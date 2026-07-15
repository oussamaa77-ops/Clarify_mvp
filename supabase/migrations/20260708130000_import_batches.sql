-- Import de Grand Livre (Excel) — lots RÉVERSIBLES.
-- Chaque import est un lot (import_batches). Les écritures et les tiers auto-dérivés
-- portent une référence vers le lot, ce qui permet une annulation « en un clic » :
--   • supprimer le lot → ses écritures disparaissent (ON DELETE CASCADE),
--   • ses tiers auto-créés sont détachés (ON DELETE SET NULL) puis nettoyés côté
--     serveur s'ils ne sont référencés par aucune facture.

CREATE TABLE IF NOT EXISTS public.import_batches (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dossier_id          UUID NOT NULL REFERENCES public.dossiers(id) ON DELETE CASCADE,
  type                TEXT NOT NULL DEFAULT 'grand_livre',   -- 'grand_livre' (extensible)
  filename            TEXT,
  source_rows         INTEGER NOT NULL DEFAULT 0,            -- lignes lues dans le fichier
  inserted_ecritures  INTEGER NOT NULL DEFAULT 0,
  inserted_tiers      INTEGER NOT NULL DEFAULT 0,
  mapping             JSONB NOT NULL DEFAULT '{}'::jsonb,    -- mapping colonnes retenu (traçabilité)
  created_by          UUID REFERENCES auth.users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_import_batches_dossier
  ON public.import_batches (dossier_id, created_at DESC);

-- Tag de lot sur les écritures : CASCADE ⇒ annuler le lot supprime ses écritures.
ALTER TABLE public.ecritures_comptables
  ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES public.import_batches(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_ecritures_batch
  ON public.ecritures_comptables (batch_id);

-- Traçabilité des tiers auto-dérivés : SET NULL ⇒ pas de suppression destructive
-- automatique (le serveur ne supprime que les tiers non référencés du lot).
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS import_batch_id UUID REFERENCES public.import_batches(id) ON DELETE SET NULL;
ALTER TABLE public.fournisseurs
  ADD COLUMN IF NOT EXISTS import_batch_id UUID REFERENCES public.import_batches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_clients_batch ON public.clients (import_batch_id);
CREATE INDEX IF NOT EXISTS idx_fournisseurs_batch ON public.fournisseurs (import_batch_id);

ALTER TABLE public.import_batches ENABLE ROW LEVEL SECURITY;

-- Mêmes politiques que les autres tables scoped-dossier.
CREATE POLICY "ds_select" ON public.import_batches FOR SELECT TO authenticated
  USING (public.has_dossier_access(auth.uid(), dossier_id));
CREATE POLICY "ds_all" ON public.import_batches FOR ALL TO authenticated
  USING (public.has_dossier_access(auth.uid(), dossier_id))
  WITH CHECK (public.has_dossier_access(auth.uid(), dossier_id));

COMMENT ON TABLE public.import_batches IS
  'Lot d''import Grand Livre (Excel) — réversible : supprimer le lot annule ses écritures.';
