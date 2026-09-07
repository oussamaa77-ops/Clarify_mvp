// ============================================================================
// invoice-hash.ts — empreinte d'inaltérabilité d'une facture.
//
// L'empreinte répond à UNE question, celle que pose un contrôle fiscal : « ce
// document est-il bien celui qui a été émis, ou a-t-il été retouché depuis ? »
// Elle est calculée à l'émission, transmise à la DGI, imprimée dans le QR code
// du PDF, et recalculable à tout moment. Si un seul des champs qui la composent
// bouge — numéro, date, ICE, montant TTC — l'empreinte ne retombe plus.
//
// ─── Ce qui entre dans le calcul ─────────────────────────────────────────────
//   numéro | date | ICE vendeur | ICE acheteur | montant TTC | clef secrète
//
// ─── Pourquoi des SÉPARATEURS ────────────────────────────────────────────────
// Concaténer sans séparateur est une faille classique : les couples
// (numéro « FA12 », ICE « 3… ») et (numéro « FA1 », ICE « 23… ») produisent la
// même chaîne, donc la même empreinte. Deux factures distinctes deviendraient
// interchangeables. Le séparateur `|` lève l'ambiguïté, et il est interdit dans
// les champs normalisés (les ICE sont numériques, le numéro est nettoyé).
//
// ─── Pourquoi une forme CANONIQUE ────────────────────────────────────────────
// « 001 547 896 000 073 » et « 001547896000073 » sont le même ICE mais deux
// chaînes. Sans normalisation, l'empreinte dépendrait de la façon dont
// l'utilisateur a tapé ses espaces, et le recalcul de contrôle échouerait sur
// une facture pourtant intacte. Idem pour la date (toujours ISO) et le montant
// (toujours deux décimales).
// ============================================================================

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { normaliserIdentifiant } from "./fiscal-identifiers";

/**
 * Version du schéma de calcul, préfixée à la chaîne canonique.
 *
 * Le jour où la DGI impose une composition différente, les empreintes déjà
 * émises doivent rester vérifiables : la version dit avec quelle règle
 * recalculer. Sans elle, changer la formule invaliderait rétroactivement tout
 * l'historique — c'est-à-dire exactement ce que l'inaltérabilité doit empêcher.
 */
export const HASH_VERSION = "HISAB-1";

export type AlgorithmeHash = "sha256" | "hmac-sha256";

export interface ChampsHash {
  numero: string;
  /** Date d'émission ; `Date` ou chaîne, ramenée à `YYYY-MM-DD`. */
  date_facture: string | Date;
  ice_vendeur: string | null | undefined;
  ice_acheteur: string | null | undefined;
  montant_ttc: number;
}

/** Ramène une date à sa forme ISO `YYYY-MM-DD`, quelle que soit l'entrée. */
export function dateCanonique(valeur: string | Date): string {
  if (valeur instanceof Date) {
    if (Number.isNaN(valeur.getTime())) throw new Error("Date de facture invalide");
    // `toISOString` bascule en UTC : sur une date née à minuit heure locale à
    // l'est de Greenwich, elle rendrait la VEILLE. On lit donc les composantes
    // locales, qui sont celles que l'utilisateur a saisies et vues.
    const mois = String(valeur.getMonth() + 1).padStart(2, "0");
    const jour = String(valeur.getDate()).padStart(2, "0");
    return `${valeur.getFullYear()}-${mois}-${jour}`;
  }
  const texte = String(valeur ?? "").trim();
  const iso = texte.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const fr = texte.match(/^(\d{2})[/\-.](\d{2})[/\-.](\d{4})$/);
  if (fr) return `${fr[3]}-${fr[2]}-${fr[1]}`;
  throw new Error(`Date de facture non reconnue : « ${texte} »`);
}

/** Numéro de facture canonique : espaces compactés, majuscules. */
export function numeroCanonique(numero: string | null | undefined): string {
  const v = String(numero ?? "").trim().replace(/\s+/g, " ").toUpperCase();
  // Le séparateur du format ne doit jamais apparaître DANS un champ, sans quoi
  // l'ambiguïté qu'il sert à lever reviendrait par la fenêtre.
  return v.replace(/\|/g, "/");
}

