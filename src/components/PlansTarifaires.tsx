// ============================================================================
// PlansTarifaires — le catalogue des 3 offres, en cartes.
//
// Une seule définition, deux usages : le choix du plan à l'INSCRIPTION (/auth,
// aucun cabinet n'existe encore) et le changement de plan depuis /abonnement
// (un plan est alors déjà actif). D'où `planActuel`, absent à l'inscription.
// ============================================================================
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Check, Zap } from "lucide-react";
import type { Plan } from "@/lib/quota";

const PLAN_RECOMMANDE = "pro";

export function PlansTarifaires({
  plans,
  planActuel,
  enCours,
  onChoisir,
  libelleCta = "Choisir ce plan",
}: {
  plans: Plan[];
  /** Code du plan actif — non fourni à l'inscription. */
  planActuel?: string;
  /** Code du plan en cours d'activation (bouton en attente). */
  enCours: string | null;
  onChoisir: (code: string) => void;
  libelleCta?: string;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {plans.map((plan) => {
        const actuel = plan.code === planActuel;
        const recommande = plan.code === PLAN_RECOMMANDE;
        return (
          <Card key={plan.id} className={recommande && !actuel ? "border-primary shadow-sm" : undefined}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>{plan.name}</CardTitle>
                {actuel && <Badge>Plan actuel</Badge>}
                {!actuel && recommande && (
                  <Badge variant="secondary" className="gap-1"><Zap className="h-3 w-3" /> Populaire</Badge>
                )}
              </div>
              <CardDescription>
                <span className="text-2xl font-bold text-foreground">
                  {new Intl.NumberFormat("fr-MA").format(plan.price_monthly)}
                </span>{" "}
                {plan.currency} / mois
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-4">
              <p className="text-sm font-medium">
                {plan.scans_limit < 0 ? "Scans illimités" : `${plan.scans_limit} scans / mois`}
              </p>
              <ul className="space-y-1.5 text-sm text-muted-foreground">
                {plan.features.map((f) => (
                  <li key={f} className="flex gap-2">
                    <Check className="h-4 w-4 shrink-0 text-emerald-500" /> {f}
                  </li>
                ))}
              </ul>
              <Button
                className="w-full"
                variant={actuel ? "outline" : recommande ? "default" : "secondary"}
                disabled={actuel || enCours !== null}
                onClick={() => onChoisir(plan.code)}
              >
                {actuel ? "Plan actuel" : enCours === plan.code ? "Activation…" : libelleCta}
              </Button>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
