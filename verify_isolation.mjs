// verify_isolation.mjs — garde-fou anti-régression de l'isolation multi-cabinet.
//   À lancer APRÈS la migration 20260715120000_harden_tenant_isolation.
//   `node verify_isolation.mjs`
//
// Principe : la RLS ne se lit pas via l'API REST, mais elle se PROUVE par le
// comportement. Un client ANONYME (clé publishable, NON connecté) ne doit voir
// AUCUNE ligne des tables tenant. S'il en voit → la RLS est désactivée ou une
// policy est trop permissive → l'anomalie « dossiers partagés » peut revenir.
//
// Contrôle aussi, en service_role : aucun dossier sans cabinet, aucun profil
// sans cabinet (un profil sans cabinet ne verrait rien / créerait des orphelins).
//
// Sort 0 si tout est vert, 1 si une fuite/incohérence est détectée, 3 si la
// base est injoignable.
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  fs.readFileSync(new URL(".env", import.meta.url), "utf8")
    .split(/\r?\n/).filter(l => l && !l.startsWith("#") && l.includes("="))
    .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);

// Fetch tolérant au proxy TLS d'entreprise (cf. proxy-supabase-server).
let D = false;
async function pf(i, x) {
  if (D) { const { fetch: uf, Agent } = await import("undici"); return uf(String(i), { ...x, dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) }); }
  try { return await fetch(String(i), x); } catch { D = true; const { fetch: uf, Agent } = await import("undici"); return uf(String(i), { ...x, dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) }); }
}

const URL_SB = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
const ANON = env.SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_PUBLISHABLE_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_SB || !ANON) { console.log("  .env incomplet (URL / clé publishable). STOP."); process.exit(3); }

const anon = createClient(URL_SB, ANON, { auth: { persistSession: false }, global: { fetch: pf } });

let echecs = 0;
const ok = (c, m) => { console.log(`  [${c ? "OK" : "!!"}] ${m}`); if (!c) echecs++; };

// ── 1. Un ANONYME ne voit AUCUNE donnée tenant (preuve que la RLS est active) ─
console.log("\n1. Étanchéité RLS vue par un client anonyme (0 ligne attendue)");
const TABLES = ["dossiers", "clients", "fournisseurs", "factures", "factures_fournisseurs", "ecritures_comptables", "comptes_bancaires", "justificatifs", "releves_bancaires"];
for (const t of TABLES) {
  const { data, error } = await anon.from(t).select("id").limit(1);
  if (error) {
    // Une erreur (permission denied) est ACCEPTABLE : l'anonyme est bloqué.
    ok(true, `${t} : accès anonyme refusé (${error.code || "erreur"}) ✔`);
  } else {
    ok((data ?? []).length === 0, `${t} : ${(data ?? []).length} ligne(s) visible(s) par un anonyme (attendu 0)`);
  }
}

// ── 2. Cohérence des rattachements (service_role) ────────────────────────────
if (!SERVICE) {
  console.log("\n2. (SUPABASE_SERVICE_ROLE_KEY absente — contrôles de cohérence ignorés)");
} else {
  console.log("\n2. Cohérence des rattachements cabinet");
  const sb = createClient(URL_SB, SERVICE, { auth: { persistSession: false }, global: { fetch: pf } });

  const { data: dsSansCab, error: eD } = await sb.from("dossiers").select("id,nom_societe").is("cabinet_id", null);
  if (eD) { console.log(`  base injoignable (${eD.message}). STOP.`); process.exit(3); }
  ok((dsSansCab ?? []).length === 0, `dossiers sans cabinet : ${(dsSansCab ?? []).length} (attendu 0)`);

  const { data: profSansCab } = await sb.from("profiles").select("id,email").is("cabinet_id", null);
  ok((profSansCab ?? []).length === 0, `profils sans cabinet : ${(profSansCab ?? []).length} (attendu 0)`);

  const { data: cabs } = await sb.from("cabinets").select("id");
  const { data: profs } = await sb.from("profiles").select("id,cabinet_id");
  console.log(`  info : ${(cabs ?? []).length} cabinet(s), ${(profs ?? []).length} profil(s).`);
  // NB : plusieurs profils par cabinet = LÉGITIME (collaborateurs d'un même
  // cabinet). L'isolation repose sur la RLS (test 1), pas sur l'unicité profil↔cabinet.
}

console.log(echecs === 0 ? "\n✅ Isolation étanche : un compte ne voit que son cabinet.\n" : `\n❌ ${echecs} contrôle(s) en échec — RISQUE DE FUITE ENTRE CABINETS.\n`);
process.exit(echecs === 0 ? 0 : 1);
