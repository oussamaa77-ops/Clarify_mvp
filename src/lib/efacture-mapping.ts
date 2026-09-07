// ============================================================================
// efacture-mapping.ts — traduction entre le modèle stocké et le modèle fiscal.
//
// La base parle en lignes de tables (`factures`, `dossiers`, `clients`) ; les
// générateurs UBL, QR et PDF parlent en objets fiscaux. Tout le passage de l'un
// à l'autre est ici, et NULLE PART ailleurs — c'est ce qui permet de le tester
// sans base, et d'éviter qu'une règle comme « l'ICE figé prime sur l'ICE de la
// fiche client » soit réimplémentée trois fois avec trois nuances.
// ============================================================================

import type { IdentitesFiscales } from "./fiscal-identifiers";
import type { FactureUbl, LigneUbl, TypeDocumentFiscal } from "./ubl-invoice";

export type DgiStatus =
  | "DRAFT"
  | "PENDING_DGI"
  | "VALIDATED_BY_DGI"
  | "REJECTED_BY_DGI"
  | "CANCELLED_BY_DGI";

/** Ligne `factures` telle que lue, en ne typant que ce qu'on consomme. */
export interface LigneFactureStockee {
  id: string;
  numero: string | null;
  type: string | null;
  date_facture: string;
  date_echeance: string | null;
  montant_ht: number | null;
  montant_tva: number | null;
  montant_ttc: number | null;
  lignes: unknown;
  notes?: string | null;
  /** `factures.mode_reglement` — vocabulaire applicatif, traduit en UNCL4461. */
  mode_reglement?: string | null;
  ice_vendeur?: string | null;
  if_vendeur?: string | null;
  rc_vendeur?: string | null;
  patente_vendeur?: string | null;
  ice_acheteur?: string | null;
  if_acheteur?: string | null;
  dgi_status?: string | null;
  dgi_uuid?: string | null;
  hash_sha256?: string | null;
  xml_ubl?: string | null;
  facture_parent_id?: string | null;
}

export interface SocieteStockee {
  nom_societe?: string | null;
  ice?: string | null;
  if_fiscal?: string | null;
  rc?: string | null;
  patente?: string | null;
  adresse?: string | null;
  email_societe?: string | null;
  telephone?: string | null;
}

export interface TiersStocke {
  nom?: string | null;
  ice?: string | null;
  if_fiscal?: string | null;
  rc?: string | null;
  adresse?: string | null;
  email?: string | null;
  telephone?: string | null;
}

/**
 * Identités fiscales à utiliser pour cette facture.
 *
 * RÈGLE CENTRALE : ce qui est FIGÉ sur la facture prime toujours sur la fiche.
 * Une facture déjà transmise porte les identifiants qui ont été déclarés ; si
 * le client corrige son ICE l'an prochain, relire sa fiche ferait basculer
 * l'empreinte d'inaltérabilité d'une facture pourtant intacte, et le contrôle
 * conclurait à une falsification. La fiche ne sert qu'à AMORCER les champs
 * encore vides, c'est-à-dire avant la première émission.
 */
export function resoudreIdentites(
  facture: LigneFactureStockee,
  societe: SocieteStockee | null | undefined,
  client: TiersStocke | null | undefined,
): IdentitesFiscales {
  return {
    ice_vendeur: facture.ice_vendeur ?? societe?.ice ?? null,
    if_vendeur: facture.if_vendeur ?? societe?.if_fiscal ?? null,
    rc_vendeur: facture.rc_vendeur ?? societe?.rc ?? null,
    patente_vendeur: facture.patente_vendeur ?? societe?.patente ?? null,
    ice_acheteur: facture.ice_acheteur ?? client?.ice ?? null,
    if_acheteur: facture.if_acheteur ?? client?.if_fiscal ?? null,
  };
}

/** Normalise le tableau `lignes` (JSONB, donc de forme non garantie). */
export function lireLignes(brut: unknown): LigneUbl[] {
  if (!Array.isArray(brut)) return [];
  return brut
    .map((l: any) => ({
      designation: String(l?.designation ?? "").trim(),
      quantite: Number(l?.quantite) || 0,
      prix_unitaire: Number(l?.prix_unitaire) || 0,
      taux_tva: l?.taux_tva === null || l?.taux_tva === undefined ? 20 : Number(l.taux_tva),
      unite: typeof l?.unite === "string" ? l.unite : undefined,
      motif_exoneration: typeof l?.motif_exoneration === "string" ? l.motif_exoneration : null,
    }))
    // Une ligne sans quantité ni prix ne représente rien de facturable ; la
    // laisser passer produirait un `InvoiceLine` à zéro que la DGI compte
    // comme une anomalie de structure.
    .filter((l) => l.quantite !== 0 || l.prix_unitaire !== 0);
}

