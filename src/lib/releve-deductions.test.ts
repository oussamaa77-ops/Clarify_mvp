import { describe, it, expect } from "vitest";
import {
  COLONNES_RELEVE_DEDUCTIONS, MODE_PAIEMENT_DGI, DESIGNATION_DGI_DEFAUT,
  codeModePaiementDGI, construireReleveDeductions, designationAchat, designationDGI,
  indexerComptesCharge, resoudreIdentiteFiscale, tauxTvaFacture,
  ligneVersCellules, totauxReleveDeductions, type AchatDeduction,
} from "./releve-deductions";

/** Achat 1000 HT + 200 TVA = 1200 TTC, soldé, du fournisseur F1. */
const achat = (o: Partial<AchatDeduction> = {}): AchatDeduction => ({
  id: "A1", numero: "FA-001", fournisseur_id: "F1", fournisseur_nom: "ACME SARL",
  montant_ht: 1000, montant_tva: 200, montant_ttc: 1200,
  montant_paye: 1200, montant_restant: 0, statut_paiement: "payee",
  date_facture: "2026-05-10", date_paiement: "2026-05-20",
  lignes: [{ designation: "Fournitures de bureau" }],
  ...o,
});

const FOURNISSEURS = [{ id: "F1", nom: "ACME SARL", ice: "001234567000045", if_fiscal: "12345678" }];

describe("colonnes DGI", () => {
  it("expose exactement les 14 colonnes SIMPL-TVA, dans l'ordre", () => {
    expect(COLONNES_RELEVE_DEDUCTIONS).toHaveLength(14);
    expect(COLONNES_RELEVE_DEDUCTIONS).toEqual([
      "N° ordre", "N° facture", "Désignation", "Montant HT", "Montant TVA", "Montant TTC",
      "IF Fournisseur", "Nom/Raison sociale", "ICE Fournisseur", "Taux TVA", "Prorata",
      "Id Mode Paiement", "Date paiement", "Date facture",
    ]);
  });

  it("sérialise une ligne en 14 cellules alignées sur les en-têtes", () => {
    const [l] = construireReleveDeductions({ achats: [achat()], fournisseurs: FOURNISSEURS });
    const cellules = ligneVersCellules(l);
    expect(cellules).toHaveLength(COLONNES_RELEVE_DEDUCTIONS.length);
    expect(cellules).toEqual([
      1, "FA-001", "Fournitures de bureau", 1000, 200, 1200,
      "12345678", "ACME SARL", "001234567000045", 20, 100, MODE_PAIEMENT_DGI.autre,
      "2026-05-20", "2026-05-10",
    ]);
  });
});

describe("codeModePaiementDGI", () => {
  it("mappe les instruments sur la nomenclature DGI", () => {
    expect(codeModePaiementDGI("especes")).toBe(1);
    expect(codeModePaiementDGI("cheque")).toBe(2);
    expect(codeModePaiementDGI("prelevement")).toBe(3);
    expect(codeModePaiementDGI("virement")).toBe(4);
    expect(codeModePaiementDGI("effet")).toBe(5);
  });

  it("range la carte et l'inconnu en « Autre » (7), jamais en compensation", () => {
    expect(codeModePaiementDGI("carte")).toBe(7);
    expect(codeModePaiementDGI(null)).toBe(7);
    expect(codeModePaiementDGI(undefined)).toBe(7);
  });

  it("lit le mode depuis l'index des règlements, sinon depuis la facture", () => {
    const parIndex = construireReleveDeductions({
      achats: [achat()], fournisseurs: FOURNISSEURS,
      modes: new Map([["A1", "cheque" as const]]),
    });
    expect(parIndex[0].idModePaiement).toBe(2);

    const parFacture = construireReleveDeductions({
      achats: [achat({ mode_reglement: "virement" })], fournisseurs: FOURNISSEURS,
    });
    expect(parFacture[0].idModePaiement).toBe(4);
  });
});

