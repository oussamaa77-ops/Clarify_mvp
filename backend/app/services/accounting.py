from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from sqlalchemy.orm import selectinload
from app.models.billing import Invoice, Payment, SupplierBill
from app.models.accounting import Account, AccountType, JournalEntry, JournalEntryLine

async def get_or_create_account(db: AsyncSession, company_id: int, code: str, name: str, type_val: AccountType) -> Account:
    """Helper to dynamically fetch or spawn necessary chart of accounts for the company."""
    result = await db.execute(
        select(Account).where(Account.company_id == company_id, Account.code == code)
    )
    account = result.scalars().first()
    if not account:
        # On extrait la classe (premier chiffre du code) pour le Bilan/CPC
        acc_class = code[0] if code else None
        account = Account(company_id=company_id, code=code, name=name, type=type_val, account_class=acc_class)
        db.add(account)
        await db.flush()
    return account

async def generate_accounting_entries_for_invoice(db: AsyncSession, invoice: Invoice):
    """Ventes : Débit 3421 (Clients) / Crédit 7111 (Ventes) + 4455 (TVA)"""
    client_acc = await get_or_create_account(db, invoice.company_id, "3421", "Clients", AccountType.ASSET)
    sales_acc = await get_or_create_account(db, invoice.company_id, "7111", "Vente de marchandises", AccountType.REVENUE)
    vat_acc = await get_or_create_account(db, invoice.company_id, "4455", "Etat, TVA facturée", AccountType.LIABILITY)

    je = JournalEntry(
        company_id=invoice.company_id,
        reference=f"INV-{invoice.number}",
        date=invoice.date,
        description=f"Facture client {invoice.number}",
        source="invoice",
    )
    db.add(je)
    await db.flush()

    db.add(JournalEntryLine(journal_entry_id=je.id, account_id=client_acc.id, debit=invoice.total_incl_tax, credit=0.0))
    db.add(JournalEntryLine(journal_entry_id=je.id, account_id=sales_acc.id, debit=0.0, credit=invoice.total_excl_tax))
    
    if invoice.vat_amount > 0:
        db.add(JournalEntryLine(journal_entry_id=je.id, account_id=vat_acc.id, debit=0.0, credit=invoice.vat_amount))
        
    await db.flush()

# ══════════════════════════════════════════════════════════════
# FONCTION CORRIGÉE : GESTION HYBRIDE VENTES / ACHATS
# ══════════════════════════════════════════════════════════════
async def generate_accounting_entries_for_payment(db: AsyncSession, payment: Payment):
    """
    Génère l'écriture de trésorerie.
    - Si Client : Débit Banque (5141) / Crédit Client (3421)
    - Si Fournisseur : Débit Fournisseur (4411) / Crédit Banque (5141)
    """
    bank_acc = await get_or_create_account(db, payment.company_id, "5141", "Banque", AccountType.ASSET)
    
    # Initialisation des variables
    je_desc = ""
    debit_acc_id = None
    credit_acc_id = None

    if payment.invoice_id:
        # --- FLUX CLIENT (Encaissement) ---
        client_acc = await get_or_create_account(db, payment.company_id, "3421", "Clients", AccountType.ASSET)
        je_desc = f"Encaissement Client - Réf: {payment.id}"
        debit_acc_id = bank_acc.id      # L'argent rentre en banque
        credit_acc_id = client_acc.id   # On diminue la créance client
        
    elif payment.supplier_bill_id:
        # --- FLUX FOURNISSEUR (Décaissement) ---
        supplier_acc = await get_or_create_account(db, payment.company_id, "4411", "Fournisseurs", AccountType.LIABILITY)
        je_desc = f"Paiement Fournisseur - Réf: {payment.id}"
        debit_acc_id = supplier_acc.id  # On diminue la dette fournisseur
        credit_acc_id = bank_acc.id     # L'argent sort de la banque

    if not debit_acc_id or not credit_acc_id:
        return # Rien à générer si pas de lien

    je = JournalEntry(
        company_id=payment.company_id,
        reference=f"PAY-{payment.id}",
        date=payment.date,
        description=je_desc,
        source="payment",
    )
    db.add(je)
    await db.flush()

    # Ligne de Débit
    db.add(JournalEntryLine(journal_entry_id=je.id, account_id=debit_acc_id, debit=payment.amount, credit=0.0))
    # Ligne de Crédit
    db.add(JournalEntryLine(journal_entry_id=je.id, account_id=credit_acc_id, debit=0.0, credit=payment.amount))
    
    await db.flush()

