import { describe, it, expect } from "vitest";
import {
  cleanOcrText, detectDates, detectAmounts, isNonTransactional, parseAttijariReleve,
  extractRibMarocain,
} from "./releve-attijari";

describe("cleanOcrText", () => {
  it("compresse les espaces et retire les caractères bruités", () => {
    expect(cleanOcrText("VIR   12   02  |  SALAIRE")).toBe("VIR 12 02 SALAIRE");
    expect(cleanOcrText("A  B")).toBe("A B");
  });
});

describe("detectDates", () => {
  it("détecte jj mm et jj mm aaaa", () => {
    const d = detectDates("12 02 VIREMENT 12 02 2024 15 000,00");
    expect(d[0]).toMatchObject({ day: 12, month: 2, year: null });
    expect(d.some((x) => x.year === 2024)).toBe(true);
  });
  it("gère les séparateurs / . -", () => {
    expect(detectDates("01/03/2024")[0]).toMatchObject({ day: 1, month: 3, year: 2024 });
    expect(detectDates("01-03-24")[0]).toMatchObject({ day: 1, month: 3, year: 2024 });
  });
  it("répare les chiffres OCR (l6 O3 → 16 03)", () => {
    expect(detectDates("l6 O3 2024")[0]).toMatchObject({ day: 16, month: 3, year: 2024 });
  });
  it("rejette les faux positifs (jour>31, mois>12)", () => {
    expect(detectDates("45 99 2024")).toHaveLength(0);
    expect(detectDates("VIR2401 SALAIRE")).toHaveLength(0);
  });
});

describe("detectAmounts", () => {
  it("gère les formats marocains et signés", () => {
    expect(detectAmounts("15 000,00")[0].value).toBe(15000);
    expect(detectAmounts("1.234,56")[0].value).toBeCloseTo(1234.56);
    expect(detectAmounts("1234,56")[0].value).toBeCloseTo(1234.56);
    const neg = detectAmounts("-1234.56")[0];
    expect(neg.value).toBeCloseTo(1234.56);
    expect(neg.negative).toBe(true);
  });
  it("répare les chiffres OCR (4l,20 → 41,20)", () => {
    expect(detectAmounts("FRAIS 4l,20")[0].value).toBeCloseTo(41.2);
  });
  it("n'attrape pas un simple mot (garde-fou vrai chiffre)", () => {
    expect(detectAmounts("SALAIRE MENSUEL")).toHaveLength(0);
  });
});

describe("isNonTransactional", () => {
  it("ignore en-têtes, soldes et mentions légales", () => {
    expect(isNonTransactional("SOLDE DEPART AU 01 02 2024 10 000,00")).toBe(true);
    expect(isNonTransactional("ATTIJARIWAFA BANK - AGENCE CASA")).toBe(true);
    expect(isNonTransactional("DATE OPER  DATE VALEUR  LIBELLE  MONTANT")).toBe(true);
    expect(isNonTransactional("ICE : 001234567")).toBe(true);
  });
  it("laisse passer une vraie transaction", () => {
    expect(isNonTransactional("VIR2401 12 02 VIREMENT SALAIRE 12 02 2024 15 000,00")).toBe(false);
  });
});

describe("extractRibMarocain (RIB ATW, tolérant séparateurs/OCR)", () => {
  // RIB ATW réel plausible : 007 (banque) 780 (ville) 0002110000012345 (compte) 67 (clé)
  const EXPECTED = "007780000211000001234567";
  const cases: Record<string, string> = {
    "espaces (label + valeur)": "RELEVE D'IDENTITE BANCAIRE : 007 780 0002110000012345 67",
    "tirets": "RELEVE D'IDENTITE BANCAIRE (R.I.B) : 007-780-0002110000012345-67",
    "slash": "RELEVE D'IDENTITE BANCAIRE 007/780/0002110000012345/67",
    "gras markdown": "RELEVE D'IDENTITE BANCAIRE : **007 780 0002110000012345 67**",
    "label et digits sur lignes séparées": "RELEVE D'IDENTITE BANCAIRE\n007 780 0002110000012345 67",
    "table markdown (cellules)":
      "RELEVE D'IDENTITE BANCAIRE\n\n| Code Banque | Code Ville | N° de Compte | Clé RIB |\n|:---:|:---:|:---:|:---:|\n| 007 | 780 | 0002110000012345 | 67 |",
    "bruit OCR (O/l/S/B)": "RELEVE D'IDENTITE BANCAIRE : OO7 78O OOO2llOOOOOl2345 67",
    "compte groupé par 4": "RELEVE D'IDENTITE BANCAIRE : 007 780 0002 1100 0001 2345 67",
  };
  for (const [name, text] of Object.entries(cases)) {
    it(name, () => {
      expect(extractRibMarocain(text).replace(/\s/g, "")).toBe(EXPECTED);
    });
  }

  it("repli sans label : RIB seul dans l'en-tête", () => {
    expect(extractRibMarocain("EXTRAIT DE COMPTE\n007 780 0002110000012345 67\n").replace(/\s/g, "")).toBe(EXPECTED);
  });

  it("retourne \"\" quand aucun RIB plausible", () => {
    expect(extractRibMarocain("SOLDE DEPART AU 01/02/2024 10 000,00")).toBe("");
  });

  it("formate le RIB en groupes 3/3/16/2", () => {
    expect(extractRibMarocain("R.I.B : 007 780 0002110000012345 67")).toBe("007 780 0002110000012345 67");
  });
});

