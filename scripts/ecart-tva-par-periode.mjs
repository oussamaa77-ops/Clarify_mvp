/**
 * ecart-tva-par-periode.mjs — CHIFFRE l'écart entre les déclarations DÉPOSÉES et
 * la position de TVA telle que le régime des encaissements corrigé la calcule.
 *
 * ─── Pourquoi ce script existe ───────────────────────────────────────────────
 * `reconstruire_compta_dossiers.mjs` a refait les factures et `relancer-lettrage-
 * auto.mjs` a reposé les bascules : l'exigibilité de la TVA a donc changé. Les
 * OD `DECL-TVA-<période>` déjà déposées, elles, sont restées telles quelles —
 * et c'est VOULU. Une déclaration déposée est un acte fiscal transmis à la DGI :
 * on ne la réécrit pas, on la RÉGULARISE sur une période ultérieure.
 *
 * Ce script ne corrige rien. Il produit la matière de cette régularisation :
 * pour chaque période, ce qui a été déclaré face à ce qui aurait dû l'être.
 *
 * ─── La date qui compte est celle du RÈGLEMENT ───────────────────────────────
 * Une bascule appartient à la période où l'ARGENT a bougé, pas à celle où on l'a
 * enregistrée. Le lettrage automatique ne transmettait pas la date de règlement
 * (corrigé depuis : `dateDuReglement`), si bien que les bascules d'une reprise
 * portent toutes la date de la reprise. Chiffrer sur ces dates ne mesurerait pas
 * l'écart fiscal, mais le décalage de saisie.
 *
 * Le script REDATE donc chaque bascule sur la ligne de trésorerie de son code de
 * lettrage, et signale les pièces dont la date en base diverge — elles restent à
 * corriger EN BASE, ce chiffrage ne le fait pas.
 *
 * ─── Comment lire le résultat ────────────────────────────────────────────────
 * L'écart n'est PAS le solde résiduel de 44551/34552. Ce solde mélange trois
 * choses de natures différentes, et les confondre ferait régulariser du normal —
 * ou régulariser deux fois :
 *
 *   1. l'ÉCART sur les périodes DÉCLARÉES  → anomalie, à régulariser ;
 *   2. la TVA des périodes PAS ENCORE DÉCLARÉES → normal, elle attend sa
 *      déclaration ;
 *   3. les RÉGULARISATIONS déjà passées → l'anomalie a déjà été reprise, et la
 *      reclasser en « attente » inviterait à déduire une seconde fois ce qui
 *      vient d'être rendu à l'État.
 *
 * Le script sépare les trois et vérifie l'identité comptable
 *      solde résiduel = écart déclaré + non encore déclaré + régularisations
 * pour chaque compte. Si elle ne boucle pas, c'est le chiffrage qui est faux,
 * pas la base — et il le dit plutôt que de rendre un total rassurant. Les
 * dossiers SANS aucune déclaration sont parcourus eux aussi : ils ne peuvent
 * porter d'écart, mais ils portent de la TVA en attente, et l'omettre laisserait
 * la synthèse en déséquilibre (cas ATLAS, 15 400 à lui seul).
 *
 * Convention de signe des écarts : RÉEL − DÉCLARÉ.
 *   collectée > 0  → TVA collectée SOUS-déclarée  (complément dû à l'État)
 *   déductible > 0 → TVA déductible SOUS-déduite  (créance sur l'État)
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   node --import tsx scripts/ecart-tva-par-periode.mjs
 *   node --import tsx scripts/ecart-tva-par-periode.mjs --dossier="<nom|uuid>"
 *   node --import tsx scripts/ecart-tva-par-periode.mjs --csv=ecarts-tva.csv
 *   node --import tsx scripts/ecart-tva-par-periode.mjs --dates-base   (sans redatage)
 *
 * LECTURE SEULE : aucun `insert`, `update` ni `delete`. Il n'a pas de `--apply`,
 * et c'est délibéré — l'arbitrage d'une régularisation revient au comptable.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  liquiderTva,
  bornesPeriode,
  PREFIXE_DECLARATION_TVA,
  RACINE_COLLECTEE,
  RACINE_DEDUCTIBLE,
  COMPTE_TVA_DUE,
  LIBELLE_PAIEMENT_DGI,
  PREFIXE_REGULARISATION_TVA,
} from "../src/lib/liquidation-tva.ts";
import { estJournalReglement, COMPTE_TVA_ATTENTE } from "../src/lib/genererEcritures.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const flag = (nom) => {
  const hit = argv.find((a) => a === `--${nom}` || a.startsWith(`--${nom}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf("=");
  return eq === -1 ? "" : hit.slice(eq + 1).replace(/^["']|["']$/g, "");
};
const CIBLE = flag("dossier") || null;
const CSV = flag("csv") || null;
const DATES_BASE = flag("dates-base") !== undefined;

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env"), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);

// Le proxy TLS de l'entreprise casse le `fetch` global côté serveur ; undici en
// direct passe. On n'essaie le repli qu'une fois (cf. mémoire « proxy-supabase-server »).
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

const round2 = (x) => Math.round(x * 100) / 100;
const nb = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const txt = (v) => String(v ?? "").trim();
const jour = (l) => txt(l.date_ecriture).slice(0, 10);
const fmt = (x) => (Math.abs(x) < 0.005 ? "—" : x.toLocaleString("fr-MA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

/** PostgREST plafonne à 1000 lignes : on pagine, sinon un gros dossier est tronqué en silence. */
async function toutesLesEcritures(dossierId) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("ecritures_comptables")
      .select("compte_numero,journal_code,date_ecriture,debit,credit,reference_piece,libelle,lettrage_code")
      .eq("dossier_id", dossierId)
      .order("date_ecriture", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) return out;
  }
}

