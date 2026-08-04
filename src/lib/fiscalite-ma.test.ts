import { describe, it, expect } from "vitest";
import {
  situerExercice, calculerCotisationMinimale, calculerAcomptesIS, calculerIS,
  calculerTP, statutTva, trancheIS, lireParametresFiscaux,
  TAUX_CM_DROIT_COMMUN, CM_MINIMUM_MAD, ANNEES_EXONERATION_TP, formatDateFr,
} from "./fiscalite-ma";

describe("situerExercice", () => {
  it("reconnaît le premier exercice à l'année de début d'activité", () => {
    const s = situerExercice("2026-03-15", 2026);
    expect(s.premierExercice).toBe(true);
    expect(s.anneeDebut).toBe(2026);
  });

  it("ne présume rien sans date de début d'activité", () => {
    const s = situerExercice(null, 2026);
    expect(s.inconnue).toBe(true);
    expect(s.premierExercice).toBe(false);
    expect(s.finExonerationCM).toBeNull();
  });

  it("place la fin d'exonération CM à 36 mois du début", () => {
    expect(situerExercice("2024-06-15", 2026).finExonerationCM).toBe("2027-06-15");
    // Débordement de fin de mois : le jour est borné au dernier du mois cible.
    expect(situerExercice("2024-08-31", 2026).finExonerationCM).toBe("2027-08-31");
  });

  it("compte les mois écoulés jusqu'à la clôture", () => {
    expect(situerExercice("2025-01-01", 2025).moisALaCloture).toBe(11);
    expect(situerExercice("2025-01-01", 2026).moisALaCloture).toBe(23);
  });
});

describe("cotisation minimale", () => {
  it("exonère pendant les 36 premiers mois d'activité", () => {
    const cm = calculerCotisationMinimale({ base: 5_000_000, exercice: 2026, dateDebutActivite: "2025-01-10" });
    expect(cm.applicable).toBe(false);
    expect(cm.montant).toBe(0);
    expect(cm.motif).toContain("36 premiers mois");
    expect(cm.motif).toContain("art. 144 CGI");
  });

  it("redevient due dès que l'exercice déborde la fenêtre des 36 mois", () => {
    // 36 mois expirent le 10/01/2028 → l'exercice 2028 n'est plus couvert.
    expect(calculerCotisationMinimale({ base: 4_000_000, exercice: 2027, dateDebutActivite: "2025-01-10" }).applicable).toBe(false);
    const cm2028 = calculerCotisationMinimale({ base: 4_000_000, exercice: 2028, dateDebutActivite: "2025-01-10" });
    expect(cm2028.applicable).toBe(true);
    expect(cm2028.montant).toBe(10_000); // 0,25 %
  });

  it("applique 0,25 % (et non 0,5 %) au-delà de 36 mois", () => {
    expect(TAUX_CM_DROIT_COMMUN).toBe(0.0025);
    const cm = calculerCotisationMinimale({ base: 4_000_000, exercice: 2026, dateDebutActivite: "2015-01-01" });
    expect(cm.taux).toBe(0.0025);
    expect(cm.montant).toBe(10_000);
  });

  it("respecte le plancher légal de 3 000 MAD", () => {
    const cm = calculerCotisationMinimale({ base: 100_000, exercice: 2026, dateDebutActivite: "2015-01-01" });
    expect(cm.montant).toBe(CM_MINIMUM_MAD);
    expect(cm.plancherApplique).toBe(true);
  });

  it("applique le droit commun quand la date de début est inconnue", () => {
    const cm = calculerCotisationMinimale({ base: 4_000_000, exercice: 2026 });
    expect(cm.applicable).toBe(true);
    expect(cm.montant).toBe(10_000);
  });

  it("accepte un taux dérogatoire", () => {
    const cm = calculerCotisationMinimale({ base: 10_000_000, exercice: 2026, dateDebutActivite: "2010-01-01", taux: 0.0015 });
    expect(cm.montant).toBe(15_000);
  });
});

describe("acomptes provisionnels IS", () => {
  it("dispense d'acomptes le premier exercice (art. 170 CGI)", () => {
    const a = calculerAcomptesIS({ exercice: 2026, isDuExercicePrecedent: 80_000, dateDebutActivite: "2026-02-01" });
    expect(a.dus).toBe(false);
    expect(a.total).toBe(0);
    expect(a.motif).toBe("Exonéré d'acomptes IS pour le 1er exercice - Art. 170 CGI");
    expect(a.echeances.every((e) => e.montant === 0)).toBe(true);
  });

  it("assoit les acomptes de N sur l'IS dû de N-1", () => {
    const a = calculerAcomptesIS({ exercice: 2026, isDuExercicePrecedent: 80_000, dateDebutActivite: "2020-01-01" });
    expect(a.dus).toBe(true);
    expect(a.base).toBe(80_000);
    expect(a.montantUnitaire).toBe(20_000);
    expect(a.total).toBe(80_000);
  });

  it("place les échéances à la fin des 3e, 6e, 9e et 12e mois", () => {
    const a = calculerAcomptesIS({ exercice: 2026, isDuExercicePrecedent: 40_000, dateDebutActivite: "2020-01-01" });
    expect(a.echeances.map((e) => e.date)).toEqual(["2026-03-31", "2026-06-30", "2026-09-30", "2026-12-31"]);
  });

  it("réclame les acomptes dès le 2e exercice, sur l'IS du 1er", () => {
    const a = calculerAcomptesIS({ exercice: 2027, isDuExercicePrecedent: 12_000, dateDebutActivite: "2026-05-01" });
    expect(a.dus).toBe(true);
    expect(a.montantUnitaire).toBe(3_000);
  });
});

