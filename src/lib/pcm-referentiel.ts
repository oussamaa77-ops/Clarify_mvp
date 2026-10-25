// ============================================================================
// pcm-referentiel.ts — LA source unique des comptes et racines PCM de Clarify.
//
// ─── Pourquoi un référentiel unique ──────────────────────────────────────────
// Les numéros de comptes vivaient en clair dans une trentaine de fichiers, et
// les copies avaient divergé : la même dépense télécom partait en 6145 depuis la
// banque et en 6132 (redevances de crédit-bail) depuis les justificatifs ;
// l'assurance en 6161 (impôts et taxes directs) ; la taxe professionnelle en
// 6313 (intérêts) ; les intérêts créditeurs en 7611, rubrique inexistante au
// CGNC. Chaque copie « avait l'air » juste. Seule leur confrontation montrait
// l'erreur.
//
// Ce module ne fait qu'une chose : NOMMER les comptes que l'application
// mouvemente, et dire ce qu'est un numéro recevable. Aucune I/O, aucun import —
// il peut être lu par n'importe quelle couche sans créer de cycle.
//
// ─── Ce qu'il ne fait PAS ────────────────────────────────────────────────────
// Il ne décide d'aucune imputation nouvelle. Chaque constante ci-dessous est un
// compte du CGNC vérifié contre la nomenclature. Les anciens numéros hors CGNC
// que l'historique peut encore porter figurent dans `COMPTES_HISTORIQUES_HORS_CGNC` :
// lisibles avec un avertissement, jamais produits par le code.
//
// ─── Longueur ────────────────────────────────────────────────────────────────
// Le CGNC n'impose AUCUNE longueur : 4 chiffres (compte principal, 5141), 5
// (sous-compte, 34552), davantage pour l'auxiliaire (44110005). La validation
// accepte donc de 4 à 10 chiffres. La forme de STOCKAGE sur 8 chiffres reste
// une convention d'échange du projet (cf. numero-compte.ts), pas une règle PCM.
// ============================================================================

// ─── 1. Classes et rubriques du CGNC ─────────────────────────────────────────

/** Classes mouvementables en comptabilité générale (0 = hors bilan, 9 = analytique : exclues). */
export const CLASSES_PCM: Record<string, string> = {
  "1": "Comptes de financement permanent",
  "2": "Comptes d'actif immobilisé",
  "3": "Comptes d'actif circulant (hors trésorerie)",
  "4": "Comptes de passif circulant (hors trésorerie)",
  "5": "Comptes de trésorerie",
  "6": "Comptes de charges",
  "7": "Comptes de produits",
  "8": "Comptes de résultats",
};

/**
 * Rubriques (2 premiers chiffres) du CGNC, classes 1 à 7.
 *
 * Un numéro dont la rubrique n'y figure pas est « clairement hors référentiel »
 * — typiquement un numéro du plan comptable FRANÇAIS (401, 411, 471 en classe 4
 * n'existent pas comme rubriques 40/41 au Maroc ; 62, 64, 66, 76 non plus).
 * La classe 8 n'est pas détaillée : elle porte les soldes intermédiaires et ne
 * se mouvemente pas par saisie courante.
 */
