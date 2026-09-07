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
// Ce prélèvement tombe APRÈS la période — la TVA de mars se paie en avril. Il se
// rattache donc à sa déclaration par la RÉFÉRENCE DE PIÈCE, jamais par sa date :
// c'est ce que fait `reglementsDgiPeriode`, et c'est ce qui permet de voir qu'une
// période est réglée sans la déclarer « non soldée » pour cause de calendrier.
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

// Le couple (compte de trésorerie → journal) vit dans comptes-tresorerie.ts, et
// pas ici : le paiement DGI est un décaissement comme un autre.
import { journalDeTresorerie } from "@/lib/comptes-tresorerie";

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
  libelle?: string | null;
}

/**
 * Libellés des lignes de 4456 — ce sont eux qui disent QUEL geste a écrit la
 * ligne, et le nom n'est pas cosmétique.
 *
 * Sur le 4456, la déclaration et le paiement se ressemblent : même référence de
 * pièce, et un DÉBIT peut être l'un ou l'autre — le paiement d'une dette, mais
 * aussi la constatation d'un crédit reportable. Ni le sens ni la date ne les
 * séparent (le prélèvement peut tomber le dernier jour de la période). Le
 * libellé, lui, est écrit par ce module et ne varie pas.
 */
export const LIBELLE_TVA_DUE = "TVA due";
export const LIBELLE_CREDIT_REPORTABLE = "Crédit de TVA reportable";
export const LIBELLE_PAIEMENT_DGI = "Paiement TVA DGI";

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

/**
 * Régularisation d'une période ANTÉRIEURE déjà déclarée.
 *
 * ─── Pourquoi elle doit sortir du flux ───────────────────────────────────────
 * Une déclaration déposée ne se réécrit pas : c'est un acte transmis à la DGI.
 * Quand elle s'avère fausse, on la corrige par une écriture de la période
 * COURANTE — mais cette écriture ne décrit pas l'activité de la période
 * courante, et la compter dans son flux la rendrait sans effet.
 *
 * Le cas concret : une TVA déduite trop tôt laisse le 34552 CRÉDITEUR. Pour le
 * solder il faut le débiter — or tout débit de 3455 est, pour `liquiderTva`,
 * une TVA déductible de la période. La régularisation s'accorderait donc à
 * elle-même la déduction qu'elle est censée reprendre, et le compte repartirait
 * créditeur à la déclaration suivante, indéfiniment.
 *
 * Hors flux, la mécanique se referme : le 34552 se solde, le 4456 porte la dette
 * rendue à l'État, et le 3458 reste intact — la TVA redeviendra déductible le
 * jour où le fournisseur sera réellement payé, et cette fois une seule fois.
 *
 * C'est aussi ce que dit l'imprimé SIMPL-TVA, qui range les régularisations sur
 * une ligne à part et non dans la TVA déductible du mois.
 */
export const PREFIXE_REGULARISATION_TVA = "REGUL-TVA-";
const estRegularisation = (l: LigneTva): boolean =>
  txt(l.reference_piece).startsWith(PREFIXE_REGULARISATION_TVA);

/** Lignes que la liquidation d'une période ne doit PAS compter dans son flux. */
const estHorsFlux = (l: LigneTva): boolean => estDeclaration(l) || estRegularisation(l);

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

  const retenues = lignes.filter((l) => dansPeriode(l, bornes) && !estHorsFlux(l));
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
  /**
   * OD pour la DÉCLARATION (un reclassement, aucun argent ne bouge) ; BQ ou CAI
   * pour le PAIEMENT (cf. `construireOdPaiementDgi`). Le journal OD n'a pas le
   * droit de porter de la trésorerie — voir `controlerJournalOd`.
   */
  journal_code: "OD" | "BQ" | "CAI";
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
        ? `${LIBELLE_TVA_DUE} - ${liq.periode}`
        : `${LIBELLE_CREDIT_REPORTABLE} - ${liq.periode}`).slice(0, 200),
    });
  }
  return lignes;
}

/** Libellés des régularisations — ils disent quel sens a été repris. */
export const LIBELLE_REGUL_DEDUCTION = "Régularisation TVA déduite par anticipation";
export const LIBELLE_REGUL_COLLECTE = "Régularisation TVA déclarée par anticipation";

export interface ContexteRegularisationTva {
  /** Période DÉJÀ DÉCLARÉE que l'on corrige (« 2024-11 »), pas celle où l'on écrit. */
  periodeRegularisee: string;
  /**
   * `deduction` : TVA déduite trop tôt (34552 créditeur) — on la rend à l'État.
   * `collecte`  : TVA déclarée trop tôt (44551 débiteur) — l'État la doit.
   */
  sens: "deduction" | "collecte";
  /** Montant à reprendre, toujours POSITIF. */
  montant: number;
  /** Date de l'écriture : dans l'exercice OUVERT, jamais dans la période corrigée. */
  date: string;
  /** Précision libre ajoutée au libellé (n° de facture, fournisseur…). */
  motif?: string | null;
}

