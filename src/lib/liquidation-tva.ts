// ============================================================================
// liquidation-tva.ts — Déclaration périodique de TVA (SIMPL-TVA) et son paiement.
//
// ─── Ce que la déclaration fait, comptablement ───────────────────────────────
// Pendant la période, deux comptes se chargent : 44551 « TVA facturée » au
// crédit à mesure des encaissements, 34552 « TVA récupérable sur charges » au
// débit à mesure des décaissements. Ils ne se soldent JAMAIS d'eux-mêmes ni par
// lettrage — c'est la déclaration qui les remet à zéro et transforme leur écart
// en une DETTE (ou une créance) envers l'État :
//
//   D 44551   Σ TVA collectée de la période      (on solde le compte)
//   C 34552   Σ TVA déductible de la période     (on solde le compte)
//   C 4456    différence                          (État — TVA due)
//
// Puis le prélèvement de la DGI éteint cette dette :
//
//   D 4456    montant déclaré
//   C 5141    banque
//
// À la fin de ce cycle, 44551, 34552 et 4456 sont tous les trois à 0,00 : c'est
// le contrôle qui prouve que la période est réellement soldée.
//
// ─── Le cas du CRÉDIT DE TVA ─────────────────────────────────────────────────
// Quand la TVA déductible dépasse la collectée, il n'y a pas de dette mais un
// crédit reportable. Le sens de la troisième ligne s'inverse (D 4456), et rien
// n'est prélevé. Traiter ce cas comme une dette négative produirait une écriture
// à montant négatif, que ni Sage ni la DGI n'acceptent.
//
// Logique pure : l'écran, l'écriture générée et le contrôle de cohérence
// consomment le MÊME calcul.
// ============================================================================

const round2 = (x: number) => Math.round(x * 100) / 100;
const nb = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const txt = (v: unknown) => String(v ?? "").trim();

/** Comptes de la liquidation — mêmes numéros que le régime des encaissements. */
export const COMPTE_TVA_COLLECTEE = "44551";
export const COMPTE_TVA_DEDUCTIBLE = "34552";
export const COMPTE_TVA_DUE = "4456";
/** Racines de détection, pour ramasser les sous-comptes (44551 ⊂ 4455). */
export const RACINE_COLLECTEE = "4455";
export const RACINE_DEDUCTIBLE = "3455";

export interface LigneTva {
  journal_code?: string | null;
  compte_numero?: string | null;
  date_ecriture?: string | null;
  debit?: number | null;
  credit?: number | null;
  reference_piece?: string | null;
}

/** Référence portée par l'OD de déclaration — la rend retrouvable et idempotente. */
export const PREFIXE_DECLARATION_TVA = "DECL-TVA-";
export const referenceDeclaration = (periode: string): string =>
  `${PREFIXE_DECLARATION_TVA}${txt(periode)}`;

/**
 * Bornes d'une période déclarative.
 *
 * `periode` est « AAAA-MM » (mensuel) ou « AAAA-Tn » (trimestriel) — les deux
 * régimes ouverts par le CGI. Rend les dates INCLUSES, et la date d'écriture de
 * l'OD, qui est toujours le DERNIER jour de la période : la déclaration constate
 * une position arrêtée, elle ne peut pas être datée du mois suivant.
 */
export interface BornesPeriode {
  debut: string;
  fin: string;
  /** « mensuel » ou « trimestriel », déduit de la forme de `periode`. */
  regime: "mensuel" | "trimestriel";
  label: string;
}