/** Montant canonique : deux décimales, point décimal, jamais de `-0.00`. */
export function montantCanonique(montant: number): string {
  const n = Math.round((Number(montant) + Number.EPSILON) * 100) / 100;
  if (!Number.isFinite(n)) throw new Error("Montant TTC invalide");
  return (Object.is(n, -0) ? 0 : n).toFixed(2);
}

/**
 * Chaîne canonique HORS clef secrète — la partie publique du calcul.
 *
 * Exposée à dessein : elle est reproduite telle quelle dans le QR code, ce qui
 * permet à un contrôleur de recomposer l'entrée du hash sans avoir accès au
 * secret, puis de demander la vérification à l'émetteur ou à la DGI.
 */
export function chaineCanonique(champs: ChampsHash): string {
  return [
    HASH_VERSION,
    numeroCanonique(champs.numero),
    dateCanonique(champs.date_facture),
    normaliserIdentifiant(champs.ice_vendeur),
    normaliserIdentifiant(champs.ice_acheteur),
    montantCanonique(champs.montant_ttc),
  ].join("|");
}

export interface OptionsHash {
  /**
   * `sha256` — empreinte de la chaîne canonique SUIVIE du secret. C'est la
   * composition décrite par le cahier des charges, et le défaut.
   *
   * `hmac-sha256` — construction cryptographique correcte pour authentifier
   * avec une clef. Le secret en suffixe n'est pas vulnérable à l'extension de
   * longueur (contrairement au secret en préfixe), donc le défaut reste sain ;
   * HMAC est offert pour les déploiements qui exigent une primitive normalisée.
   */
  algorithme?: AlgorithmeHash;
}

/**
 * Empreinte SHA-256 en hexadécimal minuscule (64 caractères).
 *
 * La clef secrète est OBLIGATOIRE et l'absence lève. Se rabattre sur une valeur
 * par défaut produirait des empreintes que n'importe qui pourrait recalculer :
 * le document paraîtrait scellé sans l'être, ce qui est pire que pas de sceau
 * du tout. Un incident passé sur ce projet — le mail d'approbation muet quand
 * `APPROVAL_TOKEN_SECRET` manquait — a montré le coût d'un repli silencieux.
 */
export function calculerHashFacture(
  champs: ChampsHash,
  clefSecrete: string,
  options: OptionsHash = {},
): string {
  if (!clefSecrete || String(clefSecrete).trim().length < 16) {
    throw new Error(
      "Clef secrète de facturation absente ou trop courte (16 caractères minimum) : " +
        "renseignez EFACTURE_SECRET_KEY. Sans elle, l'empreinte d'inaltérabilité n'a aucune valeur probante.",
    );
  }
  const base = chaineCanonique(champs);
  if (options.algorithme === "hmac-sha256") {
    return createHmac("sha256", clefSecrete).update(base, "utf8").digest("hex");
  }
  return createHash("sha256").update(`${base}|${clefSecrete}`, "utf8").digest("hex");
}

/**
 * Vérifie une empreinte. La comparaison est à temps constant : comparer deux
 * empreintes avec `===` laisse fuir, par la durée, le nombre de caractères de
 * tête corrects, ce qui permet de reconstruire une empreinte valide octet par
 * octet sur un point de vérification exposé.
 */
export function verifierHashFacture(
  champs: ChampsHash,
  clefSecrete: string,
  empreinteAttendue: string,
  options: OptionsHash = {},
): boolean {
  const attendue = String(empreinteAttendue ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(attendue)) return false;
  const calculee = calculerHashFacture(champs, clefSecrete, options);
  return timingSafeEqual(Buffer.from(calculee, "hex"), Buffer.from(attendue, "hex"));
}

/**
 * Lit la clef secrète depuis l'environnement serveur.
 * Isolé ici pour que les modules purs ne touchent jamais `process.env`.
 */
export function clefSecreteFacturation(): string {
  const clef = process.env.EFACTURE_SECRET_KEY ?? process.env.APPROVAL_TOKEN_SECRET ?? "";
  if (!clef) {
    throw new Error(
      "EFACTURE_SECRET_KEY n'est pas définie. Ajoutez-la au .env local ET aux variables Railway : " +
        "une empreinte calculée avec une clef différente d'un environnement à l'autre ne se vérifie plus.",
    );
  }
  return clef;
}
