// ============================================================================
// import-grandlivre.ts — Cœur PUR (testable) de l'import Excel du Grand Livre.
//
// Aucune structure de fichier n'est supposée : on détecte la ligne d'en-tête, on
// devine le mapping des colonnes par synonymes, puis on normalise chaque ligne
// (dates multi-formats + série Excel, montants FR, débit/crédit ou montant signé).
// Enfin on dérive les tiers (clients/fournisseurs) depuis les comptes auxiliaires.
//
// Volontairement sans dépendance (pas de xlsx ici) : l'appelant passe un tableau
// de tableaux (AOA) déjà lu. Ça garde le module trivialement testable.
// ============================================================================

export type TargetField =
  | "date" | "journal" | "compte" | "libelle"
  | "debit" | "credit" | "reference"
  | "montant" | "sens" // repli : montant unique (+ sens D/C) au lieu de débit/crédit
  | "lettrage";        // code de pointage/lettrage d'un export (Sage…) : A, B, AB…

// Mapping : champ cible → index de colonne source (-1 / absent = non mappé).
export type Mapping = Partial<Record<TargetField, number>>;

export interface NormalizedRow {
  date: string | null;          // ISO YYYY-MM-DD
  journal_code: string;
  compte_numero: string;
  libelle: string;
  debit: number;
  credit: number;
  reference_piece: string | null;
  code_lettrage: string | null; // lettre(s) de pointage d'origine (Sage) — A, B, AB… ou null
  warnings: string[];
  _row: number;                 // index de la ligne source (0-based, hors en-tête)
}

export interface DerivedTier {
  type: "client" | "fournisseur";
  nom: string;
  compte_numero: string;
}

// Préfixes PCM marocain (CGNC) — configurables si besoin.
export const CLIENT_PREFIXES = ["3421", "342", "3423"];
export const FOURNISSEUR_PREFIXES = ["4411", "441", "4417"];

