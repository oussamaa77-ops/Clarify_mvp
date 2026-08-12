// verify_liquidation_generique.mjs — Preuve que `liquiderPeriodeTva` est
// générique, puis LIQUIDATION RÉELLE d'une période.
//
// Trois choses, dans cet ordre :
//
//   1. GÉNÉRICITÉ  — la fonction est appelée en SIMULATION sur CHAQUE dossier et
//      CHAQUE période portant de la TVA. Aucun dossier n'est privilégié : si
//      elle ne marchait que sur celui qu'on a sous la main, ce balayage le dirait.
//   2. NON-RÉGRESSION — l'ancienne règle de bouclage (tout solde 4456 ≠ 0 bloque)
//      est rejouée à côté de la nouvelle (seule une dette bloque) sur tous les
//      dossiers. Toute divergence est affichée : on attend qu'il n'y en ait que
//      là où un crédit de TVA est reporté.
//   3. LIQUIDATION — l'écriture est réellement passée sur le dossier et la
//      période demandés, puis relue.
//
// ⚠ Contrairement à verify_cycle_tva_e2e.mjs, ce script NE REVIENT PAS en
//   arrière : liquider est un acte comptable voulu. Il est idempotent (une
//   période déjà déclarée est refusée, pas doublée) et refuse d'écrire sans
//   --liquider.
//
// Lancement :
//   node --import tsx verify_liquidation_generique.mjs                  (à blanc)
//   node --import tsx verify_liquidation_generique.mjs --liquider \
//        --dossier="DIGITAL SOLUTIONS" --periode=2026-08
//
// Codes de sortie : 0 tout vert · 1 au moins un contrôle rouge.

import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { liquiderPeriodeTva, lireEtatPeriodeTva } from "./src/server/liquidation-tva.functions.ts";
import {
  COMPTE_TVA_DEDUCTIBLE, COMPTE_TVA_DUE, RACINE_COLLECTEE, RACINE_DEDUCTIBLE,
  bornesPeriode, controlerBouclagePeriode,
} from "./src/lib/liquidation-tva.ts";

const env = Object.fromEntries(
  fs.readFileSync(new URL(".env", import.meta.url), "utf8").split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
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
  auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: pf },
});

