"""
Utilitaires de normalisation / tokenisation de libellés.

Partagés par le classifieur de documents (matching de tiers) et par
l'algorithme de rapprochement (cohérence des libellés d'opérations).
"""
from __future__ import annotations

import re
import unicodedata
from typing import Iterable

# Mots parasites fréquents dans les libellés bancaires / raisons sociales marocaines.
# Volontairement conservateur : on ne retire que le bruit qui n'aide jamais au matching.
_STOPWORDS: frozenset[str] = frozenset(
    {
        "sarl", "sa", "sas", "sae", "sarlau", "au", "ste", "societe", "soc",
        "ets", "etablissement", "etablissements", "cie", "co", "group", "groupe",
        "et", "de", "des", "du", "la", "le", "les", "el", "al",
        "vir", "virement", "vrt", "paiement", "pmt", "reglement", "regl",
        "facture", "fact", "fac", "ref", "reference", "operation", "op",
        "maroc", "morocco", "casablanca", "rabat",
    }
)

_PUNCT_RE = re.compile(r"[^0-9A-Za-z\s]+")
_WS_RE = re.compile(r"\s+")


def strip_accents(value: str) -> str:
    """Supprime les diacritiques (é -> e, ç -> c...)."""
    nfkd = unicodedata.normalize("NFKD", value)
    return "".join(ch for ch in nfkd if not unicodedata.combining(ch))


def normalize(value: str | None) -> str:
    """
    Normalise un libellé pour comparaison :
    - suppression des accents
    - majuscules
    - ponctuation -> espace
    - espaces multiples compressés
    """
    if not value:
        return ""
    value = strip_accents(value)
    value = value.upper()
    value = _PUNCT_RE.sub(" ", value)
    value = _WS_RE.sub(" ", value)
    return value.strip()


def tokenize(value: str | None, *, drop_stopwords: bool = True, min_len: int = 2) -> set[str]:
    """
    Tokenise un libellé normalisé en un ensemble de mots signifiants.
    Les tokens purement numériques (dates, numéros de pièce) sont conservés
    seulement s'ils font >= 3 caractères (utile pour matcher un n° de facture).
    """
    normalized = normalize(value)
    if not normalized:
        return set()

    tokens: set[str] = set()
    for tok in normalized.split(" "):
        if len(tok) < min_len:
            continue
        if tok.isdigit() and len(tok) < 3:
            continue
        if drop_stopwords and tok in _STOPWORDS:
            continue
        tokens.add(tok)
    return tokens


def token_sort_key(value: str | None) -> str:
    """
    Forme canonique pour comparaison floue : tokens signifiants (stopwords
    retirés) triés et rejoints. Rend Jaro-Winkler robuste aux préfixes de
    raison sociale ("SOCIETE", "STE"...) et à l'ordre des mots.
    Retombe sur `normalize()` si la tokenisation ne laisse rien.
    """
    toks = tokenize(value)
    if not toks:
        return normalize(value)
    return " ".join(sorted(toks))


def common_tokens(labels: Iterable[str | None]) -> set[str]:
    """
    Intersection des tokens signifiants entre plusieurs libellés.
    Renvoie l'ensemble vide si moins de deux libellés exploitables.
    """
    token_sets = [tokenize(lbl) for lbl in labels]
    token_sets = [ts for ts in token_sets if ts]
    if len(token_sets) < 2:
        return set()
    inter = set(token_sets[0])
    for ts in token_sets[1:]:
        inter &= ts
    return inter


def label_cohesion(labels: list[str | None]) -> float:
    """
    Score [0..1] de cohésion d'un GROUPE de libellés : à quel point ils
    partagent du vocabulaire (indice de Jaccard moyen par paires).

    Utilisé pour privilégier les combinaisons de transactions qui portent
    « le même libellé, ou contenant les mêmes mots » (exigence métier).
    """
    token_sets = [tokenize(lbl) for lbl in labels]
    token_sets = [ts for ts in token_sets if ts]
    if len(token_sets) < 2:
        # Un seul libellé exploitable : neutre (ni bonus ni malus).
        return 1.0 if len(token_sets) == 1 else 0.0

    scores: list[float] = []
    for i in range(len(token_sets)):
        for j in range(i + 1, len(token_sets)):
            a, b = token_sets[i], token_sets[j]
            union = a | b
            if not union:
                continue
            scores.append(len(a & b) / len(union))
    if not scores:
        return 0.0
    return sum(scores) / len(scores)