/**
 * Écriture de régularisation d'une TVA déclarée par anticipation.
 *
 * ─── Le sens, et pourquoi il n'est pas symétrique ────────────────────────────
 * Déduction anticipée : on a déduit une TVA non encore exigible. Le 34552 est
 * créditeur du montant indûment déduit ; on le débite pour le solder, et on
 * CRÉDITE le 4456 — la somme est due à l'État.
 *
 *   D 34552   montant      (solde la déduction prise à tort)
 *   C 4456    montant      (dette rendue à l'État)
 *
 * Collecte anticipée : on a déclaré une TVA pas encore encaissée. Le 44551 est
 * débiteur ; on le crédite, et on DÉBITE le 4456 — l'État nous doit cette
 * avance, imputable sur les déclarations suivantes.
 *
 * ─── Ce qu'elle ne touche PAS ────────────────────────────────────────────────
 * Le compte d'attente (3458 / 4458) reste intact, et c'est l'essentiel. La TVA
 * y demeure en attente du fait générateur réel — le paiement du fournisseur, ou
 * l'encaissement du client. Elle deviendra alors exigible par la bascule
 * ordinaire, et sera déclarée là, une seule fois. Purger l'attente en même temps
 * reviendrait à ratifier l'anticipation au lieu de la corriger.
 */
export function construireOdRegularisationTva(
  ctx: ContexteRegularisationTva,
): LigneDeclaration[] {
  const montant = round2(Math.abs(nb(ctx.montant)));
  if (montant < 0.005) return [];
  const periode = txt(ctx.periodeRegularisee);
  if (!bornesPeriode(periode)) return [];

  const deduction = ctx.sens === "deduction";
  const libelle = [
    deduction ? LIBELLE_REGUL_DEDUCTION : LIBELLE_REGUL_COLLECTE,
    periode,
    txt(ctx.motif) || null,
  ].filter(Boolean).join(" - ").slice(0, 200);

  const commun = {
    journal_code: "OD" as const,
    date_ecriture: txt(ctx.date).slice(0, 10),
    // La référence porte la période CORRIGÉE, pas celle de l'écriture : c'est
    // elle qui rend la régularisation retrouvable depuis la déclaration fautive,
    // et c'est le préfixe qui la sort du flux (cf. `estRegularisation`).
    reference_piece: `${PREFIXE_REGULARISATION_TVA}${periode}`,
    libelle,
  };

  const compteTva = deduction ? COMPTE_TVA_DEDUCTIBLE : COMPTE_TVA_COLLECTEE;
  return [
    { ...commun, compte_numero: compteTva, debit: deduction ? montant : 0, credit: deduction ? 0 : montant },
    { ...commun, compte_numero: COMPTE_TVA_DUE, debit: deduction ? 0 : montant, credit: deduction ? montant : 0 },
  ];
}

/**
 * Écriture du PAIEMENT de la TVA à la DGI : D 4456 / C compte de trésorerie.
 *
 * Elle éteint la dette née de la déclaration. Le compte de trésorerie est un
 * paramètre et non 5141 en dur : le prélèvement peut tomber sur un autre compte
 * bancaire du dossier.
 *
 * ─── Pourquoi BQ / CAI et non OD ─────────────────────────────────────────────
 * Cette pièce était émise en journal OD. C'était la violation la plus visible de
 * l'invariant « pas de trésorerie en OD » (cf. `controlerJournalOd`) : le
 * prélèvement de TVA est un vrai décaissement, il doit se retrouver dans le
 * journal que le rapprochement bancaire lit. Logé en OD, il créditait 5141 sans
 * qu'aucun écran de trésorerie ne le voie — le grand livre divergeait du relevé
 * du montant de la TVA, chaque mois.
 *
 * Le journal se déduit du compte, jamais de l'appelant : un compte de rubrique
 * 516 (caisse) va en CAI, tout le reste en BQ. Les rendre ENSEMBLE est la seule
 * façon d'empêcher une pièce qui dirait « caisse » au compte et « banque » au
 * journal (même raison que `imputationTresorerie`).
 *
 * Le rattachement du règlement à sa déclaration se fait par `reference_piece`
 * (`DECL-TVA-<période>`) et par le compte 4456, jamais par le journal : le
 * changement est donc sans effet sur `reglementsDgiPeriode`.
 */