export const RUBRIQUES_CGNC: Record<string, string> = {
  "11": "Capitaux propres",
  "13": "Capitaux propres assimilés",
  "14": "Dettes de financement",
  "15": "Provisions durables pour risques et charges",
  "16": "Comptes de liaison des établissements et succursales",
  "17": "Écarts de conversion – passif",
  "21": "Immobilisations en non-valeurs",
  "22": "Immobilisations incorporelles",
  "23": "Immobilisations corporelles",
  "24": "Immobilisations financières",
  "25": "Titres de participation",
  "27": "Écarts de conversion – actif",
  "28": "Amortissements des immobilisations",
  "29": "Provisions pour dépréciation des immobilisations",
  "31": "Stocks",
  "34": "Créances de l'actif circulant",
  "35": "Titres et valeurs de placement",
  "37": "Écarts de conversion – actif (éléments circulants)",
  "39": "Provisions pour dépréciation des comptes de l'actif circulant",
  "44": "Dettes du passif circulant",
  "45": "Autres provisions pour risques et charges",
  "47": "Écarts de conversion – passif (éléments circulants)",
  "51": "Trésorerie – actif",
  "55": "Trésorerie – passif",
  "59": "Provisions pour dépréciation des comptes de trésorerie",
  "61": "Charges d'exploitation",
  "63": "Charges financières",
  "65": "Charges non courantes",
  "67": "Impôts sur les résultats",
  "71": "Produits d'exploitation",
  "73": "Produits financiers",
  "75": "Produits non courants",
};

// ─── 2. Comptes mouvementés par l'application ────────────────────────────────

/**
 * Comptes que le code IMPUTE. Forme courte (PCM) : la forme de stockage 8
 * chiffres s'obtient à la frontière par `normaliserNumeroCompte`.
 */
export const PCM = {
  // Classe 1
  REPORT_A_NOUVEAU_CREDITEUR: "1161",
  REPORT_A_NOUVEAU_DEBITEUR: "1169",
  /**
   * 1181 / 1189 « Résultats nets en instance d'affectation ». C'est là que
   * l'à-nouveau porte le résultat de l'exercice clos : son affectation (réserve
   * légale 1140, dividendes 4465, report à nouveau 116x) relève de l'AGO et se
   * passe ensuite par OD. Le verser d'office en 116x sautait la réserve légale.
   */
  RESULTAT_INSTANCE_AFFECTATION_CREDITEUR: "1181",
  RESULTAT_INSTANCE_AFFECTATION_DEBITEUR: "1189",
  // Classe 3
  FOURNISSEURS_AVANCES_VERSEES: "3411",
  CLIENTS: "3421",
  /** 3453 « Acomptes sur impôts sur les résultats » — acomptes d'IS versés. */
  ACOMPTES_IS: "3453",
  TVA_RECUPERABLE_CHARGES: "34552",
  /** 3456 « État – crédit de TVA (suivant déclarations) ». */
  CREDIT_TVA: "3456",
  /** « État – autres comptes débiteurs », employé comme TVA sur achats EN ATTENTE. */
  TVA_ATTENTE_ACHAT: "3458",
  /** 3497 « Comptes transitoires ou d'attente – débiteurs ». */
  ATTENTE_BANQUE_DEBIT: "3497",
  // Classe 4
  /** 4421 « Clients – avances et acomptes reçus sur commandes en cours ». */
  CLIENTS_AVANCES_RECUES: "4421",
  /** Ancien compte d'acomptes clients (plan français 419) : LU dans l'historique, jamais écrit. */
  ANCIEN_CLIENTS_AVANCES_RECUES: "4191",
  FOURNISSEURS: "4411",
  REMUNERATIONS_DUES_PERSONNEL: "4432",
  CNSS: "4441",
  /** 4443 « Caisses de retraite » — CIMR. */
  CAISSES_RETRAITE: "4443",
  /** 44525 « État, IGR » (sous-compte de 4452) — IR retenu à la source sur salaires. */
  IR_RETENU_SALAIRES: "44525",
  TVA_FACTUREE_EXIGIBLE: "44551",
  TVA_DUE: "4456",
  /** « État – autres comptes créditeurs », employé comme TVA facturée EN ATTENTE. */
  TVA_ATTENTE_VENTE: "4458",
  /** 4497 « Comptes transitoires ou d'attente – créditeurs ». */
  ATTENTE_BANQUE_CREDIT: "4497",
  // Classe 5
  VIREMENTS_DE_FONDS: "5115",
  BANQUE: "5141",
  CAISSE: "5161",
  /** Sous-compte de caisse par défaut, aligné sur la comptabilité auxiliaire. */
  CAISSE_DEFAUT: "51610000",
  // Classe 6
  ACHATS_MARCHANDISES: "6111",
  ACHATS_MATIERES_PREMIERES: "6121",
  /** 61223 « Achats de combustibles » — carburant. */
  ACHATS_COMBUSTIBLES: "61223",
  ACHATS_NON_STOCKES: "6125",
  /** 61251 « Achats de fournitures non stockables (eau, électricité) ». */
  EAU_ELECTRICITE: "61251",
  LOCATIONS: "6131",
  ENTRETIEN_REPARATIONS: "6133",
  PRIMES_ASSURANCES: "6134",
  HONORAIRES: "6136",
  /**
   * Repli des achats non catégorisés : 6125 « Achats non stockés de matières et
   * fournitures ». C'était 6141 « Études, recherches et documentation ».
   */
  CHARGE_DEFAUT: "6125",
  ETUDES_RECHERCHES_DOCUMENTATION: "6141",
  TRANSPORTS: "6142",
  DEPLACEMENTS_MISSIONS_RECEPTIONS: "6143",
  PUBLICITE: "6144",
  FRAIS_POSTAUX_TELECOMMUNICATIONS: "6145",
  /**
   * 61473 « Frais et commissions sur services bancaires » (rubrique 6147
   * « Services bancaires »). C'était 6347 — la rubrique 634 n'existe pas au CGNC.
   */
  SERVICES_BANCAIRES: "61473",
  IMPOTS_TAXES_DIRECTS: "6161",
  DROITS_ENREGISTREMENT_TIMBRE: "61671",
  /** 61678 « Autres impôts, taxes et droits assimilés » — droits de douane non incorporés au coût d'achat. */
  AUTRES_IMPOTS_TAXES: "61678",
  REMUNERATIONS_PERSONNEL: "6171",
  CHARGES_SOCIALES: "6174",
  // Classe 7
  VENTES_MARCHANDISES: "7111",
  VENTES_BIENS_PRODUITS: "7121",
  VENTES_SERVICES: "7124",
  INTERETS_PRODUITS_ASSIMILES: "7381",
} as const;

