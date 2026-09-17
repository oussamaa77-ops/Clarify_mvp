// ============================================================================
// tests/golden/scenario.ts — le DOSSIER ÉTALON, décrit une fois pour toutes.
//
// Un exercice comptable complet, en données pures : ni base, ni réseau, ni
// horloge. Le semeur l'écrit, les tests l'interrogent, le banc d'audit le juge.
//
// ─── Pourquoi une description PURE ───────────────────────────────────────────
// Si le semeur calculait ses propres montants et que les tests recalculaient les
// leurs, les deux dériveraient sans que rien ne le signale : le jour où le
// semeur se trompe, les tests se trompent pareil et tout reste vert. Ici les
// attendus (`ATTENDUS`) sont posés à la main, à côté du scénario, et le semeur
// les VÉRIFIE après écriture. C'est la seule disposition où une erreur de saisie
// dans ce fichier casse la suite au lieu de la rendre complaisante.
//
// ─── Ce que le scénario couvre ───────────────────────────────────────────────
//   1. Vente au comptant, encaissée en ESPÈCES le jour même  (FA-GOLD-001)
//   2. Vente à CRÉDIT, restée partiellement due               (FA-GOLD-002)
//   3. Règlement PARTIEL, non lettrable, bascule au prorata
//   4. AVOIR (journal VTE-AVR) et solde du reliquat            (AV-GOLD-001)
//   5. Règlement GROUPÉ de deux factures par un seul virement  (FA-GOLD-004/5)
//   6. Achat fournisseur, TVA en attente au 3458               (FF-GOLD-001)
//   7. Décaissements BANQUE et CAISSE
//   8. Deux déclarations de TVA : une en DETTE (payée), une en CRÉDIT reportable
//   9. Clôture — report à nouveau de l'exercice suivant
//
// Toutes les dates tombent dans l'exercice 2026 (année civile, art. 20 CGI) ;
// seul l'à-nouveau porte le 1er janvier 2027, par construction.
// ============================================================================

export const EXERCICE = 2026;

/** Compte de produit unique du dossier : simplifie la lecture, sans rien fausser. */
export const COMPTE_PRODUIT = "71110000";
/** Charge d'achat de marchandises. */
export const COMPTE_CHARGE_ACHAT = "61110000";
/**
 * Droits d'enregistrement et de timbres : une charge réellement HORS CHAMP de
 * la TVA. Le décaissement de caisse ne doit produire AUCUNE ligne de TVA — s'il
 * en produisait une, il faudrait la justifier par un règlement, et le scénario
 * testerait alors la bascule au lieu du mouvement de caisse.
 */
export const COMPTE_CHARGE_CAISSE = "61671000";

export const COMPTE_CAISSE = "51610000";
export const COMPTE_BANQUE = "51410000";

export const CLIENT_GOLDEN = {
  nom: "CLARIFY CLIENT ETALON",
  code_auxiliaire: "C0001",
  /** 34210001 — collectif 3421 + code de fiche « 0001 » (cf. comptes-auxiliaires.ts). */
  compte: "34210001",
  ice: "001789456000073",
  if_fiscal: "40889712",
} as const;

export const FOURNISSEUR_GOLDEN = {
  nom: "CLARIFY FOURNISSEUR ETALON",
  code_auxiliaire: "F0001",
  /** 44110001 — collectif 4411 + code de fiche « 0001 ». */
  compte: "44110001",
  ice: "002314887000041",
  if_fiscal: "51203366",
} as const;

// ─── Les pièces ──────────────────────────────────────────────────────────────

export interface LigneDetail {
  designation: string;
  quantite: number;
  prix_unitaire: number;
  taux_tva?: number;
}

export interface FactureGolden {
  numero: string;
  /** Rôle joué dans le scénario — sert au compte rendu du semeur. */
  role: string;
  type: "facture" | "avoir";
  journal: "VTE" | "VTE-AVR";
  date: string;
  ht: number;
  tva: number;
  ttc: number;
  lignes: LigneDetail[];
}

