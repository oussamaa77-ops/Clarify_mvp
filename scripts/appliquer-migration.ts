/**
 * appliquer-migration.ts — applique un fichier de migration, et VÉRIFIE qu'il a pris.
 *
 * ─── Pourquoi ce script existe ───────────────────────────────────────────────
 * Les migrations de ce projet s'appliquent à la main dans le dashboard Supabase,
 * et ce n'est pas un choix : depuis le réseau de l'entreprise, aucun des chemins
 * habituels ne passe. Constaté, mesuré, pas supposé :
 *
 *   • `supabase db push` a besoin du port Postgres. `db.<ref>.supabase.co:5432`
 *     ne résout pas (ENOTFOUND — les projets récents n'exposent plus cet hôte),
 *     et le pooler `…pooler.supabase.com:6543` part en TIMEOUT. La CLI est bien
 *     installée (2.109.0) ; c'est le réseau qui manque, pas l'outil.
 *   • `psql` n'est pas installé, et aucune URL de base ne figure dans `.env`.
 *   • En revanche `https://api.supabase.com` RÉPOND (401 sans jeton, donc la
 *     couche réseau est bonne). C'est le seul chemin ouvert.
 *
 * D'où ce script : il passe par l'API Management, en HTTPS, comme le reste de
 * l'application. Il lui faut un JETON D'ACCÈS PERSONNEL — la clé de service ne
 * convient pas, elle n'ouvre que PostgREST, jamais le moteur SQL.
 *
 *   À créer sur https://supabase.com/dashboard/account/tokens
 *   puis :  SUPABASE_ACCESS_TOKEN=sbp_xxx  (variable d'environnement ou .env)
 *
 * ─── La VÉRIFICATION, elle, ne demande aucun jeton ───────────────────────────
 * PostgREST publie sa spécification OpenAPI sur `/rest/v1/` : elle liste les
 * fonctions et les vues réellement présentes dans le schéma. C'est une lecture,
 * accessible avec la clé de service, et c'est la seule preuve honnête qu'une
 * migration a pris — plus fiable que « le dashboard n'a pas affiché d'erreur ».
 *
 * Ce que la vérification NE PEUT PAS voir : les TRIGGERS et les INDEX, que
 * PostgREST n'expose pas. Le script le DIT au lieu de conclure au succès sur une
 * vérification partielle. Un contrôle qui tait ses angles morts ne vaut rien.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   # Vérifier seulement (aucun jeton nécessaire) :
 *   node --import tsx scripts/appliquer-migration.ts supabase/migrations/XXX.sql --verifier
 *
 *   # Appliquer puis vérifier (jeton nécessaire) :
 *   node --import tsx scripts/appliquer-migration.ts supabase/migrations/XXX.sql --apply
 *
 * CODE DE SORTIE : 0 = présente en base · 1 = absente ou partielle · 2 = échec.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const flag = (nom: string) => argv.some((a) => a === `--${nom}`);
const FICHIER = argv.find((a) => !a.startsWith("--"));
const APPLY = flag("apply");

if (!FICHIER) {
  console.error("Usage : appliquer-migration.ts <fichier.sql> [--apply]");
  process.exit(2);
}

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env"), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
) as Record<string, string>;

const SUPABASE_URL = env.SUPABASE_URL || env.VITE_SUPABASE_URL || "";
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || "";
// Le jeton personnel n'a rien à faire dans `.env` versionné : on le lit d'abord
// dans l'environnement du shell, qui est l'endroit correct pour un secret de ce
// niveau (il donne accès au MOTEUR SQL, pas seulement aux données).
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN || env.SUPABASE_ACCESS_TOKEN || "";
const REF = (SUPABASE_URL.match(/https:\/\/([a-z0-9]+)\.supabase\./) ?? [])[1] ?? "";

// Le proxy TLS de l'entreprise casse le `fetch` global ; undici en direct passe.
async function req(url: string, init: any = {}): Promise<Response> {
  const { fetch: uf, Agent } = await import("undici");
  return (uf as any)(url, { ...init, dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) });
}

// ─── Ce que le fichier PRÉTEND créer ─────────────────────────────────────────

interface Objets {
  fonctions: string[];
  vues: string[];
  /** Non vérifiables via PostgREST — nommés pour que l'angle mort soit visible. */
  triggers: string[];
  index: string[];
}

/**
 * Relève les objets déclarés par le fichier SQL.
 *
 * On lit le SOURCE plutôt qu'une liste écrite à la main : une liste se
 * désynchronise du fichier au premier ajout, et le script conclurait alors au
 * succès sans avoir contrôlé le nouvel objet.
 */
function objetsDeclares(sql: string): Objets {
  const tous = (re: RegExp) => [...sql.matchAll(re)].map((m) => m[1]);
  return {
    fonctions: [...new Set(tous(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.(\w+)/gi))],
    vues: [...new Set(tous(/CREATE\s+OR\s+REPLACE\s+VIEW\s+public\.(\w+)/gi))],
    triggers: [...new Set(tous(/CREATE\s+TRIGGER\s+(\w+)/gi))],
    index: [...new Set(tous(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi))],
  };
}

/**
 * Fonctions déjà déclarées par une migration ANTÉRIEURE.
 *
 * Les migrations sont horodatées dans leur nom : une comparaison de chaînes
 * suffit à les ordonner, et c'est déjà l'ordre dans lequel Supabase les applique.
 */
