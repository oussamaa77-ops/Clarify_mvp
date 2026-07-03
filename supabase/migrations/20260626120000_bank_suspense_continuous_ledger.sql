-- ════════════════════════════════════════════════════════════════════════════
-- APPROCHE ODOO — Bank Suspense Account / Grand Livre de Trésorerie continu
-- ════════════════════════════════════════════════════════════════════════════
-- Bascule du modèle « clôture sélective du lettré » vers le modèle Odoo :
--   1. À la clôture, TOUTES les transactions sont comptabilisées (Journal BQ).
--      Les orphelines sont parquées sur le compte d'attente PCM : 4711 (débit) /
--      4712 (crédit). Le Grand Livre reste donc toujours à jour.
--   2. Le lettrage reste possible APRÈS clôture : un justificatif tardif fait
--      basculer dynamiquement la ligne d'écriture du compte d'attente vers le
--      compte final (3421 client / 4411 fournisseur / compte PCM du justificatif).
--      Le délettrage la repasse automatiquement en compte d'attente.
--
-- Mécanisme : on relie chaque écriture à sa transaction source (transaction_id),
-- puis un trigger AFTER UPDATE synchronise le compte de contrepartie — quel que
-- soit le chemin de lettrage (RPC serveur OU update UI directe).
-- ════════════════════════════════════════════════════════════════════════════

-- 1) Lien écriture → transaction source (manquant jusqu'ici) ───────────────────
ALTER TABLE public.ecritures_comptables
  ADD COLUMN IF NOT EXISTS transaction_id uuid
    REFERENCES public.transactions_bancaires(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ecritures_transaction
  ON public.ecritures_comptables(transaction_id);

-- 2) Trigger : synchro dynamique du compte de contrepartie ─────────────────────
-- Se déclenche quand la pièce liée d'une transaction change (lettrage / délettrage).
-- N'agit que si des écritures existent déjà pour la transaction (= déjà clôturée) :
-- pour une transaction non encore clôturée, il n'y a rien à corriger (l'écriture
-- sera générée au bon compte lors de la clôture).
CREATE OR REPLACE FUNCTION public.sync_ecriture_contrepartie()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_final text;   -- compte final (NULL = orphelin → compte d'attente 4711/4712)
BEGIN
  -- Rien à faire si l'imputation (pièce liée) n'a pas changé.
  IF NEW.facture_id IS NOT DISTINCT FROM OLD.facture_id
     AND NEW.justificatif_id IS NOT DISTINCT FROM OLD.justificatif_id THEN
    RETURN NEW;
  END IF;

  -- Compte final selon la pièce désormais liée.
  IF NEW.facture_id IS NOT NULL AND NEW.document_type = 'facture_client' THEN
    v_final := '3421';                                   -- créance client
  ELSIF NEW.facture_id IS NOT NULL AND NEW.document_type = 'facture_fournisseur' THEN
    v_final := '4411';                                   -- dette fournisseur
  ELSIF NEW.justificatif_id IS NOT NULL THEN
    SELECT NULLIF(compte_pcm, '') INTO v_final
      FROM public.justificatifs WHERE id = NEW.justificatif_id;
    IF v_final IS NULL OR v_final !~ '^\d{3,}' THEN
      v_final := NULL;                                   -- pas de compte PCM exploitable → attente
    END IF;
  ELSE
    v_final := NULL;                                     -- orphelin (délettrage)
  END IF;

  -- MAJ de la (des) ligne(s) de contrepartie de cette transaction (hors banque 5141).
  -- Orphelin → compte d'attente selon le sens de la ligne : 4711 (débit) / 4712 (crédit).
  UPDATE public.ecritures_comptables e
     SET compte_numero = COALESCE(v_final, CASE WHEN e.debit > 0 THEN '4711' ELSE '4712' END)
   WHERE e.transaction_id = NEW.id
     AND e.journal_code = 'BQ'
     AND e.compte_numero <> '5141';

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_sync_ecriture_contrepartie ON public.transactions_bancaires;
CREATE TRIGGER trg_sync_ecriture_contrepartie
  AFTER UPDATE OF facture_id, justificatif_id, document_type
  ON public.transactions_bancaires
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_ecriture_contrepartie();

-- 3) RPC lier_transaction — déverrouillage post-clôture ────────────────────────
-- Changements vs version précédente :
--   • on RETIRE le verrou « AND COALESCE(statut,'') <> 'cloture' » → une
--     transaction déjà clôturée (orpheline sur 4711/4712) peut être lettrée ;
--   • le statut 'cloture' est CONSERVÉ (jamais rétrogradé en 'ferme') car les
--     écritures sont déjà générées — sinon double comptabilisation à la clôture.
-- Le trigger ci-dessus s'occupe du basculement du compte de contrepartie.
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
  --    (clôturées comprises désormais). Conserve le statut 'cloture'.
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
    UPDATE public.justificatifs
       SET statut = 'rapproche', rapproche = true
     WHERE id = p_doc_id AND COALESCE(statut,'') <> 'rapproche';
  END IF;

  RETURN true;
END $$;

GRANT EXECUTE ON FUNCTION public.lier_transaction(uuid, uuid, text) TO authenticated, service_role;
