-- ============================================================================
-- Avoirs fournisseurs et périodicité des déclarations de TVA.
--
-- 1. factures_fournisseurs.type : 'facture' (défaut implicite, NULL) ou 'avoir'.
--    Un avoir fournisseur était enregistré comme un achat : charge et TVA
--    déductible augmentées au lieu d'être réduites. L'application le comptabilise
--    désormais au journal ACH-AVR (D 4411 / C 6xxx / C 3458).
--
-- 2. dossiers.periodicite_tva : SITUATION déclarative du dossier (art. 108 CGI) :
--      option_mensuelle  option pour la déclaration mensuelle ;
--      saisonniere       activité saisonnière, périodique ou occasionnelle (trimestrielle) ;
--      non_resident      non-résident sans établissement au Maroc (mensuelle).
--    NULL = droit commun : entreprise nouvelle trimestrielle l'année de son début,
--    puis CA taxable N-1 ≥ 1 000 000 MAD mensuelle, sinon trimestrielle.
--    La périodicité RETENUE pour une année se fige dans
--    dossiers.ajustements_fiscaux[année].periodicite_tva (historique préservé).
--
-- Additive et rejouable : aucune ligne existante n'est modifiée (les factures
-- fournisseurs existantes restent NULL = facture).
-- Réversible : DROP COLUMN type / periodicite_tva.
-- ⚠️ À exécuter manuellement dans le SQL editor Supabase.
-- ============================================================================

ALTER TABLE public.factures_fournisseurs ADD COLUMN IF NOT EXISTS type TEXT;
ALTER TABLE public.factures_fournisseurs DROP CONSTRAINT IF EXISTS factures_fournisseurs_type_check;
ALTER TABLE public.factures_fournisseurs
  ADD CONSTRAINT factures_fournisseurs_type_check CHECK (type IS NULL OR type IN ('facture', 'avoir'));
COMMENT ON COLUMN public.factures_fournisseurs.type IS
  'Nature de la pièce : NULL/facture = achat ; avoir = avoir fournisseur (journal ACH-AVR).';

ALTER TABLE public.dossiers ADD COLUMN IF NOT EXISTS periodicite_tva TEXT;
ALTER TABLE public.dossiers DROP CONSTRAINT IF EXISTS dossiers_periodicite_tva_check;
ALTER TABLE public.dossiers
  ADD CONSTRAINT dossiers_periodicite_tva_check CHECK (periodicite_tva IS NULL OR periodicite_tva IN ('option_mensuelle', 'saisonniere', 'non_resident'));
COMMENT ON COLUMN public.dossiers.periodicite_tva IS
  'Situation TVA (art. 108 CGI) : option_mensuelle / saisonniere / non_resident ; NULL = droit commun.';
