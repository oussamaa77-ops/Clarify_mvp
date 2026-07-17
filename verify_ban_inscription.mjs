// ============================================================================
// verify_ban_inscription.mjs — Un compte fraîchement inscrit peut-il se
// connecter sans approbation ?
//
// Teste le chemin que le front NE contrôLE PAS : un POST direct sur
// /auth/v1/signup, sans passer par l'application. C'est le scénario que le
// bannissement applicatif (approval.functions.ts) ne couvre pas — seul le
// trigger de 20260717120000_ban_a_inscription.sql le ferme.
//
//   node verify_ban_inscription.mjs
//     exit 0 → le verrou tient (connexion refusée avant approbation)
//     exit 3 → TROU : le compte se connecte sans approbation
//              → appliquer 20260717120000_ban_a_inscription.sql dans le
//                dashboard Supabase (SQL editor).
//
// Crée un compte jetable et le supprime toujours, y compris en cas d'échec.
// ============================================================================
import { readFileSync } from "node:fs";
import { fetch as uf, Agent } from "undici";

const env = Object.fromEntries(
  readFileSync(new URL(".env", import.meta.url), "utf8").split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()])
);
const url = env.SUPABASE_URL;
const svc = env.SUPABASE_SERVICE_ROLE_KEY;
const anon = env.SUPABASE_PUBLISHABLE_KEY ?? env.VITE_SUPABASE_PUBLISHABLE_KEY;
if (!url || !svc || !anon) { console.error("SUPABASE_URL / SERVICE_ROLE_KEY / PUBLISHABLE_KEY requis dans .env"); process.exit(2); }

// Proxy TLS d'entreprise : cf. proxy-supabase-server.
const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
const email = `verify-ban-${Date.now()}@example.com`;
const pwd = "Verify!Passw0rd123";
let uid = null;

try {
  // Inscription DIRECTE, sans le front — comme le ferait un script tiers.
  const su = await uf(`${url}/auth/v1/signup`, {
    method: "POST", dispatcher,
    headers: { apikey: anon, "content-type": "application/json" },
    body: JSON.stringify({ email, password: pwd, data: { cabinet_nom: "Verify Cabinet" } }),
  });
  const suB = await su.json();
  uid = suB.user?.id ?? suB.id;
  if (!uid) { console.error(`inscription impossible : ${JSON.stringify(suB).slice(0, 200)}`); process.exit(2); }

  // La connexion DOIT être refusée : le trigger a dû bannir le compte.
  const li = await uf(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST", dispatcher,
    headers: { apikey: anon, "content-type": "application/json" },
    body: JSON.stringify({ email, password: pwd }),
  });
  const liB = await li.text();

  if (li.status === 200) {
    console.log("❌ TROU : un compte inscrit hors du front se connecte SANS approbation.");
    console.log("   → appliquer supabase/migrations/20260717120000_ban_a_inscription.sql");
    console.log("     dans le dashboard Supabase (SQL editor), puis relancer ce script.");
    process.exit(3);
  }
  if (!/banned/i.test(liB)) {
    console.log(`⚠️ connexion refusée (HTTP ${li.status}) mais pas pour cause de bannissement :`);
    console.log(`   ${liB.slice(0, 200)}`);
    process.exit(3);
  }
  console.log(`✅ connexion refusée avant approbation (HTTP ${li.status}, user_banned).`);
  console.log("   Le verrou tient même sans passer par l'application.");
  process.exit(0);
} finally {
  if (uid) {
    await uf(`${url}/auth/v1/admin/users/${uid}`, {
      method: "DELETE", dispatcher,
      headers: { apikey: svc, authorization: `Bearer ${svc}` },
    }).catch(() => {});
  }
}
