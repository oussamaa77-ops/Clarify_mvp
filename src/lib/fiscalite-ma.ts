// ============================================================================
// Règles fiscales marocaines (CGI) — logique PURE et testable.
//
// L'écran Fiscalité ne fait qu'AFFICHER ce que ce module décide : l'ancienneté
// de la société (1er exercice, 36 mois, 5 ans) commande des exonérations qui ne
// peuvent pas être devinées à partir des seules écritures comptables, elles
// dépendent de la DATE DE DÉBUT D'ACTIVITÉ du dossier.
//
// Hypothèse d'exercice : année civile (ouverture 01/01, clôture 31/12), ce qui
// couvre l'écrasante majorité des dossiers marocains. Les échéances d'acomptes
// en découlent (fin des 3e, 6e, 9e et 12e mois de l'exercice).
// ============================================================================

const round2 = (x: number) => Math.round(x * 100) / 100;

function n(v: unknown): number {
  const x = Number(v);
  return isFinite(x) ? x : 0;
}

// ─── Dates ───────────────────────────────────────────────────────────────────

interface DateSimple { annee: number; mois: number; jour: number }

/** Parse une date ISO courte (AAAA-MM-JJ, éventuellement horodatée). */
export function parseDateIso(d: string | null | undefined): DateSimple | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d ?? "").trim());
  if (!m) return null;
  const annee = Number(m[1]), mois = Number(m[2]), jour = Number(m[3]);
  if (mois < 1 || mois > 12 || jour < 1 || jour > 31) return null;
  return { annee, mois, jour };
}

const enJours = (d: DateSimple) => Date.UTC(d.annee, d.mois - 1, d.jour) / 86400000;

/** Ajoute `mois` mois à une date, en bornant le jour au dernier du mois cible. */
function ajouterMois(d: DateSimple, mois: number): DateSimple {
  const total = (d.annee * 12 + (d.mois - 1)) + mois;
  const annee = Math.floor(total / 12);
  const m = (total % 12) + 1;
  const dernierJour = new Date(Date.UTC(annee, m, 0)).getUTCDate();
  return { annee, mois: m, jour: Math.min(d.jour, dernierJour) };
}

const formatIso = (d: DateSimple) =>
  `${d.annee}-${String(d.mois).padStart(2, "0")}-${String(d.jour).padStart(2, "0")}`;

/** Date en JJ/MM/AAAA — format d'affichage des échéances fiscales. */
export function formatDateFr(iso: string | null | undefined): string {
  const d = parseDateIso(iso);
  return d ? `${String(d.jour).padStart(2, "0")}/${String(d.mois).padStart(2, "0")}/${d.annee}` : "";
}

/** Clôture de l'exercice N (année civile). */
export const clotureExercice = (exercice: number): DateSimple =>
  ({ annee: exercice, mois: 12, jour: 31 });

// ─── Ancienneté du dossier ───────────────────────────────────────────────────

/** Durée d'exonération de la cotisation minimale (art. 144-I-C CGI). */
export const MOIS_EXONERATION_CM = 36;
/** Durée d'exonération de la taxe professionnelle (art. 6 — 5 premières années). */
export const ANNEES_EXONERATION_TP = 5;

export interface AncienneteDossier {
  /** `true` tant que la date de début d'activité n'est pas renseignée. */
  inconnue: boolean;
  /** Année de début d'activité, si connue. */
  anneeDebut: number | null;
  /** L'exercice demandé est-il le PREMIER exercice d'exploitation ? */
  premierExercice: boolean;
  /** Mois écoulés entre le début d'activité et la clôture de l'exercice. */
  moisALaCloture: number | null;
  /** Dernier jour couvert par l'exonération de CM (36 mois), ISO court. */
  finExonerationCM: string | null;
  /** Première année au titre de laquelle la TP est due (début + 5 ans). */
  premiereAnneeImposableTP: number | null;
}

