// ============================================================================
// exportSage.ts — Export du grand livre vers les logiciels comptables.
//
// Trois formats, une seule source : les écritures du dossier, lettrage compris.
//
//   • SAGE 100  — CSV « ; » attendu par l'import des écritures de Sage 100.
//                 Le code de lettrage y occupe sa propre colonne : c'est lui qui
//                 évite au cabinet de refaire à la main, dans Sage, le
//                 rapprochement déjà fait ici.
//   • FEC       — Fichier des Écritures Comptables, 18 colonnes normalisées,
//                 tabulé. `EcritureLet` / `DateLet` portent le lettrage.
//   • CSV       — tabulaire neutre, réimportable à peu près partout.
//
// Ce module est PUR : il produit des chaînes. Le téléchargement est isolé dans
// les helpers `download*` en fin de fichier, seuls à toucher au DOM.
// ============================================================================

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** Écriture telle que l'export la consomme. */
export interface EcritureExport {
  id?: string | null;
  journal_code?: string | null;
  compte_numero?: string | null;
  date_ecriture?: string | null;
  libelle?: string | null;
  debit?: number | string | null;
  credit?: number | string | null;
  reference_piece?: string | null;
  /** Code de lettrage GÉNÉRÉ par le moteur (AA, AB…). */
  lettrage_code?: string | null;
  /** Horodatage du lettrage — alimente DateLet au format FEC. */
  lettrage_date?: string | null;
  /** Code de lettrage d'ORIGINE, conservé à l'import (Sage : A, B…). */
  code_lettrage?: string | null;
}

export interface OptionsExport {
  /** Intitulés PCM, pour nommer les comptes dans les colonnes qui l'exigent. */
  intitules?: Record<string, string>;
  /** Nom du journal quand le code seul ne suffit pas (FEC : JournalLib). */
  libellesJournaux?: Record<string, string>;
  /** Repli quand une écriture ne porte pas de journal. */
  journalParDefaut?: string;
}

const LIBELLES_JOURNAUX_DEFAUT: Record<string, string> = {
  VTE: "Journal des ventes",
  ACH: "Journal des achats",
  BQ: "Journal de banque",
  CAI: "Journal de caisse",
  OD: "Opérations diverses",
  AN: "À-nouveaux",
};

// ─── Formatage ───────────────────────────────────────────────────────────────

/** Date AAAA-MM-JJ → AAAAMMJJ (format FEC). Rend "" si illisible. */
export function dateFEC(d: string | null | undefined): string {
  const s = String(d ?? "").trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.replace(/-/g, "") : "";
}

