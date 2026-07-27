import { describe, it, expect } from "vitest";
import {
  partReglee,
  synthetiserTva,
  tvaRecuperableEnCours,
  echeanceSimplTva,
  joursAvant,
  ventilerChargesPcm,
  GROUPES_PCM,
  balanceAgeeDashboard,
  calculerCashFlow,
  type FactureFiscale,
} from "./dashboard-fiscal";

const AUJ = new Date(2026, 6, 24); // 24/07/2026

/** Facture 1000 HT + 200 TVA = 1200 TTC, non réglée par défaut. */
const f = (o: Partial<FactureFiscale> = {}): FactureFiscale => ({
  montant_ht: 1000, montant_tva: 200, montant_ttc: 1200,
  montant_paye: 0, montant_restant: 1200, statut_paiement: "non_payee",
  date_facture: "2026-06-15", date_echeance: "2026-07-15",
  ...o,
});

describe("partReglee — prorata d'encaissement", () => {
  it("facture non réglée → 0", () => {
    expect(partReglee(f())).toBe(0);
  });

  it("facture soldée → 1", () => {
    expect(partReglee(f({ montant_paye: 1200, montant_restant: 0, statut_paiement: "payee" }))).toBe(1);
  });

  it("règlement partiel → prorata exact", () => {
    expect(partReglee(f({ montant_paye: 600, montant_restant: 600 }))).toBeCloseTo(0.5, 6);
  });

  it("statut « payee » fait foi même sans montant_paye (factures anciennes)", () => {
    expect(partReglee(f({ montant_paye: 0, montant_restant: 1200, statut_paiement: "payee" }))).toBe(1);
  });

  it("déduit l'encaissé du reste dû quand montant_paye est absent", () => {
    expect(partReglee(f({ montant_paye: null, montant_restant: 300 }))).toBeCloseTo(0.75, 6);
  });

  it("ne dépasse jamais 1 même si le payé excède le TTC", () => {
    expect(partReglee(f({ montant_paye: 5000 }))).toBe(1);
  });
});

describe("synthetiserTva — régime de l'encaissement", () => {
  it("ne retient que la TVA effectivement encaissée / décaissée", () => {
    const ventes = [f({ montant_paye: 1200, montant_restant: 0, statut_paiement: "payee" }), f()];
    const achats = [f({ montant_tva: 50, montant_ttc: 300, montant_paye: 300, montant_restant: 0, statut_paiement: "payee" })];
    const s = synthetiserTva(ventes, achats);
    expect(s.collectee).toBe(200);  // seule la 1re vente est encaissée
    expect(s.deductible).toBe(50);
    expect(s.nette).toBe(150);
    expect(s.estCredit).toBe(false);
  });

  it("règlement partiel → TVA au prorata, pas en tout-ou-rien", () => {
    const s = synthetiserTva([f({ montant_paye: 600, montant_restant: 600 })], []);
    expect(s.collectee).toBe(100); // la moitié de 200
  });

  it("déductible > collectée → crédit de TVA signalé", () => {
    const achats = [f({ montant_paye: 1200, montant_restant: 0, statut_paiement: "payee" })];
    const s = synthetiserTva([], achats);
    expect(s.nette).toBe(-200);
    expect(s.estCredit).toBe(true);
  });

  it("borne la période sur la date de facture", () => {
    const ventes = [
      f({ date_facture: "2026-05-10", montant_paye: 1200, statut_paiement: "payee" }),
      f({ date_facture: "2026-06-10", montant_paye: 1200, statut_paiement: "payee" }),
    ];
    const s = synthetiserTva(ventes, [], { debut: "2026-06-01", fin: "2026-06-30" });
    expect(s.collectee).toBe(200); // seule la facture de juin
  });
});

describe("tvaRecuperableEnCours", () => {
  it("TVA des achats reçus mais non encore décaissés", () => {
    expect(tvaRecuperableEnCours([f()])).toBe(200);
  });

  it("achat soldé → plus rien à récupérer", () => {
    expect(tvaRecuperableEnCours([f({ montant_paye: 1200, montant_restant: 0, statut_paiement: "payee" })])).toBe(0);
  });

  it("achat à moitié réglé → moitié encore récupérable", () => {
    expect(tvaRecuperableEnCours([f({ montant_paye: 600, montant_restant: 600 })])).toBe(100);
  });
});

describe("echeanceSimplTva — dernier jour du mois suivant", () => {
  it("période de juin 2026 → 31 juillet 2026", () => {
    const d = echeanceSimplTva("2026-06")!;
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(6); // juillet
    expect(d.getDate()).toBe(31);
  });

  it("mois suivant plus court (janvier → 28/29 février)", () => {
    expect(echeanceSimplTva("2026-01")!.getDate()).toBe(28); // 2026 non bissextile
    expect(echeanceSimplTva("2024-01")!.getDate()).toBe(29); // 2024 bissextile
  });

  it("décembre bascule sur janvier de l'année suivante", () => {
    const d = echeanceSimplTva("2026-12")!;
    expect(d.getFullYear()).toBe(2027);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(31);
  });

  it("période invalide → null (aucune date inventée)", () => {
    expect(echeanceSimplTva("2026-13")).toBeNull();
    expect(echeanceSimplTva("juin")).toBeNull();
  });
});

