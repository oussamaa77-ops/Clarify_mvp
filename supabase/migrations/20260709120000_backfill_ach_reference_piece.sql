-- ════════════════════════════════════════════════════════════════════════════
-- BACKFILL — rattacher les écritures ACH historiques à leur facture fournisseur
-- ════════════════════════════════════════════════════════════════════════════
-- À coller dans Supabase SQL Editor (rejouable, idempotent).
--
-- CONTEXTE. La suppression d'une facture fournisseur efface ses écritures via
--   DELETE FROM ecritures_comptables WHERE reference_piece = <id facture>
-- Or les écritures d'achat créées AVANT que ce rattachement ne soit posé ont
-- reference_piece = NULL : supprimer leur facture les laissait ORPHELINES dans le
-- Grand Livre (charge 6141 + TVA 34552 + dette 4411 sans pièce justificative).
--
-- On ne peut pas utiliser ecritures_comptables.facture_id : sa clé étrangère pointe
-- sur `factures` (clients), et refuse un id de facture fournisseur.
--
-- APPARIEMENT. dossier + date du document + nom du fournisseur, ce dernier étant
-- toujours repris dans le libellé (« Achat ATLAS PACKAGING MAROC SARL FAC-… »).
-- Les montants sont volontairement écartés : la ligne de TVA a un débit nul quand le
-- taux est 0 %, exactement comme la ligne de dette — l'appariement deviendrait faux.
--
-- SÉCURITÉ. On n'estampille QUE si le couple (date, fournisseur) désigne une seule
-- facture. Une écriture ambiguë reste NULL : elle sera signalée, jamais rattachée
-- au hasard à la mauvaise facture.

UPDATE public.ecritures_comptables e
   SET reference_piece = f.id::text
  FROM public.factures_fournisseurs f
 WHERE e.journal_code    = 'ACH'
   AND e.reference_piece IS NULL
   AND f.dossier_id      = e.dossier_id
   AND f.date_facture    = e.date_ecriture
   AND f.fournisseur_nom IS NOT NULL
   AND e.libelle IS NOT NULL
   AND upper(e.libelle) LIKE '%' || upper(f.fournisseur_nom) || '%'
   -- Unicité : aucune autre facture du même fournisseur à la même date.
   AND (
     SELECT count(*) FROM public.factures_fournisseurs f2
      WHERE f2.dossier_id      = e.dossier_id
        AND f2.date_facture    = e.date_ecriture
        AND f2.fournisseur_nom = f.fournisseur_nom
   ) = 1;

-- ─── Contrôle : ce qui reste non rattaché ────────────────────────────────────
-- Causes possibles, à distinguer AVANT toute suppression :
--   • couple (date, fournisseur) ambigu → à rattacher à la main ;
--   • le libellé porte un AUTRE nom de fournisseur que la facture (OCR ayant repris
--     le tiers de la facture précédente) → l'appariement par nom échoue ;
--   • facture réellement supprimée → écritures orphelines, séquelles du bug.
--
-- Cas rencontré le 2026-07-09 (STE SMERT WATER) : 3 lignes du 2026-03-24 libellées
-- « PRO-FLUIDES MAROC SARL » étaient en fait un DOUBLON de la facture FA-2026-90812
-- (MAROC TELECOM (IAM) SA), saisie deux fois — la charge, la TVA récupérable et la
-- dette étaient comptées double. Elles ont été supprimées après contrôle manuel.
-- Ne jamais conclure « facture supprimée » sur la seule foi du libellé : vérifier
-- d'abord par le NUMÉRO de facture, qu'il reprend (« … FA-2026-90812 »).
--
-- SELECT date_ecriture, compte_numero, debit, credit, libelle
--   FROM public.ecritures_comptables
--  WHERE journal_code = 'ACH' AND reference_piece IS NULL
--  ORDER BY date_ecriture;
