// ============================================================================
// ubl-invoice.ts — construction du document UBL 2.1 d'une facture.
//
// UBL (Universal Business Language, OASIS) est le format d'échange retenu par
// la DGI comme par PEPPOL. Le document produit ici est celui qui est TRANSMIS,
// HACHÉ, et embarqué dans le PDF/A-3 : c'est la pièce juridique, pas une
// représentation d'agrément. D'où trois exigences que ce module tient :
//
//   1. ORDRE DES ÉLÉMENTS. Le XSD d'UBL déclare des `xsd:sequence`, pas des
//      `xsd:all` : un `cbc:ID` placé après `cbc:IssueDate` rend le document
//      invalide alors qu'il « contient tout ». Les blocs ci-dessous suivent
//      l'ordre normatif ; ne pas les réordonner par confort de lecture.
//
//   2. VENTILATION PAR TAUX. Les cinq taux marocains (0, 7, 10, 14, 20 %) ne
//      peuvent pas être agrégés en un seul `TaxSubtotal` : le contrôle DGI
//      recalcule la taxe taux par taux. Une facture qui mélange du 20 % et du
//      7 % en une seule base est rejetée même si le total est juste.
//
//   3. ARRONDI AU NIVEAU DU TAUX, pas de la ligne. La TVA due sur un taux vaut
//      `arrondi(base_du_taux × taux)`, et non la somme des TVA de chaque ligne
//      arrondies : sur dix lignes, les deux méthodes divergent d'un centime ou
//      deux, et cet écart suffit à faire échouer le contrôle HT + TVA = TTC.
//
// ─── Trois exigences propres au profil DGI marocain ─────────────────────────
//
//   A. VENTILATION TVA À LA RACINE. Le `cac:TaxTotal` du document porte, pour
//      chaque taux, un `cac:TaxSubtotal` complet : base imposable, montant de
//      taxe, taux, et code du régime. Le contrôle DGI recalcule taux par taux
//      À CE NIVEAU — les sous-totaux portés par les lignes ne lui suffisent pas.
//
//   B. IDENTIFIANTS LÉGAUX DE L'ÉMETTEUR (CGI art. 145). La facture doit porter
//      l'IF et le RC du vendeur en clair, sous `cac:PartyIdentification`.
//      L'IF reste PAR AILLEURS en `PartyTaxScheme`, où la plateforme cherche
//      l'identifiant d'assujetti : les deux emplacements répondent à deux
//      questions différentes, l'un ne remplace pas l'autre.
//
//   C. MÉTADONNÉES DE SCELLEMENT. Récépissé DGI et empreinte SHA-256 voyagent
//      en `ext:UBLExtensions`, PREMIER enfant de `Invoice`. Ils restent aussi en
//      `AdditionalDocumentReference` : l'extension est ce que lit la plateforme,
//      la référence documentaire ce que lit un contrôleur — et les retirer
//      désynchroniserait les QR codes déjà imprimés.
//
// Module PUR : ni base, ni framework, ni horloge. Il se teste et se rejoue à
// l'identique — condition pour que le hash d'inaltérabilité soit reproductible.
// ============================================================================

import { MODE_PAIEMENT_LABEL, normaliserMode, type ModePaiement } from "./mode-paiement";
import { TVA_RATES_MA } from "./tva";

export type TypeDocumentFiscal = "facture" | "avoir" | "acompte" | "solde" | "proforma";

/**
 * Code porté par `cac:TaxScheme/cbc:ID`.
 *
 * Le profil DGI marocain attend « TVA ». Ce n'est PAS le code UNCL5153, qui vaut
 * « VAT » et que réclame la validation sémantique PEPPOL : les deux référentiels
 * divergent sur ce point précis et aucune valeur ne satisfait les deux. Le
 * défaut suit la DGI — c'est elle qui reçoit nos factures ;
 * `OptionsUbl.taxSchemeId` permet de repasser en « VAT » pour soumettre un
 * document au validateur PEPPOL en diagnostic (cf. dgi_validator.ts).
 */
export const DGI_TAX_SCHEME_ID = "TVA";

/** Code UNCL5153, attendu par le validateur PEPPOL. */
export const PEPPOL_TAX_SCHEME_ID = "VAT";

/** Espace de noms UBL des extensions (préfixe `ext:`). */
export const UBL_EXT_NAMESPACE =
  "urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2";

/** Espace de noms du bloc de scellement, qui sert aussi d'`ExtensionURI`. */
export const DGI_SCELLEMENT_NAMESPACE = "urn:dgi.gov.ma:einvoice:scellement:1.0";

export interface LigneUbl {
  designation: string;
  quantite: number;
  /** Prix unitaire HORS TAXE — source de vérité interne du modèle. */
  prix_unitaire: number;
  taux_tva: number | null;
  /** Code d'unité UN/ECE Rec. 20 ; C62 = unité indifférenciée. */
  unite?: string;
  /** Motif d'exonération, obligatoire en UBL dès que le taux est à 0. */
  motif_exoneration?: string | null;
}

export interface PartieUbl {
  nom: string;
  ice?: string | null;
  if_fiscal?: string | null;
  rc?: string | null;
  patente?: string | null;
  adresse?: string | null;
  ville?: string | null;
  code_postal?: string | null;
  /** Code pays ISO 3166-1 alpha-2 ; MA par défaut. */
  pays?: string | null;
  email?: string | null;
  telephone?: string | null;
}

