"""
Micro-service Donut — OCR de relevés bancaires (option locale / hors-ligne).

Contrat HTTP (identique à ce qu'attend callDonutLocal côté TS) :
    POST /parse   { "image_base64": "...", "mime_type": "image/jpeg" }
    → 200 { "banque", "rib", "solde_initial", "solde_final", "txs": [ ... ] }
    → 5xx en cas d'échec modèle (OOM, etc.) → le SaaS bascule sur Gemini/Groq.

Démarrage :
    uvicorn app:app --host 127.0.0.1 --port 8501
(le port 8501 correspond à DONUT_ENDPOINT dans le .env du SaaS)
"""

from __future__ import annotations

# Réseau d'entreprise avec inspection SSL (proxy à certificat auto-signé) :
# on fait confiance au magasin de certificats du système (Windows/macOS), où le
# CA du proxy est déjà installé — sinon HuggingFace échoue en CERTIFICATE_VERIFY_FAILED.
# Optionnel : si truststore n'est pas installé, on continue sans.
try:
    import truststore as _truststore

    _truststore.inject_into_ssl()
except Exception:  # noqa: BLE001
    pass

import base64
import binascii
import io
import logging
import os
import re
from contextlib import asynccontextmanager
from typing import Any, Optional

import torch
from fastapi import FastAPI, HTTPException
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field
from transformers import DonutProcessor, VisionEncoderDecoderModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s [donut] %(levelname)s %(message)s")
log = logging.getLogger("donut")

# ─── Backend Python unifié « Clarify » ───────────────────────────────────────
# On greffe ici les services IA (scan + rapprochement) situés dans le package
# `ia_services` à la RACINE du repo, pour n'avoir qu'un seul process/port.
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    # Rend `ia_services` importable même lancé via `uvicorn app:app` depuis ce dossier.
    sys.path.insert(0, str(_REPO_ROOT))


def _load_root_dotenv() -> None:
    """Charge le .env de la racine (SUPABASE_URL, SERVICE_ROLE_KEY…) sans dépendance.
    `setdefault` : n'écrase jamais une variable déjà présente dans l'environnement."""
    env_path = _REPO_ROOT / ".env"
    if not env_path.exists():
        return
    try:
        for raw in env_path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))
    except Exception:  # noqa: BLE001 - un .env illisible ne doit pas bloquer l'app
        log.warning("Lecture du .env racine impossible — variables d'env système utilisées.")


_load_root_dotenv()

from ia_services.reconciliation import router as reconciliation_router  # noqa: E402
from ia_services.scan import router as scan_router  # noqa: E402
from ia_services.scan.supabase_repositories import (  # noqa: E402
    SupabaseAliasRepository,
    SupabaseTiersRepository,
)

# ─── Configuration (surchargée par variables d'environnement) ────────────────
MODEL_NAME = os.environ.get("DONUT_MODEL", "naver-clova-ix/donut-base-finetuned-cord-v2")
# Prompt de tâche du décodeur. Pour un modèle fine-tuné « relevé » mettez le vôtre,
# ex. "<s_releve>" ; par défaut on utilise la tâche CORD (reçus) dont le vocabulaire
# nm/price est mappé vers libelle/montant côté SaaS.
TASK_PROMPT = os.environ.get("DONUT_TASK_PROMPT", "<s_cord-v2>")
MAX_LENGTH = int(os.environ.get("DONUT_MAX_LENGTH", "1536"))
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

# Le modèle est chargé une seule fois au démarrage (objet lourd : ~700 Mo).
STATE: dict[str, Any] = {"processor": None, "model": None}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    log.info("Chargement du modèle Donut '%s' sur %s …", MODEL_NAME, DEVICE)
    try:
        processor = DonutProcessor.from_pretrained(MODEL_NAME)
        model = VisionEncoderDecoderModel.from_pretrained(MODEL_NAME)
        model.to(DEVICE)
        model.eval()
        STATE["processor"] = processor
        STATE["model"] = model
        log.info("Modèle prêt.")
    except Exception:  # noqa: BLE001
        # On loggue mais on laisse le service démarrer : /parse renverra alors
        # 503 et le SaaS basculera proprement sur le cloud.
        log.exception("Échec du chargement du modèle Donut")
    yield
    STATE.clear()


