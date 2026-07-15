// ============================================================================
// billing.functions.ts — API abonnement/quota exposée au front.
//
//   • listPlans        : catalogue tarifaire (public, lecture seule) ;
//   • getQuotaStatus   : consommation du cabinet (résolu depuis un dossier) ;
//   • getBillingOverview : plans + quota, pour la page /abonnement ;
//   • changePlan       : change le plan du cabinet DU CALLEUR (jeton vérifié).
//
// SÉCURITÉ : changePlan ne prend PAS de cabinet_id. Le cabinet est déduit du
// jeton de session vérifié côté serveur — sinon n'importe qui pourrait s'offrir
// un plan Cabinet sur le cabinet d'un tiers.
// ============================================================================
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSupabaseAdmin, resoudreCabinet } from "./supabase-admin";
import { getBillingProvider } from "./billing.provider";
import { statutQuotaCabinet, statutQuotaDossier } from "./billing";
import type { Plan } from "@/lib/quota";

async function chargerPlans(): Promise<Plan[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("plans" as any)
    .select("id,code,name,price_monthly,currency,scans_limit,features")
    .eq("is_active", true)
    .order("sort_order", { ascending: true });

  if (error) {
    console.warn(`[billing] plans illisibles (${error.message}) — migration appliquée ?`);
    return [];
  }
  return (data ?? []).map((p: any) => ({
    ...p,
    price_monthly: Number(p.price_monthly),
    features: Array.isArray(p.features) ? p.features : [],
  })) as Plan[];
}

export const listPlans = createServerFn({ method: "GET" }).handler(async () => ({
  plans: await chargerPlans(),
}));

export const getQuotaStatus = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ dossier_id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => ({ quota: await statutQuotaDossier(data.dossier_id) }));

/** Page /abonnement : tout ce dont elle a besoin en un aller-retour. */
export const getBillingOverview = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(async ({ data }) => {
    const { cabinetId } = await resoudreCabinet(data.access_token);
    const [plans, quota] = await Promise.all([chargerPlans(), statutQuotaCabinet(cabinetId)]);
    return { plans, quota, cabinet_id: cabinetId };
  });

/**
 * Applique le plan choisi PENDANT l'inscription, à la première connexion.
 *
 * À l'inscription, le cabinet n'existe pas encore (il naît avec le profil) et
 * il n'y a pas de session : impossible d'activer un plan à ce moment-là. Le code
 * du plan est donc rangé dans les métadonnées de l'utilisateur (signUp), et on
 * le consomme ici — puis on l'EFFACE, sinon chaque connexion réécraserait un
 * changement de plan fait entre-temps depuis /abonnement.
 *
 * Silencieux et sans effet si aucun plan n'est en attente.
 */
export const activerPlanChoisi = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(async ({ data }) => {
    const sb = getSupabaseAdmin();
    const { data: auth } = await sb.auth.getUser(data.access_token);
    const planCode = (auth?.user?.user_metadata as any)?.plan_code as string | undefined;
    if (!planCode) return { applique: false as const };

    const { cabinetId, userId } = await resoudreCabinet(data.access_token);
    await getBillingProvider().changerPlan({ cabinetId, planCode });

    // Consommé : on retire le code pour que la prochaine connexion n'y touche plus.
    const { error } = await sb.auth.admin.updateUserById(userId, {
      user_metadata: { ...(auth!.user!.user_metadata ?? {}), plan_code: null },
    });
    if (error) console.warn(`[billing] plan_code non effacé (${error.message}) — il sera réappliqué à la prochaine connexion`);

    return { applique: true as const, plan_code: planCode };
  });

export const changePlan = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({
      access_token: z.string().min(1),
      plan_code: z.enum(["starter", "pro", "cabinet"]),
    }).parse(input),
  )
  .handler(async ({ data }) => {
    const { cabinetId, userId } = await resoudreCabinet(data.access_token);
    const resultat = await getBillingProvider().changerPlan({
      cabinetId,
      planCode: data.plan_code,
    });

    // Trace : qui a changé quoi, quand. Best-effort (ne bloque pas le changement).
    await getSupabaseAdmin()
      .from("audit_logs" as any)
      .insert({
        user_id: userId,
        action: "changement_plan",
        ressource_type: "subscriptions",
        details: { cabinet_id: cabinetId, plan_code: resultat.planCode, provider: getBillingProvider().code },
      })
      .then(({ error }) => error && console.warn(`[billing] audit non écrit : ${error.message}`));

    return { ...resultat, quota: await statutQuotaCabinet(cabinetId) };
  });
