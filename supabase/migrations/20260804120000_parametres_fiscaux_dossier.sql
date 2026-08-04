-- ============================================================================
-- Paramètres fiscaux du dossier (module Fiscalité — CGI marocain).
--
-- Ces informations sont DÉCLARATIVES : aucune écriture comptable ne les porte,
-- et elles commandent pourtant l'essentiel des règles du module :
--   • date_debut_activite → 1er exercice (dispense d'acomptes IS, art. 170),
--     exonération de cotisation minimale 36 mois (art. 144), exonération
--     quinquennale de taxe professionnelle (art. 6) ;
--   • valeur_locative_tp  → BASE de la taxe professionnelle (jamais le CA) ;
--   • classe_tp           → taux TP (classe 1 : 30 %, 2 : 20 %, 3 : 10 %) ;
--   • regime_is           → barème IS applicable (droit commun ou statut spécifique).
--
-- taux_cm reste facultatif : il n'accueille que les taux dérogatoires de
-- cotisation minimale (0,15 % pour certaines activités réglementées). NULL =
-- taux de droit commun (0,25 %).
--
-- Rejouable sans risque : ADD COLUMN IF NOT EXISTS + création de contrainte gardée.
-- ============================================================================

ALTER TABLE public.dossiers
  ADD COLUMN IF NOT EXISTS date_debut_activite DATE,
  ADD COLUMN IF NOT EXISTS valeur_locative_tp  NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS classe_tp           SMALLINT,
  ADD COLUMN IF NOT EXISTS taux_cm             NUMERIC(6,5),
  -- Régime IS : 'droit_commun' (20 % < 100 MDH, 35 % au-delà) ou 'taux_specifique'
  -- (20 % plafonné : exportateurs, ZAI, CFC…). NULL = droit commun.
  ADD COLUMN IF NOT EXISTS regime_is           TEXT;

-- La nomenclature des professions ne connaît que trois classes.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'dossiers_classe_tp_check'
  ) THEN
    ALTER TABLE public.dossiers
      ADD CONSTRAINT dossiers_classe_tp_check CHECK (classe_tp IS NULL OR classe_tp IN (1, 2, 3));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'dossiers_regime_is_check'
  ) THEN
    ALTER TABLE public.dossiers
      ADD CONSTRAINT dossiers_regime_is_check
      CHECK (regime_is IS NULL OR regime_is IN ('droit_commun', 'taux_specifique'));
  END IF;
END $$;

COMMENT ON COLUMN public.dossiers.date_debut_activite IS
  'Date de début d''exploitation — pilote les exonérations IS/CM/TP du module Fiscalité.';
COMMENT ON COLUMN public.dossiers.valeur_locative_tp IS
  'Valeur locative annuelle des locaux, matériel et outillage — base de la taxe professionnelle.';
COMMENT ON COLUMN public.dossiers.classe_tp IS
  'Classe de la nomenclature des professions : 1 = 30 %, 2 = 20 %, 3 = 10 %.';
COMMENT ON COLUMN public.dossiers.taux_cm IS
  'Taux dérogatoire de cotisation minimale (ex. 0.0015). NULL = droit commun 0,25 %.';
COMMENT ON COLUMN public.dossiers.regime_is IS
  'Régime IS : NULL/droit_commun = barème 20 % / 35 % ; taux_specifique = 20 % plafonné (export, ZAI, CFC).';
