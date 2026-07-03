"""Exemple de câblage FastAPI du module de rapprochement par tranches."""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, Field

from .matcher import ReconciliationConfig, find_partial_payments_combinations
from .schemas import FactureEcheances, OrphanTransaction, PartialReconciliationResult

router = APIRouter(prefix="/reconciliation", tags=["reconciliation"])


class PartialPaymentsRequest(BaseModel):
    facture: FactureEcheances
    orphan_transactions: list[OrphanTransaction] = Field(default_factory=list)


@router.post("/partial-payments", response_model=PartialReconciliationResult)
def partial_payments(req: PartialPaymentsRequest) -> PartialReconciliationResult:
    """
    Retrouve les combinaisons de transactions correspondant aux tranches d'une
    facture (paiements partiels), avec suggestions triées pour l'UI.
    """
    return find_partial_payments_combinations(
        req.facture, req.orphan_transactions, ReconciliationConfig()
    )
