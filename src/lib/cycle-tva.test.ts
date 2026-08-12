import { describe, expect, it } from "vitest";
import {
  actionsCycleTva, badgeCycleTva, estCreditTva, etapeCycleTva, soldeHistoriqueTva,
} from "./cycle-tva";

const dette = { neant: false, dette: true };
const credit = { neant: false, dette: false };

describe("etapeCycleTva", () => {
  it("classe en néant tant qu'il n'y a ni collectée ni déductible", () => {
    expect(etapeCycleTva({ liquidation: { neant: true } })).toBe("neant");
    expect(etapeCycleTva(null)).toBe("neant");
    expect(etapeCycleTva({ liquidation: null })).toBe("neant");
  });

  it("réclame la liquidation avant tout le reste", () => {
    expect(etapeCycleTva({ liquidation: dette, declaree: false, resteAPayer: 0 })).toBe("a_declarer");
  });

  it("passe à « à payer » dès que le 4456 porte une dette", () => {
    expect(etapeCycleTva({ liquidation: dette, declaree: true, resteAPayer: 7500 })).toBe("a_payer");
  });

  it("saute le paiement sur un crédit de TVA : il n'y a rien à prélever", () => {
    expect(etapeCycleTva({ liquidation: credit, declaree: true, resteAPayer: 0 })).toBe("a_justifier");
  });

  it("clôt un crédit de TVA sur le récépissé, sans attendre de pointage", () => {
    const c = { liquidation: credit, declaree: true, resteAPayer: 0 };
    expect(etapeCycleTva(c)).toBe("a_justifier");
    expect(etapeCycleTva({ ...c, quittance: true })).toBe("liquidee");
  });

  // Le 4456 est CUMULATIF : un arriéré de janvier laisse un solde créditeur en
  // février. Le lire comme l'échéance de février réclamerait un prélèvement que
  // la période n'a pas engendré.
  it("ne réclame pas de paiement sur un crédit dont le 4456 traîne une dette passée", () => {
    expect(etapeCycleTva({ liquidation: credit, declaree: true, resteAPayer: 4200 })).toBe("a_justifier");
    expect(etapeCycleTva({ liquidation: credit, declaree: true, resteAPayer: 4200, quittance: true }))
      .toBe("liquidee");
  });

  it("ne tient pas un reliquat d'arrondi pour une dette", () => {
    expect(etapeCycleTva({ liquidation: dette, declaree: true, resteAPayer: 0.004 })).toBe("a_pointer");
    expect(etapeCycleTva({ liquidation: dette, declaree: true, resteAPayer: 0.01 })).toBe("a_payer");
  });

  it("n'atteint « liquidée » qu'une fois le règlement pointé", () => {
    const paye = { liquidation: dette, declaree: true, resteAPayer: 0 };
    expect(etapeCycleTva(paye)).toBe("a_pointer");
    expect(etapeCycleTva({ ...paye, pointe: true })).toBe("liquidee");
  });
});

describe("badgeCycleTva", () => {
  it("nomme chaque état du cycle", () => {
    expect(badgeCycleTva({ liquidation: dette, declaree: false }).label).toBe("À déclarer");
    expect(badgeCycleTva({ liquidation: dette, declaree: true, resteAPayer: 100 }).label).toBe("Déclarée");
    expect(badgeCycleTva({ liquidation: dette, declaree: true, resteAPayer: 0 }).label).toBe("Payée — à pointer");
    expect(badgeCycleTva({ liquidation: credit, declaree: true, resteAPayer: 0 }).label).toBe("Crédit de TVA");
    expect(badgeCycleTva({ liquidation: { neant: true } }).label).toBe("Néant");
  });

  it("réserve « Liquidée & Payée » au règlement pointé", () => {
    const b = badgeCycleTva({ liquidation: dette, declaree: true, resteAPayer: 0, pointe: true });
    expect(b.label).toBe("Liquidée & Payée");
    expect(b.variant).toBe("default");
    expect(b.classe).toContain("emerald");
  });

  it("ne dit pas « Payée » d'un crédit validé : rien n'a été prélevé", () => {
    const b = badgeCycleTva({ liquidation: credit, declaree: true, resteAPayer: 0, quittance: true });
    expect(b.label).toBe("Liquidée — crédit reporté");
    expect(b.variant).toBe("default");
    expect(b.classe).toContain("emerald");
  });
});

