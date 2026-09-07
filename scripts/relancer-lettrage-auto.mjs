/**
 * relancer-lettrage-auto.mjs — repose les lettrages et les BASCULES DE TVA.
 *
 * Compagnon obligé de `reconstruire_compta_dossiers.mjs`. La reconstruction
 * purge les OD de bascule et régénère les lignes de facture ; elle ne recrée PAS
 * les bascules, et c'est délibéré : sous le régime des encaissements, la TVA ne
 * devient exigible qu'au RÈGLEMENT. Les recréer depuis la facture inventerait de
 * la TVA due sans encaissement en face.
 *
 * C'est donc le lettrage qui les repose : apparier une facture avec son règlement
 * déclenche `basculerTvaSurReglement` dans la même passe.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   node --import tsx scripts/relancer-lettrage-auto.mjs            # DRY-RUN
 *   node --import tsx scripts/relancer-lettrage-auto.mjs --apply
 *   node --import tsx scripts/relancer-lettrage-auto.mjs --dossier="<nom|uuid>"
 *
 * ─── Pourquoi le CŒUR et non la server function ──────────────────────────────
 * On appelle `executerLettrageAuto`, pas `lettrerAutomatiquement`. Une server
 * function TanStack ne rend rien à un appelant situé hors de son runtime : elle
 * s'exécuterait, mais le script afficherait « 0 lettrage » et on la croirait
 * sans effet (cf. mémoire « perf-pipeline-ia »).
 *
 * ─── Sûreté ──────────────────────────────────────────────────────────────────
 * Le lettrage n'apparie QUE des groupes équilibrés, sur un même compte de tiers
 * (`controlerEquilibre`) : il ne peut pas solder la dette d'un tiers avec la
 * créance d'un autre. Et il est réversible — `executerDelettrage` retire le code
 * et supprime la bascule qu'il a posée.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { executerLettrageAuto } from "../src/server/lettrage-compta.functions.ts";
import { synchroniserApresLettrage } from "../src/server/factures-gl.functions.ts";
import { apparierAutomatiquement, regrouperParCompte, sensDuCompte } from "../src/services/lettrage.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const flag = (nom) => {
  const hit = argv.find((a) => a === `--${nom}` || a.startsWith(`--${nom}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf("=");
  return eq === -1 ? "" : hit.slice(eq + 1).replace(/^["']|["']$/g, "");
};
const APPLY = flag("apply") !== undefined;
const CIBLE = flag("dossier") || null;

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env"), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);

let PROXY_DIRECT = false;
async function proxyFetch(input, init) {
  const direct = async () => {
    const { fetch: uf, Agent } = await import("undici");
    return uf(String(input), { ...init, dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) });
  };
  if (PROXY_DIRECT) return direct();
  try { return await fetch(String(input), init); }
  catch { PROXY_DIRECT = true; return direct(); }
}
const sb = createClient(env.SUPABASE_URL || env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  global: { fetch: proxyFetch }, auth: { persistSession: false, autoRefreshToken: false },
});

console.log(`\n${APPLY ? "🔧 APPLICATION" : "🔍 SIMULATION (dry-run)"} — lettrage automatique + bascules de TVA\n`);

let q = sb.from("dossiers").select("id,nom_societe");
if (CIBLE) q = /^[0-9a-f-]{36}$/i.test(CIBLE) ? q.eq("id", CIBLE) : q.ilike("nom_societe", `%${CIBLE}%`);
const { data: dossiers, error } = await q;
if (error) { console.error(`❌ ${error.message}`); process.exit(1); }

let totalLettres = 0, totalPaires = 0;

for (const d of dossiers ?? []) {
  if (!APPLY) {
    // Simulation : on rejoue l'appariement SANS écrire, avec le même moteur pur
    // que celui qu'emploiera l'exécution. Ce que le dry-run annonce est donc ce
    // que l'application posera, et non une approximation.
    const { data: ecr } = await sb.from("ecritures_comptables")
      .select("id,compte_numero,libelle,debit,credit,date_ecriture,reference_piece,journal_code,lettrage_code")
      .eq("dossier_id", d.id);
    const tiers = (ecr ?? []).filter((l) => sensDuCompte(l.compte_numero) !== null);
    let paires = 0;
    for (const poste of regrouperParCompte(tiers)) paires += apparierAutomatiquement(poste.lignes).length;
    if (paires) {
      console.log(`── ${d.nom_societe} : ${paires} appariement(s) possible(s)`);
      totalPaires += paires;
    }
    continue;
  }

  const r = await executerLettrageAuto(sb, { dossierId: d.id });
  if (!r.ok) { console.log(`── ${d.nom_societe} : ❌ ${r.reason}`); continue; }
  if (r.lettres > 0) {
    console.log(`── ${d.nom_societe} : ${r.lettres} lettrage(s) posé(s) → ${r.codes.join(", ")}`);
    // Réaligne factures.montant_paye / statut_paiement sur le grand livre, comme
    // le fait la porte d'entrée HTTP après un lettrage.
    await synchroniserApresLettrage(sb, d.id);
    totalLettres += r.lettres;
  }
}

console.log(`\n${"─".repeat(70)}`);
if (APPLY) {
  console.log(`${totalLettres} lettrage(s) posé(s) — autant de bascules de TVA reposées.`);
} else {
  console.log(`${totalPaires} appariement(s) possible(s). Ajoutez --apply pour les poser.`);
}
