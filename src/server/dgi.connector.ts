// ============================================================================
// dgi.connector.ts — couche d'intégration à la plateforme DGI.
//
// La DGI n'a pas encore ouvert ses accès. Tout l'enjeu de ce fichier est donc
// que le JOUR où les identifiants arrivent, on remplace une implémentation par
// une autre sans toucher à une seule ligne du métier : mêmes appels, mêmes
// types de retour, mêmes cas d'erreur. Le reste de l'application ne sait pas —
// et ne doit jamais savoir — si elle parle au bac à sable ou à la vraie DGI.
//
// D'où trois choix :
//
//   • Le connecteur ne touche NI la base NI le stockage. Il reçoit une charge
//     utile déjà constituée et rend une réponse. Un connecteur qui irait lire
//     la facture lui-même serait intestable sans base et impossible à doubler.
//
//   • Le Mock ne dit pas systématiquement « oui ». Un bac à sable complaisant
//     donne l'illusion que tout marche, jusqu'au premier envoi réel. Celui-ci
//     rejoue les motifs de rejet réellement observés sur les plateformes de
//     facturation électronique : identifiant invalide, totaux incohérents,
//     document illisible, doublon.
//
//   • Le choix de l'implémentation se fait par VARIABLES D'ENVIRONNEMENT, pas
//     par un drapeau dans le code. Passer en production = renseigner
//     DGI_API_URL et DGI_API_KEY, rien d'autre.
// ============================================================================

import { randomUUID } from "node:crypto";
import { proxyFetch } from "./supabase-admin";
import type { ValeurJson } from "@/lib/efacture-mapping";

/** États du cycle de vie, alignés sur la colonne `factures.dgi_status`. */
export type DgiStatus =
  | "DRAFT"
  | "PENDING_DGI"
  | "VALIDATED_BY_DGI"
  | "REJECTED_BY_DGI"
  | "CANCELLED_BY_DGI";

/**
 * Alias de type, et non `interface`, à dessein : une erreur voyage à l'intérieur
 * des charges brutes journalisées, donc dans du JSON. TypeScript n'accorde une
 * signature d'index implicite qu'aux alias — une `interface` ici refuserait de
 * s'assigner à `ValeurJson` et forcerait des conversions à chaque usage.
 */
export type DgiErreur = {
  /** Code stable, journalisable et testable — jamais traduit. */
  code: string;
  message: string;
  /** Champ ou élément XML en cause, quand la plateforme le précise. */
  champ?: string;
};

/** Charge utile d'une soumission. */
export interface DgiSubmitRequest {
  /** Identifiant interne de la facture — sert de clef de corrélation. */
  invoice_id: string;
  numero: string;
  date_facture: string;
  ice_vendeur: string | null;
  ice_acheteur: string | null;
  montant_ht: number;
  montant_tva: number;
  montant_ttc: number;
  /** Document UBL 2.1, tel qu'il sera archivé et embarqué dans le PDF. */
  xml_ubl: string;
  /** Empreinte d'inaltérabilité de la facture. */
  hash_sha256: string;
}

export interface DgiSubmitResponse {
  accepte: boolean;
  statut: DgiStatus;
  dgi_uuid: string | null;
  /** Horodatage tel que renvoyé par la plateforme. */
  horodatage: string;
  erreurs: DgiErreur[];
  /** Réponse brute, conservée telle quelle dans le journal des échanges. */
  brut: ValeurJson;
}

export interface DgiStatusResponse {
  statut: DgiStatus;
  dgi_uuid: string;
  horodatage: string;
  /** Date de validation, si la facture a été acceptée. */
  valide_le?: string | null;
  erreurs: DgiErreur[];
  brut: ValeurJson;
}

export interface DgiCancelResponse {
  annule: boolean;
  statut: DgiStatus;
  dgi_uuid: string;
  horodatage: string;
  erreurs: DgiErreur[];
  brut: ValeurJson;
}

