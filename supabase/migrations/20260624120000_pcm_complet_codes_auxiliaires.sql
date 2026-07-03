-- ════════════════════════════════════════════════════════════════════════════
-- ÉTAPE 0 — Fondation BD : PCM marocain (référence globale) + Codes auxiliaires
-- ════════════════════════════════════════════════════════════════════════════
-- À coller dans Supabase SQL Editor (REJOUABLE / idempotent — additif uniquement).
--
-- Objectifs :
--   1. Centraliser le Plan Comptable Marocain (CGNC) dans UNE table de référence
--      globale `pcm_reference` (non liée à un dossier), ~150 comptes courants TPE/PME.
--   2. Faire semer chaque NOUVEAU dossier depuis cette référence (remplace le seed
--      « 14 comptes en dur » de init_pcm_for_dossier, SANS toucher au seed des journaux).
--   3. Backfiller les dossiers EXISTANTS (ON CONFLICT DO NOTHING → ne duplique rien,
--      ne réécrit pas les comptes déjà créés/édités).
--   4. Ajouter `code_auxiliaire` sur clients & fournisseurs (compta auxiliaire /
--      balance âgée, compatible import Sage).
--
-- Non destructif : aucun DROP de colonne, aucun renommage. Les comptes déjà présents
-- dans comptes_comptables sont préservés tels quels.

