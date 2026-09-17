import { describe, it, expect } from "vitest";
import {
  assertEcrituresTresorerie, cleEcritureTresorerie, clePiece, controlerEcrituresTresorerie,
  controlerCaissePositive, creuxCaisse,
  ecartPartieDouble, estJournalTresorerie, grouperEnEcritures, origineEcritureTresorerie,
} from "./integrite-tresorerie";

describe("estJournalTresorerie", () => {
  it("reconnaît BQ et CAI, quelle que soit la casse", () => {
    expect(estJournalTresorerie("BQ")).toBe(true);
    expect(estJournalTresorerie(" cai ")).toBe(true);
  });

  it("laisse hors champ les journaux de vente, d'achat et d'OD", () => {
    for (const j of ["VTE", "ACH", "OD", "VTE-AVR", null, undefined, ""]) {
      expect(estJournalTresorerie(j)).toBe(false);
    }
  });
});

describe("origineEcritureTresorerie", () => {
  const bq = (p: Record<string, unknown> = {}) => ({
    journal_code: "BQ", compte_numero: "5141", date_ecriture: "2026-07-09",
    debit: 9000, credit: 0, ...p,
  });

  it("accepte une écriture issue d'une transaction rattachée à un relevé", () => {
    const v = origineEcritureTresorerie(bq({ transaction_id: "tx1" }), {
      transactionsValidees: ["tx1"],
    });
    expect(v).toMatchObject({ ok: true, origine: "releve" });
  });

  it("REFUSE une transaction qui n'est rattachée à aucun relevé", () => {
    // Le piège des jeux de démonstration : une transaction orpheline couvrait
    // une écriture tout aussi fictive.
    const v = origineEcritureTresorerie(bq({ transaction_id: "txOrpheline" }), {
      transactionsValidees: ["tx1"],
    });
    expect(v.ok).toBe(false);
    expect(v.origine).toBe("aucune");
    expect(v.raison).toMatch(/AUCUN relevé/i);
  });

  it("fait confiance à l'estampille quand l'appelant ne fournit pas d'index", () => {
    expect(origineEcritureTresorerie(bq({ transaction_id: "tx1" }), {}).ok).toBe(true);
  });

  it("accepte une saisie manuelle appariée par date + montant", () => {
    const v = origineEcritureTresorerie(bq(), {
      piecesManuelles: [clePiece("2026-07-09", 9000)],
    });
    expect(v).toMatchObject({ ok: true, origine: "saisie_manuelle" });
  });

  it("REFUSE l'écriture de banque qui ne s'appuie que sur un facture_id", () => {
    // Le cœur de la règle : une facture dit ce qui est dû, pas ce qui est payé.
    const v = origineEcritureTresorerie(bq({ facture_id: "f1", lettrage_code: "AA" }), {
      transactionsValidees: [], piecesManuelles: [],
    });
    expect(v.ok).toBe(false);
    expect(v.raison).toMatch(/pas ce qui est payé/i);
  });

  it("REFUSE une écriture de banque sans aucune estampille", () => {
    const v = origineEcritureTresorerie(bq(), { transactionsValidees: [], piecesManuelles: [] });
    expect(v.ok).toBe(false);
    expect(v.raison).toMatch(/Aucun relevé bancaire ni saisie manuelle/i);
  });

  it("n'a rien à dire d'une vente à crédit : elle ne bouge pas d'argent", () => {
    const v = origineEcritureTresorerie(
      { journal_code: "VTE", compte_numero: "34210002", debit: 9000 },
      { transactionsValidees: [], piecesManuelles: [] },
    );
    expect(v.ok).toBe(true);
  });

  it("n'apparie une saisie manuelle que sur son montant EXACT", () => {
    const ctx = { piecesManuelles: [clePiece("2026-07-09", 9000)] };
    expect(origineEcritureTresorerie(bq({ debit: 8999.99 }), ctx).ok).toBe(false);
    expect(origineEcritureTresorerie(bq({ debit: 0, credit: 9000 }), ctx).ok).toBe(true);
  });
});

