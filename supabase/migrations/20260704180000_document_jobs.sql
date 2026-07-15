-- File d'attente de traitement documentaire (OCR + LLM + mémoire) découplée.
--
-- Chaque upload de document (facture / relevé / justificatif) crée une ligne ici
-- (status='pending') PUIS pousse un job BullMQ. Un worker séparé exécute le
-- traitement, met à jour le statut et stocke le résultat. Idempotence garantie
-- par `idempotency_key` UNIQUE (+ jobId BullMQ = id de cette ligne).

CREATE TABLE IF NOT EXISTS public.document_jobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dossier_id       UUID REFERENCES public.dossiers(id) ON DELETE CASCADE,
  type             TEXT NOT NULL,                       -- 'facture' | 'releve' | 'justificatif'
  bucket           TEXT,                                 -- bucket storage (ex: factures-originales)
  file_path        TEXT,                                 -- chemin dans le bucket (ou null si payload inline)
  payload          JSONB,                                -- entrées préparées (texte, base64, transactions…)
  status           TEXT NOT NULL DEFAULT 'pending',      -- pending | processing | done | failed
  attempts         INTEGER NOT NULL DEFAULT 0,
  result           JSONB,                                -- sortie du traitement (analyses / result OCR)
  error            TEXT,
  idempotency_key  TEXT UNIQUE,                          -- anti double-traitement
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_document_jobs_dossier ON public.document_jobs (dossier_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_document_jobs_status  ON public.document_jobs (status);

ALTER TABLE public.document_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "dj_select" ON public.document_jobs FOR SELECT TO authenticated
  USING (dossier_id IS NULL OR public.has_dossier_access(auth.uid(), dossier_id));
CREATE POLICY "dj_all" ON public.document_jobs FOR ALL TO authenticated
  USING (dossier_id IS NULL OR public.has_dossier_access(auth.uid(), dossier_id))
  WITH CHECK (dossier_id IS NULL OR public.has_dossier_access(auth.uid(), dossier_id));

COMMENT ON TABLE public.document_jobs IS
  'File de traitement documentaire asynchrone (OCR+LLM+mémoire) — statut + résultat par job.';
