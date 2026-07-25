import { describe, it, expect } from "vitest";
import { puHtToTtc, puTtcToHt, reconcilierLignesHtTtc } from "./tva";

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

describe("reconcilierLignesHtTtc — HT ou TTC déduit du bloc totaux", () => {
  it("PU affiché = TTC (somme colle au TTC) → converti en HT", () => {
    // 1 × 120 = 120 = Total TTC ; Total HT = 100 → le PU 120 était TTC.
    const r = reconcilierLignesHtTtc(
      [{ quantite: 1, prix_unitaire: 120, taux_tva: 20 }],
      100,
      120,
    );
    expect(r.converti).toBe(true);
    expect(r.lignes[0].prix_unitaire).toBeCloseTo(100, 2);
  });

  it("PU affiché = HT (somme colle au HT) → inchangé", () => {
    const r = reconcilierLignesHtTtc(
      [{ quantite: 1, prix_unitaire: 100, taux_tva: 20 }],
      100,
      120,
    );
    expect(r.converti).toBe(false);
    expect(r.lignes[0].prix_unitaire).toBe(100);
  });

  it("plusieurs lignes, PU en TTC → toutes converties", () => {
    // (2×60) + (1×240) = 360 = TTC ; HT = 300.
    const r = reconcilierLignesHtTtc(
      [
        { quantite: 2, prix_unitaire: 60, taux_tva: 20 },
        { quantite: 1, prix_unitaire: 240, taux_tva: 20 },
      ],
      300,
      360,
    );
    expect(r.converti).toBe(true);
    expect(r.lignes[0].prix_unitaire).toBeCloseTo(50, 2);
    expect(r.lignes[1].prix_unitaire).toBeCloseTo(200, 2);
  });

  it("ne convertit pas si un total manque", () => {
    const r = reconcilierLignesHtTtc([{ quantite: 1, prix_unitaire: 120, taux_tva: 20 }], 0, 120);
    expect(r.converti).toBe(false);
  });

  it("ne convertit pas si HT == TTC (pas de TVA)", () => {
    const r = reconcilierLignesHtTtc([{ quantite: 1, prix_unitaire: 100, taux_tva: 0 }], 100, 100);
    expect(r.converti).toBe(false);
  });

  it("ne convertit pas si la somme ne colle ni au HT ni au TTC", () => {
    const r = reconcilierLignesHtTtc([{ quantite: 1, prix_unitaire: 999, taux_tva: 20 }], 100, 120);
    expect(r.converti).toBe(false);
    expect(r.lignes[0].prix_unitaire).toBe(999);
  });

  it("taux différents par ligne : chaque PU est converti avec SON taux", () => {
    // (1×120 à 20%) + (1×110 à 10%) = 230 = TTC ; HT = 200.
    const r = reconcilierLignesHtTtc(
      [
        { quantite: 1, prix_unitaire: 120, taux_tva: 20 },
        { quantite: 1, prix_unitaire: 110, taux_tva: 10 },
      ],
      200,
      230,
    );
    expect(r.converti).toBe(true);
    expect(r.lignes[0].prix_unitaire).toBeCloseTo(100, 2);
    expect(r.lignes[1].prix_unitaire).toBeCloseTo(100, 2);
  });
});