async def generate_accounting_entries_for_supplier_bill(db: AsyncSession, supplier_bill: SupplierBill):
    """Achats : Débit 6111 (Achats) + 3455 (TVA) / Crédit 4411 (Fournisseurs)"""
    purchases_acc = await get_or_create_account(db, supplier_bill.company_id, "6111", "Achats de marchandises", AccountType.EXPENSE)
    vat_recovery_acc = await get_or_create_account(db, supplier_bill.company_id, "3455", "Etat, TVA récupérable", AccountType.ASSET)
    supplier_acc = await get_or_create_account(db, supplier_bill.company_id, "4411", "Fournisseurs", AccountType.LIABILITY)

    je = JournalEntry(
        company_id=supplier_bill.company_id,
        reference=supplier_bill.number,
        date=supplier_bill.date,
        description=f"Facture fournisseur {supplier_bill.number}",
        source="invoice",
    )
    db.add(je)
    await db.flush()

    db.add(JournalEntryLine(journal_entry_id=je.id, account_id=purchases_acc.id, debit=supplier_bill.total_excl_tax, credit=0.0))
    if supplier_bill.vat_amount > 0:
        db.add(JournalEntryLine(journal_entry_id=je.id, account_id=vat_recovery_acc.id, debit=supplier_bill.vat_amount, credit=0.0))
    
    db.add(JournalEntryLine(journal_entry_id=je.id, account_id=supplier_acc.id, debit=0.0, credit=supplier_bill.total_incl_tax))
    
    await db.flush()

from sqlalchemy.orm import selectinload
from sqlalchemy import func

async def get_accounts(db: AsyncSession, company_id: int) -> list[Account]:
    result = await db.execute(select(Account).where(Account.company_id == company_id).order_by(Account.code))
    return result.scalars().all()

async def get_journal_entries(
    db: AsyncSession,
    company_id: int,
    skip: int = 0,
    limit: int = 100,
    status_filter: str = None,
) -> list[JournalEntry]:
    from app.models.accounting import JournalEntryStatus
    from sqlalchemy.orm import selectinload

    q = (
        select(JournalEntry)
        .options(selectinload(JournalEntry.lines).selectinload(JournalEntryLine.account))
        .where(JournalEntry.company_id == company_id)
        .order_by(JournalEntry.date.desc(), JournalEntry.id.desc())
    )
    if status_filter:
        try:
            q = q.where(JournalEntry.status == JournalEntryStatus(status_filter))
        except ValueError:
            pass  # filtre invalide ignoré silencieusement

    result = await db.execute(q.offset(skip).limit(limit))
    return result.scalars().all()

async def get_general_ledger(db: AsyncSession, company_id: int):
    stmt = (
        select(
            Account,
            func.coalesce(func.sum(JournalEntryLine.debit), 0.0).label("total_debit"),
            func.coalesce(func.sum(JournalEntryLine.credit), 0.0).label("total_credit")
        )
        .outerjoin(JournalEntryLine, Account.id == JournalEntryLine.account_id)
        .where(Account.company_id == company_id)
        .group_by(Account.id)
        .order_by(Account.code)
    )
    result = await db.execute(stmt)
    
    ledger = []
    for account, total_debit, total_credit in result.all():
        ledger.append({
            "id": account.id,
            "company_id": account.company_id,
            "code": account.code,
            "name": account.name,
            "type": account.type,
            "created_at": account.created_at,
            "total_debit": float(total_debit),
            "total_credit": float(total_credit),
            "balance": float(total_debit) - float(total_credit)
        })
    return ledger

