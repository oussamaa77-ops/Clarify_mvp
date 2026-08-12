import { describe, it, expect } from "vitest";
import {
  bornesPeriode, construireOdDeclaration, construireOdPaiementDgi, controlerBouclagePeriode,
  controlerPiece, liquiderTva, referenceDeclaration,
} from "./liquidation-tva";

/** Période mars 2026 : 12 000 de TVA collectée, 4 500 de déductible. */
const MARS = [
  { journal_code: "OD", compte_numero: "44551", date_ecriture: "2026-03-05", debit: 0, credit: 8000 },
  { journal_code: "OD", compte_numero: "44551", date_ecriture: "2026-03-28", debit: 0, credit: 4000 },
  { journal_code: "OD", compte_numero: "34552", date_ecriture: "2026-03-12", debit: 4500, credit: 0 },
  // Hors période — ne doit jamais entrer dans la déclaration de mars.
  { journal_code: "OD", compte_numero: "44551", date_ecriture: "2026-04-02", debit: 0, credit: 9999 },
];

describe("bornesPeriode", () => {
  it("borne un mois, année bissextile comprise", () => {
    expect(bornesPeriode("2026-03")).toMatchObject({ debut: "2026-03-01", fin: "2026-03-31", regime: "mensuel" });
    expect(bornesPeriode("2024-02")?.fin).toBe("2024-02-29");
    expect(bornesPeriode("2026-02")?.fin).toBe("2026-02-28");
  });

  it("borne un trimestre", () => {
    expect(bornesPeriode("2026-T1")).toMatchObject({ debut: "2026-01-01", fin: "2026-03-31", regime: "trimestriel" });
    expect(bornesPeriode("2026-T4")).toMatchObject({ debut: "2026-10-01", fin: "2026-12-31" });
  });

  it("refuse une période illisible", () => {
    for (const p of ["", "2026", "2026-13", "2026-T5", "mars"]) expect(bornesPeriode(p)).toBeNull();
  });
});

describe("liquiderTva", () => {
  it("calcule la position de la période, hors écritures voisines", () => {
    const l = liquiderTva(MARS, "2026-03")!;
    expect(l).toMatchObject({ collectee: 12000, deductible: 4500, net: 7500, montant: 7500, dette: true, neant: false });
  });

  it("prend les comptes en NET : un avoir vient en diminution", () => {
    const l = liquiderTva([
      ...MARS,
      { journal_code: "OD", compte_numero: "44551", date_ecriture: "2026-03-20", debit: 2000, credit: 0 },
    ], "2026-03")!;
    expect(l.collectee).toBe(10000);
    expect(l.net).toBe(5500);
  });

  it("reconnaît le CRÉDIT DE TVA sans produire de montant négatif", () => {
    const l = liquiderTva([
      { journal_code: "OD", compte_numero: "44551", date_ecriture: "2026-03-05", debit: 0, credit: 1000 },
      { journal_code: "OD", compte_numero: "34552", date_ecriture: "2026-03-05", debit: 4000, credit: 0 },
    ], "2026-03")!;
    expect(l).toMatchObject({ net: -3000, montant: 3000, dette: false });
  });

  it("rend « néant » quand la période n'a aucun mouvement de TVA", () => {
    expect(liquiderTva([], "2026-03")!.neant).toBe(true);
  });

  it("N'INCLUT PAS les déclarations passées : on liquide le flux, pas le stock", () => {
    const avecDecl = [
      ...MARS,
      { journal_code: "OD", compte_numero: "44551", date_ecriture: "2026-03-31", debit: 12000, credit: 0, reference_piece: referenceDeclaration("2026-03") },
    ];
    expect(liquiderTva(avecDecl, "2026-03")!.collectee).toBe(12000);
  });

  it("ramasse les sous-comptes par leur racine", () => {
    const l = liquiderTva([
      { journal_code: "OD", compte_numero: "4455", date_ecriture: "2026-03-01", debit: 0, credit: 500 },
      { journal_code: "OD", compte_numero: "34551", date_ecriture: "2026-03-01", debit: 200, credit: 0 },
    ], "2026-03")!;
    expect(l).toMatchObject({ collectee: 500, deductible: 200 });
  });

  it("agrège un trimestre entier", () => {
    expect(liquiderTva(MARS, "2026-T1")!.collectee).toBe(12000);
  });
});

