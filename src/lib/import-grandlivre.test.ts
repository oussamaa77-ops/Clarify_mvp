import { describe, it, expect } from "vitest";
import {
  detectHeaderRow, guessMapping, parseAmount, parseDate, inferJournal,
  normalizeRows, deriveTiers, summarize, normalizeLettrage, type Mapping,
} from "./import-grandlivre";

describe("guessMapping — mapping tolérant aux variantes d'en-têtes", () => {
  it("mappe les colonnes standard FR", () => {
    const headers = ["Date", "Journal", "N° Compte", "Libellé", "Débit", "Crédit", "Pièce"];
    const m = guessMapping(headers);
    expect(m.date).toBe(0);
    expect(m.journal).toBe(1);
    expect(m.compte).toBe(2);
    expect(m.libelle).toBe(3);
    expect(m.debit).toBe(4);
    expect(m.credit).toBe(5);
    expect(m.reference).toBe(6);
  });

  it("gère accents, casse et intitulés alternatifs", () => {
    const headers = ["DATE ECRITURE", "Code Journal", "Compte Général", "Intitulé", "Montant Débit", "Montant Crédit"];
    const m = guessMapping(headers);
    expect(m.date).toBe(0);
    expect(m.journal).toBe(1);
    expect(m.compte).toBe(2);
    expect(m.libelle).toBe(3);
    expect(m.debit).toBe(4);
    expect(m.credit).toBe(5);
  });

  it("détecte le repli montant + sens", () => {
    const m = guessMapping(["Date", "Compte", "Désignation", "Montant", "Sens"]);
    expect(m.montant).toBe(3);
    expect(m.sens).toBe(4);
    expect(m.debit).toBeUndefined();
  });

  it("mappe la colonne de lettrage (Sage)", () => {
    expect(guessMapping(["Date", "Compte", "Libellé", "Débit", "Crédit", "Lettrage"]).lettrage).toBe(5);
    expect(guessMapping(["Date", "Compte", "Libellé", "Débit", "Crédit", "Pointage"]).lettrage).toBe(5);
    expect(guessMapping(["Date", "Compte", "Libellé", "Débit", "Crédit", "Let."]).lettrage).toBe(5);
  });
});

describe("normalizeLettrage — codes de pointage", () => {
  it("normalise en majuscules sans espaces", () => {
    expect(normalizeLettrage("a")).toBe("A");
    expect(normalizeLettrage(" ab ")).toBe("AB");
    expect(normalizeLettrage("Ba")).toBe("BA");
  });
  it("traite les valeurs vides/neutres comme non lettré", () => {
    expect(normalizeLettrage("")).toBeNull();
    expect(normalizeLettrage(null)).toBeNull();
    expect(normalizeLettrage("-")).toBeNull();
    expect(normalizeLettrage("0")).toBeNull();
    expect(normalizeLettrage("*")).toBeNull();
  });
});

describe("detectHeaderRow — en-tête non en première ligne", () => {
  it("saute les lignes de titre et trouve l'en-tête réel", () => {
    const aoa = [
      ["SOCIÉTÉ XYZ — GRAND LIVRE", "", "", ""],
      ["Exercice 2026", "", "", ""],
      [],
      ["Date", "Compte", "Libellé", "Débit", "Crédit"],
      ["01/01/2026", "3421001", "CLIENT A", "1000", ""],
    ];
    expect(detectHeaderRow(aoa)).toBe(3);
  });
});

describe("parseAmount — formats marocains/FR", () => {
  it("parse espaces de milliers et virgule décimale", () => {
    expect(parseAmount("1 234,56")).toBeCloseTo(1234.56);
    expect(parseAmount("12 000,00")).toBeCloseTo(12000);
    expect(parseAmount("1 000,00 DH")).toBeCloseTo(1000);
  });
  it("parse point décimal et milliers virgule (format anglo)", () => {
    expect(parseAmount("1,234.56")).toBeCloseTo(1234.56);
  });
  it("gère négatifs et vide", () => {
    expect(parseAmount("(500,00)")).toBeCloseTo(-500);
    expect(parseAmount("-250")).toBeCloseTo(-250);
    expect(parseAmount("")).toBe(0);
    expect(parseAmount(null)).toBe(0);
    expect(parseAmount(1500)).toBe(1500);
  });
});

describe("parseDate — multi-formats + série Excel", () => {
  it("parse JJ/MM/AAAA", () => {
    expect(parseDate("15/03/2026")).toBe("2026-03-15");
    expect(parseDate("05-01-2026")).toBe("2026-01-05");
    expect(parseDate("15.03.26")).toBe("2026-03-15");
  });
  it("parse ISO", () => {
    expect(parseDate("2026-03-15")).toBe("2026-03-15");
  });
  it("parse une série Excel", () => {
    // 46022 = 2025-12-31 (jours depuis 1899-12-30, corrige le bug an-1900)
    expect(parseDate(46022)).toBe("2025-12-31");
  });
  it("renvoie null si illisible", () => {
    expect(parseDate("n/a")).toBeNull();
    expect(parseDate("")).toBeNull();
  });
});

