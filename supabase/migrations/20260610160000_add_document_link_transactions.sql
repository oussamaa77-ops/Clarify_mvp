-- Lie chaque transaction bancaire à son document source
-- facture_id    : UUID de la facture client (table factures) OU fournisseur (table factures_fournisseurs)
-- justificatif_id : UUID du justificatif (table justificatifs)
-- document_type : 'facture_client' | 'facture_fournisseur' | 'justificatif'
-- categorie / compte_comptable : code PCM stocké à l'insertion du relevé

ALTER TABLE public.transactions_bancaires
  ADD COLUMN IF NOT EXISTS facture_id        UUID,
  ADD COLUMN IF NOT EXISTS justificatif_id   UUID,
  ADD COLUMN IF NOT EXISTS document_type     TEXT,
  ADD COLUMN IF NOT EXISTS categorie         TEXT,
  ADD COLUMN IF NOT EXISTS compte_comptable  TEXT;

-- Backfill : rapproche=true mais pas encore de document_type → marquer générique
UPDATE public.transactions_bancaires
  SET document_type = 'inconnu'
  WHERE rapproche = true AND document_type IS NULL;