describe("cleEcritureTresorerie", () => {
  it("regroupe les deux lignes d'un règlement malgré des libellés différents", () => {
    // Le défaut corrigé : « Encaissement FAC-… » et « Règlement client FAC-… »
    // étaient séparés, et supprimer la moitié d'une écriture déséquilibrait le
    // grand livre du montant du règlement.
    const debit = { journal_code: "BQ", date_ecriture: "2026-07-09", libelle: "Encaissement FAC-2026-001", reference_piece: "FAC-2026-001" };
    const credit = { journal_code: "BQ", date_ecriture: "2026-07-09", libelle: "Règlement client FAC-2026-001", reference_piece: "FAC-2026-001" };
    expect(cleEcritureTresorerie(debit)).toBe(cleEcritureTresorerie(credit));
  });

  it("retombe sur le libellé quand la référence de pièce manque", () => {
    const a = { journal_code: "BQ", date_ecriture: "2026-07-09", libelle: "VIR RECU" };
    const b = { journal_code: "BQ", date_ecriture: "2026-07-09", libelle: "COMMISSION" };
    expect(cleEcritureTresorerie(a)).not.toBe(cleEcritureTresorerie(b));
  });

  it("ne mélange jamais deux journaux ni deux dates", () => {
    const base = { date_ecriture: "2026-07-09", reference_piece: "R1" };
    expect(cleEcritureTresorerie({ ...base, journal_code: "BQ" }))
      .not.toBe(cleEcritureTresorerie({ ...base, journal_code: "CAI" }));
    expect(cleEcritureTresorerie({ ...base, journal_code: "BQ" }))
      .not.toBe(cleEcritureTresorerie({ ...base, journal_code: "BQ", date_ecriture: "2026-07-10" }));
  });
});

describe("grouperEnEcritures / ecartPartieDouble", () => {
  const lignes = [
    { id: "1", journal_code: "BQ", date_ecriture: "2026-07-09", reference_piece: "FAC-1", libelle: "Encaissement", debit: 9000, credit: 0 },
    { id: "2", journal_code: "BQ", date_ecriture: "2026-07-09", reference_piece: "FAC-1", libelle: "Règlement client", debit: 0, credit: 9000 },
    { id: "3", journal_code: "BQ", date_ecriture: "2026-07-10", reference_piece: "FAC-2", libelle: "Encaissement", debit: 500, credit: 0 },
  ];

  it("rend une écriture complète, donc soldée", () => {
    const g = grouperEnEcritures(lignes);
    expect(g.size).toBe(2);
    expect(ecartPartieDouble(g.get(cleEcritureTresorerie(lignes[0]))!)).toBe(0);
  });

  it("laisse voir l'écriture BOITEUSE plutôt que de la masquer", () => {
    const g = grouperEnEcritures(lignes);
    expect(ecartPartieDouble(g.get(cleEcritureTresorerie(lignes[2]))!)).toBe(500);
  });
});

describe("controlerEcrituresTresorerie — garde à l'insertion", () => {
  const ligneBQ = { journal_code: "BQ", compte_numero: "5141", debit: 100, credit: 0 };

  it("laisse passer un lot sans aucune ligne de trésorerie", () => {
    const r = controlerEcrituresTresorerie(
      [{ journal_code: "VTE", compte_numero: "7124" }], { origine: "aucune" },
    );
    expect(r.ok).toBe(true);
  });

  it("exige un transaction_id sur CHAQUE ligne d'une clôture de relevé", () => {
    expect(controlerEcrituresTresorerie(
      [{ ...ligneBQ, transaction_id: "tx1" }], { origine: "releve" },
    ).ok).toBe(true);

    const r = controlerEcrituresTresorerie(
      [{ ...ligneBQ, transaction_id: "tx1" }, { ...ligneBQ, transaction_id: null }],
      { origine: "releve" },
    );
    expect(r.ok).toBe(false);
    expect(r.refusees).toHaveLength(1);
    expect(r.raison).toMatch(/transaction_id/);
  });

  it("exige une pièce pour une saisie manuelle", () => {
    expect(controlerEcrituresTresorerie([ligneBQ], { origine: "saisie_manuelle", piece: "pai-1" }).ok).toBe(true);
    const r = controlerEcrituresTresorerie([ligneBQ], { origine: "saisie_manuelle", piece: "  " });
    expect(r.ok).toBe(false);
    expect(r.raison).toMatch(/sans pièce/i);
  });

  it("refuse toute écriture de trésorerie sans origine revendiquée", () => {
    const r = controlerEcrituresTresorerie([ligneBQ], { origine: "aucune" });
    expect(r.ok).toBe(false);
    expect(r.raison).toMatch(/relevé bancaire validé ou une saisie manuelle formelle/);
  });

  it("refuse le lot ENTIER : insérer la moitié conforme déséquilibrerait le journal", () => {
    const r = controlerEcrituresTresorerie(
      [{ ...ligneBQ, transaction_id: "tx1" }, { journal_code: "BQ", compte_numero: "3421", credit: 100 }],
      { origine: "releve" },
    );
    expect(r.ok).toBe(false);
  });

  it("assertEcrituresTresorerie jette un message exploitable", () => {
    expect(() => assertEcrituresTresorerie([ligneBQ], { origine: "aucune" }))
      .toThrow(/Intégrité Banque ⇄ Compta/);
    expect(() => assertEcrituresTresorerie([ligneBQ], { origine: "saisie_manuelle", piece: "enc-9" }))
      .not.toThrow();
  });
});

