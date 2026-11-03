-- ============================================================================
-- Compensation de créances réciproques : date de signature de la convention.
--
-- La convention est un justificatif existant (catégorie
-- `convention_compensation`, numéro de pièce = référence de l'OD COMP-<n°>).
-- Elle n'est probante que DATÉE et SIGNÉE PAR LES DEUX PARTIES, original joint :
-- `date_signature` porte la date réelle de signature (fait générateur de la TVA
-- compensée), `signature_parties` l'attestation des deux signatures.
-- Tant qu'elle est vide, l'OD de compensation n'est pas admise comme règlement
-- (aucune TVA rendue exigible ni déductible sur sa foi).
--
-- Additive et rejouable ; aucune ligne existante modifiée. Réversible : DROP COLUMN.
-- ⚠️ À exécuter manuellement dans le SQL editor Supabase.
-- ============================================================================

ALTER TABLE public.justificatifs ADD COLUMN IF NOT EXISTS date_signature DATE;
ALTER TABLE public.justificatifs ADD COLUMN IF NOT EXISTS signature_parties BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.justificatifs.date_signature IS
  'Convention de compensation : date de signature — sans elle, la compensation n''est pas recevable.';

COMMENT ON COLUMN public.justificatifs.signature_parties IS
  'Convention de compensation signée par les deux parties (vérifié sur l''original joint).';
