/**
 * bank-grayscale — conversion en niveaux de gris des images de relevés, DÉSACTIVÉE
 * par défaut, derrière un drapeau basculable à chaud.
 *
 * Objet de l'expérience : réduire le poids transféré à l'OCR sans toucher à la
 * résolution. Le gain attendu est modeste (la chrominance JPEG est déjà
 * sous-échantillonnée en 4:2:0), d'où la mesure A/B intégrée : on ne l'activera
 * durablement que si les octets économisés le justifient ET que l'extraction ne
 * régresse pas.
 *
 * PÉRIMÈTRE STRICT — uniquement la luminance :
 *   • aucune correction de contraste, de luminosité, de gamma, de netteté ;
 *   • aucune binarisation, aucun seuillage ;
 *   • dimensions et résolution rigoureusement inchangées ;
 *   • canal alpha préservé tel quel.
 * Ces exclusions ne sont pas cosmétiques : un rehaussement de contraste avait déjà
 * fait disparaître l'extraction sur les relevés imprimés en matriciel, dont les
 * chiffres sont pâles et fins. Toute évolution de ce fichier doit rester dans ce
 * périmètre.
 *
 * Drapeau OFF = le pipeline couleur d'origine, à l'octet près (aucun décodage,
 * aucun ré-encodage supplémentaire).
 */

/** Clé de bascule persistante (localStorage) — priorité sur le défaut de build. */
export const CLE_STOCKAGE_GRAYSCALE = "bank_grayscale";

/** Paramètre d'URL de bascule immédiate : ?grayscale=1 / ?grayscale=0 */
export const PARAM_URL_GRAYSCALE = "grayscale";

/**
 * Défaut de build : `VITE_ENABLE_BANK_GRAYSCALE=true` dans .env pour livrer le
 * mode gris par défaut. Absent ou différent de "true" → couleur (comportement
 * actuel). C'est bien un défaut, pas un verrou : les bascules à chaud priment.
 */
function defautBuild(): boolean {
  try {
    return String((import.meta as any)?.env?.VITE_ENABLE_BANK_GRAYSCALE ?? "").toLowerCase() === "true";
  } catch {
    return false;
  }
}

/**
 * Le drapeau est-il actif ? Résolution par priorité décroissante :
 *   1. `?grayscale=1|0` dans l'URL — bascule en un clic, sans rien réinstaller ;
 *   2. `localStorage.bank_grayscale` — persiste entre les rechargements ;
 *   3. `VITE_ENABLE_BANK_GRAYSCALE` — défaut de build (false).
 *
 * Lu à CHAQUE scan, jamais mis en cache dans un module : basculer puis relancer
 * un scan suffit, sans rebuild ni redémarrage du serveur.
 */
export function grayscaleActif(): boolean {
  if (typeof window === "undefined") return defautBuild();

  try {
    const param = new URLSearchParams(window.location.search).get(PARAM_URL_GRAYSCALE);
    if (param !== null) return param === "1" || param.toLowerCase() === "true";
  } catch { /* URL exotique : on passe à la source suivante */ }

  try {
    const stocke = window.localStorage?.getItem(CLE_STOCKAGE_GRAYSCALE);
    if (stocke !== null && stocke !== undefined) return stocke === "1" || stocke.toLowerCase() === "true";
  } catch { /* localStorage bloqué (navigation privée) : on passe au défaut */ }

  return defautBuild();
}

/** Bascule persistante ; `null` efface l'override et rend la main au défaut de build. */
export function basculerGrayscale(actif: boolean | null): void {
  if (typeof window === "undefined") return;
  try {
    if (actif === null) window.localStorage?.removeItem(CLE_STOCKAGE_GRAYSCALE);
    else window.localStorage?.setItem(CLE_STOCKAGE_GRAYSCALE, actif ? "1" : "0");
  } catch { /* stockage indisponible : la bascule par URL reste utilisable */ }
}

/**
 * Luminance Rec. 709 — la pondération perceptuelle standard (le vert porte
 * l'essentiel de la luminance perçue, le bleu presque rien).
 * Aucune correction de gamma : on reste dans l'espace de l'image source.
 */
export function luminance709(r: number, g: number, b: number): number {
  return Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
}

