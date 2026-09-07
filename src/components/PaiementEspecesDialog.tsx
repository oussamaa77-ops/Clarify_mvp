// ============================================================================
// PaiementEspecesDialog — saisie d'un règlement au comptant depuis la colonne
// « Actions » des tableaux de factures (clients ET fournisseurs).
//
// Pourquoi une boîte de dialogue plutôt qu'un clic direct : le bouton soldait
// AUTOMATIQUEMENT la facture à la date du jour. Or un règlement de guichet est
// très souvent PARTIEL (acompte espèces) et rarement saisi le jour même. Le
// montant exact et la date sont donc demandés, puis renvoyés au serveur qui
// enregistre un paiement de ce montant : le trigger recalcule montant_paye /
// montant_restant, les deux colonnes que le tableau relit ensuite.
// ============================================================================

import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { marquerPayee } from "@/server/factures.functions";
import { validerDateReglement } from "@/lib/date-reglement";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Banknote, Loader2 } from "lucide-react";
import { toast } from "sonner";

/** Le strict nécessaire : les deux tableaux ont des types de facture distincts. */
export interface FacturePayable {
  id: string;
  numero: string | null;
  montant_ttc: number;
  montant_paye?: number | null;
  montant_restant?: number | null;
  /** Émission — borne basse de la date de règlement (cf. validerDateReglement). */
  date_facture?: string | null;
}

const fmt = (n: number) =>
  Number(n).toLocaleString("fr-MA", { minimumFractionDigits: 2 }) + " MAD";
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Reste dû = TTC − déjà payé, EXACTEMENT le calcul du serveur. On ne lit pas
 * `montant_restant` : cette colonne dérivée vaut 0 sur les factures antérieures
 * au trigger de recalcul, et le dialogue refuserait alors tout paiement (« reste
 * dû 0 ») sur une facture pourtant impayée. `montant_paye`, lui, est l'accumulateur
 * de référence. Repli sur montant_restant seulement s'il n'y a pas de montant_paye.
 */
export const resteDu = (f: FacturePayable) =>
  Math.max(0, r2(f.montant_paye == null && f.montant_restant != null
    ? Number(f.montant_restant)
    : Number(f.montant_ttc) - Number(f.montant_paye ?? 0)));

