-- ============================================================================
-- Module Fiscalité — ajustements extra-comptables et régime IS à 40 %.
--
-- 1. dossiers.ajustements_fiscaux (jsonb, indexé par millésime) :
--      { "2026": { "reintegrations": 12000, "deductions": 0, "is_du_precedent": 85000 } }
--    • reintegrations / deductions : tableau de passage du résultat comptable
--      au résultat fiscal (charges non déductibles, produits exonérés, déficits) ;
--    • is_du_precedent : IS liquidé sur la liasse N-1, base légale des acomptes
--      de N (art. 170 CGI) — prime sur le recalcul depuis le grand livre ;
--    • deficits_anterieurs : stock de déficits encore reportables à l'ouverture
--      (art. 12 CGI), imputé par l'application dans la limite du bénéfice.
--    NULL / clé absente = aucun ajustement. L'application lit la colonne de façon
--    tolérante : tant que cette migration n'est pas appliquée, rien ne casse.
--
-- 2. regime_is accepte 'etablissement_credit' : taux de 40 % des établissements
--    de crédit, Bank Al-Maghrib, CDG, assurances et réassurance (art. 19-I-C CGI).
--
-- Rejouable sans risque.
-- ⚠️ À exécuter manuellement dans le SQL editor Supabase.
-- ============================================================================

ALTER TABLE public.dossiers
  ADD COLUMN IF NOT EXISTS ajustements_fiscaux JSONB;

COMMENT ON COLUMN public.dossiers.ajustements_fiscaux IS
  'Ajustements fiscaux par exercice : { "AAAA": { reintegrations, deductions, is_du_precedent } }.';

ALTER TABLE public.dossiers DROP CONSTRAINT IF EXISTS dossiers_regime_is_check;
ALTER TABLE public.dossiers
  ADD CONSTRAINT dossiers_regime_is_check
  CHECK (regime_is IS NULL OR regime_is IN ('droit_commun', 'taux_specifique', 'etablissement_credit'));

COMMENT ON COLUMN public.dossiers.regime_is IS
  'Régime IS : NULL/droit_commun = 20 % / 35 % ; taux_specifique = 20 % plafonné ; etablissement_credit = 40 %.';
