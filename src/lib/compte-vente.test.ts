import { describe, it, expect } from "vitest";
import { compteVente, natureDepuisTexte } from "./compte-vente";

describe("natureDepuisTexte", () => {
  it("reconnaît une prestation", () => {
    expect(natureDepuisTexte("Prestation de conseil")).toBe("services");
    expect(natureDepuisTexte("Honoraires d'audit")).toBe("services");
    expect(natureDepuisTexte("Maintenance annuelle")).toBe("services");
  });

  it("reconnaît une marchandise", () => {
    expect(natureDepuisTexte("Vente de marchandises")).toBe("marchandises");
    expect(natureDepuisTexte("Articles divers")).toBe("marchandises");
  });

  it("NE TRANCHE PAS quand les deux natures cohabitent", () => {
    // « Fourniture et pose » relève d'un arbitrage humain : décider au mot-clé
    // déplacerait le produit d'un compte à l'autre sans motif.
    expect(natureDepuisTexte("Fourniture et installation")).toBeNull();
  });

  it("ne tranche pas sur un texte muet", () => {
    for (const t of ["", null, undefined, "Divers", "Facture n°12"]) {
      expect(natureDepuisTexte(t)).toBeNull();
    }
  });

  it("ignore accents et casse", () => {
    expect(natureDepuisTexte("ÉTUDE technique")).toBe("services");
  });
});

describe("compteVente", () => {
  it("1. la nature explicite prime sur tout", () => {
    expect(compteVente({ nature: "services", designations: ["Vente de marchandises"], secteur: "Commerce / Négoce" }))
      .toMatchObject({ compte: "7124", regle: "nature_explicite" });
  });

  it("2. les désignations priment sur le secteur", () => {
    // Un négociant qui facture une installation vend bien une prestation.
    expect(compteVente({ designations: ["Prestation d'installation"], secteur: "Commerce / Négoce" }))
      .toMatchObject({ compte: "7124", regle: "designations" });
  });

  it("2 bis. juge les lignes ENSEMBLE, pas une à une", () => {
    expect(compteVente({ designations: ["Conseil stratégique", "Formation équipe", "Audit"] }))
      .toMatchObject({ compte: "7124", nature: "services" });
  });

  it("3. le secteur tranche quand les lignes sont muettes", () => {
    expect(compteVente({ designations: ["Divers"], secteur: "Services IT" }))
      .toMatchObject({ compte: "7124", regle: "secteur" });
    expect(compteVente({ secteur: "Commerce / Négoce" }))
      .toMatchObject({ compte: "7111", regle: "secteur" });
    expect(compteVente({ secteur: "BTP" }))
      .toMatchObject({ compte: "7121", nature: "biens_produits", regle: "secteur" });
  });

  it("4. repli sur 7111 — aucun compte existant ne change sans motif", () => {
    expect(compteVente({})).toMatchObject({ compte: "7111", regle: "defaut" });
    expect(compteVente({ secteur: "Secteur inconnu" })).toMatchObject({ compte: "7111", regle: "defaut" });
  });

  it("trace toujours la règle qui a décidé", () => {
    const regles = new Set([
      compteVente({ nature: "services" }).regle,
      compteVente({ designations: ["honoraires"] }).regle,
      compteVente({ secteur: "Consulting" }).regle,
      compteVente({}).regle,
    ]);
    expect(regles).toEqual(new Set(["nature_explicite", "designations", "secteur", "defaut"]));
  });
});