export function PaiementEspecesDialog({
  facture, type, onClose, onDone,
}: {
  /** `null` ferme la boîte : l'appelant n'a qu'un état à piloter. */
  facture: FacturePayable | null;
  type: "client" | "fournisseur";
  onClose: () => void;
  /** Rappelé après un règlement accepté — l'appelant recharge son tableau. */
  onDone: () => void;
}) {
  const payFn = useServerFn(marquerPayee);
  const [montant, setMontant] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);

  const solde = facture ? resteDu(facture) : 0;

  // Pré-remplissage à l'ouverture : le cas courant reste le solde intégral au
  // jour même — l'utilisateur n'a qu'à valider, ou corriger l'un des deux champs.
  useEffect(() => {
    if (!facture) return;
    setMontant(String(resteDu(facture)));
    setDate(new Date().toISOString().slice(0, 10));
  }, [facture?.id]);

  const valeur = Number(montant.replace(",", "."));
  // Même règle que la server function, appelée depuis la même fonction pure :
  // le bouton refuse ce que l'API refuserait, au lieu de laisser l'utilisateur
  // découvrir l'erreur après coup dans un toast.
  const validiteDate = validerDateReglement(facture?.date_facture ?? null, date);
  const erreur =
    !montant.trim() || !Number.isFinite(valeur) ? "Saisissez un montant"
    : valeur <= 0 ? "Le montant doit être supérieur à 0"
    // Tolérance d'un centime, comme côté serveur : un arrondi ne doit pas bloquer.
    : valeur - solde > 0.01 ? `Maximum ${fmt(solde)} (reste dû)`
    : !validiteDate.ok ? validiteDate.message
    : null;

  const handleSubmit = async () => {
    if (!facture || erreur) return;
    setSaving(true);
    try {
      const res: any = await payFn({ data: {
        facture_id: facture.id, date_paiement: date, mode: "especes",
        type, montant: r2(valeur),
      }});
      // `res` peut être vide si le runtime ne propage pas le retour : on retombe
      // alors sur le calcul local plutôt que d'afficher « NaN ».
      const restant = Number(res?.restant ?? r2(solde - valeur));
      toast.success(restant <= 1
        ? `Facture soldée — ${fmt(r2(valeur))} en espèces`
        : `Règlement partiel de ${fmt(r2(valeur))} — reste ${fmt(restant)}`);

      // Le lettrage et la TVA sont la seconde moitié du travail : les taire
      // laisserait croire qu'un règlement se limite à l'écriture de caisse.
      const c = res?.compta;
      if (c?.lettre && c.code) {
        toast.success(`Lettré ${c.code}${c.tvaBasculee > 0 ? ` — TVA exigible ${fmt(c.tvaBasculee)}` : ""}`);
      } else if (c?.tvaBasculee > 0) {
        toast.info(`TVA exigible sur encaissement : ${fmt(c.tvaBasculee)}`);
      } else if (c?.raison) {
        toast.warning(`Lettrage non effectué : ${c.raison}`);
      }
      onClose();
      onDone();
    } catch (e: any) {
      toast.error(e?.message ?? "Règlement impossible");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!facture} onOpenChange={(v) => { if (!v && !saving) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Banknote className="h-4 w-4" />
            {type === "client" ? "Encaissement en espèces" : "Règlement en espèces"}
          </DialogTitle>
          <DialogDescription>
            Facture <span className="font-mono">{facture?.numero ?? facture?.id.slice(0, 8)}</span> —
            écriture passée au journal de caisse (CAI / 51610000).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 rounded-lg bg-muted/50 p-3 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">Montant TTC</p>
              <p className="font-mono font-medium">{fmt(Number(facture?.montant_ttc ?? 0))}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Reste dû</p>
              <p className="font-mono font-medium text-orange-600">{fmt(solde)}</p>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="paie-montant">Montant payé</Label>
            <Input
              id="paie-montant" type="number" step="0.01" min="0" max={solde}
              value={montant} onChange={(e) => setMontant(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
              autoFocus
            />
            {/* Raccourci du cas courant : solder sans retaper le chiffre. */}
            <button type="button" className="text-xs text-primary hover:underline"
              onClick={() => setMontant(String(solde))}>
              Solder la facture ({fmt(solde)})
            </button>
          </div>

          <div className="space-y-2">
            <Label htmlFor="paie-date">
              Date de règlement <span className="text-destructive">*</span>
            </Label>
            {/* `min` / `max` bornent directement le sélecteur natif : l'émission
                d'un côté, aujourd'hui de l'autre. C'est la même règle que
                `validerDateReglement`, rendue au clavier ET à la souris. */}
            <Input id="paie-date" type="date" value={date} required
              min={facture?.date_facture?.slice(0, 10) || undefined}
              max={new Date().toISOString().slice(0, 10)}
              onChange={(e) => setDate(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }} />
            {/* Cette date n'est pas décorative : elle date l'écriture de
                trésorerie, l'OD de bascule de TVA et le relevé DGI. Un
                encaissement du 28 juin saisi le 3 juillet appartient à la
                déclaration de JUIN. */}
            <p className="text-xs text-muted-foreground">
              Jour où l'argent a été reçu — datera l'écriture de caisse, la TVA
              exigible et le relevé DGI.
            </p>
          </div>

          {erreur && montant.trim() !== "" && (
            <p className="text-xs text-destructive">{erreur}</p>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>Annuler</Button>
          <Button onClick={handleSubmit} disabled={!!erreur || saving}>
            {saving
              ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              : <Banknote className="h-4 w-4 mr-2" />}
            Valider le paiement
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