export function bornesPeriode(periode: string): BornesPeriode | null {
  const p = txt(periode).toUpperCase();
  const dernierJour = (annee: number, mois: number) => new Date(Date.UTC(annee, mois, 0)).getUTCDate();
  const iso = (a: number, m: number, j: number) =>
    `${a}-${String(m).padStart(2, "0")}-${String(j).padStart(2, "0")}`;

  const mensuel = /^(\d{4})-(\d{2})$/.exec(p);
  if (mensuel) {
    const a = Number(mensuel[1]); const m = Number(mensuel[2]);
    if (m < 1 || m > 12) return null;
    return { debut: iso(a, m, 1), fin: iso(a, m, dernierJour(a, m)), regime: "mensuel", label: p };
  }
  const trim = /^(\d{4})-T([1-4])$/.exec(p);
  if (trim) {
    const a = Number(trim[1]); const t = Number(trim[2]);
    const premier = (t - 1) * 3 + 1; const dernier = premier + 2;
    return {
      debut: iso(a, premier, 1), fin: iso(a, dernier, dernierJour(a, dernier)),
      regime: "trimestriel", label: p,
    };
  }
  return null;
}

/** Une ligne tombe-t-elle dans la période ? Bornes incluses. */
const dansPeriode = (l: LigneTva, b: BornesPeriode): boolean => {
  const d = txt(l.date_ecriture).slice(0, 10);
  return d >= b.debut && d <= b.fin;
};

/** Écarte les écritures de déclaration elles-mêmes : on liquide le flux, pas le stock. */
const estDeclaration = (l: LigneTva): boolean =>
  txt(l.reference_piece).startsWith(PREFIXE_DECLARATION_TVA);

export interface LiquidationTva {
  periode: string;
  bornes: BornesPeriode;
  /** Σ des crédits nets du 44551 sur la période. */
  collectee: number;
  /** Σ des débits nets du 34552 sur la période. */
  deductible: number;
  /** collectée − déductible. Positif = dette, négatif = crédit reportable. */
  net: number;
  /** Montant à porter au 4456, toujours positif. */
  montant: number;
  /** `true` quand l'État doit être payé, `false` en crédit de TVA. */
  dette: boolean;
  /** Rien à déclarer : les deux comptes sont restés immobiles. */
  neant: boolean;
  label: string;
}

/**
 * Position de TVA d'une période, lue dans le grand livre.
 *
 * Les deux comptes sont pris en NET (crédits − débits pour la collectée, débits
 * − crédits pour la déductible) : un avoir ou une régularisation vient en
 * diminution, comme sur la déclaration elle-même. Une simple somme des crédits
 * gonflerait la TVA due de chaque annulation.
 */
export function liquiderTva(lignes: LigneTva[], periode: string): LiquidationTva | null {
  const bornes = bornesPeriode(periode);
  if (!bornes) return null;

  const retenues = lignes.filter((l) => dansPeriode(l, bornes) && !estDeclaration(l));
  const collectee = round2(retenues
    .filter((l) => txt(l.compte_numero).startsWith(RACINE_COLLECTEE))
    .reduce((s, l) => s + nb(l.credit) - nb(l.debit), 0));
  const deductible = round2(retenues
    .filter((l) => txt(l.compte_numero).startsWith(RACINE_DEDUCTIBLE))
    .reduce((s, l) => s + nb(l.debit) - nb(l.credit), 0));

  const net = round2(collectee - deductible);
  return {
    periode: bornes.label, bornes, collectee, deductible, net,
    montant: Math.abs(net), dette: net >= 0,
    // « Néant » au sens de la DGI : aucune opération taxable ni déductible.
    neant: Math.abs(collectee) < 0.005 && Math.abs(deductible) < 0.005,
    label: bornes.regime === "mensuel" ? `Déclaration TVA ${bornes.label}` : `Déclaration TVA ${bornes.label}`,
  };
}

export interface LigneDeclaration {
  journal_code: "OD";
  compte_numero: string;
  date_ecriture: string;
  libelle: string;
  debit: number;
  credit: number;
  reference_piece: string;
}

/**
 * OD de déclaration : solde les deux comptes de la période et constate le 4456.
 *
 * Rend un tableau VIDE sur une période néant — une écriture à zéro ne prouve
 * rien et pollue le journal. Les lignes à montant nul sont également écartées :
 * une période sans TVA déductible ne doit pas produire une ligne 34552 à 0,00.
 */
