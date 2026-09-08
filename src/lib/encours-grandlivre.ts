// ============================================================================
// encours-grandlivre.ts — Le GRAND LIVRE comme source des indicateurs (Pennylane).
//
// ─── Le problème ─────────────────────────────────────────────────────────────
// Deux vérités cohabitaient dans l'application :
//
//   • les colonnes `factures.montant_paye / montant_restant / statut_paiement`,
//     écrites au fil des règlements ;
//   • le grand livre, où le lettrage dit ce qui est réellement soldé.
//
// Elles divergent dès qu'une opération touche l'une sans l'autre : le dashboard
// annonçait 0,00 MAD de solde bancaire alors que le compte 5141 portait 9 000,
// et une facture affichait « restant 9 000 » alors que sa ligne 3421 était
// lettrée. Un chiffre qui contredit la comptabilité n'est pas un chiffre.
//
// ─── La règle ────────────────────────────────────────────────────────────────
// Le grand livre EST la source. Les colonnes de `factures` en sont une PROJECTION
// recalculée, jamais une saisie indépendante :
//
//   montant_payé  = Σ des règlements LETTRÉS avec la facture, au journal de
//                   trésorerie, sur SON compte de tiers ;
//   encours client = Σ des soldes DÉBITEURS non lettrés du compte 3421 ;
//   solde banque   = solde du compte 5141 (classe 5).
//
// « Non lettré » est le discriminant : une ligne de facture lettrée est soldée,
// quoi que dise la colonne. Logique pure — l'écran, l'export et le script de
// resynchronisation consomment le MÊME calcul.
// ============================================================================

import { statutPaiement } from "@/lib/paiements";
import { estJournalTresorerie } from "@/lib/integrite-tresorerie";
import { paiementsRecevables } from "@/lib/reglements";

/** Racines PCM. Les auxiliaires en dérivent par préfixe : 34210002 ⊂ 3421. */
export const COMPTE_CLIENTS = "3421";
export const COMPTE_FOURNISSEURS = "4411";
/** Banque (514x) et caisse (516x) — les deux poches de la trésorerie. */
export const COMPTE_BANQUE = "5141";
export const RACINES_TRESORERIE = ["514", "516"] as const;

const round2 = (x: number) => Math.round(x * 100) / 100;
const nb = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const txt = (v: unknown) => String(v ?? "").trim();

export interface LigneGrandLivre {
  id?: string;
  journal_code?: string | null;
  compte_numero?: string | null;
  date_ecriture?: string | null;
  debit?: number | null;
  credit?: number | null;
  reference_piece?: string | null;
  lettrage_code?: string | null;
  facture_id?: string | null;
}

/** Un compte appartient à une racine s'il en est le préfixe (collectif ou auxiliaire). */
export function relevantDe(compte: string | null | undefined, racine: string): boolean {
  return txt(compte).startsWith(racine);
}

/** Une ligne est lettrée si elle porte un code non vide. */
export function estLettree(l: LigneGrandLivre): boolean {
  return txt(l.lettrage_code).length > 0;
}

// ─── Solde de trésorerie ─────────────────────────────────────────────────────

/**
 * Solde du grand livre pour une racine de compte : Σ débits − Σ crédits.
 *
 * Positif = débiteur. Pour la trésorerie (classe 5) c'est l'argent disponible,
 * pour un client (3421) c'est ce qu'il doit.
 */
export function soldeCompte(lignes: LigneGrandLivre[], racine: string): number {
  return round2(lignes
    .filter((l) => relevantDe(l.compte_numero, racine))
    .reduce((s, l) => s + nb(l.debit) - nb(l.credit), 0));
}

export interface SoldeTresorerie {
  /** Solde des comptes 514x (banque). */
  banque: number;
  /** Solde des comptes 516x (caisse). */
  caisse: number;
  total: number;
  /** `false` si AUCUNE ligne de trésorerie n'existe : il n'y a alors rien à afficher. */
  mouvemente: boolean;
}

