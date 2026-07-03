# Clarify — System Architecture Blueprint

> **Document technique & fonctionnel — préparation du déploiement Cloud de production**
> Application SaaS B2B d'automatisation comptable (marché : cabinets d'expertise comptable au Maroc)
> Destinataire : Expert Cloud / DevOps / FinTech — Version 1.0 — 29 juin 2026
> Nom de code applicatif (repo) : `hisabpro` / `Clarify`

---

## 0. Résumé exécutif (TL;DR pour l'expert)

| Dimension | État actuel |
|---|---|
| **Type d'application** | SaaS B2B multi-tenant, full-stack JavaScript/TypeScript |
| **Framework** | TanStack Start (React 19 SSR + server functions) bundlé par Vite 7 |
| **Sortie de build** | Serveur Node (`.output/server/index.mjs` — runtime Nitro) |
| **Backend / données** | Supabase managé (Postgres + Auth + Storage + RLS), provisionné à l'origine via *Lovable Cloud* |
| **Logique métier critique** | Triggers PL/pgSQL + RPC atomique `lier_transaction` (lettrage), Grand Livre continu (modèle « Bank Suspense » à la Odoo) |
| **Moteur IA/OCR** | Pré-traitement PDF côté **navigateur** (PDF.js, tri Y) ; côté serveur, **Mistral principal** (OCR `mistral-ocr-latest` + catégorisation `mistral-large-latest`), **Groq en secours**. Cf. §1.4 pour le flux d'API détaillé. |
| **Spécificité marché** | Plan Comptable Marocain (PCM), ICE/IF/RC, règles TVA CGI Art.106, conformité DGI/EDI |
| **Tests** | Vitest (unitaires, matching/idempotence) + Playwright E2E + rapports Allure |
| **Enjeux du déploiement** | Isolation Dev/Staging/Prod, CI/CD, isolation du traitement documentaire lourd, intégration paiement (CMI/PayZone + Stripe) |

**Trois décisions structurantes à arbitrer avec l'expert :**
1. **Cible d'hébergement** du serveur Node SSR (Vercel/Netlify vs. VPS Coolify/Dokku vs. conteneur).
2. **Isolation du traitement documentaire** lourd (OCR vision + LLM) pour ne pas bloquer l'API SSR.
3. **Architecture de facturation/abonnement** et **passerelle de paiement** (locale Maroc + internationale) synchronisée avec Supabase.

---

## 1. Composantes et stack technique (l'existant)

### 1.1 Front-end

| Élément | Choix technique | Détail |
|---|---|---|
| Framework | **TanStack Start** (`@tanstack/react-start`) | Full-stack React 19 avec SSR et *server functions* (`createServerFn`) — ce n'est **pas** un SPA Vite/React pur. |
| Bundler | **Vite 7** + `@vitejs/plugin-react` | `vite build` → sortie serveur Nitro. |
| Routing | **TanStack Router** (`file-based`) | Arbre généré (`routeTree.gen.ts`). Routes métier sous `src/routes/_app/dossiers.$dossierId.*` (banque, factures, justificatifs, comptabilité, fiscalité, paie, GED, audit, dashboard, relevescanner). |
| Données / cache | **TanStack Query** (`@tanstack/react-query`) | Cache et synchronisation des requêtes Supabase. |
| État local | React 19 + hooks (`useAuth`), pas de Redux/Zustand | État serveur délégué à React Query ; auth via contexte. |
| UI | **Radix UI** + pattern **shadcn/ui** (`components.json`) + **Tailwind CSS 4** | ~50 composants `src/components/ui/*`. Toasts via `sonner`, formulaires via `react-hook-form` + résolveurs **Zod**. |
| Graphiques | `recharts` | Dashboards et reporting (3 grands livres, reporting par tiers). |
| Traitement PDF | `pdfjs-dist` (**côté navigateur**) | Extraction de texte locale (cf. §1.4) — point d'architecture majeur. |
| Export | `xlsx` | Génération de fichiers tableurs (Sage/EDI). |

**Spécificité UI notable :** le scanner de relevés (`relevescanner.tsx`) embarque un *worker* PDF.js (`/pdf.worker.min.mjs`) servi statiquement. L'extraction de texte se fait **dans le navigateur du client**, ce qui décharge le serveur du parsing PDF mais impose de servir correctement l'asset worker en production.

### 1.2 Back-end / Base de données — Supabase

