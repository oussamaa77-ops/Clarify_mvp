import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  concordanceJournal, construireGrandLivre, dansIntervalle, grandLivreEnTableau,
  lignesDeLaPiece, planPieceSource, ventiler, type LigneGrandLivre,
} from "./grand-livre";
import { genererPdfGrandLivre, montantPdf, texteWinAnsi } from "./grand-livre-pdf";

const UUID_FF = "0f8a2b6c-1d3e-4f50-8a9b-0c1d2e3f4a5b";
let seq = 0;
const L = (
  date: string, journal: string, compte: string, debit: number, credit: number,
  ref: string | null = "P", extra: Partial<LigneGrandLivre> = {},
): LigneGrandLivre => ({
  id: `l${++seq}`, date_ecriture: date, journal_code: journal, compte_numero: compte,
  libelle: `${journal} ${ref ?? ""}`.trim(), debit, credit, reference_piece: ref, ...extra,
});

/** Un exercice 2026 : à-nouveau, vente de janvier, encaissement de février, achat de mars, OD de décembre. */
const LIGNES: LigneGrandLivre[] = [
  L("2026-01-01", "AN", "51410000", 10000, 0, "AN-2026"),
  L("2026-01-01", "AN", "11610000", 0, 10000, "AN-2026"),
  L("2026-01-15", "VTE", "34210002", 1200, 0, "FA-1", { facture_id: "f1" }),
  L("2026-01-15", "VTE", "71240000", 0, 1000, "FA-1", { facture_id: "f1" }),
  L("2026-01-15", "VTE", "44580000", 0, 200, "FA-1", { facture_id: "f1" }),
  L("2026-02-10", "BQ", "5141", 1200, 0, "FA-1", { transaction_id: "t1" }), // forme COURTE du même compte
  L("2026-02-10", "BQ", "34210002", 0, 1200, "FA-1", { transaction_id: "t1" }),
  L("2026-03-05", "ACH", "61330000", 500, 0, UUID_FF),
  L("2026-03-05", "ACH", "34580000", 100, 0, UUID_FF),
  L("2026-03-05", "ACH", "44110005", 0, 600, UUID_FF),
  L("2026-12-31", "OD", "51410000", 50, 0, "OD-9"),
  L("2026-12-31", "OD", "47120000", 0, 50, "OD-9"),
];

const gl = construireGrandLivre(LIGNES, { debut: "2026-02-01", fin: "2026-06-30" });
const compte = (n: string) => gl.comptes.find((c) => c.compte === n)!;

describe("construireGrandLivre — soldes par compte", () => {
  it("un dossier par compte, trié, formes courte et longue fusionnées", () => {
    expect(gl.comptes.map((c) => c.compte)).toEqual([
      "11610000", "34210002", "34580000", "44110005", "44580000", "51410000", "61330000", "71240000",
    ]);
    expect(compte("51410000").mouvements).toHaveLength(1);
  });

  it("solde initial = à-nouveau + écritures antérieures à la période", () => {
    expect(compte("51410000")).toMatchObject({ initialDebit: 10000, soldeInitial: 10000, totalDebit: 1200, soldeFinal: 11200 });
    expect(compte("34210002")).toMatchObject({ initialDebit: 1200, soldeInitial: 1200, totalCredit: 1200, soldeFinal: 0 });
    // Un compte sans mouvement dans la période reste au grand livre par son report.
    expect(compte("71240000")).toMatchObject({ soldeInitial: -1000, totalDebit: 0, totalCredit: 0, soldeCrediteur: 1000 });
  });

  it("solde final ventilé sur DEUX colonnes exclusives", () => {
    expect(compte("51410000")).toMatchObject({ soldeDebiteur: 11200, soldeCrediteur: 0 });
    expect(compte("44110005")).toMatchObject({ soldeDebiteur: 0, soldeCrediteur: 600 });
    expect(ventiler(-0)).toEqual({ debiteur: 0, crediteur: 0 });
  });

  it("ignore les écritures postérieures à la fin de période", () => {
    expect(gl.comptes.some((c) => c.compte === "47120000")).toBe(false);
  });

  it("totaux du périmètre : Σ D = Σ C et Σ soldes débiteurs = Σ soldes créditeurs", () => {
    expect(gl.totauxPerimetre).toEqual({
      initialDebit: 11200, initialCredit: 11200, totalDebit: 1800, totalCredit: 1800,
      soldeDebiteur: 11800, soldeCrediteur: 11800,
    });
    expect(gl.equilibre).toBe(true);
  });

  it("sans date de début, les écritures de janvier sont des mouvements, l'AN reste un report", () => {
    const g = construireGrandLivre(LIGNES, { fin: "2026-06-30" });
    const c = g.comptes.find((x) => x.compte === "34210002")!;
    expect(c).toMatchObject({ soldeInitial: 0, totalDebit: 1200, totalCredit: 1200, soldeFinal: 0 });
    expect(g.comptes.find((x) => x.compte === "51410000")!.initialDebit).toBe(10000);
  });

  it("option : les à-nouveaux peuvent être lus comme des mouvements", () => {
    const g = construireGrandLivre(LIGNES, { fin: "2026-06-30", reportsEnSoldeInitial: false });
    const banque = g.comptes.find((x) => x.compte === "51410000")!;
    expect(banque).toMatchObject({ soldeInitial: 0, totalDebit: 11200, soldeFinal: 11200 });
    expect(banque.mouvements.map((m) => m.journal_code)).toEqual(["AN", "BQ"]);
  });

  it("intitulé fourni par l'appelant", () => {
    const g = construireGrandLivre(LIGNES, { intitule: (c) => (c.startsWith("4411") ? "ATLAS SARL" : "") });
    expect(g.comptes.find((x) => x.compte === "44110005")!.intitule).toBe("ATLAS SARL");
  });
});

