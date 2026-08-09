import { describe, it, expect } from "vitest";
import {
  encoursTiersGrandLivre, projeterSituationFacture, situationDivergente,
  situationFactureGrandLivre, soldeBancaireAffiche, soldeCompte, soldeTresorerieGrandLivre,
} from "./encours-grandlivre";

// Grand livre de DIGITAL SOLUTIONS après purge de l'écriture fantôme : la vente
// est comptabilisée, rien n'est encaissé.
const VENTE_NON_REGLEE = [
  { journal_code: "VTE", compte_numero: "34210002", date_ecriture: "2026-04-15", debit: 9000, credit: 0, reference_piece: "FAC-2026-001", lettrage_code: null },
  { journal_code: "VTE", compte_numero: "44551", date_ecriture: "2026-04-15", debit: 0, credit: 1500, reference_piece: "FAC-2026-001" },
  { journal_code: "VTE", compte_numero: "7124", date_ecriture: "2026-04-15", debit: 0, credit: 7500, reference_piece: "FAC-2026-001" },
];

// La même vente, réglée par une ligne de relevé lettrée AA.
const VENTE_REGLEE = [
  { journal_code: "VTE", compte_numero: "34210002", date_ecriture: "2026-04-15", debit: 9000, credit: 0, reference_piece: "FAC-2026-001", lettrage_code: "AA" },
  { journal_code: "VTE", compte_numero: "7124", date_ecriture: "2026-04-15", debit: 0, credit: 7500, reference_piece: "FAC-2026-001" },
  { journal_code: "BQ", compte_numero: "5141", date_ecriture: "2026-07-09", debit: 9000, credit: 0, reference_piece: "FAC-2026-001", lettrage_code: null },
  { journal_code: "BQ", compte_numero: "34210002", date_ecriture: "2026-07-09", debit: 0, credit: 9000, reference_piece: "FAC-2026-001", lettrage_code: "AA" },
];

describe("soldeCompte", () => {
  it("somme débit − crédit sur la racine, auxiliaires compris", () => {
    expect(soldeCompte(VENTE_REGLEE, "3421")).toBe(0);
    expect(soldeCompte(VENTE_REGLEE, "514")).toBe(9000);
  });

  it("ignore les comptes hors racine", () => {
    expect(soldeCompte(VENTE_NON_REGLEE, "514")).toBe(0);
  });
});

describe("soldeTresorerieGrandLivre", () => {
  it("sépare banque et caisse, et somme les deux", () => {
    const gl = soldeTresorerieGrandLivre([
      ...VENTE_REGLEE,
      { journal_code: "CAI", compte_numero: "51610000", date_ecriture: "2026-07-10", debit: 400, credit: 0 },
    ]);
    expect(gl).toMatchObject({ banque: 9000, caisse: 400, total: 9400, mouvemente: true });
  });

  it("distingue « compte à zéro » de « aucun mouvement connu »", () => {
    // C'est ce que le widget confondait : il affichait 0,00 MAD dans les deux cas.
    expect(soldeTresorerieGrandLivre(VENTE_NON_REGLEE).mouvemente).toBe(false);
    expect(soldeTresorerieGrandLivre([
      { journal_code: "BQ", compte_numero: "5141", debit: 100, credit: 0 },
      { journal_code: "BQ", compte_numero: "5141", debit: 0, credit: 100 },
    ])).toMatchObject({ total: 0, mouvemente: true });
  });
});

describe("soldeBancaireAffiche", () => {
  it("fait primer le grand livre dès qu'il porte des mouvements", () => {
    // Le cas signalé : comptes_bancaires.solde_actuel à 0 alors que 5141 porte 9 000.
    expect(soldeBancaireAffiche(VENTE_REGLEE, 0))
      .toEqual({ montant: 9000, source: "grand_livre" });
  });

  it("retombe sur les comptes bancaires quand la compta ne connaît aucun mouvement", () => {
    expect(soldeBancaireAffiche(VENTE_NON_REGLEE, 12500))
      .toEqual({ montant: 12500, source: "comptes_bancaires" });
  });
});

