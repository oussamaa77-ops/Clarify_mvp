/**
 * CategorizationEngine — moteur de catégorisation comptable PCM (Plan Comptable
 * Marocain) centralisé et HYBRIDE. Une seule source de vérité, partagée par la
 * saisie manuelle ET le post-traitement OCR, pour qu'une facture donne le même
 * compte quel que soit le canal d'entrée (rétro-compatibilité stricte).
 *
 * La suggestion est déterministe et AUDITABLE : `suggestAccount` renvoie non
 * seulement le compte, mais la règle qui l'a produit (`source`) et un `motif`
 * lisible. Trois règles, par priorité décroissante :
 *
 *   Règle 1a — Compte par défaut du TIERS (fournisseurs.compte_charge_defaut /
 *             clients.compte_produit_defaut). Le choix explicite du comptable
 *             prime sur toute heuristique.
 *   Règle 1b — Compte MÉMORISÉ pour ce tiers (`tiers_memoire.compte_pcm`, rappelé
 *             par ICE puis par libellé). Rend au comptable le compte qu'il a déjà
 *             saisi pour ce tiers, même sans l'avoir défini par défaut.
 *   Règle 2 — Dictionnaire de MOTS-CLÉS déterministes (télécom → 61455,
 *             loyer → 6131, assurance → 6134, honoraires → 6136…).
 *   Règle 3 — Fallback SECTORIEL : à défaut, un compte par défaut cohérent avec
 *             le secteur d'activité du dossier. Un branchement IA optionnel peut
 *             remplacer/affiner ce fallback (cf. `suggestAccountWithAi`), sans
 *             jamais bloquer le chemin synchrone.
 *
 * La fonction est PURE (aucun accès réseau/DB) : les comptes du tiers sont résolus
 * par l'appelant et passés via `compteDefautTiers` / `compteMemoireTiers`. `tiersId` reste
 * accepté à titre informatif (traçabilité/logs).
 */

// ── Types publics ────────────────────────────────────────────────────────────

/** Sens comptable : charge (achats) ou produit (ventes). */
export type SensCompte = "charge" | "produit";

/** Secteurs proposés dans la configuration du dossier (texte libre en base). */
export type SecteurActivite =
  | "Services IT"
  | "Commerce / Négoce"
  | "BTP"
  | "Restauration"
  | "Consulting"
  | (string & {});

/** Liste des secteurs proposés dans la configuration du dossier (UI). */
export const SECTEURS_ACTIVITE = [
  "Services IT",
  "Commerce / Négoce",
  "BTP",
  "Restauration",
  "Consulting",
] as const;

/** Origine de la suggestion — pour l'affichage et l'audit. */
export type SourceSuggestion = "tiers" | "memoire_tiers" | "mots_cles" | "secteur" | "defaut";

export interface SuggestAccountInput {
  /** Sens comptable attendu. Défaut : « charge » (le cas des achats). */
  sens?: SensCompte;
  /** Identifiant du tiers — informatif (l'appelant a déjà résolu son défaut). */
  tiersId?: string | null;
  /** Règle 1a : compte PCM configuré sur le tiers (déjà lu en base). */
  compteDefautTiers?: string | null;
  /**
   * Règle 1b : compte MÉMORISÉ pour ce tiers lors d'une validation précédente
   * (`tiers_memoire.compte_pcm`, rappelé par ICE puis par libellé normalisé). Sert
   * le cas « le comptable a saisi 44110005 sur la facture sans cliquer sur
   * “définir par défaut” » : au scan suivant du même ICE, on lui rend SON compte
   * plutôt qu'un compte générique. Passe APRÈS `compteDefautTiers` (configuration
   * explicite) mais AVANT les mots-clés.
   */
  compteMemoireTiers?: string | null;
  /** Libellé de la ligne / désignation saisie — matière de la Règle 2. */
  description?: string | null;
  /** Nom du tiers — renfort de mots-clés (ex. « MAROC TELECOM » → télécom). */
  nomTiers?: string | null;
  /** Montant (réservé : seuils d'immobilisation, TVA… — non utilisé à ce jour). */
  montant?: number | null;
  /** Secteur d'activité du dossier — pilote la Règle 3. */
  secteurActivite?: SecteurActivite | null;
}

export interface SuggestionCompte {
  /** Code PCM recommandé (ex. « 61455 »). */
  compte: string;
  /** Règle ayant produit la suggestion. */
  source: SourceSuggestion;
  /** Niveau de confiance indicatif. */
  confiance: "haute" | "moyenne" | "faible";
  /** Explication auditable de la décision. */
  motif: string;
  /** Mot-clé déclencheur (uniquement quand `source === "mots_cles"`). */
  motCle?: string;
  /** Libellé lisible du compte, si connu. */
  label?: string;
}

// ── Comptes de repli déterministes ───────────────────────────────────────────

/**
 * Compte de charge « générique » utilisé quand aucune règle plus précise ne
 * s'applique. Aligné sur l'historique (l'ancienne saisie fournisseur écrivait
 * « 6141 » en dur) → la migration vers le moteur ne change AUCUN compte existant.
 */