const estCollectee = (l) => txt(l.compte_numero).startsWith(RACINE_COLLECTEE);
const estDeductible = (l) => txt(l.compte_numero).startsWith(RACINE_DEDUCTIBLE);
const estTva = (l) => estCollectee(l) || estDeductible(l);
const estDeclaration = (l) => txt(l.reference_piece).startsWith(PREFIXE_DECLARATION_TVA);
/**
 * Reprise d'une période antérieure. Elle forme un TROISIÈME poste, distinct de
 * l'écart et de l'attente — et l'isoler n'est pas cosmétique : rangée en « en
 * attente de déclaration », elle se lirait comme une TVA restant à déduire, et
 * inviterait à déduire une seconde fois ce que la reprise vient justement de
 * rendre à l'État.
 */
const estRegularisation = (l) => txt(l.reference_piece).startsWith(PREFIXE_REGULARISATION_TVA);
const periodeRegularisee = (l) => txt(l.reference_piece).slice(PREFIXE_REGULARISATION_TVA.length);

/** Solde d'un compte, au sens de sa nature : créditeur pour 4455, débiteur pour 3455. */
const soldeCollectee = (lignes) => round2(lignes.filter(estCollectee)
  .reduce((s, l) => s + nb(l.credit) - nb(l.debit), 0));
const soldeDeductible = (lignes) => round2(lignes.filter(estDeductible)
  .reduce((s, l) => s + nb(l.debit) - nb(l.credit), 0));

let q = sb.from("dossiers").select("id,nom_societe").order("nom_societe");
if (CIBLE) q = /^[0-9a-f-]{36}$/i.test(CIBLE) ? q.eq("id", CIBLE) : q.ilike("nom_societe", `%${CIBLE}%`);
const { data: dossiers, error } = await q;
if (error) { console.error(`❌ ${error.message}`); process.exit(1); }

console.log(`\n📊 ÉCART DE TVA PAR PÉRIODE — déclaré (DGI) vs recalculé (régime des encaissements corrigé)`);
console.log(`   Lecture seule. Signe : réel − déclaré.`);
console.log(`   Datation des bascules : ${DATES_BASE ? "⚠ telle qu'en base (--dates-base)" : "date réelle du règlement"}\n`);

const csv = [["dossier", "periode", "statut", "collectee_declaree", "collectee_reelle", "ecart_collectee",
  "deductible_declaree", "deductible_reelle", "ecart_deductible", "tva_due_declaree", "tva_due_reelle",
  "ecart_du", "paye_dgi"].join(";")];

let gEcartCol = 0, gEcartDed = 0, gEcartDu = 0, gNonDecCol = 0, gNonDecDed = 0;
let gResCol = 0, gResDed = 0, gMalDatees = 0, gRegulCol = 0, gRegulDed = 0;
const dossiersAvecEcart = [];
const malDatees = [];

