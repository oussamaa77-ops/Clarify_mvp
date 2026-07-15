-- ════════════════════════════════════════════════════════════════════════════
-- BALANCE ÂGÉE — reste à payer par tiers, ventilé par ancienneté (CURRENT_DATE)
-- ════════════════════════════════════════════════════════════════════════════
-- Version DYNAMIQUE : le reste à payer est recalculé à la volée depuis la table
-- `paiements` — montant_ttc − SUM(paiements) — et NON lu sur la colonne dérivée
-- montant_restant. La vue reste donc juste même si un jour la colonne dérivait à
-- nouveau : elle ne dépend que des factures et de leurs paiements réels.
--
-- Dépend de la migration `paiements_source_of_truth` (table `paiements`) et de
-- `consolidation_type_facture` (enum `type` incluant acompte/solde, plus de
-- colonne `type_facture`). D'où le numéro de séquence postérieur.
--
-- Exigibilité = échéance, à défaut date de facture, à défaut date de création
-- (Casablanca) : aucune facture due ne peut s'évaporer faute de date.
-- Avoirs exclus (ils diminuent la créance, ne la portent pas). Acomptes CONSERVÉS :
-- un acompte non réglé est une somme réellement due.

CREATE OR REPLACE VIEW public.v_balance_agee
WITH (security_invoker = true) AS

WITH factures_ouvertes AS (

  -- Ventes.
  SELECT
    f.dossier_id,
    'client'::text                                       AS sens,
    f.client_id                                          AS tiers_id,
    COALESCE(c.nom, '(client non rattaché)')             AS tiers_nom,
    f.id                                                 AS facture_id,
    COALESCE(f.date_echeance, f.date_facture, (f.created_at AT TIME ZONE 'Africa/Casablanca')::date) AS date_exigibilite,
    COALESCE(f.montant_ttc, 0)                           AS montant_ttc,
    COALESCE(pc.paye, 0)                                 AS montant_paye
  FROM public.factures f
  LEFT JOIN public.clients c ON c.id = f.client_id
  LEFT JOIN (
    SELECT facture_id, SUM(montant) AS paye
      FROM public.paiements WHERE facture_id IS NOT NULL GROUP BY facture_id
  ) pc ON pc.facture_id = f.id
  WHERE f.statut NOT IN ('brouillon', 'annulee')
    AND f.type <> 'avoir'          -- enum consolidé : unique source de vérité

  UNION ALL

  -- Achats. fournisseur_id nullable → repli sur fournisseur_nom pour ne pas perdre la dette.
  SELECT
    ff.dossier_id,
    'fournisseur'::text                                  AS sens,
    ff.fournisseur_id                                    AS tiers_id,
    COALESCE(fo.nom, NULLIF(btrim(ff.fournisseur_nom), ''), '(fournisseur non rattaché)') AS tiers_nom,
    ff.id                                                AS facture_id,
    COALESCE(ff.date_echeance, ff.date_facture, (ff.created_at AT TIME ZONE 'Africa/Casablanca')::date) AS date_exigibilite,
    COALESCE(ff.montant_ttc, 0)                          AS montant_ttc,
    COALESCE(pf.paye, 0)                                 AS montant_paye
  FROM public.factures_fournisseurs ff
  LEFT JOIN public.fournisseurs fo ON fo.id = ff.fournisseur_id
  LEFT JOIN (
    SELECT facture_fournisseur_id, SUM(montant) AS paye
      FROM public.paiements WHERE facture_fournisseur_id IS NOT NULL GROUP BY facture_fournisseur_id
  ) pf ON pf.facture_fournisseur_id = ff.id
  WHERE COALESCE(ff.statut, '') <> 'annulee'
),

-- Reste à payer dynamique + ancienneté. Reste ≤ 0 (soldé) écarté.
factures_dues AS (
  SELECT
    fx.*,
    ROUND(GREATEST(fx.montant_ttc - fx.montant_paye, 0)::numeric, 2) AS reste_a_payer,
    (CURRENT_DATE - fx.date_exigibilite)                             AS jours_retard
  FROM factures_ouvertes fx
  WHERE GREATEST(fx.montant_ttc - fx.montant_paye, 0) > 0.005
),

-- Ventilation : bornes mutuellement exclusives, somme = reste_a_payer.
factures_ventilees AS (
  SELECT
    fd.*,
    CASE WHEN fd.jours_retard <= 0             THEN fd.reste_a_payer ELSE 0 END AS non_echu,
    CASE WHEN fd.jours_retard BETWEEN  1 AND 30 THEN fd.reste_a_payer ELSE 0 END AS retard_1_30,
    CASE WHEN fd.jours_retard BETWEEN 31 AND 60 THEN fd.reste_a_payer ELSE 0 END AS retard_31_60,
    CASE WHEN fd.jours_retard > 60             THEN fd.reste_a_payer ELSE 0 END AS retard_60_plus
  FROM factures_dues fd
)

SELECT
  fv.dossier_id,
  fv.sens,
  fv.tiers_id,
  fv.tiers_nom,
  COUNT(*)::int                          AS nb_factures,
  SUM(fv.reste_a_payer)                  AS total_du,
  SUM(fv.non_echu)                       AS non_echu,
  SUM(fv.retard_1_30)                    AS retard_1_30,
  SUM(fv.retard_31_60)                   AS retard_31_60,
  SUM(fv.retard_60_plus)                 AS retard_60_plus,
  MIN(fv.date_exigibilite)               AS plus_ancienne_echeance,
  GREATEST(MAX(fv.jours_retard), 0)::int AS jours_retard_max
FROM factures_ventilees fv
GROUP BY fv.dossier_id, fv.sens, fv.tiers_id, fv.tiers_nom;

COMMENT ON VIEW public.v_balance_agee IS
  'Balance âgée par tiers. Reste à payer = montant_ttc − SUM(paiements) sur les factures '
  'non soldées, ventilé non échu / 1-30 / 31-60 / +60 j à CURRENT_DATE. Calcul dynamique '
  '(indépendant de la colonne montant_restant). Avoirs exclus, acomptes inclus.';
