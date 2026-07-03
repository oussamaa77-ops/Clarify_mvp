-- ════════════════════════════════════════════════════════════════════════════
-- CHANTIER 2 — RPC atomique de lettrage : lier_transaction
-- ════════════════════════════════════════════════════════════════════════════
-- Lie UNE transaction bancaire à UN document (facture client/fournisseur ou
-- justificatif) de façon ATOMIQUE et IDEMPOTENTE :
--   • le lien n'est posé QUE si la transaction est encore orpheline
--     (facture_id IS NULL AND justificatif_id IS NULL) → bloque la concurrence ;
--   • la mise à jour du montant payé du document n'a lieu qu'une fois
--     (garde montant_paye < 1) → empêche le double-comptage.
-- Renvoie TRUE si le lien a été posé, FALSE si la transaction était déjà liée
-- (course concurrente) ou clôturée.
--
-- Index partiel sur factures/fournisseurs (perf du lettrage continu) — placés ici
-- car montant_restant a été ajouté hors-migration ; gardés par IF NOT EXISTS.
CREATE INDEX IF NOT EXISTS idx_ff_dossier_restant
  ON public.factures_fournisseurs(dossier_id) WHERE montant_restant > 0;
CREATE INDEX IF NOT EXISTS idx_fc_dossier_restant
  ON public.factures(dossier_id) WHERE montant_restant > 0;

CREATE OR REPLACE FUNCTION public.lier_transaction(
  p_tx_id   uuid,
  p_doc_id  uuid,
  p_doc_kind text   -- 'facture_client' | 'facture_fournisseur' | 'justificatif'
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_montant numeric;
  v_date    date;
BEGIN
  -- 1) Lien atomique : ne touche QUE les transactions encore orphelines.
  UPDATE public.transactions_bancaires
     SET facture_id      = CASE WHEN p_doc_kind IN ('facture_client','facture_fournisseur') THEN p_doc_id END,
         justificatif_id = CASE WHEN p_doc_kind = 'justificatif' THEN p_doc_id END,
         document_type   = p_doc_kind,
         statut          = 'ferme',
         rapproche       = true
   WHERE id = p_tx_id
     AND facture_id IS NULL
     AND justificatif_id IS NULL
     AND COALESCE(statut,'') <> 'cloture'
   RETURNING montant, date_operation INTO v_montant, v_date;

  IF NOT FOUND THEN
    RETURN false;   -- déjà liée / clôturée / course concurrente → aucune écriture
  END IF;

  -- 2) Mise à jour du document (montant payé), idempotente (garde montant_paye < 1).
  IF p_doc_kind = 'facture_client' THEN
    UPDATE public.factures
       SET montant_paye    = COALESCE(montant_paye,0) + v_montant,
           montant_restant = GREATEST(0, montant_ttc - (COALESCE(montant_paye,0) + v_montant)),
           statut_paiement = (CASE WHEN montant_ttc - (COALESCE(montant_paye,0) + v_montant) <= 1
                                   THEN 'payee' ELSE 'partielle' END)::public.statut_paiement,
           date_paiement   = COALESCE(v_date, CURRENT_DATE)
     WHERE id = p_doc_id AND COALESCE(montant_paye,0) < 1;

  ELSIF p_doc_kind = 'facture_fournisseur' THEN
    UPDATE public.factures_fournisseurs
       SET montant_paye    = COALESCE(montant_paye,0) + v_montant,
           montant_restant = GREATEST(0, montant_ttc - (COALESCE(montant_paye,0) + v_montant)),
           statut_paiement = (CASE WHEN montant_ttc - (COALESCE(montant_paye,0) + v_montant) <= 1
                                   THEN 'payee' ELSE 'partielle' END)::public.statut_paiement,
           date_paiement   = COALESCE(v_date, CURRENT_DATE)
     WHERE id = p_doc_id AND COALESCE(montant_paye,0) < 1;

  ELSIF p_doc_kind = 'justificatif' THEN
    UPDATE public.justificatifs
       SET statut = 'rapproche', rapproche = true
     WHERE id = p_doc_id AND COALESCE(statut,'') <> 'rapproche';
  END IF;

  RETURN true;
END $$;

GRANT EXECUTE ON FUNCTION public.lier_transaction(uuid, uuid, text) TO authenticated, service_role;
