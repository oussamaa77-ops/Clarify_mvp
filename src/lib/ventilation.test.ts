import { describe, it, expect } from "vitest";
import { facturesCitees, lignesTiersVentilees, planifierRattrapageTva, proposerVentilation, type FactureOuverte } from "./ventilation";

const f = (id: string, numero: string, restant: number, tiers = "SAHARA LOGISTIQUE SARL"): FactureOuverte => ({ id, numero, restant, tiers });

describe("proposerVentilation", () => {
  const ouvertes = [
    f("a", "FA-2026-0103", 4800), f("b", "FA-2026-0104", 7800),
    f("c", "FA-2026-0102", 20000, "OCEAN DISTRIBUTION SA"), f("d", "FA-2026-0107", 9000, "OCEAN DISTRIBUTION SA"),
    f("e", "FA-2026-0108", 3000, "RIF AGRO SA"),
  ];

  it("deux factures citées dont la somme égale le virement → toutes deux soldées", () => {
    expect(proposerVentilation({ libelle: "VIR RECU SAHARA LOGISTIQUE REGL FA-2026-0103 FA-2026-0104", montant: 12600 }, ouvertes))
      .toEqual([{ facture_id: "a", montant: 4800 }, { facture_id: "b", montant: 7800 }]);
  });

  it("tranche + facture entière : une seule lecture possible → FA-0107 soldée, reliquat sur FA-0102", () => {
    expect(proposerVentilation({ libelle: "VIR OCEAN DISTRIBUTION FA-2026-0102 FA-2026-0107", montant: 19000 }, ouvertes))
      .toEqual([{ facture_id: "c", montant: 10000 }, { facture_id: "d", montant: 9000 }]);
  });

  it("une seule facture citée, montant inférieur au restant → tranche", () => {
    expect(proposerVentilation({ libelle: "VIR 1ERE TRANCHE FA-2026-0102", montant: 10000 }, ouvertes))
      .toEqual([{ facture_id: "c", montant: 10000 }]);
  });

  it("numéros recollés par la banque (FA20260103) reconnus", () => {
    expect(facturesCitees("VIR SAHARA FA20260103 ET FA20260104", ouvertes).map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("rien de cité : combinaison UNIQUE du payeur", () => {
    expect(proposerVentilation({ libelle: "VIR RECU SAHARA LOGISTIQUE", montant: 12600 }, ouvertes))
      .toEqual([{ facture_id: "a", montant: 4800 }, { facture_id: "b", montant: 7800 }]);
  });

  it("ambigu → null (le comptable tranche)", () => {
    const amb = [f("x", "FA-1", 1000), f("y", "FA-2", 1000), f("z", "FA-3", 1000)];
    expect(proposerVentilation({ libelle: "VIR SAHARA LOGISTIQUE", montant: 2000 }, amb)).toBeNull();
    // deux factures citées de 5 000, 7 000 reçus : laquelle est soldée ? Les deux lectures se valent.
    const jumelles = [f("m", "FA-2026-0201", 5000), f("n", "FA-2026-0202", 5000)];
    expect(proposerVentilation({ libelle: "FA-2026-0201 FA-2026-0202", montant: 7000 }, jumelles)).toBeNull();
  });

  it("ne crée jamais de trop-perçu : montant au-delà des factures citées → null", () => {
    expect(proposerVentilation({ libelle: "FA-2026-0103 FA-2026-0104", montant: 20000 }, ouvertes)).toBeNull();
  });
});

describe("lignesTiersVentilees", () => {
  it("découpe un crédit 3421 de 12 600 en deux lignes référencées, reliquat en 4497", () => {
    const l = lignesTiersVentilees({ compte_numero: "34210000", debit: 0, credit: 13000, reference_piece: "VIR X" }, [
      { reference: "FA-0103", compte: "34210000", facture_id: "a", montant: 4800 },
      { reference: "FA-0104", compte: "34210000", facture_id: "b", montant: 7800 },
    ]);
    expect(l.map((x) => [x.compte_numero, x.credit, x.reference_piece])).toEqual([
      ["34210000", 4800, "FA-0103"], ["34210000", 7800, "FA-0104"], ["4497", 400, "VIR X"],
    ]);
  });
});

describe("planifierRattrapageTva — art. 95 CGI, chaque tranche rend sa TVA exigible", () => {
  it("3 tranches de 10 000 sur 30 000 TTC / 5 000 TVA : deux encaissées → deux bascules datées", () => {
    const p = planifierRattrapageTva({ tvaTotale: 5000, tvaAttente: 5000, ttc: 30000, paiements: [
      { id: "p2", montant: 10000, date: "2026-10-15" }, { id: "p1", montant: 10000, date: "2026-09-25" },
    ] });
    expect(p.etapes).toEqual([
      { montantRegle: 10000, date: "2026-09-25", paiementId: "p1" },
      { montantRegle: 10000, date: "2026-10-15", paiementId: "p2" },
    ]);
  });

  it("idempotent : ce qui est déjà exigible n'est pas rebasculé", () => {
    // 1 666,67 déjà basculés (tranche 1) → seule la tranche 2 reste à faire.
    const p = planifierRattrapageTva({ tvaTotale: 5000, tvaAttente: 3333.33, ttc: 30000, paiements: [
      { montant: 10000, date: "2026-09-25" }, { montant: 10000, date: "2026-10-15" },
    ] });
    expect(p.etapes).toEqual([{ montantRegle: 10000, date: "2026-10-15", paiementId: null }]);
    expect(planifierRattrapageTva({ tvaTotale: 5000, tvaAttente: 1666.67, ttc: 30000, paiements: [
      { montant: 10000, date: "2026-09-25" }, { montant: 10000, date: "2026-10-15" },
    ] }).etapes).toEqual([]);
  });

  it("paiement délié après bascule → excédent à contrepasser", () => {
    const p = planifierRattrapageTva({ tvaTotale: 5000, tvaAttente: 3333.33, ttc: 30000, paiements: [] });
    expect(p.excedent).toBe(1666.67);
  });

  it("sur-paiement : jamais au-delà du TTC", () => {
    const p = planifierRattrapageTva({ tvaTotale: 200, tvaAttente: 200, ttc: 1200, paiements: [{ montant: 1500, date: "2026-01-02" }] });
    expect(p.etapes).toEqual([{ montantRegle: 1200, date: "2026-01-02", paiementId: null }]);
  });
});
