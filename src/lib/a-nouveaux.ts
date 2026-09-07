// ============================================================================
// a-nouveaux.ts — L'écriture d'À-NOUVEAU, qui rouvre un exercice.
//
// ─── Pourquoi elle manquait, et ce qu'elle répare ────────────────────────────
// Depuis que les vues comptables sont bornées par exercice, un solde né dans un
// exercice antérieur DISPARAÎT de l'exercice courant. C'est correct pour un
// compte de résultat — le CA 2025 n'est pas le CA 2026 — mais faux pour un
// compte de BILAN : la dette de 24 600 MAD envers ACOSOLUTIONS, comptabilisée le
// 16/12/2025, est toujours due au 01/01/2026. Sans à-nouveau, la balance 2026
// affichait un 4411 amputé de cette dette.
//
// L'à-nouveau est la pièce qui règle cela : au premier jour de l'exercice, elle
// REPORTE les soldes de bilan de la clôture précédente.
//
// ─── La règle, et le piège ───────────────────────────────────────────────────
// Seuls les comptes de BILAN (classes 1 à 5) sont reportés. Les comptes de
// GESTION (classes 6 et 7) ne le sont jamais : ils sont soldés par la
// détermination du résultat, et c'est ce RÉSULTAT qui est reporté — au compte
// 1161 « Report à nouveau (solde créditeur) » s'il s'agit d'un bénéfice, au 1169
// « Report à nouveau (solde débiteur) » s'il s'agit d'une perte.
//
// C'est ce qui rend l'à-nouveau ÉQUILIBRÉ sans qu'on ait à le forcer : le grand
// livre d'un exercice se solde à zéro, donc Σ(bilan) = −Σ(gestion), et le report
// du résultat comble exactement l'écart des comptes de bilan. Une écriture
// d'à-nouveau qui ne s'équilibre pas signale un grand livre déjà déséquilibré en
// amont — on refuse alors de l'écrire plutôt que de propager le défaut.
//
// ─── Le piège du double comptage ─────────────────────────────────────────────
// Une fois l'à-nouveau posé, la dette ACOSOLUTIONS existe DEUX FOIS dans la
// base : sa ligne d'origine (ACH, 16/12/2025) et son report (AN, 01/01/2026).
// C'est normal — elles vivent dans deux exercices différents et ne se rencontrent
// jamais dans une vue bornée. Mais toute lecture « tous exercices confondus »
// doit EXCLURE le journal AN, sans quoi le solde double. `JOURNAL_AN` est exporté
// pour cela : c'est le seul discriminant.
//
// Logique pure — aucun accès base.
// ============================================================================

import { auditComptesSuspens, type AuditSuspens, type LigneBalance } from "./balance-comptable";

/** Journal technique des à-nouveaux. À exclure de toute vue multi-exercices. */
export const JOURNAL_AN = "AN";

/** Report à nouveau — bénéfice antérieur (solde créditeur). */
export const COMPTE_REPORT_CREDITEUR = "1161";
/** Report à nouveau — perte antérieure (solde débiteur). */
export const COMPTE_REPORT_DEBITEUR = "1169";

const r2 = (x: unknown) => Math.round((Number(x) || 0) * 100) / 100;
const nb = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const txt = (v: unknown) => String(v ?? "").trim();

export interface LigneSolde {
  compte_numero?: string | null;
  journal_code?: string | null;
  date_ecriture?: string | null;
  debit?: number | null;
  credit?: number | null;
}

/** Un compte de BILAN : classes 1 à 5. Les classes 6 et 7 sont de gestion. */
export const estCompteDeBilan = (compte: string | null | undefined): boolean =>
  /^[1-5]/.test(txt(compte));

/** Un compte de GESTION : classes 6 et 7. */
export const estCompteDeGestion = (compte: string | null | undefined): boolean =>
  /^[67]/.test(txt(compte));

export interface SoldesCloture {
  /** Solde par compte, SIGNÉ : positif = débiteur, négatif = créditeur. */
  parCompte: Map<string, number>;
  /** Σ des soldes de bilan, signée. */
  totalBilan: number;
  /** Σ des soldes de gestion, signée — le résultat de l'exercice, à l'envers. */
  totalGestion: number;
  /** Écart de la partie double sur la période lue. Doit valoir 0. */
  ecart: number;
}

/**
 * Date du DERNIER à-nouveau strictement antérieur à `avant`, ou `null`.
 *
 * C'est l'ANCRE de la clôture : cette pièce résume à elle seule tout ce qui la
 * précède. Un à-nouveau daté exactement de `avant` est ignoré — c'est celui
 * qu'on est en train de recalculer.
 */
export function dernierANouveau(lignes: LigneSolde[], avant: string): string | null {
  let ancre: string | null = null;
  for (const l of lignes ?? []) {
    if (txt(l.journal_code).toUpperCase() !== JOURNAL_AN) continue;
    const d = txt(l.date_ecriture).slice(0, 10);
    if (!d || d >= avant) continue;
    if (!ancre || d > ancre) ancre = d;
  }
  return ancre;
}

