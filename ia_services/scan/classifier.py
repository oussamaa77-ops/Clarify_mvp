"""
DocumentClassifierService
=========================

Moteur DÉTERMINISTE de post-traitement. Prend le JSON brut du LLM
(`RawExtraction`) et applique, dans l'ordre, des règles métier auditables :

    Étape A — Règles hardcodées Maroc (CNSS / Sécurité sociale...).
    Étape B — Alias & historique (libellé déjà mappé -> réutilise le PCM).
    Étape C — Fuzzy matching Jaro-Winkler (rapidfuzz) sur les tiers existants.

Aucune de ces décisions n'est confiée au LLM.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Optional

from rapidfuzz.distance import JaroWinkler

from ..common.text import normalize, token_sort_key
from .repositories import AliasRepository, TiersRepository
from .schemas import ClassifiedDocument, DetectedDate, MatchOrigin, RawExtraction


@dataclass(frozen=True)
class HardcodedRule:
    """Une règle figée déclenchée par des mots-clés dans le libellé du tiers."""

    keywords: tuple[str, ...]           # comparés en libellé NORMALISÉ
    type_document: str
    compte_pcm: str
    categorie_pcm: str
    # Rôles de date à privilégier pour redresser la date officielle du document,
    # par ordre de préférence (ex : un bordereau CNSS -> date de télé-règlement).
    date_roles_priorises: tuple[str, ...] = ()
    # Si aucun rôle ne matche, prendre la date la plus récente (True) ou None.
    fallback_date_la_plus_recente: bool = True


# --- Règles métier Maroc (extensibles) --------------------------------------
DEFAULT_HARDCODED_RULES: tuple[HardcodedRule, ...] = (
    # CNSS — règle STRICTE : tout document émis par la Caisse Nationale de
    # Sécurité Sociale est une charge sociale imputée OBLIGATOIREMENT au 6174.
    # Mots-clés volontairement spécifiques : on N'UTILISE PAS le fragment isolé
    # "CAISSE NATIONALE" car il capturerait à tort la « CAISSE NATIONALE DE
    # CRÉDIT AGRICOLE » (CNCA, une banque → jamais 6174). Seuls "CNSS", le nom
    # complet, ou "SECURITE SOCIALE" déclenchent la règle.
    HardcodedRule(
        keywords=(
            "CNSS",
            "CAISSE NATIONALE DE SECURITE SOCIALE",
            "SECURITE SOCIALE",
            "SECURITE SOCIAL",
        ),
        type_document="Bordereau",
        compte_pcm="6174",
        categorie_pcm="Charges Sociales",
        date_roles_priorises=("execution", "tele-reglement", "teleregement", "paiement"),
        fallback_date_la_plus_recente=True,
    ),
)


@dataclass
class ClassifierConfig:
    """Paramètres du moteur."""

    fuzzy_threshold: float = 85.0          # score Jaro-Winkler (0..100)
    hardcoded_rules: tuple[HardcodedRule, ...] = field(
        default_factory=lambda: DEFAULT_HARDCODED_RULES
    )


class DocumentClassifierService:
    """
    Service stateless (hors config + repositories injectés). Réutilisable :
    instanciez-le une fois, appelez `classify()` par document.
    """

    def __init__(
        self,
        alias_repo: AliasRepository,
        tiers_repo: TiersRepository,
        config: Optional[ClassifierConfig] = None,
    ) -> None:
        self._alias_repo = alias_repo
        self._tiers_repo = tiers_repo
        self._config = config or ClassifierConfig()

    # ------------------------------------------------------------------ API --
    def classify(self, raw: RawExtraction) -> ClassifiedDocument:
        doc = ClassifiedDocument(
            nom_tiers=raw.nom_tiers,
            montant_ttc=raw.montant_ttc,
            montant_ht=raw.montant_ht,
            taux_tva=raw.taux_tva,
            tiers_libelle_normalise=normalize(raw.nom_tiers),
        )

        # Étape A — règles figées (prioritaire, s'arrête si match).
        if self._apply_hardcoded_rules(raw, doc):
            self._finalize_date(raw, doc, roles_priorises=self._matched_rule_date_roles)
            return doc

        # Étape B — alias / historique.
        if self._apply_alias(doc):
            self._finalize_date(raw, doc, roles_priorises=("emission", "facture"))
            return doc

        # Étape C — fuzzy matching.
        self._apply_fuzzy(doc)
        self._finalize_date(raw, doc, roles_priorises=("emission", "facture"))

        if doc.origine_mapping == MatchOrigin.UNRESOLVED:
            doc.besoin_validation_humaine = True
            doc.notes.append("Aucun mapping (hardcodé/alias/fuzzy) : validation requise.")
        return doc

    # ----------------------------------------------------- Étape A (figée) --
    def _apply_hardcoded_rules(self, raw: RawExtraction, doc: ClassifiedDocument) -> bool:
        self._matched_rule_date_roles: tuple[str, ...] = ()
        haystack = normalize(raw.nom_tiers)
        # On enrichit avec le texte brut : certains bordereaux ne mettent "CNSS"
        # que dans le corps, pas dans l'en-tête tiers.
        haystack_full = f"{haystack} {normalize(raw.texte_brut)}".strip()

        for rule in self._config.hardcoded_rules:
            if any(kw in haystack_full for kw in rule.keywords):
                doc.type_document = rule.type_document
                doc.compte_pcm = rule.compte_pcm
                doc.categorie_pcm = rule.categorie_pcm
                doc.origine_mapping = MatchOrigin.HARDCODED
                doc.notes.append(
                    f"Règle figée déclenchée par {rule.keywords} "
                    f"-> {rule.type_document} / PCM {rule.compte_pcm}."
                )
                self._matched_rule_date_roles = rule.date_roles_priorises
                return True
        return False

    # ---------------------------------------------------- Étape B (alias) --
    def _apply_alias(self, doc: ClassifiedDocument) -> bool:
        key = doc.tiers_libelle_normalise or ""
        if not key:
            return False
        alias = self._alias_repo.find_by_libelle(key)
        if alias is None:
            return False

        doc.tiers_id = alias.tiers_id
        doc.compte_pcm = alias.compte_pcm
        doc.categorie_pcm = alias.categorie_pcm
        if alias.type_document:
            doc.type_document = alias.type_document
        doc.origine_mapping = MatchOrigin.ALIAS
        doc.notes.append(
            f"Alias historique trouvé pour « {key} » -> PCM {alias.compte_pcm}."
        )
        return True

    # ---------------------------------------------------- Étape C (fuzzy) --
    def _apply_fuzzy(self, doc: ClassifiedDocument) -> None:
        if not (doc.tiers_libelle_normalise or ""):
            return
        # On compare des formes canoniques (stopwords retirés, tokens triés)
        # pour que Jaro-Winkler ne soit pas pénalisé par "SOCIETE"/"STE" & co.
        target = token_sort_key(doc.nom_tiers)

        best_score = 0.0
        best = None
        for tiers in self._tiers_repo.list_all():
            candidate = token_sort_key(tiers.libelle)
            if not candidate:
                continue
            # Jaro-Winkler renvoie une similarité 0..1 -> on passe en 0..100.
            score = JaroWinkler.similarity(target, candidate) * 100.0
            if score > best_score:
                best_score = score
                best = tiers

        if best is not None and best_score >= self._config.fuzzy_threshold:
            doc.tiers_id = best.tiers_id
            doc.compte_pcm = best.compte_pcm
            doc.categorie_pcm = best.categorie_pcm
            doc.origine_mapping = MatchOrigin.FUZZY
            doc.score_matching = round(best_score, 2)
            doc.notes.append(
                f"Fuzzy Jaro-Winkler : « {target} » ~ « {normalize(best.libelle)} » "
                f"(score {best_score:.1f} >= {self._config.fuzzy_threshold})."
            )
        elif best is not None:
            # On journalise le meilleur candidat rejeté, utile côté UI.
            doc.score_matching = round(best_score, 2)
            doc.notes.append(
                f"Meilleur candidat flou « {normalize(best.libelle)} » rejeté "
                f"(score {best_score:.1f} < {self._config.fuzzy_threshold})."
            )

    # ----------------------------------------- Sélection de la date officielle --
    def _finalize_date(
        self,
        raw: RawExtraction,
        doc: ClassifiedDocument,
        roles_priorises: tuple[str, ...],
    ) -> None:
        """
        Choisit la `date_document` de façon déterministe :
        1. première date dont le `role` (normalisé) matche la priorité métier ;
        2. sinon, la date la plus récente (redressement typique des bordereaux
           où la date d'exécution/télé-règlement est postérieure à l'émission).
        """
        dates = [d for d in raw.dates_detectees if isinstance(d, DetectedDate)]
        if not dates:
            doc.notes.append("Aucune date détectée.")
            return

        # 1) match par rôle.
        for role in roles_priorises:
            role_n = normalize(role).replace(" ", "")
            for d in dates:
                if d.role and normalize(d.role).replace(" ", "") == role_n:
                    doc.date_document = d.valeur
                    doc.notes.append(
                        f"Date redressée via rôle « {d.role} » -> {d.valeur.isoformat()}."
                    )
                    return

        # 2) fallback : date la plus récente.
        latest = max(dates, key=lambda d: d.valeur)
        doc.date_document = latest.valeur
        doc.notes.append(
            f"Date retenue = plus récente détectée -> {latest.valeur.isoformat()}."
        )
