// Chargement minimal du .env racine (sans dépendance dotenv) + constantes partagées.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Normalise une valeur .env : guillemets entourants retirés, commentaire inline
// `# …` retiré uniquement si la valeur n'est pas entre guillemets (convention dotenv).
function parseEnvValue(raw: string): string {
  let v = raw.trim();
  const q = v[0];
  if ((q === '"' || q === "'") && v.length >= 2) {
    const end = v.indexOf(q, 1);
    if (end !== -1) return v.slice(1, end); // ignore tout ce qui suit le guillemet fermant
  }
  const hash = v.indexOf(" #");
  if (hash !== -1) v = v.slice(0, hash).trim();
  return v;
}

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const file = path.join(ROOT, ".env");
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line || line.startsWith("#")) continue;
      const i = line.indexOf("=");
      if (i === -1) continue;
      out[line.slice(0, i).trim()] = parseEnvValue(line.slice(i + 1));
    }
  }
  // process.env l'emporte (utile pour E2E_EMAIL/E2E_PASSWORD passés en ligne de commande)
  return { ...out, ...process.env } as Record<string, string>;
}

const env = loadEnv();

export const CONFIG = {
  ROOT,
  BASE_URL: env.E2E_BASE_URL || "http://localhost:3000",
  SUPABASE_URL: env.SUPABASE_URL || env.VITE_SUPABASE_URL || "",
  SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY || "",
  ANON_KEY: env.VITE_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_PUBLISHABLE_KEY || "",
  // Identifiants du test UI (Test 1). Sans eux, le test UI est SKIP.
  E2E_EMAIL: env.E2E_EMAIL || "",
  E2E_PASSWORD: env.E2E_PASSWORD || "",

  // Cible métier — surchargeable via E2E_ICE (défaut : STE SMART WATER).
  TARGET_ICE: env.E2E_ICE || "003279992000040",

  // Marqueurs d'isolation (teardown les supprime tous)
  TEST_PREFIX: "TEST_PERF",
  TEST_COMPTE_INTITULE: "TEST_PERF_COMPTE",

  // Volume du lot injecté (100–500 demandé)
  SEED_COUNT: Number(env.SEED_COUNT || 250),
  // Concurrence du bombardement RPC (Test 2)
  STRESS_CONCURRENCY: Number(env.STRESS_CONCURRENCY || 25),
  // Objectif de latence RPC (ms) — reporté dans Allure ; hard-fail seulement si PERF_STRICT=1
  PERF_MAX_MS: Number(env.PERF_MAX_MS || 50),
  PERF_STRICT: env.PERF_STRICT === "1",

  // storageState d'auth produit par global-setup
  AUTH_STATE: path.join(ROOT, "e2e", ".auth", "state.json"),
};

// Référence projet Supabase (sous-domaine) → clé de stockage de session supabase-js.
export function projectRef(): string {
  try { return new URL(CONFIG.SUPABASE_URL).host.split(".")[0]; }
  catch { return ""; }
}
export function authStorageKey(): string {
  return `sb-${projectRef()}-auth-token`;
}
