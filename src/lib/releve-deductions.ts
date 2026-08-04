// ============================================================================
// Relevé des déductions de TVA — format SIMPL-TVA (DGI Maroc).
//
// Pièce jointe obligatoire de la déclaration : elle détaille, ligne à ligne, les
// achats dont la TVA est déduite sur la période. Le format attendu par le portail
// compte 14 colonnes, dans un ORDRE FIGÉ — un décalage de colonne fait rejeter
// le dépôt, d'où la constante `COLONNES_RELEVE_DEDUCTIONS` comme source unique.
//
// Règle structurante : la ligne du relevé est un RÈGLEMENT, pas une facture.
// Sous le régime de l'encaissement, le droit à déduction naît au décaissement ;
// une facture réglée en trois fois produit donc trois lignes, chacune avec sa
// quote-part de HT/TVA/TTC et SA date de paiement.
// ============================================================================

import { intitulePcm, partReglee, type FactureFiscale, type PaiementFiscal } from "./dashboard-fiscal";
import { normaliserMode, type ModePaiement } from "./mode-paiement";
import { TVA_RATES_MA } from "./tva";

const round2 = (x: number) => Math.round(x * 100) / 100;

function n(v: unknown): number {
  const x = Number(v);
  return isFinite(x) ? x : 0;
}

/** En-têtes SIMPL-TVA, dans l'ordre imposé par la DGI. */
export const COLONNES_RELEVE_DEDUCTIONS = [
  "N° ordre",
  "N° facture",
  "Désignation",
  "Montant HT",
  "Montant TVA",
  "Montant TTC",
  "IF Fournisseur",
  "Nom/Raison sociale",
  "ICE Fournisseur",
  "Taux TVA",
  "Prorata",
  "Id Mode Paiement",
  "Date paiement",
  "Date facture",
] as const;

/** Codes DGI des modes de règlement (colonne 12). */
export const MODE_PAIEMENT_DGI = {
  espece: 1,
  cheque: 2,
  prelevement: 3,
  virement: 4,
  effet: 5,
  compensation: 6,
  autre: 7,
} as const;

/**
 * Instrument interne → code DGI.
 *
 * La carte bancaire n'a pas de code dédié dans la nomenclature SIMPL : elle tombe
 * en « Autre » (7), comme tout mode inconnu. On ne devine jamais « Compensation »
 * (6), qui suppose une convention entre les parties et ne se déduit d'aucune trace.
 */
export function codeModePaiementDGI(mode: ModePaiement | null | undefined): number {
  switch (mode) {
    case "especes":     return MODE_PAIEMENT_DGI.espece;
    case "cheque":      return MODE_PAIEMENT_DGI.cheque;
    case "prelevement": return MODE_PAIEMENT_DGI.prelevement;
    case "virement":    return MODE_PAIEMENT_DGI.virement;
    case "effet":       return MODE_PAIEMENT_DGI.effet;
    default:            return MODE_PAIEMENT_DGI.autre;
  }
}

/** Facture d'achat, vue sous l'angle du relevé des déductions. */
export interface AchatDeduction extends FactureFiscale {
  numero?: string | null;
  fournisseur_id?: string | null;
  fournisseur_nom?: string | null;
  mode_reglement?: string | null;
  /** Date de règlement portée par la facture (repli quand `paiements` est muet). */
  date_paiement?: string | null;
  /** Lignes de détail issues de l'OCR — source de la désignation. */
  lignes?: unknown;
}

/** Fournisseur : porte l'identité fiscale exigée par la DGI (IF et ICE). */
export interface TiersDeduction {
  id?: string | null;
  nom?: string | null;
  ice?: string | null;
  if_fiscal?: string | null;
}

export interface LigneReleveDeduction {
  ordre: number;
  numeroFacture: string;
  designation: string;
  montantHt: number;
  montantTva: number;
  montantTtc: number;
  ifFournisseur: string;
  nomFournisseur: string;
  iceFournisseur: string;
  tauxTva: number;
  prorata: number;
  idModePaiement: number;
  datePaiement: string;
  dateFacture: string;
  /** `true` quand la ligne provient d'un règlement daté (et non d'un repli). */
  reglementDate: boolean;
}

/**
 * Désignation par défaut quand rien d'exploitable n'est disponible.
 * La colonne « Désignation du bien ou service » est OBLIGATOIRE : une cellule
 * vide fait rejeter le dépôt, un libellé générique conforme ne le fait pas.
 */
export const DESIGNATION_DGI_DEFAUT = "ACHATS DE BIENS ET SERVICES";

/**
 * Désignation de l'achat : premier libellé exploitable des lignes OCR.
 *
 * Rend une chaîne vide quand rien n'est exploitable — c'est `designationDGI` qui
 * décide du repli, pour que cette fonction reste utilisable comme simple lecteur.
 */