/**
 * Solde de trésorerie tel qu'il ressort de la COMPTABILITÉ.
 *
 * `mouvemente` distingue « le compte est à zéro » de « la comptabilité ne
 * connaît aucun mouvement ». Le widget Banque affichait 0,00 MAD dans les deux
 * cas : il lisait `comptes_bancaires.solde_actuel`, qui n'est renseigné que par
 * l'import d'un relevé et reste donc à 0 sur un dossier tenu à la main.
 */
export function soldeTresorerieGrandLivre(lignes: LigneGrandLivre[]): SoldeTresorerie {
  const deTresorerie = lignes.filter((l) =>
    RACINES_TRESORERIE.some((r) => relevantDe(l.compte_numero, r)));
  const banque = soldeCompte(lignes, "514");
  const caisse = soldeCompte(lignes, "516");
  return { banque, caisse, total: round2(banque + caisse), mouvemente: deTresorerie.length > 0 };
}

/**
 * Solde bancaire à afficher — la comptabilité prime, le compte bancaire dépanne.
 *
 * Tant que le grand livre porte des mouvements de trésorerie, c'est LUI qui fait
 * foi : c'est la seule valeur qu'un expert-comptable pourra justifier. Sinon on
 * retombe sur `comptes_bancaires.solde_actuel`, qui reste utile sur un dossier
 * où seuls des relevés ont été importés sans être clôturés en écritures.
 */
export function soldeBancaireAffiche(
  lignes: LigneGrandLivre[], soldeComptesBancaires: number,
): { montant: number; source: "grand_livre" | "comptes_bancaires" } {
  const gl = soldeTresorerieGrandLivre(lignes);
  return gl.mouvemente
    ? { montant: gl.total, source: "grand_livre" }
    : { montant: round2(nb(soldeComptesBancaires)), source: "comptes_bancaires" };
}

// ─── Encours clients ─────────────────────────────────────────────────────────

export interface PosteOuvert {
  compte: string;
  /** Solde du compte sur ses seules lignes NON LETTRÉES, signé (débit − crédit). */
  solde: number;
}

export interface EncoursTiers {
  /** Σ des soldes DÉBITEURS non lettrés : ce que les clients doivent encore. */
  total: number;
  /** Σ des soldes créditeurs, en positif : avances reçues, trop-perçus. */
  avances: number;
  /** Détail par compte auxiliaire, du plus gros dû au plus petit. */
  postes: PosteOuvert[];
}

/**
 * Encours d'une racine de tiers, depuis les seules lignes NON LETTRÉES.
 *
 * Les soldes sont pris compte par compte, puis ventilés débiteur / créditeur —
 * jamais compensés. Un client qui a versé une avance ne doit pas effacer la
 * dette d'un autre : c'est la même règle que `ventilerSolde` en balance, et
 * c'est ce qui rend le total additionnable avec la balance âgée.
 */
export function encoursTiersGrandLivre(
  lignes: LigneGrandLivre[], racine: string = COMPTE_CLIENTS,
): EncoursTiers {
  const parCompte = new Map<string, number>();
  for (const l of lignes) {
    if (!relevantDe(l.compte_numero, racine) || estLettree(l)) continue;
    const c = txt(l.compte_numero);
    parCompte.set(c, (parCompte.get(c) ?? 0) + nb(l.debit) - nb(l.credit));
  }

  let total = 0;
  let avances = 0;
  const postes: PosteOuvert[] = [];
  for (const [compte, brut] of parCompte) {
    const solde = round2(brut);
    if (Math.abs(solde) < 0.005) continue;
    if (solde > 0) total += solde; else avances += -solde;
    postes.push({ compte, solde });
  }
  postes.sort((a, b) => b.solde - a.solde);
  return { total: round2(total), avances: round2(avances), postes };
}

