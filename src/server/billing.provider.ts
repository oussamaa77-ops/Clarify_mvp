// ============================================================================
// billing.provider.ts — la couture prévue pour Stripe / CMI.
//
// Aujourd'hui la facturation est MANUELLE : l'utilisateur choisit un plan, on
// l'active, on encaisse hors application (virement, chèque). Demain, brancher
// un PSP ne doit toucher QUE ce fichier :
//
//   1. écrire un objet StripeProvider / CmiProvider qui implémente
//      BillingProvider (créer une session de paiement + traiter le webhook) ;
//   2. le déclarer dans PROVIDERS ci-dessous ;
//   3. poser BILLING_PROVIDER=stripe dans l'environnement.
//
// Le reste de l'app (garde-quota, page abonnement, RPC) ne bouge pas : le
// schéma porte déjà provider / provider_customer_id / provider_subscription_id,
// et le quota ne lit que subscriptions.status + plans.scans_limit — exactement
// ce qu'un webhook viendra écrire.
// ============================================================================
import { getSupabaseAdmin } from "./supabase-admin";

export type CodeProvider = "manual" | "stripe" | "cmi";

export interface DemandeChangementPlan {
  cabinetId: string;
  planCode: string;
  /** URL de retour après paiement (inutilisé en manuel). */
  returnUrl?: string;
}

export interface ResultatChangementPlan {
  /** URL de paiement à ouvrir (PSP), ou null si l'activation est immédiate. */
  checkoutUrl: string | null;
  /** true = plan actif tout de suite (pas de paiement en ligne). */
  activeImmediatement: boolean;
  planCode: string;
  message: string;
}

export interface BillingProvider {
  readonly code: CodeProvider;
  /** Fait passer un cabinet sur un plan (ou renvoie l'URL de paiement du PSP). */
  changerPlan(demande: DemandeChangementPlan): Promise<ResultatChangementPlan>;
}

/**
 * Facturation manuelle : le plan est activé immédiatement en base, le
 * règlement se fait hors application. La période et le compteur de scans ne
 * sont pas réinitialisés (cf. set_subscription_plan) — un changement de plan
 * ne remet pas le quota à zéro.
 */
export const manualProvider: BillingProvider = {
  code: "manual",

  async changerPlan({ cabinetId, planCode }): Promise<ResultatChangementPlan> {
    const { data, error } = await getSupabaseAdmin().rpc("set_subscription_plan", {
      _cabinet_id: cabinetId,
      _plan_code: planCode,
      _status: "active",
    });
    if (error) throw new Error(`Changement de plan impossible : ${error.message}`);

    const res = (data ?? {}) as { ok?: boolean; reason?: string; plan_code?: string };
    if (!res.ok) throw new Error(res.reason === "plan_inconnu" ? "Plan inconnu." : "Changement de plan refusé.");

    return {
      checkoutUrl: null,
      activeImmediatement: true,
      planCode: res.plan_code ?? planCode,
      message: "Plan activé. Le règlement se fait hors application (facturation manuelle).",
    };
  },
};

const PROVIDERS: Partial<Record<CodeProvider, BillingProvider>> = {
  manual: manualProvider,
  // stripe: stripeProvider,   ← à brancher ici, rien d'autre à toucher
  // cmi:    cmiProvider,
};

export function getBillingProvider(): BillingProvider {
  const code = (process.env.BILLING_PROVIDER ?? "manual") as CodeProvider;
  const provider = PROVIDERS[code];
  if (!provider) {
    throw new Error(
      `BILLING_PROVIDER='${code}' n'est pas implémenté. Providers disponibles : ${Object.keys(PROVIDERS).join(", ")}.`,
    );
  }
  return provider;
}
