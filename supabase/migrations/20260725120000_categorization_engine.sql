-- ─────────────────────────────────────────────────────────────────────────────
-- Moteur de catégorisation comptable PCM — champs de configuration
-- ─────────────────────────────────────────────────────────────────────────────
-- Ces colonnes alimentent la Règle 1 (compte par défaut du tiers) et la Règle 3
-- (fallback sectoriel) du CategorizationEngine (src/lib/categorization-engine.ts).
--
-- Idempotent : « IF NOT EXISTS » pour pouvoir rejouer la migration sans risque
-- (elle est appliquée MANUELLEMENT dans le dashboard Supabase — pas de CLI/psql
-- disponible sur ce réseau).

-- 1. Secteur d'activité du dossier (entreprise) — pilote le fallback sectoriel.
--    Texte libre volontairement (pas d'ENUM) : la liste des secteurs évolue côté
--    applicatif sans nouvelle migration. Valeurs attendues : « Services IT »,
--    « Commerce / Négoce », « BTP », « Restauration », « Consulting »…
ALTER TABLE public.dossiers
  ADD COLUMN IF NOT EXISTS secteur_activite text;

-- 2. Compte de charge par défaut du fournisseur (ex. « 61455 » pour un opérateur
--    télécom). Prioritaire sur le dictionnaire de mots-clés.
ALTER TABLE public.fournisseurs
  ADD COLUMN IF NOT EXISTS compte_charge_defaut text;

-- 3. Compte de produit par défaut du client (ex. « 7111 »).
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS compte_produit_defaut text;

COMMENT ON COLUMN public.dossiers.secteur_activite IS
  'Secteur d''activité — fallback sectoriel du moteur de catégorisation PCM.';
COMMENT ON COLUMN public.fournisseurs.compte_charge_defaut IS
  'Compte PCM de charge par défaut (Règle 1 du CategorizationEngine).';
COMMENT ON COLUMN public.clients.compte_produit_defaut IS
  'Compte PCM de produit par défaut (Règle 1 du CategorizationEngine).';
