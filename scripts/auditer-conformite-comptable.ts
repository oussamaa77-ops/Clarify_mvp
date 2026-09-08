/**
 * auditer-conformite-comptable.ts — LE contrôle de conformité de toute la base,
 * tous dossiers confondus, en une passe.
 *
 * ─── Pourquoi un audit global ────────────────────────────────────────────────
 * Les verrous existants agissent au moment d'ÉCRIRE : `controlerEcrituresRegime`
 * refuse une pièce non conforme, le trigger `trg_normaliser_compte_numero`
 * recanonise les numéros. Ils protègent l'avenir. Ils ne disent rien de ce qui
 * est DÉJÀ en base — écrit avant qu'ils n'existent, ou par un chemin qui les
 * contournait (console SQL, script de reprise, import).
 *
 * Ce script répond donc à une seule question, dossier par dossier : « si les
 * règles d'aujourd'hui avaient toujours été appliquées, cette base serait-elle
 * celle-ci ? » Chaque écart est nommé, chiffré, et rattaché au dossier porteur.
 *
 * ─── Ce qu'il vérifie, et ce que chaque écart signifie ───────────────────────
 *  1. CONFORMITÉ DES NUMÉROS — tout compte doit faire 8 chiffres. Deux
 *     longueurs pour un même compte, c'est deux lignes de balance et un export
 *     Sage refusé (cf. src/lib/numero-compte.ts).
 *  2. RÉGIME DES ENCAISSEMENTS — aucune TVA exigible (4455x/3455x) dans un
 *     journal de facturation. Une TVA posée dès la facture est déclarée, et
 *     payée, avant d'être encaissée.
 *  3. TRÉSORERIE HORS OD — aucun 5141x/5161x en journal OD. Logé là, un
 *     mouvement d'argent échappe au rapprochement bancaire : c'est le chemin
 *     qui produisait la « trésorerie fictive ».
 *  4. COMPTES D'ATTENTE 47* — un parking non apuré fausse le résultat et
 *     traverse l'exercice par l'à-nouveau (cf. balance-comptable.ts).
 *  5. TVA DÉCLARÉE PAR ANTICIPATION — 44551 débiteur ou 34552 créditeur : une
 *     position anormale pour ces comptes, qui dit qu'on a déclaré plus qu'on
 *     n'a encaissé. Le script chiffre l'écart PÉRIODE PAR PÉRIODE, jamais sur
 *     le solde : le solde agrège les périodes et en soustrait ce qui est devenu
 *     exigible depuis (cf. mémoire « regularisation-tva-hors-flux »).
 *  6. PARTIE DOUBLE — Σ débits = Σ crédits, par dossier.
 *  7. DOUBLE COMPTE D'À-NOUVEAU — une pièce AN qui coexiste avec les écritures
 *     d'origine qu'elle reprend : tout total « tous exercices » qui n'écarte pas
 *     le journal AN est faux du montant reporté.
 *  8. SENS DES RÈGLEMENTS — un compte fournisseur crédité (ou client débité) en
 *     journal de trésorerie. L'écriture reste ÉQUILIBRÉE, donc invisible pour
 *     tout contrôle de partie double.
 *  9. MOUVEMENTS DU 4456 — hors déclaration, régularisation ou paiement DGI, le
 *     solde du compte de liquidation n'est plus explicable par un acte fiscal.
 * 10. BASCULES SANS RÈGLEMENT — une TVA rendue exigible sans qu'aucune écriture
 *     de trésorerie ne l'appuie.
 *
 * Les contrôles 2, 3 et 4 ne sont pas réimplémentés : ils appellent
 * `controlerTvaOrigine`, `controlerJournalOd` et `auditComptesSuspens`, c'est-à-dire
 * EXACTEMENT le code qui garde les écritures à l'insertion. Un audit qui
 * redéfinirait la règle finirait par diverger de celle qu'on applique.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   node --import tsx scripts/auditer-conformite-comptable.ts
 *   node --import tsx scripts/auditer-conformite-comptable.ts --dossier="SMERT"
 *   node --import tsx scripts/auditer-conformite-comptable.ts --json
 *   node --import tsx scripts/auditer-conformite-comptable.ts --quiet   (verdict seul)
 *
 * LECTURE SEULE : aucun insert, update ni delete. Pas de `--apply`, et c'est
 * délibéré — corriger relève de scripts dédiés, qui sauvegardent et savent
 * revenir en arrière.
 *
 * CODE DE SORTIE — pensé pour servir de garde-fou automatisable :
 *   0 = conforme · 1 = au moins une anomalie · 2 = l'audit lui-même a échoué.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { normaliserNumeroCompte, LARGEUR_COMPTE } from "../src/lib/numero-compte";
import {
  controlerTvaOrigine, controlerJournalOd, estTvaExigible, estTresorerieHorsOd,
  controlerSensReglement, controlerMouvementsTvaDue, controlerPreuveBascule,
  estBasculeTva, estJournalReglement, JOURNAUX_FACTURATION,
} from "../src/lib/genererEcritures";
import { auditComptesSuspens, type LigneBalance } from "../src/lib/balance-comptable";
import { sansANouveaux } from "../src/lib/a-nouveaux";
import {
  liquiderTva, bornesPeriode, RACINE_COLLECTEE, RACINE_DEDUCTIBLE,
  PREFIXE_DECLARATION_TVA, PREFIXE_REGULARISATION_TVA,
} from "../src/lib/liquidation-tva";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const flag = (nom: string) => {
  const hit = argv.find((a) => a === `--${nom}` || a.startsWith(`--${nom}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf("=");
  return eq === -1 ? "" : hit.slice(eq + 1).replace(/^["']|["']$/g, "");
};
const CIBLE = flag("dossier") || null;
const JSON_OUT = flag("json") !== undefined;
const QUIET = flag("quiet") !== undefined;

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env"), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
) as Record<string, string>;

// Le proxy TLS de l'entreprise casse le `fetch` global ; undici en direct passe
// (cf. mémoire « proxy-supabase-server »). On n'essaie le repli qu'une fois.
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
const sb = createClient(env.SUPABASE_URL || env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  global: { fetch: proxyFetch as any }, auth: { persistSession: false, autoRefreshToken: false },
});

const nb = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const txt = (v: unknown) => String(v ?? "").trim();
const r2 = (x: number) => Math.round(x * 100) / 100;
const fmt = (x: number) => x.toLocaleString("fr-MA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const jour = (l: any) => txt(l.date_ecriture).slice(0, 10);
const say = (...a: unknown[]) => { if (!JSON_OUT && !QUIET) console.log(...a); };

/** Gravité d'un écart. Un `bloquant` fait sortir en 1 ; un `signal` informe. */
type Gravite = "bloquant" | "signal";

