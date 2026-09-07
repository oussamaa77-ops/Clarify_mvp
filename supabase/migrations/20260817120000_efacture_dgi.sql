-- ============================================================================
-- 20260817120000 — Facturation électronique (e-Invoicing) : identités fiscales,
-- inaltérabilité et cycle de vie DGI.
--
-- À APPLIQUER À LA MAIN dans le SQL Editor de Supabase (pas de CLI sur ce poste).
-- Ce fichier est IDEMPOTENT : le rejouer ne casse rien.
--
-- ─── Pourquoi FIGER les identités sur la facture ? ───────────────────────────
-- L'ICE, l'IF, le RC et la patente du vendeur vivent aujourd'hui sur `dossiers`,
-- ceux de l'acheteur sur `clients`. Une facture transmise à la DGI est un acte
-- juridique DÉFINITIF : si le client corrige son ICE l'an prochain, la facture
-- déjà validée doit continuer à porter l'ICE qui a été transmis, sinon le hash
-- d'inaltérabilité ne se recalcule plus et le contrôle échoue.
--
-- On COPIE donc les identifiants sur la facture au moment de l'émission
-- (snapshot). Les tables `dossiers`/`clients` restent la source de saisie ; la
-- facture devient la source de vérité de ce qui a été DÉCLARÉ.
--
-- ─── Colonnes déjà présentes (schéma initial) ────────────────────────────────
-- `factures` porte déjà : xml_ubl, hash_sha256, dgi_uuid, dgi_response,
-- statut_dgi. On NE les duplique PAS. Ce qu'on ajoute :
--   • dgi_status           — cycle de vie normalisé (DRAFT/PENDING/VALIDATED/REJECTED)
--   • dgi_submission_at    — horodatage de la transmission
--   • dgi_response_payload — JOURNAL des échanges (requêtes ET réponses), là où
--                            `dgi_response` ne garde que la DERNIÈRE réponse.
--
-- `statut_dgi` (texte libre : 'en_analyse'/'conforme'/'rejetee') est lu par
-- l'UI historique et par les filtres factures. Plutôt que de le renommer et de
-- casser ces lecteurs, un trigger le MAINTIENT EN MIROIR de `dgi_status` : une
-- seule écriture, deux vues cohérentes. Le jour où plus rien ne lit `statut_dgi`,
-- il suffit de supprimer le trigger et la colonne.
-- ============================================================================

-- ─── 1. Patente du vendeur (manquante sur `dossiers`) ────────────────────────
-- ICE / RC / IF existent déjà ; la taxe professionnelle (ex-patente) est une
-- mention obligatoire de la facture marocaine et n'était stockée nulle part.
ALTER TABLE public.dossiers
  ADD COLUMN IF NOT EXISTS patente text;

COMMENT ON COLUMN public.dossiers.patente IS
  'Numéro de taxe professionnelle (ex-patente) — mention obligatoire sur facture.';

-- ─── 2. Snapshot des identités fiscales sur la facture ───────────────────────
ALTER TABLE public.factures
  ADD COLUMN IF NOT EXISTS ice_vendeur     text,
  ADD COLUMN IF NOT EXISTS if_vendeur      text,
  ADD COLUMN IF NOT EXISTS rc_vendeur      text,
  ADD COLUMN IF NOT EXISTS patente_vendeur text,
  ADD COLUMN IF NOT EXISTS ice_acheteur    text,
  ADD COLUMN IF NOT EXISTS if_acheteur     text;

COMMENT ON COLUMN public.factures.ice_vendeur IS
  'ICE du vendeur FIGÉ à l''émission (15 chiffres). Ne jamais recalculer depuis dossiers : le hash en dépend.';
COMMENT ON COLUMN public.factures.ice_acheteur IS
  'ICE de l''acheteur FIGÉ à l''émission (15 chiffres). Vide = vente à particulier (B2C).';

-- ─── 3. Cycle de vie DGI ─────────────────────────────────────────────────────
ALTER TABLE public.factures
  ADD COLUMN IF NOT EXISTS dgi_status           text NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN IF NOT EXISTS dgi_submission_at    timestamptz,
  ADD COLUMN IF NOT EXISTS dgi_validated_at     timestamptz,
  ADD COLUMN IF NOT EXISTS dgi_response_payload jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.factures.dgi_status IS
  'DRAFT | PENDING_DGI | VALIDATED_BY_DGI | REJECTED_BY_DGI | CANCELLED_BY_DGI';
COMMENT ON COLUMN public.factures.dgi_response_payload IS
  'Journal APPEND-ONLY des échanges DGI : [{sens:"requete"|"reponse", operation, at, payload}].';

