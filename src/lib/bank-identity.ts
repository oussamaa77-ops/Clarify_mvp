// ============================================================================
// bank-identity.ts — Identification d'une banque marocaine à partir du RIB.
//
// Le code banque = 3 PREMIERS chiffres du RIB (24 chiffres au total). On l'utilise
// comme source AUTORITAIRE d'identification (plus fiable qu'un mot-clé OCR bruité),
// avec repli sur les mots-clés du texte du relevé. Fournit aussi le logo officiel
// (servi depuis /public/logos) et une couleur d'accent pour l'UI premium.
//
// Client + serveur : aucune dépendance framework. Réutilise extractRibMarocain.
// ============================================================================
import { extractRibMarocain } from "./releve-attijari";

export interface BankIdentity {
  id: string;               // slug stable (attijariwafa, bcp, cih…)
  nom: string;              // libellé d'affichage canonique
  logo: string | null;     // URL publique du logo (ou null si indisponible)
  accent: string;          // classe Tailwind de fond pastel (badge/accent premium)
  accentText: string;      // classe Tailwind de texte assortie
  // Préfixes de code banque (3 chiffres). '1xx' = tout code commençant par 1.
  matchCode: (code3: string) => boolean;
  // Détection par mots-clés du texte (repli si RIB illisible).
  keywords: RegExp;
}

// Banque générique (RIB/texte non identifiés) — pas de logo officiel.
export const BANQUE_INCONNUE: BankIdentity = {
  id: "inconnue",
  nom: "Banque",
  logo: null,
  accent: "bg-slate-100 dark:bg-slate-800",
  accentText: "text-slate-600 dark:text-slate-300",
  matchCode: () => false,
  keywords: /$^/,
};

// Registre des banques marocaines. Codes banque officiels (3 premiers chiffres du RIB).
export const BANKS: BankIdentity[] = [
  {
    id: "attijariwafa", nom: "Attijariwafa Bank", logo: "/logos/attijari.png",
    accent: "bg-amber-100 dark:bg-amber-900/30", accentText: "text-amber-700 dark:text-amber-300",
    matchCode: (c) => c === "007",
    keywords: /attijariwafa|attijari|\bawb\b|wafa\s*bank/i,
  },
  {
    id: "bcp", nom: "Banque Populaire", logo: "/logos/bcp.jpg",
    accent: "bg-orange-100 dark:bg-orange-900/30", accentText: "text-orange-700 dark:text-orange-300",
    // Toute la plage 1xx (101, 127, 145, 190…) appartient au Groupe Banque Populaire.
    matchCode: (c) => c.startsWith("1"),
    keywords: /banque\s+populaire|banque\s+centrale\s+populaire|chaabi|groupe\s+banque\s+populaire|\bbcp\b|\bgbp\b/i,
  },
  {
    id: "boa", nom: "Bank of Africa", logo: "/logos/bmce.png",
    accent: "bg-sky-100 dark:bg-sky-900/30", accentText: "text-sky-700 dark:text-sky-300",
    matchCode: (c) => c === "011" || c === "012",
    keywords: /bank\s+of\s+africa\b|\bbmce\b|\bboa\b/i,
  },
  {
    id: "cih", nom: "CIH Bank", logo: "/logos/cih.png",
    accent: "bg-red-100 dark:bg-red-900/30", accentText: "text-red-700 dark:text-red-300",
    matchCode: (c) => c === "230",
    keywords: /\bcih\b|credit\s+immobilier/i,
  },
  {
    id: "bmci", nom: "BMCI", logo: "/logos/bmci.png",
    accent: "bg-emerald-100 dark:bg-emerald-900/30", accentText: "text-emerald-700 dark:text-emerald-300",
    matchCode: (c) => c === "013",
    keywords: /\bbmci\b|banque\s+marocaine\s+pour\s+le\s+commerce/i,
  },
  {
    // Ex-Société Générale Maroc, rebrandée Saham Bank (2024-2025) — même code banque 022.
    // On garde les mots-clés « société générale » pour les anciens relevés encore en circulation.
    id: "saham", nom: "Saham Bank", logo: "/logos/saham.jpg",
    accent: "bg-rose-100 dark:bg-rose-900/30", accentText: "text-rose-700 dark:text-rose-300",
    matchCode: (c) => c === "022",
    keywords: /saham\s*bank|\bsaham\b|societe\s+generale|société\s+générale|\bsgmb\b|\bsgma\b/i,
  },
  {
    id: "cam", nom: "Crédit Agricole du Maroc", logo: "/logos/cam.png",
    accent: "bg-lime-100 dark:bg-lime-900/30", accentText: "text-lime-700 dark:text-lime-300",
    matchCode: (c) => c === "021",
    keywords: /credit\s+agricole|crédit\s+agricole|\bcam\b/i,
  },
  {
    id: "cdm", nom: "Crédit du Maroc", logo: "/logos/cdm.png",
    accent: "bg-violet-100 dark:bg-violet-900/30", accentText: "text-violet-700 dark:text-violet-300",
    matchCode: (c) => c === "019",
    keywords: /credit\s+du\s+maroc|crédit\s+du\s+maroc|\bcdm\b/i,
  },
];

// Code banque = 3 premiers chiffres du RIB (après nettoyage des séparateurs).
export function codeBanqueFromRib(rib: string | null | undefined): string {
  const digits = (rib ?? "").replace(/\D/g, "");
  return digits.length >= 3 ? digits.slice(0, 3) : "";
}

// Identifie la banque par code RIB (autoritaire), à défaut par mots-clés du texte.
export function identifierBanque(opts: { rib?: string | null; texte?: string | null }): BankIdentity {
  const code = codeBanqueFromRib(opts.rib);
  if (code) {
    const parCode = BANKS.find((b) => b.matchCode(code));
    if (parCode) return parCode;
  }
  const texte = opts.texte ?? "";
  if (texte) {
    const parMot = BANKS.find((b) => b.keywords.test(texte));
    if (parMot) return parMot;
  }
  return BANQUE_INCONNUE;
}

// Retrouve l'identité à partir d'un nom de banque déjà connu (pour l'UI : comptes en
// base stockés avec leur libellé banque). Tolérant : essaie mots-clés puis égalité nom.
export function identifierBanqueParNom(nom: string | null | undefined): BankIdentity {
  const n = (nom ?? "").trim();
  if (!n) return BANQUE_INCONNUE;
  return BANKS.find((b) => b.keywords.test(n) || b.nom.toLowerCase() === n.toLowerCase()) ?? BANQUE_INCONNUE;
}

// Identifie directement depuis le texte brut OCR : extrait le RIB puis la banque.
export function identifierBanqueDepuisTexte(texte: string): { banque: BankIdentity; rib: string } {
  const rib = extractRibMarocain(texte);
  return { banque: identifierBanque({ rib, texte }), rib };
}

// Masque un RIB pour n'exposer que les 4 derniers chiffres : « •••• •••• •••• 5932 ».
// Retourne "" si aucun chiffre exploitable.
export function maskRib(rib: string | null | undefined): string {
  const digits = (rib ?? "").replace(/\D/g, "");
  if (digits.length < 4) return "";
  return `•••• •••• •••• ${digits.slice(-4)}`;
}
