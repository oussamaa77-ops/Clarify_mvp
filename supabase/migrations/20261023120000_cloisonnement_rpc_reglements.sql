-- ════════════════════════════════════════════════════════════════════════════
-- 20261023120000_cloisonnement_rpc_reglements.sql
--
-- FERME UNE FUITE ENTRE CABINETS dans les RPC de règlement.
--
-- DÉPEND de 20260908120000 puis 20260909120000, dans cet ordre. Elle REMPLACE
-- leurs fonctions : réappliquer l'une d'elles après celle-ci ROUVRE la faille
-- (CREATE OR REPLACE, la dernière écrite gagne). L'ordre correct est donc :
--   1) 20260908120000_verrous_reglements.sql
--   2) 20260909120000_verrou_concurrence_reglements.sql
--   3) 20261023120000_cloisonnement_rpc_reglements.sql   (ce fichier)
--
-- ─── Le défaut ───────────────────────────────────────────────────────────────
-- `enregistrer_reglement`, `lier_transaction`, `delier_transaction` et
-- `synchroniser_paiements_dossier` sont SECURITY DEFINER : elles s'exécutent
-- avec les droits du propriétaire, donc HORS RLS. Elles sont ouvertes à
-- `authenticated` (et, par le défaut PUBLIC de PostgreSQL, à `anon`), et aucune
-- ne vérifiait que l'appelant a accès au dossier visé. N'importe quel compte
-- connecté pouvait donc, par un simple `rpc(...)` :
--   • insérer un règlement dans les livres d'un autre cabinet ;
--   • lettrer / délettrer ses lignes de relevé ;
--   • effacer puis reconstruire tous ses paiements dérivés.
-- `verrouiller_facture`, `emission_facture` et `recalc_solde_facture`, purement
-- internes, étaient eux aussi appelables : verrou de ligne sur la facture d'un
-- tiers, lecture de son numéro / TTC / date. Et la vue
-- `v_liens_bancaires_impossibles`, créée sans `security_invoker`, exposait les
-- lignes de relevé de TOUS les dossiers.
--
-- ─── Le remède ───────────────────────────────────────────────────────────────
-- Une garde unique, `exiger_acces_dossier`, appelée en tête de chaque RPC, et
-- un contrôle que chaque pièce citée (facture, transaction, encaissement,
-- justificatif) appartient bien au dossier contrôlé — sans lui, un appelant
-- pourrait passer SON dossier et la facture d'un AUTRE.
--
-- Corps des fonctions : identiques à 20260909120000 / 20260908120000, à
-- l'exception des seuls contrôles ajoutés (marqués « CLOISONNEMENT »).
-- ════════════════════════════════════════════════════════════════════════════

-- ── 0. Garde de dépendance ───────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regprocedure('public.verrouiller_facture(uuid, text)') IS NULL THEN
    RAISE EXCEPTION
      E'Dépendance absente : public.verrouiller_facture(uuid, text).\n'
      'Appliquez d''abord 20260908120000_verrous_reglements.sql, puis\n'
      '20260909120000_verrou_concurrence_reglements.sql, puis celle-ci.'
      USING ERRCODE = 'undefined_function';
  END IF;
END $$;

