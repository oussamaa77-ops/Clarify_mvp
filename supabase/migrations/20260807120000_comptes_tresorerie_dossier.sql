-- ============================================================================
-- COMPTES DE TRÉSORERIE DU DOSSIER — caisse (516) et banque (514)
--
-- POURQUOI : le règlement en espèces s'imputait en 5143. Au PCM marocain (CGNC),
-- 5143 est la TRÉSORERIE GÉNÉRALE ; la caisse, c'est 5161 :
--
--     514  Banques, Trésorerie Générale et Chèques postaux
--          5141 Banques (soldes débiteurs)      ← virement / chèque / carte
--          5143 Trésorerie Générale
--     516  Caisses, Régies d'avances et accréditifs
--          5161 Caisses                          ← ESPÈCES
--          5165 Régies d'avances et accréditifs
--
-- L'erreur ne se voyait pas au journal (le montant y était juste) mais rangeait
-- les espèces dans le mauvais poste du bilan : aucun contrôle de caisse ne
-- pouvait boucler, et le poste « Trésorerie Générale » gonflait sans raison.
--
-- Ces deux colonnes restent OPTIONNELLES : le code retombe sur 51610000 / 5141
-- quand elles sont NULL — ou absentes, tant que cette migration n'est pas
-- appliquée. Elles servent au cabinet qui ouvre un sous-compte par caisse
-- (51610000 siège, 51610001 agence…) ou par banque.
--
-- ⚠️ À exécuter manuellement dans le dashboard Supabase (SQL editor). Idempotent.
-- ============================================================================

ALTER TABLE public.dossiers
  ADD COLUMN IF NOT EXISTS compte_caisse TEXT,
  ADD COLUMN IF NOT EXISTS compte_banque TEXT;

-- Garde-fou : un sous-compte mal saisi enverrait les règlements hors de leur
-- poste de bilan, exactement la panne qu'on corrige. La contrainte impose la
-- RUBRIQUE ; elle laisse libre la profondeur du sous-compte.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'dossiers_compte_caisse_rubrique'
  ) THEN
    ALTER TABLE public.dossiers
      ADD CONSTRAINT dossiers_compte_caisse_rubrique
      CHECK (compte_caisse IS NULL OR compte_caisse ~ '^516[0-9]{0,7}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'dossiers_compte_banque_rubrique'
  ) THEN
    ALTER TABLE public.dossiers
      ADD CONSTRAINT dossiers_compte_banque_rubrique
      CHECK (compte_banque IS NULL OR compte_banque ~ '^514[0-9]{0,7}$');
  END IF;
END $$;

COMMENT ON COLUMN public.dossiers.compte_caisse IS
  'Sous-compte de caisse du dossier (rubrique 516 du PCM). NULL → 51610000. Utilisé par le règlement en espèces (journal CAI).';
COMMENT ON COLUMN public.dossiers.compte_banque IS
  'Sous-compte bancaire du dossier (rubrique 514 du PCM). NULL → 5141. Utilisé par les règlements non-espèces (journal BQ).';

-- ── Référentiel PCM : la caisse doit exister comme compte imputable ──────────
INSERT INTO public.pcm_reference (numero, intitule, type_compte, classe)
VALUES
  ('5161',     'Caisses',                            'actif_circulant', 5),
  ('51610000', 'Caisse centrale',                    'actif_circulant', 5),
  ('5165',     'Régies d''avances et accréditifs',   'actif_circulant', 5)
ON CONFLICT (numero) DO NOTHING;

-- ── Reprise des écritures déjà passées en 5143 ───────────────────────────────
-- Périmètre VOLONTAIREMENT étroit, en deux passes. Une ligne 5143 quelconque
-- peut être une VRAIE opération de Trésorerie Générale (grand livre importé) :
-- on ne reprend que ce dont on sait avec certitude que c'est de la caisse.
--
-- Passe 1 — journal de caisse (CAI). Il n'est alimenté que par les règlements
-- en espèces de l'application : tout 5143 qu'on y trouve est une caisse.
UPDATE public.ecritures_comptables
   SET compte_numero = '51610000'
 WHERE journal_code = 'CAI'
   AND compte_numero = '5143';

-- Passe 2 — journal de banque (BQ). Les RETRAITS d'espèces y vivent : la caisse
-- est la contrepartie du retrait, l'écriture reste au journal de banque. Ici le
-- journal ne suffit donc pas à trancher, le libellé est ajouté au filtre.
UPDATE public.ecritures_comptables
   SET compte_numero = '51610000'
 WHERE journal_code = 'BQ'
   AND compte_numero = '5143'
   AND upper(coalesce(libelle, '')) ~ '(RETRAIT|\mGAB\M|\mDAB\M)';

-- Compte affiché sur la transaction du relevé — sinon l'écran continuerait
-- d'annoncer 5143 pour une écriture désormais passée en 51610000.
UPDATE public.transactions_bancaires
   SET compte_comptable = '51610000'
 WHERE compte_comptable IN ('5143', '5161')
   AND categorie = 'retrait_especes';
