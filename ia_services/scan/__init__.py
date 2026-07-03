"""
Module `scan` : séparation stricte entre
- l'EXTRACTION (le LLM ne fait QUE lire du texte -> JSON brut), et
- la CLASSIFICATION (règles métier déterministes, testables, auditables).
"""
from .schemas import RawExtraction, ClassifiedDocument, DetectedDate, MatchOrigin
from .classifier import DocumentClassifierService, ClassifierConfig
from .repositories import AliasRepository, TiersRepository, TiersRecord, AliasRecord
from . import prompts

__all__ = [
    "RawExtraction",
    "ClassifiedDocument",
    "DetectedDate",
    "MatchOrigin",
    "DocumentClassifierService",
    "ClassifierConfig",
    "AliasRepository",
    "TiersRepository",
    "TiersRecord",
    "AliasRecord",
    "prompts",
]