async def generate_bilan(db: AsyncSession, company_id: int) -> dict:
    """Genere le Bilan comptable selon le PCM marocain."""
    stmt = (
        select(
            Account.code,
            Account.name,
            Account.type,
            Account.account_class,
            func.coalesce(func.sum(JournalEntryLine.debit), 0.0).label("total_debit"),
            func.coalesce(func.sum(JournalEntryLine.credit), 0.0).label("total_credit")
        )
        .outerjoin(JournalEntryLine, Account.id == JournalEntryLine.account_id)
        .where(Account.company_id == company_id)
        .group_by(Account.id)
        .order_by(Account.code)
    )
    result = await db.execute(stmt)
    rows = result.all()

    actif = []
    passif = []
    total_actif = 0.0
    total_passif = 0.0

    for row in rows:
        debit = float(row.total_debit)
        credit = float(row.total_credit)
        solde = debit - credit
        account_class = row.account_class or ""

        if solde == 0:
            continue

        item = {
            "code": row.code,
            "name": row.name,
            "solde": abs(solde)
        }

        # ACTIF: classes 2, 3, 5 avec solde debiteur
        if account_class in ["2", "3", "5"] and solde > 0:
            actif.append(item)
            total_actif += abs(solde)

        # PASSIF: classes 1, 4 avec solde crediteur
        elif account_class in ["1", "4"] and solde < 0:
            passif.append(item)
            total_passif += abs(solde)

    # Resultat de l'exercice
    resultat = total_actif - total_passif
    if resultat != 0:
        if resultat > 0:
            passif.append({"code": "1161", "name": "Resultat net (benefice)", "solde": resultat})
            total_passif += resultat
        else:
            actif.append({"code": "1161", "name": "Resultat net (perte)", "solde": abs(resultat)})
            total_actif += abs(resultat)

    return {
        "actif": actif,
        "passif": passif,
        "total_actif": total_actif,
        "total_passif": total_passif,
        "resultat": resultat,
        "is_balanced": abs(total_actif - total_passif) < 0.01
    }


async def generate_cpc(db: AsyncSession, company_id: int) -> dict:
    """Genere le Compte de Produits et Charges selon le PCM marocain."""
    stmt = (
        select(
            Account.code,
            Account.name,
            Account.type,
            Account.account_class,
            func.coalesce(func.sum(JournalEntryLine.debit), 0.0).label("total_debit"),
            func.coalesce(func.sum(JournalEntryLine.credit), 0.0).label("total_credit")
        )
        .outerjoin(JournalEntryLine, Account.id == JournalEntryLine.account_id)
        .where(Account.company_id == company_id)
        .where(Account.account_class.in_(["6", "7"]))
        .group_by(Account.id)
        .order_by(Account.code)
    )
    result = await db.execute(stmt)
    rows = result.all()

    produits = []
    charges = []
    total_produits = 0.0
    total_charges = 0.0

    for row in rows:
        debit = float(row.total_debit)
        credit = float(row.total_credit)
        solde = debit - credit

        if solde == 0:
            continue

        item = {
            "code": row.code,
            "name": row.name,
            "montant": abs(solde)
        }

        # Produits: classe 7 solde crediteur
        if row.account_class == "7" and solde < 0:
            produits.append(item)
            total_produits += abs(solde)

        # Charges: classe 6 solde debiteur
        elif row.account_class == "6" and solde > 0:
            charges.append(item)
            total_charges += abs(solde)

    resultat_exploitation = total_produits - total_charges

    return {
        "produits": produits,
        "charges": charges,
        "total_produits": total_produits,
        "total_charges": total_charges,
        "resultat_exploitation": resultat_exploitation,
        "resultat_net": resultat_exploitation
    }