function fonctionsDesMigrationsAnterieures(nomFichier: string): Set<string> {
  const dir = path.join(ROOT, "supabase", "migrations");
  const noms = new Set<string>();
  if (!fs.existsSync(dir)) return noms;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".sql") && x < nomFichier)) {
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    for (const m of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(\w+)/gi)) {
      noms.add(m[1]);
    }
  }
  return noms;
}

// ─── Vérification (lecture seule, sans jeton) ────────────────────────────────

async function verifier(objets: Objets): Promise<boolean> {
  const r = await req(`${SUPABASE_URL}/rest/v1/`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) { console.error(`   ✗ Spécification PostgREST illisible (HTTP ${r.status}).`); return false; }

  const spec = await r.json() as any;
  const chemins = new Set(Object.keys(spec.paths ?? {}));

  // Une fonction que le fichier REMPLACE existait déjà : sa présence ne prouve
  // rien sur cette migration-ci. Seules les fonctions NOUVELLES sont probantes.
  // Sans cette distinction, `lier_transaction` et `synchroniser_paiements_dossier`
  // — remplacées ici mais créées en juillet — feraient passer pour appliquée une
  // migration qui ne l'est pas.
  const anterieures = fonctionsDesMigrationsAnterieures(path.basename(path.resolve(ROOT, FICHIER!)));

  let complet = true;
  let probantes = 0;
  console.log("\n   Fonctions :");
  for (const f of objets.fonctions) {
    const ok = chemins.has(`/rpc/${f}`);
    const nouvelle = !anterieures.has(f);
    if (!ok) complet = false;
    if (ok && nouvelle) probantes++;
    console.log(`     ${ok ? "✓" : "✗"} ${f}`
      + (nouvelle ? "" : "   (remplacée — existait avant, présence non probante)"));
  }
  if (!probantes && objets.fonctions.some((f) => !anterieures.has(f))) {
    console.log("     → aucune fonction NOUVELLE n'est présente : la migration n'a pas été exécutée.");
  }
  if (objets.vues.length) {
    console.log("   Vues :");
    for (const v of objets.vues) {
      const ok = chemins.has(`/${v}`);
      if (!ok) complet = false;
      console.log(`     ${ok ? "✓" : "✗"} ${v}`);
    }
  }
  // L'angle mort, dit explicitement.
  if (objets.triggers.length || objets.index.length) {
    console.log("   Non vérifiable par ce canal (PostgREST n'expose ni trigger ni index) :");
    for (const t of objets.triggers) console.log(`     ? trigger ${t}`);
    for (const i of objets.index) console.log(`     ? index   ${i}`);
    console.log("     → ces objets sont créés par le MÊME fichier, dans la même transaction");
    console.log("       que les fonctions ci-dessus : si celles-ci sont présentes, ils le sont aussi.");
  }
  return complet;
}

// ─── Application (API Management, jeton requis) ──────────────────────────────

async function appliquer(sql: string): Promise<boolean> {
  const r = await req(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  const corps = await r.text();
  if (!r.ok) {
    console.error(`   ✗ HTTP ${r.status} — ${corps.slice(0, 600)}`);
    return false;
  }
  console.log(`   ✓ SQL exécuté (HTTP ${r.status}).`);
  if (corps.trim() && corps.trim() !== "[]") console.log(`     ${corps.slice(0, 300)}`);
  return true;
}

// ─── Enchaînement ────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const chemin = path.resolve(ROOT, FICHIER!);
  if (!fs.existsSync(chemin)) { console.error(`Fichier introuvable : ${chemin}`); return 2; }
  const sql = fs.readFileSync(chemin, "utf8");
  const objets = objetsDeclares(sql);

  console.log(`\n📄 ${path.basename(chemin)} — projet ${REF}`);
  console.log(`   ${objets.fonctions.length} fonction(s), ${objets.vues.length} vue(s), `
    + `${objets.triggers.length} trigger(s), ${objets.index.length} index.`);

  if (APPLY) {
    if (!TOKEN) {
      console.error(
        "\n❌ APPLICATION IMPOSSIBLE — aucun jeton d'accès personnel.\n"
        + "\n   La clé de service (SUPABASE_SERVICE_ROLE_KEY) ne convient pas : elle ouvre"
        + "\n   PostgREST, pas le moteur SQL. Il faut un jeton de compte :"
        + "\n"
        + "\n     1. https://supabase.com/dashboard/account/tokens → « Generate new token »"
        + "\n     2. export SUPABASE_ACCESS_TOKEN=sbp_xxx"
        + "\n     3. relancer cette commande"
        + "\n"
        + "\n   Chemins écartés, et pourquoi : `supabase db push` exige le port Postgres,"
        + "\n   injoignable depuis ce réseau (db.<ref>.supabase.co ne résout pas, le pooler"
        + "\n   part en timeout) ; `psql` n'est pas installé et aucune URL de base n'existe"
        + "\n   dans .env. Sinon : coller le fichier dans l'éditeur SQL du dashboard.\n");
      return 2;
    }
    console.log("\n🚀 Application via l'API Management…");
    if (!await appliquer(sql)) return 2;
  }

  console.log("\n🔎 Vérification (spécification PostgREST, lecture seule) :");
  const complet = await verifier(objets);

  console.log(complet
    ? "\n✅ Migration PRÉSENTE en base."
    : "\n⚠️  Migration ABSENTE ou partielle — les objets marqués ✗ manquent.");
  return complet ? 0 : 1;
}

process.exit(await main());
