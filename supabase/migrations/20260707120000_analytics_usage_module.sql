-- Ventilation de l'usage IA par MODULE et par PHASE.
--
--   • module : quel écran/pipeline a déclenché l'IA —
--       'facture_client' | 'facture_fournisseur' | 'justificatif' | 'releve'
--   • phase  : à quelle étape l'IA (ou son économie) intervient —
--       'ocr'     = extraction OCR du document (Mistral OCR + éventuelle relecture LLM)
--       'analyse' = rapprochement / classification comptable (LLM ou mémoire des tiers)
--
-- Colonnes ADDITIVES : les lignes existantes (module/phase NULL) restent valides.
-- L'insert côté serveur reste best-effort et tolère l'absence de ces colonnes
-- (retry sans elles) pour ne jamais bloquer un scan avant application de la migration.

ALTER TABLE public.analytics_usage
  ADD COLUMN IF NOT EXISTS module TEXT,   -- facture_client | facture_fournisseur | justificatif | releve
  ADD COLUMN IF NOT EXISTS phase  TEXT;   -- ocr | analyse

CREATE INDEX IF NOT EXISTS idx_analytics_usage_module
  ON public.analytics_usage (module, created_at DESC);

COMMENT ON COLUMN public.analytics_usage.module IS
  'Module déclencheur : facture_client | facture_fournisseur | justificatif | releve';
COMMENT ON COLUMN public.analytics_usage.phase IS
  'Étape IA : ocr (extraction) | analyse (rapprochement/classification)';