-- ─── 1. Table de référence globale du PCM ────────────────────────────────────
-- Pas de dossier_id : c'est un référentiel partagé par tout le cabinet.
-- type_compte : aligné sur les valeurs déjà utilisées par comptes_comptables
--   (capitaux | immobilisations | actif_circulant | passif_circulant
--    | tresorerie | charges | produits).
CREATE TABLE IF NOT EXISTS public.pcm_reference (
  numero      TEXT PRIMARY KEY,
  intitule    TEXT NOT NULL,
  type_compte TEXT NOT NULL,
  classe      SMALLINT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 2. Seed du PCM courant étendu (CGNC, ~150 comptes) ──────────────────────
-- INSERT idempotent : on (ré)aligne intitulé/type/classe si le numéro existe déjà.
INSERT INTO public.pcm_reference (numero, intitule, type_compte, classe) VALUES
  -- ══ CLASSE 1 — Comptes de financement permanent ══
  ('1111','Capital social','capitaux',1),
  ('1117','Capital personnel','capitaux',1),
  ('1119','Actionnaires, capital souscrit non appelé','capitaux',1),
  ('1140','Réserve légale','capitaux',1),
  ('1151','Réserves statutaires ou contractuelles','capitaux',1),
  ('1152','Réserves facultatives','capitaux',1),
  ('1161','Report à nouveau (solde créditeur)','capitaux',1),
  ('1169','Report à nouveau (solde débiteur)','capitaux',1),
  ('1181','Résultats nets en instance d''affectation (SC)','capitaux',1),
  ('1191','Résultat net de l''exercice (solde créditeur)','capitaux',1),
  ('1199','Résultat net de l''exercice (solde débiteur)','capitaux',1),
  ('1311','Subventions d''investissement reçues','capitaux',1),
  ('1481','Emprunts auprès des établissements de crédit','capitaux',1),
  ('1486','Fournisseurs d''immobilisations','capitaux',1),
  ('1487','Dettes rattachées à des participations','capitaux',1),
  ('1511','Provisions pour risques','capitaux',1),
  ('1518','Autres provisions pour risques et charges','capitaux',1),

  -- ══ CLASSE 2 — Comptes d'actif immobilisé ══
  ('2111','Frais de constitution','immobilisations',2),
  ('2117','Frais préliminaires','immobilisations',2),
  ('2121','Frais de recherche et développement','immobilisations',2),
  ('2125','Frais d''augmentation du capital','immobilisations',2),
  ('2220','Brevets, marques, droits et valeurs similaires','immobilisations',2),
  ('2230','Fonds commercial','immobilisations',2),
  ('2285','Immobilisations incorporelles en cours','immobilisations',2),
  ('2311','Terrains nus','immobilisations',2),
  ('2313','Terrains aménagés','immobilisations',2),
  ('2321','Bâtiments','immobilisations',2),
  ('2327','Agencements et aménagements des constructions','immobilisations',2),
  ('2332','Matériel et outillage','immobilisations',2),
  ('2340','Matériel de transport','immobilisations',2),
  ('2351','Mobilier de bureau','immobilisations',2),
  ('2352','Matériel de bureau','immobilisations',2),
  ('2355','Matériel informatique','immobilisations',2),
  ('2356','Agencements, aménagements, installations','immobilisations',2),
  ('2486','Dépôts et cautionnements versés','immobilisations',2),
  ('2811','Amortissements des frais préliminaires','immobilisations',2),
  ('2820','Amortissements des immobilisations incorporelles','immobilisations',2),
  ('2832','Amortissements du matériel et outillage','immobilisations',2),
  ('2834','Amortissements du matériel de transport','immobilisations',2),
  ('2835','Amortissements du mobilier, matériel de bureau et aménagements','immobilisations',2),

  -- ══ CLASSE 3 — Comptes d'actif circulant (hors trésorerie) ══
  ('3111','Marchandises (stock)','actif_circulant',3),
  ('3121','Matières premières','actif_circulant',3),
  ('3122','Matières et fournitures consommables','actif_circulant',3),
  ('3151','Produits finis','actif_circulant',3),
  ('3411','Fournisseurs débiteurs, avances et acomptes','actif_circulant',3),
  ('3421','Clients','actif_circulant',3),
  ('3424','Clients douteux ou litigieux','actif_circulant',3),
  ('3425','Clients - effets à recevoir','actif_circulant',3),
  ('3427','Clients - factures à établir et créances sur travaux non facturés','actif_circulant',3),
  ('3431','Personnel - avances et acomptes','actif_circulant',3),
  ('3441','État - subventions à recevoir','actif_circulant',3),
  ('3451','État - acomptes sur impôts sur les résultats','actif_circulant',3),
  ('3455','État - TVA récupérable','actif_circulant',3),
  ('34551','État - TVA récupérable sur immobilisations','actif_circulant',3),
  ('34552','État - TVA récupérable sur charges','actif_circulant',3),
  ('3456','État - crédit de TVA','actif_circulant',3),
  ('3458','État - autres comptes débiteurs','actif_circulant',3),
  ('3461','Comptes d''associés débiteurs','actif_circulant',3),
  ('3481','Créances rattachées aux autres débiteurs','actif_circulant',3),
  ('3488','Divers débiteurs','actif_circulant',3),
  ('3491','Charges constatées d''avance','actif_circulant',3),
  ('3511','Titres et valeurs de placement','actif_circulant',3),

  -- ══ CLASSE 4 — Comptes de passif circulant (hors trésorerie) ══
  ('4411','Fournisseurs','passif_circulant',4),
  ('4415','Fournisseurs - effets à payer','passif_circulant',4),
  ('4417','Fournisseurs - factures non parvenues','passif_circulant',4),
  ('4419','Fournisseurs débiteurs (avances, RRR à obtenir)','passif_circulant',4),
  ('4191','Clients - avances et acomptes reçus','passif_circulant',4),
  ('4197','Clients - dettes pour emballages et matériel consignés','passif_circulant',4),
  ('4432','Rémunérations dues au personnel','passif_circulant',4),
  ('4441','Caisse nationale de sécurité sociale (CNSS)','passif_circulant',4),
  ('4443','État - impôt sur le revenu (IR)','passif_circulant',4),
  ('4445','État - impôts, taxes et assimilés','passif_circulant',4),
  ('4452','État - TVA facturée','passif_circulant',4),
  ('44551','État - TVA facturée','passif_circulant',4),
  ('4453','État - TVA due','passif_circulant',4),
  ('4456','État - crédit de TVA / TVA due','passif_circulant',4),
  ('4457','État - impôts sur les résultats','passif_circulant',4),
  ('4458','État - autres comptes créditeurs','passif_circulant',4),
  ('4461','Comptes d''associés créditeurs','passif_circulant',4),
  ('4465','Associés - dividendes à payer','passif_circulant',4),
  ('4481','Dettes sur acquisitions d''immobilisations','passif_circulant',4),
  ('4488','Divers créanciers','passif_circulant',4),
  ('4491','Produits constatés d''avance','passif_circulant',4),

  -- ══ CLASSE 5 — Comptes de trésorerie ══
  ('5141','Banques (solde débiteur)','tresorerie',5),
  ('5143','Trésorerie - chèques et valeurs à encaisser','tresorerie',5),
  ('5146','Chèques et valeurs à encaisser','tresorerie',5),
  ('5161','Caisses','tresorerie',5),
  ('5165','Régies d''avances et accréditifs','tresorerie',5),
  ('5520','Crédits d''escompte','tresorerie',5),
  ('5541','Banques (solde créditeur)','tresorerie',5),

  -- ══ CLASSE 6 — Comptes de charges ══
  ('6111','Achats de marchandises','charges',6),
  ('6112','Achats de marchandises (groupe B)','charges',6),
  ('6114','Variation de stocks de marchandises','charges',6),
  ('6121','Achats de matières premières','charges',6),
  ('6122','Achats de matières et fournitures consommables','charges',6),
  ('6123','Achats d''emballages','charges',6),
  ('6125','Achats non stockés de matières et fournitures','charges',6),
  ('6126','Achats de travaux, études et prestations de services','charges',6),
  ('6131','Locations et charges locatives','charges',6),
  ('6132','Redevances de crédit-bail','charges',6),
  ('6133','Entretien et réparations','charges',6),
  ('6134','Primes d''assurances','charges',6),
  ('6135','Rémunérations du personnel extérieur à l''entreprise','charges',6),
  ('6136','Rémunérations d''intermédiaires et honoraires','charges',6),
  ('6141','Études, recherches et documentation','charges',6),
  ('6142','Transports','charges',6),
  ('6143','Déplacements, missions et réceptions','charges',6),
  ('6144','Publicité, publications et relations publiques','charges',6),
  ('6145','Frais postaux et frais de télécommunications','charges',6),
  ('6146','Cotisations et dons','charges',6),
  ('6147','Services bancaires','charges',6),
  ('6148','Autres charges externes','charges',6),
  ('6161','Impôts et taxes directs','charges',6),
  ('6167','Impôts, taxes et droits assimilés','charges',6),
  ('6171','Rémunérations du personnel','charges',6),
  ('6174','Charges sociales','charges',6),
  ('6176','Charges sociales diverses','charges',6),
  ('6181','Autres charges d''exploitation','charges',6),
  ('6191','Dotations d''exploitation aux amortissements des immobilisations','charges',6),
  ('6195','Dotations d''exploitation aux provisions pour risques et charges','charges',6),
  ('6311','Intérêts des emprunts et dettes','charges',6),
  ('6313','Intérêts bancaires et sur opérations de financement','charges',6),
  ('6331','Pertes de change','charges',6),
  ('6347','Frais d''escompte et frais sur effets de commerce','charges',6),
  ('6386','Escomptes accordés','charges',6),
  ('6391','Dotations aux provisions pour dépréciation financière','charges',6),
  ('6582','Pénalités et amendes fiscales ou pénales','charges',6),
  ('6588','Autres charges non courantes','charges',6),
  ('6701','Impôts sur les bénéfices','charges',6),

  -- ══ CLASSE 7 — Comptes de produits ══
  ('7111','Ventes de marchandises','produits',7),
  ('7121','Ventes de biens produits au Maroc','produits',7),
  ('7122','Ventes de biens produits à l''étranger','produits',7),
  ('7124','Ventes de services produits au Maroc','produits',7),
  ('7126','Ventes de produits accessoires','produits',7),
  ('7127','Ventes de services produits à l''étranger','produits',7),
  ('7129','Rabais, remises et ristournes accordés par l''entreprise','produits',7),
  ('7131','Variation des stocks de produits','produits',7),
  ('7161','Subventions d''exploitation reçues','produits',7),
  ('7181','Autres produits d''exploitation','produits',7),
  ('7197','Transferts de charges d''exploitation','produits',7),
  ('7321','Produits des titres de participation','produits',7),
  ('7331','Gains de change','produits',7),
  ('7381','Intérêts et produits assimilés','produits',7),
  ('7386','Escomptes obtenus','produits',7),
  ('7388','Intérêts et autres produits financiers','produits',7),
  ('7513','Produits des cessions d''immobilisations','produits',7),
  ('7577','Reprises sur subventions d''investissement','produits',7),
  ('7581','Pénalités et dédits reçus','produits',7),
  ('7588','Autres produits non courants','produits',7)
ON CONFLICT (numero) DO UPDATE
  SET intitule = EXCLUDED.intitule,
      type_compte = EXCLUDED.type_compte,
      classe = EXCLUDED.classe;

-- ─── 3. RLS : référentiel en lecture seule pour tout utilisateur authentifié ──
ALTER TABLE public.pcm_reference ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pcm_read" ON public.pcm_reference;
CREATE POLICY "pcm_read" ON public.pcm_reference
  FOR SELECT TO authenticated
  USING (true);

-- ─── 4. Trigger de création de dossier : semer journaux + PCM depuis la référence ──
-- On conserve les journaux par défaut (inchangés) et on remplace le bloc « 14 comptes
-- en dur » par un SELECT depuis pcm_reference. ON CONFLICT DO NOTHING → sûr même si
-- des comptes existent déjà (réexécution, dossier partiellement initialisé).
CREATE OR REPLACE FUNCTION public.init_pcm_for_dossier()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  -- Journaux par défaut (identiques à l'existant)
  INSERT INTO public.journaux_comptables (dossier_id, code, intitule, type_journal) VALUES
    (NEW.id, 'VTE', 'Journal des ventes', 'ventes'),
    (NEW.id, 'ACH', 'Journal des achats', 'achats'),
    (NEW.id, 'BQ',  'Journal de banque', 'banque'),
    (NEW.id, 'CAI', 'Journal de caisse', 'caisse'),
    (NEW.id, 'OD',  'Opérations diverses', 'od'),
    (NEW.id, 'TVA', 'Journal TVA', 'tva')
  ON CONFLICT (dossier_id, code) DO NOTHING;

  -- Plan Comptable Marocain complet depuis le référentiel global
  INSERT INTO public.comptes_comptables (dossier_id, numero, intitule, type_compte)
  SELECT NEW.id, p.numero, p.intitule, p.type_compte
  FROM public.pcm_reference p
  ON CONFLICT (dossier_id, numero) DO NOTHING;

  RETURN NEW;
END;
$$;

-- ─── 5. Backfill des dossiers EXISTANTS ──────────────────────────────────────
-- Chaque dossier reçoit les comptes du PCM qui lui manquent. Les comptes déjà
-- présents (créés par l'ancien seed ou saisis manuellement) sont laissés intacts.
INSERT INTO public.comptes_comptables (dossier_id, numero, intitule, type_compte)
SELECT d.id, p.numero, p.intitule, p.type_compte
FROM public.dossiers d
CROSS JOIN public.pcm_reference p
ON CONFLICT (dossier_id, numero) DO NOTHING;

-- ─── 6. Codes auxiliaires sur les tiers (compta auxiliaire / balance âgée) ────
-- Format libre (TEXT) compatible import Sage : ex. « C0001 » clients, « F0001 »
-- fournisseurs. Nullable → n'impacte aucune insertion existante.
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS code_auxiliaire TEXT;
ALTER TABLE public.fournisseurs
  ADD COLUMN IF NOT EXISTS code_auxiliaire TEXT;

-- Index pour la recherche / le tri par code auxiliaire (balance âgée par tiers).
CREATE INDEX IF NOT EXISTS idx_clients_code_aux
  ON public.clients(dossier_id, code_auxiliaire)
  WHERE code_auxiliaire IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fournisseurs_code_aux
  ON public.fournisseurs(dossier_id, code_auxiliaire)
  WHERE code_auxiliaire IS NOT NULL;
