-- ════════════════════════════════════════════════════════════════════════════
-- CONSOLIDATION DES COLONNES DE TYPE — une seule source de vérité : l'enum `type`
-- ════════════════════════════════════════════════════════════════════════════
-- État constaté : `factures` porte DEUX colonnes de type qui n'encodent pas la même
-- chose —
--     • enum   `type`         ∈ (facture, avoir, proforma)   → NATURE du document
--     • texte  `type_facture` ∈ (standard, acompte, solde, avoir) → RÔLE échéancier
-- En prod : 10 lignes (facture / standard) et 1 ligne (facture / ACOMPTE).
--
-- L'objectif demandé — supprimer `type_facture`, ne garder que l'enum — est correct,
-- MAIS l'enum actuel ne sait pas dire « acompte » ni « solde ». Le supprimer tel quel
-- ferait DISPARAÎTRE le marquage d'acompte : les 3 calculs de CA qui excluent les
-- acomptes (dashboard, TiersReporting) se mettraient à les double-compter avec la
-- facture de solde. Ce serait une régression comptable.
--
-- DÉVIATION ASSUMÉE (à valider) : pour que `type` puisse VRAIMENT être l'unique source
-- de vérité SANS perdre de donnée, on ÉTEND l'enum à acompte/solde avant de supprimer
-- `type_facture`. Sur les données réelles il n'existe aucun conflit d'axe (aucune ligne
-- n'est à la fois « avoir » ET « acompte »), donc la fusion sur une seule colonne est
-- exacte. Un ordre littéral « drop sans étendre » reste possible — voir le bloc en fin
-- de fichier — mais il perd l'acompte ; à n'appliquer que si le métier abandonne la
-- notion d'acompte.
--
-- ⚠️ REVUE REQUISE avant application : ALTER COLUMN TYPE échoue si une VUE ou une
--    fonction dépend de `factures.type`. Vérifier au préalable :
--      SELECT dependent_view.relname FROM pg_depend d
--        JOIN pg_rewrite r ON r.oid = d.objid
--        JOIN pg_class dependent_view ON dependent_view.oid = r.ev_class
--        JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
--       WHERE d.refobjid = 'public.factures'::regclass AND a.attname = 'type';
--    (la vue v_balance_agee de ce lot se crée APRÈS, donc pas de dépendance ici.)

-- 1) Nouvel enum, sur-ensemble des deux axes réellement utilisés.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'facture_type') THEN
    CREATE TYPE public.facture_type AS ENUM ('facture','avoir','proforma','acompte','solde');
  END IF;
END $$;

-- 2) Bascule de la colonne `type` vers le nouvel enum, en fusionnant les deux colonnes.
--    Priorité : un avoir (quelle que soit la colonne qui le porte) reste un avoir ;
--    sinon le rôle échéancier (acompte/solde) prime sur « facture » ; proforma conservé.
ALTER TABLE public.factures ALTER COLUMN type DROP DEFAULT;

ALTER TABLE public.factures
  ALTER COLUMN type TYPE public.facture_type
  USING (
    CASE
      WHEN type::text = 'avoir'        THEN 'avoir'
      WHEN type_facture = 'avoir'      THEN 'avoir'
      WHEN type::text = 'proforma'     THEN 'proforma'
      WHEN type_facture = 'acompte'    THEN 'acompte'
      WHEN type_facture = 'solde'      THEN 'solde'
      ELSE 'facture'
    END::public.facture_type
  );

ALTER TABLE public.factures ALTER COLUMN type SET DEFAULT 'facture';

-- 3) La colonne en doublon disparaît. `type` est désormais l'unique source de vérité.
ALTER TABLE public.factures DROP COLUMN type_facture;

-- 4) L'ancien enum `type_facture` (facture/avoir/proforma) n'est plus référencé par
--    aucune colonne. On le laisse en place s'il est encore utilisé ailleurs ; sinon,
--    décommenter pour nettoyer :
-- DROP TYPE IF EXISTS public.type_facture;

COMMENT ON COLUMN public.factures.type IS
  'Nature ET rôle échéancier du document : facture | avoir | proforma | acompte | solde. '
  'Unique source de vérité (ex-colonne texte type_facture supprimée). '
  'Filtres : exclure les avoirs avec type <> ''avoir'' ; exclure les acomptes du CA avec type <> ''acompte''.';

-- ─────────────────────────────────────────────────────────────────────────────
-- VARIANTE LITTÉRALE (drop sans extension) — NE PAS appliquer avec le bloc ci-dessus.
-- À n'utiliser QUE si le métier renonce à distinguer les acomptes. Perd le marquage
-- de l'unique ligne acompte de prod ; les filtres CA doivent alors retirer l'exclusion
-- des acomptes (qui les compterait deux fois autrement).
--
--   UPDATE public.factures SET type = 'avoir' WHERE type_facture = 'avoir' AND type::text <> 'avoir';
--   ALTER TABLE public.factures DROP COLUMN type_facture;
-- ─────────────────────────────────────────────────────────────────────────────
