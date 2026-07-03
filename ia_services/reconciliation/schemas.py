"""
Schémas du module de rapprochement par tranches.

Montants en `Decimal` (jamais de float pour de la monnaie). L'algorithme
travaille en interne en centimes entiers pour un subset-sum exact.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Optional

from pydantic import BaseModel, Field


class Echeance(BaseModel):
    """Une tranche de paiement attendue, définie à la saisie de la facture."""

    echeance_id: Optional[str] = Field(
        default=None, description="Identifiant de la tranche (si géré côté BDD)."
    )
    montant_attendu: Decimal = Field(..., gt=0)
    date_echeance: date


class FactureEcheances(BaseModel):
    """
    Extension du schéma facture : accepte une liste d'échéances de paiement
    partiel. `echeances = []` => facture réglée en une fois (pas de tranches).
    """

    facture_id: str
    tiers_id: Optional[str] = None
    tiers_libelle: Optional[str] = None
    montant_total: Optional[Decimal] = None
    echeances: list[Echeance] = Field(default_factory=list)


class OrphanTransaction(BaseModel):
    """Transaction bancaire non lettrée (orpheline) candidate au rapprochement."""

    transaction_id: str
    montant: Decimal = Field(..., description="Montant de l'opération (positif).")
    date_operation: date
    libelle: str = ""
    tiers_id: Optional[str] = None


class TrancheSuggestion(BaseModel):
    """Une combinaison candidate de transactions pour UNE tranche."""

    transaction_ids: list[str]
    montant_total: Decimal
    ecart: Decimal = Field(..., description="montant_total - montant_attendu.")
    exact: bool

    # Éléments d'aide à la décision UI.
    date_min: Optional[date] = None
    date_max: Optional[date] = None
    ecart_jours_moyen: float = Field(
        ..., description="Écart moyen (jours) à la date d'échéance."
    )
    libelle_coherence: float = Field(
        ..., description="Cohésion des libellés de la combinaison (0..1)."
    )
    libelles_communs: list[str] = Field(default_factory=list)
    libelle_representatif: Optional[str] = None

    score: float = Field(..., description="Score global de tri (plus grand = mieux).")


class TrancheResult(BaseModel):
    """Résultat pour une tranche : ses suggestions triées."""

    echeance: Echeance
    fenetre_debut: date
    fenetre_fin: date
    suggestions: list[TrancheSuggestion] = Field(default_factory=list)
    resolue: bool = False


class FullSolution(BaseModel):
    """
    Affectation COHÉRENTE couvrant toutes les tranches sans réutiliser
    une même transaction sur deux tranches.
    """

    affectations: dict[str, list[str]] = Field(
        ..., description="echeance_id (ou index) -> liste de transaction_ids."
    )
    exact_total: bool
    libelle_coherence_globale: float
    score: float


class PartialReconciliationResult(BaseModel):
    facture_id: str
    a_des_echeances: bool
    tranches: list[TrancheResult] = Field(default_factory=list)
    solutions_completes: list[FullSolution] = Field(default_factory=list)
    message: Optional[str] = None
