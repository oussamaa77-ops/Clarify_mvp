// verify_tva_tracabilite.mjs — LECTURE SEULE. Contrôle sur la base RÉELLE que la
// migration 20260809130000 est bien APPLIQUÉE et EXPLOITABLE :
//   1. `ecritures_comptables.paiement_id` lisible + clé étrangère vers `paiements`
//      réellement déclarée (sinon PostgREST refuse la jointure imbriquée) ;
//   2. `ecritures_comptables.pointe / pointe_le` lisibles ;
//   3. `transactions_bancaires.pointe / quittance_path / quittance_nom` lisibles ;
//   4. bucket privé `quittances-tva` présent et NON public ;
//   5. `lireEtatPeriodeTva` répond `tracable: true` sur les données réelles —
//      c'est-à-dire SANS retomber sur le jeu de colonnes historique ;
//   6. état du cycle TVA période par période sur le dossier visé.
//
// Lancement :  node --import tsx verify_tva_tracabilite.mjs
//              node --import tsx verify_tva_tracabilite.mjs --dossier="DIGITAL"
//
// Codes de sortie : 0 tout vert · 1 contrôle rouge · 3 migration non appliquée.

import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { lireEtatPeriodeTva } from "./src/server/liquidation-tva.functions.ts";
import { COMPTE_TVA_DUE, referenceDeclaration } from "./src/lib/liquidation-tva.ts";

const env = Object.fromEntries(
  fs.readFileSync(new URL(".env", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);
let DIRECT = false;
async function pf(input, init) {
  const direct = async () => {
    const { fetch: uf, Agent } = await import("undici");
    return uf(String(input), { ...init, dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) });
  };
  if (DIRECT) return direct();
  try { return await fetch(String(input), init); } catch { DIRECT = true; return direct(); }
}
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: pf },
});

