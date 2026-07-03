"""
Subset-Sum exact (optimisé) sur des montants entiers en centimes.

On veut TOUTES les combinaisons de transactions dont la somme égale le montant
attendu d'une tranche (à une tolérance en centimes près). Approche : DFS trié
décroissant avec élagage (borne haute + borne des restes), plafonnée en taille
de combinaison et en nombre de résultats pour rester bornée en temps.
"""
from __future__ import annotations

from typing import Sequence


def find_subsets_within_tolerance(
    values_cents: Sequence[int],
    target_cents: int,
    *,
    tolerance_cents: int = 0,
    max_len: int = 6,
    max_results: int = 50,
) -> list[tuple[tuple[int, ...], int]]:
    """
    Cherche les sous-ensembles d'indices dont la somme est dans
    [target - tolerance, target + tolerance].

    Args:
        values_cents: montants candidats (centimes, > 0), indexés positionnellement.
        target_cents: montant cible (centimes).
        tolerance_cents: tolérance absolue autorisée sur la somme.
        max_len: taille maximale d'une combinaison (borne la combinatoire).
        max_results: nombre maximal de combinaisons renvoyées.

    Returns:
        Liste de (indices, somme_cents). Les indices réfèrent `values_cents`.
        Triée par |somme - target| croissant puis par taille croissante
        (les correspondances exactes et minimales d'abord).
    """
    n = len(values_cents)
    if n == 0 or target_cents <= 0:
        return []

    lower = target_cents - tolerance_cents
    upper = target_cents + tolerance_cents

    # Tri décroissant : permet d'élaguer tôt (on dépasse vite `upper`).
    order = sorted(range(n), key=lambda i: values_cents[i], reverse=True)
    sorted_vals = [values_cents[i] for i in order]

    # Somme suffixe : borne supérieure atteignable à partir d'une position.
    suffix_sum = [0] * (n + 1)
    for i in range(n - 1, -1, -1):
        suffix_sum[i] = suffix_sum[i + 1] + sorted_vals[i]

    results: list[tuple[tuple[int, ...], int]] = []
    chosen: list[int] = []  # positions dans l'ordre trié

    def dfs(start: int, current: int) -> None:
        if len(results) >= max_results:
            return
        # Élagage 1 : on a déjà dépassé la borne haute.
        if current > upper:
            return
        # Solution valide ?
        if lower <= current <= upper and chosen:
            original_indices = tuple(sorted(order[p] for p in chosen))
            results.append((original_indices, current))
            # On ne `return` pas : un sur-ensemble ne peut qu'augmenter la somme,
            # donc inutile de continuer CETTE branche au-delà de upper — géré par
            # l'élagage 1 au prochain ajout. On stoppe l'extension ici :
            return
        if len(chosen) >= max_len:
            return
        # Élagage 2 : même en prenant tout le reste, impossible d'atteindre lower.
        if current + suffix_sum[start] < lower:
            return

        for p in range(start, n):
            v = sorted_vals[p]
            # Élagage 3 : ajout qui dépasse déjà upper -> les suivants (triés
            # décroissant) sont <= v, on tente quand même les plus petits.
            if current + v > upper:
                continue
            chosen.append(p)
            dfs(p + 1, current + v)
            chosen.pop()
            if len(results) >= max_results:
                return

    dfs(0, 0)

    results.sort(key=lambda r: (abs(r[1] - target_cents), len(r[0])))
    return results