for (const d of dossiers ?? []) {
  const lignes = await toutesLesEcritures(d.id);
  const lignesTva = lignes.filter(estTva);
  if (!lignesTva.length) continue;

  // ── Redatage : chaque bascule à la date de SON règlement ───────────────────
  // Le code de lettrage est le lien : il est posé à la fois sur les lignes de
  // tiers appariées et sur l'OD de bascule qu'elles ont déclenchée. La date de
  // la ligne BQ/CAI portant ce code est le jour où l'argent a bougé.
  const dateReglementParCode = new Map();
  for (const l of lignes) {
    const code = txt(l.lettrage_code);
    if (!code || !estJournalReglement(l.journal_code)) continue;
    const j = jour(l);
    if (!j) continue;
    const vue = dateReglementParCode.get(code);
    // Le MAXIMUM : sur un règlement échelonné, la pièce n'est soldée qu'au
    // dernier versement (même règle que `dateDuReglement` côté serveur).
    if (!vue || j > vue) dateReglementParCode.set(code, j);
  }
  const dateEffective = (l) => {
    if (DATES_BASE || estDeclaration(l)) return jour(l);
    return dateReglementParCode.get(txt(l.lettrage_code)) ?? jour(l);
  };
  const lignesTvaDatees = lignesTva.map((l) => ({ ...l, date_ecriture: dateEffective(l) }));

  for (const l of lignesTva) {
    const reelle = dateEffective(l);
    if (reelle !== jour(l)) {
      gMalDatees += 1;
      malDatees.push({ dossier: d.nom_societe, ref: txt(l.reference_piece), compte: txt(l.compte_numero),
        base: jour(l), reelle, montant: round2(nb(l.debit) + nb(l.credit)) });
    }
  }

  // ── Les périodes DÉCLARÉES, lues dans les pièces elles-mêmes ───────────────
  // La période vient de la référence (`DECL-TVA-2026-03`), jamais de la date :
  // une déclaration est datée du dernier jour de SA période, mais un rattrapage
  // peut avoir été saisi plus tard.
  const declarations = new Map();
  for (const l of lignes) {
    if (!estDeclaration(l)) continue;
    const periode = txt(l.reference_piece).slice(PREFIXE_DECLARATION_TVA.length);
    if (!bornesPeriode(periode)) continue;
    if (!declarations.has(periode)) declarations.set(periode, []);
    declarations.get(periode).push(l);
  }
  // Périodes déjà reprises, pour les distinguer dans le tableau.
  const regularisees = new Map();
  for (const l of lignesTva.filter(estRegularisation)) {
    const p = periodeRegularisee(l);
    regularisees.set(p, round2((regularisees.get(p) ?? 0) + nb(l.debit) - nb(l.credit)));
  }

  const periodes = [...declarations.keys()].sort();

  const residuelCol = soldeCollectee(lignesTva);
  const residuelDed = soldeDeductible(lignesTva);
  gResCol += residuelCol; gResDed += residuelDed;

  console.log(`\n${"═".repeat(112)}`);
  console.log(`  ${d.nom_societe}`);
  console.log(`${"═".repeat(112)}`);

  let dEcartCol = 0, dEcartDed = 0, dEcartDu = 0;
  const couvertes = [];

  if (!periodes.length) {
    // Aucune déclaration : pas d'écart POSSIBLE, mais de la TVA en attente. Le
    // dossier compte quand même dans la synthèse, sans quoi elle ne boucle pas.
    console.log(`  Aucune déclaration déposée — rien à régulariser ici.`);
  } else {
    console.log(`  ${pad("Période", 10)} ${padL("Collectée décl.", 16)} ${padL("Collectée réelle", 17)} ${padL("Écart", 13)}   `
      + `${padL("Déduct. décl.", 14)} ${padL("Déduct. réelle", 15)} ${padL("Écart", 13)}`);
    console.log(`  ${"─".repeat(108)}`);
  }

  for (const periode of periodes) {
    const piece = declarations.get(periode);
    couvertes.push(bornesPeriode(periode));

    // Ce qui a ÉTÉ DÉCLARÉ : lu dans l'OD déposée. La déclaration solde les
    // comptes — elle DÉBITE la collectée et CRÉDITE la déductible — donc le
    // montant déclaré se lit dans le sens inverse de celui du compte.
    const colDeclaree = round2(piece.filter(estCollectee)
      .reduce((s, l) => s + nb(l.debit) - nb(l.credit), 0));
    const dedDeclaree = round2(piece.filter(estDeductible)
      .reduce((s, l) => s + nb(l.credit) - nb(l.debit), 0));
    // Le 4456 de la pièce : crédit = dette, débit = crédit reportable. On écarte
    // un éventuel paiement DGI portant la même référence (il débite aussi 4456).
    const duDeclare = round2(piece
      .filter((l) => txt(l.compte_numero).startsWith(COMPTE_TVA_DUE)
        && !txt(l.libelle).startsWith(LIBELLE_PAIEMENT_DGI))
      .reduce((s, l) => s + nb(l.credit) - nb(l.debit), 0));

    // Ce qui AURAIT DÛ l'être : le même calcul pur que l'écran de liquidation,
    // appliqué au grand livre reconstruit et redaté.
    const liq = liquiderTva(lignesTvaDatees, periode);
    const colReelle = liq?.collectee ?? 0;
    const dedReelle = liq?.deductible ?? 0;
    const duReel = round2(colReelle - dedReelle);

    const eCol = round2(colReelle - colDeclaree);
    const eDed = round2(dedReelle - dedDeclaree);
    const eDu = round2(duReel - duDeclare);
    dEcartCol += eCol; dEcartDed += eDed; dEcartDu += eDu;

    // Le paiement DGI se rattache par la référence, jamais par la date : le
    // prélèvement de la TVA de mars tombe en avril.
    const paye = round2(lignes
      .filter((l) => txt(l.reference_piece) === `${PREFIXE_DECLARATION_TVA}${periode}`
        && txt(l.libelle).startsWith(LIBELLE_PAIEMENT_DGI))
      .reduce((s, l) => s + nb(l.debit), 0));

    // Une période reprise n'est plus une anomalie ouverte : elle est traitée.
    const ecarte = Math.abs(eCol) > 0.005 || Math.abs(eDed) > 0.005;
    const marque = !ecarte ? "  " : regularisees.has(periode) ? "✓ " : "⚠ ";
    console.log(`${marque}${pad(periode, 10)} ${padL(fmt(colDeclaree), 16)} ${padL(fmt(colReelle), 17)} ${padL(fmt(eCol), 13)}   `
      + `${padL(fmt(dedDeclaree), 14)} ${padL(fmt(dedReelle), 15)} ${padL(fmt(eDed), 13)}`);

    csv.push([d.nom_societe, periode, paye > 0.005 ? "payée" : "déposée",
      colDeclaree, colReelle, eCol, dedDeclaree, dedReelle, eDed,
      duDeclare, duReel, eDu, paye].join(";"));
  }

  if (periodes.length) {
    console.log(`  ${"─".repeat(108)}`);
    console.log(`  ${pad("TOTAL", 10)} ${padL("", 16)} ${padL("", 17)} ${padL(fmt(dEcartCol), 13)}   `
      + `${padL("", 14)} ${padL("", 15)} ${padL(fmt(dEcartDed), 13)}`);
    if (Math.abs(dEcartCol) > 0.005 || Math.abs(dEcartDed) > 0.005) dossiersAvecEcart.push(d.nom_societe);
  }

  // ── Contrôle de bouclage : le résiduel s'explique-t-il entièrement ? ───────
  // TVA hors de toute période déclarée : elle est exigible mais attend encore sa
  // déclaration. C'est du NORMAL, pas un écart — les mélanger ferait régulariser
  // une TVA qui sera déclarée le mois prochain.
  const dansUnePeriodeDeclaree = (l) => {
    const j = jour(l);
    return couvertes.some((b) => j >= b.debut && j <= b.fin);
  };
  const regul = lignesTvaDatees.filter(estRegularisation);
  const rgCol = soldeCollectee(regul);
  const rgDed = soldeDeductible(regul);
  const nonDeclarees = lignesTvaDatees.filter((l) =>
    !estDeclaration(l) && !estRegularisation(l) && !dansUnePeriodeDeclaree(l));
  const ndCol = soldeCollectee(nonDeclarees);
  const ndDed = soldeDeductible(nonDeclarees);

  const bouclageCol = round2(residuelCol - (dEcartCol + ndCol + rgCol));
  const bouclageDed = round2(residuelDed - (dEcartDed + ndDed + rgDed));

  console.log(`\n  Décomposition du solde résiduel`);
  console.log(`    ${pad("", 30)} ${padL("44551 (collectée)", 20)} ${padL("34552 (déductible)", 20)}`);
  console.log(`    ${pad("écart sur périodes déclarées", 30)} ${padL(fmt(dEcartCol), 20)} ${padL(fmt(dEcartDed), 20)}`);
  console.log(`    ${pad("+ en attente de déclaration", 30)} ${padL(fmt(ndCol), 20)} ${padL(fmt(ndDed), 20)}`);
  console.log(`    ${pad("+ régularisations déjà passées", 30)} ${padL(fmt(rgCol), 20)} ${padL(fmt(rgDed), 20)}`);
  console.log(`    ${pad("= solde du compte", 30)} ${padL(fmt(residuelCol), 20)} ${padL(fmt(residuelDed), 20)}`);
  if (Math.abs(bouclageCol) > 0.005 || Math.abs(bouclageDed) > 0.005) {
    console.log(`    ⛔ NE BOUCLE PAS — reliquat inexpliqué : 44551 ${fmt(bouclageCol)} · 34552 ${fmt(bouclageDed)}`);
    console.log(`       (chiffrage incomplet pour ce dossier — ne pas régulariser sur cette base)`);
  } else {
    console.log(`    ✅ boucle au centime`);
  }

  // ── Nature de l'écart : décalage de période, ou perte sèche ? ─────────────
  // La question qui commande la régularisation. Un compte 44551 DÉBITEUR veut
  // dire qu'on a déclaré une TVA qui n'était pas encore exigible : l'entreprise
  // a payé D'AVANCE. Cette avance se rattrape d'elle-même — au règlement du
  // client, la bascule rendra la TVA exigible et viendra solder le débit.
  //
  // À une condition : que la TVA correspondante soit ENCORE EN ATTENTE sur 4458
  // (ou 3458). Si l'avance dépasse ce qui reste en attente, la différence ne se
  // rattrapera jamais toute seule — c'est une perte, et elle appelle une
  // réclamation, pas une simple régularisation sur la période suivante.
  const attenteVente = round2(lignes
    .filter((l) => txt(l.compte_numero).startsWith(COMPTE_TVA_ATTENTE.vente))
    .reduce((s, l) => s + nb(l.credit) - nb(l.debit), 0));
  const attenteAchat = round2(lignes
    .filter((l) => txt(l.compte_numero).startsWith(COMPTE_TVA_ATTENTE.achat))
    .reduce((s, l) => s + nb(l.debit) - nb(l.credit), 0));
  const avanceCol = round2(Math.max(0, -residuelCol));   // 44551 débiteur = payé d'avance
  const avanceDed = round2(Math.max(0, -residuelDed));   // 34552 créditeur = déduit d'avance

  if (avanceCol > 0.005 || avanceDed > 0.005) {
    console.log(`\n  Nature de l'écart`);
    if (avanceCol > 0.005) {
      const sec = round2(avanceCol - attenteVente);
      console.log(`    TVA collectée déclarée d'avance   ${padL(fmt(avanceCol), 14)}`
        + `  · encore en attente sur ${COMPTE_TVA_ATTENTE.vente} : ${fmt(attenteVente)}`);
      console.log(`      → ${sec <= 0.005
        ? "DÉCALAGE DE PÉRIODE : intégralement couvert, se résorbe au règlement des clients."
        : `PERTE de ${fmt(sec)} non couverte par le ${COMPTE_TVA_ATTENTE.vente} — à réclamer.`}`);
    }
    if (avanceDed > 0.005) {
      const sec = round2(avanceDed - attenteAchat);
      console.log(`    TVA déductible déduite d'avance   ${padL(fmt(avanceDed), 14)}`
        + `  · encore en attente sur ${COMPTE_TVA_ATTENTE.achat} : ${fmt(attenteAchat)}`);
      console.log(`      → ${sec <= 0.005
        ? `DÉCALAGE DE PÉRIODE, mais À RISQUE : la TVA a été déduite avant le paiement du`
          + ` fournisseur. Elle redeviendra déductible au décaissement — ne pas la déduire DEUX fois.`
        : `PERTE de ${fmt(sec)} non couverte par le ${COMPTE_TVA_ATTENTE.achat}.`}`);
    }
  }

  gEcartCol += dEcartCol; gEcartDed += dEcartDed; gEcartDu += dEcartDu;
  gNonDecCol += ndCol; gNonDecDed += ndDed;
  gRegulCol += rgCol; gRegulDed += rgDed;
}

