-- ════════════════════════════════════════════════════════════════════════════
-- 20260909120000_verrou_concurrence_reglements.sql
--
-- Rend le contrôle de non-dépassement RÉSISTANT À LA CONCURRENCE.
--
-- DÉPEND de 20260908120000_verrous_reglements.sql, qu'il faut appliquer d'abord :
-- cette migration ne fait que remplacer deux fonctions qu'elle crée.
--
-- ⚠ DEUX PIÈGES D'ORDRE, tous deux constatés en vrai le 2026-09-09 ⚠
--
--   1. L'APPLIQUER SEULE CASSE LA TABLE `paiements`. Elle réinstalle le trigger
--      `paiements_valider`, dont le corps appelle `emission_facture()` — créée
--      par 20260908120000 et par elle seule. Sans cette fonction, TOUT INSERT ou
--      UPDATE sur `paiements` échoue en 42883, quelle que soit son origine :
--      plus aucun règlement ne peut être enregistré, ni par l'application, ni
--      par le rapprochement, ni par un script de reprise. Les LECTURES, elles,
--      continuent — la panne est donc invisible tant qu'on ne tente pas d'écrire.
--      Le garde ci-dessous refuse désormais ce scénario au lieu de le produire.
--
--   2. RÉAPPLIQUER 20260908120000 APRÈS CELLE-CI REGRESSE LE VERROU. Les deux
--      migrations font `CREATE OR REPLACE` sur `trg_paiements_valider` et sur
--      `enregistrer_reglement` : la dernière écrite gagne. Repasser l'ancienne
--      remet les versions SANS `FOR UPDATE`, et le surpaiement concurrentiel
--      redevient possible — silencieusement, puisque le test unitaire séquentiel
--      continue de passer.
--
--      => Après toute réapplication de 20260908120000, REPASSER CELLE-CI.
--         L'ordre correct, en reprise comme en installation neuve, est :
--           1) 20260908120000_verrous_reglements.sql
--           2) 20260909120000_verrou_concurrence_reglements.sql   (ce fichier)
--         `tests/concurrency-locks.test.ts` est ce qui le vérifie.

-- ── 0. Garde de dépendance ───────────────────────────────────────────────────
-- Un DO block plutôt qu'un commentaire : un avertissement en tête de fichier ne
-- protège que celui qui l'a lu, et le SQL editor du dashboard invite justement à
-- coller sans lire. Le message dit quoi faire, pas seulement ce qui manque.
DO $$
BEGIN
  IF to_regprocedure('public.emission_facture(uuid, text)') IS NULL THEN
    RAISE EXCEPTION
      E'Dépendance absente : public.emission_facture(uuid, text).\n'
      'Cette migration REMPLACE un trigger qui l''appelle : l''appliquer maintenant\n'
      'rendrait toute écriture dans `paiements` impossible (SQLSTATE 42883).\n'
      'Appliquez d''abord 20260908120000_verrous_reglements.sql, puis celle-ci.'
      USING ERRCODE = 'undefined_function';
  END IF;
