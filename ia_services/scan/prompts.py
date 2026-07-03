"""
Prompt d'extraction pour le LLM d'OCR (Groq / Mistral).

RÈGLE D'OR : le LLM est un EXTRACTEUR, pas un comptable.
Il ne doit produire AUCUN compte PCM (6147, 6174...), AUCUN type de document
final, AUCUNE catégorie. Toute cette logique vit dans `DocumentClassifierService`.
"""
from __future__ import annotations

import json

# Schéma JSON strict attendu en sortie (à passer en `response_format` si le
# fournisseur le supporte — Groq/Mistral acceptent le mode JSON).
EXTRACTION_JSON_SCHEMA: dict = {
    "type": "object",
    "additionalProperties": False,
    "required": ["nom_tiers", "dates_detectees"],
    "properties": {
        "nom_tiers": {
            "type": "string",
            "description": "Raison sociale / émetteur exactement tel qu'écrit.",
        },
        "montant_ttc": {"type": ["number", "null"]},
        "montant_ht": {"type": ["number", "null"]},
        "taux_tva": {
            "type": ["number", "null"],
            "description": "Taux de TVA en pourcentage (20 pour 20%), sinon null.",
        },
        "dates_detectees": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["valeur"],
                "properties": {
                    "valeur": {
                        "type": "string",
                        "description": "Date au format ISO AAAA-MM-JJ.",
                    },
                    "role": {
                        "type": ["string", "null"],
                        "description": (
                            "Indice de rôle LU sur le document si présent : "
                            "'emission', 'echeance', 'execution', 'tele-reglement', "
                            "'periode'. Ne rien inventer -> null si inconnu."
                        ),
                    },
                    "texte_source": {"type": ["string", "null"]},
                },
            },
        },
        "texte_brut": {
            "type": ["string", "null"],
            "description": "Reste du texte utile (ICE, adresse, mentions).",
        },
    },
}

EXTRACTION_SYSTEM_PROMPT = """\
Tu es un moteur d'extraction OCR. Ton UNIQUE rôle est de lire un document \
(facture, bordereau, reçu, relevé) et d'en restituer les FAITS bruts au format JSON.

TU NE DOIS JAMAIS :
- deviner ou produire un numéro de compte comptable / PCM (ex : 6147, 6174, 44xx) ;
- décider du "type" comptable final du document ;
- attribuer une catégorie comptable ;
- choisir « la » date officielle du document.

TU DOIS UNIQUEMENT extraire :
- nom_tiers : la raison sociale / l'émetteur, exactement tel qu'écrit ;
- montant_ttc, montant_ht : nombres décimaux (point décimal), ou null si absents ;
- taux_tva : le pourcentage de TVA (ex 20), ou null ;
- dates_detectees : TOUTES les dates présentes, chacune au format AAAA-MM-JJ. \
Pour chaque date, si le document précise explicitement son rôle \
(émission, échéance, exécution, télé-règlement, période), reporte-le dans "role" ; \
sinon mets "role" à null. N'invente jamais de rôle.

Réponds STRICTEMENT en JSON conforme au schéma, sans texte autour, sans commentaire.
"""


def build_extraction_messages(document_text: str) -> list[dict]:
    """
    Construit la liste de messages chat pour un appel Groq/Mistral.
    `document_text` = texte OCR brut (ou contenu multimodal déjà résolu).
    """
    return [
        {"role": "system", "content": EXTRACTION_SYSTEM_PROMPT},
        {
            "role": "user",
            "content": (
                "Document à extraire (restitue le JSON strict) :\n\n"
                f"{document_text}"
            ),
        },
    ]


def response_format() -> dict:
    """`response_format` compatible Groq/Mistral pour forcer un JSON valide."""
    return {
        "type": "json_schema",
        "json_schema": {"name": "extraction", "schema": EXTRACTION_JSON_SCHEMA},
    }


def schema_as_text() -> str:
    """Le schéma JSON en texte (fallback pour les modèles sans json_schema)."""
    return json.dumps(EXTRACTION_JSON_SCHEMA, ensure_ascii=False, indent=2)
