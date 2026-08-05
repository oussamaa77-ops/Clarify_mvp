-- ============================================================================
-- LETTRAGE INTERNE (codes AA, AB, AC…) + TVA AU RÉGIME DE L'ENCAISSEMENT
--
-- 1. `lettrage_code` : le code de lettrage GÉNÉRÉ par notre moteur. Colonne
--    DISTINCTE de `code_lettrage`, qui conserve le code d'origine du fichier
--    importé (Sage : A, B, AB…). Les deux vivent côte à côte sans se marcher
--    dessus : un « AB » importé et un « AB » généré ne désignent pas le même
--    rapprochement, et l'import doit rester réversible par lot.
--
-- 2. Comptes de TVA « en attente » du régime des encaissements marocain :
--    la TVA n'est exigible qu'au décaissement/encaissement, elle transite donc
--    par un compte d'attente entre la facture et le règlement.
--        VENTE  : facture → crédit 4458 (en attente) ; paiement → D 4458 / C 4455
--        ACHAT  : facture → débit  3458 (en attente) ; paiement → D 3455 / C 3458
--
-- ⚠️ À exécuter manuellement dans le dashboard Supabase (SQL editor). Idempotent.
-- ============================================================================

-- ── 1. Code de lettrage généré ──────────────────────────────────────────────
ALTER TABLE public.ecritures_comptables
  ADD COLUMN IF NOT EXISTS lettrage_code      TEXT,
  ADD COLUMN IF NOT EXISTS lettrage_date      TIMESTAMPTZ,
  -- Trace l'origine du lettrage : 'auto' (moteur, au paiement) ou 'manuel'
  -- (écran comptable). Sert au délettrage sélectif et à l'audit.
  ADD COLUMN IF NOT EXISTS lettrage_origine   TEXT
    CHECK (lettrage_origine IS NULL OR lettrage_origine IN ('auto','manuel'));

COMMENT ON COLUMN public.ecritures_comptables.lettrage_code IS
  'Code de lettrage GÉNÉRÉ par le moteur interne (AA, AB… séquence par dossier). NE PAS confondre avec code_lettrage = code d''origine du fichier importé.';
COMMENT ON COLUMN public.ecritures_comptables.lettrage_origine IS
  'auto = lettré par le moteur lors d''un paiement/rapprochement ; manuel = lettré depuis l''écran comptable.';

-- Un code de lettrage se lit toujours « toutes les lignes d'un même code, dans
-- un dossier » : c'est l'accès unitaire de l'écran de lettrage et de l'export.
CREATE INDEX IF NOT EXISTS idx_ecritures_lettrage_code
  ON public.ecritures_comptables (dossier_id, lettrage_code)
  WHERE lettrage_code IS NOT NULL;

-- Postes NON lettrés d'un compte de tiers : filtre par défaut de l'écran.
CREATE INDEX IF NOT EXISTS idx_ecritures_non_lettrees
  ON public.ecritures_comptables (dossier_id, compte_numero)
  WHERE lettrage_code IS NULL;

-- ── 2. Comptes de TVA au PCM de référence ───────────────────────────────────
-- 3455 / 3458 / 44551 / 4458 sont déjà présents ; 4455 (collecteur « TVA
-- facturée » au niveau exigible) manque au référentiel. On complète sans
-- écraser un intitulé existant.
INSERT INTO public.pcm_reference (numero, intitule, type_compte, classe)
VALUES ('4455', 'État - TVA facturée', 'passif_circulant', 4)
ON CONFLICT (numero) DO NOTHING;

-- Les deux comptes d'attente existent au PCM sous un intitulé générique
-- (« autres comptes débiteurs / créditeurs »). On ne renomme PAS le compte —
-- d'autres régularisations légitimes y transitent — on documente seulement
-- l'usage que le moteur en fait.
COMMENT ON TABLE public.ecritures_comptables IS
  'Grand livre. TVA au régime des encaissements : 4458 = TVA facturée EN ATTENTE (vente non encaissée), 3458 = TVA récupérable EN ATTENTE (achat non décaissé). La bascule vers 4455 / 3455 est passée en journal OD au moment du règlement, et porte le même lettrage_code que le règlement qui la déclenche.';

-- ── 3. Réversibilité ────────────────────────────────────────────────────────
-- Le délettrage remet lettrage_code/date/origine à NULL et supprime les OD de
-- bascule (repérées par leur lettrage_code + journal_code = 'OD'). Aucun
-- trigger ici : la logique vit dans le moteur applicatif, qui doit rester la
-- seule source de vérité du lettrage (cf. src/services/lettrage.ts).