export interface FactureUbl {
  numero: string;
  /** Date d'émission au format ISO `YYYY-MM-DD`. */
  date_facture: string;
  date_echeance?: string | null;
  type?: TypeDocumentFiscal;
  devise?: string;
  lignes: LigneUbl[];
  vendeur: PartieUbl;
  acheteur: PartieUbl;
  notes?: string | null;
  /** Empreinte d'inaltérabilité, reportée en référence documentaire. */
  hash_sha256?: string | null;
  /** UUID DGI, présent seulement une fois la facture validée. */
  dgi_uuid?: string | null;
  /** Numéro de la facture rectifiée — obligatoire sur un avoir. */
  facture_origine?: string | null;
  /**
   * Mode de règlement, dans le vocabulaire de l'application
   * (`factures.mode_reglement` : « virement », « cheque », « especes »,
   * « traite »…). Traduit en code UNCL4461 par `codePaiementUbl` ; absent ou non
   * reconnu, le document déclare le virement (cf. `MODE_PAIEMENT_UBL_DEFAUT`).
   */
  mode_reglement?: string | null;
}

/** Une ligne de la ventilation TVA : un taux, sa base, sa taxe. */
export interface VentilationTva {
  taux: number;
  base_ht: number;
  montant_tva: number;
  /** Code UNCL5305 : S = taux normal, Z = taux zéro, E = exonéré. */
  categorie: "S" | "Z" | "E";
  motif_exoneration?: string | null;
}

export interface TotauxFacture {
  total_ht: number;
  total_tva: number;
  total_ttc: number;
  ventilation: VentilationTva[];
}

