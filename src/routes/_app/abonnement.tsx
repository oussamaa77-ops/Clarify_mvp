// ============================================================================
// /abonnement — plan du cabinet, consommation de scans, changement de plan.
//
// Pas de paiement en ligne : le changement de plan est immédiat et le règlement
// se fait hors application (cf. billing.provider.ts). Le jour où Stripe/CMI est
// branché, le provider renverra une checkoutUrl et cette page redirigera —
// aucun autre changement ici.
// ============================================================================
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { getBillingOverview, changePlan } from "@/server/billing.functions";
import { etatQuota, formatPrix, type Plan, type QuotaStatus } from "@/lib/quota";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { JaugeQuota } from "@/components/JaugeQuota";
import { PlansTarifaires } from "@/components/PlansTarifaires";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_app/abonnement")({ component: AbonnementPage });

function AbonnementPage() {
  const { session } = useAuth();
  const token = session?.access_token;

  const [plans, setPlans] = useState<Plan[]>([]);
  const [quota, setQuota] = useState<QuotaStatus | null>(null);
  const [chargement, setChargement] = useState(true);
  const [enCours, setEnCours] = useState<string | null>(null);

  const charger = async (accessToken: string) => {
    try {
      const res = await getBillingOverview({ data: { access_token: accessToken } });
      setPlans(res.plans as Plan[]);
      setQuota(res.quota as QuotaStatus);
    } catch (e: any) {
      toast.error(e.message ?? "Abonnement illisible");
    } finally {
      setChargement(false);
    }
  };

  useEffect(() => {
    if (token) charger(token);
  }, [token]);

  const choisirPlan = async (code: string) => {
    if (!token) return;
    setEnCours(code);
    try {
      const res = await changePlan({ data: { access_token: token, plan_code: code as any } });
      // Prêt pour le PSP : si un jour le provider renvoie une URL, on y va.
      if (res.checkoutUrl) {
        window.location.href = res.checkoutUrl;
        return;
      }
      setQuota(res.quota as QuotaStatus);
      toast.success(res.message);
    } catch (e: any) {
      toast.error(e.message ?? "Changement de plan impossible");
    } finally {
      setEnCours(null);
    }
  };

  if (chargement) {
    return <div className="p-8 text-muted-foreground">Chargement de l'abonnement…</div>;
  }

  const planActuel = quota?.plan?.code;
  const etat = etatQuota({ used: quota?.used, limit: quota?.limit });
  const enEssai = quota?.status === "trial";

  return (
    <div className="p-8 space-y-8 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold">Abonnement</h1>
        <p className="text-muted-foreground">Votre plan, votre consommation de scans et les offres disponibles.</p>
      </div>

      {/* ── Consommation du mois ─────────────────────────────────────────── */}
      {quota?.has_subscription ? (
        <Card>
          <CardHeader className="flex flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2">
                Plan {quota.plan?.name}
                {enEssai && <Badge variant="secondary">Essai</Badge>}
                {quota.status === "past_due" && <Badge variant="destructive">Impayé</Badge>}
              </CardTitle>
              <CardDescription>
                {quota.plan && formatPrix(quota.plan.price_monthly, quota.plan.currency)}
                {quota.period_end && ` · période en cours jusqu'au ${new Date(quota.period_end).toLocaleDateString("fr-FR")}`}
              </CardDescription>
            </div>
            {etat.epuise && (
              <Badge variant="destructive" className="gap-1">
                <AlertTriangle className="h-3 w-3" /> Quota atteint
              </Badge>
            )}
          </CardHeader>

          <CardContent>
            <JaugeQuota
              quota={quota}
              note="Un document servi par le cache ou la mémoire des tiers ne consomme pas de scan."
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="py-6 text-muted-foreground">
            Aucun abonnement actif sur ce cabinet. Choisissez un plan ci-dessous pour commencer.
          </CardContent>
        </Card>
      )}

      {/* ── Catalogue ────────────────────────────────────────────────────── */}
      <PlansTarifaires plans={plans} planActuel={planActuel} enCours={enCours} onChoisir={choisirPlan} />

      <p className="text-xs text-muted-foreground">
        Le paiement en ligne n'est pas encore actif : le plan choisi est activé immédiatement et le règlement se fait
        hors application. Un changement de plan ne réinitialise ni la période en cours ni les scans déjà consommés.
      </p>
    </div>
  );
}
