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

export type EtapeCycleTva = "neant" | "a_declarer" | "a_payer" | "a_pointer" | "liquidee";

export interface EtatCycleTva {
  declaree?: boolean | null;
  resteAPayer?: number | null;
  pointe?: boolean | null;
  tracable?: boolean | null;
  liquidation?: { neant?: boolean | null; dette?: boolean | null } | null;
}

/** Tolérance d'arrondi : au-delà, le 4456 porte une vraie dette. */
const EPS = 0.005;

/**
 * Étape atteinte par la période.
 *
 * Un crédit de TVA saute l'étape de paiement : il n'y a rien à prélever, le
 * cycle est complet dès l'OD générée. Le traiter comme « à payer » afficherait
 * une dette de 0,00 MAD que l'utilisateur ne pourrait jamais solder.
 */
export function etapeCycleTva(etat: EtatCycleTva | null | undefined): EtapeCycleTva {
  const liq = etat?.liquidation ?? null;
  if (!liq || liq.neant) return "neant";
  if (!etat?.declaree) return "a_declarer";
  if (Number(etat?.resteAPayer ?? 0) > EPS) return "a_payer";
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
    case "a_pointer":
      // Le crédit de TVA n'attend aucun prélèvement : le dire évite de faire
      // chercher un règlement qui n'arrivera jamais.
      return etat?.liquidation?.dette === false
        ? { label: "Crédit de TVA", variant: "secondary", classe: "text-blue-700 dark:text-blue-400" }
        : { label: "Payée — à pointer", variant: "secondary", classe: "text-amber-700 dark:text-amber-400" };
    case "liquidee":
      return {
        label: "Liquidée & Payée", variant: "default",
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

  const raison = !declaree
    ? "Générez d'abord l'OD de liquidation."
    : Number(etat?.resteAPayer ?? 0) > EPS
      ? "Le compte 4456 n'est pas soldé : enregistrez le prélèvement DGI."
      // Un crédit de TVA n'est jamais prélevé : il n'existe aucune ligne
      // bancaire de débit à rapprocher, donc rien à pointer.
      : etat?.liquidation?.dette === false
        ? "Aucun prélèvement à pointer : la période dégage un crédit de TVA reportable."
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
