// ============================================================================
// analytics.functions.ts — Logging structuré de l'usage IA / mémoire.
//
//   • logUsage / logUsageBatch : écrit une (ou N) ligne(s) dans analytics_usage.
//     Best-effort : jamais bloquant, jamais d'exception propagée au scan.
//   • estimerCoutIA : coût USD estimé d'un appel IA par pipeline (facture/banque).
//   • agregerUsage (pur, testable) + usageMetrics (server fn) : % skipLLM, nombre
//     d'appels IA évités et coût économisé, agrégés par jour.
// ============================================================================

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// fetch tolérant au proxy TLS d'entreprise : le fetch global de Node échoue
// (`TypeError: fetch failed`) → repli sur undici sans vérif TLS (le proxy présente
// son propre CA). Sans ça, TOUTE requête serveur vers Supabase échoue silencieusement.
let PROXY_DIRECT = false;
async function proxyFetch(input: any, init?: any): Promise<Response> {
  const url = String(input);
  if (PROXY_DIRECT) {
    const { fetch: uf, Agent } = await import("undici");
    const agent = new Agent({ connect: { rejectUnauthorized: false } });
    return (uf as any)(url, { ...init, dispatcher: agent }) as Promise<Response>;
  }
  try {
    return await fetch(url, init);
  } catch (e: any) {
    const cause: string = e?.cause?.code ?? e?.cause?.message ?? e?.message ?? "";
    if (/SELF_SIGNED|CERT_|UNABLE_TO_VERIFY|fetch failed|ECONNRESET|EPROTO/i.test(cause) || /fetch failed/i.test(String(e?.message ?? ""))) {
      PROXY_DIRECT = true;
      const { fetch: uf, Agent } = await import("undici");
      const agent = new Agent({ connect: { rejectUnauthorized: false } });
      return (uf as any)(url, { ...init, dispatcher: agent }) as Promise<Response>;
    }
    throw e;
  }
}

function getSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    "";
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (i: any, init?: any) => proxyFetch(i, init) },
  });
}

// ── Coût IA estimé (USD) d'UN appel, par pipeline ────────────────────────────
// Ordre de grandeur (Mistral large / Groq) : facture = 1 gros appel OCR+sémantique ;
// banque = 1 analyse de transaction (part de prompt mutualisée + ~200 tk sortie).
// Volontairement conservateur — sert à chiffrer l'ÉCONOMIE du skipLLM, pas à
// facturer. Ajustable en un point.
const COUT_IA_USD: Record<string, number> = {
  // Mesuré sur Mistral (facture type) : ~5000 tk in / ~500 tk out sur
  // mistral-large ≈ 0,0033 $, + 0,002 $ d'OCR page si le document est scanné.
  facture: 0.005,
  banque: 0.004,
  releve_ocr: 0.004,   // relecture mistral-large ÉVITÉE quand regex/delta suffit
};
export function estimerCoutIA(sens: string): number {
  return COUT_IA_USD[sens] ?? COUT_IA_USD.banque;
}

// Module déclencheur de l'appel IA (écran / pipeline). Sert à ventiler l'usage.
export type UsageModule = "facture_client" | "facture_fournisseur" | "justificatif" | "releve";
// Étape à laquelle l'IA (ou son économie) intervient.
export type UsagePhase = "ocr" | "analyse";

export type UsageRow = {
  dossier_id: string | null;
  sens: "facture" | "banque";
  method: "llm" | "memoire" | "regex";
  skip_llm: boolean;
  cout_estime: number;
  libelle?: string | null;
  module?: UsageModule | null;
  phase?: UsagePhase | null;
};

// ── Écriture (best-effort) ───────────────────────────────────────────────────
// Résilient à l'absence des colonnes module/phase (migration pas encore appliquée) :
// si l'insert enrichi échoue, on retente sans ces colonnes → le logging n'est JAMAIS
// perdu, on gagne seulement la ventilation par module une fois la migration passée.
export async function logUsageBatch(sb: SupabaseClient, rows: UsageRow[]): Promise<void> {
  if (!rows.length) return;
  const base = rows.map((r) => ({
    dossier_id: r.dossier_id,
    sens: r.sens,
    method: r.method,
    skip_llm: r.skip_llm,
    cout_estime: r.cout_estime,
    libelle: r.libelle ? String(r.libelle).slice(0, 120) : null,
  }));
  const enriched = rows.map((r, i) => ({
    ...base[i],
    module: r.module ?? null,
    phase: r.phase ?? null,
  }));
  try {
    const res = await (sb.from("analytics_usage") as any).insert(enriched);
    if (!res?.error) return;
    // Colonne module/phase absente (PGRST204 / 42703) → repli sans enrichissement.
    const fb = await (sb.from("analytics_usage") as any).insert(base);
    if (fb?.error) {
      console.error("[analytics] insert analytics_usage ÉCHOUÉ (fallback base):", fb.error.message ?? fb.error, "| 1er essai:", res.error.message ?? res.error);
    }
  } catch (e: any) {
    // table absente (migration non appliquée) / réseau → on retente le socle et on LOGGE.
    try {
      const fb = await (sb.from("analytics_usage") as any).insert(base);
      if (fb?.error) console.error("[analytics] insert analytics_usage ÉCHOUÉ:", fb.error.message ?? fb.error);
    } catch (e2: any) {
      console.error("[analytics] insert analytics_usage EXCEPTION:", e2?.message ?? e2, "| initial:", e?.message ?? e);
    }
  }
}

