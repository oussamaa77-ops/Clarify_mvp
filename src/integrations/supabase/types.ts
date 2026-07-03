// ─────────────────────────────────────────────────────────────────────────────
// Types Supabase — GÉNÉRÉS depuis le schéma live PostgREST (OpenAPI) du projet.
//
// Le CLI officiel `supabase gen types` est inaccessible ici (proxy TLS d'entreprise
// → SELF_SIGNED_CERT_IN_CHAIN). Ces types sont régénérés à partir de l'endpoint REST
// introspectable `/rest/v1/` (même source de vérité que PostgREST).
//
// Régénérer :  node scripts/gen-supabase-types.mjs
// Ne pas éditer à la main.
// ─────────────────────────────────────────────────────────────────────────────

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  public: {
    Tables: {
      "alertes": {
        Row: {
          id: string
          dossier_id: string
          type: string | null
          titre: string | null
          message: string | null
          lue: boolean | null
          email_envoye: boolean | null
          created_at: string | null
        }
        Insert: {
          id?: string
          dossier_id: string
          type?: string | null
          titre?: string | null
          message?: string | null
          lue?: boolean | null
          email_envoye?: boolean | null
          created_at?: string | null
        }
        Update: {
          id?: string
          dossier_id?: string
          type?: string | null
          titre?: string | null
          message?: string | null
          lue?: boolean | null
          email_envoye?: boolean | null
          created_at?: string | null
        }
        Relationships: [
        {
          foreignKeyName: "alertes_dossier_id_fkey"
          columns: ["dossier_id"]
          isOneToOne: false
          referencedRelation: "dossiers"
          referencedColumns: ["id"]
        },
      ]
      }
      "audit_logs": {
        Row: {
          id: string
          dossier_id: string | null
          user_id: string | null
          user_email: string | null
          action: string
          ressource_type: string | null
          ressource_id: string | null
          details: Json | null
          ip_address: string | null
          hash: string | null
          hash_precedent: string | null
          created_at: string | null
        }
        Insert: {
          id?: string
          dossier_id?: string | null
          user_id?: string | null
          user_email?: string | null
          action: string
          ressource_type?: string | null
          ressource_id?: string | null
          details?: Json | null
          ip_address?: string | null
          hash?: string | null
          hash_precedent?: string | null
          created_at?: string | null
        }
        Update: {
          id?: string
          dossier_id?: string | null
          user_id?: string | null
          user_email?: string | null
          action?: string
          ressource_type?: string | null
          ressource_id?: string | null
          details?: Json | null
          ip_address?: string | null
          hash?: string | null
          hash_precedent?: string | null
          created_at?: string | null
        }
        Relationships: [
        {
          foreignKeyName: "audit_logs_dossier_id_fkey"
          columns: ["dossier_id"]
          isOneToOne: false
          referencedRelation: "dossiers"
          referencedColumns: ["id"]
        },
        {
          foreignKeyName: "audit_logs_user_id_fkey"
          columns: ["user_id"]
          isOneToOne: false
          referencedRelation: "user_profiles"
          referencedColumns: ["id"]
        },
      ]
      }
      "bulletins_paie": {
        Row: {
          id: string
          dossier_id: string
          employe_id: string
          periode: string
          date_paiement: string | null
          salaire_base: number | null
          heures_sup: number | null
          montant_heures_sup: number | null
          primes: number | null
          indemnites: number | null
          avantages_nature: number | null
          brut_imposable: number | null
          cnss_salarie: number | null
          amo_salarie: number | null
          cimr_salarie: number | null
          base_ir: number | null
          ir_brut: number | null
          deduction_familiale: number | null
          ir_net: number | null
          cnss_patronal: number | null
          amo_patronal: number | null
          cimr_patronal: number | null
          taxe_formation_pro: number | null
          total_retenues: number | null
          net_a_payer: number | null
          cout_employeur: number | null
          statut: string | null
          ecriture_creee: boolean | null
          notes: string | null
          created_at: string | null
        }
        Insert: {
          id?: string
          dossier_id: string
          employe_id: string
          periode: string
          date_paiement?: string | null
          salaire_base?: number | null
          heures_sup?: number | null
          montant_heures_sup?: number | null
          primes?: number | null
          indemnites?: number | null
          avantages_nature?: number | null
          brut_imposable?: number | null
          cnss_salarie?: number | null
          amo_salarie?: number | null
          cimr_salarie?: number | null
          base_ir?: number | null
          ir_brut?: number | null
          deduction_familiale?: number | null
          ir_net?: number | null
          cnss_patronal?: number | null
          amo_patronal?: number | null
          cimr_patronal?: number | null
          taxe_formation_pro?: number | null
          total_retenues?: number | null
          net_a_payer?: number | null
          cout_employeur?: number | null
          statut?: string | null
          ecriture_creee?: boolean | null
          notes?: string | null
          created_at?: string | null
        }
        Update: {
          id?: string
          dossier_id?: string
          employe_id?: string
          periode?: string
          date_paiement?: string | null
          salaire_base?: number | null
          heures_sup?: number | null
          montant_heures_sup?: number | null
          primes?: number | null
          indemnites?: number | null
          avantages_nature?: number | null
          brut_imposable?: number | null
          cnss_salarie?: number | null
          amo_salarie?: number | null
          cimr_salarie?: number | null
          base_ir?: number | null
          ir_brut?: number | null
          deduction_familiale?: number | null
          ir_net?: number | null
          cnss_patronal?: number | null
          amo_patronal?: number | null
          cimr_patronal?: number | null
          taxe_formation_pro?: number | null
          total_retenues?: number | null
          net_a_payer?: number | null
          cout_employeur?: number | null
          statut?: string | null
          ecriture_creee?: boolean | null
          notes?: string | null
          created_at?: string | null
        }
        Relationships: [
        {
          foreignKeyName: "bulletins_paie_dossier_id_fkey"
          columns: ["dossier_id"]
          isOneToOne: false
          referencedRelation: "dossiers"
          referencedColumns: ["id"]
        },
        {
          foreignKeyName: "bulletins_paie_employe_id_fkey"
          columns: ["employe_id"]
          isOneToOne: false
          referencedRelation: "employes"
          referencedColumns: ["id"]
        },
      ]
      }
      "cabinets": {
        Row: {
          id: string
          nom: string
          email: string | null
          telephone: string | null
          adresse: string | null
          created_at: string | null
        }
        Insert: {
          id?: string
          nom: string
          email?: string | null
          telephone?: string | null
          adresse?: string | null
          created_at?: string | null
        }
        Update: {
          id?: string
          nom?: string
          email?: string | null
          telephone?: string | null
          adresse?: string | null
          created_at?: string | null
        }
        Relationships: []
      }
      "clients": {
        Row: {
          id: string
          dossier_id: string
          nom: string
          ice: string | null
          if_fiscal: string | null
          rc: string | null
          email: string | null
          telephone: string | null
          adresse: string | null
          deleted_at: string | null
          created_at: string | null
          code_auxiliaire: string | null
        }
        Insert: {
          id?: string
          dossier_id: string
          nom: string
          ice?: string | null
          if_fiscal?: string | null
          rc?: string | null
          email?: string | null
          telephone?: string | null
          adresse?: string | null
          deleted_at?: string | null
          created_at?: string | null
          code_auxiliaire?: string | null
        }
        Update: {
          id?: string
          dossier_id?: string
          nom?: string
          ice?: string | null
          if_fiscal?: string | null
          rc?: string | null
          email?: string | null
          telephone?: string | null
          adresse?: string | null
          deleted_at?: string | null
          created_at?: string | null
          code_auxiliaire?: string | null
        }
        Relationships: [
        {
          foreignKeyName: "clients_dossier_id_fkey"
          columns: ["dossier_id"]
          isOneToOne: false
          referencedRelation: "dossiers"
          referencedColumns: ["id"]
        },
      ]
      }
      "comptes_bancaires": {
        Row: {
          id: string
          dossier_id: string
          banque: string | null
          intitule: string | null
          rib: string | null
          iban: string | null
          solde_actuel: number | null
          created_at: string | null
        }
        Insert: {
          id?: string
          dossier_id: string
          banque?: string | null
          intitule?: string | null
          rib?: string | null
          iban?: string | null
          solde_actuel?: number | null
          created_at?: string | null
        }
        Update: {
          id?: string
          dossier_id?: string
          banque?: string | null
          intitule?: string | null
          rib?: string | null
          iban?: string | null
          solde_actuel?: number | null
          created_at?: string | null
        }
        Relationships: [
        {
          foreignKeyName: "comptes_bancaires_dossier_id_fkey"
          columns: ["dossier_id"]
          isOneToOne: false
          referencedRelation: "dossiers"
          referencedColumns: ["id"]
        },
      ]
      }
      "comptes_comptables": {
        Row: {
          id: string
          dossier_id: string
          numero: string
          intitule: string
          type_compte: string | null
          solde_initial: number | null
          created_at: string | null
        }
        Insert: {
          id?: string
          dossier_id: string
          numero: string
          intitule: string
          type_compte?: string | null
          solde_initial?: number | null
          created_at?: string | null
        }
        Update: {
          id?: string
          dossier_id?: string
          numero?: string
          intitule?: string
          type_compte?: string | null
          solde_initial?: number | null
          created_at?: string | null
        }
        Relationships: [
        {
          foreignKeyName: "comptes_comptables_dossier_id_fkey"
          columns: ["dossier_id"]
          isOneToOne: false
          referencedRelation: "dossiers"
          referencedColumns: ["id"]
        },
      ]
      }
      "dossier_access": {
        Row: {
          id: string
          dossier_id: string
          user_id: string
          role: "expert_comptable" | "assistant_cabinet" | "chef_entreprise" | "collaborateur"
          created_at: string | null
        }
        Insert: {
          id?: string
          dossier_id: string
          user_id: string
          role: "expert_comptable" | "assistant_cabinet" | "chef_entreprise" | "collaborateur"
          created_at?: string | null
        }
        Update: {
          id?: string
          dossier_id?: string
          user_id?: string
          role?: "expert_comptable" | "assistant_cabinet" | "chef_entreprise" | "collaborateur"
          created_at?: string | null
        }
        Relationships: [
        {
          foreignKeyName: "dossier_access_dossier_id_fkey"
          columns: ["dossier_id"]
          isOneToOne: false
          referencedRelation: "dossiers"
          referencedColumns: ["id"]
        },
        {
          foreignKeyName: "dossier_access_user_id_fkey"
          columns: ["user_id"]
          isOneToOne: false
          referencedRelation: "user_profiles"
          referencedColumns: ["id"]
        },
      ]
      }
      "dossiers": {
        Row: {
          id: string
          cabinet_id: string
          nom_societe: string
          ice: string | null
          rc: string | null
          if_fiscal: string | null
          adresse: string | null
          email_societe: string | null
          telephone: string | null
          statut: string | null
          created_by: string | null
          created_at: string | null
          updated_at: string | null
        }
        Insert: {
          id?: string
          cabinet_id: string
          nom_societe: string
          ice?: string | null
          rc?: string | null
          if_fiscal?: string | null
          adresse?: string | null
          email_societe?: string | null
          telephone?: string | null
          statut?: string | null
          created_by?: string | null
          created_at?: string | null
          updated_at?: string | null
        }
        Update: {
          id?: string
          cabinet_id?: string
          nom_societe?: string
          ice?: string | null
          rc?: string | null
          if_fiscal?: string | null
          adresse?: string | null
          email_societe?: string | null
          telephone?: string | null
          statut?: string | null
          created_by?: string | null
          created_at?: string | null
          updated_at?: string | null
        }
        Relationships: [
        {
          foreignKeyName: "dossiers_cabinet_id_fkey"
          columns: ["cabinet_id"]
          isOneToOne: false
          referencedRelation: "cabinets"
          referencedColumns: ["id"]
        },
      ]
      }
      "ecritures_comptables": {
        Row: {
          id: string
          dossier_id: string
          journal_id: string | null
          compte_id: string | null
          journal_code: string | null
          compte_numero: string | null
          date_ecriture: string
          libelle: string | null
          debit: number | null
          credit: number | null
          type_ecriture: "debit" | "credit" | null
          reference_piece: string | null
          facture_id: string | null
          valide: boolean | null
          created_at: string | null
          lettre: string | null
          date_lettrage: string | null
          transaction_id: string | null
        }
        Insert: {
          id?: string
          dossier_id: string
          journal_id?: string | null
          compte_id?: string | null
          journal_code?: string | null
          compte_numero?: string | null
          date_ecriture: string
          libelle?: string | null
          debit?: number | null
          credit?: number | null
          type_ecriture?: "debit" | "credit" | null
          reference_piece?: string | null
          facture_id?: string | null
          valide?: boolean | null
          created_at?: string | null
          lettre?: string | null
          date_lettrage?: string | null
          transaction_id?: string | null
        }
        Update: {
          id?: string
          dossier_id?: string
          journal_id?: string | null
          compte_id?: string | null
          journal_code?: string | null
          compte_numero?: string | null
          date_ecriture?: string
          libelle?: string | null
          debit?: number | null
          credit?: number | null
          type_ecriture?: "debit" | "credit" | null
          reference_piece?: string | null
          facture_id?: string | null
          valide?: boolean | null
          created_at?: string | null
          lettre?: string | null
          date_lettrage?: string | null
          transaction_id?: string | null
        }
        Relationships: [
        {
          foreignKeyName: "ecritures_comptables_dossier_id_fkey"
          columns: ["dossier_id"]
          isOneToOne: false
          referencedRelation: "dossiers"
          referencedColumns: ["id"]
        },
        {
          foreignKeyName: "ecritures_comptables_journal_id_fkey"
          columns: ["journal_id"]
          isOneToOne: false
          referencedRelation: "journaux_comptables"
          referencedColumns: ["id"]
        },
        {
          foreignKeyName: "ecritures_comptables_compte_id_fkey"
          columns: ["compte_id"]
          isOneToOne: false
          referencedRelation: "comptes_comptables"
          referencedColumns: ["id"]
        },
        {
          foreignKeyName: "ecritures_comptables_facture_id_fkey"
          columns: ["facture_id"]
          isOneToOne: false
          referencedRelation: "factures"
          referencedColumns: ["id"]
        },
        {
          foreignKeyName: "ecritures_comptables_transaction_id_fkey"
          columns: ["transaction_id"]
          isOneToOne: false
          referencedRelation: "transactions_bancaires"
          referencedColumns: ["id"]
        },
      ]
      }
      "employes": {
        Row: {
          id: string
          dossier_id: string
          matricule: string | null
          nom: string
          prenom: string
          cin: string | null
          date_naissance: string | null
          date_embauche: string
          date_fin_contrat: string | null
          type_contrat: string
          poste: string | null
          departement: string | null
          salaire_base: number
          regime_ir: string
          situation_familiale: string | null
          nombre_enfants: number | null
          cnss_assujetti: boolean | null
          amo_assujetti: boolean | null
          cimr_taux: number | null
          rib: string | null
          email: string | null
          telephone: string | null
          adresse: string | null
          actif: boolean | null
          created_at: string | null
        }
        Insert: {
          id?: string
          dossier_id: string
          matricule?: string | null
          nom: string
          prenom: string
          cin?: string | null
          date_naissance?: string | null
          date_embauche: string
          date_fin_contrat?: string | null
          type_contrat?: string
          poste?: string | null
          departement?: string | null
          salaire_base?: number
          regime_ir?: string
          situation_familiale?: string | null
          nombre_enfants?: number | null
          cnss_assujetti?: boolean | null
          amo_assujetti?: boolean | null
          cimr_taux?: number | null
          rib?: string | null
          email?: string | null
          telephone?: string | null
          adresse?: string | null
          actif?: boolean | null
          created_at?: string | null
        }
        Update: {
          id?: string
          dossier_id?: string
          matricule?: string | null
          nom?: string
          prenom?: string
          cin?: string | null
          date_naissance?: string | null
          date_embauche?: string
          date_fin_contrat?: string | null
          type_contrat?: string
          poste?: string | null
          departement?: string | null
          salaire_base?: number
          regime_ir?: string
          situation_familiale?: string | null
          nombre_enfants?: number | null
          cnss_assujetti?: boolean | null
          amo_assujetti?: boolean | null
          cimr_taux?: number | null
          rib?: string | null
          email?: string | null
          telephone?: string | null
          adresse?: string | null
          actif?: boolean | null
          created_at?: string | null
        }
        Relationships: [
        {
          foreignKeyName: "employes_dossier_id_fkey"
          columns: ["dossier_id"]
          isOneToOne: false
          referencedRelation: "dossiers"
          referencedColumns: ["id"]
        },
      ]
      }
      "encaissements": {
        Row: {
          id: string
          dossier_id: string
          type: string
          montant: number
          date_encaissement: string
          reference: string | null
          numero_cheque: string | null
          banque_cheque: string | null
          facture_id: string | null
          facture_fournisseur_id: string | null
          libelle: string | null
          valide: boolean | null
          created_at: string | null
        }
        Insert: {
          id?: string
          dossier_id: string
          type: string
          montant: number
          date_encaissement: string
          reference?: string | null
          numero_cheque?: string | null
          banque_cheque?: string | null
          facture_id?: string | null
          facture_fournisseur_id?: string | null
          libelle?: string | null
          valide?: boolean | null
          created_at?: string | null
        }
        Update: {
          id?: string
          dossier_id?: string
          type?: string
          montant?: number
          date_encaissement?: string
          reference?: string | null
          numero_cheque?: string | null
          banque_cheque?: string | null
          facture_id?: string | null
          facture_fournisseur_id?: string | null
          libelle?: string | null
          valide?: boolean | null
          created_at?: string | null
        }
        Relationships: [
        {
          foreignKeyName: "encaissements_dossier_id_fkey"
          columns: ["dossier_id"]
          isOneToOne: false
          referencedRelation: "dossiers"
          referencedColumns: ["id"]
        },
        {
          foreignKeyName: "encaissements_facture_id_fkey"
          columns: ["facture_id"]
          isOneToOne: false
          referencedRelation: "factures"
          referencedColumns: ["id"]
        },
        {
          foreignKeyName: "encaissements_facture_fournisseur_id_fkey"
          columns: ["facture_fournisseur_id"]
          isOneToOne: false
          referencedRelation: "factures_fournisseurs"
          referencedColumns: ["id"]
        },
      ]
      }
      "factures": {
        Row: {
          id: string
          dossier_id: string
          client_id: string | null
          numero: string | null
          type: "facture" | "avoir" | "proforma" | null
          statut: "brouillon" | "envoyee" | "conforme" | "rejetee" | "annulee" | null
          statut_dgi: string | null
          statut_paiement: "non_payee" | "partielle" | "payee" | "en_retard" | null
          date_facture: string
          date_echeance: string | null
          date_paiement: string | null
          montant_ht: number | null
          montant_tva: number | null
          montant_ttc: number | null
          lignes: Json | null
          notes: string | null
          xml_ubl: string | null
          hash_sha256: string | null
          dgi_uuid: string | null
          dgi_response: Json | null
          created_by: string | null
          created_at: string | null
          updated_at: string | null
          fichier_original_url: string | null
          fichier_original_nom: string | null
          fichier_original_type: string | null
          statut_dgi_detail: Json | null
          type_facture: string | null
          numero_commande: string | null
          numero_acompte: number | null
          montant_commande_total_ht: number | null
          montant_commande_total_ttc: number | null
          montant_restant_du: number | null
          facture_parent_id: string | null
          montant_paye: number | null
          montant_restant: number | null
          mode_reglement: string | null
          echeances: Json | null
        }
        Insert: {
          id?: string
          dossier_id: string
          client_id?: string | null
          numero?: string | null
          type?: "facture" | "avoir" | "proforma" | null
          statut?: "brouillon" | "envoyee" | "conforme" | "rejetee" | "annulee" | null
          statut_dgi?: string | null
          statut_paiement?: "non_payee" | "partielle" | "payee" | "en_retard" | null
          date_facture: string
          date_echeance?: string | null
          date_paiement?: string | null
          montant_ht?: number | null
          montant_tva?: number | null
          montant_ttc?: number | null
          lignes?: Json | null
          notes?: string | null
          xml_ubl?: string | null
          hash_sha256?: string | null
          dgi_uuid?: string | null
          dgi_response?: Json | null
          created_by?: string | null
          created_at?: string | null
          updated_at?: string | null
          fichier_original_url?: string | null
          fichier_original_nom?: string | null
          fichier_original_type?: string | null
          statut_dgi_detail?: Json | null
          type_facture?: string | null
          numero_commande?: string | null
          numero_acompte?: number | null
          montant_commande_total_ht?: number | null
          montant_commande_total_ttc?: number | null
          montant_restant_du?: number | null
          facture_parent_id?: string | null
          montant_paye?: number | null
          montant_restant?: number | null
          mode_reglement?: string | null
          echeances?: Json | null
        }
        Update: {
          id?: string
          dossier_id?: string
          client_id?: string | null
          numero?: string | null
          type?: "facture" | "avoir" | "proforma" | null
          statut?: "brouillon" | "envoyee" | "conforme" | "rejetee" | "annulee" | null
          statut_dgi?: string | null
          statut_paiement?: "non_payee" | "partielle" | "payee" | "en_retard" | null
          date_facture?: string
          date_echeance?: string | null
          date_paiement?: string | null
          montant_ht?: number | null
          montant_tva?: number | null
          montant_ttc?: number | null
          lignes?: Json | null
          notes?: string | null
          xml_ubl?: string | null
          hash_sha256?: string | null
          dgi_uuid?: string | null
          dgi_response?: Json | null
          created_by?: string | null
          created_at?: string | null
          updated_at?: string | null
          fichier_original_url?: string | null
          fichier_original_nom?: string | null
          fichier_original_type?: string | null
          statut_dgi_detail?: Json | null
          type_facture?: string | null
          numero_commande?: string | null
          numero_acompte?: number | null
          montant_commande_total_ht?: number | null
          montant_commande_total_ttc?: number | null
          montant_restant_du?: number | null
          facture_parent_id?: string | null
          montant_paye?: number | null
          montant_restant?: number | null
          mode_reglement?: string | null
          echeances?: Json | null
        }
        Relationships: [
        {
          foreignKeyName: "factures_dossier_id_fkey"
          columns: ["dossier_id"]
          isOneToOne: false
          referencedRelation: "dossiers"
          referencedColumns: ["id"]
        },
        {
          foreignKeyName: "factures_client_id_fkey"
          columns: ["client_id"]
          isOneToOne: false
          referencedRelation: "clients"
          referencedColumns: ["id"]
        },
        {
          foreignKeyName: "factures_facture_parent_id_fkey"
          columns: ["facture_parent_id"]
          isOneToOne: false
          referencedRelation: "factures"
          referencedColumns: ["id"]
        },
      ]
      }
      "factures_fournisseurs": {
        Row: {
          id: string
          dossier_id: string
          fournisseur_id: string | null
          fournisseur_nom: string | null
          numero: string | null
          statut: string | null
          statut_dgi: string | null
          statut_paiement: "non_payee" | "partielle" | "payee" | "en_retard" | null
          date_facture: string | null
          date_echeance: string | null
          date_paiement: string | null
          montant_ht: number | null
          montant_tva: number | null
          montant_ttc: number | null
          xml_ubl: string | null
          hash_sha256: string | null
          dgi_uuid: string | null
          ocr_data: Json | null
          created_at: string | null
          lignes: Json | null
          montant_paye: number | null
          montant_restant: number | null
          mode_reglement: string | null
          echeances: Json | null
        }
        Insert: {
          id?: string
          dossier_id: string
          fournisseur_id?: string | null
          fournisseur_nom?: string | null
          numero?: string | null
          statut?: string | null
          statut_dgi?: string | null
          statut_paiement?: "non_payee" | "partielle" | "payee" | "en_retard" | null
          date_facture?: string | null
          date_echeance?: string | null
          date_paiement?: string | null
          montant_ht?: number | null
          montant_tva?: number | null
          montant_ttc?: number | null
          xml_ubl?: string | null
          hash_sha256?: string | null
          dgi_uuid?: string | null
          ocr_data?: Json | null
          created_at?: string | null
          lignes?: Json | null
          montant_paye?: number | null
          montant_restant?: number | null
          mode_reglement?: string | null
          echeances?: Json | null
        }
        Update: {
          id?: string
          dossier_id?: string
          fournisseur_id?: string | null
          fournisseur_nom?: string | null
          numero?: string | null
          statut?: string | null
          statut_dgi?: string | null
          statut_paiement?: "non_payee" | "partielle" | "payee" | "en_retard" | null
          date_facture?: string | null
          date_echeance?: string | null
          date_paiement?: string | null
          montant_ht?: number | null
          montant_tva?: number | null
          montant_ttc?: number | null
          xml_ubl?: string | null
          hash_sha256?: string | null
          dgi_uuid?: string | null
          ocr_data?: Json | null
          created_at?: string | null
          lignes?: Json | null
          montant_paye?: number | null
          montant_restant?: number | null
          mode_reglement?: string | null
          echeances?: Json | null
        }
        Relationships: [
        {
          foreignKeyName: "factures_fournisseurs_dossier_id_fkey"
          columns: ["dossier_id"]
          isOneToOne: false
          referencedRelation: "dossiers"
          referencedColumns: ["id"]
        },
        {
          foreignKeyName: "factures_fournisseurs_fournisseur_id_fkey"
          columns: ["fournisseur_id"]
          isOneToOne: false
          referencedRelation: "fournisseurs"
          referencedColumns: ["id"]
        },
      ]
      }
      "fournisseurs": {
        Row: {
          id: string
          dossier_id: string
          nom: string
          ice: string | null
          if_fiscal: string | null
          rc: string | null
          email: string | null
          telephone: string | null
          adresse: string | null
          deleted_at: string | null
          created_at: string | null
          code_auxiliaire: string | null
        }
        Insert: {
          id?: string
          dossier_id: string
          nom: string
          ice?: string | null
          if_fiscal?: string | null
          rc?: string | null
          email?: string | null
          telephone?: string | null
          adresse?: string | null
          deleted_at?: string | null
          created_at?: string | null
          code_auxiliaire?: string | null
        }
        Update: {
          id?: string
          dossier_id?: string
          nom?: string
          ice?: string | null
          if_fiscal?: string | null
          rc?: string | null
          email?: string | null
          telephone?: string | null
          adresse?: string | null
          deleted_at?: string | null
          created_at?: string | null
          code_auxiliaire?: string | null
        }
        Relationships: [
        {
          foreignKeyName: "fournisseurs_dossier_id_fkey"
          columns: ["dossier_id"]
          isOneToOne: false
          referencedRelation: "dossiers"
          referencedColumns: ["id"]
        },
      ]
      }
      "ged_documents": {
        Row: {
          id: string
          dossier_id: string
          nom_fichier: string
          type_document: string | null
          url_stockage: string | null
          hash_sha256: string | null
          dgi_uuid: string | null
          horodatage: string | null
          taille_bytes: number | null
          mime_type: string | null
          facture_id: string | null
          created_at: string | null
        }
        Insert: {
          id?: string
          dossier_id: string
          nom_fichier: string
          type_document?: string | null
          url_stockage?: string | null
          hash_sha256?: string | null
          dgi_uuid?: string | null
          horodatage?: string | null
          taille_bytes?: number | null
          mime_type?: string | null
          facture_id?: string | null
          created_at?: string | null
        }
        Update: {
          id?: string
          dossier_id?: string
          nom_fichier?: string
          type_document?: string | null
          url_stockage?: string | null
          hash_sha256?: string | null
          dgi_uuid?: string | null
          horodatage?: string | null
          taille_bytes?: number | null
          mime_type?: string | null
          facture_id?: string | null
          created_at?: string | null
        }
        Relationships: [
        {
          foreignKeyName: "ged_documents_dossier_id_fkey"
          columns: ["dossier_id"]
          isOneToOne: false
          referencedRelation: "dossiers"
          referencedColumns: ["id"]
        },
        {
          foreignKeyName: "ged_documents_facture_id_fkey"
          columns: ["facture_id"]
          isOneToOne: false
          referencedRelation: "factures"
          referencedColumns: ["id"]
        },
      ]
      }
      "invitations": {
        Row: {
          id: string
          dossier_id: string | null
          cabinet_id: string | null
          email: string
          role: "expert_comptable" | "assistant_cabinet" | "chef_entreprise" | "collaborateur"
          token: string
          expires_at: string
          accepted_at: string | null
          created_at: string | null
        }
        Insert: {
          id?: string
          dossier_id?: string | null
          cabinet_id?: string | null
          email: string
          role: "expert_comptable" | "assistant_cabinet" | "chef_entreprise" | "collaborateur"
          token: string
          expires_at: string
          accepted_at?: string | null
          created_at?: string | null
        }
        Update: {
          id?: string
          dossier_id?: string | null
          cabinet_id?: string | null
          email?: string
          role?: "expert_comptable" | "assistant_cabinet" | "chef_entreprise" | "collaborateur"
          token?: string
          expires_at?: string
          accepted_at?: string | null
          created_at?: string | null
        }
        Relationships: [
        {
          foreignKeyName: "invitations_dossier_id_fkey"
          columns: ["dossier_id"]
          isOneToOne: false
          referencedRelation: "dossiers"
          referencedColumns: ["id"]
        },
        {
          foreignKeyName: "invitations_cabinet_id_fkey"
          columns: ["cabinet_id"]
          isOneToOne: false
          referencedRelation: "cabinets"
          referencedColumns: ["id"]
        },
      ]
      }
      "journaux_comptables": {
        Row: {
          id: string
          dossier_id: string
          code: string
          intitule: string
          type_journal: string | null
          created_at: string | null
        }
        Insert: {
          id?: string
          dossier_id: string
          code: string
          intitule: string
          type_journal?: string | null
          created_at?: string | null
        }
        Update: {
          id?: string
          dossier_id?: string
          code?: string
          intitule?: string
          type_journal?: string | null
          created_at?: string | null
        }
        Relationships: [
        {
          foreignKeyName: "journaux_comptables_dossier_id_fkey"
          columns: ["dossier_id"]
          isOneToOne: false
          referencedRelation: "dossiers"
          referencedColumns: ["id"]
        },
      ]
      }
      "justificatifs": {
        Row: {
          id: string
          dossier_id: string | null
          type_document: string | null
          flux_type: string | null
          nom_tiers: string | null
          montant_ttc: number | null
          montant_ht: number | null
          montant_tva: number | null
          taux_tva: number | null
          categorie_pcm: string | null
          compte_pcm: string | null
          date_document: string | null
          numero_piece: string | null
          url_fichier: string | null
          eligible_edi: boolean | null
          statut: string | null
          created_at: string | null
          numero_commande: string | null
          bon_commande_id: string | null
          devis_id: string | null
          date_commande: string | null
          lignes: Json | null
        }
        Insert: {
          id?: string
          dossier_id?: string | null
          type_document?: string | null
          flux_type?: string | null
          nom_tiers?: string | null
          montant_ttc?: number | null
          montant_ht?: number | null
          montant_tva?: number | null
          taux_tva?: number | null
          categorie_pcm?: string | null
          compte_pcm?: string | null
          date_document?: string | null
          numero_piece?: string | null
          url_fichier?: string | null
          eligible_edi?: boolean | null
          statut?: string | null
          created_at?: string | null
          numero_commande?: string | null
          bon_commande_id?: string | null
          devis_id?: string | null
          date_commande?: string | null
          lignes?: Json | null
        }
        Update: {
          id?: string
          dossier_id?: string | null
          type_document?: string | null
          flux_type?: string | null
          nom_tiers?: string | null
          montant_ttc?: number | null
          montant_ht?: number | null
          montant_tva?: number | null
          taux_tva?: number | null
          categorie_pcm?: string | null
          compte_pcm?: string | null
          date_document?: string | null
          numero_piece?: string | null
          url_fichier?: string | null
          eligible_edi?: boolean | null
          statut?: string | null
          created_at?: string | null
          numero_commande?: string | null
          bon_commande_id?: string | null
          devis_id?: string | null
          date_commande?: string | null
          lignes?: Json | null
        }
        Relationships: [
        {
          foreignKeyName: "justificatifs_dossier_id_fkey"
          columns: ["dossier_id"]
          isOneToOne: false
          referencedRelation: "dossiers"
          referencedColumns: ["id"]
        },
        {
          foreignKeyName: "justificatifs_bon_commande_id_fkey"
          columns: ["bon_commande_id"]
          isOneToOne: false
          referencedRelation: "justificatifs"
          referencedColumns: ["id"]
        },
        {
          foreignKeyName: "justificatifs_devis_id_fkey"
          columns: ["devis_id"]
          isOneToOne: false
          referencedRelation: "justificatifs"
          referencedColumns: ["id"]
        },
      ]
      }
      "lignes_paie": {
        Row: {
          id: string
          bulletin_id: string
          type: string
          libelle: string
          montant: number
          imposable: boolean | null
          created_at: string | null
        }
        Insert: {
          id?: string
          bulletin_id: string
          type: string
          libelle: string
          montant: number
          imposable?: boolean | null
          created_at?: string | null
        }
        Update: {
          id?: string
          bulletin_id?: string
          type?: string
          libelle?: string
          montant?: number
          imposable?: boolean | null
          created_at?: string | null
        }
        Relationships: [
        {
          foreignKeyName: "lignes_paie_bulletin_id_fkey"
          columns: ["bulletin_id"]
          isOneToOne: false
          referencedRelation: "bulletins_paie"
          referencedColumns: ["id"]
        },
      ]
      }
      "pcm_reference": {
        Row: {
          numero: string
          intitule: string
          type_compte: string
          classe: number
          created_at: string
        }
        Insert: {
          numero: string
          intitule: string
          type_compte: string
          classe: number
          created_at?: string
        }
        Update: {
          numero?: string
          intitule?: string
          type_compte?: string
          classe?: number
          created_at?: string
        }
        Relationships: []
      }
      "profiles": {
        Row: {
          id: string
          email: string
          nom: string | null
          prenom: string | null
          cabinet_id: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id: string
          email: string
          nom?: string | null
          prenom?: string | null
          cabinet_id?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          email?: string
          nom?: string | null
          prenom?: string | null
          cabinet_id?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: [
        {
          foreignKeyName: "profiles_cabinet_id_fkey"
          columns: ["cabinet_id"]
          isOneToOne: false
          referencedRelation: "cabinets"
          referencedColumns: ["id"]
        },
      ]
      }
      "releves_bancaires": {
        Row: {
          id: string
          compte_id: string
          dossier_id: string
          date_debut: string | null
          date_fin: string | null
          solde_initial: number | null
          solde_final: number | null
          nombre_transactions: number | null
          fichier_original: string | null
          ocr_data: Json | null
          created_at: string | null
          fichier_nom: string | null
          fichier_type: string | null
          fichier_url: string | null
          statut: string | null
          fichier_path: string | null
        }
        Insert: {
          id?: string
          compte_id: string
          dossier_id: string
          date_debut?: string | null
          date_fin?: string | null
          solde_initial?: number | null
          solde_final?: number | null
          nombre_transactions?: number | null
          fichier_original?: string | null
          ocr_data?: Json | null
          created_at?: string | null
          fichier_nom?: string | null
          fichier_type?: string | null
          fichier_url?: string | null
          statut?: string | null
          fichier_path?: string | null
        }
        Update: {
          id?: string
          compte_id?: string
          dossier_id?: string
          date_debut?: string | null
          date_fin?: string | null
          solde_initial?: number | null
          solde_final?: number | null
          nombre_transactions?: number | null
          fichier_original?: string | null
          ocr_data?: Json | null
          created_at?: string | null
          fichier_nom?: string | null
          fichier_type?: string | null
          fichier_url?: string | null
          statut?: string | null
          fichier_path?: string | null
        }
        Relationships: [
        {
          foreignKeyName: "releves_bancaires_compte_id_fkey"
          columns: ["compte_id"]
          isOneToOne: false
          referencedRelation: "comptes_bancaires"
          referencedColumns: ["id"]
        },
        {
          foreignKeyName: "releves_bancaires_dossier_id_fkey"
          columns: ["dossier_id"]
          isOneToOne: false
          referencedRelation: "dossiers"
          referencedColumns: ["id"]
        },
      ]
      }
      "tiers": {
        Row: {
          id: string
          client_id: string
          nom: string
          nom_normalise: string
          ice: string | null
          compte_pcm: string
          categorie_pcm: string
          created_at: string
        }
        Insert: {
          id?: string
          client_id: string
          nom: string
          nom_normalise: string
          ice?: string | null
          compte_pcm: string
          categorie_pcm: string
          created_at?: string
        }
        Update: {
          id?: string
          client_id?: string
          nom?: string
          nom_normalise?: string
          ice?: string | null
          compte_pcm?: string
          categorie_pcm?: string
          created_at?: string
        }
        Relationships: []
      }
      "tiers_alias": {
        Row: {
          id: string
          client_id: string
          tier_id: string
          libelle_brut: string
          libelle_normalise: string
          created_at: string
        }
        Insert: {
          id?: string
          client_id: string
          tier_id: string
          libelle_brut: string
          libelle_normalise: string
          created_at?: string
        }
        Update: {
          id?: string
          client_id?: string
          tier_id?: string
          libelle_brut?: string
          libelle_normalise?: string
          created_at?: string
        }
        Relationships: [
        {
          foreignKeyName: "tiers_alias_tier_id_fkey"
          columns: ["tier_id"]
          isOneToOne: false
          referencedRelation: "tiers"
          referencedColumns: ["id"]
        },
      ]
      }
      "transactions_bancaires": {
        Row: {
          id: string
          compte_id: string
          dossier_id: string
          releve_id: string | null
          date_operation: string
          libelle: string | null
          type: "credit" | "debit"
          montant: number
          solde_apres: number | null
          reference: string | null
          rapproche: boolean | null
          created_at: string | null
          statut: string | null
          facture_id: string | null
          justificatif_id: string | null
          document_type: string | null
          categorie: string | null
          compte_comptable: string | null
        }
        Insert: {
          id?: string
          compte_id: string
          dossier_id: string
          releve_id?: string | null
          date_operation: string
          libelle?: string | null
          type: "credit" | "debit"
          montant: number
          solde_apres?: number | null
          reference?: string | null
          rapproche?: boolean | null
          created_at?: string | null
          statut?: string | null
          facture_id?: string | null
          justificatif_id?: string | null
          document_type?: string | null
          categorie?: string | null
          compte_comptable?: string | null
        }
        Update: {
          id?: string
          compte_id?: string
          dossier_id?: string
          releve_id?: string | null
          date_operation?: string
          libelle?: string | null
          type?: "credit" | "debit"
          montant?: number
          solde_apres?: number | null
          reference?: string | null
          rapproche?: boolean | null
          created_at?: string | null
          statut?: string | null
          facture_id?: string | null
          justificatif_id?: string | null
          document_type?: string | null
          categorie?: string | null
          compte_comptable?: string | null
        }
        Relationships: [
        {
          foreignKeyName: "transactions_bancaires_compte_id_fkey"
          columns: ["compte_id"]
          isOneToOne: false
          referencedRelation: "comptes_bancaires"
          referencedColumns: ["id"]
        },
        {
          foreignKeyName: "transactions_bancaires_dossier_id_fkey"
          columns: ["dossier_id"]
          isOneToOne: false
          referencedRelation: "dossiers"
          referencedColumns: ["id"]
        },
        {
          foreignKeyName: "transactions_bancaires_releve_id_fkey"
          columns: ["releve_id"]
          isOneToOne: false
          referencedRelation: "releves_bancaires"
          referencedColumns: ["id"]
        },
      ]
      }
      "user_profiles": {
        Row: {
          id: string
          email: string
          nom: string | null
          prenom: string | null
          role: "expert_comptable" | "assistant_cabinet" | "chef_entreprise" | "collaborateur"
          cabinet_id: string | null
          created_at: string | null
        }
        Insert: {
          id: string
          email: string
          nom?: string | null
          prenom?: string | null
          role?: "expert_comptable" | "assistant_cabinet" | "chef_entreprise" | "collaborateur"
          cabinet_id?: string | null
          created_at?: string | null
        }
        Update: {
          id?: string
          email?: string
          nom?: string | null
          prenom?: string | null
          role?: "expert_comptable" | "assistant_cabinet" | "chef_entreprise" | "collaborateur"
          cabinet_id?: string | null
          created_at?: string | null
        }
        Relationships: [
        {
          foreignKeyName: "user_profiles_cabinet_id_fkey"
          columns: ["cabinet_id"]
          isOneToOne: false
          referencedRelation: "cabinets"
          referencedColumns: ["id"]
        },
      ]
      }
      "user_roles": {
        Row: {
          id: string
          user_id: string
          role: "expert_comptable" | "assistant_cabinet" | "chef_entreprise" | "collaborateur"
          cabinet_id: string | null
          created_at: string
        }
        Insert: {
          id?: string
          user_id: string
          role: "expert_comptable" | "assistant_cabinet" | "chef_entreprise" | "collaborateur"
          cabinet_id?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          role?: "expert_comptable" | "assistant_cabinet" | "chef_entreprise" | "collaborateur"
          cabinet_id?: string | null
          created_at?: string
        }
        Relationships: [
        {
          foreignKeyName: "user_roles_cabinet_id_fkey"
          columns: ["cabinet_id"]
          isOneToOne: false
          referencedRelation: "cabinets"
          referencedColumns: ["id"]
        },
      ]
      }
      "v_releves_stats": {
        Row: {
          releve_id: string | null
          dossier_id: string | null
          compte_id: string | null
          nb_total: number | null
          nb_lettrees: number | null
          nb_orphelines: number | null
          nb_cloturees: number | null
        }
        Insert: {
          releve_id?: string | null
          dossier_id?: string | null
          compte_id?: string | null
          nb_total?: number | null
          nb_lettrees?: number | null
          nb_orphelines?: number | null
          nb_cloturees?: number | null
        }
        Update: {
          releve_id?: string | null
          dossier_id?: string | null
          compte_id?: string | null
          nb_total?: number | null
          nb_lettrees?: number | null
          nb_orphelines?: number | null
          nb_cloturees?: number | null
        }
        Relationships: [
        {
          foreignKeyName: "v_releves_stats_dossier_id_fkey"
          columns: ["dossier_id"]
          isOneToOne: false
          referencedRelation: "dossiers"
          referencedColumns: ["id"]
        },
        {
          foreignKeyName: "v_releves_stats_compte_id_fkey"
          columns: ["compte_id"]
          isOneToOne: false
          referencedRelation: "comptes_bancaires"
          referencedColumns: ["id"]
        },
      ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type PublicSchema = Database["public"];
export type Tables<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T]["Row"];
export type TablesInsert<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T]["Insert"];
export type TablesUpdate<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T]["Update"];