describe("construireOdDeclaration", () => {
  it("solde les deux comptes et constate la dette au 4456", () => {
    const od = construireOdDeclaration(liquiderTva(MARS, "2026-03")!);
    expect(od).toHaveLength(3);
    expect(od[0]).toMatchObject({ compte_numero: "44551", debit: 12000, credit: 0 });
    expect(od[1]).toMatchObject({ compte_numero: "34552", debit: 0, credit: 4500 });
    expect(od[2]).toMatchObject({ compte_numero: "4456", debit: 0, credit: 7500 });
    expect(controlerPiece(od).ok).toBe(true);
  });

  it("date l'OD du DERNIER jour de la période", () => {
    expect(construireOdDeclaration(liquiderTva(MARS, "2026-03")!)[0].date_ecriture).toBe("2026-03-31");
  });

  it("inverse la troisième ligne en crédit de TVA", () => {
    const liq = liquiderTva([
      { journal_code: "OD", compte_numero: "44551", date_ecriture: "2026-03-05", debit: 0, credit: 1000 },
      { journal_code: "OD", compte_numero: "34552", date_ecriture: "2026-03-05", debit: 4000, credit: 0 },
    ], "2026-03")!;
    const od = construireOdDeclaration(liq);
    expect(od[2]).toMatchObject({ compte_numero: "4456", debit: 3000, credit: 0 });
    expect(od[2].libelle).toMatch(/Crédit de TVA reportable/);
    expect(controlerPiece(od).ok).toBe(true);
  });

  it("ne produit AUCUNE écriture sur une période néant", () => {
    expect(construireOdDeclaration(liquiderTva([], "2026-03")!)).toEqual([]);
  });

  it("n'écrit pas de ligne à zéro quand une seule nature a bougé", () => {
    const liq = liquiderTva([
      { journal_code: "OD", compte_numero: "44551", date_ecriture: "2026-03-05", debit: 0, credit: 900 },
    ], "2026-03")!;
    const od = construireOdDeclaration(liq);
    expect(od.map((l) => l.compte_numero)).toEqual(["44551", "4456"]);
    expect(controlerPiece(od).ok).toBe(true);
  });

  it("porte une référence idempotente, retrouvable par période", () => {
    expect(construireOdDeclaration(liquiderTva(MARS, "2026-03")!)[0].reference_piece).toBe("DECL-TVA-2026-03");
  });
});

describe("construireOdPaiementDgi", () => {
  it("éteint la dette : D 4456 / C banque", () => {
    const od = construireOdPaiementDgi({ montant: 7500, date: "2026-04-28", periode: "2026-03" });
    expect(od[0]).toMatchObject({ compte_numero: "4456", debit: 7500, credit: 0 });
    expect(od[1]).toMatchObject({ compte_numero: "5141", debit: 0, credit: 7500 });
    expect(controlerPiece(od).ok).toBe(true);
  });

  it("accepte un autre compte de trésorerie", () => {
    expect(construireOdPaiementDgi({ montant: 100, date: "2026-04-28", periode: "2026-03", compteBanque: "51420000" })[1].compte_numero)
      .toBe("51420000");
  });

  it("ne produit rien pour un montant nul — un crédit de TVA ne se paie pas", () => {
    expect(construireOdPaiementDgi({ montant: 0, date: "2026-04-28", periode: "2026-03" })).toEqual([]);
  });
});

describe("controlerPiece — invariant de partie double", () => {
  it("accepte une pièce soldée et refuse un écart", () => {
    expect(controlerPiece([{ debit: 100 }, { credit: 100 }]).ok).toBe(true);
    const ko = controlerPiece([{ debit: 100 }, { credit: 90 }]);
    expect(ko.ok).toBe(false);
    expect(ko.ecart).toBe(10);
    expect(ko.raison).toMatch(/déséquilibrée/);
  });

  it("tolère le centime, pas au-delà", () => {
    expect(controlerPiece([{ debit: 100 }, { credit: 100.004 }]).ok).toBe(true);
    expect(controlerPiece([{ debit: 100 }, { credit: 100.02 }]).ok).toBe(false);
  });

  it("accepte une pièce vide : rien à insérer n'est pas une erreur", () => {
    expect(controlerPiece([]).ok).toBe(true);
  });
});

