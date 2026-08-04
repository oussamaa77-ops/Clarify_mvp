import { describe, it, expect } from "vitest";
import {
  partReglee,
  synthetiserTva,
  tvaRecuperableEnCours,
  echeanceSimplTva,
  joursAvant,
  ventilerChargesParCompte,
  ventilerVentesParCompte,
  intitulePcm,
  balanceAgeeDashboard,
  calculerCashFlow,
  periodesTva,
  bornesDuMois,
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

  it("sans règlement daté, la couverture vaut 0 (rattachement à la facture)", () => {
    const s = synthetiserTva([f({ montant_paye: 1200, statut_paiement: "payee" })], [], { paiements: [] });
    expect(s.collectee).toBe(200);
    expect(s.couverture).toBe(0);
  });
});

describe("synthetiserTva — exigibilité à la date d'encaissement", () => {
  const vente = f({ id: "V1", date_facture: "2026-05-10", montant_paye: 1200, montant_restant: 0, statut_paiement: "payee" });

  it("rattache la TVA au mois du RÈGLEMENT, pas à celui de la facture", () => {
    const paiements = [{ facture_id: "V1", montant: 1200, date_paiement: "2026-07-03" }];
    // Facturée en mai, encaissée en juillet : rien n'est exigible en mai…
    expect(synthetiserTva([vente], [], { paiements, debut: "2026-05-01", fin: "2026-05-31" }).collectee).toBe(0);
    // …tout l'est en juillet.
    const juillet = synthetiserTva([vente], [], { paiements, debut: "2026-07-01", fin: "2026-07-31" });
    expect(juillet.collectee).toBe(200);
    expect(juillet.couverture).toBe(1);
  });

  it("ventile un règlement échelonné sur ses mois d'encaissement", () => {
    const paiements = [
      { facture_id: "V1", montant: 300, date_paiement: "2026-06-20" },
      { facture_id: "V1", montant: 900, date_paiement: "2026-07-05" },
    ];
    expect(synthetiserTva([vente], [], { paiements, debut: "2026-06-01", fin: "2026-06-30" }).collectee).toBe(50);
    expect(synthetiserTva([vente], [], { paiements, debut: "2026-07-01", fin: "2026-07-31" }).collectee).toBe(150);
    expect(synthetiserTva([vente], [], { paiements }).collectee).toBe(200);
  });

  it("date les décaissements d'achat de la même façon", () => {
    const achat = f({ id: "A1", montant_tva: 50, montant_ttc: 300, montant_paye: 300, montant_restant: 0, statut_paiement: "payee" });
    const paiements = [{ facture_fournisseur_id: "A1", montant: 300, date_paiement: "2026-08-02" }];
    const s = synthetiserTva([], [achat], { paiements, debut: "2026-08-01", fin: "2026-08-31" });
    expect(s.deductible).toBe(50);
    expect(s.nette).toBe(-50);
    expect(s.estCredit).toBe(true);
  });

  it("ne confond pas un paiement de vente avec un paiement d'achat", () => {
    const achat = f({ id: "A1", montant_tva: 50, montant_ttc: 300, montant_paye: 300, statut_paiement: "payee" });
    // Même identifiant des deux côtés : seule la bonne colonne doit être lue.
    const paiements = [{ facture_id: "V1", montant: 1200, date_paiement: "2026-07-03" }];
    const s = synthetiserTva([vente], [achat], { paiements, debut: "2026-07-01", fin: "2026-07-31" });
    expect(s.collectee).toBe(200);
    expect(s.deductible).toBe(0); // l'achat n'a aucun règlement daté en juillet
  });

  it("complète les règlements non datés par la date de facture, sans perdre de TVA", () => {
    // 300 datés en juillet, 900 réglés « à l'ancienne » (montant_paye seul).
    const paiements = [{ facture_id: "V1", montant: 300, date_paiement: "2026-07-05" }];
    const mai = synthetiserTva([vente], [], { paiements, debut: "2026-05-01", fin: "2026-05-31" });
    expect(mai.collectee).toBe(150);   // les 900 non datés, rattachés à la facture de mai
    const total = synthetiserTva([vente], [], { paiements });
    expect(total.collectee).toBe(200); // rien ne disparaît
    expect(total.couverture).toBe(0.25);
  });

  it("ignore l'excédent d'un règlement saisi en double", () => {
    const paiements = [
      { facture_id: "V1", montant: 1200, date_paiement: "2026-07-05" },
      { facture_id: "V1", montant: 1200, date_paiement: "2026-07-06" },
    ];
    expect(synthetiserTva([vente], [], { paiements }).collectee).toBe(200); // pas 400
  });
});

