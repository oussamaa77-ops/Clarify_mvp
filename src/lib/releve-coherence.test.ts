import { describe, it, expect } from "vitest";
import { controlerCoherenceReleve, resumerCoherence, TOLERANCE_CENTIME } from "./releve-coherence";

/** Relevé jouet qui boucle : 10 000 − 1 234,56 + 500,00 = 9 265,44 */
const TXS_OK = [
  { date_operation: "01/06/2026", montant_debit: 1234.56, montant_credit: null },
  { date_operation: "03/06/2026", montant_debit: null, montant_credit: 500.0 },
];
const SOLDES_OK = { solde_initial: 10000, solde_final: 9265.44 };

describe("controlerCoherenceReleve — cas nominal", () => {
  it("valide un relevé dont l'équation de solde boucle au centime", () => {
    const r = controlerCoherenceReleve(TXS_OK, SOLDES_OK);
    expect(r.fiable).toBe(true);
    expect(r.raison).toBeNull();
    expect(r.ecart).toBe(0);
    expect(r.details).toMatchObject({ nbTx: 2, totalDebit: 1234.56, totalCredit: 500 });
  });

  it("accepte un solde initial à 0 (relevé d'ouverture de compte)", () => {
    const r = controlerCoherenceReleve(
      [{ date_operation: "01/06/2026", montant_credit: 1500, montant_debit: null }],
      { solde_initial: 0, solde_final: 1500 },
    );
    expect(r.fiable).toBe(true);
  });

  it("accepte un solde final négatif (compte débiteur)", () => {
    const r = controlerCoherenceReleve(
      [{ date_operation: "01/06/2026", montant_debit: 2500, montant_credit: null }],
      { solde_initial: 1000, solde_final: -1500 },
    );
    expect(r.fiable).toBe(true);
  });

  it("absorbe le bruit des flottants (0.1 + 0.2)", () => {
    const r = controlerCoherenceReleve(
      [
        { date_operation: "01/06/2026", montant_credit: 0.1, montant_debit: null },
        { date_operation: "02/06/2026", montant_credit: 0.2, montant_debit: null },
      ],
      { solde_initial: 0, solde_final: 0.3 },
    );
    expect(r.fiable).toBe(true);
  });
});

