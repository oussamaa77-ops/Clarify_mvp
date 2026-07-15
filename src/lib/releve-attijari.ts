// ============================================================================
// releve-attijari.ts — Preprocessing HEURISTIQUE des relevés Attijariwafa (ATW).
//
// Les relevés ATW (surtout scannés CamScanner) cassent les regex mono-ligne :
// espaces aléatoires, caractères OCR mal reconnus (O↔0, l/I↔1, S↔5, B↔8),
// transactions étalées sur plusieurs lignes, colonnes désalignées. Plutôt qu'un
// méga-regex, on procède en étapes robustes et tolérantes :
//
//   (1) détecter les lignes portant une DATE valide (jj mm aaaa + variantes OCR)
//   (2) détecter les MONTANTS (avec/sans signe, "1 234,56" / "-1234.56" …)
//   (3) REGROUPER les lignes suivantes sans date → transactions multi-lignes
//   (4) NETTOYER espaces / caractères bruités / alignements cassés
//   (5) déduire DÉBIT/CRÉDIT (signe → delta de solde → mots-clés → défaut)
//   (6) IGNORER les lignes non transactionnelles (en-têtes, soldes, mentions)
//
// Sortie : blocs de transactions semi-structurés, prêts pour le LLM (même forme
// que parserTransactions). Chaque bloc garde ses métadonnées de debug (_raw…).
// ============================================================================

export interface RawTx {
  ligne: number;
  date_operation: string;   // JJ/MM/AAAA
  date_valeur: string;
  reference: string;
  nature_operation: string;
  montant_debit: number | null;
  montant_credit: number | null;
}

export interface AtwBlock extends RawTx {
  _raw: string;                                                     // lignes brutes du bloc (debug)
  _amounts: number[];                                              // montants candidats détectés
  _sens_source: "signe" | "solde-delta" | "keyword" | "defaut";   // origine de la décision débit/crédit
}

export interface AtwParseOptions {
  year?: number;                 // année par défaut si absente d'une date
  soldeInitial?: number | null;  // pour la détection débit/crédit par delta de solde
  debug?: boolean;               // logs détaillés (true par défaut)
}

// ── Extraction du RIB marocain (24 chiffres) — robuste ATW ───────────────────
// Le RIB marocain = 24 chiffres : 3 (banque) + 3 (ville) + 16 (compte) + 2 (clé).
// Les relevés ATW l'affichent dans un champ « RELEVE D'IDENTITE BANCAIRE » AU-DESSUS
// du tableau, souvent découpé (Code Banque | Code Ville | N° Compte | Clé) et séparé
// par des tirets/slashs/pipes/gras markdown ("007-780-…-67", cellules « | 007 | 780 |
// … | 67 | »). Deux stratégies :
//   (1) ANCRÉE SUR LE LABEL, insensible aux séparateurs : à partir du label, on isole
//       les tokens numériques (≥1 vrai chiffre, réparés OCR) et on les concatène jusqu'à
//       EXACTEMENT 24 chiffres avec un code banque valide — quels que soient les séparateurs.
//   (2) REPLI : scan « run contigu » sur tout le texte (relevés SANS label explicite).
// Retourne le RIB formaté « xxx xxx xxxxxxxxxxxxxxxx xx » ou "" si introuvable.
const RIB_NBSP = /[   ]/g;
const ribRepair = (s: string) => s
  .replace(/[OoQ]/g, "0").replace(/[lI!]/g, "1").replace(/[Ss]/g, "5")
  .replace(/B/g, "8").replace(/[gq]/g, "9").replace(/\D/g, "");
const ribIsBankCode = (d: string) => { const c = parseInt(d.slice(0, 3), 10); return c >= 1 && c <= 399; };
const ribFmt = (d: string) => `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6, 22)} ${d.slice(22)}`;
const RIB_LABELS_SRC =
  "relev[eé]\\s*d['’]?\\s*identit[eé]\\s+bancaire|identit[eé]\\s+bancaire|R\\.?\\s?I\\.?\\s?B\\.?|IBAN|" +
  "compte\\s+bancaire|num[eé]ro\\s+(?:de\\s+)?compte|n[°ºo]?\\s*(?:de\\s*)?compte|compte\\s*n[°ºo]";

