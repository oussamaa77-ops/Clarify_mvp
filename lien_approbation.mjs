// ============================================================================
// lien_approbation.mjs — Reconstitue le lien « Approuver ce compte » sans mail.
//
// Le port SMTP sortant est bloqué sur certains réseaux : le mail d'approbation
// ne part pas et l'inscription reste bloquée en attente. Le jeton étant un HMAC
// sans état de l'userId (cf. src/server/approval.token.ts), il se recalcule ici
// à partir d'APPROVAL_TOKEN_SECRET — le lien produit est identique à celui du
// mail.
//
//   node lien_approbation.mjs                      → liste les comptes en attente
//   node lien_approbation.mjs <email>              → lien pour ce compte
//   node lien_approbation.mjs <email> --supprimer  → supprime le compte (refaire le test)
// ============================================================================
import { fetch as uf, Agent } from "undici";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("./.env", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.trim().startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")];
    })
);

const SB_URL = env.SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const APP_URL = (env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
// Le proxy TLS d'entreprise casse le fetch global : undici en direct (même
// motif que les server functions).
const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
const auth = { apikey: KEY, Authorization: `Bearer ${KEY}` };

if (!SB_URL || !KEY) {
  console.error("SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont requis dans .env.");
  process.exit(1);
}

const [emailArg, ...flags] = process.argv.slice(2);
const supprimer = flags.includes("--supprimer");

const r = await uf(`${SB_URL}/auth/v1/admin/users?per_page=200`, { headers: auth, dispatcher });
if (!r.ok) {
  console.error("Lecture des comptes impossible :", r.status, await r.text());
  process.exit(1);
}
const users = (await r.json()).users ?? [];

// banned_until dans le futur = compte créé mais pas encore approuvé.
const enAttente = users.filter((u) => u.banned_until && new Date(u.banned_until) > new Date());

if (!emailArg) {
  if (enAttente.length === 0) {
    console.log("Aucun compte en attente d'approbation.");
  } else {
    console.log(`${enAttente.length} compte(s) en attente :\n`);
    for (const u of enAttente) console.log(`  ${u.email}  (créé ${u.created_at.slice(0, 19).replace("T", " ")})`);
    console.log(`\nLien d'approbation : node lien_approbation.mjs <email>`);
  }
  process.exit(0);
}

const cible = users.find((u) => u.email?.toLowerCase() === emailArg.toLowerCase());
if (!cible) {
  console.error(`Aucun compte pour « ${emailArg} ».`);
  console.error(`Comptes existants : ${users.map((u) => u.email).join(", ")}`);
  process.exit(1);
}

if (supprimer) {
  const d = await uf(`${SB_URL}/auth/v1/admin/users/${cible.id}`, { method: "DELETE", headers: auth, dispatcher });
  console.log(d.ok ? `Compte ${cible.email} supprimé — l'adresse est de nouveau libre.` : `Échec : ${d.status} ${await d.text()}`);
  process.exit(d.ok ? 0 : 1);
}

const secret = (env.APPROVAL_TOKEN_SECRET ?? "").trim();
if (secret.length < 16) {
  console.error("APPROVAL_TOKEN_SECRET manquant ou trop court dans .env — le lien serait rejeté par le serveur.");
  process.exit(1);
}
const token = createHmac("sha256", secret).update(cible.id).digest("hex");

const approuve = !cible.banned_until || new Date(cible.banned_until) <= new Date();
console.log(`Compte  : ${cible.email}`);
console.log(`État    : ${approuve ? "déjà approuvé (le lien reste sans effet)" : "en attente d'approbation"}`);
console.log(`\nOuvrez ce lien dans le navigateur (serveur démarré sur ${APP_URL}) :\n`);
console.log(`${APP_URL}/api/approve-user?userId=${encodeURIComponent(cible.id)}&token=${token}`);
