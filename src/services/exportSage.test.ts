import { describe, it, expect } from "vitest";
import {
  COLONNES_FEC, COLONNES_SAGE100,
  buildCsvGenerique, buildFEC, buildSage100CSV, construireExport, controlerExport,
  dateFEC, dateSage, echapperCsv, montantFR, nomFichierExport, type EcritureExport,
} from "./exportSage";

// Jeu d'écritures : une vente lettrée AA, son règlement, et l'OD de bascule TVA.
const ecritures: EcritureExport[] = [
  {
    id: "1", journal_code: "VTE", compte_numero: "34210001", date_ecriture: "2026-03-10",
    libelle: "Vente FA-12", debit: 1200, credit: 0, reference_piece: "FA-12",
    lettrage_code: "AA", lettrage_date: "2026-04-01",
  },
  {
    id: "2", journal_code: "VTE", compte_numero: "7111", date_ecriture: "2026-03-10",
    libelle: "Vente FA-12", debit: 0, credit: 1000, reference_piece: "FA-12",
  },
  {
    id: "3", journal_code: "VTE", compte_numero: "4458", date_ecriture: "2026-03-10",
    libelle: "TVA en attente FA-12", debit: 0, credit: 200, reference_piece: "FA-12",
  },
  {
    id: "4", journal_code: "BQ", compte_numero: "34210001", date_ecriture: "2026-04-01",
    libelle: "Règlement FA-12", debit: 0, credit: 1200, reference_piece: "FA-12",
    lettrage_code: "AA", lettrage_date: "2026-04-01",
  },
  // Contrepartie de trésorerie du règlement : sans elle le lot ne s'équilibre
  // pas, et les contrôles d'export porteraient sur une pièce incomplète.
  {
    id: "5", journal_code: "BQ", compte_numero: "5141", date_ecriture: "2026-04-01",
    libelle: "Règlement FA-12", debit: 1200, credit: 0, reference_piece: "FA-12",
  },
];

const lignesDe = (csv: string) => csv.split("\r\n");

describe("formatage", () => {
  it("convertit les dates aux deux formats attendus", () => {
    expect(dateFEC("2026-03-10")).toBe("20260310");
    expect(dateSage("2026-03-10")).toBe("10/03/2026");
  });

  it("rend une chaîne vide sur une date illisible", () => {
    for (const mauvaise of ["", null, undefined, "10/03/2026", "2026-3-1"]) {
      expect(dateFEC(mauvaise as any)).toBe("");
      expect(dateSage(mauvaise as any)).toBe("");
    }
  });

  // Un point décimal serait lu comme séparateur de milliers en locale FR.
  it("écrit les montants avec une virgule décimale", () => {
    expect(montantFR(1234.5)).toBe("1234,50");
    expect(montantFR(0)).toBe("0,00");
    expect(montantFR(null)).toBe("0,00");
    expect(montantFR("96.33")).toBe("96,33");
  });

  it("échappe les valeurs contenant le séparateur", () => {
    expect(echapperCsv("SARL; Casa", ";")).toBe('"SARL; Casa"');
    expect(echapperCsv('Dit "le grand"', ";")).toBe('"Dit ""le grand"""');
    expect(echapperCsv("simple", ";")).toBe("simple");
  });

  it("aplatit les retours à la ligne, qui casseraient le fichier", () => {
    expect(echapperCsv("ligne1\nligne2", ";")).toBe("ligne1 ligne2");
  });
});

describe("export Sage 100", () => {
  const csv = buildSage100CSV(ecritures);

  it("porte l'en-tête attendu et une ligne par écriture", () => {
    const l = lignesDe(csv);
    expect(l[0]).toBe(COLONNES_SAGE100.join(";"));
    expect(l).toHaveLength(ecritures.length + 1);
  });

  // C'est LE point du format : le rapprochement fait ici ne doit pas être refait
  // à la main dans Sage.
  it("fait apparaître le code de lettrage AA dans le fichier", () => {
    expect(csv).toContain("AA");
    const ligneVente = lignesDe(csv)[1].split(";");
    const iLettrage = COLONNES_SAGE100.indexOf("Lettrage" as never);
    expect(ligneVente[iLettrage]).toBe("AA");
    expect(ligneVente[iLettrage + 1]).toBe("01/04/2026");
  });

  it("laisse la colonne lettrage vide sur une écriture non lettrée", () => {
    const ligneProduit = lignesDe(csv)[2].split(";");
    expect(ligneProduit[COLONNES_SAGE100.indexOf("Lettrage" as never)]).toBe("");
  });

  // Un « 0,00 » explicite créerait dans Sage une ligne à zéro dans le journal.
  it("laisse vide le sens non mouvementé", () => {
    const ligneVente = lignesDe(csv)[1].split(";");
    expect(ligneVente[COLONNES_SAGE100.indexOf("Debit" as never)]).toBe("1200,00");
    expect(ligneVente[COLONNES_SAGE100.indexOf("Credit" as never)]).toBe("");
  });

  it("utilise le format de date français", () => {
    expect(csv).toContain("10/03/2026");
  });
});