/**
 * Contrat que doit remplir toute plateforme DGI — bac à sable comme production.
 *
 * Aucune méthode ne LÈVE sur un rejet métier : un ICE invalide n'est pas une
 * panne, c'est une réponse. Seules les défaillances techniques (réseau, 500)
 * lèvent. Cette distinction est ce qui permet à l'appelant d'écrire le rejet
 * dans le journal au lieu de le traiter comme un incident.
 */
export interface DgiConnectorInterface {
  /** Nom de l'implémentation, tracé dans le journal des échanges. */
  readonly nom: string;
  /** Vrai si le connecteur parle à la vraie plateforme. */
  readonly production: boolean;

  submitInvoice(requete: DgiSubmitRequest): Promise<DgiSubmitResponse>;
  checkStatus(dgiUuid: string): Promise<DgiStatusResponse>;
  cancelInvoice(dgiUuid: string, motif: string): Promise<DgiCancelResponse>;
}

// ─── Contrôles communs aux deux implémentations ─────────────────────────────
// Ces vérifications DOIVENT rester côté connecteur mock uniquement : en
// production, c'est la DGI qui arbitre, et pré-filtrer localement masquerait
// des divergences entre notre lecture des règles et la sienne.

const ICE_VALIDE = /^\d{15}$/;

