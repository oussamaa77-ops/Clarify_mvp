// ============================================================================
// statut-paiement.ts — Vocabulaire métier des statuts de règlement.
//
// ─── Pourquoi une traduction plutôt qu'un renommage ──────────────────────────
// `statut_paiement` est un TYPE ÉNUMÉRÉ PostgreSQL — `('non_payee','partielle',
// 'payee','en_retard')` — dont les valeurs sont écrites en dur dans cinq
// fonctions SQL (lier_transaction, le trigger de `paiements`, le bank suspense,
// la balance âgée, la reconciliation). Renommer les valeurs de l'ENUM sans
// recréer ces fonctions dans la MÊME migration fait échouer tout enregistrement
// de règlement en production (« invalid input value for enum »).
//
// Le vocabulaire métier est donc porté ICI, en surface, et la base garde ses
// valeurs. C'est aussi ce qui permet d'en changer sans migration.
//
// Règle : on STOCKE `StatutStocke`, on AFFICHE `StatutMetier`. Aucun composant
// ne doit comparer une chaîne de statut en dur — c'est ainsi que « partielle »
// et « partiellement_payee » finiraient par coexister.
// ============================================================================

/** Ce que la base contient réellement (ENUM `public.statut_paiement`). */
export type StatutStocke = "non_payee" | "partielle" | "payee" | "en_retard";

/** Le vocabulaire métier, exposé à l'utilisateur, aux exports et à l'API. */
export type StatutMetier = "en_attente" | "partiellement_payee" | "payee" | "en_retard";

const VERS_METIER: Record<StatutStocke, StatutMetier> = {
  non_payee: "en_attente",
  partielle: "partiellement_payee",
  payee: "payee",
  en_retard: "en_retard",
};

const VERS_STOCKE: Record<StatutMetier, StatutStocke> = {
  en_attente: "non_payee",
  partiellement_payee: "partielle",
  payee: "payee",
  en_retard: "en_retard",
};

/** Statut métier depuis la valeur stockée. Une valeur inconnue reste « en attente ». */
export function statutMetier(stocke: string | null | undefined): StatutMetier {
  const s = String(stocke ?? "").trim() as StatutStocke;
  return VERS_METIER[s] ?? "en_attente";
}

/** Valeur à ÉCRIRE en base depuis un statut métier — le seul chemin vers l'ENUM. */
export function statutStocke(metier: string | null | undefined): StatutStocke {
  const s = String(metier ?? "").trim();
  if (s in VERS_STOCKE) return VERS_STOCKE[s as StatutMetier];
  // Tolère qu'on lui passe déjà une valeur stockée : les deux vocabulaires se
  // croisent le temps que les appelants migrent.
  if (s in VERS_METIER) return s as StatutStocke;
  return "non_payee";
}

/** Libellé français, prêt à afficher. */
export const LIBELLES_STATUT: Record<StatutMetier, string> = {
  en_attente: "En attente",
  partiellement_payee: "Partiellement payée",
  payee: "Payée",
  en_retard: "En retard",
};

export function libelleStatut(stocke: string | null | undefined): string {
  return LIBELLES_STATUT[statutMetier(stocke)];
}

/**
 * Statut déduit des montants — l'unique règle de décision.
 *
 * Seuil d'1 MAD sur le reste dû, aligné sur la RPC `lier_transaction` : sans lui,
 * un centime d'arrondi laisserait une facture éternellement « partiellement
 * payée ». Le seuil s'applique au RESTE, jamais au payé.
 */
export function statutDepuisMontants(ttc: number, paye: number): StatutMetier {
  const t = Number(ttc) || 0;
  const p = Number(paye) || 0;
  if (p <= 0.005) return "en_attente";
  return t - p <= 1 ? "payee" : "partiellement_payee";
}

/** La facture est-elle soldée ? Vrai pour la seule valeur « payée ». */
export const estSoldee = (stocke: string | null | undefined): boolean =>
  statutMetier(stocke) === "payee";

/** Reste-t-il quelque chose à encaisser ? Inclut « en retard ». */
export const estOuverte = (stocke: string | null | undefined): boolean => !estSoldee(stocke);