describe("parseAttijariReleve", () => {
  const opts = { debug: false, year: 2024 };

  it("parse une transaction mono-ligne (format ATW propre)", () => {
    const { txs } = parseAttijariReleve("VIR2401 12 02 VIREMENT RECU ACME 12 02 2024 15 000,00", opts);
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({ date_operation: "12/02/2024", date_valeur: "12/02/2024" });
    expect(txs[0].montant_credit).toBe(15000);   // "VIREMENT RECU" → crédit
    expect(txs[0].montant_debit).toBeNull();
    expect(txs[0].reference).toBe("VIR2401");
  });

  it("REGROUPE une transaction étalée sur plusieurs lignes", () => {
    const text = [
      "CB2402 15 03 PAIEMENT CARTE",
      "GLOVO CASABLANCA",
      "15 03 2024 234,50",
    ].join("\n");
    const { txs } = parseAttijariReleve(text, opts);
    expect(txs).toHaveLength(1);
    expect(txs[0].nature_operation).toContain("GLOVO");
    expect(txs[0].montant_debit).toBeCloseTo(234.5);   // pas de mot-clé crédit → débit
  });

  it("tolère le bruit OCR (chiffres mal reconnus)", () => {
    const { txs } = parseAttijariReleve("PRLV24 l6 O3 FRAIS TENUE COMPTE 16 03 2024 4l,20", opts);
    expect(txs).toHaveLength(1);
    expect(txs[0].date_operation).toBe("16/03/2024");
    expect(txs[0].montant_debit).toBeCloseTo(41.2);
  });

  it("détecte le crédit via le signe et via le delta de solde", () => {
    // Deux montants par ligne : montant puis solde courant → delta décide du sens.
    const text = [
      "VIR2405 10 04 VIREMENT EMIS FOURNISSEUR 10 04 2024 2 000,00 8 000,00",
      "VIR2406 15 04 VERSEMENT ESPECES 15 04 2024 5 000,00 13 000,00",
    ].join("\n");
    const { txs } = parseAttijariReleve(text, { debug: false, year: 2024, soldeInitial: 10000 });
    expect(txs).toHaveLength(2);
    // 10000 → 8000 : débit
    expect(txs[0].montant_debit).toBeCloseTo(2000);
    expect(txs[0]._sens_source).toBe("solde-delta");
    // 8000 → 13000 : crédit
    expect(txs[1].montant_credit).toBeCloseTo(5000);
    expect(txs[1]._sens_source).toBe("solde-delta");
  });

  it("ignore les lignes non transactionnelles (soldes, en-têtes)", () => {
    const text = [
      "ATTIJARIWAFA BANK - EXTRAIT DE COMPTE",
      "DATE OPER DATE VALEUR LIBELLE DEBIT CREDIT",
      "SOLDE DEPART AU 01 04 2024 10 000,00",
      "VIR2401 05 04 ACHAT DIVERS 05 04 2024 350,00",
      "SOLDE FINAL AU 30 04 2024 9 650,00",
    ].join("\n");
    const { txs } = parseAttijariReleve(text, opts);
    expect(txs).toHaveLength(1);
    expect(txs[0].nature_operation).toContain("ACHAT");
  });

  it("renvoie une liste vide sur un texte sans transaction", () => {
    expect(parseAttijariReleve("PAGE 1 / 3\nMENTIONS LEGALES\n", opts).txs).toHaveLength(0);
  });
});
