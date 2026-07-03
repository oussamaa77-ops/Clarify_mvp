"""
Schémas Pydantic du module de scan.

`RawExtraction`      = contrat de sortie du LLM (extraction pure, aucun PCM).
`ClassifiedDocument` = résultat après passage dans le moteur déterministe.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field, field_validator


class MatchOrigin(str, Enum):
    """D'où provient le compte PCM finalement retenu (traçabilité / audit)."""

    HARDCODED = "hardcoded"        # Étape A : règle métier Maroc figée (CNSS...)
    ALIAS = "alias"                # Étape B : alias historique déjà mappé
    FUZZY = "fuzzy"                # Étape C : rapprochement flou sur les tiers
    UNRESOLVED = "unresolved"      # Aucun mapping : à traiter par un humain


class DetectedDate(BaseModel):
    """
    Une date repérée par le LLM. Le LLM peut (optionnellement) fournir un
    `role` textuel non contraint ("execution", "tele-reglement", "echeance",
    "emission"...). La logique de sélection finale reste déterministe côté
    service : on ne fait JAMAIS confiance au LLM pour décider de la date
    officielle du document.
    """

    valeur: date
    role: Optional[str] = Field(
        default=None,
        description="Indice textuel de rôle fourni par le LLM, non contraint.",
    )
    texte_source: Optional[str] = Field(
        default=None, description="Chaîne brute telle que lue sur le document."
    )


class RawExtraction(BaseModel):
    """
    CONTRAT DE SORTIE DU LLM — extraction brute uniquement.

    Le LLM ne doit PAS deviner : type de document, compte PCM (6147, 6174...),
    catégorie comptable, ni « la » date officielle. Il extrait des faits.
    """

    nom_tiers: str = Field(..., description="Raison sociale / émetteur tel qu'écrit.")
    montant_ttc: Optional[Decimal] = Field(default=None)
    montant_ht: Optional[Decimal] = Field(default=None)
    taux_tva: Optional[Decimal] = Field(
        default=None, description="Taux TVA en pourcentage, ex 20 pour 20%."
    )
    dates_detectees: list[DetectedDate] = Field(default_factory=list)

    # Texte brut résiduel, utile au fuzzy matching (ICE, adresse, mentions...).
    texte_brut: Optional[str] = Field(default=None)

    @field_validator("nom_tiers")
    @classmethod
    def _strip_tiers(cls, v: str) -> str:
        return (v or "").strip()


class ClassifiedDocument(BaseModel):
    """Résultat déterministe, prêt à être persisté / lettré."""

    # Report des données extraites (inchangées).
    nom_tiers: str
    montant_ttc: Optional[Decimal] = None
    montant_ht: Optional[Decimal] = None
    taux_tva: Optional[Decimal] = None

    # Décisions déterministes.
    type_document: Optional[str] = None
    compte_pcm: Optional[str] = None
    categorie_pcm: Optional[str] = None
    date_document: Optional[date] = None

    # Rattachement tiers.
    tiers_id: Optional[str] = None
    tiers_libelle_normalise: Optional[str] = None

    # Traçabilité de la décision.
    origine_mapping: MatchOrigin = MatchOrigin.UNRESOLVED
    score_matching: Optional[float] = Field(
        default=None, description="Score du fuzzy matching (0..100) si applicable."
    )
    besoin_validation_humaine: bool = False
    notes: list[str] = Field(
        default_factory=list,
        description="Journal lisible des règles appliquées (audit / debug).",
    )
