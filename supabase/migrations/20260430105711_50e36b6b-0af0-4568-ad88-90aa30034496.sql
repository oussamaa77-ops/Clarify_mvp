-- ============================================================
-- HisabPro Schema for Lovable Cloud
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ENUMS
CREATE TYPE public.app_role AS ENUM ('expert_comptable','assistant_cabinet','chef_entreprise','collaborateur');
CREATE TYPE public.statut_facture AS ENUM ('brouillon','envoyee','conforme','rejetee','annulee');
CREATE TYPE public.type_facture AS ENUM ('facture','avoir','proforma');
CREATE TYPE public.statut_paiement AS ENUM ('non_payee','partielle','payee','en_retard');
CREATE TYPE public.type_transaction AS ENUM ('credit','debit');

-- ============================================================
-- CABINETS
-- ============================================================
CREATE TABLE public.cabinets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nom TEXT NOT NULL,
  email TEXT,
  telephone TEXT,
  adresse TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- PROFILES (lié à auth.users)
-- ============================================================
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  nom TEXT,
  prenom TEXT,
  cabinet_id UUID REFERENCES public.cabinets(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- USER_ROLES (table séparée — sécurité)
-- ============================================================
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  cabinet_id UUID REFERENCES public.cabinets(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, role, cabinet_id)
);

-- ============================================================
-- SECURITY DEFINER FUNCTIONS (anti-recursion RLS)
-- ============================================================
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;

CREATE OR REPLACE FUNCTION public.get_user_cabinet(_user_id UUID)
RETURNS UUID
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT cabinet_id FROM public.profiles WHERE id = _user_id LIMIT 1 $$;

-- DOSSIERS
CREATE TABLE public.dossiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cabinet_id UUID NOT NULL REFERENCES public.cabinets(id) ON DELETE CASCADE,
  nom_societe TEXT NOT NULL,
  ice TEXT, rc TEXT, if_fiscal TEXT,
  adresse TEXT, email_societe TEXT, telephone TEXT,
  statut TEXT NOT NULL DEFAULT 'actif',
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.dossier_access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dossier_id UUID NOT NULL REFERENCES public.dossiers(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(dossier_id, user_id)
);

CREATE OR REPLACE FUNCTION public.has_dossier_access(_user_id UUID, _dossier_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.dossiers d
    WHERE d.id = _dossier_id
      AND (
        d.cabinet_id = public.get_user_cabinet(_user_id)
        OR EXISTS (SELECT 1 FROM public.dossier_access da WHERE da.dossier_id = _dossier_id AND da.user_id = _user_id)
      )
  )
$$;

-- CLIENTS / FOURNISSEURS
CREATE TABLE public.clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dossier_id UUID NOT NULL REFERENCES public.dossiers(id) ON DELETE CASCADE,
  nom TEXT NOT NULL, ice TEXT, if_fiscal TEXT, rc TEXT,
  email TEXT, telephone TEXT, adresse TEXT,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.fournisseurs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dossier_id UUID NOT NULL REFERENCES public.dossiers(id) ON DELETE CASCADE,
  nom TEXT NOT NULL, ice TEXT, if_fiscal TEXT, rc TEXT,
  email TEXT, telephone TEXT, adresse TEXT,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- FACTURES
CREATE TABLE public.factures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dossier_id UUID NOT NULL REFERENCES public.dossiers(id) ON DELETE CASCADE,
  client_id UUID REFERENCES public.clients(id),
  numero TEXT,
  type public.type_facture NOT NULL DEFAULT 'facture',
  statut public.statut_facture NOT NULL DEFAULT 'brouillon',
  statut_dgi TEXT,
  statut_paiement public.statut_paiement NOT NULL DEFAULT 'non_payee',
  date_facture DATE NOT NULL,
  date_echeance DATE, date_paiement DATE,
  montant_ht NUMERIC(15,2) NOT NULL DEFAULT 0,
  montant_tva NUMERIC(15,2) NOT NULL DEFAULT 0,
  montant_ttc NUMERIC(15,2) NOT NULL DEFAULT 0,
  lignes JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes TEXT, xml_ubl TEXT,
  hash_sha256 TEXT, dgi_uuid TEXT, dgi_response JSONB,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(dossier_id, numero)
);

