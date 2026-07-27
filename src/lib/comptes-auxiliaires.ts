/**
 * comptes-auxiliaires.ts — comptabilité AUXILIAIRE : dérive le compte de tiers
 * détaillé (44110005, 34210002…) à partir du compte collectif PCM et du code
 * auxiliaire déjà porté par la fiche tiers (`clients.code_auxiliaire` /
 * `fournisseurs.code_auxiliaire`, migration 20260624120000).
 *
 * Pourquoi dériver plutôt que stocker une colonne de plus : le code auxiliaire
 * existe déjà, il est unique par dossier, il est séquentiel (« F0005 », « C0002 »)
 * et il alimente déjà l'export Sage. Le compte auxiliaire n'en est que la forme
 * « compte » : COLLECTIF + partie numérique du code.
 *
 *     fournisseur « F0005 » + collectif 4411  →  44110005
 *     client      « C0002 » + collectif 3421  →  34210002
 *
 * Conséquence importante : le compte auxiliaire COMMENCE toujours par son
 * collectif. Tout le code existant qui raisonne par PRÉFIXE (lettrage
 * `startsWith("441")`, balance âgée, postes ouverts) continue donc de fonctionner
 * sans modification — ce qui a été vérifié : aucune comparaison stricte
 * `=== "4411"` / `=== "3421"` n'existe dans le code applicatif.
 *
 * Sans code auxiliaire sur la fiche, on retombe sur le COLLECTIF : le
 * comportement historique est strictement préservé.
 */

/** Sens du tiers, qui détermine le compte collectif PCM. */
export type TypeTiers = "client" | "fournisseur";

/** Comptes collectifs PCM marocains. */
export const COMPTE_COLLECTIF: Record<TypeTiers, string> = {
  client: "3421",       // Clients
  fournisseur: "4411",  // Fournisseurs
};

/** Largeur de la partie numérique du compte auxiliaire (44110005 → « 0005 »). */
export const LARGEUR_AUXILIAIRE = 4;

/**
 * Compte de tiers à imputer sur la ligne 3 de l'écriture.
 * Renvoie le compte auxiliaire si un code exploitable existe, sinon le collectif.
 *
 * Robuste aux saisies libres : « F0005 », « f-0005 », « 5 », « FOURN 0005 » et
 * même « 44110005 » (déjà un compte complet) donnent tous 44110005.
 */
export function compteTiersAuxiliaire(
  type: TypeTiers,
  codeAuxiliaire?: string | null,
): string {
  const collectif = COMPTE_COLLECTIF[type];
  const brut = (codeAuxiliaire ?? "").trim();
  if (!brut) return collectif;

  // Code déjà saisi sous forme de compte complet (« 44110005 ») → tel quel.
  if (brut.startsWith(collectif) && /^\d+$/.test(brut) && brut.length > collectif.length) return brut;

  const chiffres = brut.replace(/\D+/g, "");
  if (!chiffres) return collectif;                      // code sans aucun chiffre
  const n = Number(chiffres);
  if (!Number.isFinite(n) || n === 0) return collectif;  // « F0000 » n'est pas un tiers

  // Zéro-padding sur la largeur standard, sans TRONQUER un code plus long.
  const suffixe = chiffres.length >= LARGEUR_AUXILIAIRE
    ? chiffres.replace(/^0+(?=\d)/, "").padStart(LARGEUR_AUXILIAIRE, "0")
    : chiffres.padStart(LARGEUR_AUXILIAIRE, "0");
  return `${collectif}${suffixe}`;
}

/** `true` si `compte` est un compte auxiliaire (ou le collectif) de ce type. */
export function estCompteDeTiers(compte: string | null | undefined, type: TypeTiers): boolean {
  return String(compte ?? "").trim().startsWith(COMPTE_COLLECTIF[type]);
}

/**
 * Compte collectif d'un compte de tiers — la « racine » sous laquelle la balance
 * générale doit regrouper les auxiliaires (44110005 → 4411).
 */
export function collectifDeCompte(compte: string | null | undefined): string | null {
  const c = String(compte ?? "").trim();
  for (const collectif of Object.values(COMPTE_COLLECTIF)) {
    if (c.startsWith(collectif)) return collectif;
  }
  return null;
}

/** Partie auxiliaire d'un compte de tiers (44110005 → « 0005 » ; 4411 → null). */
export function suffixeAuxiliaire(compte: string | null | undefined): string | null {
  const c = String(compte ?? "").trim();
  const collectif = collectifDeCompte(c);
  if (!collectif) return null;
  const reste = c.slice(collectif.length);
  return reste.length ? reste : null;
}