/**
 * Les lignes qui FORMENT la clôture au `avant` — et elles seules.
 *
 * ─── Le double comptage que cette fonction existe pour empêcher ─────────────
 * Un solde reporté vit DEUX FOIS en base : sur sa ligne d'origine et sur son
 * report. Prendre « tout ce qui précède » additionne donc les deux dès qu'un
 * à-nouveau intermédiaire existe. Le dossier SMERT le montrait : le 4712 porte
 * 41 500 (une seule ligne de banque, 2024-07-31), et une lecture cumulative en
 * annonçait 83 000 — l'origine plus son report par la pièce AN-2026.
 *
 * ─── La règle ───────────────────────────────────────────────────────────────
 * On s'ANCRE sur le dernier à-nouveau antérieur : il résume tout ce qui le
 * précède, donc on retient cette pièce PLUS les écritures ordinaires qui la
 * suivent. Les origines déjà reprises par l'ancre sortent.
 *
 * Sans ancre — dossier qui n'a jamais été rouvert — on retient tout ce qui
 * précède `avant` : c'est la lecture historique, et la seule qui ne perde rien
 * sur un dossier repris portant 2024 ET 2025 sans à-nouveau intermédiaire.
 *
 * ─── Pourquoi l'ancre ne peut PAS être remplacée par « écarter tous les AN » ─
 * Un dossier repris en cours de vie n'a parfois AUCUNE écriture d'origine : son
 * ouverture a été saisie comme à-nouveau. Écarter le journal AN y perdrait la
 * totalité du bilan. L'ancre garde ce cas et corrige l'autre.
 *
 * ─── Et le RÉSULTAT, alors ? ────────────────────────────────────────────────
 * L'ancre porte déjà le résultat des exercices antérieurs, converti en 1161 /
 * 1169 — un compte de BILAN, donc reporté comme un solde. Les comptes de
 * gestion retenus sont dès lors ceux de la seule période [ancre, avant) : le
 * résultat calculé est celui des exercices écoulés depuis, jamais deux fois le
 * même.
 */
export function lignesDeCloture(lignes: LigneSolde[], avant: string): LigneSolde[] {
  const ancre = dernierANouveau(lignes, avant);
  return (lignes ?? []).filter((l) => {
    const d = txt(l.date_ecriture).slice(0, 10);
    if (!d || d >= avant) return false;
    if (!ancre) return true;
    return txt(l.journal_code).toUpperCase() === JOURNAL_AN ? d === ancre : d >= ancre;
  });
}

/**
 * Soldes à la clôture, calculés sur les écritures qui la FORMENT.
 *
 * `avant` est exclusif et vaut le premier jour du nouvel exercice. Le périmètre
 * exact est celui de `lignesDeCloture` : ancré sur le dernier à-nouveau s'il en
 * existe un, cumulatif sinon. C'est ce qui rend l'appel sûr sur un dossier
 * qu'on rouvre pour la deuxième fois.
 */
export function soldesCloture(lignes: LigneSolde[], avant: string): SoldesCloture {
  const parCompte = new Map<string, number>();
  let ecart = 0;
  for (const l of lignesDeCloture(lignes, avant)) {
    const d = txt(l.date_ecriture).slice(0, 10);
    if (!d) continue;
    const c = txt(l.compte_numero);
    if (!c) continue;
    const mouvement = nb(l.debit) - nb(l.credit);
    parCompte.set(c, (parCompte.get(c) ?? 0) + mouvement);
    ecart += mouvement;
  }

  let totalBilan = 0, totalGestion = 0;
  for (const [compte, solde] of parCompte) {
    if (estCompteDeBilan(compte)) totalBilan += solde;
    else if (estCompteDeGestion(compte)) totalGestion += solde;
  }
  return { parCompte, totalBilan: r2(totalBilan), totalGestion: r2(totalGestion), ecart: r2(ecart) };
}

export interface LigneANouveau {
  dossier_id: string;
  journal_code: string;
  compte_numero: string;
  date_ecriture: string;
  libelle: string;
  debit: number;
  credit: number;
  reference_piece: string;
  valide: true;
}

export interface PlanANouveaux {
  lignes: LigneANouveau[];
  /** Résultat antérieur reporté, signé : négatif = bénéfice, positif = perte. */
  resultatReporte: number;
  /** Compte de report retenu — 1161 ou 1169. */
  compteReport: string;
  /** Écart de la partie double de l'écriture produite. Doit valoir 0. */
  ecart: number;
  /** Ce qui empêche d'écrire, en clair. Vide quand tout est conforme. */
  violations: string[];
  /**
   * Ce qui doit être VU sans empêcher d'écrire.
   *
   * Distinct de `violations` à dessein : un compte d'attente encore garni rend
   * l'arrêté douteux, pas impossible. Le confondre avec une violation
   * bloquerait la réouverture de l'exercice — un dossier sans exercice ouvert
   * coûte plus cher que le défaut signalé.
   */
  avertissements: string[];
  /** Détail du contrôle des comptes d'attente (47*) à la clôture reportée. */
  suspens: AuditSuspens;
}