export function construireOdDeclaration(liq: LiquidationTva): LigneDeclaration[] {
  if (liq.neant) return [];

  const commun = {
    journal_code: "OD" as const,
    date_ecriture: liq.bornes.fin,
    libelle: `${liq.label} - ${liq.periode}`.slice(0, 200),
    reference_piece: referenceDeclaration(liq.periode),
  };
  const lignes: LigneDeclaration[] = [];

  // 1) Solder la TVA collectée : elle est créditrice, on la débite d'autant.
  if (Math.abs(liq.collectee) > 0.005) {
    lignes.push({
      ...commun, compte_numero: COMPTE_TVA_COLLECTEE,
      debit: Math.max(0, liq.collectee), credit: Math.max(0, -liq.collectee),
    });
  }
  // 2) Solder la TVA déductible : elle est débitrice, on la crédite d'autant.
  if (Math.abs(liq.deductible) > 0.005) {
    lignes.push({
      ...commun, compte_numero: COMPTE_TVA_DEDUCTIBLE,
      debit: Math.max(0, -liq.deductible), credit: Math.max(0, liq.deductible),
    });
  }
  // 3) La différence : dette (crédit 4456) ou crédit de TVA reportable (débit).
  if (Math.abs(liq.net) > 0.005) {
    lignes.push({
      ...commun, compte_numero: COMPTE_TVA_DUE,
      debit: liq.dette ? 0 : liq.montant,
      credit: liq.dette ? liq.montant : 0,
      libelle: (liq.dette
        ? `TVA due - ${liq.periode}`
        : `Crédit de TVA reportable - ${liq.periode}`).slice(0, 200),
    });
  }
  return lignes;
}

/**
 * Écriture du PAIEMENT de la TVA à la DGI : D 4456 / C compte de banque.
 *
 * Elle éteint la dette née de la déclaration. Le compte de trésorerie est un
 * paramètre et non 5141 en dur : le prélèvement peut tomber sur un autre compte
 * bancaire du dossier.
 */
export function construireOdPaiementDgi(p: {
  montant: number; date: string; periode: string;
  compteBanque?: string; reference?: string | null;
}): LigneDeclaration[] {
  const m = round2(Math.abs(nb(p.montant)));
  if (m <= 0) return [];
  const banque = txt(p.compteBanque) || "5141";
  const commun = {
    journal_code: "OD" as const,
    date_ecriture: p.date,
    libelle: `Paiement TVA DGI - ${txt(p.periode)}`.slice(0, 200),
    reference_piece: txt(p.reference) || referenceDeclaration(p.periode),
  };
  return [
    { ...commun, compte_numero: COMPTE_TVA_DUE, debit: m, credit: 0 },
    { ...commun, compte_numero: banque, debit: 0, credit: m },
  ];
}

// ─── Contrôles & invariants ──────────────────────────────────────────────────

export interface ControlePiece {
  ok: boolean;
  totalDebit: number;
  totalCredit: number;
  ecart: number;
  raison: string | null;
}

/**
 * Invariant de partie double sur UNE pièce générée : Σ débits = Σ crédits.
 *
 * À appeler avant CHAQUE insertion d'écriture construite par ce module. Une
 * pièce déséquilibrée insérée est un écart qu'on ne retrouve qu'à la balance,
 * des semaines plus tard, sans savoir d'où il vient.
 */
export function controlerPiece(lignes: { debit?: number | null; credit?: number | null }[]): ControlePiece {
  const totalDebit = round2(lignes.reduce((s, l) => s + nb(l.debit), 0));
  const totalCredit = round2(lignes.reduce((s, l) => s + nb(l.credit), 0));
  const ecart = round2(totalDebit - totalCredit);
  if (!lignes.length) {
    return { ok: true, totalDebit: 0, totalCredit: 0, ecart: 0, raison: null };
  }
  if (Math.abs(ecart) > 0.005) {
    return {
      ok: false, totalDebit, totalCredit, ecart,
      raison: `Pièce déséquilibrée : débit ${totalDebit.toFixed(2)} ≠ crédit ${totalCredit.toFixed(2)} (écart ${ecart.toFixed(2)} MAD).`,
    };
  }
  return { ok: true, totalDebit, totalCredit, ecart, raison: null };
}

