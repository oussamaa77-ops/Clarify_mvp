// ============================================================================
// verify_approbation_flux.mjs — Exerce le parcours d'approbation de bout en bout
// contre la VRAIE base, sans dépendre de l'envoi d'e-mail (les ports SMTP sont
// bloqués sur le réseau du cabinet ; les liens du mail sont reconstruits ici).
//
// Prérequis : serveur démarré (npm run dev) sur http://localhost:3000
// Usage     : node verify_approbation_flux.mjs
//
// Le compte de test est créé puis supprimé : la base revient à son état initial.
// ============================================================================
import { fetch as uf, Agent } from "undici";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("./.env", import.meta.url), "utf8").split(/\r?\n/)
    .filter((l) => l && !l.trim().startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")]; })
);

const SB = env.SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = env.SUPABASE_PUBLISHABLE_KEY;
const APP = (env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
const admin = { apikey: KEY, Authorization: `Bearer ${KEY}` };

const MDP = "MotDePasseTest123!";
const email = `verif-approbation-${Date.now()}@example.com`;

let echecs = 0;
const ok = (n, d = "") => console.log(`  OK    ${n}${d ? ` — ${d}` : ""}`);
const ko = (n, d = "") => { echecs++; console.log(`  ÉCHEC ${n}${d ? ` — ${d}` : ""}`); };
const verifier = (cond, nom, detail) => (cond ? ok(nom, detail) : ko(nom, detail));

/** Tente une connexion. Renvoie {connecte, message}. */
async function tenterConnexion(mail, mdp) {
  const r = await uf(`${SB}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({ email: mail, password: mdp }),
    dispatcher,
  });
  const j = await r.json();
  return { connecte: r.ok && !!j.access_token, message: j.error_description || j.msg || j.error || "" };
}

const trouverUser = async (mail) => {
  const r = await uf(`${SB}/auth/v1/admin/users?per_page=200`, { headers: admin, dispatcher });
  return ((await r.json()).users ?? []).find((u) => u.email?.toLowerCase() === mail.toLowerCase());
};

console.log(`\nParcours d'approbation — compte de test : ${email}\n`);

// ── 1. Le serveur répond-il ? ────────────────────────────────────────────────
try {
  await uf(`${APP}/api/approve-user`, { dispatcher, headers: { accept: "text/html" } });
} catch {
  console.error(`Serveur injoignable sur ${APP}. Lancez « npm run dev » puis relancez.`);
  process.exit(2);
}

// ── 2. Inscription (via l'API admin, comme le fait inscrireEnAttente) ────────
console.log("1) Inscription");
const cree = await uf(`${SB}/auth/v1/admin/users`, {
  method: "POST",
  headers: { ...admin, "content-type": "application/json" },
  body: JSON.stringify({ email, password: MDP, email_confirm: true, user_metadata: { nom: "Verif", prenom: "Auto", cabinet_nom: "Cabinet Vérif", plan_code: "starter" } }),
  dispatcher,
});
if (!cree.ok) { console.error("Création impossible :", cree.status, await cree.text()); process.exit(1); }
const userId = (await cree.json()).id;
// Le ban que pose inscrireEnAttente (le trigger le fait aussi, on le rejoue).
await uf(`${SB}/auth/v1/admin/users/${userId}`, {
  method: "PUT", headers: { ...admin, "content-type": "application/json" },
  body: JSON.stringify({ ban_duration: "876000h" }), dispatcher,
});
const u1 = await trouverUser(email);
verifier(!!u1?.banned_until && new Date(u1.banned_until) > new Date(), "compte créé et banni");
const p1 = await (await uf(`${SB}/rest/v1/profiles?id=eq.${userId}&select=is_approved,cabinet_id`, { headers: admin, dispatcher })).json();
verifier(p1[0]?.is_approved === false, "profil créé avec is_approved=false");
verifier(!!p1[0]?.cabinet_id, "cabinet rattaché");

// ── 3. Connexion refusée AVANT approbation ───────────────────────────────────
console.log("\n2) Connexion avant approbation");
const avant = await tenterConnexion(email, MDP);
verifier(!avant.connecte, "connexion REFUSÉE avec le bon mot de passe", avant.message);

// ── 4. Refus : GET ne détruit rien, POST supprime ────────────────────────────
console.log("\n3) Bouton « Refuser »");
const jeton = createHmac("sha256", env.APPROVAL_TOKEN_SECRET).update(userId).digest("hex");
const lienNon = `${APP}/api/reject-user?userId=${userId}&token=${jeton}`;

const faux = await uf(`${APP}/api/reject-user?userId=${userId}&token=deadbeef`, { dispatcher });
verifier(faux.status === 400, "jeton invalide rejeté", `HTTP ${faux.status}`);

const conf = await uf(lienNon, { dispatcher });
const htmlConf = await conf.text();
verifier(conf.ok && /Refuser cette inscription/.test(htmlConf), "GET affiche la confirmation");
verifier(!!(await trouverUser(email)), "GET (préchargement mail) n'a RIEN supprimé");

// ── 5. Approbation ───────────────────────────────────────────────────────────
console.log("\n4) Bouton « Approuver »");
const app = await uf(`${APP}/api/approve-user?userId=${userId}&token=${jeton}`, { dispatcher, redirect: "manual" });
verifier(app.status === 303 && (app.headers.get("location") ?? "").includes("approbation=ok"), "approbation acceptée", `→ ${app.headers.get("location")}`);
const p2 = await (await uf(`${SB}/rest/v1/profiles?id=eq.${userId}&select=is_approved`, { headers: admin, dispatcher })).json();
verifier(p2[0]?.is_approved === true, "is_approved passé à true");
const u2 = await trouverUser(email);
verifier(!u2?.banned_until || new Date(u2.banned_until) <= new Date(), "bannissement levé");

// ── 6. Connexion APRÈS approbation ───────────────────────────────────────────
console.log("\n5) Connexion après approbation");
const apres = await tenterConnexion(email, MDP);
verifier(apres.connecte, "connexion ACCEPTÉE avec les mêmes identifiants", apres.message);

// ── 7. Refus effectif (POST) ─────────────────────────────────────────────────
console.log("\n6) Refus effectif (POST) et libération de l'adresse");
const del = await uf(lienNon, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ userId, token: jeton }).toString(),
  dispatcher,
});
const htmlDel = await del.text();
verifier(del.ok && /Inscription refusée/.test(htmlDel), "POST confirme le refus");
verifier(!(await trouverUser(email)), "compte supprimé — adresse de nouveau libre");
const refuse = await tenterConnexion(email, MDP);
verifier(!refuse.connecte, "connexion impossible après refus", refuse.message);

// ── Ménage : le compte doit avoir disparu ; on force au cas où. ──────────────
if (await trouverUser(email)) await uf(`${SB}/auth/v1/admin/users/${userId}`, { method: "DELETE", headers: admin, dispatcher });

console.log(`\n${echecs === 0 ? "TOUT PASSE — le parcours complet fonctionne." : `${echecs} ÉCHEC(S).`}\n`);
process.exit(echecs === 0 ? 0 : 1);
