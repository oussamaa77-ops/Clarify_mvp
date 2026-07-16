-- ============================================================================
-- APPROBATION DES INSCRIPTIONS PAR L'ADMINISTRATEUR
--
-- Un compte fraîchement créé naît NON APPROUVÉ et ne voit aucune donnée tant
-- qu'un administrateur n'a pas cliqué le lien d'approbation reçu par e-mail.
--
-- ⚠️ À exécuter manuellement dans le dashboard Supabase (SQL editor).
-- Script IDEMPOTENT : rejouable sans risque (voir la note sur le backfill).
-- ============================================================================

-- 1) Colonne is_approved ------------------------------------------------------
-- Astuce : on ajoute la colonne avec DEFAULT true, ce qui approuve d'office
-- TOUTES les lignes existantes (sinon les comptes actuels, admin compris, se
-- retrouveraient verrouillés hors de l'application). On bascule le défaut à
-- false JUSTE APRÈS : seuls les comptes créés à partir de maintenant naissent
-- en attente. Faire l'inverse (DEFAULT false puis UPDATE ... SET true) ne
-- serait pas rejouable : un second passage réapprouverait tout le monde.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_approved BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE public.profiles
  ALTER COLUMN is_approved SET DEFAULT false;

-- 2) Le trigger d'inscription crée désormais des comptes en attente ----------
-- Identique à la version de 20260715120000_harden_tenant_isolation.sql, à
-- l'ajout de is_approved près (explicite plutôt que via le DEFAULT, pour que
-- l'intention soit lisible ici).
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE _cabinet_id UUID;
BEGIN
  INSERT INTO public.cabinets (nom, email)
  VALUES (COALESCE(NEW.raw_user_meta_data->>'cabinet_nom', 'Mon Cabinet'), NEW.email)
  RETURNING id INTO _cabinet_id;

  INSERT INTO public.profiles (id, email, nom, prenom, cabinet_id, is_approved)
  VALUES (NEW.id, NEW.email, NEW.raw_user_meta_data->>'nom', NEW.raw_user_meta_data->>'prenom', _cabinet_id, false);

  INSERT INTO public.user_roles (user_id, role, cabinet_id)
  VALUES (NEW.id, 'expert_comptable', _cabinet_id);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 3) LE VERROU RÉEL : get_user_cabinet() ne rend rien à un non-approuvé ------
-- C'est ici que se joue la sécurité, pas dans l'interface. Cette fonction est
-- le pivot de la RLS (utilisée par ~19 policies) : si elle renvoie NULL, la
-- comparaison `cabinet_id = get_user_cabinet(auth.uid())` est fausse pour toute
-- ligne, et l'utilisateur ne voit RIEN — même s'il appelle l'API directement
-- avec un JWT valide, en contournant totalement le front.
--
-- La policy view_own_profile reste satisfaite par sa branche `id = auth.uid()`,
-- donc le compte en attente peut toujours lire son propre profil : c'est ce qui
-- permet à l'écran de connexion de lui dire qu'il attend une approbation.
CREATE OR REPLACE FUNCTION public.get_user_cabinet(_user_id UUID)
RETURNS UUID
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT cabinet_id FROM public.profiles
  WHERE id = _user_id AND is_approved
  LIMIT 1
$$;

-- 4) Interdire l'auto-approbation --------------------------------------------
-- La policy update_own_profile autorise `USING (id = auth.uid())` SANS
-- restriction de colonne : la RLS de PostgreSQL ne sait pas raisonner par
-- colonne. Sans ce garde-fou, n'importe quel compte en attente pourrait
-- exécuter `update profiles set is_approved = true where id = <soi>` et
-- s'approuver lui-même — le verrou ci-dessus ne vaudrait plus rien.
-- Un trigger, lui, s'applique quel que soit le chemin d'écriture.
CREATE OR REPLACE FUNCTION public.prevent_self_approval()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NEW.is_approved IS DISTINCT FROM OLD.is_approved
     AND current_user NOT IN ('service_role', 'postgres', 'supabase_admin')
  THEN
    RAISE EXCEPTION 'is_approved ne peut être modifié que par un administrateur (clé de service).';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_self_approval ON public.profiles;
CREATE TRIGGER trg_prevent_self_approval
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.prevent_self_approval();

-- ============================================================================
-- VÉRIFICATIONS (à exécuter séparément)
-- ============================================================================
-- a) Les comptes existants sont-ils bien tous approuvés ? (attendu : 0 ligne)
--    SELECT id, email FROM public.profiles WHERE NOT is_approved;
--
-- b) Approuver un compte à la main (dépannage, si l'e-mail n'est pas parti) :
--    UPDATE public.profiles SET is_approved = true WHERE email = '<email>';
--
-- c) Vérifier que l'auto-approbation est bien refusée : se connecter avec un
--    compte en attente et tenter depuis le navigateur —
--    await supabase.from('profiles').update({is_approved:true}).eq('id', <soi>)
--    → doit renvoyer l'exception du trigger, PAS un succès.
