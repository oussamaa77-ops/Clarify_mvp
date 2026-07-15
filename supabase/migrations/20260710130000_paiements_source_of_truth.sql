-- ════════════════════════════════════════════════════════════════════════════
-- MOTEUR DE PAIEMENT — `paiements` comme unique source de vérité du reste à payer
-- ════════════════════════════════════════════════════════════════════════════
-- PROBLÈME RÉEL constaté en base (sonde PostgREST du 2026-07-10, dossier de prod) :
--   • factures.montant_restant est FAUX sur 8 factures / 11 : montant_restant = 0
--     alors que montant_paye = 0 et la facture n'est pas soldée (ex. F2024-001,
--     TTC 16 200, payé 0, restant 0). Tout écran lisant montant_restant sous-évalue
--     les créances.
--   • Le bouton « Payée » passe statut_paiement='payee' SANS renseigner montant_paye
--     (ex. FAC-2024-306). Statut et montants se contredisent.
--   • Aucune trace des règlements individuels : impossible d'auditer, d'annuler un
--     paiement précis, ou de garantir l'idempotence d'un relettrage.
--
-- MODÈLE CIBLE : une facture reçoit N paiements. montant_paye / montant_restant ne
-- sont plus écrits à la main nulle part — un TRIGGER les recalcule depuis SUM(paiements).
-- Reste à payer = montant_ttc − SUM(paiements), vrai par construction.
--
-- IDEMPOTENCE : un règlement issu d'un encaissement ou d'un lettrage bancaire ne peut
-- être inséré deux fois (index uniques partiels sur encaissement_id / transaction_id).
-- C'est ce qui remplace la garde `montant_paye < 1` de lier_transaction, laquelle
-- bloquait à tort les paiements PARTIELS successifs (2ᵉ acompte ignoré silencieusement).
--
-- ⚠️  COUPLAGE CODE À DÉPLOYER EN MÊME TEMPS (voir la migration 2 + le checklist) :
--     une fois le trigger en place, tout code qui FAIT `UPDATE ... SET montant_paye = ...`
--     à la main doit passer par un INSERT dans `paiements`, sinon double comptage.

-- ── 1. Table des paiements ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.paiements (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dossier_id             uuid NOT NULL REFERENCES public.dossiers(id) ON DELETE CASCADE,
  -- Exactement une des deux FK est renseignée (contrainte plus bas).
  facture_id             uuid REFERENCES public.factures(id) ON DELETE CASCADE,
  facture_fournisseur_id uuid REFERENCES public.factures_fournisseurs(id) ON DELETE CASCADE,
  montant                numeric(15,2) NOT NULL CHECK (montant > 0),
  date_paiement          date NOT NULL DEFAULT CURRENT_DATE,
  -- Provenance du flux, pour l'audit et pour délier proprement.
  origine                text NOT NULL CHECK (origine IN ('encaissement','lettrage','manuel')),
  -- Rattachement à la pièce d'origine (null si saisie manuelle directe).
  encaissement_id        uuid REFERENCES public.encaissements(id) ON DELETE SET NULL,
  transaction_id         uuid REFERENCES public.transactions_bancaires(id) ON DELETE SET NULL,
  reference              text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  -- Un paiement s'impute à UNE facture (vente XOR achat), jamais aux deux ni à aucune.
  CONSTRAINT paiements_une_seule_facture
    CHECK ( (facture_id IS NOT NULL)::int + (facture_fournisseur_id IS NOT NULL)::int = 1 )
);

-- Idempotence : une pièce (encaissement / ligne de relevé lettrée) = au plus un paiement.
CREATE UNIQUE INDEX IF NOT EXISTS paiements_uq_encaissement
  ON public.paiements(encaissement_id) WHERE encaissement_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS paiements_uq_transaction
  ON public.paiements(transaction_id)  WHERE transaction_id  IS NOT NULL;

-- Accès aux soldes par facture (le trigger et la balance âgée agrègent dessus).
CREATE INDEX IF NOT EXISTS paiements_facture_idx      ON public.paiements(facture_id)             WHERE facture_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS paiements_facture_four_idx ON public.paiements(facture_fournisseur_id) WHERE facture_fournisseur_id IS NOT NULL;

ALTER TABLE public.paiements ENABLE ROW LEVEL SECURITY;

-- RLS alignée sur factures : un utilisateur voit/écrit les paiements des dossiers
-- auxquels il a accès. On réutilise la même logique d'appartenance que le reste du schéma.
DROP POLICY IF EXISTS paiements_acces_dossier ON public.paiements;
CREATE POLICY paiements_acces_dossier ON public.paiements
  USING (dossier_id IN (SELECT dossier_id FROM public.dossier_access WHERE user_id = auth.uid()))
  WITH CHECK (dossier_id IN (SELECT dossier_id FROM public.dossier_access WHERE user_id = auth.uid()));