// ─── Invariant C_t ≥ 0 ───────────────────────────────────────────────────────

const cai = (date: string, debit: number, credit: number) =>
  ({ journal_code: "CAI", compte_numero: "51610000", date_ecriture: date, debit, credit });

describe("creuxCaisse", () => {
  it("rend un creux nul et le solde de clôture quand la caisse ne descend jamais", () => {
    const c = creuxCaisse([cai("2026-03-02", 12000, 0), cai("2026-06-22", 0, 1200)]);
    expect(c.ok).toBe(true);
    expect(c.creux).toBe(0);
    expect(c.cloture).toBe(10800);
    expect(c.apportManquant).toBe(0);
  });

  it("attrape un creux INTERMÉDIAIRE que le solde de clôture masque", () => {
    // Le piège que la règle existe pour corriger : la caisse plonge en mai, se
    // rétablit en juin, et termine l'année à +5 000. Un contrôle sur le seul
    // solde final n'y verrait rien — la trajectoire a pourtant été impossible.
    const c = creuxCaisse([
      cai("2026-05-10", 0, 3000),
      cai("2026-06-01", 8000, 0),
    ]);
    expect(c.cloture).toBe(5000);
    expect(c.ok).toBe(false);
    expect(c.creux).toBe(-3000);
    expect(c.date).toBe("2026-05-10");
    expect(c.apportManquant).toBe(3000);
  });

  it("compte en FIN DE JOURNÉE : l'ordre des lignes d'un même jour est sans effet", () => {
    // Un apport et le décaissement qu'il finance, saisis le même jour. Les juger
    // ligne à ligne rendrait le verdict dépendant de l'ordre de retour de la
    // base — le même dossier serait déclaré impossible une fois sur deux.
    const decaissementDAbord = creuxCaisse([cai("2026-04-01", 0, 5000), cai("2026-04-01", 6000, 0)]);
    const apportDAbord = creuxCaisse([cai("2026-04-01", 6000, 0), cai("2026-04-01", 0, 5000)]);
    expect(decaissementDAbord.ok).toBe(true);
    expect(apportDAbord.ok).toBe(true);
    expect(decaissementDAbord.creux).toBe(apportDAbord.creux);
  });

  it("ignore les comptes qui ne sont pas de la caisse", () => {
    const c = creuxCaisse([
      { journal_code: "BQ", compte_numero: "51410000", date_ecriture: "2026-01-05", debit: 0, credit: 90000 },
    ]);
    expect(c.mouvements).toBe(0);
    expect(c.ok).toBe(true);
  });
});

describe("controlerCaissePositive", () => {
  const existantes = [cai("2026-03-02", 12000, 0)];

  it("accepte un décaissement que le tiroir peut porter", () => {
    const c = controlerCaissePositive(existantes, [cai("2026-04-01", 0, 5000)]);
    expect(c.ok).toBe(true);
    expect(c.apres.cloture).toBe(7000);
  });

  it("refuse un décaissement qui rendrait la caisse créditrice", () => {
    const c = controlerCaissePositive(existantes, [cai("2026-04-01", 0, 20000)]);
    expect(c.ok).toBe(false);
    expect(c.violations.join(" ")).toMatch(/caisse créditrice/i);
    expect(c.apres.creux).toBe(-8000);
  });

  it("laisse passer l'apport qui REDRESSE une caisse déjà créditrice", () => {
    // Un verrou qui refuserait toute écriture sur une caisse en défaut
    // empêcherait la correction qu'il réclame : le dossier resterait bloqué.
    const enDefaut = [cai("2026-02-01", 0, 4000)];
    const c = controlerCaissePositive(enDefaut, [cai("2026-02-02", 4000, 0)]);
    expect(c.avant.ok).toBe(false);
    expect(c.ok).toBe(true);
  });

  it("refuse ce qui AGGRAVE une caisse déjà créditrice", () => {
    const enDefaut = [cai("2026-02-01", 0, 4000)];
    const c = controlerCaissePositive(enDefaut, [cai("2026-02-02", 0, 1000)]);
    expect(c.ok).toBe(false);
    expect(c.apres.creux).toBe(-5000);
  });
});
