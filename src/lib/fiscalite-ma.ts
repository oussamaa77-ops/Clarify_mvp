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
 * Régime d'imposition du dossier.
 *  - `droit_commun`     : barème ci-dessus (20 % / 35 %) ;
 *  - `taux_specifique`  : 20 % PLAFONNÉ quel que soit le bénéfice — sociétés à
 *    statut particulier (exportateurs, zones d'accélération industrielle, CFC…),
 *    qui échappent au taux de 35 % au-delà de 100 MDH.
 */
export type RegimeIS = "droit_commun" | "taux_specifique";

/** Taux plafond des sociétés à statut spécifique (art. 6 / 19 CGI). */
export const TAUX_IS_SPECIFIQUE = 0.20;

export const TRANCHE_IS_SPECIFIQUE: TrancheIS = {
  plancher: 0, taux: TAUX_IS_SPECIFIQUE,
  label: "Taux spécifique 20 % (statut particulier)",
};

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
export function trancheIS(resultatFiscal: number, regime: RegimeIS = "droit_commun"): TrancheIS {
  if (regime === "taux_specifique") return TRANCHE_IS_SPECIFIQUE;
  const base = Math.max(0, n(resultatFiscal));
  let retenue = BAREME_IS[0];
  for (const t of BAREME_IS) if (base >= t.plancher) retenue = t;
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
  const regime: RegimeIS = input.regime === "taux_specifique" ? "taux_specifique" : "droit_commun";
  const resultatFiscal = round2(n(input.resultatFiscal));
  const tranche = trancheIS(resultatFiscal, regime);
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
    regimeIS: d.regime_is === "taux_specifique" ? "taux_specifique" : "droit_commun",
  };
}