interface Anomalie {
  code: string;
  gravite: Gravite;
  message: string;
  /** Montant en jeu, quand l'écart en a un. */
  montant?: number;
  /** Quelques lignes ou comptes en cause, pour aller voir. */
  exemples?: string[];
}

interface RapportDossier {
  dossier: string;
  dossierId: string;
  nbEcritures: number;
  anomalies: Anomalie[];
}

/** PostgREST plafonne à 1000 lignes : sans pagination, un gros dossier est tronqué en silence. */
async function toutesLesEcritures(dossierId: string): Promise<any[]> {
  let tout: any[] = [], de = 0;
  for (;;) {
    const { data, error } = await sb.from("ecritures_comptables")
      // `lettrage_code` et `facture_id` NE SONT PAS optionnels ici : ce sont deux
      // des trois preuves qu'accepte `controlerPreuveBascule`. Les omettre
      // rendrait toute bascule lettrée « sans règlement » — la lib serait juste,
      // et l'audit mentirait (cf. mémoire select-reduit-affame-le-generateur).
      .select("id,compte_numero,journal_code,date_ecriture,debit,credit,reference_piece,libelle,lettrage_code,facture_id")
      .eq("dossier_id", dossierId).range(de, de + 999);
    if (error) throw new Error(`ecritures_comptables : ${error.message}`);
    tout = tout.concat(data ?? []);
    if ((data ?? []).length < 1000) break;
    de += 1000;
  }
  return tout;
}

