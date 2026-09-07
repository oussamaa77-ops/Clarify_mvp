// ============================================================================
// fiscal-identifiers.ts — validation des identifiants fiscaux marocains.
//
// Ce module est la GARDE d'entrée de la facturation électronique : aucune
// facture ne part à la DGI sans que ses identités aient franchi `validerEmission`.
// Il est PUR (aucun accès base, aucun framework) pour tourner indifféremment
// côté serveur (avant transmission) et côté navigateur (avant même d'activer le
// bouton « Transmettre »), avec le MÊME verdict des deux côtés.
//
// Pourquoi être strict : un ICE rejeté par la DGI n'est pas un avertissement
// cosmétique. La facture repart en REJECTED_BY_DGI, doit être annulée puis
// réémise sous un nouveau numéro, et la TVA correspondante reste indéductible
// pour le client tant que ce n'est pas fait. Il coûte infiniment moins cher de
// bloquer à la saisie.
// ============================================================================

/** Champ concerné par une anomalie, tel que nommé dans le modèle de données. */
export type ChampFiscal =
  | "ice_vendeur"
  | "if_vendeur"
  | "rc_vendeur"
  | "patente_vendeur"
  | "ice_acheteur"
  | "if_acheteur";

export interface AnomalieFiscale {
  champ: ChampFiscal;
  /** Code stable, destiné aux tests et au journal DGI — jamais traduit. */
  code: "MANQUANT" | "LONGUEUR" | "NON_NUMERIQUE" | "SEQUENCE_INVALIDE";
  /** Message en clair, affiché tel quel à l'utilisateur. */
  message: string;
}

export interface ResultatValidation {
  ok: boolean;
  erreurs: AnomalieFiscale[];
  avertissements: AnomalieFiscale[];
}

/** Longueur normative de l'ICE : 15 chiffres, sans exception. */
export const ICE_LONGUEUR = 15;

/**
 * Normalise un identifiant saisi à la main : espaces, points, tirets et slashs
 * sautent. Les ICE sont couramment recopiés « 001 234 567 000 089 » depuis un
 * en-tête de facture — refuser cette forme ferait rejeter des saisies correctes.
 */
export function normaliserIdentifiant(valeur: string | null | undefined): string {
  return String(valeur ?? "").replace(/[\s.\-/_]/g, "").trim();
}

/**
 * ICE — Identifiant Commun de l'Entreprise : exactement 15 chiffres
 * (9 pour l'entité + 4 pour l'établissement + 2 de clé).
 *
 * On refuse aussi les séquences dégénérées (000000000000000, 111111111111111,
 * 123456789012345) : elles ont la bonne forme, passent tous les contrôles de
 * longueur, et sont ce que produit un OCR qui n'a rien lu ou un utilisateur qui
 * « remplit pour passer à la suite ». Les laisser filer revient à transmettre
 * une facture qui sera rejetée côté DGI, trop tard.
 */
export function validerIce(valeur: string | null | undefined): {
  valide: boolean;
  normalise: string;
  code?: AnomalieFiscale["code"];
} {
  const v = normaliserIdentifiant(valeur);
  if (!v) return { valide: false, normalise: "", code: "MANQUANT" };
  if (!/^\d+$/.test(v)) return { valide: false, normalise: v, code: "NON_NUMERIQUE" };
  if (v.length !== ICE_LONGUEUR) return { valide: false, normalise: v, code: "LONGUEUR" };
  if (estSequenceDegeneree(v)) return { valide: false, normalise: v, code: "SEQUENCE_INVALIDE" };
  return { valide: true, normalise: v };
}

/**
 * IF — Identifiant Fiscal : numérique, 6 à 9 chiffres selon l'ancienneté de
 * l'attribution (les IF récents sont à 8 chiffres, les anciens à 7).
 * Pas de clé de contrôle publiée : on ne peut valider que la forme.
 */