function ribFromTokens(win: string): string | null {
  const toks = (win.match(/[0-9OoQlI!SsBgq]+/g) ?? [])
    .filter((t) => /[0-9]/.test(t))   // ignore les mots (Code, Ville, Compte, Clé…)
    .map(ribRepair)
    .filter((d) => d.length > 0);
  for (let start = 0; start < toks.length; start++) {
    let acc = "";
    for (let j = start; j < toks.length; j++) {
      acc += toks[j];
      if (acc.length === 24) { if (ribIsBankCode(acc)) return acc; break; }
      if (acc.length > 24) break;
    }
  }
  return null;
}

export function extractRibMarocain(rawText: string): string {
  const text = rawText.replace(RIB_NBSP, " ");
  const labelRe = new RegExp(`(?:${RIB_LABELS_SRC})`, "gi");

  // Stratégie 1 : ancrée sur le label (couvre le champ ATW multi-cellules/séparateurs).
  let lm: RegExpExecArray | null;
  while ((lm = labelRe.exec(text)) !== null) {
    // Fenêtre après le label : englobe l'éventuelle ligne d'en-tête du bloc RIB
    // (Code Banque / Ville / Compte / Clé) puis la ligne des valeurs.
    const win = text.slice(lm.index + lm[0].length, lm.index + lm[0].length + 200);
    const d = ribFromTokens(win);
    if (d) return ribFmt(d);
  }

  // Stratégie 2 : scan « run contigu » (24 chiffres exacts + code banque valide).
  const candidates: { digits: string; index: number }[] = [];
  const RUN = /[\dOoQlI!SsBgq][\dOoQlI!SsBgq |.]{20,52}[\dOoQlI!SsBgq]/g;
  let m: RegExpExecArray | null;
  while ((m = RUN.exec(text)) !== null) {
    const d = ribRepair(m[0]);
    if (d.length === 24 && ribIsBankCode(d)) candidates.push({ digits: d, index: m.index });
  }
  if (candidates.length === 0) return "";
  labelRe.lastIndex = 0;
  while ((lm = labelRe.exec(text)) !== null) {
    const near = candidates.find((c) => c.index >= lm!.index && c.index - lm!.index < 140);
    if (near) return ribFmt(near.digits);
  }
  return ribFmt(candidates[0].digits);
}

// ── Étape 4 : nettoyage OCR ──────────────────────────────────────────────────
export function cleanOcrText(line: string): string {
  return line
    .replace(/ /g, " ")            // espace insécable
    .replace(/[\t\r\f\v]+/g, " ")
    .replace(/[·•◦∙|¦]/g, " ")           // puces / barres verticales bruitées
    .replace(/[^\S\n]{2,}/g, " ")        // espaces multiples → 1
    .replace(/\s+/g, " ")
    .trim();
}

// Répare les confusions OCR fréquentes DANS un token censé être numérique.
function repairDigits(tok: string): string {
  return tok
    .replace(/[OoQ]/g, "0")
    .replace(/[lI|!]/g, "1")
    .replace(/[Ss]/g, "5")
    .replace(/B/g, "8")
    .replace(/[gq]/g, "9")
    .replace(/[^\d]/g, "");
}

// ── Étape 1 : détection de dates tolérante OCR ───────────────────────────────
export interface DateHit { day: number; month: number; year: number | null; index: number; end: number; }

// Séparateur : / . - ou espace(s). Chiffres tolèrent quelques lettres OCR.
const DIGITISH = String.raw`[0-9OoQlI|!SsBgq]`;
const DATE_RE = new RegExp(
  String.raw`(?<![0-9])(${DIGITISH}{1,2})\s*[\/.\-\s]\s*(${DIGITISH}{1,2})(?:\s*[\/.\-\s]\s*(${DIGITISH}{2,4}))?(?![0-9])`,
  "g",
);