describe("controlerCoherenceReleve — ce qui DOIT être refusé", () => {
  it("refuse un montant mal lu (décimale décalée) même d'un seul centime", () => {
    // 1234,56 lu 1234,65 : inversion de deux chiffres, invisible à l'œil.
    const txs = [{ ...TXS_OK[0], montant_debit: 1234.65 }, TXS_OK[1]];
    const r = controlerCoherenceReleve(txs, SOLDES_OK);
    expect(r.fiable).toBe(false);
    expect(r.ecart).toBeCloseTo(0.09, 2);
    expect(r.raison).toMatch(/équation de solde/);
  });

  it("refuse une transaction manquante", () => {
    const r = controlerCoherenceReleve([TXS_OK[0]], SOLDES_OK);
    expect(r.fiable).toBe(false);
  });

  it("refuse une transaction dupliquée", () => {
    const r = controlerCoherenceReleve([...TXS_OK, TXS_OK[1]], SOLDES_OK);
    expect(r.fiable).toBe(false);
  });

  it("refuse un débit lu comme crédit (erreur de colonne)", () => {
    const txs = [
      { date_operation: "01/06/2026", montant_debit: null, montant_credit: 1234.56 },
      TXS_OK[1],
    ];
    const r = controlerCoherenceReleve(txs, SOLDES_OK);
    expect(r.fiable).toBe(false);
    // Erreur de sens = 2× le montant d'écart : très visible.
    expect(r.ecart).toBeCloseTo(2469.12, 2);
  });

  it("refuse quand le solde final est absent — pas de preuve possible", () => {
    const r = controlerCoherenceReleve(TXS_OK, { solde_initial: 10000, solde_final: 0 });
    expect(r.fiable).toBe(false);
    expect(r.raison).toMatch(/solde final absent/);
  });

  it("refuse une extraction vide", () => {
    expect(controlerCoherenceReleve([], SOLDES_OK).fiable).toBe(false);
    expect(controlerCoherenceReleve(null, SOLDES_OK).raison).toMatch(/aucune transaction/);
  });

  it("refuse une ligne portant débit ET crédit", () => {
    const r = controlerCoherenceReleve(
      [{ date_operation: "01/06/2026", montant_debit: 100, montant_credit: 100 }],
      { solde_initial: 0, solde_final: 0.0 },
    );
    expect(r.fiable).toBe(false);
  });

  it("refuse une ligne à montant nul (montant illisible)", () => {
    const r = controlerCoherenceReleve(
      [...TXS_OK, { date_operation: "04/06/2026", montant_debit: 0, montant_credit: 0 }],
      SOLDES_OK,
    );
    expect(r.fiable).toBe(false);
    expect(r.raison).toMatch(/montant nul/);
  });

  it("refuse une ligne sans date d'opération", () => {
    const r = controlerCoherenceReleve(
      [{ date_operation: "", montant_debit: 1234.56, montant_credit: null }, TXS_OK[1]],
      SOLDES_OK,
    );
    expect(r.fiable).toBe(false);
    expect(r.raison).toMatch(/date d'opération/);
  });

  it("refuse un montant négatif (le sens passe par la colonne, pas par le signe)", () => {
    const r = controlerCoherenceReleve(
      [{ date_operation: "01/06/2026", montant_debit: -100, montant_credit: null }],
      { solde_initial: 0, solde_final: 100 },
    );
    expect(r.fiable).toBe(false);
    expect(r.raison).toMatch(/négatif/);
  });

  it("ne se laisse pas berner par deux erreurs qui se compensent", () => {
    // +100 sur une ligne, −100 sur une autre : le total boucle mais les deux
    // lignes sont fausses. Ici le total EST bouclé → le contrôle ne peut pas le
    // voir ; on documente la limite plutôt que de prétendre l'inverse.
    const r = controlerCoherenceReleve(
      [
        { date_operation: "01/06/2026", montant_debit: 1334.56, montant_credit: null },
        { date_operation: "03/06/2026", montant_debit: null, montant_credit: 600.0 },
      ],
      SOLDES_OK,
    );
    expect(r.fiable).toBe(true); // limite connue et assumée du contrôle
  });
});

describe("tolérance", () => {
  it("le centime est la tolérance par défaut", () => {
    expect(TOLERANCE_CENTIME).toBe(0.01);
    const juste = controlerCoherenceReleve(
      [{ date_operation: "01/06/2026", montant_credit: 100.01, montant_debit: null }],
      { solde_initial: 0, solde_final: 100 },
    );
    expect(juste.fiable).toBe(true); // écart 0,01 = tolérance atteinte, acceptée
    const trop = controlerCoherenceReleve(
      [{ date_operation: "01/06/2026", montant_credit: 100.02, montant_debit: null }],
      { solde_initial: 0, solde_final: 100 },
    );
    expect(trop.fiable).toBe(false);
  });

  it("une tolérance élargie reste explicite (jamais implicite)", () => {
    const txs = [{ date_operation: "01/06/2026", montant_credit: 100.5, montant_debit: null }];
    expect(controlerCoherenceReleve(txs, { solde_initial: 0, solde_final: 100 }).fiable).toBe(false);
    expect(controlerCoherenceReleve(txs, { solde_initial: 0, solde_final: 100 }, 1).fiable).toBe(true);
  });
});

describe("resumerCoherence", () => {
  it("résume un succès et un échec de façon lisible", () => {
    expect(resumerCoherence(controlerCoherenceReleve(TXS_OK, SOLDES_OK))).toContain("soldes bouclés");
    expect(resumerCoherence(controlerCoherenceReleve([], SOLDES_OK))).toContain("aucune transaction");
  });
});
