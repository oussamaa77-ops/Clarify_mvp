// ============================================================================
// a-nouveaux.test.ts — L'écriture qui rouvre un exercice.
//
// Les cas reproduisent le dossier STE SMERT WATER, dont les soldes au
// 31/12/2025 étaient : 3458 +4 100, 4712 −41 500, 5141 +35 500, 44110006 −24 600,
// et 26 500 de charges (6111 + 61312) sans aucun produit — donc une PERTE.
// ============================================================================

import { describe, it, expect } from "vitest";
import {
  COMPTE_REPORT_CREDITEUR, COMPTE_REPORT_DEBITEUR, JOURNAL_AN,
  assertANouveaux, estCompteDeBilan, estCompteDeGestion,
  lignesANouveaux, sansANouveaux, soldesCloture, type LigneSolde,
} from "@/lib/a-nouveaux";

const l = (p: Partial<LigneSolde>): LigneSolde => ({
  journal_code: "OD", compte_numero: "5141", date_ecriture: "2025-12-16",
  debit: 0, credit: 0, ...p,
});

/** Le grand livre antérieur de SMERT WATER, réduit à ses lignes utiles. */
const anterieures: LigneSolde[] = [
  l({ date_ecriture: "2024-07-31", journal_code: "BQ", compte_numero: "5141", credit: 6000 }),
  l({ date_ecriture: "2024-07-31", journal_code: "BQ", compte_numero: "61312", debit: 6000 }),
  l({ date_ecriture: "2024-07-31", journal_code: "BQ", compte_numero: "4712", credit: 41500 }),
  l({ date_ecriture: "2024-07-31", journal_code: "BQ", compte_numero: "5141", debit: 41500 }),
  l({ date_ecriture: "2025-12-16", journal_code: "ACH", compte_numero: "6111", debit: 20500 }),
  l({ date_ecriture: "2025-12-16", journal_code: "ACH", compte_numero: "34552", debit: 4100 }),
  l({ date_ecriture: "2025-12-16", journal_code: "ACH", compte_numero: "44110006", credit: 24600 }),
  l({ date_ecriture: "2025-12-16", journal_code: "OD", compte_numero: "3458", debit: 4100 }),
  l({ date_ecriture: "2025-12-16", journal_code: "OD", compte_numero: "34552", credit: 4100 }),
];

const OPTS = { dossier_id: "D", date: "2026-01-01" };

describe("classement des comptes", () => {
  it("sépare le bilan de la gestion", () => {
    for (const c of ["1169", "3421", "44110006", "5141"]) expect(estCompteDeBilan(c)).toBe(true);
    for (const c of ["6111", "7111", "61312"]) expect(estCompteDeGestion(c)).toBe(true);
    expect(estCompteDeBilan("6111")).toBe(false);
    expect(estCompteDeGestion("5141")).toBe(false);
  });
});

describe("soldes de clôture", () => {
  it("cumule TOUS les exercices antérieurs, 2024 comme 2025", () => {
    const s = soldesCloture(anterieures, "2026-01-01");
    expect(s.parCompte.get("5141")).toBe(35500);
    expect(s.parCompte.get("44110006")).toBe(-24600);
    expect(s.parCompte.get("4712")).toBe(-41500);
    expect(s.parCompte.get("3458")).toBe(4100);
    // Compte mouvementé au débit ET au crédit du même montant : solde nul.
    expect(s.parCompte.get("34552")).toBe(0);
    expect(s.ecart).toBe(0);
    expect(s.totalBilan).toBe(-26500);
    expect(s.totalGestion).toBe(26500);
  });

  it("ignore ce qui tombe DANS le nouvel exercice", () => {
    const avec = [...anterieures, l({ date_ecriture: "2026-03-10", compte_numero: "5141", debit: 999 })];
    expect(soldesCloture(avec, "2026-01-01").parCompte.get("5141")).toBe(35500);
  });
});