CREATE TABLE public.factures_fournisseurs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dossier_id UUID NOT NULL REFERENCES public.dossiers(id) ON DELETE CASCADE,
  fournisseur_id UUID REFERENCES public.fournisseurs(id),
  fournisseur_nom TEXT,
  numero TEXT, statut TEXT NOT NULL DEFAULT 'recue',
  statut_dgi TEXT NOT NULL DEFAULT 'conforme',
  statut_paiement public.statut_paiement NOT NULL DEFAULT 'non_payee',
  date_facture DATE, date_echeance DATE, date_paiement DATE,
  montant_ht NUMERIC(15,2) NOT NULL DEFAULT 0,
  montant_tva NUMERIC(15,2) NOT NULL DEFAULT 0,
  montant_ttc NUMERIC(15,2) NOT NULL DEFAULT 0,
  xml_ubl TEXT, hash_sha256 TEXT, dgi_uuid TEXT, ocr_data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- COMPTABILITE
CREATE TABLE public.comptes_comptables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dossier_id UUID NOT NULL REFERENCES public.dossiers(id) ON DELETE CASCADE,
  numero TEXT NOT NULL, intitule TEXT NOT NULL, type_compte TEXT,
  solde_initial NUMERIC(15,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(dossier_id, numero)
);

CREATE TABLE public.journaux_comptables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dossier_id UUID NOT NULL REFERENCES public.dossiers(id) ON DELETE CASCADE,
  code TEXT NOT NULL, intitule TEXT NOT NULL, type_journal TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(dossier_id, code)
);

CREATE TABLE public.ecritures_comptables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dossier_id UUID NOT NULL REFERENCES public.dossiers(id) ON DELETE CASCADE,
  journal_code TEXT, compte_numero TEXT,
  date_ecriture DATE NOT NULL, libelle TEXT,
  debit NUMERIC(15,2) NOT NULL DEFAULT 0,
  credit NUMERIC(15,2) NOT NULL DEFAULT 0,
  reference_piece TEXT,
  facture_id UUID REFERENCES public.factures(id) ON DELETE SET NULL,
  valide BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- BANQUE
