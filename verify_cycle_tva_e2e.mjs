// verify_cycle_tva_e2e.mjs — BOUT EN BOUT sur la base RÉELLE, puis RESTAURATION.
//
// Ce script ÉCRIT. Il est le seul moyen de répondre à « le flux marche-t-il sur
// les vraies données ? » : les tests unitaires bouchonnent Supabase, ils ne
// prouvent rien de la base, et l'inverse est vrai des scripts en lecture seule.
//
// ─── Pourquoi une période bac à sable, et pas la vraie période ───────────────
// DIGITAL SOLUTIONS est au régime des ENCAISSEMENTS : sa TVA collectée est
// reclassée en 4458 tant que le client n'a pas payé, et aucune de ses périodes
// réelles ne dégage de dette. Le chemin « dette → prélèvement → pointage » ne
// peut donc PAS être exercé sur les données existantes. On l'exerce sur une
// période vide (2026-12) du vrai dossier, avec de vraies écritures, la vraie
// server function et le vrai bucket — puis on efface TOUT.
//
// Deux garde-fous, parce qu'écrire dans une compta réelle ne se rattrape pas :
//   • REFUS de démarrer si la période bac à sable porte déjà quoi que ce soit ;
//   • empreinte du grand livre AVANT / APRÈS : le script échoue s'il n'a pas
//     rendu le dossier à l'identique, et affiche alors quoi supprimer à la main.
//
// Lancement :  node --import tsx verify_cycle_tva_e2e.mjs
// Codes de sortie : 0 tout vert · 1 échec · 2 RÉSIDU EN BASE (intervention).

import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  executerDeclarationTva, executerEnregistrementQuittance, executerPaiementDgi,
  executerPointageTva, lireEtatPeriodeTva,
} from "./src/server/liquidation-tva.functions.ts";
import { controlerBouclagePeriode, referenceDeclaration } from "./src/lib/liquidation-tva.ts";
import { actionsCycleTva, badgeCycleTva, etapeCycleTva } from "./src/lib/cycle-tva.ts";

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

const PERIODE = "2026-12";
const REF_SEED = "E2E-TVA-SANDBOX";
const REF_DECL = referenceDeclaration(PERIODE);
const BUCKET = "quittances-tva";

const fmt = (x) => Number(x ?? 0).toLocaleString("fr-MA", { minimumFractionDigits: 2 });
let rouge = 0;
const ok = (m) => console.log(`   ✅ ${m}`);
const ko = (m) => { rouge++; console.log(`   ❌ ${m}`); };
const info = (m) => console.log(`   ·  ${m}`);
const attendu = (cond, m) => (cond ? ok(m) : ko(m));

// ── Dossier ──────────────────────────────────────────────────────────────────
const { data: dos, error: eDos } = await sb.from("dossiers")
  .select("id,nom_societe").ilike("nom_societe", "%DIGITAL SOLUTIONS%");
if (eDos || !dos?.length) { console.error("❌ dossier introuvable :", eDos?.message); process.exit(1); }
const dossierId = dos[0].id;
console.log(`\n═══ CYCLE TVA BOUT EN BOUT — ${dos[0].nom_societe} ═══`);
console.log(`    période bac à sable ${PERIODE} · dossier ${dossierId}\n`);

// ── Empreinte AVANT ──────────────────────────────────────────────────────────
const empreinte = async () => {
  const { data } = await sb.from("ecritures_comptables")
    .select("id,journal_code,compte_numero,date_ecriture,debit,credit,reference_piece,pointe")
    .eq("dossier_id", dossierId);
  return (data ?? []).map((l) =>
    `${l.journal_code}|${l.compte_numero}|${l.date_ecriture}|${l.debit}|${l.credit}|${l.reference_piece}|${l.pointe}`
  ).sort().join("\n");
};
const AVANT = await empreinte();
info(`empreinte initiale : ${AVANT.split("\n").filter(Boolean).length} écriture(s)`);

