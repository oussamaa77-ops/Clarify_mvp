"""
ia_services
===========

Deux extensions logiques isolées, branchables dans l'architecture FastAPI existante :

1. `scan`            -> Extraction IA (LLM = extracteur brut) + classification
                         DÉTERMINISTE (`DocumentClassifierService`).
2. `reconciliation`  -> Rapprochement par tranches / échéances réelles
                         (`find_partial_payments_combinations`, Subset-Sum optimisé).

Aucun couplage direct à la base : les accès données passent par des `Protocol`
(voir `scan/repositories.py`). Fournissez vos propres implémentations Supabase.
"""

__all__ = ["scan", "reconciliation", "common"]