/**
 * Situe un exercice par rapport à la date de début d'activité.
 *
 * Sans date renseignée, on ne présume RIEN : `inconnue` est vrai et l'appelant
 * retombe sur le droit commun (acomptes dus, CM due, TP due). Exonérer par
 * défaut masquerait des obligations réelles — l'erreur la plus coûteuse.
 */
export function situerExercice(
  dateDebutActivite: string | null | undefined,
  exercice: number,
): AncienneteDossier {
  const debut = parseDateIso(dateDebutActivite);
  if (!debut) {
    return {
      inconnue: true, anneeDebut: null, premierExercice: false,
      moisALaCloture: null, finExonerationCM: null, premiereAnneeImposableTP: null,
    };
  }
  const cloture = clotureExercice(exercice);
  const moisALaCloture = (cloture.annee - debut.annee) * 12 + (cloture.mois - debut.mois)
    + (cloture.jour >= debut.jour ? 0 : -1);
  return {
    inconnue: false,
    anneeDebut: debut.annee,
    premierExercice: exercice === debut.annee,
    moisALaCloture,
    finExonerationCM: formatIso(ajouterMois(debut, MOIS_EXONERATION_CM)),
    premiereAnneeImposableTP: debut.annee + ANNEES_EXONERATION_TP,
  };
}

// ─── Impôt sur les sociétés ──────────────────────────────────────────────────

export interface TrancheIS {
  /** Bénéfice net fiscal à partir duquel le taux s'applique (borne INCLUSE). */
  plancher: number;
  taux: number;
  label: string;
}

/**
 * Barème IS cible de la loi de finances 2026 (art. 19 CGI).
 *
 * Le taux n'est pas marginal : celui de la tranche s'applique à la TOTALITÉ du
 * bénéfice net fiscal. Le taux réduit des PME n'a pas disparu — il est devenu le
 * taux de droit commun, tout bénéfice inférieur à 100 MDH étant imposé à 20 %.
 */
export const BAREME_IS: TrancheIS[] = [
  { plancher: 0,           taux: 0.20, label: "PME / droit commun — bénéfice < 100 000 000 MAD" },
  { plancher: 100_000_000, taux: 0.35, label: "Grands bénéfices — ≥ 100 000 000 MAD" },
];

/**
 * Barèmes TRANSITOIRES de la LF 2023 (art. 247-XXXVII CGI), exercices ouverts
 * de 2023 à 2025 : la convergence vers 20 % / 35 % s'est faite par paliers
 * annuels. Appliquer le barème 2026 à un exercice antérieur rendait l'IS faux :
 * 20 % au lieu de 15 % sur un bénéfice de 200 000 MAD en 2024, par exemple.
 *
 * Paliers vérifiés : ≤ 300 000 → 12,5 / 15 / 17,5 % ; 300 000 – 1 MDH → 20 % ;
 * 1 MDH – 100 MDH → 28,25 / 25,5 / 22,75 %. Palier ≥ 100 MDH (32 / 33 / 34 %) :
 * 32 % pour 2023 cité par la note circulaire DGI n° 733 ; suite à confirmer.
 */
const BAREMES_TRANSITOIRES_IS: Record<number, TrancheIS[]> = Object.fromEntries(
  ([[2023, 0.125, 0.2825, 0.32], [2024, 0.15, 0.255, 0.33], [2025, 0.175, 0.2275, 0.34]] as const)
    .map(([annee, bas, moyen, haut]) => [annee, [
      { plancher: 0,           taux: bas,  label: `Bénéfice ≤ 300 000 MAD (barème transitoire ${annee})` },
      { plancher: 300_000.01,  taux: 0.20, label: `Bénéfice de 300 000 à 1 000 000 MAD (${annee})` },
      { plancher: 1_000_000.01, taux: moyen, label: `Bénéfice de 1 à 100 MDH (barème transitoire ${annee})` },
      { plancher: 100_000_000, taux: haut, label: `Bénéfice ≥ 100 MDH (barème transitoire ${annee})` },
    ]]),
);