/** Racines de DÉTECTION — on impute sur le compte précis, on reconnaît par racine. */
export const RACINES_PCM = {
  CLIENTS: "342",
  CLIENTS_COLLECTIF: PCM.CLIENTS,
  FOURNISSEURS: "441",
  FOURNISSEURS_COLLECTIF: PCM.FOURNISSEURS,
  TVA_RECUPERABLE: "3455",
  TVA_FACTUREE: "4455",
  TVA_DUE: PCM.TVA_DUE,
  CREDIT_TVA: PCM.CREDIT_TVA,
  TVA_ATTENTE_ACHAT: PCM.TVA_ATTENTE_ACHAT,
  TVA_ATTENTE_VENTE: PCM.TVA_ATTENTE_VENTE,
  BANQUE: "514",
  CAISSE: "516",
  TRESORERIE_ACTIF: "51",
  REPORT_A_NOUVEAU: "116",
  RESULTAT_INSTANCE_AFFECTATION: "118",
  CHARGES: "6",
  PRODUITS: "7",
} as const;

/**
 * Comptes d'attente (transitoires) du CGNC : 3497 débiteurs, 4497 créditeurs.
 * Les anciens numéros 4711 / 4712 (plan français) y figurent pour que
 * l'historique non encore renuméroté reste détecté.
 */
export const COMPTES_ATTENTE: readonly string[] = [
  PCM.ATTENTE_BANQUE_DEBIT, PCM.ATTENTE_BANQUE_CREDIT, "4711", "4712",
];

/**
 * Comptes de frais bancaires — 61473 (CGNC) et l'ancien 6347 de l'historique.
 * Le 6147 nu n'en fait PAS partie : l'historique l'a employé pour la restauration.
 */