CREATE TABLE public.comptes_bancaires (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dossier_id UUID NOT NULL REFERENCES public.dossiers(id) ON DELETE CASCADE,
  banque TEXT, intitule TEXT, rib TEXT, iban TEXT,
  solde_actuel NUMERIC(15,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.transactions_bancaires (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  compte_id UUID NOT NULL REFERENCES public.comptes_bancaires(id) ON DELETE CASCADE,
  dossier_id UUID NOT NULL REFERENCES public.dossiers(id) ON DELETE CASCADE,
  date_operation DATE NOT NULL, libelle TEXT,
  type public.type_transaction NOT NULL,
  montant NUMERIC(15,2) NOT NULL,
  solde_apres NUMERIC(15,2),
  reference TEXT, rapproche BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- GED
CREATE TABLE public.ged_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dossier_id UUID NOT NULL REFERENCES public.dossiers(id) ON DELETE CASCADE,
  nom_fichier TEXT NOT NULL, type_document TEXT,
  url_stockage TEXT, hash_sha256 TEXT, dgi_uuid TEXT,
  horodatage TIMESTAMPTZ NOT NULL DEFAULT now(),
  taille_bytes INTEGER, mime_type TEXT,
  facture_id UUID REFERENCES public.factures(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- AUDIT
CREATE TABLE public.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dossier_id UUID REFERENCES public.dossiers(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id),
  user_email TEXT, action TEXT NOT NULL,
  ressource_type TEXT, ressource_id UUID, details JSONB,
  hash TEXT, hash_precedent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.alertes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dossier_id UUID NOT NULL REFERENCES public.dossiers(id) ON DELETE CASCADE,
  type TEXT, titre TEXT, message TEXT,
  lue BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- INDEXES
CREATE INDEX idx_factures_dossier ON public.factures(dossier_id);
CREATE INDEX idx_factures_statut ON public.factures(statut);
CREATE INDEX idx_ecritures_dossier ON public.ecritures_comptables(dossier_id);
CREATE INDEX idx_audit_dossier ON public.audit_logs(dossier_id);
CREATE INDEX idx_dossiers_cabinet ON public.dossiers(cabinet_id);

-- ============================================================
-- TRIGGER: auto-create profile on signup
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE _cabinet_id UUID;
BEGIN
  -- Crée un cabinet par défaut pour le nouvel utilisateur
  INSERT INTO public.cabinets (nom, email)
  VALUES (COALESCE(NEW.raw_user_meta_data->>'cabinet_nom', 'Mon Cabinet'), NEW.email)
  RETURNING id INTO _cabinet_id;

  INSERT INTO public.profiles (id, email, nom, prenom, cabinet_id)
  VALUES (
    NEW.id, NEW.email,
    NEW.raw_user_meta_data->>'nom',
    NEW.raw_user_meta_data->>'prenom',
    _cabinet_id
  );

  -- Rôle par défaut: expert_comptable (peut être changé)
  INSERT INTO public.user_roles (user_id, role, cabinet_id)
  VALUES (NEW.id, 'expert_comptable', _cabinet_id);

  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- ENABLE RLS
-- ============================================================
ALTER TABLE public.cabinets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dossiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dossier_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fournisseurs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.factures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.factures_fournisseurs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comptes_comptables ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journaux_comptables ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ecritures_comptables ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comptes_bancaires ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions_bancaires ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ged_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alertes ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- RLS POLICIES
-- ============================================================

-- Cabinets: utilisateur voit son cabinet
CREATE POLICY "view_own_cabinet" ON public.cabinets FOR SELECT TO authenticated
  USING (id = public.get_user_cabinet(auth.uid()));
CREATE POLICY "update_own_cabinet" ON public.cabinets FOR UPDATE TO authenticated
  USING (id = public.get_user_cabinet(auth.uid()) AND public.has_role(auth.uid(),'expert_comptable'));

-- Profiles
CREATE POLICY "view_own_profile" ON public.profiles FOR SELECT TO authenticated
  USING (id = auth.uid() OR cabinet_id = public.get_user_cabinet(auth.uid()));
CREATE POLICY "update_own_profile" ON public.profiles FOR UPDATE TO authenticated
  USING (id = auth.uid());

-- User roles
CREATE POLICY "view_own_roles" ON public.user_roles FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR cabinet_id = public.get_user_cabinet(auth.uid()));
CREATE POLICY "expert_manage_roles" ON public.user_roles FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'expert_comptable') AND cabinet_id = public.get_user_cabinet(auth.uid()))
  WITH CHECK (public.has_role(auth.uid(),'expert_comptable') AND cabinet_id = public.get_user_cabinet(auth.uid()));

-- Dossiers
CREATE POLICY "view_dossiers" ON public.dossiers FOR SELECT TO authenticated
  USING (cabinet_id = public.get_user_cabinet(auth.uid())
    OR EXISTS (SELECT 1 FROM public.dossier_access da WHERE da.dossier_id = id AND da.user_id = auth.uid()));
CREATE POLICY "create_dossiers" ON public.dossiers FOR INSERT TO authenticated
  WITH CHECK (cabinet_id = public.get_user_cabinet(auth.uid())
    AND public.has_role(auth.uid(),'expert_comptable'));
CREATE POLICY "update_dossiers" ON public.dossiers FOR UPDATE TO authenticated
  USING (cabinet_id = public.get_user_cabinet(auth.uid()));
CREATE POLICY "delete_dossiers" ON public.dossiers FOR DELETE TO authenticated
  USING (cabinet_id = public.get_user_cabinet(auth.uid()) AND public.has_role(auth.uid(),'expert_comptable'));

CREATE POLICY "view_dossier_access" ON public.dossier_access FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_dossier_access(auth.uid(), dossier_id));
CREATE POLICY "manage_dossier_access" ON public.dossier_access FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'expert_comptable') AND public.has_dossier_access(auth.uid(), dossier_id))
  WITH CHECK (public.has_role(auth.uid(),'expert_comptable') AND public.has_dossier_access(auth.uid(), dossier_id));

-- Dossier-scoped tables: même policy pour toutes
-- Helper macro via repetition
CREATE POLICY "ds_select" ON public.clients FOR SELECT TO authenticated USING (public.has_dossier_access(auth.uid(), dossier_id));
CREATE POLICY "ds_all" ON public.clients FOR ALL TO authenticated USING (public.has_dossier_access(auth.uid(), dossier_id)) WITH CHECK (public.has_dossier_access(auth.uid(), dossier_id));

