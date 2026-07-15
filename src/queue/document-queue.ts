// document-queue.ts — déclaration de la queue "document-processing" + helper d'ajout.
import { Queue } from "bullmq";
import { connection } from "./connection";

export const DOCUMENT_QUEUE = "document-processing";

export interface DocumentJobData {
  job_id: string;               // = document_jobs.id (sert aussi de jobId BullMQ → idempotence)
  dossier_id: string;
  type: "facture" | "releve" | "justificatif";
  bucket?: string | null;
  file_path?: string | null;
  payload?: Record<string, any> | null;
}

// `connection as any` : BullMQ embarque ses propres types ioredis (léger décalage
// de version avec le ioredis racine) — l'instance Redis est bien acceptée à l'exécution.
export const documentQueue = connection
  ? new Queue<DocumentJobData>(DOCUMENT_QUEUE, { connection: connection as any })
  : null;

const MAX_ATTEMPTS = Number(process.env.JOB_MAX_ATTEMPTS ?? 3);

/** Ajoute un job. jobId = job_id → BullMQ dédoublonne (idempotence). */
export async function enqueueDocument(data: DocumentJobData): Promise<void> {
  if (!documentQueue) throw new Error("Redis non configuré (REDIS_URL absent)");
  await documentQueue.add("process", data, {
    jobId: data.job_id,                                   // anti double-traitement
    attempts: MAX_ATTEMPTS,                               // retries automatiques (défaut 3)
    backoff: { type: "exponential", delay: 3000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  });
}
