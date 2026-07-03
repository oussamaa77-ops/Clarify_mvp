// Auth bootstrap : on se connecte via supabase-js (clé anon) et on injecte la
// session dans le storageState Playwright (localStorage de l'origine de l'app),
// ce qui évite de piloter le formulaire de login (plus rapide / moins flaky).
// Sans E2E_EMAIL / E2E_PASSWORD → on écrit un état vide et le Test UI se SKIP.
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { CONFIG, authStorageKey } from "./helpers/config";

// Proxy TLS d'entreprise : le certificat auto-signé intercepté fait échouer les
// connexions Supabase depuis Node (undici → SELF_SIGNED_CERT_IN_CHAIN), aussi bien
// ici (login) que dans les workers forkés ensuite (seed / RPC / admin). On neutralise
// la vérification pour le BANC DE TEST uniquement (équivalent `curl -k`), jamais dans
// le code applicatif. Un override explicite (=1) est respecté (strict sur réseau sain).
// NB : le process du serveur dev démarre AVANT ce hook → il reçoit la variable via
// `webServer.env` dans playwright.config.ts (couvre les server functions du Test 1).
process.env.NODE_TLS_REJECT_UNAUTHORIZED ??= "0";

export default async function globalSetup() {
  fs.mkdirSync(path.dirname(CONFIG.AUTH_STATE), { recursive: true });

  const empty = { cookies: [] as any[], origins: [] as any[] };

  if (!CONFIG.E2E_EMAIL || !CONFIG.E2E_PASSWORD) {
    fs.writeFileSync(CONFIG.AUTH_STATE, JSON.stringify(empty, null, 2));
    console.log("[global-setup] E2E_EMAIL/E2E_PASSWORD absents → Test UI sera SKIP.");
    return;
  }
  if (!CONFIG.SUPABASE_URL || !CONFIG.ANON_KEY) {
    fs.writeFileSync(CONFIG.AUTH_STATE, JSON.stringify(empty, null, 2));
    console.warn("[global-setup] SUPABASE_URL/ANON_KEY manquants → Test UI sera SKIP.");
    return;
  }

  const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.ANON_KEY, {
    auth: { persistSession: false },
  });
  const { data, error } = await sb.auth.signInWithPassword({
    email: CONFIG.E2E_EMAIL,
    password: CONFIG.E2E_PASSWORD,
  });
  if (error || !data.session) {
    fs.writeFileSync(CONFIG.AUTH_STATE, JSON.stringify(empty, null, 2));
    console.warn(`[global-setup] Login échoué (${error?.message ?? "no session"}) → Test UI sera SKIP.`);
    return;
  }

  const origin = new URL(CONFIG.BASE_URL).origin;
  const state = {
    cookies: [],
    origins: [
      {
        origin,
        localStorage: [
          { name: authStorageKey(), value: JSON.stringify(data.session) },
        ],
      },
    ],
  };
  fs.writeFileSync(CONFIG.AUTH_STATE, JSON.stringify(state, null, 2));
  console.log(`[global-setup] Session injectée pour ${CONFIG.E2E_EMAIL} → ${origin}`);
}