describe("joursAvant", () => {
  it("échéance future → positif", () => {
    expect(joursAvant(new Date(2026, 6, 31), AUJ)).toBe(7);
  });

  it("échéance dépassée → négatif", () => {
    expect(joursAvant(new Date(2026, 6, 20), AUJ)).toBe(-4);
  });
});

describe("ventilerChargesPcm", () => {
  const ecr = [
    { compte_numero: "6111", debit: 10000, credit: 0, date_ecriture: "2026-06-05" },
    { compte_numero: "6121", debit: 5000,  credit: 0, date_ecriture: "2026-06-06" },
    { compte_numero: "6131", debit: 3000,  credit: 0, date_ecriture: "2026-06-07" },
    { compte_numero: "6141", debit: 2000,  credit: 0, date_ecriture: "2026-06-08" },
    { compte_numero: "6171", debit: 8000,  credit: 0, date_ecriture: "2026-06-09" },
    { compte_numero: "3421", debit: 9999,  credit: 0, date_ecriture: "2026-06-10" }, // hors classe 6
  ];

  it("regroupe 613 et 614 sous Services extérieurs & Loyers", () => {
    const parts = ventilerChargesPcm(ecr);
    expect(parts.find(p => p.cle === "services")?.montant).toBe(5000); // 3000 + 2000
  });

  it("ignore les comptes hors classe 6", () => {
    const total = ventilerChargesPcm(ecr).reduce((s, p) => s + p.montant, 0);
    expect(total).toBe(28000); // 9999 exclu
  });

  it("un avoir vient en diminution de la charge", () => {
    const parts = ventilerChargesPcm([
      { compte_numero: "6111", debit: 10000, credit: 0, date_ecriture: "2026-06-05" },
      { compte_numero: "6111", debit: 0, credit: 4000, date_ecriture: "2026-06-20" },
    ]);
    expect(parts.find(p => p.cle === "marchandises")?.montant).toBe(6000);
  });

  it("classe le reste de la classe 6 en « Autres charges »", () => {
    const parts = ventilerChargesPcm([
      { compte_numero: "6182", debit: 1500, credit: 0, date_ecriture: "2026-06-05" },
    ]);
    expect(parts).toEqual([{ cle: "autres", label: "Autres charges", montant: 1500 }]);
  });

  it("écarte les groupes vides", () => {
    const parts = ventilerChargesPcm([
      { compte_numero: "6111", debit: 100, credit: 0, date_ecriture: "2026-06-05" },
    ]);
    expect(parts.map(p => p.cle)).toEqual(["marchandises"]);
  });

  it("borne sur la période demandée", () => {
    const parts = ventilerChargesPcm(ecr, { debut: "2026-06-08", fin: "2026-06-09" });
    expect(parts.map(p => p.cle).sort()).toEqual(["personnel", "services"]);
  });

  // ── 6125 « achats NON STOCKÉS » : eau, électricité, fournitures de bureau ──
  // Le préfixe 6125 est plus précis que 612 : il doit gagner, sinon des
  // consommables du quotidien s'affichent en « Matières premières ».
  it("sort 6125x de « Matières premières » vers son propre poste", () => {
    const parts = ventilerChargesPcm([
      { compte_numero: "61251", debit: 800,  credit: 0, date_ecriture: "2026-06-05" }, // eau
      { compte_numero: "61252", debit: 1500, credit: 0, date_ecriture: "2026-06-06" }, // électricité
      { compte_numero: "61254", debit: 1200, credit: 0, date_ecriture: "2026-06-07" }, // fournitures de bureau
    ]);
    expect(parts).toEqual([
      { cle: "non_stockes", label: "Eau, énergie & fournitures", montant: 3500 },
    ]);
    expect(parts.some(p => p.cle === "matieres")).toBe(false);
  });

  it("laisse les VRAIES matières premières (6121) sous « Matières premières »", () => {
    const parts = ventilerChargesPcm([
      { compte_numero: "6121",  debit: 5000, credit: 0, date_ecriture: "2026-06-05" },
      { compte_numero: "61254", debit: 1200, credit: 0, date_ecriture: "2026-06-06" },
    ]);
    expect(parts.find(p => p.cle === "matieres")?.montant).toBe(5000);
    expect(parts.find(p => p.cle === "non_stockes")?.montant).toBe(1200);
  });

  it("place 6125 AVANT 612 dans l'ordre de la légende (priorité de matching)", () => {
    const iNonStockes = GROUPES_PCM.findIndex(g => g.cle === "non_stockes");
    const iMatieres = GROUPES_PCM.findIndex(g => g.cle === "matieres");
    expect(iNonStockes).toBeGreaterThanOrEqual(0);
    expect(iNonStockes).toBeLessThan(iMatieres);
  });

  it("6126 (travaux & études) reste dans le groupe général 612", () => {
    const parts = ventilerChargesPcm([
      { compte_numero: "6126", debit: 400, credit: 0, date_ecriture: "2026-06-05" },
    ]);
    expect(parts.map(p => p.cle)).toEqual(["matieres"]);
  });

  it("le total des charges est insensible au regroupement", () => {
    const lignes = [
      { compte_numero: "6111",  debit: 1000, credit: 0, date_ecriture: "2026-06-05" },
      { compte_numero: "6121",  debit: 2000, credit: 0, date_ecriture: "2026-06-05" },
      { compte_numero: "61254", debit: 1200, credit: 0, date_ecriture: "2026-06-05" },
    ];
    const total = ventilerChargesPcm(lignes).reduce((s, p) => s + p.montant, 0);
    expect(total).toBe(4200);
  });
});

