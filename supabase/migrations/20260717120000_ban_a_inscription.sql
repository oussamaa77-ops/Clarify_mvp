-- ============================================================================
-- BANNISSEMENT AUTOMATIQUE À L'INSCRIPTION
--
-- Complète 20260716120000_approbation_inscription.sql. Celle-ci posait bien
-- is_approved = false à la création, mais is_approved ne bloque QUE la lecture
-- des données (via get_user_cabinet + RLS). Le compte, lui, recevait un jeton :
-- la confirmation d'e-mail étant désactivée, /auth/v1/signup ouvre une session
-- immédiatement.
--
-- Le code applicatif banne désormais le compte (approval.functions.ts), mais il
-- ne s'exécute que si l'inscription passe par le front. /auth/v1/signup est une
-- API publique, appelable directement : sans le trigger ci-dessous, un compte
-- créé hors du front naîtrait NON banni, donc connecté.
--
-- Ce trigger rend le verrou indépendant du front ET du code déployé : quel que
-- soit le chemin d'inscription, le compte naît sans pouvoir se connecter.
--
-- ⚠️ À exécuter manuellement dans le dashboard Supabase (SQL editor).
-- Script IDEMPOTENT : rejouable sans risque.
-- ============================================================================

-- 1) Le trigger d'inscription banne le compte -------------------------------
-- Reprend handle_new_user de 20260716120000 À L'IDENTIQUE, en ajoutant le seul
-- UPDATE sur auth.users. Écrire dans auth.users depuis un trigger est inhabituel
-- mais banned_until est un champ stable de GoTrue, et c'est le seul moyen de
-- refuser le jeton dès l'INSERT, sans dépendre d'un appel applicatif.
--
-- Pas de récursion : on_auth_user_created est AFTER INSERT uniquement, cet
-- UPDATE ne le redéclenche donc pas.
--
-- 100 ans plutôt que 'infinity' : GoTrue sérialise banned_until en JSON, et une
-- date infinie est un cas limite inutile à tester ici. Le débannissement est de
-- toute façon explicite (/api/approve-user pose ban_duration: 'none').
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

  -- LE VERROU DE CONNEXION : aucun jeton ne sera délivré tant que
  -- /api/approve-user n'aura pas levé ce bannissement.
  UPDATE auth.users
     SET banned_until = now() + interval '100 years'
   WHERE id = NEW.id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 2) Rattrapage des comptes déjà en attente ---------------------------------
-- Les comptes créés avant ce correctif sont non approuvés mais non bannis :
-- ils peuvent encore obtenir un jeton. On aligne leur état.
-- (Rejouable : ne touche que les non-approuvés non déjà bannis.)
UPDATE auth.users u
   SET banned_until = now() + interval '100 years'
  FROM public.profiles p
 WHERE p.id = u.id
   AND NOT p.is_approved
   AND (u.banned_until IS NULL OR u.banned_until < now());

-- ============================================================================
-- VÉRIFICATIONS (à exécuter séparément)
-- ============================================================================
-- a) Tout non-approuvé est-il bien banni ? (attendu : 0 ligne)
--    SELECT p.email FROM public.profiles p JOIN auth.users u ON u.id = p.id
--     WHERE NOT p.is_approved AND (u.banned_until IS NULL OR u.banned_until < now());
--
-- b) Inversement, aucun approuvé ne doit rester banni : (attendu : 0 ligne)
--    SELECT p.email FROM public.profiles p JOIN auth.users u ON u.id = p.id
--     WHERE p.is_approved AND u.banned_until > now();
--
-- c) Dépannage si un mail d'approbation n'est jamais parti — approuver ET
--    débannir à la main (les deux, sinon le compte reste inutilisable) :
--    UPDATE public.profiles SET is_approved = true WHERE email = '<email>';
--    UPDATE auth.users SET banned_until = NULL WHERE email = '<email>';
