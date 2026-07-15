-- ============================================================================
-- DURCISSEMENT DE L'ISOLATION MULTI-CABINET (anomalie #1)
--
-- Symptôme : deux comptes de cabinet différents voyaient les MÊMES dossiers.
-- Cause possible côté base réelle : soit la RLS n'est pas active, soit le
-- trigger d'inscription ne crée pas un cabinet distinct par compte.
--
-- Ce script est IDEMPOTENT : on peut le rejouer sans risque. Il (ré)active la
-- RLS sur toutes les tables portant un dossier_id, recrée les fonctions de
-- sécurité, la policy de lecture des dossiers et le trigger d'inscription.
--
-- ⚠️ À exécuter manuellement dans le dashboard Supabase (SQL editor).
-- ============================================================================

-- 1) Fonctions de sécurité (recréées à l'identique de la migration initiale) ---
CREATE OR REPLACE FUNCTION public.get_user_cabinet(_user_id UUID)
RETURNS UUID
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT cabinet_id FROM public.profiles WHERE id = _user_id LIMIT 1 $$;

CREATE OR REPLACE FUNCTION public.has_dossier_access(_user_id UUID, _dossier_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.dossiers d
    WHERE d.id = _dossier_id
      AND (
        d.cabinet_id = public.get_user_cabinet(_user_id)
        OR EXISTS (SELECT 1 FROM public.dossier_access da WHERE da.dossier_id = _dossier_id AND da.user_id = _user_id)
      )
  )
$$;

-- 2) RLS ON sur toutes les tables tenant + toute table portant un dossier_id ---
DO $$
DECLARE r RECORD;
BEGIN
  -- Tables « racine » du tenant
  FOR r IN
    SELECT unnest(ARRAY[
      'cabinets','profiles','user_roles','dossiers','dossier_access'
    ]) AS tbl
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', r.tbl);
  END LOOP;

  -- Toute table publique disposant d'une colonne dossier_id (couvre les
  -- tables ajoutées par des migrations ultérieures : justificatifs,
  -- releves_bancaires, paiements, import_batches, ocr_cache, etc.)
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND c.column_name = 'dossier_id'
      AND t.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', r.table_name);
  END LOOP;
END $$;

-- 3) Policy de lecture des dossiers (recréée) --------------------------------
DROP POLICY IF EXISTS "view_dossiers" ON public.dossiers;
CREATE POLICY "view_dossiers" ON public.dossiers FOR SELECT TO authenticated
  USING (cabinet_id = public.get_user_cabinet(auth.uid())
    OR EXISTS (SELECT 1 FROM public.dossier_access da WHERE da.dossier_id = id AND da.user_id = auth.uid()));

-- 4) Trigger d'inscription : 1 cabinet DISTINCT par nouveau compte -----------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE _cabinet_id UUID;
BEGIN
  INSERT INTO public.cabinets (nom, email)
  VALUES (COALESCE(NEW.raw_user_meta_data->>'cabinet_nom', 'Mon Cabinet'), NEW.email)
  RETURNING id INTO _cabinet_id;

  INSERT INTO public.profiles (id, email, nom, prenom, cabinet_id)
  VALUES (NEW.id, NEW.email, NEW.raw_user_meta_data->>'nom', NEW.raw_user_meta_data->>'prenom', _cabinet_id);

  INSERT INTO public.user_roles (user_id, role, cabinet_id)
  VALUES (NEW.id, 'expert_comptable', _cabinet_id);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================================
-- 5) DIAGNOSTIC (à exécuter séparément pour vérifier l'état réel)
-- ============================================================================
-- a) Des comptes partagent-ils un cabinet ? (résultat attendu : 0 ligne)
--    SELECT cabinet_id, count(*) AS nb_comptes
--    FROM public.profiles
--    GROUP BY cabinet_id HAVING count(*) > 1;
--
-- b) Des profils sans cabinet ? (empêche la création de dossiers)
--    SELECT id, email FROM public.profiles WHERE cabinet_id IS NULL;
--
-- REMÉDIATION si deux comptes partagent un cabinet (garder l'un, isoler l'autre) :
--    WITH nouveau AS (
--      INSERT INTO public.cabinets (nom, email)
--      VALUES ('Cabinet isolé', '<email_du_compte_a_isoler>')
--      RETURNING id
--    )
--    UPDATE public.profiles SET cabinet_id = (SELECT id FROM nouveau)
--    WHERE id = '<user_id_a_isoler>';
--    -- NB : ré-affecter AUSSI les dossiers créés par ce compte au bon cabinet
--    --      si nécessaire (via dossiers.created_by).
-- ============================================================================