// ⚠️ Au CGNC, 6141 est « Études, recherches et documentation », pas un compte
// d'achats : repli historique conservé, À VALIDER (cf. COMPTES_A_VALIDER,
// src/lib/pcm-referentiel.ts). Doit rester égal à PCM.CHARGE_DEFAUT — un test le verrouille.
export const COMPTE_CHARGE_DEFAUT = "6141";
/** Compte de produit générique (ventes de marchandises au Maroc). */
export const COMPTE_PRODUIT_DEFAUT = "7111";

// ── Règle 2 — dictionnaire de mots-clés ──────────────────────────────────────

export interface RegleMotCle {
  compte: string;
  label: string;
  /** Sens auquel la règle s'applique (une charge ne vaut pas pour une vente). */
  sens: SensCompte;
  /** Mots-clés NORMALISÉS (minuscule, sans accent) recherchés dans le texte. */
  motsCles: string[];
}

/**
 * Dictionnaire ORDONNÉ : la première règle qui matche gagne. Les entrées les
 * plus spécifiques (marques, formulations non ambiguës) doivent précéder les
 * plus génériques. Codes PCM/CGNC marocains.
 */
export const DICTIONNAIRE_PCM: RegleMotCle[] = [
  // — Télécommunications : opérateurs marocains + termes génériques.
  {
    compte: "61455", label: "Frais de télécommunications", sens: "charge",
    motsCles: [
      "telecom", "telephone", "telephonie", "internet", "adsl", "fibre", "mobile", "forfait",
      "maroc telecom", "iam", "inwi", "orange", "meditel",
    ],
  },
  // — Loyers et charges locatives.
  {
    compte: "6131", label: "Locations et charges locatives", sens: "charge",
    motsCles: ["loyer", "location", "bail", "locative", "credit bail", "leasing"],
  },
  // — Assurances.
  {
    compte: "6134", label: "Primes d'assurances", sens: "charge",
    motsCles: ["assurance", "assurances", "prime d assurance", "police d assurance", "rc pro"],
  },
  // — Honoraires (comptable, avocat, conseil…).
  {
    compte: "6136", label: "Rémunérations d'intermédiaires et honoraires", sens: "charge",
    motsCles: [
      "honoraire", "honoraires", "comptable", "expert comptable", "expertise comptable",
      "avocat", "notaire", "conseil", "consulting", "audit", "fiduciaire",
    ],
  },
  // — Eau et électricité (achats non stockés).
  {
    compte: "61251", label: "Eau", sens: "charge",
    motsCles: ["eau", "redal", "lydec eau", "onep", "radeema"],
  },
  {
    compte: "61252", label: "Électricité", sens: "charge",
    motsCles: ["electricite", "electricity", "one", "onee", "lydec"],
  },
  // — Carburants et combustibles.
  {
    compte: "61411", label: "Combustibles / carburants", sens: "charge",
    motsCles: ["carburant", "gasoil", "gazole", "essence", "diesel", "station service", "shell", "total energies", "afriquia"],
  },
  // — Entretien et réparations.
  {
    compte: "6133", label: "Entretien et réparations", sens: "charge",
    motsCles: ["entretien", "reparation", "maintenance", "depannage", "sav"],
  },
  // — Transports et livraisons.
  {
    compte: "6142", label: "Transports", sens: "charge",
    motsCles: ["transport", "livraison", "fret", "messagerie", "logistique", "chronopost", "dhl"],
  },
  // — Déplacements, missions et réceptions.
  {
    compte: "6143", label: "Déplacements, missions et réceptions", sens: "charge",
    motsCles: ["deplacement", "mission", "hotel", "restaurant", "restauration", "peage", "billet", "train", "avion", "taxi"],
  },
  // — Publicité et relations publiques.
  {
    compte: "6144", label: "Publicité, publications et relations publiques", sens: "charge",
    motsCles: ["publicite", "marketing", "annonce", "communication", "sponsoring", "flyer", "impression"],
  },
  // — Fournitures de bureau.
  {
    compte: "61254", label: "Fournitures de bureau", sens: "charge",
    motsCles: ["fourniture de bureau", "fournitures de bureau", "papeterie", "cartouche", "toner", "consommable bureau"],
  },
  // — Services bancaires.
  {
    compte: "6147", label: "Services bancaires", sens: "charge",
    motsCles: ["frais bancaire", "frais bancaires", "commission bancaire", "agios", "tenue de compte"],
  },
];

// ── Règle 3 — fallback sectoriel ─────────────────────────────────────────────

interface FallbackSecteur { charge: string; produit: string }

/**
 * Compte par défaut par secteur, quand ni le tiers ni les mots-clés ne tranchent.
 * Choix prudents : un négociant achète surtout des marchandises (6111) et vend
 * des marchandises (7111) ; une société de services facture des prestations
 * (7124) et achète peu de marchandises (repli sur le générique 6141).
 */