export const COMPTES_FRAIS_BANCAIRES: readonly string[] = [PCM.SERVICES_BANCAIRES, "6347"];

/** Le compte relève-t-il des frais bancaires (61473, ou l'historique 6347) ? */
export const estCompteFraisBancaires = (compte: unknown): boolean =>
  COMPTES_FRAIS_BANCAIRES.some((c) => String(compte ?? "").trim().startsWith(c));

/**
 * Anciens numéros HORS CGNC que l'application a produits avant correction, avec
 * leur remplacement. Ils restent lisibles dans l'historique (avertissement), et
 * la migration `20261024120000_conformite_cgnc.sql` les renumérote.
 */
export const COMPTES_HISTORIQUES_HORS_CGNC: Record<string, string> = {
  "4191": "Numérotation du plan FRANÇAIS (419) : remplacé par 4421 « Clients – avances et "
    + "acomptes reçus sur commandes en cours ». La rubrique 41 n'existe pas au CGNC.",
  "4711": "Au CGNC, la rubrique 47 porte les écarts de conversion – passif : remplacé par 3497 "
    + "« Comptes transitoires ou d'attente – débiteurs ».",
  "4712": "Remplacé par 4497 « Comptes transitoires ou d'attente – créditeurs ».",
  "6347": "La rubrique 634 n'existe pas au CGNC : remplacé par 61473 « Frais et commissions "
    + "sur services bancaires ».",
  "61241": "6124 est « Variation des stocks de matières et fournitures » : le carburant relève "
    + "de 61223 « Achats de combustibles ».",
};

/**
 * Comptes employés par l'application dont l'usage est admissible mais doit être
 * documenté dans le manuel de procédures du dossier — plus les anciens numéros
 * hors CGNC de l'historique.
 */
export const COMPTES_A_VALIDER: Record<string, string> = {
  ...COMPTES_HISTORIQUES_HORS_CGNC,
  "3458": "« État – autres comptes débiteurs » employé comme TVA sur achats en attente "
    + "(régime des encaissements) : usage admissible par sous-compte, à documenter.",
  "4458": "« État – autres comptes créditeurs » employé comme TVA facturée en attente : "
    + "usage admissible par sous-compte, à documenter.",
};

// ─── 3. Usages : quelle racine un rôle comptable a-t-il le droit d'employer ─

export type UsageCompte =
  | "charge" | "produit"
  | "client" | "fournisseur" | "acompte_client" | "acompte_fournisseur"
  | "tva_collectee" | "tva_recuperable" | "tva_attente_vente" | "tva_attente_achat" | "tva_due" | "credit_tva"
  | "banque" | "caisse" | "tresorerie" | "virement_fonds" | "attente_bancaire"
  | "report_a_nouveau" | "personnel" | "organisme_social" | "impots";

/** Racines admises par usage. Un compte « dans le bon rôle » commence par l'une d'elles. */
export const RACINES_PAR_USAGE: Record<UsageCompte, readonly string[]> = {
  charge: [RACINES_PCM.CHARGES],
  produit: [RACINES_PCM.PRODUITS],
  client: [RACINES_PCM.CLIENTS],
  fournisseur: [RACINES_PCM.FOURNISSEURS],
  acompte_client: [PCM.CLIENTS_AVANCES_RECUES, PCM.ANCIEN_CLIENTS_AVANCES_RECUES],
  acompte_fournisseur: [PCM.FOURNISSEURS_AVANCES_VERSEES],
  tva_collectee: [RACINES_PCM.TVA_FACTUREE],
  tva_recuperable: [RACINES_PCM.TVA_RECUPERABLE],
  tva_attente_vente: [RACINES_PCM.TVA_ATTENTE_VENTE],
  tva_attente_achat: [RACINES_PCM.TVA_ATTENTE_ACHAT],
  tva_due: [RACINES_PCM.TVA_DUE],
  credit_tva: [RACINES_PCM.CREDIT_TVA],
  banque: [RACINES_PCM.BANQUE],
  caisse: [RACINES_PCM.CAISSE],
  tresorerie: [RACINES_PCM.BANQUE, RACINES_PCM.CAISSE],
  virement_fonds: [PCM.VIREMENTS_DE_FONDS],
  attente_bancaire: COMPTES_ATTENTE,
  report_a_nouveau: [RACINES_PCM.REPORT_A_NOUVEAU, RACINES_PCM.RESULTAT_INSTANCE_AFFECTATION],
  personnel: ["443"],
  organisme_social: ["444"],
  /** Impôts retenus ou versés d'avance : 4452 (État créditeur — IR retenu), 3453 (acomptes d'IS). */
  impots: ["4452", PCM.ACOMPTES_IS],
};

