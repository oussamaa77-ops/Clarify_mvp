-- ============================================================================
-- PISTE D'AUDIT INFALSIFIABLE — chaîne SHA-256 (anomalie #5)
--
-- La table audit_logs possédait déjà les colonnes hash / hash_precedent mais
-- RIEN ne les remplissait, alors que l'UI promet une « chaîne cryptographique ».
-- Ce trigger scelle CHAQUE insertion (client ou serveur) :
--   hash = sha256(hash_precedent || action || ressource_id || details || created_at)
-- La chaîne est partitionnée par dossier_id (les événements globaux — connexion,
-- déconnexion — forment la chaîne dossier_id = NULL).
--
-- Le trigger renseigne aussi user_id / user_email depuis la session si absents.
-- Un trigger BEFORE INSERT s'exécute AVANT le WITH CHECK de la RLS
-- (user_id = auth.uid()), donc l'insertion reste conforme à la policy.
--
-- ⚠️ À exécuter manuellement dans le dashboard Supabase (SQL editor).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.audit_logs_seal()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE _prev TEXT;
BEGIN
  -- Contexte utilisateur (best-effort) si non fourni par l'appelant.
  NEW.user_id    := COALESCE(NEW.user_id, auth.uid());
  NEW.user_email := COALESCE(NEW.user_email, NULLIF(auth.jwt() ->> 'email', ''));
  IF NEW.created_at IS NULL THEN NEW.created_at := now(); END IF;

  -- Dernier maillon de la même partition (même dossier, NULL inclus).
  SELECT a.hash INTO _prev
  FROM public.audit_logs a
  WHERE a.dossier_id IS NOT DISTINCT FROM NEW.dossier_id
  ORDER BY a.created_at DESC, a.id DESC
  LIMIT 1;

  NEW.hash_precedent := COALESCE(_prev, 'genesis');
  NEW.hash := encode(
    digest(
      NEW.hash_precedent
        || COALESCE(NEW.action, '')
        || COALESCE(NEW.ressource_type, '')
        || COALESCE(NEW.ressource_id::text, '')
        || COALESCE(NEW.details::text, '')
        || NEW.created_at::text,
      'sha256'
    ),
    'hex'
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_logs_seal ON public.audit_logs;
CREATE TRIGGER trg_audit_logs_seal
  BEFORE INSERT ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.audit_logs_seal();

-- Autorise l'insertion d'événements NON liés à un dossier (connexion,
-- déconnexion) : la policy initiale n'exigeait que user_id = auth.uid().
-- On la recrée par sécurité (idempotent).
DROP POLICY IF EXISTS "ds_insert" ON public.audit_logs;
CREATE POLICY "ds_insert" ON public.audit_logs FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- Vérification : intégrité de la chaîne (doit renvoyer 0 ligne cassée)
--   SELECT id, action FROM (
--     SELECT id, action, hash_precedent,
--            LAG(hash) OVER (PARTITION BY dossier_id ORDER BY created_at, id) AS prev
--     FROM public.audit_logs
--   ) t WHERE hash_precedent <> COALESCE(prev, 'genesis');