/**
 * Type de document fiscal. Le modèle stocke deux vocabulaires qui se
 * chevauchent (`type` valant tantôt « facture », tantôt « acompte »/« solde ») :
 * un « solde » est fiscalement une facture ordinaire, seul l'acompte a son
 * propre code UNCL.
 */
export function typeFiscal(type: string | null | undefined): TypeDocumentFiscal {
  switch (String(type ?? "").toLowerCase()) {
    case "avoir":
      return "avoir";
    case "acompte":
      return "acompte";
    case "proforma":
      return "proforma";
    default:
      return "facture";
  }
}

/** Assemble l'objet fiscal complet à partir des lignes de base. */
export function construireFactureUbl(
  facture: LigneFactureStockee,
  societe: SocieteStockee | null | undefined,
  client: TiersStocke | null | undefined,
  extra: { facture_origine?: string | null } = {},
): FactureUbl {
  const identites = resoudreIdentites(facture, societe, client);
  return {
    // Une facture sans numéro ne devrait jamais être transmise ; on retombe sur
    // l'identifiant technique plutôt que d'émettre un `cbc:ID` vide, qui rend
    // le document invalide au lieu de simplement mal nommé.
    numero: facture.numero?.trim() || facture.id,
    date_facture: String(facture.date_facture).slice(0, 10),
    date_echeance: facture.date_echeance ? String(facture.date_echeance).slice(0, 10) : null,
    type: typeFiscal(facture.type),
    devise: "MAD",
    lignes: lireLignes(facture.lignes),
    notes: facture.notes ?? null,
    hash_sha256: facture.hash_sha256 ?? null,
    dgi_uuid: facture.dgi_uuid ?? null,
    mode_reglement: facture.mode_reglement ?? null,
    facture_origine: extra.facture_origine ?? null,
    vendeur: {
      nom: societe?.nom_societe ?? "—",
      ice: identites.ice_vendeur ?? null,
      if_fiscal: identites.if_vendeur ?? null,
      rc: identites.rc_vendeur ?? null,
      patente: identites.patente_vendeur ?? null,
      adresse: societe?.adresse ?? null,
      email: societe?.email_societe ?? null,
      telephone: societe?.telephone ?? null,
      pays: "MA",
    },
    acheteur: {
      nom: client?.nom ?? "—",
      ice: identites.ice_acheteur ?? null,
      if_fiscal: identites.if_acheteur ?? null,
      rc: client?.rc ?? null,
      adresse: client?.adresse ?? null,
      email: client?.email ?? null,
      telephone: client?.telephone ?? null,
      pays: "MA",
    },
  };
}

// ─── Journal des échanges ───────────────────────────────────────────────────

/**
 * Valeur strictement JSON. Le journal vit dans une colonne `jsonb` et transite
 * par une server function : `unknown` y passerait au compilateur mais pas au
 * sérialiseur, qui refuse ce qu'il ne sait pas transporter. Nommer la
 * contrainte ici la fait respecter dès la construction de l'entrée, plutôt
 * qu'au moment de l'envoi.
 */
export type ValeurJson = string | number | boolean | null | ValeurJson[] | { [clef: string]: ValeurJson };

export interface EntreeJournal {
  sens: "requete" | "reponse";
  operation: "submitInvoice" | "checkStatus" | "cancelInvoice" | "generateUbl";
  at: string;
  /** Nom du connecteur : distingue un récépissé simulé d'un vrai. */
  connecteur?: string;
  payload: ValeurJson;
}

/**
 * Le journal est borné. Il vit dans une colonne JSONB de la ligne facture :
 * sans plafond, une facture qu'on interroge en boucle finirait par alourdir
 * CHAQUE lecture de la liste des factures. On garde les échanges les plus
 * RÉCENTS — ce sont eux qui expliquent l'état courant.
 */
export const JOURNAL_MAX = 40;

export function ajouterAuJournal(
  journal: unknown,
  entrees: EntreeJournal | EntreeJournal[],
): EntreeJournal[] {
  const existant = Array.isArray(journal) ? (journal as EntreeJournal[]) : [];
  const ajout = Array.isArray(entrees) ? entrees : [entrees];
  const complet = [...existant, ...ajout];
  return complet.slice(Math.max(0, complet.length - JOURNAL_MAX));
}

/**
 * Reconstitue un journal pour les factures qui n'en ont pas de structuré :
 * celles émises avant sa mise en place, et toutes tant que la colonne
 * `dgi_response_payload` n'existe pas en base.
 *
 * Sans cela, une facture portant un récépissé DGI affiche « aucun échange
 * enregistré » — ce qui donne à croire qu'elle n'a jamais été transmise, le
 * contraire exact de ce qu'annonce son statut. Mieux vaut un historique partiel
 * et daté, dont l'origine est dite, qu'un vide trompeur.
 */