describe("balanceAgeeDashboard", () => {
  it("range chaque impayé dans sa tranche d'ancienneté", () => {
    const ventes = [
      f({ date_echeance: "2026-08-30", montant_restant: 100 }), // non échue
      f({ date_echeance: "2026-07-10", montant_restant: 200 }), // 14 j
      f({ date_echeance: "2026-06-10", montant_restant: 300 }), // 44 j
      f({ date_echeance: "2026-05-10", montant_restant: 400 }), // 75 j
      f({ date_echeance: "2026-01-10", montant_restant: 500 }), // 195 j
    ];
    const b = balanceAgeeDashboard(ventes, [], AUJ);
    const par = Object.fromEntries(b.map(t => [t.cle, t.creances]));
    expect(par.a_jour).toBe(100);
    expect(par.j_1_30).toBe(200);
    expect(par.j_31_60).toBe(300);
    expect(par.j_61_90).toBe(400);   // tranche intercalée : sans elle, 400 disparaissait
    expect(par.j_90_plus).toBe(500);
  });

  it("sépare créances (ventes) et dettes (achats)", () => {
    const b = balanceAgeeDashboard(
      [f({ date_echeance: "2026-07-10", montant_restant: 200 })],
      [f({ date_echeance: "2026-07-10", montant_restant: 700 })],
      AUJ,
    );
    const t = b.find(x => x.cle === "j_1_30")!;
    expect(t.creances).toBe(200);
    expect(t.dettes).toBe(700);
  });

  it("exclut les factures soldées", () => {
    const b = balanceAgeeDashboard(
      [f({ date_echeance: "2026-01-01", montant_restant: 0, statut_paiement: "payee" })],
      [], AUJ,
    );
    expect(b.every(t => t.creances === 0)).toBe(true);
  });

  it("facture sans échéance → « dans les temps » plutôt que perdue", () => {
    const b = balanceAgeeDashboard([f({ date_echeance: null, montant_restant: 250 })], [], AUJ);
    expect(b.find(t => t.cle === "a_jour")!.creances).toBe(250);
  });

  it("aucun montant ne disparaît entre les tranches", () => {
    const ventes = Array.from({ length: 12 }, (_, i) =>
      f({ date_echeance: `2026-0${(i % 9) + 1}-15`.slice(0, 10), montant_restant: 100 }));
    const b = balanceAgeeDashboard(ventes, [], AUJ);
    expect(b.reduce((s, t) => s + t.creances, 0)).toBe(1200);
  });
});

describe("calculerCashFlow", () => {
  it("HT réellement encaissé moins HT réellement décaissé", () => {
    const ventes = [f({ montant_paye: 1200, montant_restant: 0, statut_paiement: "payee" })];
    const achats = [f({ montant_ht: 400, montant_tva: 80, montant_ttc: 480, montant_paye: 480, montant_restant: 0, statut_paiement: "payee" })];
    const c = calculerCashFlow(ventes, achats);
    expect(c.encaissementsHt).toBe(1000);
    expect(c.decaissementsHt).toBe(400);
    expect(c.marge).toBe(600);
  });

  it("ignore la part non encore réglée", () => {
    const c = calculerCashFlow([f()], [f()]);
    expect(c.encaissementsHt).toBe(0);
    expect(c.decaissementsHt).toBe(0);
    expect(c.marge).toBe(0);
  });

  it("règlement partiel → HT au prorata", () => {
    const c = calculerCashFlow([f({ montant_paye: 300, montant_restant: 900 })], []);
    expect(c.encaissementsHt).toBe(250); // 1000 × 25 %
  });

  it("marge négative quand on décaisse plus qu'on encaisse", () => {
    const achats = [f({ montant_paye: 1200, montant_restant: 0, statut_paiement: "payee" })];
    expect(calculerCashFlow([], achats).marge).toBe(-1000);
  });
});
