/**
 * image-optimize — allègement du PAYLOAD OCR côté navigateur.
 *
 * Pourquoi : une photo de facture prise au téléphone pèse 3–6 Mo ; encodée en
 * base64 dans le POST de la server fn `ocrFacture`, elle gonfle encore de ~33 %.
 * En local la latence est invisible (loopback), en prod (Railway) l'upload seul
 * coûte plusieurs secondes AVANT que le moindre appel IA ne démarre.
 * On redimensionne donc à 1800 px max et on ré-encode en JPEG 85 % : une facture
 * A4 reste largement au-dessus du seuil de lisibilité de l'OCR (~150 dpi) pour
 * un payload qui tombe sous les 500 Ko.
 *
 * Garde-fous (cf. l'échec du « pré-traitement scan OCR » : le rehaussement
 * grayscale/autolevels avait DÉGRADÉ l'extraction) — ici on ne touche pas aux
 * pixels autrement qu'en échelle :
 *   • jamais d'agrandissement : une petite image est renvoyée telle quelle ;
 *   • pas de niveaux, pas de N&B, pas de netteté — seulement échelle + JPEG ;
 *   • orientation EXIF respectée (photo de téléphone = souvent rotation 6/8) ;
 *   • si le ré-encodage ne fait pas gagner de place, on garde l'original ;
 *   • tout échec (canvas indisponible, décodage KO) retombe sur l'original.
 *
 * Le fichier ORIGINAL n'est jamais modifié : il continue d'être archivé tel quel
 * dans le bucket `factures-originales` (seul le payload envoyé à l'IA est allégé).
 */

/** Côté le plus long autorisé pour le payload OCR, en pixels. */
export const OCR_MAX_DIMENSION = 1800;

/** Qualité JPEG du ré-encodage (0–1). */
export const OCR_JPEG_QUALITY = 0.85;

/**
 * En dessous de ce poids, on n'optimise pas : le gain réseau serait marginal et
 * une recompression JPEG d'un document déjà propre n'ajoute que des artefacts.
 */
export const OCR_SEUIL_OPTIMISATION_OCTETS = 400 * 1024;

/** Types d'images que l'on sait décoder puis ré-encoder sans risque. */
const TYPES_OPTIMISABLES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

export type PayloadOcrImage = {
  /** Base64 SANS préfixe data-URI (format attendu par `ocrFacture`). */
  base64: string;
  /** MIME à transmettre : devient "image/jpeg" si l'image a été ré-encodée. */
  mimeType: string;
  /** Poids des octets binaires réellement envoyés (avant gonflement base64). */
  octets: number;
  /** Poids d'origine, pour journaliser le gain. */
  octetsOrigine: number;
  /** false = l'original a été renvoyé intact (trop petit, ou gain nul). */
  optimise: boolean;
};

// ─── Décisions pures (testables sans DOM) ────────────────────────────────────

/**
 * Dimensions cibles en préservant le ratio. N'agrandit JAMAIS : une image déjà
 * plus petite que `max` est renvoyée à l'identique (`redimensionne: false`).
 */
export function calculerDimensionsCible(
  largeur: number,
  hauteur: number,
  max: number = OCR_MAX_DIMENSION,
): { largeur: number; hauteur: number; redimensionne: boolean } {
  if (!Number.isFinite(largeur) || !Number.isFinite(hauteur) || largeur <= 0 || hauteur <= 0) {
    return { largeur, hauteur, redimensionne: false };
  }
  const cote = Math.max(largeur, hauteur);
  if (cote <= max) return { largeur, hauteur, redimensionne: false };
  const ratio = max / cote;
  return {
    // `round` + plancher à 1 px : une bande très fine ne doit pas tomber à 0.
    largeur: Math.max(1, Math.round(largeur * ratio)),
    hauteur: Math.max(1, Math.round(hauteur * ratio)),
    redimensionne: true,
  };
}

/**
 * Faut-il tenter l'optimisation ? Uniquement pour une image bitmap connue et
 * assez lourde pour que le gain réseau dépasse le coût de la recompression.
 */
export function doitOptimiser(
  fichier: { type?: string; size?: number },
  seuil: number = OCR_SEUIL_OPTIMISATION_OCTETS,
): boolean {
  const type = (fichier.type ?? "").toLowerCase();
  if (!TYPES_OPTIMISABLES.has(type)) return false;
  return (fichier.size ?? 0) > seuil;
}

/** Base64 par blocs : `String.fromCharCode(...)` sur un Mo entier explose la pile. */
export function octetsVersBase64(octets: Uint8Array): string {
  let binaire = "";
  const BLOC = 0x8000; // 32 Ko : sous la limite d'arguments de fromCharCode
  for (let i = 0; i < octets.length; i += BLOC) {
    binaire += String.fromCharCode(...octets.subarray(i, i + BLOC));
  }
  return btoa(binaire);
}

// ─── Chemin navigateur ───────────────────────────────────────────────────────