export async function logUsage(sb: SupabaseClient, row: UsageRow): Promise<void> {
  return logUsageBatch(sb, [row]);
}

// ── Agrégation PURE (exportée pour les tests) ────────────────────────────────
export type DayMetric = {
  jour: string;               // YYYY-MM-DD
  total: number;              // traitements
  appels_ia: number;         // method !== 'memoire' effectivement partis au LLM
  ia_evites: number;         // skip_llm = true
  pct_skip: number;          // 0..100
  cout_economise: number;    // USD (somme cout_estime des skip)
  cout_depense: number;      // USD (somme cout_estime des non-skip 'llm')
};

// Métrique ventilée par une clé libre (module ou phase), même forme que DayMetric.
export type GroupMetric = {
  cle: string;                // valeur du module / de la phase (ou 'inconnu')
  total: number;
  appels_ia: number;
  ia_evites: number;
  pct_skip: number;
  cout_economise: number;
  cout_depense: number;
};

export type UsageRowAgg = {
  method: string; skip_llm: boolean; cout_estime: number; created_at: string;
  module?: string | null; phase?: string | null;
};

// Libellés lisibles des modules (pour l'UI et les tests).
export const MODULE_LABELS: Record<string, string> = {
  facture_client: "Factures client",
  facture_fournisseur: "Factures fournisseurs",
  justificatif: "Justificatifs",
  releve: "Relevés bancaires",
  inconnu: "Non ventilé",
};

export function agregerUsage(
  rows: UsageRowAgg[],
): { par_jour: DayMetric[]; global: DayMetric; par_module: GroupMetric[]; par_phase: GroupMetric[] } {
  const byDay = new Map<string, DayMetric>();
  const byModule = new Map<string, GroupMetric>();
  const byPhase = new Map<string, GroupMetric>();
  const blank = (jour: string): DayMetric => ({
    jour, total: 0, appels_ia: 0, ia_evites: 0, pct_skip: 0, cout_economise: 0, cout_depense: 0,
  });
  const blankG = (cle: string): GroupMetric => ({
    cle, total: 0, appels_ia: 0, ia_evites: 0, pct_skip: 0, cout_economise: 0, cout_depense: 0,
  });
  const glob = blank("TOTAL");

  const accumule = (m: { total: number; appels_ia: number; ia_evites: number; cout_economise: number; cout_depense: number }, r: UsageRowAgg, cout: number) => {
    m.total += 1;
    if (r.skip_llm) { m.ia_evites += 1; m.cout_economise += cout; }
    else if (r.method === "llm") { m.appels_ia += 1; m.cout_depense += cout; }
  };

  for (const r of rows) {
    const jour = (r.created_at ?? "").slice(0, 10) || "?";
    const cout = Number(r.cout_estime ?? 0);
    const d = byDay.get(jour) ?? blank(jour);
    const modKey = r.module || "inconnu";
    const phKey = r.phase || "inconnu";
    const gm = byModule.get(modKey) ?? blankG(modKey);
    const gp = byPhase.get(phKey) ?? blankG(phKey);
    for (const m of [d, glob, gm, gp]) accumule(m, r, cout);
    byDay.set(jour, d);
    byModule.set(modKey, gm);
    byPhase.set(phKey, gp);
  }
  const round = (m: any) => {
    m.pct_skip = m.total ? Math.round((m.ia_evites / m.total) * 1000) / 10 : 0;
    m.cout_economise = Math.round(m.cout_economise * 10000) / 10000;
    m.cout_depense = Math.round(m.cout_depense * 10000) / 10000;
    return m;
  };
  const par_jour = [...byDay.values()].map(round).sort((a, b) => b.jour.localeCompare(a.jour));
  const par_module = [...byModule.values()].map(round).sort((a, b) => b.total - a.total);
  const par_phase = [...byPhase.values()].map(round).sort((a, b) => b.total - a.total);
  return { par_jour, global: round(glob), par_module, par_phase };
}

// ── Server function d'agrégation (exposable à l'UI / script) ─────────────────
export const usageMetrics = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({
      dossier_id: z.string().uuid().nullish(),  // null → tous les dossiers accessibles
      days: z.number().int().positive().max(365).default(30),
    }).parse(input),
  )
  .handler(async ({ data }) => {
    const sb = getSupabase();
    const since = new Date(Date.now() - data.days * 86400_000).toISOString();
    // Sélection enrichie (module/phase). Si ces colonnes n'existent pas encore, la
    // requête échoue → on retombe sur la sélection de base (ventilation "inconnu").
    const cols = "method,skip_llm,cout_estime,created_at,module,phase";
    const runQuery = async (select: string) => {
      let q = (sb.from("analytics_usage") as any)
        .select(select)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(50000);
      if (data.dossier_id) q = q.eq("dossier_id", data.dossier_id);
      return q;
    };
    let { data: rows, error } = await runQuery(cols);
    if (error) {
      const fb = await runQuery("method,skip_llm,cout_estime,created_at");
      rows = fb.data; error = fb.error;
    }
    if (error) return { ok: false as const, reason: error.message, par_jour: [], global: null, par_module: [], par_phase: [] };
    return { ok: true as const, ...agregerUsage(rows ?? []) };
  });
