// Indicateurs fiscaux et de trésorerie du dashboard (régime marocain).
// Logique pure, testable sans rendu : c'est ici que vit la règle métier, les
// écrans ne font que l'afficher.

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

// ─── Ventilation des charges par compte PCM ──────────────────────────────────

export interface EcritureCharge {
  compte_numero?: string | null;
  debit?: number | null;
  credit?: number | null;
  date_ecriture?: string | null;
}

export interface GroupePcm {
  cle: string;
  label: string;
  /** Préfixes de comptes PCM regroupés. */
  prefixes: string[];
}

/**
 * Regroupements demandés pour la ventilation des dépenses. « Autres charges »
 * capture le reste de la classe 6 : sans lui, le total du graphique serait
 * inférieur aux charges réelles et induirait en erreur.
 *
 * ORDRE SIGNIFICATIF — la ventilation retient le PREMIER groupe dont un préfixe
 * matche : un préfixe plus précis doit donc précéder le plus général qui le
 * contient (6125 avant 612), sinon il ne serait jamais atteint. L'ordre est
 * aussi celui de la légende du donut.
 */
export const GROUPES_PCM: GroupePcm[] = [
  { cle: "marchandises", label: "Achats de marchandises",       prefixes: ["611"] },
  // 6125 « Achats NON STOCKÉS de matières et fournitures » (CGNC) : eau 61251,
  // électricité 61252, fournitures de bureau 61254… Ce sont des consommables du
  // quotidien, pas de la matière première transformée — les afficher sous
  // « Matières premières » (612) faussait la lecture du donut.
  { cle: "non_stockes",  label: "Eau, énergie & fournitures",   prefixes: ["6125"] },
  { cle: "matieres",     label: "Matières premières",           prefixes: ["612"] },
  { cle: "services",     label: "Services extérieurs & Loyers", prefixes: ["613", "614"] },
  { cle: "personnel",    label: "Charges de personnel",         prefixes: ["617"] },
];

export interface PartCharge {
  cle: string;
  label: string;
  montant: number;
}

/**
 * Ventile les charges (classe 6) par groupe PCM. Une charge est un solde
 * DÉBITEUR : on retranche le crédit pour que les avoirs et annulations
 * viennent en diminution plutôt que de gonfler la dépense.
 *
 * Les groupes vides sont écartés — un donut à secteurs nuls n'apprend rien.
 */
export function ventilerChargesPcm(
  ecritures: EcritureCharge[],
  opts: { debut?: string; fin?: string; avecAutres?: boolean } = {},
): PartCharge[] {
  const totaux = new Map<string, number>();
  let autres = 0;

  for (const e of ecritures) {
    const compte = (e.compte_numero ?? "").trim();
    if (!compte.startsWith("6")) continue;
    const d = (e.date_ecriture ?? "").slice(0, 10);
    if (opts.debut && (!d || d < opts.debut)) continue;
    if (opts.fin && (!d || d > opts.fin)) continue;

    const montant = n(e.debit) - n(e.credit);
    const groupe = GROUPES_PCM.find((g) => g.prefixes.some((p) => compte.startsWith(p)));
    if (groupe) totaux.set(groupe.cle, (totaux.get(groupe.cle) ?? 0) + montant);
    else autres += montant;
  }

  const parts: PartCharge[] = GROUPES_PCM
    .map((g) => ({ cle: g.cle, label: g.label, montant: round2(totaux.get(g.cle) ?? 0) }))
    .filter((p) => p.montant > 0);

  if (opts.avecAutres !== false && round2(autres) > 0) {
    parts.push({ cle: "autres", label: "Autres charges", montant: round2(autres) });
  }
  return parts;
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