describe("controlerBouclagePeriode", () => {
  it("constate le bouclage quand déclaration ET paiement sont passés", () => {
    const gl = [
      ...MARS.filter((l) => l.date_ecriture < "2026-04"),
      ...construireOdDeclaration(liquiderTva(MARS, "2026-03")!),
      ...construireOdPaiementDgi({ montant: 7500, date: "2026-03-31", periode: "2026-03" }),
    ];
    const c = controlerBouclagePeriode(gl, "2026-03")!;
    expect(c).toMatchObject({ collectee: 0, deductible: 0, due: 0, solde: true });
  });

  it("signale la déclaration NON PAYÉE par un 4456 restant", () => {
    const gl = [
      ...MARS.filter((l) => l.date_ecriture < "2026-04"),
      ...construireOdDeclaration(liquiderTva(MARS, "2026-03")!),
    ];
    const c = controlerBouclagePeriode(gl, "2026-03")!;
    expect(c.solde).toBe(false);
    expect(c.due).toBe(7500);
    expect(c.raison).toMatch(/4456 = 7500\.00/);
  });

  it("signale une TVA encaissée hors déclaration", () => {
    const gl = [
      ...MARS.filter((l) => l.date_ecriture < "2026-04"),
      ...construireOdDeclaration(liquiderTva(MARS, "2026-03")!),
      ...construireOdPaiementDgi({ montant: 7500, date: "2026-03-31", periode: "2026-03" }),
      { journal_code: "OD", compte_numero: "44551", date_ecriture: "2026-03-31", debit: 0, credit: 300 },
    ];
    const c = controlerBouclagePeriode(gl, "2026-03")!;
    expect(c.solde).toBe(false);
    expect(c.raison).toMatch(/44551 = 300\.00/);
  });

  // ── Le SENS du 4456 décide, pas sa nullité ────────────────────────────────
  // Une dette non prélevée et un crédit reportable laissent tous deux un solde
  // au 4456 ; seul le sens les distingue. Les confondre déclarerait « non
  // soldée » toute période suivant un crédit, définitivement.
  const CREDIT = [
    { journal_code: "OD", compte_numero: "34552", date_ecriture: "2026-05-04", debit: 240, credit: 0 },
  ];

  it("boucle une période à crédit de TVA : le 4456 débiteur est une CRÉANCE, pas une dette", () => {
    const gl = [...CREDIT, ...construireOdDeclaration(liquiderTva(CREDIT, "2026-05")!)];
    const c = controlerBouclagePeriode(gl, "2026-05")!;
    expect(c).toMatchObject({ collectee: 0, deductible: 0, solde: true, creditReporte: 240 });
    expect(c.due).toBe(-240);
    expect(c.raison).toMatch(/crédit de TVA de 240\.00 MAD reporté/i);
  });

  it("ne boucle PAS tant que le crédit n'est pas déclaré", () => {
    // 34552 encore chargé : la déclaration n'a pas eu lieu.
    const c = controlerBouclagePeriode(CREDIT, "2026-05")!;
    expect(c.solde).toBe(false);
    expect(c.raison).toMatch(/34552 = 240\.00/);
  });

  it("laisse le crédit reporté peser sur les périodes suivantes sans les bloquer", () => {
    const gl = [...CREDIT, ...construireOdDeclaration(liquiderTva(CREDIT, "2026-05")!)];
    const c = controlerBouclagePeriode(gl, "2026-06")!;
    expect(c.solde).toBe(true);
    expect(c.creditReporte).toBe(240);
  });

  it("rend creditReporte à 0 quand le 4456 porte une dette", () => {
    const gl = [
      ...MARS.filter((l) => l.date_ecriture < "2026-04"),
      ...construireOdDeclaration(liquiderTva(MARS, "2026-03")!),
    ];
    const c = controlerBouclagePeriode(gl, "2026-03")!;
    expect(c.creditReporte).toBe(0);
    expect(c.solde).toBe(false);
    expect(c.raison).toMatch(/TVA due non prélevée/);
  });
});
