-- ════════════════════════════════════════════════════════════════════════════
-- BALANCE ÂGÉE v3 — état COMPLET des factures (payées + impayées) + délai de règlement
-- ════════════════════════════════════════════════════════════════════════════
-- À coller dans Supabase SQL Editor (rejouable). Remplace la vue v2
-- (20260711120000_balance_agee_regle_paiement).
--
-- CHANGEMENT DE PÉRIMÈTRE demandé : la balance âgée ne se limite plus au reste dû. Elle
-- présente désormais, par tiers (client OU fournisseur), l'ÉTAT de TOUTES les factures :
--   • ce qui est déjà réglé (total_paye) ;
--   • ce qui reste dû, ventilé non échu / 1-30 / 31-60 / +60 j (inchangé) ;
--   • le DÉLAI DE RÈGLEMENT moyen = date du paiement − date de facture, sur les factures
--     soldées (comportement de paiement réel : DSO côté clients, DPO côté fournisseurs).
--
-- INVARIANTS CONSERVÉS (verify_balance_agee.mjs reste vert) :
--   • non_echu + retard_1_30 + retard_31_60 + retard_60_plus = total_du (le reste dû) ;
--   • total_du agrège UNIQUEMENT le reste à payer (une facture soldée y pèse 0) ;
--   • plus_ancienne_echeance / jours_retard_max ne portent que sur l'IMPAYÉ (FILTER),
--     donc une facture réglée en retard n'invente jamais un « retard max ».
--
-- Payé retenu = MAX(SUM(paiements), montant_paye) — cf. v2, blinde contre un règlement
-- non reflété en `paiements`. Date de règlement = MAX(paiements.date_paiement), qui porte
-- déjà la date_operation (banque) ou date_encaissement (espèces), jamais la date système.
--
-- Exigibilité = échéance, à défaut date de facture, à défaut création (Casablanca).
-- Avoirs exclus. Acomptes inclus.
--
-- ⚠️  DROP AVANT CREATE — obligatoire ici. La v3 AJOUTE des colonnes (total_facture,
--     total_paye, nb_ouvertes, nb_reglees, delai_reglement_moyen) et en change l'ORDRE.
--     PostgreSQL interdit à CREATE OR REPLACE VIEW de renommer/réordonner/ajouter des
--     colonnes au milieu (ERROR 42P16). On détruit donc la vue puis on la recrée.
--     Il n'existe qu'UNE vue (v_balance_agee) : elle sert clients ET fournisseurs via la
--     colonne `sens`, il n'y a pas deux vues distinctes. CASCADE par sécurité : aucun
--     objet ne dépend de cette vue aujourd'hui (vérifié), donc rien d'autre n'est détruit.
DROP VIEW IF EXISTS public.v_balance_agee CASCADE;

CREATE VIEW public.v_balance_agee
WITH (security_invoker = true) AS

WITH factures_base AS (

  -- Ventes.
  SELECT
    f.dossier_id,
    'client'::text                                       AS sens,
    f.client_id                                          AS tiers_id,
    COALESCE(c.nom, '(client non rattaché)')             AS tiers_nom,
    f.id                                                 AS facture_id,
    f.date_facture                                       AS date_facture,
    COALESCE(f.date_echeance, f.date_facture, (f.created_at AT TIME ZONE 'Africa/Casablanca')::date) AS date_exigibilite,
    COALESCE(f.montant_ttc, 0)                           AS montant_ttc,
    GREATEST(COALESCE(pc.paye, 0), COALESCE(f.montant_paye, 0)) AS montant_paye,
    pc.dernier_paiement                                  AS dernier_paiement
  FROM public.factures f
  LEFT JOIN public.clients c ON c.id = f.client_id
  LEFT JOIN (
    SELECT facture_id, SUM(montant) AS paye, MAX(date_paiement) AS dernier_paiement
      FROM public.paiements WHERE facture_id IS NOT NULL GROUP BY facture_id
  ) pc ON pc.facture_id = f.id
  WHERE f.statut NOT IN ('brouillon', 'annulee')
    AND f.type <> 'avoir'

  UNION ALL

  -- Achats.
  SELECT
    ff.dossier_id,
    'fournisseur'::text                                  AS sens,
    ff.fournisseur_id                                    AS tiers_id,
    COALESCE(fo.nom, NULLIF(btrim(ff.fournisseur_nom), ''), '(fournisseur non rattaché)') AS tiers_nom,
    ff.id                                                AS facture_id,
    ff.date_facture                                      AS date_facture,
    COALESCE(ff.date_echeance, ff.date_facture, (ff.created_at AT TIME ZONE 'Africa/Casablanca')::date) AS date_exigibilite,
    COALESCE(ff.montant_ttc, 0)                          AS montant_ttc,
    GREATEST(COALESCE(pf.paye, 0), COALESCE(ff.montant_paye, 0)) AS montant_paye,
    pf.dernier_paiement                                  AS dernier_paiement
  FROM public.factures_fournisseurs ff
  LEFT JOIN public.fournisseurs fo ON fo.id = ff.fournisseur_id
  LEFT JOIN (
    SELECT facture_fournisseur_id, SUM(montant) AS paye, MAX(date_paiement) AS dernier_paiement
      FROM public.paiements WHERE facture_fournisseur_id IS NOT NULL GROUP BY facture_fournisseur_id
  ) pf ON pf.facture_fournisseur_id = ff.id
  WHERE COALESCE(ff.statut, '') <> 'annulee'
),

