/**
 * RepartitionVentesPcm — donut du CHIFFRE D'AFFAIRES HT (classe 7) par compte PCM.
 *
 * Miroir exact de `RepartitionDepensesPcm` : un poste = un compte de produit du
 * grand livre (7111 « Ventes de marchandises », 7124 « Ventes de services
 * produits au Maroc »…), avec son intitulé réel, la règle stricte des 5 postes
 * + « Autres ventes », la même palette validée et la même infobulle (code PCM,
 * montant en MAD, part exacte).
 *
 * Ce qui change côté calcul — et c'est tout : `ventilerVentesParCompte` lit le
 * solde CRÉDITEUR, sens naturel d'un compte de produit, pour que les rabais et
 * avoirs (7129) viennent en diminution du CA au lieu d'y figurer comme un poste
 * de vente.
 */

import { DonutRepartitionPcm } from "./DonutRepartitionPcm";
import type { PartComptePcm } from "@/lib/dashboard-fiscal";

interface Props {
  parts: PartComptePcm[];
  /** Total du CA HT affiché (somme exacte des tranches). */
  total: number;
}

export function RepartitionVentesPcm({ parts, total }: Props) {
  return (
    <DonutRepartitionPcm
      parts={parts}
      total={total}
      libelleTotal="Ventes HT"
      messageVide="Aucune vente comptabilisée (classe 7)."
    />
  );
}