// ── Bascules mal datées : à corriger EN BASE, ce script ne le fait pas ───────
if (malDatees.length) {
  console.log(`\n${"═".repeat(112)}`);
  console.log(`  ⚠ ${gMalDatees} BASCULE(S) MAL DATÉE(S) EN BASE — redatées ici pour le calcul, PAS en base`);
  console.log(`${"═".repeat(112)}`);
  console.log(`  ${pad("Dossier", 30)} ${pad("Pièce", 22)} ${pad("Cpte", 7)} ${padL("Montant", 12)}   ${pad("en base", 12)} → date réelle`);
  for (const m of malDatees) {
    console.log(`  ${pad(m.dossier.slice(0, 29), 30)} ${pad(m.ref.slice(0, 21), 22)} ${pad(m.compte, 7)} `
      + `${padL(fmt(m.montant), 12)}   ${pad(m.base, 12)} → ${m.reelle}`);
  }
}

console.log(`\n${"═".repeat(112)}`);
console.log(`  SYNTHÈSE`);
console.log(`${"═".repeat(112)}`);
// Le signe porte le sens, et un intitulé figé le trahirait : un écart négatif
// n'est pas une « sous-déclaration négative », c'est une SUR-déclaration. On
// nomme donc le sens réellement constaté plutôt que de laisser lire un moins.
const sensCol = gEcartCol >= 0 ? "sous-déclarée (complément dû à l'État)" : "SUR-déclarée (payée d'avance)";
const sensDed = gEcartDed >= 0 ? "sous-déduite (créance sur l'État)" : "SUR-déduite (déduite d'avance)";
console.log(`  TVA collectée ${pad(sensCol, 40)} : ${fmt(Math.abs(gEcartCol))}`);
console.log(`  TVA déductible ${pad(sensDed, 39)} : ${fmt(Math.abs(gEcartDed))}`);
console.log(`  ───────────────────────────────────────────────────────────────────`);
const net = round2(gEcartCol - gEcartDed);
console.log(`  Régularisation nette                                  : ${fmt(Math.abs(net))} `
  + `${net >= 0 ? "à PAYER en complément" : "payé d'AVANCE (à récupérer sur les périodes suivantes)"}`);
