// ============================================================================
// billing.ts — le garde-quota serveur.
//
// UN SEUL point d'entrée : guardScan(). Appelé au sommet de chaque scan
// facturable (ocrFacture, ocrReleve), il consomme un scan ou lève
// QuotaExceededError. Tout le reste de l'app ignore l'existence des quotas.
//
// L'arbitrage vit en base (RPC consume_scan_quota, atomique sous verrou) :
// deux scans concurrents ne peuvent pas passer ensemble le dernier crédit.
// Ce module ne fait que l'appeler et traduire sa réponse.
//
// POLITIQUE DE PANNE (importante) :
//   • refus explicite du RPC        → on BLOQUE (c'est le métier) ;
//   • migration non appliquée / DB  → on LAISSE PASSER en journalisant, pour
//     ne pas transformer un incident d'infra en panne totale du produit.
//     QUOTA_STRICT=true inverse ce choix (bloquer en cas de panne) : à activer
//     le jour où la facturation devient contraignante.
// ============================================================================
import { createHash } from "crypto";
import { getSupabaseAdmin } from "./supabase-admin";
import { messageRefus, type RaisonRefus, type QuotaStatus } from "@/lib/quota";

export type KindScan = "facture" | "releve" | "justificatif";

export interface DecisionQuota {
  allowed: boolean;
  reason?: RaisonRefus | string;
  /** true = clé d'idempotence déjà vue : rien n'a été décompté. */
  replay?: boolean;
  used?: number;
  limit?: number;
  remaining?: number;
  period_start?: string;
  period_end?: string;
  plan_code?: string;
  status?: string;
  /** true = quota non évalué (schéma absent / DB injoignable) et laissé passer. */
  degraded?: boolean;
}

export class QuotaExceededError extends Error {
  readonly code = "QUOTA_EXCEEDED";
  constructor(readonly decision: DecisionQuota) {
    super(messageRefus(decision.reason, { limite: decision.limit, plan: decision.plan_code }));
    this.name = "QuotaExceededError";
  }
}

const strict = () => process.env.QUOTA_STRICT === "true";

/** Le schéma de quota est-il absent (migration pas encore appliquée) ? */
function schemaAbsent(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const code = error.code ?? "";
  const msg = error.message ?? "";
  // PGRST202 : fonction introuvable ; 42883/42P01 : fonction/table inexistante.
  return code === "PGRST202" || code === "42883" || code === "42P01"
    || (/consume_scan_quota|usage_records|subscriptions/i.test(msg) && /does not exist|not find/i.test(msg));
}

/**
 * Clé d'idempotence d'un scan : (dossier, type, empreinte du contenu).
 * Le même document rejoué — retry BullMQ, double-clic, re-scan après cache OCR —
 * retombe sur la même clé et ne consomme donc PAS un second crédit.
 */
export function cleScan(input: { dossier_id: string; kind: KindScan; contenu: string }): string {
  const empreinte = createHash("sha1").update(input.contenu ?? "").digest("hex");
  return `scan:${input.kind}:${input.dossier_id}:${empreinte}`;
}

/** Consomme un scan. Ne lève jamais : renvoie la décision. */
export async function consommerScan(input: {
  dossier_id: string;
  kind: KindScan;
  idempotency_key: string;
  quantity?: number;
}): Promise<DecisionQuota> {
  try {
    const { data, error } = await getSupabaseAdmin().rpc("consume_scan_quota", {
      _dossier_id: input.dossier_id,
      _kind: input.kind,
      _idempotency_key: input.idempotency_key,
      _quantity: input.quantity ?? 1,
    });

    if (error) {
      if (schemaAbsent(error)) {
        console.warn(`[quota] schéma non migré (${error.code ?? ""} ${error.message}) → scan laissé passer`);
        return { allowed: !strict(), degraded: true, reason: "schema_absent" };
      }
      console.error(`[quota] RPC en échec (${error.code ?? ""} ${error.message}) → ${strict() ? "BLOQUÉ" : "laissé passer"}`);
      return { allowed: !strict(), degraded: true, reason: "erreur_quota" };
    }

    return (data ?? { allowed: true, degraded: true }) as DecisionQuota;
  } catch (e: any) {
    console.error(`[quota] injoignable (${e?.message ?? e}) → ${strict() ? "BLOQUÉ" : "laissé passer"}`);
    return { allowed: !strict(), degraded: true, reason: "erreur_quota" };
  }
}

/**
 * Garde-fou des scans : consomme un crédit ou lève QuotaExceededError.
 * À appeler AVANT tout appel OCR/LLM — sinon on paie l'IA d'un scan refusé.
 */
export async function guardScan(input: {
  dossier_id: string;
  kind: KindScan;
  contenu: string;
  quantity?: number;
}): Promise<DecisionQuota> {
  const decision = await consommerScan({
    dossier_id: input.dossier_id,
    kind: input.kind,
    idempotency_key: cleScan(input),
    quantity: input.quantity,
  });

  if (!decision.allowed) throw new QuotaExceededError(decision);

  if (!decision.degraded && !decision.replay) {
    console.log(`[quota] ${input.kind} dossier=${input.dossier_id} → ${decision.used}/${decision.limit} (plan ${decision.plan_code})`);
  }
  return decision;
}

/**
 * Rend un scan qui n'a déclenché AUCUN appel IA (servi par le cache OCR ou par
 * la mémoire des tiers) : un document gratuit ne doit pas décompter le quota.
 *
 * À n'appeler QUE si guardScan a réellement consommé un crédit sur cet appel
 * (decision.replay === false) : sur un rejeu, le crédit appartient au scan
 * d'origine — celui-là, lui, a bien payé l'IA, et le rendre serait un cadeau.
 *
 * Best-effort : un échec laisse le scan décompté (on ne casse jamais un scan
 * réussi pour une histoire de compteur).
 */
export async function libererScan(input: {
  dossier_id: string;
  kind: KindScan;
  contenu: string;
}): Promise<boolean> {
  try {
    const { data, error } = await getSupabaseAdmin().rpc("release_scan_quota", {
      _idempotency_key: cleScan(input),
    });
    if (error) {
      console.warn(`[quota] scan non rendu (${error.code ?? ""} ${error.message}) — migration release_scan_quota appliquée ?`);
      return false;
    }
    const rendu = Boolean((data as any)?.released);
    if (rendu) console.log(`[quota] ${input.kind} sans appel IA → scan rendu (dossier=${input.dossier_id})`);
    return rendu;
  } catch (e: any) {
    console.warn(`[quota] scan non rendu (${e?.message ?? e})`);
    return false;
  }
}

/** État du quota d'un cabinet, sans consommer. */
export async function statutQuotaCabinet(cabinetId: string): Promise<QuotaStatus> {
  const { data, error } = await getSupabaseAdmin().rpc("get_quota_status", { _cabinet_id: cabinetId });
  if (error) {
    if (schemaAbsent(error)) return { has_subscription: false, reason: "schema_absent" };
    throw new Error(error.message);
  }
  return data as QuotaStatus;
}

/** État du quota vu depuis un dossier (le cabinet est déduit du dossier). */
export async function statutQuotaDossier(dossierId: string): Promise<QuotaStatus> {
  const sb = getSupabaseAdmin();
  const { data: dossier } = await sb
    .from("dossiers" as any)
    .select("cabinet_id")
    .eq("id", dossierId)
    .maybeSingle();

  const cabinetId = (dossier as any)?.cabinet_id as string | undefined;
  if (!cabinetId) return { has_subscription: false, reason: "dossier_introuvable" };
  return statutQuotaCabinet(cabinetId);
}
