// ============================================================================
// JaugeQuota — la barre « X / Y scans consommés ce mois ».
//
// Affichée sur /abonnement (gestion du plan) ET dans Usage IA (là où l'on
// regarde ce que l'IA a coûté). Les deux lisent le MÊME état dérivé
// (etatQuota), donc elles ne peuvent pas se contredire.
//
// Rappel produit : seuls les documents réellement partis au LLM décomptent.
// Un document servi par le cache OCR ou la mémoire des tiers est rendu au
// quota côté serveur (release_scan_quota) — d'où la mention sous la barre.
// ============================================================================
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle } from "lucide-react";
import { etatQuota, type QuotaStatus } from "@/lib/quota";

const COULEUR_JAUGE: Record<string, string> = {
  ok: "[&>div]:bg-emerald-500",
  alerte: "[&>div]:bg-amber-500",
  critique: "[&>div]:bg-orange-500",
  epuise: "[&>div]:bg-destructive",
};

export function JaugeQuota({ quota, note }: { quota: QuotaStatus; note?: string }) {
  const etat = etatQuota({ used: quota.used, limit: quota.limit });

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-medium">
          {etat.utilises} {etat.illimite ? "scans ce mois" : `/ ${etat.limite} scans`}
        </span>
        <span className="text-muted-foreground">
          {etat.illimite ? "Illimité" : `${etat.restants} restants`}
        </span>
      </div>

      {!etat.illimite && <Progress value={etat.pourcentage} className={COULEUR_JAUGE[etat.niveau]} />}

      {etat.niveau === "alerte" && (
        <p className="text-sm text-amber-600">Vous avez consommé {etat.pourcentage}% de votre quota mensuel.</p>
      )}
      {etat.epuise && (
        <p className="text-sm text-destructive flex items-center gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          Les scans sont bloqués jusqu'au renouvellement. Passez à un plan supérieur pour reprendre immédiatement.
        </p>
      )}
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

/** Badge du plan + statut, pour les en-têtes. */
export function BadgePlan({ quota }: { quota: QuotaStatus }) {
  if (!quota.has_subscription) return <Badge variant="outline">Aucun abonnement</Badge>;
  return (
    <div className="flex items-center gap-1.5">
      <Badge variant="secondary">Plan {quota.plan?.name}</Badge>
      {quota.status === "trial" && <Badge variant="outline">Essai</Badge>}
      {quota.status === "past_due" && <Badge variant="destructive">Impayé</Badge>}
    </div>
  );
}
