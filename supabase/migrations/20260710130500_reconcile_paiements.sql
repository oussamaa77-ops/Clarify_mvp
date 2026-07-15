-- ════════════════════════════════════════════════════════════════════════════
-- synchroniser_paiements_dossier — dérive `paiements` des liens authoritatifs
-- ════════════════════════════════════════════════════════════════════════════
-- Plusieurs chemins de l'UI (import de relevé par lot, liaison manuelle, sélecteur
-- « Lier un document ») posent `transactions_bancaires.facture_id` DIRECTEMENT, sans
-- passer par la RPC lier_transaction. Impossible d'y récupérer proprement l'id de la
-- transaction insérée côté client pour créer le paiement correspondant.
--
-- Cette fonction reconstruit donc les paiements DÉRIVÉS (origine 'lettrage' et
-- 'encaissement') d'un dossier à partir de leurs sources authoritatives — les lignes
-- de relevé lettrées et les encaissements rattachés. Les paiements 'manuel' (bouton
-- « Payée », sans source externe) ne sont JAMAIS touchés. Le trigger paiements_resync
-- met à jour montant_paye/montant_restant/statut des factures concernées.
--
-- Idempotente : on efface puis reconstruit les deux origines dérivées. À appeler après
-- toute opération de lettrage/délettrage/encaissement côté UI.

CREATE OR REPLACE FUNCTION public.synchroniser_paiements_dossier(p_dossier uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- 1) Purge des paiements dérivés du dossier (le trigger remet les factures à jour).
  DELETE FROM public.paiements
   WHERE dossier_id = p_dossier
     AND origine IN ('lettrage','encaissement');

  -- 2) Reconstruction depuis les lignes de relevé lettrées.
  INSERT INTO public.paiements
    (dossier_id, facture_id, facture_fournisseur_id, montant, date_paiement, origine, transaction_id)
  SELECT t.dossier_id,
         CASE WHEN t.document_type = 'facture_fournisseur' THEN NULL ELSE t.facture_id END,
         CASE WHEN t.document_type = 'facture_fournisseur' THEN t.facture_id ELSE NULL END,
         ABS(t.montant), COALESCE(t.date_operation, CURRENT_DATE), 'lettrage', t.id
    FROM public.transactions_bancaires t
   WHERE t.dossier_id = p_dossier
     AND t.facture_id IS NOT NULL
     AND ABS(t.montant) > 0;

  -- 3) Reconstruction depuis les encaissements rattachés à une facture.
  INSERT INTO public.paiements
    (dossier_id, facture_id, facture_fournisseur_id, montant, date_paiement, origine, encaissement_id, reference)
  SELECT e.dossier_id, e.facture_id, e.facture_fournisseur_id, e.montant,
         COALESCE(e.date_encaissement, e.created_at::date), 'encaissement', e.id, e.reference
    FROM public.encaissements e
   WHERE e.dossier_id = p_dossier
     AND COALESCE(e.valide, true) = true
     AND e.montant > 0
     AND (e.facture_id IS NOT NULL OR e.facture_fournisseur_id IS NOT NULL);
END $$;

GRANT EXECUTE ON FUNCTION public.synchroniser_paiements_dossier(uuid) TO authenticated, service_role;
