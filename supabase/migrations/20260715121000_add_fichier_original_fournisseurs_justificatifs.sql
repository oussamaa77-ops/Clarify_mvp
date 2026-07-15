-- ============================================================================
-- PERSISTANCE DU FICHIER ORIGINAL SCANNÉ (anomalie #3)
--
-- Les factures client stockaient déjà l'original (fichier_original_url/nom/type)
-- mais PAS les factures fournisseurs ni les justificatifs : le scan faisait
-- l'OCR sans conserver le document. Sans fichier stocké, impossible de le
-- « visualiser » ensuite. On ajoute donc les mêmes colonnes.
--
-- ⚠️ À exécuter manuellement dans le dashboard Supabase (SQL editor).
-- Idempotent (IF NOT EXISTS).
-- ============================================================================

ALTER TABLE public.factures_fournisseurs
  ADD COLUMN IF NOT EXISTS fichier_original_url  TEXT,
  ADD COLUMN IF NOT EXISTS fichier_original_nom  TEXT,
  ADD COLUMN IF NOT EXISTS fichier_original_type TEXT;

ALTER TABLE public.justificatifs
  ADD COLUMN IF NOT EXISTS fichier_original_url  TEXT,
  ADD COLUMN IF NOT EXISTS fichier_original_nom  TEXT,
  ADD COLUMN IF NOT EXISTS fichier_original_type TEXT;