describe("inferJournal — classe de compte", () => {
  it("classe correctement", () => {
    expect(inferJournal("7111")).toBe("VTE");
    expect(inferJournal("6111")).toBe("ACH");
    expect(inferJournal("5141")).toBe("BQ");
    expect(inferJournal("5161")).toBe("CAI");
    expect(inferJournal("3421")).toBe("OD");
  });
});

describe("normalizeRows — normalisation + warnings", () => {
  const mapping: Mapping = { date: 0, journal: 1, compte: 2, libelle: 3, debit: 4, credit: 5 };

  it("normalise, ignore vides et lignes de total", () => {
    const rows = [
      ["15/03/2026", "VTE", "3421001", "CLIENT ALPHA", "1 200,00", ""],
      ["", "", "", "", "", ""],                                  // vide → skip
      ["", "", "", "TOTAL GÉNÉRAL", "1 200,00", "1 200,00"],     // total sans compte → skip
      ["15/03/2026", "VTE", "7111", "VENTE MARCHANDISES", "", "1 200,00"],
    ];
    const { rows: norm, skipped } = normalizeRows(rows, mapping);
    expect(norm).toHaveLength(2);
    expect(skipped).toBe(2);
    expect(norm[0].debit).toBeCloseTo(1200);
    expect(norm[0].credit).toBe(0);
    expect(norm[1].credit).toBeCloseTo(1200);
    expect(norm[0].warnings).toHaveLength(0);
  });

  it("signale les dates illisibles et montants nuls", () => {
    const { rows } = normalizeRows([["xx", "OD", "3421", "X", "", ""]], mapping);
    expect(rows[0].warnings).toContain("date illisible");
    expect(rows[0].warnings).toContain("montant nul");
  });

  it("infère le journal quand la colonne est absente", () => {
    const m: Mapping = { date: 0, compte: 1, libelle: 2, debit: 3, credit: 4 };
    const { rows } = normalizeRows([["01/01/2026", "6111", "ACHAT", "500", ""]], m);
    expect(rows[0].journal_code).toBe("ACH");
  });

  it("extrait le code de lettrage quand la colonne est mappée", () => {
    const m: Mapping = { date: 0, journal: 1, compte: 2, libelle: 3, debit: 4, credit: 5, lettrage: 6 };
    const { rows } = normalizeRows([
      ["15/03/2026", "VTE", "3421001", "CLIENT ALPHA", "1200", "", "a"],
      ["16/03/2026", "BQ", "5141", "REGLEMENT ALPHA", "", "1200", "A"],
      ["17/03/2026", "OD", "6111", "DIVERS", "50", "", ""],   // non lettré → null
    ], m);
    expect(rows[0].code_lettrage).toBe("A");
    expect(rows[1].code_lettrage).toBe("A");
    expect(rows[2].code_lettrage).toBeNull();
  });

  it("repli montant signé → débit/crédit", () => {
    const m: Mapping = { date: 0, compte: 1, libelle: 2, montant: 3 };
    const { rows } = normalizeRows([
      ["01/01/2026", "3421", "CLIENT", "1000"],
      ["01/01/2026", "7111", "VENTE", "-1000"],
    ], m);
    expect(rows[0].debit).toBeCloseTo(1000);
    expect(rows[1].credit).toBeCloseTo(1000);
  });
});

describe("deriveTiers — extraction depuis comptes auxiliaires", () => {
  it("dérive clients (342x) et fournisseurs (441x), dédupliqués", () => {
    const mapping: Mapping = { date: 0, journal: 1, compte: 2, libelle: 3, debit: 4, credit: 5 };
    const { rows } = normalizeRows([
      ["01/01/2026", "VTE", "3421001", "CLIENT ALPHA", "1000", ""],
      ["05/01/2026", "VTE", "3421001", "Client Alpha", "500", ""],  // doublon (nom normalisé)
      ["10/01/2026", "ACH", "4411002", "FOURNISSEUR BETA", "", "800"],
      ["15/01/2026", "OD", "6111", "ELECTRICITE", "300", ""],        // pas un tiers
    ], mapping);
    const tiers = deriveTiers(rows);
    expect(tiers).toHaveLength(2);
    expect(tiers.find((t) => t.type === "client")?.nom).toBe("CLIENT ALPHA");
    expect(tiers.find((t) => t.type === "fournisseur")?.nom).toBe("FOURNISSEUR BETA");
  });
});

describe("summarize — équilibre débit/crédit", () => {
  it("détecte l'équilibre et compte les warnings", () => {
    const mapping: Mapping = { date: 0, journal: 1, compte: 2, libelle: 3, debit: 4, credit: 5 };
    const { rows } = normalizeRows([
      ["01/01/2026", "VTE", "3421", "CLIENT", "1200", ""],
      ["01/01/2026", "VTE", "7111", "VENTE", "", "1200"],
    ], mapping);
    const s = summarize(rows);
    expect(s.totalDebit).toBeCloseTo(1200);
    expect(s.totalCredit).toBeCloseTo(1200);
    expect(s.equilibre).toBe(true);
    expect(s.nbWarnings).toBe(0);
  });
});
