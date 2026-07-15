-- ════════════════════════════════════════════════════════════════════════════
-- lier_transaction v3 — routage par la table `paiements`, garde `montant_paye < 1`
-- SUPPRIMÉE.
-- ════════════════════════════════════════════════════════════════════════════
-- Le bug corrigé : la garde `WHERE ... AND COALESCE(montant_paye,0) < 1` empêchait
-- tout SECOND règlement partiel. Une facture ayant déjà reçu un acompte ne pouvait
-- plus être lettrée : le montant était accepté sur la ligne bancaire (marquée liée)
-- mais IGNORÉ sur la facture. Paiements partiels successifs impossibles.
--
-- Désormais : lier_transaction n'écrit plus montant_paye directement. Elle insère un
-- paiement (origine='lettrage', transaction_id) ; le trigger paiements_resync recalcule
-- montant_paye / montant_restant / statut. L'idempotence est portée par l'index unique
-- partiel sur transaction_id (relier la même ligne deux fois → ON CONFLICT DO NOTHING),
-- plus par la garde `facture_id IS NULL` du lien lui-même (course concurrente).
--
-- Inchangé : le lien bancaire reste atomique ; une ligne clôturée conserve son statut ;
-- la branche justificatif ne touche que `statut` (pas de colonne `rapproche`).

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
  v_montant   numeric;
  v_date      date;
  v_dossier   uuid;
BEGIN
  -- 1) Lien atomique : ne touche QUE les transactions encore orphelines.
  UPDATE public.transactions_bancaires
     SET facture_id      = CASE WHEN p_doc_kind IN ('facture_client','facture_fournisseur') THEN p_doc_id END,
         justificatif_id = CASE WHEN p_doc_kind = 'justificatif' THEN p_doc_id END,
         document_type   = p_doc_kind,
         statut          = CASE WHEN statut = 'cloture' THEN 'cloture' ELSE 'ferme' END,
         rapproche       = true
   WHERE id = p_tx_id
     AND facture_id IS NULL
     AND justificatif_id IS NULL
   RETURNING ABS(montant), date_operation, dossier_id INTO v_montant, v_date, v_dossier;

  IF NOT FOUND THEN
    RETURN false;   -- déjà liée / course concurrente → aucun paiement
  END IF;

  -- 2) Enregistrer le règlement comme un PAIEMENT. Le trigger met à jour la facture.
  --    Plus de garde `montant_paye < 1` : un 2ᵉ, 3ᵉ… paiement partiel est accepté
  --    jusqu'à extinction de la dette.
  IF p_doc_kind = 'facture_client' THEN
    INSERT INTO public.paiements (dossier_id, facture_id, montant, date_paiement, origine, transaction_id)
    VALUES (v_dossier, p_doc_id, v_montant, COALESCE(v_date, CURRENT_DATE), 'lettrage', p_tx_id)
    ON CONFLICT (transaction_id) WHERE transaction_id IS NOT NULL DO NOTHING;

  ELSIF p_doc_kind = 'facture_fournisseur' THEN
    INSERT INTO public.paiements (dossier_id, facture_fournisseur_id, montant, date_paiement, origine, transaction_id)
    VALUES (v_dossier, p_doc_id, v_montant, COALESCE(v_date, CURRENT_DATE), 'lettrage', p_tx_id)
    ON CONFLICT (transaction_id) WHERE transaction_id IS NOT NULL DO NOTHING;

  ELSIF p_doc_kind = 'justificatif' THEN
    UPDATE public.justificatifs
       SET statut = 'rapproche'
     WHERE id = p_doc_id AND COALESCE(statut,'') <> 'rapproche';
  END IF;

  RETURN true;
END $$;

GRANT EXECUTE ON FUNCTION public.lier_transaction(uuid, uuid, text) TO authenticated, service_role;

-- Délettrage : quand une ligne de relevé est déliée (facture_id → NULL côté appli),
-- le paiement correspondant doit disparaître pour que la dette se rouvre. On le fait
-- porter par le paiement lui-même via son transaction_id, plutôt que de dupliquer la
-- logique dans le code : une fonction dédiée, appelée par le code de délettrage.
CREATE OR REPLACE FUNCTION public.delier_transaction(p_tx_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Supprime le paiement issu de cette ligne (le trigger recalcule la facture).
  DELETE FROM public.paiements WHERE transaction_id = p_tx_id;
  -- Délie la ligne bancaire sans jamais la supprimer (fait bancaire).
  UPDATE public.transactions_bancaires
     SET facture_id = NULL, justificatif_id = NULL, document_type = NULL, rapproche = false,
         statut = CASE WHEN statut = 'cloture' THEN 'cloture' ELSE 'ouvert' END
   WHERE id = p_tx_id;
  RETURN true;
END $$;

GRANT EXECUTE ON FUNCTION public.delier_transaction(uuid) TO authenticated, service_role;
