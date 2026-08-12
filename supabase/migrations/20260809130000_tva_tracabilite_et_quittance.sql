-- ============================================================================
-- 20260809130000 — Traçabilité des OD de TVA et quittance SIMPL-TVA.
--
-- À APPLIQUER À LA MAIN dans le SQL Editor de Supabase (pas de CLI sur ce poste).
-- Ce fichier est IDEMPOTENT : le rejouer ne casse rien.
--
-- ─── 1. `ecritures_comptables.paiement_id` ───────────────────────────────────
-- L'OD qui rend la TVA exigible naît d'un RÈGLEMENT précis. Jusqu'ici seul le
-- couple (référence de pièce, code de lettrage) la reliait à son origine : du
-- texte, tronqué à 50 caractères à l'affichage, et que deux pièces peuvent
-- partager. On ne pouvait donc pas répondre d'une jointure à « quel encaissement
-- a rendu cette TVA due ? », question que pose tout contrôle DGI.
--
-- La colonne est NULLABLE et ON DELETE SET NULL : supprimer un paiement ne doit
-- jamais emporter l'écriture de TVA — c'est au délettrage de la défaire, dans le
-- bon ordre (cf. executerDelettrage).
--
-- ─── 2. Quittance SIMPL-TVA sur la transaction bancaire ──────────────────────
-- Le prélèvement de la DGI (D 4456 / C 5141) doit pouvoir porter le PDF de la
-- quittance : c'est la pièce justificative du paiement de la taxe, exigible en
-- cas de contrôle. On stocke le CHEMIN dans le bucket privé, jamais une URL
-- publique — le document nomme la société et le montant de sa TVA.
--
-- ─── 3. Pointage du compte 4456 ──────────────────────────────────────────────
-- `pointe` permet de cocher une ligne de 4456 sans la lettrer : le lettrage est
-- désormais interdit sur les comptes de TVA (ils se soldent par la déclaration),
-- mais on veut quand même vérifier à l'œil que la dette déclarée a bien été
-- prélevée, et que le compte retombe à 0,00.
-- ============================================================================

-- ─── 1. Traçabilité des OD de TVA ────────────────────────────────────────────
ALTER TABLE public.ecritures_comptables
  ADD COLUMN IF NOT EXISTS paiement_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'ecritures_comptables_paiement_id_fkey'
      AND table_name = 'ecritures_comptables'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'paiements'
  ) THEN
    ALTER TABLE public.ecritures_comptables
      ADD CONSTRAINT ecritures_comptables_paiement_id_fkey
      FOREIGN KEY (paiement_id) REFERENCES public.paiements(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Index : on interroge « les écritures de CE règlement », jamais l'inverse.
CREATE INDEX IF NOT EXISTS idx_ecritures_paiement
  ON public.ecritures_comptables (paiement_id)
  WHERE paiement_id IS NOT NULL;

-- ─── 2. Pointage et quittance sur les lignes de banque ───────────────────────
ALTER TABLE public.transactions_bancaires
  ADD COLUMN IF NOT EXISTS pointe boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS quittance_path text,
  ADD COLUMN IF NOT EXISTS quittance_nom text;

COMMENT ON COLUMN public.transactions_bancaires.quittance_path IS
  'Chemin dans le bucket privé de la quittance SIMPL-TVA justifiant ce prélèvement DGI.';

-- ─── 3. Pointage des écritures (comptes de TVA, 4456 en particulier) ─────────
ALTER TABLE public.ecritures_comptables
  ADD COLUMN IF NOT EXISTS pointe boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pointe_le timestamptz;

COMMENT ON COLUMN public.ecritures_comptables.pointe IS
  'Pointage (rapprochement SANS lettrage) — employé sur 4456 pour vérifier que la '
  'TVA déclarée a bien été prélevée. Le lettrage reste réservé aux comptes de tiers.';

-- ─── 4. Bucket privé des quittances ──────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public)
SELECT 'quittances-tva', 'quittances-tva', false
WHERE NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'quittances-tva');