export function validerIf(valeur: string | null | undefined): {
  valide: boolean;
  normalise: string;
  code?: AnomalieFiscale["code"];
} {
  const v = normaliserIdentifiant(valeur);
  if (!v) return { valide: false, normalise: "", code: "MANQUANT" };
  if (!/^\d+$/.test(v)) return { valide: false, normalise: v, code: "NON_NUMERIQUE" };
  if (v.length < 6 || v.length > 9) return { valide: false, normalise: v, code: "LONGUEUR" };
  if (estSequenceDegeneree(v)) return { valide: false, normalise: v, code: "SEQUENCE_INVALIDE" };
  return { valide: true, normalise: v };
}

/**
 * RC — Registre du Commerce : numéro du greffe, 1 à 12 chiffres. Il est souvent
 * écrit « 123456/Casablanca » : on ne garde que la partie numérique de tête,
 * la ville n'étant pas un élément d'identification transmis en UBL.
 */
export function validerRc(valeur: string | null | undefined): {
  valide: boolean;
  normalise: string;
  code?: AnomalieFiscale["code"];
} {
  const brut = String(valeur ?? "").trim();
  if (!brut) return { valide: false, normalise: "", code: "MANQUANT" };
  const v = normaliserIdentifiant(brut.split(/[^\d\s.\-/_]/)[0] ?? "");
  if (!v) return { valide: false, normalise: "", code: "NON_NUMERIQUE" };
  if (v.length > 12) return { valide: false, normalise: v, code: "LONGUEUR" };
  return { valide: true, normalise: v };
}

/** Patente (taxe professionnelle) : numérique, 6 à 10 chiffres. */
export function validerPatente(valeur: string | null | undefined): {
  valide: boolean;
  normalise: string;
  code?: AnomalieFiscale["code"];
} {
  const v = normaliserIdentifiant(valeur);
  if (!v) return { valide: false, normalise: "", code: "MANQUANT" };
  if (!/^\d+$/.test(v)) return { valide: false, normalise: v, code: "NON_NUMERIQUE" };
  if (v.length < 6 || v.length > 10) return { valide: false, normalise: v, code: "LONGUEUR" };
  return { valide: true, normalise: v };
}

/**
 * Chiffres tous identiques, ou suite de pas ±1.
 *
 * Le pas se compte MODULO 10 : « 123456789012345 » repasse de 9 à 0, ce qui
 * donne un delta de −9 et non de +1. Sans le modulo, la saisie de remplissage
 * la plus évidente au clavier passerait à travers le filtre.
 */
function estSequenceDegeneree(chiffres: string): boolean {
  if (/^(\d)\1+$/.test(chiffres)) return true;
  let croissante = true;
  let decroissante = true;
  for (let i = 1; i < chiffres.length; i++) {
    const delta = (Number(chiffres[i]) - Number(chiffres[i - 1]) + 10) % 10;
    if (delta !== 1) croissante = false;
    if (delta !== 9) decroissante = false;
  }
  return croissante || decroissante;
}

/** Identités telles qu'elles seront figées sur la facture. */
export interface IdentitesFiscales {
  ice_vendeur?: string | null;
  if_vendeur?: string | null;
  rc_vendeur?: string | null;
  patente_vendeur?: string | null;
  ice_acheteur?: string | null;
  if_acheteur?: string | null;
}

export interface OptionsEmission {
  /**
   * Vente à particulier : l'acheteur n'a ni ICE ni IF, et c'est LÉGAL. Sans ce
   * drapeau, toute facture B2C serait bloquée à l'émission. En B2C, un ICE
   * acheteur *renseigné mais faux* reste une erreur — on ne valide pas
   * l'absence, on valide ce qui est présent.
   */
  b2c?: boolean;
}

const LIBELLES: Record<ChampFiscal, string> = {
  ice_vendeur: "ICE du vendeur",
  if_vendeur: "IF du vendeur",
  rc_vendeur: "RC du vendeur",
  patente_vendeur: "Patente du vendeur",
  ice_acheteur: "ICE de l'acheteur",
  if_acheteur: "IF de l'acheteur",
};

function message(champ: ChampFiscal, code: AnomalieFiscale["code"]): string {
  const nom = LIBELLES[champ];
  switch (code) {
    case "MANQUANT":
      return `${nom} manquant.`;
    case "NON_NUMERIQUE":
      return `${nom} doit ne contenir que des chiffres.`;
    case "LONGUEUR":
      return champ === "ice_vendeur" || champ === "ice_acheteur"
        ? `${nom} doit compter exactement ${ICE_LONGUEUR} chiffres.`
        : `${nom} n'a pas une longueur admise.`;
    case "SEQUENCE_INVALIDE":
      return `${nom} est une séquence invraisemblable (chiffres identiques ou suite) — vérifiez la saisie.`;
  }
}

