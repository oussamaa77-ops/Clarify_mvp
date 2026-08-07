// Cellule « Date de règlement », partagée par les tableaux de factures clients
// et fournisseurs. Un seul rendu pour les deux sens : la date se lit de la même
// façon des deux côtés, et la dupliquer les ferait diverger à la première retouche.

import {
  dateReglementFacture, formaterDateReglement, infobulleDateReglement,
  type DateReglement, type FactureDateRef,
} from "@/lib/date-reglement";

export function DateReglementCell({
  facture, index, className = "",
}: {
  facture: FactureDateRef;
  index: Map<string, DateReglement>;
  className?: string;
}) {
  const d = dateReglementFacture(facture, index);
  if (!d) return <span className="text-muted-foreground text-sm">—</span>;
  return (
    <span className={`text-sm ${className}`} title={infobulleDateReglement(d)}>
      {formaterDateReglement(d)}
      {/* Un règlement échelonné : la date affichée est celle du DERNIER
          versement, et l'utilisateur doit pouvoir s'en rendre compte. */}
      {d.nbReglements > 1 && (
        <span className="ml-1 text-[10px] text-muted-foreground">×{d.nbReglements}</span>
      )}
    </span>
  );
}
