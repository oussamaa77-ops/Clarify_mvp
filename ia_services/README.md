# ia_services

Deux extensions logiques **isolées et réutilisables**, prêtes à brancher dans
l'architecture FastAPI existante. Aucun couplage direct à Supabase : les accès
données passent par des `Protocol` (ports) que vous implémentez.

```
ia_services/
├── common/text.py            # normalisation / tokenisation / cohésion de libellés
├── scan/                     # 1. Extraction IA brute + classification déterministe
│   ├── prompts.py            #    prompt d'extraction (LLM = extracteur pur)
│   ├── schemas.py            #    RawExtraction (contrat LLM) / ClassifiedDocument
│   ├── repositories.py       #    ports AliasRepository / TiersRepository
│   ├── classifier.py         #    DocumentClassifierService (Étapes A/B/C)
│   └── router.py             #    exemple de câblage FastAPI
└── reconciliation/           # 2. Rapprochement par tranches / échéances réelles
    ├── schemas.py            #    Echeance / FactureEcheances / OrphanTransaction
    ├── subset_sum.py         #    Subset-Sum exact optimisé (centimes)
    ├── matcher.py            #    find_partial_payments_combinations
    └── router.py             #    exemple de câblage FastAPI
```

Installation : `pip install -r ia_services/requirements.txt`
Vérification : `python -m ia_services._smoketest`

---

## 1. Moteur de scan — extraction IA + classification déterministe

**Principe : le LLM n'est qu'un extracteur.** Il ne devine plus les comptes PCM
(6147, 6174…), ni le type de document, ni la date officielle. Il extrait des
faits (`nom_tiers`, `montant_ttc`, `montant_ht`, `taux_tva`, `dates_detectees`).
Toute la logique comptable vit dans `DocumentClassifierService`.

### Côté appel LLM (Groq / Mistral)

```python
from ia_services.scan import prompts, RawExtraction

messages = prompts.build_extraction_messages(texte_ocr)
resp = client.chat.completions.create(
    model="...", messages=messages,
    response_format=prompts.response_format(),   # JSON strict
)
raw = RawExtraction.model_validate_json(resp.choices[0].message.content)
```

### Classification (déterministe, auditable)

```python
from ia_services.scan import DocumentClassifierService, ClassifierConfig

classifier = DocumentClassifierService(alias_repo, tiers_repo, ClassifierConfig())
doc = classifier.classify(raw)
# doc.type_document, doc.compte_pcm, doc.categorie_pcm, doc.date_document,
# doc.tiers_id, doc.origine_mapping, doc.notes (journal des règles)
```

Ordre des règles (s'arrête au premier match) :

- **Étape A — Règles figées Maroc.** `nom_tiers` (ou texte brut) contient
  `CNSS` / `SECURITE SOCIALE` → `type="Bordereau"`, `compte_pcm="6174"`,
  `categorie="Charges Sociales"`, et **date redressée** sur la date
  d'exécution / télé-règlement (sinon la plus récente). Extensible via
  `ClassifierConfig.hardcoded_rules`.
- **Étape B — Alias & historique.** `AliasRepository.find_by_libelle(libellé_normalisé)`
  → réutilise le PCM déjà mappé pour ce tiers.
- **Étape C — Fuzzy matching.** Jaro-Winkler (`rapidfuzz`) sur une forme
  canonique (stopwords retirés, tokens triés). Score > **85** → rattachement.
  Sinon `besoin_validation_humaine = True`.

### Ports à implémenter (Supabase)

```python
class SupabaseAliasRepo:      # AliasRepository
    def find_by_libelle(self, libelle_normalise: str) -> AliasRecord | None: ...

class SupabaseTiersRepo:      # TiersRepository
    def list_all(self) -> list[TiersRecord]: ...   # cache conseillé
```

Router prêt : `from ia_services.scan.router import router` (à brancher via
`app.include_router(...)` après avoir surchargé `get_alias_repo`/`get_tiers_repo`).

---

## 2. Rapprochement par tranches / échéances réelles

Extension du schéma facture : `echeances: list[Echeance]`
(`montant_attendu`, `date_echeance`). Pour les paiements partiels, on retrouve
parmi les transactions orphelines du même tiers celles qui **égalent
exactement** le montant de chaque tranche.

```python
from ia_services.reconciliation import (
    FactureEcheances, Echeance, OrphanTransaction,
    find_partial_payments_combinations,
)

res = find_partial_payments_combinations(facture, orphan_transactions)
# res.tranches[i].suggestions      -> combinaisons triées pour l'UI
# res.solutions_completes          -> affectations cohérentes (tx jamais réutilisée)
```

Caractéristiques :

- **Subset-Sum exact** en centimes entiers (`subset_sum.py`), avec élagage
  (borne haute + somme des restes), plafonné en taille de combinaison et en
  nombre de résultats.
- **Fenêtre de dates dynamique par tranche** : centrée sur la `date_echeance`
  propre à la tranche, sa largeur s'adapte à l'espacement des tranches voisines
  (demi-écart), donc **pas de limite globale figée** et pas de chevauchement
  entre tranches.
- **Cohérence des libellés** : les suggestions privilégient les combinaisons
  dont les transactions partagent le même libellé / les mêmes mots
  (`libelle_coherence`, `libelles_communs`, `libelle_representatif`), et
  l'affinité avec le libellé du tiers.
- **Suggestions multiples** triées par score quand plusieurs combinaisons
  mathématiques sont valides.

Réglages : `ReconciliationConfig` (`base_window_days`, `min/max_window_days`,
`amount_tolerance`, `max_transactions_per_tranche`, pondérations de score…).

---

### Note environnement

Le proxy TLS d'entreprise peut bloquer `pip`. En cas d'échec :
`pip install --trusted-host pypi.org --trusted-host files.pythonhosted.org -r ia_services/requirements.txt`.