export const FALLBACK_SECTEUR: Record<string, FallbackSecteur> = {
  "Commerce / Négoce": { charge: "6111", produit: "7111" },
  "Restauration":      { charge: "6111", produit: "7111" },
  "BTP":               { charge: "6121", produit: "7121" },
  "Services IT":       { charge: "6141", produit: "7124" },
  "Consulting":        { charge: "6136", produit: "7124" },
};

// ── Normalisation ────────────────────────────────────────────────────────────

/**
 * Minuscule, sans accent, ponctuation → espaces, espaces compactés. Le texte
 * comparé et les mots-clés du dictionnaire passent par la même moulinette, si
 * bien qu'« Électricité » matche « electricite » et « Rép. » matche « rep ».
 */
export function normaliser(v: string | null | undefined): string {
  return (v ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")    // diacritiques combinants
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")        // ponctuation → espace
    .trim()
    .replace(/\s+/g, " ");
}

// ── API ──────────────────────────────────────────────────────────────────────

/** Un compte est « configuré » s'il n'est ni nul ni vide après trim. */
function compteRenseigne(c: string | null | undefined): c is string {
  return typeof c === "string" && c.trim().length > 0;
}

/**
 * Suggère un compte PCM pour une ligne de facture. Toujours renvoie une
 * suggestion (jamais `null`) : à défaut de règle, le compte générique du sens
 * demandé, source « defaut ». Voir l'en-tête du module pour l'ordre des règles.
 */
export function suggestAccount(input: SuggestAccountInput): SuggestionCompte {
  const sens: SensCompte = input.sens ?? "charge";

  // — Règle 1 : compte par défaut du tiers (priorité absolue).
  if (compteRenseigne(input.compteDefautTiers)) {
    return {
      compte: input.compteDefautTiers.trim(),
      source: "tiers",
      confiance: "haute",
      motif: "Compte par défaut configuré sur le tiers.",
    };
  }

  // — Règle 1b : compte mémorisé pour ce tiers (rappel par ICE / libellé).
  if (compteRenseigne(input.compteMemoireTiers)) {
    return {
      compte: input.compteMemoireTiers.trim(),
      source: "memoire_tiers",
      confiance: "haute",
      motif: "Compte mémorisé pour ce tiers (validation précédente).",
    };
  }

  // — Règle 2 : dictionnaire de mots-clés (sur description + nom du tiers).
  // Correspondance par MOT entier, pas par sous-chaîne : on borne le texte et
  // les mots-clés par des espaces, sinon « eau » matcherait dans « bureau » et
  // « one » dans « téléphone ». Les mots-clés multi-mots restent gérés tels quels.
  const foin = ` ${normaliser(input.description)} ${normaliser(input.nomTiers)} `.replace(/\s+/g, " ");
  if (foin.trim()) {
    for (const regle of DICTIONNAIRE_PCM) {
      if (regle.sens !== sens) continue;
      const motCle = regle.motsCles.find((kw) => foin.includes(` ${kw} `));
      if (motCle) {
        return {
          compte: regle.compte,
          source: "mots_cles",
          confiance: "haute",
          motif: `Mot-clé « ${motCle} » → ${regle.label}.`,
          motCle,
          label: regle.label,
        };
      }
    }
  }

  // — Règle 3 : fallback sectoriel.
  const secteur = input.secteurActivite ?? "";
  const fb = FALLBACK_SECTEUR[secteur];
  if (fb) {
    const compte = sens === "produit" ? fb.produit : fb.charge;
    return {
      compte,
      source: "secteur",
      confiance: "moyenne",
      motif: `Compte par défaut du secteur « ${secteur} ».`,
    };
  }

  // — Défaut générique (préserve le comportement historique de la saisie).
  return {
    compte: sens === "produit" ? COMPTE_PRODUIT_DEFAUT : COMPTE_CHARGE_DEFAUT,
    source: "defaut",
    confiance: "faible",
    motif: "Aucune règle applicable — compte générique du sens demandé.",
  };
}

/**
 * Variante asynchrone : applique d'abord les règles déterministes ; si l'on
 * retombe sur le fallback (source « secteur » ou « defaut ») et qu'un
 * suggesteur IA est fourni, on lui laisse la main. L'IA ne peut donc JAMAIS
 * écraser une règle métier (tiers/mots-clés), seulement affiner l'incertain.
 * Toute erreur IA est absorbée : on garde la suggestion déterministe.
 */
export async function suggestAccountWithAi(
  input: SuggestAccountInput,
  aiSuggest?: (input: SuggestAccountInput) => Promise<string | null | undefined>,
): Promise<SuggestionCompte> {
  const base = suggestAccount(input);
  if (!aiSuggest) return base;
  if (base.source === "tiers" || base.source === "memoire_tiers" || base.source === "mots_cles") return base;
  try {
    const compteIa = await aiSuggest(input);
    if (compteRenseigne(compteIa)) {
      return {
        compte: compteIa.trim(),
        source: "secteur",
        confiance: "moyenne",
        motif: "Suggestion IA (fallback sectoriel affiné).",
      };
    }
  } catch {
    // Silencieux : le fallback déterministe reste valable.
  }
  return base;
}