Supabase joue le rôle de **backend-as-a-service complet** : Postgres managé, Auth (`auth.users`), Storage (bucket privé `ged`) et moteur RLS. Les *server functions* TanStack (Node) s'intercalent uniquement pour les opérations sensibles (LLM, lettrage avec service-role, e-mail, audit chaîné).

#### Tables clés (multi-tenant)

```
cabinets ─┬─ profiles (1:1 auth.users)        ← tenant racine
          ├─ user_roles (app_role)
          └─ dossiers ─┬─ dossier_access       ← partage granulaire
                       ├─ clients / fournisseurs
                       ├─ factures / factures_fournisseurs
                       ├─ comptes_comptables / journaux_comptables
                       ├─ ecritures_comptables  ← Grand Livre
                       ├─ comptes_bancaires
                       ├─ releves_bancaires (PARENT) ─┐
                       ├─ transactions_bancaires ─────┘ (enfant, releve_id)
                       ├─ justificatifs
                       ├─ ged_documents (Storage)
                       ├─ audit_logs (hash-chain)
                       └─ alertes
```

- **`dossiers`** : entité d'isolation métier. Porte l'identité légale marocaine : `ice`, `rc`, `if_fiscal`.
- **`transactions_bancaires`** : cœur du rapprochement. Colonnes critiques : `facture_id`, `justificatif_id`, `document_type`, `statut` (`brouillon`/`ferme`/`cloture`), `rapproche`, `releve_id`, `montant NUMERIC(15,2)`.
- **`releves_bancaires`** : entité **parente** (briques de relevés, modèle parent-enfant) — métadonnées + cycle de vie (`brouillon` → `actif` → `cloture`).
- **`justificatifs`** : pièces (BC/BL/reçu/avis de débit/DUM) avec `compte_pcm`, `taux_tva`, `eligible_edi`.

#### Politiques RLS (Row Level Security)

Modèle **multi-tenant strict** activé sur **toutes** les tables métier. Pour éviter la récursion RLS, l'accès passe par des fonctions `SECURITY DEFINER` :

| Fonction | Rôle |
|---|---|
| `has_role(user, role)` | Vérifie un rôle applicatif (`expert_comptable`, `assistant_cabinet`, `chef_entreprise`, `collaborateur`). |
| `get_user_cabinet(user)` | Résout le cabinet (tenant) de l'utilisateur. |
| `has_dossier_access(user, dossier)` | Accès au dossier via cabinet **OU** partage explicite (`dossier_access`). |

Pattern de policy répété : `ds_select` (lecture) + `ds_all` (écriture) → `USING (has_dossier_access(auth.uid(), dossier_id))`. Le bucket Storage `ged` est privé, accès réservé aux `authenticated`.

> ⚠️ **Point d'attention sécurité pour l'expert :** les policies Storage actuelles autorisent tout utilisateur authentifié (`auth.uid() IS NOT NULL`) sans re-vérifier l'appartenance au dossier via le chemin de l'objet. À durcir avant la prod (cf. §6 checklist).

#### Triggers critiques

| Trigger | Table | Effet |
|---|---|---|
| `on_auth_user_created` → `handle_new_user()` | `auth.users` | Crée automatiquement cabinet + profil + rôle `expert_comptable` à l'inscription. |
| `on_dossier_created` → `init_pcm_for_dossier()` | `dossiers` | Initialise journaux marocains (VTE/ACH/BQ/CAI/OD/TVA) + extrait du **PCM** à la création d'un dossier. |
| `trg_sync_ecriture_contrepartie` → `sync_ecriture_contrepartie()` | `transactions_bancaires` | **Cœur du Grand Livre continu** : à chaque (dé)lettrage, bascule dynamiquement le compte de contrepartie d'une écriture entre compte d'attente (4711/4712) et compte final (3421/4411/compte PCM du justificatif). |

#### Fonction RPC PL/pgSQL — gestion atomique du lettrage

**`lier_transaction(p_tx_id, p_doc_id, p_doc_kind)` → boolean** est la pierre angulaire de l'intégrité financière. Garanties :

