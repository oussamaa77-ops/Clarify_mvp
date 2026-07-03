# Déploiement HisabPro sur Cloudflare Pages

## Pourquoi Cloudflare Pages ?
- ✅ Gratuit (100k requêtes/jour)
- ✅ `wrangler.jsonc` déjà configuré dans le projet
- ✅ Supporte TanStack Start (SSR + server functions)
- ✅ Pas besoin de backend séparé
- ✅ Variables d'env dans l'interface web Cloudflare

---

## Étapes (10 minutes)

### 1. Pousser sur GitHub
```bash
git init
git add -A
git commit -m "HisabPro initial"
git remote add origin https://github.com/VOTRE-USERNAME/hisabpro.git
git push -u origin main
```

### 2. Connecter à Cloudflare Pages
1. Allez sur **https://dash.cloudflare.com**
2. Menu gauche → **Workers & Pages** → **Create** → **Pages**
3. **Connect to Git** → Sélectionnez votre repo GitHub
4. Configuration du build :
   - **Framework preset**: None
   - **Build command**: `npm run build`
   - **Build output directory**: `.output/public`
   - **Root directory**: (laisser vide)

### 3. Variables d'environnement
Dans **Settings > Environment variables**, ajoutez :

| Variable | Valeur |
|----------|--------|
| `SUPABASE_URL` | https://vimyobeuujxlfhtauzoh.supabase.co |
| `SUPABASE_PUBLISHABLE_KEY` | votre clé anon |
| `VITE_SUPABASE_URL` | https://vimyobeuujxlfhtauzoh.supabase.co |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | votre clé anon |
| `VITE_SUPABASE_PROJECT_ID` | vimyobeuujxlfhtauzoh |
| `ANTHROPIC_API_KEY` | sk-ant-... (Claude Haiku OCR) |
| `RESEND_API_KEY` | re_... (emails gratuits) |
| `FROM_EMAIL` | noreply@votredomaine.com |

### 4. Déployer
Cliquez **Save and Deploy**. Cloudflare build automatiquement.

URL obtenue : `https://hisabpro.pages.dev` (ou votre domaine custom)

### 5. Configurer Supabase
Dans Supabase → **Authentication > URL Configuration** :
- Site URL : `https://hisabpro.pages.dev`
- Redirect URLs : `https://hisabpro.pages.dev/**`

---

## Emails : Resend (gratuit)
1. Créez un compte sur https://resend.com
2. API Keys → Create → copiez la clé `re_...`
3. Ajoutez dans Cloudflare : `RESEND_API_KEY=re_...`
4. Pour envoyer depuis votre domaine : vérifiez-le dans Resend (DNS)
5. Sans domaine custom : utilisez `onboarding@resend.dev` (100 emails/jour)

## OCR IA : Claude Haiku
1. https://console.anthropic.com → Settings → API Keys
2. $5 de crédit gratuit à l'inscription
3. Claude Haiku coûte ~$0.0008 / 1000 tokens (très pas cher)
4. ~1000 factures OCR ≈ $0.50

---

## Coût total estimé
| Service | Plan | Coût/mois |
|---------|------|-----------|
| Cloudflare Pages | Free | 0€ |
| Supabase | Free (500MB) | 0€ |
| Resend | Free (3000 emails) | 0€ |
| Anthropic Haiku | Pay-per-use | ~1-5€ |
| **Total** | | **~1-5€/mois** |