describe("encoursTiersGrandLivre", () => {
  it("compte la facture non lettrée dans l'encours", () => {
    const e = encoursTiersGrandLivre(VENTE_NON_REGLEE);
    expect(e.total).toBe(9000);
    expect(e.postes).toEqual([{ compte: "34210002", solde: 9000 }]);
  });

  it("sort du calcul la facture soldée par un règlement lettré", () => {
    expect(encoursTiersGrandLivre(VENTE_REGLEE).total).toBe(0);
  });

  it("ne compense JAMAIS l'avance d'un client par la dette d'un autre", () => {
    const e = encoursTiersGrandLivre([
      { journal_code: "VTE", compte_numero: "34210001", debit: 34200, credit: 0 },
      { journal_code: "BQ", compte_numero: "34210002", debit: 0, credit: 5000 },
    ]);
    expect(e.total).toBe(34200);
    expect(e.avances).toBe(5000);
  });

  it("sait aussi calculer l'encours fournisseurs", () => {
    const e = encoursTiersGrandLivre(
      [{ journal_code: "ACH", compte_numero: "44110001", debit: 0, credit: 1440 }], "4411",
    );
    expect(e.avances).toBe(1440);
    expect(e.total).toBe(0);
  });

  it("écarte le bruit sous le centime", () => {
    expect(encoursTiersGrandLivre([
      { journal_code: "VTE", compte_numero: "34210001", debit: 100, credit: 0 },
      { journal_code: "BQ", compte_numero: "34210001", debit: 0, credit: 100.001 },
    ]).postes).toHaveLength(0);
  });
});

describe("situationFactureGrandLivre", () => {
  const cible = { references: ["FAC-2026-001"], montant_ttc: 9000, sens: "client" as const };

  it("rend une facture NON PAYÉE tant que sa ligne n'est pas lettrée", () => {
    expect(situationFactureGrandLivre(VENTE_NON_REGLEE, cible)).toMatchObject({
      montant_paye: 0, montant_restant: 9000, statut_paiement: "non_payee", trouvee: true,
    });
  });

  it("rend une facture SOLDÉE par le règlement lettré, et trace son code", () => {
    expect(situationFactureGrandLivre(VENTE_REGLEE, cible)).toMatchObject({
      montant_paye: 9000, montant_restant: 0, statut_paiement: "payee",
      codes: ["AA"], date_paiement: "2026-07-09",
    });
  });

  it("IGNORE une écriture de banque non lettrée, même si elle nomme la facture", () => {
    // Exactement l'écriture fantôme : elle mentionne la facture, elle ne la solde pas.
    const fantome = [
      ...VENTE_NON_REGLEE,
      { journal_code: "BQ", compte_numero: "5141", date_ecriture: "2026-07-09", debit: 9000, credit: 0, reference_piece: "FAC-2026-001", lettrage_code: null },
      { journal_code: "BQ", compte_numero: "34210002", date_ecriture: "2026-07-09", debit: 0, credit: 9000, reference_piece: "FAC-2026-001", lettrage_code: null },
    ];
    expect(situationFactureGrandLivre(fantome, cible).statut_paiement).toBe("non_payee");
  });

  it("additionne deux acomptes lettrés et rend « partielle »", () => {
    const s = situationFactureGrandLivre([
      { journal_code: "VTE", compte_numero: "34210002", debit: 9000, credit: 0, reference_piece: "FAC-2026-001", lettrage_code: "AB" },
      { journal_code: "BQ", compte_numero: "34210002", date_ecriture: "2026-05-02", debit: 0, credit: 3000, lettrage_code: "AB" },
      { journal_code: "CAI", compte_numero: "34210002", date_ecriture: "2026-06-02", debit: 0, credit: 2000, lettrage_code: "AB" },
    ], cible);
    expect(s).toMatchObject({ montant_paye: 5000, montant_restant: 4000, statut_paiement: "partielle", date_paiement: "2026-06-02" });
  });

  it("ne prend le règlement que sur le compte AUXILIAIRE réellement mouvementé", () => {
    // Un crédit sur un autre client, sous le même code, ne solde pas cette facture.
    const s = situationFactureGrandLivre([
      { journal_code: "VTE", compte_numero: "34210002", debit: 9000, credit: 0, reference_piece: "FAC-2026-001", lettrage_code: "AA" },
      { journal_code: "BQ", compte_numero: "34210007", debit: 0, credit: 9000, lettrage_code: "AA" },
    ], cible);
    expect(s.montant_paye).toBe(0);
  });

  it("retrouve la facture par son facture_id quand la référence diffère", () => {
    const s = situationFactureGrandLivre([
      { journal_code: "VTE", compte_numero: "34210002", debit: 9000, credit: 0, reference_piece: "FAC - 2026 - 001", facture_id: "f1", lettrage_code: "AA" },
      { journal_code: "BQ", compte_numero: "34210002", date_ecriture: "2026-07-09", debit: 0, credit: 9000, lettrage_code: "AA" },
    ], { ...cible, references: ["autre"], id: "f1" });
    expect(s.montant_paye).toBe(9000);
  });

  it("inverse le sens pour un fournisseur : c'est le DÉBIT qui règle", () => {
    const s = situationFactureGrandLivre([
      { journal_code: "ACH", compte_numero: "44110001", debit: 0, credit: 1440, reference_piece: "F-88", lettrage_code: "AC" },
      { journal_code: "BQ", compte_numero: "44110001", date_ecriture: "2026-05-01", debit: 1440, credit: 0, lettrage_code: "AC" },
    ], { references: ["F-88"], montant_ttc: 1440, sens: "fournisseur" });
    expect(s).toMatchObject({ montant_paye: 1440, statut_paiement: "payee" });
  });

  it("signale la facture absente du grand livre plutôt que de la dire payée", () => {
    expect(situationFactureGrandLivre([], cible)).toMatchObject({
      trouvee: false, montant_restant: 9000, statut_paiement: "non_payee",
    });
  });
});