// ─── Indicateurs de tête, tirés de la COMPTABILITÉ ───────────────────────────
//
// Les trois chiffres du bandeau — CA HT facturé, encaissements clients, encours —
// se lisaient jusqu'ici dans les colonnes de `factures` : Σ montant_ht, Σ
// montant_paye, Σ montant_restant. Trois agrégats d'une projection, présentés
// comme des données comptables.
//
// Le défaut n'est pas théorique. Sur SMERT WATER, « Encaissements clients »
// annonçait 102 972 MAD — le TTC de trois factures dont deux n'ont jamais été
// encaissées — quand la comptabilité n'en portait que 21 000. Aucun de ces
// chiffres n'était justifiable devant un contrôle : ils ne venaient d'aucun
// journal.
//
// On les tire donc du grand livre, où chacun a une définition unique :
//   • CA HT facturé        = Σ des crédits nets de la classe 7 ;
//   • Encaissements clients = Σ des CRÉDITS du 342x en journal de TRÉSORERIE ;
//   • Encours clients       = Σ des soldes débiteurs non lettrés du 342x.
//
// Le TTC des factures n'entre dans aucun des trois : il porte la TVA, qui n'est
// pas du produit, et il ignore ce qui a été réellement reçu.

export interface AgregatGrandLivre {
  /** Le montant, en MAD. */
  montant: number;
  /** Nombre de lignes du grand livre qui le composent — la trace du calcul. */
  lignes: number;
  /** `false` quand aucune ligne ne relève de l'agrégat : rien à afficher. */
  comptabilise: boolean;
}

/**
 * CA HT de l'exercice = crédits nets de la classe 7.
 *
 * NET des débits : un avoir débite le compte de produit, et le compter pour zéro
 * gonflerait le chiffre d'affaires du montant annulé. C'est la même convention
 * que `rapprocherCaProduits`, dont ce calcul est la moitié comptable.
 */
export function caHtGrandLivre(lignes: LigneGrandLivre[]): AgregatGrandLivre {
  const produits = (lignes ?? []).filter((l) => txt(l.compte_numero).startsWith("7"));
  return {
    montant: round2(produits.reduce((s, l) => s + nb(l.credit) - nb(l.debit), 0)),
    lignes: produits.length,
    comptabilise: produits.length > 0,
  };
}

/**
 * Encaissements clients = ce que les journaux de trésorerie ont crédité au 342x.
 *
 * Le CRÉDIT du compte client est la contrepartie du débit de banque ou de caisse :
 * c'est l'écriture, et elle seule, qui dit que l'argent est entré. Net des débits
 * pour qu'un impayé rejeté (qui rouvre la créance) vienne bien en déduction.
 *
 * Une écriture de VENTE au crédit du 342x — un avoir, par exemple — n'est pas un
 * encaissement : d'où le filtre sur le journal, jamais sur le seul compte.
 */
export function encaissementsTiersGrandLivre(
  lignes: LigneGrandLivre[], racine: string = COMPTE_CLIENTS,
): AgregatGrandLivre {
  const sens = racine === COMPTE_FOURNISSEURS ? -1 : 1;
  const mouvements = (lignes ?? []).filter((l) =>
    relevantDe(l.compte_numero, racine) && estJournalTresorerie(l.journal_code));
  return {
    // Client : crédit − débit (l'encaissement solde la créance).
    // Fournisseur : débit − crédit (le décaissement solde la dette).
    montant: round2(mouvements.reduce(
      (s, l) => s + sens * (nb(l.credit) - nb(l.debit)), 0)),
    lignes: mouvements.length,
    comptabilise: mouvements.length > 0,
  };
}

// ─── Situation d'une facture, dérivée du grand livre ─────────────────────────

