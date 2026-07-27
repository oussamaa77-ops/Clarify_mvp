// Indicateurs fiscaux et de trésorerie du dashboard (régime marocain).
// Logique pure, testable sans rendu : c'est ici que vit la règle métier, les
// écrans ne font que l'afficher.

import { DICTIONNAIRE_PCM } from "./categorization-engine";

/** Facture (vente ou achat) vue sous l'angle des montants et du règlement. */
export interface FactureFiscale {
  montant_ht?: number | null;
  montant_tva?: number | null;
  montant_ttc?: number | null;
  montant_paye?: number | null;
  montant_restant?: number | null;
  statut_paiement?: string | null;
  date_facture?: string | null;
  date_echeance?: string | null;
}

function n(v: unknown): number {
  const x = Number(v);
  return isFinite(x) ? x : 0;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Part réellement encaissée/décaissée d'une facture, entre 0 et 1.
 *
 * Le régime de l'ENCAISSEMENT ne rend exigible que la TVA effectivement
 * encaissée : sur une facture réglée à moitié, seule la moitié de la TVA est
 * due. On raisonne donc au prorata et jamais en tout-ou-rien.
 */
export function partReglee(f: FactureFiscale): number {
  const ttc = n(f.montant_ttc);
  // Sans TTC exploitable, le statut est le seul indice disponible.
  if (ttc <= 0) return f.statut_paiement === "payee" ? 1 : 0;
  // Un statut « payée » fait foi même si montant_paye n'a pas été renseigné
  // (factures antérieures au moteur de paiement).
  if (f.statut_paiement === "payee") return 1;
  const paye = f.montant_paye != null
    ? n(f.montant_paye)
    // À défaut, on déduit l'encaissé du reste dû.
    : f.montant_restant != null ? ttc - n(f.montant_restant) : 0;
  if (paye <= 0) return 0;
  return Math.min(1, paye / ttc);
}

export interface SyntheseTva {
  /** TVA sur les ventes effectivement encaissées. */
  collectee: number;
  /** TVA sur les achats effectivement décaissés. */
  deductible: number;
  /** Collectée − déductible. Négatif = crédit de TVA en faveur de l'entreprise. */
  nette: number;
  /** `true` quand l'entreprise est créditrice (nette < 0). */
  estCredit: boolean;
}

/**
 * Synthèse TVA au régime de l'encaissement, sur la période fournie (bornes
 * incluses, format YYYY-MM ou YYYY-MM-DD ; omises = tout l'historique).
 *
 * Volontairement calculé depuis les FACTURES et leur règlement, et non depuis
 * les écritures 44551/34552 : ces dernières suivent le fait générateur
 * comptable, qui ne coïncide pas avec l'encaissement.
 */
export function synthetiserTva(
  ventes: FactureFiscale[],
  achats: FactureFiscale[],
  opts: { debut?: string; fin?: string } = {},
): SyntheseTva {
  const dansPeriode = (f: FactureFiscale) => {
    if (!opts.debut && !opts.fin) return true;
    const d = (f.date_facture ?? "").slice(0, 10);
    if (!d) return false;
    if (opts.debut && d < opts.debut) return false;
    if (opts.fin && d > opts.fin) return false;
    return true;
  };
  const cumul = (fs: FactureFiscale[]) =>
    round2(fs.filter(dansPeriode).reduce((s, f) => s + n(f.montant_tva) * partReglee(f), 0));

  const collectee = cumul(ventes);
  const deductible = cumul(achats);
  const nette = round2(collectee - deductible);
  return { collectee, deductible, nette, estCredit: nette < 0 };
}

/**
 * TVA récupérable en cours : TVA des achats reçus mais PAS encore décaissés.
 * Au régime de l'encaissement elle n'est pas déductible aujourd'hui — c'est une
 * récupération future, d'où un indicateur distinct de la TVA déductible.
 */
export function tvaRecuperableEnCours(achats: FactureFiscale[]): number {
  return round2(achats.reduce((s, f) => s + n(f.montant_tva) * (1 - partReglee(f)), 0));
}

/**
 * Date limite de télédéclaration et de paiement SIMPL-TVA : dernier jour du
 * mois SUIVANT la période déclarée. `periode` au format YYYY-MM.
 *
 * NB : le dépôt papier obéit à une échéance plus courte (le 20). Ce calcul vise
 * la télédéclaration, seul canal ouvert à la majorité des entreprises.
 */
export function echeanceSimplTva(periode: string): Date | null {
  const m = /^(\d{4})-(\d{2})$/.exec(periode.trim());
  if (!m) return null;
  const annee = Number(m[1]);
  const mois = Number(m[2]); // 1-12
  if (mois < 1 || mois > 12) return null;
  // Jour 0 du mois M+2 = dernier jour du mois M+1 (JS normalise le débordement).
  return new Date(annee, mois + 1, 0);
}

/** Jours restants avant une échéance (négatif = dépassée). */
export function joursAvant(echeance: Date, aujourdhui: Date = new Date()): number {
  const a = Date.UTC(echeance.getFullYear(), echeance.getMonth(), echeance.getDate());
  const b = Date.UTC(aujourdhui.getFullYear(), aujourdhui.getMonth(), aujourdhui.getDate());
  return Math.round((a - b) / 86400000);
}

// ─── Ventilation par compte PCM (charges classe 6 / ventes classe 7) ─────────

export interface EcritureCharge {
  compte_numero?: string | null;
  debit?: number | null;
  credit?: number | null;
  date_ecriture?: string | null;
}

/**
 * Rubriques PCM à 3 chiffres (CGNC) — DERNIER repli d'intitulé, quand ni le
 * référentiel ni le dictionnaire ne connaissent le compte exact. Un compte
 * inventé par l'OCR (6137 chez un dossier) reste ainsi rattaché à une rubrique
 * réelle plutôt que de s'afficher « — ».
 */
const RUBRIQUES_PCM: Record<string, string> = {
  "611": "Achats revendus de marchandises",
  "612": "Achats consommés de matières et fournitures",
  "613": "Autres charges externes",
  "614": "Autres charges externes",
  "616": "Impôts et taxes",
  "617": "Charges de personnel",
  "618": "Autres charges d'exploitation",
  "619": "Dotations d'exploitation",
  "631": "Charges d'intérêts",
  "633": "Pertes de change",
  "638": "Autres charges financières",
  "639": "Dotations financières",
  "651": "VNA des immobilisations cédées",
  "656": "Subventions accordées",
  "658": "Autres charges non courantes",
  "659": "Dotations non courantes",
  "670": "Impôts sur les résultats",
  // ── Classe 7 — produits ──
  "711": "Ventes de marchandises",
  "712": "Ventes de biens et services produits",
  "713": "Variation des stocks de produits",
  "714": "Immobilisations produites par l'entreprise pour elle-même",
  "716": "Subventions d'exploitation",
  "718": "Autres produits d'exploitation",
  "719": "Reprises d'exploitation ; transferts de charges",
  "732": "Produits des titres de participation",
  "733": "Gains de change",
  "738": "Intérêts et autres produits financiers",
  "739": "Reprises financières ; transferts de charges",
  "751": "Produits de cession des immobilisations",
  "756": "Subventions d'équilibre",
  "757": "Reprises sur subventions d'investissement",
  "758": "Autres produits non courants",
  "759": "Reprises non courantes ; transferts de charges",
};

/**
 * Intitulés portés par le moteur de catégorisation : il descend PLUS FIN que le
 * référentiel `pcm_reference` (61455 « Frais de télécommunications », 61254
 * « Fournitures de bureau »…) parce que ce sont les comptes qu'il IMPUTE. Sans
 * ce repli, un sous-compte s'afficherait sous l'intitulé de son parent.
 *
 * Pas de filtre sur le sens : un numéro de compte n'appartient qu'à une classe,
 * charge (6) ou produit (7), donc la table ne peut pas se contredire — et une
 * future règle « produit » profitera automatiquement au donut des ventes.
 */
const INTITULES_MOTEUR: Record<string, string> = Object.fromEntries(
  DICTIONNAIRE_PCM.map((r) => [r.compte, r.label]),
);

/**
 * Intitulé d'un compte de charge ou de produit, du plus précis au plus général :
 *   1. le référentiel PCM du cabinet (`pcm_reference`, passé par l'appelant) ;
 *   2. le dictionnaire du moteur de catégorisation (sous-comptes) ;
 *   3. le compte parent (61312 → 6131) — un sous-compte hérite de son poste ;
 *   4. la rubrique à 3 chiffres (6137 → 613 « Autres charges externes »).
 *
 * On n'invente jamais : à défaut, l'intitulé reste vide et l'écran n'affiche que
 * le numéro de compte, qui lui est certain.
 */
export function intitulePcm(compte: string, catalogue: Record<string, string> = {}): string {
  const c = String(compte ?? "").trim();
  if (!c) return "";
  for (let i = c.length; i >= 4; i--) {
    const cle = c.slice(0, i);
    const hit = catalogue[cle] ?? INTITULES_MOTEUR[cle];
    if (hit) return hit;
  }
  return RUBRIQUES_PCM[c.slice(0, 3)] ?? "";
}

/** Un poste du donut : un compte PCM réel, ou le reliquat regroupé. */
export interface PartComptePcm {
  /** Numéro de compte tel qu'il est enregistré en comptabilité (« 6145 »). */
  compte: string;
  /** Intitulé PCM résolu (« Frais postaux et frais de télécommunications »). */
  intitule: string;
  /** Montant HT de la période (solde débiteur en classe 6, créditeur en 7). */
  montant: number;
  /** Proportion EXACTE dans le total affiché, entre 0 et 1 (non arrondie). */
  part: number;
  /** Comptes agrégés — renseigné uniquement sur la tranche de reliquat. */
  regroupe?: string[];
}

/** Clé de la tranche de reliquat, commune aux deux donuts. */
export const COMPTE_AUTRES = "autres";
export const LIBELLE_AUTRES_CHARGES = "Autres charges";
export const LIBELLE_AUTRES_VENTES = "Autres ventes";
/** Nombre de postes nommés affichés avant regroupement du reliquat. */
export const MAX_POSTES_PCM = 5;

interface OptionsVentilation {
  debut?: string;
  fin?: string;
  max?: number;
  intitules?: Record<string, string>;
}

/**
 * Ventilation par COMPTE PCM RÉEL — un poste = un compte du grand livre, jamais
 * un regroupement maison au libellé vague. Moteur commun aux deux donuts ; seuls
 * changent la classe retenue et le SENS du solde.
 *
 * Les écritures de classe 6 et 7 sont HT par construction : la TVA part en 34552
 * (déductible) ou 44551 (collectée) à la saisie, elle n'entre jamais ici.
 *
 * Le solde est pris dans le sens NATUREL du compte — débiteur pour une charge,
 * créditeur pour un produit — afin que les avoirs, remises et annulations
 * viennent en diminution plutôt que de gonfler le poste. Un compte au solde nul
 * ou inversé est écarté : un secteur négatif ne se dessine pas, un secteur nul
 * n'apprend rien.
 *
 * Au-delà de `max` comptes, seuls les `max` plus gros sont nommés et TOUT le
 * reste est regroupé, sans exception — y compris un reliquat d'un seul compte :
 * la règle doit être lisible à l'œil (« les 5 plus gros postes, puis le reste »),
 * pas conditionnelle. Le total reste exact, aucun montant ne disparaît, et le
 * détail des comptes regroupés reste accessible via `regroupe`.
 */
function ventilerParCompte(
  ecritures: EcritureCharge[],
  classe: "6" | "7",
  libelleAutres: string,
  opts: OptionsVentilation,
): PartComptePcm[] {
  const max = opts.max ?? MAX_POSTES_PCM;
  const totaux = new Map<string, number>();

  for (const e of ecritures) {
    const compte = (e.compte_numero ?? "").trim();
    if (!compte.startsWith(classe)) continue;
    const d = (e.date_ecriture ?? "").slice(0, 10);
    if (opts.debut && (!d || d < opts.debut)) continue;
    if (opts.fin && (!d || d > opts.fin)) continue;
    const solde = classe === "6" ? n(e.debit) - n(e.credit) : n(e.credit) - n(e.debit);
    totaux.set(compte, (totaux.get(compte) ?? 0) + solde);
  }

  // Tri par poids décroissant ; à montant égal, par n° de compte pour que deux
  // rendus successifs des mêmes données donnent exactement le même graphique.
  const postes = [...totaux.entries()]
    .map(([compte, montant]) => ({ compte, montant: round2(montant) }))
    .filter((p) => p.montant > 0)
    .sort((a, b) => b.montant - a.montant || a.compte.localeCompare(b.compte));

  const nommes = postes.length > max ? postes.slice(0, max) : postes;
  const reliquat = postes.slice(nommes.length);

  const parts: PartComptePcm[] = nommes.map((p) => ({
    compte: p.compte,
    intitule: intitulePcm(p.compte, opts.intitules),
    montant: p.montant,
    part: 0,
  }));

  if (reliquat.length) {
    parts.push({
      compte: COMPTE_AUTRES,
      intitule: libelleAutres,
      montant: round2(reliquat.reduce((s, p) => s + p.montant, 0)),
      part: 0,
      regroupe: reliquat.map((p) => p.compte),
    });
  }

  const total = parts.reduce((s, p) => s + p.montant, 0);
  return total > 0 ? parts.map((p) => ({ ...p, part: p.montant / total })) : parts;
}

/** Charges HT (classe 6) par compte PCM — solde DÉBITEUR. */
export function ventilerChargesParCompte(
  ecritures: EcritureCharge[],
  opts: OptionsVentilation = {},
): PartComptePcm[] {
  return ventilerParCompte(ecritures, "6", LIBELLE_AUTRES_CHARGES, opts);
}

/**
 * Chiffre d'affaires HT (classe 7) par compte PCM — solde CRÉDITEUR.
 *
 * Le sens inversé n'est pas un détail : le compte 7129 « Rabais, remises et
 * ristournes ACCORDÉS » est un compte de produit qui fonctionne au débit. Pris
 * comme une charge, il apparaîtrait en poste de vente ; pris dans son sens
 * naturel, il vient en diminution du CA et sort du graphique — ce qui est le
 * comportement comptable attendu.
 */
export function ventilerVentesParCompte(
  ecritures: EcritureCharge[],
  opts: OptionsVentilation = {},
): PartComptePcm[] {
  return ventilerParCompte(ecritures, "7", LIBELLE_AUTRES_VENTES, opts);
}

// ─── Balance âgée (dashboard) ────────────────────────────────────────────────

export interface TrancheAgee {
  cle: string;
  label: string;
  creances: number;
  dettes: number;
}

/**
 * Tranches d'ancienneté des impayés.
 *
 * La spec listait « Dans les temps / 1-30 / 31-60 / +90 », ce qui laissait les
 * impayés de 61 à 90 jours sans tranche d'accueil. On intercale donc 61-90 :
 * aucun montant ne disparaît et le « +90 » critique reste isolé.
 */
const BORNES = [
  { cle: "a_jour",     label: "Dans les temps", max: 0 },
  { cle: "j_1_30",     label: "1 à 30 jours",   max: 30 },
  { cle: "j_31_60",    label: "31 à 60 jours",  max: 60 },
  { cle: "j_61_90",    label: "61 à 90 jours",  max: 90 },
  { cle: "j_90_plus",  label: "+90 jours",      max: Infinity },
] as const;

function jourUTC(d: string | null | undefined): number | null {
  if (!d) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d.trim());
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000;
}