app = FastAPI(title="Clarify backend (Donut OCR + services IA)", version="1.1.0", lifespan=lifespan)

# ─── Montage des services IA ─────────────────────────────────────────────────
# Repos Supabase en singletons (le cache tiers du fuzzy est ainsi partagé).
_alias_repo = SupabaseAliasRepository()
_tiers_repo = SupabaseTiersRepository()

# On surcharge les providers `Depends` déclarés dans le router de scan pour y
# injecter les implémentations Supabase (le router reste réutilisable/testable).
app.dependency_overrides[scan_router.get_alias_repo] = lambda: _alias_repo
app.dependency_overrides[scan_router.get_tiers_repo] = lambda: _tiers_repo

app.include_router(scan_router.router)                # POST /scan/classify
app.include_router(reconciliation_router.router)      # POST /reconciliation/partial-payments


class ParseRequest(BaseModel):
    image_base64: str = Field(..., min_length=16)
    mime_type: str = "image/jpeg"


# ─── Décodage image ──────────────────────────────────────────────────────────
def decode_image(image_base64: str) -> Image.Image:
    # Tolère un préfixe data-URI éventuel ("data:image/jpeg;base64,....").
    if "," in image_base64 and image_base64.strip().startswith("data:"):
        image_base64 = image_base64.split(",", 1)[1]
    try:
        raw = base64.b64decode(image_base64, validate=False)
        return Image.open(io.BytesIO(raw)).convert("RGB")
    except (binascii.Error, ValueError, UnidentifiedImageError) as exc:
        raise HTTPException(status_code=422, detail=f"Image illisible: {exc}") from exc


# ─── Normalisation montants marocains : "1 234,56" → 1234.56 ─────────────────
def to_number(value: Any) -> Optional[float]:
    if value is None:
        return None
    s = re.sub(r"[^\d,.\-]", "", str(value)).replace(" ", "")
    if not s:
        return None
    # "1.234,56" (séparateur milliers point) ou "1234,56" → virgule = décimale
    if "," in s:
        s = s.replace(".", "").replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def first(d: dict, *keys: str, default: Any = None) -> Any:
    for k in keys:
        if k in d and d[k] not in (None, ""):
            return d[k]
    return default


# ─── Traduction sortie Donut (token2json) → format relevé du SaaS ────────────
def donut_to_releve(parsed: dict) -> dict:
    """
    Donut renvoie un dict imbriqué (schéma CORD ou schéma 'relevé' fine-tuné).
    On extrait une liste de lignes et on les ré-exprime avec les clés attendues.
    Les clés brutes (nm/price) sont conservées : le mappeur TS sait les lire.
    """
    # La liste des transactions peut s'appeler txs / transactions / menu / lignes.
    rows = (
        first(parsed, "txs", "transactions", "menu", "lignes", "items", default=[])
        or []
    )
    if isinstance(rows, dict):  # Donut renvoie un objet seul quand 1 ligne
        rows = [rows]

    txs: list[dict] = []
    for it in rows:
        if not isinstance(it, dict):
            continue
        libelle = first(it, "libelle", "nm", "name", "nature_operation", "description", default="")
        montant = to_number(first(it, "montant", "price", "amount", "value"))
        solde = to_number(first(it, "solde_courant", "solde", "balance"))

        # Sens éventuel fourni par un modèle fine-tuné ; sinon le SaaS tranche
        # via le delta de solde + mots-clés.
        sens = str(first(it, "sens", "type", "direction", default="")).lower()
        debit = to_number(first(it, "montant_debit", "debit"))
        credit = to_number(first(it, "montant_credit", "credit"))
        if debit is None and credit is None and montant is not None:
            if re.search(r"cred|créd|recu|reçu", sens):
                credit = montant
            elif re.search(r"deb|déb", sens):
                debit = montant

        txs.append(
            {
                "date_operation": first(it, "date_operation", "date", default=""),
                "date_valeur": first(it, "date_valeur", "date_operation", "date", default=""),
                "reference": first(it, "reference", "ref", default=""),
                "libelle": libelle,
                "nature_operation": first(it, "nature_operation", default=""),
                "montant": montant if montant is not None else 0,
                "montant_debit": debit,
                "montant_credit": credit,
                "solde_courant": solde,
            }
        )

    return {
        "banque": first(parsed, "banque", "bank", default="Banque (Donut local)"),
        "rib": first(parsed, "rib", "iban", default=""),
        "solde_initial": to_number(first(parsed, "solde_initial", "solde_depart")) or 0,
        "solde_final": to_number(first(parsed, "solde_final", "nouveau_solde")) or 0,
        "txs": txs,
    }


