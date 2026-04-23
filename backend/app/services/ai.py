"""
services/ai.py — Service IA Complet (Gemini 1.5 Flash)
Accès : Bilan, PCM, Grand Livre, GED, Facturation
"""
from groq import Groq
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from app.config import settings
from app.models.billing import Invoice, InvoiceStatus, SupplierBill, SupplierBillStatus
from app.models.crm import Client
from app.models.catalog import Product
from app.models.accounting import Account, JournalEntry, JournalEntryLine, AccountType
from app.models.system import Document

# Initialisation du client Groq
client_groq = Groq(api_key=settings.GROQ_API_KEY)

# --- SECTION 1 : EXTRACTION DES DONNÉES COMPTABLES (CONTEXTE) ---

async def get_pcm_context(db: AsyncSession, company_id: int) -> str:
    """Plan Comptable Marocain — tous les comptes groupés par classe"""
    result = await db.execute(
        select(Account).where(Account.company_id == company_id).order_by(Account.code)
    )
    accounts = result.scalars().all()
    if not accounts:
        return "PLAN COMPTABLE: Aucun compte configuré."

    classes: dict[str, list] = {}
    for a in accounts:
        cls = a.code[0] if a.code else "?"
        classes.setdefault(cls, []).append(a)

    lines = ["=== PLAN COMPTABLE MAROCAIN (PCM) ==="]
    class_names = {
        "1": "Financement permanent", "2": "Actif immobilisé",
        "3": "Actif circulant", "4": "Passif circulant",
        "5": "Trésorerie", "6": "Charges", "7": "Produits",
    }
    for cls in sorted(classes.keys()):
        label = class_names.get(cls, "Autre")
        lines.append(f"\nClasse {cls} — {label} ({len(classes[cls])} comptes):")
        for a in classes[cls]:
            lines.append(f"  {a.code} | {a.name} | {a.type.value}")
    return "\n".join(lines)

async def get_ledger_context(db: AsyncSession, company_id: int) -> str:
    """Grand Livre — totaux débit/crédit/solde par compte"""
    result = await db.execute(
        select(
            Account.code, Account.name, Account.type,
            func.coalesce(func.sum(JournalEntryLine.debit), 0).label("total_debit"),
            func.coalesce(func.sum(JournalEntryLine.credit), 0).label("total_credit"),
        )
        .outerjoin(JournalEntryLine, JournalEntryLine.account_id == Account.id)
        .where(Account.company_id == company_id)
        .group_by(Account.code, Account.name, Account.type)
        .order_by(Account.code)
    )
    rows = result.all()
    lines = ["=== GRAND LIVRE (SOLDES) ==="]
    for code, name, acc_type, td, tc in rows:
        solde = td - tc
        if td > 0 or tc > 0:
            lines.append(f"  {code} {name}: D={td:,.2f} C={tc:,.2f} Solde={solde:,.2f} MAD")
    return "\n".join(lines) if len(lines) > 1 else "GRAND LIVRE: Aucun mouvement."

async def get_balance_bilan_context(db: AsyncSession, company_id: int) -> str:
    """Calcul du Bilan et du CPC pour l'IA"""
    result = await db.execute(
        select(
            Account.code, Account.name, Account.type,
            func.coalesce(func.sum(JournalEntryLine.debit), 0).label("td"),
            func.coalesce(func.sum(JournalEntryLine.credit), 0).label("tc"),
        )
        .outerjoin(JournalEntryLine, JournalEntryLine.account_id == Account.id)
        .where(Account.company_id == company_id)
        .group_by(Account.code, Account.name, Account.type)
        .order_by(Account.code)
    )
    rows = result.all()

    actif = passif = capitaux = charges = produits = 0.0
    for code, name, acc_type, td, tc in rows:
        solde = td - tc
        if acc_type == AccountType.ASSET: actif += solde
        elif acc_type == AccountType.LIABILITY: passif += abs(solde)
        elif acc_type == AccountType.EQUITY: capitaux += abs(solde)
        elif acc_type == AccountType.EXPENSE: charges += solde
        elif acc_type == AccountType.REVENUE: produits += abs(solde)

    resultat = produits - charges
    return f"""
=== ÉTATS FINANCIERS (BILAN & CPC) ===
BILAN:
  - Total Actif: {actif:,.2f} MAD
  - Total Passif (Dettes): {passif:,.2f} MAD
  - Capitaux Propres: {capitaux:,.2f} MAD
CPC:
  - Total Produits (7xxx): {produits:,.2f} MAD
  - Total Charges (6xxx): {charges:,.2f} MAD
  - RÉSULTAT NET: {resultat:,.2f} MAD
"""

async def get_ged_context(db: AsyncSession, company_id: int) -> str:
    """Liste des documents archivés (Preuve d'intégrité)"""
    result = await db.execute(
        select(Document).where(Document.company_id == company_id).limit(10)
    )
    docs = result.scalars().all()
    lines = ["=== GED (Derniers documents) ==="]
    for d in docs:
        lines.append(f"  {d.name} | Hash: {d.sha256[:10]}... | Date: {d.created_at}")
    return "\n".join(lines)

# --- SECTION 2 : FONCTION MAITRESSE (ASSEMBLAGE DU CONTEXTE) ---

async def get_company_context(db: AsyncSession, company_id: int) -> str:
    """Compile toutes les données pour Gemini"""
    try:
        # On appelle toutes les fonctions de calcul
        pcm = await get_pcm_context(db, company_id)
        bilan_cpc = await get_balance_bilan_context(db, company_id)
        ledger = await get_ledger_context(db, company_id)
        ged = await get_ged_context(db, company_id)
        
        return f"{bilan_cpc}\n{ledger}\n{pcm}\n{ged}"
    except Exception as e:
        return f"Erreur de récupération des données: {str(e)}"

# --- SECTION 3 : INTERFACE AVEC GEMINI ---

async def get_ai_response(company_id: int, user_id: int, message: str, db: AsyncSession = None) -> str:
    """Envoie la question + tout le bilan à Llama-3.3-70b via Groq"""
    try:
        context = ""
        if db:
            context = await get_company_context(db, company_id)

        system_instruction = f"""Tu es l'Assistant Expert-Comptable de FactureMaroc. 
Tu réponds aux entrepreneurs marocains sur leur santé financière.
Utilise les données ci-dessous pour répondre avec PRÉCISION.

{context}

RÈGLES FISCALES MAROCAINES:
- Si le résultat est bénéficiaire, mentionne l'IS (10% si < 300k).
- Si on parle de TVA, rappelle le régime des encaissements.
- Toujours être pro et rassurer sur la sécurité (SHA-256).
"""

        # Adaptation pour Groq (Llama-3.3-70b-versatile)
        response = client_groq.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[
                {"role": "system", "content": system_instruction},
                {"role": "user", "content": message}
            ]
        )

        # On récupère le texte de la réponse Groq
        return response.choices[0].message.content

    except Exception as e:
        return f"Erreur de l'assistant IA: {str(e)}"