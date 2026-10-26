# ============================================================================
# chandra_modal.py — Chandra (datalab-to/chandra-ocr-2) servi par vLLM sur un
# GPU Modal, en serverless : facturé à la seconde, éteint quand personne ne
# l'appelle. Expose l'API compatible OpenAI qu'attend src/server/chandra-ocr.ts.
#
# ─── Déployer ────────────────────────────────────────────────────────────────
#   pip install modal
#   modal setup                                   # connexion au compte Modal
#   modal secret create chandra-api-key CHANDRA_API_KEY=<un long secret>
#   modal deploy gpu/chandra_modal.py
# Modal affiche l'URL du serveur, ex. https://<compte>--clarify-chandra-ocr-serve.modal.run
# Dans Railway :
#   CHANDRA_API_BASE = <cette URL>/v1
#   CHANDRA_API_KEY  = le même secret
#   CHANDRA_MODEL    = chandra                    (évite un appel à /models)
#
# ─── Vérifier ────────────────────────────────────────────────────────────────
#   modal run gpu/chandra_modal.py                # réveille le serveur, liste le modèle
#
# ─── Coût et démarrage à froid ───────────────────────────────────────────────
# Le conteneur s'éteint après SCALEDOWN secondes sans requête. Le premier appel
# après une pause le rallume (≈ 1 à 2 min, poids lus depuis le volume ; le tout
# premier déploiement télécharge en plus ~10 Go). Si l'application abandonne
# pendant ce temps, elle retombe sur Mistral OCR : rien n'est perdu.
# ============================================================================

import os
import subprocess

import modal

MODEL = "datalab-to/chandra-ocr-2"
SERVED_NAME = "chandra"
# Version de l'image Docker du script officiel (chandra/scripts/vllm.py).
VLLM_VERSION = "0.17.0"
# L40S (48 Go) : marge confortable pour 5 G paramètres en bf16 et des pages
# jusqu'à 6 Mpx. A10G (24 Go) est moins cher ; à essayer via CHANDRA_GPU=A10G.
GPU = os.environ.get("CHANDRA_GPU", "L40S")
SCALEDOWN = 5 * 60
PORT = 8000

image = (
    modal.Image.from_registry("nvidia/cuda:12.8.0-devel-ubuntu22.04", add_python="3.12")
    .entrypoint([])
    .uv_pip_install(f"vllm=={VLLM_VERSION}", "huggingface_hub")
)

# Poids et compilations gardés entre deux démarrages.
hf_cache = modal.Volume.from_name("huggingface-cache", create_if_missing=True)
vllm_cache = modal.Volume.from_name("vllm-cache", create_if_missing=True)

app = modal.App("clarify-chandra-ocr")


@app.function(
    image=image,
    gpu=GPU,
    scaledown_window=SCALEDOWN,
    timeout=15 * 60,
    volumes={"/root/.cache/huggingface": hf_cache, "/root/.cache/vllm": vllm_cache},
    secrets=[modal.Secret.from_name("chandra-api-key")],
)
@modal.concurrent(max_inputs=16)
@modal.web_server(port=PORT, startup_timeout=15 * 60)
def serve():
    import json

    cmd = [
        "vllm", "serve", MODEL,
        "--host", "0.0.0.0",
        "--port", str(PORT),
        "--served-model-name", SERVED_NAME,
        "--api-key", os.environ["CHANDRA_API_KEY"],
        # Arguments du script officiel.
        "--dtype", "bfloat16",
        "--max-model-len", "18000",
        "--max-num-seqs", "16",
        "--max-num-batched-tokens", "8192",
        "--gpu-memory-utilization", "0.85",
        "--enable-prefix-caching",
        "--mm-processor-kwargs", json.dumps({"min_pixels": 3136, "max_pixels": 6291456}),
        # Démarrage rapide plutôt que débit maximal : on paie surtout le
        # réveil, pas le volume (le script officiel met --no-enforce-eager).
        "--enforce-eager",
    ]
    subprocess.Popen(cmd)


@app.local_entrypoint()
def main():
    """Réveille le serveur et vérifie qu'il sert le modèle (CHANDRA_API_KEY dans l'env local)."""
    import urllib.request

    cle = os.environ.get("CHANDRA_API_KEY", "")
    url = serve.get_web_url().rstrip("/") + "/v1/models"
    print(f"GET {url} (un démarrage à froid peut prendre 1 à 2 min)…")
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {cle}"})
    with urllib.request.urlopen(req, timeout=15 * 60) as r:
        print(r.read().decode())