CREATE POLICY "ds_select" ON public.fournisseurs FOR SELECT TO authenticated USING (public.has_dossier_access(auth.uid(), dossier_id));
CREATE POLICY "ds_all" ON public.fournisseurs FOR ALL TO authenticated USING (public.has_dossier_access(auth.uid(), dossier_id)) WITH CHECK (public.has_dossier_access(auth.uid(), dossier_id));

CREATE POLICY "ds_select" ON public.factures FOR SELECT TO authenticated USING (public.has_dossier_access(auth.uid(), dossier_id));
CREATE POLICY "ds_all" ON public.factures FOR ALL TO authenticated USING (public.has_dossier_access(auth.uid(), dossier_id)) WITH CHECK (public.has_dossier_access(auth.uid(), dossier_id));

CREATE POLICY "ds_select" ON public.factures_fournisseurs FOR SELECT TO authenticated USING (public.has_dossier_access(auth.uid(), dossier_id));
CREATE POLICY "ds_all" ON public.factures_fournisseurs FOR ALL TO authenticated USING (public.has_dossier_access(auth.uid(), dossier_id)) WITH CHECK (public.has_dossier_access(auth.uid(), dossier_id));

CREATE POLICY "ds_select" ON public.comptes_comptables FOR SELECT TO authenticated USING (public.has_dossier_access(auth.uid(), dossier_id));
CREATE POLICY "ds_all" ON public.comptes_comptables FOR ALL TO authenticated USING (public.has_dossier_access(auth.uid(), dossier_id)) WITH CHECK (public.has_dossier_access(auth.uid(), dossier_id));

CREATE POLICY "ds_select" ON public.journaux_comptables FOR SELECT TO authenticated USING (public.has_dossier_access(auth.uid(), dossier_id));
CREATE POLICY "ds_all" ON public.journaux_comptables FOR ALL TO authenticated USING (public.has_dossier_access(auth.uid(), dossier_id)) WITH CHECK (public.has_dossier_access(auth.uid(), dossier_id));

CREATE POLICY "ds_select" ON public.ecritures_comptables FOR SELECT TO authenticated USING (public.has_dossier_access(auth.uid(), dossier_id));
CREATE POLICY "ds_all" ON public.ecritures_comptables FOR ALL TO authenticated USING (public.has_dossier_access(auth.uid(), dossier_id)) WITH CHECK (public.has_dossier_access(auth.uid(), dossier_id));

CREATE POLICY "ds_select" ON public.comptes_bancaires FOR SELECT TO authenticated USING (public.has_dossier_access(auth.uid(), dossier_id));
CREATE POLICY "ds_all" ON public.comptes_bancaires FOR ALL TO authenticated USING (public.has_dossier_access(auth.uid(), dossier_id)) WITH CHECK (public.has_dossier_access(auth.uid(), dossier_id));

CREATE POLICY "ds_select" ON public.transactions_bancaires FOR SELECT TO authenticated USING (public.has_dossier_access(auth.uid(), dossier_id));
CREATE POLICY "ds_all" ON public.transactions_bancaires FOR ALL TO authenticated USING (public.has_dossier_access(auth.uid(), dossier_id)) WITH CHECK (public.has_dossier_access(auth.uid(), dossier_id));

CREATE POLICY "ds_select" ON public.ged_documents FOR SELECT TO authenticated USING (public.has_dossier_access(auth.uid(), dossier_id));
CREATE POLICY "ds_all" ON public.ged_documents FOR ALL TO authenticated USING (public.has_dossier_access(auth.uid(), dossier_id)) WITH CHECK (public.has_dossier_access(auth.uid(), dossier_id));

CREATE POLICY "ds_select" ON public.audit_logs FOR SELECT TO authenticated USING (dossier_id IS NULL OR public.has_dossier_access(auth.uid(), dossier_id));
CREATE POLICY "ds_insert" ON public.audit_logs FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

CREATE POLICY "ds_select" ON public.alertes FOR SELECT TO authenticated USING (public.has_dossier_access(auth.uid(), dossier_id));
CREATE POLICY "ds_all" ON public.alertes FOR ALL TO authenticated USING (public.has_dossier_access(auth.uid(), dossier_id)) WITH CHECK (public.has_dossier_access(auth.uid(), dossier_id));