const arg = process.argv.slice(2).find((a) => a.startsWith("--dossier="));
const DOSSIER = arg ? arg.slice(10).replace(/^["']|["']$/g, "") : "DIGITAL";

const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const r2 = (x) => Math.round(x * 100) / 100;
const fmt = (x) => Number(x).toLocaleString("fr-MA", { minimumFractionDigits: 2 });

let rouge = 0, absente = 0;
const ok = (m) => console.log(`   ✅ ${m}`);
const ko = (m) => { rouge++; console.log(`   ❌ ${m}`); };
const manque = (m) => { absente++; console.log(`   ⛔ ${m}`); };
const info = (m) => console.log(`   ·  ${m}`);

/** Une colonne absente rend un 42703 ; on veut le distinguer d'une vraie panne. */
const colonneAbsente = (e) =>
  e?.code === "42703" || /column .* does not exist/i.test(String(e?.message ?? ""));

// ═══ 1. Colonnes de traçabilité, une par une ══════════════════════════════════
// Une par une, et pas en bloc : un select groupé qui échoue ne dit pas LAQUELLE
// des colonnes manque, et c'est précisément ce qu'on vient vérifier.
console.log("\n═══ MIGRATION 20260809130000 — COLONNES ═══\n");

async function sonder(table, colonne) {
  const { error } = await sb.from(table).select(colonne).limit(1);
  if (!error) { ok(`${table}.${colonne} — lisible`); return true; }
  if (colonneAbsente(error)) { manque(`${table}.${colonne} — ABSENTE (migration non appliquée)`); return false; }
  ko(`${table}.${colonne} — ${error.message}`);
  return false;
}

const colonnes = [
  ["ecritures_comptables", "paiement_id"],
  ["ecritures_comptables", "pointe"],
  ["ecritures_comptables", "pointe_le"],
  ["transactions_bancaires", "pointe"],
  ["transactions_bancaires", "quittance_path"],
  ["transactions_bancaires", "quittance_nom"],
];
const presentes = [];
for (const [t, c] of colonnes) presentes.push(await sonder(t, c));

// ═══ 2. La clé étrangère existe-t-elle VRAIMENT ? ═════════════════════════════
// Ajouter la colonne sans la contrainte laisserait `paiement_id` sans garantie
// d'intégrité — un uuid libre. PostgREST ne sait imbriquer `paiements(id)` que
// s'il trouve une FK déclarée : la jointure est donc le test de la contrainte.
console.log("\n═══ CLÉ ÉTRANGÈRE paiement_id → paiements ═══\n");
{
  const { error } = await sb.from("ecritures_comptables").select("id,paiements(id)").limit(1);
  if (!error) ok("jointure ecritures_comptables → paiements résolue (contrainte FK déclarée)");
  else if (/relationship|schema cache|foreign key/i.test(String(error.message))) {
    ko(`FK ecritures_comptables_paiement_id_fkey INTROUVABLE — ${error.message}`);
  } else ko(`jointure refusée — ${error.message}`);
}

// ═══ 3. Bucket privé des quittances ═══════════════════════════════════════════
console.log("\n═══ BUCKET quittances-tva ═══\n");
{
  const { data: buckets, error } = await sb.storage.listBuckets();
  if (error) {
    ko(`impossible de lister les buckets — ${error.message}`);
  } else {
    const b = (buckets ?? []).find((x) => x.id === "quittances-tva" || x.name === "quittances-tva");
    if (!b) manque("bucket « quittances-tva » ABSENT");
    else if (b.public) ko("bucket « quittances-tva » présent mais PUBLIC — il nomme la société et le montant de sa TVA");
    else {
      ok("bucket « quittances-tva » présent et privé");
      // Exploitable = on sait y lister et en signer une URL, pas seulement qu'il existe.
      const { error: eList } = await sb.storage.from("quittances-tva").list("", { limit: 1 });
      if (eList) ko(`bucket non exploitable en lecture — ${eList.message}`);
      else ok("bucket accessible en lecture (list)");
    }
  }
}

// ═══ 4. Le serveur voit-il la base comme traçable ? ═══════════════════════════
console.log(`\n═══ ÉTAT RÉEL — dossier « ${DOSSIER} » ═══`);

const { data: dossiers, error: eDos } = await sb
  .from("dossiers").select("id,nom_societe").ilike("nom_societe", `%${DOSSIER}%`);
if (eDos) { console.error("❌", eDos.message); process.exit(1); }
if (!dossiers?.length) { console.error(`❌ aucun dossier ne correspond à « ${DOSSIER} »`); process.exit(1); }

for (const d of dossiers) {
  console.log(`\n📁 ${d.nom_societe}`);

  // Périodes réellement portées par la compta : on ne teste pas des mois vides.
  const { data: lignes, error: eLig } = await sb.from("ecritures_comptables")
    .select("compte_numero,date_ecriture,debit,credit,reference_piece,pointe,pointe_le,transaction_id,paiement_id")
    .eq("dossier_id", d.id);
  if (eLig) {
    ko(`lecture des écritures avec colonnes de traçabilité — ${eLig.message}`);
    continue;
  }
  ok(`${(lignes ?? []).length} écriture(s) lues AVEC pointe/pointe_le/paiement_id (aucun repli historique)`);

  const periodes = [...new Set((lignes ?? [])
    .filter((l) => /^(4455|3455|4456)/.test(String(l.compte_numero ?? "").trim()))
    .map((l) => String(l.date_ecriture ?? "").slice(0, 7))
    .filter((p) => /^\d{4}-\d{2}$/.test(p)))].sort();

  if (!periodes.length) { info("aucune écriture de TVA — rien à liquider"); continue; }
  info(`périodes portant de la TVA : ${periodes.join(", ")}`);

  for (const periode of periodes) {
    const etat = await lireEtatPeriodeTva(sb, { dossierId: d.id, periode });
    if (!etat.ok) { ko(`${periode} — ${etat.raison}`); continue; }
    if (!etat.tracable) {
      ko(`${periode} — REPLI HISTORIQUE : le serveur n'a pas vu les colonnes de traçabilité`);
      continue;
    }
    const liq = etat.liquidation;
    const nature = liq?.neant ? "néant" : liq?.dette ? "dette" : "crédit reportable";
    console.log(
      `   ✅ ${periode} · ${nature} ${fmt(liq?.montant ?? 0)} MAD`
      + ` · déclarée=${etat.declaree ? "oui" : "non"}`
      + ` · reste 4456=${fmt(etat.resteAPayer)}`
      + ` · bouclée=${etat.bouclee ? "oui" : "non"}`
      + ` · pointé=${etat.pointe ? "oui" : "non"}`,
    );
    if (etat.transactionId) info(`     ligne de banque rapprochée : ${etat.transactionId}`);
    if (etat.quittancePath) info(`     quittance tracée : ${etat.quittanceNom ?? etat.quittancePath}`);
    if (!etat.bouclee && etat.detailBouclage) info(`     ${etat.detailBouclage}`);

    // Le bouton de pointage n'est cliquable QUE si ces conditions se lisent en
    // base : on les rejoue ici pour que le rapport dise pourquoi il est grisé.
    if (etat.declaree && !etat.pointe) {
      const bloquant = !liq?.dette
        ? "crédit reportable — aucun prélèvement DGI à pointer"
        : etat.resteAPayer > 0.005
          ? `4456 non soldé (${fmt(etat.resteAPayer)} MAD) — enregistrer le prélèvement DGI d'abord`
          : null;
      info(bloquant ? `     pointage GRISÉ : ${bloquant}` : "     pointage ACTIF : cliquable dès maintenant");
    }
  }

  // Traçabilité des OD de TVA vers leur règlement d'origine.
  const odTva = (lignes ?? []).filter((l) =>
    String(l.reference_piece ?? "").startsWith("DECL-TVA-"));
  const tracees = odTva.filter((l) => l.paiement_id);
  info(`${odTva.length} ligne(s) d'OD de déclaration · ${tracees.length} rattachée(s) à un paiement via paiement_id`);
}

console.log("\n" + "─".repeat(72));
if (absente) {
  console.log(`⛔ ${absente} objet(s) de la migration 20260809130000 ABSENT(S) — appliquez le SQL dans Supabase\n`);
  process.exit(3);
}
console.log(rouge === 0 ? "✅ TOUS LES CONTRÔLES SONT VERTS\n" : `❌ ${rouge} contrôle(s) en échec\n`);
process.exit(rouge === 0 ? 0 : 1);
