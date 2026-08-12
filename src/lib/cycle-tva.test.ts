import { describe, expect, it } from "vitest";
import { actionsCycleTva, badgeCycleTva, etapeCycleTva } from "./cycle-tva";

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
    expect(etapeCycleTva({ liquidation: credit, declaree: true, resteAPayer: 0 })).toBe("a_pointer");
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