export function reconstituerJournal(
  facture: { dgi_response?: unknown; updated_at?: string | null; created_at?: string | null },
  traces: { action: string; details?: unknown; created_at: string }[] = [],
): EntreeJournal[] {
  const reconstitue: EntreeJournal[] = traces.map((trace) => ({
    sens: "reponse",
    operation: trace.action === "efacture_annulee" ? "cancelInvoice" : "submitInvoice",
    at: trace.created_at,
    payload: {
      origine: "audit_logs",
      action: trace.action,
      ...((trace.details ?? {}) as Record<string, ValeurJson>),
    },
  }));

  // La dernière réponse brute ne sert qu'à défaut de trace d'audit : elle n'est
  // pas datée par elle-même, et la superposer aux traces ferait apparaître deux
  // fois le même échange.
  if (reconstitue.length === 0 && facture.dgi_response) {
    reconstitue.push({
      sens: "reponse",
      operation: "submitInvoice",
      at: facture.updated_at ?? facture.created_at ?? new Date().toISOString(),
      payload: {
        origine: "dgi_response (avant journal structuré)",
        ...(facture.dgi_response as Record<string, ValeurJson>),
      },
    });
  }

  return reconstitue;
}

// ─── Présentation des statuts ───────────────────────────────────────────────

export interface PresentationStatut {
  libelle: string;
  /** Ton d'affichage, mappé côté UI sur une variante de badge. */
  ton: "neutre" | "attente" | "succes" | "erreur";
  description: string;
}

const PRESENTATIONS: Record<DgiStatus, PresentationStatut> = {
  DRAFT: {
    libelle: "Brouillon",
    ton: "neutre",
    description: "La facture n'a pas encore été transmise à la DGI.",
  },
  PENDING_DGI: {
    libelle: "En attente DGI",
    ton: "attente",
    description: "Transmise à la DGI, en cours de traitement. Le récépissé n'est pas encore attribué.",
  },
  VALIDATED_BY_DGI: {
    libelle: "Conforme DGI",
    ton: "succes",
    description: "Validée par la DGI et scellée : elle ne peut plus être modifiée, seulement annulée.",
  },
  REJECTED_BY_DGI: {
    libelle: "Rejetée",
    ton: "erreur",
    description: "Refusée par la DGI. Corrigez les anomalies signalées puis retransmettez.",
  },
  CANCELLED_BY_DGI: {
    libelle: "Annulée",
    ton: "erreur",
    description: "Annulée auprès de la DGI. Une facture rectificative ou un avoir doit lui succéder.",
  },
};

/** Statut normalisé, tolérant aux valeurs héritées de l'ancienne colonne. */
export function normaliserStatutDgi(brut: string | null | undefined): DgiStatus {
  const v = String(brut ?? "").toUpperCase();
  if (v in PRESENTATIONS) return v as DgiStatus;
  // Reprise des valeurs de `statut_dgi` (français, minuscules) : sans elle, une
  // facture émise avant la migration s'afficherait « Brouillon » alors qu'elle
  // porte un récépissé DGI.
  switch (String(brut ?? "").toLowerCase()) {
    case "conforme":
    case "valide":
    case "validee":
      return "VALIDATED_BY_DGI";
    case "rejetee":
    case "rejete":
      return "REJECTED_BY_DGI";
    case "en_analyse":
    case "en_attente":
      return "PENDING_DGI";
    case "annulee":
      return "CANCELLED_BY_DGI";
    default:
      return "DRAFT";
  }
}

export function presenterStatutDgi(brut: string | null | undefined): PresentationStatut {
  return PRESENTATIONS[normaliserStatutDgi(brut)];
}

/**
 * Une facture scellée par la DGI est-elle encore modifiable ?
 * Réponse fiscale : non. On l'expose ici pour que l'UI grise les actions au
 * lieu de laisser l'utilisateur tenter une modification que la base ou la
 * plateforme refusera plus tard, sans qu'il comprenne pourquoi.
 */
export function estFigeeFiscalement(brut: string | null | undefined): boolean {
  const statut = normaliserStatutDgi(brut);
  return statut === "VALIDATED_BY_DGI" || statut === "PENDING_DGI";
}

/** Peut-on (re)transmettre cette facture à la DGI ? */
export function peutTransmettre(brut: string | null | undefined): boolean {
  const statut = normaliserStatutDgi(brut);
  return statut === "DRAFT" || statut === "REJECTED_BY_DGI";
}
