import { describe, it, expect } from "vitest";
import { agregerUsage, estimerCoutIA, type UsageRowAgg } from "./analytics.functions";

const row = (o: Partial<UsageRowAgg>): UsageRowAgg => ({
  method: "llm", skip_llm: false, cout_estime: 0.004, created_at: "2026-07-06T10:00:00Z",
  module: null, phase: null, ...o,
});

describe("estimerCoutIA", () => {
  it("connaît facture / banque / releve_ocr, défaut = banque", () => {
    expect(estimerCoutIA("facture")).toBe(0.005);
    expect(estimerCoutIA("banque")).toBe(0.004);
    expect(estimerCoutIA("releve_ocr")).toBe(0.004);
    expect(estimerCoutIA("inconnu")).toBe(0.004);
  });
});

describe("agregerUsage — global & par jour", () => {
  it("compte appels IA réels vs évités et somme les coûts", () => {
    const rows: UsageRowAgg[] = [
      row({ skip_llm: true, method: "memoire", cout_estime: 0.004 }),   // évité
      row({ skip_llm: true, method: "regex", cout_estime: 0.004 }),     // évité
      row({ skip_llm: false, method: "llm", cout_estime: 0.004 }),      // dépensé
      row({ skip_llm: false, method: "regex", cout_estime: 0.004 }),    // ni l'un ni l'autre (regex sans skip)
    ];
    const { global } = agregerUsage(rows);
    expect(global.total).toBe(4);
    expect(global.ia_evites).toBe(2);
    expect(global.appels_ia).toBe(1);
    expect(global.pct_skip).toBe(50);
    expect(global.cout_economise).toBeCloseTo(0.008);
    expect(global.cout_depense).toBeCloseTo(0.004);
  });
});

describe("agregerUsage — ventilation par module", () => {
  it("regroupe par module et trie par volume décroissant", () => {
    const rows: UsageRowAgg[] = [
      row({ module: "releve", phase: "ocr", skip_llm: true, method: "regex" }),
      row({ module: "releve", phase: "analyse", skip_llm: false, method: "llm" }),
      row({ module: "releve", phase: "analyse", skip_llm: true, method: "memoire" }),
      row({ module: "facture_fournisseur", phase: "ocr", skip_llm: false, method: "llm" }),
      row({ module: "facture_client", phase: "ocr", skip_llm: false, method: "llm" }),
    ];
    const { par_module, par_phase } = agregerUsage(rows);

    const releve = par_module.find((m) => m.cle === "releve")!;
    expect(releve.total).toBe(3);
    expect(releve.ia_evites).toBe(2);
    expect(releve.appels_ia).toBe(1);
    // trié par total desc → 'releve' (3) en premier
    expect(par_module[0].cle).toBe("releve");

    const client = par_module.find((m) => m.cle === "facture_client")!;
    expect(client.total).toBe(1);
    expect(client.appels_ia).toBe(1);

    // par phase : ocr (3) vs analyse (2)
    const ocr = par_phase.find((p) => p.cle === "ocr")!;
    expect(ocr.total).toBe(3);
    const analyse = par_phase.find((p) => p.cle === "analyse")!;
    expect(analyse.total).toBe(2);
  });

  it("les lignes sans module/phase tombent dans 'inconnu'", () => {
    const { par_module, par_phase } = agregerUsage([row({}), row({ module: undefined, phase: undefined })]);
    expect(par_module[0].cle).toBe("inconnu");
    expect(par_module[0].total).toBe(2);
    expect(par_phase[0].cle).toBe("inconnu");
  });
});