describe("règlements échelonnés", () => {
  it("génère une ligne par règlement, avec sa quote-part et sa date", () => {
    const paiements = [
      { facture_fournisseur_id: "A1", montant: 300, date_paiement: "2026-06-10" },
      { facture_fournisseur_id: "A1", montant: 900, date_paiement: "2026-07-05" },
    ];
    const lignes = construireReleveDeductions({ achats: [achat()], paiements, fournisseurs: FOURNISSEURS });
    expect(lignes).toHaveLength(2);
    expect(lignes[0]).toMatchObject({ ordre: 1, montantTtc: 300, montantHt: 250, montantTva: 50, datePaiement: "2026-06-10" });
    expect(lignes[1]).toMatchObject({ ordre: 2, montantTtc: 900, montantHt: 750, montantTva: 150, datePaiement: "2026-07-05" });
    // La somme des lignes reconstitue la facture : aucune TVA ne se perd.
    const t = totauxReleveDeductions(lignes);
    expect(t.totalTva).toBe(200);
    expect(t.totalTtc).toBe(1200);
  });

  it("ne retient que les règlements de la période déclarée", () => {
    const paiements = [
      { facture_fournisseur_id: "A1", montant: 300, date_paiement: "2026-06-10" },
      { facture_fournisseur_id: "A1", montant: 900, date_paiement: "2026-07-05" },
    ];
    const juin = construireReleveDeductions({
      achats: [achat()], paiements, fournisseurs: FOURNISSEURS,
      debut: "2026-06-01", fin: "2026-06-30",
    });
    expect(juin).toHaveLength(1);
    expect(juin[0].montantTva).toBe(50);
    expect(juin[0].ordre).toBe(1); // la numérotation repart de 1 sur la période
  });

  it("complète un règlement partiel non daté sans dépasser la part réglée", () => {
    // 300 datés, mais la facture est soldée (1200) → 900 reconstitués.
    const paiements = [{ facture_fournisseur_id: "A1", montant: 300, date_paiement: "2026-06-10" }];
    const lignes = construireReleveDeductions({ achats: [achat()], paiements, fournisseurs: FOURNISSEURS });
    expect(lignes).toHaveLength(2);
    expect(totauxReleveDeductions(lignes).totalTtc).toBe(1200);
    expect(lignes.find(l => !l.reglementDate)?.montantTtc).toBe(900);
    expect(totauxReleveDeductions(lignes).sansReglementDate).toBe(1);
  });

  it("ignore l'excédent d'un règlement saisi en double", () => {
    const paiements = [
      { facture_fournisseur_id: "A1", montant: 1200, date_paiement: "2026-06-10" },
      { facture_fournisseur_id: "A1", montant: 1200, date_paiement: "2026-06-11" },
    ];
    const t = totauxReleveDeductions(construireReleveDeductions({ achats: [achat()], paiements }));
    expect(t.totalTtc).toBe(1200); // pas 2400
    expect(t.totalTva).toBe(200);
  });

  it("n'attribue pas à une facture les règlements d'une autre", () => {
    const paiements = [
      { facture_fournisseur_id: "A2", montant: 600, date_paiement: "2026-06-10" },
      // Un paiement de VENTE ne doit jamais entrer dans le relevé des déductions.
      { facture_id: "A1", montant: 600, date_paiement: "2026-06-10" },
    ];
    const lignes = construireReleveDeductions({ achats: [achat()], paiements });
    expect(lignes).toHaveLength(1);
    expect(lignes[0].reglementDate).toBe(false); // repli sur la date de la facture
    expect(lignes[0].montantTtc).toBe(1200);
  });
});

describe("périmètre du relevé", () => {
  it("écarte les achats non réglés (aucun droit à déduction)", () => {
    const impaye = achat({ montant_paye: 0, montant_restant: 1200, statut_paiement: "non_payee", date_paiement: null });
    expect(construireReleveDeductions({ achats: [impaye] })).toEqual([]);
  });

  it("écarte les achats sans TVA (exonérés / hors champ)", () => {
    expect(construireReleveDeductions({ achats: [achat({ montant_tva: 0 })] })).toEqual([]);
  });

  it("ne retient qu'un prorata de règlement partiel", () => {
    const partiel = achat({ montant_paye: 600, montant_restant: 600, statut_paiement: "partielle" });
    const [l] = construireReleveDeductions({ achats: [partiel] });
    expect(l.montantTtc).toBe(600);
    expect(l.montantTva).toBe(100);
  });

  it("numérote et trie par date de règlement croissante", () => {
    const paiements = [
      { facture_fournisseur_id: "A1", montant: 1200, date_paiement: "2026-08-01" },
      { facture_fournisseur_id: "A2", montant: 1200, date_paiement: "2026-06-01" },
    ];
    const lignes = construireReleveDeductions({
      achats: [achat(), achat({ id: "A2", numero: "FA-002" })], paiements,
    });
    expect(lignes.map(l => [l.ordre, l.numeroFacture, l.datePaiement])).toEqual([
      [1, "FA-002", "2026-06-01"],
      [2, "FA-001", "2026-08-01"],
    ]);
  });
});