-- Par facture : reste, statut soldé, jours de retard (référence figée si soldé, sinon
-- aujourd'hui), et délai de règlement (jours facture → dernier paiement) si soldée.
factures_calc AS (
  SELECT
    fb.*,
    ROUND(GREATEST(fb.montant_ttc - fb.montant_paye, 0)::numeric, 2) AS reste_a_payer,
    (GREATEST(fb.montant_ttc - fb.montant_paye, 0) <= 0.005)         AS soldee,
    ( CASE
        WHEN GREATEST(fb.montant_ttc - fb.montant_paye, 0) <= 0.005
          THEN COALESCE(fb.dernier_paiement, fb.date_exigibilite)
        ELSE CURRENT_DATE
      END - fb.date_exigibilite )                                   AS jours_retard,
    -- Délai de règlement = jours entre facture et dernier paiement, UNIQUEMENT si soldée
    -- et si la date de paiement est postérieure ou égale à la facture. Un délai négatif
    -- (paiement daté AVANT la facture) n'est pas un délai : c'est une incohérence de date
    -- (rapprochement bancaire dont la date_operation ne correspond pas à la pièce). On
    -- l'écarte de la moyenne plutôt que de la polluer avec une valeur impossible.
    CASE
      WHEN GREATEST(fb.montant_ttc - fb.montant_paye, 0) <= 0.005
       AND fb.dernier_paiement IS NOT NULL
       AND fb.date_facture     IS NOT NULL
       AND fb.dernier_paiement >= fb.date_facture
      THEN (fb.dernier_paiement - fb.date_facture)
    END                                                             AS delai_reglement
  FROM factures_base fb
),

-- Ventilation du RESTE par ancienneté (une facture soldée → reste 0 → toutes tranches 0).
factures_ventilees AS (
  SELECT
    fc.*,
    CASE WHEN fc.reste_a_payer > 0.005 AND fc.jours_retard <= 0              THEN fc.reste_a_payer ELSE 0 END AS non_echu,
    CASE WHEN fc.reste_a_payer > 0.005 AND fc.jours_retard BETWEEN  1 AND 30 THEN fc.reste_a_payer ELSE 0 END AS retard_1_30,
    CASE WHEN fc.reste_a_payer > 0.005 AND fc.jours_retard BETWEEN 31 AND 60 THEN fc.reste_a_payer ELSE 0 END AS retard_31_60,
    CASE WHEN fc.reste_a_payer > 0.005 AND fc.jours_retard > 60              THEN fc.reste_a_payer ELSE 0 END AS retard_60_plus
  FROM factures_calc fc
)

SELECT
  fv.dossier_id,
  fv.sens,
  fv.tiers_id,
  fv.tiers_nom,
  COUNT(*)::int                                                    AS nb_factures,      -- toutes
  COUNT(*) FILTER (WHERE fv.reste_a_payer > 0.005)::int            AS nb_ouvertes,      -- impayées / partielles
  COUNT(*) FILTER (WHERE fv.delai_reglement IS NOT NULL)::int      AS nb_reglees,       -- base du délai
  ROUND(SUM(fv.montant_ttc)::numeric, 2)                          AS total_facture,
  ROUND(SUM(fv.montant_paye)::numeric, 2)                         AS total_paye,
  ROUND(SUM(fv.reste_a_payer)::numeric, 2)                        AS total_du,
  SUM(fv.non_echu)                                                AS non_echu,
  SUM(fv.retard_1_30)                                             AS retard_1_30,
  SUM(fv.retard_31_60)                                            AS retard_31_60,
  SUM(fv.retard_60_plus)                                          AS retard_60_plus,
  MIN(fv.date_exigibilite) FILTER (WHERE fv.reste_a_payer > 0.005)         AS plus_ancienne_echeance,
  GREATEST(COALESCE(MAX(fv.jours_retard) FILTER (WHERE fv.reste_a_payer > 0.005), 0), 0)::int AS jours_retard_max,
  ROUND(AVG(fv.delai_reglement) FILTER (WHERE fv.delai_reglement IS NOT NULL), 0)::int        AS delai_reglement_moyen
FROM factures_ventilees fv
GROUP BY fv.dossier_id, fv.sens, fv.tiers_id, fv.tiers_nom;

COMMENT ON VIEW public.v_balance_agee IS
  'État des factures par tiers (payées + impayées). total_facture / total_paye / total_du, '
  'reste ventilé non échu / 1-30 / 31-60 / +60 j (somme = total_du). delai_reglement_moyen = '
  'moyenne (date_paiement − date_facture) sur les factures soldées (DSO clients / DPO '
  'fournisseurs). plus_ancienne_echeance & jours_retard_max ne portent que sur l''impayé. '
  'Avoirs exclus, acomptes inclus.';
