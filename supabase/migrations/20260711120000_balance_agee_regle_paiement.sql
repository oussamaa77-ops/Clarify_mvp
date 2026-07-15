-- ════════════════════════════════════════════════════════════════════════════
-- BALANCE ÂGÉE v2 — séparation payé/non payé blindée + règle de date explicite
-- ════════════════════════════════════════════════════════════════════════════
-- À coller dans Supabase SQL Editor (rejouable). Remplace la vue de la migration
-- 20260710133000_balance_agee. Colonnes de sortie STRICTEMENT identiques : l'UI
-- (composant BalanceAgee) et le script verify_balance_agee.mjs ne changent pas.
--
-- CE QUI ÉTAIT DÉJÀ CORRECT (confirmé par sonde lecture seule sur le dossier de prod,
-- 2026-07-11 : 0 retard fantôme, 0 écart de payé, 0 mauvaise date) :
--   • reste à payer = montant_ttc − SUM(paiements), soldé (reste ≈ 0) écarté ;
--   • la date de règlement d'un lettrage vient de transactions_bancaires.date_operation
--     et celle d'un encaissement de encaissements.date_encaissement — JAMAIS la date
--     système du rapprochement (paiements.date_paiement, alimenté par lier_transaction
--     et le backfill, porte déjà l'une ou l'autre).
--
-- CE QUE CETTE VERSION DURCIT / REND EXPLICITE, pour que les cas encore absents des
-- données (paiement partiel, facture réglée en retard) restent justes par construction :
--
--   1. SÉPARATION PAYÉ / NON PAYÉ (règle #1) — le payé retenu est le MAXIMUM entre
--      SUM(paiements) et la colonne factures.montant_paye. Normalement égaux (le trigger
--      paiements_resync maintient l'égalité), mais si un règlement transitait un jour par
--      le repli direct (montant_paye écrit sans ligne `paiements`, avant migration), il
--      serait tout de même déduit : plus aucune facture réglée ne peut réapparaître « due »,
--      donc AUCUN retard fantôme. Le MAX (et non la somme) exclut tout double comptage.
--
--   2. DATE QUI ARRÊTE LE COMPTEUR (règles #2 et #3) — le retard se mesure par rapport à
--      une DATE DE RÉFÉRENCE explicite, et non plus systématiquement CURRENT_DATE :
--        • facture soldée   → date du DERNIER paiement réel (date_operation / saisie
--          encaissement)         →  retard figé = date_paiement − échéance ;
--        • facture non soldée → CURRENT_DATE
--                                →  retard vivant = aujourd'hui − échéance.
--      Une facture soldée a un reste nul : elle ne pèse dans aucune tranche (règle #1) et,
--      son compteur étant figé, elle n'alimente jamais un « retard max » fantôme.
--
-- Exigibilité = échéance, à défaut date de facture, à défaut création (Casablanca).
-- Avoirs exclus. Acomptes non réglés conservés (somme réellement due).

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
    -- Payé = MAX(paiements, colonne dérivée) : blinde contre un règlement non encore
    -- reflété en `paiements` (repli direct). MAX, pas somme → zéro double comptage.
    GREATEST(COALESCE(pc.paye, 0), COALESCE(f.montant_paye, 0)) AS montant_paye,
    pc.dernier_paiement                                  AS dernier_paiement
  FROM public.factures f
  LEFT JOIN public.clients c ON c.id = f.client_id
  LEFT JOIN (
    SELECT facture_id, SUM(montant) AS paye, MAX(date_paiement) AS dernier_paiement
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

-- Reste à payer + DATE DE RÉFÉRENCE du compteur (soldé → dernier paiement, sinon aujourd'hui),
-- puis retard = référence − exigibilité. Reste ≤ 0 (soldé) écarté : une facture réglée
-- n'est jamais « en retard » (règle #1) et son compteur figé n'inflate aucun total.
factures_dues AS (
  SELECT
    fx.*,
    ROUND(GREATEST(fx.montant_ttc - fx.montant_paye, 0)::numeric, 2) AS reste_a_payer,
    ( CASE
        WHEN GREATEST(fx.montant_ttc - fx.montant_paye, 0) <= 0.005
          THEN COALESCE(fx.dernier_paiement, fx.date_exigibilite)   -- soldé : compteur figé
        ELSE CURRENT_DATE                                           -- dû : compteur vivant
      END
      - fx.date_exigibilite )                                       AS jours_retard
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
  'Balance âgée par tiers. Reste à payer = montant_ttc − MAX(SUM(paiements), montant_paye) '
  'sur les factures non soldées, ventilé non échu / 1-30 / 31-60 / +60 j. Le compteur de '
  'retard se fige à la date du dernier paiement réel (date_operation / date_encaissement) '
  'quand la facture est soldée, sinon court jusqu''à CURRENT_DATE. Avoirs exclus, acomptes inclus.';
