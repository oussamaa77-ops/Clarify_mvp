-- Ajoute la colonne statut sur transactions_bancaires
-- ouvert  = transaction enregistrée, pas encore rapprochée/clôturée
-- ferme   = transaction liée à un document (facture ou justificatif)
-- cloture = écritures Sage générées, transaction verrouillée

ALTER TABLE public.transactions_bancaires
  ADD COLUMN IF NOT EXISTS statut TEXT DEFAULT 'ouvert';

-- Migrer l'historique : si rapproche = true → statut = 'ferme'
UPDATE public.transactions_bancaires
  SET statut = 'ferme'
  WHERE rapproche = true AND statut = 'ouvert';
