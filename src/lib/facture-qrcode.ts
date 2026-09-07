// ============================================================================
// facture-qrcode.ts — QR code fiscal apposé sur la facture.
//
// À quoi il sert concrètement : un agent muni d'un téléphone scanne le coin de
// la facture papier et lit, SANS accès à notre base, l'identité des deux
// parties, le montant, l'UUID attribué par la DGI et l'empreinte
// d'inaltérabilité. Il peut alors confronter ce qu'affiche la facture à ce que
// le sceau dit — un montant retouché sur le papier ne correspondra plus.
//
// ─── Pourquoi un format compact plutôt que du JSON ───────────────────────────
// Chaque caractère encodé fait grossir la matrice. Du JSON avec ses accolades,
// guillemets et noms de champs double la charge utile pour la même information,
// ce qui pousse le QR de la version 10 à la version 16 : plus de modules, des
// modules plus petits à surface égale, et un scan qui échoue sur une impression
// laser ordinaire ou une photocopie. Le format à séparateurs tient la charge
// sous ~200 caractères, soit une matrice qui reste lisible à 25 mm de côté.
// ============================================================================

import QRCode from "qrcode";
import { chaineCanonique, montantCanonique, type ChampsHash } from "./invoice-hash";

/** Version du format de charge utile, en tête pour que tout lecteur sache lire. */
export const QR_FORMAT_VERSION = "MA1";

export interface DonneesQrFacture extends ChampsHash {
  montant_tva: number;
  /** UUID attribué par la DGI ; vide tant que la facture n'est pas validée. */
  dgi_uuid?: string | null;
  /** Empreinte d'inaltérabilité, 64 hexadécimaux. */
  hash_sha256: string;
}

/**
 * Charge utile encodée dans la matrice.
 *
 * Champs, dans l'ordre :
 *   MA1 | numéro | date | ICE vendeur | ICE acheteur | TTC | TVA | UUID DGI | empreinte
 *
 * Les cinq premiers champs après l'en-tête sont EXACTEMENT ceux de la chaîne
 * canonique du hash : un vérificateur les recompose et retrouve l'entrée du
 * calcul sans rien deviner.
 */
export function construirePayloadQr(donnees: DonneesQrFacture): string {
  // On réutilise la chaîne canonique du hash plutôt que de reformater les mêmes
  // champs une seconde fois : deux formatages parallèles finissent toujours par
  // diverger, et le QR annoncerait alors des données qui ne sont pas celles qui
  // ont été hachées.
  const canonique = chaineCanonique(donnees);
  return [
    QR_FORMAT_VERSION,
    canonique,
    montantCanonique(donnees.montant_tva),
    donnees.dgi_uuid ?? "",
    String(donnees.hash_sha256 ?? "").toLowerCase(),
  ].join("|");
}

/** Relit une charge utile de QR code. Rend `null` si le format n'est pas reconnu. */
export function lirePayloadQr(payload: string): {
  numero: string;
  date_facture: string;
  ice_vendeur: string;
  ice_acheteur: string;
  montant_ttc: string;
  montant_tva: string;
  dgi_uuid: string;
  hash_sha256: string;
} | null {
  const parts = String(payload ?? "").split("|");
  // MA1 | HISAB-1 | numéro | date | iceV | iceA | ttc | tva | uuid | hash
  if (parts.length !== 10 || parts[0] !== QR_FORMAT_VERSION) return null;
  return {
    numero: parts[2],
    date_facture: parts[3],
    ice_vendeur: parts[4],
    ice_acheteur: parts[5],
    montant_ttc: parts[6],
    montant_tva: parts[7],
    dgi_uuid: parts[8],
    hash_sha256: parts[9],
  };
}

export interface OptionsQr {
  /**
   * Niveau de correction d'erreur. `M` (~15 %) est le compromis retenu : `L`
   * ne survit pas à une photocopie ou à un pli sur le coin de la feuille, `Q`
   * et `H` gonflent la matrice sans bénéfice sur un document qui, la plupart du
   * temps, est scanné une fois à l'écran.
   */
  correction?: "L" | "M" | "Q" | "H";
  /** Côté de l'image en pixels (PNG uniquement). */
  taille?: number;
  /** Marge en modules ; 1 suffit, la mise en page ajoute déjà du blanc autour. */
  marge?: number;
}

function optionsQrcode(options: OptionsQr) {
  return {
    errorCorrectionLevel: options.correction ?? ("M" as const),
    margin: options.marge ?? 1,
    width: options.taille ?? 256,
    color: { dark: "#000000ff", light: "#ffffffff" },
  };
}

/** QR code en SVG — pour l'affichage écran, où il reste net à toute échelle. */
export async function genererQrSvg(donnees: DonneesQrFacture, options: OptionsQr = {}): Promise<string> {
  return QRCode.toString(construirePayloadQr(donnees), { type: "svg", ...optionsQrcode(options) });
}

/** QR code en PNG (octets bruts) — c'est cette forme que le PDF embarque. */
export async function genererQrPng(donnees: DonneesQrFacture, options: OptionsQr = {}): Promise<Uint8Array> {
  const buffer = await QRCode.toBuffer(construirePayloadQr(donnees), { type: "png", ...optionsQrcode(options) });
  return new Uint8Array(buffer);
}

/** QR code en data URL PNG — pour un `<img src>` sans requête réseau. */
export async function genererQrDataUrl(donnees: DonneesQrFacture, options: OptionsQr = {}): Promise<string> {
  return QRCode.toDataURL(construirePayloadQr(donnees), { type: "image/png", ...optionsQrcode(options) });
}
