import { describe, expect, it } from "vitest";
import { assertLignesPaie, controlerLignesPaie, lignesEcrituresPaie, type BulletinComptable } from "./ecritures-paie";
import { validatePcmAccount } from "./pcm-referentiel";

// Bulletin cohérent avec calculBulletin : total_retenues = CNSS + AMO + CIMR + IR.
const bulletin = (extra: Partial<BulletinComptable> = {}): BulletinComptable => ({
  dossier_id: "D1",
  periode: "2026-03",
  date_paiement: "2026-03-31",
  net_a_payer: 8176.6,
  total_retenues: 1823.4,
  cnss_salarie: 403.2,
  amo_salarie: 226,
  ir_net: 1194.2,
  cimr_salarie: 0,
  cnss_patronal: 808.2,
  amo_patronal: 411,
  taxe_formation_pro: 160,
  ...extra,
});

describe("écritures de paie", () => {
  it("crédite le NET À PAYER en 4432, jamais en 4441 (CNSS)", () => {
    const l = lignesEcrituresPaie(bulletin(), "Amina B.");
    const net = l.find((x) => x.libelle.startsWith("Net à payer"))!;
    expect(net.compte_numero).toBe("4432");
    expect(validatePcmAccount(net.compte_numero, { usage: "personnel" }).ok).toBe(true);
    expect(l.filter((x) => x.compte_numero === "4441").every((x) => !x.libelle.startsWith("Net"))).toBe(true);
  });

  it("produit une pièce équilibrée, en journal OD, sur des comptes recevables", () => {
    const l = lignesEcrituresPaie(bulletin(), "Amina B.");
    const c = controlerLignesPaie(l);
    expect(c).toMatchObject({ ok: true, ecart: 0 });
    expect(l.every((x) => x.journal_code === "OD" && x.reference_piece === "PAIE-2026-03")).toBe(true);
    expect(() => assertLignesPaie(l)).not.toThrow();
  });

  it("omet les lignes à zéro (salarié non imposable)", () => {
    const b = bulletin({ ir_net: 0, total_retenues: 629.2, net_a_payer: 9370.8 });
    const l = lignesEcrituresPaie(b, "X");
    expect(l.some((x) => x.libelle.startsWith("IR/"))).toBe(false);
    expect(controlerLignesPaie(l).ok).toBe(true);
  });

  it("REFUSE une paie avec CIMR : la retenue n'a pas de contrepartie arbitrée", () => {
    const b = bulletin({ cimr_salarie: 300, total_retenues: 2123.4, net_a_payer: 7876.6 });
    const l = lignesEcrituresPaie(b, "X");
    const c = controlerLignesPaie(l, b);
    expect(c.ok).toBe(false);
    expect(c.ecart).toBe(300);
    expect(c.violations.join(" ")).toMatch(/CIMR salariale 300\.00/);
    expect(() => assertLignesPaie(l, b)).toThrow(/déséquilibrée/);
  });

  it("date la pièce au premier du mois à défaut de date de paiement", () => {
    const l = lignesEcrituresPaie(bulletin({ date_paiement: null }), "X");
    expect(l[0].date_ecriture).toBe("2026-03-01");
  });
});