// Le dossier et la période sont des ARGUMENTS, jamais des constantes : c'est la
// même exigence que pour `src/`, appliquée à l'outillage.
const argOf = (nom, defaut) => {
  const a = process.argv.slice(2).find((x) => x.startsWith(`--${nom}=`));
  return a ? a.slice(nom.length + 3).replace(/^["']|["']$/g, "") : defaut;
};
const CIBLE_DOSSIER = argOf("dossier", "DIGITAL SOLUTIONS");
// Vide = toutes les périodes ouvertes du dossier. Pas de période par défaut :
// une constante ici rendrait le script muet sur le reste de l'exercice.
const CIBLE_PERIODE = argOf("periode", "");
const ECRIRE = process.argv.includes("--liquider");

const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const r2 = (x) => Math.round(x * 100) / 100;
const fmt = (x) => Number(x ?? 0).toLocaleString("fr-MA", { minimumFractionDigits: 2 });
let rouge = 0;
const ok = (m) => console.log(`   ✅ ${m}`);
const ko = (m) => { rouge++; console.log(`   ❌ ${m}`); };
const info = (m) => console.log(`   ·  ${m}`);
const att = (c, m) => (c ? ok(m) : ko(m));

/** ANCIENNE règle : tout solde non nul sur l'un des trois comptes bloquait. */
function bouclageAncienneRegle(lignes, periode) {
  const bornes = bornesPeriode(periode);
  if (!bornes) return null;
  const jusqua = lignes.filter((l) => String(l.date_ecriture ?? "").slice(0, 10) <= bornes.fin);
  const solde = (racine, sens) => r2(jusqua
    .filter((l) => String(l.compte_numero ?? "").startsWith(racine))
    .reduce((s, l) => s + (sens === "D" ? n(l.debit) - n(l.credit) : n(l.credit) - n(l.debit)), 0));
  const c = solde(RACINE_COLLECTEE, "C"), d = solde(RACINE_DEDUCTIBLE, "D"), u = solde(COMPTE_TVA_DUE, "C");
  return { solde: Math.abs(c) <= 0.005 && Math.abs(d) <= 0.005 && Math.abs(u) <= 0.005 };
}

const lignesDe = async (id) => (await sb.from("ecritures_comptables")
  .select("id,journal_code,compte_numero,date_ecriture,debit,credit,reference_piece")
  .eq("dossier_id", id)).data ?? [];

const empreinte = (lignes) => lignes
  .map((l) => `${l.journal_code}|${l.compte_numero}|${l.date_ecriture}|${l.debit}|${l.credit}|${l.reference_piece}`)
  .sort().join("\n");

/** Périodes mensuelles portant de la TVA — déduites des écritures, jamais listées. */
const periodesDe = (lignes) => [...new Set(lignes
  .filter((l) => new RegExp(`^(${RACINE_COLLECTEE}|${RACINE_DEDUCTIBLE}|${COMPTE_TVA_DUE})`)
    .test(String(l.compte_numero ?? "").trim()))
  .map((l) => String(l.date_ecriture ?? "").slice(0, 7))
  .filter((p) => /^\d{4}-(0[1-9]|1[0-2])$/.test(p)))].sort();

const { data: dossiers, error } = await sb.from("dossiers").select("id,nom_societe").order("nom_societe");
if (error) { console.error("❌", error.message); process.exit(1); }

// ═══ 1. GÉNÉRICITÉ — tous les dossiers, toutes les périodes, en simulation ════
console.log("\n═══ 1. GÉNÉRICITÉ — simulation sur tous les dossiers ═══\n");
const avant = new Map();
let simulees = 0, dossiersVus = 0;

for (const d of dossiers ?? []) {
  const lignes = await lignesDe(d.id);
  avant.set(d.id, { empreinte: empreinte(lignes), nom: d.nom_societe });
  const periodes = periodesDe(lignes);
  if (!periodes.length) continue;
  dossiersVus++;
  const rendu = [];
  for (const p of periodes) {
    // MÊME appel générique pour tout le monde — deux arguments, rien d'autre.
    const r = await liquiderPeriodeTva(d.id, p, { client: sb, simulation: true });
    simulees++;
    if (!r.ok && !/déjà déclarée/i.test(r.raison ?? "")) { ko(`${d.nom_societe} ${p} — ${r.raison}`); continue; }
    rendu.push(`${p}: ${r.liquidation?.neant ? "néant" : `${fmt(r.montant)} ${r.dette ? "dû" : "crédit"}`}`);
  }
  console.log(`   ✅ ${d.nom_societe}`);
  info(`   ${rendu.join(" · ")}`);
}
att(simulees > 0 && dossiersVus > 1,
  `${simulees} liquidation(s) simulées sur ${dossiersVus} dossier(s) — aucun dossier privilégié`);

// La simulation ne doit RIEN avoir écrit.
for (const d of dossiers ?? []) {
  const e = empreinte(await lignesDe(d.id));
  if (e !== avant.get(d.id).empreinte) ko(`${d.nom_societe} — la SIMULATION a modifié le grand livre`);
}
ok("aucune écriture produite par les simulations");

// Garde-fous d'arguments — la généricité n'est pas la crédulité.
{
  const mauvais = await liquiderPeriodeTva("DIGITAL SOLUTIONS MAROC", CIBLE_PERIODE, { client: sb });
  att(!mauvais.ok && /dossier invalide/i.test(mauvais.raison ?? ""),
    `un NOM passé à la place d'un UUID est refusé — « ${mauvais.raison} »`);
  const perMauvaise = await liquiderPeriodeTva(dossiers[0].id, "août 2026", { client: sb });
  att(!perMauvaise.ok && /illisible/i.test(perMauvaise.raison ?? ""),
    `une période mal formée est refusée — « ${perMauvaise.raison} »`);
}

// ═══ 2. NON-RÉGRESSION de la règle de bouclage ════════════════════════════════
console.log("\n═══ 2. NON-RÉGRESSION — ancienne règle vs nouvelle ═══\n");
{
  let compares = 0, divergences = 0, injustifiees = 0;
  for (const d of dossiers ?? []) {
    const lignes = await lignesDe(d.id);
    for (const p of periodesDe(lignes)) {
      const neuf = controlerBouclagePeriode(lignes, p);
      const ancien = bouclageAncienneRegle(lignes, p);
      compares++;
      if (neuf.solde !== ancien.solde) {
        divergences++;
        console.log(`   ⚠️  ${d.nom_societe} ${p} : ancien=${ancien.solde} → nouveau=${neuf.solde}`
          + ` (crédit reporté ${fmt(neuf.creditReporte)} MAD)`);
        if (neuf.creditReporte <= 0.005) {
          injustifiees++;
          ko(`   divergence SANS crédit reporté — la nouvelle règle relâche à tort`);
        }
      }
    }
  }
  ok(`${compares} période(s) comparées sur ${(dossiers ?? []).length} dossier(s)`);
  // Une divergence n'est PAS une régression tant qu'un crédit de TVA reporté
  // l'explique : c'est précisément ce que la nouvelle règle vient reconnaître.
  // Seule une divergence sans crédit au débit du 4456 serait un relâchement.
  att(injustifiees === 0, divergences === 0
    ? "aucune divergence : la règle ne change rien à l'état actuel des dossiers"
    : `${divergences} divergence(s), toutes justifiées par un crédit de TVA reporté`);
}


// ═══ 3. LIQUIDATION RÉELLE ════════════════════════════════════════════════════
// `--dossier=` accepte plusieurs noms séparés par des virgules, et `--periode=`
// peut être omis : sans elle, TOUTES les périodes non déclarées et non néant du
// dossier sont liquidées, dans l'ordre CHRONOLOGIQUE. L'ordre n'a pas d'effet
// sur les montants (chaque OD ne lit que sa propre période), mais une compta se
// déroule dans le temps et un journal qui remonte le temps se relit mal.
const NOMS = CIBLE_DOSSIER.split(",").map((s) => s.trim()).filter(Boolean);
console.log(`\n═══ 3. LIQUIDATION — « ${NOMS.join(" », « ")} »`
  + ` · ${CIBLE_PERIODE ? CIBLE_PERIODE : "toutes les périodes ouvertes"} ═══\n`);

const cibles = (dossiers ?? []).filter((d) =>
  NOMS.some((nom) => d.nom_societe.toLowerCase().includes(nom.toLowerCase())));

if (!cibles.length) {
  ko(`aucun dossier ne correspond à « ${NOMS.join(", ")} »`);
} else {
  for (const d of cibles) {
    console.log(`\n📁 ${d.nom_societe}`);
    const lignesAvant = await lignesDe(d.id);

    // Périodes à traiter : celle demandée, ou toutes celles qui portent une TVA
    // à liquider. Une période « néant » ne produit aucune écriture — l'annoncer
    // comme liquidée serait faux, on la saute en le disant.
    let periodes = CIBLE_PERIODE ? [CIBLE_PERIODE] : periodesDe(lignesAvant);
    const aTraiter = [];
    for (const p of periodes) {
      const sim = await liquiderPeriodeTva(d.id, p, { client: sb, simulation: true });
      if (sim.liquidation?.neant) { info(`${p} — néant, aucune écriture à produire`); continue; }
      if (!sim.ok && /déjà déclarée/i.test(sim.raison ?? "")) { info(`${p} — déjà déclarée`); continue; }
      if (!sim.ok) { ko(`${p} — ${sim.raison}`); continue; }
      aTraiter.push({ periode: p, montant: sim.montant, dette: sim.dette });
    }
    if (!aTraiter.length) info("aucune période ouverte — tout est déjà liquidé");
    if (!ECRIRE) {
      for (const t of aTraiter) {
        info(`SIMULATION ${t.periode} : ${fmt(t.montant)} MAD de ${t.dette ? "TVA due" : "crédit reportable"}`);
      }
    }

    for (const t of ECRIRE ? aTraiter : []) {
      const r = await liquiderPeriodeTva(d.id, t.periode, { client: sb });
      if (!r.ok) { ko(`${t.periode} — liquidation refusée : ${r.raison}`); continue; }

      const apres = await lireEtatPeriodeTva(sb, { dossierId: d.id, periode: t.periode });
      const lignes = await lignesDe(d.id);
      const fin = bornesPeriode(t.periode).fin;
      const soldeA = (c) => r2(lignes
        .filter((l) => String(l.compte_numero ?? "").trim() === c && String(l.date_ecriture ?? "") <= fin)
        .reduce((s, acc) => s + n(acc.debit) - n(acc.credit), 0));

      const od = lignes.filter((l) => String(l.reference_piece ?? "") === `DECL-TVA-${t.periode}`);
      const ecartOd = r2(od.reduce((s, l) => s + n(l.debit) - n(l.credit), 0));

      // Ce que la LIQUIDATION doit garantir : les comptes de la période sont
      // soldés et l'OD est équilibrée. Le BOUCLAGE, lui, dépend d'une étape
      // suivante — le prélèvement DGI. Exiger `bouclee` ici confondrait « mal
      // liquidée » et « liquidée, dette pas encore prélevée ».
      const resteDu = apres.resteAPayer > 0.005;
      const sain = apres.declaree
        && Math.abs(soldeA(COMPTE_TVA_DEDUCTIBLE)) < 0.005
        && Math.abs(ecartOd) < 0.005
        && (apres.bouclee || resteDu);

      att(sain, `${t.periode} — ${fmt(r.montant)} MAD de ${r.dette ? "TVA due" : "crédit reportable"}`
        + ` · ${r.lignesInserees} ligne(s) · 34552 = ${fmt(soldeA(COMPTE_TVA_DEDUCTIBLE))}`
        + ` · ${apres.bouclee ? "bouclée" : `reste ${fmt(apres.resteAPayer)} MAD à prélever`}`
        + (Math.abs(ecartOd) < 0.005 ? " · OD équilibrée" : ` · OD DÉSÉQUILIBRÉE ${fmt(ecartOd)}`));
      if (apres.creditReporte > 0.005) {
        info(`     crédit de TVA reporté : ${fmt(apres.creditReporte)} MAD au débit du ${COMPTE_TVA_DUE}`);
      }
    }

    // Le dossier reste équilibré une fois toutes ses périodes passées.
    const fin = await lignesDe(d.id);
    const ecartGl = r2(fin.reduce((s, l) => s + n(l.debit) - n(l.credit), 0));
    att(Math.abs(ecartGl) < 0.005, `grand livre équilibré — écart ${fmt(ecartGl)} MAD sur ${fin.length} ligne(s)`);

    // ÉTAT FINAL — relu, pas déduit de ce qu'on vient d'écrire. Il se relit à
    // l'identique quand tout est déjà déclaré : c'est le rapport qui compte.
    const derniere = periodesDe(fin).at(-1);
    if (derniere) {
      const e = await lireEtatPeriodeTva(sb, { dossierId: d.id, periode: derniere });
      const position = e.resteAPayer > 0.005
        ? `${fmt(e.resteAPayer)} MAD de TVA DUE à prélever par la DGI`
        : e.creditReporte > 0.005
          ? `${fmt(e.creditReporte)} MAD de crédit de TVA reportable`
          : "compte 4456 soldé";
      info(`position cumulée au ${bornesPeriode(derniere).fin} : ${position}`);
    }
  }

  // ═══ 4. Les dossiers NON visés n'ont pas bougé d'un centime ═══
  if (ECRIRE) {
    console.log("\n═══ 4. ISOLEMENT — les dossiers non visés ═══\n");
    const visees = new Set(cibles.map((d) => d.id));
    let touches = 0;
    for (const autre of dossiers ?? []) {
      if (visees.has(autre.id)) continue;
      const e = empreinte(await lignesDe(autre.id));
      if (e === avant.get(autre.id).empreinte) ok(`${autre.nom_societe} — inchangé`);
      else { touches++; ko(`${autre.nom_societe} — MODIFIÉ par la liquidation`); }
    }
    att(touches === 0, "la liquidation n'a touché que les dossiers visés");
  } else {
    console.log("\n   Relancez avec --liquider pour passer réellement les écritures.");
  }
}

console.log("\n" + "─".repeat(72));
console.log(rouge === 0 ? "✅ TOUS LES CONTRÔLES SONT VERTS\n" : `❌ ${rouge} contrôle(s) en échec\n`);
process.exit(rouge === 0 ? 0 : 1);