// ── Normalisation ────────────────────────────────────────────────────────────
export function normalizeHeader(s: unknown): string {
  return String(s ?? "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Miroir de normalizeLibelle (tiers-memoire.functions.ts) — défini localement pour
// garder ce module pur/sans dépendance serveur.
export function normalizeLibelle(s: string | null | undefined): string {
  if (!s) return "";
  return String(s)
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toUpperCase().replace(/[^0-9A-Z\s]+/g, " ")
    .replace(/\s+/g, " ").trim();
}

// ── Dictionnaire de synonymes d'en-têtes (FR + variantes fréquentes) ─────────
const SYNONYMS: Record<TargetField, string[]> = {
  date:      ["date", "date ecriture", "date d ecriture", "date operation", "date piece", "date compta", "jour"],
  journal:   ["journal", "code journal", "jrnl", "jal", "j", "code jrnl"],
  compte:    ["compte", "compte general", "n compte", "no compte", "num compte", "numero de compte", "cpt", "compte comptable", "compte num"],
  libelle:   ["libelle", "intitule", "designation", "libelle ecriture", "nom", "tiers", "libelle mouvement", "description"],
  debit:     ["debit", "montant debit", "deb", "d"],
  credit:    ["credit", "montant credit", "cred", "cre", "c"],
  reference: ["reference", "ref", "piece", "n piece", "no piece", "num piece", "reference piece", "numero piece", "justificatif"],
  montant:   ["montant", "montant mouvement", "valeur", "somme"],
  sens:      ["sens", "d c", "dc", "sens ecriture"],
  lettrage:  ["lettrage", "lettre", "lettr", "pointage", "code lettrage", "lettre pointage", "rapprochement", "rappro"],
};

// ── Détection de la ligne d'en-tête ──────────────────────────────────────────
// Scanne les premières lignes ; retient celle qui matche le plus de synonymes
// (au moins 2). Repli : première ligne non vide.
export function detectHeaderRow(aoa: unknown[][], maxScan = 15): number {
  let best = -1, bestScore = 0;
  const limit = Math.min(aoa.length, maxScan);
  for (let i = 0; i < limit; i++) {
    const row = aoa[i] ?? [];
    let score = 0;
    for (const cell of row) {
      const h = normalizeHeader(cell);
      if (!h) continue;
      if (matchTarget(h)) score++;
    }
    if (score > bestScore) { bestScore = score; best = i; }
  }
  if (bestScore >= 2) return best;
  // repli : première ligne non entièrement vide
  for (let i = 0; i < limit; i++) {
    if ((aoa[i] ?? []).some((c) => String(c ?? "").trim() !== "")) return i;
  }
  return 0;
}

// Un en-tête normalisé matche-t-il un champ cible ? (retourne le champ ou null)
function matchTarget(h: string): TargetField | null {
  for (const field of Object.keys(SYNONYMS) as TargetField[]) {
    for (const syn of SYNONYMS[field]) {
      if (h === syn) return field;                       // égalité exacte prioritaire
    }
  }
  for (const field of Object.keys(SYNONYMS) as TargetField[]) {
    for (const syn of SYNONYMS[field]) {
      if (syn.length >= 3 && (h.includes(syn) || syn.includes(h))) return field; // inclusion
    }
  }
  return null;
}

// ── Devine le mapping colonnes à partir des en-têtes ─────────────────────────
export function guessMapping(headers: unknown[]): Mapping {
  const map: Mapping = {};
  headers.forEach((raw, idx) => {
    const h = normalizeHeader(raw);
    if (!h) return;
    const field = matchTarget(h);
    // Ne pas écraser un mapping déjà trouvé (première colonne gagne).
    if (field && map[field] === undefined) map[field] = idx;
  });
  return map;
}

// ── Parsing des montants (formats FR) ────────────────────────────────────────
export function parseAmount(v: unknown): number {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return isFinite(v) ? v : 0;
  let s = String(v).trim();
  if (!s) return 0;
  const neg = /^\(.*\)$/.test(s) || /-\s*$/.test(s) || /^-/.test(s); // (123) ou 123- ou -123
  s = s.replace(/[()]/g, "")
    .replace(/(dh|mad|dhs|dirham[s]?|€|eur)/gi, "")
    .replace(/[\s  ']/g, "")   // espaces (dont insécables) et apostrophes de milliers
    .replace(/-/g, "");
  // Décimale : virgule ou point. Retirer les séparateurs de milliers.
  if (s.includes(",") && s.includes(".")) {
    // Le dernier séparateur est le décimal.
    s = s.lastIndexOf(",") > s.lastIndexOf(".")
      ? s.replace(/\./g, "").replace(",", ".")
      : s.replace(/,/g, "");
  } else {
    s = s.replace(",", ".");
  }
  const n = parseFloat(s);
  if (!isFinite(n)) return 0;
  return neg ? -n : n;
}

// ── Parsing des dates (multi-formats + série Excel) ──────────────────────────
export function parseDate(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  // Série Excel (jours depuis 1899-12-30). Plage plausible ~ 1990..2100.
  if (typeof v === "number" && v > 20000 && v < 80000) {
    const ms = Date.UTC(1899, 11, 30) + Math.round(v) * 86400000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  if (!s) return null;
  // ISO direct
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return isoOrNull(+m[1], +m[2], +m[3]);
  // JJ/MM/AAAA (ou -,.) ; année sur 2 ou 4 chiffres
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    let y = +m[3]; if (y < 100) y += y < 70 ? 2000 : 1900;
    return isoOrNull(y, +m[2], +m[1]);
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function isoOrNull(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
}

// ── Inférence du journal depuis la classe de compte (si colonne absente) ─────
export function inferJournal(compte: string): string {
  const c = (compte || "").trim();
  if (c.startsWith("516") || c.startsWith("53")) return "CAI"; // caisse (CGNC 516x)
  if (c.startsWith("5")) return "BQ";     // banque / trésorerie (514x…)
  if (c.startsWith("7")) return "VTE";    // produits → ventes
  if (c.startsWith("6")) return "ACH";    // charges → achats
  return "OD";                            // opérations diverses
}

function cell(row: unknown[], idx: number | undefined): unknown {
  return idx == null || idx < 0 ? undefined : row[idx];
}
function str(v: unknown): string { return v == null ? "" : String(v).trim(); }

// Normalise un code de lettrage (Sage) : majuscules, sans espaces. Les valeurs
// « vides » usuelles (0, -, *, .) signifient « non lettré » → null.
export function normalizeLettrage(v: unknown): string | null {
  const s = str(v).toUpperCase().replace(/\s+/g, "");
  if (!s || /^[-0*.]+$/.test(s)) return null;
  return s;
}

// Une ligne ressemble-t-elle à un total / report / solde (à ignorer) ?
function looksLikeTotal(libelle: string, compte: string): boolean {
  if (compte) return false; // un total n'a pas de compte auxiliaire
  return /\b(total|totaux|report|a nouveau|solde|cumul|sous.total)\b/i.test(normalizeLibelle(libelle).toLowerCase());
}

// ── Normalisation de toutes les lignes de données ────────────────────────────
export function normalizeRows(dataRows: unknown[][], mapping: Mapping): {
  rows: NormalizedRow[];
  skipped: number;
} {
  const out: NormalizedRow[] = [];
  let skipped = 0;
  const hasDC = mapping.debit != null || mapping.credit != null;

  dataRows.forEach((row, i) => {
    const isEmpty = !row || row.every((c) => str(c) === "");
    if (isEmpty) { skipped++; return; }

    const compte = str(cell(row, mapping.compte));
    const libelle = str(cell(row, mapping.libelle));
    if (looksLikeTotal(libelle, compte)) { skipped++; return; }

    const warnings: string[] = [];
    const date = parseDate(cell(row, mapping.date));
    if (!date) warnings.push("date illisible");
    if (!compte) warnings.push("compte manquant");

    let debit = 0, credit = 0;
    if (hasDC) {
      debit = Math.abs(parseAmount(cell(row, mapping.debit)));
      credit = Math.abs(parseAmount(cell(row, mapping.credit)));
    } else if (mapping.montant != null) {
      const montant = parseAmount(cell(row, mapping.montant));
      const sens = str(cell(row, mapping.sens)).toUpperCase();
      if (sens.startsWith("D") || (!sens && montant >= 0)) debit = Math.abs(montant);
      else credit = Math.abs(montant);
    } else {
      warnings.push("aucune colonne montant");
    }
    if (debit > 0 && credit > 0) warnings.push("débit ET crédit renseignés");
    if (debit === 0 && credit === 0) warnings.push("montant nul");

    const journal = str(cell(row, mapping.journal)).toUpperCase() || inferJournal(compte);
    const reference = str(cell(row, mapping.reference)) || null;
    const code_lettrage = normalizeLettrage(cell(row, mapping.lettrage));

    out.push({ date, journal_code: journal, compte_numero: compte, libelle, debit, credit, reference_piece: reference, code_lettrage, warnings, _row: i });
  });

  return { rows: out, skipped };
}

// ── Dérivation des tiers depuis les comptes auxiliaires ──────────────────────
export function deriveTiers(
  rows: NormalizedRow[],
  opts: { clientPrefixes?: string[]; fournisseurPrefixes?: string[] } = {},
): DerivedTier[] {
  const cliP = opts.clientPrefixes ?? CLIENT_PREFIXES;
  const fouP = opts.fournisseurPrefixes ?? FOURNISSEUR_PREFIXES;
  const seen = new Set<string>();       // dédup par type|nom normalisé
  const tiers: DerivedTier[] = [];

  for (const r of rows) {
    const c = r.compte_numero;
    if (!c) continue;
    let type: DerivedTier["type"] | null = null;
    if (fouP.some((p) => c.startsWith(p))) type = "fournisseur";      // 44 avant 34 : ordre indifférent (préfixes disjoints)
    else if (cliP.some((p) => c.startsWith(p))) type = "client";
    if (!type) continue;

    const nom = r.libelle.trim() || `Compte ${c}`;
    const key = `${type}|${normalizeLibelle(nom)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tiers.push({ type, nom, compte_numero: c });
  }
  return tiers;
}

// ── Récap (équilibre débit/crédit) ───────────────────────────────────────────
export function summarize(rows: NormalizedRow[]): {
  totalDebit: number; totalCredit: number; equilibre: boolean; nbWarnings: number;
} {
  let totalDebit = 0, totalCredit = 0, nbWarnings = 0;
  for (const r of rows) {
    totalDebit += r.debit; totalCredit += r.credit;
    if (r.warnings.length) nbWarnings++;
  }
  return { totalDebit, totalCredit, equilibre: Math.abs(totalDebit - totalCredit) < 0.01, nbWarnings };
}
