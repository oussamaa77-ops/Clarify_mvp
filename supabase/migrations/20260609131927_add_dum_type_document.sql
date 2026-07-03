-- Ajoute le type "dum" (Déclaration Unique des Marchandises / import douane)
-- à la contrainte CHECK de la colonne type_document de la table justificatifs.

ALTER TABLE public.justificatifs
  DROP CONSTRAINT IF EXISTS justificatifs_type_document_check;

ALTER TABLE public.justificatifs
  ADD CONSTRAINT justificatifs_type_document_check
  CHECK (type_document IN (
    'recu',
    'bon_commande',
    'bon_livraison',
    'note_frais',
    'addition',
    'facture',
    'dum'
  ));
