-- Mémoire des tiers (POC apprentissage — fournisseurs).
-- Mappe un tiers (clé forte = ICE, clé principale = libellé normalisé) vers sa
-- classification comptable APPRISE (compte PCM, catégorie, taux TVA), enrichie à
-- CHAQUE validation de facture (occurrences++). Lue AVANT le LLM dans ocrFacture
-- pour court-circuiter l'appel IA quand le fournisseur est déjà connu.

CREATE TABLE IF NOT EXISTS public.tiers_memoire (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dossier_id          UUID NOT NULL REFERENCES public.dossiers(id) ON DELETE CASCADE,
  sens                TEXT NOT NULL DEFAULT 'fournisseur',   -- 'fournisseur' | 'client'
  cle_ice             TEXT,                                   -- ICE normalisé si dispo (clé forte)
  cle_libelle         TEXT NOT NULL,                          -- libellé normalisé (clé principale)
  fournisseur_id      UUID,                                   -- lien optionnel vers fournisseurs.id
  compte_pcm          TEXT,
  categorie_pcm       TEXT,
  taux_tva            NUMERIC,
  occurrences         INTEGER NOT NULL DEFAULT 1,             -- nb de validations → confiance
  derniere_validation TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tiers_memoire_cle_unique UNIQUE (dossier_id, sens, cle_libelle)
);

CREATE INDEX IF NOT EXISTS idx_tiers_memoire_ice
  ON public.tiers_memoire (dossier_id, sens, cle_ice);

ALTER TABLE public.tiers_memoire ENABLE ROW LEVEL SECURITY;

-- Mêmes politiques que les autres tables scoped-dossier.
CREATE POLICY "ds_select" ON public.tiers_memoire FOR SELECT TO authenticated
  USING (public.has_dossier_access(auth.uid(), dossier_id));
CREATE POLICY "ds_all" ON public.tiers_memoire FOR ALL TO authenticated
  USING (public.has_dossier_access(auth.uid(), dossier_id))
  WITH CHECK (public.has_dossier_access(auth.uid(), dossier_id));

COMMENT ON TABLE public.tiers_memoire IS
  'Mémoire d''apprentissage des tiers : classification comptable réutilisable, enrichie à chaque validation.';