/** Barème de droit commun applicable à l'exercice (2026 et suivants : barème cible). */
export function baremeIS(exercice?: number | null): TrancheIS[] {
  const a = Number(exercice);
  if (!Number.isFinite(a) || a >= 2026) return BAREME_IS;
  return BAREMES_TRANSITOIRES_IS[Math.max(2023, a)];
}

/**
 * Régime d'imposition du dossier.
 *  - `droit_commun`          : barème ci-dessus (20 % / 35 %) ;
 *  - `taux_specifique`       : 20 % PLAFONNÉ quel que soit le bénéfice — sociétés
 *    à statut particulier (exportateurs, zones d'accélération industrielle,
 *    CFC…), qui échappent au taux de 35 % au-delà de 100 MDH ;
 *  - `etablissement_credit`  : 40 % sur tout le bénéfice — établissements de
 *    crédit et organismes assimilés, Bank Al-Maghrib, CDG, entreprises
 *    d'assurances et de réassurance (art. 19-I-C CGI, taux cible LF 2023 atteint
 *    en 2026).
 */
export type RegimeIS = "droit_commun" | "taux_specifique" | "etablissement_credit";

/** Taux plafond des sociétés à statut spécifique (art. 6 / 19 CGI). */
export const TAUX_IS_SPECIFIQUE = 0.20;

export const TRANCHE_IS_SPECIFIQUE: TrancheIS = {
  plancher: 0, taux: TAUX_IS_SPECIFIQUE,
  label: "Taux spécifique 20 % (statut particulier)",
};

/** Taux des établissements de crédit et des assurances (art. 19-I-C CGI). */
export const TAUX_IS_ETABLISSEMENT_CREDIT = 0.40;

export const TRANCHE_IS_ETABLISSEMENT_CREDIT: TrancheIS = {
  plancher: 0, taux: TAUX_IS_ETABLISSEMENT_CREDIT,
  label: "Établissements de crédit et assurances — 40 %",
};

const REGIMES_IS: readonly RegimeIS[] = ["droit_commun", "taux_specifique", "etablissement_credit"];

/** Normalise une valeur de régime : toute valeur inconnue retombe sur le droit commun. */
export function normaliserRegimeIS(v: unknown): RegimeIS {
  return REGIMES_IS.includes(v as RegimeIS) ? (v as RegimeIS) : "droit_commun";
}

/** Taux de droit commun de la cotisation minimale (art. 144 CGI). */
export const TAUX_CM_DROIT_COMMUN = 0.0025;
/** Plancher légal de la cotisation minimale pour les sociétés soumises à l'IS. */
export const CM_MINIMUM_MAD = 3_000;

/**
 * Tranche applicable à un résultat fiscal.
 *
 * Un déficit relève de la première tranche : le taux n'a alors aucune prise
 * (l'IS théorique est nul) mais l'affichage doit rester cohérent.
 */
export function trancheIS(
  resultatFiscal: number, regime: RegimeIS = "droit_commun", exercice?: number | null,
): TrancheIS {
  if (regime === "taux_specifique") return TRANCHE_IS_SPECIFIQUE;
  if (regime === "etablissement_credit") return TRANCHE_IS_ETABLISSEMENT_CREDIT;
  const base = Math.max(0, n(resultatFiscal));
  const bareme = baremeIS(exercice);
  let retenue = bareme[0];
  for (const t of bareme) if (base >= t.plancher) retenue = t;
  return retenue;
}

export interface CotisationMinimale {
  /** La CM est-elle due au titre de cet exercice ? */
  applicable: boolean;
  /** Motif d'exonération, prêt à afficher (vide si la CM est due). */
  motif: string;
  taux: number;
  base: number;
  /** Montant retenu : max(base × taux, plancher légal), 0 si exonéré. */
  montant: number;
  /** `true` quand le plancher de 3 000 MAD a pris le pas sur le calcul. */
  plancherApplique: boolean;
}

