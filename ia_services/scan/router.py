"""
Exemple de câblage FastAPI du module de scan.

À adapter : remplacez `build_classifier` par vos vraies implémentations
Supabase de `AliasRepository` / `TiersRepository` (via Depends).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends

from .classifier import ClassifierConfig, DocumentClassifierService
from .repositories import AliasRepository, TiersRepository
from .schemas import ClassifiedDocument, RawExtraction

router = APIRouter(prefix="/scan", tags=["scan"])


# --- À REMPLACER par vos providers réels (Supabase) -------------------------
def get_alias_repo() -> AliasRepository:  # pragma: no cover - wiring
    raise NotImplementedError("Injectez votre AliasRepository (Supabase).")


def get_tiers_repo() -> TiersRepository:  # pragma: no cover - wiring
    raise NotImplementedError("Injectez votre TiersRepository (Supabase).")


def get_classifier(
    alias_repo: AliasRepository = Depends(get_alias_repo),
    tiers_repo: TiersRepository = Depends(get_tiers_repo),
) -> DocumentClassifierService:
    return DocumentClassifierService(alias_repo, tiers_repo, ClassifierConfig())


@router.post("/classify", response_model=ClassifiedDocument)
def classify_document(
    raw: RawExtraction,
    classifier: DocumentClassifierService = Depends(get_classifier),
) -> ClassifiedDocument:
    """
    Reçoit le JSON BRUT du LLM et renvoie le document classifié
    (type, PCM, catégorie, date redressée, tiers rattaché).
    """
    return classifier.classify(raw)