- **Atomicité & anti-concurrence** : l'`UPDATE` ne pose le lien que `WHERE facture_id IS NULL AND justificatif_id IS NULL`. Si une course concurrente a déjà lié la transaction, `NOT FOUND` → retourne `false`, aucune écriture.
- **Anti-double-paiement / idempotence** : la mise à jour du `montant_paye` du document est gardée par `WHERE montant_paye < 1`. Rejouer l'opération ne double jamais le montant.
- **Lettrage post-clôture** : la version courante a retiré le verrou `statut <> 'cloture'` → une transaction clôturée (parquée sur 4711/4712) peut être lettrée tardivement, son statut `cloture` étant **conservé** (pas de re-comptabilisation). Le trigger bascule alors le compte de contrepartie.
- `SECURITY DEFINER`, `GRANT EXECUTE … TO authenticated, service_role`.

### 1.3 Server functions (la couche « API »)

Pas d'API REST/Express séparée : les endpoints sont des **server functions** TanStack (`createServerFn`), validées par Zod, protégées par le middleware `requireSupabaseAuth` (vérification du `Bearer` JWT via `supabase.auth.getClaims`). Principales :

| Fonction | Fichier | Rôle |
|---|---|---|
| `runOcr` / `ocrReleve` / `analyserReleveIA` | `ocr.functions.ts`, scanner | Extraction & catégorisation OCR/LLM. |
| `lettrerDossier` | `lettrage.functions.ts` | Orchestration du lettrage continu (matcher pur + RPC). |
| `writeAuditLog` | `ocr.functions.ts` | Journal d'audit **chaîné par hash SHA-256** (`hash_precedent` → `GENESIS`), inviolable. |
| `initDossierPCM` | `ocr.functions.ts` | Initialisation PCM (idempotente). |
| `sendEmail` | `ocr.functions.ts` | E-mails transactionnels via **Resend**. |

> Note : `lettrerDossier` utilise une clé **service-role** (`SUPABASE_SERVICE_ROLE_KEY`) — secret serveur à ne **jamais** exposer côté client.

### 1.4 Moteur IA / OCR — flux d'API réel (Mistral vs Groq vs replis)

> **Section critique pour l'expert Cloud.** L'architecture IA repose sur **deux piliers** : **Mistral AI** (`api.mistral.ai`) en **moteur principal** (OCR vision + catégorisation), et **Groq** (`api.groq.com`) en **secours/complément**. Un appel d'API **différent intervient à chaque étape** du pipeline. Ce qui suit reflète exactement le code de `src/server/factures.functions.ts` et du scanner.

#### Étape 1 — Pré-traitement côté **navigateur** (PDF numérique)

Pour un PDF **texte** (non scanné), l'extraction se fait dans le navigateur via **PDF.js** (`getTextContent`), **avant tout appel réseau** :

- **Reconstruction des lignes par coordonnée Y** : les items sont regroupés en lignes par proximité verticale (`Math.round(item.transform[5])`, seuil de 3 px). C'est le seul tri **explicite** réalisé côté client.
- **Ordre horizontal (X)** : l'ordre gauche → droite à l'intérieur d'une ligne repose sur **l'ordre natif de séquence des items PDF.js** (généralement déjà ordonné en X), et **non** sur un `sort()` explicite par `item.transform[4]`.

  > ⚠️ **Correction de la v1.0 du document :** il n'existe **pas** de « tri horizontal X-sorting » dédié dans le code navigateur actuel. La robustesse de l'**alignement des colonnes** (débit/crédit/solde) est en réalité assurée **en aval** : (a) par le **parsing du tableau Markdown** renvoyé par Mistral OCR (colonnes Débit/Crédit explicites, `_side` figé sans re-deviner), et (b) par les **prompts OCR/LLM** qui imposent explicitement le respect de l'alignement des colonnes. *Recommandation : ajouter un tri X explicite par `transform[4]` au sein de chaque ligne Y fiabiliserait l'extraction texte avant envoi — cf. §4.3.*

- Le texte reconstruit alimente alors `parserTransactions()` (parser multi-banques déterministe, regex), **sans appel LLM** si le parsing suffit.

#### Étape 2 — Extraction / OCR Vision : **Mistral en moteur PRINCIPAL** (`ocrReleve`)

Pour une **image** ou un **PDF scanné/CamScanner** (texte < 300 car. ou marqueur CamScanner), l'extraction part en serveur via la *server function* `ocrReleve`, qui appelle **en premier Mistral OCR** :