/**
 * Convertit un buffer RGBA en gris, SUR PLACE.
 *
 * Chaque pixel devient (Y, Y, Y, alpha inchangé). Aucune valeur n'est étirée,
 * seuillée ni saturée : la dynamique d'origine est conservée telle quelle, ce qui
 * est précisément ce qui rend l'opération sans danger pour des chiffres pâles.
 */
export function convertirPixelsEnGris(donnees: Uint8ClampedArray | number[]): void {
  for (let i = 0; i < donnees.length; i += 4) {
    const y = luminance709(donnees[i], donnees[i + 1], donnees[i + 2]);
    donnees[i] = y;
    donnees[i + 1] = y;
    donnees[i + 2] = y;
    // donnees[i + 3] (alpha) volontairement intact.
  }
}

/** Poids réel des octets encodés derrière une chaîne base64 (padding compris). */
export function octetsDepuisBase64(base64: string): number {
  if (!base64) return 0;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

export type MesureGrayscale = {
  actif: boolean;
  /** Poids de la variante couleur (toujours mesuré : c'est la référence A/B). */
  octetsCouleur: number;
  /** Poids de la variante gris — null quand le drapeau est OFF. */
  octetsGris: number | null;
  /** Réduction en % (positive = gain) — null quand le drapeau est OFF. */
  reductionPct: number | null;
  /** Durée de la conversion des pixels seule, en ms. */
  msConversion: number;
  /** Durée d'encodage JPEG de chaque variante, en ms. */
  msEncodageCouleur: number;
  msEncodageGris: number | null;
};

function maintenant(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * Encode un canvas pour l'OCR en appliquant le drapeau, et renvoie la mesure A/B.
 *
 * Drapeau OFF → un seul encodage, strictement identique au code d'origine.
 * Drapeau ON  → encode AUSSI la variante couleur, pour disposer de la référence
 *               de poids sur la même image ; c'est le coût assumé de la mesure,
 *               et il disparaît en repassant le drapeau à OFF.
 *
 * Les dimensions du canvas ne sont jamais modifiées.
 */
export function encoderCanvasPourOcr(
  canvas: HTMLCanvasElement,
  qualite: number,
): { base64: string; mesure: MesureGrayscale } {
  const t0 = maintenant();
  const base64Couleur = canvas.toDataURL("image/jpeg", qualite).split(",")[1] ?? "";
  const msEncodageCouleur = maintenant() - t0;
  const octetsCouleur = octetsDepuisBase64(base64Couleur);

  if (!grayscaleActif()) {
    return {
      base64: base64Couleur,
      mesure: {
        actif: false, octetsCouleur, octetsGris: null, reductionPct: null,
        msConversion: 0, msEncodageCouleur, msEncodageGris: null,
      },
    };
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    // Sans contexte 2D on ne peut pas convertir : on renvoie la couleur plutôt
    // que d'échouer — le scan prime sur l'expérience de mesure.
    return {
      base64: base64Couleur,
      mesure: {
        actif: false, octetsCouleur, octetsGris: null, reductionPct: null,
        msConversion: 0, msEncodageCouleur, msEncodageGris: null,
      },
    };
  }

  const t1 = maintenant();
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  convertirPixelsEnGris(image.data);
  ctx.putImageData(image, 0, 0);
  const msConversion = maintenant() - t1;

  const t2 = maintenant();
  const base64Gris = canvas.toDataURL("image/jpeg", qualite).split(",")[1] ?? "";
  const msEncodageGris = maintenant() - t2;
  const octetsGris = octetsDepuisBase64(base64Gris);

  return {
    base64: base64Gris,
    mesure: {
      actif: true, octetsCouleur, octetsGris,
      reductionPct: octetsCouleur > 0 ? ((octetsCouleur - octetsGris) / octetsCouleur) * 100 : null,
      msConversion, msEncodageCouleur, msEncodageGris,
    },
  };
}

/**
 * Prépare une image de relevé téléversée directement (JPEG/PNG, pas un PDF).
 *
 * Drapeau OFF → les octets d'origine sont transmis tels quels, SANS décodage ni
 * ré-encodage : c'est exactement le comportement actuel.
 * Drapeau ON  → l'image est décodée à sa taille NATURELLE (aucun redimensionnement),
 * convertie en gris, puis ré-encodée en JPEG.
 *
 * À noter pour l'analyse A/B : dans le mode ON, l'image subit une génération
 * d'encodage supplémentaire que le mode OFF n'a pas. Les deux poids rapportés
 * (`octetsCouleur` / `octetsGris`) sont en revanche issus du MÊME canvas, donc
 * directement comparables entre eux — c'est bien le gain du gris qu'ils mesurent,
 * pas celui du ré-encodage.
 */
export async function preparerImageBanquePourOcr(
  fichier: File,
  qualite = 0.95,
): Promise<{ base64: string; mimeType: string; mesure: MesureGrayscale }> {
  const { octetsVersBase64 } = await import("./image-optimize");

  const brut = async (): Promise<{ base64: string; mimeType: string; mesure: MesureGrayscale }> => {
    const octets = new Uint8Array(await fichier.arrayBuffer());
    return {
      base64: octetsVersBase64(octets),
      mimeType: fichier.type || "image/jpeg",
      mesure: {
        actif: false, octetsCouleur: octets.length, octetsGris: null, reductionPct: null,
        msConversion: 0, msEncodageCouleur: 0, msEncodageGris: null,
      },
    };
  };

  if (typeof document === "undefined" || typeof createImageBitmap !== "function" || !grayscaleActif()) {
    return brut();
  }

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(fichier, { imageOrientation: "from-image" });
    const canvas = document.createElement("canvas");
    // Dimensions NATURELLES : aucune réduction de résolution.
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return await brut();
    ctx.drawImage(bitmap, 0, 0);

    const { base64, mesure } = encoderCanvasPourOcr(canvas, qualite);
    return { base64, mimeType: "image/jpeg", mesure };
  } catch (e) {
    console.warn("[BANQUE A/B] conversion gris ignorée:", e);
    return brut();
  } finally {
    bitmap?.close();
  }
}

/** Agrège plusieurs mesures (une par page/moitié) en une seule ligne de log. */
export function cumulerMesures(mesures: readonly MesureGrayscale[]): MesureGrayscale | null {
  if (mesures.length === 0) return null;
  const actif = mesures.some((m) => m.actif);
  const octetsCouleur = mesures.reduce((s, m) => s + m.octetsCouleur, 0);
  const octetsGris = actif ? mesures.reduce((s, m) => s + (m.octetsGris ?? m.octetsCouleur), 0) : null;
  return {
    actif,
    octetsCouleur,
    octetsGris,
    reductionPct: actif && octetsCouleur > 0 && octetsGris !== null
      ? ((octetsCouleur - octetsGris) / octetsCouleur) * 100
      : null,
    msConversion: mesures.reduce((s, m) => s + m.msConversion, 0),
    msEncodageCouleur: mesures.reduce((s, m) => s + m.msEncodageCouleur, 0),
    msEncodageGris: actif ? mesures.reduce((s, m) => s + (m.msEncodageGris ?? 0), 0) : null,
  };
}

/** Ligne de log A/B, volontairement explicite sur le mode en cours. */
export function journaliserMesure(contexte: string, m: MesureGrayscale | null): void {
  if (!m) return;
  const ko = (n: number) => `${Math.round(n / 1024)} Ko`;
  if (!m.actif) {
    console.log(
      `[BANQUE A/B] ${contexte} | mode COULEUR (drapeau OFF) | ${ko(m.octetsCouleur)} | encodage ${m.msEncodageCouleur.toFixed(0)} ms`,
    );
    return;
  }
  console.log(
    `[BANQUE A/B] ${contexte} | mode GRIS (drapeau ON) | couleur ${ko(m.octetsCouleur)} → gris ${ko(m.octetsGris ?? 0)} ` +
      `(${(m.reductionPct ?? 0).toFixed(1)} % de gain) | conversion ${m.msConversion.toFixed(0)} ms | ` +
      `encodage ${m.msEncodageCouleur.toFixed(0)} ms (couleur, mesure) + ${(m.msEncodageGris ?? 0).toFixed(0)} ms (gris, envoyé)`,
  );
}
