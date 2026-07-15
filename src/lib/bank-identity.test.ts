import { describe, it, expect } from "vitest";
import {
  identifierBanque, identifierBanqueParNom, identifierBanqueDepuisTexte,
  codeBanqueFromRib, maskRib, BANKS,
} from "./bank-identity";

const rib = (code3: string) => `${code3} 780 0002110000012345 67`;

describe("codeBanqueFromRib", () => {
  it("extrait les 3 premiers chiffres, séparateurs ignorés", () => {
    expect(codeBanqueFromRib("007 780 0002110000012345 67")).toBe("007");
    expect(codeBanqueFromRib("230-810-0000000000000000-11")).toBe("230");
    expect(codeBanqueFromRib("")).toBe("");
  });
});

describe("identifierBanque — mapping par code RIB (autoritaire)", () => {
  const cas: Array<[string, string]> = [
    ["007", "attijariwafa"],
    ["101", "bcp"], ["127", "bcp"], ["145", "bcp"], ["190", "bcp"],
    ["011", "boa"], ["012", "boa"],
    ["230", "cih"],
    ["013", "bmci"],
    ["022", "saham"],
    ["021", "cam"],
    ["019", "cdm"],
  ];
  for (const [code, id] of cas) {
    it(`code ${code} → ${id}`, () => {
      expect(identifierBanque({ rib: rib(code) }).id).toBe(id);
    });
  }

  it("le code RIB PRIME sur un mot-clé contradictoire du texte", () => {
    // Texte mentionne CIH mais le RIB est ATW (007) → on suit le RIB.
    expect(identifierBanque({ rib: rib("007"), texte: "agence CIH Bank Casablanca" }).id).toBe("attijariwafa");
  });

  it("repli sur mots-clés si RIB absent", () => {
    expect(identifierBanque({ rib: "", texte: "RELEVE ATTIJARIWAFA BANK" }).id).toBe("attijariwafa");
    expect(identifierBanque({ rib: null, texte: "BANQUE POPULAIRE" }).id).toBe("bcp");
    // Saham Bank (ex-Société Générale) : nouveau nom ET ancien libellé → même identité.
    expect(identifierBanque({ rib: "", texte: "RELEVE SAHAM BANK" }).id).toBe("saham");
    expect(identifierBanque({ rib: "", texte: "SOCIETE GENERALE MAROC" }).id).toBe("saham");
  });

  it("code inconnu et texte vide → banque inconnue (sans logo)", () => {
    const b = identifierBanque({ rib: rib("999"), texte: "" });
    expect(b.id).toBe("inconnue");
    expect(b.logo).toBeNull();
  });
});

describe("identifierBanqueParNom", () => {
  it("retrouve l'identité depuis un libellé stocké", () => {
    expect(identifierBanqueParNom("Attijariwafa Bank").id).toBe("attijariwafa");
    expect(identifierBanqueParNom("CIH Bank").id).toBe("cih");
    expect(identifierBanqueParNom("Banque Populaire").id).toBe("bcp");
    expect(identifierBanqueParNom("").id).toBe("inconnue");
  });
});

describe("identifierBanqueDepuisTexte", () => {
  it("extrait le RIB puis identifie la banque", () => {
    const r = identifierBanqueDepuisTexte("RELEVE D'IDENTITE BANCAIRE : 007 780 0002110000012345 67");
    expect(r.banque.id).toBe("attijariwafa");
    expect(r.rib.replace(/\s/g, "")).toBe("007780000211000001234567");
  });
});

describe("maskRib", () => {
  it("ne montre que les 4 derniers chiffres au format groupé", () => {
    expect(maskRib("007 780 0002110000000059 32")).toBe("•••• •••• •••• 5932");
    expect(maskRib("230-810-0000000000000000-99")).toBe("•••• •••• •••• 0099");
  });
  it("retourne \"\" si trop court / vide", () => {
    expect(maskRib("")).toBe("");
    expect(maskRib("12")).toBe("");
  });
});

describe("registre BANKS", () => {
  it("chaque banque a un logo et une couleur d'accent", () => {
    for (const b of BANKS) {
      expect(b.accent).toMatch(/bg-/);
      expect(b.accentText).toMatch(/text-/);
      expect(b.logo).toMatch(/^\/logos\//);
    }
  });
});
