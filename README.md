# 🧾 HisabPro — Lancement local / Codespaces

## Option 1 — GitHub Codespaces (le plus simple, aucune installation)

1. Poussez ce dossier sur GitHub
2. Ouvrez le repo → bouton vert **Code** → **Codespaces** → **Create codespace**
3. Attendez ~2 min (installation automatique)
4. Dans le terminal Codespaces :

```bash
# Mode développement (hot reload)
npm run dev
```

L'app s'ouvre automatiquement sur le port 3000. C'est tout.

---

## Option 2 — Docker local

**Prérequis :** Docker Desktop installé

```bash
# 1. Clonez / extrayez le projet
cd hisabpro

# 2. Vérifiez que le .env contient vos clés
# (déjà pré-rempli avec les clés Supabase du projet)
# Ajoutez ANTHROPIC_API_KEY et RESEND_API_KEY si vous en avez

# 3. Lancez
docker compose up --build

# App disponible sur http://localhost:3000
```

---

## Option 3 — Node.js local (sans Docker)

**Prérequis :** Node.js 20+

```bash
npm install --legacy-peer-deps

# Développement (hot reload, recommandé pour tester)
npm run dev
# → http://localhost:3000

# OU production
npm run build && npm start
```

---

## Variables d'environnement

Le fichier `.env` est déjà pré-rempli avec les clés Supabase du projet.

Pour activer l'OCR IA et les emails, ajoutez dans `.env` :

```env
ANTHROPIC_API_KEY=sk-ant-...   # Claude Haiku (gratuit $5 crédit)
RESEND_API_KEY=re_...           # Emails (gratuit 3000/mois)
FROM_EMAIL=noreply@votredomaine.com
```

Sans ces clés :
- OCR fonctionne quand même (mode regex seulement, moins précis)
- Les emails ne sont pas envoyés (pas d'erreur, juste silencieux)

---

## Test bout-en-bout

1. Ouvrez http://localhost:3000
2. Créez un compte (page /auth)
3. Créez un dossier → PCM initialisé automatiquement
4. Créez un client (nom + email requis pour recevoir la facture)
5. Créez une facture → cliquez **e-Facture DGI**
   - XML UBL 2.1 généré
   - SHA-256 calculé
   - UUID DGI mock attribué
   - Écritures PCM créées (3421/7111/44551)
   - Email envoyé au client (si RESEND_API_KEY configurée)
6. Allez dans **Comptabilité** → Balance → vérifiez les écritures
7. Allez dans **GED** → le document XML est archivé
8. Allez dans **Audit** → toutes les actions sont tracées avec hash chaîné
