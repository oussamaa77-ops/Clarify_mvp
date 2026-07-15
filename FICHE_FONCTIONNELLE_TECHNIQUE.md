# Clarify — Fiche Fonctionnelle & Technique complète

> Application SaaS B2B d'automatisation comptable pour le marché marocain
> (cabinets d'expertise comptable & TPE/PME). Nom de code repo : `hisabpro` / `Clarify`.
> Document de référence — fonctionnalités, architecture technique, pipelines IA.

---

## 1. Présentation générale

| Dimension | Valeur |
|---|---|
| **Type** | SaaS B2B **multi-tenant** (cabinet → dossiers → entités comptables) |
| **Marché** | Maroc — Plan Comptable Marocain (PCM), ICE/IF/RC, TVA CGI, conformité DGI/EDI, CNSS/AMO |
| **Proposition de valeur** | Numérisation (OCR IA) des factures & relevés bancaires, comptabilisation automatique, rapprochement bancaire (lettrage), e-facture DGI, fiscalité et paie |
| **Nature** | Full-stack TypeScript (SSR) + services IA Python optionnels |
| **Utilisateurs** | Expert-comptable, assistant cabinet, chef d'entreprise, collaborateur (rôles applicatifs) |

L'application couvre le **cycle comptable complet** : import documentaire → extraction IA → écritures → rapprochement bancaire → grand livre/balance → déclarations fiscales → paie → archivage probant (GED) → piste d'audit.

---

## 2. Architecture technique globale

### 2.1 Vue d'ensemble

```
┌──────────────────────────────────────────────────────────────────────┐
│  NAVIGATEUR (React 19 SSR + TanStack Router)                          │
│   • UI Radix/shadcn + Tailwind 4 · recharts · sonner                  │
│   • Pré-traitement PDF LOCAL (pdf.js : extraction texte, tri Y)       │
└───────────────┬──────────────────────────────────────────────────────┘
                │  server functions (createServerFn, validées Zod, JWT)
┌───────────────▼──────────────────────────────────────────────────────┐
│  SERVEUR NODE (TanStack Start / Nitro)  — la « couche API »           │
│   • OCR / catégorisation / lettrage / e-facture / paie / mail         │
│   • Appels LLM externes : Mistral (principal) · Groq/Gemini (secours) │
└───────┬───────────────────────────────────────────┬──────────────────┘
        │ supabase-js (anon + service_role)          │  HTTP (option)
┌───────▼───────────────────────┐         ┌──────────▼───────────────────┐
│  SUPABASE (BaaS)               │         │  BACKEND PYTHON (donut-service)│
│   • Postgres + RLS multi-tenant│         │   • FastAPI unifié             │
│   • Auth (JWT) · Storage (ged) │         │   • /parse  Donut OCR local    │
│   • Triggers PL/pgSQL + RPC    │         │   • /scan/classify (déterministe)│
│     lier_transaction (atomique)│         │   • /reconciliation/partial-…  │
└────────────────────────────────┘         └───────────────────────────────┘
```

### 2.2 Stack précise (d'après `package.json`)

**Front-end / Framework**
- **TanStack Start** (`@tanstack/react-start`) — React 19 **SSR** + **server functions** (pas un SPA pur).
- **TanStack Router** (`@tanstack/react-router`, `@tanstack/router-plugin`) — routing *file-based*, arbre généré `routeTree.gen.ts`.
- **Vite** (bundler) + `@vitejs/plugin-react` → build serveur Node (`.output/server/index.mjs`).
- **État** : React hooks (`useState/useEffect`) + appels **supabase-js** directs + contexte `useAuth`. (Pas de Redux/Zustand ; pas de React Query dans les dépendances actuelles.)

**UI**
- **Radix UI** + pattern **shadcn/ui** (`components.json`) — ~50 composants `src/components/ui/*`.
- **Tailwind CSS 4** (`@tailwindcss/vite`, `tw-animate-css`).
- `lucide-react` (icônes), `sonner` (toasts), `recharts` (graphiques), `vaul` (drawer), `cmdk` (command palette), `date-fns`.
- Formulaires : `react-hook-form` + `@hookform/resolvers` + **Zod**.

**Traitement documentaire côté client**
- `pdfjs-dist` — extraction de texte PDF **dans le navigateur** (worker `public/pdf.worker.min.mjs`).
- `xlsx` — export tableur (Sage / EDI).

**Back-end / Données**
- **Supabase** : Postgres managé, Auth, Storage (bucket privé `ged`), RLS. Accès via `@supabase/supabase-js`.
- **Server functions** TanStack (Node) validées par **Zod**, protégées par middleware JWT.

**Services IA Python (optionnels, isolés)**
- `donut-service/` : **FastAPI** + `torch` + `transformers` (modèle **Donut** `naver-clova-ix/donut-base-finetuned-cord-v2`) pour OCR relevé local/hors-ligne.
- `ia_services/` : classification déterministe (`rapidfuzz`) + rapprochement par échéances (subset-sum).

**Tests / Qualité**
- **Vitest** (unitaires), **Playwright** (E2E) + **Allure** (rapports), ESLint, TypeScript.

---

## 3. Modèle de données (Supabase / Postgres)

### 3.1 Hiérarchie multi-tenant

```
cabinets ─┬─ profiles (1:1 auth.users)          ← tenant racine
          ├─ user_roles (app_role)
          └─ dossiers ─┬─ dossier_access          ← partage granulaire
                       ├─ clients / fournisseurs
                       ├─ factures / factures_fournisseurs
                       ├─ comptes_comptables / journaux_comptables
                       ├─ ecritures_comptables      ← Grand Livre
                       ├─ comptes_bancaires
                       ├─ releves_bancaires (PARENT) ─┐
                       ├─ transactions_bancaires ─────┘ (enfant, releve_id)
                       ├─ justificatifs
                       ├─ ged_documents (Storage)
                       ├─ audit_logs (hash-chain)
                       └─ alertes
```

- **`dossiers`** : entité d'isolation métier, porte l'identité légale (`ice`, `rc`, `if_fiscal`).
- **`factures` / `factures_fournisseurs`** : montants `NUMERIC(15,2)`, `statut`, `statut_paiement`, `statut_dgi`, `xml_ubl`, `hash_sha256`, `dgi_uuid`, **`echeances` (jsonb)** pour paiements partiels.
- **`transactions_bancaires`** : cœur du rapprochement — `facture_id`, `justificatif_id`, `document_type`, `statut` (`ouvert`/`ferme`/`cloture`), `rapproche`, `releve_id`, `montant`.
- **`releves_bancaires`** : entité **parente** (modèle briques parent-enfant), cycle `brouillon → actif → cloture`.
- **`justificatifs`** : pièces (BC/BL/reçu/avis de débit/DUM/quittances) avec `compte_pcm`, `categorie_pcm`, `taux_tva`, `eligible_edi`.

### 3.2 Sécurité au niveau ligne (RLS)

RLS **strict** sur toutes les tables métier. Fonctions `SECURITY DEFINER` pour éviter la récursion :

| Fonction | Rôle |
|---|---|
| `has_role(user, role)` | Rôle applicatif (`expert_comptable`, `assistant_cabinet`, `chef_entreprise`, `collaborateur`) |
| `get_user_cabinet(user)` | Résout le tenant (cabinet) |
| `has_dossier_access(user, dossier)` | Accès via cabinet **OU** partage explicite (`dossier_access`) |

Pattern répété : `ds_select` (lecture) + `ds_all` (écriture) → `USING (has_dossier_access(auth.uid(), dossier_id))`.

### 3.3 Triggers & RPC critiques (PL/pgSQL)

| Objet | Déclencheur | Effet |
|---|---|---|
| `handle_new_user()` | après inscription `auth.users` | Crée cabinet + profil + rôle `expert_comptable` |
| `init_pcm_for_dossier()` | création `dossiers` | Initialise journaux marocains (VTE/ACH/BQ/CAI/OD/TVA) + extrait du PCM |
| `sync_ecriture_contrepartie()` | (dé)lettrage `transactions_bancaires` | **Cœur du Grand Livre continu** : bascule la contrepartie entre compte d'attente (4711/4712) et compte final (3421/4411/compte PCM) |
| **`lier_transaction(tx, doc, kind)` → bool** | RPC appelée par le serveur | **Lettrage atomique & idempotent** (voir §6.2) |

Migrations versionnées dans `supabase/migrations/*.sql` (schéma initial, briques parent-enfant, RPC lettrage, ledger continu « bank suspense », PCM complet & codes auxiliaires, colonne `echeances`, etc.).

---

## 4. Modules fonctionnels (par écran)

> Routes sous `src/routes/_app/dossiers.$dossierId.*`

| Module | Écran | Fonctionnalités clés |
|---|---|---|
| **Portail dossiers** | `dossiers` | Liste des sociétés clientes ; création de dossier (PCM initialisé automatiquement) ; identité légale ICE/IF/RC |
| **Tableau de bord** | `dashboard` | KPIs société, **TVA nette du mois** & échéance, factures en retard, indicateurs de trésorerie |
| **Clients** | `clients` | Fiches clients (ICE/email), reporting par catégorie PCM, stats |
| **Factures clients** | `factures` | Création + **OCR** ; **e-facture DGI** (XML **UBL 2.1**, **SHA-256**, `dgi_uuid`) ; suivi paiement (payé/restant) ; **échéances de paiement partiel** ; envoi e-mail client ; matching bancaire auto |
| **Factures fournisseurs** | `fournisseurs` | Import **OCR** ou saisie manuelle ; **comptabilisation automatique** (écritures ACH 6141/34552/4411) ; gestion des tiers + codes auxiliaires ; **export Sage** ; reporting (charts) ; échéances |
| **Justificatifs** | `justificatifs` | Pièces BC/BL/reçu/avis de débit/DUM/quittances ; **catégorisation PCM** (OCR IA) ; **matrice fiscale CGI** (TVA déductible/non, EDI bloqué) ; lettrage avec transactions |
| **Banque & Trésorerie** | `banque`, `banque.$releveId` | Comptes bancaires & soldes ; relevés ; **rapprochement automatique** ; encaissements espèces/chèques ; détail relevé & lignes |
| **Scanner de relevés** | `relevescanner` | Import PDF/image, extraction texte locale (pdf.js) + **OCR vision** ; parsing multi-banques ; catégorisation IA par lots ; contrôle de cohérence des soldes |
| **Comptabilité** | `comptabilite` | **Grand livre**, **balance**, saisie manuelle d'écritures |
| **Fiscalité** | `fiscalite` | **TVA**, **IS**, **Taxe Professionnelle**, calendrier fiscal / échéances déclaratives |
| **Paie & RH** | `paie` | Bulletins de paie, **CNSS/AMO**, **IR salarial (barème 2024)**, calcul net |
| **GED** | `ged` | Archive documentaire **immuable** : SHA-256, `dgi_uuid`, horodatage, stockage Storage privé |
| **Piste d'audit** | `audit` | **Journal inviolable** : hachage **SHA-256 chaîné** (`hash_precedent` → `GENESIS`) |

Fonctions transverses : **réception de factures par e-mail** (`handleInboundMail`), **envoi e-mail transactionnel** (templates factures/invitations via API **Brevo**), partage de dossier granulaire.

---

## 5. Couche « API » — Server functions (Node/TanStack)

Pas d'API REST/Express séparée : endpoints = **server functions** `createServerFn`, validées Zod, protégées par le middleware `requireSupabaseAuth` (vérification du JWT `Bearer`).

| Fichier | Fonctions exportées | Rôle |
|---|---|---|
| `factures.functions.ts` | `generateFactureXml`, `ocrFacture`, `marquerPayee`, `ajouterEmailClient`, `ocrReleve`, `extraireTransactionsPage`, `extraireTransactionsVision`, `analyserReleveIA`, `analyserTransactions`, `matcherDocumentAvecTransactions`, `lettrerJustificatif` | E-facture DGI ; OCR facture & relevé ; catégorisation IA ; matching document↔transaction |
| `lettrage.functions.ts` | `matchTransactionDeterministe` (pur), `lettrerDossier` | Orchestration du lettrage continu (matcher pur + RPC atomique) |
| `ocr.functions.ts` | `runOcr`, `sendEmail`, `writeAuditLog`, `initDossierPCM` | OCR facture unitaire ; e-mail ; audit hash-chain ; init PCM idempotente |
| `paie.functions.ts` | `calculBulletin` (pur), `genererBulletin`, `validerBulletin` | Calcul de paie (CNSS/AMO/IR) |
| `mail.inbound.ts` | `handleInboundMail`, `envoyerMailBrevo` | Pipeline e-mail entrant (factures reçues) + envoi Brevo |
| `dgi_validator.ts` | `validerXmlUBL` | Validation XML UBL 2.1 (conformité DGI) |
| `factures.utils.ts` | `parseInvoiceRegex`, `correctMontants`, `parseReleveMarkdown`, `controleSoldeReleve`, `buildOcrPrompt`, … | Utilitaires purs (regex, parsing Markdown relevé, contrôle solde, prompts) — **couverts par Vitest** |

> `lettrerDossier` et le lettrage utilisent la clé **`SUPABASE_SERVICE_ROLE_KEY`** (secret serveur, jamais côté client).

---

## 6. Comptabilité & conformité Maroc

### 6.1 Plan Comptable Marocain (PCM) & TVA

- **Initialisation automatique** par dossier (`init_pcm_for_dossier`) : journaux VTE/ACH/BQ/CAI/OD/TVA + comptes structurants (3421 Clients, 4411 Fournisseurs, 4455x TVA facturée, 3455x/34552 TVA récupérable, 5141 Banque, 4711/4712 comptes d'attente…).
- **Règles TVA CGI Art. 106** (dans `PCM_MAP` / `comptabilite-bq.ts`, `justificatifs.tsx`) : taux 20/14/10/7 % ; **non-déductibilité** explicite (carburant, frais de représentation `6147`, droits de douane) ; frais bancaires (TVA 10 % `6347`).
- **Charges sociales** : CNSS/AMO — dette **4441** (flux trésorerie) et charge **6174** (« Charges Sociales », règle stricte de classification côté OCR & classifieur Python).
- **Export Sage / EDI** : dates EDI en texte, compte PCM stocké pour l'export sans facture, traitement TVA frais bancaires hybride (COMMISSION = HT, sinon TTC).

### 6.2 Lettrage continu & Grand Livre équilibré (modèle « Bank Suspense » à la Odoo)

- **Deux sens de rapprochement** (`lettrerDossier`) : *Sens A* (après import d'un relevé → confronte ses transactions aux documents) et *Sens B* (après un nouveau document → confronte aux transactions en attente).
- **Matcher déterministe et pur** (`matchTransactionDeterministe`) : barème montant (±1 MAD, bloquant) + mot-clé tiers + mode de règlement/date chèque + N° de pièce ; testé sous Vitest.
- **RPC `lier_transaction` atomique** :
  - **Anti-concurrence** : `UPDATE … WHERE facture_id IS NULL AND justificatif_id IS NULL` → un seul « gagnant » sous appels concurrents.
  - **Anti-double-paiement / idempotence** : mise à jour `montant_paye` gardée par `montant_paye < 1`.
  - **Lettrage post-clôture** : une transaction clôturée (parquée en 4711/4712) peut être lettrée tardivement ; le trigger `sync_ecriture_contrepartie` bascule alors la contrepartie vers le compte final sans recomptabiliser.
- Résultat : le **Grand Livre reste toujours équilibré** (toute transaction est comptabilisée à la clôture, en compte d'attente si orpheline).

### 6.3 Conformité DGI / e-facture

- Génération **XML UBL 2.1** + **hash SHA-256** + `dgi_uuid` par facture, `statut_dgi`.
- Validateur `validerXmlUBL` (`dgi_validator.ts`).
- Archivage probant en **GED** + **piste d'audit** hash-chaînée.

---

## 7. Pipelines IA (détaillés)

> Deux piliers cloud : **Mistral AI** (principal) et **Groq** (secours), + **Gemini** (repli additionnel), + **Donut** (modèle local optionnel). Chaque étape appelle une API distincte.

### 7.1 Pré-traitement PDF — **navigateur** (aucun LLM)
Pour un PDF texte : **pdf.js** extrait le texte, reconstruit les lignes par **coordonnée Y** (seuil ~3 px), puis alimente un **parser multi-banques déterministe** (regex). Si le parsing suffit → aucun appel réseau.

### 7.2 OCR Vision de relevé — `ocrReleve` (Mistral principal)
Pour une image ou un PDF scanné (texte < 300 car. ou marqueur CamScanner) :

| Ordre | Modèle | Endpoint | Rôle |
|---|---|---|---|
| **1 (principal)** | **Mistral OCR** `mistral-ocr-latest` | `api.mistral.ai/v1/ocr` | Document → **Markdown structuré** (tableau Débit/Crédit/Solde), parsé par `parseReleveMarkdown` + contrôle de cohérence des soldes |
| 2 (secours) | **Groq vision** (`llama-4-scout` / `llama-3.3-70b`) | `api.groq.com` | Repli si Mistral échoue / 0 transaction |
| 3 (option locale) | **Donut** (`donut-service`/parse) | `127.0.0.1:8501` | OCR hors-ligne ; si indisponible (503) → repli cloud (Gemini/Groq) |

### 7.3 Catégorisation & structuration relevé — `analyserReleveIA` (Mistral principal, Groq secours)
Traitement **par lots** (budget TPM), mapping par `_idx` réel :
```
callCategorize(prompt):
  1. si MISTRAL_API_KEY → mistral-large-latest        ← PRINCIPAL
  2. sinon / si échec   → Groq llama-3.3-70b-versatile ← SECOURS
```
Un appel **Mistral** supplémentaire assure la **réconciliation par équilibre** si le contrôle solde initial/final révèle un écart (ré-extraction des transactions).

### 7.4 OCR facture/justificatif unitaire — `ocrFacture` / `runOcr`
Cascade `regex → score de confiance → repli LLM`. **Règle d'or** : le LLM est un **extracteur pur** (nom_tiers, montants, dates, lignes) ; il **n'attribue pas** les comptes PCM — cette logique est déterministe (prompt `buildOcrPrompt` avec **règles strictes** de classification : quittances loyer/eau/élec, carburant, **CNSS → 6174 / `charges_sociales`**, garde anti-confusion CNCA, etc.).

### 7.5 Classification déterministe (backend Python `ia_services/scan`)
`DocumentClassifierService.classify()` — moteur **auditable**, ordre d'application (s'arrête au 1er match) :
- **Étape A — Règles figées Maroc** : mots-clés (`CNSS`, `CAISSE NATIONALE DE SECURITE SOCIALE`, `SECURITE SOCIALE`) → `type="Bordereau"`, `compte_pcm="6174"`, `categorie="Charges Sociales"`, **date redressée** (exécution/télé-règlement). Faux positif **CNCA** (banque) explicitement exclu.
- **Étape B — Alias / historique** : réutilise le PCM déjà mappé pour un tiers.
- **Étape C — Fuzzy matching** : **Jaro-Winkler** (`rapidfuzz`) sur forme canonique (stopwords retirés, tokens triés), seuil > 85 → rattachement ; sinon `besoin_validation_humaine`.

### 7.6 Rapprochement par échéances / paiements partiels (`ia_services/reconciliation`)
Pour une facture avec `echeances[]` (`montant_attendu`, `date_echeance`) :
- **Subset-Sum exact** en centimes entiers (élagage borne haute + somme des restes) → combinaisons de transactions orphelines égalant **exactement** chaque tranche.
- **Fenêtre de dates dynamique par tranche** (centrée sur l'échéance, largeur = demi-écart aux voisines).
- **Cohésion de libellés** (Jaccard) pour privilégier les combinaisons cohérentes ; suggestions multiples triées par score.
- Exposé par le backend Python : `POST /reconciliation/partial-payments` (aligné avec le champ `echeances` de l'UI).

### 7.7 Robustesse transverse (déjà codée)
- **Tolérance proxy TLS d'entreprise** : repli `undici` sans vérification TLS quand un proxy casse la chaîne de certificats (Mistral/Groq côté Node ; `truststore` côté Python).
- **Bascule fournisseur** : Mistral → Groq/Gemini sur échec/quota (429).
- **Cohérence comptable** : contrôle solde initial/final, arrondis systématiques `Math.round(x*100)/100`, tolérance bancaire `0.005`, seuil de matching ±1 MAD.
- **Clés d'environnement** : `MISTRAL_API_KEY` (principal), `GROQ_API_KEY` / `GEMINI_API_KEY` (secours), `SUPABASE_SERVICE_ROLE_KEY`, `BREVO_API_KEY`, `DONUT_ENDPOINT`.

---

## 8. Backend Python unifié (`donut-service`)

Un **seul process FastAPI** (`donut-service/app.py`) regroupe :
- `GET /health`, `POST /parse` — **OCR Donut** local (VisionEncoderDecoder, chargé une fois ; 503 → repli cloud) ;
- `POST /scan/classify` — classification déterministe (`ia_services/scan`, repos Supabase REST injectés) ;
- `POST /reconciliation/partial-payments` — rapprochement par échéances (`ia_services/reconciliation`).

Principe : les modules `ia_services/` sont **découplés de Supabase** via des `Protocol` (ports) ; les implémentations REST (`supabase_repositories.py`) sont injectées au montage. Vérification : `python -m ia_services._smoketest`.

---

## 9. Sécurité

- **Auth** : Supabase Auth (JWT). Server functions protégées par `requireSupabaseAuth` (`supabase.auth.getClaims`).
- **Multi-tenant** : RLS strict + fonctions `SECURITY DEFINER` (`has_dossier_access`).
- **Intégrité financière** : RPC atomique (anti-concurrence + idempotence), triggers de contrepartie.
- **Traçabilité** : **audit_logs** hash-chaînés SHA-256 ; GED immuable horodatée.
- **Secrets** : `SUPABASE_SERVICE_ROLE_KEY` réservé au serveur ; clés LLM/e-mail hors bundle client.

---

## 10. Tests & qualité

| Type | Outil | Portée |
|---|---|---|
| Unitaires | **Vitest** | `factures.utils.test.ts` (54), `matching.test.ts` (45) — parsing, arrondis, matcher/idempotence (**99 tests**) |
| E2E | **Playwright** (+ Allure) | Lettrage UI + concurrence RPC ; saisie échéances (`EcheancesInput`) |
| Smoke Python | `python -m ia_services._smoketest` | Classifieur (CNSS→6174, garde CNCA, fuzzy) + rapprochement par tranches |
| Statique | ESLint + TypeScript (`tsc`) | Typage (types Supabase générés depuis le schéma live) |

---

## 11. Points d'attention / dette technique connue

- **Types Supabase** : régénérés depuis le schéma live PostgREST (le CLI officiel est bloqué par le proxy TLS d'entreprise) via `npm run gen:types` (`scripts/gen-supabase-types.mjs`). ~36 erreurs TS latentes préexistantes hors périmètre.
- **Isolation du pipeline IA** : les appels LLM sont synchrones dans le serveur SSR → recommandé de les déporter dans un worker asynchrone + file d'attente avant montée en charge (cf. `ARCHITECTURE_BLUEPRINT.md` §4.3).
- **Policies Storage `ged`** : à durcir (accès par appartenance au dossier, pas seulement `authenticated`).
- **Harmonisation OCR facture unitaire** : `runOcr` utilise encore Groq `llama-3.1-8b-instant` (non migré vers Mistral).
- **Secrets** : `.env.example` contient des clés réelles (non commité) — à assainir + rotation avant partage du dépôt.

---

## Annexe — Inventaire technique de référence

| Domaine | Fichiers / objets clés |
|---|---|
| Server functions | `src/server/{ocr,lettrage,factures}.functions.ts`, `paie.functions.ts`, `mail.inbound.ts`, `dgi_validator.ts` |
| Utilitaires purs | `src/server/factures.utils.ts`, `src/lib/comptabilite-bq.ts`, `src/lib/sage-export.ts` |
| Composants métier | `src/components/EcheancesInput.tsx`, `src/components/TiersReporting.tsx`, `src/components/ui/*` |
| Écrans | `src/routes/_app/dossiers.$dossierId.*` (13 modules) |
| Data / migrations | `supabase/migrations/*.sql`, RPC `lier_transaction`, triggers `sync_ecriture_contrepartie` / `init_pcm_for_dossier` |
| IA Python | `donut-service/app.py`, `ia_services/scan/*`, `ia_services/reconciliation/*` |
| Tests | `src/server/*.test.ts`, `e2e/tests/*.spec.ts`, `ia_services/_smoketest.py` |
| Docs | `ARCHITECTURE_BLUEPRINT.md` (déploiement Cloud), `README.md`, `ia_services/README.md`, ce document |

---

*Fiche générée à partir de l'état réel du code. Pour les décisions de déploiement Cloud, tarification SaaS et passerelles de paiement, voir `ARCHITECTURE_BLUEPRINT.md` (sections 4–5).*