/**
 * Cotisation minimale de l'exercice.
 *
 * Exonération : 36 premiers mois d'exploitation (art. 144-I-C CGI). On n'exonère
 * l'exercice QUE s'il est intégralement couvert par cette fenêtre — dès qu'un
 * exercice la déborde, la CM redevient due sur sa totalité (lecture prudente).
 */
export function calculerCotisationMinimale(input: {
  base: number;
  exercice: number;
  dateDebutActivite?: string | null;
  taux?: number;
}): CotisationMinimale {
  const taux = input.taux != null && isFinite(input.taux) && input.taux > 0
    ? input.taux : TAUX_CM_DROIT_COMMUN;
  const base = Math.max(0, round2(n(input.base)));
  const situation = situerExercice(input.dateDebutActivite, input.exercice);

  if (!situation.inconnue && situation.finExonerationCM) {
    const cloture = enJours(clotureExercice(input.exercice));
    const fin = enJours(parseDateIso(situation.finExonerationCM)!);
    if (cloture <= fin) {
      return {
        applicable: false,
        motif: `Exonéré de cotisation minimale — 36 premiers mois d'activité (art. 144 CGI), jusqu'au ${formatDateFr(situation.finExonerationCM)}`,
        taux, base, montant: 0, plancherApplique: false,
      };
    }
  }

  const calculee = round2(base * taux);
  const montant = Math.max(calculee, CM_MINIMUM_MAD);
  return {
    applicable: true, motif: "", taux, base, montant,
    plancherApplique: montant > calculee,
  };
}

export interface EcheanceAcompte {
  /** « 1er acompte », « 2ème acompte »… */
  label: string;
  /** Date limite de versement, ISO court. */
  date: string;
  montant: number;
}

export interface AcomptesIS {
  /** Les acomptes sont-ils dus au titre de cet exercice ? */
  dus: boolean;
  /** Motif de dispense, prêt à afficher (vide si les acomptes sont dus). */
  motif: string;
  /** Base légale des acomptes : IS DÛ de l'exercice précédent (N-1). */
  base: number;
  /** Montant de chaque acompte = base ÷ 4. */
  montantUnitaire: number;
  /** Somme des 4 acomptes versés au cours de l'exercice. */
  total: number;
  echeances: EcheanceAcompte[];
}

/**
 * Acomptes provisionnels versés AU COURS de l'exercice N (art. 170 CGI).
 *
 * Deux règles que le calcul naïf « IS de l'année ÷ 4 » viole :
 *  - la base est l'IS DÛ DE N-1, jamais le résultat de l'année en cours, qui
 *    n'est pas connu au moment des versements ;
 *  - une société nouvellement créée est DISPENSÉE d'acomptes sur son premier
 *    exercice, faute d'exercice de référence.
 *
 * Échéances : avant l'expiration des 3e, 6e, 9e et 12e mois suivant l'ouverture
 * de l'exercice — soit 31/03, 30/06, 30/09 et 31/12 sur une année civile.
 */
export function calculerAcomptesIS(input: {
  exercice: number;
  isDuExercicePrecedent: number;
  dateDebutActivite?: string | null;
}): AcomptesIS {
  const { exercice } = input;
  const dates = [`${exercice}-03-31`, `${exercice}-06-30`, `${exercice}-09-30`, `${exercice}-12-31`];
  const labels = ["1er acompte", "2ème acompte", "3ème acompte", "4ème acompte"];
  const situation = situerExercice(input.dateDebutActivite, exercice);

  const dispense = (motif: string): AcomptesIS => ({
    dus: false, motif, base: 0, montantUnitaire: 0, total: 0,
    echeances: labels.map((label, i) => ({ label, date: dates[i], montant: 0 })),
  });

  if (situation.premierExercice) {
    return dispense("Exonéré d'acomptes IS pour le 1er exercice - Art. 170 CGI");
  }

  const base = Math.max(0, round2(n(input.isDuExercicePrecedent)));
  const montantUnitaire = round2(base / 4);
  return {
    dus: true, motif: "", base, montantUnitaire,
    total: round2(montantUnitaire * 4),
    echeances: labels.map((label, i) => ({ label, date: dates[i], montant: montantUnitaire })),
  };
}