function round2(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function controlerRequete(requete: DgiSubmitRequest): DgiErreur[] {
  const erreurs: DgiErreur[] = [];

  if (!requete.numero?.trim()) {
    erreurs.push({ code: "DGI-ERR-NUM", message: "Numéro de facture absent.", champ: "numero" });
  }

  if (!ICE_VALIDE.test(String(requete.ice_vendeur ?? ""))) {
    erreurs.push({
      code: "DGI-ERR-ICE-VENDEUR",
      message: "ICE du vendeur invalide : 15 chiffres attendus.",
      champ: "ice_vendeur",
    });
  }

  // L'ICE acheteur peut être absent (vente à particulier) mais pas erroné.
  if (requete.ice_acheteur && !ICE_VALIDE.test(requete.ice_acheteur)) {
    erreurs.push({
      code: "DGI-ERR-ICE-ACHETEUR",
      message: "ICE de l'acheteur invalide : 15 chiffres attendus.",
      champ: "ice_acheteur",
    });
  }

  // Le rejet le plus fréquent en production : la plateforme recalcule et
  // compare. Un centime d'écart suffit.
  const attendu = round2(round2(requete.montant_ht) + round2(requete.montant_tva));
  if (Math.abs(round2(attendu - round2(requete.montant_ttc))) > 0.01) {
    erreurs.push({
      code: "DGI-ERR-TOTAUX",
      message: `Incohérence des totaux : HT (${round2(requete.montant_ht)}) + TVA (${round2(
        requete.montant_tva,
      )}) = ${attendu}, or TTC déclaré = ${round2(requete.montant_ttc)}.`,
      champ: "montant_ttc",
    });
  }

  if (round2(requete.montant_ttc) <= 0) {
    erreurs.push({ code: "DGI-ERR-MONTANT", message: "Montant TTC nul ou négatif.", champ: "montant_ttc" });
  }

  const xml = String(requete.xml_ubl ?? "");
  if (!xml.includes("<Invoice") || !xml.includes("urn:oasis:names:specification:ubl:schema:xsd:Invoice-2")) {
    erreurs.push({ code: "DGI-ERR-XML", message: "Document UBL 2.1 absent ou non reconnu.", champ: "xml_ubl" });
  }
  if (!/^[0-9a-f]{64}$/i.test(String(requete.hash_sha256 ?? ""))) {
    erreurs.push({
      code: "DGI-ERR-HASH",
      message: "Empreinte d'inaltérabilité absente ou malformée (64 hexadécimaux attendus).",
      champ: "hash_sha256",
    });
  }

  return erreurs;
}

// ─── Implémentation bac à sable ─────────────────────────────────────────────

export interface OptionsMockDgi {
  /**
   * Latence simulée, en millisecondes. Le défaut imite un aller-retour réel
   * (l'UI doit être écrite pour une attente, pas pour une réponse immédiate) ;
   * les tests passent 0.
   */
  latenceMs?: number;
  /**
   * Taux de panne technique simulée, entre 0 et 1. Sert à éprouver le chemin
   * d'erreur de l'appelant. Nul par défaut — une panne aléatoire en
   * développement serait un piège, pas une aide.
   */
  tauxPanne?: number;
  /** Générateur d'UUID, injectable pour rendre les tests déterministes. */
  genererUuid?: () => string;
  /** Horloge injectable, même raison. */
  maintenant?: () => Date;
}

interface EntreeRegistre {
  dgi_uuid: string;
  statut: DgiStatus;
  hash: string;
  invoice_id: string;
  numero: string;
  soumis_le: string;
  valide_le: string | null;
  motif_annulation?: string;
}

/**
 * Plateforme DGI simulée.
 *
 * Elle tient un registre en mémoire, ce qui lui permet de se comporter comme un
 * vrai service sur trois points qui comptent :
 *
 *   • `checkStatus` répond sur un UUID connu et échoue sur un inconnu ;
 *   • une RE-soumission à l'identique rend le MÊME UUID (idempotence) — sans
 *     quoi un simple double-clic créerait deux factures fiscales pour une seule
 *     vente ;
 *   • une re-soumission du même numéro avec un contenu DIFFÉRENT est rejetée
 *     en doublon, comme le ferait la DGI : une facture émise ne se corrige pas,
 *     elle s'annule et se remplace.
 *
 * Le registre est volontairement en mémoire : il est remis à zéro au
 * redémarrage, ce qui est le comportement attendu d'un bac à sable.
 */
export class MockDgiService implements DgiConnectorInterface {
  readonly nom = "MockDgiService";
  readonly production = false;

  private readonly registre = new Map<string, EntreeRegistre>();
  private readonly parUuid = new Map<string, EntreeRegistre>();
  private readonly options: Required<OptionsMockDgi>;

  constructor(options: OptionsMockDgi = {}) {
    this.options = {
      latenceMs: options.latenceMs ?? 450,
      tauxPanne: options.tauxPanne ?? 0,
      genererUuid: options.genererUuid ?? randomUUID,
      maintenant: options.maintenant ?? (() => new Date()),
    };
  }

  private async simulerReseau(): Promise<void> {
    if (this.options.latenceMs > 0) {
      await new Promise((r) => setTimeout(r, this.options.latenceMs));
    }
    if (this.options.tauxPanne > 0 && Math.random() < this.options.tauxPanne) {
      throw new Error("Plateforme DGI injoignable (panne simulée)");
    }
  }

  /** Clef d'unicité côté DGI : un numéro de facture est unique PAR ÉMETTEUR. */
  private clef(requete: DgiSubmitRequest): string {
    return `${requete.ice_vendeur ?? "?"}|${requete.numero.trim().toUpperCase()}`;
  }

  async submitInvoice(requete: DgiSubmitRequest): Promise<DgiSubmitResponse> {
    await this.simulerReseau();
    const horodatage = this.options.maintenant().toISOString();

    const erreurs = controlerRequete(requete);
    if (erreurs.length > 0) {
      return {
        accepte: false,
        statut: "REJECTED_BY_DGI",
        dgi_uuid: null,
        horodatage,
        erreurs,
        brut: { service: this.nom, resultat: "REJET", horodatage, erreurs },
      };
    }

    const clef = this.clef(requete);
    const existant = this.registre.get(clef);
    if (existant) {
      // Même facture, même contenu → on rend le récépissé déjà attribué. Un
      // nouvel UUID ferait exister deux fois la même vente au fichier fiscal.
      if (existant.hash === requete.hash_sha256 && existant.statut !== "CANCELLED_BY_DGI") {
        return {
          accepte: true,
          statut: existant.statut,
          dgi_uuid: existant.dgi_uuid,
          horodatage,
          erreurs: [],
          brut: { service: this.nom, resultat: "DEJA_TRANSMISE", horodatage, dgi_uuid: existant.dgi_uuid },
        };
      }
      if (existant.statut !== "CANCELLED_BY_DGI") {
        return {
          accepte: false,
          statut: "REJECTED_BY_DGI",
          dgi_uuid: null,
          horodatage,
          erreurs: [
            {
              code: "DGI-ERR-DOUBLON",
              message:
                `Le numéro ${requete.numero} a déjà été transmis avec un contenu différent ` +
                `(récépissé ${existant.dgi_uuid}). Une facture transmise ne se modifie pas : ` +
                "annulez-la puis émettez un avoir ou une facture rectificative.",
              champ: "numero",
            },
          ],
          brut: { service: this.nom, resultat: "DOUBLON", horodatage, dgi_uuid: existant.dgi_uuid },
        };
      }
    }

    const entree: EntreeRegistre = {
      dgi_uuid: this.options.genererUuid(),
      // La plateforme valide immédiatement dans ce bac à sable. En production,
      // le traitement peut être asynchrone : c'est pourquoi l'appelant doit
      // TOUJOURS passer par `checkStatus` et ne jamais présumer de l'issue.
      statut: "VALIDATED_BY_DGI",
      hash: requete.hash_sha256,
      invoice_id: requete.invoice_id,
      numero: requete.numero,
      soumis_le: horodatage,
      valide_le: horodatage,
    };
    this.registre.set(clef, entree);
    this.parUuid.set(entree.dgi_uuid, entree);

    return {
      accepte: true,
      statut: entree.statut,
      dgi_uuid: entree.dgi_uuid,
      horodatage,
      erreurs: [],
      brut: {
        service: this.nom,
        resultat: "ACCEPTE",
        horodatage,
        dgi_uuid: entree.dgi_uuid,
        numero: requete.numero,
        montant_ttc: round2(requete.montant_ttc),
        empreinte: requete.hash_sha256,
        taille_xml: requete.xml_ubl.length,
      },
    };
  }

  async checkStatus(dgiUuid: string): Promise<DgiStatusResponse> {
    await this.simulerReseau();
    const horodatage = this.options.maintenant().toISOString();
    const entree = this.parUuid.get(dgiUuid);

    if (!entree) {
      return {
        statut: "REJECTED_BY_DGI",
        dgi_uuid: dgiUuid,
        horodatage,
        erreurs: [{ code: "DGI-ERR-INCONNU", message: "Aucune facture ne correspond à ce récépissé." }],
        brut: { service: this.nom, resultat: "INCONNU", horodatage },
      };
    }

    return {
      statut: entree.statut,
      dgi_uuid: entree.dgi_uuid,
      horodatage,
      valide_le: entree.valide_le,
      erreurs: [],
      brut: { service: this.nom, resultat: "TROUVE", horodatage, entree: { ...entree } },
    };
  }

  async cancelInvoice(dgiUuid: string, motif: string): Promise<DgiCancelResponse> {
    await this.simulerReseau();
    const horodatage = this.options.maintenant().toISOString();
    const entree = this.parUuid.get(dgiUuid);

    if (!entree) {
      return {
        annule: false,
        statut: "REJECTED_BY_DGI",
        dgi_uuid: dgiUuid,
        horodatage,
        erreurs: [{ code: "DGI-ERR-INCONNU", message: "Aucune facture ne correspond à ce récépissé." }],
        brut: { service: this.nom, resultat: "INCONNU", horodatage },
      };
    }

    // Le motif est exigé : une annulation sans justification n'est pas
    // opposable en contrôle, et la DGI la refuse.
    if (!motif?.trim()) {
      return {
        annule: false,
        statut: entree.statut,
        dgi_uuid: dgiUuid,
        horodatage,
        erreurs: [{ code: "DGI-ERR-MOTIF", message: "Motif d'annulation obligatoire.", champ: "motif" }],
        brut: { service: this.nom, resultat: "MOTIF_MANQUANT", horodatage },
      };
    }

    if (entree.statut === "CANCELLED_BY_DGI") {
      return {
        annule: true,
        statut: entree.statut,
        dgi_uuid: dgiUuid,
        horodatage,
        erreurs: [],
        brut: { service: this.nom, resultat: "DEJA_ANNULEE", horodatage },
      };
    }

    entree.statut = "CANCELLED_BY_DGI";
    entree.motif_annulation = motif.trim();
    return {
      annule: true,
      statut: entree.statut,
      dgi_uuid: dgiUuid,
      horodatage,
      erreurs: [],
      brut: { service: this.nom, resultat: "ANNULEE", horodatage, motif: entree.motif_annulation },
    };
  }
}

// ─── Implémentation REST réelle ─────────────────────────────────────────────

export interface OptionsHttpDgi {
  urlBase: string;
  apiKey: string;
  /** Certificat client PEM pour l'authentification mutuelle, si exigée. */
  certificat?: string | null;
  clefPrivee?: string | null;
  timeoutMs?: number;
}

/**
 * Connecteur REST vers la plateforme DGI.
 *
 * Écrit d'avance, non exercé : les URL, noms de champs et codes d'erreur ci-
 * dessous sont des HYPOTHÈSES calquées sur les plateformes comparables, et
 * devront être confrontés à la documentation le jour de l'ouverture des accès.
 * Ce qui est acquis en revanche, et qui est l'essentiel, c'est que la surface
 * exposée au métier est déjà la bonne : seul l'intérieur de ces trois méthodes
 * bougera.
 *
 * Le transport passe par `proxyFetch` comme tout le reste du serveur — sans
 * quoi les appels mourraient en `TypeError: fetch failed` derrière le proxy TLS
 * d'entreprise, une panne déjà rencontrée sur ce projet et difficile à lire.
 */
export class HttpDgiConnector implements DgiConnectorInterface {
  readonly nom = "HttpDgiConnector";
  readonly production = true;

  constructor(private readonly options: OptionsHttpDgi) {
    if (!options.urlBase) throw new Error("DGI_API_URL manquante");
    if (!options.apiKey) throw new Error("DGI_API_KEY manquante");
  }

  private async appeler(chemin: string, methode: string, corps?: unknown): Promise<{ statut: number; json: any }> {
    const url = `${this.options.urlBase.replace(/\/+$/, "")}${chemin}`;
    const reponse = await proxyFetch(url, {
      method: methode,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${this.options.apiKey}`,
      },
      body: corps === undefined ? undefined : JSON.stringify(corps),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
    });

    // On lit le corps AVANT de tester le code : les plateformes fiscales
    // renvoient leurs motifs de rejet dans un 400, et jeter le corps rendrait
    // le rejet indéchiffrable pour le comptable.
    const texte = await reponse.text();
    let json: any = null;
    try {
      json = texte ? JSON.parse(texte) : null;
    } catch {
      json = { brut: texte };
    }
    return { statut: reponse.status, json };
  }

  async submitInvoice(requete: DgiSubmitRequest): Promise<DgiSubmitResponse> {
    const horodatage = new Date().toISOString();
    const { statut, json } = await this.appeler("/invoices", "POST", {
      invoice_reference: requete.numero,
      issue_date: requete.date_facture,
      supplier_ice: requete.ice_vendeur,
      customer_ice: requete.ice_acheteur,
      total_excl_tax: requete.montant_ht,
      total_tax: requete.montant_tva,
      total_incl_tax: requete.montant_ttc,
      document_hash: requete.hash_sha256,
      // Le XML est encodé en base64 : le transmettre brut dans du JSON
      // l'exposerait à une ré-échappement qui casserait l'empreinte.
      ubl_document: Buffer.from(requete.xml_ubl, "utf8").toString("base64"),
    });

    const accepte = statut >= 200 && statut < 300 && !!json?.uuid;
    return {
      accepte,
      statut: accepte ? "VALIDATED_BY_DGI" : "REJECTED_BY_DGI",
      dgi_uuid: json?.uuid ?? null,
      horodatage: json?.timestamp ?? horodatage,
      erreurs: extraireErreurs(json, statut),
      brut: { service: this.nom, http: statut, reponse: json },
    };
  }

  async checkStatus(dgiUuid: string): Promise<DgiStatusResponse> {
    const { statut, json } = await this.appeler(`/invoices/${encodeURIComponent(dgiUuid)}`, "GET");
    return {
      statut: normaliserStatut(json?.status, statut),
      dgi_uuid: dgiUuid,
      horodatage: json?.timestamp ?? new Date().toISOString(),
      valide_le: json?.validated_at ?? null,
      erreurs: extraireErreurs(json, statut),
      brut: { service: this.nom, http: statut, reponse: json },
    };
  }

  async cancelInvoice(dgiUuid: string, motif: string): Promise<DgiCancelResponse> {
    const { statut, json } = await this.appeler(`/invoices/${encodeURIComponent(dgiUuid)}/cancel`, "POST", {
      reason: motif,
    });
    const annule = statut >= 200 && statut < 300;
    return {
      annule,
      statut: annule ? "CANCELLED_BY_DGI" : normaliserStatut(json?.status, statut),
      dgi_uuid: dgiUuid,
      horodatage: json?.timestamp ?? new Date().toISOString(),
      erreurs: extraireErreurs(json, statut),
      brut: { service: this.nom, http: statut, reponse: json },
    };
  }
}

function normaliserStatut(brut: unknown, http: number): DgiStatus {
  switch (String(brut ?? "").toUpperCase()) {
    case "VALIDATED":
    case "ACCEPTED":
      return "VALIDATED_BY_DGI";
    case "REJECTED":
      return "REJECTED_BY_DGI";
    case "CANCELLED":
    case "CANCELED":
      return "CANCELLED_BY_DGI";
    case "PENDING":
    case "PROCESSING":
      return "PENDING_DGI";
    default:
      return http >= 200 && http < 300 ? "PENDING_DGI" : "REJECTED_BY_DGI";
  }
}

function extraireErreurs(json: any, http: number): DgiErreur[] {
  if (Array.isArray(json?.errors) && json.errors.length > 0) {
    return json.errors.map((e: any) => ({
      code: String(e?.code ?? "DGI-ERR"),
      message: String(e?.message ?? e?.detail ?? "Erreur non détaillée par la plateforme."),
      champ: e?.field ?? undefined,
    }));
  }
  if (http >= 400) {
    return [
      {
        code: `DGI-HTTP-${http}`,
        message: String(json?.message ?? json?.error ?? `La plateforme a répondu ${http} sans détail.`),
      },
    ];
  }
  return [];
}

// ─── Fabrique ───────────────────────────────────────────────────────────────

let connecteurMemorise: DgiConnectorInterface | null = null;

/**
 * Rend le connecteur à utiliser, choisi par l'environnement.
 *
 * Le bac à sable est le défaut ASSUMÉ : tant que `DGI_API_URL` et
 * `DGI_API_KEY` ne sont pas renseignées, il n'y a pas de plateforme à joindre,
 * et lever ici empêcherait purement et simplement d'émettre des factures. Le
 * mode retenu est en revanche TRACÉ dans le journal de chaque échange, pour
 * qu'aucun récépissé simulé ne puisse être pris pour un vrai.
 */
export function obtenirConnecteurDgi(forcer?: DgiConnectorInterface): DgiConnectorInterface {
  if (forcer) {
    connecteurMemorise = forcer;
    return forcer;
  }
  if (connecteurMemorise) return connecteurMemorise;

  const urlBase = process.env.DGI_API_URL ?? "";
  const apiKey = process.env.DGI_API_KEY ?? "";

  if (urlBase && apiKey) {
    connecteurMemorise = new HttpDgiConnector({
      urlBase,
      apiKey,
      certificat: process.env.DGI_CLIENT_CERT ?? null,
      clefPrivee: process.env.DGI_CLIENT_KEY ?? null,
      timeoutMs: Number(process.env.DGI_TIMEOUT_MS ?? 30_000),
    });
    console.log("[DGI] Connecteur RÉEL actif :", urlBase);
  } else {
    connecteurMemorise = new MockDgiService({
      latenceMs: Number(process.env.DGI_MOCK_LATENCE_MS ?? 450),
    });
    console.log("[DGI] Bac à sable actif (DGI_API_URL/DGI_API_KEY non renseignées).");
  }
  return connecteurMemorise;
}

/** Réinitialise la fabrique — réservé aux tests. */
export function reinitialiserConnecteurDgi(): void {
  connecteurMemorise = null;
}