describe("projeterSituationFacture", () => {
  const cible = { references: ["FAC-2026-001"], montant_ttc: 9000, sens: "client" as const };
  const glVide = situationFactureGrandLivre(VENTE_NON_REGLEE, cible);
  const glSolde = situationFactureGrandLivre(VENTE_REGLEE, cible);

  it("NE DÉMARQUE PAS une facture réglée mais jamais lettrée", () => {
    // Le cas rencontré sur SMERT WATER et SOMADIR : un `paiements` existe, mais
    // aucune écriture de trésorerie n'a jamais été générée — donc rien à lettrer.
    // S'en tenir au grand livre aurait effacé la seule trace du règlement.
    const p = projeterSituationFacture(glVide, [{ montant: 9000, date: "2026-03-02" }], 9000);
    expect(p).toMatchObject({
      montant_paye: 9000, montant_restant: 0, statut_paiement: "payee",
      date_paiement: "2026-03-02", source: "pieces",
    });
  });

  it("garde le grand livre quand il est au moins aussi complet", () => {
    const p = projeterSituationFacture(glSolde, [{ montant: 9000, date: "2026-01-01" }], 9000);
    expect(p).toBe(glSolde);
    expect(p.source).toBe("grand_livre");
  });

  it("laisse « non payée » la facture SANS lettrage ET SANS pièce", () => {
    // L'écriture fantôme purgée : plus rien ne la justifie, des deux côtés.
    expect(projeterSituationFacture(glVide, [], 9000)).toMatchObject({
      montant_paye: 0, statut_paiement: "non_payee", source: "grand_livre",
    });
  });

  it("additionne des acomptes formels et rend « partielle »", () => {
    const p = projeterSituationFacture(glVide, [
      { montant: 3000, date: "2026-05-02" }, { montant: 2000, date: "2026-06-02" },
    ], 9000);
    expect(p).toMatchObject({ montant_paye: 5000, montant_restant: 4000, statut_paiement: "partielle", date_paiement: "2026-06-02" });
  });

  it("borne le payé au TTC : une pièce en double ne crée pas un restant négatif", () => {
    const p = projeterSituationFacture(glVide, [{ montant: 12000 }], 9000);
    expect(p).toMatchObject({ montant_paye: 9000, montant_restant: 0 });
  });

  it("ne bascule pas sur les pièces pour un écart d'arrondi", () => {
    expect(projeterSituationFacture(glSolde, [{ montant: 9000.004 }], 9000).source).toBe("grand_livre");
  });
});

describe("situationDivergente", () => {
  const calcule = situationFactureGrandLivre(VENTE_NON_REGLEE, {
    references: ["FAC-2026-001"], montant_ttc: 9000, sens: "client",
  });

  it("détecte la projection périmée", () => {
    expect(situationDivergente({ montant_paye: 9000, montant_restant: 0, statut_paiement: "payee" }, calcule)).toBe(true);
    expect(situationDivergente({ montant_paye: 0, montant_restant: 9000, statut_paiement: "partielle" }, calcule)).toBe(true);
  });

  it("ne signale rien quand la facture est déjà alignée", () => {
    expect(situationDivergente({ montant_paye: 0, montant_restant: 9000, statut_paiement: "non_payee" }, calcule)).toBe(false);
  });

  it("tolère l'arrondi au centime, pas au-delà", () => {
    expect(situationDivergente({ montant_paye: 0.001, montant_restant: 9000, statut_paiement: "non_payee" }, calcule)).toBe(false);
    expect(situationDivergente({ montant_paye: 0.02, montant_restant: 9000, statut_paiement: "non_payee" }, calcule)).toBe(true);
  });
});
