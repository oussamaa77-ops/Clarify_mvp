"""
Algorithme de rapprochement par tranches / échéances réelles.

Point d'entrée : `find_partial_payments_combinations`.

Principe :
  1. Pour chaque tranche (échéance), calcul d'une FENÊTRE DE DATES DYNAMIQUE
     centrée sur `date_echeance` — sa largeur s'adapte à l'espacement des
     tranches voisines (pas de limite globale figée).
  2. Subset-Sum exact (en centimes) sur les transactions candidates de la
     fenêtre pour retrouver la/les combinaison(s) égalant `montant_attendu`.
  3. Scoring des combinaisons : exactitude du montant, proximité de date,
     et COHÉRENCE DES LIBELLÉS (les virements d'une même facture partagent
     en général le même libellé / les mêmes mots).
  4. Assemblage de solutions complètes cohérentes (une transaction n'est
     jamais affectée à deux tranches).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal
from typing import Optional

from ..common.text import common_tokens, label_cohesion, tokenize
from .schemas import (
    Echeance,
    FactureEcheances,
    FullSolution,
    OrphanTransaction,
    PartialReconciliationResult,
    TrancheResult,
    TrancheSuggestion,
)
from .subset_sum import find_subsets_within_tolerance


@dataclass
class ReconciliationConfig:
    # Fenêtre de dates dynamique (jours), autour de CHAQUE date_echeance.
    base_window_days: int = 15
    min_window_days: int = 3
    max_window_days: int = 45
    # Tolérance de montant (arrondis) exprimée en unité monétaire.
    amount_tolerance: Decimal = Decimal("0.00")
    # Bornes de la combinatoire.
    max_transactions_per_tranche: int = 6
    max_suggestions_per_tranche: int = 10
    max_full_solutions: int = 5
    # Restreindre aux transactions du même tiers que la facture.
    restrict_same_tiers: bool = True
    # Pondérations du score de tri d'une combinaison (somme libre, normalisée).
    w_exact: float = 0.45
    w_date: float = 0.20
    w_label: float = 0.25
    w_size: float = 0.10


def _to_cents(value: Decimal) -> int:
    return int((value * 100).to_integral_value(rounding="ROUND_HALF_UP"))


def _dynamic_window(
    idx: int, echeances: list[Echeance], cfg: ReconciliationConfig
) -> tuple[date, date]:
    """
    Fenêtre [debut, fin] centrée sur la date de la tranche `idx`.
    La demi-largeur vers un voisin est plafonnée à la moitié de l'écart avec
    ce voisin : deux tranches proches ne se disputent pas les mêmes virements.
    """
    this_date = echeances[idx].date_echeance

    def half_gap(other_idx: int) -> Optional[int]:
        if other_idx < 0 or other_idx >= len(echeances):
            return None
        gap = abs((echeances[other_idx].date_echeance - this_date).days)
        return max(cfg.min_window_days, gap // 2)

    before_cap = half_gap(idx - 1)
    after_cap = half_gap(idx + 1)

    win_before = cfg.base_window_days if before_cap is None else min(cfg.base_window_days, before_cap)
    win_after = cfg.base_window_days if after_cap is None else min(cfg.base_window_days, after_cap)

    win_before = max(cfg.min_window_days, min(win_before, cfg.max_window_days))
    win_after = max(cfg.min_window_days, min(win_after, cfg.max_window_days))

    return this_date - timedelta(days=win_before), this_date + timedelta(days=win_after)


def _build_suggestion(
    tx_combo: list[OrphanTransaction],
    total_cents: int,
    echeance: Echeance,
    window_days: int,
    tiers_libelle: Optional[str],
    cfg: ReconciliationConfig,
) -> TrancheSuggestion:
    montant_total = Decimal(total_cents) / 100
    ecart = montant_total - echeance.montant_attendu
    exact = _to_cents(ecart) == 0

    dates = [t.date_operation for t in tx_combo]
    date_min, date_max = min(dates), max(dates)
    avg_days = sum(abs((d - echeance.date_echeance).days) for d in dates) / len(dates)

    labels = [t.libelle for t in tx_combo]
    coherence = label_cohesion(labels)
    commons = sorted(common_tokens(labels))

    # Bonus si les libellés collent au nom du tiers de la facture.
    if tiers_libelle:
        tiers_tokens = tokenize(tiers_libelle)
        if tiers_tokens:
            hit = sum(1 for t in tx_combo if tokenize(t.libelle) & tiers_tokens)
            tiers_affinity = hit / len(tx_combo)
            coherence = max(coherence, 0.5 * coherence + 0.5 * tiers_affinity)

    # Sous-scores normalisés [0..1].
    exact_score = 1.0 if exact else max(0.0, 1.0 - abs(float(ecart)) / max(float(echeance.montant_attendu), 1.0))
    date_score = max(0.0, 1.0 - (avg_days / window_days)) if window_days > 0 else 0.0
    size_score = 1.0 / len(tx_combo)

    score = (
        cfg.w_exact * exact_score
        + cfg.w_date * date_score
        + cfg.w_label * coherence
        + cfg.w_size * size_score
    )

    representative = max(labels, key=lambda s: len(tokenize(s))) if labels else None

    return TrancheSuggestion(
        transaction_ids=[t.transaction_id for t in tx_combo],
        montant_total=montant_total,
        ecart=ecart,
        exact=exact,
        date_min=date_min,
        date_max=date_max,
        ecart_jours_moyen=round(avg_days, 2),
        libelle_coherence=round(coherence, 4),
        libelles_communs=commons,
        libelle_representatif=representative,
        score=round(score, 6),
    )


def _solve_tranche(
    echeance: Echeance,
    window: tuple[date, date],
    candidates: list[OrphanTransaction],
    tiers_libelle: Optional[str],
    cfg: ReconciliationConfig,
) -> TrancheResult:
    debut, fin = window
    in_window = [t for t in candidates if debut <= t.date_operation <= fin]

    values = [_to_cents(t.montant) for t in in_window]
    target = _to_cents(echeance.montant_attendu)
    tol = _to_cents(cfg.amount_tolerance)

    combos = find_subsets_within_tolerance(
        values,
        target,
        tolerance_cents=tol,
        max_len=cfg.max_transactions_per_tranche,
        max_results=cfg.max_suggestions_per_tranche * 3,
    )

    window_days = (fin - debut).days or 1
    suggestions: list[TrancheSuggestion] = []
    for indices, total_cents in combos:
        tx_combo = [in_window[i] for i in indices]
        suggestions.append(
            _build_suggestion(tx_combo, total_cents, echeance, window_days, tiers_libelle, cfg)
        )

    suggestions.sort(key=lambda s: s.score, reverse=True)
    suggestions = suggestions[: cfg.max_suggestions_per_tranche]

    return TrancheResult(
        echeance=echeance,
        fenetre_debut=debut,
        fenetre_fin=fin,
        suggestions=suggestions,
        resolue=any(s.exact for s in suggestions),
    )


def _assemble_full_solutions(
    echeances: list[Echeance],
    tranche_results: list[TrancheResult],
    cfg: ReconciliationConfig,
    tx_by_id: dict[str, OrphanTransaction],
) -> list[FullSolution]:
    """
    Backtracking : choisit une suggestion par tranche sans jamais réutiliser
    une transaction sur deux tranches. Ne considère que les suggestions EXACTES
    (une facture doit être soldée au centime).
    """
    def key(idx: int) -> str:
        return echeances[idx].echeance_id or f"tranche_{idx}"

    exact_options: list[list[TrancheSuggestion]] = [
        [s for s in tr.suggestions if s.exact] for tr in tranche_results
    ]

    solutions: list[FullSolution] = []

    def backtrack(i: int, used: set[str], chosen: list[TrancheSuggestion]) -> None:
        if len(solutions) >= cfg.max_full_solutions:
            return
        if i == len(echeances):
            if not chosen:
                return
            all_ids = [tid for s in chosen for tid in s.transaction_ids]
            labels = [tx_by_id[tid].libelle for tid in all_ids if tid in tx_by_id]
            coherence = label_cohesion(labels)
            avg_score = sum(s.score for s in chosen) / len(chosen)
            solutions.append(
                FullSolution(
                    affectations={key(idx): chosen[idx].transaction_ids for idx in range(len(chosen))},
                    exact_total=True,
                    libelle_coherence_globale=round(coherence, 4),
                    score=round(0.7 * avg_score + 0.3 * coherence, 6),
                )
            )
            return

        for sug in exact_options[i]:
            ids = set(sug.transaction_ids)
            if ids & used:
                continue
            chosen.append(sug)
            backtrack(i + 1, used | ids, chosen)
            chosen.pop()
            if len(solutions) >= cfg.max_full_solutions:
                return

    backtrack(0, set(), [])
    solutions.sort(key=lambda s: s.score, reverse=True)
    return solutions


def find_partial_payments_combinations(
    facture: FactureEcheances,
    orphan_transactions: list[OrphanTransaction],
    config: Optional[ReconciliationConfig] = None,
) -> PartialReconciliationResult:
    """
    Point d'entrée métier.

    Args:
        facture: la facture et sa liste d'échéances de paiement partiel.
        orphan_transactions: transactions bancaires non lettrées (candidates).
        config: réglages optionnels (fenêtres, tolérances, bornes).

    Returns:
        `PartialReconciliationResult` :
          - `tranches`            : par tranche, les combinaisons suggérées triées ;
          - `solutions_completes` : affectations cohérentes couvrant toutes les
                                     tranches sans réutilisation de transaction.
    """
    cfg = config or ReconciliationConfig()

    if not facture.echeances:
        return PartialReconciliationResult(
            facture_id=facture.facture_id,
            a_des_echeances=False,
            message="Facture sans échéances de paiement partiel : rapprochement standard.",
        )

    # Filtrage tiers (les tranches d'une facture proviennent du même tiers).
    candidates = orphan_transactions
    if cfg.restrict_same_tiers and facture.tiers_id is not None:
        same = [t for t in candidates if t.tiers_id == facture.tiers_id]
        # Si aucun tiers renseigné côté transactions, on ne filtre pas à vide.
        candidates = same if same else candidates

    echeances = sorted(facture.echeances, key=lambda e: e.date_echeance)
    tx_by_id = {t.transaction_id: t for t in candidates}

    tranche_results: list[TrancheResult] = []
    for idx, ech in enumerate(echeances):
        window = _dynamic_window(idx, echeances, cfg)
        tranche_results.append(
            _solve_tranche(ech, window, candidates, facture.tiers_libelle, cfg)
        )

    solutions = _assemble_full_solutions(echeances, tranche_results, cfg, tx_by_id)

    resolved = sum(1 for tr in tranche_results if tr.resolue)
    message = (
        f"{resolved}/{len(echeances)} tranche(s) avec correspondance exacte ; "
        f"{len(solutions)} solution(s) complète(s) proposée(s)."
    )

    return PartialReconciliationResult(
        facture_id=facture.facture_id,
        a_des_echeances=True,
        tranches=tranche_results,
        solutions_completes=solutions,
        message=message,
    )