-- ── 2. Recalcul du solde d'une facture depuis ses paiements ──────────────────
-- Seuil de solde à 1 MAD, cohérent avec l'existant (arrondis TVA, RPC lier_transaction).
CREATE OR REPLACE FUNCTION public.recalc_solde_facture(p_facture_id uuid, p_kind text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_paye numeric;
BEGIN
  IF p_facture_id IS NULL THEN RETURN; END IF;

  IF p_kind = 'client' THEN
    SELECT COALESCE(SUM(montant),0) INTO v_paye
      FROM public.paiements WHERE facture_id = p_facture_id;
    UPDATE public.factures f
       SET montant_paye    = v_paye,
           montant_restant = GREATEST(0, f.montant_ttc - v_paye),
           statut_paiement = (CASE
                                WHEN v_paye <= 0                       THEN 'non_payee'
                                WHEN f.montant_ttc - v_paye <= 1       THEN 'payee'
                                ELSE 'partielle' END)::public.statut_paiement,
           date_paiement   = (SELECT MAX(date_paiement) FROM public.paiements WHERE facture_id = p_facture_id)
     WHERE f.id = p_facture_id;

  ELSIF p_kind = 'fournisseur' THEN
    SELECT COALESCE(SUM(montant),0) INTO v_paye
      FROM public.paiements WHERE facture_fournisseur_id = p_facture_id;
    UPDATE public.factures_fournisseurs ff
       SET montant_paye    = v_paye,
           montant_restant = GREATEST(0, ff.montant_ttc - v_paye),
           statut_paiement = (CASE
                                WHEN v_paye <= 0                        THEN 'non_payee'
                                WHEN ff.montant_ttc - v_paye <= 1       THEN 'payee'
                                ELSE 'partielle' END)::public.statut_paiement,
           date_paiement   = (SELECT MAX(date_paiement) FROM public.paiements WHERE facture_fournisseur_id = p_facture_id)
     WHERE ff.id = p_facture_id;
  END IF;
END $$;

-- ── 3. Trigger : tout mouvement de paiement resynchronise la (ou les) facture(s) ──
CREATE OR REPLACE FUNCTION public.trg_paiements_resync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Ligne supprimée ou déplacée : recalcule l'ancienne facture.
  IF (TG_OP = 'DELETE' OR TG_OP = 'UPDATE') THEN
    PERFORM public.recalc_solde_facture(OLD.facture_id, 'client');
    PERFORM public.recalc_solde_facture(OLD.facture_fournisseur_id, 'fournisseur');
  END IF;
  -- Ligne créée ou modifiée : recalcule la nouvelle facture.
  IF (TG_OP = 'INSERT' OR TG_OP = 'UPDATE') THEN
    PERFORM public.recalc_solde_facture(NEW.facture_id, 'client');
    PERFORM public.recalc_solde_facture(NEW.facture_fournisseur_id, 'fournisseur');
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS paiements_resync ON public.paiements;
CREATE TRIGGER paiements_resync
  AFTER INSERT OR UPDATE OR DELETE ON public.paiements
  FOR EACH ROW EXECUTE FUNCTION public.trg_paiements_resync();

-- ── 4. Backfill : reconstruire l'historique des règlements déjà réalisés ──────
-- Les deux sources qui ont réellement soldé des factures jusqu'ici.

-- 4a. Encaissements saisis (espèces / chèque / virement) rattachés à une facture.
INSERT INTO public.paiements
  (dossier_id, facture_id, facture_fournisseur_id, montant, date_paiement, origine, encaissement_id, reference)
SELECT e.dossier_id, e.facture_id, e.facture_fournisseur_id, e.montant,
       COALESCE(e.date_encaissement, e.created_at::date), 'encaissement', e.id, e.reference
  FROM public.encaissements e
 WHERE COALESCE(e.valide, true) = true
   AND e.montant > 0
   AND (e.facture_id IS NOT NULL OR e.facture_fournisseur_id IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM public.paiements p WHERE p.encaissement_id = e.id);

-- 4b. Lignes de relevé bancaire lettrées à une facture (via lier_transaction).
INSERT INTO public.paiements
  (dossier_id, facture_id, facture_fournisseur_id, montant, date_paiement, origine, transaction_id)
SELECT t.dossier_id,
       CASE WHEN t.document_type = 'facture_fournisseur' THEN NULL ELSE t.facture_id END,
       CASE WHEN t.document_type = 'facture_fournisseur' THEN t.facture_id ELSE NULL END,
       ABS(t.montant), COALESCE(t.date_operation, CURRENT_DATE), 'lettrage', t.id
  FROM public.transactions_bancaires t
 WHERE t.facture_id IS NOT NULL
   AND ABS(t.montant) > 0
   AND NOT EXISTS (SELECT 1 FROM public.paiements p WHERE p.transaction_id = t.id);

-- ── 5. Recalcul GÉNÉRAL : réparer TOUTES les factures, y compris celles sans
--       aucun paiement (les 8 lignes à montant_restant faux, et les factures
--       marquées « payée » par le bouton sans montant enregistré).
--       Le trigger n'a couvert que les factures touchées par le backfill ; ce
--       balayage final rétablit l'invariant partout.
--       CONSÉQUENCE ASSUMÉE : une facture passée « payée » via le bouton sans
--       montant enregistré redevient non_payee (aucun paiement réel n'existe).
--       C'est l'état honnête ; il faudra y saisir un paiement réel si elle l'était.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM public.factures LOOP
    PERFORM public.recalc_solde_facture(r.id, 'client');
  END LOOP;
  FOR r IN SELECT id FROM public.factures_fournisseurs LOOP
    PERFORM public.recalc_solde_facture(r.id, 'fournisseur');
  END LOOP;
END $$;

COMMENT ON TABLE public.paiements IS
  'Source de vérité des règlements. factures.montant_paye/montant_restant sont dérivées '
  '(trigger paiements_resync) : ne jamais les écrire à la main. Reste à payer = TTC − SUM(paiements).';