export interface ResultatIS {
  exercice: number;
  resultatFiscal: number;
  regime: RegimeIS;
  tranche: TrancheIS;
  /** Résultat fiscal × taux de la tranche (0 si résultat déficitaire). */
  isTheorique: number;
  cotisationMinimale: CotisationMinimale;
  /** Impôt DÛ au titre de l'exercice = max(IS théorique, CM). */
  isDu: number;
  acomptes: AcomptesIS;
  /** isDu − acomptes versés : positif = reliquat, négatif = excédent. */
  solde: number;
  /** Reliquat à verser (jamais négatif). */
  isAPayer: number;
  /** Excédent d'acomptes, imputable sur les acomptes suivants (art. 170 CGI). */
  excedent: number;
  situation: AncienneteDossier;
}

/**
 * Liquidation complète de l'IS d'un exercice.
 *
 * `IS à payer = max(IS théorique, CM) − acomptes versés au titre de l'exercice`,
 * ces acomptes étant eux-mêmes assis sur l'IS dû de N-1.
 */
export function calculerIS(input: {
  exercice: number;
  resultatFiscal: number;
  /** Base de la CM : produits d'exploitation, financiers et non courants HT. */
  baseCotisationMinimale: number;
  dateDebutActivite?: string | null;
  /** IS dû au titre de N-1 — base des acomptes versés pendant l'exercice. */
  isDuExercicePrecedent?: number;
  tauxCotisationMinimale?: number;
  regime?: RegimeIS;
}): ResultatIS {
  const regime: RegimeIS = normaliserRegimeIS(input.regime);
  const resultatFiscal = round2(n(input.resultatFiscal));
  const tranche = trancheIS(resultatFiscal, regime, input.exercice);
  const isTheorique = round2(Math.max(0, resultatFiscal) * tranche.taux);

  const cotisationMinimale = calculerCotisationMinimale({
    base: input.baseCotisationMinimale,
    exercice: input.exercice,
    dateDebutActivite: input.dateDebutActivite,
    taux: input.tauxCotisationMinimale,
  });

  const isDu = round2(Math.max(isTheorique, cotisationMinimale.montant));
  const acomptes = calculerAcomptesIS({
    exercice: input.exercice,
    isDuExercicePrecedent: n(input.isDuExercicePrecedent),
    dateDebutActivite: input.dateDebutActivite,
  });

  const solde = round2(isDu - acomptes.total);
  return {
    exercice: input.exercice,
    resultatFiscal, regime, tranche, isTheorique, cotisationMinimale, isDu, acomptes, solde,
    isAPayer: Math.max(0, solde),
    excedent: Math.max(0, round2(-solde)),
    situation: situerExercice(input.dateDebutActivite, input.exercice),
  };
}

// ─── Taxe professionnelle ────────────────────────────────────────────────────

export interface ClasseTP { classe: 1 | 2 | 3; taux: number; label: string }

/** Taux de la TP par classe de la nomenclature des professions. */
export const CLASSES_TP: ClasseTP[] = [
  { classe: 3, taux: 0.10, label: "Classe 3 — 10 %" },
  { classe: 2, taux: 0.20, label: "Classe 2 — 20 %" },
  { classe: 1, taux: 0.30, label: "Classe 1 — 30 %" },
];
export const CLASSE_TP_DEFAUT = 3;