export function detectDates(line: string): DateHit[] {
  const hits: DateHit[] = [];
  DATE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DATE_RE.exec(line)) !== null) {
    const day = Number(repairDigits(m[1]));
    const month = Number(repairDigits(m[2]));
    const yRaw = m[3] ? repairDigits(m[3]) : "";
    let year: number | null = null;
    if (yRaw) {
      const y = Number(yRaw);
      year = y < 100 ? 2000 + y : y;
    }
    // Validation métier : jour 1-31, mois 1-12, année plausible.
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12 && (year === null || (year >= 2000 && year <= 2100))) {
      hits.push({ day, month, year, index: m.index, end: m.index + m[0].length });
    } else {
      // Match invalide (ex: "24 l6" issu d'un code+date collés) : on ne consomme
      // pas tout le motif → on relance 1 caractère plus loin pour capter le vrai
      // date qui chevauche (ex: "l6 O3").
      DATE_RE.lastIndex = m.index + 1;
    }
  }
  return hits;
}

// ── Étape 2 : détection de montants ──────────────────────────────────────────
export interface AmountHit { value: number; negative: boolean; index: number; end: number; raw: string; }

// Un montant a TOUJOURS 2 décimales (",dd" ou ".dd"), éventuellement des milliers
// séparés par espace/point, et un signe optionnel (- ou +, y compris − OCR). La
// partie entière tolère les confusions OCR (O↔0, l↔1…) MAIS un garde-fou exige au
// moins un vrai chiffre → on n'attrape jamais un simple mot du libellé.
const AMT_DIGITISH = String.raw`[0-9OoQlI!SsBgq]`;
// Le lookbehind (?<![\d.,]) empêche de démarrer AU MILIEU d'un nombre plus long
// (ex: l'année "20|24" collée au montant "234,50" ne doit pas donner "24 234,50").
const AMOUNT_RE = new RegExp(
  String.raw`(?<![\d.,])([-−–+])?\s?(${AMT_DIGITISH}{1,3}(?:[ .]${AMT_DIGITISH}{3})+|${AMT_DIGITISH}{1,9})\s?([.,])(\d{2})(?![0-9])`,
  "g",
);

function parseAmountRaw(intPart: string, dec: string): number {
  const digits = repairDigits(intPart); // répare OCR + retire séparateurs de milliers
  return Number(`${digits}.${dec}`);
}

export function detectAmounts(line: string): AmountHit[] {
  const hits: AmountHit[] = [];
  AMOUNT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = AMOUNT_RE.exec(line)) !== null) {
    if (!/[0-9]/.test(m[2])) continue;                 // garde-fou : au moins un vrai chiffre
    const sign = m[1] ?? "";
    const value = parseAmountRaw(m[2], m[4]);
    if (!Number.isFinite(value) || value <= 0) continue;
    hits.push({
      value,
      negative: sign === "-" || sign === "−" || sign === "–",
      index: m.index,
      end: m.index + m[0].length,
      raw: m[0].trim(),
    });
  }
  return hits;
}

// ── Étape 6 : lignes non transactionnelles ───────────────────────────────────
const NON_TX_KW = [
  "solde depart", "solde initial", "solde final", "solde a reporter", "ancien solde",
  "nouveau solde", "report", "total mouvement", "total des", "sous total",
  "attijariwafa", "banque populaire", "cih bank", "agence", "adresse",
  "extrait de compte", "releve de compte", "code banque", "date oper", "date valeur",
  "libelle", "montant", "debit credit", "page ", "www.", "sa au capital",
  "ice :", "rc :", "if :", "titulaire", "morocco", "maroc", "rib", "n° compte",
  "numero de compte", "devise", "arrete", "edition",
];