END $$;
--
-- ─── Le défaut, et pourquoi aucune relecture ne le montre ────────────────────
-- La migration précédente pose la bonne règle : la somme des règlements ne
-- dépasse pas le TTC. Le trigger la vérifie ainsi —
--
--     SELECT COALESCE(SUM(p.montant), 0) INTO v_cumul FROM public.paiements p
--      WHERE (p.facture_id = NEW.facture_id OR …);
--     IF v_cumul > 0 AND v_cumul + NEW.montant > v_ttc + 1 THEN RAISE …
--
-- — et c'est juste, tant que les règlements arrivent l'un APRÈS l'autre.
--
-- En parallèle, ça ne l'est plus. PostgreSQL tourne par défaut en READ
-- COMMITTED, et Supabase ne change pas ce réglage : chaque transaction lit un
-- instantané qui ignore ce que les autres n'ont pas encore commité. Vingt
-- appels simultanés sur une facture de 10 000 MAD lisent donc tous
-- `v_cumul = 0`. La garde `v_cumul > 0` ne s'arme pour AUCUN d'eux — elle est
-- pourtant délibérée, elle autorise un premier versement en trop-perçu — et les
-- vingt lignes s'insèrent. La facture porte 200 000 MAD encaissés pour 10 000
-- dus, sans qu'aucune contrainte n'ait été violée au sens de PostgreSQL.
--
-- Le même raisonnement condamne l'idempotence : deux réessais concurrents de la
-- MÊME pièce ne se voient pas l'un l'autre, passent tous deux le `SELECT id`
-- d'idempotence, et le second meurt sur l'index unique — une erreur brute là où
-- la fonction promet de rendre l'état existant.
--
-- ─── Le remède : sérialiser sur la FACTURE, pas sur les paiements ────────────
-- `SELECT … FOR UPDATE` sur la ligne de la facture, AVANT de compter. Les
-- transactions concurrentes se mettent en file derrière cette ligne ; la
-- première commite, les suivantes reprennent leur lecture APRÈS son commit
-- (READ COMMITTED relit la ligne verrouillée) et voient enfin le cumul réel.
--
-- Pourquoi la facture et non les paiements : on ne peut pas verrouiller des
-- lignes qui n'existent pas encore. Le premier règlement d'une facture n'a
-- aucune ligne `paiements` à opposer — c'est précisément le cas dangereux. La
-- facture, elle, existe toujours : elle sert de point de rendez-vous.
--
-- Pourquoi dans le TRIGGER et pas seulement dans la RPC : quatre chemins
-- écrivent dans `paiements` (le modal de règlement, `lier_transaction`, le
-- rebuild `synchroniser_paiements_dossier`, la console SQL des scripts de
-- reprise). Un verrou posé dans la seule RPC laisserait les trois autres
-- courir. La RPC prend le verrou elle aussi, mais pour une autre raison : rendre
-- son idempotence fiable, ce que le trigger ne peut pas faire à sa place.
--
-- ─── Ce que ça NE fait PAS ───────────────────────────────────────────────────
-- Aucun changement de règle métier. Le premier versement reste autorisé à
-- dépasser le TTC (trop-perçu constaté), l'antériorité et l'unicité sont
-- inchangées. Cette migration ne fait que rendre EFFECTIF, sous charge, un
-- contrôle qui l'était déjà en séquentiel.
--
-- Coût : le verrou ne porte que sur les règlements de la MÊME facture. Deux
-- règlements de deux factures différentes ne s'attendent jamais.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Le point de rendez-vous ───────────────────────────────────────────────
-- Une fonction dédiée plutôt qu'un `SELECT … FOR UPDATE` recopié aux deux
-- endroits : le jour où une troisième fonction doit prendre le même verrou, elle
-- appellera celle-ci et ne pourra pas verrouiller une autre ligne que les deux
-- premières. Deux verrous pris dans un ordre différent, c'est un interblocage.
CREATE OR REPLACE FUNCTION public.verrouiller_facture(p_facture uuid, p_kind text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ignore uuid;
BEGIN
  IF p_facture IS NULL THEN RETURN; END IF;
  IF p_kind = 'client' THEN
    SELECT f.id INTO v_ignore FROM public.factures f WHERE f.id = p_facture FOR UPDATE;
  ELSE
    SELECT ff.id INTO v_ignore FROM public.factures_fournisseurs ff
     WHERE ff.id = p_facture FOR UPDATE;
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION public.verrouiller_facture(uuid, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.verrouiller_facture(uuid, text) IS
  'Verrou de ligne sur la facture, pris AVANT tout calcul de cumul de règlements. '
  'Sérialise les écritures concurrentes sur une même pièce ; deux pièces '
  'différentes ne s''attendent jamais.';

-- ── 2. Le trigger de validation, désormais sérialisé ─────────────────────────
-- Identique à la version de 20260908120000 pour toute la règle métier. Seul
-- ajout : le verrou, pris juste avant le SELECT de cumul.
CREATE OR REPLACE FUNCTION public.trg_paiements_valider()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_facture   uuid;
  v_kind      text;
  v_emission  date;
  v_ttc       numeric;
  v_numero    text;
  v_date_tx   date;
  v_cumul     numeric;
  c_tolerance CONSTANT numeric := 1;
BEGIN
  IF NEW.facture_id IS NOT NULL THEN
    v_facture := NEW.facture_id; v_kind := 'client';
  ELSE
    v_facture := NEW.facture_fournisseur_id; v_kind := 'fournisseur';
  END IF;

  SELECT e.date_emission, e.montant_ttc, e.numero
    INTO v_emission, v_ttc, v_numero
    FROM public.emission_facture(v_facture, v_kind) e;

  IF v_ttc IS NULL AND v_emission IS NULL THEN RETURN NEW; END IF;

  -- ── Invariant 1a : antériorité de la DATE DE RÈGLEMENT ────────────────────
  IF v_emission IS NOT NULL AND NEW.date_paiement IS NOT NULL
     AND NEW.date_paiement < v_emission THEN
    RAISE EXCEPTION
      'Règlement du % antérieur à l''émission de la facture % (%) : une facture ne peut pas être réglée avant d''exister.',
      NEW.date_paiement, COALESCE(v_numero, v_facture::text), v_emission
      USING ERRCODE = 'check_violation';
  END IF;

  -- ── Invariant 1b : antériorité de la PIÈCE BANCAIRE ──────────────────────
  IF NEW.transaction_id IS NOT NULL AND v_emission IS NOT NULL THEN
    SELECT t.date_operation INTO v_date_tx
      FROM public.transactions_bancaires t WHERE t.id = NEW.transaction_id;
    IF v_date_tx IS NOT NULL AND v_date_tx < v_emission THEN
      RAISE EXCEPTION
        'Pièce bancaire du % antérieure à la facture % (%) : cette ligne de relevé ne peut pas la régler.',
        v_date_tx, COALESCE(v_numero, v_facture::text), v_emission
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- ── Invariant 3 : non-dépassement CUMULATIF du TTC, sérialisé ────────────
  IF v_ttc IS NOT NULL AND v_ttc > 0 THEN
    -- LE VERROU. Sans cette ligne, vingt transactions concurrentes lisent
    -- chacune un cumul de 0 et s'insèrent toutes : le contrôle ci-dessous est
    -- juste, et pourtant inopérant. Il doit être pris AVANT le SUM, jamais
    -- après — un verrou posé après la lecture ne protège plus rien.
    PERFORM public.verrouiller_facture(v_facture, v_kind);

    SELECT COALESCE(SUM(p.montant), 0) INTO v_cumul
      FROM public.paiements p
     WHERE (p.facture_id = NEW.facture_id OR p.facture_fournisseur_id = NEW.facture_fournisseur_id)
       AND (TG_OP <> 'UPDATE' OR p.id <> NEW.id);

    -- `v_cumul > 0` reste la règle : un PREMIER règlement supérieur au TTC est
    -- un trop-perçu réellement encaissé, et le refuser laisserait la facture
    -- impayée. Ce qui est fautif, c'est le règlement qui déborde APRÈS un autre.
    IF v_cumul > 0 AND v_cumul + NEW.montant > v_ttc + c_tolerance THEN
      RAISE EXCEPTION
        'Règlement de % sur la facture % : % déjà encaissés pour % dus. Un trop-perçu se constate par un avoir ou au 4191, pas par un paiement.',
        NEW.montant, COALESCE(v_numero, v_facture::text), v_cumul, v_ttc
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS paiements_valider ON public.paiements;
CREATE TRIGGER paiements_valider
  BEFORE INSERT OR UPDATE ON public.paiements
  FOR EACH ROW EXECUTE FUNCTION public.trg_paiements_valider();

-- ── 3. `enregistrer_reglement` : une idempotence qui tient sous charge ───────
-- Identique à la version de 20260908120000, verrou en plus. Il est pris AVANT
-- la recherche de la pièce déjà enregistrée : sans lui, deux réessais
-- concurrents du même encaissement ne se voient pas, passent tous deux le
-- `SELECT id`, et le second meurt sur l'index unique. Une fonction qui promet
-- d'être rejouable ne peut pas rendre une erreur brute au réessai.
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
BEGIN
  IF p_kind NOT IN ('client', 'fournisseur') THEN
    RAISE EXCEPTION 'Sens de facture inconnu : %', p_kind USING ERRCODE = 'check_violation';
  END IF;

  -- Même point de rendez-vous que le trigger, et pris dans le même ordre : la
  -- facture d'abord, ses paiements ensuite. Un ordre inverse ici produirait un
  -- interblocage avec les écritures qui passent par le trigger seul.
  PERFORM public.verrouiller_facture(p_facture, p_kind);

  IF p_transaction IS NOT NULL THEN
    SELECT id INTO v_id FROM public.paiements WHERE transaction_id = p_transaction;
  ELSIF p_encaissement IS NOT NULL THEN
    SELECT id INTO v_id FROM public.paiements WHERE encaissement_id = p_encaissement;
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

GRANT EXECUTE ON FUNCTION public.enregistrer_reglement(uuid, uuid, text, numeric, date, text, uuid, uuid, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.enregistrer_reglement(uuid, uuid, text, numeric, date, text, uuid, uuid, text) IS
  'Enregistrement ATOMIQUE et SÉRIALISÉ d''un règlement : verrou de ligne sur la '
  'facture, validation, insertion, recalcul et restitution de l''état final en une '
  'transaction. Idempotente sur la pièce, y compris sous réessais concurrents. '
  'Éprouvée par tests/concurrency-locks.test.ts (20 appels simultanés).';