/** Décodage en respectant l'orientation EXIF (sinon la facture part de travers). */
async function decoder(fichier: Blob): Promise<{ source: CanvasImageSource; largeur: number; hauteur: number; liberer: () => void }> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(fichier, { imageOrientation: "from-image" });
    return { source: bitmap, largeur: bitmap.width, hauteur: bitmap.height, liberer: () => bitmap.close() };
  }
  // Repli <img> : les navigateurs modernes appliquent l'EXIF au rendu par défaut.
  const url = URL.createObjectURL(fichier);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Décodage image impossible"));
      el.src = url;
    });
    return {
      source: img,
      largeur: img.naturalWidth,
      hauteur: img.naturalHeight,
      liberer: () => URL.revokeObjectURL(url),
    };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

/** `toBlob` (asynchrone, n'immobilise pas le thread UI) avec repli `toDataURL`. */
function encoderJpeg(canvas: HTMLCanvasElement, qualite: number): Promise<Blob | null> {
  if (typeof canvas.toBlob === "function") {
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", qualite));
  }
  try {
    const dataUrl = canvas.toDataURL("image/jpeg", qualite);
    const binaire = atob(dataUrl.split(",")[1] ?? "");
    const octets = new Uint8Array(binaire.length);
    for (let i = 0; i < binaire.length; i++) octets[i] = binaire.charCodeAt(i);
    return Promise.resolve(new Blob([octets], { type: "image/jpeg" }));
  } catch {
    return Promise.resolve(null);
  }
}

/** Renvoie le fichier tel quel, encodé en base64. */
async function payloadOriginal(fichier: File | Blob, mimeType: string): Promise<PayloadOcrImage> {
  const octets = new Uint8Array(await fichier.arrayBuffer());
  return {
    base64: octetsVersBase64(octets),
    mimeType,
    octets: octets.length,
    octetsOrigine: octets.length,
    optimise: false,
  };
}

/**
 * Prépare une image pour l'OCR : redimensionnement à 1800 px max + JPEG 85 %.
 *
 * Ne lève jamais pour une raison d'optimisation : en cas de souci on retombe
 * sur les octets d'origine (le scan doit marcher, même dégradé côté réseau).
 * À n'appeler que pour un fichier IMAGE — le flux PDF reste inchangé.
 */
export async function preparerImagePourOcr(
  fichier: File,
  options: { maxDimension?: number; qualite?: number; seuil?: number } = {},
): Promise<PayloadOcrImage> {
  const mimeOrigine = fichier.type || "image/jpeg";
  const max = options.maxDimension ?? OCR_MAX_DIMENSION;
  const qualite = options.qualite ?? OCR_JPEG_QUALITY;

  if (typeof document === "undefined" || !doitOptimiser(fichier, options.seuil)) {
    return payloadOriginal(fichier, mimeOrigine);
  }

  let liberer = () => {};
  try {
    const decode = await decoder(fichier);
    liberer = decode.liberer;
    const cible = calculerDimensionsCible(decode.largeur, decode.hauteur, max);

    const canvas = document.createElement("canvas");
    canvas.width = cible.largeur;
    canvas.height = cible.hauteur;
    const ctx = canvas.getContext("2d");
    if (!ctx) return await payloadOriginal(fichier, mimeOrigine);

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    // Fond blanc : un PNG à fond transparent virerait au NOIR en JPEG.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, cible.largeur, cible.hauteur);
    ctx.drawImage(decode.source, 0, 0, cible.largeur, cible.hauteur);

    const blob = await encoderJpeg(canvas, qualite);
    // Ré-encodage plus lourd que l'original (PNG texte très compressible, etc.)
    // → aucun intérêt à dégrader l'image pour rien.
    if (!blob || blob.size >= fichier.size) return await payloadOriginal(fichier, mimeOrigine);

    const octets = new Uint8Array(await blob.arrayBuffer());
    return {
      base64: octetsVersBase64(octets),
      mimeType: "image/jpeg",
      octets: octets.length,
      octetsOrigine: fichier.size,
      optimise: true,
    };
  } catch (e) {
    console.warn("[ocr] optimisation image ignorée:", e);
    return payloadOriginal(fichier, mimeOrigine);
  } finally {
    liberer();
  }
}

/** Journal une ligne : « 4.2 Mo → 320 Ko (-92 %) ». */
export function journaliserPayload(contexte: string, p: PayloadOcrImage): void {
  const ko = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} Mo` : `${Math.round(n / 1024)} Ko`);
  if (!p.optimise) {
    console.log(`[ocr] ${contexte}: payload ${ko(p.octets)} (original conservé)`);
    return;
  }
  const gain = Math.round((1 - p.octets / Math.max(1, p.octetsOrigine)) * 100);
  console.log(`[ocr] ${contexte}: ${ko(p.octetsOrigine)} → ${ko(p.octets)} (-${gain} %)`);
}