describe("écriture d'à-nouveau", () => {
  it("reporte les comptes de BILAN et jamais ceux de gestion", () => {
    const plan = lignesANouveaux(soldesCloture(anterieures, "2026-01-01"), OPTS);
    const comptes = plan.lignes.map((x) => x.compte_numero);
    expect(comptes).toContain("44110006");
    expect(comptes).toContain("5141");
    expect(comptes).toContain("4712");
    expect(comptes).toContain("3458");
    expect(comptes).not.toContain("6111");
    expect(comptes).not.toContain("61312");
    // Un solde nul n'encombre pas le grand livre.
    expect(comptes).not.toContain("34552");
  });

  it("reporte la dette ACOSOLUTIONS au CRÉDIT du 44110006", () => {
    const plan = lignesANouveaux(soldesCloture(anterieures, "2026-01-01"), OPTS);
    const aco = plan.lignes.find((x) => x.compte_numero === "44110006")!;
    expect(aco.credit).toBe(24600);
    expect(aco.debit).toBe(0);
    expect(aco.journal_code).toBe(JOURNAL_AN);
    expect(aco.date_ecriture).toBe("2026-01-01");
  });

  it("reporte la PERTE antérieure au débit du 1169, et s'équilibre seule", () => {
    const plan = lignesANouveaux(soldesCloture(anterieures, "2026-01-01"), OPTS);
    expect(plan.compteReport).toBe(COMPTE_REPORT_DEBITEUR);
    expect(plan.resultatReporte).toBe(26500);
    const report = plan.lignes.find((x) => x.compte_numero === "1169")!;
    expect(report.debit).toBe(26500);
    expect(plan.ecart).toBe(0);
    expect(plan.violations).toEqual([]);
  });

  it("reporte un BÉNÉFICE au crédit du 1161", () => {
    const benefice: LigneSolde[] = [
      l({ date_ecriture: "2025-06-01", compte_numero: "3421", debit: 12000 }),
      l({ date_ecriture: "2025-06-01", compte_numero: "7111", credit: 12000 }),
    ];
    const plan = lignesANouveaux(soldesCloture(benefice, "2026-01-01"), OPTS);
    expect(plan.compteReport).toBe(COMPTE_REPORT_CREDITEUR);
    expect(plan.lignes.find((x) => x.compte_numero === "1161")!.credit).toBe(12000);
    expect(plan.ecart).toBe(0);
  });

  it("REFUSE de reporter un grand livre antérieur déséquilibré", () => {
    const bancal = [l({ date_ecriture: "2025-01-01", compte_numero: "5141", debit: 100 })];
    const plan = lignesANouveaux(soldesCloture(bancal, "2026-01-01"), OPTS);
    expect(plan.violations.length).toBeGreaterThan(0);
    expect(plan.violations[0]).toMatch(/DÉSÉQUILIBRÉ/);
    expect(() => assertANouveaux(plan)).toThrow();
  });

  it("ne produit rien quand il n'y a rien à reporter", () => {
    const plan = lignesANouveaux(soldesCloture([], "2026-01-01"), OPTS);
    expect(plan.lignes).toEqual([]);
    expect(plan.violations).toEqual([]);
    expect(plan.avertissements).toEqual([]);
    expect(plan.suspens.apure).toBe(true);
  });
});

// ── Contrôle d'audit : compte d'attente reporté ──────────────────────────────
// Le dossier jouet porte déjà un 4712 créditeur de 41 500 — une transaction de
// banque sans pièce, parquée par le rapprochement. L'à-nouveau la REPORTE
// (classe 4, compte de bilan) : sans alerte, le nouvel exercice s'ouvre en
// anomalie et rien ne le dit.
describe("comptes d'attente au passage de l'exercice", () => {
  it("ALERTE sur le 4712 non apuré, en le nommant et en le chiffrant", () => {
    const plan = lignesANouveaux(soldesCloture(anterieures, "2026-01-01"), OPTS);
    expect(plan.suspens.apure).toBe(false);
    expect(plan.suspens.total).toBe(41500);
    expect(plan.suspens.comptes[0]).toMatchObject({
      compte: "4712", solde: 41500, sens: "C", attenteBancaire: true,
    });
    expect(plan.avertissements).toHaveLength(1);
    expect(plan.avertissements[0]).toContain("4712");
  });

  it("l'alerte NE BLOQUE PAS l'écriture : elle avertit, elle n'empêche pas", () => {
    const plan = lignesANouveaux(soldesCloture(anterieures, "2026-01-01"), OPTS);
    expect(plan.violations).toEqual([]);
    expect(() => assertANouveaux(plan)).not.toThrow();
    // …et le solde est bien reporté, alerte ou non.
    expect(plan.lignes.find((x) => x.compte_numero === "4712")!.credit).toBe(41500);
  });

  it("se taît quand l'attente a été apurée avant l'arrêté", () => {
    const apure: LigneSolde[] = [
      ...anterieures,
      l({ date_ecriture: "2025-12-31", journal_code: "OD", compte_numero: "4712", debit: 41500 }),
      l({ date_ecriture: "2025-12-31", journal_code: "OD", compte_numero: "6111", credit: 41500 }),
    ];
    const plan = lignesANouveaux(soldesCloture(apure, "2026-01-01"), OPTS);
    expect(plan.suspens.apure).toBe(true);
    expect(plan.avertissements).toEqual([]);
    // Le compte soldé disparaît aussi du report : une ligne à zéro n'apporte rien.
    expect(plan.lignes.map((x) => x.compte_numero)).not.toContain("4712");
  });
});

describe("double comptage", () => {
  it("le solde 44110006 DOUBLE si l'on cumule origine et report", () => {
    const plan = lignesANouveaux(soldesCloture(anterieures, "2026-01-01"), OPTS);
    const toutes = [...anterieures, ...plan.lignes];
    const solde = (rows: any[]) => rows
      .filter((x) => x.compte_numero === "44110006")
      .reduce((s, x) => s + Number(x.credit || 0) - Number(x.debit || 0), 0);

    expect(solde(toutes)).toBe(49200);          // le piège
    expect(solde(sansANouveaux(toutes))).toBe(24600);   // la parade
  });

  it("borné à 2026, le report est SEUL — et c'est bien lui qu'on veut", () => {
    const plan = lignesANouveaux(soldesCloture(anterieures, "2026-01-01"), OPTS);
    const de2026 = [...anterieures, ...plan.lignes]
      .filter((x) => String(x.date_ecriture).slice(0, 4) === "2026");
    const solde = de2026
      .filter((x) => x.compte_numero === "44110006")
      .reduce((s, x) => s + Number(x.credit || 0) - Number(x.debit || 0), 0);
    expect(solde).toBe(24600);
  });

  it("sansANouveaux ne touche à aucun autre journal", () => {
    const rows = [{ journal_code: "ACH" }, { journal_code: "AN" }, { journal_code: "an" }, { journal_code: null }];
    expect(sansANouveaux(rows)).toHaveLength(2);
  });
});
