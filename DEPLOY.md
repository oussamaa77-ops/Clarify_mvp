# Déploiement de HisabPro (front-end + fonctions serveur)

## Pourquoi l'erreur `404: NOT_FOUND` sur Vercel

Cette application **n'est pas** un site statique : c'est une app **TanStack Start**
full-stack (rendu serveur + `createServerFn` pour l'OCR, l'import Grand Livre, la
facturation, l'e-mail SMTP, la file BullMQ…).

`npm run build` produit :

- `dist/client/` — les assets statiques **sans `index.html`** (les pages sont rendues
  par le serveur) ;
- `dist/server/server.js` — un **handler « fetch » Web** (`server.fetch(request)`), qui
  **n'écoute sur aucun port** tout seul.

Vercel a détecté un projet « Vite » et a servi `dist/` comme un site statique : comme il
n'y a **ni `index.html` ni fonction serverless**, toute URL renvoie `404`.

> Cette version de TanStack Start **ne fournit pas d'adaptateur Vercel** (pas de Nitro,
> pas de preset). De plus le bundle serveur tire des dépendances **natives/Node**
> (`canvas` via pdf.js, `bullmq`/`ioredis` pour la file Redis, `nodemailer`) qui ne
> conviennent pas au modèle serverless. **Le bon hôte est un serveur Node** (Railway,
> Render, Fly…) — c'est d'ailleurs déjà là que tourne votre backend.

## Ce qui a été ajouté pour corriger

- **`server.mjs`** — le chaînon manquant : un serveur HTTP Node qui sert `dist/client/`
  et délègue le reste à `server.fetch`. Écoute sur `$PORT` (0.0.0.0).
- **`npm start`** pointe désormais dessus (`node server.mjs`).
- **`Procfile`** (`web: npm start`) + **`.nvmrc`** (Node 20) + `engines.node >= 20`.

Vérifié en local : `npm run build && npm start` → `/` et `/auth` renvoient du HTML (200),
les assets sont servis.

## Déployer sur Railway (recommandé — même plateforme que le backend)

1. **New Project → Deploy from GitHub repo** (ou `railway up`).
2. Railway (Nixpacks) détecte Node et exécute automatiquement :
   `npm install` → `npm run build` → `npm start`. Aucune config supplémentaire requise.
3. **Générer un domaine** (Settings → Networking → Generate Domain). Railway fournit `$PORT`.
4. **Variables d'environnement** (Settings → Variables) — voir la liste ci-dessous.

> Render / Fly.io fonctionnent pareil : Build `npm run build`, Start `npm start`.

## Variables d'environnement

Le **build** (client) a besoin des variables `VITE_*`, et le **runtime** (fonctions
serveur) des variables serveur. Sur un hôte Node, build et runtime partagent le même
environnement — tout doit être présent :

**Obligatoires**
- `VITE_SUPABASE_URL` et `SUPABASE_URL` — même URL Supabase
- `VITE_SUPABASE_PUBLISHABLE_KEY` et `SUPABASE_PUBLISHABLE_KEY` — clé publishable
- `SUPABASE_SERVICE_ROLE_KEY` — **secret** (fonctions serveur : quotas, audit, admin)

**Selon les fonctionnalités utilisées**
- OCR : `MISTRAL_API_KEY`, `GROQ_API_KEY`
- E-mail : `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE`,
  `FROM_EMAIL`, `FROM_NAME` (`SMTP_TLS_REJECT_UNAUTHORIZED` si besoin)
- File asynchrone BullMQ : `REDIS_URL` (+ worker `npm run worker` en process séparé)
- Facturation : `BILLING_PROVIDER`, `QUOTA_STRICT`

## Si vous tenez absolument à Vercel

Il faudrait passer par la **Build Output API** (`.vercel/output`) avec une fonction
serverless qui emballe `server.fetch`, en neutralisant `canvas` (jamais utilisé côté
serveur) et en s'assurant que `bullmq`/`ioredis` ne se connectent pas au démarrage.
C'est faisable mais fragile et non couvert par un adaptateur officiel — dites-le-moi si
vous voulez que je le mette en place, sinon Railway/Render reste la voie fiable.