| Ordre | Fournisseur / modèle | Endpoint | Rôle |
|---|---|---|---|
| **1 (principal)** | **Mistral OCR** — `mistral-ocr-latest` | `https://api.mistral.ai/v1/ocr` | OCR vision du document → **Markdown structuré** (tableau Débit/Crédit/Solde). Parsé par `parseReleveMarkdown` + contrôle de cohérence des soldes. |
| 2 (secours) | **Groq vision** — `callAI` (`llama-4-scout` / `llama-3.3-70b`) | `https://api.groq.com/...` | Repli OCR vision si Mistral indisponible / échec / 0 transaction. |

→ **Mistral est le moteur d'extraction/OCR vision principal** ; **Groq** prend le relais en secours.

#### Étape 3 — Catégorisation métier & structuration : **Mistral PRINCIPAL, Groq en REPLI** (`analyserReleveIA`)

La *server function* `analyserReleveIA` réalise la catégorisation PCM + le matching/structuration des transactions (par lots, budget TPM, mapping par `_idx` réel). Le sélecteur réel (`callCategorize`) est :

```
useMistralChat = !!process.env.MISTRAL_API_KEY
callCategorize(prompt):
   1. si MISTRAL_API_KEY → callMistralChat()  → mistral-large-latest   ← PRINCIPAL
   2. sinon / si échec   → callAI() (Groq)     → llama-3.3-70b-versatile ← SECOURS
```