export interface OptionsANouveaux {
  dossier_id: string;
  /** Premier jour de l'exercice rouvert — la date de l'écriture. */
  date: string;
  /** Référence de la pièce. Sert aussi de clef d'idempotence au script. */
  reference?: string;
  /** Seuil sous lequel un solde est considéré comme nul. */
  seuil?: number;
}

/**
 * L'écriture d'à-nouveau complète, à partir des soldes de clôture.
 *
 * Un compte au solde nul n'est pas reporté : une ligne à zéro n'apporte rien et
 * encombre le grand livre. Le résultat antérieur n'est reporté que s'il est lui
 * aussi non nul — un premier exercice sans activité ne produit aucune pièce.
 */
export function lignesANouveaux(
  soldes: SoldesCloture, options: OptionsANouveaux,
): PlanANouveaux {
  const seuil = options.seuil ?? 0.005;
  const reference = options.reference ?? `AN-${options.date.slice(0, 4)}`;
  const violations: string[] = [];

  if (Math.abs(soldes.ecart) > seuil) {
    violations.push(
      `Le grand livre antérieur est DÉSÉQUILIBRÉ de ${soldes.ecart.toFixed(2)} MAD : `
      + "reporter des soldes faux propagerait le défaut dans le nouvel exercice.",
    );
  }

  const base = {
    dossier_id: options.dossier_id,
    journal_code: JOURNAL_AN,
    date_ecriture: options.date,
    reference_piece: reference,
    valide: true as const,
  };

  const lignes: LigneANouveau[] = [];
  // Ordre stable : le grand livre se lit par numéro de compte croissant.
  for (const compte of [...soldes.parCompte.keys()].sort()) {
    if (!estCompteDeBilan(compte)) continue;
    const solde = r2(soldes.parCompte.get(compte));
    if (Math.abs(solde) < seuil) continue;
    lignes.push({
      ...base, compte_numero: compte,
      libelle: `À-nouveau ${options.date.slice(0, 4)} — ${compte}`,
      debit: solde > 0 ? solde : 0,
      credit: solde < 0 ? -solde : 0,
    });
  }

  // Le résultat antérieur : Σ(gestion) signée. Positif = charges > produits =
  // PERTE, qui se reporte au DÉBIT du 1169. Négatif = bénéfice, au CRÉDIT du 1161.
  const resultatReporte = soldes.totalGestion;
  const compteReport = resultatReporte > 0 ? COMPTE_REPORT_DEBITEUR : COMPTE_REPORT_CREDITEUR;
  if (Math.abs(resultatReporte) >= seuil) {
    lignes.push({
      ...base, compte_numero: compteReport,
      libelle: `Report à nouveau — résultat des exercices antérieurs`,
      debit: resultatReporte > 0 ? r2(resultatReporte) : 0,
      credit: resultatReporte < 0 ? r2(-resultatReporte) : 0,
    });
  }

  const ecart = r2(lignes.reduce((s, l) => s + l.debit - l.credit, 0));
  if (Math.abs(ecart) > seuil) {
    violations.push(`L'écriture d'à-nouveau ne s'équilibre pas (écart ${ecart.toFixed(2)} MAD).`);
  }

  // ── Contrôle d'audit : comptes d'attente non apurés ───────────────────────
  // Le moment est le bon : c'est ICI que l'exercice change, et c'est ici qu'un
  // 4712 garni cesse d'être une anomalie de l'exercice clos pour devenir le
  // solde d'ouverture du suivant. On le calcule sur les soldes REPORTÉS, donc
  // sur ce que l'à-nouveau va réellement propager.
  const suspens = auditComptesSuspens(
    [...soldes.parCompte.entries()].map(([compte, solde]): LigneBalance => ({
      compte,
      total_debit: solde > 0 ? r2(solde) : 0,
      total_credit: solde < 0 ? r2(-solde) : 0,
      solde: Math.abs(r2(solde)),
      sens: solde >= 0 ? "D" : "C",
    })),
    { seuil },
  );
  const avertissements = suspens.alerte ? [suspens.alerte] : [];

  return { lignes, resultatReporte, compteReport, ecart, violations, avertissements, suspens };
}

/** Même production, mais BLOQUANTE — la porte qu'emprunte le script d'écriture. */
export function assertANouveaux(plan: PlanANouveaux): void {
  if (plan.violations.length) {
    throw new Error(`À-nouveau non conforme — ${plan.violations.join(" ")}`);
  }
}

/**
 * Écarte les à-nouveaux d'une collection d'écritures.
 *
 * À appeler dès qu'une lecture couvre PLUSIEURS exercices : sans cela, chaque
 * solde reporté est compté deux fois — une fois sur sa ligne d'origine, une fois
 * sur son report.
 */
export function sansANouveaux<T extends { journal_code?: string | null }>(lignes: T[]): T[] {
  return (lignes ?? []).filter((l) => txt(l.journal_code).toUpperCase() !== JOURNAL_AN);
}