describe("periodesTva / bornesDuMois", () => {
  it("retient le mois d'encaissement, pas celui de la facture couverte", () => {
    const ventes = [f({ id: "V1", date_facture: "2026-05-10", montant_paye: 1200, montant_restant: 0, statut_paiement: "payee" })];
    const paiements = [{ facture_id: "V1", montant: 1200, date_paiement: "2026-07-03" }];
    // Mai ne porte aucune TVA : le règlement daté de juillet couvre tout.
    expect(periodesTva(ventes, [], paiements)).toEqual(["2026-07"]);
  });

  it("garde le mois de facture pour la part non couverte par un règlement daté", () => {
    const ventes = [f({ id: "V1", date_facture: "2026-05-10", montant_paye: 1200, montant_restant: 0, statut_paiement: "payee" })];
    const paiements = [{ facture_id: "V1", montant: 300, date_paiement: "2026-07-03" }];
    expect(periodesTva(ventes, [], paiements)).toEqual(["2026-07", "2026-05"]);
  });

  it("ignore les factures non réglées (aucune TVA exigible)", () => {
    expect(periodesTva([f()], [], [])).toEqual([]);
  });

  it("ignore les factures sans TVA (exonérées)", () => {
    const ventes = [f({ id: "V1", montant_tva: 0, montant_paye: 1200, statut_paiement: "payee" })];
    expect(periodesTva(ventes, [], [])).toEqual([]);
  });

  it("borne un mois sur ses premier et dernier jours", () => {
    expect(bornesDuMois("2026-02")).toEqual({ debut: "2026-02-01", fin: "2026-02-28" });
    expect(bornesDuMois("2024-02")).toEqual({ debut: "2024-02-01", fin: "2024-02-29" });
    expect(bornesDuMois("2026-12")).toEqual({ debut: "2026-12-01", fin: "2026-12-31" });
    expect(bornesDuMois("bidon")).toBeNull();
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

describe("ventilerChargesParCompte", () => {
  // Référentiel PCM tel que le dashboard le passe (extrait de `pcm_reference`).
  const PCM = {
    "6111": "Achats de marchandises",
    "6131": "Locations et charges locatives",
    "6133": "Entretien et réparations",
    "6145": "Frais postaux et frais de télécommunications",
    "6171": "Rémunérations du personnel",
  };

  const ecr = [
    { compte_numero: "6111", debit: 10000, credit: 0, date_ecriture: "2026-06-05" },
    { compte_numero: "6121", debit: 5000,  credit: 0, date_ecriture: "2026-06-06" },
    { compte_numero: "6131", debit: 3000,  credit: 0, date_ecriture: "2026-06-07" },
    { compte_numero: "6141", debit: 2000,  credit: 0, date_ecriture: "2026-06-08" },
    { compte_numero: "6171", debit: 8000,  credit: 0, date_ecriture: "2026-06-09" },
    { compte_numero: "3421", debit: 9999,  credit: 0, date_ecriture: "2026-06-10" }, // hors classe 6
  ];

  it("ventile par COMPTE réel, sans regroupement maison", () => {
    const parts = ventilerChargesParCompte(ecr, { intitules: PCM });
    expect(parts.map(p => p.compte)).toEqual(["6111", "6171", "6121", "6131", "6141"]);
  });

  it("classe du poste le plus lourd au plus léger", () => {
    const montants = ventilerChargesParCompte(ecr).map(p => p.montant);
    expect(montants).toEqual([...montants].sort((a, b) => b - a));
  });

  it("nomme chaque compte avec l'intitulé du référentiel PCM", () => {
    const parts = ventilerChargesParCompte(ecr, { intitules: PCM });
    expect(parts.find(p => p.compte === "6111")?.intitule).toBe("Achats de marchandises");
    expect(parts.find(p => p.compte === "6171")?.intitule).toBe("Rémunérations du personnel");
  });

  it("ignore les comptes hors classe 6", () => {
    const total = ventilerChargesParCompte(ecr).reduce((s, p) => s + p.montant, 0);
    expect(total).toBe(28000); // 9999 exclu
  });

  it("un avoir vient en diminution de la charge", () => {
    const parts = ventilerChargesParCompte([
      { compte_numero: "6111", debit: 10000, credit: 0, date_ecriture: "2026-06-05" },
      { compte_numero: "6111", debit: 0, credit: 4000, date_ecriture: "2026-06-20" },
    ]);
    expect(parts).toHaveLength(1);
    expect(parts[0].montant).toBe(6000);
  });

  it("écarte un compte au solde nul ou créditeur (secteur indessinable)", () => {
    const parts = ventilerChargesParCompte([
      { compte_numero: "6111", debit: 1000, credit: 0,    date_ecriture: "2026-06-05" },
      { compte_numero: "6133", debit: 200,  credit: 500,  date_ecriture: "2026-06-06" }, // net créditeur
    ]);
    expect(parts.map(p => p.compte)).toEqual(["6111"]);
  });

  it("borne sur la période demandée", () => {
    const parts = ventilerChargesParCompte(ecr, { debut: "2026-06-08", fin: "2026-06-09" });
    expect(parts.map(p => p.compte)).toEqual(["6171", "6141"]);
  });

  it("la part de chaque poste est la proportion EXACTE du total", () => {
    const parts = ventilerChargesParCompte([
      { compte_numero: "6111", debit: 750, credit: 0, date_ecriture: "2026-06-05" },
      { compte_numero: "6131", debit: 250, credit: 0, date_ecriture: "2026-06-05" },
    ]);
    expect(parts.map(p => p.part)).toEqual([0.75, 0.25]);
    expect(parts.reduce((s, p) => s + p.part, 0)).toBeCloseTo(1, 10);
  });

  // ── Règle des 5 postes + reliquat ──
  const beaucoup = [
    { compte_numero: "6111", debit: 10000, credit: 0, date_ecriture: "2026-06-01" },
    { compte_numero: "6171", debit: 8000,  credit: 0, date_ecriture: "2026-06-01" },
    { compte_numero: "6121", debit: 5000,  credit: 0, date_ecriture: "2026-06-01" },
    { compte_numero: "6131", debit: 3000,  credit: 0, date_ecriture: "2026-06-01" },
    { compte_numero: "6133", debit: 2000,  credit: 0, date_ecriture: "2026-06-01" },
    { compte_numero: "6145", debit: 500,   credit: 0, date_ecriture: "2026-06-01" },
    { compte_numero: "6147", debit: 300,   credit: 0, date_ecriture: "2026-06-01" },
  ];

  it("au-delà de 5 comptes : 5 postes nommés + « Autres charges »", () => {
    const parts = ventilerChargesParCompte(beaucoup, { intitules: PCM });
    expect(parts).toHaveLength(6);
    expect(parts.slice(0, 5).map(p => p.compte)).toEqual(["6111", "6171", "6121", "6131", "6133"]);
    const autres = parts[5];
    expect(autres.compte).toBe("autres");
    expect(autres.intitule).toBe("Autres charges");
    expect(autres.montant).toBe(800);            // 500 + 300
    expect(autres.regroupe).toEqual(["6145", "6147"]);
  });

  it("le reliquat regroupé ne fait perdre AUCUN montant", () => {
    const total = ventilerChargesParCompte(beaucoup).reduce((s, p) => s + p.montant, 0);
    expect(total).toBe(28800);
  });

  // Règle STRICTE : 6 comptes → 5 postes + « Autres », même si le reliquat est
  // un compte unique. La règle reste lisible à l'œil, sans cas particulier.
  it("un reliquat d'un SEUL compte part quand même dans « Autres charges »", () => {
    const parts = ventilerChargesParCompte(beaucoup.slice(0, 6), { intitules: PCM });
    expect(parts).toHaveLength(6);
    expect(parts[5].compte).toBe("autres");
    expect(parts[5].regroupe).toEqual(["6145"]);
    expect(parts[5].montant).toBe(500);
  });

  it("exactement 5 comptes : aucune tranche « Autres »", () => {
    const parts = ventilerChargesParCompte(beaucoup.slice(0, 5), { intitules: PCM });
    expect(parts).toHaveLength(5);
    expect(parts.some(p => p.compte === "autres")).toBe(false);
  });

  it("à montant égal, l'ordre reste déterministe (par n° de compte)", () => {
    const parts = ventilerChargesParCompte([
      { compte_numero: "6145", debit: 100, credit: 0, date_ecriture: "2026-06-01" },
      { compte_numero: "6111", debit: 100, credit: 0, date_ecriture: "2026-06-01" },
    ]);
    expect(parts.map(p => p.compte)).toEqual(["6111", "6145"]);
  });
});

describe("ventilerVentesParCompte", () => {
  const PCM = {
    "7111": "Ventes de marchandises",
    "7124": "Ventes de services produits au Maroc",
    "7126": "Ventes de produits accessoires",
    "7129": "Rabais, remises et ristournes accordés par l'entreprise",
    "7181": "Autres produits d'exploitation",
    "7386": "Escomptes obtenus",
  };

  // Un produit est un solde CRÉDITEUR — miroir exact des charges.
  const ventes = [
    { compte_numero: "7111", debit: 0, credit: 120000, date_ecriture: "2026-06-05" },
    { compte_numero: "7124", debit: 0, credit: 80000,  date_ecriture: "2026-06-06" },
    { compte_numero: "7126", debit: 0, credit: 12000,  date_ecriture: "2026-06-07" },
    { compte_numero: "6111", debit: 50000, credit: 0,  date_ecriture: "2026-06-08" }, // charge : hors champ
  ];

  it("ventile le CA par compte de produit, du plus gros au plus petit", () => {
    const parts = ventilerVentesParCompte(ventes, { intitules: PCM });
    expect(parts.map(p => p.compte)).toEqual(["7111", "7124", "7126"]);
    expect(parts[0].montant).toBe(120000);
  });

  it("ignore les comptes hors classe 7", () => {
    const total = ventilerVentesParCompte(ventes).reduce((s, p) => s + p.montant, 0);
    expect(total).toBe(212000); // la charge de 50 000 est exclue
  });

  it("nomme chaque compte avec l'intitulé du référentiel PCM", () => {
    const parts = ventilerVentesParCompte(ventes, { intitules: PCM });
    expect(parts[1].intitule).toBe("Ventes de services produits au Maroc");
  });

  it("un avoir client vient en diminution du poste de vente", () => {
    const parts = ventilerVentesParCompte([
      { compte_numero: "7111", debit: 0,     credit: 10000, date_ecriture: "2026-06-05" },
      { compte_numero: "7111", debit: 2500,  credit: 0,     date_ecriture: "2026-06-20" }, // avoir
    ]);
    expect(parts[0].montant).toBe(7500);
  });

  // 7129 « RRR accordés » est un compte de PRODUIT qui fonctionne au DÉBIT :
  // pris dans le sens des charges il apparaîtrait comme un poste de vente.
  it("les rabais accordés (7129) ne deviennent jamais un poste de vente", () => {
    const parts = ventilerVentesParCompte([
      { compte_numero: "7111", debit: 0,    credit: 50000, date_ecriture: "2026-06-05" },
      { compte_numero: "7129", debit: 3000, credit: 0,     date_ecriture: "2026-06-06" },
    ], { intitules: PCM });
    expect(parts.map(p => p.compte)).toEqual(["7111"]);
  });

  it("règle stricte : au-delà de 5 comptes, reliquat sous « Autres ventes »", () => {
    const parts = ventilerVentesParCompte([
      { compte_numero: "7111", debit: 0, credit: 100000, date_ecriture: "2026-06-01" },
      { compte_numero: "7124", debit: 0, credit: 80000,  date_ecriture: "2026-06-01" },
      { compte_numero: "7121", debit: 0, credit: 60000,  date_ecriture: "2026-06-01" },
      { compte_numero: "7126", debit: 0, credit: 40000,  date_ecriture: "2026-06-01" },
      { compte_numero: "7181", debit: 0, credit: 20000,  date_ecriture: "2026-06-01" },
      { compte_numero: "7386", debit: 0, credit: 1500,   date_ecriture: "2026-06-01" },
      { compte_numero: "7331", debit: 0, credit: 500,    date_ecriture: "2026-06-01" },
    ], { intitules: PCM });
    expect(parts).toHaveLength(6);
    expect(parts[5]).toMatchObject({
      compte: "autres",
      intitule: "Autres ventes",
      montant: 2000,
      regroupe: ["7386", "7331"],
    });
  });

  it("charges et ventes se lisent sur le MÊME jeu d'écritures sans interférer", () => {
    const melange = [
      { compte_numero: "6111", debit: 30000, credit: 0,     date_ecriture: "2026-06-01" },
      { compte_numero: "7111", debit: 0,     credit: 90000, date_ecriture: "2026-06-01" },
    ];
    expect(ventilerChargesParCompte(melange).map(p => p.compte)).toEqual(["6111"]);
    expect(ventilerVentesParCompte(melange).map(p => p.compte)).toEqual(["7111"]);
  });
});

describe("intitulePcm", () => {
  const PCM = { "6131": "Locations et charges locatives", "6145": "Frais postaux et frais de télécommunications" };

  it("prend l'intitulé exact du référentiel", () => {
    expect(intitulePcm("6145", PCM)).toBe("Frais postaux et frais de télécommunications");
  });

  it("descend au sous-compte du moteur de catégorisation", () => {
    // 61254 n'est pas dans `pcm_reference` mais le moteur l'impute et le nomme.
    expect(intitulePcm("61254", PCM)).toBe("Fournitures de bureau");
  });

  it("hérite du compte parent pour un sous-compte inconnu", () => {
    expect(intitulePcm("61312", PCM)).toBe("Locations et charges locatives");
  });

  it("retombe sur la rubrique à 3 chiffres pour un compte inventé", () => {
    // 6137 : imputé par l'OCR, absent de tous les référentiels.
    expect(intitulePcm("6137", PCM)).toBe("Autres charges externes");
  });

  it("couvre aussi les rubriques de la classe 7 (produits)", () => {
    expect(intitulePcm("7118", {})).toBe("Ventes de marchandises");        // rubrique 711
    expect(intitulePcm("71241", { "7124": "Ventes de services produits au Maroc" }))
      .toBe("Ventes de services produits au Maroc");                       // parent 7124
  });

  it("n'invente rien quand la rubrique elle-même est inconnue", () => {
    expect(intitulePcm("6999", PCM)).toBe("");
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