/** Arrondi comptable au centime, en évitant la dérive binaire de `Math.round`. */
function round2(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function montant(n: number): string {
  // `-0` existe en IEEE 754 et se sérialise en « -0.00 », que les validateurs
  // XSD refusent sur un montant positif : on le ramène à 0.
  const v = round2(n);
  return (Object.is(v, -0) ? 0 : v).toFixed(2);
}

/**
 * Normalise un taux vers la grille marocaine. Un taux hors grille (saisie
 * libre, OCR fantaisiste) n'est PAS silencieusement ramené à 20 % : il est
 * conservé tel quel et remontera au contrôle de cohérence. Écraser un taux
 * inconnu fabriquerait une facture fausse mais d'apparence conforme.
 */
export function tauxNormalise(taux: number | null | undefined): number {
  const t = Number(taux);
  return Number.isFinite(t) && t > 0 ? t : 0;
}

/** Vrai si le taux appartient à la grille marocaine officielle. */
export function tauxReconnu(taux: number): boolean {
  return (TVA_RATES_MA as readonly number[]).includes(taux);
}

/** Base HT d'une ligne : quantité × prix unitaire HT, arrondie au centime. */
export function baseLigne(ligne: LigneUbl): number {
  return round2((Number(ligne.quantite) || 0) * (Number(ligne.prix_unitaire) || 0));
}

/**
 * Regroupe les lignes par taux et calcule la taxe de chaque groupe.
 *
 * Ordre de sortie : taux CROISSANT. Un ordre stable n'est pas un détail — le
 * XML entre dans le hash d'inaltérabilité, et un regroupement dont l'ordre
 * suivrait celui des lignes produirait deux empreintes différentes pour la
 * même facture selon la saisie.
 */
export function ventilerParTaux(lignes: LigneUbl[]): VentilationTva[] {
  const parTaux = new Map<number, { base: number; motif?: string | null }>();

  for (const ligne of lignes) {
    const taux = tauxNormalise(ligne.taux_tva);
    const courant = parTaux.get(taux) ?? { base: 0, motif: null };
    courant.base = round2(courant.base + baseLigne(ligne));
    if (!courant.motif && ligne.motif_exoneration) courant.motif = ligne.motif_exoneration;
    parTaux.set(taux, courant);
  }

  return [...parTaux.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([taux, { base, motif }]) => ({
      taux,
      base_ht: base,
      // Arrondi UNE fois, sur la base agrégée du taux (cf. en-tête du module).
      montant_tva: round2((base * taux) / 100),
      categorie: taux > 0 ? ("S" as const) : ("Z" as const),
      motif_exoneration: taux === 0 ? (motif ?? "Opération non soumise à la TVA") : null,
    }));
}

/**
 * Totaux de la facture, DÉRIVÉS des lignes. Le total TTC vaut HT + TVA par
 * construction : c'est la seule façon de garantir l'identité que la DGI
 * recalcule, plutôt que de faire confiance à trois nombres stockés séparément
 * qui ont pu diverger au fil des modifications.
 */
export function totauxFacture(lignes: LigneUbl[]): TotauxFacture {
  const ventilation = ventilerParTaux(lignes);
  const total_ht = round2(ventilation.reduce((s, v) => s + v.base_ht, 0));
  const total_tva = round2(ventilation.reduce((s, v) => s + v.montant_tva, 0));
  return { total_ht, total_tva, total_ttc: round2(total_ht + total_tva), ventilation };
}

export interface EcartTotaux {
  champ: "total_ht" | "total_tva" | "total_ttc" | "identite";
  calcule: number;
  declare: number;
  ecart: number;
}

/**
 * Compare les totaux DÉCLARÉS (ceux stockés sur la facture) aux totaux
 * RECALCULÉS depuis les lignes, et vérifie l'identité HT + TVA = TTC.
 *
 * Tolérance à 1 centime : les factures reprises par OCR portent des totaux
 * saisis par le fournisseur, arrondis selon sa propre convention. Au-delà, ce
 * n'est plus un arrondi mais une incohérence — exactement le motif de rejet
 * n° 1 côté DGI, et le seul qu'on puisse détecter avant l'envoi.
 */
export function controlerTotaux(
  lignes: LigneUbl[],
  declares: { total_ht: number; total_tva: number; total_ttc: number },
  tolerance = 0.01,
): { coherent: boolean; ecarts: EcartTotaux[]; calcules: TotauxFacture } {
  const calcules = totauxFacture(lignes);
  const ecarts: EcartTotaux[] = [];

  const comparer = (champ: EcartTotaux["champ"], calcule: number, declare: number) => {
    const ecart = round2(calcule - declare);
    if (Math.abs(ecart) > tolerance) ecarts.push({ champ, calcule, declare, ecart });
  };

  comparer("total_ht", calcules.total_ht, round2(declares.total_ht));
  comparer("total_tva", calcules.total_tva, round2(declares.total_tva));
  comparer("total_ttc", calcules.total_ttc, round2(declares.total_ttc));

  // Contrôle indépendant des lignes : même sans lignes détaillées (facture
  // saisie en global), l'identité doit tenir sur les montants déclarés.
  const identite = round2(round2(declares.total_ht) + round2(declares.total_tva));
  if (Math.abs(round2(identite - round2(declares.total_ttc))) > tolerance) {
    ecarts.push({
      champ: "identite",
      calcule: identite,
      declare: round2(declares.total_ttc),
      ecart: round2(identite - round2(declares.total_ttc)),
    });
  }

  return { coherent: ecarts.length === 0, ecarts, calcules };
}

/**
 * Relit les totaux d'un document UBL déjà émis.
 *
 * Sert à afficher une facture SCELLÉE : son QR de contrôle doit porter les
 * montants qui ont été transmis, pas ceux de la ligne en base — qui ont pu
 * bouger depuis. Un QR annonçant un TTC différent de celui que scelle
 * l'empreinte donnerait, au contrôle, l'apparence exacte d'une falsification.
 *
 * On lit `LegalMonetaryTotal` et on DÉRIVE la TVA (TTC − HT) plutôt que de
 * chercher un `cbc:TaxAmount` : cette balise apparaît aussi dans chaque ligne
 * et dans chaque sous-total, et la première rencontrée n'est pas la bonne.
 */
export function lireTotauxUbl(xml: string): { total_ht: number; total_tva: number; total_ttc: number } | null {
  const bloc = String(xml ?? "").match(/<cac:LegalMonetaryTotal>([\s\S]*?)<\/cac:LegalMonetaryTotal>/);
  if (!bloc) return null;

  const lire = (balise: string): number | null => {
    const m = bloc[1].match(new RegExp(`<cbc:${balise}[^>]*>([-0-9.]+)</cbc:${balise}>`));
    if (!m) return null;
    const v = Number(m[1]);
    return Number.isFinite(v) ? v : null;
  };

  const total_ht = lire("TaxExclusiveAmount");
  const total_ttc = lire("TaxInclusiveAmount") ?? lire("PayableAmount");
  if (total_ht === null || total_ttc === null) return null;

  return { total_ht, total_tva: round2(total_ttc - total_ht), total_ttc };
}

/** Code UNCL1001 du type de document transmis. */
export function codeTypeDocument(type: TypeDocumentFiscal | undefined): string {
  switch (type) {
    case "avoir":
      return "381"; // Note de crédit
    case "acompte":
      return "386"; // Facture d'acompte
    case "proforma":
      return "325"; // Facture proforma
    default:
      return "380"; // Facture commerciale
  }
}

// ─── Mode de règlement ──────────────────────────────────────────────────────
//
// UBL exprime l'instrument de paiement en `cbc:PaymentMeansCode`, dont les
// valeurs viennent de la liste UNCL4461 (UN/EDIFACT 4461). Ce n'est pas un texte
// libre : la plateforme rapproche ce code de ce qu'elle observe par ailleurs, et
// un code qui ne correspond pas à l'instrument réel est une déclaration fausse,
// pas une imprécision de forme.
//
// Le vocabulaire d'ENTRÉE est celui de l'application (`mode-paiement.ts`) — on ne
// s'en fabrique pas un second ici. `normaliserMode` sait déjà que « traite » et
// « LCN » désignent le même instrument, et cette connaissance doit rester à un
// seul endroit.

/**
 * Correspondance mode applicatif → code UNCL4461.
 *
 * ⚠️ `effet` (traite / LCN) est mappé sur **42** comme demandé. La liste UNCL4461
 * donne à 42 le sens « Payment to bank account » ; le code normatif d'une traite
 * — effet tiré par le créancier sur le débiteur — est **70** (« Bill drawn by the
 * creditor on the debtor »). Si la plateforme DGI rejette le 42 sur une facture
 * réglée par traite, c'est cette ligne, et elle seule, qu'il faut passer à "70".
 *
 * `prelevement` et `carte` ne figuraient pas dans la consigne mais existent dans
 * l'application : sans eux, une facture prélevée déclarerait un virement.
 */
export const CODE_PAIEMENT_UNCL4461: Record<ModePaiement, string> = {
  especes:     "10", // In cash
  cheque:      "20", // Cheque
  virement:    "30", // Credit transfer
  prelevement: "49", // Direct debit
  carte:       "48", // Bank card
  effet:       "42", // cf. avertissement ci-dessus (normatif : 70)
};

/** Instrument déclaré à défaut de mieux. */
export const MODE_PAIEMENT_UBL_DEFAUT: ModePaiement = "virement";

export interface PaiementUbl {
  mode: ModePaiement;
  code: string;
  libelle: string;
  /**
   * Vrai quand le mode n'a pas pu être lu et que le document retombe sur le
   * virement. L'appelant s'en sert pour prévenir : une facture qui porte
   * « autre » en base ressort en « Virement (30) », ce qui est une AFFIRMATION
   * que personne n'a faite. Le document reste valide, mais l'utilisateur doit
   * savoir ce qui a été déclaré à sa place.
   */
  parDefaut: boolean;
}

/** Traduit un mode de règlement applicatif en instrument UBL. */
export function codePaiementUbl(mode: string | null | undefined): PaiementUbl {
  const reconnu = normaliserMode(mode);
  const retenu = reconnu ?? MODE_PAIEMENT_UBL_DEFAUT;
  return {
    mode: retenu,
    code: CODE_PAIEMENT_UNCL4461[retenu],
    libelle: MODE_PAIEMENT_LABEL[retenu],
    parDefaut: reconnu === null,
  };
}

/**
 * Bloc `cac:PaymentMeans`.
 *
 * Sa PLACE est imposée par le XSD : dans la séquence d'`Invoice`, `PaymentMeans`
 * vient après les parties et AVANT `TaxTotal`. Le poser ailleurs — après les
 * totaux, par exemple, où il se lirait plus naturellement — rend le document
 * invalide alors qu'il contient tout.
 *
 * Le libellé voyage en attribut `name`, à côté du code : un contrôleur humain lit
 * « Virement », la plateforme lit « 30 », et les deux viennent de la même source.
 */
function paymentMeansXml(facture: FactureUbl): string {
  const paiement = codePaiementUbl(facture.mode_reglement);
  return [
    "<cac:PaymentMeans>",
    indenter(
      [
        el("cbc:PaymentMeansCode", paiement.code, ` listID="UNCL4461" name="${echapperXml(paiement.libelle)}"`),
        // Échéance de règlement : UBL la porte ici EN PLUS du `cbc:DueDate` de
        // l'en-tête. La redondance est normative, pas accidentelle.
        el("cbc:PaymentDueDate", facture.date_echeance),
      ],
      1,
    ),
    "</cac:PaymentMeans>",
  ].join("\n");
}

// ─── Encodage : un seul passage UTF-8, du début à la fin ────────────────────
//
// Le document se déclare `encoding="UTF-8"`. Deux façons de mentir sur cette
// déclaration se sont présentées sur ce chantier, et les deux se voient à
// l'œil sur un simple « Étage » :
//
//   • DOUBLE ENCODAGE (« Étage » → « Ã‰tage ») : des octets UTF-8 relus comme
//     du Latin-1 quelque part en amont — un import, un OCR, une réponse HTTP
//     sans charset — puis ré-encodés en UTF-8. Le texte arrive DÉJÀ corrompu
//     dans le modèle ; le construire proprement ne le répare pas.
//   • SOUS-ENCODAGE : une chaîne JavaScript sérialisée octet par octet via
//     `charCodeAt`, qui tronque tout caractère au-delà de U+00FF et écrit du
//     Latin-1 dans un flux annoncé en UTF-8.
//
// `reparerMojibake` traite le premier cas à l'entrée du document,
// `encoderXmlUtf8` interdit le second à sa sortie.

/**
 * Table inverse de Windows-1252 sur la plage 0x80–0x9F.
 *
 * C'est la pièce sans laquelle la réparation échoue sur les cas réels. Le
 * mojibake n'arrive presque jamais par du Latin-1 pur : les tuyaux qui le
 * produisent (Excel, un import CSV, une réponse HTTP sans charset, Windows) se
 * replient sur CP1252, où les octets 0x80–0x9F ne sont PAS des caractères de
 * contrôle mais des symboles typographiques. « Étage » corrompu ne s'écrit
 * donc pas avec un U+0089 en second caractère, mais avec le « ‰ » (U+2030)
 * que CP1252 associe à l'octet 0x89 — hors de la plage Latin-1. Sans cette
 * table, le mojibake le plus courant du terrain ressort intact, c'est-à-dire
 * toujours cassé.
 */
const CP1252_INVERSE = new Map<string, number>([
  ["\u20AC", 0x80],
  ["\u201A", 0x82],
  ["\u0192", 0x83],
  ["\u201E", 0x84],
  ["\u2026", 0x85],
  ["\u2020", 0x86],
  ["\u2021", 0x87],
  ["\u02C6", 0x88],
  ["\u2030", 0x89],
  ["\u0160", 0x8a],
  ["\u2039", 0x8b],
  ["\u0152", 0x8c],
  ["\u017D", 0x8e],
  ["\u2018", 0x91],
  ["\u2019", 0x92],
  ["\u201C", 0x93],
  ["\u201D", 0x94],
  ["\u2022", 0x95],
  ["\u2013", 0x96],
  ["\u2014", 0x97],
  ["\u02DC", 0x98],
  ["\u2122", 0x99],
  ["\u0161", 0x9a],
  ["\u203A", 0x9b],
  ["\u0153", 0x9c],
  ["\u017E", 0x9e],
  ["\u0178", 0x9f],
]);

/** Octet d'origine d'un caractère mal décodé, ou `null` s'il n'en vient pas. */
function octetDeCaractere(caractere: string): number | null {
  const code = caractere.charCodeAt(0);
  if (code <= 0xff) return code;
  return CP1252_INVERSE.get(caractere) ?? null;
}

/** Têtes de séquence UTF-8 des caractères latins, vues comme un octet isolé. */
const TETES_MOJIBAKE = new Set([0xc2, 0xc3, 0xc4, 0xc5, 0xd0, 0xd1, 0xd8, 0xd9, 0xda, 0xe2]);

/**
 * Signature d'un texte doublement encodé.
 *
 * Une tête de séquence UTF-8 (« Ã », « Â », « â »…) suivie d'un octet de
 * CONTINUATION (0x80–0xBF, sous sa forme Latin-1 ou CP1252) ne se produit pas
 * en français ni en arabe translittéré : c'est la marque d'octets UTF-8 relus
 * comme du texte 8 bits.
 *
 * La détection est VOLONTAIREMENT étroite : « Âge » (Â suivi d'un « g »
 * ordinaire) n'y répond pas, et n'est donc jamais « réparé » en autre chose.
 */
function porteSignatureMojibake(texte: string): boolean {
  for (let i = 0; i < texte.length - 1; i++) {
    if (!TETES_MOJIBAKE.has(texte.charCodeAt(i))) continue;
    const suite = octetDeCaractere(texte[i + 1]);
    if (suite !== null && suite >= 0x80 && suite <= 0xbf) return true;
  }
  return false;
}

/** Relecture en UTF-8 des octets d'origine, ou `null` si le texte ne s'y prête pas. */
function relireEnUtf8(texte: string): string | null {
  const octets = new Uint8Array(texte.length);
  for (let i = 0; i < texte.length; i++) {
    const octet = octetDeCaractere(texte[i]);
    // Un seul caractère qui ne vient pas d'un octet prouve que la chaîne n'est
    // PAS une suite d'octets mal décodés : on s'abstient plutôt que de tronquer.
    if (octet === null) return null;
    octets[i] = octet;
  }
  try {
    // `fatal` : le décodeur REFUSE une séquence UTF-8 invalide au lieu de poser
    // un U+FFFD. C'est la garantie qui rend la réparation sûre — un texte qui
    // n'était pas du mojibake ne se décode pas, donc n'est pas touché.
    return new TextDecoder("utf-8", { fatal: true }).decode(octets);
  } catch {
    return null;
  }
}

/**
 * Répare un texte doublement (ou triplement) encodé, et le laisse INTACT au
 * moindre doute.
 *
 * On boucle : un import repassé deux fois par le même tuyau mal configuré
 * demande deux tours. Trois passes suffisent en pratique et bornent le travail
 * sur une désignation pathologique.
 */
export function reparerMojibake(valeur: string | null | undefined): string {
  let courant = String(valeur ?? "");
  for (let passe = 0; passe < 3; passe++) {
    if (!porteSignatureMojibake(courant)) break;
    const repare = relireEnUtf8(courant);
    if (repare === null || repare === courant) break;
    courant = repare;
  }
  return courant;
}

/** Marque d'ordre des octets UTF-8. */
export const BOM_UTF8 = "\uFEFF";

/**
 * Sérialise le document en OCTETS UTF-8 — la seule forme dans laquelle il doit
 * quitter le serveur.
 *
 * `bom` n'est PAS un détail cosmétique : un fichier `.xml` téléchargé puis
 * ouvert dans un éditeur Windows sans marque d'ordre est lu en ANSI, et
 * « Étage » s'y affiche « Ã‰tage » alors que les octets du fichier sont
 * parfaitement corrects. La marque lève l'ambiguïté pour le lecteur humain sans
 * rien changer pour un parseur XML, qui la reconnaît explicitement (XML 1.0
 * §4.3.3). On ne la pose JAMAIS sur le document transmis à la DGI ni sur celui
 * qu'on scelle : là, l'octet doit être nu.
 */
export function encoderXmlUtf8(xml: string, options: { bom?: boolean } = {}): Uint8Array {
  const nu = String(xml ?? "").replace(/^\uFEFF/, "");
  return new TextEncoder().encode(options.bom ? BOM_UTF8 + nu : nu);
}

/** Échappement XML — les cinq entités prédéfinies, plus les caractères de
 *  contrôle que XML 1.0 interdit purement et simplement dans un contenu.
 *
 *  Le texte est d'abord DÉ-MOJIBAKÉ (cf. `reparerMojibake`) : une désignation
 *  ou une adresse déjà corrompue en amont ressortirait sinon telle quelle dans
 *  un document qui se déclare en UTF-8. */
export function echapperXml(valeur: string | null | undefined): string {
  return reparerMojibake(sansCaracteresDeControle(String(valeur ?? "")))
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Retire les caractères que XML 1.0 interdit dans un contenu textuel.
 *
 * Ils arrivent réellement : un scan OCR ou un copier-coller depuis un tableur
 * ramène des 0x00 ou 0x1F invisibles dans une désignation d'article. Le
 * document produit serait alors NON PARSABLE — pas simplement laid — et la DGI
 * le rejetterait sans indiquer la ligne fautive.
 *
 * Seuls TAB, LF et CR sont conservés parmi les codes inférieurs à 0x20.
 */
function sansCaracteresDeControle(texte: string): string {
  let sortie = "";
  for (const caractere of texte) {
    const code = caractere.codePointAt(0) ?? 0;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    if (code === 0x7f) continue;
    sortie += caractere;
  }
  return sortie;
}

/** Élément simple, omis si la valeur est vide (UBL préfère l'absence au vide). */
function el(nom: string, valeur: string | number | null | undefined, attrs = ""): string {
  const v = valeur === null || valeur === undefined ? "" : String(valeur);
  if (v.trim() === "") return "";
  return `<${nom}${attrs}>${echapperXml(v)}</${nom}>`;
}

function indenter(lignes: string[], niveau: number): string {
  const pad = "  ".repeat(niveau);
  return lignes
    .filter((l) => l !== "")
    .map((l) => l.split("\n").map((sl) => pad + sl).join("\n"))
    .join("\n");
}

/**
 * Bloc `cac:Party`. L'ICE voyage en `PartyIdentification/@schemeID="ICE"` —
 * c'est l'identifiant d'entreprise — tandis que l'IF va en `PartyTaxScheme`,
 * l'identifiant de TVA. Les intervertir est l'erreur classique : le document
 * reste bien formé, mais la DGI ne retrouve pas l'assujetti.
 *
 * L'IF figure DE PLUS en `PartyIdentification/@schemeID="IF"`, aux côtés du RC :
 * l'article 145 du CGI impose ces deux mentions sur la facture elle-même, et un
 * IF présent uniquement en `PartyTaxScheme` s'y lit comme un numéro de TVA, pas
 * comme la mention légale. La duplication est voulue, ce n'est pas un doublon.
 */
function partieXml(partie: PartieUbl, taxSchemeId: string): string {
  const lignes = [
    el("cbc:EndpointID", partie.email, ' schemeID="EM"'),
    partie.ice ? `<cac:PartyIdentification>${el("cbc:ID", partie.ice, ' schemeID="ICE"')}</cac:PartyIdentification>` : "",
    partie.if_fiscal ? `<cac:PartyIdentification>${el("cbc:ID", partie.if_fiscal, ' schemeID="IF"')}</cac:PartyIdentification>` : "",
    partie.rc ? `<cac:PartyIdentification>${el("cbc:ID", partie.rc, ' schemeID="RC"')}</cac:PartyIdentification>` : "",
    partie.patente ? `<cac:PartyIdentification>${el("cbc:ID", partie.patente, ' schemeID="PATENTE"')}</cac:PartyIdentification>` : "",
    `<cac:PartyName>${el("cbc:Name", partie.nom)}</cac:PartyName>`,
    [
      "<cac:PostalAddress>",
      indenter(
        [
          el("cbc:StreetName", partie.adresse),
          el("cbc:CityName", partie.ville),
          el("cbc:PostalZone", partie.code_postal),
          `<cac:Country>${el("cbc:IdentificationCode", partie.pays || "MA")}</cac:Country>`,
        ],
        1,
      ),
      "</cac:PostalAddress>",
    ].join("\n"),
    // Identifiant d'ASSUJETTI. Le code de régime suit le profil retenu pour tout
    // le document : porter « TVA » ici et « VAT » ailleurs produirait un document
    // incohérent qu'aucun des deux validateurs n'accepterait.
    partie.if_fiscal
      ? [
          "<cac:PartyTaxScheme>",
          indenter([el("cbc:CompanyID", partie.if_fiscal), `<cac:TaxScheme>${el("cbc:ID", taxSchemeId)}</cac:TaxScheme>`], 1),
          "</cac:PartyTaxScheme>",
        ].join("\n")
      : "",
    [
      "<cac:PartyLegalEntity>",
      indenter([el("cbc:RegistrationName", partie.nom), el("cbc:CompanyID", partie.rc, ' schemeID="RC"')], 1),
      "</cac:PartyLegalEntity>",
    ].join("\n"),
    partie.telephone
      ? ["<cac:Contact>", indenter([el("cbc:Telephone", partie.telephone), el("cbc:ElectronicMail", partie.email)], 1), "</cac:Contact>"].join("\n")
      : "",
  ];
  return ["<cac:Party>", indenter(lignes, 1), "</cac:Party>"].join("\n");
}

function ligneXml(ligne: LigneUbl, index: number, devise: string, taxSchemeId: string): string {
  const taux = tauxNormalise(ligne.taux_tva);
  const base = baseLigne(ligne);
  const dev = ` currencyID="${devise}"`;
  const categorie = taux > 0 ? "S" : "Z";

  const taxTotal = [
    "<cac:TaxTotal>",
    indenter(
      [
        el("cbc:TaxAmount", montant((base * taux) / 100), dev),
        [
          "<cac:TaxSubtotal>",
          indenter(
            [
              el("cbc:TaxableAmount", montant(base), dev),
              el("cbc:TaxAmount", montant((base * taux) / 100), dev),
              [
                "<cac:TaxCategory>",
                indenter(
                  [
                    el("cbc:ID", categorie),
                    el("cbc:Percent", taux.toFixed(2)),
                    `<cac:TaxScheme>${el("cbc:ID", taxSchemeId)}</cac:TaxScheme>`,
                  ],
                  1,
                ),
                "</cac:TaxCategory>",
              ].join("\n"),
            ],
            1,
          ),
          "</cac:TaxSubtotal>",
        ].join("\n"),
      ],
      1,
    ),
    "</cac:TaxTotal>",
  ].join("\n");

  const item = [
    "<cac:Item>",
    indenter(
      [
        el("cbc:Name", ligne.designation || `Article ${index + 1}`),
        [
          "<cac:ClassifiedTaxCategory>",
          indenter(
            [el("cbc:ID", categorie), el("cbc:Percent", taux.toFixed(2)), `<cac:TaxScheme>${el("cbc:ID", taxSchemeId)}</cac:TaxScheme>`],
            1,
          ),
          "</cac:ClassifiedTaxCategory>",
        ].join("\n"),
      ],
      1,
    ),
    "</cac:Item>",
  ].join("\n");

  const prix = [
    "<cac:Price>",
    indenter([el("cbc:PriceAmount", montant(ligne.prix_unitaire), dev)], 1),
    "</cac:Price>",
  ].join("\n");

  return [
    "<cac:InvoiceLine>",
    indenter(
      [
        el("cbc:ID", index + 1),
        el("cbc:InvoicedQuantity", Number(ligne.quantite) || 0, ` unitCode="${ligne.unite || "C62"}"`),
        el("cbc:LineExtensionAmount", montant(base), dev),
        taxTotal,
        item,
        prix,
      ],
      1,
    ),
    "</cac:InvoiceLine>",
  ].join("\n");
}

export interface OptionsUbl {
  /** Identifiant de personnalisation ; par défaut le profil DGI marocain. */
  customizationId?: string;
  profileId?: string;
  /**
   * Code de régime de taxe (`cac:TaxScheme/cbc:ID`). Défaut : `TVA`, attendu
   * par la DGI. Passer `PEPPOL_TAX_SCHEME_ID` pour produire un document que le
   * validateur PEPPOL accepte — usage de diagnostic, pas d'émission.
   */
  taxSchemeId?: string;
}

/**
 * Bloc `ext:UBLExtensions` de scellement — récépissé DGI et empreinte SHA-256.
 *
 * POURQUOI UNE EXTENSION plutôt qu'un champ UBL standard : UBL 2.1 n'a aucun
 * emplacement normatif pour l'empreinte d'inaltérabilité ni pour un numéro de
 * récépissé d'administration fiscale. `UBLExtensions` est précisément le point
 * d'accroche prévu par le standard pour ces ajouts nationaux : le document
 * reste valide au XSD UBL, et la plateforme DGI lit ses métadonnées à un endroit
 * fixe, sans avoir à balayer les `AdditionalDocumentReference`.
 *
 * RIEN N'EST ÉMIS si la facture ne porte ni empreinte ni récépissé : le XSD
 * impose au moins un `ext:UBLExtension` sous `ext:UBLExtensions`, donc un bloc
 * « préparé mais vide » rendrait invalide un brouillon parfaitement légitime.
 *
 * L'empreinte ne se calcule PAS sur ce XML (elle porte sur la chaîne canonique
 * numéro|date|ICE|ICE|TTC, cf. invoice-hash.ts) : l'injecter ici ne crée donc
 * aucune circularité, et le document reste reproductible à l'octet près.
 */
export function scellementXml(facture: FactureUbl): string {
  const recepisse = String(facture.dgi_uuid ?? "").trim();
  const empreinte = String(facture.hash_sha256 ?? "").trim();
  if (!recepisse && !empreinte) return "";

  const contenu = [
    `<dgi:Scellement xmlns:dgi="${DGI_SCELLEMENT_NAMESPACE}">`,
    indenter(
      [
        el("dgi:Recepisse", recepisse),
        el("dgi:Empreinte", empreinte, ' algorithme="SHA-256"'),
      ],
      1,
    ),
    "</dgi:Scellement>",
  ].join("\n");

  return [
    "<ext:UBLExtensions>",
    indenter(
      [
        [
          "<ext:UBLExtension>",
          indenter(
            [
              el("ext:ExtensionURI", DGI_SCELLEMENT_NAMESPACE),
              ["<ext:ExtensionContent>", indenter([contenu], 1), "</ext:ExtensionContent>"].join("\n"),
            ],
            1,
          ),
          "</ext:UBLExtension>",
        ].join("\n"),
      ],
      1,
    ),
    "</ext:UBLExtensions>",
  ].join("\n");
}

export const DGI_CUSTOMIZATION_ID = "urn:dgi.gov.ma:einvoice:1.0";
export const DGI_PROFILE_ID = "urn:fdc:dgi.gov.ma:2026:einvoice:b2b";

/**
 * Construit le document UBL 2.1 complet.
 *
 * Les totaux transmis sont TOUJOURS ceux recalculés depuis les lignes, jamais
 * ceux stockés : ce sont les seuls dont on puisse garantir l'identité
 * HT + TVA = TTC. Il appartient à l'appelant d'avoir contrôlé, via
 * `controlerTotaux`, que la facture stockée ne diverge pas — et de refuser
 * l'émission si c'est le cas, plutôt que de transmettre en silence des montants
 * qui ne sont pas ceux affichés au client.
 */
export function construireUblXml(facture: FactureUbl, options: OptionsUbl = {}): string {
  const devise = facture.devise || "MAD";
  const dev = ` currencyID="${devise}"`;
  const taxSchemeId = options.taxSchemeId ?? DGI_TAX_SCHEME_ID;
  const totaux = totauxFacture(facture.lignes);

  const taxTotalGlobal = [
    "<cac:TaxTotal>",
    indenter(
      [
        el("cbc:TaxAmount", montant(totaux.total_tva), dev),
        ...totaux.ventilation.map((v) =>
          [
            "<cac:TaxSubtotal>",
            indenter(
              [
                el("cbc:TaxableAmount", montant(v.base_ht), dev),
                el("cbc:TaxAmount", montant(v.montant_tva), dev),
                el("cbc:Percent", v.taux.toFixed(2)),
                [
                  "<cac:TaxCategory>",
                  indenter(
                    [
                      el("cbc:ID", v.categorie),
                      el("cbc:Percent", v.taux.toFixed(2)),
                      // Obligatoire dès que le taux est nul : un 0 % sans motif
                      // est un rejet sémantique, pas un avertissement.
                      v.taux === 0 ? el("cbc:TaxExemptionReason", v.motif_exoneration) : "",
                      `<cac:TaxScheme>${el("cbc:ID", taxSchemeId)}</cac:TaxScheme>`,
                    ],
                    1,
                  ),
                  "</cac:TaxCategory>",
                ].join("\n"),
              ],
              1,
            ),
            "</cac:TaxSubtotal>",
          ].join("\n"),
        ),
      ],
      1,
    ),
    "</cac:TaxTotal>",
  ].join("\n");

  const monetaryTotal = [
    "<cac:LegalMonetaryTotal>",
    indenter(
      [
        el("cbc:LineExtensionAmount", montant(totaux.total_ht), dev),
        el("cbc:TaxExclusiveAmount", montant(totaux.total_ht), dev),
        el("cbc:TaxInclusiveAmount", montant(totaux.total_ttc), dev),
        el("cbc:PayableAmount", montant(totaux.total_ttc), dev),
      ],
      1,
    ),
    "</cac:LegalMonetaryTotal>",
  ].join("\n");

  // L'empreinte et l'UUID DGI voyagent en références documentaires : ce sont
  // les deux éléments qu'un contrôleur confronte au QR code du PDF.
  const references = [
    facture.facture_origine
      ? [
          "<cac:BillingReference>",
          indenter([`<cac:InvoiceDocumentReference>${el("cbc:ID", facture.facture_origine)}</cac:InvoiceDocumentReference>`], 1),
          "</cac:BillingReference>",
        ].join("\n")
      : "",
    facture.hash_sha256
      ? [
          "<cac:AdditionalDocumentReference>",
          indenter([el("cbc:ID", facture.hash_sha256), el("cbc:DocumentType", "HASH-SHA256")], 1),
          "</cac:AdditionalDocumentReference>",
        ].join("\n")
      : "",
    facture.dgi_uuid
      ? [
          "<cac:AdditionalDocumentReference>",
          indenter([el("cbc:ID", facture.dgi_uuid), el("cbc:DocumentType", "DGI-UUID")], 1),
          "</cac:AdditionalDocumentReference>",
        ].join("\n")
      : "",
  ];

  const corps = [
    // `ext:UBLExtensions` ouvre le document : le XSD d'UBL le déclare AVANT
    // `cbc:UBLVersionID`, et le placer ailleurs invalide le document entier.
    scellementXml(facture),
    el("cbc:UBLVersionID", "2.1"),
    el("cbc:CustomizationID", options.customizationId ?? DGI_CUSTOMIZATION_ID),
    el("cbc:ProfileID", options.profileId ?? DGI_PROFILE_ID),
    el("cbc:ID", facture.numero),
    el("cbc:IssueDate", facture.date_facture),
    el("cbc:DueDate", facture.date_echeance),
    el("cbc:InvoiceTypeCode", codeTypeDocument(facture.type)),
    el("cbc:Note", facture.notes),
    el("cbc:DocumentCurrencyCode", devise),
    el("cbc:LineCountNumeric", facture.lignes.length),
    ...references,
    ["<cac:AccountingSupplierParty>", indenter([partieXml(facture.vendeur, taxSchemeId)], 1), "</cac:AccountingSupplierParty>"].join("\n"),
    ["<cac:AccountingCustomerParty>", indenter([partieXml(facture.acheteur, taxSchemeId)], 1), "</cac:AccountingCustomerParty>"].join("\n"),
    paymentMeansXml(facture),
    taxTotalGlobal,
    monetaryTotal,
    ...facture.lignes.map((l, i) => ligneXml(l, i, devise, taxSchemeId)),
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:ext="${UBL_EXT_NAMESPACE}">
${indenter(corps, 1)}
</Invoice>`;
}


// ─── Reconnaissance d'un document au profil COURANT ─────────────────────────

export interface ControleProfilUbl {
  /** Vrai si le document porte tout ce que le profil DGI courant exige. */
  conforme: boolean;
  /** Ce qui manque, en clair — sert de motif de régénération dans les journaux. */
  manquants: string[];
}

/**
 * Dit si un document UBL DÉJÀ STOCKÉ a été produit par le constructeur courant.
 *
 * Pourquoi ce contrôle existe : le XML d'une facture est archivé en base au
 * moment du scellement. Les factures scellées AVANT l'entrée en vigueur des
 * trois règles DGI portent donc, pour toujours, un document d'un constructeur
 * précédent — sans `ext:UBLExtensions`, sans identifiants légaux de l'émetteur,
 * sans ventilation de TVA à la racine. Aucune correction du constructeur ne les
 * atteint : ce sont des DONNÉES, pas du code. Il faut les reconnaître pour
 * pouvoir les refaire.
 *
 * Le contrôle porte sur la STRUCTURE, jamais sur une chaîne de version : un
 * document peut annoncer le bon `CustomizationID` et n'avoir aucun des trois
 * blocs, et c'est exactement ce qu'on cherche à détecter.
 */
export function controlerProfilUbl(
  xml: string | null | undefined,
  options: { attendScellement?: boolean } = {},
): ControleProfilUbl {
  const doc = String(xml ?? "");
  const manquants: string[] = [];
  if (doc.trim() === "") return { conforme: false, manquants: ["document absent"] };

  // Règle 1 — scellement en PREMIER enfant de <Invoice>.
  if (options.attendScellement) {
    const debut = doc.indexOf("<Invoice");
    const ext = doc.indexOf("<ext:UBLExtensions>");
    if (ext < 0) manquants.push("ext:UBLExtensions (récépissé + empreinte)");
    else if (debut >= 0 && doc.slice(debut, ext).includes("<cbc:")) {
      manquants.push("ext:UBLExtensions n'est pas le premier enfant de <Invoice>");
    }
  }

  // Règle 2 — identifiants légaux de l'ÉMETTEUR (IF et RC).
  const vendeur = doc.match(/<cac:AccountingSupplierParty>([\s\S]*?)<\/cac:AccountingSupplierParty>/);
  const blocVendeur = vendeur?.[1] ?? "";
  if (!/<cbc:ID[^>]*schemeID="IF"/.test(blocVendeur)) manquants.push('PartyIdentification schemeID="IF" (émetteur)');
  if (!/<cbc:ID[^>]*schemeID="RC"/.test(blocVendeur)) manquants.push('PartyIdentification schemeID="RC" (émetteur)');

  // Règle 3 — ventilation TVA dans le TaxTotal RACINE. Les lignes portent leur
  // propre TaxSubtotal : on les retire d'abord, sans quoi n'importe quel
  // document paraîtrait ventilé.
  const sansLignes = doc.replace(/<cac:InvoiceLine>[\s\S]*?<\/cac:InvoiceLine>/g, "");
  const racine = sansLignes.match(/<cac:TaxTotal>([\s\S]*?)<\/cac:TaxTotal>/);
  if (!racine) manquants.push("cac:TaxTotal racine");
  else if (!racine[1].includes("<cac:TaxSubtotal>")) manquants.push("cac:TaxSubtotal dans le TaxTotal racine");

  // Règle 4 — instrument de paiement déclaré. Un bloc ajouté au constructeur
  // n'atteint AUCUN document archivé tant que le contrôle de profil l'ignore :
  // c'est précisément ainsi que les trois règles précédentes étaient restées
  // invisibles sur les factures déjà scellées.
  if (!/<cbc:PaymentMeansCode/.test(doc)) manquants.push("cac:PaymentMeans (mode de règlement)");

  // Règle 5 — propreté des caractères. Un document techniquement complet mais
  // doublement encodé est tout aussi inexploitable ; il se refait de la même
  // façon, donc il se signale au même endroit.
  if (porteSignatureMojibake(doc)) manquants.push("caractères doublement encodés (UTF-8 relu en Latin-1)");

  return { conforme: manquants.length === 0, manquants };
}