describe("export FEC", () => {
  const fec = buildFEC(ecritures, { intitules: { "34210001": "Client ACME" } });
  const lignes = lignesDe(fec);
  const cols = (i: number) => lignes[i].split("\t");

  it("porte les 18 colonnes normalisées, dans l'ordre", () => {
    expect(lignes[0].split("\t")).toEqual([...COLONNES_FEC]);
    expect(cols(1)).toHaveLength(18);
  });

  it("place le lettrage en EcritureLet et DateLet", () => {
    const iLet = COLONNES_FEC.indexOf("EcritureLet" as never);
    expect(cols(1)[iLet]).toBe("AA");
    expect(cols(1)[iLet + 1]).toBe("20260401");
    expect(cols(2)[iLet]).toBe("");     // ligne non lettrée
  });

  // Si chaque ligne portait son propre numéro, le contrôle d'équilibre du FEC
  // verrait autant d'écritures déséquilibrées que de lignes.
  it("regroupe les lignes d'une même pièce sous un seul EcritureNum", () => {
    const iNum = COLONNES_FEC.indexOf("EcritureNum" as never);
    expect(cols(1)[iNum]).toBe(cols(2)[iNum]);
    expect(cols(1)[iNum]).toBe(cols(3)[iNum]);
    expect(cols(4)[iNum]).not.toBe(cols(1)[iNum]);   // journal + date différents
  });

  it("nomme le journal et le compte", () => {
    expect(cols(1)[COLONNES_FEC.indexOf("JournalLib" as never)]).toBe("Journal des ventes");
    expect(cols(1)[COLONNES_FEC.indexOf("CompteLib" as never)]).toBe("Client ACME");
  });

  it("écrit les dates au format AAAAMMJJ", () => {
    expect(cols(1)[COLONNES_FEC.indexOf("EcritureDate" as never)]).toBe("20260310");
  });

  it("ne laisse aucune tabulation dans une valeur", () => {
    const avecTab = buildFEC([{ ...ecritures[0], libelle: "Vente\tFA-12" }]);
    expect(lignesDe(avecTab)[1].split("\t")).toHaveLength(18);
  });
});

describe("export CSV générique", () => {
  it("expose côte à côte le lettrage généré et celui d'origine", () => {
    const csv = buildCsvGenerique([
      { ...ecritures[0], code_lettrage: "B" },
    ]);
    const l = lignesDe(csv)[1].split(";");
    expect(l[l.length - 2]).toBe("AA");   // généré
    expect(l[l.length - 1]).toBe("B");    // importé
  });
});

describe("contrôles avant remise", () => {
  it("valide un lot équilibré et compte les lignes lettrées", () => {
    const c = controlerExport(ecritures);
    expect(c.lignes).toBe(5);
    expect(c.totalDebit).toBe(2400);
    expect(c.totalCredit).toBe(2400);
    expect(c.equilibre).toBe(true);
    expect(c.nbLettrees).toBe(2);
    expect(c.lettragesDesequilibres).toEqual([]);
  });

  it("signale un lot déséquilibré", () => {
    const c = controlerExport([{ ...ecritures[0], debit: 999 }, ecritures[3]]);
    expect(c.equilibre).toBe(false);
  });

  // Un code dont les lignes ne se soldent pas trahit un lettrage corrompu :
  // c'est exactement ce que l'import de Sage refusera.
  it("signale un code de lettrage déséquilibré", () => {
    const c = controlerExport([
      { ...ecritures[0], debit: 1200, lettrage_code: "AA" },
      { ...ecritures[3], credit: 900, lettrage_code: "AA" },
    ]);
    expect(c.lettragesDesequilibres).toEqual(["AA"]);
  });

  it("compte les écritures sans date exploitable", () => {
    expect(controlerExport([{ ...ecritures[0], date_ecriture: null }]).sansDate).toBe(1);
  });
});

describe("nommage et aiguillage", () => {
  it("nomme le FEC selon la norme <ID>FEC<AAAAMMJJ>.txt", () => {
    expect(nomFichierExport("fec", "001642874000089", "2026-12-31"))
      .toBe("001642874000089FEC20261231.txt");
  });

  it("nettoie un identifiant non alphanumérique", () => {
    expect(nomFichierExport("fec", "ICE-1234/56", "2026-12-31")).toBe("ICE123456FEC20261231.txt");
    expect(nomFichierExport("fec", "", "2026-12-31")).toBe("DOSSIERFEC20261231.txt");
  });

  it("construireExport aiguille vers le bon format", () => {
    expect(construireExport("sage100", ecritures).split("\r\n")[0]).toBe(COLONNES_SAGE100.join(";"));
    expect(construireExport("fec", ecritures).split("\r\n")[0]).toBe(COLONNES_FEC.join("\t"));
    expect(construireExport("csv", ecritures)).toContain("Intitule_compte");
  });

  it("produit un fichier d'en-tête seul sur un lot vide", () => {
    for (const f of ["sage100", "fec", "csv"] as const) {
      expect(construireExport(f, []).split("\r\n")).toHaveLength(1);
    }
  });
});