export const VENTES: FactureGolden[] = [
  {
    numero: "FA-GOLD-001", role: "Vente au comptant, encaissée en espèces",
    type: "facture", journal: "VTE", date: "2026-03-02",
    ht: 10000, tva: 2000, ttc: 12000,
    lignes: [{ designation: "Lot de marchandises A", quantite: 20, prix_unitaire: 500, taux_tva: 20 }],
  },
  {
    numero: "FA-GOLD-002", role: "Vente à crédit, réglée partiellement",
    type: "facture", journal: "VTE", date: "2026-04-06",
    ht: 20000, tva: 4000, ttc: 24000,
    lignes: [{ designation: "Lot de marchandises B", quantite: 40, prix_unitaire: 500, taux_tva: 20 }],
  },
  {
    numero: "FA-GOLD-003", role: "Vente ramenée par un avoir, puis soldée",
    type: "facture", journal: "VTE", date: "2026-05-04",
    ht: 8000, tva: 1600, ttc: 9600,
    lignes: [{ designation: "Lot de marchandises C", quantite: 16, prix_unitaire: 500, taux_tva: 20 }],
  },
  {
    // Montants NÉGATIFS, et c'est la seule représentation cohérente : `caHtGrandLivre`
    // prend la classe 7 en NET des débits, et `rapprocherCaProduits` compare cette
    // somme au Σ des `montant_ht`. Un avoir stocké en positif gonflerait le CA du
    // double du montant annulé — une fois au débit du 7111, une fois dans le Σ.
    numero: "AV-GOLD-001", role: "Avoir sur FA-GOLD-003 (journal VTE-AVR)",
    type: "avoir", journal: "VTE-AVR", date: "2026-06-08",
    ht: -2000, tva: -400, ttc: -2400,
    lignes: [{ designation: "Retour marchandises C", quantite: -4, prix_unitaire: 500, taux_tva: 20 }],
  },
  {
    numero: "FA-GOLD-004", role: "Réglée par un virement groupé",
    type: "facture", journal: "VTE", date: "2026-07-06",
    ht: 5000, tva: 1000, ttc: 6000,
    lignes: [{ designation: "Prestation D", quantite: 10, prix_unitaire: 500, taux_tva: 20 }],
  },
  {
    numero: "FA-GOLD-005", role: "Réglée par le même virement groupé",
    type: "facture", journal: "VTE", date: "2026-07-13",
    ht: 3000, tva: 600, ttc: 3600,
    lignes: [{ designation: "Prestation E", quantite: 6, prix_unitaire: 500, taux_tva: 20 }],
  },
];

export const ACHAT_GOLDEN = {
  numero: "FF-GOLD-001",
  role: "Achat fournisseur, TVA en attente au 3458, payé partiellement",
  date: "2026-04-20",
  ht: 12000, tva: 2400, ttc: 14400,
  lignes: [{ designation: "Matières premières", quantite: 24, prix_unitaire: 500, taux_tva: 20 }] as LigneDetail[],
} as const;

// ─── Les règlements ──────────────────────────────────────────────────────────
//
// `lettrage` non vide = la pièce est SOLDÉE et le groupe se boucle à zéro sur le
// compte de tiers. Vide = règlement partiel, non lettrable : c'est alors la
// RÉFÉRENCE qui relie la bascule de TVA à sa ligne de banque (cf. R4 du banc).

export interface ReglementGolden {
  /** Numéro de la ou des factures réglées. Plusieurs = virement groupé. */
  factures: string[];
  role: string;
  date: string;
  /** Montant reçu (client) ou versé (fournisseur), toujours positif. */
  montant: number;
  sens: "client" | "fournisseur";
  /** Compte de trésorerie mouvementé — décide du journal (BQ ou CAI). */
  compte: string;
  reference: string;
  /** Code de lettrage, vide sur un règlement partiel. */
  lettrage: string;
  /**
   * Avoirs entrant dans le MÊME groupe de lettrage.
   *
   * Un groupe se solde à zéro sur le compte de tiers, et c'est sa définition :
   * 9 600 de créance, moins 2 400 d'avoir, moins 7 200 encaissés. Oublier
   * l'avoir laisserait le code AC ouvert de 2 400 MAD — exactement ce que la
   * troisième vérification de R1 dénonce.
   */
  avoirs?: string[];
}

export const REGLEMENTS: ReglementGolden[] = [
  {
    factures: ["FA-GOLD-001"], role: "Encaissement en ESPÈCES, le jour de la vente",
    date: "2026-03-02", montant: 12000, sens: "client",
    compte: COMPTE_CAISSE, reference: "REG-GOLD-001", lettrage: "AA",
  },
  {
    factures: ["FA-GOLD-002"], role: "Règlement PARTIEL — 9 000 sur 24 000, non lettrable",
    date: "2026-05-11", montant: 9000, sens: "client",
    compte: COMPTE_BANQUE, reference: "REG-GOLD-002-1", lettrage: "",
  },
  {
    factures: ["FA-GOLD-003"], role: "Solde de FA-GOLD-003, avoir déduit (9 600 − 2 400)",
    date: "2026-06-15", montant: 7200, sens: "client",
    compte: COMPTE_BANQUE, reference: "REG-GOLD-003", lettrage: "AC",
    avoirs: ["AV-GOLD-001"],
  },
  {
    factures: [ACHAT_GOLDEN.numero], role: "Décaissement BANQUE au fournisseur — partiel",
    date: "2026-06-20", montant: 8400, sens: "fournisseur",
    compte: COMPTE_BANQUE, reference: "REG-GOLD-FF-1", lettrage: "",
  },
  {
    factures: ["FA-GOLD-004", "FA-GOLD-005"],
    role: "Virement GROUPÉ soldant deux factures d'un coup",
    date: "2026-08-03", montant: 9600, sens: "client",
    compte: COMPTE_BANQUE, reference: "REG-GOLD-GROUPE", lettrage: "AD",
  },
];

