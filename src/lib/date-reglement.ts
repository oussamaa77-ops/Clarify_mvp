/**
 * Date de règlement RÉELLEMENT constatée d'une facture (client ou fournisseur).
 *
 * Pendant symétrique de `mode-paiement.ts` : là où celui-ci répond « par quel
 * instrument », celui-ci répond « quel jour ». Et la réponse vient des mêmes
 * pièces, pour la même raison — c'est la pièce qui fait foi, pas la saisie :
 *
 *   1. `paiements.date_paiement` — la date choisie dans le modal de règlement
 *      manuel. Source de vérité du reste dû, donc du règlement lui-même.
 *   2. `transactions_bancaires.date_operation` — quand la facture a été lettrée
 *      contre une ligne de relevé, la banque DATE l'opération : c'est la date la
 *      plus fiable qui existe, personne ne l'a saisie à la main.
 *   3. `encaissements.date_encaissement` — encaissement espèces/chèque saisi
 *      depuis la page Banque.
 *   4. `factures.date_paiement` — repli pour les factures antérieures au moteur
 *      de paiement, qui ne portent que cette colonne.
 *
 * QUELLE date retenir quand plusieurs pièces existent : la PLUS RÉCENTE. Une
 * facture réglée en trois fois est soldée le jour du dernier versement, et c'est
 * cette date-là que le comptable cherche dans la colonne. Retenir la première
 * ferait passer pour ancienne une créance encaissée hier.
 *
 * Aucune colonne nouvelle en base : tout se déduit de l'existant.
 */

import type { SensFacture } from "@/lib/mode-paiement";

/** D'où vient la date affichée — sert à l'infobulle de la colonne. */
export type SourceDateReglement = "manuel" | "banque" | "encaissement" | "facture";

export const SOURCE_DATE_LABEL: Record<SourceDateReglement, string> = {
  manuel:       "Règlement saisi manuellement",
  banque:       "Date de l'opération bancaire (relevé rapproché)",
  encaissement: "Encaissement espèces / chèque saisi",
  facture:      "Date portée par la facture (règlement non détaillé)",
};

export interface DateReglement {
  /** Date ISO (YYYY-MM-DD). */
  date: string;
  source: SourceDateReglement;
  /** Nombre de règlements distincts recensés — > 1 = paiement échelonné. */
  nbReglements: number;
}

/** Normalise une date en YYYY-MM-DD ; rend "" si elle est inutilisable. */
const jour = (v: string | null | undefined): string => {
  const s = String(v ?? "").trim();
  if (!s) return "";
  const d = s.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : "";
};

export interface PaiementDateRef {
  facture_id?: string | null;
  facture_fournisseur_id?: string | null;
  date_paiement?: string | null;
  montant?: number | string | null;
}

export interface TransactionDateRef {
  facture_id?: string | null;
  document_type?: string | null;
  date_operation?: string | null;
}

export interface EncaissementDateRef {
  facture_id?: string | null;
  facture_fournisseur_id?: string | null;
  date_encaissement?: string | null;
}

/**
 * Index facture → date de règlement constatée.
 *
 * Chaque pièce est versée avec sa date ; la plus récente l'emporte. À date
 * ÉGALE, l'ordre de priorité départage : la banque prime sur le reste, car sa
 * date d'opération n'est pas une saisie.
 */
export function indexerDatesReglement(
  sens: SensFacture,
  sources: {
    paiements?: PaiementDateRef[];
    transactions?: TransactionDateRef[];
    encaissements?: EncaissementDateRef[];
  },
): Map<string, DateReglement> {
  const index = new Map<string, DateReglement>();
  const docType = sens === "client" ? "facture_client" : "facture_fournisseur";
  // Départage à date égale — plus le rang est haut, plus la source est sûre.
  const rang: Record<SourceDateReglement, number> = {
    banque: 3, manuel: 2, encaissement: 1, facture: 0,
  };

  const poser = (id: string | null | undefined, d: string | null | undefined, source: SourceDateReglement) => {
    const date = jour(d);
    if (!id || !date) return;
    const actuel = index.get(id);
    if (!actuel) { index.set(id, { date, source, nbReglements: 1 }); return; }
    const nbReglements = actuel.nbReglements + 1;
    const plusRecente = date > actuel.date
      || (date === actuel.date && rang[source] > rang[actuel.source]);
    index.set(id, plusRecente ? { date, source, nbReglements } : { ...actuel, nbReglements });
  };

  for (const p of sources.paiements ?? []) {
    const id = sens === "client" ? p?.facture_id : p?.facture_fournisseur_id;
    // Un paiement à montant nul ou négatif n'est pas un règlement : il ne date rien.
    if (Number(p?.montant ?? 1) <= 0) continue;
    poser(id, p?.date_paiement, "manuel");
  }

  for (const t of sources.transactions ?? []) {
    if (!t?.facture_id) continue;
    // document_type absent : lignes lettrées avant son introduction (backfill
    // 'inconnu'). L'id de facture suffit alors à trancher le sens.
    if (t.document_type && t.document_type !== docType && t.document_type !== "inconnu") continue;
    poser(t.facture_id, t.date_operation, "banque");
  }

  for (const e of sources.encaissements ?? []) {
    const id = sens === "client" ? e?.facture_id : e?.facture_fournisseur_id;
    poser(id, e?.date_encaissement, "encaissement");
  }

  return index;
}