export interface ResultatTP {
  /** Exonération quinquennale en cours ? */
  exonere: boolean;
  /** Motif d'exonération, prêt à afficher (vide si la TP est due). */
  motif: string;
  /** Base imposable = valeur locative annuelle (JAMAIS le chiffre d'affaires). */
  base: number;
  taux: number;
  classe: 1 | 2 | 3;
  montant: number;
  /** Première année au titre de laquelle la TP sera due. */
  premiereAnneeImposable: number | null;
  /** `true` quand aucune valeur locative n'a été renseignée sur le dossier. */
  baseManquante: boolean;
}

/**
 * Taxe professionnelle de l'exercice.
 *
 * La base est la VALEUR LOCATIVE annuelle des locaux, matériel et outillage
 * (loi 47-06). Le chiffre d'affaires n'entre à aucun moment dans ce calcul.
 * Exonération totale les 5 premières années d'activité.
 */
export function calculerTP(input: {
  exercice: number;
  valeurLocative?: number | null;
  classe?: number | null;
  dateDebutActivite?: string | null;
}): ResultatTP {
  const classeChoisie = CLASSES_TP.find((c) => c.classe === Number(input.classe))
    ?? CLASSES_TP.find((c) => c.classe === CLASSE_TP_DEFAUT)!;
  const base = Math.max(0, round2(n(input.valeurLocative)));
  const situation = situerExercice(input.dateDebutActivite, input.exercice);
  const commun = {
    base, taux: classeChoisie.taux, classe: classeChoisie.classe,
    premiereAnneeImposable: situation.premiereAnneeImposableTP,
    baseManquante: base <= 0,
  };

  if (situation.anneeDebut != null && input.exercice - situation.anneeDebut < ANNEES_EXONERATION_TP) {
    return {
      ...commun, exonere: true, montant: 0,
      motif: "Exonéré (5 premières années d'activité - Art. 6 CGI)",
    };
  }
  return { ...commun, exonere: false, motif: "", montant: round2(base * classeChoisie.taux) };
}

// ─── TVA ─────────────────────────────────────────────────────────────────────

/** Régime TVA appliqué par le module — droit commun marocain. */
export const REGIME_TVA_LABEL = "Régime de l'Encaissement - Droit commun marocain";

export type CleStatutTva = "neant" | "a_payer" | "credit";

export interface StatutTva {
  cle: CleStatutTva;
  /** Libellé du badge. */
  label: string;
  /** Montant à afficher, toujours positif. */
  montant: number;
}

/**
 * Statut d'une période de TVA à partir du net.
 *
 * Un net nul n'est PAS un crédit : la déclaration reste obligatoire, elle est
 * simplement déposée « néant ». Le seuil est le centime, l'unité de la
 * déclaration : 0,004 MAD s'affiche 0,00 MAD et doit donc se lire « Néant ».
 */
export function statutTva(nette: number): StatutTva {
  const net = round2(n(nette));
  if (Math.abs(net) < 0.005) return { cle: "neant", label: "Néant", montant: 0 };
  if (net > 0) return { cle: "a_payer", label: "À payer", montant: net };
  return { cle: "credit", label: "Crédit", montant: round2(-net) };
}

// ─── Paramètres fiscaux portés par le dossier ────────────────────────────────

export interface ParametresFiscaux {
  dateDebutActivite: string | null;
  valeurLocative: number | null;
  classeTP: number | null;
  tauxCM: number | null;
  regimeIS: RegimeIS;
}

/**
 * Lit les paramètres fiscaux d'une ligne `dossiers` de façon TOLÉRANTE : tant
 * que la migration n'est pas appliquée, les colonnes sont absentes et le module
 * doit retomber proprement sur le droit commun plutôt que de planter.
 */
export function lireParametresFiscaux(dossier: unknown): ParametresFiscaux {
  const d = (dossier ?? {}) as Record<string, unknown>;
  const nombre = (v: unknown): number | null => {
    if (v == null || v === "") return null;
    const x = Number(v);
    return isFinite(x) ? x : null;
  };
  return {
    dateDebutActivite: parseDateIso(d.date_debut_activite as string) ? String(d.date_debut_activite).slice(0, 10) : null,
    valeurLocative: nombre(d.valeur_locative_tp),
    classeTP: nombre(d.classe_tp),
    tauxCM: nombre(d.taux_cm),
    // Le droit commun est le défaut : un statut spécifique se déclare, il ne se devine pas.
    regimeIS: normaliserRegimeIS(d.regime_is),
  };
}