describe("trancheIS — barème LF 2026", () => {
  it("impose à 20 % tout bénéfice inférieur à 100 MDH (PME et droit commun)", () => {
    expect(trancheIS(250_000).taux).toBe(0.20);
    expect(trancheIS(2_000_000).taux).toBe(0.20);
    expect(trancheIS(99_999_999).taux).toBe(0.20);
    expect(trancheIS(-50_000).taux).toBe(0.20); // déficit → première tranche
  });

  it("bascule à 35 % à partir de 100 MDH exactement", () => {
    expect(trancheIS(100_000_000).taux).toBe(0.35);
    expect(trancheIS(250_000_000).taux).toBe(0.35);
  });

  it("plafonne à 20 % les sociétés à statut spécifique, même au-delà de 100 MDH", () => {
    expect(trancheIS(250_000_000, "taux_specifique").taux).toBe(0.20);
    expect(trancheIS(500_000, "taux_specifique").taux).toBe(0.20);
  });
});

describe("calculerIS", () => {
  it("retient le maximum entre IS théorique et cotisation minimale", () => {
    // Résultat faible mais gros CA : la CM l'emporte.
    const r = calculerIS({
      exercice: 2026, resultatFiscal: 10_000, baseCotisationMinimale: 20_000_000,
      dateDebutActivite: "2010-01-01", isDuExercicePrecedent: 0,
    });
    expect(r.isTheorique).toBe(2_000);
    expect(r.cotisationMinimale.montant).toBe(50_000);
    expect(r.isDu).toBe(50_000);
  });

  it("déduit les acomptes versés et expose le reliquat", () => {
    const r = calculerIS({
      exercice: 2026, resultatFiscal: 1_000_000, baseCotisationMinimale: 5_000_000,
      dateDebutActivite: "2015-01-01", isDuExercicePrecedent: 100_000,
    });
    expect(r.isDu).toBe(200_000);        // 1 000 000 × 20 %
    expect(r.acomptes.total).toBe(100_000);
    expect(r.isAPayer).toBe(100_000);
    expect(r.excedent).toBe(0);
  });

  it("applique 35 % au-delà de 100 MDH de bénéfice", () => {
    const r = calculerIS({
      exercice: 2026, resultatFiscal: 120_000_000, baseCotisationMinimale: 400_000_000,
      dateDebutActivite: "2010-01-01",
    });
    expect(r.tranche.taux).toBe(0.35);
    expect(r.isTheorique).toBe(42_000_000);
    expect(r.isDu).toBe(42_000_000);     // CM à 1 000 000, largement dépassée
  });

  it("maintient 20 % au-delà de 100 MDH sous statut spécifique", () => {
    const r = calculerIS({
      exercice: 2026, resultatFiscal: 120_000_000, baseCotisationMinimale: 400_000_000,
      dateDebutActivite: "2010-01-01", regime: "taux_specifique",
    });
    expect(r.regime).toBe("taux_specifique");
    expect(r.isTheorique).toBe(24_000_000);
  });

  it("bascule en excédent quand les acomptes dépassent l'impôt dû", () => {
    const r = calculerIS({
      exercice: 2026, resultatFiscal: 100_000, baseCotisationMinimale: 500_000,
      dateDebutActivite: "2015-01-01", isDuExercicePrecedent: 60_000,
    });
    expect(r.isDu).toBe(20_000);
    expect(r.isAPayer).toBe(0);
    expect(r.excedent).toBe(40_000);
    expect(r.solde).toBe(-40_000);
  });

  it("n'impute aucun acompte sur le premier exercice, CM comprise", () => {
    const r = calculerIS({
      exercice: 2026, resultatFiscal: 500_000, baseCotisationMinimale: 8_000_000,
      dateDebutActivite: "2026-01-05", isDuExercicePrecedent: 999_999,
    });
    expect(r.situation.premierExercice).toBe(true);
    expect(r.acomptes.dus).toBe(false);
    expect(r.acomptes.total).toBe(0);
    expect(r.cotisationMinimale.applicable).toBe(false);
    expect(r.isDu).toBe(100_000);        // 500 000 × 20 %, CM exonérée
    expect(r.isAPayer).toBe(100_000);
  });

  it("ne taxe pas un résultat déficitaire au-delà de la CM", () => {
    const r = calculerIS({
      exercice: 2026, resultatFiscal: -400_000, baseCotisationMinimale: 2_000_000,
      dateDebutActivite: "2010-01-01",
    });
    expect(r.isTheorique).toBe(0);
    expect(r.isDu).toBe(5_000);          // CM seule
  });
});

