// ============================================================================
// jobs.functions.ts — API de la file de traitement documentaire asynchrone.
//
//   • enqueueDocumentJob : crée la ligne document_jobs (idempotente) puis POUSSE
//     un job BullMQ. Si Redis est absent → FALLBACK INLINE (traitement synchrone)
//     pour que la fonctionnalité marche sans casser l'app.
//   • getJobStatus : lu par le polling frontend (pending|processing|done|failed).
// ============================================================================
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createHash } from "crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { redisEnabled } from "@/queue/connection";
import { enqueueDocument } from "@/queue/document-queue";
import { processDocumentJob } from "@/services/document-processing.service";
import { markJobStatus } from "@/services/job-store";

function getSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    "";
  return createClient(url, key);
}

const now = () => new Date().toISOString();

export const enqueueDocumentJob = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({
      dossier_id: z.string().uuid(),
      type: z.enum(["facture", "releve", "justificatif"]),
      bucket: z.string().nullish(),
      file_path: z.string().nullish(),
      payload: z.any().nullish(),
      // Clé d'idempotence explicite (sinon dérivée du contenu).
      idempotency_key: z.string().nullish(),
    }).parse(input),
  )
  .handler(async ({ data }) => {
    const supabase = getSupabase();

    // Clé d'idempotence : fournie, ou hash (dossier+type+file_path+payload).
    const idem =
      data.idempotency_key ??
      createHash("sha1")
        .update(JSON.stringify({ d: data.dossier_id, t: data.type, f: data.file_path ?? "", p: data.payload ?? null }))
        .digest("hex");

    // Déjà un job non-échoué avec cette clé → on le réutilise (anti double-traitement).
    const { data: existing } = await (supabase.from("document_jobs") as any)
      .select("id,status,result,error").eq("idempotency_key", idem).maybeSingle();
    if (existing && existing.status !== "failed") {
      return { job_id: existing.id, status: existing.status, result: existing.result ?? null, reused: true as const };
    }

    // Création de la ligne (status pending).
    const { data: row, error } = await (supabase.from("document_jobs") as any)
      .insert({
        dossier_id: data.dossier_id, type: data.type,
        bucket: data.bucket ?? null, file_path: data.file_path ?? null,
        payload: data.payload ?? null, idempotency_key: idem, status: "pending",
      })
      .select("id").single();
    // Course : insertion concurrente sur la même clé → on récupère l'existant.
    if (error) {
      const { data: race } = await (supabase.from("document_jobs") as any)
        .select("id,status,result").eq("idempotency_key", idem).maybeSingle();
      if (race) return { job_id: race.id, status: race.status, result: race.result ?? null, reused: true as const };
      // Table absente (migration non appliquée) ou DB indisponible → on NE CASSE PAS
      // le flux : traitement inline SANS persistance de statut.
      console.warn(`[jobs] document_jobs indisponible (${error.message}) → inline sans persistance`);
      try {
        const result = await processDocumentJob({
          job_id: "inline", dossier_id: data.dossier_id, type: data.type,
          bucket: data.bucket ?? null, file_path: data.file_path ?? null, payload: data.payload ?? null,
        });
        return { job_id: "inline", status: "done" as const, result, mode: "inline-nopersist" as const };
      } catch (e: any) {
        return { job_id: "inline", status: "failed" as const, error: String(e?.message ?? e), mode: "inline-nopersist" as const };
      }
    }
    const jobId: string = row.id;

    // ── Mode QUEUE (Redis présent) ────────────────────────────────────────────
    if (redisEnabled) {
      try {
        await enqueueDocument({
          job_id: jobId, dossier_id: data.dossier_id, type: data.type,
          bucket: data.bucket ?? null, file_path: data.file_path ?? null, payload: data.payload ?? null,
        });
        console.log(`[jobs] ENQUEUE job=${jobId} type=${data.type} → queue`);
        return { job_id: jobId, status: "pending" as const, mode: "queue" as const };
      } catch (e: any) {
        await markJobStatus(jobId, { status: "failed", error: `enqueue: ${e?.message ?? e}`, finished_at: now() });
        return { job_id: jobId, status: "failed" as const, error: String(e?.message ?? e), mode: "queue" as const };
      }
    }

    // ── Fallback INLINE (pas de Redis) : traitement synchrone ─────────────────
    console.log(`[jobs] INLINE job=${jobId} type=${data.type} (Redis absent)`);
    try {
      await markJobStatus(jobId, { status: "processing", attempts: 1, started_at: now() });
      const result = await processDocumentJob({
        job_id: jobId, dossier_id: data.dossier_id, type: data.type,
        bucket: data.bucket ?? null, file_path: data.file_path ?? null, payload: data.payload ?? null,
      });
      await markJobStatus(jobId, { status: "done", result, error: null, finished_at: now() });
      return { job_id: jobId, status: "done" as const, result, mode: "inline" as const };
    } catch (e: any) {
      await markJobStatus(jobId, { status: "failed", error: String(e?.message ?? e), finished_at: now() });
      return { job_id: jobId, status: "failed" as const, error: String(e?.message ?? e), mode: "inline" as const };
    }
  });

export const getJobStatus = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ job_id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const { data: row } = await (getSupabase().from("document_jobs") as any)
      .select("id,type,status,result,error,attempts,created_at,finished_at")
      .eq("id", data.job_id).maybeSingle();
    return { job: row ?? null };
  });