// ─── Agrégats comptables d'un exercice ───────────────────────────────────────

/**
 * Comptes de produits qui entrent dans la base de la cotisation minimale
 * (art. 144-I-B CGI), par racine CGNC :
 *
 *   711 / 712  chiffre d'affaires (art. 9-I-A-1°)
 *   718        autres produits d'exploitation (art. 9-I-A-5°)
 *   716 / 756  subventions d'exploitation et d'équilibre reçues
 *   732        produits des titres de participation
 *   733        gains de change
 *   738        intérêts et autres produits financiers
 *
 * Restent HORS base : les reprises et transferts de charges (719, 739, 759), la
 * variation de stocks et les immobilisations produites (713, 714), les produits
 * de cession d'immobilisations (751), les reprises sur subventions
 * d'investissement (757) et les autres produits non courants (758). Additionner
 * toute la classe 7 gonflait la base de ces montants, donc la CM elle-même.
 */
export const RACINES_BASE_CM = ["711", "712", "716", "718", "732", "733", "738", "756"] as const;

/** Racine CGNC des impôts sur les résultats (670 / 6701 IS de l'exercice). */
export const RACINE_IMPOTS_RESULTATS = "67";

/** Journal technique des à-nouveaux : jamais une opération de l'exercice. */
const JOURNAL_AN = "AN";

export interface LigneAgregat {
  compte_numero?: string | null;
  journal_code?: string | null;
  date_ecriture?: string | null;
  debit?: number | null;
  credit?: number | null;
}

export interface AgregatsFiscaux {
  /** Produits nets de classe 7. */
  produits: number;
  /** Charges nettes de classe 6, HORS impôts sur les résultats (67). */
  charges: number;
  /** IS comptabilisé en charge (67) — à ne pas déduire de sa propre base. */
  impotsResultats: number;
  /** Résultat avant impôt = produits − charges hors 67. */
  resultatAvantImpot: number;
  /** Chiffre d'affaires (711 + 712). */
  ca: number;
  /** Base de la cotisation minimale (art. 144-I-B). */
  baseCotisationMinimale: number;
  nbEcritures: number;
}

/**
 * Agrégats d'un exercice civil, lus dans le grand livre.
 *
 * Le résultat est pris AVANT impôt : l'IS de l'exercice, s'il a déjà été
 * comptabilisé en charge (670), ne peut pas diminuer la base sur laquelle il se
 * calcule — c'était une base nette d'IS, donc un IS sous-évalué.
 */
export function agregatsFiscaux(lignes: LigneAgregat[], exercice: number): AgregatsFiscaux {
  const prefixe = String(exercice);
  const e = lignes.filter((x) =>
    String(x.date_ecriture ?? "").startsWith(prefixe)
    && String(x.journal_code ?? "").toUpperCase() !== JOURNAL_AN);
  const net = (pred: (c: string) => boolean, sens: "credit" | "debit") => round2(e
    .filter((x) => pred(String(x.compte_numero ?? "").trim()))
    .reduce((s, x) => s + (sens === "credit" ? n(x.credit) - n(x.debit) : n(x.debit) - n(x.credit)), 0));

  const produits = net((c) => c.startsWith("7"), "credit");
  const impotsResultats = net((c) => c.startsWith(RACINE_IMPOTS_RESULTATS), "debit");
  const charges = net((c) => c.startsWith("6") && !c.startsWith(RACINE_IMPOTS_RESULTATS), "debit");
  return {
    produits, charges, impotsResultats,
    resultatAvantImpot: round2(produits - charges),
    ca: net((c) => c.startsWith("711") || c.startsWith("712"), "credit"),
    baseCotisationMinimale: Math.max(0, net((c) => RACINES_BASE_CM.some((r) => c.startsWith(r)), "credit")),
    nbEcritures: e.length,
  };
}