// ─── Vraisemblance : on ne règle pas une facture avant de l'émettre ──────────

export interface ValiditeDateReglement {
  ok: boolean;
  /** Message prêt à afficher, `null` quand la date est acceptable. */
  message: string | null;
}

/**
 * Contrôle d'une date de règlement saisie.
 *
 * Deux impossibilités, et une seule tolérance :
 *   • une date ANTÉRIEURE à l'émission — la base en portait deux (FA-2026-0084
 *     réglée le 10 mars pour une facture du 17 mai). Une telle date range
 *     l'encaissement dans la mauvaise déclaration de TVA et fausse le délai de
 *     règlement de la balance âgée ;
 *   • une date dans le FUTUR — un encaissement qui n'a pas eu lieu.
 *
 * La tolérance : une date de facture absente ou illisible ne bloque rien. Le
 * contrôle sert à empêcher une saisie fausse, pas à rendre une facture
 * inutilisable parce qu'un import ancien n'a pas renseigné son émission.
 *
 * Même règle des deux côtés du fil : le formulaire l'appelle pour désactiver le
 * bouton, la server function pour refuser l'appel. Une validation qui n'existe
 * qu'au formulaire n'est pas une validation.
 */
export function validerDateReglement(
  dateFacture: string | null | undefined,
  dateReglement: string | null | undefined,
  aujourdhui: string | Date = new Date(),
): ValiditeDateReglement {
  const regl = jour(dateReglement);
  if (!regl) return { ok: false, message: "Saisissez la date de règlement" };

  const fact = jour(dateFacture);
  if (fact && regl < fact) {
    return {
      ok: false,
      message: `Date de règlement (${regl}) antérieure à la facture (${fact}) : `
        + "une facture ne peut pas être réglée avant d'être émise.",
    };
  }

  const now = typeof aujourdhui === "string" ? jour(aujourdhui) : jour(aujourdhui.toISOString());
  if (now && regl > now) {
    return { ok: false, message: `Date de règlement dans le futur (${regl}).` };
  }

  return { ok: true, message: null };
}

/** Rendu court et localisé pour la colonne « Date de règlement ». */
export const formaterDateReglement = (d: DateReglement | null): string =>
  d ? new Date(d.date).toLocaleDateString("fr-MA") : "—";

/** Infobulle : d'où sort la date, et s'il y a eu plusieurs versements. */
export const infobulleDateReglement = (d: DateReglement | null): string | undefined => {
  if (!d) return undefined;
  const base = SOURCE_DATE_LABEL[d.source];
  return d.nbReglements > 1
    ? `${base} — dernier de ${d.nbReglements} règlements`
    : base;
};

export interface FactureDateRef {
  id: string;
  statut_paiement?: string | null;
  date_paiement?: string | null;
}

/**
 * Date à afficher pour une facture. Rend null tant qu'aucun règlement n'est
 * enregistré : une facture en attente n'a pas de date de règlement, et en
 * afficher une laisserait croire qu'elle est réglée.
 */
export function dateReglementFacture(
  f: FactureDateRef,
  index: Map<string, DateReglement>,
): DateReglement | null {
  if (f.statut_paiement !== "payee" && f.statut_paiement !== "partielle") return null;
  const trouvee = index.get(f.id);
  if (trouvee) return trouvee;
  // Repli : facture antérieure au moteur de paiement, sans pièce rattachée.
  const date = jour(f.date_paiement);
  return date ? { date, source: "facture", nbReglements: 1 } : null;
}
