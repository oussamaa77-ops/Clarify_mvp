/**
 * regulariser-tva-anticipee.mjs — reprend une TVA déclarée par ANTICIPATION.
 *
 * ─── Le cas ──────────────────────────────────────────────────────────────────
 * SOMADIR a déduit 3 360,00 de TVA en 2024-11 sur une facture fournisseur jamais
 * payée. Sous le régime des encaissements, la déduction naît du DÉCAISSEMENT :
 * elle n'était pas acquise. Le compte 34552 en garde la trace, CRÉDITEUR — une
 * position anormale pour un compte de nature débitrice, qui dit exactement
 * « on a réclamé plus qu'on n'a gagné ».
 *
 * ─── Ce qu'on ne fait pas, et pourquoi ───────────────────────────────────────
 * On ne réécrit pas la déclaration de 2024-11 : elle est déposée, c'est un acte
 * transmis à la DGI, et la corriger effacerait une déclaration réellement
 * transmise. On ne la purge pas davantage. On la REPREND sur l'exercice ouvert,
 * ce qui est le geste comptable normal — et le seul qui laisse une piste d'audit.
 *
 * On ne purge pas non plus le 3458 (TVA en attente). C'est délibéré : la TVA y
 * reste en attente du fait générateur réel. Le jour où le fournisseur sera payé,
 * la bascule ordinaire la rendra déductible — une fois, et à la bonne date.
 * Solder l'attente ici reviendrait à RATIFIER l'anticipation au lieu de la
 * corriger, et la déduction serait perdue.
 *
 * ─── Le verrou qui rend la reprise efficace ──────────────────────────────────
 * L'écriture est hors flux (référence `REGUL-TVA-<période>`, cf.
 * `estRegularisation`). Sans cela, le débit du 34552 serait compté comme TVA
 * déductible du mois de la reprise : la régularisation s'accorderait la déduction
 * qu'elle est censée reprendre, son effet serait nul, et le compte repartirait
 * créditeur à chaque déclaration, indéfiniment.
 *
 * ─── Le montant vient de la PÉRIODE, jamais du solde du compte ───────────────
 * Tentant de reprendre « le solde anormal ». C'est faux dès qu'un dossier a
 * plusieurs périodes en cause : le solde les agrège, et il en soustrait la TVA
 * devenue exigible depuis, pas encore déclarée. SMERT porte 13 662,00 au 44551
 * pour 17 162,00 réellement sur-déclarés sur trois périodes, moins 3 500,00
 * devenus exigibles en juillet. Reprendre 13 662,00 mélangerait les périodes.
 *
 * Le montant d'une reprise est donc l'écart de SA période — déclaré moins réel.
 *
 * ─── Le garde : l'identité comptable du dossier ──────────────────────────────
 * Le script refuse d'écrire si, pour le dossier entier,
 *      solde du compte = −Σ sur-déclarations + TVA non déclarée + reprises déjà passées
 * ne boucle pas au centime. Tant qu'elle boucle, l'écart de chaque période est
 * une quantité fiable. Si elle casse, c'est le chiffrage qui est incomplet — et
 * une régularisation est un acte fiscal : mieux vaut ne rien écrire.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   node --import tsx scripts/regulariser-tva-anticipee.mjs --dossier="SOMADIR" --periode=2024-11
 *   node --import tsx scripts/regulariser-tva-anticipee.mjs --dossier="SMERT" --toutes --apply
 *   node --import tsx scripts/regulariser-tva-anticipee.mjs --rollback=backup_regul_....json
 *
 * Options : --periode=P (répétable par virgules) ou --toutes (toutes les
 *           périodes en cause), --sens=deduction|collecte (défaut : déduit du
 *           compte anormal), --date=AAAA-MM-JJ (défaut : aujourd'hui).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  liquiderTva, construireOdRegularisationTva, controlerPiece,
  PREFIXE_REGULARISATION_TVA, PREFIXE_DECLARATION_TVA,
  RACINE_COLLECTEE, RACINE_DEDUCTIBLE, bornesPeriode,
} from "../src/lib/liquidation-tva.ts";
import { insererPiece } from "../src/server/lettrage-compta.functions.ts";
import { bornesExerciceActif, COMPTE_TVA_ATTENTE } from "../src/lib/genererEcritures.ts";
import { dansExercice } from "../src/lib/exercice-comptable.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const flag = (nom) => {
  const hit = argv.find((a) => a === `--${nom}` || a.startsWith(`--${nom}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf("=");
  return eq === -1 ? "" : hit.slice(eq + 1).replace(/^["']|["']$/g, "");
};
const APPLY = flag("apply") !== undefined;
const ROLLBACK = flag("rollback") || null;
const CIBLE = flag("dossier") || null;
const PERIODE = flag("periode") || null;
const SENS = flag("sens") || null;
const MONTANT = flag("montant") ? Number(flag("montant")) : null;
const DATE = flag("date") || new Date().toISOString().slice(0, 10);

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

const nb = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const txt = (v) => String(v ?? "").trim();
const r2 = (x) => Math.round(x * 100) / 100;
const fmt = (x) => x.toLocaleString("fr-MA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ─── Rollback ───────────────────────────────────────────────────────────────
if (ROLLBACK) {
  const sauv = JSON.parse(fs.readFileSync(path.join(ROOT, ROLLBACK), "utf8"));
  console.log(`\n⏪ ROLLBACK depuis ${ROLLBACK} — suppression de ${sauv.reference}\n`);
  const { error, count } = await sb.from("ecritures_comptables")
    .delete({ count: "exact" })
    .eq("dossier_id", sauv.dossierId).eq("reference_piece", sauv.reference);
  if (error) { console.error(`❌ ${error.message}`); process.exit(1); }
  console.log(`  ${count ?? 0} ligne(s) supprimée(s) — la régularisation est annulée.\n`);
  process.exit(0);
}

if (!CIBLE || !PERIODE) {
  console.error(`\n❌ --dossier et --periode sont requis.`);
  console.error(`   ex. --dossier="SOMADIR" --periode=2024-11\n`);
  process.exit(1);
}
if (!bornesPeriode(PERIODE)) { console.error(`\n❌ Période illisible : « ${PERIODE} » (AAAA-MM ou AAAA-Tn)\n`); process.exit(1); }

console.log(`\n${APPLY ? "🔧 APPLICATION" : "🔍 SIMULATION (dry-run)"} — régularisation de TVA anticipée\n`);

let q = sb.from("dossiers").select("id,nom_societe,date_debut_activite");
q = /^[0-9a-f-]{36}$/i.test(CIBLE) ? q.eq("id", CIBLE) : q.ilike("nom_societe", `%${CIBLE}%`);
const { data: dossiers, error: eDos } = await q;
if (eDos) { console.error(`❌ ${eDos.message}`); process.exit(1); }
if ((dossiers ?? []).length !== 1) {
  console.error(`❌ ${(dossiers ?? []).length} dossier(s) pour « ${CIBLE} » — il en faut exactement un.`);
  for (const d of dossiers ?? []) console.error(`   · ${d.nom_societe}`);
  process.exit(1);
}
const dossier = dossiers[0];

const { data: lignes, error: eL } = await sb.from("ecritures_comptables")
  .select("compte_numero,journal_code,date_ecriture,debit,credit,reference_piece,libelle")
  .eq("dossier_id", dossier.id);
if (eL) { console.error(`❌ ${eL.message}`); process.exit(1); }

// ─── Idempotence : une période ne se régularise qu'une fois ──────────────────
const refRegul = `${PREFIXE_REGULARISATION_TVA}${PERIODE}`;
const dejaFaite = (lignes ?? []).filter((l) => txt(l.reference_piece) === refRegul);
if (dejaFaite.length) {
  console.log(`✅ ${dossier.nom_societe} — ${PERIODE} est DÉJÀ régularisée (${refRegul}, ${dejaFaite.length} lignes) :`);
  for (const l of dejaFaite) console.log(`   ${l.date_ecriture} ${txt(l.compte_numero).padEnd(7)} D ${fmt(nb(l.debit))} / C ${fmt(nb(l.credit))}`);
  console.log(`\nRien à faire.\n`);
  process.exit(0);
}

// ─── Dérivation 1 : le solde ANORMAL du compte ──────────────────────────────
const soldeCol = r2((lignes ?? []).filter((l) => txt(l.compte_numero).startsWith(RACINE_COLLECTEE))
  .reduce((s, l) => s + nb(l.credit) - nb(l.debit), 0));
const soldeDed = r2((lignes ?? []).filter((l) => txt(l.compte_numero).startsWith(RACINE_DEDUCTIBLE))
  .reduce((s, l) => s + nb(l.debit) - nb(l.credit), 0));
// Anormal = 34552 créditeur (déduit d'avance) ou 44551 débiteur (déclaré d'avance).
const anormalDeduction = r2(Math.max(0, -soldeDed));
const anormalCollecte = r2(Math.max(0, -soldeCol));

const sens = SENS ?? (anormalDeduction > 0.005 ? "deduction" : anormalCollecte > 0.005 ? "collecte" : null);
if (!sens) {
  console.log(`✅ ${dossier.nom_societe} — aucun solde de TVA anormal (44551 ${fmt(soldeCol)} créditeur, 34552 ${fmt(soldeDed)} débiteur).`);
  console.log(`   Rien à régulariser.\n`);
  process.exit(0);
}
const parSolde = sens === "deduction" ? anormalDeduction : anormalCollecte;

// ─── Dérivation 2 : l'écart de la période DÉCLARÉE ──────────────────────────
const piece = (lignes ?? []).filter((l) => txt(l.reference_piece) === `${PREFIXE_DECLARATION_TVA}${PERIODE}`);
if (!piece.length) {
  console.error(`❌ Aucune déclaration ${PREFIXE_DECLARATION_TVA}${PERIODE} pour ${dossier.nom_societe}.`);
  console.error(`   On ne régularise que ce qui a été DÉCLARÉ — sinon il n'y a pas d'anticipation, juste une TVA en attente.\n`);
  process.exit(1);
}
// La déclaration solde les comptes : elle DÉBITE la collectée et CRÉDITE la
// déductible. Le montant déclaré se lit donc à l'envers du sens du compte.
const declare = sens === "deduction"
  ? r2(piece.filter((l) => txt(l.compte_numero).startsWith(RACINE_DEDUCTIBLE))
      .reduce((s, l) => s + nb(l.credit) - nb(l.debit), 0))
  : r2(piece.filter((l) => txt(l.compte_numero).startsWith(RACINE_COLLECTEE))
      .reduce((s, l) => s + nb(l.debit) - nb(l.credit), 0));
const liq = liquiderTva((lignes ?? []).filter((l) =>
  txt(l.compte_numero).startsWith(RACINE_COLLECTEE) || txt(l.compte_numero).startsWith(RACINE_DEDUCTIBLE)), PERIODE);
const reel = sens === "deduction" ? (liq?.deductible ?? 0) : (liq?.collectee ?? 0);
const parEcart = r2(declare - reel);

console.log(`  Dossier             ${dossier.nom_societe}`);
console.log(`  Période régularisée ${PERIODE}   ·   sens : ${sens === "deduction" ? "TVA DÉDUITE par anticipation" : "TVA COLLECTÉE déclarée par anticipation"}`);
console.log(`\n  Deux lectures indépendantes du montant :`);
console.log(`    solde anormal du compte  ${fmt(parSolde).padStart(12)}`);
console.log(`    écart de la période      ${fmt(parEcart).padStart(12)}   (déclaré ${fmt(declare)} − réel ${fmt(reel)})`);

if (Math.abs(parSolde - parEcart) > 0.005 && MONTANT == null) {
  console.error(`\n⛔ Les deux lectures DIVERGENT de ${fmt(Math.abs(parSolde - parEcart))}.`);
  console.error(`   Le solde du compte porte peut-être d'autres périodes non régularisées.`);
  console.error(`   Refus d'écrire : régularisez période par période, ou forcez avec --montant=.\n`);
  process.exit(1);
}
const montant = MONTANT != null ? r2(MONTANT) : parSolde;
if (montant < 0.005) { console.log(`\n✅ Montant nul — rien à régulariser.\n`); process.exit(0); }

// ─── Le compte d'ATTENTE couvre-t-il la reprise ? ───────────────────────────
// Si oui, la TVA redeviendra déductible (ou exigible) au fait générateur réel :
// la reprise ne fait que replacer la déduction à sa date. Sinon, la reprise est
// une perte sèche — ce qui reste juste, mais mérite d'être dit.
const attente = sens === "deduction"
  ? r2((lignes ?? []).filter((l) => txt(l.compte_numero).startsWith(COMPTE_TVA_ATTENTE.achat))
      .reduce((s, l) => s + nb(l.debit) - nb(l.credit), 0))
  : r2((lignes ?? []).filter((l) => txt(l.compte_numero).startsWith(COMPTE_TVA_ATTENTE.vente))
      .reduce((s, l) => s + nb(l.credit) - nb(l.debit), 0));
const compteAttente = sens === "deduction" ? COMPTE_TVA_ATTENTE.achat : COMPTE_TVA_ATTENTE.vente;
console.log(`\n  Couverture par le compte d'attente ${compteAttente} : ${fmt(attente)}`);
console.log(`    → ${attente + 0.005 >= montant
  ? `couverte : la TVA redeviendra ${sens === "deduction" ? "déductible au paiement du fournisseur" : "exigible à l'encaissement"}, une seule fois.`
  : `NON couverte à hauteur de ${fmt(r2(montant - attente))} — cette part est une perte définitive.`}`);

// ─── Construction et verrous ────────────────────────────────────────────────
const bornes = bornesExerciceActif(dossier);
if (!dansExercice(DATE, bornes)) {
  console.error(`\n⛔ La date ${DATE} est hors exercice ouvert (${bornes.debut} → ${bornes.fin}).`);
  console.error(`   Une régularisation s'écrit sur l'exercice COURANT, jamais dans la période corrigée.\n`);
  process.exit(1);
}

const od = construireOdRegularisationTva({
  periodeRegularisee: PERIODE, sens, montant, date: DATE,
  motif: `solde ${sens === "deduction" ? "34552" : "44551"} anormal`,
});
const ctrl = controlerPiece(od);
if (!od.length || !ctrl.ok) {
  console.error(`\n⛔ Pièce invalide : ${ctrl.raison ?? "aucune ligne produite"}\n`);
  process.exit(1);
}

console.log(`\n  Écriture (journal OD, réf. ${refRegul}, date ${DATE}) :`);
for (const l of od) {
  console.log(`    ${txt(l.compte_numero).padEnd(7)} D ${fmt(l.debit).padStart(12)}  C ${fmt(l.credit).padStart(12)}   ${l.libelle}`);
}
console.log(`\n  Effet : le ${sens === "deduction" ? "34552" : "44551"} est soldé, et le 4456 porte `
  + `${fmt(montant)} ${sens === "deduction" ? "DÛ à l'État" : "dû PAR l'État"}.`);

if (!APPLY) {
  console.log(`\n🔍 Dry-run — rien n'a été écrit. Ajoutez --apply pour passer l'écriture.\n`);
  process.exit(0);
}

// Sauvegarde AVANT écriture : la référence suffit à défaire, la pièce est neuve.
const horodatage = new Date().toISOString().replace(/[:.]/g, "-");
const chemin = `backup_regul_tva_${horodatage}.json`;
fs.writeFileSync(path.join(ROOT, chemin), JSON.stringify({
  date: new Date().toISOString(), dossierId: dossier.id, dossier: dossier.nom_societe,
  reference: refRegul, periode: PERIODE, sens, montant, lignes: od,
}, null, 2), "utf8");
console.log(`\n💾 Sauvegarde : ${chemin}`);

// Même chemin que l'application : `insererPiece` repasse les verrous de régime
// (pas de trésorerie en OD, partie double) juste avant la base.
const { error } = await insererPiece(sb, dossier.id, od, { origine: "manuel" });
if (error) { console.error(`\n❌ Insertion refusée : ${error}\n`); process.exit(1); }

console.log(`✅ Régularisation passée — ${od.length} lignes, ${fmt(montant)}.`);
console.log(`\nRollback : node --import tsx scripts/regulariser-tva-anticipee.mjs --rollback=${chemin}`);
console.log(`Contrôle : node --import tsx scripts/ecart-tva-par-periode.mjs\n`);