-- ─── 4. Reprise de l'existant ────────────────────────────────────────────────
-- Les factures déjà passées par l'ancien `generateFactureXml` portent un
-- `statut_dgi` textuel : on en déduit leur état normalisé une seule fois.
UPDATE public.factures SET dgi_status =
  CASE
    WHEN statut_dgi IN ('conforme', 'valide', 'validee')  THEN 'VALIDATED_BY_DGI'
    WHEN statut_dgi IN ('rejetee', 'rejete', 'rejected')  THEN 'REJECTED_BY_DGI'
    WHEN statut_dgi IN ('en_analyse', 'en_attente')       THEN 'PENDING_DGI'
    WHEN statut = 'annulee'                               THEN 'CANCELLED_BY_DGI'
    ELSE 'DRAFT'
  END
WHERE dgi_status = 'DRAFT' AND (statut_dgi IS NOT NULL OR statut = 'annulee');

-- Une facture reprise comme validée a forcément été transmise : on date la
-- transmission de sa dernière modification connue plutôt que de la laisser
-- NULL (un récépissé sans date d'envoi est illisible pour le contrôleur).
UPDATE public.factures
   SET dgi_submission_at = COALESCE(dgi_submission_at, updated_at, created_at),
       dgi_validated_at  = COALESCE(dgi_validated_at, updated_at, created_at)
 WHERE dgi_status = 'VALIDATED_BY_DGI' AND dgi_submission_at IS NULL;

-- Le journal reprend la dernière réponse connue pour ne pas afficher un
-- historique vide sur des factures pourtant transmises.
UPDATE public.factures
   SET dgi_response_payload =
     jsonb_build_array(jsonb_build_object(
       'sens',      'reponse',
       'operation', 'submitInvoice',
       'at',        COALESCE(updated_at, created_at),
       'payload',   dgi_response
     ))
 WHERE dgi_response IS NOT NULL
   AND dgi_response_payload = '[]'::jsonb;

-- ─── 5. Contrainte de domaine ────────────────────────────────────────────────
-- Posée APRÈS la reprise : sur une base où `statut_dgi` contenait une valeur
-- inattendue, la reprise retombe sur 'DRAFT' et la contrainte passe.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'factures_dgi_status_check' AND table_name = 'factures'
  ) THEN
    ALTER TABLE public.factures
      ADD CONSTRAINT factures_dgi_status_check
      CHECK (dgi_status IN ('DRAFT','PENDING_DGI','VALIDATED_BY_DGI','REJECTED_BY_DGI','CANCELLED_BY_DGI'));
  END IF;
END $$;

-- ─── 6. Miroir legacy `statut_dgi` ───────────────────────────────────────────
-- L'UI historique (badge, filtres, exports) lit `statut_dgi`. Le trigger le
-- dérive de `dgi_status` : le code applicatif n'écrit plus QUE `dgi_status`.
CREATE OR REPLACE FUNCTION public.sync_statut_dgi_legacy()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.statut_dgi := CASE NEW.dgi_status
    WHEN 'VALIDATED_BY_DGI' THEN 'conforme'
    WHEN 'REJECTED_BY_DGI'  THEN 'rejetee'
    WHEN 'PENDING_DGI'      THEN 'en_analyse'
    WHEN 'CANCELLED_BY_DGI' THEN 'annulee'
    ELSE 'brouillon'
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_sync_statut_dgi_legacy ON public.factures;
CREATE TRIGGER trg_sync_statut_dgi_legacy
  BEFORE INSERT OR UPDATE OF dgi_status ON public.factures
  FOR EACH ROW EXECUTE FUNCTION public.sync_statut_dgi_legacy();

-- Alignement immédiat des lignes existantes (le trigger ne s'applique qu'aux
-- écritures futures).
UPDATE public.factures SET dgi_status = dgi_status;

-- ─── 7. Index ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_factures_dgi_status
  ON public.factures (dossier_id, dgi_status);

-- Un UUID DGI est unique dans l'univers DGI : deux factures ne peuvent pas le
-- partager. Index partiel — les brouillons (dgi_uuid NULL) ne s'y heurtent pas.
CREATE UNIQUE INDEX IF NOT EXISTS idx_factures_dgi_uuid_unique
  ON public.factures (dgi_uuid) WHERE dgi_uuid IS NOT NULL;

-- ─── 8. Même traitement pour les factures FOURNISSEURS (achats) ──────────────
-- Une facture reçue porte l'ICE de SON émetteur (le fournisseur = vendeur) et
-- le nôtre (acheteur). Le contrôle de déductibilité TVA exige l'ICE du
-- fournisseur : sans ces colonnes, l'état des déductions reste incomplet.
ALTER TABLE public.factures_fournisseurs
  ADD COLUMN IF NOT EXISTS ice_vendeur  text,
  ADD COLUMN IF NOT EXISTS if_vendeur   text,
  ADD COLUMN IF NOT EXISTS ice_acheteur text,
  ADD COLUMN IF NOT EXISTS if_acheteur  text,
  ADD COLUMN IF NOT EXISTS dgi_status   text NOT NULL DEFAULT 'DRAFT';
