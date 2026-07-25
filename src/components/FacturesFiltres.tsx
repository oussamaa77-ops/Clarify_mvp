import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { X } from "lucide-react";
import type { CriteresFiltre, StatutFiltre, ChampDate } from "@/lib/factures-filtres";

interface FacturesFiltresProps {
  criteres: CriteresFiltre;
  onChange: (c: CriteresFiltre) => void;
  /** Liste des tiers proposés au filtre (clients ou fournisseurs). */
  tiers: { id: string; nom: string }[];
  /** Libellé du tiers selon l'écran : « Client » ou « Fournisseur ». */
  labelTiers: string;
  nbFiltrees: number;
  nbTotal: number;
}

const CRITERES_VIDES: CriteresFiltre = {
  texte: "", statut: "toutes", tiersId: "", debut: "", fin: "", champDate: "date_facture",
};

/** Un filtre est « actif » dès qu'il s'écarte de l'état neutre. */
function aDesFiltres(c: CriteresFiltre): boolean {
  return Boolean(c.texte || (c.statut && c.statut !== "toutes") || c.tiersId || c.debut || c.fin);
}

/**
 * Barre de filtres commune aux tableaux de factures Ventes et Achats.
 * Entièrement contrôlée : l'écran porte l'état, ce composant ne fait que le rendre.
 */
export function FacturesFiltres({
  criteres, onChange, tiers, labelTiers, nbFiltrees, nbTotal,
}: FacturesFiltresProps) {
  const set = (patch: Partial<CriteresFiltre>) => onChange({ ...criteres, ...patch });
  const actif = aDesFiltres(criteres);

  return (
    <div className="mb-4 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="max-w-xs"
          placeholder={`N° facture, référence, ${labelTiers.toLowerCase()}…`}
          value={criteres.texte ?? ""}
          onChange={(e) => set({ texte: e.target.value })}
        />

        <Select
          value={criteres.statut ?? "toutes"}
          onValueChange={(v) => set({ statut: v as StatutFiltre })}
        >
          <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="toutes">Tous les statuts</SelectItem>
            <SelectItem value="payees">Payées</SelectItem>
            <SelectItem value="partiel">Partiellement payées</SelectItem>
            <SelectItem value="impayees">Impayées</SelectItem>
            <SelectItem value="retard">En retard</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={criteres.tiersId || "__tous__"}
          onValueChange={(v) => set({ tiersId: v === "__tous__" ? "" : v })}
        >
          <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__tous__">Tous les {labelTiers.toLowerCase()}s</SelectItem>
            {tiers.map((t) => (
              <SelectItem key={t.id} value={t.id}>{t.nom}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {actif && (
          <>
            <span className="text-xs text-muted-foreground">
              {nbFiltrees} / {nbTotal} facture{nbTotal > 1 ? "s" : ""}
            </span>
            <Button
              variant="ghost" size="sm" className="h-8 text-xs"
              onClick={() => onChange({ ...CRITERES_VIDES })}
            >
              <X className="h-3 w-3 mr-1" />Réinitialiser
            </Button>
          </>
        )}
      </div>

      {/* Période : le champ visé est explicite — filtrer sur la date de facture ou
          sur l'échéance ne répond pas à la même question comptable. */}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={criteres.champDate ?? "date_facture"}
          onValueChange={(v) => set({ champDate: v as ChampDate })}
        >
          <SelectTrigger className="w-44 h-8 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="date_facture">Date de facture</SelectItem>
            <SelectItem value="date_echeance">Date d'échéance</SelectItem>
          </SelectContent>
        </Select>
        <Label className="text-xs text-muted-foreground">du</Label>
        <Input
          type="date" className="w-40 h-8 text-xs"
          value={criteres.debut ?? ""}
          onChange={(e) => set({ debut: e.target.value })}
        />
        <Label className="text-xs text-muted-foreground">au</Label>
        <Input
          type="date" className="w-40 h-8 text-xs"
          value={criteres.fin ?? ""}
          onChange={(e) => set({ fin: e.target.value })}
        />
      </div>
    </div>
  );
}
