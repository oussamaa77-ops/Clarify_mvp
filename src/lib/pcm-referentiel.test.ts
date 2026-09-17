import { describe, expect, it } from "vitest";
import {
  COMPTES_A_VALIDER, PCM, RACINES_PAR_USAGE, RUBRIQUES_CGNC,
  assertComptesPcm, controlerComptesPcm, validatePcmAccount, type UsageCompte,
} from "./pcm-referentiel";
import { normaliserNumeroCompte } from "./numero-compte";

describe("validatePcmAccount — format", () => {
  it("accepte 4, 5, 8 et 10 chiffres : le CGNC n'impose pas 8", () => {
    for (const c of ["5141", "34552", "44110005", "3421000012"]) {
      expect(validatePcmAccount(c).ok, c).toBe(true);
    }
  });

  it("refuse vide, lettres, moins de 4 ou plus de 10 chiffres", () => {
    for (const c of ["", "   ", null, undefined, "514", "51", "CAISSE", "5141A", "4411-0005", "12345678901"]) {
      expect(validatePcmAccount(c).ok, String(c)).toBe(false);
    }
  });

  it("tolère les espaces autour sans les accepter au milieu", () => {
    expect(validatePcmAccount(" 5141 ").ok).toBe(true);
    expect(validatePcmAccount("51 41").ok).toBe(false);
  });

  it("rend la forme courte, la classe et la rubrique", () => {
    const v = validatePcmAccount("44580000");
    expect(v).toMatchObject({ significatif: "4458", classe: "4", rubrique: "44" });
  });
});

describe("validatePcmAccount — classe et rubrique CGNC", () => {
  it("refuse les classes 0 (hors bilan) et 9 (analytique)", () => {
    expect(validatePcmAccount("0100").ok).toBe(false);
    expect(validatePcmAccount("9100").ok).toBe(false);
  });

  it("refuse les rubriques du plan FRANÇAIS absentes du CGNC", () => {
    // 401/411 (tiers), 471 existe (rubrique 47), mais 62, 64, 66, 76, 41 non.
    for (const c of ["4010", "4110", "6226", "6411", "6611", "7611", "5300", "1200"]) {
      const v = validatePcmAccount(c);
      expect(v.ok, c).toBe(false);
      expect(v.erreurs.join(" "), c).toMatch(/rubrique/);
    }
  });

  it("accepte chaque rubrique déclarée du CGNC", () => {
    for (const r of Object.keys(RUBRIQUES_CGNC)) {
      expect(validatePcmAccount(`${r}11`).ok, r).toBe(true);
    }
  });

  it("classe 8 : recevable, mais signalée", () => {
    const v = validatePcmAccount("8100");
    expect(v.ok).toBe(true);
    expect(v.avertissements.length).toBeGreaterThan(0);
  });

  it("4191 : hors CGNC mais dérogation documentée — recevable AVEC avertissement", () => {
    const v = validatePcmAccount("4191");
    expect(v.ok).toBe(true);
    expect(v.avertissements.join(" ")).toMatch(/4421/);
    // La dérogation ne s'étend pas à toute la rubrique 41.
    expect(validatePcmAccount("4110").ok).toBe(false);
  });

  it("un compte à valider n'est jamais silencieux", () => {
    for (const c of Object.keys(COMPTES_A_VALIDER)) {
      expect(validatePcmAccount(c).avertissements.length, c).toBeGreaterThan(0);
    }
  });
});

describe("validatePcmAccount — cohérence avec l'usage", () => {
  const cas: [string, UsageCompte, boolean][] = [
    ["34210002", "client", true],
    ["44110005", "client", false],
    ["44110005", "fournisseur", true],
    ["3421", "fournisseur", false],
    ["61110000", "charge", true],
    ["71110000", "charge", false],
    ["7124", "produit", true],
    ["6141", "produit", false],
    ["44551000", "tva_collectee", true],
    ["34552", "tva_collectee", false],
    ["34552000", "tva_recuperable", true],
    ["4458", "tva_attente_vente", true],
    ["3458", "tva_attente_vente", false],
    ["4456", "tva_due", true],
    ["51410000", "banque", true],
    ["51610000", "banque", false],
    ["51610000", "caisse", true],
    ["5143", "caisse", false],
    ["4712", "attente_bancaire", true],
    ["4432", "personnel", true],
    ["4441", "personnel", false],
    ["11610000", "report_a_nouveau", true],
  ];
  it.each(cas)("%s pour « %s » → %s", (compte, usage, attendu) => {
    expect(validatePcmAccount(compte, { usage }).ok).toBe(attendu);
  });

  it("chaque usage déclare au moins une racine elle-même recevable", () => {
    for (const [usage, racines] of Object.entries(RACINES_PAR_USAGE)) {
      expect(racines.length, usage).toBeGreaterThan(0);
      for (const r of racines) {
        expect(validatePcmAccount(r.padEnd(4, "1")).ok, `${usage} ${r}`).toBe(true);
      }
    }
  });
});

describe("référentiel PCM de l'application", () => {
  it("chaque compte nommé est recevable, en forme courte ET canonique", () => {
    for (const [nom, compte] of Object.entries(PCM)) {
      expect(validatePcmAccount(compte).ok, nom).toBe(true);
      expect(validatePcmAccount(normaliserNumeroCompte(compte)).ok, nom).toBe(true);
    }
  });

  it("les corrections de ce lot sont VERROUILLÉES", () => {
    expect(PCM.PRIMES_ASSURANCES).toBe("6134");           // pas 6161 (impôts directs)
    expect(PCM.IMPOTS_TAXES_DIRECTS).toBe("6161");        // taxe professionnelle, pas 6313
    expect(PCM.DEPLACEMENTS_MISSIONS_RECEPTIONS).toBe("6143"); // réceptions, pas 6147
    expect(PCM.SERVICES_BANCAIRES).toBe("6147");
    expect(PCM.FRAIS_POSTAUX_TELECOMMUNICATIONS).toBe("6145"); // pas 6132 (crédit-bail)
    expect(PCM.INTERETS_PRODUITS_ASSIMILES).toBe("7381"); // pas 7611
    expect(PCM.REMUNERATIONS_DUES_PERSONNEL).toBe("4432"); // net à payer, pas 4441
  });
});

describe("controlerComptesPcm / assertComptesPcm", () => {
  it("lit les deux conventions de nommage", () => {
    expect(controlerComptesPcm([{ compte_numero: "5141" }, { compte: "44580000" }]).ok).toBe(true);
    expect(controlerComptesPcm([{ compte_numero: "7611" }]).ok).toBe(false);
    expect(controlerComptesPcm([{ compte: "ABC" }]).ok).toBe(false);
  });

  it("dédoublonne les griefs et remonte les avertissements", () => {
    const c = controlerComptesPcm([{ compte_numero: "6226" }, { compte_numero: "6226" }, { compte_numero: "4191" }]);
    expect(c.violations).toHaveLength(1);
    expect(c.avertissements.length).toBeGreaterThan(0);
  });

  it("assert jette avec le contexte", () => {
    expect(() => assertComptesPcm([{ compte_numero: "4011" }], "Import")).toThrow(/Import/);
    expect(() => assertComptesPcm([{ compte_numero: "4011000" }])).toThrow(/hors référentiel/);
    expect(() => assertComptesPcm([{ compte_numero: "4411" }])).not.toThrow();
  });
});