-- ============================================================
-- FONCTION: Initialiser PCM (Plan Comptable Marocain) à la création d'un dossier
-- ============================================================
CREATE OR REPLACE FUNCTION public.init_pcm_for_dossier()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  -- Journaux par défaut
  INSERT INTO public.journaux_comptables (dossier_id, code, intitule, type_journal) VALUES
    (NEW.id, 'VTE', 'Journal des ventes', 'ventes'),
    (NEW.id, 'ACH', 'Journal des achats', 'achats'),
    (NEW.id, 'BQ',  'Journal de banque', 'banque'),
    (NEW.id, 'CAI', 'Journal de caisse', 'caisse'),
    (NEW.id, 'OD',  'Opérations diverses', 'od'),
    (NEW.id, 'TVA', 'Journal TVA', 'tva');

  -- Plan Comptable Marocain (extrait essentiel)
  INSERT INTO public.comptes_comptables (dossier_id, numero, intitule, type_compte) VALUES
    (NEW.id,'1111','Capital social','capitaux'),
    (NEW.id,'2111','Frais de constitution','immobilisations'),
    (NEW.id,'2230','Fonds commercial','immobilisations'),
    (NEW.id,'2340','Matériel de transport','immobilisations'),
    (NEW.id,'3421','Clients','actif_circulant'),
    (NEW.id,'3455','État - TVA récupérable','actif_circulant'),
    (NEW.id,'4411','Fournisseurs','passif_circulant'),
    (NEW.id,'4455','État - TVA facturée','passif_circulant'),
    (NEW.id,'5141','Banque','tresorerie'),
    (NEW.id,'5161','Caisse','tresorerie'),
    (NEW.id,'6111','Achats de marchandises','charges'),
    (NEW.id,'6125','Achats non stockés','charges'),
    (NEW.id,'7111','Ventes de marchandises','produits'),
    (NEW.id,'7121','Ventes de biens produits','produits');
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_dossier_created
  AFTER INSERT ON public.dossiers
  FOR EACH ROW EXECUTE FUNCTION public.init_pcm_for_dossier();

-- ============================================================
-- STORAGE BUCKET pour GED (privé)
-- ============================================================
INSERT INTO storage.buckets (id, name, public) VALUES ('ged', 'ged', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "ged_user_select" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'ged' AND auth.uid() IS NOT NULL);
CREATE POLICY "ged_user_insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'ged' AND auth.uid() IS NOT NULL);
CREATE POLICY "ged_user_delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'ged' AND auth.uid() IS NOT NULL);

-- Migration : support factures d'acompte
ALTER TABLE public.factures 
  ADD COLUMN IF NOT EXISTS type_facture TEXT DEFAULT 'standard' 
    CHECK (type_facture IN ('standard', 'acompte', 'solde', 'avoir')),
  ADD COLUMN IF NOT EXISTS numero_commande TEXT,
  ADD COLUMN IF NOT EXISTS numero_acompte INTEGER,
  ADD COLUMN IF NOT EXISTS montant_commande_total_ht NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS montant_commande_total_ttc NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS montant_restant_du NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS facture_parent_id UUID REFERENCES public.factures(id);

CREATE INDEX IF NOT EXISTS idx_factures_commande 
  ON public.factures(numero_commande) WHERE numero_commande IS NOT NULL;

-- Données de test : FA 0005 AGAF
-- (à exécuter après avoir créé le client AGAF et le dossier)
/*
INSERT INTO public.factures (
  dossier_id, numero, date_facture, date_echeance,
  type_facture, numero_commande, numero_acompte,
  montant_ht, montant_tva, montant_ttc,
  montant_commande_total_ht, montant_commande_total_ttc,
  montant_restant_du,
  statut, statut_paiement
) VALUES (
  'VOTRE_DOSSIER_ID',
  'FA 0005',
  '2026-03-11',
  '2026-04-10',        -- échéance 30j
  'acompte',
  'BC 014025',
  1,
  42000.00,
  8400.00,
  50400.00,
  140783.21,           -- total commande HT
  168939.85,           -- total commande TTC
  118539.85,           -- reliquat restant
  'conforme',
  'payee'              -- payée par virement AGA du 02/03/2026
);
*/

