import os
os.environ["HF_HUB_DISABLE_SSL_VERIFY"] = "1"
os.environ["PYTHONHTTPSVERIFY"] = "0"

import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# LE BLINDAGE ULTIME : On force la bibliothèque réseau à ignorer le certificat du proxy
import requests
from requests.adapters import HTTPAdapter
orig_send = HTTPAdapter.send
def subclassed_send(self, request, **kwargs):
    kwargs['verify'] = False
    return orig_send(self, request, **kwargs)
HTTPAdapter.send = subclassed_send

import io
from fastapi import FastAPI, UploadFile, File, HTTPException
import uvicorn
from transformers import DonutProcessor, VisionEncoderDecoderModel
import PIL.Image
import torch

app = FastAPI()

print("🔄 [Option Nucléaire] Téléchargement forcé via le proxy... Patientez.")
try:
    processor = DonutProcessor.from_pretrained("naver-clova-ix/donut-base-finetuned-cord-v2")
    model = VisionEncoderDecoderModel.from_pretrained("naver-clova-ix/donut-base-finetuned-cord-v2")
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model.to(device)
    print(f"✅ Modele charge sur : {device.upper()}")
except Exception as e:
    print(f"❌ Erreur : {e}")

@app.post("/parse")
async def parse_statement(file: UploadFile = File(...)):
    try:
        image_bytes = await file.read()
        image = PIL.Image.open(io.BytesIO(image_bytes)).convert("RGB")
        pixel_values = processor(image, return_tensors="pt").pixel_values.to(device)
        task_prompt = "<s_cord-v2>"
        decoder_input_ids = processor.tokenizer(task_prompt, add_special_tokens=False, return_tensors="pt").input_ids.to(device)
        
        outputs = model.generate(
            pixel_values,
            decoder_input_ids=decoder_input_ids,
            max_length=model.config.decoder.max_position_embeddings,
            early_stopping=True,
        )
        prediction = processor.token2json(outputs[0])
        
        txs_mappees = []
        items_bruts = []
        if isinstance(prediction, dict):
            if "menu" in prediction and isinstance(prediction["menu"], dict):
                items_bruts = prediction["menu"].get("item", [])
            else:
                items_bruts = prediction.get("item", [])
                
        if isinstance(items_bruts, list):
            for item in items_bruts:
                if isinstance(item, dict):
                    libelle = item.get("nm") or item.get("item_name") or item.get("nm_ex") or "TRANSACTION"
                    montant_str = item.get("price") or item.get("sub_total", {}).get("subtotal_price") or "0"
                    try:
                        montant = float(str(montant_str).replace(",", ".").replace(" ", ""))
                    except ValueError:
                        montant = 0.0
                        
                    txs_mappees.append({
                        "date_operation": item.get("date") or "",
                        "libelle": str(libelle).strip().upper(),
                        "montant_debit": montant if "PAIEMENT" in str(libelle).upper() or "CHEQUE" in str(libelle).upper() else None,
                        "montant_credit": montant if "REMISE" in str(libelle).upper() or "VIREMENT" in str(libelle).upper() else None
                    })

        return {
            "banque": "Attijariwafa bank (Local)",
            "rib": "",
            "solde_initial": 0.0,
            "solde_final": 0.0,
            "txs": txs_mappees
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8501)