/** Reste dû ; repli sur le TTC quand `montant_restant` n'est pas renseigné. */
function resteDu(f: FactureFiscale): number {
  if (f.statut_paiement === "payee") return 0;
  const r = f.montant_restant != null ? n(f.montant_restant) : n(f.montant_ttc);
  return r > 0 ? r : 0;
}

/**
 * Répartit créances (ventes) et dettes (achats) non soldées par ancienneté.
 * Une facture sans échéance est comptée « dans les temps » : rien ne prouve
 * qu'elle soit en retard, et l'exclure ferait disparaître son montant.
 */
export function balanceAgeeDashboard(
  ventes: FactureFiscale[],
  achats: FactureFiscale[],
  aujourdhui: Date = new Date(),
): TrancheAgee[] {
  const now = Date.UTC(aujourdhui.getFullYear(), aujourdhui.getMonth(), aujourdhui.getDate()) / 86400000;
  const acc = new Map<string, { creances: number; dettes: number }>(
    BORNES.map((b) => [b.cle, { creances: 0, dettes: 0 }]),
  );

  const classer = (f: FactureFiscale, champ: "creances" | "dettes") => {
    const du = resteDu(f);
    if (du <= 0) return;
    const ech = jourUTC(f.date_echeance);
    const retard = ech == null ? 0 : now - ech;
    const borne = BORNES.find((b) => retard <= b.max) ?? BORNES[BORNES.length - 1];
    const cell = acc.get(borne.cle)!;
    cell[champ] += du;
  };

  ventes.forEach((f) => classer(f, "creances"));
  achats.forEach((f) => classer(f, "dettes"));

  return BORNES.map((b) => ({
    cle: b.cle,
    label: b.label,
    creances: round2(acc.get(b.cle)!.creances),
    dettes: round2(acc.get(b.cle)!.dettes),
  }));
}

// ─── Trésorerie ──────────────────────────────────────────────────────────────

export interface CashFlow {
  /** Part HT réellement encaissée sur les ventes. */
  encaissementsHt: number;
  /** Part HT réellement décaissée sur les achats. */
  decaissementsHt: number;
  /** Encaissements − décaissements, hors TVA (la TVA n'est pas une marge). */
  marge: number;
}

/**
 * Marge brute réelle / cash-flow, en HT et sur les seuls flux effectifs.
 *
 * Le HT est pris au prorata du règlement : encaisser 50 % d'une facture, c'est
 * encaisser 50 % de son HT. Raisonner en HT neutralise la TVA, qui transite par
 * l'entreprise sans lui appartenir.
 */
export function calculerCashFlow(
  ventes: FactureFiscale[],
  achats: FactureFiscale[],
): CashFlow {
  const cumulHt = (fs: FactureFiscale[]) =>
    round2(fs.reduce((s, f) => s + n(f.montant_ht) * partReglee(f), 0));
  const encaissementsHt = cumulHt(ventes);
  const decaissementsHt = cumulHt(achats);
  return { encaissementsHt, decaissementsHt, marge: round2(encaissementsHt - decaissementsHt) };
}
