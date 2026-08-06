// Diagnostic Resend : valide la clé, liste les domaines vérifiés, tente un envoi
// réel — et affiche la RÉPONSE BRUTE de l'API dans tous les cas.
// Passe par undici (le proxy TLS d'entreprise casse le fetch global).
import { readFileSync } from "node:fs";
import { fetch as uf, Agent } from "undici";

const DEST = process.argv[2] ?? "oussamakarmaoui7@gmail.com";

// .env lu à la main : pas de dépendance, et on voit exactement ce qui est posé.
const env = {};
for (const l of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const KEY = (env.RESEND_API_KEY ?? "").trim();
const FROM = (env.RESEND_FROM ?? "").trim() || "Clarify <onboarding@resend.dev>";

const masque = (k) => (k ? `${k.slice(0, 8)}…${k.slice(-4)} (${k.length} car.)` : "(absente)");
const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });

const appel = async (methode, chemin, body) => {
  const res = await uf(`https://api.resend.com${chemin}`, {
    method: methode,
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    dispatcher,
  });
  return { status: res.status, brut: await res.text() };
};

console.log("=== CONFIG LUE DANS .env ===");
console.log(`RESEND_API_KEY   : ${masque(KEY)}`);
console.log(`RESEND_FROM      : ${env.RESEND_FROM ? env.RESEND_FROM : "(NON POSÉE) → repli bac à sable"}`);
console.log(`from effectif    : ${FROM}`);
console.log(`ADMIN_APPROVAL_EMAIL : ${env.ADMIN_APPROVAL_EMAIL ?? "(défaut code) oussamakarmaoui7@gmail.com"}`);
console.log(`MAIL_TRANSPORT   : ${env.MAIL_TRANSPORT ?? "(auto)"}`);
console.log(`destinataire test: ${DEST}\n`);

if (!KEY) { console.error("RESEND_API_KEY absente — rien à tester."); process.exit(2); }

try {
  console.log("=== 1. VALIDITÉ DE LA CLÉ (GET /domains) ===");
  const d = await appel("GET", "/domains");
  console.log(`HTTP ${d.status}`);
  console.log(d.brut.slice(0, 1500), "\n");

  console.log("=== 2. ENVOI RÉEL (POST /emails) ===");
  const e = await appel("POST", "/emails", {
    from: FROM,
    to: [DEST],
    subject: `Test Resend — ${new Date().toISOString()}`,
    html: "<p>Test de diagnostic du transport Resend (approbation d'inscription).</p>",
    text: "Test de diagnostic du transport Resend (approbation d'inscription).",
  });
  console.log(`HTTP ${e.status}`);
  console.log(e.brut.slice(0, 2000));
  console.log(`\n→ ${e.status === 200 ? "ACCEPTÉ par l'API" : "REFUSÉ par l'API"}`);
} catch (err) {
  console.error("=== APPEL RÉSEAU IMPOSSIBLE ===");
  console.error(`${err?.name}: ${err?.message}`);
  if (err?.cause) console.error(`cause: ${err.cause?.code ?? ""} ${err.cause?.message ?? err.cause}`);
  process.exit(3);
}
