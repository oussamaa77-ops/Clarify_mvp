import { describe, it, expect } from "vitest";
import {
  bornesPeriode, construireOdDeclaration, construireOdPaiementDgi, controlerBouclagePeriode,
  controlerPiece, liquiderTva, referenceDeclaration, reglementsDgiPeriode, resteExigible,
  soldeTvaDue, construireOdRegularisationTva, PREFIXE_REGULARISATION_TVA,
  COMPTE_TVA_DEDUCTIBLE, COMPTE_TVA_COLLECTEE, COMPTE_TVA_DUE,
} from "./liquidation-tva";
import { controlerJournalOd } from "./genererEcritures";

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

  // Le prélèvement de TVA est un vrai décaissement : il appartient au journal que
  // le rapprochement bancaire lit. Émis en OD — ce qu'il était —, il créditait
  // 5141 hors de toute vue de trésorerie, et le grand livre divergeait du relevé.
  it("passe en journal BQ, jamais en OD : le journal OD ne porte pas de trésorerie", () => {
    const od = construireOdPaiementDgi({ montant: 7500, date: "2026-04-28", periode: "2026-03" });
    expect(od.every((l) => l.journal_code === "BQ")).toBe(true);
    expect(controlerJournalOd(od).ok).toBe(true);
  });

  it("bascule en CAI quand la TVA est réglée par la caisse (rubrique 516)", () => {
    const od = construireOdPaiementDgi({
      montant: 300, date: "2026-04-28", periode: "2026-03", compteBanque: "51610000",
    });
    expect(od.every((l) => l.journal_code === "CAI")).toBe(true);
    expect(controlerJournalOd(od).ok).toBe(true);
  });

  it("l'OD de DÉCLARATION reste en OD — elle ne déplace aucun argent", () => {
    const od = construireOdDeclaration(liquiderTva(MARS, "2026-03")!);
    expect(od.every((l) => l.journal_code === "OD")).toBe(true);
    expect(controlerJournalOd(od).ok).toBe(true);
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

// ─── Règlements DGI : rattachés par la PIÈCE, pas par la date ────────────────
// La TVA de mars se règle en avril. Tout ce qui suit vérifie qu'on sait le voir.
describe("reglementsDgiPeriode", () => {
  /** Mars déclarée (7 500 de dette), puis prélevée le 20 avril. */
  const grandLivre = (paiements: { date: string; montant: number }[] = []) => [
    ...MARS.filter((l) => l.date_ecriture < "2026-04"),
    ...construireOdDeclaration(liquiderTva(MARS, "2026-03")!),
    ...paiements.flatMap((p) =>
      construireOdPaiementDgi({ montant: p.montant, date: p.date, periode: "2026-03" })),
  ];

  it("voit un prélèvement daté APRÈS la fin de la période", () => {
    const r = reglementsDgiPeriode(grandLivre([{ date: "2026-04-20", montant: 7500 }]), "2026-03");
    expect(r).toMatchObject({ declaree: true, detteConstatee: 7500, regle: 7500, reste: 0 });
    expect(r.dernierReglement).toBe("2026-04-20");
  });

  it("laisse le reste dû sur un règlement partiel", () => {
    const r = reglementsDgiPeriode(grandLivre([{ date: "2026-04-20", montant: 2500 }]), "2026-03");
    expect(r).toMatchObject({ regle: 2500, reste: 5000 });
  });

  it("cumule les échéances et retient la dernière date", () => {
    const r = reglementsDgiPeriode(grandLivre([
      { date: "2026-04-20", montant: 2500 }, { date: "2026-05-18", montant: 5000 },
    ]), "2026-03");
    expect(r).toMatchObject({ regle: 7500, reste: 0, dernierReglement: "2026-05-18" });
  });

  it("ne prend pas la déclaration elle-même pour un règlement", () => {
    const r = reglementsDgiPeriode(grandLivre(), "2026-03");
    expect(r).toMatchObject({ declaree: true, regle: 0, reste: 7500, dernierReglement: null });
  });

  // Piège : sur un crédit, la ligne de DÉCLARATION est un DÉBIT du 4456. Un
  // simple « existe-t-il un débit ? » la compterait comme un paiement.
  it("ne confond pas le débit d'un crédit reportable avec un prélèvement", () => {
    const CREDIT = [
      { journal_code: "OD", compte_numero: "44551", date_ecriture: "2026-05-04", debit: 0, credit: 1000 },
      { journal_code: "OD", compte_numero: "34552", date_ecriture: "2026-05-09", debit: 4000, credit: 0 },
    ];
    const gl = [...CREDIT, ...construireOdDeclaration(liquiderTva(CREDIT, "2026-05")!)];
    expect(reglementsDgiPeriode(gl, "2026-05"))
      .toMatchObject({ declaree: true, detteConstatee: 0, regle: 0, reste: 0 });
  });

  it("ne rattache rien à une période non déclarée", () => {
    expect(reglementsDgiPeriode(MARS, "2026-03"))
      .toMatchObject({ declaree: false, detteConstatee: 0, regle: 0, reste: 0 });
  });

  it("n'attribue pas à mars le règlement d'une autre période", () => {
    const gl = [
      ...grandLivre(),
      ...construireOdPaiementDgi({ montant: 900, date: "2026-04-20", periode: "2026-02" }),
    ];
    expect(reglementsDgiPeriode(gl, "2026-03").regle).toBe(0);
    expect(reglementsDgiPeriode(gl, "2026-02").regle).toBe(900);
  });
});

describe("soldeTvaDue / resteExigible", () => {
  it("somme le 4456 à ce jour, toutes dates confondues", () => {
    const gl = [
      ...construireOdDeclaration(liquiderTva(MARS, "2026-03")!),
      ...construireOdPaiementDgi({ montant: 2500, date: "2026-04-20", periode: "2026-03" }),
    ];
    expect(soldeTvaDue(gl)).toBe(5000);
  });

  it("ramasse les sous-comptes du 4456 et ignore les autres comptes", () => {
    expect(soldeTvaDue([
      { compte_numero: "44560000", debit: 0, credit: 300 },
      { compte_numero: "5141", debit: 0, credit: 9999 },
    ])).toBe(300);
  });

  it("retient la plus petite des deux bornes, et jamais un montant négatif", () => {
    // Dette de la pièce encore ouverte, mais compte déjà éteint par un crédit
    // antérieur : rien n'est exigible.
    expect(resteExigible(1880, -902)).toBe(0);
    // Compte créditeur d'un arriéré, mais CETTE déclaration est réglée.
    expect(resteExigible(0, 4200)).toBe(0);
    expect(resteExigible(7500, 7500)).toBe(7500);
    expect(resteExigible(7500, 3000)).toBe(3000);
  });
});

// ─── Régularisation d'une TVA déclarée par anticipation ─────────────────────
//
// Le cas SOMADIR 2024-11 : 3 360,00 de TVA déduits sur une facture fournisseur
// jamais payée. Sous le régime des encaissements la déduction n'était pas
// acquise ; la déclaration étant déposée, on ne la réécrit pas — on la reprend
// sur l'exercice ouvert.
describe("construireOdRegularisationTva", () => {
  const REGUL = {
    periodeRegularisee: "2024-11", sens: "deduction" as const,
    montant: 3360, date: "2026-08-28", motif: "FA-2024-0892",
  };

  it("rend la TVA déduite à tort : D 34552 / C 4456", () => {
    const od = construireOdRegularisationTva(REGUL);
    expect(od).toHaveLength(2);
    const tva = od.find((l) => l.compte_numero === COMPTE_TVA_DEDUCTIBLE)!;
    const etat = od.find((l) => l.compte_numero === COMPTE_TVA_DUE)!;
    expect(tva.debit).toBe(3360);
    expect(etat.credit).toBe(3360);
    expect(controlerPiece(od).ok).toBe(true);
  });

  it("inverse le sens pour une collecte anticipée : C 44551 / D 4456", () => {
    const od = construireOdRegularisationTva({ ...REGUL, sens: "collecte" });
    expect(od.find((l) => l.compte_numero === COMPTE_TVA_COLLECTEE)!.credit).toBe(3360);
    expect(od.find((l) => l.compte_numero === COMPTE_TVA_DUE)!.debit).toBe(3360);
  });

  it("porte la période CORRIGÉE en référence, pas celle de l'écriture", () => {
    const od = construireOdRegularisationTva(REGUL);
    expect(od[0].reference_piece).toBe(`${PREFIXE_REGULARISATION_TVA}2024-11`);
    expect(od[0].date_ecriture).toBe("2026-08-28");
  });

  it("refuse un montant nul ou une période illisible", () => {
    expect(construireOdRegularisationTva({ ...REGUL, montant: 0 })).toEqual([]);
    expect(construireOdRegularisationTva({ ...REGUL, periodeRegularisee: "n'importe" })).toEqual([]);
  });

  it("reste HORS FLUX : elle ne se rouvre pas une déduction à elle-même", () => {
    // Le piège central. Sans exclusion, le débit du 34552 serait compté comme
    // TVA déductible du mois de la régularisation : elle s'accorderait la
    // déduction qu'elle est censée reprendre, et l'effet serait nul.
    const od = construireOdRegularisationTva(REGUL);
    const liq = liquiderTva(od, "2026-08")!;
    expect(liq.deductible).toBe(0);
    expect(liq.neant).toBe(true);
  });

  it("solde le compte DÉFINITIVEMENT, sans le rouvrir à la déclaration suivante", () => {
    // La vraie question : après régularisation, le 34552 reste-t-il à zéro ?
    // Une écriture comptée dans le flux le ferait repartir créditeur à chaque
    // déclaration, indéfiniment.
    const declarationFautive = [
      { journal_code: "OD", compte_numero: COMPTE_TVA_DEDUCTIBLE, date_ecriture: "2024-11-30",
        debit: 0, credit: 3360, reference_piece: referenceDeclaration("2024-11") },
    ];
    const regul = construireOdRegularisationTva(REGUL);
    const grandLivre = [...declarationFautive, ...regul];

    const solde = (lignes: typeof grandLivre) => lignes
      .filter((l) => l.compte_numero === COMPTE_TVA_DEDUCTIBLE)
      .reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);
    expect(solde(grandLivre)).toBe(0);

    // Août ne déclare rien de ce chef : la déclaration du mois est « néant ».
    const aout = liquiderTva(grandLivre, "2026-08")!;
    expect(aout.neant).toBe(true);
    expect(construireOdDeclaration(aout)).toEqual([]);
    expect(solde(grandLivre)).toBe(0);
  });

  it("laisse le compte d'ATTENTE intact — la déduction reste due au paiement", () => {
    // Purger le 3458 en même temps ratifierait l'anticipation. La TVA doit
    // redevenir déductible le jour du décaissement, et une seule fois.
    const od = construireOdRegularisationTva(REGUL);
    expect(od.some((l) => String(l.compte_numero).startsWith("3458"))).toBe(false);
    expect(od.some((l) => String(l.compte_numero).startsWith("4458"))).toBe(false);
  });

  it("la dette rendue est bien portée par le 4456", () => {
    const od = construireOdRegularisationTva(REGUL);
    expect(soldeTvaDue(od)).toBe(3360);
  });
});
