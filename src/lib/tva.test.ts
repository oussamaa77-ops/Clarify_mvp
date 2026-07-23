import { describe, it, expect } from "vitest";
import { puHtToTtc, puTtcToHt } from "./tva";

describe("puHtToTtc — HT → TTC", () => {
  it("applique 20 %", () => {
    expect(puHtToTtc(1000, 20)).toBe(1200);
  });

  it("applique 7 %", () => {
    expect(puHtToTtc(1000, 7)).toBe(1070);
  });

  it("taux 0 % → TTC = HT", () => {
    expect(puHtToTtc(1000, 0)).toBe(1000);
  });

  it("taux null → traité comme 0 % (TTC = HT)", () => {
    expect(puHtToTtc(1000, null)).toBe(1000);
  });

  it("arrondit au centime", () => {
    // 33,33 × 1,2 = 39,996 → 40,00
    expect(puHtToTtc(33.33, 20)).toBe(40);
  });
});

describe("puTtcToHt — TTC → HT (formule de la règle métier)", () => {
  it("retire 20 %", () => {
    expect(puTtcToHt(1200, 20)).toBeCloseTo(1000, 2);
  });

  it("retire 7 %", () => {
    expect(puTtcToHt(1070, 7)).toBeCloseTo(1000, 2);
  });

  it("retire 14 %", () => {
    expect(puTtcToHt(1140, 14)).toBeCloseTo(1000, 2);
  });

  it("taux 0 % → HT = TTC", () => {
    expect(puTtcToHt(1000, 0)).toBe(1000);
  });

  it("taux null → traité comme 0 % (HT = TTC)", () => {
    expect(puTtcToHt(1000, null)).toBe(1000);
  });
});

describe("réciprocité HT ⇄ TTC", () => {
  it.each([0, 7, 10, 14, 20])("HT→TTC→HT reste stable au centime (taux %i%%)", (taux) => {
    const ttc = puHtToTtc(1000, taux);
    expect(puTtcToHt(ttc, taux)).toBeCloseTo(1000, 2);
  });
});
