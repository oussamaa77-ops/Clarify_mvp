// ============================================================================
// numero-compte.ts — LA forme canonique d'un numéro de compte, sur 8 chiffres.
//
// ─── Pourquoi une longueur unique ────────────────────────────────────────────
// La base portait trois longueurs à la fois : 4 (« 5141 », « 4458 »), 5
// (« 44551 », « 34552 », « 61254 ») et 8 (« 44110005 », « 51610000 »). Les
// deux dernières ne sont pas des erreurs de saisie mais des couches successives
// — sous-comptes de TVA d'un côté, comptabilité auxiliaire et caisse de l'autre.
// Mêlées, elles rendent deux comptes IDENTIQUES visuellement différents :
// « 5141 » et « 51410000 » désignent la même banque, s'additionnent en deux
// lignes de balance, et un export vers Sage — qui exige une longueur fixe — en
// refuse une sur deux.
//
// La forme canonique est donc le PCM complété à DROITE par des zéros :
//     5141  → 51410000     34552 → 34552000     4458 → 44580000
// C'est la convention du plan comptable marocain, et c'est celle que la
// comptabilité auxiliaire suivait déjà : 4411 + « 0005 » = 44110005.
//
// ─── Ce que le padding ne doit PAS casser ────────────────────────────────────
// Tout le code applicatif DÉTECTE par racine et IMPUTE sur le sous-compte
// (cf. mémoire « tva-pcm-comptes-unifies »). Compléter à droite par des zéros
// préserve exactement cette lecture : `"44551000".startsWith("4455")` reste
// vrai, la classe reste le premier chiffre, le collectif reste le préfixe du
// compte auxiliaire. C'est la propriété qui rend la normalisation sûre —
// lettrage (3421*/4411*), balance par classe, TVA par racine et balance âgée
// continuent de fonctionner sans être touchés.
//
// Deux formes coexistent donc, et il faut savoir laquelle on manipule :
//
//   • `normaliserNumeroCompte` — la forme de STOCKAGE et d'ÉCHANGE (8 chiffres).
//     À appliquer au bord : juste avant un insert, à l'import, à l'export.
//   • `numeroSignificatif` — la forme COURTE, zéros de complément retirés
//     (« 44580000 » → « 4458 »). Elle sert à interroger un référentiel dont les
//     clefs sont restées au format PCM court, jamais à écrire en base.
//
// Un numéro non purement numérique n'est JAMAIS retouché : mieux vaut un code
// exotique conservé tel quel qu'un code corrompu par un padding aveugle.
//
// Logique pure : aucune base, aucun réseau.
// ============================================================================

/** Longueur canonique d'un numéro de compte, général comme auxiliaire. */
export const LARGEUR_COMPTE = 8;

/**
 * Longueur PCM minimale : on ne raccourcit jamais en dessous.
 *
 * Le plan comptable marocain s'arrête à 4 chiffres pour un compte
 * « divisionnaire » (6141, 4458). Retirer les zéros plus loin ferait remonter
 * « 51610000 » à « 5 », c'est-à-dire à la classe — plus un compte.
 */
export const LARGEUR_MIN_COMPTE = 4;

const txt = (v: unknown) => String(v ?? "").trim();
const estNumerique = (c: string) => /^[0-9]+$/.test(c);

/**
 * Forme canonique : 8 chiffres, complétés à droite par des zéros.
 *
 * Idempotente — `normaliserNumeroCompte(normaliserNumeroCompte(x)) === normaliserNumeroCompte(x)`.
 * Un compte déjà plus long que 8 chiffres est rendu tel quel : le tronquer
 * détruirait un code auxiliaire large, ce qui coûterait bien plus cher qu'une
 * longueur atypique.
 */
export function normaliserNumeroCompte(valeur: unknown): string {
  const c = txt(valeur);
  if (!c || !estNumerique(c)) return c;
  return c.length >= LARGEUR_COMPTE ? c : c.padEnd(LARGEUR_COMPTE, "0");
}

/**
 * Forme courte : zéros de complément retirés, sans descendre sous 4 chiffres.
 *
 *     44580000 → 4458     34552000 → 34552     44110005 → 44110005
 *
 * Sert à retrouver un compte dans un référentiel resté au format PCM court
 * (`pcm_reference`, dictionnaire du moteur de catégorisation).
 */
export function numeroSignificatif(valeur: unknown): string {
  const c = txt(valeur);
  if (!c || !estNumerique(c)) return c;
  let fin = c.length;
  while (fin > LARGEUR_MIN_COMPTE && c[fin - 1] === "0") fin -= 1;
  return c.slice(0, fin);
}

/**
 * Deux écritures désignent-elles le MÊME compte, quelles que soient leurs
 * longueurs ? « 5141 » et « 51410000 » : oui.
 */
export function memeCompte(a: unknown, b: unknown): boolean {
  const x = normaliserNumeroCompte(a);
  const y = normaliserNumeroCompte(b);
  return x !== "" && x === y;
}

/**
 * `compte` relève-t-il de la racine `racine` (4455, 3421, 47…) ?
 *
 * La racine se donne TOUJOURS en forme courte : c'est un préfixe, pas un
 * compte. Comparer deux formes canoniques échouerait — « 4455 » normalisé vaut
 * « 44550000 », dont « 44551000 » n'est pas un descendant lexical.
 */
export function estSousCompteDe(compte: unknown, racine: string): boolean {
  const c = normaliserNumeroCompte(compte);
  const r = txt(racine);
  return c !== "" && r !== "" && c.startsWith(r);
}

/** Classe CGNC d'un compte : son premier chiffre, ou "" si illisible. */
export function classeDeCompte(compte: unknown): string {
  const premier = txt(compte).charAt(0);
  return /^[0-9]$/.test(premier) ? premier : "";
}

/**
 * Normalise la clef de compte d'un lot de lignes, avant insertion ou export.
 *
 * Accepte les DEUX conventions de nommage du projet — `compte_numero` (colonne
 * de `ecritures_comptables`) et `compte` (les `LigneOD` du service de lettrage)
 * — parce que les deux atteignent la base par des chemins différents et qu'un
 * helper qui n'en couvre qu'une laisserait l'autre non normalisée.
 *
 * Rend un NOUVEAU tableau : les lignes d'entrée sont souvent les objets qu'un
 * appelant affiche encore à l'écran.
 */
export function normaliserComptesLignes<T extends object>(lignes: T[]): T[] {
  return (lignes ?? []).map((l) => {
    if (!l || typeof l !== "object") return l;
    const vue = l as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if ("compte_numero" in vue) patch.compte_numero = normaliserNumeroCompte(vue.compte_numero);
    if ("compte" in vue) patch.compte = normaliserNumeroCompte(vue.compte);
    return Object.keys(patch).length ? { ...l, ...patch } : l;
  });
}
