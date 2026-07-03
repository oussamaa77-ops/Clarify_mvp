-- ════════════════════════════════════════════════════════════════════════════
-- CHANTIER 1 — Modèle « Briques de relevés » (parent-enfant) + backfill + index
-- ════════════════════════════════════════════════════════════════════════════
-- Objectif : passer d'une liste plate de transactions à une gestion par LOTS.
--   • releves_bancaires devient l'entité PARENTE (métadonnées + cycle de vie).
--   • transactions_bancaires.releve_id pointe vers son relevé parent.
--
-- NB : releves_bancaires a été créée HORS-MIGRATION (absente du schéma initial).
-- On la régularise : CREATE IF NOT EXISTS (environnements neufs) + ALTER ADD
-- COLUMN IF NOT EXISTS (base existante partielle). Idempotent.
--
-- Statut relevé (TEXT, même style que transactions_bancaires.statut — pas d'ENUM) :
--   brouillon = importé/en aperçu, éditable, pas encore enregistré comme actif
--   actif     = enregistré, transactions vivantes, lettrage continu applicable
--   cloture   = écritures Grand Livre générées, relevé verrouillé (lecture seule)
-- CHECK volontairement OMIS ici : l'app écrit encore 'valide' à l'insert ; une
-- contrainte CHECK sera ajoutée dans une migration ultérieure, une fois le code
-- applicatif aligné sur ces trois valeurs.

-- ─── 1. Table parente releves_bancaires ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.releves_bancaires (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  compte_id           UUID REFERENCES public.comptes_bancaires(id) ON DELETE CASCADE,
  dossier_id          UUID REFERENCES public.dossiers(id) ON DELETE CASCADE,
  fichier_nom         TEXT,
  banque              TEXT,
  rib                 TEXT,
  periode_debut       DATE,
  periode_fin         DATE,
  solde_initial       NUMERIC(15,2) DEFAULT 0,
  solde_final         NUMERIC(15,2) DEFAULT 0,
  nombre_transactions INTEGER DEFAULT 0,
  statut              TEXT NOT NULL DEFAULT 'brouillon',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Colonnes nouvelles pour la base existante (la table y est déjà, partielle).
ALTER TABLE public.releves_bancaires
  ADD COLUMN IF NOT EXISTS compte_id           UUID REFERENCES public.comptes_bancaires(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS dossier_id          UUID REFERENCES public.dossiers(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS fichier_nom         TEXT,
  ADD COLUMN IF NOT EXISTS banque              TEXT,
  ADD COLUMN IF NOT EXISTS rib                 TEXT,
  ADD COLUMN IF NOT EXISTS periode_debut       DATE,
  ADD COLUMN IF NOT EXISTS periode_fin         DATE,
  ADD COLUMN IF NOT EXISTS solde_initial       NUMERIC(15,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS solde_final         NUMERIC(15,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS nombre_transactions INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS statut              TEXT NOT NULL DEFAULT 'brouillon',
  ADD COLUMN IF NOT EXISTS updated_at          TIMESTAMPTZ NOT NULL DEFAULT now();

-- Normalise les statuts hérités (l'app posait 'valide') vers la nouvelle machine d'états.
UPDATE public.releves_bancaires
  SET statut = 'actif'
  WHERE statut IS NULL OR statut NOT IN ('brouillon','actif','cloture');

-- ─── 2. Lien parent-enfant : transactions_bancaires.releve_id ────────────────
ALTER TABLE public.transactions_bancaires
  ADD COLUMN IF NOT EXISTS releve_id UUID REFERENCES public.releves_bancaires(id) ON DELETE CASCADE;

-- ─── 3. Backfill : rattacher les transactions orphelines à un relevé de reprise ──
-- Pour chaque compte ayant des transactions sans releve_id, on crée UN relevé
-- « Reprise historique » (statut actif) et on y rattache toutes ses transactions.
-- Période et soldes dérivés des transactions / du compte.
DO $$
DECLARE
  r          RECORD;
  new_releve UUID;
BEGIN
  FOR r IN
    SELECT DISTINCT compte_id, dossier_id
    FROM public.transactions_bancaires
    WHERE releve_id IS NULL
  LOOP
    INSERT INTO public.releves_bancaires
      (compte_id, dossier_id, fichier_nom, banque, statut,
       periode_debut, periode_fin, nombre_transactions, solde_final)
    SELECT
      r.compte_id, r.dossier_id, 'Reprise historique',
      cb.banque, 'actif',
      MIN(t.date_operation), MAX(t.date_operation), COUNT(*),
      COALESCE(cb.solde_actuel, 0)
    FROM public.transactions_bancaires t
    LEFT JOIN public.comptes_bancaires cb ON cb.id = r.compte_id
    WHERE t.compte_id = r.compte_id AND t.releve_id IS NULL
    GROUP BY cb.banque, cb.solde_actuel
    RETURNING id INTO new_releve;

    UPDATE public.transactions_bancaires
      SET releve_id = new_releve
      WHERE compte_id = r.compte_id AND releve_id IS NULL;
  END LOOP;
END $$;

-- ─── 3b. Nettoyage : supprimer les anciens relevés VIDES ─────────────────────
-- Après backfill, toute transaction réelle est rattachée à un relevé. Les relevés
-- restants SANS aucune transaction liée sont des stubs hérités (créés hors-flux,
-- libellé générique « relevé importé ») : ni fichier réel ni contenu → on les
-- supprime. Les « Reprise historique » sont conservés (ils ont des transactions),
-- et on ne touche jamais un relevé déjà clôturé.
DELETE FROM public.releves_bancaires r
WHERE NOT EXISTS (
    SELECT 1 FROM public.transactions_bancaires t WHERE t.releve_id = r.id
  )
  AND r.statut <> 'cloture';

-- ─── 4. Index de performance ─────────────────────────────────────────────────
-- Détail d'un relevé (drill-down) : transactions par relevé.
CREATE INDEX IF NOT EXISTS idx_tx_releve
  ON public.transactions_bancaires(releve_id);
-- Cœur du lettrage continu : index PARTIEL sur les transactions non encore liées.
CREATE INDEX IF NOT EXISTS idx_tx_dossier_unlinked
  ON public.transactions_bancaires(dossier_id)
  WHERE facture_id IS NULL AND justificatif_id IS NULL;
-- Liste des briques par compte + filtre statut.
CREATE INDEX IF NOT EXISTS idx_releve_compte_statut
  ON public.releves_bancaires(compte_id, statut);

-- ─── 5. Row Level Security ───────────────────────────────────────────────────
-- Mêmes règles d'accès par dossier que les autres tables (has_dossier_access).
ALTER TABLE public.releves_bancaires ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ds_select" ON public.releves_bancaires;
CREATE POLICY "ds_select" ON public.releves_bancaires
  FOR SELECT TO authenticated
  USING (public.has_dossier_access(auth.uid(), dossier_id));

DROP POLICY IF EXISTS "ds_all" ON public.releves_bancaires;
CREATE POLICY "ds_all" ON public.releves_bancaires
  FOR ALL TO authenticated
  USING (public.has_dossier_access(auth.uid(), dossier_id))
  WITH CHECK (public.has_dossier_access(auth.uid(), dossier_id));