// ─── 4. validatePcmAccount ───────────────────────────────────────────────────

export const LONGUEUR_MIN_PCM = 4;
export const LONGUEUR_MAX_PCM = 10;

/**
 * Dérogations de RUBRIQUE : comptes hors CGNC que l'application produit encore
 * et qu'on ne peut refuser sans casser un flux existant. Chacune renvoie à sa
 * question dans `COMPTES_A_VALIDER`. Une dérogation ne rend PAS le compte
 * conforme : elle le rend recevable, avec un avertissement.
 */
/** 4191 : ancien compte d'acomptes clients (plan français), lisible dans l'historique. */
export const DEROGATIONS_RUBRIQUE: readonly string[] = [PCM.ANCIEN_CLIENTS_AVANCES_RECUES];

export interface VerdictPcm {
  /** `true` si aucune erreur — les avertissements n'empêchent rien. */
  ok: boolean;
  /** Numéro tel que reçu, espaces retirés. */
  numero: string;
  /** Forme courte : zéros de complément retirés, jamais sous 4 chiffres. */
  significatif: string;
  classe: string;
  rubrique: string;
  erreurs: string[];
  avertissements: string[];
}

const txt = (v: unknown) => String(v ?? "").trim();

/** Zéros de complément retirés (44580000 → 4458), sans descendre sous 4 chiffres. */
function formeCourte(c: string): string {
  let fin = c.length;
  while (fin > LONGUEUR_MIN_PCM && c[fin - 1] === "0") fin -= 1;
  return c.slice(0, fin);
}

/** Le compte (sous toutes ses longueurs) relève-t-il de cette racine ? */
export function relevePcm(compte: unknown, racine: string): boolean {
  const c = txt(compte);
  return c !== "" && racine !== "" && c.startsWith(racine);
}

/**
 * Un numéro de compte est-il recevable dans le grand livre, et pour cet usage ?
 *
 * ERREURS (bloquantes) :
 *   • format — vide, non numérique, moins de 4 ou plus de 10 chiffres ;
 *   • classe — 0 (hors bilan) ou 9 (analytique) ;
 *   • rubrique — absente du CGNC en classes 1 à 7 (hors dérogation documentée) ;
 *   • usage — compte hors des racines admises pour le rôle demandé.
 *
 * AVERTISSEMENTS (non bloquants) :
 *   • compte dont la conformité CGNC est à valider (`COMPTES_A_VALIDER`) ;
 *   • classe 8, qui ne se saisit pas couramment.
 *
 * La longueur n'est jamais imposée à 8 : le CGNC ne l'exige pas.
 */