/**
 * L'avoir éteint 2 400 MAD de créance sans qu'aucun argent ne circule.
 *
 * Il est enregistré dans `paiements` — non par abus de langage, mais parce que
 * cette table EST le moteur du reste dû (cf. la migration 20260710130000). Sans
 * cette ligne, FA-GOLD-003 resterait « partielle » à 2 400 MAD au niveau
 * commercial alors que son compte de tiers est soldé et lettré : le banc
 * d'audit signalerait, à juste titre, un écart d'encours de 2 400 MAD.
 */
export const AVOIR_IMPUTE = {
  facture: "FA-GOLD-003",
  avoir: "AV-GOLD-001",
  date: "2026-06-08",
  montant: 2400,
} as const;

/** Décaissement d'espèces — la seule sortie de caisse du scénario. */
export const DECAISSEMENT_CAISSE = {
  role: "Décaissement CAISSE — droits de timbre, hors champ de TVA",
  date: "2026-06-22",
  montant: 1200,
  compte_charge: COMPTE_CHARGE_CAISSE,
  reference: "CAI-GOLD-001",
  libelle: "Droits d'enregistrement et de timbres",
} as const;

// ─── Les déclarations de TVA ─────────────────────────────────────────────────
//
// Deux périodes, et deux issues opposées — c'est le but :
//   • 2026-03 : la TVA collectée sur la vente au comptant, sans déductible.
//     Position DÉBITRICE de l'État, donc dette au crédit du 4456, puis paiement.
//   • 2026-06 : 1 200 collectés (solde FA-GOLD-003) contre 1 400 déduits
//     (décaissement fournisseur). Position CRÉDITRICE : crédit de TVA
//     reportable, aucun paiement — « sans objet », et non « impayé ».

export const DECLARATIONS = [
  {
    periode: "2026-03",
    role: "Période en DETTE — 4456 crédité, puis payé à la DGI",
    /** Attendu : collectée − déductible. Positif = dette. */
    net: 2000,
    paiement: { date: "2026-05-20", compte: COMPTE_BANQUE },
  },
  {
    periode: "2026-06",
    role: "Période en CRÉDIT reportable — paiement sans objet",
    net: -200,
    paiement: null as null | { date: string; compte: string },
  },
] as const;

/** Premier jour de l'exercice rouvert : la date de l'à-nouveau. */
export const CLOTURE = {
  role: "Clôture 2026 — report à nouveau au 01/01/2027",
  date: "2027-01-01",
  reference: "AN-2027",
} as const;

// ─── Ce que le dossier DOIT valoir une fois semé ─────────────────────────────
//
// Posés à la main, jamais recalculés depuis le scénario : c'est ce qui rend le
// contrôle capable de détecter une erreur DANS le scénario lui-même.

export const ATTENDUS = {
  /** Σ des HT facturés, avoir compris (négatif) = Σ des crédits nets de classe 7. */
  caHt: 44000,
  /** Solde débiteur non lettré du 342x : le reliquat de FA-GOLD-002. */
  encoursClients: 15000,
  /** 12 000 encaissés en mars, 1 200 décaissés en juin. */
  caisseCloture: 10800,
  /** +9 000 −2 000 +7 200 −8 400 +9 600. */
  banqueCloture: 15400,
  /** Le point le plus bas atteint par la caisse — jamais négatif (invariant C_t ≥ 0). */
  caisseCreux: 0,
  /** TVA restée en attente au 4458 : le reliquat non encaissé de FA-GOLD-002. */
  tvaAttenteVente: 2500,
  /** TVA restée en attente au 3458 : le reliquat non payé de FF-GOLD-001. */
  tvaAttenteAchat: 1000,
  /** Solde du 4456 en fin d'exercice : le crédit reportable de juin, au débit. */
  tvaDue: -200,
  /** Nombre de pièces de vente, avoir compris. */
  nbVentes: 6,
  /** Nombre de lignes `paiements` — 5 règlements clients/fournisseur + l'avoir imputé. */
  nbPaiements: 7,
} as const;

/** Toutes les références de pièce du scénario, pour le nettoyage et l'idempotence. */
export function referencesGolden(): string[] {
  return [
    ...VENTES.map((f) => f.numero),
    ACHAT_GOLDEN.numero,
    ...REGLEMENTS.map((r) => r.reference),
    DECAISSEMENT_CAISSE.reference,
    ...DECLARATIONS.map((d) => `DECL-TVA-${d.periode}`),
    CLOTURE.reference,
  ];
}
