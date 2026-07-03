"""
Module `reconciliation` : rapprochement tardif par tranches / échéances réelles.

Cœur : `find_partial_payments_combinations` — pour une facture porteuse
d'échéances de paiement partiel, retrouve, parmi les transactions orphelines
du même tiers, la combinaison de virements correspondant EXACTEMENT au montant
attendu de chaque tranche, dans une fenêtre de dates dynamique propre à la tranche.
"""
from .schemas import (
    Echeance,
    FactureEcheances,
    OrphanTransaction,
    TrancheSuggestion,
    TrancheResult,
    FullSolution,
    PartialReconciliationResult,
)
from .matcher import find_partial_payments_combinations, ReconciliationConfig

__all__ = [
    "Echeance",
    "FactureEcheances",
    "OrphanTransaction",
    "TrancheSuggestion",
    "TrancheResult",
    "FullSolution",
    "PartialReconciliationResult",
    "find_partial_payments_combinations",
    "ReconciliationConfig",
]