export interface SoldeApresDeclaration {
  collectee: number;
  deductible: number;
  due: number;
  /** La période est-elle close ? Un crédit reportable ne l'en empêche pas. */
  solde: boolean;
  raison: string | null;
  /**
   * Crédit de TVA reporté sur les périodes suivantes, en positif.
   *
   * Zéro dans le cas courant. Non nul, il dit que le 4456 est débiteur : la
   * période est close, mais elle lègue une créance sur l'État.
   */
  creditReporte: number;
}

/**
 * Contrôle de bouclage : après déclaration ET paiement, 44551 et 34552 sont
 * revenus à 0,00 et le 4456 ne porte plus de dette.
 *
 * C'est LE test qui prouve qu'une période est close. Un 44551 non nul signale
 * une TVA encaissée après la déclaration, donc rattachée à la mauvaise période.
 *
 * ─── Pourquoi le SENS du 4456 décide, et non sa nullité ─────────────────────
 * Exiger 4456 = 0,00 confondrait deux situations opposées, que seul le sens du
 * solde distingue :
 *
 *   • 4456 CRÉDITEUR — une dette envers l'État non prélevée. La période n'est
 *     pas close, et c'est exactement ce qu'on veut voir signalé.
 *   • 4456 DÉBITEUR — un crédit de TVA reportable, c'est-à-dire une CRÉANCE sur
 *     l'État. La déclaration a fait son travail : 44551 et 34552 sont soldés et
 *     rien n'est dû. Ce solde est destiné à vivre jusqu'à ce qu'une période
 *     ultérieure l'absorbe — le rendre bloquant reviendrait à déclarer « non
 *     soldée » toute période suivant un crédit, définitivement.
 *
 * Le contrôle est CUMULATIF (toutes les lignes jusqu'à la fin de la période) :
 * il juge la position des comptes de TVA à cette date, pas le seul mouvement de
 * la période. Une TVA antérieure jamais déclarée se reporte donc et fait à bon
 * droit échouer le bouclage des périodes suivantes.
 */
export function controlerBouclagePeriode(
  lignes: LigneTva[], periode: string,
): SoldeApresDeclaration | null {
  const bornes = bornesPeriode(periode);
  if (!bornes) return null;

  const jusqua = lignes.filter((l) => txt(l.date_ecriture).slice(0, 10) <= bornes.fin);
  const solde = (racine: string, sens: "D" | "C") => round2(jusqua
    .filter((l) => txt(l.compte_numero).startsWith(racine))
    .reduce((s, l) => s + (sens === "D" ? nb(l.debit) - nb(l.credit) : nb(l.credit) - nb(l.debit)), 0));

  const collectee = solde(RACINE_COLLECTEE, "C");
  const deductible = solde(RACINE_DEDUCTIBLE, "D");
  const due = solde(COMPTE_TVA_DUE, "C");
  // `due` est compté au CRÉDIT : positif = dette envers l'État, négatif =
  // crédit de TVA reportable. On ne retient comme bloquante que la dette.
  const creditReporte = due < -0.005 ? round2(-due) : 0;

  const ouverts: string[] = [];
  if (Math.abs(collectee) > 0.005) ouverts.push(`44551 = ${collectee.toFixed(2)}`);
  if (Math.abs(deductible) > 0.005) ouverts.push(`34552 = ${deductible.toFixed(2)}`);
  if (due > 0.005) ouverts.push(`4456 = ${due.toFixed(2)} (TVA due non prélevée)`);

  return {
    collectee, deductible, due, creditReporte,
    solde: ouverts.length === 0,
    raison: ouverts.length
      ? `Période non soldée au ${bornes.fin} : ${ouverts.join(", ")}.`
      : creditReporte > 0
        ? `Période soldée au ${bornes.fin} — crédit de TVA de ${creditReporte.toFixed(2)} MAD reporté sur les périodes suivantes.`
        : null,
  };
}
