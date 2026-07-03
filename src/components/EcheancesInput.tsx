import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, Trash2, CalendarClock, AlertTriangle, CheckCircle2 } from "lucide-react";

// ─── Types ──────────────────────────────────────────────────────────────────
// Format attendu par le backend FastAPI /api/reconciliation/partial-payments
export interface Echeance {
  montant_attendu: number;   // MAD, 2 décimales
  date_echeance: string;     // "YYYY-MM-DD"
}

const fmtMad = (n: number) =>
  Number(n || 0).toLocaleString("fr-MA", { minimumFractionDigits: 2 }) + " MAD";

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

// ─── Helper payload ─────────────────────────────────────────────────────────
// À appeler au moment de la soumission (création / validation manuelle).
// - Si aucune tranche saisie → renvoie [] (paiement non fractionné).
// - Sinon → tableau nettoyé { montant_attendu, date_echeance } trié par date.
// Les tranches incomplètes (montant nul OU date vide) sont ignorées.
export function buildEcheancesPayload(echeances: Echeance[]): Echeance[] {
  return echeances
    .filter((e) => e.date_echeance && Number(e.montant_attendu) > 0)
    .map((e) => ({
      montant_attendu: round2(e.montant_attendu),
      date_echeance: e.date_echeance,
    }))
    .sort((a, b) => a.date_echeance.localeCompare(b.date_echeance));
}

// ─── Props ──────────────────────────────────────────────────────────────────
interface EcheancesInputProps {
  echeances: Echeance[];
  onChange: (echeances: Echeance[]) => void;
  /** Montant total TTC de la facture — sert au contrôle de cohérence. */
  montantTtc: number;
  className?: string;
}

// ─── Composant ──────────────────────────────────────────────────────────────
export function EcheancesInput({ echeances, onChange, montantTtc, className }: EcheancesInputProps) {
  const total = round2(echeances.reduce((s, e) => s + (Number(e.montant_attendu) || 0), 0));
  const ttc = round2(montantTtc);
  const reste = round2(ttc - total);
  const depasse = total - ttc > 0.01; // tolérance d'arrondi

  const addTranche = () => {
    // Pré-remplit la nouvelle tranche avec le reste dû + échéance à +30j
    const d = new Date();
    d.setDate(d.getDate() + 30 * (echeances.length + 1));
    onChange([
      ...echeances,
      {
        montant_attendu: reste > 0 ? reste : 0,
        date_echeance: d.toISOString().slice(0, 10),
      },
    ]);
  };

  const updateTranche = (i: number, field: keyof Echeance, value: string) => {
    onChange(
      echeances.map((e, j) =>
        j === i
          ? { ...e, [field]: field === "montant_attendu" ? (parseFloat(value) || 0) : value }
          : e,
      ),
    );
  };

  const removeTranche = (i: number) => onChange(echeances.filter((_, j) => j !== i));

  return (
    <div
      data-testid="echeances-input"
      className={`rounded-lg border border-slate-200 dark:border-slate-700 ${className ?? ""}`}
    >
      {/* En-tête */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b bg-slate-50 dark:bg-slate-800/40 rounded-t-lg">
        <div className="flex items-center gap-2">
          <CalendarClock className="h-4 w-4 text-slate-500" />
          <Label className="text-sm font-semibold">Modalités de paiement</Label>
          {echeances.length > 0 && (
            <span className="text-[11px] text-muted-foreground">
              {echeances.length} tranche{echeances.length > 1 ? "s" : ""}
            </span>
          )}
        </div>
        <Button type="button" variant="outline" size="sm" className="h-7" onClick={addTranche}>
          <Plus className="h-3 w-3 mr-1" />
          Ajouter une tranche de paiement
        </Button>
      </div>

      {/* Liste des tranches */}
      <div className="p-3 space-y-2">
        {echeances.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-3">
            Aucune échéance — le paiement sera considéré comme non fractionné (montant total TTC).
          </p>
        ) : (
          <>
            {/* En-têtes de colonnes */}
            <div className="hidden sm:grid grid-cols-12 gap-2 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              <span className="col-span-1 text-center">#</span>
              <span className="col-span-5">Montant attendu (MAD)</span>
              <span className="col-span-5">Date d'échéance</span>
              <span className="col-span-1"></span>
            </div>
            {echeances.map((e, i) => (
              <div key={i} data-testid="echeance-row" className="grid grid-cols-12 gap-2 items-center">
                <span className="col-span-1 text-center text-xs font-mono text-muted-foreground">
                  {i + 1}
                </span>
                <Input
                  data-testid="echeance-montant"
                  className="col-span-5 text-sm font-mono"
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="0.00"
                  value={e.montant_attendu || ""}
                  onChange={(ev) => updateTranche(i, "montant_attendu", ev.target.value)}
                />
                <Input
                  data-testid="echeance-date"
                  className="col-span-5 text-sm"
                  type="date"
                  value={e.date_echeance}
                  onChange={(ev) => updateTranche(i, "date_echeance", ev.target.value)}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="col-span-1 h-8 w-8 text-red-500 hover:text-red-700 hover:bg-red-50"
                  onClick={() => removeTranche(i)}
                  title="Retirer la tranche"
                  data-testid="echeance-remove"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </>
        )}
      </div>

      {/* Récapitulatif + validation temps réel */}
      {echeances.length > 0 && (
        <div
          data-testid="echeances-recap"
          data-overflow={depasse ? "true" : "false"}
          className={`flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-t text-xs rounded-b-lg ${
            depasse
              ? "bg-red-50 dark:bg-red-950/20 text-red-700 dark:text-red-400"
              : "bg-slate-50 dark:bg-slate-800/40 text-slate-600 dark:text-slate-300"
          }`}
        >
          <div className="flex items-center gap-1.5">
            {depasse ? (
              <AlertTriangle className="h-3.5 w-3.5" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
            )}
            <span>
              Total tranches : <strong className="font-mono">{fmtMad(total)}</strong> / TTC{" "}
              <span className="font-mono">{fmtMad(ttc)}</span>
            </span>
          </div>
          <span data-testid="echeances-status" className={depasse ? "font-semibold" : "text-muted-foreground"}>
            {depasse
              ? `⚠️ Dépassement de ${fmtMad(total - ttc)}`
              : reste > 0.01
                ? `Reste à répartir : ${fmtMad(reste)}`
                : "✅ Réparti intégralement"}
          </span>
        </div>
      )}
    </div>
  );
}
