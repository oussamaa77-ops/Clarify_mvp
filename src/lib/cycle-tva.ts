// ============================================================================
// cycle-tva.ts — Où en est une période de TVA, et ce que l'écran a le droit de
// proposer.
//
// La déclaration SIMPL-TVA est une SÉQUENCE : on ne paie pas une période non
// déclarée, on ne joint pas de quittance à un paiement qui n'existe pas, on ne
// pointe pas un règlement dont le 4456 n'est pas soldé. Cet enchaînement est
// une règle métier, pas une préférence d'affichage : le laisser vivre en `&&`
// dans le JSX, c'est le réécrire à chaque bouton et le perdre au premier
// remaniement.
//
// D'où ce module : une fonction pure prend l'état serveur et rend l'étape
// courante, le libellé de l'état, et ce qui est actionnable. L'écran ne fait
// plus que le peindre — et le test le vérifie sans navigateur.
// ============================================================================

import { resteExigible } from "./liquidation-tva";

export type EtapeCycleTva =
  | "neant" | "a_declarer" | "a_payer" | "a_justifier" | "a_pointer" | "liquidee";

export interface EtatCycleTva {
  declaree?: boolean | null;
  /**
   * Solde du 4456 arrêté à la FIN de la période (bouclage).
   *
   * Sert de repli quand les deux champs suivants manquent, mais ne décide plus
   * seul : arrêté au 31 mars, il ignore le prélèvement du 20 avril.
   */
  resteAPayer?: number | null;
  /** Solde du 4456 à ce jour, toutes dates confondues. */
  solde4456?: number | null;
  /** Reste dû sur la déclaration de CETTE période, règlements postérieurs déduits. */
  resteAPayerPeriode?: number | null;
  /** Un règlement DGI est-il rattaché à la déclaration de la période ? */
  regle?: boolean | null;
  pointe?: boolean | null;
  tracable?: boolean | null;
  /**
   * Récépissé SIMPL-TVA déposé.
   *
   * Sans prélèvement, c'est la SEULE pièce qui prouve le dépôt de la
   * déclaration : c'est donc elle qui clôt une période en crédit de TVA.
   */
  quittance?: boolean | null;
  liquidation?: { neant?: boolean | null; dette?: boolean | null } | null;
}

/** Tolérance d'arrondi : au-delà, le 4456 porte une vraie dette. */
const EPS = 0.005;

const round2 = (x: number) => Math.round(x * 100) / 100;

/** Solde du 4456 à retenir : le solde vivant, à défaut celui de fin de période. */
const solde4456 = (etat: EtatCycleTva | null | undefined): number =>
  Number(etat?.solde4456 ?? etat?.resteAPayer ?? 0);

/**
 * Ce qu'il reste À PAYER sur la période, tel que l'écran doit le lire.
 *
 * Deux bornes, et il faut les deux (cf. `resteExigible`) : le reste de la pièce
 * — qui tombe à zéro dès qu'un prélèvement est rattaché à la déclaration, même
 * daté du mois suivant — et le solde du compte, qui peut déjà être éteint par un
 * crédit antérieur. Lire `resteAPayer` seul réclamerait un prélèvement déjà fait.
 */
export function resteAPayerTva(etat: EtatCycleTva | null | undefined): number {
  const solde = solde4456(etat);
  const cycle = etat?.resteAPayerPeriode;
  return resteExigible(cycle == null ? solde : Number(cycle), solde);
}

/**
 * La période dégage-t-elle un CRÉDIT de TVA — TVA nette à payer nulle et report
 * sur les périodes suivantes ?
 *
 * La réponse se lit sur la LIQUIDATION de la période (`dette === false`), jamais
 * sur le solde du 4456 : ce solde est CUMULATIF (cf. `controlerBouclagePeriode`),
 * il mélange la période courante et tout ce que les précédentes ont laissé.
 * Conclure « il reste à payer, donc la période est en dette » présenterait
 * l'arriéré d'un mois passé comme l'échéance du mois courant.
 */
export function estCreditTva(etat: EtatCycleTva | null | undefined): boolean {
  const liq = etat?.liquidation ?? null;
  return !!liq && !liq.neant && liq.dette === false;
}

/**
 * Dette de TVA HÉRITÉE des périodes antérieures, en positif ; 0 sinon.
 *
 * N'a de sens que sur une période en crédit : la liquidation du mois n'a rien
 * mis au crédit du 4456, donc ce qu'il en reste vient forcément d'avant. Sur une
 * période en dette, le reste dû se lit tel quel — le séparer n'apporterait rien.
 */
export function soldeHistoriqueTva(etat: EtatCycleTva | null | undefined): number {
  if (!estCreditTva(etat)) return 0;
  const du = solde4456(etat);
  return du > EPS ? round2(du) : 0;
}