// ── Garde-fou : la période bac à sable doit être VIERGE ──────────────────────
{
  const { data } = await sb.from("ecritures_comptables").select("id")
    .eq("dossier_id", dossierId)
    .or(`reference_piece.eq.${REF_DECL},reference_piece.like.${REF_SEED}%`);
  if ((data ?? []).length) {
    console.error(`❌ la période ${PERIODE} porte déjà ${data.length} écriture(s) — résidu d'un run précédent.`);
    console.error(`   Supprimez les références « ${REF_DECL} » et « ${REF_SEED}* » avant de relancer.`);
    process.exit(2);
  }
  const { data: dec } = await sb.from("ecritures_comptables").select("id")
    .eq("dossier_id", dossierId).gte("date_ecriture", "2026-12-01").lte("date_ecriture", "2026-12-31");
  if ((dec ?? []).length) {
    console.error(`❌ décembre 2026 porte ${dec.length} écriture(s) réelle(s) — choisissez une autre période.`);
    process.exit(2);
  }
  ok(`période ${PERIODE} vierge — sûr d'y écrire`);
}

// ── Report de TVA préexistant ────────────────────────────────────────────────
// `controlerBouclagePeriode` est CUMULATIF : il solde les comptes de TVA depuis
// l'origine jusqu'à la fin de la période, pas sur la seule période. Toute TVA
// antérieure jamais déclarée se reporte donc et empêchera le bouclage — ce qui
// est correct, mais n'a rien à voir avec le cycle qu'on teste. On mesure ce
// report AVANT, pour pouvoir affirmer ensuite que le cycle n'a rien laissé.
const REPORT = await (async () => {
  const { data } = await sb.from("ecritures_comptables")
    .select("compte_numero,date_ecriture,debit,credit").eq("dossier_id", dossierId);
  return controlerBouclagePeriode(data ?? [], PERIODE);
})();
if (REPORT?.solde) info("aucun report de TVA antérieur — le bouclage doit tomber à zéro");
else info(`report de TVA antérieur au ${PERIODE} : ${REPORT?.raison}`);

let txTemp = null;

