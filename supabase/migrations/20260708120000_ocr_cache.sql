-- Cache OCR au niveau document : réutilisation du résultat d'extraction quand le
-- MÊME document est rescanné (même fichier ou re-saisie identique) → le LLM est
-- court-circuité (skip_llm = true, méthode = "cache" côté usage IA).
--
--   • input_hash : empreinte stable du contenu (texte OCR normalisé, sinon octets
--                  image). Deux scans identiques → même hash → cache-hit.
--   • result     : payload OCR complet (champs sémantiques) réinjecté tel quel.
-- Unicité (dossier_id, input_hash) → upsert idempotent côté serveur.

CREATE TABLE IF NOT EXISTS public.ocr_cache (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dossier_id   UUID REFERENCES public.dossiers(id) ON DELETE CASCADE,
  input_hash   TEXT NOT NULL,
  result       JSONB NOT NULL,
  method       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dossier_id, input_hash)
);

CREATE INDEX IF NOT EXISTS idx_ocr_cache_lookup
  ON public.ocr_cache (dossier_id, input_hash);

ALTER TABLE public.ocr_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ocr_cache_select" ON public.ocr_cache FOR SELECT TO authenticated
  USING (dossier_id IS NULL OR public.has_dossier_access(auth.uid(), dossier_id));
CREATE POLICY "ocr_cache_insert" ON public.ocr_cache FOR INSERT TO authenticated
  WITH CHECK (dossier_id IS NULL OR public.has_dossier_access(auth.uid(), dossier_id));
CREATE POLICY "ocr_cache_update" ON public.ocr_cache FOR UPDATE TO authenticated
  USING (dossier_id IS NULL OR public.has_dossier_access(auth.uid(), dossier_id));

COMMENT ON TABLE public.ocr_cache IS
  'Cache OCR document : évite un nouvel appel LLM quand le même document est rescanné.';