console.log(`  Dossier(s) porteur(s) d'un écart : ${dossiersAvecEcart.length ? dossiersAvecEcart.join(", ") : "aucun"}`);
console.log(`\n  Pour mémoire — TVA en attente de déclaration (normal, pas un écart) :`);
console.log(`    collectée ${fmt(gNonDecCol)} · déductible ${fmt(gNonDecDed)}`);
// L'écart NET est ce qui reste à arbitrer : l'écart brut moins ce qui a déjà été
// repris. C'est le seul chiffre sur lequel décider quelque chose aujourd'hui.
const netCol = round2(gEcartCol + gRegulCol);
const netDed = round2(gEcartDed + gRegulDed);
if (Math.abs(gRegulCol) > 0.005 || Math.abs(gRegulDed) > 0.005) {
  console.log(`
  Déjà repris par régularisation : 44551 ${fmt(gRegulCol)} · 34552 ${fmt(gRegulDed)}`);
  console.log(`  ÉCART NET restant à arbitrer   : 44551 ${fmt(netCol)} · 34552 ${fmt(netDed)}`);
}
const bCol = round2(gResCol - (gEcartCol + gNonDecCol + gRegulCol));
const bDed = round2(gResDed - (gEcartDed + gNonDecDed + gRegulDed));
console.log(`  Soldes en base : 44551 ${fmt(gResCol)} (créditeur) · 34552 ${fmt(gResDed)} (débiteur)`);
console.log(`  Bouclage global : ${Math.abs(bCol) < 0.005 && Math.abs(bDed) < 0.005
  ? "✅ écart + attente = solde, au centime"
  : `⛔ reliquat 44551 ${fmt(bCol)} · 34552 ${fmt(bDed)}`}`);

if (CSV) {
  fs.writeFileSync(path.join(ROOT, CSV), csv.join("\n"), "utf8");
  console.log(`\n  📄 Détail écrit dans ${CSV} (séparateur « ; », ouvrable tel quel dans Excel fr).`);
}
console.log();
