/**
 * RepartitionDepensesPcm — donut des CHARGES HT (classe 6) par compte PCM.
 *
 * Un poste = un compte du grand livre (6111, 6133, 6145…), avec son intitulé
 * réel : plus de regroupement maison sous un libellé vague, le comptable
 * retrouve dans le graphique exactement les comptes qu'il a mouvementés.
 *
 * Le calcul vit dans `ventilerChargesParCompte` (logique pure, testée) et le
 * rendu dans `DonutRepartitionPcm`, partagé avec le donut des ventes — les deux
 * widgets ne peuvent donc pas diverger visuellement.
 */

import { DonutRepartitionPcm } from "./DonutRepartitionPcm";
import type { PartComptePcm } from "@/lib/dashboard-fiscal";

interface Props {
  parts: PartComptePcm[];
  /** Total des charges HT affichées (somme exacte des tranches). */
  total: number;
}

export function RepartitionDepensesPcm({ parts, total }: Props) {
  return (
    <DonutRepartitionPcm
      parts={parts}
      total={total}
      libelleTotal="Charges HT"
      messageVide="Aucune charge comptabilisée (classe 6)."
    />
  );
}
