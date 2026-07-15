// job-store.ts — accès à la table document_jobs (partagé worker + server fns).
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function sb(): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    "";
  return createClient(url, key);
}

export type JobStatus = "pending" | "processing" | "done" | "failed";

export interface DocumentJobRow {
  id: string;
  dossier_id: string | null;
  type: string;
  bucket: string | null;
  file_path: string | null;
  payload: any;
  status: JobStatus;
  attempts: number;
  result: any;
  error: string | null;
  idempotency_key: string | null;
}

export async function getJob(id: string): Promise<DocumentJobRow | null> {
  const { data } = await (sb().from("document_jobs") as any).select("*").eq("id", id).maybeSingle();
  return (data as DocumentJobRow) ?? null;
}

export async function markJobStatus(
  id: string,
  patch: Partial<{ status: JobStatus; attempts: number; result: any; error: string | null; started_at: string; finished_at: string }>,
): Promise<void> {
  await (sb().from("document_jobs") as any)
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
}