export function validatePcmAccount(
  valeur: unknown,
  opts: { usage?: UsageCompte } = {},
): VerdictPcm {
  const numero = txt(valeur);
  const erreurs: string[] = [];
  const avertissements: string[] = [];
  const vide = { numero, significatif: numero, classe: "", rubrique: "" };

  if (!numero) {
    return { ok: false, ...vide, erreurs: ["Numéro de compte vide."], avertissements };
  }
  if (!/^[0-9]+$/.test(numero)) {
    return { ok: false, ...vide, erreurs: [`« ${numero} » n'est pas un numéro de compte : chiffres uniquement.`], avertissements };
  }
  if (numero.length < LONGUEUR_MIN_PCM || numero.length > LONGUEUR_MAX_PCM) {
    return {
      ok: false, ...vide,
      erreurs: [`« ${numero} » : ${numero.length} chiffre(s), un compte mouvementable en compte `
        + `de ${LONGUEUR_MIN_PCM} à ${LONGUEUR_MAX_PCM}.`],
      avertissements,
    };
  }

  const significatif = formeCourte(numero);
  const classe = numero.charAt(0);
  const rubrique = numero.slice(0, 2);

  if (!CLASSES_PCM[classe]) {
    erreurs.push(`« ${numero} » : classe ${classe} non mouvementable en comptabilité générale `
      + `(classe 0 = engagements hors bilan, classe 9 = comptabilité analytique).`);
  } else if (classe === "8") {
    avertissements.push(`« ${numero} » : classe 8 (résultats), qui ne se mouvemente pas par saisie courante.`);
  } else if (!RUBRIQUES_CGNC[rubrique]) {
    const derogation = DEROGATIONS_RUBRIQUE.some((d) => significatif.startsWith(d));
    const msg = `« ${numero} » : rubrique ${rubrique} absente du CGNC — numéro hors référentiel `
      + `(souvent un compte du plan français).`;
    if (derogation) avertissements.push(`${msg} Dérogation documentée, à valider.`);
    else erreurs.push(msg);
  }

  const aValider = Object.keys(COMPTES_A_VALIDER).find((c) => significatif.startsWith(c));
  if (aValider) avertissements.push(`« ${numero} » — à valider : ${COMPTES_A_VALIDER[aValider]}`);

  if (opts.usage) {
    const racines = RACINES_PAR_USAGE[opts.usage];
    if (!racines.some((r) => numero.startsWith(r))) {
      erreurs.push(`« ${numero} » incohérent avec l'usage « ${opts.usage} » : `
        + `racine attendue ${racines.join(" / ")}.`);
    }
  }

  return { ok: erreurs.length === 0, numero, significatif, classe, rubrique, erreurs, avertissements };
}

// ─── 5. Contrôle d'un lot de lignes ──────────────────────────────────────────

export interface ControleComptesPcm {
  ok: boolean;
  violations: string[];
  avertissements: string[];
}

/**
 * Tous les comptes d'un lot sont-ils recevables ? Lit `compte_numero` ou
 * `compte` — les deux conventions du projet. Un avertissement ne bloque pas.
 *
 * Une ligne SANS champ de compte (null / absent) n'est pas jugée ici : c'est une
 * vue partielle d'écriture, que d'autres contrôles lisent (unicité, cut-off).
 * Un compte PRÉSENT mais vide, lui, est refusé.
 */
export function controlerComptesPcm(
  lignes: readonly { compte_numero?: string | null; compte?: string | null }[],
): ControleComptesPcm {
  const violations = new Set<string>();
  const avertissements = new Set<string>();
  for (const l of lignes ?? []) {
    const brut = l?.compte_numero ?? l?.compte;
    if (brut == null) continue;
    const v = validatePcmAccount(brut);
    v.erreurs.forEach((e) => violations.add(e));
    v.avertissements.forEach((a) => avertissements.add(a));
  }
  return { ok: violations.size === 0, violations: [...violations], avertissements: [...avertissements] };
}

/** Même contrôle, bloquant. */
export function assertComptesPcm(
  lignes: readonly { compte_numero?: string | null; compte?: string | null }[],
  contexte = "Écriture refusée",
): void {
  const c = controlerComptesPcm(lignes);
  if (!c.ok) throw new Error(`${contexte} — compte(s) hors référentiel PCM : ${c.violations.join(" ")}`);
}
