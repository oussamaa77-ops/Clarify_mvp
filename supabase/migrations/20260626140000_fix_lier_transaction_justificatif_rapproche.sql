-- ════════════════════════════════════════════════════════════════════════════
-- FIX — lier_transaction : la table `justificatifs` n'a PAS de colonne `rapproche`
-- ════════════════════════════════════════════════════════════════════════════
-- La version de `20260626120000` faisait `UPDATE justificatifs SET statut='rapproche',
-- rapproche = true`, ce qui échoue : column "rapproche" of relation "justificatifs"
-- does not exist. Le statut de rapprochement d'un justificatif est porté UNIQUEMENT
-- par la colonne TEXT `statut` ('non_rapproche' | 'rapproche').
--
-- Seul changement vs 20260626120000 : la branche justificatif n'écrit plus que `statut`.
-- (transactions_bancaires.rapproche EXISTE → inchangé ; factures inchangées.)
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
  -- 1) Lien atomique : ne touche QUE les transactions encore orphelines
  --    (clôturées comprises). Conserve le statut 'cloture'.
  UPDATE public.transactions_bancaires
     SET facture_id      = CASE WHEN p_doc_kind IN ('facture_client','facture_fournisseur') THEN p_doc_id END,
         justificatif_id = CASE WHEN p_doc_kind = 'justificatif' THEN p_doc_id END,
         document_type   = p_doc_kind,
         statut          = CASE WHEN statut = 'cloture' THEN 'cloture' ELSE 'ferme' END,
         rapproche       = true
   WHERE id = p_tx_id
     AND facture_id IS NULL
     AND justificatif_id IS NULL
   RETURNING montant, date_operation INTO v_montant, v_date;

  IF NOT FOUND THEN
    RETURN false;   -- déjà liée / course concurrente → aucune écriture
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
    -- FIX : pas de colonne `rapproche` sur justificatifs → on ne met à jour que `statut`.
    UPDATE public.justificatifs
       SET statut = 'rapproche'
     WHERE id = p_doc_id AND COALESCE(statut,'') <> 'rapproche';
  END IF;

  RETURN true;
END $$;

GRANT EXECUTE ON FUNCTION public.lier_transaction(uuid, uuid, text) TO authenticated, service_role;