/**
 * Verdict d'émission. Distingue deux niveaux, et c'est le cœur de la règle :
 *
 *   • ERREURS — bloquantes. ICE et IF du vendeur : sans eux la facture n'a pas
 *     d'émetteur identifiable, la DGI la rejette systématiquement. ICE acheteur
 *     en B2B pour la même raison côté destinataire.
 *
 *   • AVERTISSEMENTS — non bloquants. RC et patente sont des mentions
 *     obligatoires de la facture PAPIER, mais leur absence ne déclenche pas de
 *     rejet DGI : bloquer dessus empêcherait d'émettre une facture par ailleurs
 *     valide, ce qui serait pire que la mention manquante.
 */
export function validerEmission(
  identites: IdentitesFiscales,
  options: OptionsEmission = {},
): ResultatValidation {
  const erreurs: AnomalieFiscale[] = [];
  const avertissements: AnomalieFiscale[] = [];

  const pousser = (
    cible: AnomalieFiscale[],
    champ: ChampFiscal,
    code: AnomalieFiscale["code"],
  ) => cible.push({ champ, code, message: message(champ, code) });

  const iceV = validerIce(identites.ice_vendeur);
  if (!iceV.valide) pousser(erreurs, "ice_vendeur", iceV.code!);

  const ifV = validerIf(identites.if_vendeur);
  if (!ifV.valide) pousser(erreurs, "if_vendeur", ifV.code!);

  const rcV = validerRc(identites.rc_vendeur);
  if (!rcV.valide) pousser(avertissements, "rc_vendeur", rcV.code!);

  const patV = validerPatente(identites.patente_vendeur);
  if (!patV.valide) pousser(avertissements, "patente_vendeur", patV.code!);

  // Acheteur : en B2C on ne réclame rien, mais on contrôle ce qui est saisi.
  const iceARenseigne = !!normaliserIdentifiant(identites.ice_acheteur);
  const iceA = validerIce(identites.ice_acheteur);
  // En B2C, seule l'ABSENCE est tolérée : un ICE saisi doit rester valide.
  const absenceToleree = options.b2c === true && !iceARenseigne;
  if (!iceA.valide && !absenceToleree) pousser(erreurs, "ice_acheteur", iceA.code!);

  const ifARenseigne = !!normaliserIdentifiant(identites.if_acheteur);
  if (ifARenseigne) {
    const ifA = validerIf(identites.if_acheteur);
    if (!ifA.valide) pousser(erreurs, "if_acheteur", ifA.code!);
  } else if (!options.b2c) {
    // L'IF de l'acheteur n'est pas exigé par la DGI pour accepter le flux :
    // seul l'ICE identifie le destinataire. On le signale sans bloquer.
    pousser(avertissements, "if_acheteur", "MANQUANT");
  }

  return { ok: erreurs.length === 0, erreurs, avertissements };
}

/**
 * Renvoie les identités NORMALISÉES prêtes à être figées sur la facture.
 * Séparé de la validation à dessein : on veut stocker la forme canonique
 * (chiffres nus) même quand un avertissement subsiste, sinon le hash
 * d'inaltérabilité dépendrait de la façon dont l'utilisateur a tapé les espaces.
 */
export function normaliserIdentites(identites: IdentitesFiscales): IdentitesFiscales {
  return {
    ice_vendeur: normaliserIdentifiant(identites.ice_vendeur) || null,
    if_vendeur: normaliserIdentifiant(identites.if_vendeur) || null,
    rc_vendeur: validerRc(identites.rc_vendeur).normalise || null,
    patente_vendeur: normaliserIdentifiant(identites.patente_vendeur) || null,
    ice_acheteur: normaliserIdentifiant(identites.ice_acheteur) || null,
    if_acheteur: normaliserIdentifiant(identites.if_acheteur) || null,
  };
}