export interface SituationFacture {
  montant_paye: number;
  montant_restant: number;
  statut_paiement: "non_payee" | "partielle" | "payee";
  /** Code(s) de lettrage qui portent le règlement — la trace justifiant le montant. */
  codes: string[];
  /** Date du dernier règlement lettré, ou `null`. */
  date_paiement: string | null;
  /** `false` si aucune ligne de cette facture n'existe au grand livre. */
  trouvee: boolean;
  /** Ce qui justifie le montant retenu (cf. `projeterSituationFacture`). */
  source: "grand_livre" | "pieces";
}

export interface CibleFacture {
  /** Références portées par les écritures : le NUMÉRO côté vente, l'ID côté achat. */
  references: (string | null | undefined)[];
  montant_ttc: number;
  /** Sens de la facture — décide quel côté du compte de tiers est le règlement. */
  sens: "client" | "fournisseur";
  /** id de la facture, quand les écritures l'estampillent (`facture_id`). */
  id?: string | null;
}

/**
 * Recalcule montant_payé / restant / statut d'une facture DEPUIS le grand livre.
 *
 * L'algorithme suit le lettrage, pas les montants :
 *   1. on isole les lignes de la facture sur son compte de tiers (par référence
 *      ou par `facture_id`) et on relève leurs codes de lettrage ;
 *   2. le règlement, ce sont les lignes de TRÉSORERIE (BQ / CAI) portant ces
 *      mêmes codes, du côté opposé à la facture — crédit du 3421 pour un client
 *      encaissé, débit du 4411 pour un fournisseur payé.
 *
 * Une facture dont les lignes ne sont pas lettrées est donc NON PAYÉE, même si
 * une écriture de banque la mentionne : c'est précisément ce que la règle
 * d'intégrité veut faire apparaître (cf. integrite-tresorerie.ts).
 */
export function situationFactureGrandLivre(
  lignes: LigneGrandLivre[], cible: CibleFacture,
): SituationFacture {
  const racine = cible.sens === "client" ? COMPTE_CLIENTS : COMPTE_FOURNISSEURS;
  const refs = new Set(cible.references.map((r) => txt(r)).filter(Boolean));
  const id = txt(cible.id);

  const designeLaFacture = (l: LigneGrandLivre) =>
    (id && txt(l.facture_id) === id) || refs.has(txt(l.reference_piece));

  const lignesFacture = lignes.filter((l) =>
    relevantDe(l.compte_numero, racine)
    && !estJournalTresorerie(l.journal_code)
    && designeLaFacture(l));

  const ttc = round2(nb(cible.montant_ttc));
  if (!lignesFacture.length) {
    return {
      montant_paye: 0, montant_restant: ttc,
      statut_paiement: statutPaiement(ttc, 0),
      codes: [], date_paiement: null, trouvee: false, source: "grand_livre",
    };
  }

  const codes = [...new Set(lignesFacture.map((l) => txt(l.lettrage_code)).filter(Boolean))];
  // Comptes RÉELLEMENT mouvementés par la facture : un règlement doit solder le
  // même auxiliaire (34210002), pas seulement la même racine.
  const comptes = new Set(lignesFacture.map((l) => txt(l.compte_numero)));

  const reglements = codes.length
    ? lignes.filter((l) =>
        estJournalTresorerie(l.journal_code)
        && comptes.has(txt(l.compte_numero))
        && codes.includes(txt(l.lettrage_code)))
    : [];

  // Côté du règlement : à l'inverse de la facture. Un encaissement CRÉDITE le
  // client ; un paiement fournisseur DÉBITE le fournisseur.
  const montant_paye = round2(reglements.reduce(
    (s, l) => s + (cible.sens === "client" ? nb(l.credit) - nb(l.debit) : nb(l.debit) - nb(l.credit)), 0));

  const dates = reglements.map((l) => txt(l.date_ecriture).slice(0, 10)).filter(Boolean).sort();
  const paye = Math.max(0, montant_paye);

  return {
    montant_paye: paye,
    montant_restant: Math.max(0, round2(ttc - paye)),
    statut_paiement: statutPaiement(ttc, paye),
    codes,
    date_paiement: dates.length ? dates[dates.length - 1] : null,
    trouvee: true, source: "grand_livre",
  };
}

