/**
 * attribuer-codes-auxiliaires.ts — script ONE-SHOT d'attribution des CODES
 * AUXILIAIRES (« C0001 », « F0001 ») aux fiches tiers déjà en base.
 *
 * Contexte : la comptabilité auxiliaire (`src/lib/comptes-auxiliaires.ts`) dérive
 * le compte de tiers détaillé du code porté par la fiche — 4411 + F0005 → 44110005.
 * Sans code, on retombe sur le COLLECTIF (4411 / 3421) : la mécanique est donc
 * restée INERTE tant qu'aucun tiers n'avait de code. Ce script attribue la
 * séquence en une passe, avec la MÊME fonction que le bouton « baguette magique »
 * des formulaires tiers (`nextCodeAuxiliaire`), pour que les codes attribués ici
 * et ceux créés plus tard depuis l'UI forment une seule et même suite.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   node --import tsx scripts/attribuer-codes-auxiliaires.ts                 # DRY-RUN
 *   node --import tsx scripts/attribuer-codes-auxiliaires.ts --apply         # écrit
 *   node --import tsx scripts/attribuer-codes-auxiliaires.ts --dossier="XXX"
 *   node --import tsx scripts/attribuer-codes-auxiliaires.ts --rollback=backup.json
 *
 * Options :
 *   --dossier="<nom>"    Limite à une raison sociale (défaut : TOUS les dossiers).
 *   --apply              Écrit en base. SANS ce drapeau : simulation seule.
 *   --inclure-supprimes  Code aussi les fiches soft-deletées (`deleted_at`).
 *   --rollback=<file>    Restaure les codes depuis un fichier de sauvegarde.
 *
 * ─── Sûreté ──────────────────────────────────────────────────────────────────
 * • La séquence est calculée PAR DOSSIER (un code n'est unique que dans son
 *   dossier) et repart des codes DÉJÀ présents : un tiers déjà codé n'est jamais
 *   touché, et aucun doublon n'est créé — vérifié avant écriture, le script
 *   s'arrête si une collision subsiste (aucune contrainte UNIQUE en base).
 * • L'ordre d'attribution est chronologique (`created_at`, puis `nom`) : stable et
 *   reproductible, le plus ancien tiers reçoit C0001/F0001.
 * • PostgREST n'expose pas de transaction multi-requêtes : la réversibilité passe
 *   par `backup_codes_aux_<date>.json` (écrit AVANT la première mise à jour).
 *
 * ⚠️ N'affecte QUE les écritures FUTURES : les pièces déjà comptabilisées gardent
 * le compte collectif avec lequel elles ont été enregistrées. Le bilan final
 * indique combien d'écritures sont concernées.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { nextCodeAuxiliaire } from "../src/lib/sage-export";
import { compteTiersAuxiliaire, type TypeTiers } from "../src/lib/comptes-auxiliaires";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ─── Arguments ───────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (nom: string): string | undefined => {
  const hit = argv.find((a) => a === `--${nom}` || a.startsWith(`--${nom}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf("=");
  return eq === -1 ? "" : hit.slice(eq + 1).replace(/^["']|["']$/g, "");
};
const NOM_DOSSIER = flag("dossier") || null;
const APPLY = flag("apply") !== undefined;
const INCLURE_SUPPRIMES = flag("inclure-supprimes") !== undefined;
const ROLLBACK = flag("rollback") || null;

// ─── Connexion Supabase (service_role : le script contourne la RLS) ──────────

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env"), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
) as Record<string, string>;

// Le proxy TLS d'entreprise casse le `fetch` global de Node → repli undici
// (cf. mémoire « proxy-supabase-server »).
let PROXY_DIRECT = false;
async function proxyFetch(input: any, init?: any): Promise<any> {
  const direct = async () => {
    const { fetch: uf, Agent } = await import("undici");
    return uf(String(input), { ...init, dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) } as any);
  };
  if (PROXY_DIRECT) return direct();
  try { return await fetch(String(input), init); }
  catch { PROXY_DIRECT = true; return direct(); }
}
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  global: { fetch: proxyFetch as any },
  auth: { persistSession: false },
});

const TABLE: Record<TypeTiers, "clients" | "fournisseurs"> = { client: "clients", fournisseur: "fournisseurs" };

interface Attribution {
  table: "clients" | "fournisseurs";
  type: TypeTiers;
  id: string;
  nom: string;
  dossier: string;
  ancien: string | null;
  code: string;
  compte: string;
}

// ─── Rollback ────────────────────────────────────────────────────────────────

if (ROLLBACK) {
  const f = path.isAbsolute(ROLLBACK) ? ROLLBACK : path.join(ROOT, ROLLBACK);
  const sauvegarde = JSON.parse(fs.readFileSync(f, "utf8")) as { attributions: Attribution[] };
  console.log(`\n↩️  ROLLBACK depuis ${path.basename(f)} — ${sauvegarde.attributions.length} fiche(s)\n`);
  for (const a of sauvegarde.attributions) {
    const { error } = await sb.from(a.table).update({ code_auxiliaire: a.ancien }).eq("id", a.id);
    console.log(`  ${error ? "❌" : "✅"} ${a.nom} : ${a.code} → ${a.ancien ?? "(vide)"}${error ? ` (${error.message})` : ""}`);
  }
  console.log("");
  process.exit(0);
}

// ─── 1. Dossiers ciblés ──────────────────────────────────────────────────────

console.log(`\n🔧 Attribution des codes auxiliaires — ${APPLY ? "MODE ÉCRITURE (--apply)" : "SIMULATION (dry-run)"}\n`);

const normNom = (v: string | null | undefined) =>
  (v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();

const { data: dossiers, error: errDos } = await sb.from("dossiers").select("id,nom_societe").order("nom_societe");
if (errDos) { console.error(`❌ Lecture des dossiers impossible : ${errDos.message}`); process.exit(1); }

let cibles = dossiers ?? [];
if (NOM_DOSSIER) {
  const cible = normNom(NOM_DOSSIER);
  cibles = cibles.filter((d) => {
    const n = normNom(d.nom_societe);
    return n === cible || n.startsWith(cible) || cible.startsWith(n);
  });
  if (cibles.length === 0) {
    console.error(`❌ ARRÊT : aucun dossier nommé « ${NOM_DOSSIER} ».`);
    console.error(`   Dossiers existants : ${(dossiers ?? []).map((d) => `« ${d.nom_societe} »`).join(", ") || "(aucun)"}`);
    process.exit(1);
  }
}
console.log(`📁 ${cibles.length} dossier(s) : ${cibles.map((d) => d.nom_societe).join(", ")}\n`);

// ─── 2. Calcul des attributions, dossier par dossier ─────────────────────────

const attributions: Attribution[] = [];
const dejaCodes: { nom: string; code: string; dossier: string }[] = [];
let supprimesIgnores = 0;

for (const dossier of cibles) {
  console.log(`── ${dossier.nom_societe}`);

  for (const type of ["client", "fournisseur"] as TypeTiers[]) {
    const table = TABLE[type];
    const { data, error } = await sb
      .from(table)
      .select("id,nom,code_auxiliaire,created_at,deleted_at")
      .eq("dossier_id", dossier.id);
    if (error) { console.error(`   ❌ Lecture ${table} impossible : ${error.message}`); process.exit(1); }

    const tous = data ?? [];
    const retenus = INCLURE_SUPPRIMES ? tous : tous.filter((t: any) => !t.deleted_at);
    supprimesIgnores += tous.length - retenus.length;

    // Ordre chronologique de création : le plus ancien tiers prend C0001 / F0001.
    retenus.sort((a: any, b: any) =>
      String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")) || String(a.nom).localeCompare(String(b.nom)));

    // La séquence repart des codes DÉJÀ attribués dans CE dossier (y compris ceux
    // des fiches supprimées, jamais réutilisés : un code retiré ne se recycle pas).
    const codesDuDossier = tous.map((t: any) => t.code_auxiliaire as string | null);
    const aCoder = retenus.filter((t: any) => !String(t.code_auxiliaire ?? "").trim());

    for (const t of retenus as any[]) {
      const existant = String(t.code_auxiliaire ?? "").trim();
      if (existant) {
        dejaCodes.push({ nom: t.nom, code: existant, dossier: dossier.nom_societe });
        continue;
      }
      const code = nextCodeAuxiliaire(type, codesDuDossier);
      codesDuDossier.push(code); // réserve le code pour l'itération suivante
      attributions.push({
        table, type, id: t.id, nom: t.nom, dossier: dossier.nom_societe,
        ancien: t.code_auxiliaire ?? null, code,
        compte: compteTiersAuxiliaire(type, code),
      });
    }

    const libelle = type === "client" ? "clients" : "fournisseurs";
    console.log(`   ${libelle.padEnd(13)}: ${retenus.length} fiche(s) — ${aCoder.length} à coder, ${retenus.length - aCoder.length} déjà codée(s)`);
    for (const a of attributions.filter((x) => x.dossier === dossier.nom_societe && x.type === type)) {
      console.log(`      → ${a.code}  ${a.nom.padEnd(34).slice(0, 34)}  compte ${a.compte}`);
    }
  }
  console.log("");
}

// ─── 3. Garde anti-doublon (aucune contrainte UNIQUE en base) ────────────────

const parDossier = new Map<string, Set<string>>();
for (const a of [...dejaCodes.map((d) => ({ dossier: d.dossier, code: d.code })), ...attributions]) {
  const cle = `${a.dossier}`;
  const vus = parDossier.get(cle) ?? new Set<string>();
  if (vus.has(a.code)) {
    console.error(`❌ ARRÊT : code « ${a.code} » en double dans « ${a.dossier} » — aucune écriture effectuée.`);
    process.exit(1);
  }
  vus.add(a.code);
  parDossier.set(cle, vus);
}

// ─── 3 bis. Homonymes : deux fiches = deux comptes auxiliaires distincts ─────
// Le script ne fusionne RIEN (deux fiches peuvent légitimement porter le même
// nom), mais un doublon de saisie éclaterait le solde du tiers sur deux comptes.
const homonymes = new Map<string, Attribution[]>();
for (const a of attributions) {
  const cle = `${a.dossier}|${a.type}|${normNom(a.nom)}`;
  homonymes.set(cle, [...(homonymes.get(cle) ?? []), a]);
}
const collisions = [...homonymes.values()].filter((g) => g.length > 1);

// ─── 4. Application ──────────────────────────────────────────────────────────

if (attributions.length === 0) {
  console.log("Aucun tiers à coder — tous les tiers ont déjà un code auxiliaire.\n");
} else if (!APPLY) {
  console.log(`🔍 SIMULATION : ${attributions.length} fiche(s) SERAIENT codée(s). Relance avec --apply pour écrire.\n`);
} else {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const nomFichier = `backup_codes_aux_${stamp}.json`;
  fs.writeFileSync(
    path.join(ROOT, nomFichier),
    JSON.stringify({ date: new Date().toISOString(), dossiers: cibles, attributions }, null, 2),
    "utf8",
  );
  console.log(`💾 Sauvegarde : ${nomFichier} (rejouable via --rollback=${nomFichier})\n`);

  let ok = 0;
  for (const a of attributions) {
    const { error } = await sb.from(a.table).update({ code_auxiliaire: a.code }).eq("id", a.id);
    if (error) console.error(`   ❌ ${a.nom} → ${a.code} : ${error.message}`);
    else { ok++; console.log(`   ✅ ${a.code}  ${a.nom}  (compte ${a.compte})`); }
  }
  console.log(`\n${ok}/${attributions.length} fiche(s) mise(s) à jour en base.`);
  if (ok !== attributions.length) { console.error("⚠️  Mises à jour partielles — voir les erreurs ci-dessus.\n"); process.exit(1); }
}

// ─── 5. Bilan ────────────────────────────────────────────────────────────────

const nb = (t: TypeTiers) => attributions.filter((a) => a.type === t).length;
console.log("─".repeat(72));
console.log(`BILAN${APPLY ? "" : "  (simulation)"}`);
console.log(`  Clients codés       : ${nb("client")}`);
console.log(`  Fournisseurs codés  : ${nb("fournisseur")}`);
console.log(`  Déjà codés (intacts): ${dejaCodes.length}`);
if (collisions.length) {
  console.log(`  ⚠️  Fiches homonymes (doublons probables à fusionner à la main) :`);
  for (const g of collisions) {
    console.log(`      • « ${g[0].nom} » (${g[0].dossier}) → ${g.map((a) => a.code).join(" + ")} : le solde du tiers`);
    console.log(`        sera réparti sur ${g.length} comptes auxiliaires distincts.`);
  }
}
if (!INCLURE_SUPPRIMES && supprimesIgnores) console.log(`  Fiches supprimées ignorées : ${supprimesIgnores} (--inclure-supprimes pour les coder)`);
console.log("");
console.log("  ⚠️  Les écritures DÉJÀ comptabilisées conservent leur compte collectif");
console.log("     (4411 / 3421). Seules les pièces enregistrées à partir de maintenant");
console.log("     porteront le compte auxiliaire du tiers.");
console.log("─".repeat(72) + "\n");
