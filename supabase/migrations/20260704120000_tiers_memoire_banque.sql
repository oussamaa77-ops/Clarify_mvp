-- Extension « mémoire des tiers » aux RELEVÉS BANCAIRES + lettrage automatique.
--
-- Ajoute le support sens='banque' : la clé principale (cle_libelle) devient le
-- LIBELLÉ BANCAIRE NORMALISÉ — bruit retiré (VIR/SEPA/PRLV/CB, dates, références,
-- montants parasites), accents supprimés, MAJUSCULES. On stocke en plus :
--   • pattern       : le même libellé normalisé (signature réutilisée par la
--                     recherche de similarité côté serveur) ;
--   • pattern_hash  : hash court du pattern → lookup exact O(1) ;
--   • type_tiers    : nature bancaire du tiers (client | fournisseur | autre) ;
--   • confiance     : score 0..1 dérivé des occurrences (LEAST(1, occurrences/3)).
--
-- La colonne `sens` n'a pas de contrainte CHECK → 'banque' est accepté tel quel.

ALTER TABLE public.tiers_memoire
  ADD COLUMN IF NOT EXISTS type_tiers    TEXT,                      -- 'client' | 'fournisseur' | 'autre'
  ADD COLUMN IF NOT EXISTS pattern       TEXT,                      -- libellé bancaire normalisé (bruit retiré)
  ADD COLUMN IF NOT EXISTS pattern_hash  TEXT,                      -- hash court du pattern (lookup exact)
  ADD COLUMN IF NOT EXISTS confiance     NUMERIC NOT NULL DEFAULT 0;-- 0..1 dérivé des occurrences

-- Lookup exact rapide par hash + repli similarité par pattern.
CREATE INDEX IF NOT EXISTS idx_tiers_memoire_pattern_hash
  ON public.tiers_memoire (dossier_id, sens, pattern_hash);
CREATE INDEX IF NOT EXISTS idx_tiers_memoire_pattern
  ON public.tiers_memoire (dossier_id, sens, pattern);

COMMENT ON COLUMN public.tiers_memoire.type_tiers   IS 'client | fournisseur | autre — nature du tiers bancaire.';
COMMENT ON COLUMN public.tiers_memoire.pattern      IS 'Libellé bancaire normalisé (VIR/SEPA/PRLV/CB, dates et références retirés).';
COMMENT ON COLUMN public.tiers_memoire.pattern_hash IS 'Hash court du pattern pour lookup exact rapide.';
COMMENT ON COLUMN public.tiers_memoire.confiance    IS 'Score 0..1 dérivé des occurrences : LEAST(1, occurrences/3).';