describe("estCreditTva / soldeHistoriqueTva", () => {
  it("lit le crédit sur la liquidation de la période, pas sur le solde du 4456", () => {
    expect(estCreditTva({ liquidation: credit, declaree: true, resteAPayer: 4200 })).toBe(true);
    expect(estCreditTva({ liquidation: dette, declaree: true, resteAPayer: -4200 })).toBe(false);
    expect(estCreditTva({ liquidation: { neant: true } })).toBe(false);
    expect(estCreditTva(null)).toBe(false);
  });

  it("isole l'arriéré des périodes antérieures sur une période en crédit", () => {
    expect(soldeHistoriqueTva({ liquidation: credit, declaree: true, resteAPayer: 4200 })).toBe(4200);
    expect(soldeHistoriqueTva({ liquidation: credit, declaree: true, resteAPayer: 0 })).toBe(0);
    // 4456 débiteur : c'est le crédit lui-même, pas une dette héritée.
    expect(soldeHistoriqueTva({ liquidation: credit, declaree: true, resteAPayer: -3000 })).toBe(0);
    // Sur une période en dette, le reste dû se lit tel quel — rien à isoler.
    expect(soldeHistoriqueTva({ liquidation: dette, declaree: true, resteAPayer: 7500 })).toBe(0);
  });
});

describe("actionsCycleTva", () => {
  it("n'ouvre la liquidation que sur une période non déclarée", () => {
    expect(actionsCycleTva({ liquidation: dette, declaree: false }).declarer).toBe(true);
    expect(actionsCycleTva({ liquidation: dette, declaree: true, resteAPayer: 10 }).declarer).toBe(false);
  });

  it("n'ouvre la quittance qu'après la liquidation", () => {
    expect(actionsCycleTva({ liquidation: dette, declaree: false }).quittance).toBe(false);
    expect(actionsCycleTva({ liquidation: dette, declaree: true, resteAPayer: 10 }).quittance).toBe(true);
  });

  it("refuse le pointage tant que le 4456 n'est pas soldé, et dit pourquoi", () => {
    const a = actionsCycleTva({ liquidation: dette, declaree: true, resteAPayer: 7500 });
    expect(a.pointer).toBe(false);
    expect(a.raisonPointageIndisponible).toMatch(/n'est pas soldé/);
  });

  it("refuse le pointage sur un crédit de TVA : rien n'a été prélevé", () => {
    const a = actionsCycleTva({ liquidation: credit, declaree: true, resteAPayer: -3000, tracable: true });
    expect(a.pointer).toBe(false);
    expect(a.raisonPointageIndisponible).toMatch(/crédit de TVA reportable/);
    expect(a.raisonPointageIndisponible).toMatch(/récépissé/);
  });

  it("n'ouvre pas le prélèvement sur un crédit, même si le 4456 traîne un arriéré", () => {
    const a = actionsCycleTva({ liquidation: credit, declaree: true, resteAPayer: 4200, tracable: true });
    expect(a.payer).toBe(false);
    // La raison parle du crédit, pas d'un prélèvement à enregistrer.
    expect(a.raisonPointageIndisponible).toMatch(/crédit de TVA reportable/);
    expect(a.raisonPointageIndisponible).not.toMatch(/enregistrez le prélèvement/i);
  });

  it("dit qu'un crédit justifié est validé, sans jamais proposer de le pointer", () => {
    const a = actionsCycleTva({
      liquidation: credit, declaree: true, resteAPayer: 0, tracable: true, quittance: true,
    });
    expect(a.pointer).toBe(false);
    expect(a.raisonPointageIndisponible).toMatch(/validée/);
  });

  it("refuse le pointage quand la migration de traçabilité manque", () => {
    const a = actionsCycleTva({ liquidation: dette, declaree: true, resteAPayer: 0, tracable: false });
    expect(a.pointer).toBe(false);
    expect(a.raisonPointageIndisponible).toMatch(/20260809130000/);
  });

  it("autorise le pointage sur une période déclarée et soldée", () => {
    const a = actionsCycleTva({ liquidation: dette, declaree: true, resteAPayer: 0, tracable: true });
    expect(a.pointer).toBe(true);
    expect(a.raisonPointageIndisponible).toBeNull();
  });
});