// Détecte une ligne d'en-tête / solde / mention légale (à ignorer comme début de tx).
export function isNonTransactional(line: string): boolean {
  const low = line.toLowerCase();
  if (NON_TX_KW.some((k) => low.includes(k))) return true;
  if (/^[؀-ۿ\s,.:؛،-]+$/.test(line)) return true;   // ligne 100% arabe
  if (/^[\s*_=.\-–—]+$/.test(line)) return true;             // séparateurs graphiques
  if (line.replace(/\s/g, "").length < 4) return true;        // trop courte
  return false;
}

// ── Mots-clés crédit (fallback direction) ────────────────────────────────────
const CREDIT_KW = [
  "VIRT RECU", "VIR RECU", "VIREMENT RECU", "VIR REC", "RECU DE",
  "VERSEMENT", "DEPOT", "REMISE CHEQUE", "REMISE CHQ", "REM CHQ", "REMISE CB",
  "REMISE ESP", "ENCAISSEMENT", "RECOUVREMENT", "AVIS DE CREDIT", "AVOIR",
  "INTERETS CRED", "INTERET CRED", "CREDIT VIREMENT", "CREDIT COMPTE",
];

const fmtDate = (d: number, m: number, y: number) =>
  `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${y}`;

// Retire du texte les tokens déjà consommés (code, dates, montants) → libellé propre.
// On MASQUE les spans VALIDÉS de dates/montants (via leurs index) plutôt que de
// faire un .replace(regex) brut — ce dernier grignoterait les chiffres des montants
// (ex: DATE_RE capturant "15 00" dans "15 000,00").
function extractReferenceAndLibelle(blockText: string): { reference: string; libelle: string } {
  let s = blockText;
  // Référence = token alphanum (avec au moins un chiffre) en tête de bloc.
  let reference = "";
  const mRef = s.match(/^\s*([A-Z0-9]{4,20})\b/);
  if (mRef && /\d/.test(mRef[1]) && /[A-Z]/i.test(mRef[1])) {
    reference = mRef[1];
    s = s.slice(mRef[0].length);
  }
  // Masque les emplacements des dates et montants réellement détectés.
  const spans: Array<[number, number]> = [
    ...detectDates(s).map((d) => [d.index, d.end] as [number, number]),
    ...detectAmounts(s).map((a) => [a.index, a.end] as [number, number]),
  ];
  const chars = s.split("");
  for (const [i, e] of spans) for (let k = i; k < e && k < chars.length; k++) chars[k] = " ";
  const out = chars.join("")
    .replace(/\s[,.]+(?=\s|$)/g, " ")   // séparateurs orphelins laissés par le masquage
    .replace(/\s*-\s*$/, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return { reference, libelle: out };
}

// ── Orchestrateur : texte ATW → blocs de transactions ────────────────────────
export function parseAttijariReleve(text: string, opts: AtwParseOptions = {}): { txs: AtwBlock[] } {
  const debug = opts.debug !== false;
  const defaultYear = opts.year ?? new Date().getFullYear();

  // Année dominante du relevé (si une date complète existe quelque part).
  let refYear = defaultYear;
  const yMatch = text.match(/\b(20\d{2})\b/);
  if (yMatch) refYear = Number(yMatch[1]);

  const rawLines = text.split(/\n/).map(cleanOcrText).filter((l) => l.length > 0);

  // Étapes 1+3+6 : découpage en BLOCS (une date en tête = nouvelle transaction).
  type Group = { lines: string[] };
  const groups: Group[] = [];
  let current: Group | null = null;

  for (const line of rawLines) {
    if (isNonTransactional(line)) {
      // Une ligne d'en-tête/solde clôt le bloc courant sans en ouvrir un nouveau.
      current = null;
      continue;
    }
    const dates = detectDates(line);
    // Début de bloc : une date en DÉBUT de ligne (après un éventuel code ≤ ~10 car).
    const startsBlock = dates.length > 0 && dates[0].index <= 12;
    // Une transaction n'est COMPLÈTE qu'une fois son montant trouvé. Tant que le
    // bloc courant n'a pas de montant, une ligne « date + montant » (souvent la
    // date valeur sur sa propre ligne) le COMPLÈTE au lieu d'ouvrir une nouvelle tx.
    const currentIncomplete = current !== null && detectAmounts(current.lines.join(" ")).length === 0;
    if (startsBlock && !currentIncomplete) {
      current = { lines: [line] };
      groups.push(current);
    } else if (current) {
      current.lines.push(line);            // Étape 3 : continuation multi-lignes
    }
    // Sinon : ligne orpheline sans bloc ouvert → ignorée.
  }

  // Étapes 2+4+5 : transformer chaque bloc en transaction structurée.
  let prevSolde: number | null = opts.soldeInitial != null && opts.soldeInitial > 0 ? opts.soldeInitial : null;
  const txs: AtwBlock[] = [];

  groups.forEach((g, gi) => {
    const blockText = g.lines.join(" ");
    const dates = detectDates(blockText);
    if (dates.length === 0) return;

    // Dates : opération = 1ʳᵉ ; valeur = 1ʳᵉ avec année (sinon opération).
    const dOp = dates[0];
    const dVal = dates.find((d) => d.year !== null) ?? dOp;
    const yearOp = dOp.year ?? dVal.year ?? refYear;
    const yearVal = dVal.year ?? yearOp;
    const date_operation = fmtDate(dOp.day, dOp.month, yearOp);
    const date_valeur = fmtDate(dVal.day, dVal.month, yearVal);

    const amounts = detectAmounts(blockText);
    if (amounts.length === 0) {
      if (debug) console.log(`[ATW] bloc#${gi} IGNORÉ (aucun montant) :`, blockText.slice(0, 80));
      return;
    }

    // Montant de la transaction vs solde courant :
    //   • 1 montant  → c'est le montant.
    //   • ≥2 montants → le DERNIER est le solde courant, l'avant-dernier le montant.
    let montant: number;
    let newSolde: number | null = null;
    let montantHit: AmountHit;
    if (amounts.length >= 2) {
      montantHit = amounts[amounts.length - 2];
      montant = montantHit.value;
      newSolde = amounts[amounts.length - 1].value;
    } else {
      montantHit = amounts[0];
      montant = montantHit.value;
    }

    const { reference, libelle } = extractReferenceAndLibelle(blockText);
    const up = blockText.toUpperCase();

    // Étape 5 : direction débit/crédit.
    let isCr: boolean;
    let source: AtwBlock["_sens_source"];
    if (montantHit.negative) {
      isCr = false; source = "signe";                        // signe explicite "-"
    } else if (newSolde !== null && prevSolde !== null && Math.abs(newSolde - prevSolde) > 0.005) {
      isCr = newSolde > prevSolde; source = "solde-delta";   // delta de solde (fiable)
    } else if (CREDIT_KW.some((k) => up.includes(k))) {
      isCr = true; source = "keyword";
    } else {
      isCr = false; source = "defaut";                       // défaut : débit
    }
    if (newSolde !== null) prevSolde = newSolde;

    const block: AtwBlock = {
      ligne: txs.length + 1,
      date_operation, date_valeur, reference,
      nature_operation: libelle || "Transaction",
      montant_debit: isCr ? null : montant,
      montant_credit: isCr ? montant : null,
      _raw: blockText,
      _amounts: amounts.map((a) => a.value),
      _sens_source: source,
    };
    txs.push(block);

    if (debug) {
      console.log(
        `[ATW] bloc#${gi} → ${date_operation} | ${isCr ? "CR" : "DB"} ${montant} (${source})` +
        (reference ? ` | ref ${reference}` : "") +
        ` | « ${block.nature_operation.slice(0, 48)} »` +
        (g.lines.length > 1 ? ` | ${g.lines.length} lignes` : "") +
        (newSolde !== null ? ` | solde ${newSolde}` : ""),
      );
    }
  });

  if (debug) console.log(`[ATW] ✅ ${txs.length} transaction(s) reconstruite(s) depuis ${groups.length} bloc(s)`);
  return { txs };
}
