import { describe, it, expect } from "vitest";
import {
  partReglee,
  synthetiserTva,
  tvaRecuperableEnCours,
  echeanceSimplTva, tvaHorsFactures, classerDeductibiliteAchats,
  calendrierTva, periodiciteTva, periodesDeclareesTva, prochaineEcheanceTva, etatsDeclarationsTva, caTaxableTva,
  reglementsParCompensation,
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
    // Tranches ET clés de la vue v_balance_agee : non échu / 1-30 / 31-60 / +60.
    expect(b.map(t => t.cle)).toEqual(["non_echu", "retard_1_30", "retard_31_60", "retard_60_plus"]);
    expect(par.non_echu).toBe(100);
    expect(par.retard_1_30).toBe(200);
    expect(par.retard_31_60).toBe(300);
    expect(par.retard_60_plus).toBe(900);   // 75 j et 195 j : tous deux « +60 », comme la vue
  });

  it("sépare créances (ventes) et dettes (achats)", () => {
    const b = balanceAgeeDashboard(
      [f({ date_echeance: "2026-07-10", montant_restant: 200 })],
      [f({ date_echeance: "2026-07-10", montant_restant: 700 })],
      AUJ,
    );
    const t = b.find(x => x.cle === "retard_1_30")!;
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

  it("facture sans échéance → retard compté depuis l'émission, comme la vue SQL", () => {
    // Émise le 15/06, sans échéance : 39 jours au 24/07 → 31-60, et non « dans les temps ».
    const b = balanceAgeeDashboard([f({ date_echeance: null, montant_restant: 250 })], [], AUJ);
    expect(b.find(t => t.cle === "retard_31_60")!.creances).toBe(250);
    expect(b.find(t => t.cle === "non_echu")!.creances).toBe(0);
  });

  it("sans aucune date exploitable → « dans les temps » plutôt que perdue", () => {
    const b = balanceAgeeDashboard([f({ date_echeance: null, date_facture: null, montant_restant: 250 })], [], AUJ);
    expect(b.find(t => t.cle === "non_echu")!.creances).toBe(250);
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

// ─── Correctifs fiscaux du 2026-11-03 ────────────────────────────────────────
describe("echeanceSimplTva — régime trimestriel", () => {
  it("fin du mois suivant le trimestre", () => {
    const t1 = echeanceSimplTva("2026-T1")!;
    expect([t1.getFullYear(), t1.getMonth() + 1, t1.getDate()]).toEqual([2026, 4, 30]);
    const t4 = echeanceSimplTva("2026-T4")!;
    expect([t4.getFullYear(), t4.getMonth() + 1, t4.getDate()]).toEqual([2027, 1, 31]);
  });
});

describe("tvaHorsFactures — TVA née en trésorerie sans facture", () => {
  const ecritures = [
    { journal_code: "BQ", compte_numero: "34552", debit: 15, credit: 0, date_ecriture: "2026-04-30" },   // TVA sur frais bancaires
    { journal_code: "OD", compte_numero: "34552", debit: 200, credit: 0, date_ecriture: "2026-04-15" },  // bascule d'une facture : déjà comptée
    { journal_code: "BQ", compte_numero: "34552", debit: 99, credit: 0, date_ecriture: "2026-05-02" },   // hors période
  ];

  it("ne retient que les journaux BQ / CAI de la période", () => {
    expect(tvaHorsFactures(ecritures, { debut: "2026-04-01", fin: "2026-04-30" })).toEqual({ collectee: 0, deductible: 15 });
  });

  it("est ajoutée à la TVA déductible de la synthèse quand les écritures sont fournies", () => {
    const s = synthetiserTva([], [], { debut: "2026-04-01", fin: "2026-04-30", ecritures });
    expect(s.deductible).toBe(15);
    expect(s.nette).toBe(-15);
    expect(synthetiserTva([], [], { debut: "2026-04-01", fin: "2026-04-30" }).deductible).toBe(0);
  });

  it("fait apparaître le mois dans la liste des périodes", () => {
    expect(periodesTva([], [], [], ecritures)).toEqual(["2026-05", "2026-04"]);
  });
});


describe("classerDeductibiliteAchats — la comptabilisation décide de la déduction", () => {
  const ecritures = [
    { journal_code: "ACH", compte_numero: "6143", debit: 600, credit: 0, reference_piece: "resto" },
    { journal_code: "ACH", compte_numero: "44110001", debit: 0, credit: 600, reference_piece: "resto" },
    { journal_code: "ACH", compte_numero: "6125", debit: 500, credit: 0, reference_piece: "fourn" },
    { journal_code: "ACH", compte_numero: "3458", debit: 100, credit: 0, reference_piece: "fourn" },
  ];

  const achats = [
    { id: "resto", montant_ht: 500, montant_tva: 100, montant_ttc: 600, statut_paiement: "payee", date_facture: "2026-04-02" },
    { id: "fourn", montant_ht: 500, montant_tva: 100, montant_ttc: 600, statut_paiement: "payee", date_facture: "2026-04-02" },
    { id: "ancien", numero: "F-OLD", montant_ht: 500, montant_tva: 100, montant_ttc: 600, statut_paiement: "payee", date_facture: "2026-04-02" },
  ];

  it("distingue non déductible, non classé et déductible", () => {
    const d = classerDeductibiliteAchats(achats, ecritures);
    expect([...d.nonDeductibles]).toEqual(["resto"]);
    expect([...d.nonClasses]).toEqual(["ancien"]);
    expect(d.exclus.has("fourn")).toBe(false);
  });

  it("ne présume jamais déductible un achat sans écriture d'achat", () => {
    expect(synthetiserTva([], achats).deductible).toBe(300);
    expect(synthetiserTva([], achats, { achatsExclus: classerDeductibiliteAchats(achats, ecritures).exclus }).deductible).toBe(100);
  });

  it("retrouve une écriture reprise par le numéro de la facture", () => {
    const repris = [...ecritures, { journal_code: "ACH", compte_numero: "3458", debit: 100, credit: 0, reference_piece: "F-OLD" }];
    expect(classerDeductibiliteAchats(achats, repris).nonClasses.size).toBe(0);
  });

  it("ne signale pas un achat sans TVA", () => {
    expect(classerDeductibiliteAchats([{ id: "x", montant_tva: 0 }], []).nonClasses.size).toBe(0);
  });
});


describe("périodicité TVA — art. 108, année par année", () => {
  it("nouvelle entreprise : trimestrielle l'année de son début", () => {
    expect(periodiciteTva({ date_debut_activite: "2026-03-01" }, 2026, null)).toMatchObject({ periodicite: "trimestriel", source: "nouvelle_entreprise" });
  });
  it("CA taxable N-1 : >= 1 000 000 mensuelle, sinon trimestrielle", () => {
    expect(periodiciteTva({}, 2026, 1_000_000).periodicite).toBe("mensuel");
    expect(periodiciteTva({}, 2026, 999_999).periodicite).toBe("trimestriel");
  });
  it("saisonnière : trimestrielle ; non-résident : mensuelle ; option : mensuelle", () => {
    expect(periodiciteTva({ periodicite_tva: "saisonniere" }, 2026, 5_000_000).periodicite).toBe("trimestriel");
    expect(periodiciteTva({ periodicite_tva: "non_resident" }, 2026, 10).periodicite).toBe("mensuel");
    expect(periodiciteTva({ periodicite_tva: "option_mensuelle" }, 2026, 200_000)).toMatchObject({ periodicite: "mensuel", source: "option" });
  });
  it("CA inconnu : trimestrielle à confirmer — plus aucune présomption mensuelle", () => {
    expect(periodiciteTva(null, 2026)).toMatchObject({ periodicite: "trimestriel", source: "defaut" });
  });
  it("préserve la périodicité retenue pour une année historique", () => {
    const d = { ajustements_fiscaux: { "2025": { periodicite_tva: "mensuel" } } };
    expect(periodiciteTva(d, 2025, 100)).toMatchObject({ periodicite: "mensuel", source: "historique" });
    expect(periodiciteTva(d, 2026, 100).periodicite).toBe("trimestriel");
  });
});

describe("calendrier TVA — état réel des déclarations", () => {
  const auj = new Date(2026, 10, 3); // 3 novembre 2026
  const odLiquidation = (p: string, du: number) => [
    { reference_piece: `DECL-TVA-${p}`, journal_code: "OD", date_ecriture: "2026-09-30", compte_numero: "44551", debit: du, credit: 0 },
    { reference_piece: `DECL-TVA-${p}`, journal_code: "OD", date_ecriture: "2026-09-30", compte_numero: "4456", debit: 0, credit: du },
  ];
  /** Règlement DGI tel que l'écrit construireOdPaiementDgi : BQ, D 4456 / C 5141. */
  const paiementDgi = (p: string, m: number, date = "2026-10-25") => [
    { reference_piece: `DECL-TVA-${p}`, journal_code: "BQ", date_ecriture: date, compte_numero: "44560000", debit: m, credit: 0 },
    { reference_piece: `DECL-TVA-${p}`, journal_code: "BQ", date_ecriture: date, compte_numero: "51410000", debit: 0, credit: m },
  ];
  const statut = (ecr: any[], recepisses: string[], p: string) =>
    calendrierTva({ periodicite: "mensuel", aujourdhui: auj, etats: etatsDeclarationsTva(ecr, recepisses) })
      .find((e) => e.periode === p)?.statut;

  it("une OD de liquidation SANS récépissé laisse la période non déposée", () => {
    const etats = etatsDeclarationsTva(odLiquidation("2026-09", 500), []);
    const cal = calendrierTva({ periodicite: "mensuel", aujourdhui: auj, etats });
    const sept = cal.find((e) => e.periode === "2026-09")!;
    expect(sept).toMatchObject({ statut: "en_retard", liquidee: true, deposee: false });
  });

  it("déposée (récépissé) mais non payée : à payer ; payée : réglée", () => {
    const ecr = [...odLiquidation("2026-09", 500)];
    expect(calendrierTva({ periodicite: "mensuel", aujourdhui: auj, etats: etatsDeclarationsTva(ecr, ["DECL-TVA-2026-09.pdf"]) })
      .find((e) => e.periode === "2026-09")?.statut).toBe("a_payer");
    ecr.push(...paiementDgi("2026-09", 500));
    expect(calendrierTva({ periodicite: "mensuel", aujourdhui: auj, etats: etatsDeclarationsTva(ecr, ["DECL-TVA-2026-09.pdf"]) })
      .find((e) => e.periode === "2026-09")?.statut).toBe("reglee");
  });

  it("un débit 4456 en OD (sans trésorerie) n'est PAS un paiement", () => {
    const ecr = [...odLiquidation("2026-09", 500),
      { reference_piece: "DECL-TVA-2026-09", journal_code: "OD", date_ecriture: "2026-10-25", compte_numero: "4456", debit: 500, credit: 0 },
      { reference_piece: "DECL-TVA-2026-09", journal_code: "OD", date_ecriture: "2026-10-25", compte_numero: "4411", debit: 0, credit: 500 }];
    expect(statut(ecr, ["DECL-TVA-2026-09.pdf"], "2026-09")).toBe("a_payer");
    expect(etatsDeclarationsTva(ecr, []).get("2026-09")).toMatchObject({ montantDu: 500, montantPaye: 0 });
  });

  it("un paiement BQ sans contrepartie 51 n'est pas retenu ; un paiement partiel laisse « à payer »", () => {
    const sansBanque = [...odLiquidation("2026-09", 500),
      { reference_piece: "DECL-TVA-2026-09", journal_code: "BQ", date_ecriture: "2026-10-25", compte_numero: "4456", debit: 500, credit: 0 },
      { reference_piece: "DECL-TVA-2026-09", journal_code: "BQ", date_ecriture: "2026-10-25", compte_numero: "4411", debit: 0, credit: 500 }];
    expect(statut(sansBanque, ["DECL-TVA-2026-09.pdf"], "2026-09")).toBe("a_payer");
    const partiel = [...odLiquidation("2026-09", 500), ...paiementDgi("2026-09", 200)];
    expect(statut(partiel, ["DECL-TVA-2026-09.pdf"], "2026-09")).toBe("a_payer");
    expect(etatsDeclarationsTva(partiel, []).get("2026-09")).toMatchObject({ montantDu: 500, montantPaye: 200 });
  });

  it("le paiement n'établit PAS le dépôt : payée sans récépissé reste non déposée", () => {
    const ecr = [...odLiquidation("2026-09", 500), ...paiementDgi("2026-09", 500)];
    expect(statut(ecr, [], "2026-09")).toBe("en_retard");
  });

  it("une période en CRÉDIT déposée est « crédit », jamais « payée »", () => {
    const ecr = [
      { reference_piece: "DECL-TVA-2026-10", journal_code: "OD", date_ecriture: "2026-10-31", compte_numero: "34560000", debit: 300, credit: 0 },
      { reference_piece: "DECL-TVA-2026-10", journal_code: "OD", date_ecriture: "2026-10-31", compte_numero: "34552000", debit: 0, credit: 300 },
    ];
    expect(statut(ecr, ["DECL-TVA-2026-10.pdf"], "2026-10")).toBe("credit");
    expect(etatsDeclarationsTva(ecr, []).get("2026-10")).toMatchObject({ creditReporte: 300, montantDu: 0, montantPaye: 0 });
  });

  it("une période sans dette ni crédit déposée est « néant » ; déposée sans OD : « non liquidée »", () => {
    // Dette entièrement couverte par un crédit antérieur : C 3456 / D 44551, aucun 4456.
    const couverte = [
      { reference_piece: "DECL-TVA-2026-10", journal_code: "OD", date_ecriture: "2026-10-31", compte_numero: "44551000", debit: 120, credit: 0 },
      { reference_piece: "DECL-TVA-2026-10", journal_code: "OD", date_ecriture: "2026-10-31", compte_numero: "34560000", debit: 0, credit: 120 },
    ];
    expect(statut(couverte, ["DECL-TVA-2026-10.pdf"], "2026-10")).toBe("neant");
    expect(statut([], ["DECL-TVA-2026-10.pdf"], "2026-10")).toBe("non_liquidee");
  });

  it("applique à chaque année SA périodicité, et le début d'activité", () => {
    const cal = calendrierTva({
      periodicite: (a) => (a === 2025 ? "mensuel" : "trimestriel"), aujourdhui: auj,
      etats: new Map(), dateDebutActivite: "2025-11-01",
    });
    expect(cal.map((e) => e.periode)).toEqual(["2025-11", "2025-12", "2026-T1", "2026-T2", "2026-T3", "2026-T4"]);
    expect(prochaineEcheanceTva(cal)?.periode).toBe("2025-11");
  });

  it("ne dépend pas de l'existence de factures : une période vide se déclare aussi", () => {
    const cal = calendrierTva({ periodicite: "trimestriel", aujourdhui: auj, etats: new Map(), dateDebutActivite: "2026-04-15" });
    expect(cal.find((e) => e.periode === "2026-T3")).toMatchObject({ statut: "en_retard", echeance: "2026-10-31" });
  });

  it("lit les périodes liquidées dans les références d'OD", () => {
    expect([...periodesDeclareesTva(["DECL-TVA-2026-09", "FA-1", "DECL-TVA-2026-T2", null])]).toEqual(["2026-09", "2026-T2"]);
  });
});

describe("reglementsParCompensation — règlements datés de la signature", () => {
  const ecr = [
    { journal_code: "ACH", compte_numero: "44110003", reference_piece: "ff1", lettrage_code: "AB", debit: 0, credit: 6000, date_ecriture: "2026-04-01" },
    { journal_code: "OD", compte_numero: "44110003", reference_piece: "COMP-CV-7", lettrage_code: "AB", debit: 4000, credit: 0, date_ecriture: "2026-06-30" },
    { journal_code: "BQ", compte_numero: "44110003", reference_piece: "VIR", lettrage_code: "AB", debit: 2000, credit: 0, date_ecriture: "2026-05-02" },
  ];
  it("retient la part compensée, datée de la signature et non de l'OD", () => {
    const p = reglementsParCompensation(ecr, [{ id: "ff1" }], "fournisseur", new Map([["CV-7", "2026-05-20"]]));
    expect(p).toEqual([{ facture_fournisseur_id: "ff1", montant: 4000, date_paiement: "2026-05-20", origine: "compensation", reference: "COMP-CV-7" }]);
  });
});

describe("caTaxableTva — CA taxable de l'art. 108, par nature fiscale", () => {
  const v = (o: any) => ({ statut: "conforme", type: "facture", date_facture: "2025-06-01", montant_ht: 0, montant_tva: 0, ...o });

  it("retient les ventes soumises à TVA (acomptes compris), déduit les avoirs, écarte les ventes sans TVA", () => {
    const ca = caTaxableTva([
      v({ numero: "F1", montant_ht: 900_000, montant_tva: 180_000 }),
      v({ numero: "AC1", type: "acompte", montant_ht: 150_000, montant_tva: 30_000 }),
      v({ numero: "AV1", type: "avoir", montant_ht: -40_000, montant_tva: -8_000 }),
      v({ numero: "EXO1", montant_ht: 300_000, montant_tva: 0 }),
      v({ numero: "PF1", type: "proforma", montant_ht: 999_999, montant_tva: 199_999 }),
      v({ numero: "R1", statut: "rejetee", montant_ht: 500_000, montant_tva: 100_000 }),
      v({ numero: "F2024", date_facture: "2024-12-31", montant_ht: 5_000_000, montant_tva: 1_000_000 }),
    ], 2025)!;
    expect(ca.montant).toBe(1_010_000);
    expect(ca.retenues).toEqual({ nb: 2, ht: 1_050_000 });
    expect(ca.avoirs).toEqual({ nb: 1, ht: 40_000 });
    expect(ca.sansTva).toMatchObject({ nb: 1, ht: 300_000, numeros: ["EXO1"] });
    expect(ca.ignorees).toBe(2);
    expect(ca.justification).toContain("1 vente(s) sans TVA écartée(s)");
  });

  it("sans vente dans l'année : CA INCONNU (null), pas nul", () => {
    expect(caTaxableTva([v({ date_facture: "2024-05-01", montant_ht: 10, montant_tva: 2 })], 2025)).toBeNull();
  });

  it("une vente exonérée ne fait pas basculer en mensuel ; la justification figure au motif", () => {
    const ventes = [v({ montant_ht: 800_000, montant_tva: 160_000 }), v({ montant_ht: 400_000, montant_tva: 0 })];
    const p = periodiciteTva({}, 2026, caTaxableTva(ventes, 2025));
    expect(p).toMatchObject({ periodicite: "trimestriel", source: "chiffre_affaires" });
    expect(p.motif).toContain(caTaxableTva(ventes, 2025)!.justification);
    expect(caTaxableTva(ventes, 2025)!.montant).toBe(800_000);
    expect(periodiciteTva({}, 2026, caTaxableTva([v({ montant_ht: 1_000_000, montant_tva: 200_000 })], 2025)).periodicite).toBe("mensuel");
  });
});
