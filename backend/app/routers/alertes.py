"""
Router Alertes Fiscales — Détection proactive des obligations fiscales marocaines
"""
from datetime import datetime, date, timedelta
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from typing import List
from app.database import get_db
from app.utils.security import get_current_user, get_current_company_id
from app.models.identity import User
from app.models.billing import Invoice, InvoiceStatus, SupplierBill, Payment

router = APIRouter(prefix="/alertes", tags=["Alertes Fiscales"])


def get_urgency(days_left: int) -> str:
    if days_left <= 3:
        return "critique"
    elif days_left <= 7:
        return "urgent"
    elif days_left <= 15:
        return "attention"
    return "info"


@router.get("/")
async def get_alertes(
    db: AsyncSession = Depends(get_db),
    company_id: int = Depends(get_current_company_id),
    current_user: User = Depends(get_current_user),
):
    """Retourne toutes les alertes fiscales et comptables de l'entreprise."""
    alertes = []
    today = date.today()
    current_month = today.month
    current_year = today.year

    # ─── 1. ECHÉANCE TVA ───
    # Au Maroc: déclaration TVA avant le 20 du mois suivant
    if today.day <= 20:
        deadline_tva = date(current_year, current_month, 20)
    else:
        next_month = current_month + 1 if current_month < 12 else 1
        next_year = current_year if current_month < 12 else current_year + 1
        deadline_tva = date(next_year, next_month, 20)

    days_tva = (deadline_tva - today).days

    # Calculer TVA due
    vat_result = await db.execute(
        select(func.sum(Invoice.vat_amount))
        .where(
            Invoice.company_id == company_id,
            Invoice.status == InvoiceStatus.PAID,
            func.extract('month', Invoice.date) == current_month,
            func.extract('year', Invoice.date) == current_year,
        )
    )
    tva_collected = float(vat_result.scalar() or 0)

    vat_purchase = await db.execute(
        select(func.sum(SupplierBill.vat_amount))
        .where(
            SupplierBill.company_id == company_id,
            func.extract('month', SupplierBill.date) == current_month,
            func.extract('year', SupplierBill.date) == current_year,
        )
    )
    tva_deductible = float(vat_purchase.scalar() or 0)
    tva_nette = tva_collected - tva_deductible

    alertes.append({
        "id": "tva_mensuelle",
        "type": "fiscal",
        "titre": "Déclaration TVA mensuelle",
        "description": f"TVA nette à déclarer: {tva_nette:.2f} MAD (collectée: {tva_collected:.2f} - déductible: {tva_deductible:.2f})",
        "echeance": deadline_tva.isoformat(),
        "jours_restants": days_tva,
        "urgence": get_urgency(days_tva),
        "montant": tva_nette,
        "action": "Préparer et soumettre la déclaration TVA (formulaire DGI)",
        "loi": "Article 111 du CGI Maroc — avant le 20 du mois suivant",
    })

    # ─── 2. FACTURES EN RETARD ───
    overdue_result = await db.execute(
        select(func.count(Invoice.id), func.sum(Invoice.total_incl_tax))
        .where(
            Invoice.company_id == company_id,
            Invoice.status == InvoiceStatus.SENT,
            Invoice.due_date < today,
        )
    )
    overdue_row = overdue_result.first()
    overdue_count = overdue_row[0] or 0
    overdue_total = float(overdue_row[1] or 0)

    if overdue_count > 0:
        alertes.append({
            "id": "factures_retard",
            "type": "tresorerie",
            "titre": f"{overdue_count} facture(s) en retard de paiement",
            "description": f"Total impayé en retard: {overdue_total:.2f} MAD",
            "echeance": today.isoformat(),
            "jours_restants": 0,
            "urgence": "urgent",
            "montant": overdue_total,
            "action": "Envoyer des relances aux clients concernés",
            "loi": "Délai légal de paiement: 60 jours (Art. 78 de la loi 15-95)",
        })

    # ─── 3. ACOMPTE IS (Impôt sur les Sociétés) ───
    # Acomptes trimestriels: 31/03, 30/06, 30/09, 31/12
    acompte_dates = [
        date(current_year, 3, 31),
        date(current_year, 6, 30),
        date(current_year, 9, 30),
        date(current_year, 12, 31),
    ]
    for acompte_date in acompte_dates:
        days_left = (acompte_date - today).days
        if 0 <= days_left <= 30:
            alertes.append({
                "id": f"acompte_is_{acompte_date.month}",
                "type": "fiscal",
                "titre": f"Acompte IS trimestriel — {acompte_date.strftime('%d/%m/%Y')}",
                "description": "Verser 1/4 de l'IS de l'exercice précédent ou estimation",
                "echeance": acompte_date.isoformat(),
                "jours_restants": days_left,
                "urgence": get_urgency(days_left),
                "montant": None,
                "action": "Calculer et verser l'acompte IS auprès de la recette des impôts",
                "loi": "Article 169 du CGI Maroc — 4 acomptes trimestriels",
            })

    # ─── 4. COTISATION MINIMALE ───
    # Due en même temps que l'IS (fin mars de chaque année)
    cm_deadline = date(current_year, 3, 31)
    days_cm = (cm_deadline - today).days
    if 0 <= days_cm <= 60:
        ca_result = await db.execute(
            select(func.sum(Invoice.total_excl_tax))
            .where(
                Invoice.company_id == company_id,
                Invoice.status == InvoiceStatus.PAID,
                func.extract('year', Invoice.date) == current_year - 1,
            )
        )
        ca_annuel = float(ca_result.scalar() or 0)
        cm = max(ca_annuel * 0.005, 1500)  # 0.5% du CA, minimum 1500 MAD

        alertes.append({
            "id": "cotisation_minimale",
            "type": "fiscal",
            "titre": "Cotisation Minimale (CM)",
            "description": f"CM estimée: {cm:.2f} MAD (0.5% du CA ou min 1500 MAD)",
            "echeance": cm_deadline.isoformat(),
            "jours_restants": days_cm,
            "urgence": get_urgency(days_cm),
            "montant": cm,
            "action": "Verser la cotisation minimale même si résultat déficitaire",
            "loi": "Article 144 du CGI Maroc",
        })

    # ─── 5. CNSS ───
    # Déclaration CNSS avant le 10 du mois suivant
    cnss_day = 10
    if today.day <= cnss_day:
        deadline_cnss = date(current_year, current_month, cnss_day)
    else:
        next_month = current_month + 1 if current_month < 12 else 1
        next_year = current_year if current_month < 12 else current_year + 1
        deadline_cnss = date(next_year, next_month, cnss_day)

    days_cnss = (deadline_cnss - today).days
    if days_cnss <= 10:
        alertes.append({
            "id": "cnss_mensuelle",
            "type": "social",
            "titre": "Déclaration CNSS mensuelle",
            "description": "Déclarer et payer les cotisations sociales des salariés",
            "echeance": deadline_cnss.isoformat(),
            "jours_restants": days_cnss,
            "urgence": get_urgency(days_cnss),
            "montant": None,
            "action": "Soumettre la déclaration sur le portail CNSS (www.cnss.ma)",
            "loi": "Dahir n°1-72-184 — avant le 10 du mois suivant",
        })

    # ─── 6. ANOMALIES COMPTABLES ───
    # Détecter les factures sans paiement depuis plus de 90 jours
    old_unpaid_result = await db.execute(
        select(func.count(Invoice.id))
        .where(
            Invoice.company_id == company_id,
            Invoice.status == InvoiceStatus.SENT,
            Invoice.date < date(current_year, current_month, 1) - timedelta(days=90),
        )
    )
    old_unpaid = old_unpaid_result.scalar() or 0
    if old_unpaid > 0:
        alertes.append({
            "id": "creances_anciennes",
            "type": "anomalie",
            "titre": f"{old_unpaid} créance(s) de plus de 90 jours",
            "description": "Ces factures risquent de devenir irrécouvrables — provisionner ou relancer",
            "echeance": today.isoformat(),
            "jours_restants": 0,
            "urgence": "attention",
            "montant": None,
            "action": "Constituer une provision pour créances douteuses (compte 3491 PCM)",
            "loi": "Principe de prudence — PCM marocain",
        })

    # Trier par urgence
    urgence_order = {"critique": 0, "urgent": 1, "attention": 2, "info": 3}
    alertes.sort(key=lambda x: (urgence_order.get(x["urgence"], 4), x["jours_restants"]))

    return {
        "alertes": alertes,
        "total": len(alertes),
        "critiques": sum(1 for a in alertes if a["urgence"] == "critique"),
        "urgents": sum(1 for a in alertes if a["urgence"] == "urgent"),
        "generated_at": datetime.now().isoformat(),
    }
