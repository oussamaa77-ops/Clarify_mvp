// Pure utility functions — no framework dependencies, fully testable.

import { extractRibMarocain } from "../lib/releve-attijari";
import { identifierBanque } from "../lib/bank-identity";

export function parseInvoiceRegex(text: string, dossierNom: string, dossierIce: string) {
  const norm = text.replace(/\r\n/g, "\n").replace(/\t/g, " ");

  const iceMatches = [...norm.matchAll(/ICE\s*[:\-]?\s*(\d{15})/gi)];
  const allIces = iceMatches.map((m) => m[1]);

  const emetteur_ice: string | null =
    allIces.find((ice) => ice !== dossierIce) ?? allIces[0] ?? null;

  const sens_facture = "inconnu";

  let emetteur_nom: string | null = null;
  if (emetteur_ice) {
    const iceIdx = norm.indexOf(emetteur_ice);
    if (iceIdx !== -1) {
      const before = norm.slice(Math.max(0, iceIdx - 600), iceIdx);
      const candidates = before
        .split("\n")
        .map((l) => l.trim())
        .filter(
          (l) =>
            l.length >= 2 &&
            l.length <= 80 &&
            !/^\d/.test(l) &&
            !/(:\s)/.test(l) &&
            !/^(?:ICE|IF|RC|TP|SIRET|Factur|Client|Date|Total|N°|Réf|Ref|Direction|Zone|Adresse|Tel|Fax|Email|Siège|BP |Avenue|Rue |Blvd|Boulevard|Quartier|Hay |Lotissement|Immeuble|Bâtiment|Résidence)/i.test(l) &&
            !/\d{5,}/.test(l) &&
            /[A-Za-zÀ-ÿ]{2,}/.test(l),
        );
      emetteur_nom = candidates[0] ?? null;
    }
  }

  const numero: string | null =
    norm.match(
      /(?:facture\s*n°?|n°\s*facture|invoice\s*n°?|fact\.?\s*n°?|num[eé]ro(?:\s+facture)?)\s*[:\-]?\s*([A-Z0-9][A-Z0-9\/\-\.]{1,25})/i,
    )?.[1] ?? null;

  const rawDates: string[] = [];
  for (const m of norm.matchAll(/(?<!\d)(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/g)) {
    const [, d, mo, y] = m;
    const year = y.length === 2 ? "20" + y : y;
    const iso = `${year}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
    const dt = new Date(iso);
    if (!isNaN(dt.getTime()) && dt.getFullYear() >= 2000 && dt.getFullYear() <= 2035)
      rawDates.push(iso);
  }
  for (const m of norm.matchAll(/(\d{4})[\/\-](\d{2})[\/\-](\d{2})/g)) {
    const iso = `${m[1]}-${m[2]}-${m[3]}`;
    const dt = new Date(iso);
    if (!isNaN(dt.getTime()) && dt.getFullYear() >= 2000 && dt.getFullYear() <= 2035)
      rawDates.push(iso);
  }
  const uniqueDates = [...new Set(rawDates)];
  const date_facture = uniqueDates[0] ?? null;
  const date_echeance = uniqueDates[1] ?? null;

  const amt = (s: string | undefined): number | null => {
    if (!s) return null;
    const n = parseFloat(s.replace(/\s/g, "").replace(",", "."));
    return isNaN(n) || n <= 0 ? null : n;
  };

  const ttcRaw = norm.match(
    /(?:total\s+t\.?t\.?c\.?|net\s+[àa]\s+payer|montant\s+ttc|net\s+payable|total\s+payable)\s*[:\-]?\s*([\d\s]+(?:[,\.]\d{1,2})?)/i,
  )?.[1];
  const htRaw = norm.match(
    /(?:total\s+h\.?t\.?|montant\s+h\.?t\.?|sous[- ]?total\s+h\.?t\.?|hors\s+taxe|total\s+hors\s+taxe)\s*[:\-]?\s*([\d\s]+(?:[,\.]\d{1,2})?)/i,
  )?.[1];
  const tvaRaw = norm.match(
    /(?:total\s+t\.?v\.?a\.?|montant\s+t\.?v\.?a\.?|t\.?v\.?a\.?\s+\d+\s*%)\s*[:\-]?\s*([\d\s]+(?:[,\.]\d{1,2})?)/i,
  )?.[1];

  let montant_ttc = amt(ttcRaw);
  let montant_ht = amt(htRaw);
  let montant_tva = amt(tvaRaw);

  if (montant_ttc && montant_ht && !montant_tva)
    montant_tva = Math.round((montant_ttc - montant_ht) * 100) / 100;
  if (montant_ttc && montant_tva && !montant_ht)
    montant_ht = Math.round((montant_ttc - montant_tva) * 100) / 100;
  if (montant_ttc && !montant_ht) {
    montant_ht = Math.round((montant_ttc / 1.2) * 100) / 100;
    montant_tva = Math.round((montant_ttc - montant_ht) * 100) / 100;
  }

  const mode_reglement = /virement/i.test(norm)
    ? "virement"
    : /chèque|cheque/i.test(norm)
      ? "cheque"
      : /espèces|especes|cash/i.test(norm)
        ? "especes"
        : /prélèvement|prelevement/i.test(norm)
          ? "prelevement"
          : /carte/i.test(norm)
            ? "carte"
            : "virement";

  let score = 0;
  if (montant_ttc && montant_ttc > 0) score += 3;
  if (montant_ht && montant_ht > 0) score += 2;
  if (date_facture) score += 2;
  if (numero) score += 1;
  if (emetteur_ice) score += 2;

  const confidence: "high" | "medium" | "low" =
    score >= 8 ? "high" : score >= 4 ? "medium" : "low";

  return {
    sens_facture,
    emetteur_nom,
    emetteur_ice,
    numero_facture: numero,
    date_facture,
    date_echeance,
    montant_ht: montant_ht ?? 0,
    montant_tva: montant_tva ?? 0,
    montant_ttc: montant_ttc ?? 0,
    mode_reglement,
    confidence,
  };
}

export interface MontantsInput {
  montant_ht: number;
  montant_tva: number;
  montant_ttc: number;
  taux_tva: number | null;
}

export function correctMontants(input: MontantsInput): MontantsInput {
  const TVA_RATES = [0, 7, 10, 14, 20];
  const ht   = Number(input.montant_ht)  || 0;
  const ttc  = Number(input.montant_ttc) || 0;
  const txAI = Number(input.taux_tva)   || 0;

  const result = { ...input };

  if (ht > 0 && ttc > 0) {
    // Both declared on the invoice — keep them as-is.
    // Only fill in TVA if missing (simple subtraction, no rate snapping).
    if (!result.montant_tva) {
      result.montant_tva = Math.round((ttc - ht) * 100) / 100;
    }
  } else if (ht > 0 && txAI > 0 && ttc === 0) {
    const tx = TVA_RATES.includes(txAI) ? txAI : 20;
    result.montant_tva = Math.round(ht * tx / 100 * 100) / 100;
    result.montant_ttc = Math.round((ht + result.montant_tva) * 100) / 100;
    result.taux_tva    = tx;
  } else if (ttc > 0 && ht === 0 && txAI > 0) {
    const tx = TVA_RATES.includes(txAI) ? txAI : 20;
    result.montant_ht  = Math.round(ttc / (1 + tx / 100) * 100) / 100;
    result.montant_tva = Math.round((ttc - result.montant_ht) * 100) / 100;
    result.taux_tva    = tx;
  }

  return result;
}

export function buildReleveImagePrompt(): string {
  return `Tu es un expert OCR bancaire marocain. Extrais TOUTES les transactions de ce relevé. JSON uniquement, zéro texte avant ou après.

════════════ MISSION PRINCIPALE ════════════
Tu dois lire et retourner pour chaque transaction :
1. Les dates, référence, libellé
2. Le MONTANT (valeur absolue positive — juste le chiffre)
3. Le SOLDE COURANT affiché sur la même ligne en fin de tableau (colonne SOLDE / BALANCE)

Le système calculera lui-même si c'est un débit ou crédit à partir du solde courant.
Tu n'as PAS besoin de décider débit ou crédit — concentre-toi sur bien lire les chiffres.

════════════ SOLDE COURANT — LE CHAMP LE PLUS IMPORTANT ════════════
Chaque ligne de transaction affiche un solde mis à jour (colonne tout à droite, libellée SOLDE, BALANCE, SOLDE COURANT).
→ Lis ce solde EXACTEMENT pour chaque transaction et mets-le dans "solde_courant".
→ Si le solde courant n'est PAS visible sur ce relevé → mettre null.

Exemple format colonne unique (débit et crédit dans la même colonne) :
  15 01  15 01 2024  VIR124  VIREMENT RECU   1 500,00        52 300,00
  → montant = 1500.00, solde_courant = 52300.00
  20 01  20 01 2024  CHQ456  CHEQUE EMIS           800,00     51 500,00
  → montant = 800.00, solde_courant = 51500.00

Exemple format deux colonnes DÉBIT / CRÉDIT séparées :
  15 01  15 01 2024  VIR124  VIREMENT RECU              1 500,00    52 300,00
  → montant = 1500.00 (colonne CRÉDIT), solde_courant = 52300.00 (colonne SOLDE la plus à droite)
  20 01  20 01 2024  CHQ456  CHEQUE EMIS      800,00               51 500,00
  → montant = 800.00 (colonne DÉBIT), solde_courant = 51500.00
  ⚠ Le montant crédit (1 500,00) est dans l'avant-dernière colonne, PAS dans solde_courant !

════════════ MONTANTS — RÈGLES DE LECTURE ════════════
• Montants MAD : "1 250,00" → 1250.00 | "52 300,00" → 52300.00 | "800,00" → 800.00
• Toujours positif (valeur absolue) — ne mets jamais de signe négatif
• Ne recalcule JAMAIS — lis exactement ce qui est imprimé

FORMATS DE COLONNES — TRÈS IMPORTANT :
  Format 1 — colonne unique (MONTANT + SOLDE) :
    Ligne débit  : DATE  DATE  REF  LIBELLÉ   800,00      51 500,00
    Ligne crédit : DATE  DATE  REF  LIBELLÉ  1 500,00      53 000,00
    → montant = premier nombre, solde_courant = second nombre

  Format 2 — deux colonnes séparées (DÉBIT | CRÉDIT | SOLDE) :
    Ligne débit  : DATE  DATE  REF  LIBELLÉ   800,00              51 500,00
    Ligne crédit : DATE  DATE  REF  LIBELLÉ             1 500,00  53 000,00
    → Pour une ligne DÉBIT  : montant = la valeur dans la colonne gauche (débit), solde_courant = colonne droite
    → Pour une ligne CRÉDIT : montant = la valeur dans la colonne du milieu (crédit), solde_courant = colonne tout à droite
    ⚠ CRUCIAL : quand la colonne débit est VIDE, le montant est dans la colonne CRÉDIT — ne le mets JAMAIS dans solde_courant !

  Règle universelle : "montant" = la valeur de la transaction (débit OU crédit), "solde_courant" = le solde du compte après la transaction (toujours la colonne la plus à droite).

════════════ EN-TÊTE DU RELEVÉ ════════════
banque        : "Attijariwafa Bank" | "Banque Populaire du Maroc" | "CIH Bank" |
                "BMCE Bank of Africa" | "BMCI" | "Société Générale Maroc" | autre
rib           : RIB complet si visible (24 chiffres)
solde_initial : solde AVANT la 1ère transaction — labels : "SOLDE DEPART", "ANCIEN SOLDE",
                "SOLDE REPORT", "SOLDE PRÉCÉDENT", "SOLDE REPORTÉ" — lire EXACTEMENT
solde_final   : solde APRÈS la dernière transaction — labels : "SOLDE FINAL",
                "SOLDE A REPORTER", "SOLDE A REPORTER AU <date>", "SOLDE AU <date>",
                "NOUVEAU SOLDE", "SOLDE DE CLÔTURE" — lire EXACTEMENT

════════════ SOLDE A REPORTER / SOLDE AU <date> EN FIN DE TABLEAU — RÈGLE ABSOLUE ════════════
Beaucoup de relevés (Crédit Agricole, Saham, CIH…) terminent le tableau — ou juste
en dessous — par une ligne de SOLDE DE FIN dont la date est DANS le libellé :
  ex: "SOLDE A REPORTER AU 31/12/2024    12 500,00"
  ex: "SOLDE AU 31/12/2024    12 500,00"
  ex: "NOUVEAU SOLDE AU 31/12/2024    12 500,00"
Signes distinctifs : le libellé contient le mot "SOLDE", les colonnes DATE D'OPÉRATION
et RÉFÉRENCE sont VIDES (la date "AU …" fait partie du texte du solde), et il y a UN
seul montant = le solde du compte.
→ Cette ligne N'EST PAS UNE TRANSACTION. Mets son montant dans "solde_final".
→ NE crée JAMAIS d'objet dans "txs" pour cette ligne, même si elle a un montant.

════════════ SOLDE REPORTÉ / ANCIEN SOLDE — RÈGLE ABSOLUE ════════════
Certains relevés (page 2+) affichent en HAUT DU TABLEAU une ligne de report de solde :
  ex: "SOLDE REPORTÉ AU 31/01/2024    52 300,00"
  ex: "ANCIEN SOLDE    52 300,00"
  ex: "REPORT AU ...   52 300,00"
→ Cette ligne N'EST PAS UNE TRANSACTION. C'est le solde de fin de la page précédente.
→ Mets son montant dans "solde_initial" et NE l'inclus JAMAIS dans le tableau "txs".
→ La première vraie transaction commence APRÈS cette ligne (elle a une date d'opération).
⚠ INTERDIT : créer un objet dans "txs" pour cette ligne de report, même si elle a un montant.

════════════ RÈGLES GÉNÉRALES ════════════
• Lis le tableau de haut en bas SANS sauter aucune ligne de transaction
• Ignore : en-têtes de colonnes, totaux de page, lignes de solde seules, numéros de page
• Dates → DD/MM/YYYY. Année absente → utilise l'année visible sur le document
• Champ illisible → "" pour chaînes, null pour nombres

════════════ LIBELLÉS SUR PLUSIEURS LIGNES — RÈGLE CRITIQUE ════════════
• Une NOUVELLE transaction commence UNIQUEMENT sur une ligne où les colonnes date opération / date valeur sont REMPLIES — chaque transaction réelle a ses dates.
• Si une ligne du tableau n'a PAS de date (colonnes dates VIDES) → c'est la SUITE du libellé de la transaction PRÉCÉDENTE : concatène ce texte à la fin du libellé précédent, ne crée JAMAIS un nouvel objet JSON pour cette ligne.
• NUMÉROS COUPÉS PAR LE RETOUR À LA LIGNE : si le libellé se termine par un numéro (LCN, chèque, référence) et que la ligne suivante SANS date commence par un ou plusieurs chiffres → ce sont les DERNIERS CHIFFRES du MÊME numéro, colle-les SANS espace.
  Exemple : ligne 1 "COM REMISE LCN N° 63023" + ligne 2 sans date "2" → libelle = "COM REMISE LCN N° 630232"
• Ne fusionne JAMAIS deux lignes qui ont chacune leurs colonnes dates remplies — ce sont deux transactions DISTINCTES, même si leurs libellés se ressemblent.

════════════ UNE TRANSACTION = UNE SEULE LIGNE — RÈGLE ABSOLUE ════════════
• Chaque objet du tableau "txs" correspond à EXACTEMENT UNE ligne datée du tableau : un seul montant de transaction (+ son solde courant éventuel).
• Ne REGROUPE JAMAIS plusieurs montants de transactions différentes dans un même objet. Si tu vois deux montants de transaction sur deux lignes datées distinctes → deux objets JSON distincts.
• Les seuls deux montants autorisés sur une même ligne sont : le montant de la transaction ET le solde courant (jamais deux montants de transaction).
• Retourne le tableau "txs" dans l'ORDRE VISUEL du tableau, de haut en bas, sans réordonner ni regrouper.

════════════ JSON À RETOURNER ════════════
{
  "banque": "",
  "rib": "",
  "solde_initial": 0,
  "solde_final": 0,
  "txs": [
    {
      "date_operation": "DD/MM/YYYY",
      "date_valeur": "DD/MM/YYYY",
      "reference": "",
      "libelle": "",
      "montant": 0,
      "solde_courant": null
    }
  ]
}`;
}

// ─── Parseur Markdown OCR (Mistral OCR) → structure relevé ───────────────────
// Mistral OCR (`mistral-ocr-latest`) renvoie le relevé sous forme de Markdown :
// les tableaux deviennent des lignes « | colonne | colonne | ». On reconstruit
// les transactions au format attendu par le pipeline ocrReleve.
//
// Champs produits par transaction :
//   { reference, date_operation, date_valeur, libelle, montant_debit, montant_credit, solde_courant }
//   - montant_debit / montant_credit : nombre, ou null si la cellule est vide
//   - la direction (débit/crédit) provient des colonnes explicites du tableau ;
//     à défaut, du delta de solde, puis des mots-clés du libellé.

export interface ReleveMarkdownTx {
  reference: string;
  date_operation: string;
  date_valeur: string;
  libelle: string;
  montant_debit: number | null;
  montant_credit: number | null;
  solde_courant: number | null;
  // DERNIER montant numérique de la ligne = solde courant réel du relevé (la colonne
  // solde est toujours la plus à droite), robuste même quand l'OCR décale les colonnes.
  // Permet une récupération DÉTERMINISTE des montants par delta de solde (sans LLM).
  solde_ligne?: number | null;
  // Solde reconstruit pas à pas depuis le solde initial (solde_initial signé +
  // Σ crédits − Σ débits jusqu'à cette ligne incluse). Sert au contrôle de
  // cohérence et au repérage de la ligne où l'écart apparaît.
  solde_calcule?: number | null;
}

// Contrôle de cohérence : on reconstruit le solde final ligne par ligne et on le
// confronte au solde de fin scanné (« SOLDE A REPORTER » chez Banque Populaire).
// Un écart > tolérance signale une ligne manquante / mal lue par l'OCR.
export interface ReleveControle {
  solde_initial: number;        // solde de départ scanné (valeur absolue lue)
  total_debit: number;          // Σ des débits des transactions
  total_credit: number;         // Σ des crédits des transactions
  solde_final_calcule: number;  // solde final reconstruit (signé, convention retenue)
  solde_final_scanne: number;   // « SOLDE A REPORTER » lu sur le relevé (valeur absolue)
  ecart: number;                // |solde_final_calcule| − solde_final_scanne (≈0 si cohérent)
  sens: "crediteur" | "debiteur"; // signe du solde de départ retenu pour l'équilibre
  coherent: boolean;            // true si |ecart| ≤ tolérance et soldes exploitables
  controlable: boolean;         // false si solde initial ou final illisible (contrôle impossible)
}

export interface ReleveMarkdownResult {
  banque: string;
  rib: string;
  solde_initial: number;
  solde_final: number;
  txs: ReleveMarkdownTx[];
  controle: ReleveControle;
}

// Espaces insécables fréquents dans les sorties OCR.
const MD_NBSP = /[   ]/g;

function mdStripAccentsLower(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// Convertit une cellule de montant marocain en nombre. Cellule vide / tiret → null.
function mdParseMontant(s: string | undefined | null): number | null {
  if (s == null) return null;
  let raw = s.replace(MD_NBSP, " ").replace(/\*\*/g, "").trim();
  if (!raw || /^[-—–.\s]+$/.test(raw)) return null; // cellule vide ou tiret
  raw = raw.replace(/(mad|dhs?|dh)\b/gi, "").trim(); // retire la devise
  let n = raw.replace(/\s/g, "");
  if (/,\d{1,2}$/.test(n)) {
    // virgule décimale → les points sont des séparateurs de milliers
    n = n.replace(/\./g, "").replace(",", ".");
  } else {
    // point décimal (ou entier) → les virgules sont des séparateurs de milliers
    n = n.replace(/,/g, "");
  }
  n = n.replace(/[^\d.\-]/g, "");
  const val = parseFloat(n);
  return isNaN(val) ? null : val;
}

// Normalise une date détectée (JJ/MM/AAAA, JJ-MM, JJ MM AAAA…) en DD/MM/YYYY.
function mdNormDate(s: string): string {
  const m = s.replace(MD_NBSP, " ").trim()
    .match(/(\d{1,2})[\/.\- ](\d{1,2})(?:[\/.\- ](\d{2,4}))?/);
  if (!m) return "";
  const dd = m[1].padStart(2, "0");
  const mm = m[2].padStart(2, "0");
  let yy = m[3] ?? String(new Date().getFullYear());
  if (yy.length === 2) yy = "20" + yy;
  if (Number(dd) > 31 || Number(mm) > 12) return "";
  return `${dd}/${mm}/${yy}`;
}

const MD_CREDIT_KW = [
  "RECU", "REÇU", "VIR RECU", "VIRT RECU", "VIREMENT RECU", "VIR.WEB RECU", "VIR INST RECU",
  "REMISE", "VERSEMENT", "DEPOT", "DÉPÔT", "ENCAISSEMENT", "AVOIR", "AVIS DE CREDIT",
  "INTERETS CREDIT", "INTERETS CREDITEUR", "RECOUVREMENT", "CREDIT VIREMENT",
];
function mdLooksCredit(libelle: string): boolean {
  const u = (libelle || "").toUpperCase();
  return MD_CREDIT_KW.some((k) => u.includes(k));
}

// Quand le relevé n'a pas de colonne « Référence » dédiée, la réf. (n° chèque,
// code opération, LCN…) est souvent en tête du libellé. On récupère le 1er jeton
// alphanumérique contenant un chiffre dans les premiers mots (générique).
function mdRefFromLibelle(libelle: string): string {
  const tokens = libelle.trim().split(/\s+/).slice(0, 3);
  for (const tk of tokens) {
    const t = tk.replace(/^n[°o]?[:.]?/i, ""); // retire un préfixe « N° »
    if (/^[A-Z0-9]{4,20}$/i.test(t) && /\d/.test(t)) return t;
  }
  return "";
}

// Découpe une ligne de tableau Markdown « | a | b | c | » en cellules nettoyées.
function mdSplitRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.replace(MD_NBSP, " ").replace(/\*\*/g, "").trim());
}

function mdIsSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s/g, "")));
}

// Repère les colonnes d'un en-tête de tableau de transactions.
type MdCols = Partial<Record<
  "date_operation" | "date_valeur" | "reference" | "libelle" | "debit" | "credit" | "solde" | "montant",
  number
>>;
function mdDetectColumns(cells: string[]): MdCols {
  const map: MdCols = {};
  cells.forEach((c, i) => {
    const h = mdStripAccentsLower(c);
    if (!h) return;
    if (h.includes("debit") || h.includes("retrait")) { if (map.debit === undefined) map.debit = i; }
    else if (h.includes("credit") || h.includes("versement")) { if (map.credit === undefined) map.credit = i; }
    else if (h.includes("solde") || h.includes("balance")) { if (map.solde === undefined) map.solde = i; }
    else if (h.includes("valeur") || /\bval\b/.test(h) || h.includes("val.")) { if (map.date_valeur === undefined) map.date_valeur = i; }
    else if (h.includes("date") || h.includes("jour")) { if (map.date_operation === undefined) map.date_operation = i; }
    else if (h.includes("referen") || h.includes("piece") || /\bref\b/.test(h) || h.includes("operation n") || h.includes("n operation") || h.includes("n°")) { if (map.reference === undefined) map.reference = i; }
    else if (h.includes("libell") || h.includes("nature") || h.includes("designation") || h.includes("description") || h.includes("operation") || h.includes("motif") || h.includes("intitule")) { if (map.libelle === undefined) map.libelle = i; }
    else if (h.includes("montant")) { if (map.montant === undefined) map.montant = i; }
  });
  return map;
}

// Une ligne d'en-tête de tableau de transactions doit comporter au moins une
// colonne « date » + une colonne montant (débit/crédit/montant).
function mdLooksLikeHeader(map: MdCols): boolean {
  return map.date_operation !== undefined &&
    (map.debit !== undefined || map.credit !== undefined || map.montant !== undefined || map.solde !== undefined);
}

function mdGetCell(cells: string[], idx: number | undefined): string {
  return idx !== undefined && idx < cells.length ? cells[idx] : "";
}

// ─── Sanitization générique du Markdown OCR ──────────────────────────────────
// Corrige un défaut majeur de l'OCR : les cellules coupées par des sauts de ligne
// (ex. "16 07 \n\n 2024" ou "4000 \n ,00") qui font échouer les regex et sautent
// des transactions. À appliquer sur le texte brut AVANT le parsing.
export function sanitizeReleveMarkdown(raw: string): string {
  let text = raw.replace(/\r\n/g, "\n").replace(MD_NBSP, " ");

  // 1) APLATIR LES CELLULES : une ligne de tableau commence par "|". Si elle ne
  //    se termine PAS par "|", c'est qu'une cellule a été coupée par un saut de
  //    ligne — on fusionne la/les ligne(s) suivante(s) (qui ne commencent pas par
  //    "|") avec un espace, jusqu'à retrouver une ligne complète (terminée par "|").
  //    Le test « ne finit pas par | » évite d'avaler un paragraphe qui suit un
  //    tableau complet (ex. "NOUVEAU SOLDE …").
  const rawLines = text.split("\n");
  const merged: string[] = [];
  for (const line of rawLines) {
    const prevIdx = merged.length - 1;
    const prev = prevIdx >= 0 ? merged[prevIdx] : undefined;
    const t = line.trim();
    const prevIsOpenRow =
      prev !== undefined &&
      prev.trimStart().startsWith("|") &&
      !prev.trimEnd().endsWith("|");
    if (prevIsOpenRow && t !== "" && !t.startsWith("|") && !t.startsWith("#")) {
      merged[prevIdx] = prev.replace(/\s+$/, "") + " " + t; // recoller la cellule
    } else {
      merged.push(line);
    }
  }
  text = merged.join("\n");

  // 2) RECOLLER LES NOMBRES coupés : "4000 ,00" / "4 000 , 00" → "4000,00".
  text = text.replace(/(\d)[ \t]+,[ \t]*(\d{2})\b/g, "$1,$2");

  // 3) NORMALISER LES DATES espacées : "16 07 2024" / "16 / 07 / 2024" →
  //    "16/07/2024". jour & mois 1-2 chiffres ⇒ ne touche pas les montants
  //    ("12 000,00") ni les fragments de RIB.
  text = text.replace(
    /\b(\d{1,2})[ \t]*[\/.\-][ \t]*(\d{1,2})[ \t]*[\/.\-][ \t]*(\d{2,4})\b/g,
    (_m, d, mo, y) => `${String(d).padStart(2, "0")}/${String(mo).padStart(2, "0")}/${y}`,
  );
  // Variante avec espaces comme seuls séparateurs : "16 07 2024".
  text = text.replace(
    /\b(\d{1,2})[ \t]+(\d{1,2})[ \t]+(\d{4})\b/g,
    (_m, d, mo, y) => `${String(d).padStart(2, "0")}/${String(mo).padStart(2, "0")}/${y}`,
  );

  return text;
}

export function parseReleveMarkdown(markdown: string): ReleveMarkdownResult {
  const text = sanitizeReleveMarkdown(markdown);
  const lower = mdStripAccentsLower(text);

  // RIB marocain = 24 chiffres (3 banque + 3 ville + 16 compte + 2 clé). L'extraction
  // (ancrée sur le label « RELEVE D'IDENTITE BANCAIRE », tolérante OCR/séparateurs pour
  // couvrir le champ ATW multi-cellules) est centralisée dans releve-attijari.ts.
  const rib = extractRibMarocain(text);

  // Identification de la banque : le CODE BANQUE (3 premiers chiffres du RIB) fait
  // AUTORITÉ (plus fiable qu'un mot-clé OCR bruité) ; repli sur les mots-clés du texte.
  const identite = identifierBanque({ rib, texte: text });
  const banque = identite.id === "inconnue" ? "Banque (OCR)" : identite.nom;

  // Recherche d'un solde à partir de ses libellés. Le label peut être suivi d'une
  // date ("… AU 31/01/2024 …") AVANT le montant. Deux cas réels :
  //   • Banque Populaire : « SOLDE REPORT : 17 580,00 » → label + montant sur la
  //     MÊME ligne (1re ligne du tableau, sans date ni référence).
  //   • Attijariwafa : le montant n'est PAS sur la même ligne que le label —
  //     « SOLDE DEPART AU <date> » est dans une case, le montant dans la case
  //     au-dessus/en-dessous → il faut autoriser le saut de ligne.
  // On tente d'abord sur la même ligne (fiable), puis en franchissant les sauts
  // de ligne avec une fenêtre courte. Le quantificateur paresseux capture le 1er
  // montant « …,dd » qui suit le label : la date (sans décimales ,dd) est ignorée.
  const findSolde = (labels: string): number | null => {
    // Dans la fenêtre après le label, on RETIRE d'abord toute date (« SOLDE FINAL AU
    // 31 01 2026 12 500,00 ») : sinon l'année 2026 se colle à la partie entière du
    // montant → « 202612500 ». Puis on capte le 1er montant « …,dd ».
    const grab = (window: string): number | null => {
      const cleaned = window.replace(/\b\d{1,2}[\s\/.\-]\d{1,2}[\s\/.\-]\d{2,4}\b/g, " ");
      const amt = cleaned.match(/([\d  .]{1,12},\d{2})/);
      return amt ? mdParseMontant(amt[1]) : null;
    };
    const sl = text.match(new RegExp(`(?:${labels})([^\\n]{0,60})`, "i"));
    const slv = sl ? grab(sl[1]) : null;
    if (slv != null) return slv;
    const cl = text.match(new RegExp(`(?:${labels})([\\s\\S]{0,90})`, "i"));
    return cl ? grab(cl[1]) : null;
  };
  let solde_initial = findSolde(
    "solde\\s+depart|solde\\s+initial|ancien\\s+solde|solde\\s+report[eé]?|solde\\s+pr[eé]c[eé]dent|solde\\s+[àa]\\s+nouveau|report\\s+[àa]\\s+nouveau"
  ) ?? 0;
  let solde_final = findSolde(
    "solde\\s+final[e]?|solde\\s+[àa]\\s+reporter|nouveau\\s+solde|solde\\s+de\\s+cl[oô]ture|solde\\s+fin\\s+de\\s+p[eé]riode"
  ) ?? 0;

  const txs: ReleveMarkdownTx[] = [];
  let cols: MdCols | null = null;
  // Lignes de synthèse / solde qui ne sont PAS des transactions (test ligne complète,
  // sécurité si l'OCR décale le mot-clé hors de la colonne libellé). « TOTAL » n'est
  // pris qu'en contexte de synthèse (pas TotalEnergies).
  const NON_TX_KW = /\b(solde\s*report[eé]?|solde\s*[àa]\s*nouveau|report\s*[àa]\s*nouveau|ancien\s*solde|nouveau\s*solde|solde\s*pr[eé]c[eé]dent|solde\s*(initial|final|de\s*d[eé]part|de\s*cl[oô]ture)|report\s+au|totaux|sous[- ]?total|total\s+(des\s+)?(mouvements?|d[eé]bits?|cr[eé]dits?|op[eé]rations?)|total\s+g[eé]n[eé]ral)\b/i;
  // BORNE HAUTE — mots-clés du SOLDE INITIAL (BP : « SOLDE A NOUVEAU » / « REPORT A NOUVEAU »).
  const INIT_KW_SRC = "solde\\s*report[eé]?|solde\\s*[àa]\\s*nouveau|report\\s*[àa]\\s*nouveau|solde\\s*(?:de\\s*)?d[eé]part|ancien\\s*solde|solde\\s*initial|solde\\s*pr[eé]c[eé]dent|report\\s+au";
  // BORNE BASSE — mots-clés du SOLDE FINAL.
  const FINAL_KW_SRC = "nouveau\\s*solde|solde\\s*final|solde\\s*[àa]\\s*reporter|solde\\s*(?:de\\s*)?cl[oô]ture|solde\\s*fin\\s*de\\s*p[eé]riode";
  const SOLDE_INIT_KW = new RegExp(`\\b(?:${INIT_KW_SRC})\\b`, "i");
  const SOLDE_FINAL_KW = new RegExp(`\\b(?:${FINAL_KW_SRC})\\b`, "i");
  // ── RÈGLE 1 (filtre post-OCR sur le LIBELLÉ) : mots de solde/report (hors TOTAL
  // et ARRETE, présents dans de vraies transactions). Testé sur libellé normalisé.
  const LIBELLE_EXCLU = /\b(solde|report|reporter|ancien|nouveau|balance|depart)\b/;
  // ── « SOLDE AU <date> » / « SOLDE A REPORTER AU <date> » / « SOLDE FINAL AU <date> » :
  // ligne de solde dont la DATE fait partie du libellé (Crédit Agricole, Saham, CIH…),
  // reconnue MÊME sans les mots « final »/« reporter ». Avec référence vide, ce n'est
  // JAMAIS une transaction : c'est le solde d'ouverture (avant toute tx) ou de fin.
  const SOLDE_AU_DATE = /\bsolde\b.{0,22}?\bau\b\s*\d{1,2}[\s\/.\-]\d{1,2}[\s\/.\-]\d{2,4}/i;

  // Récupère le montant le plus à droite d'une ligne de solde (colonne solde sinon dernier nombre).
  const grabSolde = (cells: string[]): number | null => {
    let m = cols ? mdParseMontant(mdGetCell(cells, cols.solde)) : null;
    if (m === null) {
      for (let k = cells.length - 1; k >= 0; k--) {
        const v = mdParseMontant(cells[k]);
        if (v !== null) { m = v; break; }
      }
    }
    return m;
  };
  // Montant qui SUIT un mot-clé de solde : « SOLDE REPORT : 17 580,00 » → 17580.
  const soldeAmountAfter = (rowText: string, src: string): number | null => {
    const m = rowText.match(new RegExp(`(?:${src})\\s*[:\\-]?\\s*([\\d \\u00a0.]{1,15},\\d{2})`, "i"));
    return m ? mdParseMontant(m[1]) : null;
  };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("|") || !line.includes("|", 1)) continue; // pas une ligne de tableau

    const cells = mdSplitRow(line);
    if (mdIsSeparatorRow(cells)) continue;

    const detected = mdDetectColumns(cells);
    if (mdLooksLikeHeader(detected)) { cols = detected; continue; }
    if (!cols) continue; // données avant d'avoir vu un en-tête exploitable

    const date_operation = mdNormDate(mdGetCell(cells, cols.date_operation));
    const libelle = mdGetCell(cells, cols.libelle).trim();
    const rowText = cells.join(" ");

    // ── LIGNE DE SOLDE (report/départ/ancien OU final/reporter) ─────────────────
    // Détectée par mot-clé sur la ligne complète, AVEC OU SANS date. Le solde report
    // est typiquement une ligne « SOLDE REPORT : montant » SANS date → on extrait le
    // montant après les deux-points et on ne la compte JAMAIS comme transaction.
    const isInit = SOLDE_INIT_KW.test(rowText);
    const isFinal = SOLDE_FINAL_KW.test(rowText);
    const refCell = mdGetCell(cells, cols.reference).trim();

    // ── « SOLDE AU <date> » nu (sans « final »/« reporter »), colonne référence
    // vide → ligne de solde, jamais une transaction. Position dans le tableau :
    // avant toute transaction = solde d'ouverture ; après = solde de fin.
    if (!isInit && !isFinal && !refCell && SOLDE_AU_DATE.test(rowText)) {
      const a = grabSolde(cells);
      if (a !== null) {
        if (txs.length === 0 && !solde_initial) solde_initial = a;
        else solde_final = a;
      }
      continue; // ni transaction, ni report de libellé
    }

    if (isInit || isFinal) {
      if (isInit && !solde_initial) {
        const a = soldeAmountAfter(rowText, INIT_KW_SRC) ?? grabSolde(cells);
        if (a !== null) solde_initial = a;
      }
      if (isFinal) {
        const a = soldeAmountAfter(rowText, FINAL_KW_SRC) ?? grabSolde(cells);
        if (a !== null) solde_final = a;
      }
      // ── CAS FUSIONNÉ : Mistral colle le solde report ET la 1re transaction sur la
      // MÊME ligne (« SOLDE REPORT : 17580,00 … 24 07 2024 RETRAIT … 100,00 »).
      // On détecte la présence d'une date valide → on sépare : le solde (ci-dessus)
      // ET la transaction (date + libellé nettoyé + montant ≠ solde).
      if (date_operation) {
        // Repli sur le montant de solde le plus à droite quand aucun montant ne suit
        // directement le mot-clé (« SOLDE A REPORTER AU 31/12/2024   12 500,00 ») :
        // garantit que le montant du solde n'est JAMAIS pris pour une transaction.
        const soldeAmt = (isInit ? soldeAmountAfter(rowText, INIT_KW_SRC) : soldeAmountAfter(rowText, FINAL_KW_SRC)) ?? grabSolde(cells);
        const txLib = libelle
          .replace(new RegExp(`(?:${INIT_KW_SRC}|${FINAL_KW_SRC})\\s*[:\\-]?\\s*[\\d \\u00a0.]{1,15},\\d{2}`, "i"), "")
          .replace(new RegExp(`(?:${INIT_KW_SRC}|${FINAL_KW_SRC})`, "i"), "")
          .replace(/^[\s:.\-]+/, "")
          .trim();
        let md = mdParseMontant(mdGetCell(cells, cols.debit));
        let mc = mdParseMontant(mdGetCell(cells, cols.credit));
        if (md === null && mc === null && cols.debit === undefined && cols.credit === undefined) {
          const montant = mdParseMontant(mdGetCell(cells, cols.montant));
          if (montant !== null && montant !== soldeAmt) {
            if (mdLooksCredit(txLib)) mc = montant; else md = montant;
          }
        }
        // Ne jamais confondre le montant du solde avec celui de la transaction.
        if (md !== null && md === soldeAmt) md = null;
        if (mc !== null && mc === soldeAmt) mc = null;
        if ((md !== null || mc !== null) && txLib) {
          const dv = mdNormDate(mdGetCell(cells, cols.date_valeur)) || date_operation;
          const ref = mdGetCell(cells, cols.reference).trim() || mdRefFromLibelle(txLib);
          txs.push({ reference: ref, date_operation, date_valeur: dv, libelle: txLib, montant_debit: md, montant_credit: mc, solde_courant: null });
        }
      }
      continue; // la partie solde de la ligne n'est jamais une transaction
    }

    // ── Ligne SANS date (et sans mot-clé solde) = suite du libellé précédent ─────
    if (!date_operation) {
      if (libelle && txs.length > 0) txs[txs.length - 1].libelle = `${txs[txs.length - 1].libelle} ${libelle}`.trim();
      continue;
    }

    // ── Autres lignes de synthèse (totaux, balance) ─────────────────────────────
    const libNorm = mdStripAccentsLower(libelle);
    if (LIBELLE_EXCLU.test(libNorm) || NON_TX_KW.test(rowText)) continue;

    // ── TRANSACTION : montants lus DIRECTEMENT des colonnes, sans déplacement ────
    const date_valeur = mdNormDate(mdGetCell(cells, cols.date_valeur)) || date_operation;
    const reference = mdGetCell(cells, cols.reference).trim() || mdRefFromLibelle(libelle);
    const solde_courant = mdParseMontant(mdGetCell(cells, cols.solde));
    // Dernier montant numérique de la ligne = solde courant réel (colonne solde =
    // toujours la plus à droite), fiable même si l'OCR a décalé les colonnes.
    let solde_ligne: number | null = null;
    for (let k = cells.length - 1; k >= 0; k--) { const v = mdParseMontant(cells[k]); if (v !== null) { solde_ligne = v; break; } }

    let montant_debit = mdParseMontant(mdGetCell(cells, cols.debit));
    let montant_credit = mdParseMontant(mdGetCell(cells, cols.credit));

    // Seul cas où l'on déduit le sens : pas de colonnes débit/crédit séparées, juste
    // une colonne « Montant ». On classe par mots-clés du libellé (sans rien déplacer).
    if (montant_debit === null && montant_credit === null &&
        cols.debit === undefined && cols.credit === undefined) {
      const montant = mdParseMontant(mdGetCell(cells, cols.montant));
      if (montant !== null) {
        if (mdLooksCredit(libelle)) montant_credit = montant;
        else montant_debit = montant;
      }
    }

    txs.push({ reference, date_operation, date_valeur, libelle, montant_debit, montant_credit, solde_courant, solde_ligne });
  }

  // Déduplication PRUDENTE : on ne supprime QUE les doublons CONSÉCUTIFS exacts
  // (même date + libellé + montants + référence), seul artefact OCR fiable (une
  // ligne lue deux fois de suite). On NE déduplique JAMAIS à distance : deux
  // transactions de même montant — voire de même date et même libellé — situées
  // à des endroits différents du relevé sont de VRAIES opérations distinctes et
  // doivent TOUTES être conservées. Aucune transaction réelle ne doit être perdue.
  const txKey = (t: ReleveMarkdownTx) =>
    `${t.date_operation}|${t.libelle.toUpperCase().replace(/\s+/g, "").slice(0, 40)}|${t.montant_debit ?? "x"}|${t.montant_credit ?? "x"}|${(t.reference || "").toUpperCase().replace(/\s+/g, "")}`;
  const txsUniq = txs.filter((t, i) => i === 0 || txKey(t) !== txKey(txs[i - 1]));

  const controle = controleSoldeReleve(solde_initial, solde_final, txsUniq, banque);

  return { banque, rib, solde_initial, solde_final, txs: txsUniq, controle };
}

// ─── Contrôle de cohérence du solde (reconstruction ligne par ligne) ─────────
// Banque Populaire (et la plupart des relevés marocains) vérifient l'identité :
//     solde_final = solde_initial(signé) + Σ crédits − Σ débits
// Le « SOLDE A REPORTER » est affiché en VALEUR ABSOLUE (sans signe) : le compte
// peut être créditeur (+) ou débiteur (−). On reconstruit donc le solde pas à
// pas depuis le solde de départ, en testant les DEUX conventions de signe du
// solde initial (créditeur : +SI ; débiteur : −SI, d'où Σcrédits − Σdébits − SI),
// et on retient celle dont la valeur absolue colle au solde de fin scanné.
// Un écart résiduel > tolérance trahit une transaction manquante / mal lue.
const RELEVE_TOL = 1; // tolérance d'arrondi en MAD
export function controleSoldeReleve(
  soldeInitialScanne: number,
  soldeFinalScanne: number,
  txs: ReleveMarkdownTx[],
  banque?: string,
): ReleveControle {
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const total_debit = round2(txs.reduce((s, t) => s + (t.montant_debit ?? 0), 0));
  const total_credit = round2(txs.reduce((s, t) => s + (t.montant_credit ?? 0), 0));
  const flux = round2(total_credit - total_debit); // Σ crédits − Σ débits

  const finalCrediteur = round2(soldeInitialScanne + flux);  // +SI (identité comptable standard)
  const finalDebiteur = round2(-soldeInitialScanne + flux);  // −SI (compte débiteur)
  const controlable = soldeFinalScanne > 0; // sans solde de fin lisible : contrôle impossible

  // La convention DÉBITEUR (comparer les valeurs absolues) n'est nécessaire que pour
  // les banques qui affichent le « solde à reporter » SANS signe — cas de la Banque
  // Populaire. Pour Attijariwafa (et les autres), le solde est SIGNÉ correctement :
  //   solde_final = solde_initial(écrit) + Σ crédits − Σ débits  (convention créditeur).
  // On ne teste donc l'hypothèse débiteur que pour la Banque Populaire.
  const bpSansSigne = /banque\s+populaire|populaire|chaabi|\bbcp\b|\bgbp\b/i.test(banque ?? "");
  const ecartCred = Math.abs(Math.abs(finalCrediteur) - soldeFinalScanne);
  const ecartDeb = Math.abs(Math.abs(finalDebiteur) - soldeFinalScanne);
  const debiteurMeilleur = bpSansSigne && soldeInitialScanne > 0 && ecartDeb < ecartCred;
  const sens: "crediteur" | "debiteur" = debiteurMeilleur ? "debiteur" : "crediteur";
  const solde_final_calcule = debiteurMeilleur ? finalDebiteur : finalCrediteur;
  const ecart = round2(debiteurMeilleur ? ecartDeb : ecartCred);

  // Reconstruction pas à pas : annote chaque transaction de son solde courant
  // calculé (utile pour localiser la ligne où l'écart apparaît côté appelant).
  let running = debiteurMeilleur ? -soldeInitialScanne : soldeInitialScanne;
  for (const t of txs) {
    running = round2(running + (t.montant_credit ?? 0) - (t.montant_debit ?? 0));
    t.solde_calcule = running;
  }

  return {
    solde_initial: soldeInitialScanne,
    total_debit,
    total_credit,
    solde_final_calcule,
    solde_final_scanne: soldeFinalScanne,
    ecart,
    sens,
    coherent: controlable && ecart <= RELEVE_TOL,
    controlable,
  };
}

export function buildOcrPrompt(dossierNom: string, dossierIce: string, text: string | null): string {
  return `Extrais les données de cette facture marocaine. JSON uniquement, aucun texte avant/après.

SOCIÉTÉ GÉRÉE: "${dossierNom}" (ICE: "${dossierIce}")

═══════════════════════════════════════════════════════════════════════════
RÈGLES STRICTES DE CLASSIFICATION (PRIORITÉ ABSOLUE — ANTI-HALLUCINATION)
Ces règles l'emportent sur toute autre déduction. Ne JAMAIS les contredire.

[TYPE DE DOCUMENT]
- Si le document contient "loyer", "bailleur", "locataire", "quittance de loyer"
  ou "avis d'échéance" → type_document_justificatif = "quittance_loyer"
  (et JAMAIS "recu" / "facture").
- Si station-service OU mention "Gazole" / "Sans plomb" / "Diesel" / "Essence"
  → type_document_justificatif = "recu".

[PLAN COMPTABLE MAROCAIN (PCM) — compte_pcm imposé]
- "quittance_loyer" → compte_pcm = "61312" (Locations de constructions).
  JAMAIS "61311" (terrains) SAUF mention explicite d'un terrain / terrain nu.
- Frais / commissions bancaires — émetteur banque (BP, Banque Populaire, ATW,
  Attijariwafa, BMCE, Bank of Africa, BMCI, CIH, CFG, Crédit du Maroc, SGMB…)
  → compte_pcm = "6147".
- Carburant (station-service, Gazole, Sans plomb, Diesel, Essence)
  → compte_pcm = "61251".
- Eau / Électricité (Lydec, Amendis, ONEE, ONEP, Redal, Radeema, Radeef…)
  → compte_pcm = "61252".
- CNSS / Sécurité Sociale — émetteur = "CAISSE NATIONALE DE SÉCURITÉ SOCIALE",
  ou mention "CNSS" / "Bordereau de paiement CNSS" / "Déclaration CNSS" /
  "Sécurité Sociale" / "cotisations sociales" → compte_pcm = "6174"
  ET categorie_pcm = "charges_sociales". PRIORITÉ ABSOLUE : ne JAMAIS classer
  la CNSS en 6147, en "assurance" (6161) ni en frais bancaires.
  ⚠️ La "CAISSE NATIONALE DE CRÉDIT AGRICOLE" (CNCA) est une BANQUE, PAS la CNSS.
═══════════════════════════════════════════════════════════════════════════

RÈGLES:
- ÉMETTEUR = société en en-tête avec RC/IF/ICE
- CLIENT = après "Client:", "Facturer à:", "Bill to:", bloc CLIENT
- sens_facture: "client" si ${dossierNom} est émetteur, "fournisseur" si ${dossierNom} est le client/acheteur, sinon "inconnu"
  RÈGLE ABSOLUE : pour tout document de type "recu", "addition", "ticket de caisse", "receipt" → sens_facture = "fournisseur" TOUJOURS, même si le document affiche "Customer:", "Table:", "Served to:" — ce sont des dépenses, jamais des ventes.
- numero: N° du document — labels reconnus : "N° Facture", "N° Reçu", "Réf.", "Référence", "Receipt:", "Receipt N°", "Receipt #", "Ticket N°", "Ticket:", "Order #", "Check #", "Reçu N°", "N°", "Ref" — retourner la valeur exacte qui suit le label, sans le label lui-même (ex: "Receipt: 123456" → "123456")
  · AVIS DE DÉBIT BANCAIRE (droits de timbre, frais et taxes sur effets/chèques) — RÈGLE DE PRIORITÉ :
    SI le libellé mentionne une remise d'effet, une LCN ou un chèque (ex: "REMISE LCN N° 630238", "CHÈQUE N° 12345") → IGNORE le numéro d'avis interne de la banque et retourne le numéro de la LCN ou du chèque dans "numero" — c'est CE numéro qui apparaît sur le relevé bancaire du client et sert au rapprochement bancaire.
    SINON → retourne le "N° d'opération" / "N° opération" / "N° d'avis" / "N° avis" dans "numero"
- type_facture: "acompte" si mots acompte/avance/accompte présents, "avoir" si avoir/remboursement, "standard" sinon
- type_document_justificatif: "avis_debit" si le document contient "DROIT DE TIMBRE" / "DROITS DE TIMBRE" / "REMISE LCN" / "LETTRE DE CHANGE" / "TIMBRE FISCAL" / "AVIS DE DÉBIT" / "AVIS DE DEBIT", "dum" si "DÉCLARATION UNIQUE DES MARCHANDISES" / "DUM" / "QUITTANCE DOUANIÈRE" / "BUREAU DE DOUANE", "bon_livraison" si titre = "BON DE LIVRAISON" / "BL" / "Delivery Note", "bon_commande" si "BON DE COMMANDE" / "BC" / "Purchase Order", "note_frais" si "NOTE DE FRAIS" / "NDF", "addition" si "ADDITION" / "TICKET DE CAISSE" / "TICKET RESTO" / "TICKET RESTAURANT", "quittance_elec" si "FACTURE ELECTRICITE" / "FACTURE ÉLECTRICITÉ" / "CONSOMMATION ELECTRIQUE" / "CONSOMMATION ÉLECTRIQUE" (même si l'émetteur est ONEE/LYDEC/REDAL/AMENDIS/RADEEMA), "quittance_eau" si émetteur = "ONEE" / "LYDEC" / "REDAL" / "AMENDIS" / "RADEEMA" ou si "FACTURE EAU" / "CONSOMMATION EAU", "quittance_loyer" si "LOYER" / "BAILLEUR" / "LOCATAIRE" / "QUITTANCE DE LOYER" / "AVIS D'ÉCHÉANCE", "recu" si "REÇU" / "RECU" / "RECEIPT" / "REÇU DE CAISSE" / "QUITTANCE" / "REÇU DE PAIEMENT" / "REÇU N°", "facture" sinon
- categorie_pcm: déduire OBLIGATOIREMENT depuis le nom de l'émetteur, les articles/désignations et la description du document. Utiliser exactement l'une de ces valeurs :
  · "frais_representation" → restaurant, café, brasserie, pizzeria, snack, fast-food, hôtel (repas/resto), réception, traiteur, pâtisserie, salon de thé — ou si les articles sont des plats/boissons/repas
  · "gasoil" → station-service, gasoil, carburant, essence, diesel, Shell, Total, Afriquia, Ziz, Winxo, Petrom — ou si articles = carburant/lubrifiants
  · "transport" → taxi, transport, livraison, messagerie, Amana, DHL, FedEx, courrier, fret, Supratours, CTM — ou articles = frais de port/livraison
  · "telecom" → téléphone, internet, Maroc Telecom, Orange, Inwi, ADSL, mobile, forfait, recharge — ou articles = abonnement télécom
  · "eau_electricite" → ONEE, LYDEC, RADEEF, RADEM, RADEEM, eau, électricité, énergie — ou articles = consommation eau/électricité
  · "loyers" → loyer, location, bail, gérance, loyer commercial
  · "assurance" → assurance, Wafa Assurance, AXA, RMA, Allianz, SAHAM, police, prime d'assurance
  · "charges_sociales" → CNSS, Caisse Nationale de Sécurité Sociale, Sécurité Sociale, cotisations sociales, bordereau / déclaration CNSS (compte 6174). NE PAS confondre avec "assurance" (compagnie privée) ni avec la CNCA (banque)
  · "entretien" → maintenance, réparation, pièces détachées, atelier, garage, dépannage, révision
  · "frais_bancaires" → banque, commission bancaire, frais de tenue, CIH, Attijariwafa, BMCE, BMCI, Banque Populaire, CFG, frais bancaires
  · "encaissement_client" → uniquement si sens_facture = "client" (on émet la facture)
  · "tva_import" → DUM, déclaration douanière, importation, quittance douanière, dédouanement
  · "droits_timbre" → DROIT DE TIMBRE / DROITS DE TIMBRE / REMISE LCN / LETTRE DE CHANGE / TIMBRE FISCAL — taxe fiscale, hors TVA, hors EDI DGI (compte 61671)
  · "acompte_fournisseur" → bon de commande, acompte, avance fournisseur (type_document = "bon_commande")
  · "paiement_fournisseur" → achat de marchandises, fournitures, matières premières, prestation générale non classifiable ci-dessus
- compte_pcm: code comptable PCM selon type_document_justificatif (respecter les RÈGLES STRICTES ci-dessus en priorité absolue) :
  · "quittance_loyer" → "61312" (Locations de constructions ; JAMAIS "61311" sauf terrain explicite)
  · "quittance_eau" → "61252" ET taux_tva = 7
  · "quittance_elec" → "61252" ET taux_tva = 14
  · "recu" → selon la nature de la dépense : "6147" si restaurant/café/repas, "61251" si carburant/station-service, "6141" sinon
  · frais/commissions bancaires (émetteur = banque : BP, ATW, BMCE, CIH…) → "6147"
  · CNSS / Sécurité Sociale (categorie_pcm = "charges_sociales") → "6174" (RÈGLE STRICTE, priorité absolue)
  · tout autre type → null
- periode / numero_compteur (UNIQUEMENT pour quittance_eau et quittance_elec) : extraire OBLIGATOIREMENT le montant, la période de consommation (label "Période", "Mois", ex: "01/2025", "Janvier 2025" — retourner telle quelle) et le numéro de compteur (label "N° Compteur", "Compteur", "N° Contrat") → null si absents
- DATES — deux champs distincts à identifier OBLIGATOIREMENT pour les BL et BC :

  CHAMP "date" (= date d'émission du document) :
  · C'est la date à laquelle le document a été créé/émis.
  · Elle apparaît EN HAUT du document, typiquement sous la forme : "[Ville], le [date]"
    Exemples : "Casablanca, le 15/01/2025" | "Rabat, le 10 janvier 2025" | "Marrakech, le 05-03-2025"
  · Le mot-clé "le" suivi d'une date, précédé d'un nom de ville, est le signal fort de cette date.
  · Si tu ne trouves pas ce pattern "Ville, le [date]" → cherche un label "Date d'émission :", "Date BL :", "Date BC :", "Établi le :" dans l'en-tête uniquement.

  CHAMP "date_commande" (= date de la commande référencée) :
  · C'est la date qui apparaît ASSOCIÉE AU NUMÉRO DE COMMANDE — sur la même ligne ou sur la ligne juste en dessous.
  · Pattern à détecter OBLIGATOIREMENT : si tu vois "N° de la commande", "N° commande", "Réf. commande", "Bon de commande N°", suivi ou précédé d'un numéro, ET qu'une date ("Date :", "Date de commande :") apparaît sur la MÊME LIGNE ou la ligne IMMÉDIATEMENT SUIVANTE → c'est date_commande.
  · Exemple typique sur un BL :
      N° de la commande : BC-2024-042
      Date : 10/01/2025          ← ceci est date_commande = "2025-01-10"
  · Si absente → null. Ne jamais mettre cette date dans le champ "date".

  RÈGLE ANTI-CONFUSION : si tu trouves deux dates, l'une en haut du document et l'autre près du N° de commande → "date" = celle d'en haut, "date_commande" = celle près du N° de commande. Ne jamais les inverser.
  CETTE DATE ("date") EST DIFFÉRENTE de la date_commande — elles ne peuvent PAS être identiques sauf coïncidence réelle.

  Autres champs date :
  · date_echeance : label "Échéance", "À régler avant le", "Date limite de paiement" → null si absent.
  · Toutes les autres dates → tableau dates_reference. Chaque entrée : {"valeur":"YYYY-MM-DD","libelle":"label original tel qu'il apparaît dans le document"} — ne pas traduire ni interpréter le libellé, le retourner mot pour mot.
  · Si aucun label textuel autour d'une date → libelle: "date inconnue".
  · Conversion universelle vers YYYY-MM-DD :
    - Formats numériques : DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY → toujours DD avant MM
    - Dates en toutes lettres : identifier séparément (1) le jour = nombre ordinal 1-31, (2) le mois = mot à convertir, (3) l'année = nombre à 4 chiffres. Ne jamais inverser jour et mois quelle que soit la langue du document. Si ambiguïté → privilégier l'ordre naturel de la langue du document (FR/AR : jour-mois-année).
    - RÈGLE CRITIQUE — JOUR À DEUX CHIFFRES : lire le jour comme un seul nombre entier. "15" = quinze (pas "1" suivi de "5"). "10" = dix (pas "1" seul). "05" = cinq. Ne jamais tronquer le jour au premier chiffre. Exemple : "le 15 janvier 2025" → jour=15, pas jour=1.
    - Mois FR : janvier=01 février=02 mars=03 avril=04 mai=05 juin=06 juillet=07 août=08 septembre=09 octobre=10 novembre=11 décembre=12
    - Mois EN : january=01 february=02 march=03 april=04 may=05 june=06 july=07 august=08 september=09 october=10 november=11 december=12
    - Année 2 chiffres : 00-30 → 20xx, 31-99 → 19xx
  · ICE = 15 chiffres exactement.
- taux_tva: retourne la valeur LUE sur la facture (0, 7, 10, 14 ou 20). Si absent ou illisible → retourne null. JAMAIS 20 par défaut. 0% est une valeur valide (exonéré, franchise).
- mode_reglement: détecter depuis la facture: "carte"|"cheque"|"virement"|"especes"|"prelevement" — si absent mettre "virement"
- MONTANTS: extrais prioritairement les montants écrits dans le bloc totaux en bas du document (HT, TVA, Net à payer/TTC) — ne recalcule JAMAIS ces valeurs toi-même, sauf si ce bloc est totalement absent ou illisible
- LIGNES DE DÉTAIL: sauf mention explicite contraire (ex: "P.U. TTC"), le Prix Unitaire et le Total de chaque ligne sont toujours en Hors Taxes (HT) — utilise ces valeurs directement dans prix_unitaire_ht et total_ht
- NOMS ILLISIBLES: si un nom d'émetteur ou de client est masqué (barre colorée CamScanner, tampon, zone floutée) ou totalement illisible, renvoie null pour ce champ — ne devine jamais et n'invente pas un nom

RÈGLES CRITIQUES POUR FACTURE ACOMPTE:
Une facture acompte contient DEUX montants distincts:
1. Le montant de l'acompte (ce que le client paie maintenant) → c'est montant_ttc
2. Le montant total de la commande (montant global du contrat) → c'est montant_commande_total_ttc
3. Le reliquat (total - acompte) → c'est montant_restant_du

COMMENT IDENTIFIER:
- montant_ttc = ligne "Net à payer" OU "Montant acompte" OU "Total TTC" de CETTE facture = le plus petit montant
- montant_commande_total_ttc = ligne "Montant total commande" OU "Montant total marché" = le plus grand montant
- montant_restant_du = ligne "Reste à payer" OU "Reliquat" = différence entre les deux
- NE JAMAIS mettre le montant total commande dans montant_ttc pour une facture acompte
${text ? `\nTEXTE FACTURE:\n${text.slice(0, 2000)}` : `
INSTRUCTIONS LECTURE IMAGE SCANNÉE (PRIORITÉ ABSOLUE):
- Lis chaque chiffre individuellement — ne confonds pas 1/7, 0/6, 3/8, 5/6
- Montants: repère d'abord le bloc totaux en bas (Total HT, TVA xx%, Total TTC / Net à payer) — lis le nombre exact à droite de chaque ligne, ne recalcule pas
- Prix unitaire: lis la colonne "P.U." / "Prix unitaire" / "P.U. HT" ligne par ligne — valeur HT sauf si "P.U. TTC" est explicitement écrit
- Quantité × Prix unitaire HT = Total HT ligne (vérifie pour les lignes de détail uniquement, pas pour les totaux)
- Dates: cherche "Date:" ou "Le:" — format JJ/MM/AAAA → convertis en AAAA-MM-JJ
- Date d'échéance: cherche "Échéance", "À régler avant le", "Date limite" — sinon null
- Taux TVA marocains valides: 0%, 7%, 10%, 14%, 20% — identifie lequel est sur la facture`}

JSON EXACT (remplace les valeurs):
{"sens_facture":"client","emetteur_nom":"","emetteur_ice":null,"client_nom":"","client_ice":null,"client_adresse":null,"numero":null,"date":null,"date_echeance":null,"date_commande":null,"dates_reference":[],"type_facture":"standard","type_document_justificatif":"facture","categorie_pcm":"paiement_fournisseur","compte_pcm":null,"periode":null,"numero_compteur":null,"numero_commande":null,"numero_acompte":null,"montant_ht":0,"montant_tva":0,"taux_tva":null,"montant_ttc":0,"montant_commande_total_ht":null,"montant_commande_total_ttc":null,"montant_restant_du":null,"description":"","mode_reglement":"virement","lignes":[{"description":"","quantite":1,"prix_unitaire_ht":0,"total_ht":0,"taux_tva":null}]}`;
}
