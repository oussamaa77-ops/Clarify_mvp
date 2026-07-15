-- Rapprochement hybride PASSÉ / PRÉSENT (modèle Pennylane/Odoo) + archivage netting.
--
--  • dossiers.date_reprise : date de reprise comptable. Une transaction bancaire
--    dont la date_operation est ANTÉRIEURE = « passé » (migration) → le lettrage
--    direct contre une écriture du Grand Livre est PRIORITAIRE (validation des
--    soldes de départ sans scanner les vieilles factures). À partir de cette date
--    = « présent » (flux courant) → priorité à la facture / justificatif OCR.
--
--  • ecritures_comptables.lettree : marque un poste soldé « archivé ». Le netting
--    par reference_piece met à true les écritures d'une pièce déjà équilibrée dans
--    le Grand Livre (débit facture = crédit règlement) → elles sortent des candidats.

ALTER TABLE public.dossiers
  ADD COLUMN IF NOT EXISTS date_reprise DATE;

ALTER TABLE public.ecritures_comptables
  ADD COLUMN IF NOT EXISTS lettree       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS date_lettrage TIMESTAMPTZ;

-- Postes ouverts = écritures auxiliaires non encore lettrées ni liées à une transaction.
CREATE INDEX IF NOT EXISTS idx_ecritures_ouvertes
  ON public.ecritures_comptables (dossier_id, compte_numero)
  WHERE transaction_id IS NULL AND lettree = false;

COMMENT ON COLUMN public.dossiers.date_reprise IS
  'Date de reprise comptable : avant = migration (lettrage GL prioritaire), après = flux courant (facture OCR prioritaire).';
COMMENT ON COLUMN public.ecritures_comptables.lettree IS
  'Poste soldé/archivé (netting par pièce ou lettrage bancaire) → exclu des candidats au rapprochement.';
