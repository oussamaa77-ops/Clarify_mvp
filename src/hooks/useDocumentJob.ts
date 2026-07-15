// useDocumentJob.ts — enqueue d'un traitement documentaire + suivi du statut.
//
//   • runDocumentJob(input)  : helper impératif (enqueue → polling → résultat).
//   • useDocumentJob()       : hook React exposant { status, result, error, enqueue }.
//
// En mode INLINE (pas de Redis) enqueueDocumentJob renvoie déjà status='done' :
// pas de polling. En mode QUEUE, on interroge getJobStatus toutes les 1,5 s.
import { useCallback, useRef, useState } from "react";
import { enqueueDocumentJob, getJobStatus } from "@/server/jobs.functions";

export type JobStatus = "idle" | "pending" | "processing" | "done" | "failed";

export interface EnqueueInput {
  dossier_id: string;
  type: "facture" | "releve" | "justificatif";
  bucket?: string | null;
  file_path?: string | null;
  payload?: Record<string, any> | null;
  idempotency_key?: string | null;
}

const POLL_MS = 1500;
const MAX_POLLS = 400; // garde-fou ~10 min

export async function runDocumentJob(
  input: EnqueueInput,
  onStatus?: (s: JobStatus) => void,
): Promise<{ job_id: string; status: JobStatus; result: any; error?: string }> {
  onStatus?.("pending");
  const res: any = await enqueueDocumentJob({ data: input });
  const jobId: string = res.job_id;

  if (res.status === "done") { onStatus?.("done"); return { job_id: jobId, status: "done", result: res.result ?? null }; }
  if (res.status === "failed") { onStatus?.("failed"); return { job_id: jobId, status: "failed", result: null, error: res.error }; }

  // Mode QUEUE → polling.
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const { job }: any = await getJobStatus({ data: { job_id: jobId } });
    if (!job) continue;
    if (job.status === "done") { onStatus?.("done"); return { job_id: jobId, status: "done", result: job.result ?? null }; }
    if (job.status === "failed") { onStatus?.("failed"); return { job_id: jobId, status: "failed", result: null, error: job.error }; }
    onStatus?.(job.status as JobStatus);
  }
  return { job_id: jobId, status: "processing", result: null, error: "Délai de suivi dépassé" };
}

export function useDocumentJob() {
  const [status, setStatus] = useState<JobStatus>("idle");
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const running = useRef(false);

  const enqueue = useCallback(async (input: EnqueueInput) => {
    if (running.current) return null;
    running.current = true;
    setStatus("pending"); setError(null); setResult(null);
    try {
      const out = await runDocumentJob(input, setStatus);
      setJobId(out.job_id); setResult(out.result);
      if (out.status === "failed") setError(out.error ?? "Échec du traitement");
      return out;
    } finally {
      running.current = false;
    }
  }, []);

  return { status, result, error, jobId, enqueue };
}