describe("identité du fournisseur — jointure dynamique sur l'annuaire", () => {
  it("reprend IF et ICE de la fiche fournisseur", () => {
    const [l] = construireReleveDeductions({ achats: [achat()], fournisseurs: FOURNISSEURS });
    expect(l.ifFournisseur).toBe("12345678");
    expect(l.iceFournisseur).toBe("001234567000045");
    expect(l.nomFournisseur).toBe("ACME SARL");
  });

  it("préfère la fiche À JOUR au nom figé sur la facture", () => {
    const [l] = construireReleveDeductions({
      achats: [achat({ fournisseur_nom: "ACME (ancien nom)" })],
      fournisseurs: [{ id: "F1", nom: "ACME MAROC SARL", ice: "001", if_fiscal: "999" }],
    });
    expect(l.nomFournisseur).toBe("ACME MAROC SARL");
  });

  it("rattache par raison sociale quand fournisseur_id est absent", () => {
    const [l] = construireReleveDeductions({
      achats: [achat({ fournisseur_id: null, fournisseur_nom: "  acme   sarl " })],
      fournisseurs: FOURNISSEURS,
    });
    expect(l.ifFournisseur).toBe("12345678");
    expect(l.iceFournisseur).toBe("001234567000045");
  });

  it("consolide les fiches en double : l'IF de la jumelle complète la principale", () => {
    // Cas réel : deux fiches pour le même fournisseur, même ICE, l'une sans IF.
    const annuaire = [
      { id: "F1", nom: "PRO-FLUIDES MAROC SARL", ice: "002145896000188", if_fiscal: null },
      { id: "F2", nom: "PRO-FLUIDES MAROC SARL", ice: "002145896000188", if_fiscal: "40404040" },
    ];
    const [l] = construireReleveDeductions({
      achats: [achat({ fournisseur_id: "F1", fournisseur_nom: "PRO-FLUIDES MAROC SARL" })],
      fournisseurs: annuaire,
    });
    expect(l.ifFournisseur).toBe("40404040");
    expect(l.iceFournisseur).toBe("002145896000188");
  });

  it("consolide aussi par ICE identique malgré une raison sociale différente", () => {
    const annuaire = [
      { id: "F1", nom: "WETRAFA Sarlu", ice: "001648789000071", if_fiscal: null },
      { id: "F2", nom: "ACOSOLUTIONS", ice: "001648789000071", if_fiscal: "55556666" },
    ];
    expect(resoudreIdentiteFiscale({ fournisseur_id: "F1", fournisseur_nom: "WETRAFA" }, annuaire))
      .toEqual({ nom: "WETRAFA Sarlu", ice: "001648789000071", if_fiscal: "55556666" });
  });

  it("laisse IF/ICE vides plutôt que d'inventer, et garde le nom de la facture", () => {
    const [l] = construireReleveDeductions({ achats: [achat({ fournisseur_id: null })] });
    expect(l.ifFournisseur).toBe("");
    expect(l.iceFournisseur).toBe("");
    expect(l.nomFournisseur).toBe("ACME SARL");
  });

  it("ne rapproche pas deux fournisseurs homonymes vides", () => {
    // Noms vides des deux côtés : aucun rapprochement ne doit se faire.
    const annuaire = [{ id: "F9", nom: "", ice: "999", if_fiscal: "888" }];
    expect(resoudreIdentiteFiscale({ fournisseur_id: null, fournisseur_nom: "" }, annuaire))
      .toEqual({ nom: "", ice: "", if_fiscal: "" });
  });
});

describe("designationDGI", () => {
  it("privilégie le libellé des lignes de la facture", () => {
    expect(designationDGI([{ designation: "Papier A4" }], "6111")).toBe("Papier A4");
  });

  it("retombe sur la nature de la charge via le compte PCM", () => {
    // Compte connu finement du dictionnaire du moteur.
    expect(designationDGI(null, "61455")).toBe("FRAIS DE TÉLÉCOMMUNICATIONS");
    expect(designationDGI([], "6133")).toBe("ENTRETIEN ET RÉPARATIONS");
    // Compte connu seulement au niveau de sa rubrique CGNC : on descend d'un cran
    // plutôt que de rendre le générique.
    expect(designationDGI(null, "6145")).toBe("AUTRES CHARGES EXTERNES");
    expect(designationDGI([], "6111")).toBe("ACHATS REVENDUS DE MARCHANDISES");
  });

  it("applique le libellé générique DGI en dernier recours", () => {
    expect(designationDGI(null, null)).toBe(DESIGNATION_DGI_DEFAUT);
    expect(designationDGI([], "")).toBe("ACHATS DE BIENS ET SERVICES");
    // Compte inconnu du référentiel → générique plutôt qu'un intitulé inventé.
    expect(designationDGI(null, "99999")).toBe(DESIGNATION_DGI_DEFAUT);
  });

  it("n'émet JAMAIS de désignation vide dans le relevé", () => {
    const lignes = construireReleveDeductions({
      achats: [achat({ lignes: null }), achat({ id: "A2", numero: "FA-002", lignes: [{ quantite: 2 }] })],
      comptesCharge: new Map([["A2", "6133"]]),
    });
    expect(lignes).toHaveLength(2);
    expect(lignes.every(l => l.designation.trim().length > 0)).toBe(true);
    expect(lignes.find(l => l.numeroFacture === "FA-001")!.designation).toBe(DESIGNATION_DGI_DEFAUT);
    expect(lignes.find(l => l.numeroFacture === "FA-002")!.designation).toContain("ENTRETIEN");
  });

  it("accepte les intitulés PCM du cabinet en priorité", () => {
    expect(designationDGI(null, "6111", { "6111": "Achats de matières premières" }))
      .toBe("ACHATS DE MATIÈRES PREMIÈRES");
  });
});

