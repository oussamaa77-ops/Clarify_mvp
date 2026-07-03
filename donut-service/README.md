# Service Donut — OCR de relevés bancaires (option locale)

Micro-service Python (FastAPI + PyTorch) qui exécute le modèle **Donut** en
local et expose un endpoint HTTP. Le SaaS (`ocrReleve` dans
`src/server/factures.functions.ts`) l'appelle **en priorité** ; si le service
est éteint, en OOM, trop lent ou renvoie un JSON illisible, le SaaS bascule
**automatiquement** sur Gemini/Groq. Le service est donc 100 % optionnel.

## Contrat HTTP

```
POST /parse
  body : { "image_base64": "<base64 sans préfixe>", "mime_type": "image/jpeg" }
  200  : { "banque", "rib", "solde_initial", "solde_final",
           "txs": [ { "date_operation", "date_valeur", "reference",
                      "libelle", "nature_operation", "montant",
                      "montant_debit", "montant_credit", "solde_courant" } ] }
  5xx  : modèle non chargé / OOM / erreur d'inférence → repli cloud côté SaaS

GET /health → { status, model, device, loaded }
```

## Installation

```bash
cd donut-service
python -m venv .venv

# Windows PowerShell
.venv\Scripts\Activate.ps1
# (Linux/macOS : source .venv/bin/activate)

pip install -r requirements.txt
```

> **GPU (optionnel) :** pour une build CUDA de PyTorch, installez torch d'abord
> via la commande adaptée sur https://pytorch.org puis `pip install -r requirements.txt`.
> Sans GPU, Donut tourne sur CPU (10-30 s/page) — d'où le garde-fou
> `DONUT_TIMEOUT_MS=25000` côté SaaS.

## Démarrage

```bash
uvicorn app:app --host 127.0.0.1 --port 8501
# ou simplement : python app.py
```

Le port `8501` correspond à `DONUT_ENDPOINT=http://127.0.0.1:8501/parse`
dans le `.env` du SaaS.

## Configuration (variables d'environnement)

| Variable            | Défaut                                          | Rôle |
|---------------------|-------------------------------------------------|------|
| `DONUT_MODEL`       | `naver-clova-ix/donut-base-finetuned-cord-v2`   | Modèle HF. Remplacez par votre modèle fine-tuné « relevé ». |
| `DONUT_TASK_PROMPT` | `<s_cord-v2>`                                    | Token de tâche du décodeur (ex. `<s_releve>` pour un fine-tune maison). |
| `DONUT_MAX_LENGTH`  | `1536`                                           | Longueur max de génération (relevés denses → augmentez). |
| `DONUT_HOST` / `DONUT_PORT` | `127.0.0.1` / `8501`                     | Adresse d'écoute. |

## Test rapide

```bash
# encode une image puis appelle /parse
python -c "import base64,json,urllib.request; b=base64.b64encode(open('releve.jpg','rb').read()).decode(); \
print(urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8501/parse', \
data=json.dumps({'image_base64':b,'mime_type':'image/jpeg'}).encode(), \
headers={'Content-Type':'application/json'})).read().decode())"
```

## Note sur la précision

`donut-base-finetuned-cord-v2` est entraîné sur des **reçus** (schéma `nm`/`price`),
pas sur des relevés bancaires marocains. Il fonctionnera comme démonstrateur mais
la qualité réelle exige un **fine-tuning sur vos relevés** (Attijariwafa, Banque
Populaire, CIH). Le mapping (`donut_to_releve`) accepte déjà un schéma `relevé`
personnalisé (`txs`/`libelle`/`montant`/`solde_courant`…) : il suffira de pointer
`DONUT_MODEL` + `DONUT_TASK_PROMPT` vers votre modèle entraîné, sans toucher au SaaS.
```
