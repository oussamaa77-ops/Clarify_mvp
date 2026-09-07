// ============================================================================
// icc-srgb.ts — profil ICC sRGB construit par le code.
//
// ─── Pourquoi ce fichier existe ──────────────────────────────────────────────
// Un PDF/A doit déclarer un `OutputIntent` : la description du dispositif de
// sortie pour lequel ses couleurs ont été définies. Sans lui, le fichier n'est
// PAS conforme — c'est un manquement bloquant, pas un avertissement. Et cet
// OutputIntent doit embarquer un profil ICC complet, car le principe même du
// PDF/A est qu'un fichier archivé se rende identiquement dans dix ans, sans
// dépendre de ressources extérieures.
//
// ─── Pourquoi le CONSTRUIRE plutôt que livrer un .icc ────────────────────────
// Les profils sRGB distribués (celui de l'ICC, celui d'Adobe) traînent chacun
// leur licence de redistribution, et un binaire de 3 à 60 Ko déposé dans un
// dépôt Git est un objet que personne ne relit ni ne sait régénérer. Le format
// ICC v2 étant entièrement spécifié, on écrit ici les quelques centaines
// d'octets nécessaires : le résultat est lisible, versionnable en diff, et sans
// question de licence.
//
// ─── Ce que ce profil est, et n'est pas ──────────────────────────────────────
// C'est un profil d'affichage RGB matriciel valide, aux primaires et au point
// blanc de sRGB (adaptés D50, comme l'exige l'espace de connexion ICC), avec
// une fonction de transfert en gamma 2,2.
//
// Ce n'est PAS une copie octet pour octet de « sRGB IEC61966-2.1 » : la vraie
// courbe sRGB est une parabole avec un segment linéaire près du noir, que le
// gamma 2,2 approche à moins de 1 % sur l'essentiel de la plage. Sur une
// facture — du texte noir, un QR noir, quelques filets gris — l'écart est
// invisible. Si un jour une validation exige le profil canonique au bit près,
// il suffira de passer ses octets à `construirePdfA3` : le point d'entrée est
// prévu pour.
// ============================================================================

/** Signature ICC d'une chaîne de 4 caractères. */
function signature(texte: string): number {
  return (
    (texte.charCodeAt(0) << 24) | (texte.charCodeAt(1) << 16) | (texte.charCodeAt(2) << 8) | texte.charCodeAt(3)
  ) >>> 0;
}

/** Encode un réel en s15Fixed16Number (entier signé 32 bits, 16 bits de partie fractionnaire). */
function s15Fixed16(valeur: number): number {
  return Math.round(valeur * 65536);
}

/** Primaires sRGB et point blanc, ADAPTÉS D50 — l'espace de connexion ICC est
 *  en D50, pas en D65. Utiliser les valeurs D65 brutes donnerait un profil
 *  cohérent en apparence mais faussé de plusieurs pour cent. */
const COLORANTS = {
  rouge: [0.4360, 0.2225, 0.0139],
  vert: [0.3851, 0.7169, 0.0971],
  bleu: [0.1431, 0.0606, 0.7139],
  blanc: [0.9642, 1.0, 0.8249],
} as const;

const GAMMA = 2.2;

/** Bloc de données d'un tag, avec sa signature. */
interface Tag {
  sig: string;
  data: Uint8Array;
}

function ecrireUint32(vue: DataView, offset: number, valeur: number): void {
  vue.setUint32(offset, valeur >>> 0, false); // ICC est big-endian de bout en bout
}

/** `XYZType` : signature + réservé + trois s15Fixed16. */
function tagXyz(sig: string, [x, y, z]: readonly number[]): Tag {
  const data = new Uint8Array(20);
  const vue = new DataView(data.buffer);
  ecrireUint32(vue, 0, signature("XYZ "));
  ecrireUint32(vue, 4, 0);
  vue.setInt32(8, s15Fixed16(x), false);
  vue.setInt32(12, s15Fixed16(y), false);
  vue.setInt32(16, s15Fixed16(z), false);
  return { sig, data };
}

/** `curveType` à un seul point de contrôle : le gamma, en u8Fixed8. */
function tagCourbe(sig: string, gamma: number): Tag {
  const data = new Uint8Array(14);
  const vue = new DataView(data.buffer);
  ecrireUint32(vue, 0, signature("curv"));
  ecrireUint32(vue, 4, 0);
  ecrireUint32(vue, 8, 1); // un point → interprété comme un gamma
  vue.setUint16(12, Math.round(gamma * 256), false);
  return { sig, data };
}

/**
 * `textDescriptionType` — le type de description propre à ICC v2. Sa structure
 * est verbeuse (ASCII, puis Unicode, puis ScriptCode Macintosh) et les trois
 * parties sont obligatoires même vides : un lecteur strict rejette le profil si
 * les 67 octets de la description Macintosh manquent.
 */