describe("drill-down — les mouvements d'un dossier-compte", () => {
  it("contient exactement les écritures du compte dans la période, avec solde progressif", () => {
    const c = compte("34210002");
    expect(c.mouvements.map((m) => m.id)).toEqual(
      LIGNES.filter((l) => l.compte_numero === "34210002" && l.date_ecriture >= "2026-02-01" && l.date_ecriture <= "2026-06-30").map((l) => l.id),
    );
    expect(c.mouvements.at(-1)!.solde).toBe(c.soldeFinal);
  });

  it("le dernier solde progressif égale le solde final, pour chaque compte", () => {
    for (const c of gl.comptes) {
      expect(c.mouvements.length ? c.mouvements.at(-1)!.solde : c.soldeInitial, c.compte).toBe(c.soldeFinal);
      expect(c.soldeInitial + c.totalDebit - c.totalCredit, c.compte).toBeCloseTo(c.soldeFinal, 2);
    }
  });

  it("trie par date, journal puis pièce — quel que soit l'ordre d'arrivée", () => {
    const g = construireGrandLivre([
      L("2026-05-02", "OD", "51410000", 3, 0, "B"),
      L("2026-05-01", "CAI", "51410000", 2, 0, "Z"),
      L("2026-05-02", "BQ", "51410000", 1, 0, "A"),
    ]);
    const mvts = g.comptes[0].mouvements;
    expect(mvts.map((m) => m.debit)).toEqual([2, 1, 3]);
    expect(mvts.map((m) => m.solde)).toEqual([2, 3, 6]);
  });

  it("conserve les liens vers la pièce (facture, transaction) sur chaque mouvement", () => {
    const m = compte("51410000").mouvements[0];
    expect(m.transaction_id).toBe("t1");
  });
});

describe("filtres et ergonomie", () => {
  it("par classe PCM", () => {
    const g = construireGrandLivre(LIGNES, { debut: "2026-02-01", fin: "2026-06-30", classes: ["6", "7"] });
    expect(g.comptes.map((c) => c.compte)).toEqual(["61330000", "71240000"]);
    // Le contrôle d'équilibre porte TOUJOURS sur le périmètre complet.
    expect(g.equilibre).toBe(true);
    expect(g.totaux.totalDebit).toBe(500);
  });

  it("par intervalle de comptes, bornes courtes complétées", () => {
    const g = construireGrandLivre(LIGNES, { debut: "2026-02-01", fin: "2026-06-30", compteDe: "3421", compteA: "4411" });
    expect(g.comptes.map((c) => c.compte)).toEqual(["34210002", "34580000", "44110005"]);
    expect(dansIntervalle("44110005", "4411", "4411")).toBe(true);
    expect(dansIntervalle("44120000", "4411", "4411")).toBe(false);
    expect(dansIntervalle("5141", null, null)).toBe(true);
  });

  it("masque les comptes soldés et dit combien", () => {
    const g = construireGrandLivre(LIGNES, { debut: "2026-02-01", fin: "2026-06-30", masquerSoldes: true });
    expect(g.comptes.some((c) => c.compte === "34210002")).toBe(false);
    expect(g.nbComptesMasques).toBe(1);
    expect(g.totauxPerimetre).toEqual(gl.totauxPerimetre);
  });
});

describe("concordance Grand Livre ⇄ Journal Général", () => {
  it("les deux livres portent les mêmes montants", () => {
    const c = concordanceJournal(LIGNES, gl);
    expect(c).toMatchObject({ journalDebit: 13000, journalCredit: 13000, grandLivreDebit: 13000, grandLivreCredit: 13000, ok: true });
  });

  it("détecte une écriture lue par le journal mais pas par le grand livre (compte vide)", () => {
    const journal = [...LIGNES, L("2026-04-01", "OD", "", 99, 0, "SANS-COMPTE")];
    const g = construireGrandLivre(journal, { debut: "2026-02-01", fin: "2026-06-30" });
    const c = concordanceJournal(journal, g);
    expect(c.ok).toBe(false);
    expect(c.ecartDebit).toBe(99);
  });

  it("reste vraie quand l'écran filtre par classe ou masque les soldés", () => {
    const g = construireGrandLivre(LIGNES, { debut: "2026-02-01", fin: "2026-06-30", classes: ["5"], masquerSoldes: true });
    expect(concordanceJournal(LIGNES, g).ok).toBe(true);
  });
});

