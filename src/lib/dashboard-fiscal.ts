// Indicateurs fiscaux et de trésorerie du dashboard (régime marocain).
// Logique pure, testable sans rendu : c'est ici que vit la règle métier, les
// écrans ne font que l'afficher.

import { DICTIONNAIRE_PCM } from "./categorization-engine";
import { numeroSignificatif } from "./numero-compte";
import { joursRetard } from "./factures-filtres";

/** Facture (vente ou achat) vue sous l'angle des montants et du règlement. */
export interface FactureFiscale {
  /** Requis seulement pour rattacher les règlements datés de `paiements`. */
  id?: string | null;
  /** Numéro de pièce — c'est par lui qu'une imputation d'avoir désigne son avoir. */
  numero?: string | null;
  /** `avoir` pour une note de crédit (qui porte aussi des montants négatifs). */
  type?: string | null;
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

/** Règlement individuel daté (table `paiements`, source de vérité du reste dû). */
export interface PaiementFiscal {
  facture_id?: string | null;
  facture_fournisseur_id?: string | null;
  montant?: number | null;
  date_paiement?: string | null;
  /**
   * `avoir` = la créance a été ÉTEINTE par un avoir, sans mouvement d'argent
   * (migration 20260909130000). Toute autre valeur est un règlement réel.
   */
  origine?: string | null;
  /** Pour une imputation d'avoir : le NUMÉRO de l'avoir imputé. */
  reference?: string | null;
}

/** Origine d'une ligne `paiements` qui n'est PAS un encaissement. */
export const ORIGINE_AVOIR = "avoir";

/** Cette ligne `paiements` est-elle l'imputation d'un avoir (aucun argent reçu) ? */
export function estImputationAvoir(p: PaiementFiscal): boolean {
  return String(p.origine ?? "").trim().toLowerCase() === ORIGINE_AVOIR;
}

/** Cette pièce est-elle un avoir ? Le type fait foi, le TTC négatif le trahit. */
export function estAvoir(f: FactureFiscale): boolean {
  return String(f.type ?? "").trim().toLowerCase() === "avoir" || n(f.montant_ttc) < 0;
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
  /**
   * Part des règlements rattachée à un paiement DATÉ, entre 0 et 1 (1 = toute la
   * TVA a été datée par un encaissement réel). En dessous de 1, le complément a
   * été rattaché à la date de facture faute de mieux — l'écran doit le dire.
   */
  couverture: number;
}

/** Indexe les règlements par facture, dans le sens (vente / achat) demandé. */
function grouperPaiements(
  paiements: PaiementFiscal[],
  cle: "facture_id" | "facture_fournisseur_id",
): Map<string, PaiementFiscal[]> {
  const index = new Map<string, PaiementFiscal[]>();
  for (const p of paiements) {
    const id = p[cle];
    if (!id) continue;
    const liste = index.get(id);
    if (liste) liste.push(p); else index.set(id, [p]);
  }
  return index;
}

/**
 * Les avoirs d'un sens (ventes ou achats), séparés des règlements réels.
 *
 * ─── Le défaut que ce contexte existe pour empêcher ─────────────────────────
 * Une imputation d'avoir est une ligne `paiements` (origine `avoir`) : elle
 * éteint la créance sans qu'un dirham n'entre. La compter comme un règlement
 * rendait « encaissée » la part de TVA qu'elle annule — +400 MAD sur FA-GOLD-003 —
 * pendant que l'avoir lui-même, pièce négative, retirait −400 MAD à SA date.
 * Les deux erreurs ne se compensaient qu'à l'intérieur d'un même mois : un avoir
 * émis en juin et imputé en juillet déplaçait 400 MAD de TVA d'une déclaration à
 * l'autre, et aucune des deux ne correspondait plus au 44551 du grand livre.
 *
 * ─── La règle ────────────────────────────────────────────────────────────────
 * Une imputation dont la référence désigne un avoir CONNU de la liste :
 *   • réduit la base de la facture imputée (TTC net = TTC − avoir) ;
 *   • ne compte JAMAIS comme un encaissement ;
 *   • fait sortir l'avoir imputé du calcul — son effet est déjà dans la facture.
 * Une imputation dont l'avoir est introuvable garde l'ancien traitement : sans
 * savoir quel avoir elle vise, l'isoler retirerait deux fois le même montant.
 */
function contexteAvoirs(
  fs: FactureFiscale[],
  paiements: PaiementFiscal[] | undefined,
  cle: "facture_id" | "facture_fournisseur_id",
) {
  const index = paiements ? grouperPaiements(paiements, cle) : null;
  const numerosAvoirs = new Set(
    fs.filter(estAvoir).map((f) => String(f.numero ?? "").trim()).filter(Boolean));
  const estAvoirIsole = (p: PaiementFiscal) =>
    estImputationAvoir(p) && numerosAvoirs.has(String(p.reference ?? "").trim());
  const avoirsImputes = new Set<string>();
  for (const liste of index?.values() ?? []) {
    for (const p of liste) if (estAvoirIsole(p)) avoirsImputes.add(String(p.reference).trim());
  }
  /** L'avoir est-il déjà porté par la facture qu'il a éteinte ? */
  const avoirDejaImpute = (f: FactureFiscale) =>
    estAvoir(f) && avoirsImputes.has(String(f.numero ?? "").trim());
  return { index, estAvoirIsole, avoirDejaImpute };
}

/**
 * Décompose le règlement d'une facture entre la part adossée à des paiements
 * DATÉS (avec leur quote-part) et le reliquat réglé mais non daté.
 *
 * Toutes les parts sont exprimées sur le TTC D'ORIGINE : `tva × part` est alors
 * la TVA contenue dans l'argent reçu (7 200 × 1 600 / 9 600 = 1 200), avoir
 * imputé ou non.
 *
 * Un cumul de règlements supérieur au TTC net (saisie en double) ne doit pas
 * créer de TVA : toutes les quotes-parts sont ramenées au TTC net.
 */
function decomposerReglement(
  f: FactureFiscale,
  reglements: PaiementFiscal[],
  estAvoirIsole: (p: PaiementFiscal) => boolean = () => false,
) {
  const ttc = n(f.montant_ttc);
  const reels = reglements.filter((p) => !estAvoirIsole(p));
  // Un avoir (TTC ≤ 0) n'a pas de base à encaisser : son sort dépend du statut.
  if (ttc <= 0) {
    return { parts: [] as { date: string | null | undefined; part: number }[], partDatee: 0, resteNonDate: partReglee(f) };
  }

  const avoirs = Math.min(ttc, reglements.filter(estAvoirIsole).reduce((s, p) => s + n(p.montant), 0));
  const ttcNet = ttc - avoirs;
  /** Part maximale réellement encaissable, avoir déduit. */
  const plafond = ttcNet / ttc;

  const somme = reels.reduce((s, p) => s + n(p.montant), 0);
  const facteur = somme > ttcNet ? (somme > 0 ? ttcNet / somme : 0) : 1;
  const parts = reels.map((p) => ({ date: p.date_paiement, part: (n(p.montant) * facteur) / ttc }));
  const partDatee = Math.min(plafond, parts.reduce((s, p) => s + p.part, 0));

  // `montant_paye` INCLUT l'avoir imputé (le trigger somme toutes les lignes
  // `paiements`) : on le retranche avant d'en déduire un reliquat non daté.
  const partNette = f.statut_paiement === "payee"
    ? plafond
    : Math.min(plafond, Math.max(0, partReglee(f) - avoirs / ttc));
  return { parts, partDatee, resteNonDate: Math.max(0, partNette - partDatee) };
}

/**
 * Synthèse TVA au régime de l'encaissement, sur la période fournie (bornes
 * incluses, format YYYY-MM-DD ; omises = tout l'historique).
 *
 * Volontairement calculé depuis les FACTURES et leur règlement, et non depuis
 * les écritures 44551/34552 : ces dernières suivent le fait générateur
 * comptable, qui ne coïncide pas avec l'encaissement.
 *
 * DATE D'EXIGIBILITÉ : sous ce régime, la TVA est due au titre du mois de
 * l'ENCAISSEMENT, pas de la facturation. Quand `opts.paiements` est fourni,
 * chaque règlement daté porte donc sa quote-part de TVA dans SA période.
 *
 * Sans règlement daté (table `paiements` absente, ou factures antérieures au
 * moteur de paiement qui portent seulement `montant_paye`), la part réglée non
 * couverte est rattachée à la DATE DE FACTURE : c'est approximatif, mais aucune
 * TVA ne disparaît de la déclaration — et `couverture` chiffre l'approximation.
 */
export function synthetiserTva(
  ventes: FactureFiscale[],
  achats: FactureFiscale[],
  opts: { debut?: string; fin?: string; paiements?: PaiementFiscal[] } = {},
): SyntheseTva {
  const dansPeriode = (date: string | null | undefined) => {
    if (!opts.debut && !opts.fin) return true;
    const d = (date ?? "").slice(0, 10);
    if (!d) return false;
    if (opts.debut && d < opts.debut) return false;
    if (opts.fin && d > opts.fin) return false;
    return true;
  };

  const cumul = (fs: FactureFiscale[], cle: "facture_id" | "facture_fournisseur_id") => {
    const { index, estAvoirIsole, avoirDejaImpute } = contexteAvoirs(fs, opts.paiements, cle);
    let tva = 0;      // TVA retenue dans la période
    let datee = 0;    // TVA réglée adossée à un règlement daté, toutes périodes
    let totale = 0;   // TVA réglée toutes périodes confondues (dénominateur de couverture)

    for (const f of fs) {
      // Avoir imputé : sa TVA est déjà retranchée de la facture qu'il éteint.
      if (avoirDejaImpute(f)) continue;
      const reglements = index && f.id ? index.get(f.id) ?? [] : [];
      const { parts, partDatee, resteNonDate } = decomposerReglement(f, reglements, estAvoirIsole);

      for (const p of parts) if (dansPeriode(p.date)) tva += n(f.montant_tva) * p.part;
      datee += n(f.montant_tva) * partDatee;
      totale += n(f.montant_tva) * partDatee;

      // Reliquat réglé mais non daté → rattaché à la date de facture.
      if (resteNonDate > 1e-9) {
        totale += n(f.montant_tva) * resteNonDate;
        if (dansPeriode(f.date_facture)) tva += n(f.montant_tva) * resteNonDate;
      }
    }
    return { tva: round2(tva), datee: round2(datee), totale: round2(totale) };
  };

  const v = cumul(ventes, "facture_id");
  const a = cumul(achats, "facture_fournisseur_id");
  const nette = round2(v.tva - a.tva);
  const totale = v.totale + a.totale;
  return {
    collectee: v.tva,
    deductible: a.tva,
    nette,
    estCredit: nette < 0,
    couverture: totale > 0 ? Math.min(1, (v.datee + a.datee) / totale) : 1,
  };
}

/**
 * Mois (YYYY-MM) où de la TVA est réellement exigible, du plus récent au plus
 * ancien.
 *
 * Un mois n'est retenu que s'il PORTE de la TVA : le mois d'un encaissement daté,
 * ou celui d'une facture dont une part réglée n'est adossée à aucun règlement
 * daté. Le mois de facture d'une vente entièrement couverte par des paiements
 * datés est donc écarté — sinon le tableau mensuel afficherait une ligne à 0,00.
 */
export function periodesTva(
  ventes: FactureFiscale[],
  achats: FactureFiscale[],
  paiements: PaiementFiscal[] = [],
): string[] {
  const mois = new Set<string>();
  const ajouter = (date: string | null | undefined) => {
    const m = (date ?? "").slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(m)) mois.add(m);
  };

