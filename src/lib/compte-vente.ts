// ============================================================================
// compte-vente.ts — Choix du compte de PRODUIT d'une facture de vente (PCM).
//
// Le journal des ventes écrivait « 7111 » en dur sur TOUTE facture. C'est le
// compte des ventes de MARCHANDISES : une société de services y logeait donc ses
// honoraires, et son compte de résultat annonçait un négoce qu'elle ne fait pas.
//
//   7111  Ventes de marchandises          — revente en l'état
//   7121  Ventes de biens produits        — production vendue (BTP, industrie)
//   7124  Ventes de services produits     — prestations, honoraires, maintenance
//
// ─── Ordre de décision (du plus sûr au plus général) ─────────────────────────
//   1. la nature EXPLICITE portée par la facture, si elle est renseignée ;
//   2. les DÉSIGNATIONS des lignes — c'est ce que le client a réellement acheté ;
//   3. le SECTEUR du dossier, paramétré une fois pour toutes ;
//   4. 7111, le repli historique — aucun compte existant ne change sans motif.
//
// La règle 2 précède la 3 délibérément : un négociant qui facture une
// installation vend bien une prestation, et le secteur ne doit pas écraser ce
// que dit la ligne. Logique pure, partagée par la facturation et la reprise.
// ============================================================================

import { FALLBACK_SECTEUR, normaliser } from "@/lib/categorization-engine";
import { PCM } from "@/lib/pcm-referentiel";

export const COMPTE_VENTE_MARCHANDISES = PCM.VENTES_MARCHANDISES;
export const COMPTE_VENTE_BIENS_PRODUITS = PCM.VENTES_BIENS_PRODUITS;
export const COMPTE_VENTE_SERVICES = PCM.VENTES_SERVICES;

export type NatureVente = "marchandises" | "biens_produits" | "services";

const COMPTE_PAR_NATURE: Record<NatureVente, string> = {
  marchandises: COMPTE_VENTE_MARCHANDISES,
  biens_produits: COMPTE_VENTE_BIENS_PRODUITS,
  services: COMPTE_VENTE_SERVICES,
};

/**
 * Mots-clés de PRESTATION. Volontairement resserrés : un faux positif déplace un
 * produit d'un compte à l'autre et fausse le compte de résultat, alors qu'un
 * faux négatif laisse simplement le repli s'appliquer. Dans le doute, ne pas
 * décider.
 */
const MOTS_SERVICES = [
  "prestation", "prestations", "service", "services", "honoraire", "honoraires",
  "conseil", "consulting", "assistance", "maintenance", "abonnement",
  "formation", "etude", "etudes", "audit", "developpement", "integration",
  "hebergement", "licence", "support", "intervention", "main d oeuvre",
  "main d'oeuvre", "installation", "reparation", "depannage", "location",
];

/** Mots-clés de MARCHANDISE — la revente en l'état. */
const MOTS_MARCHANDISES = [
  "marchandise", "marchandises", "produit", "produits", "article", "articles",
  "vente de", "livraison", "fourniture", "fournitures", "materiel", "matériel",
  "piece", "pieces", "carton", "unite", "unites",
];

/** Nature devinée d'un texte libre. `null` quand rien ne tranche. */
export function natureDepuisTexte(texte: string | null | undefined): NatureVente | null {
  const t = normaliser(texte);
  if (!t) return null;
  const contient = (mots: string[]) => mots.some((m) => t.includes(normaliser(m)));
  const services = contient(MOTS_SERVICES);
  const marchandises = contient(MOTS_MARCHANDISES);
  // Les deux familles présentes → on ne tranche pas : « fourniture et pose »
  // relève d'un arbitrage humain, pas d'un mot-clé.
  if (services === marchandises) return null;
  return services ? "services" : "marchandises";
}

export interface ContexteVente {
  /** Nature explicite portée par la facture, quand elle existe. */
  nature?: string | null;
  /** Désignations des lignes de la facture. */
  designations?: (string | null | undefined)[];
  /** Secteur d'activité du dossier (clé de `FALLBACK_SECTEUR`). */
  secteur?: string | null;
}

export interface ChoixCompteVente {
  compte: string;
  nature: NatureVente;
  /** Ce qui a tranché — tracé pour que le comptable puisse contester. */
  regle: "nature_explicite" | "designations" | "secteur" | "defaut";
}

/** Normalise une nature écrite à la main (« Services », « presta »…). */
function natureExplicite(v: string | null | undefined): NatureVente | null {
  const t = normaliser(v);
  if (!t) return null;
  if (/(service|presta|honorai)/.test(t)) return "services";
  if (/(bien.*produit|production|fabrication)/.test(t)) return "biens_produits";
  if (/(marchandise|negoce|revente)/.test(t)) return "marchandises";
  return null;
}

/** Compte de produit d'une facture de vente, et la règle qui l'a désigné. */
export function compteVente(ctx: ContexteVente = {}): ChoixCompteVente {
  const explicite = natureExplicite(ctx.nature);
  if (explicite) return { compte: COMPTE_PAR_NATURE[explicite], nature: explicite, regle: "nature_explicite" };

  // Les désignations sont jugées ENSEMBLE : une facture de dix lignes de
  // prestation et d'une ligne de fourniture reste une facture de prestation.
  const texte = (ctx.designations ?? []).filter(Boolean).join(" ");
  const devinee = natureDepuisTexte(texte);
  if (devinee) return { compte: COMPTE_PAR_NATURE[devinee], nature: devinee, regle: "designations" };

  const secteur = FALLBACK_SECTEUR[String(ctx.secteur ?? "").trim()];
  if (secteur?.produit) {
    const nature = secteur.produit === COMPTE_VENTE_SERVICES
      ? "services"
      : secteur.produit === COMPTE_VENTE_BIENS_PRODUITS ? "biens_produits" : "marchandises";
    return { compte: secteur.produit, nature, regle: "secteur" };
  }

  return { compte: COMPTE_VENTE_MARCHANDISES, nature: "marchandises", regle: "defaut" };
}
