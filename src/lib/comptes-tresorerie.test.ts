import { describe, it, expect } from "vitest";
import {
  COMPTE_BANQUE_DEFAUT, COMPTE_CAISSE_DEFAUT,
  compteBanque, compteCaisse, imputationTresorerie, journalDeTresorerie,
} from "./comptes-tresorerie";

describe("compteCaisse — rubrique 516 du PCM", () => {
  it("rend 51610000 sans paramétrage du dossier", () => {
    expect(compteCaisse()).toBe("51610000");
    expect(compteCaisse(null)).toBe(COMPTE_CAISSE_DEFAUT);
    expect(compteCaisse({ compte_caisse: null })).toBe("51610000");
    expect(compteCaisse({ compte_caisse: "   " })).toBe("51610000");
  });

  it("retient le sous-compte de caisse du dossier", () => {
    expect(compteCaisse({ compte_caisse: "51610001" })).toBe("51610001");
    expect(compteCaisse({ compte_caisse: "5161" })).toBe("5161");
    expect(compteCaisse({ compte_caisse: " 51650000 " })).toBe("51650000"); // régie d'avances
  });

  // Le cœur de la correction : 5143 est la Trésorerie Générale, pas la caisse.
  it("REFUSE un compte hors rubrique 516 et retombe sur la caisse", () => {
    expect(compteCaisse({ compte_caisse: "5143" })).toBe("51610000");
    expect(compteCaisse({ compte_caisse: "5141" })).toBe("51610000");
    expect(compteCaisse({ compte_caisse: "6141" })).toBe("51610000");
  });

  it("REFUSE une saisie non numérique", () => {
    expect(compteCaisse({ compte_caisse: "CAISSE" })).toBe("51610000");
    expect(compteCaisse({ compte_caisse: "516-1" })).toBe("51610000");
  });
});

describe("compteBanque — rubrique 514 du PCM", () => {
  it("rend 5141 par défaut", () => {
    expect(compteBanque()).toBe(COMPTE_BANQUE_DEFAUT);
    expect(compteBanque({ compte_banque: "" })).toBe("5141");
  });

  it("retient un sous-compte bancaire du dossier", () => {
    expect(compteBanque({ compte_banque: "51410002" })).toBe("51410002");
  });

  it("refuse un compte de caisse dans le champ banque", () => {
    expect(compteBanque({ compte_banque: "51610000" })).toBe("5141");
  });
});

describe("imputationTresorerie — compte et journal indissociables", () => {
  it("espèces → caisse 51610000 au journal CAI", () => {
    expect(imputationTresorerie("especes")).toEqual({
      compte: "51610000", journal: "CAI", especes: true,
    });
  });

  it("tolère les graphies du mode espèces", () => {
    for (const m of ["espèces", "Espèces", "CASH", " caisse "]) {
      expect(imputationTresorerie(m).journal).toBe("CAI");
    }
  });

  it("tout autre mode → banque 5141 au journal BQ", () => {
    for (const m of ["virement", "cheque", "carte", "prelevement", "", null, undefined]) {
      expect(imputationTresorerie(m as any)).toEqual({
        compte: "5141", journal: "BQ", especes: false,
      });
    }
  });

  it("honore les sous-comptes du dossier", () => {
    const dossier = { compte_caisse: "51610003", compte_banque: "51410007" };
    expect(imputationTresorerie("especes", dossier).compte).toBe("51610003");
    expect(imputationTresorerie("virement", dossier).compte).toBe("51410007");
  });

  it("un mode espèces ne débite JAMAIS un compte 514", () => {
    const r = imputationTresorerie("especes", { compte_caisse: "5143" });
    expect(r.compte.startsWith("516")).toBe(true);
    expect(r.journal).toBe("CAI");
  });
});

describe("journalDeTresorerie — la réciproque, à partir du COMPTE", () => {
  it("envoie la caisse en CAI et tout le reste en BQ", () => {
    expect(journalDeTresorerie("5161")).toBe("CAI");
    expect(journalDeTresorerie("51610000")).toBe("CAI");
    expect(journalDeTresorerie("5141")).toBe("BQ");
    expect(journalDeTresorerie("51420000")).toBe("BQ");
    // 5143 est la Trésorerie Générale, pas une caisse : elle reste en banque.
    expect(journalDeTresorerie("5143")).toBe("BQ");
  });

  it("retombe sur BQ sur une entrée vide", () => {
    expect(journalDeTresorerie(null)).toBe("BQ");
    expect(journalDeTresorerie("")).toBe("BQ");
  });

  it("s'accorde avec imputationTresorerie, qui part du MODE", () => {
    for (const mode of ["especes", "virement", "cheque", null]) {
      const i = imputationTresorerie(mode);
      expect(journalDeTresorerie(i.compte)).toBe(i.journal);
    }
  });
});