describe("calculerTP", () => {
  it("exonère les 5 premières années d'activité", () => {
    for (let i = 0; i < ANNEES_EXONERATION_TP; i++) {
      const r = calculerTP({ exercice: 2026 + i, valeurLocative: 120_000, dateDebutActivite: "2026-04-01" });
      expect(r.exonere).toBe(true);
      expect(r.montant).toBe(0);
      expect(r.motif).toBe("Exonéré (5 premières années d'activité - Art. 6 CGI)");
    }
  });

  it("taxe à partir de la 6e année, sur la valeur locative", () => {
    const r = calculerTP({ exercice: 2031, valeurLocative: 120_000, classe: 3, dateDebutActivite: "2026-04-01" });
    expect(r.exonere).toBe(false);
    expect(r.base).toBe(120_000);
    expect(r.taux).toBe(0.10);
    expect(r.montant).toBe(12_000);
    expect(r.premiereAnneeImposable).toBe(2031);
  });

  it("applique le taux de la classe choisie", () => {
    const base = { exercice: 2031, valeurLocative: 100_000, dateDebutActivite: "2020-01-01" };
    expect(calculerTP({ ...base, classe: 1 }).montant).toBe(30_000);
    expect(calculerTP({ ...base, classe: 2 }).montant).toBe(20_000);
    expect(calculerTP({ ...base, classe: 3 }).montant).toBe(10_000);
    // Classe absente ou farfelue → classe 3 par défaut.
    expect(calculerTP({ ...base, classe: 9 }).taux).toBe(0.10);
  });

  it("signale l'absence de valeur locative sans inventer de base", () => {
    const r = calculerTP({ exercice: 2031, valeurLocative: null, dateDebutActivite: "2020-01-01" });
    expect(r.baseManquante).toBe(true);
    expect(r.base).toBe(0);
    expect(r.montant).toBe(0);
  });

  it("ignore totalement le chiffre d'affaires (base = valeur locative seule)", () => {
    const r = calculerTP({ exercice: 2031, valeurLocative: 60_000, classe: 2, dateDebutActivite: "2010-01-01" });
    expect(r.base).toBe(60_000);
    expect(r.montant).toBe(12_000);
  });
});

describe("statutTva", () => {
  it("affiche « Néant » sur un net nul, jamais « Crédit »", () => {
    expect(statutTva(0).cle).toBe("neant");
    expect(statutTva(0).label).toBe("Néant");
    expect(statutTva(-0.004).label).toBe("Néant"); // 0,00 MAD à l'affichage
    expect(statutTva(0.004).label).toBe("Néant");
  });

  it("distingue à payer et crédit", () => {
    expect(statutTva(1_250.5)).toMatchObject({ cle: "a_payer", label: "À payer", montant: 1_250.5 });
    expect(statutTva(-800)).toMatchObject({ cle: "credit", label: "Crédit", montant: 800 });
  });
});

describe("lireParametresFiscaux", () => {
  it("tolère une ligne dossier sans les colonnes fiscales", () => {
    expect(lireParametresFiscaux({ id: "x", nom_societe: "ACME" })).toEqual({
      dateDebutActivite: null, valeurLocative: null, classeTP: null, tauxCM: null, regimeIS: "droit_commun",
    });
    expect(lireParametresFiscaux(null).dateDebutActivite).toBeNull();
  });

  it("normalise la date et les nombres", () => {
    const p = lireParametresFiscaux({
      date_debut_activite: "2026-04-01T00:00:00Z", valeur_locative_tp: "120000", classe_tp: 2, taux_cm: 0.0015,
      regime_is: "taux_specifique",
    });
    expect(p).toEqual({
      dateDebutActivite: "2026-04-01", valeurLocative: 120_000, classeTP: 2, tauxCM: 0.0015,
      regimeIS: "taux_specifique",
    });
  });

  it("retombe sur le droit commun devant un régime inconnu", () => {
    expect(lireParametresFiscaux({ regime_is: "n_importe_quoi" }).regimeIS).toBe("droit_commun");
  });
});

describe("formatDateFr", () => {
  it("formate en JJ/MM/AAAA", () => {
    expect(formatDateFr("2026-03-31")).toBe("31/03/2026");
    expect(formatDateFr(null)).toBe("");
  });
});