/** Une pièce de règlement formelle : une ligne de `paiements` / `encaissements`. */
export interface PieceReglement {
  montant: number;
  date?: string | null;
  /**
   * Identité de la pièce d'origine et référence de saisie. Facultatives, mais
   * c'est par elles que le doublon se détecte : sans elles, deux insertions de
   * la même ligne de relevé restent indiscernables (cf. `clePaiement`).
   */
  transaction_id?: string | null;
  encaissement_id?: string | null;
  reference?: string | null;
}

/** Ce que la projection doit savoir de la facture pour juger ses pièces. */
export interface CibleProjection {
  id?: string | null;
  numero?: string | null;
  /** Émission — sans elle, l'antériorité ne peut pas être constatée. */
  date_facture?: string | null;
}

/**
 * Réconcilie les DEUX preuves d'un règlement — et ne perd jamais la plus forte.
 *
 * Symétrique de la règle d'intégrité (cf. integrite-tresorerie.ts) : un règlement
 * est attesté par une écriture de trésorerie LETTRÉE, ou par une pièce formelle.
 * Chacune est une borne INFÉRIEURE de ce qui a été encaissé, et chacune peut
 * être en retard sur l'autre :
 *
 *   • le grand livre retarde quand le règlement est saisi mais pas encore lettré ;
 *   • les pièces retardent quand le règlement est entré directement en écriture.
 *
 * On retient donc le MAXIMUM. Prendre le seul grand livre aurait « démarqué »
 * six factures réellement payées de SMERT WATER et SOMADIR — elles portaient bien
 * un `paiements`, mais aucune écriture de trésorerie n'avait jamais été générée,
 * donc rien à lettrer. Ramener leur statut à « non payée » aurait détruit la
 * seule trace du règlement, ce qui est bien pire que la divergence corrigée.
 *
 * ⚠️ Le maximum ne s'applique qu'aux pièces RECEVABLES (cf. src/lib/reglements.ts).
 * Sans ce filtre, il faisait exactement le contraire de ce qu'on attend de lui :
 * une pièce IMPOSSIBLE — un virement antérieur à l'émission de la facture, un
 * doublon — l'emportait sur un grand livre correct, et aucune resynchronisation
 * ne pouvait plus la déloger, puisque le maximum la reprenait à chaque passage.
 * C'est ce qui a tenu 81 972 MAD de créances SMERT WATER affichées « encaissées »
 * pendant que le compte 3421 restait ouvert d'autant. La prudence porte sur ce
 * qu'on ne détruit pas, jamais sur ce qu'on accepte de compter.
 *
 * `cible` est facultative pour ne pas casser les appelants qui n'ont pas la date
 * d'émission sous la main ; sans elle, l'antériorité ne peut pas être constatée,
 * mais les doublons et les montants nuls le restent.
 */
export function projeterSituationFacture(
  grandLivre: SituationFacture, pieces: PieceReglement[], montant_ttc: number,
  cible: CibleProjection = {},
): SituationFacture {
  const ttc = round2(nb(montant_ttc));
  const recevables = paiementsRecevables(
    { id: cible.id, numero: cible.numero, date_facture: cible.date_facture, montant_ttc: ttc },
    (pieces ?? []).map((p) => ({
      montant: nb(p.montant), date_paiement: p.date ?? null,
      transaction_id: p.transaction_id ?? null, encaissement_id: p.encaissement_id ?? null,
      reference: p.reference ?? null,
    })),
  );
  const payePieces = round2(recevables.reduce((s, p) => s + nb(p.montant), 0));
  if (payePieces <= grandLivre.montant_paye + 0.005) return grandLivre;

  const dates = recevables.map((p) => txt(p.date_paiement).slice(0, 10)).filter(Boolean).sort();
  const paye = Math.max(0, Math.min(payePieces, ttc));
  return {
    ...grandLivre,
    montant_paye: paye,
    montant_restant: Math.max(0, round2(ttc - paye)),
    statut_paiement: statutPaiement(ttc, paye),
    date_paiement: dates.length ? dates[dates.length - 1] : grandLivre.date_paiement,
    source: "pieces",
  };
}

