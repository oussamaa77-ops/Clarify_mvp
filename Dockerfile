# ============================================================================
# Dockerfile du FRONT-END HisabPro (TanStack Start, servi par server.mjs).
# Build multi-étapes : deps → build → runner minimal.
#
# ⚠️ Les variables VITE_* sont figées DANS le bundle client au moment du build :
# elles doivent être fournies comme build args (Railway les injecte depuis les
# variables du service). Les secrets serveur (SUPABASE_SERVICE_ROLE_KEY, SMTP…)
# ne sont lus qu'au RUNTIME — ne pas les mettre ici.
# ============================================================================

# ---- 1) Dépendances (dev incluses : vite/tsc nécessaires au build) ----
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --legacy-peer-deps

# ---- 2) Build (client dist/client + serveur dist/server) ----
FROM node:20-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Variables publiques nécessaires à la compilation du bundle client.
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY
RUN npm run build

# ---- 3) Runner : uniquement ce qu'il faut pour SERVIR ----
FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
# node_modules requis : dist/server/server.js importe des paquets non bundlés
# (h3, @tanstack/*, nodemailer, ioredis…). package.json requis pour "type":"module".
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/server.mjs ./server.mjs
# Le proxy Railway cible 8080. On fixe PORT=8080 par défaut dans l'image plutôt
# que de compter sur une injection au runtime : si la variable est absente,
# server.mjs retombe sur 3000 et le proxy tape dans le vide (« Application failed
# to respond »). Une variable PORT définie sur le service écrase cette valeur.
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
