"""
Ports (Protocols) d'accès aux données pour le classifieur.

Le service NE connaît PAS Supabase : vous injectez des objets qui respectent
ces interfaces. Cela garde `DocumentClassifierService` pur et testable
(des fakes en mémoire suffisent pour les tests unitaires).
"""
from __future__ import annotations

from typing import Optional, Protocol, runtime_checkable

from pydantic import BaseModel


class AliasRecord(BaseModel):
    """Un mapping historique : un libellé tiers déjà rattaché à un PCM."""

    libelle_normalise: str
    tiers_id: Optional[str] = None
    compte_pcm: Optional[str] = None
    categorie_pcm: Optional[str] = None
    type_document: Optional[str] = None


class TiersRecord(BaseModel):
    """Un tiers existant en base, candidat au rapprochement flou."""

    tiers_id: str
    libelle: str
    compte_pcm: Optional[str] = None
    categorie_pcm: Optional[str] = None


@runtime_checkable
class AliasRepository(Protocol):
    """Étape B — historique des alias déjà mappés."""

    def find_by_libelle(self, libelle_normalise: str) -> Optional[AliasRecord]:
        """Retourne l'alias exact (clé = libellé normalisé) ou None."""
        ...


@runtime_checkable
class TiersRepository(Protocol):
    """Étape C — référentiel des tiers pour le fuzzy matching."""

    def list_all(self) -> list[TiersRecord]:
        """
        Retourne les tiers candidats. Implémentation libre (cache conseillé) :
        le classifieur itère dessus pour le scoring Jaro-Winkler.
        """
        ...
