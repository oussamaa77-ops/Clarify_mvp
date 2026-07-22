import { describe, it, expect } from "vitest";
import {
  modeDepuisLibelle,
  normaliserMode,
  indexerModesPaiement,
  modePaiementFacture,
} from "./mode-paiement";

describe("modeDepuisLibelle", () => {
  it("reconnaît un virement, quelle que soit l'abréviation de la banque", () => {
    expect(modeDepuisLibelle("VIR RECU ACME SARL")).toBe("virement");
    expect(modeDepuisLibelle("VIREMENT EMIS FOURNISSEUR")).toBe("virement");
    expect(modeDepuisLibelle("VIRT RECU 12/02")).toBe("virement");
  });

  it("reconnaît un chèque et une remise de chèque", () => {
    expect(modeDepuisLibelle("CHEQUE N° 4412")).toBe("cheque");
    expect(modeDepuisLibelle("CHQ 0012345")).toBe("cheque");
    expect(modeDepuisLibelle("REMISE CHEQUE SUR PLACE")).toBe("cheque");
  });

  // Un libellé peut citer les deux instruments ; le plus spécifique doit gagner,
  // sinon un règlement par chèque s'afficherait « Virement ».
  it("fait primer le chèque sur le virement dans un libellé mixte", () => {
    expect(modeDepuisLibelle("VIR RECU REGL CHQ 4412")).toBe("cheque");
  });

  it("reconnaît prélèvement, carte et effet de commerce", () => {
    expect(modeDepuisLibelle("PRELEVEMENT LYDEC")).toBe("prelevement");
    expect(modeDepuisLibelle("PRLV MENSUEL")).toBe("prelevement");
    expect(modeDepuisLibelle("PAIEMENT TPE 12/03")).toBe("carte");
    expect(modeDepuisLibelle("REMISE LCN N° 630238")).toBe("effet");
  });

  it("reconnaît les espèces seulement quand le libellé le dit", () => {
    expect(modeDepuisLibelle("VERSEMENT ESPECES GUICHET")).toBe("especes");
    expect(modeDepuisLibelle("RETRAIT GAB CASA")).toBe("especes");
    // « VERSEMENT » seul est ambigu (versement de fonds) → pas de mode inventé.
    expect(modeDepuisLibelle("VERSEMENT")).toBeNull();
  });

  it("rend null sur un libellé vide ou non reconnu", () => {
    expect(modeDepuisLibelle(null)).toBeNull();
    expect(modeDepuisLibelle("REGULARISATION DIVERSE")).toBeNull();
  });

  it("lit aussi la référence quand le libellé ne dit rien", () => {
    expect(modeDepuisLibelle("REGLEMENT CLIENT", "CHQ-8891")).toBe("cheque");
  });
});

describe("normaliserMode", () => {
  it("normalise les valeurs stockées en base", () => {
    expect(normaliserMode("especes")).toBe("especes");
    expect(normaliserMode("Espèces")).toBe("especes");
    expect(normaliserMode("cheque")).toBe("cheque");
    expect(normaliserMode("virement")).toBe("virement");
    expect(normaliserMode("prelevement")).toBe("prelevement");
  });

  it("rend null sur une valeur vide ou inconnue", () => {
    expect(normaliserMode(null)).toBeNull();
    expect(normaliserMode("autre")).toBeNull();
  });
});

describe("indexerModesPaiement", () => {
  it("déduit le mode d'une facture client lettrée depuis le relevé", () => {
    const idx = indexerModesPaiement("client", {
      transactions: [{ facture_id: "f1", document_type: "facture_client", libelle: "VIR RECU ACME" }],
    });
    expect(idx.get("f1")).toBe("virement");
  });

  // La FK facture_id est partagée par les deux sens : sans filtre sur
  // document_type, une facture d'achat teindrait la facture de vente de même id.
  it("ignore les transactions de l'autre sens", () => {
    const idx = indexerModesPaiement("client", {
      transactions: [{ facture_id: "f1", document_type: "facture_fournisseur", libelle: "CHQ 12" }],
    });
    expect(idx.has("f1")).toBe(false);
  });

  it("accepte les lignes lettrées avant l'introduction de document_type", () => {
    const idx = indexerModesPaiement("fournisseur", {
      transactions: [{ facture_id: "ff1", document_type: "inconnu", libelle: "VIREMENT EMIS" }],
    });
    expect(idx.get("ff1")).toBe("virement");
  });

  it("fait primer l'encaissement saisi à la main sur le libellé bancaire", () => {
    const idx = indexerModesPaiement("client", {
      transactions: [{ facture_id: "f1", document_type: "facture_client", libelle: "VIR RECU" }],
      encaissements: [{ facture_id: "f1", type: "especes" }],
    });
    expect(idx.get("f1")).toBe("especes");
  });

  it("rattache les encaissements fournisseurs à la bonne colonne", () => {
    const idx = indexerModesPaiement("fournisseur", {
      encaissements: [{ facture_fournisseur_id: "ff1", type: "cheque" }, { facture_id: "f1", type: "especes" }],
    });
    expect(idx.get("ff1")).toBe("cheque");
    expect(idx.has("f1")).toBe(false);
  });
});

describe("modePaiementFacture", () => {
  const vide = new Map();

  it("n'affiche rien tant que la facture n'est pas réglée", () => {
    expect(modePaiementFacture({ id: "f1", statut_paiement: "non_payee", mode_reglement: "virement" }, vide))
      .toBeNull();
  });

  it("affiche le mode constaté d'une facture payée", () => {
    const idx = new Map([["f1", "cheque" as const]]);
    expect(modePaiementFacture({ id: "f1", statut_paiement: "payee", mode_reglement: "virement" }, idx))
      .toBe("cheque");
  });

  // Le bouton « Payer en espèces » estampille mode_reglement : sans pièce
  // bancaire, c'est cette estampille qui porte le mode.
  it("retombe sur le mode stocké quand aucune pièce n'explique le règlement", () => {
    expect(modePaiementFacture({ id: "f1", statut_paiement: "payee", mode_reglement: "especes" }, vide))
      .toBe("especes");
  });

  it("affiche aussi le mode d'un règlement partiel", () => {
    const idx = new Map([["f1", "virement" as const]]);
    expect(modePaiementFacture({ id: "f1", statut_paiement: "partielle" }, idx)).toBe("virement");
  });
});
