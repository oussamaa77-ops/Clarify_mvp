-- ════════════════════════════════════════════════════════════════════════════
-- 20260908120000_verrous_reglements.sql
--
-- Rend la chaîne Facture ⇄ Paiement ⇄ Tiers ⇄ Trésorerie IMPOSSIBLE à
-- désynchroniser, en portant les invariants là où aucun chemin ne les contourne.
--
-- ─── Ce qui a réellement échoué ──────────────────────────────────────────────
-- La migration 20260710130000 avait fait de `paiements` la source du reste dû, et
-- un trigger recalcule bien montant_paye / montant_restant / statut. Cette moitié
-- a tenu : aucune facture de la base ne porte de montants contradictoires.
--
-- L'autre moitié manquait : RIEN ne disait ce qu'un paiement a le droit d'être.
-- Le dossier SMERT WATER en montre les trois conséquences, sur des lignes que
-- toutes les contraintes existantes acceptaient sans broncher :
--
--   • FA 0005 (AGAF, 50 400 MAD) — réglée le 02/03/2026 pour une facture émise le
--     11/03/2026, soit NEUF JOURS avant son existence ;
--   • FA-2026-0084 (31 572 MAD) — réglée le 10/03/2026 pour une facture du
--     17/05/2026, SOIXANTE-HUIT JOURS avant ;
--   • FAC002_2026 (REPERAL, 14 785 MAD) — adossée à un chèque du 16/07/**2024**,
--     pour une facture du 20/06/2026. La ligne bancaire est authentique, elle
--     figure sur un relevé ; elle a simplement près de deux ans de trop.
--
-- Ces trois factures s'affichaient soldées. Le grand livre, lui, n'en savait rien :
-- le compte 3421 restait ouvert de 81 972 MAD. Et parce que
-- `synchroniser_paiements_dossier` RECONSTRUIT les paiements depuis
-- `transactions_bancaires.facture_id`, toute correction faite à la main sur la
-- table `paiements` était défaite au rapprochement suivant. Le défaut se
-- réinstallait tout seul.
--
-- ─── Les quatre invariants, et où ils vivent désormais ───────────────────────
--   1. ANTÉRIORITÉ — un règlement ne précède pas l'émission de ce qu'il règle.
--      Contrôlé sur la date du paiement ET sur celle de la pièce bancaire qui le
--      justifie : c'est la seconde qui manquait pour REPERAL, dont la date de
--      paiement avait été recalée sur 2026 alors que son chèque restait en 2024.
--   2. UNICITÉ — une pièce règle une fois. Les index uniques existants couvrent
--      la transaction et l'encaissement ; celui d'ici couvre la SAISIE MANUELLE,
--      seul chemin qui restait ouvert au double clic.
--   3. NON-DÉPASSEMENT — la somme des règlements ne dépasse pas le TTC. Au-delà,
--      ce n'est plus un règlement de cette facture : c'est un trop-perçu, qui
--      relève d'un avoir ou du 4191.
--   4. ATOMICITÉ — `enregistrer_reglement` fait l'insertion, le recalcul de la
--      facture et la restitution de l'état final en UN appel, donc en UNE
--      transaction. Une erreur à mi-chemin ne laisse plus une facture marquée
--      payée sans paiement, ni l'inverse.
--
-- ─── Pourquoi en base et pas seulement en TypeScript ─────────────────────────
-- `src/lib/reglements.ts` porte les mêmes règles, et c'est lui que l'écran
-- consulte pour refuser une saisie avant de l'envoyer. Mais quatre chemins
-- écrivent dans `paiements` — le modal de règlement, `lier_transaction`, le
-- rebuild `synchroniser_paiements_dossier`, et la console SQL des scripts de
-- reprise. Une règle qui ne vit que dans l'un d'eux n'est pas une règle.
--
-- ─── Ce que la migration NE fait PAS ─────────────────────────────────────────
-- Elle ne corrige AUCUNE donnée. Les trois paiements fautifs de SMERT restent en
-- place après son application : les défaire suppose de délier des écritures et
-- une bascule de TVA, ce qui relève d'un script sauvegardé et réversible
-- (`scripts/corriger-reglements-dossier.ts`), pas d'un DDL.
--
-- Vérifié avant écriture, sur la base de production : 11 paiements, 0 doublon,
-- 0 surpaiement, 2 antériorités (les deux de SMERT). Aucune contrainte posée ici
-- n'est donc violée par l'existant, à l'exception de ces deux lignes — que les
-- triggers laissent en place et que seul le script corrige.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Émission d'une facture, quel que soit son sens ────────────────────────
-- Un seul endroit pour répondre « de quand date cette facture, et combien
-- vaut-elle » : le trigger, la RPC de saisie et le rebuild s'y adossent tous
-- les trois. Dupliquer ce CASE aurait suffi à les faire diverger.
CREATE OR REPLACE FUNCTION public.emission_facture(
  p_facture_id uuid, p_kind text,
  OUT date_emission date, OUT montant_ttc numeric, OUT numero text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_facture_id IS NULL THEN RETURN; END IF;
  IF p_kind = 'client' THEN
    SELECT f.date_facture, f.montant_ttc, f.numero
      INTO date_emission, montant_ttc, numero
      FROM public.factures f WHERE f.id = p_facture_id;
  ELSE
    SELECT ff.date_facture, ff.montant_ttc, ff.numero
      INTO date_emission, montant_ttc, numero
      FROM public.factures_fournisseurs ff WHERE ff.id = p_facture_id;
  END IF;
END $$;

-- ── 2. Le verrou : ce qu'un paiement a le droit d'être ───────────────────────
-- BEFORE, et non AFTER : on refuse la ligne, on ne répare pas après coup.
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
  -- Même tolérance que `statutDepuisMontants` et que la RPC lier_transaction.
  -- Un seul seuil dans toute la chaîne : deux seuils différents produiraient une
  -- facture « payée » à l'écran et « partielle » en base.
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

  -- Facture introuvable : les FK s'en chargent, ce trigger n'a rien à ajouter.
  IF v_ttc IS NULL AND v_emission IS NULL THEN RETURN NEW; END IF;

  -- ── Invariant 1a : antériorité de la DATE DE RÈGLEMENT ────────────────────
  -- Une date d'émission absente ne bloque rien : elle ne prouve pas
  -- l'impossibilité, et refuser rendrait inutilisables les factures importées
  -- sans date. On refuse ce qui est FAUX, pas ce qui est inconnu.
  IF v_emission IS NOT NULL AND NEW.date_paiement IS NOT NULL
     AND NEW.date_paiement < v_emission THEN
    RAISE EXCEPTION
      'Règlement du % antérieur à l''émission de la facture % (%) : une facture ne peut pas être réglée avant d''exister.',
      NEW.date_paiement, COALESCE(v_numero, v_facture::text), v_emission
      USING ERRCODE = 'check_violation';
  END IF;

  -- ── Invariant 1b : antériorité de la PIÈCE BANCAIRE ──────────────────────
  -- Le cas REPERAL : la date de paiement avait été recalée sur 2026 pendant que
  -- son chèque restait daté de 2024. Contrôler la seule date de paiement laisse
  -- passer un règlement dont la justification est impossible — c'est la pièce
  -- qui fait foi, pas la saisie qui la commente.
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

  -- ── Invariant 3 : non-dépassement CUMULATIF du TTC ───────────────────────
  -- Le cumul EXCLUT la ligne en cours de modification, sans quoi un simple
  -- UPDATE de la date se compterait deux fois et échouerait.
  --
  -- `v_cumul > 0` est la règle, pas une précaution : un PREMIER règlement
  -- supérieur au TTC n'est pas fictif — l'argent est arrivé, avec un trop-perçu,
  -- et le refuser laisserait la facture impayée alors qu'elle est plus que
  -- soldée. Ce qui est fautif, c'est le règlement qui déborde APRÈS un autre :
  -- c'est la signature du double comptage. Même règle que `examinerPaiements`
  -- côté TypeScript ; deux règles différentes ici et là-bas se contrediraient
  -- sur la première saisie venue.
  IF v_ttc IS NOT NULL AND v_ttc > 0 THEN
    SELECT COALESCE(SUM(p.montant), 0) INTO v_cumul
      FROM public.paiements p
     WHERE (p.facture_id = NEW.facture_id OR p.facture_fournisseur_id = NEW.facture_fournisseur_id)
       AND (TG_OP <> 'UPDATE' OR p.id <> NEW.id);

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

-- ── 3. Invariant 2 : unicité de la SAISIE MANUELLE ───────────────────────────
-- Les index `paiements_uq_encaissement` et `paiements_uq_transaction` couvrent
-- déjà les règlements adossés à une pièce. Restait le règlement saisi à la main,
-- qui n'a aucune pièce à opposer : deux clics sur « Enregistrer » créaient deux
-- lignes et soldaient la facture deux fois.
--
-- La clé miroite exactement `clePaiement` côté TypeScript : facture + date +
-- montant + référence. La DATE en fait partie délibérément — deux versements du
-- même montant à des dates différentes sont deux règlements d'un échéancier, pas
-- un doublon.
CREATE UNIQUE INDEX IF NOT EXISTS paiements_uq_saisie_client
  ON public.paiements (facture_id, date_paiement, montant, COALESCE(reference, ''))
  WHERE facture_id IS NOT NULL AND transaction_id IS NULL AND encaissement_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS paiements_uq_saisie_fournisseur
  ON public.paiements (facture_fournisseur_id, date_paiement, montant, COALESCE(reference, ''))
  WHERE facture_fournisseur_id IS NOT NULL AND transaction_id IS NULL AND encaissement_id IS NULL;

-- ── 4. Invariant 4 : l'enregistrement ATOMIQUE d'un règlement ────────────────
-- Une seule fonction, donc une seule transaction : la validation, l'insertion, le
-- recalcul de la facture par le trigger `paiements_resync` et la lecture de
-- l'état final réussissent ou échouent ENSEMBLE.
--
-- Ce que ça ferme : la séquence côté application — insérer le paiement, puis
-- relire la facture, puis écrire l'écriture de trésorerie — n'était atomique
-- nulle part. Une coupure entre deux appels laissait durablement une facture
-- payée sans écriture, ou une écriture sans paiement.
--
-- IDEMPOTENTE sur une pièce : rejouer le même encaissement ou la même ligne de
-- relevé ne crée pas de second règlement, il rend l'état courant. C'est ce qui
-- permet de réessayer sans compter double.
CREATE OR REPLACE FUNCTION public.enregistrer_reglement(
  p_dossier    uuid,
  p_facture    uuid,
  p_kind       text,               -- 'client' | 'fournisseur'
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

  -- Idempotence par la pièce, AVANT toute écriture : un réessai ne doit pas
  -- buter sur l'index unique, il doit rendre ce qui existe déjà.
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

  -- État APRÈS recalcul par le trigger : l'appelant n'a pas à relire la facture
  -- dans une seconde requête, qui pourrait voir un autre instantané.
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

-- ── 5. `lier_transaction` : refuser un lettrage impossible ───────────────────
-- v4 — identique à la v3 pour tout le reste ; seul le contrôle d'antériorité est
-- ajouté, AVANT le lien. Sans lui, le trigger de validation ferait échouer
-- l'INSERT du paiement après que la transaction a déjà été marquée liée : la
-- ligne de relevé serait perdue pour le rapprochement, sans qu'aucun règlement
-- n'existe. On refuse donc en amont, et rien ne bouge.
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
BEGIN
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

GRANT EXECUTE ON FUNCTION public.lier_transaction(uuid, uuid, text) TO authenticated, service_role;

-- ── 6. Le rebuild ne peut plus RÉINSTALLER un règlement impossible ───────────
-- C'est le point qui rendait toute correction manuelle vaine :
-- `synchroniser_paiements_dossier` efface les paiements dérivés et les reconstruit
-- depuis `transactions_bancaires.facture_id`. Un lien fautif étant conservé sur la
-- transaction, le paiement fautif réapparaissait au rapprochement suivant.
--
-- Le filtre est posé DANS la requête de reconstruction, et non laissé au trigger :
-- une exception ferait échouer la resynchronisation du dossier ENTIER à cause
-- d'une seule ligne. Les liens écartés ne sont pas perdus pour autant — ils
-- restent sur la transaction, et le contrôle de conformité les nomme.
CREATE OR REPLACE FUNCTION public.synchroniser_paiements_dossier(p_dossier uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
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

GRANT EXECUTE ON FUNCTION public.synchroniser_paiements_dossier(uuid) TO authenticated, service_role;

-- ── 7. Vue d'audit : les liens bancaires que le rebuild écarte ───────────────
-- Une ligne écartée en silence est une ligne perdue. Cette vue rend visibles les
-- rapprochements impossibles qui subsistent sur `transactions_bancaires`, pour
-- que le contrôle de conformité les nomme et qu'un humain les arbitre.
CREATE OR REPLACE VIEW public.v_liens_bancaires_impossibles AS
SELECT t.dossier_id,
       t.id            AS transaction_id,
       t.date_operation,
       t.montant,
       t.libelle,
       t.facture_id,
       t.document_type,
       e.numero        AS facture_numero,
       e.date_emission AS facture_date,
       (e.date_emission - t.date_operation) AS jours_avant
  FROM public.transactions_bancaires t
  CROSS JOIN LATERAL public.emission_facture(
    t.facture_id,
    CASE WHEN t.document_type = 'facture_fournisseur' THEN 'fournisseur' ELSE 'client' END) e
 WHERE t.facture_id IS NOT NULL
   AND e.date_emission IS NOT NULL
   AND t.date_operation IS NOT NULL
   AND t.date_operation < e.date_emission;

COMMENT ON VIEW public.v_liens_bancaires_impossibles IS
  'Lignes de relevé rattachées à une facture ANTÉRIEURE à elles. Le rebuild des '
  'paiements les écarte ; elles restent liées sur la transaction et demandent un arbitrage.';

COMMENT ON FUNCTION public.enregistrer_reglement(uuid, uuid, text, numeric, date, text, uuid, uuid, text) IS
  'Enregistrement ATOMIQUE d''un règlement : validation, insertion, recalcul de la '
  'facture et restitution de l''état final en une transaction. Idempotente sur la pièce.';