describe("indexerComptesCharge", () => {
  it("rattache la facture à son compte de charge via reference_piece", () => {
    const index = indexerComptesCharge([
      { compte_numero: "6145", reference_piece: "A1", debit: 481.66 },
      { compte_numero: "44552", reference_piece: "A1", debit: 96.33 },  // TVA : ignorée
    ]);
    expect(index.get("A1")).toBe("6145");
  });

  it("retient le plus gros débit sur un achat ventilé", () => {
    const index = indexerComptesCharge([
      { compte_numero: "6111", reference_piece: "A1", debit: 200 },
      { compte_numero: "6133", reference_piece: "A1", debit: 900 },
    ]);
    expect(index.get("A1")).toBe("6133");
  });

  it("ignore les écritures sans pièce de rattachement", () => {
    expect(indexerComptesCharge([{ compte_numero: "6111", reference_piece: null, debit: 100 }]).size).toBe(0);
  });
});

describe("contrôles avant dépôt", () => {
  it("compte les lignes sans IF ni ICE (motif de rejet DGI)", () => {
    const lignes = construireReleveDeductions({
      achats: [
        achat(),
        // Fournisseur totalement absent de l'annuaire : ni id, ni nom connu.
        achat({ id: "A2", numero: "FA-002", fournisseur_id: null, fournisseur_nom: "INCONNU SARL" }),
      ],
      fournisseurs: FOURNISSEURS,
    });
    expect(totauxReleveDeductions(lignes).sansIdentiteFiscale).toBe(1);
  });

  it("ne signale pas un fournisseur identifié par le seul ICE", () => {
    const lignes = construireReleveDeductions({
      achats: [achat()], fournisseurs: [{ id: "F1", nom: "ACME", ice: "001234567000045", if_fiscal: "" }],
    });
    expect(totauxReleveDeductions(lignes).sansIdentiteFiscale).toBe(0);
  });

  it("repère un règlement antérieur à la facture", () => {
    const paiements = [{ facture_fournisseur_id: "A1", montant: 1200, date_paiement: "2024-07-16" }];
    const lignes = construireReleveDeductions({ achats: [achat()], paiements });
    expect(totauxReleveDeductions(lignes).paiementAvantFacture).toBe(1);
  });

  it("ne signale rien sur un relevé sain", () => {
    const t = totauxReleveDeductions(construireReleveDeductions({
      achats: [achat()], fournisseurs: FOURNISSEURS,
      paiements: [{ facture_fournisseur_id: "A1", montant: 1200, date_paiement: "2026-05-20" }],
    }));
    expect(t).toMatchObject({ sansIdentiteFiscale: 0, paiementAvantFacture: 0, sansReglementDate: 0 });
  });
});

describe("designationAchat", () => {
  it("prend le premier libellé exploitable des lignes OCR", () => {
    expect(designationAchat([{ designation: "Papier A4" }])).toBe("Papier A4");
    expect(designationAchat([{ description: "Cartouches" }])).toBe("Cartouches");
    expect(designationAchat(["Prestation de conseil"])).toBe("Prestation de conseil");
    expect(designationAchat([{ designation: "  " }, { libelle: "Toner" }])).toBe("Toner");
  });

  it("rend une chaîne vide plutôt qu'un libellé inventé", () => {
    expect(designationAchat(null)).toBe("");
    expect(designationAchat([])).toBe("");
    expect(designationAchat([{ quantite: 3 }])).toBe("");
  });
});

describe("tauxTvaFacture", () => {
  it("aligne sur un taux légal marocain malgré les arrondis d'OCR", () => {
    expect(tauxTvaFacture(1000, 200)).toBe(20);
    expect(tauxTvaFacture(1000, 199.8)).toBe(20);
    expect(tauxTvaFacture(1000, 140)).toBe(14);
    expect(tauxTvaFacture(1000, 70)).toBe(7);
  });

  it("rend le taux réel quand il sort du barème", () => {
    expect(tauxTvaFacture(1000, 330)).toBe(33);
    expect(tauxTvaFacture(0, 200)).toBe(0);
  });
});
