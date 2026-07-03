-- Ajoute la colonne echeances (jsonb) sur factures (clients) et factures_fournisseurs.
-- Stocke les tranches de paiement partiel au format attendu par le backend
-- FastAPI /api/reconciliation/partial-payments :
--   [{ "montant_attendu": 1200.00, "date_echeance": "2026-08-15" }, ...]
-- Tableau vide '[]' = paiement non fractionné (montant total TTC dû en une fois).

ALTER TABLE public.factures
  ADD COLUMN IF NOT EXISTS echeances JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.factures_fournisseurs
  ADD COLUMN IF NOT EXISTS echeances JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.factures.echeances IS
  'Tranches de paiement partiel : [{montant_attendu, date_echeance}]. [] = non fractionné.';
COMMENT ON COLUMN public.factures_fournisseurs.echeances IS
  'Tranches de paiement partiel : [{montant_attendu, date_echeance}]. [] = non fractionné.';