> ⚠️ **Correction importante vs. la description initiale.** Dans le code actuel, **Mistral (`mistral-large-latest`) est le moteur principal AUSSI pour la catégorisation/structuration** — et **non Groq**. **Groq (`llama-3.3-70b-versatile`) y est désormais un *secours*** (déclenché si `MISTRAL_API_KEY` est absente ou si l'appel Mistral échoue). La migration « scanner de Groq → Mistral » (OCR + catégorisation + matching) est donc **déjà appliquée sur ces deux phases** ; Groq subsiste comme filet de sécurité, pas comme catégoriseur primaire.

Un appel Mistral supplémentaire existe pour la **réconciliation par équilibre** : si le contrôle solde initial/final révèle un écart, `mistral-large-latest` (via `callMistralChat`) ré-extrait toutes les transactions depuis le texte.

#### Cas particulier — OCR de **factures/justificatifs** unitaires (`runOcr`)

Distinct du scanner de relevés : `runOcr` (dans `ocr.functions.ts`) traite une **facture/justificatif** isolé en cascade `regex → score de confiance → repli LLM`. Ce chemin **utilise encore Groq** `llama-3.1-8b-instant` (text-only) et n'a **pas** été migré vers Mistral. *À harmoniser avec la cible Mistral si on veut un fournisseur unique.*

#### Synthèse — quel flux d'API à quelle étape

| Étape du pipeline | Lieu | Fournisseur **principal** | Secours |
|---|---|---|---|
| Extraction PDF texte | **Navigateur** | PDF.js (local, aucun LLM) | — |
| OCR Vision relevé (image/scan) | Serveur `ocrReleve` | **Mistral** `mistral-ocr-latest` | **Groq** vision (`llama-4-scout` / `llama-3.3-70b`) |
| Catégorisation / structuration relevé | Serveur `analyserReleveIA` | **Mistral** `mistral-large-latest` | **Groq** `llama-3.3-70b` |
| Réconciliation par équilibre | Serveur | **Mistral** `mistral-large-latest` | — |
| OCR facture/justificatif unitaire | Serveur `runOcr` | **Groq** `llama-3.1-8b-instant` *(non migré)* | regex seul |

#### Robustesse transverse (déjà codée)

- **Tolérance proxy SSL d'entreprise** : chaque appel (Mistral OCR, Mistral chat, Groq) gère un repli `undici` sans vérification TLS quand un proxy d'entreprise casse la chaîne de certificats.
- **Gestion des quotas / bascule** : échec ou indisponibilité Mistral → bascule **Groq** (secours).
- **Cohérence comptable** : contrôle solde initial/final (écart en MAD signalé), arrondis systématiques (`Math.round(x*100)/100`), tolérance d'arrondi bancaire `0.005`.
- **Clés d'environnement contactées** : `MISTRAL_API_KEY` (principal), `GROQ_API_KEY` (secours) — à provisionner par environnement (cf. §4.1).

---

## 2. Flux fonctionnels critiques

### 2.1 Cycle de vie de bout en bout

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 1. IMPORT          Relevé bancaire (PDF/image) ou justificatif/facture    │
│                    Upload → Storage (bucket ged), GED + hash SHA-256       │
├─────────────────────────────────────────────────────────────────────────┤
│ 2. OCR / CLASSIF.  Navigateur: PDF.js (tri Y) → parser multi-banques      │
│                    OU OCR vision. Serveur: regex → LLM (repli) →           │
│                    catégorisation PCM (deriveCategorie / LLM)              │
├─────────────────────────────────────────────────────────────────────────┤
│ 3. ENREGISTREMENT  releve_bancaire: brouillon → actif                     │
│                    (transactions_bancaires rattachées via releve_id)       │
├─────────────────────────────────────────────────────────────────────────┤
│ 4. LETTRAGE        lettrerDossier() :                                      │
│   (RPC)            • Sens A : après relevé → confronte ses tx aux docs     │
│                    • Sens B : après nouveau doc → confronte aux tx en      │
│                      attente                                               │
│                    matchTransactionDeterministe() (montant ±1 MAD +        │
│                    mot-clé tiers + mode règlement/date chèque)             │
│                    → RPC lier_transaction() ATOMIQUE pour chaque match     │
├─────────────────────────────────────────────────────────────────────────┤
│ 5. CLÔTURE & GL    releve: actif → cloture. genererLignesBQ() écrit le    │
│                    Journal de Banque. Orphelines → compte d'attente        │
│                    4711/4712. Grand Livre TOUJOURS équilibré (Odoo-like).  │
├─────────────────────────────────────────────────────────────────────────┤
│ 6. REDRESSEMENT    Lettrage tardif d'une tx clôturée → trigger            │
│                    sync_ecriture_contrepartie() bascule 4711/4712 → 3421/  │
│                    4411/compte PCM. Délettrage = bascule inverse.          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Concurrence (race conditions) & idempotence — testées

| Garantie | Mécanisme | Preuve |
|---|---|---|
| **Race condition bloquée à l'écriture** | `UPDATE … WHERE facture_id IS NULL AND justificatif_id IS NULL` dans `lier_transaction` : seule la première transaction concurrente « gagne », les autres reçoivent `false`. | RPC `lier_transaction` (PL/pgSQL atomique). |
| **Anti-double-paiement** | Mise à jour `montant_paye` gardée par `montant_paye < 1`. | Idem RPC. |
| **Idempotence du rejeu** | `lettrerDossier` ne traite que les transactions orphelines + déduplication intra-lot via `Set` (`used.fc/ff/j`). Relancer le lettrage ne crée pas de doublons. | `lettrage.functions.ts` + `matching.test.ts` (Vitest). |
| **Cohérence GL après clôture** | Toute transaction est comptabilisée à la clôture (compte d'attente si orpheline) → le Grand Livre reste équilibré ; le lettrage tardif corrige l'imputation sans re-comptabiliser. | Trigger `sync_ecriture_contrepartie` + tests. |

> Le matcher `matchTransactionDeterministe` est **pur et testable** (port fidèle de l'ancien `handleRematcher` client), séparé de l'écriture (RPC). Le repli « montant exact unique » est réservé aux transactions déjà rapprochées → évite le sur-matching sur des transactions neuves.

---

## 3. Spécificités & contraintes marché (Maroc)

L'application est conçue **nativement** pour le secteur comptable marocain :

- **Plan Comptable Marocain (PCM)** : initialisé automatiquement par dossier (`init_pcm_for_dossier`), enrichi par la migration `pcm_complet_codes_auxiliaires`. Comptes structurants : 3421 (Clients), 4411 (Fournisseurs), 44551/4455 (TVA facturée), 34552/3455 (TVA récupérable), 5141 (Banque), 5143/5161 (Caisse), 4711/4712 (comptes d'attente).
- **Identité légale** : `ICE` (15 chiffres, validé par regex), `IF` fiscal, `RC` (registre de commerce) — sur dossiers, clients, fournisseurs.
- **Règles TVA selon CGI Art. 106** (codées dans `PCM_MAP`) : taux 20 % / 14 % / 10 % / 7 % selon la nature ; **non-déductibilité** explicite (gasoil véhicules `61241`, frais de représentation `6147`, droits de douane). **Frais bancaires** : TVA 10 % déductible (`6347`), traitement hybride à l'export (COMMISSION = HT, sinon TTC).
- **Journaux comptables marocains** : VTE, ACH, BQ, CAI, OD, TVA.
- **Charges sociales & fiscales** : CNSS/AMO (dette `4441`), TVA/IS/IR/DGI (`4456`).
- **Conformité DGI / dématérialisation** : `statut_dgi`, `dgi_uuid`, `xml_ubl`, `hash_sha256` sur les factures ; validateur DGI (`dgi_validator.ts`) ; **export Sage / EDI** (dates EDI en texte, compte PCM stocké pour l'export sans facture).
- **Gestion rigide des arrondis et centimes** : `NUMERIC(15,2)` en base, arrondis applicatifs systématiques au centime (`Math.round(x*100)/100`), tolérance bancaire `0.005`, seuil de matching ±1 MAD. **Critique** pour la conformité d'un livre comptable.
- **Formats de relevés locaux** : parser multi-banques marocaines + repli OCR vision pour les relevés scannés (CamScanner courant au Maroc).

---

## 4. Demandes d'architecture Cloud & déploiement (questions pour l'expert)

> Cette section formule les **décisions à arbitrer**. Chaque point appelle une recommandation chiffrée (coût/complexité/délai).

### 4.1 Stratégie de déploiement & isolation des environnements

- **CI/CD** : nous visons **GitHub Actions**. Pipeline souhaité : lint (`eslint`) → tests unitaires (`vitest run`) → build (`vite build`) → tests E2E (`playwright`) → déploiement. **Question :** structure de workflow recommandée (jobs, cache, matrices), et gating des migrations Supabase ?
- **Isolation Dev / Staging / Prod** : aujourd'hui un seul projet Supabase (`project_id` dans `config.toml`, héritage *Lovable Cloud*). **Question :** un projet Supabase **par environnement** (recommandé pour l'isolation des données financières) ou *branching* Supabase ? Comment gérer la promotion des **migrations SQL** (`supabase/migrations/*`) entre environnements de façon sûre et auditable ?
- **Gestion des secrets** : `MISTRAL_API_KEY` (LLM principal — OCR + catégorisation), `GROQ_API_KEY` (secours), `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, clés passerelle de paiement. **Question :** coffre recommandé (GitHub Environments secrets, Doppler, Vault, secrets de la plateforme d'hébergement) et rotation ?

### 4.2 Hébergement de l'application (le build est un serveur Node)

Le build produit un **serveur Node** (`node .output/server/index.mjs`, runtime Nitro) — ce n'est pas un simple site statique. Options à arbitrer :

| Option | Avantages | Points de vigilance |
|---|---|---|
| **Vercel / Netlify** (serverless) | Zéro-ops, scaling auto, intégration Git native, edge | Coût à l'échelle, limites de durée d'exécution (problème pour l'OCR lourd), cold starts |
| **VPS (DigitalOcean/Hetzner/AWS) + Coolify ou Dokku** | Coût maîtrisé au départ, contrôle total, jobs longs possibles | Ops à charge de l'équipe, scaling manuel, TLS/monitoring à gérer |
| **Conteneur (Docker) sur Fly.io / Render / ECS** | Portabilité, environnements reproductibles, scale horizontal | Courbe de mise en place, registry, orchestration |

**Questions :**
1. Pour une **phase de lancement à coût minimal**, recommandez-vous un **VPS unique avec Coolify/Dokku** (front Node + reverse proxy + jobs) ou un découplage **front serverless (Vercel) + worker conteneurisé** ?
2. Faut-il **dockeriser** dès maintenant (Dockerfile multi-stage Node) pour garantir la portabilité, ou rester sur les adaptateurs de plateforme ?
3. Servir l'asset **`pdf.worker.min.mjs`** et les fichiers statiques : CDN ou serveur applicatif ?

### 4.3 Scalabilité du moteur d'extraction (isoler le lourd de l'API)

Le **pré-traitement PDF texte** est **côté navigateur** (PDF.js, tri Y — cf. §1.4), ce qui décharge le serveur. En revanche, **tout le reste du pipeline IA est synchrone côté serveur SSR** et enchaîne **plusieurs appels d'API externes par document**, ce qui crée le risque principal de **blocage de l'API principale** sous charge :

- **`ocrReleve`** : appel **Mistral OCR** (`mistral-ocr-latest`), avec **Groq vision en secours**.
- **`analyserReleveIA`** : **traitement par lots** (budget TPM) avec **N appels Mistral** (`mistral-large-latest`), + **secours Groq** par lot, + éventuelle **réconciliation par équilibre** (appel Mistral supplémentaire).

Un seul relevé peut donc déclencher **plusieurs requêtes LLM séquentielles longues** (OCR + autant de lots que nécessaire + réconciliation), chacune sujette à la latence réseau, aux `429` de quota, et aux replis. Tant que cela s'exécute **dans le serveur SSR**, ces appels monopolisent le runtime et dégradent les requêtes interactives.

**Questions / pistes à valider :**
- **Isoler ce pipeline multi-appels** dans un **worker dédié asynchrone** : **Supabase Edge Functions** (Deno) ou microservice conteneurisé + **file d'attente** (pgmq/Supabase Queues, Redis/BullMQ, Cloudflare Queues). Modèle visé : `upload → enqueue → worker (Mistral OCR → lots Mistral chat → réconciliation) → notification Realtime/webhook → MAJ UI`.
- **Concurrence & throughput** : combien de documents traiter en parallèle sans saturer les **quotas TPM Mistral** ? Faut-il une **limite de concurrence par fournisseur** et un **budget de tokens par dossier/abonnement** (cf. plan §5.1) ?
- **Résilience de la bascule** (Mistral → Groq) : centraliser dans le worker un **circuit breaker + retries + back-pressure** par fournisseur, plutôt que des `try/catch` dispersés.
- **Runtime** : le code note *« In Cloudflare Workers we can't run Python »* (parsing réimplémenté en TS). Le pipeline étant 100 % appels HTTP vers Mistral/Groq, un **worker Node/Deno** suffit (pas de dépendance Python à héberger).
- **Latence côté UI** : passer le scanner en **asynchrone** (statut `en_traitement` → `prêt`) via Supabase Realtime, pour ne pas tenir une requête HTTP ouverte le temps des N appels LLM.
- **Secrets** : `MISTRAL_API_KEY` et `GROQ_API_KEY` doivent être accessibles au **worker** (et non au front) — impacte le choix d'hébergement (§4.2).

---

## 5. Architecture des paiements & abonnements (SaaS B2B)

### 5.1 Modèle de tarification — proposition

Le métier se prête à une tarification **multi-niveaux indexée sur la valeur** (cabinet → dossiers → volume traité) :

| Levier de facturation | Pertinence | Mesure (déjà dans le schéma) |
|---|---|---|
| **Par dossier d'entreprise actif** | ⭐ Recommandé (lisible pour un cabinet) | `dossiers.statut = 'actif'` par `cabinet_id` |
| **Au volume de lignes traitées** | Complémentaire (usage IA/OCR) | `count(transactions_bancaires)`, `releves_bancaires.nombre_transactions` |
| **Par siège utilisateur** | Option add-on | `user_roles` / `dossier_access` |
| **Crédits OCR/LLM** | Maîtrise du coût variable IA | compteur d'appels `runOcr`/`analyserReleveIA` |

**Proposition de plans :** *Starter* (N dossiers, X lignes/mois, OCR plafonné) → *Cabinet* (dossiers illimités, quotas élargis) → *Enterprise* (volume + SLA + export EDI avancé). Hybride recommandé : **abonnement par paliers de dossiers actifs + quota de lignes** avec dépassement à l'unité.

### 5.2 Schéma de données d'abonnement (à créer)

```sql
-- Esquisse à valider avec l'expert
abonnements        (id, cabinet_id, plan, statut, periode_courante_debut/fin,
                    quota_dossiers, quota_lignes_mois, provider, provider_ref)
usage_compteurs    (id, cabinet_id, periode, dossiers_actifs, lignes_traitees,
                    appels_ocr)              -- alimenté par triggers/cron
paiements          (id, cabinet_id, montant, devise, provider, provider_txn_id,
                    statut, created_at)      -- journal idempotent (webhooks)
```

- **Enforcement par RLS / triggers** : refuser la création d'un dossier au-delà du `quota_dossiers`, ou marquer le cabinet `en_dépassement`. Compteurs d'usage agrégés par trigger (à l'image de l'existant).
- **Idempotence des webhooks** : `provider_txn_id` unique (même garantie que `lier_transaction` côté lettrage) → un webhook rejoué ne crée pas de doublon.

### 5.3 Passerelles de paiement

**Questions pour l'expert FinTech :**

| Axe | Question |
|---|---|
| **Local Maroc (CMI / PayZone)** | Meilleure approche d'intégration (paiement par carte marocaine, conformité, redirection vs. API serveur) ? Gestion des abonnements **récurrents** (les passerelles locales gèrent mal le *recurring* — faut-il un modèle de re-facturation manuelle/tokenisée ?). |
| **International (Stripe)** | Pour l'ouverture à l'international : **Stripe Billing** (abonnements, proration, dunning) recommandé ? Comment cohabiter avec une passerelle locale (routage par devise/pays du cabinet) ? |
| **Synchronisation Supabase** | Architecture des **webhooks** (Stripe/CMI) → mise à jour atomique de `abonnements.statut` dans Supabase. Edge Function dédiée à la vérification de signature ? Source de vérité : provider ou Supabase ? |
| **Conformité** | TVA marocaine sur l'abonnement lui-même, facturation du SaaS, devises (MAD/EUR/USD), PCI-DSS (ne jamais stocker de PAN → tokenisation provider). |

**Recommandation préliminaire à challenger :** abstraire un **`PaymentProvider` interface** (méthodes `createCheckout`, `handleWebhook`, `cancelSubscription`) avec deux implémentations (Stripe, CMI/PayZone), pour découpler le métier de la passerelle et router selon le pays du cabinet.

---

## 6. Annexe — Checklist de production (pré-déploiement)

- [ ] **Durcir les policies Storage `ged`** : restreindre l'accès par appartenance au dossier (préfixe de chemin = `dossier_id`), pas seulement `authenticated`.
- [ ] **Régénérer les types Supabase** : `src/integrations/supabase/types.ts` est actuellement un *placeholder* (`Database = any`) — régénération bloquée par un proxy TLS ; ~36 erreurs TS latentes. À régler hors proxy avant la prod (typage = filet de sécurité).
- [ ] **Secrets** : sortir toute clé du code/`.env` commité → coffre + rotation ; vérifier que `SUPABASE_SERVICE_ROLE_KEY` n'est jamais bundlé côté client.
- [ ] **Contrainte CHECK sur `releves_bancaires.statut`** (volontairement omise) à ajouter une fois le code aligné sur `brouillon/actif/cloture` (l'app écrivait `valide`).
- [ ] **Observabilité** : logs structurés (remplacer les `console.log` de debug du scanner), métriques (latence LLM, taux de matching), alerting.
- [ ] **Sauvegardes & PITR Supabase** (données financières → RPO/RTO à définir), plan de restauration testé.
- [ ] **Isolation du worker OCR/LLM** (cf. §4.3) avant montée en charge.
- [ ] **Rate-limiting & quotas** sur les server functions IA (coût + abus).
- [ ] **CI** : exécuter `vitest run` + `playwright` en gating de merge ; appliquer les migrations Supabase de façon versionnée.
- [ ] **Migration Groq → Mistral** finalisée et clé/quotas provisionnés dans chaque environnement.
- [ ] **RGPD/loi 09-08 (CNDP Maroc)** : registre des traitements, hébergement des données, consentement.

---

### Inventaire technique de référence (pour audit)

| Domaine | Fichiers / objets clés |
|---|---|
| Server functions | `src/server/ocr.functions.ts`, `lettrage.functions.ts`, `factures.functions.ts`, `paie.functions.ts`, `dgi_validator.ts`, `mail.inbound.ts` |
| Lettrage / comptabilité | RPC `lier_transaction`, trigger `sync_ecriture_contrepartie`, `src/lib/comptabilite-bq.ts`, `src/lib/sage-export.ts` |
| OCR / scanner | `src/routes/_app/dossiers.$dossierId.relevescanner.tsx` (PDF.js tri Y, OCR vision) |
| Schéma & migrations | `supabase/migrations/*.sql` (schéma initial, briques parent-enfant, RPC, ledger continu, PCM complet) |
| Auth / accès | `src/integrations/supabase/auth-middleware.ts`, `client.ts`, fonctions `has_role`/`has_dossier_access` |
| Tests | `matching.test.ts`, `factures.utils.test.ts`, suites Playwright + Allure |

---

*Document généré pour la transition Cloud de Clarify. Les sections 4 et 5 sont volontairement formulées sous forme de questions/propositions destinées à l'arbitrage de l'expert Cloud/DevOps/FinTech.*
