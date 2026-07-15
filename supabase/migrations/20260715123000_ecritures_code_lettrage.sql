-- ============================================================================
-- CONSERVATION DU CODE DE LETTRAGE D'ORIGINE (import Grand Livre)
--
-- Les exports comptables (Sage…) portent une colonne de lettrage : les lettres
-- de pointage A, B, AB… qui matérialisent le rapprochement fait dans l'outil
-- source. Jusqu'ici l'import les IGNORAIT. On ajoute une colonne texte pour les
-- conserver telles quelles (distincte de `lettree`/`date_lettrage`, qui sont
-- l'état de rapprochement RECALCULÉ par notre moteur).
--
-- ⚠️ À exécuter manuellement dans le dashboard Supabase (SQL editor). Idempotent.
-- ============================================================================

ALTER TABLE public.ecritures_comptables
  ADD COLUMN IF NOT EXISTS code_lettrage TEXT;

COMMENT ON COLUMN public.ecritures_comptables.code_lettrage IS
  'Code de lettrage/pointage d''origine du fichier importé (Sage : A, B, AB…). Informatif — NE PAS confondre avec lettree/date_lettrage (rapprochement recalculé en interne).';

-- Accès rapide aux écritures d'un même code de lettrage dans un dossier.
CREATE INDEX IF NOT EXISTS idx_ecritures_code_lettrage
  ON public.ecritures_comptables (dossier_id, code_lettrage)
  WHERE code_lettrage IS NOT NULL;
