-- ════════════════════════════════════════════════════════════════════════════
-- FIX — sync_ecriture_contrepartie() écrasait la ligne de TVA déductible
-- ════════════════════════════════════════════════════════════════════════════
-- À coller dans Supabase SQL Editor (rejouable).
--
-- BUG. Une transaction lettrée à un justificatif éligible EDI génère DEUX lignes de
-- contrepartie au journal BQ : la charge au HT (ex. 6141) et la TVA déductible (34552).
-- Le trigger repositionnait « toutes les lignes sauf 5141 » sur un compte unique :
--
--   initial    : 6141 D=1000 | 34552 D=200 | 5141 C=1200
--   délettrage : 4711 D=1000 | 4711  D=200 | 5141 C=1200
--   re-lettrage: 6141 D=1000 | 6141  D=200 | 5141 C=1200   ← TVA devenue charge
--
-- L'écriture reste équilibrée, donc l'anomalie est SILENCIEUSE : seule la déclaration
-- de TVA (34552) est faussée, à la baisse de 200.
--
-- CORRECTIF. La ligne de TVA n'est jamais une contrepartie de tiers : on l'exclut de la
-- substitution. Elle conserve son compte à travers le cycle délettrage / re-lettrage,
-- et seule la ligne de charge/tiers bascule entre compte d'attente et compte définitif.

CREATE OR REPLACE FUNCTION public.sync_ecriture_contrepartie()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_final text;   -- compte final (NULL = orphelin → compte d'attente 4711/4712)
BEGIN
  -- Rien à faire si l'imputation (pièce liée) n'a pas changé.
  IF NEW.facture_id IS NOT DISTINCT FROM OLD.facture_id
     AND NEW.justificatif_id IS NOT DISTINCT FROM OLD.justificatif_id THEN
    RETURN NEW;
  END IF;

  -- Compte final selon la pièce désormais liée.
  IF NEW.facture_id IS NOT NULL AND NEW.document_type = 'facture_client' THEN
    v_final := '3421';                                   -- créance client
  ELSIF NEW.facture_id IS NOT NULL AND NEW.document_type = 'facture_fournisseur' THEN
    v_final := '4411';                                   -- dette fournisseur
  ELSIF NEW.justificatif_id IS NOT NULL THEN
    SELECT NULLIF(compte_pcm, '') INTO v_final
      FROM public.justificatifs WHERE id = NEW.justificatif_id;
    IF v_final IS NULL OR v_final !~ '^\d{3,}' THEN
      v_final := NULL;                                   -- pas de compte PCM exploitable → attente
    END IF;
  ELSE
    v_final := NULL;                                     -- orphelin (délettrage)
  END IF;

  -- MAJ de la (des) ligne(s) de contrepartie de cette transaction.
  -- Exclusions :
  --   • 5141   : la ligne de banque, jamais une contrepartie ;
  --   • 34552 / 44551 : les lignes de TVA (déductible / collectée). Les écraser
  --     reclasserait la taxe en charge et fausserait la déclaration — cf. en-tête.
  UPDATE public.ecritures_comptables e
     SET compte_numero = COALESCE(v_final, CASE WHEN e.debit > 0 THEN '4711' ELSE '4712' END)
   WHERE e.transaction_id = NEW.id
     AND e.journal_code = 'BQ'
     AND e.compte_numero NOT IN ('5141', '34552', '44551');

  RETURN NEW;
END $$;

-- Le trigger lui-même est inchangé ; on le recrée par sécurité (rejouable).
DROP TRIGGER IF EXISTS trg_sync_ecriture_contrepartie ON public.transactions_bancaires;
CREATE TRIGGER trg_sync_ecriture_contrepartie
  AFTER UPDATE OF facture_id, justificatif_id, document_type
  ON public.transactions_bancaires
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_ecriture_contrepartie();

-- ─── Contrôle après application ───────────────────────────────────────────────
-- Écritures BQ de TVA qui auraient déjà été reclassées en charge par l'ancien trigger :
-- une transaction dont la contrepartie porte deux lignes sur le MÊME compte est suspecte.
--   SELECT transaction_id, compte_numero, count(*), sum(debit), sum(credit)
--     FROM public.ecritures_comptables
--    WHERE journal_code = 'BQ' AND transaction_id IS NOT NULL AND compte_numero <> '5141'
--    GROUP BY transaction_id, compte_numero HAVING count(*) > 1;