// ─── Ajustements extra-comptables (tableau de passage) ───────────────────────

export interface AjustementsFiscaux {
  /** Réintégrations : charges non déductibles (amendes, dons hors plafond…). */
  reintegrations: number;
  /** Déductions : produits non imposables (dividendes exonérés…), déficits imputés. */
  deductions: number;
  /** IS dû au titre de N-1 saisi à la main — prime sur le recalcul, NULL sinon. */
  isDuPrecedent: number | null;
  /**
   * Déficits antérieurs ENCORE reportables à l'ouverture de l'exercice (art. 12
   * CGI : quatre exercices, sans limite pour la part due aux amortissements). Le
   * cabinet saisit le stock qu'il a suivi sur ses liasses ; le module l'impute.
   */
  deficitsAnterieurs: number;
}

export interface ImputationDeficit {
  /** Résultat fiscal avant imputation des déficits antérieurs. */
  avantDeficit: number;
  /** Part des déficits antérieurs imputée sur l'exercice. */
  deficitImpute: number;
  /** Résultat fiscal après imputation — la base de l'IS. */
  resultatFiscal: number;
  /** Déficits à reporter à l'ouverture de N+1 : reliquat + déficit de N. */
  deficitReportable: number;
}

/**
 * Imputation des déficits antérieurs (art. 12 CGI). Un déficit ne s'impute que
 * sur un BÉNÉFICE et jamais au-delà : il ne crée pas de perte supplémentaire, et
 * la cotisation minimale reste due sur sa propre base.
 */
export function imputerDeficits(agregats: AgregatsFiscaux, aj: AjustementsFiscaux): ImputationDeficit {
  const avantDeficit = round2(agregats.resultatAvantImpot + aj.reintegrations - aj.deductions);
  const deficitImpute = round2(Math.min(Math.max(0, aj.deficitsAnterieurs), Math.max(0, avantDeficit)));
  const resultat = round2(avantDeficit - deficitImpute);
  return {
    avantDeficit, deficitImpute, resultatFiscal: resultat,
    deficitReportable: round2(aj.deficitsAnterieurs - deficitImpute + Math.max(0, -avantDeficit)),
  };
}

/**
 * Ajustements fiscaux d'un exercice, lus dans `dossiers.ajustements_fiscaux`
 * (jsonb indexé par millésime : { AAAA: { reintegrations, deductions,
 * is_du_precedent } }). Tolérant : colonne absente ou valeur illisible → zéro.
 */
export function lireAjustementsFiscaux(dossier: unknown, exercice: number): AjustementsFiscaux {
  const brut = ((dossier ?? {}) as Record<string, unknown>).ajustements_fiscaux;
  const tous = brut && typeof brut === "object" ? brut as Record<string, unknown> : {};
  const a = (tous[String(exercice)] ?? {}) as Record<string, unknown>;
  const montant = (v: unknown) => { const x = Number(v); return isFinite(x) && x > 0 ? round2(x) : 0; };
  const optionnel = (v: unknown) => {
    if (v == null || v === "") return null;
    const x = Number(v);
    return isFinite(x) && x >= 0 ? round2(x) : null;
  };
  return {
    reintegrations: montant(a.reintegrations),
    deductions: montant(a.deductions),
    isDuPrecedent: optionnel(a.is_du_precedent),
    deficitsAnterieurs: montant(a.deficits_anterieurs),
  };
}

/**
 * Résultat fiscal = résultat avant impôt + réintégrations − déductions −
 * déficits antérieurs imputés (cf. `imputerDeficits`).
 */
export function resultatFiscal(agregats: AgregatsFiscaux, ajustements: AjustementsFiscaux): number {
  return imputerDeficits(agregats, ajustements).resultatFiscal;
}