/** Vrai si la projection stockée sur la facture diffère du grand livre. */
export function situationDivergente(
  stocke: { montant_paye?: number | null; montant_restant?: number | null; statut_paiement?: string | null },
  calcule: SituationFacture,
): boolean {
  return Math.abs(round2(nb(stocke.montant_paye) - calcule.montant_paye)) > 0.005
    || Math.abs(round2(nb(stocke.montant_restant) - calcule.montant_restant)) > 0.005
    || txt(stocke.statut_paiement) !== calcule.statut_paiement;
}

// ─── Cohérence du LETTRAGE ───────────────────────────────────────────────────
//
// Un code de lettrage rapproche une créance et son règlement : la somme de ses
// lignes doit donc être NULLE. Quand elle ne l'est pas, le code ne rapproche
// plus rien — il masque.
//
// C'est le pire des défauts silencieux, parce que le lettrage est ce qui fait
// SORTIR une ligne de l'encours (`encoursTiersGrandLivre` ignore toute ligne
// lettrée). Un code déséquilibré retire donc de l'encours une créance qui n'a
// pas été réglée, sans qu'aucun contrôle de partie double ne bronche : le grand
// livre reste équilibré dans son ensemble, seul le SOUS-ENSEMBLE lettré ne l'est
// pas.
//
// Deux façons d'y arriver, toutes deux constatées :
//   • un règlement PARTIEL lettré comme s'il soldait la facture ;
//   • une écriture supprimée d'un côté du code et pas de l'autre — le geste
//     exact qu'un délettrage incomplet produit.

export interface LettrageIncoherent {
  code: string;
  /** Σ débits − Σ crédits des lignes portant ce code. Non nul = incohérent. */
  ecart: number;
  /** Nombre de lignes concernées. */
  lignes: number;
  /** Comptes touchés, pour situer le déséquilibre. */
  comptes: string[];
  message: string;
}

/**
 * Codes de lettrage dont les lignes ne se soldent pas.
 *
 * Le contrôle porte sur TOUTES les lignes d'un code, tous comptes confondus :
 * un lettrage se juge globalement, puisqu'il relie deux comptes différents
 * (le tiers et la trésorerie).
 */
export function controlerEquilibreLettrage(
  lignes: LigneGrandLivre[], seuil = 0.005,
): LettrageIncoherent[] {
  const parCode = new Map<string, LigneGrandLivre[]>();
  for (const l of lignes ?? []) {
    const code = txt(l.lettrage_code);
    if (!code) continue;
    const groupe = parCode.get(code) ?? [];
    groupe.push(l);
    parCode.set(code, groupe);
  }

  const anomalies: LettrageIncoherent[] = [];
  for (const [code, groupe] of parCode) {
    const ecart = round2(groupe.reduce((s, l) => s + nb(l.debit) - nb(l.credit), 0));
    if (Math.abs(ecart) <= seuil) continue;
    const comptes = [...new Set(groupe.map((l) => txt(l.compte_numero)))].sort();
    anomalies.push({
      code, ecart, lignes: groupe.length, comptes,
      message: `Lettrage « ${code} » déséquilibré de ${ecart.toFixed(2)} MAD sur `
        + `${groupe.length} ligne(s) (${comptes.join(", ")}). Un code lettré fait SORTIR `
        + "ses lignes de l'encours : déséquilibré, il en retire une créance qui n'a pas "
        + "été réglée, et la partie double du grand livre ne le voit pas.",
    });
  }
  return anomalies.sort((a, b) => Math.abs(b.ecart) - Math.abs(a.ecart));
}