# ─── Inférence Donut ─────────────────────────────────────────────────────────
def run_donut(image: Image.Image) -> dict:
    processor: DonutProcessor = STATE["processor"]
    model: VisionEncoderDecoderModel = STATE["model"]

    pixel_values = processor(image, return_tensors="pt").pixel_values.to(DEVICE)
    decoder_input_ids = processor.tokenizer(
        TASK_PROMPT, add_special_tokens=False, return_tensors="pt"
    ).input_ids.to(DEVICE)

    with torch.no_grad():
        outputs = model.generate(
            pixel_values,
            decoder_input_ids=decoder_input_ids,
            max_length=MAX_LENGTH,
            pad_token_id=processor.tokenizer.pad_token_id,
            eos_token_id=processor.tokenizer.eos_token_id,
            use_cache=True,
            bad_words_ids=[[processor.tokenizer.unk_token_id]],
            return_dict_in_generate=True,
        )

    seq = processor.batch_decode(outputs.sequences)[0]
    seq = seq.replace(processor.tokenizer.eos_token, "").replace(processor.tokenizer.pad_token, "")
    seq = re.sub(r"<.*?>", "", seq, count=1).strip()  # retire le 1er token de tâche
    return processor.token2json(seq)


# ─── Endpoints ───────────────────────────────────────────────────────────────
@app.get("/health")
def health() -> dict:
    return {"status": "ok", "model": MODEL_NAME, "device": DEVICE, "loaded": STATE.get("model") is not None}


@app.post("/parse")
def parse(req: ParseRequest) -> dict:
    if STATE.get("model") is None:
        # 503 → côté SaaS, res.ok == false → repli automatique Gemini/Groq.
        raise HTTPException(status_code=503, detail="Modèle Donut non chargé")

    image = decode_image(req.image_base64)
    try:
        parsed = run_donut(image)
    except torch.cuda.OutOfMemoryError as exc:  # type: ignore[attr-defined]
        log.error("OOM GPU pendant l'inférence: %s", exc)
        raise HTTPException(status_code=503, detail="OOM mémoire Donut") from exc
    except MemoryError as exc:
        log.error("OOM CPU pendant l'inférence: %s", exc)
        raise HTTPException(status_code=503, detail="OOM mémoire Donut") from exc
    except Exception as exc:  # noqa: BLE001
        log.exception("Erreur d'inférence Donut")
        raise HTTPException(status_code=500, detail=f"Inférence Donut KO: {exc}") from exc

    result = donut_to_releve(parsed if isinstance(parsed, dict) else {})
    log.info("Relevé parsé: %d transactions", len(result["txs"]))
    return result


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app:app",
        host=os.environ.get("DONUT_HOST", "127.0.0.1"),
        port=int(os.environ.get("DONUT_PORT", "8501")),
        reload=False,
    )