/**
 * Étape atteinte par la période.
 *
 * Un crédit de TVA saute l'étape de paiement : il n'y a rien à prélever, donc
 * rien à pointer non plus. Le traiter comme « à payer » afficherait comme
 * échéance du mois une dette qui n'est pas la sienne, et le traiter comme « à
 * pointer » ferait attendre un règlement qui n'arrivera jamais. Il se clôt sur
 * PIÈCES : l'OD de liquidation, puis le récépissé SIMPL-TVA.
 */
export function etapeCycleTva(etat: EtatCycleTva | null | undefined): EtapeCycleTva {
  const liq = etat?.liquidation ?? null;
  if (!liq || liq.neant) return "neant";
  if (!etat?.declaree) return "a_declarer";
  if (estCreditTva(etat)) return etat?.quittance ? "liquidee" : "a_justifier";
  if (resteAPayerTva(etat) > EPS) return "a_payer";
  if (etat?.pointe) return "liquidee";
  return "a_pointer";
}

export interface BadgeCycleTva {
  label: string;
  /** Variante shadcn du badge — `default` réservé à l'état final. */
  variant: "default" | "secondary" | "outline" | "destructive";
  /** Classes de couleur, pour distinguer « déclarée » de « liquidée & payée ». */
  classe: string;
}

/** Libellé d'état affiché en tête de panneau — l'utilisateur y lit où il en est. */
export function badgeCycleTva(etat: EtatCycleTva | null | undefined): BadgeCycleTva {
  switch (etapeCycleTva(etat)) {
    case "neant":
      return { label: "Néant", variant: "outline", classe: "text-muted-foreground" };
    case "a_declarer":
      return { label: "À déclarer", variant: "outline", classe: "border-orange-300 text-orange-700 dark:text-orange-400" };
    case "a_payer":
      return { label: "Déclarée", variant: "secondary", classe: "text-blue-700 dark:text-blue-400" };
    case "a_justifier":
      // Le crédit de TVA n'attend aucun prélèvement : le dire évite de faire
      // chercher un règlement qui n'arrivera jamais.
      return { label: "Crédit de TVA", variant: "secondary", classe: "text-blue-700 dark:text-blue-400" };
    case "a_pointer":
      return { label: "Payée — à pointer", variant: "secondary", classe: "text-amber-700 dark:text-amber-400" };
    case "liquidee":
      return {
        // « Payée » serait faux sur un crédit : rien n'a été prélevé, la période
        // est close parce qu'elle est déclarée et justifiée.
        label: estCreditTva(etat) ? "Liquidée — crédit reporté" : "Liquidée & Payée",
        variant: "default",
        classe: "bg-emerald-600 text-white hover:bg-emerald-600",
      };
  }
}

export interface ActionsCycleTva {
  /** Générer l'OD de liquidation. */
  declarer: boolean;
  /** Enregistrer le prélèvement DGI. */
  payer: boolean;
  /** Téléverser ou remplacer la quittance SIMPL-TVA. */
  quittance: boolean;
  /** Basculer le pointage du règlement sur le 4456. */
  pointer: boolean;
  /** Raison affichée quand le pointage est indisponible — jamais un bouton muet. */
  raisonPointageIndisponible: string | null;
}

/**
 * Ce que l'écran a le droit de proposer, dans cet état.
 *
 * Rendre `pointer` faux ne suffit pas : un bouton grisé sans explication se lit
 * comme un bug. La raison est calculée ici, à côté de la règle qui l'a produite.
 */
export function actionsCycleTva(etat: EtatCycleTva | null | undefined): ActionsCycleTva {
  const etape = etapeCycleTva(etat);
  const declaree = !!etat?.declaree;
  const tracable = etat?.tracable !== false;

  // L'ordre compte : le crédit de TVA passe AVANT le solde du 4456. Ce solde est
  // cumulatif, et un arriéré antérieur ferait sinon réclamer « enregistrez le
  // prélèvement DGI » sur une période qui n'a rien à prélever.
  const raison = !declaree
    ? "Générez d'abord l'OD de liquidation."
    // Un crédit de TVA n'est jamais prélevé : il n'existe aucune ligne
    // bancaire de débit à rapprocher, donc rien à pointer.
    : estCreditTva(etat)
      ? etat?.quittance
        ? "Aucun prélèvement à pointer : la période en crédit de TVA est validée par l'OD de liquidation et son récépissé."
        : "Aucun prélèvement à pointer : la période dégage un crédit de TVA reportable — déposez le récépissé SIMPL-TVA pour la valider."
      : resteAPayerTva(etat) > EPS
        ? "Le compte 4456 n'est pas soldé : enregistrez le prélèvement DGI."
        : !tracable
          ? "Colonnes de traçabilité absentes : appliquez la migration 20260809130000."
          : null;

  return {
    declarer: etape === "a_declarer",
    payer: etape === "a_payer",
    quittance: declaree,
    pointer: raison === null,
    raisonPointageIndisponible: raison,
  };
}