-- ── 1. La garde ──────────────────────────────────────────────────────────────
-- Qui est de confiance :
--   • une connexion directe à la base (console SQL, migrations, scripts `pg`) :
--     elle n'arrive pas par PostgREST, son session_user n'est pas `authenticator` ;
--   • un appel PostgREST avec la clé service_role (serveur, scripts de reprise).
-- Tout le reste — `authenticated` comme `anon` — doit avoir accès au dossier.
-- `auth.uid()` est NULL pour `anon` : has_dossier_access rend alors false.
CREATE OR REPLACE FUNCTION public.exiger_acces_dossier(p_dossier uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF session_user <> 'authenticator' THEN RETURN; END IF;
  IF COALESCE(auth.role(), '') = 'service_role' THEN RETURN; END IF;

  IF p_dossier IS NULL OR NOT public.has_dossier_access(auth.uid(), p_dossier) THEN
    RAISE EXCEPTION 'Accès refusé au dossier %.', COALESCE(p_dossier::text, '(inconnu)')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.exiger_acces_dossier(uuid) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.exiger_acces_dossier(uuid) IS
  'Garde de cloisonnement des RPC SECURITY DEFINER : lève 42501 si l''appelant '
  'PostgREST (hors service_role) n''a pas accès au dossier.';

-- ── 2. `enregistrer_reglement` ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enregistrer_reglement(
  p_dossier    uuid,
  p_facture    uuid,
  p_kind       text,
  p_montant    numeric,
  p_date       date,
  p_origine    text DEFAULT 'manuel',
  p_transaction uuid DEFAULT NULL,
  p_encaissement uuid DEFAULT NULL,
  p_reference  text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id       uuid;
  v_etat     jsonb;
  v_deja     boolean := false;
  v_lie_a    uuid;
BEGIN
  IF p_kind NOT IN ('client', 'fournisseur') THEN
    RAISE EXCEPTION 'Sens de facture inconnu : %', p_kind USING ERRCODE = 'check_violation';
  END IF;

  -- CLOISONNEMENT — l'appelant a accès au dossier, et chaque pièce citée en fait
  -- partie. Contrôlé AVANT le verrou : on ne pose pas de verrou sur la ligne
  -- d'un autre cabinet.
  PERFORM public.exiger_acces_dossier(p_dossier);
  IF p_kind = 'client' THEN
    PERFORM 1 FROM public.factures f WHERE f.id = p_facture AND f.dossier_id = p_dossier;
  ELSE
    PERFORM 1 FROM public.factures_fournisseurs ff WHERE ff.id = p_facture AND ff.dossier_id = p_dossier;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Facture % introuvable dans le dossier %.', p_facture, p_dossier
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_transaction IS NOT NULL THEN
    PERFORM 1 FROM public.transactions_bancaires t WHERE t.id = p_transaction AND t.dossier_id = p_dossier;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Ligne de relevé % introuvable dans le dossier %.', p_transaction, p_dossier
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF p_encaissement IS NOT NULL THEN
    PERFORM 1 FROM public.encaissements e WHERE e.id = p_encaissement AND e.dossier_id = p_dossier;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Encaissement % introuvable dans le dossier %.', p_encaissement, p_dossier
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  -- Même point de rendez-vous que le trigger, et pris dans le même ordre : la
  -- facture d'abord, ses paiements ensuite.
  PERFORM public.verrouiller_facture(p_facture, p_kind);

  IF p_transaction IS NOT NULL THEN
    SELECT id, COALESCE(facture_id, facture_fournisseur_id) INTO v_id, v_lie_a
      FROM public.paiements WHERE transaction_id = p_transaction;
  ELSIF p_encaissement IS NOT NULL THEN
    SELECT id, COALESCE(facture_id, facture_fournisseur_id) INTO v_id, v_lie_a
      FROM public.paiements WHERE encaissement_id = p_encaissement;
  END IF;

  -- La pièce déjà enregistrée l'est-elle bien sur CETTE facture ? Sinon, rendre
  -- « déjà enregistré » ferait croire à l'appelant que p_facture est réglée.
  IF v_id IS NOT NULL AND v_lie_a IS DISTINCT FROM p_facture THEN
    RAISE EXCEPTION 'Cette pièce règle déjà une autre facture (%) : elle ne peut pas régler %.', v_lie_a, p_facture
      USING ERRCODE = 'unique_violation';
  END IF;

  IF v_id IS NOT NULL THEN
    v_deja := true;
  ELSE
    INSERT INTO public.paiements
      (dossier_id, facture_id, facture_fournisseur_id, montant, date_paiement,
       origine, transaction_id, encaissement_id, reference)
    VALUES
      (p_dossier,
       CASE WHEN p_kind = 'client'      THEN p_facture END,
       CASE WHEN p_kind = 'fournisseur' THEN p_facture END,
       ROUND(p_montant, 2), COALESCE(p_date, CURRENT_DATE),
       p_origine, p_transaction, p_encaissement, p_reference)
    RETURNING id INTO v_id;
  END IF;

  IF p_kind = 'client' THEN
    SELECT jsonb_build_object(
      'montant_ttc', f.montant_ttc, 'montant_paye', f.montant_paye,
      'montant_restant', f.montant_restant, 'statut_paiement', f.statut_paiement,
      'date_paiement', f.date_paiement)
      INTO v_etat FROM public.factures f WHERE f.id = p_facture;
  ELSE
    SELECT jsonb_build_object(
      'montant_ttc', ff.montant_ttc, 'montant_paye', ff.montant_paye,
      'montant_restant', ff.montant_restant, 'statut_paiement', ff.statut_paiement,
      'date_paiement', ff.date_paiement)
      INTO v_etat FROM public.factures_fournisseurs ff WHERE ff.id = p_facture;
  END IF;

  RETURN jsonb_build_object('paiement_id', v_id, 'deja_enregistre', v_deja, 'facture', v_etat);
END $$;

REVOKE EXECUTE ON FUNCTION public.enregistrer_reglement(uuid, uuid, text, numeric, date, text, uuid, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.enregistrer_reglement(uuid, uuid, text, numeric, date, text, uuid, uuid, text)
  TO authenticated, service_role;

-- ── 3. `lier_transaction` ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.lier_transaction(
  p_tx_id   uuid,
  p_doc_id  uuid,
  p_doc_kind text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_montant   numeric;
  v_date      date;
  v_dossier   uuid;
  v_date_tx   date;
  v_emission  date;
  v_numero    text;
  v_dossier_tx uuid;
BEGIN
  -- CLOISONNEMENT — le dossier contrôlé est celui de la ligne de relevé, et le
  -- document lettré doit en faire partie : sinon, une ligne À SOI suffirait à
  -- régler la facture d'un autre cabinet.
  SELECT t.dossier_id INTO v_dossier_tx FROM public.transactions_bancaires t WHERE t.id = p_tx_id;
  PERFORM public.exiger_acces_dossier(v_dossier_tx);
  IF v_dossier_tx IS NOT NULL THEN
    IF p_doc_kind = 'facture_client' THEN
      PERFORM 1 FROM public.factures f WHERE f.id = p_doc_id AND f.dossier_id = v_dossier_tx;
    ELSIF p_doc_kind = 'facture_fournisseur' THEN
      PERFORM 1 FROM public.factures_fournisseurs ff WHERE ff.id = p_doc_id AND ff.dossier_id = v_dossier_tx;
    ELSIF p_doc_kind = 'justificatif' THEN
      PERFORM 1 FROM public.justificatifs j WHERE j.id = p_doc_id AND j.dossier_id = v_dossier_tx;
    ELSE
      PERFORM 1;
    END IF;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Document % introuvable dans le dossier de la ligne de relevé.', p_doc_id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  IF p_doc_kind IN ('facture_client', 'facture_fournisseur') THEN
    SELECT t.date_operation INTO v_date_tx
      FROM public.transactions_bancaires t WHERE t.id = p_tx_id;
    SELECT e.date_emission, e.numero INTO v_emission, v_numero
      FROM public.emission_facture(
        p_doc_id,
        CASE WHEN p_doc_kind = 'facture_fournisseur' THEN 'fournisseur' ELSE 'client' END) e;

    IF v_date_tx IS NOT NULL AND v_emission IS NOT NULL AND v_date_tx < v_emission THEN
      RAISE EXCEPTION
        'Ligne de relevé du % antérieure à la facture % (%) : elle ne peut pas la régler.',
        v_date_tx, COALESCE(v_numero, p_doc_id::text), v_emission
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

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
    RETURN false;
  END IF;

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

REVOKE EXECUTE ON FUNCTION public.lier_transaction(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lier_transaction(uuid, uuid, text) TO authenticated, service_role;

-- ── 4. `delier_transaction` ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.delier_transaction(p_tx_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dossier_tx uuid;
BEGIN
  -- CLOISONNEMENT — une ligne inexistante ne touche rien : seule une ligne
  -- réelle est soumise au contrôle.
  SELECT t.dossier_id INTO v_dossier_tx FROM public.transactions_bancaires t WHERE t.id = p_tx_id;
  IF FOUND THEN
    PERFORM public.exiger_acces_dossier(v_dossier_tx);
  END IF;

  -- Supprime le paiement issu de cette ligne (le trigger recalcule la facture).
  DELETE FROM public.paiements WHERE transaction_id = p_tx_id;
  -- Délie la ligne bancaire sans jamais la supprimer (fait bancaire).
  UPDATE public.transactions_bancaires
     SET facture_id = NULL, justificatif_id = NULL, document_type = NULL, rapproche = false,
         statut = CASE WHEN statut = 'cloture' THEN 'cloture' ELSE 'ouvert' END
   WHERE id = p_tx_id;
  RETURN true;
END $$;

REVOKE EXECUTE ON FUNCTION public.delier_transaction(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delier_transaction(uuid) TO authenticated, service_role;

-- ── 5. `synchroniser_paiements_dossier` ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.synchroniser_paiements_dossier(p_dossier uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- CLOISONNEMENT
  PERFORM public.exiger_acces_dossier(p_dossier);

  DELETE FROM public.paiements
   WHERE dossier_id = p_dossier
     AND origine IN ('lettrage','encaissement');

  -- Lignes de relevé lettrées, à l'exclusion de celles qui PRÉCÈDENT la facture
  -- qu'elles prétendent régler.
  INSERT INTO public.paiements
    (dossier_id, facture_id, facture_fournisseur_id, montant, date_paiement, origine, transaction_id)
  SELECT t.dossier_id,
         CASE WHEN t.document_type = 'facture_fournisseur' THEN NULL ELSE t.facture_id END,
         CASE WHEN t.document_type = 'facture_fournisseur' THEN t.facture_id ELSE NULL END,
         ABS(t.montant), COALESCE(t.date_operation, CURRENT_DATE), 'lettrage', t.id
    FROM public.transactions_bancaires t
    CROSS JOIN LATERAL public.emission_facture(
      t.facture_id,
      CASE WHEN t.document_type = 'facture_fournisseur' THEN 'fournisseur' ELSE 'client' END) e
   WHERE t.dossier_id = p_dossier
     AND t.facture_id IS NOT NULL
     AND ABS(t.montant) > 0
     AND (e.date_emission IS NULL
          OR COALESCE(t.date_operation, CURRENT_DATE) >= e.date_emission);

  INSERT INTO public.paiements
    (dossier_id, facture_id, facture_fournisseur_id, montant, date_paiement, origine, encaissement_id, reference)
  SELECT e.dossier_id, e.facture_id, e.facture_fournisseur_id, e.montant,
         COALESCE(e.date_encaissement, e.created_at::date), 'encaissement', e.id, e.reference
    FROM public.encaissements e
    CROSS JOIN LATERAL public.emission_facture(
      COALESCE(e.facture_id, e.facture_fournisseur_id),
      CASE WHEN e.facture_fournisseur_id IS NOT NULL THEN 'fournisseur' ELSE 'client' END) f
   WHERE e.dossier_id = p_dossier
     AND COALESCE(e.valide, true) = true
     AND e.montant > 0
     AND (e.facture_id IS NOT NULL OR e.facture_fournisseur_id IS NOT NULL)
     AND (f.date_emission IS NULL
          OR COALESCE(e.date_encaissement, e.created_at::date) >= f.date_emission);
END $$;

REVOKE EXECUTE ON FUNCTION public.synchroniser_paiements_dossier(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.synchroniser_paiements_dossier(uuid) TO authenticated, service_role;

-- ── 6. Fonctions internes : plus appelables depuis l'API ─────────────────────
-- Elles ne servent qu'aux triggers et aux RPC ci-dessus, qui tournent sous le
-- propriétaire : retirer EXECUTE aux rôles API ne les gêne pas.
REVOKE EXECUTE ON FUNCTION public.verrouiller_facture(uuid, text)   FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.emission_facture(uuid, text)      FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.recalc_solde_facture(uuid, text)  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.verrouiller_facture(uuid, text)   TO service_role;
GRANT  EXECUTE ON FUNCTION public.emission_facture(uuid, text)      TO service_role;
GRANT  EXECUTE ON FUNCTION public.recalc_solde_facture(uuid, text)  TO service_role;

-- ── 7. Vue d'audit : réservée au serveur ─────────────────────────────────────
-- Seuls les scripts de contrôle (service_role) la lisent. security_invoker en
-- plus, pour qu'un futur GRANT ne la rouvre pas hors RLS.
ALTER VIEW public.v_liens_bancaires_impossibles SET (security_invoker = true);
REVOKE ALL ON public.v_liens_bancaires_impossibles FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_liens_bancaires_impossibles TO service_role;
