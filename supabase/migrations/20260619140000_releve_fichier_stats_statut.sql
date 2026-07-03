-- ════════════════════════════════════════════════════════════════════════════
-- CHANTIER 3 — Migration A : fichier scanné (bucket privé) + vue stats + CHECK statut
-- ════════════════════════════════════════════════════════════════════════════
-- À coller dans Supabase SQL Editor (rejouable).

-- ─── 1. Colonnes fichier sur le relevé ───────────────────────────────────────
-- fichier_nom existe déjà (vrai nom du fichier). On ajoute le chemin de stockage
-- (bucket PRIVÉ → on stocke le path, l'URL signée est générée à la volée) + le type MIME.
ALTER TABLE public.releves_bancaires
  ADD COLUMN IF NOT EXISTS fichier_path TEXT,
  ADD COLUMN IF NOT EXISTS fichier_type TEXT;

-- ─── 2. Bucket de stockage PRIVÉ ─────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('releves-bancaires', 'releves-bancaires', false)
ON CONFLICT (id) DO NOTHING;

-- Accès restreint par dossier : le 1er segment du chemin = dossier_id
-- (path = "<dossierId>/<releveId>.<ext>"). On réutilise has_dossier_access.
DROP POLICY IF EXISTS "releves_files_select" ON storage.objects;
CREATE POLICY "releves_files_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'releves-bancaires'
         AND public.has_dossier_access(auth.uid(), ((storage.foldername(name))[1])::uuid));

DROP POLICY IF EXISTS "releves_files_insert" ON storage.objects;
CREATE POLICY "releves_files_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'releves-bancaires'
              AND public.has_dossier_access(auth.uid(), ((storage.foldername(name))[1])::uuid));

DROP POLICY IF EXISTS "releves_files_update" ON storage.objects;
CREATE POLICY "releves_files_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'releves-bancaires'
         AND public.has_dossier_access(auth.uid(), ((storage.foldername(name))[1])::uuid));

DROP POLICY IF EXISTS "releves_files_delete" ON storage.objects;
CREATE POLICY "releves_files_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'releves-bancaires'
         AND public.has_dossier_access(auth.uid(), ((storage.foldername(name))[1])::uuid));

-- ─── 3. Vue de stats par relevé (compteurs pour les briques) ─────────────────
-- security_invoker = true → la vue respecte la RLS des tables sous-jacentes.
CREATE OR REPLACE VIEW public.v_releves_stats
  WITH (security_invoker = true) AS
SELECT
  r.id                                                                          AS releve_id,
  r.dossier_id,
  r.compte_id,
  COUNT(t.id)                                                                   AS nb_total,
  COUNT(t.id) FILTER (WHERE t.facture_id IS NOT NULL OR t.justificatif_id IS NOT NULL) AS nb_lettrees,
  COUNT(t.id) FILTER (WHERE t.facture_id IS NULL AND t.justificatif_id IS NULL) AS nb_orphelines,
  COUNT(t.id) FILTER (WHERE t.statut = 'cloture')                              AS nb_cloturees
FROM public.releves_bancaires r
LEFT JOIN public.transactions_bancaires t ON t.releve_id = r.id
GROUP BY r.id, r.dossier_id, r.compte_id;

-- ─── 4. CHECK constraint sur le statut (verrou de la machine d'états) ─────────
-- L'app est désormais alignée sur brouillon/actif/cloture (cf. code B/C).
-- On normalise les éventuels statuts hérités avant de poser la contrainte.
UPDATE public.releves_bancaires
  SET statut = 'actif'
  WHERE statut IS NULL OR statut NOT IN ('brouillon','actif','cloture');

ALTER TABLE public.releves_bancaires
  DROP CONSTRAINT IF EXISTS releves_bancaires_statut_chk;
ALTER TABLE public.releves_bancaires
  ADD CONSTRAINT releves_bancaires_statut_chk
  CHECK (statut IN ('brouillon','actif','cloture'));
