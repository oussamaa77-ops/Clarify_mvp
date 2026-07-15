// document-worker.ts — WORKER autonome de la queue "document-processing".
//
//   Lancement :  npm run worker     (→ tsx src/queue/document-worker.ts)
//
//   Pour chaque job : marque 'processing' → OCR+LLM+mémoire (service) → stocke
//   le résultat + statut 'done'. Retries automatiques (BullMQ, max 3), timeout
//   par job, logs start/success/fail, idempotence (skip si déjà 'done').
import "./env"; // charge .env EN PREMIER
import { Worker, type Job } from "bullmq";
import { connection, redisEnabled } from "./connection";
import { DOCUMENT_QUEUE, type DocumentJobData } from "./document-queue";
import { processDocumentJob } from "@/services/document-processing.service";
import { getJob, markJobStatus } from "@/services/job-store";

if (!redisEnabled || !connection) {
  console.error("[worker] REDIS_URL absent — worker non démarré. Configurez REDIS_URL dans .env.");
  process.exit(1);
}

const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS ?? 120_000);
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 4);
const now = () => new Date().toISOString();

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timeout job > ${ms}ms`)), ms)),
  ]);
}

async function processor(job: Job<DocumentJobData>) {
  const d = job.data;
  const attempt = job.attemptsMade + 1;
  console.log(`[worker] START job=${job.id} type=${d.type} dossier=${d.dossier_id} tentative=${attempt}/${job.opts.attempts ?? 1}`);

  // Idempotence : si déjà traité, ne pas refaire.
  const existing = await getJob(d.job_id);
  if (existing?.status === "done") {
    console.log(`[worker] SKIP job=${job.id} (déjà 'done') — idempotent`);
    return existing.result;
  }

  await markJobStatus(d.job_id, { status: "processing", attempts: attempt, started_at: now() });

  const result = await withTimeout(processDocumentJob(d), JOB_TIMEOUT_MS);

  await markJobStatus(d.job_id, { status: "done", result, error: null, finished_at: now() });
  console.log(`[worker] SUCCESS job=${job.id}`);
  return result;
}

const worker = new Worker<DocumentJobData>(DOCUMENT_QUEUE, processor, {
  connection: connection as any, // types ioredis embarqués par BullMQ (cf. document-queue.ts)
  concurrency: CONCURRENCY,
});

worker.on("failed", async (job, err) => {
  const attempt = (job?.attemptsMade ?? 0);
  const max = job?.opts.attempts ?? 1;
  console.error(`[worker] FAIL job=${job?.id} tentative=${attempt}/${max} : ${err.message}`);
  // On ne marque 'failed' que lorsque toutes les tentatives sont épuisées.
  if (job && attempt >= max) {
    await markJobStatus(job.data.job_id, { status: "failed", error: err.message, finished_at: now() });
  }
});

worker.on("completed", (job) => console.log(`[worker] completed job=${job.id}`));
worker.on("error", (e) => console.error("[worker] erreur worker:", e.message));

console.log(`[worker] ✅ à l'écoute de "${DOCUMENT_QUEUE}" (concurrency=${CONCURRENCY}, timeout=${JOB_TIMEOUT_MS}ms)`);

const shutdown = async () => { console.log("[worker] arrêt…"); await worker.close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