describe("navigation vers la pièce source", () => {
  it("vente : facture client, puis numéro, puis pièce comptable", () => {
    expect(planPieceSource(LIGNES[2]).map((p) => p.type)).toEqual(["facture_client", "numero", "piece_comptable"]);
  });
  it("banque : transaction d'abord", () => {
    expect(planPieceSource(LIGNES[5]).map((p) => p.type)).toEqual(["transaction", "numero", "piece_comptable"]);
  });
  it("achat : l'identifiant de la facture fournisseur porté en référence", () => {
    expect(planPieceSource(LIGNES[7])).toEqual([
      { type: "facture_fournisseur", id: UUID_FF },
      { type: "piece_comptable", journal: "ACH", reference: UUID_FF, date: "2026-03-05" },
    ]);
  });
  it("sans aucun lien, la pièce comptable reste toujours ouvrable", () => {
    expect(planPieceSource(L("2026-04-01", "OD", "4711", 1, 0, null))).toEqual([
      { type: "piece_comptable", journal: "OD", reference: null, date: "2026-04-01" },
    ]);
  });
  it("la pièce comptable regroupe les lignes de la même écriture", () => {
    const p = lignesDeLaPiece(LIGNES, { journal: "ACH", reference: UUID_FF, date: "2026-03-05" });
    expect(p.map((l) => l.compte_numero)).toEqual(["61330000", "34580000", "44110005"]);
    expect(p.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0)).toBe(0);
  });
});

describe("exports réglementaires", () => {
  const entete = { raisonSociale: "ATLAS TECH TRADING SARL", ice: "001234567000089", identifiantFiscal: "12345678", rc: "4567", exercice: 2026, editeLe: "15/09/2026" };

  it("Excel : un bloc par compte et un total général équilibré, montants numériques", () => {
    const t = grandLivreEnTableau(gl, entete);
    expect(t[0]).toEqual(["GRAND LIVRE GÉNÉRAL"]);
    expect(t.filter((r) => r[5] === "Solde initial / report")).toHaveLength(gl.comptes.length);
    expect(t.filter((r) => String(r[5]).startsWith("Total compte"))).toHaveLength(gl.comptes.length);
    const total = t.at(-1)!;
    expect(total.slice(5)).toEqual(["TOTAL GÉNÉRAL", "", 13000, 13000, 11800, 11800]);
    const mvt = t.find((r) => r[4] === UUID_FF && r[0] === "61330000")!;
    expect(typeof mvt[7]).toBe("number");
  });

  it("PDF : document valide, identifié, paginé", async () => {
    const octets = await genererPdfGrandLivre(gl, entete);
    expect(new TextDecoder().decode(octets.slice(0, 5))).toBe("%PDF-");
    const doc = await PDFDocument.load(octets);
    // 8 comptes (en-tête, report, mouvements, total, solde) tiennent sur 1 à 2 pages A4 paysage.
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(doc.getPageCount()).toBeLessThanOrEqual(2);
    expect(doc.getTitle()).toMatch(/ATLAS TECH TRADING/);
  });

  it("PDF : un grand livre volumineux se répartit sur plusieurs pages", async () => {
    const lignes: LigneGrandLivre[] = [];
    for (let i = 0; i < 60; i++) {
      for (let j = 0; j < 6; j++) {
        lignes.push(L(`2026-0${1 + (j % 9)}-1${j}`, "OD", `6${String(1110 + i)}`, 100 + j, 0, `P${i}-${j}`, { libelle: "Libellé très long avec des accents éèàç et un séparateur 1 234 → suite" }));
        lignes.push(L(`2026-0${1 + (j % 9)}-1${j}`, "OD", "44110001", 0, 100 + j, `P${i}-${j}`));
      }
    }
    const g = construireGrandLivre(lignes, { intitule: () => "Intitulé PCM" });
    const doc = await PDFDocument.load(await genererPdfGrandLivre(g, entete));
    expect(doc.getPageCount()).toBeGreaterThan(3);
  });

  it("PDF : texte rendu compatible WinAnsi, montants au format marocain", () => {
    expect(texteWinAnsi("1 234 → é’")).toBe("1 234 -> é’");
    expect(texteWinAnsi("中文")).toBe("??");
    expect(montantPdf(-1234567.8)).toBe("-1 234 567,80");
    expect(montantPdf(0)).toBe("0,00");
  });
});