export function construireOdPaiementDgi(p: {
  montant: number; date: string; periode: string;
  compteBanque?: string; reference?: string | null;
}): LigneDeclaration[] {
  const m = round2(Math.abs(nb(p.montant)));
  if (m <= 0) return [];
  const banque = txt(p.compteBanque) || "5141";
  const commun = {
    journal_code: journalDeTresorerie(banque),
    date_ecriture: p.date,
    libelle: `${LIBELLE_PAIEMENT_DGI} - ${txt(p.periode)}`.slice(0, 200),
    reference_piece: txt(p.reference) || referenceDeclaration(p.periode),
  };
  return [
    { ...commun, compte_numero: COMPTE_TVA_DUE, debit: m, credit: 0 },
    { ...commun, compte_numero: banque, debit: 0, credit: m },
  ];
}

// ─── Règlements DGI d'une période — SANS filtre de date ──────────────────────

/** Ligne écrite par l'OD de DÉCLARATION (et non par un règlement). */
const estLigneDeclarationTva = (l: LigneTva): boolean => {
  const lib = txt(l.libelle);
  return lib.startsWith(LIBELLE_TVA_DUE) || lib.startsWith(LIBELLE_CREDIT_REPORTABLE);
};

export interface ReglementsPeriode {
  /** L'OD de déclaration existe-t-elle ? */
  declaree: boolean;
  /** Dette portée au crédit du 4456 par la déclaration, en positif (0 sur un crédit). */
  detteConstatee: number;
  /** Σ des règlements DGI imputés sur cette déclaration, à quelque date que ce soit. */
  regle: number;
  /** Reste dû sur la déclaration de CETTE période. */
  reste: number;
  /** Date du dernier règlement, ou `null` — elle peut tomber APRÈS la période. */
  dernierReglement: string | null;
}

/**
 * Règlements rattachés à la déclaration d'une période, DATE IGNORÉE.
 *
 * Le rattachement se fait par `reference_piece` (`DECL-TVA-<période>`), qui suit
 * la pièce et non le calendrier. C'est indispensable : la TVA de mars se paie en
 * avril. Chercher le règlement dans les bornes de la période — ce que fait
 * `controlerBouclagePeriode`, à bon droit pour le BOUCLAGE — le rendrait
 * invisible, et l'écran réclamerait éternellement un prélèvement déjà passé.
 *
 * Le reste dû ici est celui de la PIÈCE, pas du compte : le 4456 est un compte
 * courant avec l'État, il mélange les périodes (cf. `soldeTvaDue`). Ce qui est
 * réellement exigible est le plus petit des deux — voir `resteExigible`.
 */
export function reglementsDgiPeriode(lignes: LigneTva[], periode: string): ReglementsPeriode {
  const ref = referenceDeclaration(periode);
  const cycle = lignes.filter((l) =>
    txt(l.reference_piece) === ref && txt(l.compte_numero).startsWith(COMPTE_TVA_DUE));

  const declarations = cycle.filter(estLigneDeclarationTva);
  // Un crédit reportable est un DÉBIT du 4456 : le net est négatif, et il n'y a
  // aucune dette à éteindre. D'où le plancher à zéro.
  const detteConstatee = Math.max(0, round2(
    declarations.reduce((s, l) => s + nb(l.credit) - nb(l.debit), 0)));

  const paiements = cycle.filter((l) => !estLigneDeclarationTva(l) && nb(l.debit) > 0);
  const regle = round2(paiements.reduce((s, l) => s + nb(l.debit), 0));

  return {
    declaree: cycle.length > 0,
    detteConstatee, regle,
    reste: round2(detteConstatee - regle),
    dernierReglement: paiements.map((l) => txt(l.date_ecriture).slice(0, 10))
      .filter(Boolean).sort().pop() ?? null,
  };
}

/**
 * Solde du 4456 À CE JOUR, toutes dates confondues : positif = dette envers
 * l'État, négatif = crédit de TVA.
 *
 * C'est le montant qu'on peut réellement prélever maintenant, donc le plafond de
 * la saisie. À ne pas confondre avec le solde arrêté à la fin d'une période, qui
 * répond à une autre question (« cette période est-elle bouclée ? ») et ignore
 * par construction les règlements postérieurs.
 */
export function soldeTvaDue(lignes: LigneTva[]): number {
  return round2(lignes
    .filter((l) => txt(l.compte_numero).startsWith(COMPTE_TVA_DUE))
    .reduce((s, l) => s + nb(l.credit) - nb(l.debit), 0));
}

/**
 * Ce qui est réellement exigible sur une période : le reste de SA déclaration,
 * borné par le solde du compte.
 *
 * Les deux bornes disent une vérité différente et il faut les deux. Le reste de
 * la pièce empêche de payer deux fois la même déclaration ; le solde du compte
 * empêche de réclamer une dette qu'un crédit antérieur a déjà absorbée — cas
 * réel, le 4456 étant un compte courant. Jamais négatif : « rien à payer ».
 */
export const resteExigible = (resteCycle: number, soldeCompte: number): number =>
  Math.max(0, round2(Math.min(nb(resteCycle), nb(soldeCompte))));

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
