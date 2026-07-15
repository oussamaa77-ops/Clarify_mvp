-- ============================================================================
-- SaaS : plans tarifaires, abonnements et quotas de scans.
--
-- Le tenant facturable est le CABINET (public.cabinets) : un abonnement par
-- cabinet, les dossiers en héritent. La consommation est mesurée en « scans »
-- (1 document passé à l'OCR/IA = 1 scan) sur une période mensuelle glissante
-- qui démarre au jour de souscription.
--
-- Trois objets :
--   • plans          — catalogue (prix MAD, limite mensuelle, features) ;
--   • subscriptions  — l'abonnement vivant d'un cabinet + sa période courante ;
--   • usage_records  — le journal des scans (source de vérité du compteur).
--
-- Le compteur n'est JAMAIS stocké de façon dénormalisée : il est toujours
-- SUM(usage_records.quantity) sur la période. Pas de dérive possible.
--
-- PAIEMENT EN LIGNE : non intégré. Les colonnes provider/provider_customer_id/
-- provider_subscription_id existent déjà pour que le branchement Stripe ou CMI
-- se fasse plus tard SANS toucher au schéma ni à la logique de quota (le
-- provider écrira 'status' et 'current_period_*' via webhook, rien d'autre).
-- ============================================================================

-- ── ENUM statut ─────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE public.subscription_status AS ENUM ('trial','active','past_due','canceled','inactive');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 1. PLANS ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.plans (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code          TEXT NOT NULL UNIQUE,                 -- 'starter' | 'pro' | 'cabinet'
  name          TEXT NOT NULL,
  price_monthly NUMERIC(10,2) NOT NULL CHECK (price_monthly >= 0),
  currency      TEXT NOT NULL DEFAULT 'MAD',
  scans_limit   INTEGER NOT NULL,                     -- documents / mois ; -1 = illimité
  features      JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.plans.scans_limit IS
  'Nombre de documents OCR/IA par période mensuelle. -1 = illimité.';

-- Catalogue initial. ON CONFLICT DO UPDATE : la migration est rejouable et fait
-- foi sur les tarifs (une hausse de prix se fait ici, pas à la main en base).
INSERT INTO public.plans (code, name, price_monthly, scans_limit, sort_order, features) VALUES
  ('starter', 'Starter', 399.00,  100, 1, '["OCR factures & relevés","Comptabilité générale","Lettrage automatique","1 utilisateur"]'::jsonb),
  ('pro',     'Pro',     799.00,  400, 2, '["Tout le plan Starter","Rapprochement bancaire IA","Relances clients","Export Sage / EDI","5 utilisateurs"]'::jsonb),
  ('cabinet', 'Cabinet', 1999.00, 800, 3, '["Tout le plan Pro","Dossiers illimités","Reporting multi-dossiers","Rappels TVA automatiques","Utilisateurs illimités","Support prioritaire"]'::jsonb)
ON CONFLICT (code) DO UPDATE SET
  name          = EXCLUDED.name,
  price_monthly = EXCLUDED.price_monthly,
  scans_limit   = EXCLUDED.scans_limit,
  features      = EXCLUDED.features,
  sort_order    = EXCLUDED.sort_order,
  updated_at    = now();

-- ── 2. SUBSCRIPTIONS ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cabinet_id              UUID NOT NULL REFERENCES public.cabinets(id) ON DELETE CASCADE,
  plan_id                 UUID NOT NULL REFERENCES public.plans(id) ON DELETE RESTRICT,
  status                  public.subscription_status NOT NULL DEFAULT 'trial',
  current_period_start    DATE NOT NULL DEFAULT CURRENT_DATE,
  current_period_end      DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '1 month')::date,
  trial_ends_at           DATE,
  cancel_at_period_end    BOOLEAN NOT NULL DEFAULT false,
  -- Crochets paiement (inutilisés tant que la facturation est manuelle).
  provider                TEXT NOT NULL DEFAULT 'manual',   -- 'manual' | 'stripe' | 'cmi'
  provider_customer_id    TEXT,
  provider_subscription_id TEXT,
  metadata                JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_periode_coherente CHECK (current_period_end > current_period_start)
);

-- Un SEUL abonnement vivant par cabinet (les abonnements clos sont conservés
-- pour l'historique). C'est cette contrainte qui rend consume_scan_quota simple.
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_un_vivant_par_cabinet
  ON public.subscriptions (cabinet_id)
  WHERE status IN ('trial','active','past_due');

-- Idempotence des futurs webhooks Stripe/CMI.
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_provider_ref_uidx
  ON public.subscriptions (provider, provider_subscription_id)
  WHERE provider_subscription_id IS NOT NULL;

-- ── 3. USAGE_RECORDS ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.usage_records (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cabinet_id      UUID NOT NULL REFERENCES public.cabinets(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES public.subscriptions(id) ON DELETE SET NULL,
  dossier_id      UUID REFERENCES public.dossiers(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL,                        -- 'facture' | 'releve' | ...
  quantity        INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  period_start    DATE NOT NULL,                        -- période imputée (fige le décompte)
  idempotency_key TEXT NOT NULL UNIQUE,                 -- anti double-décompte (re-scan, retry queue)
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index du compteur : c'est LA requête du chemin chaud (à chaque scan).
CREATE INDEX IF NOT EXISTS usage_records_compteur_idx
  ON public.usage_records (cabinet_id, period_start);
CREATE INDEX IF NOT EXISTS usage_records_dossier_idx
  ON public.usage_records (dossier_id, created_at DESC);

COMMENT ON COLUMN public.usage_records.idempotency_key IS
  'Un même document rejoué (retry BullMQ, double-clic, cache OCR) ne consomme qu''un scan.';

-- ============================================================================
-- FONCTIONS
-- ============================================================================

-- Période courante d'un abonnement, en LECTURE (aucune écriture) : fait avancer
-- virtuellement la fenêtre mensuelle tant qu'elle est échue. Permet à la lecture
-- et à l'écriture de s'accorder sans cron de renouvellement.
CREATE OR REPLACE FUNCTION public.quota_periode_courante(
  _start DATE, _end DATE, _today DATE DEFAULT CURRENT_DATE
) RETURNS TABLE (periode_debut DATE, periode_fin DATE)
LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE s DATE := _start; e DATE := _end;
BEGIN
  IF e <= s THEN e := (s + INTERVAL '1 month')::date; END IF;
  WHILE e <= _today LOOP          -- période échue → on bascule sur la suivante
    s := e;
    e := (e + INTERVAL '1 month')::date;
  END LOOP;
  periode_debut := s; periode_fin := e; RETURN NEXT;
END $$;

-- Garantit qu'un cabinet a un abonnement vivant (essai Starter 14 jours par
-- défaut). Idempotent : appelé au trigger, au backfill et au premier scan.
CREATE OR REPLACE FUNCTION public.ensure_subscription(_cabinet_id UUID)
RETURNS public.subscriptions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE sub public.subscriptions; starter UUID;
BEGIN
  SELECT * INTO sub FROM public.subscriptions
   WHERE cabinet_id = _cabinet_id AND status IN ('trial','active','past_due')
   LIMIT 1;
  IF FOUND THEN RETURN sub; END IF;

  SELECT id INTO starter FROM public.plans WHERE code = 'starter';
  INSERT INTO public.subscriptions (cabinet_id, plan_id, status, trial_ends_at)
  VALUES (_cabinet_id, starter, 'trial', (CURRENT_DATE + INTERVAL '14 days')::date)
  ON CONFLICT DO NOTHING            -- course : un autre appel vient de le créer
  RETURNING * INTO sub;

  IF sub.id IS NULL THEN
    SELECT * INTO sub FROM public.subscriptions
     WHERE cabinet_id = _cabinet_id AND status IN ('trial','active','past_due') LIMIT 1;
  END IF;
  RETURN sub;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- consume_scan_quota — LE point de contrôle. Atomique et idempotent.
--
--   1. verrouille l'abonnement du cabinet (FOR UPDATE) → pas de dépassement
--      par scans concurrents ;
--   2. fait rouler la période si elle est échue (renouvellement sans cron) ;
--   3. rejoue à l'identique si la clé d'idempotence est déjà connue ;
--   4. compte, compare à la limite du plan, refuse si dépassement ;
--   5. inscrit la consommation.
--
-- Retourne du JSON : { allowed, used, limit, remaining, period_start,
--                      period_end, plan_code, status, reason, replay }
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.consume_scan_quota(
  _dossier_id       UUID,
  _kind             TEXT,
  _idempotency_key  TEXT,
  _quantity         INTEGER DEFAULT 1
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cabinet UUID;
  sub       public.subscriptions;
  v_plan    public.plans;
  p_debut   DATE; p_fin DATE;
  v_used    INTEGER;
  v_insere  INTEGER;
BEGIN
  IF _quantity IS NULL OR _quantity < 1 THEN _quantity := 1; END IF;

  SELECT cabinet_id INTO v_cabinet FROM public.dossiers WHERE id = _dossier_id;
  IF v_cabinet IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'dossier_introuvable');
  END IF;

  PERFORM public.ensure_subscription(v_cabinet);

  -- Verrou : sérialise les scans concurrents du même cabinet.
  SELECT * INTO sub FROM public.subscriptions
   WHERE cabinet_id = v_cabinet AND status IN ('trial','active','past_due')
   LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'aucun_abonnement');
  END IF;

  SELECT * INTO v_plan FROM public.plans WHERE id = sub.plan_id;

  -- Renouvellement paresseux de la période.
  SELECT q.periode_debut, q.periode_fin INTO p_debut, p_fin
    FROM public.quota_periode_courante(sub.current_period_start, sub.current_period_end) q;
  IF p_debut <> sub.current_period_start THEN
    UPDATE public.subscriptions
       SET current_period_start = p_debut, current_period_end = p_fin, updated_at = now()
     WHERE id = sub.id;
    sub.current_period_start := p_debut; sub.current_period_end := p_fin;
  END IF;

  -- Fin d'essai / abonnement suspendu : on bloque avant même de compter.
  IF sub.status = 'past_due' THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'abonnement_impaye',
      'plan_code', v_plan.code, 'status', sub.status);
  END IF;
  IF sub.status = 'trial' AND sub.trial_ends_at IS NOT NULL AND sub.trial_ends_at < CURRENT_DATE THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'essai_expire',
      'plan_code', v_plan.code, 'status', sub.status, 'trial_ends_at', sub.trial_ends_at);
  END IF;

  SELECT COALESCE(SUM(quantity), 0)::int INTO v_used
    FROM public.usage_records
   WHERE cabinet_id = v_cabinet AND period_start = p_debut;

  -- Rejeu (retry queue, double-clic, re-scan du même fichier) : ne recompte pas.
  IF EXISTS (SELECT 1 FROM public.usage_records WHERE idempotency_key = _idempotency_key) THEN
    RETURN jsonb_build_object(
      'allowed', true, 'replay', true, 'used', v_used, 'limit', v_plan.scans_limit,
      'remaining', CASE WHEN v_plan.scans_limit < 0 THEN -1 ELSE GREATEST(v_plan.scans_limit - v_used, 0) END,
      'period_start', p_debut, 'period_end', p_fin,
      'plan_code', v_plan.code, 'status', sub.status);
  END IF;

  IF v_plan.scans_limit >= 0 AND v_used + _quantity > v_plan.scans_limit THEN
    RETURN jsonb_build_object(
      'allowed', false, 'reason', 'quota_depasse', 'used', v_used, 'limit', v_plan.scans_limit,
      'remaining', 0, 'period_start', p_debut, 'period_end', p_fin,
      'plan_code', v_plan.code, 'status', sub.status);
  END IF;

  INSERT INTO public.usage_records
    (cabinet_id, subscription_id, dossier_id, kind, quantity, period_start, idempotency_key)
  VALUES
    (v_cabinet, sub.id, _dossier_id, _kind, _quantity, p_debut, _idempotency_key)
  ON CONFLICT (idempotency_key) DO NOTHING;
  GET DIAGNOSTICS v_insere = ROW_COUNT;
  IF v_insere > 0 THEN v_used := v_used + _quantity; END IF;

  RETURN jsonb_build_object(
    'allowed', true, 'replay', v_insere = 0, 'used', v_used, 'limit', v_plan.scans_limit,
    'remaining', CASE WHEN v_plan.scans_limit < 0 THEN -1 ELSE GREATEST(v_plan.scans_limit - v_used, 0) END,
    'period_start', p_debut, 'period_end', p_fin,
    'plan_code', v_plan.code, 'status', sub.status);
END $$;

-- État du quota, sans consommer. Un utilisateur ne peut lire que SON cabinet ;
-- le serveur (service_role, auth.uid() NULL) peut lire n'importe lequel.
CREATE OR REPLACE FUNCTION public.get_quota_status(_cabinet_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cabinet UUID := COALESCE(_cabinet_id, public.get_user_cabinet(auth.uid()));
  sub       public.subscriptions;
  v_plan    public.plans;
  p_debut   DATE; p_fin DATE;
  v_used    INTEGER;
BEGIN
  IF v_cabinet IS NULL THEN
    RETURN jsonb_build_object('has_subscription', false, 'reason', 'aucun_cabinet');
  END IF;
  IF auth.uid() IS NOT NULL AND public.get_user_cabinet(auth.uid()) IS DISTINCT FROM v_cabinet THEN
    RAISE EXCEPTION 'accès refusé au quota d''un autre cabinet';
  END IF;

  SELECT * INTO sub FROM public.subscriptions
   WHERE cabinet_id = v_cabinet AND status IN ('trial','active','past_due') LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('has_subscription', false, 'reason', 'aucun_abonnement',
                              'cabinet_id', v_cabinet);
  END IF;

  SELECT * INTO v_plan FROM public.plans WHERE id = sub.plan_id;
  SELECT q.periode_debut, q.periode_fin INTO p_debut, p_fin
    FROM public.quota_periode_courante(sub.current_period_start, sub.current_period_end) q;

  SELECT COALESCE(SUM(quantity), 0)::int INTO v_used
    FROM public.usage_records
   WHERE cabinet_id = v_cabinet AND period_start = p_debut;

  RETURN jsonb_build_object(
    'has_subscription', true,
    'cabinet_id', v_cabinet,
    'subscription_id', sub.id,
    'status', sub.status,
    'trial_ends_at', sub.trial_ends_at,
    'cancel_at_period_end', sub.cancel_at_period_end,
    'provider', sub.provider,
    'plan', jsonb_build_object(
      'id', v_plan.id, 'code', v_plan.code, 'name', v_plan.name,
      'price_monthly', v_plan.price_monthly, 'currency', v_plan.currency,
      'scans_limit', v_plan.scans_limit, 'features', v_plan.features),
    'used', v_used,
    'limit', v_plan.scans_limit,
    'remaining', CASE WHEN v_plan.scans_limit < 0 THEN -1 ELSE GREATEST(v_plan.scans_limit - v_used, 0) END,
    'period_start', p_debut,
    'period_end', p_fin);
END $$;

-- Changement de plan MANUEL (pas de paiement en ligne). La période et le
-- compteur ne sont PAS remis à zéro : on ne fait pas cadeau des scans déjà
-- consommés, et un downgrade ne « rend » pas de quota.
CREATE OR REPLACE FUNCTION public.set_subscription_plan(
  _cabinet_id UUID, _plan_code TEXT, _status public.subscription_status DEFAULT 'active'
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_plan public.plans; sub public.subscriptions;
BEGIN
  SELECT * INTO v_plan FROM public.plans WHERE code = _plan_code AND is_active;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'plan_inconnu');
  END IF;

  PERFORM public.ensure_subscription(_cabinet_id);
  UPDATE public.subscriptions
     SET plan_id = v_plan.id, status = _status, trial_ends_at = NULL, updated_at = now()
   WHERE cabinet_id = _cabinet_id AND status IN ('trial','active','past_due')
  RETURNING * INTO sub;

  RETURN jsonb_build_object('ok', true, 'subscription_id', sub.id, 'plan_code', v_plan.code,
                            'status', sub.status);
END $$;

-- Tout nouveau cabinet démarre avec un essai.
CREATE OR REPLACE FUNCTION public.handle_new_cabinet()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.ensure_subscription(NEW.id);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_cabinet_subscription ON public.cabinets;
CREATE TRIGGER trg_cabinet_subscription
  AFTER INSERT ON public.cabinets
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_cabinet();

-- Backfill : les cabinets déjà en base reçoivent leur abonnement d'essai.
DO $$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT id FROM public.cabinets LOOP
    PERFORM public.ensure_subscription(c.id);
  END LOOP;
END $$;

-- ============================================================================
-- RLS — lecture pour les membres du cabinet, écriture réservée au serveur.
-- ============================================================================
ALTER TABLE public.plans         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "plans_select" ON public.plans;
CREATE POLICY "plans_select" ON public.plans FOR SELECT TO authenticated
  USING (is_active);

DROP POLICY IF EXISTS "subscriptions_select" ON public.subscriptions;
CREATE POLICY "subscriptions_select" ON public.subscriptions FOR SELECT TO authenticated
  USING (cabinet_id = public.get_user_cabinet(auth.uid()));

DROP POLICY IF EXISTS "usage_records_select" ON public.usage_records;
CREATE POLICY "usage_records_select" ON public.usage_records FOR SELECT TO authenticated
  USING (cabinet_id = public.get_user_cabinet(auth.uid()));
-- Aucune policy INSERT/UPDATE/DELETE : seul le service_role (qui contourne RLS)
-- écrit dans subscriptions/usage_records. Un client ne peut pas s'offrir du quota.

-- ============================================================================
-- DROITS D'EXÉCUTION
-- ============================================================================
REVOKE ALL ON FUNCTION public.consume_scan_quota(UUID, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_subscription_plan(UUID, TEXT, public.subscription_status) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ensure_subscription(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_quota_status(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.quota_periode_courante(DATE, DATE, DATE) TO authenticated;

COMMENT ON TABLE public.plans IS 'Catalogue tarifaire (MAD/mois, quota de scans mensuel).';
COMMENT ON TABLE public.subscriptions IS 'Abonnement vivant d''un cabinet. provider_* = crochets Stripe/CMI, inutilisés en facturation manuelle.';
COMMENT ON TABLE public.usage_records IS 'Journal des scans consommés — source de vérité du compteur de quota.';