export function designationAchat(lignes: unknown): string {
  if (!Array.isArray(lignes)) return "";
  for (const l of lignes) {
    if (typeof l === "string" && l.trim()) return l.trim();
    if (l && typeof l === "object") {
      const o = l as Record<string, unknown>;
      for (const cle of ["designation", "description", "libelle", "label", "nom"]) {
        const v = o[cle];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
    }
  }
  return "";
}

/**
 * Désignation portée au relevé, du plus précis au plus générique :
 *   1. le libellé des lignes de la facture (ce que l'entreprise a réellement acheté) ;
 *   2. la NATURE DE LA CHARGE, via l'intitulé PCM du compte imputé (6111 → « Achats
 *      de marchandises », 6145 → « Frais postaux et de télécommunications »…) ;
 *   3. le libellé générique conforme DGI.
 *
 * Le compte de charge est un bon repli : il est choisi par le moteur de
 * catégorisation ou par le comptable, donc il qualifie la dépense — là où un
 * numéro de facture n'apprendrait rien à l'administration.
 */
export function designationDGI(
  lignes: unknown,
  compteCharge?: string | null,
  intitules: Record<string, string> = {},
): string {
  const depuisLignes = designationAchat(lignes);
  if (depuisLignes) return depuisLignes;

  const compte = String(compteCharge ?? "").trim();
  if (compte) {
    const intitule = intitulePcm(compte, intitules);
    if (intitule) return intitule.toUpperCase();
  }
  return DESIGNATION_DGI_DEFAUT;
}

/** Écriture comptable, vue sous l'angle du rattachement facture → compte. */
export interface EcritureCharge {
  compte_numero?: string | null;
  reference_piece?: string | null;
  debit?: number | null;
}

/**
 * Index facture → compte de charge imputé, construit depuis le grand livre.
 *
 * `reference_piece` porte l'identifiant de la facture d'origine. Quand plusieurs
 * comptes de charge sont mouvementés pour une même pièce (achat ventilé), on
 * retient le PLUS GROS débit : c'est lui qui qualifie la dépense.
 */
export function indexerComptesCharge(ecritures: EcritureCharge[]): Map<string, string> {
  const meilleur = new Map<string, { compte: string; debit: number }>();
  for (const e of ecritures) {
    const ref = String(e?.reference_piece ?? "").trim();
    const compte = String(e?.compte_numero ?? "").trim();
    if (!ref || !compte.startsWith("6")) continue;
    const debit = n(e.debit);
    const actuel = meilleur.get(ref);
    if (!actuel || debit > actuel.debit) meilleur.set(ref, { compte, debit });
  }
  return new Map([...meilleur].map(([ref, v]) => [ref, v.compte]));
}

/**
 * Taux de TVA de la facture, déduit du rapport TVA/HT et ALIGNÉ sur un taux légal
 * marocain quand il en est proche (les arrondis d'OCR donnent 19,98 % pour 20 %).
 * Un rapport hors barème est rendu tel quel : mieux vaut un taux visiblement
 * atypique qu'un taux faux arrondi de force.
 */
export function tauxTvaFacture(montantHt: number, montantTva: number): number {
  const ht = n(montantHt);
  if (ht <= 0) return 0;
  const brut = (n(montantTva) / ht) * 100;
  const proche = TVA_RATES_MA.find((t) => Math.abs(brut - t) <= 0.5);
  return proche ?? round2(brut);
}

/** Identité fiscale d'un fournisseur, telle qu'elle part au relevé. */
export interface IdentiteFiscale {
  nom: string;
  ice: string;
  if_fiscal: string;
}

/** Comparaison de raisons sociales tolérante aux espaces et aux accents. */
function normNom(v: unknown): string {
  return String(v ?? "").trim().toUpperCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ");
}

const texte = (v: unknown) => String(v ?? "").trim();

/**
 * Identité fiscale du fournisseur d'un achat — JOINTURE DYNAMIQUE sur l'annuaire.
 *
 * La fiche fournisseur fait FOI : elle est tenue à jour, alors que le nom copié
 * sur la facture fige l'état du jour de la saisie. On ne se contente pas de la
 * fiche pointée par `fournisseur_id` pour autant :
 *
 *  1. rattachement par `fournisseur_id`, sinon par raison sociale normalisée
 *     (une facture importée sans lien reste ainsi identifiable) ;
 *  2. CONSOLIDATION : les doublons d'annuaire (même raison sociale ou même ICE)
 *     complètent les champs manquants de la fiche principale. Sans cela, un ICE
 *     ou un IF présent sur la fiche jumelle partirait vide au relevé alors que le
 *     cabinet l'a bien saisi.
 *
 * Le nom de la facture ne sert qu'en dernier recours, si aucune fiche ne répond.
 */
export function resoudreIdentiteFiscale(
  achat: Pick<AchatDeduction, "fournisseur_id" | "fournisseur_nom">,
  fournisseurs: TiersDeduction[] = [],
): IdentiteFiscale {
  const parId = achat.fournisseur_id
    ? fournisseurs.find((t) => t?.id === achat.fournisseur_id)
    : undefined;
  const nomRecherche = normNom(parId?.nom ?? achat.fournisseur_nom);
  const principal = parId ?? fournisseurs.find((t) => normNom(t?.nom) === nomRecherche && nomRecherche !== "");

  // Fiches jumelles : même raison sociale, ou même ICE que la fiche principale.
  const iceRef = texte(principal?.ice);
  const jumelles = fournisseurs.filter((t) =>
    t !== principal && (
      (nomRecherche !== "" && normNom(t?.nom) === nomRecherche) ||
      (iceRef !== "" && texte(t?.ice) === iceRef)
    ));

  const premier = (lire: (t: TiersDeduction) => unknown) => {
    for (const t of [principal, ...jumelles]) {
      if (!t) continue;
      const v = texte(lire(t));
      if (v) return v;
    }
    return "";
  };

  return {
    nom: premier((t) => t.nom) || texte(achat.fournisseur_nom),
    ice: premier((t) => t.ice),
    if_fiscal: premier((t) => t.if_fiscal),
  };
}

/** Règlement retenu pour une ligne : un montant, une date, un instrument. */
interface Reglement {
  montant: number;
  date: string;
  date_ok: boolean;
}

/**
 * Règlements d'une facture, dans l'ordre chronologique.
 *
 * Priorité aux règlements DATÉS de la table `paiements` (source de vérité du
 * reste dû). À défaut — factures antérieures au moteur de paiement, qui ne
 * portent que `montant_paye` — on produit un règlement unique reconstitué, daté
 * de `date_paiement` puis, en dernier recours, de la date de facture. La colonne
 * `reglementDate` conserve la trace de ce repli.
 */
function reglementsDeLaFacture(f: AchatDeduction, paiements: PaiementFiscal[]): Reglement[] {
  const ttc = n(f.montant_ttc);
  const dates = paiements
    .filter((p) => n(p.montant) > 0 && (p.date_paiement ?? "").slice(0, 10))
    .map((p) => ({ montant: n(p.montant), date: String(p.date_paiement).slice(0, 10), date_ok: true }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const sommeDatee = dates.reduce((s, r) => s + r.montant, 0);
  // Un cumul supérieur au TTC (saisie en double) ne crée pas de déduction :
  // toutes les quotes-parts sont ramenées à 100 % du TTC.
  const facteur = ttc > 0 && sommeDatee > ttc ? ttc / sommeDatee : 1;
  const retenus = facteur === 1 ? dates : dates.map((r) => ({ ...r, montant: round2(r.montant * facteur) }));

  const regleTotal = ttc * partReglee(f);
  const reste = round2(regleTotal - retenus.reduce((s, r) => s + r.montant, 0));
  if (reste > 0.005) {
    const date = (f.date_paiement ?? f.date_facture ?? "").slice(0, 10);
    if (date) retenus.push({ montant: reste, date, date_ok: false });
  }
  return retenus.sort((a, b) => a.date.localeCompare(b.date));
}

export interface OptionsReleveDeductions {
  achats: AchatDeduction[];
  /** Règlements datés (table `paiements`), tous sens confondus. */
  paiements?: PaiementFiscal[];
  /** Annuaire fournisseurs — porte l'IF et l'ICE exigés par la DGI. */
  fournisseurs?: TiersDeduction[];
  /** Index facture → instrument constaté (cf. `indexerModesPaiement`). */
  modes?: Map<string, ModePaiement>;
  /** Index facture → compte de charge imputé (cf. `indexerComptesCharge`). */
  comptesCharge?: Map<string, string>;
  /** Intitulés PCM du cabinet, pour nommer la catégorie de charge. */
  intitulesPcm?: Record<string, string>;
  /** Bornes de la période déclarée (AAAA-MM-JJ, incluses). */
  debut?: string;
  fin?: string;
}

/**
 * Construit le relevé des déductions de la période.
 *
 * Une ligne = un règlement. Les achats sans TVA (exonérés, hors champ) sont
 * écartés : ils n'ouvrent aucun droit à déduction et alourdiraient le dépôt.
 */
export function construireReleveDeductions(opts: OptionsReleveDeductions): LigneReleveDeduction[] {
  const paiementsParFacture = new Map<string, PaiementFiscal[]>();
  for (const p of opts.paiements ?? []) {
    const id = p.facture_fournisseur_id;
    if (!id) continue;
    const liste = paiementsParFacture.get(id);
    if (liste) liste.push(p); else paiementsParFacture.set(id, [p]);
  }

  const dansPeriode = (d: string) => {
    if (opts.debut && d < opts.debut) return false;
    if (opts.fin && d > opts.fin) return false;
    return true;
  };

  const lignes: Omit<LigneReleveDeduction, "ordre">[] = [];

  for (const f of opts.achats) {
    const ttc = n(f.montant_ttc);
    const tva = n(f.montant_tva);
    if (tva <= 0 || ttc <= 0) continue;   // hors champ de la déduction

    const identite = resoudreIdentiteFiscale(f, opts.fournisseurs ?? []);
    const mode = (f.id ? opts.modes?.get(f.id) : undefined) ?? normaliserMode(f.mode_reglement);
    const commun = {
      numeroFacture: String(f.numero ?? "").trim(),
      designation: designationDGI(
        f.lignes,
        f.id ? opts.comptesCharge?.get(f.id) : undefined,
        opts.intitulesPcm,
      ),
      ifFournisseur: identite.if_fiscal,
      nomFournisseur: identite.nom,
      iceFournisseur: identite.ice,
      tauxTva: tauxTvaFacture(n(f.montant_ht), tva),
      // Prorata de déduction : 100 % par défaut (assujetti total), seul cas que
      // le module sait établir sans déclaration explicite du cabinet.
      prorata: 100,
      idModePaiement: codeModePaiementDGI(mode),
      dateFacture: (f.date_facture ?? "").slice(0, 10),
    };

    for (const r of reglementsDeLaFacture(f, paiementsParFacture.get(f.id ?? "") ?? [])) {
      if (!dansPeriode(r.date)) continue;
      const quote = r.montant / ttc;
      lignes.push({
        ...commun,
        montantHt: round2(n(f.montant_ht) * quote),
        montantTva: round2(tva * quote),
        montantTtc: round2(r.montant),
        datePaiement: r.date,
        reglementDate: r.date_ok,
      });
    }
  }

  // Ordre de dépôt : chronologique, puis par facture — un relevé se relit dans
  // l'ordre des décaissements. Le n° d'ordre est attribué APRÈS le tri.
  lignes.sort((a, b) =>
    a.datePaiement.localeCompare(b.datePaiement) ||
    a.numeroFacture.localeCompare(b.numeroFacture) ||
    b.montantTtc - a.montantTtc);

  return lignes.map((l, i) => ({ ordre: i + 1, ...l }));
}

/** Ligne → tableau de 14 cellules, dans l'ordre des colonnes DGI. */
export function ligneVersCellules(l: LigneReleveDeduction): (string | number)[] {
  return [
    l.ordre, l.numeroFacture, l.designation,
    l.montantHt, l.montantTva, l.montantTtc,
    l.ifFournisseur, l.nomFournisseur, l.iceFournisseur,
    l.tauxTva, l.prorata, l.idModePaiement,
    l.datePaiement, l.dateFacture,
  ];
}

export interface TotauxReleveDeductions {
  lignes: number;
  totalHt: number;
  totalTva: number;
  totalTtc: number;
  /** Lignes issues d'un repli (règlement non daté) — à contrôler avant dépôt. */
  sansReglementDate: number;
  /** Lignes sans IF ni ICE fournisseur — la DGI rejette le dépôt sur ce motif. */
  sansIdentiteFiscale: number;
  /** Lignes dont le règlement précède la facture — anomalie de saisie. */
  paiementAvantFacture: number;
}

export function totauxReleveDeductions(lignes: LigneReleveDeduction[]): TotauxReleveDeductions {
  return {
    lignes: lignes.length,
    totalHt: round2(lignes.reduce((s, l) => s + l.montantHt, 0)),
    totalTva: round2(lignes.reduce((s, l) => s + l.montantTva, 0)),
    totalTtc: round2(lignes.reduce((s, l) => s + l.montantTtc, 0)),
    sansReglementDate: lignes.filter((l) => !l.reglementDate).length,
    // L'IF est l'identifiant attendu par SIMPL ; l'ICE le supplée en pratique.
    // Une ligne sans AUCUN des deux est indéfendable devant l'administration.
    sansIdentiteFiscale: lignes.filter((l) => !l.ifFournisseur && !l.iceFournisseur).length,
    paiementAvantFacture: lignes.filter(
      (l) => l.dateFacture && l.datePaiement && l.datePaiement < l.dateFacture,
    ).length,
  };
}
