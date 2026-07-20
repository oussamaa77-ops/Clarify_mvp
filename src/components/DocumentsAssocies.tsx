import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { FileText, Info, Eye } from "lucide-react";
import { justificatifDetails } from "@/lib/justificatif-details";
import type { DocumentViewerSource } from "@/components/DocumentViewer";

const fmt = (n: number) =>
  Number(n).toLocaleString("fr-MA", { minimumFractionDigits: 2 }) + " MAD";

/**
 * Tableau des justificatifs rattachés à un flux (vente ou achat).
 *
 * La colonne « Détails essentiels » n'est pas générique : chaque type de pièce
 * y affiche ce qui le caractérise (période et bailleur pour une quittance de
 * loyer, période de cotisation pour une CNSS, quantités livrées et BC lié pour
 * un bon de livraison…). Voir src/lib/justificatif-details.ts.
 */
export function DocumentsAssocies({
  justificatifs,
  flux,
  onVoir,
}: {
  justificatifs: any[];
  flux: "vente" | "achat";
  onVoir?: (source: DocumentViewerSource) => void;
}) {
  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[150px]">Type</TableHead>
              <TableHead>Tiers</TableHead>
              <TableHead>Détails essentiels</TableHead>
              <TableHead className="text-right">Montant</TableHead>
              <TableHead>Statut</TableHead>
              <TableHead>Lié à</TableHead>
              <TableHead className="w-10"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {justificatifs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-12 text-muted-foreground">
                  <FileText className="h-8 w-8 mx-auto mb-2 opacity-30" />
                  {flux === "achat"
                    ? "Aucun document d'achat — scannez un BL, une quittance ou un reçu"
                    : "Aucun document de vente associé"}
                </TableCell>
              </TableRow>
            ) : (
              justificatifs.map((j: any) => {
                const d = justificatifDetails(j);
                const lie = j.bon_commande_id
                  ? justificatifs.find((x: any) => x.id === j.bon_commande_id)
                  : j.devis_id
                    ? justificatifs.find((x: any) => x.id === j.devis_id)
                    : null;
                return (
                  <TableRow key={j.id} className="align-top">
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Badge variant="outline" className={`text-xs whitespace-nowrap ${d.cls}`}>
                          {d.label}
                        </Badge>
                        {d.note && (
                          <span title={d.note} aria-label={d.note} className="inline-flex">
                            <Info className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm font-medium max-w-[160px] truncate">
                      {j.nom_tiers ?? "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {d.chips.map((c) => (
                          <span
                            key={c.label}
                            className="text-[10px] px-1.5 py-0.5 rounded bg-muted/70 text-muted-foreground"
                          >
                            {c.label} :{" "}
                            <span className={`text-foreground ${c.mono ? "font-mono font-medium" : ""}`}>
                              {c.value}
                            </span>
                          </span>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm font-semibold whitespace-nowrap">
                      {/* Un bon de livraison ne porte pas de montant : afficher un
                          chiffre ici laisserait croire à une charge comptabilisable. */}
                      {d.montant === null
                        ? <span className="text-muted-foreground font-sans font-normal text-xs">non valorisé</span>
                        : fmt(d.montant)}
                    </TableCell>
                    <TableCell>
                      {j.statut === "rapproche"
                        ? <Badge className="bg-green-100 text-green-700 text-xs">✅ Rapproché</Badge>
                        : <Badge className="bg-orange-100 text-orange-700 text-xs">⏳ En attente</Badge>}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground font-mono">
                      {lie ? (lie.numero_piece ?? lie.nom_tiers ?? lie.id.slice(0, 8)) : "—"}
                    </TableCell>
                    <TableCell>
                      {onVoir && j.fichier_original_url && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          title="Voir le document"
                          onClick={() => onVoir({
                            title: `${d.label} ${j.numero_piece ?? ""}`.trim(),
                            url: j.fichier_original_url,
                            fileName: j.fichier_original_nom,
                            mimeType: j.fichier_original_type,
                          })}
                        >
                          <Eye className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