function tagDescription(sig: string, texte: string): Tag {
  const ascii = new TextEncoder().encode(texte);
  const longueurAscii = ascii.length + 1; // terminateur nul compris
  const total = 4 + 4 + 4 + longueurAscii + 4 + 4 + 2 + 1 + 67;
  const data = new Uint8Array(total);
  const vue = new DataView(data.buffer);
  let o = 0;
  ecrireUint32(vue, o, signature("desc"));
  o += 4;
  ecrireUint32(vue, o, 0);
  o += 4;
  ecrireUint32(vue, o, longueurAscii);
  o += 4;
  data.set(ascii, o);
  o += longueurAscii; // l'octet nul final est déjà à zéro
  ecrireUint32(vue, o, 0); // code de langue Unicode
  o += 4;
  ecrireUint32(vue, o, 0); // longueur Unicode
  o += 4;
  vue.setUint16(o, 0, false); // code ScriptCode
  o += 2;
  data[o] = 0; // longueur ScriptCode
  return { sig, data };
}

/** `textType` — chaîne ASCII terminée par un octet nul. */
function tagTexte(sig: string, texte: string): Tag {
  const ascii = new TextEncoder().encode(texte);
  const data = new Uint8Array(8 + ascii.length + 1);
  const vue = new DataView(data.buffer);
  ecrireUint32(vue, 0, signature("text"));
  ecrireUint32(vue, 4, 0);
  data.set(ascii, 8);
  return { sig, data };
}

/**
 * Assemble le profil complet : en-tête de 128 octets, table des tags, données.
 *
 * Les données de chaque tag sont alignées sur 4 octets. L'alignement n'est pas
 * décoratif : plusieurs lecteurs ICC lisent les entiers par mots de 32 bits et
 * rendent des valeurs fausses sur un tag mal aligné.
 */
export function construireProfilSrgb(): Uint8Array {
  const tags: Tag[] = [
    tagDescription("desc", "sRGB (profil matriciel gamma 2,2)"),
    tagXyz("wtpt", COLORANTS.blanc),
    tagXyz("rXYZ", COLORANTS.rouge),
    tagXyz("gXYZ", COLORANTS.vert),
    tagXyz("bXYZ", COLORANTS.bleu),
    tagCourbe("rTRC", GAMMA),
    tagCourbe("gTRC", GAMMA),
    tagCourbe("bTRC", GAMMA),
    tagTexte("cprt", "Profil generique, domaine public."),
  ];

  const tailleEnTete = 128;
  const tailleTable = 4 + tags.length * 12;
  let offset = tailleEnTete + tailleTable;
  const entrees = tags.map((tag) => {
    const debut = offset;
    offset += tag.data.length;
    // Rembourrage d'alignement sur 4 octets.
    offset += (4 - (offset % 4)) % 4;
    return { tag, debut };
  });

  const taille = offset;
  const profil = new Uint8Array(taille);
  const vue = new DataView(profil.buffer);

  // ─── En-tête (128 octets) ───────────────────────────────────────────────
  ecrireUint32(vue, 0, taille);
  ecrireUint32(vue, 4, 0); // CMM préféré : aucun
  ecrireUint32(vue, 8, 0x02100000); // version 2.1.0
  ecrireUint32(vue, 12, signature("mntr")); // classe : moniteur
  ecrireUint32(vue, 16, signature("RGB ")); // espace de données
  ecrireUint32(vue, 20, signature("XYZ ")); // espace de connexion
  // Date de création FIGÉE : un PDF/A doit être reproductible octet pour octet
  // à partir des mêmes entrées. Une horloge ici rendrait deux générations de la
  // même facture différentes, et l'empreinte du PDF invérifiable.
  vue.setUint16(24, 2026, false); // année
  vue.setUint16(26, 1, false); // mois
  vue.setUint16(28, 1, false); // jour
  vue.setUint16(30, 0, false);
  vue.setUint16(32, 0, false);
  vue.setUint16(34, 0, false);
  ecrireUint32(vue, 36, signature("acsp")); // signature de fichier ICC
  ecrireUint32(vue, 40, 0); // plateforme
  ecrireUint32(vue, 44, 0); // drapeaux : profil non incorporé, indépendant
  ecrireUint32(vue, 48, 0); // fabricant
  ecrireUint32(vue, 52, 0); // modèle
  ecrireUint32(vue, 56, 0); // attributs (8 octets)
  ecrireUint32(vue, 60, 0);
  ecrireUint32(vue, 64, 0); // intention de rendu : perceptuelle
  vue.setInt32(68, s15Fixed16(COLORANTS.blanc[0]), false); // illuminant D50
  vue.setInt32(72, s15Fixed16(COLORANTS.blanc[1]), false);
  vue.setInt32(76, s15Fixed16(COLORANTS.blanc[2]), false);
  ecrireUint32(vue, 80, 0); // créateur
  // Octets 84 à 127 : identifiant de profil et réservé, laissés à zéro.

  // ─── Table des tags ─────────────────────────────────────────────────────
  ecrireUint32(vue, tailleEnTete, tags.length);
  entrees.forEach(({ tag, debut }, i) => {
    const o = tailleEnTete + 4 + i * 12;
    ecrireUint32(vue, o, signature(tag.sig));
    ecrireUint32(vue, o + 4, debut);
    ecrireUint32(vue, o + 8, tag.data.length);
    profil.set(tag.data, debut);
  });

  return profil;
}

/** Nombre de composantes du profil — repris en `/N` dans le flux PDF. */
export const ICC_COMPOSANTES = 3;

/** Identifiant de condition de sortie déclaré dans l'OutputIntent. */
export const ICC_IDENTIFIANT = "sRGB";