// ─── 1. Conformité des numéros de comptes ───────────────────────────────────
function auditerNumeros(lignes: any[], comptesPlan: any[]): Anomalie[] {
  const out: Anomalie[] = [];

  const nonConformes = new Map<string, number>();
  for (const l of lignes) {
    const c = txt(l.compte_numero);
    if (!c) { nonConformes.set("(vide)", (nonConformes.get("(vide)") ?? 0) + 1); continue; }
    if (c !== normaliserNumeroCompte(c)) nonConformes.set(c, (nonConformes.get(c) ?? 0) + 1);
  }
  if (nonConformes.size) {
    const total = [...nonConformes.values()].reduce((s, n) => s + n, 0);
    out.push({
      code: "COMPTE_NON_CANONIQUE",
      gravite: "bloquant",
      message: `${total} écriture(s) sur ${nonConformes.size} compte(s) hors forme canonique `
        + `(${LARGEUR_COMPTE} chiffres). Le même compte existe en deux longueurs : deux lignes `
        + `de balance, et un export Sage qui en refuse une sur deux.`,
      exemples: [...nonConformes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
        .map(([c, n]) => `${c} → ${normaliserNumeroCompte(c)} (${n} ligne(s))`),
    });
  }

  const planNonConforme = comptesPlan
    .map((c) => txt(c.numero))
    .filter((c) => c && c !== normaliserNumeroCompte(c));
  if (planNonConforme.length) {
    out.push({
      code: "PLAN_NON_CANONIQUE",
      gravite: "bloquant",
      message: `${planNonConforme.length} compte(s) du plan comptable hors forme canonique.`,
      exemples: planNonConforme.slice(0, 8).map((c) => `${c} → ${normaliserNumeroCompte(c)}`),
    });
  }

  // Deux comptes distincts qui se ramènent au MÊME compte réel : la normalisation
  // n'a pas pu les fusionner (unicité), c'est un arbitrage humain.
  const parCanonique = new Map<string, Set<string>>();
  for (const c of comptesPlan) {
    const brut = txt(c.numero);
    if (!brut) continue;
    const cle = normaliserNumeroCompte(brut);
    if (!parCanonique.has(cle)) parCanonique.set(cle, new Set());
    parCanonique.get(cle)!.add(brut);
  }
  const doublons = [...parCanonique.entries()].filter(([, v]) => v.size > 1);
  if (doublons.length) {
    out.push({
      code: "PLAN_DOUBLON_CANONIQUE",
      gravite: "bloquant",
      message: `${doublons.length} compte(s) en DOUBLE sous une même forme canonique — `
        + `à fusionner à la main (les soldes initiaux ne s'additionnent pas sans arbitrage).`,
      exemples: doublons.slice(0, 8).map(([k, v]) => `${k} ← ${[...v].join(" / ")}`),
    });
  }

  return out;
}

// ─── 2 et 3. Régime des encaissements et trésorerie hors OD ─────────────────
// On appelle les MÊMES contrôles que l'insertion, pas une copie.
function auditerRegime(lignes: any[]): Anomalie[] {
  const out: Anomalie[] = [];

  const tva = controlerTvaOrigine(lignes);
  if (!tva.ok) {
    const fautives = lignes.filter((l) =>
      JOURNAUX_FACTURATION.includes(txt(l.journal_code).toUpperCase() as any)
      && estTvaExigible(l.compte_numero));
    out.push({
      code: "TVA_EXIGIBLE_EN_FACTURATION",
      gravite: "bloquant",
      message: `Régime des encaissements violé : ${tva.violations.join(" ")} `
        + `Une TVA posée dès la facture est déclarée — et payée — avant d'être encaissée.`,
      montant: r2(fautives.reduce((s, l) => s + Math.abs(nb(l.debit) - nb(l.credit)), 0)),
      exemples: fautives.slice(0, 6).map((l) =>
        `${txt(l.date_ecriture).slice(0, 10)} ${txt(l.journal_code)} ${txt(l.compte_numero)} ${txt(l.reference_piece)}`),
    });
  }

  // Verrou 5 — le sens d'un règlement. Une écriture inversée reste ÉQUILIBRÉE,
  // donc aucun contrôle de partie double ne la voit : c'est ce contrôle, et lui
  // seul, qui la révèle sur l'existant.
  const sens = controlerSensReglement(lignes);
  if (!sens.ok) {
    out.push({
      code: "REGLEMENT_SENS_INVERSE",
      gravite: "bloquant",
      message: sens.violations.join(" "),
    });
  }

  // Verrou 6 — le 4456 ne se manie que par déclaration, régularisation ou
  // paiement DGI. Hors de là, son solde n'est plus explicable.
  const tvaDue = controlerMouvementsTvaDue(lignes);
  if (!tvaDue.ok) {
    out.push({
      code: "TVA_DUE_MOUVEMENT_LIBRE",
      gravite: "bloquant",
      message: tvaDue.violations.join(" "),
    });
  }

  const od = controlerJournalOd(lignes);
  if (!od.ok) {
    const fautives = lignes.filter((l) =>
      txt(l.journal_code).toUpperCase() === "OD" && estTresorerieHorsOd(l.compte_numero));
    out.push({
      code: "TRESORERIE_EN_OD",
      gravite: "bloquant",
      message: `Trésorerie en journal OD : ${od.violations.join(" ")} `
        + `Logé en OD, un mouvement d'argent échappe au rapprochement bancaire.`,
      montant: r2(fautives.reduce((s, l) => s + Math.abs(nb(l.debit) - nb(l.credit)), 0)),
      exemples: fautives.slice(0, 6).map((l) =>
        `${txt(l.date_ecriture).slice(0, 10)} ${txt(l.compte_numero)} ${txt(l.reference_piece)}`),
    });
  }

  return out;
}

// ─── 4. Comptes d'attente 47* non apurés ────────────────────────────────────
function auditerSuspens(lignes: any[]): Anomalie[] {
  const parCompte = new Map<string, { d: number; c: number }>();
  for (const l of lignes) {
    const c = txt(l.compte_numero);
    if (!c) continue;
    const cell = parCompte.get(c) ?? { d: 0, c: 0 };
    cell.d += nb(l.debit); cell.c += nb(l.credit);
    parCompte.set(c, cell);
  }
  const balance: LigneBalance[] = [...parCompte.entries()].map(([compte, v]) => ({
    compte, total_debit: r2(v.d), total_credit: r2(v.c),
    solde: Math.abs(r2(v.d - v.c)), sens: v.d >= v.c ? "D" : "C",
  }));

  const audit = auditComptesSuspens(balance);
  if (audit.apure) return [];
  return [{
    code: "COMPTE_ATTENTE_NON_APURE",
    gravite: "signal",
    message: audit.alerte!,
    montant: audit.total,
    exemples: audit.comptes.map((c) => `${c.compte} ${fmt(c.solde)} ${c.sens}`
      + (c.attenteBancaire ? " (mouvement de banque sans pièce)" : "")),
  }];
}

// ─── 5. TVA déclarée par anticipation ───────────────────────────────────────
// Le solde ne suffit PAS à chiffrer : il agrège les périodes et en soustrait ce
// qui est devenu exigible depuis. On chiffre donc période déclarée par période
// déclarée, et on ne retient que celles qui portent réellement un écart.
function auditerTvaAnticipee(lignes: any[]): Anomalie[] {
  const out: Anomalie[] = [];

  const soldeCol = r2(lignes.filter((l) => txt(l.compte_numero).startsWith(RACINE_COLLECTEE))
    .reduce((s, l) => s + nb(l.credit) - nb(l.debit), 0));
  const soldeDed = r2(lignes.filter((l) => txt(l.compte_numero).startsWith(RACINE_DEDUCTIBLE))
    .reduce((s, l) => s + nb(l.debit) - nb(l.credit), 0));

  // Position ANORMALE : 44551 débiteur (déclaré d'avance) ou 34552 créditeur
  // (déduit d'avance). Ces comptes n'ont pas vocation à s'inverser.
  const anormalCollecte = r2(Math.max(0, -soldeCol));
  const anormalDeduction = r2(Math.max(0, -soldeDed));

  // Périodes DÉCLARÉES, et ce qu'elles auraient dû porter.
  const periodes = new Set<string>();
  for (const l of lignes) {
    const ref = txt(l.reference_piece);
    if (ref.startsWith(PREFIXE_DECLARATION_TVA)) {
      const p = ref.slice(PREFIXE_DECLARATION_TVA.length);
      if (bornesPeriode(p)) periodes.add(p);
    }
  }
  const dejaRegularisees = new Set<string>();
  for (const l of lignes) {
    const ref = txt(l.reference_piece);
    if (ref.startsWith(PREFIXE_REGULARISATION_TVA)) {
      dejaRegularisees.add(ref.slice(PREFIXE_REGULARISATION_TVA.length));
    }
  }

  const ecarts: string[] = [];
  let totalEcart = 0;
  for (const p of [...periodes].sort()) {
    const piece = lignes.filter((l) => txt(l.reference_piece) === `${PREFIXE_DECLARATION_TVA}${p}`);
    // La déclaration SOLDE les comptes : elle débite la collectée, crédite la
    // déductible. Le montant déclaré se lit donc à l'envers du sens du compte.
    const declCol = r2(piece.filter((l) => txt(l.compte_numero).startsWith(RACINE_COLLECTEE))
      .reduce((s, l) => s + nb(l.debit) - nb(l.credit), 0));
    const declDed = r2(piece.filter((l) => txt(l.compte_numero).startsWith(RACINE_DEDUCTIBLE))
      .reduce((s, l) => s + nb(l.credit) - nb(l.debit), 0));
    const liq = liquiderTva(lignes, p);
    if (!liq) continue;
    const ecartCol = r2(liq.collectee - declCol);
    const ecartDed = r2(liq.deductible - declDed);
    if (Math.abs(ecartCol) < 0.005 && Math.abs(ecartDed) < 0.005) continue;

    const marque = dejaRegularisees.has(p) ? " [déjà régularisée]" : "";
    if (Math.abs(ecartCol) >= 0.005) {
      ecarts.push(`${p} collectée : déclarée ${fmt(declCol)} vs réelle ${fmt(liq.collectee)} `
        + `→ écart ${fmt(ecartCol)}${marque}`);
      if (!dejaRegularisees.has(p)) totalEcart += Math.abs(ecartCol);
    }
    if (Math.abs(ecartDed) >= 0.005) {
      ecarts.push(`${p} déductible : déclarée ${fmt(declDed)} vs réelle ${fmt(liq.deductible)} `
        + `→ écart ${fmt(ecartDed)}${marque}`);
      if (!dejaRegularisees.has(p)) totalEcart += Math.abs(ecartDed);
    }
  }

  if (anormalCollecte > 0.005 || anormalDeduction > 0.005) {
    const quoi = [
      anormalCollecte > 0.005 ? `44551 DÉBITEUR de ${fmt(anormalCollecte)} (TVA collectée déclarée d'avance)` : null,
      anormalDeduction > 0.005 ? `34552 CRÉDITEUR de ${fmt(anormalDeduction)} (TVA déduite d'avance)` : null,
    ].filter(Boolean).join(" · ");
    out.push({
      code: "TVA_POSITION_ANORMALE",
      gravite: "signal",
      message: `Position de TVA anormale : ${quoi}. Ces comptes n'ont pas vocation à s'inverser — `
        + `on a déclaré plus qu'on n'a encaissé. À reprendre par une écriture HORS FLUX `
        + `(scripts/regulariser-tva-anticipee.mjs), période par période et jamais sur le solde.`,
      montant: r2(anormalCollecte + anormalDeduction),
    });
  }

  if (ecarts.length) {
    out.push({
      code: "TVA_ECART_DECLARE",
      gravite: totalEcart > 0.005 ? "bloquant" : "signal",
      message: `${ecarts.length} écart(s) entre déclaration déposée et position recalculée`
        + (totalEcart > 0.005
          ? `, dont ${fmt(r2(totalEcart))} NON encore régularisé(s).`
          : ` — tous déjà repris par une régularisation.`),
      montant: r2(totalEcart),
      exemples: ecarts.slice(0, 8),
    });
  }

  return out;
}

// ─── 6. Partie double ───────────────────────────────────────────────────────
function auditerPartieDouble(lignes: any[]): Anomalie[] {
  const debit = r2(lignes.reduce((s, l) => s + nb(l.debit), 0));
  const credit = r2(lignes.reduce((s, l) => s + nb(l.credit), 0));
  const ecart = r2(debit - credit);
  if (Math.abs(ecart) < 0.01) return [];
  return [{
    code: "PARTIE_DOUBLE_ROMPUE",
    gravite: "bloquant",
    message: `Grand livre DÉSÉQUILIBRÉ de ${fmt(ecart)} MAD (Σ débits ${fmt(debit)} vs `
      + `Σ crédits ${fmt(credit)}). Aucun état financier n'est exploitable tant qu'il l'est.`,
    montant: Math.abs(ecart),
  }];
}

// ─── 6 bis. Bascules de TVA sans règlement constaté ─────────────────────────
//
// Le verrou 7 empêche d'en créer de nouvelles ; ce contrôle trouve celles qui
// existaient déjà. On regroupe par pièce — référence + date — parce que c'est
// l'unité qu'une bascule occupe, et on soumet chaque groupe au MÊME contrôle
// que l'insertion.
function auditerBasculesSansPreuve(lignes: any[]): Anomalie[] {
  const tresorerie = lignes.filter((l) => estJournalReglement(l.journal_code));
  const parPiece = new Map<string, any[]>();
  for (const l of lignes) {
    if (txt(l.journal_code).toUpperCase() !== "OD") continue;
    const cle = `${txt(l.reference_piece)}|${jour(l)}`;
    if (!parPiece.has(cle)) parPiece.set(cle, []);
    parPiece.get(cle)!.push(l);
  }

  const orphelines: string[] = [];
  let montant = 0;
  for (const [cle, piece] of parPiece) {
    if (!estBasculeTva(piece)) continue;
    if (controlerPreuveBascule(piece, tresorerie).ok) continue;
    const [ref, date] = cle.split("|");
    const tva = r2(piece.reduce((s, l) => s + Math.max(nb(l.debit), nb(l.credit)), 0) / 2);
    montant += tva;
    orphelines.push(`${date} « ${ref || "sans référence"} » — ${fmt(tva)} MAD`);
  }
  if (!orphelines.length) return [];

  return [{
    code: "BASCULE_SANS_REGLEMENT",
    gravite: "bloquant",
    message: `${orphelines.length} bascule(s) de TVA qu'aucune écriture de trésorerie n'appuie. `
      + `Sous le régime des encaissements le fait générateur est le mouvement d'argent : `
      + `sans lui, la TVA a été rendue exigible (ou déductible) alors qu'aucun euro n'avait bougé.`,
    montant: r2(montant),
    exemples: orphelines.slice(0, 8),
  }];
}

// ─── 7. À-nouveau et double compte ──────────────────────────────────────────
// Un solde reporté existe DEUX FOIS en base : sur sa ligne d'origine et sur son
// report (journal AN). Bornés à un exercice, les deux ne se rencontrent jamais ;
// cumulés, ils doublent le solde. Tout ce qui lit « tous exercices confondus »
// doit donc écarter le journal AN — `sansANouveaux` est là pour ça.
//
// Ce contrôle signale les dossiers OÙ LE PIÈGE EST ARMÉ : une pièce d'à-nouveau
// coexiste avec les écritures d'origine qu'elle reprend. Le chiffre exact du
// double compte est donné, parce que c'est lui qu'on retrouve dans un total
// inexpliqué — et parce qu'un outil qui oublie le filtre ne le dira pas.
//
// Les deux lecteurs du projet sont désormais protégés : la page Comptabilité
// applique `sansANouveaux` en vue « tous exercices », et `soldesCloture`
// s'ancre sur le dernier à-nouveau. Ce contrôle reste utile pour ce qui
// viendra APRÈS — une requête SQL à la main, un export, un futur écran — et
// parce qu'il chiffre l'écart qu'on constaterait alors.
function auditerDoubleCompteAn(brutes: any[]): Anomalie[] {
  const an = brutes.filter((l) => txt(l.journal_code).toUpperCase() === "AN");
  if (!an.length) return [];

  const dateAn = an.map((l) => txt(l.date_ecriture).slice(0, 10)).sort()[0];
  const originesReprises = brutes.filter((l) =>
    txt(l.journal_code).toUpperCase() !== "AN"
    && txt(l.date_ecriture).slice(0, 10) < dateAn);
  if (!originesReprises.length) return [];

  const doubleCompte = r2(an.reduce((s, l) => s + Math.abs(nb(l.debit) - nb(l.credit)), 0));
  const comptes = [...new Set(an.map((l) => txt(l.compte_numero)))].sort();

  return [{
    code: "AN_DOUBLE_COMPTE_ARME",
    gravite: "signal",
    message: `Une pièce d'à-nouveau au ${dateAn} coexiste avec les `
      + `${originesReprises.length} écriture(s) d'origine qu'elle reprend. Toute lecture `
      + `« tous exercices » qui n'écarte pas le journal AN double ces soldes — `
      + `${fmt(doubleCompte)} MAD au total. Les lecteurs du projet sont protégés `
      + `(sansANouveaux côté écran, ancrage de soldesCloture côté à-nouveau) : `
      + `ceci vise une requête SQL à la main ou un futur consommateur.`,
    montant: doubleCompte,
    exemples: comptes.slice(0, 8).map((c) => {
      const origine = r2(brutes.filter((l) => txt(l.compte_numero) === c
        && txt(l.journal_code).toUpperCase() !== "AN")
        .reduce((s, l) => s + nb(l.debit) - nb(l.credit), 0));
      const report = r2(an.filter((l) => txt(l.compte_numero) === c)
        .reduce((s, l) => s + nb(l.debit) - nb(l.credit), 0));
      return `${c} : origine ${fmt(origine)} + report ${fmt(report)} `
        + `→ ${fmt(r2(origine + report))} si le journal AN n'est pas écarté`;
    }),
  }];
}

// ─── Passe principale ───────────────────────────────────────────────────────
async function main(): Promise<number> {
  let q = sb.from("dossiers").select("id,nom_societe");
  if (CIBLE) {
    q = /^[0-9a-f-]{36}$/i.test(CIBLE) ? q.eq("id", CIBLE) : q.ilike("nom_societe", `%${CIBLE}%`);
  }
  const { data: dossiers, error } = await q.order("nom_societe");
  if (error) { console.error(`❌ dossiers : ${error.message}`); return 2; }
  if (!(dossiers ?? []).length) { console.error(`❌ aucun dossier${CIBLE ? ` pour « ${CIBLE} »` : ""}`); return 2; }

  say(`\n🔎 AUDIT DE CONFORMITÉ COMPTABLE — ${(dossiers ?? []).length} dossier(s)`);
  say(`   Lecture seule. Les règles appliquées sont celles du code d'insertion.\n`);

  const rapports: RapportDossier[] = [];

  for (const d of dossiers ?? []) {
    const brutes = await toutesLesEcritures(d.id);
    // Vue TOUS EXERCICES : les à-nouveaux doivent sortir, sinon chaque solde
    // reporté est compté deux fois (cf. src/lib/a-nouveaux.ts).
    const lignes = sansANouveaux(brutes);

    const { data: plan } = await sb.from("comptes_comptables")
      .select("numero").eq("dossier_id", d.id);

    const anomalies: Anomalie[] = [
      ...auditerNumeros(brutes, (plan ?? []) as any[]),
      ...auditerRegime(lignes),
      ...auditerSuspens(lignes),
      ...auditerTvaAnticipee(lignes),
      ...auditerPartieDouble(lignes),
      ...auditerBasculesSansPreuve(lignes),
      ...auditerDoubleCompteAn(brutes),
    ];

    rapports.push({ dossier: d.nom_societe, dossierId: d.id, nbEcritures: brutes.length, anomalies });

    const bloquants = anomalies.filter((a) => a.gravite === "bloquant").length;
    const signaux = anomalies.filter((a) => a.gravite === "signal").length;
    const badge = bloquants ? "❌" : signaux ? "⚠️ " : "✅";
    say(`${badge} ${d.nom_societe}  —  ${brutes.length} écriture(s)`
      + (anomalies.length ? `  ·  ${bloquants} bloquant(s), ${signaux} signal(aux)` : "  ·  conforme"));

    for (const a of anomalies) {
      say(`     ${a.gravite === "bloquant" ? "❌" : "⚠️ "} [${a.code}]${a.montant ? ` ${fmt(a.montant)} MAD` : ""}`);
      say(`        ${a.message}`);
      for (const e of a.exemples ?? []) say(`          · ${e}`);
    }
    if (anomalies.length) say("");
  }

  // ─── Synthèse ─────────────────────────────────────────────────────────────
  const parCode = new Map<string, { n: number; montant: number; gravite: Gravite }>();
  for (const r of rapports) {
    for (const a of r.anomalies) {
      const cell = parCode.get(a.code) ?? { n: 0, montant: 0, gravite: a.gravite };
      cell.n += 1; cell.montant += a.montant ?? 0;
      // Un même code peut être bloquant ici et simple signal là : le plus grave gagne.
      if (a.gravite === "bloquant") cell.gravite = "bloquant";
      parCode.set(a.code, cell);
    }
  }
  const bloquants = [...parCode.values()].filter((v) => v.gravite === "bloquant").length;
  const dossiersEnDefaut = rapports.filter((r) => r.anomalies.length).length;

  if (JSON_OUT) {
    console.log(JSON.stringify({
      date: new Date().toISOString(),
      nbDossiers: rapports.length,
      dossiersEnDefaut,
      conforme: dossiersEnDefaut === 0,
      parCode: Object.fromEntries([...parCode.entries()].map(([k, v]) => [k, v])),
      rapports,
    }, null, 2));
  } else {
    say(`${"═".repeat(78)}`);
    say(`  SYNTHÈSE`);
    say(`${"═".repeat(78)}`);
    if (!parCode.size) {
      say(`  ✅ ${rapports.length} dossier(s) — aucune anomalie.`);
    } else {
      for (const [code, v] of [...parCode.entries()].sort((a, b) =>
        (a[1].gravite === b[1].gravite ? 0 : a[1].gravite === "bloquant" ? -1 : 1) || b[1].n - a[1].n)) {
        say(`  ${v.gravite === "bloquant" ? "❌" : "⚠️ "} ${code.padEnd(30)} ${String(v.n).padStart(3)} dossier(s)`
          + (v.montant ? `   ${fmt(r2(v.montant)).padStart(14)} MAD` : ""));
      }
      say(`\n  ${dossiersEnDefaut}/${rapports.length} dossier(s) en défaut · ${bloquants} code(s) bloquant(s)`);
    }
  }

  if (QUIET) {
    console.log(dossiersEnDefaut === 0
      ? `CONFORME — ${rapports.length} dossier(s)`
      : `NON CONFORME — ${dossiersEnDefaut}/${rapports.length} dossier(s), ${bloquants} code(s) bloquant(s)`);
  }

  return dossiersEnDefaut === 0 ? 0 : 1;
}

try {
  process.exit(await main());
} catch (e: any) {
  console.error(`\n❌ L'audit a échoué : ${e?.message ?? e}`);
  console.error(`   (code 2 : c'est l'audit qui n'a pas pu conclure, pas la base qui est fautive)\n`);
  process.exit(2);
}