try {
  // ── 1. Amorce : de vraies écritures de TVA, pour créer une vraie dette ─────
  // Collectée 2 000 · déductible 100 → dette attendue 1 900,00 MAD.
  const seed = [
    { journal_code: "VTE", compte_numero: "34210001", debit: 12000, credit: 0, libelle: "E2E vente" },
    { journal_code: "VTE", compte_numero: "7124", debit: 0, credit: 10000, libelle: "E2E vente" },
    { journal_code: "VTE", compte_numero: "44551", debit: 0, credit: 2000, libelle: "E2E TVA collectée" },
    { journal_code: "ACH", compte_numero: "61254", debit: 500, credit: 0, libelle: "E2E achat" },
    { journal_code: "ACH", compte_numero: "34552", debit: 100, credit: 0, libelle: "E2E TVA déductible" },
    { journal_code: "ACH", compte_numero: "44110001", debit: 0, credit: 600, libelle: "E2E achat" },
  ].map((l) => ({ ...l, dossier_id: dossierId, date_ecriture: "2026-12-15", reference_piece: REF_SEED, valide: true }));
  const { error: eSeed } = await sb.from("ecritures_comptables").insert(seed);
  if (eSeed) throw new Error("amorce refusée : " + eSeed.message);
  ok(`amorce : ${seed.length} écriture(s) de TVA insérées (collectée 2 000 · déductible 100)`);

  // Ligne de banque du prélèvement : c'est elle qui porte pointe + quittance_path.
  const { data: cb } = await sb.from("comptes_bancaires").select("id").eq("dossier_id", dossierId).limit(1);
  const { data: txIns, error: eTx } = await sb.from("transactions_bancaires").insert({
    dossier_id: dossierId, compte_id: cb?.[0]?.id ?? null, date_operation: "2026-12-31",
    libelle: "E2E PRELEVEMENT DGI TVA", type: "debit", montant: 1900, statut: "ouvert",
  }).select("id").maybeSingle();
  if (eTx) info(`ligne de banque non créée (${eTx.message}) — le volet quittance/base sera testé en mode « bucket seul »`);
  else { txTemp = txIns.id; ok(`ligne de banque temporaire créée : ${txTemp}`); }

  // ── 2. État initial : la migration est-elle vue par la server function ? ───
  console.log("\n── 2. Lecture de la période ──");
  let etat = await lireEtatPeriodeTva(sb, { dossierId, periode: PERIODE });
  attendu(etat.ok, `période lue — ${etat.periode}`);
  attendu(etat.tracable === true, "tracable = true (colonnes de traçabilité lues, AUCUN repli historique)");
  attendu(etat.liquidation?.dette === true && Math.abs(etat.liquidation.montant - 1900) < 0.005,
    `dette de TVA calculée = ${fmt(etat.liquidation?.montant)} MAD (attendu 1 900,00)`);
  attendu(etat.declaree === false, "période non encore déclarée");
  info(`étape=${etapeCycleTva(etat)} · badge=« ${badgeCycleTva(etat).label} »`);

  // Le bouton de pointage AVANT déclaration : grisé, avec la bonne raison.
  let act = actionsCycleTva(etat);
  attendu(act.declarer && !act.pointer, "bouton « Déclarer » actif · pointage grisé (rien n'est déclaré)");
  attendu(act.raisonPointageIndisponible === "Générez d'abord l'OD de liquidation.",
    `raison affichée : « ${act.raisonPointageIndisponible} »`);

  // ── 3. Liquidation ─────────────────────────────────────────────────────────
  console.log("\n── 3. Liquidation (OD de déclaration) ──");
  const decl = await executerDeclarationTva(sb, { dossierId, periode: PERIODE });
  attendu(decl.ok && decl.lignesInserees === 3, `OD ${REF_DECL} générée — ${decl.lignesInserees} ligne(s), ${fmt(decl.montant)} MAD de TVA due`);
  const rejeu = await executerDeclarationTva(sb, { dossierId, periode: PERIODE });
  attendu(!rejeu.ok && /déjà déclarée/i.test(rejeu.raison ?? ""), `IDEMPOTENCE : redéclarer est refusé — « ${rejeu.raison?.slice(0, 60)}… »`);

  etat = await lireEtatPeriodeTva(sb, { dossierId, periode: PERIODE });
  attendu(etat.declaree && Math.abs(etat.resteAPayer - 1900) < 0.005,
    `compte 4456 chargé : reste à payer ${fmt(etat.resteAPayer)} MAD`);
  info(`étape=${etapeCycleTva(etat)} · badge=« ${badgeCycleTva(etat).label} »`);

  // ── 4. Le pointage refuse une dette ouverte ────────────────────────────────
  console.log("\n── 4. Pointage sur dette ouverte (doit être REFUSÉ) ──");
  act = actionsCycleTva(etat);
  attendu(!act.pointer, "interrupteur de pointage GRISÉ tant que le 4456 n'est pas soldé");
  attendu(/4456 n'est pas soldé/.test(act.raisonPointageIndisponible ?? ""),
    `raison affichée : « ${act.raisonPointageIndisponible} »`);
  const refus = await executerPointageTva(sb, { dossierId, periode: PERIODE, pointe: true });
  attendu(!refus.ok && /pas soldé/i.test(refus.raison ?? ""), "le SERVEUR refuse aussi — l'écran n'est pas le seul garde-fou");
  attendu(!/migration/i.test(refus.raison ?? ""), "le refus est MÉTIER, pas « migration absente »");

  // ── 5. Prélèvement DGI ─────────────────────────────────────────────────────
  console.log("\n── 5. Prélèvement DGI ──");
  const pay = await executerPaiementDgi(sb, {
    dossierId, periode: PERIODE, date: "2026-12-31", montant: null,
    compteBanque: "5141", transactionId: txTemp,
  });
  attendu(pay.ok && Math.abs(pay.resteApres) < 0.005,
    `D 4456 / C 5141 de ${fmt(pay.montant)} MAD — reste ${fmt(pay.resteApres)} MAD`);
  // Payer une dette déjà éteinte rendrait le 4456 DÉBITEUR — refus attendu.
  const trop = await executerPaiementDgi(sb, { dossierId, periode: PERIODE, date: "2026-12-31", montant: 500 });
  attendu(!trop.ok && /supérieur à la dette/i.test(trop.raison ?? ""),
    `sur-paiement REFUSÉ — « ${trop.raison} »`);

  // ── 6. Quittance SIMPL-TVA ─────────────────────────────────────────────────
  console.log("\n── 6. Quittance SIMPL-TVA (bucket privé + trace en base) ──");
  const chemin = `${dossierId}/${REF_DECL}.pdf`;
  const pdf = new Blob([`%PDF-1.4\n% quittance E2E ${new Date().toISOString()}\n%%EOF\n`], { type: "application/pdf" });
  const { error: eUp } = await sb.storage.from(BUCKET).upload(chemin, pdf, { upsert: true, contentType: "application/pdf" });
  attendu(!eUp, `PDF déposé dans le bucket privé « ${BUCKET} » à ${chemin}` + (eUp ? ` — ${eUp.message}` : ""));

  const { data: liste } = await sb.storage.from(BUCKET).list(dossierId, { search: REF_DECL });
  attendu((liste ?? []).some((f) => f.name.startsWith(REF_DECL)),
    "quittance retrouvée par le CHEMIN DÉTERMINISTE (l'écran la voit sans lire la base)");

  const q = await executerEnregistrementQuittance(sb, { dossierId, periode: PERIODE, path: chemin, nom: "quittance-e2e.pdf" });
  if (txTemp) {
    attendu(q.ok && q.traceEnBase, "chemin tracé en base sur la ligne de banque (quittance_path)");
    const { data: v } = await sb.from("transactions_bancaires").select("quittance_path,quittance_nom").eq("id", txTemp).maybeSingle();
    attendu(v?.quittance_path === chemin, `relu depuis la base : quittance_path = ${v?.quittance_path}`);
    attendu(v?.quittance_nom === "quittance-e2e.pdf", `relu depuis la base : quittance_nom = ${v?.quittance_nom}`);
  } else {
    attendu(q.ok && !q.traceEnBase, `sans ligne de relevé : le bucket fait foi — « ${q.raison?.slice(0, 70)}… »`);
  }

  const { data: signed, error: eSign } = await sb.storage.from(BUCKET).createSignedUrl(chemin, 300);
  attendu(!eSign && !!signed?.signedUrl, "lien signé 5 min obtenu (bucket privé — jamais d'URL publique)");

  // ── 7. Pointage du règlement ───────────────────────────────────────────────
  console.log("\n── 7. Pointage du règlement (doit être ACCEPTÉ) ──");
  etat = await lireEtatPeriodeTva(sb, { dossierId, periode: PERIODE });
  act = actionsCycleTva(etat);
  attendu(act.pointer, "interrupteur de pointage DÉGRISÉ — le 4456 est soldé");
  attendu(act.raisonPointageIndisponible === null, "aucune raison d'indisponibilité affichée");

  const pt = await executerPointageTva(sb, { dossierId, periode: PERIODE, pointe: true });
  attendu(pt.ok && pt.lignesPointees >= 2, `${pt.lignesPointees} ligne(s) de 4456 cochées`);
  if (txTemp) attendu(pt.transactionPointee, "ligne de banque cochée elle aussi (transactions_bancaires.pointe)");

  etat = await lireEtatPeriodeTva(sb, { dossierId, periode: PERIODE });
  attendu(etat.pointe === true, "relu depuis la base : pointe = true");
  attendu(!!etat.pointeLe, `horodatage du pointage : ${etat.pointeLe}`);
  // Le cycle a-t-il tout soldé ? On le mesure À REPORT CONSTANT : le 4456 doit
  // être à zéro, et les comptes de TVA ne doivent porter que ce qu'ils portaient
  // déjà avant le test. Exiger `bouclee === true` confondrait le résidu du
  // dossier avec un défaut du cycle.
  attendu(Math.abs(etat.resteAPayer) < 0.005, `compte 4456 soldé — reste ${fmt(etat.resteAPayer)} MAD`);
  const apres = controlerBouclagePeriode(
    (await sb.from("ecritures_comptables").select("compte_numero,date_ecriture,debit,credit").eq("dossier_id", dossierId)).data ?? [],
    PERIODE,
  );
  attendu(
    Math.abs(apres.collectee - REPORT.collectee) < 0.005
    && Math.abs(apres.deductible - REPORT.deductible) < 0.005
    && Math.abs(apres.due - REPORT.due) < 0.005,
    "BOUCLAGE à report constant : le cycle n'a laissé aucun solde de TVA derrière lui"
    + ` (44551 ${fmt(apres.collectee)} · 34552 ${fmt(apres.deductible)} · 4456 ${fmt(apres.due)})`,
  );
  if (!REPORT.solde) {
    info(`bouclee = ${etat.bouclee} — reste le report antérieur : ${etat.detailBouclage}`);
  } else {
    attendu(etat.bouclee === true, `BOUCLAGE : 44551, 34552 et 4456 tous à 0,00 — période soldée`);
  }
  if (txTemp) attendu(etat.quittancePath === chemin, "quittance relue via la ligne de banque rapprochée");
  info(`étape=${etapeCycleTva(etat)} · badge=« ${badgeCycleTva(etat).label} »`);

  // ── 8. Dépointage : se dédire reste possible ───────────────────────────────
  console.log("\n── 8. Dépointage ──");
  const dep = await executerPointageTva(sb, { dossierId, periode: PERIODE, pointe: false });
  attendu(dep.ok && !dep.pointe, `${dep.lignesPointees} ligne(s) décochées`);
  etat = await lireEtatPeriodeTva(sb, { dossierId, periode: PERIODE });
  attendu(etat.pointe === false && etat.pointeLe === null, "relu depuis la base : pointe = false, horodatage effacé");

} catch (e) {
  ko(`INTERRUPTION : ${e?.message ?? e}`);
} finally {
  // ── 9. Restauration ────────────────────────────────────────────────────────
  console.log("\n── 9. Restauration du dossier ──");
  const { error: eDel } = await sb.from("ecritures_comptables").delete()
    .eq("dossier_id", dossierId).in("reference_piece", [REF_DECL, REF_SEED]);
  if (eDel) ko(`suppression des écritures : ${eDel.message}`);
  if (txTemp) {
    const { error: e2 } = await sb.from("transactions_bancaires").delete().eq("id", txTemp);
    if (e2) ko(`suppression de la ligne de banque : ${e2.message}`);
  }
  await sb.storage.from(BUCKET).remove([`${dossierId}/${REF_DECL}.pdf`]);

  const APRES = await empreinte();
  if (APRES === AVANT) {
    ok(`dossier rendu à l'identique — ${APRES.split("\n").filter(Boolean).length} écriture(s), empreinte inchangée`);
  } else {
    ko("RÉSIDU EN BASE — l'empreinte diffère de l'état initial");
    const av = new Set(AVANT.split("\n")), ap = new Set(APRES.split("\n"));
    for (const l of ap) if (!av.has(l)) console.log(`        EN TROP : ${l}`);
    for (const l of av) if (!ap.has(l)) console.log(`        MANQUANT : ${l}`);
    console.log(`\n   Nettoyage manuel : DELETE FROM ecritures_comptables WHERE dossier_id='${dossierId}'`
      + ` AND reference_piece IN ('${REF_DECL}','${REF_SEED}');`);
    console.log("\n" + "─".repeat(72));
    console.log("❌ RÉSIDU EN BASE — intervention nécessaire\n");
    process.exit(2);
  }
}

console.log("\n" + "─".repeat(72));
console.log(rouge === 0 ? "✅ CYCLE TVA COMPLET VALIDÉ SUR LA BASE RÉELLE\n" : `❌ ${rouge} contrôle(s) en échec\n`);
process.exit(rouge === 0 ? 0 : 1);