/** Date AAAA-MM-JJ → JJ/MM/AAAA (format Sage FR). Rend "" si illisible. */
export function dateSage(d: string | null | undefined): string {
  const s = String(d ?? "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
  const [a, m, j] = s.split("-");
  return `${j}/${m}/${a}`;
}

/**
 * Montant à 2 décimales, virgule décimale.
 *
 * La virgule n'est pas un détail cosmétique : Sage et le FEC sont lus en locale
 * française, où un point serait pris pour un séparateur de milliers — 1.234,00
 * deviendrait mille deux cent trente-quatre au lieu de un virgule deux.
 */
export function montantFR(v: unknown): string {
  return n(v).toFixed(2).replace(".", ",");
}

/**
 * Échappe une valeur pour un CSV.
 *
 * Le point-virgule ET la virgule sont traités : un libellé contenant « SARL, Casa »
 * décalerait toutes les colonnes suivantes dans un CSV à virgule.
 */
export function echapperCsv(v: unknown, separateur: string): string {
  const s = (v ?? "").toString().replace(/[\r\n]+/g, " ").trim();
  return s.includes(separateur) || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Nettoie une valeur pour un fichier TABULÉ : la tabulation y est interdite. */
export function nettoyerTab(v: unknown): string {
  return (v ?? "").toString().replace(/[\t\r\n]+/g, " ").trim();
}

// ─── 1. Sage 100 — journal des écritures ─────────────────────────────────────

export const COLONNES_SAGE100 = [
  "Journal", "Date", "Compte", "Piece", "Libelle",
  "Debit", "Credit", "Lettrage", "Date_lettrage",
] as const;

/**
 * CSV d'import des écritures pour Sage 100.
 *
 * Une ligne = une écriture, sens porté par la colonne remplie (l'autre reste
 * vide plutôt que « 0,00 » : Sage traite une cellule vide comme « pas de
 * mouvement », alors qu'un zéro explicite crée une ligne à zéro dans le journal).
 */
export function buildSage100CSV(ecritures: EcritureExport[], opts: OptionsExport = {}): string {
  const SEP = ";";
  const esc = (v: unknown) => echapperCsv(v, SEP);
  const journalDefaut = opts.journalParDefaut ?? "OD";

  const lignes = ecritures.map((e) => {
    const debit = n(e.debit);
    const credit = n(e.credit);
    return [
      e.journal_code || journalDefaut,
      dateSage(e.date_ecriture),
      e.compte_numero ?? "",
      e.reference_piece ?? "",
      e.libelle ?? "",
      debit > 0 ? montantFR(debit) : "",
      credit > 0 ? montantFR(credit) : "",
      e.lettrage_code ?? "",
      e.lettrage_code ? dateSage(e.lettrage_date) : "",
    ].map(esc).join(SEP);
  });

  return [COLONNES_SAGE100.join(SEP), ...lignes].join("\r\n");
}

// ─── 2. FEC — Fichier des Écritures Comptables ───────────────────────────────

export const COLONNES_FEC = [
  "JournalCode", "JournalLib", "EcritureNum", "EcritureDate", "CompteNum",
  "CompteLib", "CompAuxNum", "CompAuxLib", "PieceRef", "PieceDate",
  "EcritureLib", "Debit", "Credit", "EcritureLet", "DateLet",
  "ValidDate", "Montantdevise", "Idevise",
] as const;

/**
 * Fichier FEC tabulé, 18 colonnes dans l'ordre normalisé.
 *
 * `EcritureNum` doit identifier une PIÈCE, pas une ligne : toutes les lignes
 * d'une même écriture partagent le numéro, sinon le contrôle d'équilibre du
 * fichier échoue (chaque « écriture » y apparaîtrait déséquilibrée). On
 * regroupe donc par journal + date + référence de pièce.
 */
export function buildFEC(ecritures: EcritureExport[], opts: OptionsExport = {}): string {
  const SEP = "\t";
  const intitules = opts.intitules ?? {};
  const journaux = { ...LIBELLES_JOURNAUX_DEFAUT, ...(opts.libellesJournaux ?? {}) };
  const journalDefaut = opts.journalParDefaut ?? "OD";

  // Numérotation des pièces : une clé stable → un numéro séquentiel.
  const numeroParPiece = new Map<string, number>();
  const clePiece = (e: EcritureExport) =>
    `${e.journal_code || journalDefaut}|${dateFEC(e.date_ecriture)}|${e.reference_piece ?? ""}`;
  for (const e of ecritures) {
    const k = clePiece(e);
    if (!numeroParPiece.has(k)) numeroParPiece.set(k, numeroParPiece.size + 1);
  }

  const lignes = ecritures.map((e) => {
    const journal = e.journal_code || journalDefaut;
    const compte = e.compte_numero ?? "";
    const date = dateFEC(e.date_ecriture);
    return [
      journal,
      journaux[journal] ?? journal,
      String(numeroParPiece.get(clePiece(e)) ?? 1),
      date,
      compte,
      intitules[compte] ?? "",
      "",                                   // CompAuxNum : l'auxiliaire est déjà dans CompteNum
      "",                                   // CompAuxLib
      e.reference_piece ?? "",
      date,                                 // PieceDate : la date de pièce vaut la date d'écriture
      e.libelle ?? "",
      montantFR(e.debit),
      montantFR(e.credit),
      e.lettrage_code ?? "",
      e.lettrage_code ? dateFEC(e.lettrage_date) : "",
      date,                                 // ValidDate
      "",                                   // Montantdevise : dossiers tenus en MAD uniquement
      "",                                   // Idevise
    ].map(nettoyerTab).join(SEP);
  });

  return [COLONNES_FEC.join(SEP), ...lignes].join("\r\n");
}

// ─── 3. CSV générique ────────────────────────────────────────────────────────

export const COLONNES_CSV_GENERIQUE = [
  "Date", "Journal", "Compte", "Intitule_compte", "Piece",
  "Libelle", "Debit", "Credit", "Lettrage", "Lettrage_origine",
] as const;

/**
 * CSV neutre, réimportable dans Excel ou un autre outil.
 *
 * Contrairement aux deux formats normalisés, celui-ci expose AUSSI le code de
 * lettrage d'origine (`code_lettrage`) à côté du nôtre : c'est le seul export
 * qui permet au cabinet de comparer ce que disait le fichier importé et ce que
 * notre moteur a rapproché.
 */
export function buildCsvGenerique(ecritures: EcritureExport[], opts: OptionsExport = {}): string {
  const SEP = ";";
  const esc = (v: unknown) => echapperCsv(v, SEP);
  const intitules = opts.intitules ?? {};

  const lignes = ecritures.map((e) => {
    const compte = e.compte_numero ?? "";
    return [
      (e.date_ecriture ?? "").slice(0, 10),
      e.journal_code ?? "",
      compte,
      intitules[compte] ?? "",
      e.reference_piece ?? "",
      e.libelle ?? "",
      montantFR(e.debit),
      montantFR(e.credit),
      e.lettrage_code ?? "",
      e.code_lettrage ?? "",
    ].map(esc).join(SEP);
  });

  return [COLONNES_CSV_GENERIQUE.join(SEP), ...lignes].join("\r\n");
}

// ─── Contrôles avant remise du fichier ───────────────────────────────────────

export interface ControleExport {
  lignes: number;
  totalDebit: number;
  totalCredit: number;
  equilibre: boolean;
  /** Codes de lettrage dont les lignes ne se soldent pas — anomalie à corriger. */
  lettragesDesequilibres: string[];
  nbLettrees: number;
  /** Écritures sans date exploitable : refusées par Sage comme par le FEC. */
  sansDate: number;
}

/**
 * Contrôles de cohérence du lot exporté.
 *
 * Un export déséquilibré est rejeté à l'import — autant le voir ici, avec le
 * détail de ce qui cloche, que de le découvrir dans Sage sans savoir où chercher.
 */
export function controlerExport(ecritures: EcritureExport[]): ControleExport {
  const arrondi = (x: number) => Math.round(x * 100) / 100;
  const totalDebit = arrondi(ecritures.reduce((s, e) => s + n(e.debit), 0));
  const totalCredit = arrondi(ecritures.reduce((s, e) => s + n(e.credit), 0));

  const parCode = new Map<string, { d: number; c: number }>();
  for (const e of ecritures) {
    const code = String(e.lettrage_code ?? "").trim();
    if (!code) continue;
    const g = parCode.get(code) ?? { d: 0, c: 0 };
    g.d += n(e.debit);
    g.c += n(e.credit);
    parCode.set(code, g);
  }

  return {
    lignes: ecritures.length,
    totalDebit,
    totalCredit,
    equilibre: Math.abs(totalDebit - totalCredit) < 0.005,
    lettragesDesequilibres: [...parCode.entries()]
      .filter(([, g]) => Math.abs(arrondi(g.d - g.c)) >= 0.005)
      .map(([code]) => code)
      .sort(),
    nbLettrees: ecritures.filter((e) => String(e.lettrage_code ?? "").trim()).length,
    sansDate: ecritures.filter((e) => !dateFEC(e.date_ecriture)).length,
  };
}

// ─── Téléchargement (seule partie liée au navigateur) ────────────────────────

export type FormatExport = "sage100" | "fec" | "csv";

export const FORMATS_EXPORT: Record<FormatExport, { label: string; extension: string; description: string }> = {
  sage100: { label: "Sage 100", extension: "csv", description: "Import des écritures Sage 100, lettrage inclus" },
  fec:     { label: "FEC",      extension: "txt", description: "Fichier des Écritures Comptables (18 colonnes normalisées)" },
  csv:     { label: "CSV / Excel", extension: "csv", description: "Tabulaire neutre, réimportable partout" },
};

/** Génère le contenu du format demandé. */
export function construireExport(
  format: FormatExport,
  ecritures: EcritureExport[],
  opts: OptionsExport = {},
): string {
  switch (format) {
    case "sage100": return buildSage100CSV(ecritures, opts);
    case "fec":     return buildFEC(ecritures, opts);
    case "csv":     return buildCsvGenerique(ecritures, opts);
  }
}

/**
 * Nom de fichier FEC normalisé : <SIRET/ICE>FEC<AAAAMMJJ de clôture>.txt.
 * Les autres formats prennent un nom lisible, sans contrainte réglementaire.
 */
export function nomFichierExport(
  format: FormatExport,
  identifiant: string,
  dateCloture: string,
): string {
  const ext = FORMATS_EXPORT[format].extension;
  const id = String(identifiant ?? "").replace(/[^A-Za-z0-9]/g, "") || "DOSSIER";
  if (format === "fec") return `${id}FEC${dateFEC(dateCloture) || "00000000"}.txt`;
  return `${format}_${id}_${(dateCloture ?? "").slice(0, 10)}.${ext}`;
}

/** Déclenche le téléchargement du fichier généré. */
export function telechargerExport(
  format: FormatExport,
  ecritures: EcritureExport[],
  identifiant: string,
  dateCloture: string,
  opts: OptionsExport = {},
): void {
  const contenu = construireExport(format, ecritures, opts);
  // BOM UTF-8 : sans lui, Excel et Sage lisent les accents en ANSI et « Libellé »
  // devient « LibellÃ© ». Le FEC est tabulé mais souffre du même travers.
  const blob = new Blob(["﻿" + contenu], {
    type: format === "fec" ? "text/plain;charset=utf-8;" : "text/csv;charset=utf-8;",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = nomFichierExport(format, identifiant, dateCloture);
  a.click();
  URL.revokeObjectURL(a.href);
}