  for (const [fs, cle] of [[ventes, "facture_id"], [achats, "facture_fournisseur_id"]] as const) {
    const { index, estAvoirIsole, avoirDejaImpute } = contexteAvoirs(fs, paiements, cle);
    for (const f of fs) {
      if (n(f.montant_tva) === 0 || avoirDejaImpute(f)) continue;
      const reglements = f.id ? index?.get(f.id) ?? [] : [];
      const { parts, resteNonDate } = decomposerReglement(f, reglements, estAvoirIsole);
      for (const p of parts) if (p.part > 1e-9) ajouter(p.date);
      if (resteNonDate > 1e-9) ajouter(f.date_facture);
    }
  }
  return [...mois].sort().reverse();
}

/** Bornes ISO (1er / dernier jour) d'un mois YYYY-MM. */
export function bornesDuMois(periode: string): { debut: string; fin: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(periode.trim());
  if (!m) return null;
  const dernier = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
  return { debut: `${periode}-01`, fin: `${periode}-${String(dernier).padStart(2, "0")}` };
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
/**
 * Vue du catalogue indexée AUSSI par forme courte.
 *
 * Depuis la normalisation à 8 chiffres, un référentiel peut arriver dans l'une
 * ou l'autre forme selon qu'il a été migré ou non : « 6141 » ou « 61410000 ».
 * La cascade ci-dessous raccourcit le compte, jamais la clef du catalogue — un
 * catalogue déjà normalisé n'y serait donc plus jamais trouvé, et TOUS les
 * intitulés disparaîtraient d'un coup. On indexe les deux formes, une seule
 * fois par objet catalogue (les appels sont en boucle sur les comptes).
 */
const CATALOGUES_INDEXES = new WeakMap<Record<string, string>, Record<string, string>>();

function indexerCatalogue(catalogue: Record<string, string>): Record<string, string> {
  const cache = CATALOGUES_INDEXES.get(catalogue);
  if (cache) return cache;
  const index: Record<string, string> = { ...catalogue };
  for (const [cle, valeur] of Object.entries(catalogue)) {
    const court = numeroSignificatif(cle);
    if (court && index[court] === undefined) index[court] = valeur;
  }
  CATALOGUES_INDEXES.set(catalogue, index);
  return index;
}

export function intitulePcm(compte: string, catalogue: Record<string, string> = {}): string {
  const c = String(compte ?? "").trim();
  if (!c) return "";
  const index = indexerCatalogue(catalogue);
  for (let i = c.length; i >= 4; i--) {
    const cle = c.slice(0, i);
    const hit = index[cle] ?? INTITULES_MOTEUR[cle];
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
 * Tranches d'ancienneté des impayés — EXACTEMENT celles de la vue SQL
 * `v_balance_agee` et du module Balance âgée (non échu / 1-30 / 31-60 / +60).
 *
 * Le Dashboard avait son propre découpage (61-90 / +90) : une même facture de
 * 75 jours y tombait en « 61 à 90 jours » quand le module Fournisseurs la disait
 * « +60 jours ». Deux écrans qui ne découpent pas pareil ne se rapprochent pas.
 * Les clés restent celles de la vue (`retard_60_plus`…) pour qu'on puisse les
 * comparer terme à terme.
 */
const BORNES = [
  { cle: "non_echu",       label: "Dans les temps", max: 0 },
  { cle: "retard_1_30",    label: "1 à 30 jours",   max: 30 },
  { cle: "retard_31_60",   label: "31 à 60 jours",  max: 60 },
  { cle: "retard_60_plus", label: "+60 jours",      max: Infinity },
] as const;

/** Reste dû ; repli sur le TTC quand `montant_restant` n'est pas renseigné. */
function resteDu(f: FactureFiscale): number {
  if (f.statut_paiement === "payee") return 0;
  const r = f.montant_restant != null ? n(f.montant_restant) : n(f.montant_ttc);
  return r > 0 ? r : 0;
}

/**
 * Répartit créances (ventes) et dettes (achats) non soldées par ancienneté.
 *
 * Le retard se compte depuis la date d'EXIGIBILITÉ — l'échéance, à défaut
 * l'émission — par `joursRetard`, la fonction que partagent les tableaux de
 * factures. Une facture sans aucune date exploitable reste « dans les temps » :
 * rien ne prouve qu'elle soit en retard, et l'exclure ferait disparaître son
 * montant.
 */
export function balanceAgeeDashboard(
  ventes: FactureFiscale[],
  achats: FactureFiscale[],
  aujourdhui: Date = new Date(),
): TrancheAgee[] {
  const acc = new Map<string, { creances: number; dettes: number }>(
    BORNES.map((b) => [b.cle, { creances: 0, dettes: 0 }]),
  );

  const classer = (f: FactureFiscale, champ: "creances" | "dettes") => {
    const du = resteDu(f);
    if (du <= 0) return;
    const retard = joursRetard({ ...f, montant_restant: du }, aujourdhui) ?? 0;
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
