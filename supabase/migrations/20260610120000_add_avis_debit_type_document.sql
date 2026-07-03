-- Ajoute tous les nouveaux types de documents (avis_debit, devis, quittances, contrat, autre…)
-- à la contrainte CHECK de la colonne type_document de la table justificatifs.

ALTER TABLE public.justificatifs
  DROP CONSTRAINT IF EXISTS justificatifs_type_document_check;

ALTER TABLE public.justificatifs
  ADD CONSTRAINT justificatifs_type_document_check
  CHECK (type_document IN (
    'recu',
    'facture',
    'bon_commande',
    'bon_livraison',
    'devis',
    'note_frais',
    'addition',
    'ticket_carburant',
    'avis_debit',
    'dum',
    'quittance_cnss',
    'quittance_dgi',
    'quittance_eau',
    'quittance_elec',
    'quittance_loyer',
    'contrat',
    'autre'
  ));
