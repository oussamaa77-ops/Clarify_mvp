import { describe, it, expect } from "vitest";
import {
  buildOpenItems, matchTransactionDeterministe, type OpenLedgerItem,
} from "./lettrage.functions";

// Candidats vides par défaut (le matcher reçoit factures/justificatifs vides ici).
const emptyCand = (over: Partial<Parameters<typeof matchTransactionDeterministe>[1]> = {}) =>
  ({ facturesClient: [], facturesFourn: [], justificatifs: [], ...over });
const freshUsed = () => ({ fc: new Set<string>(), ff: new Set<string>(), j: new Set<string>(), e: new Set<string>() });

const ecr = (over: Partial<{ id: string; compte_numero: string; libelle: string; debit: number; credit: number; reference_piece: string | null }>) => ({
  id: over.id ?? "e1", compte_numero: over.compte_numero ?? "3421001", libelle: over.libelle ?? "CLIENT ALPHA",
  debit: over.debit ?? 0, credit: over.credit ?? 0, reference_piece: over.reference_piece ?? null,
});

// ─── buildOpenItems ───────────────────────────────────────────────────────────
describe("buildOpenItems — postes ouverts nettés + archivage", () => {
  it("créance client (342x débit) → poste ouvert de type client", () => {
    const { open } = buildOpenItems([ecr({ compte_numero: "3421001", libelle: "CLIENT ALPHA", debit: 1200 })]);
    expect(open).toHaveLength(1);
    expect(open[0].type).toBe("client");
    expect(open[0].montant).toBeCloseTo(1200);
    expect(open[0].libelle).toBe("CLIENT ALPHA");
  });

  it("dette fournisseur (441x crédit) → poste ouvert de type fournisseur", () => {
    const { open } = buildOpenItems([ecr({ id: "f1", compte_numero: "4411002", libelle: "FOURNISSEUR BETA", credit: 800 })]);
    expect(open).toHaveLength(1);
    expect(open[0].type).toBe("fournisseur");
    expect(open[0].montant).toBeCloseTo(800);
  });

  it("NETTING par pièce : facture réglée dans le GL → 0 poste ouvert, lignes ARCHIVÉES", () => {
    // Même pièce FA-1 : débit 1200 (facture) puis crédit 1200 (encaissement comptabilisé) → soldé.
    const { open, settledIds } = buildOpenItems([
      ecr({ id: "a", compte_numero: "3421001", debit: 1200, reference_piece: "FA-1" }),
      ecr({ id: "b", compte_numero: "3421001", credit: 1200, reference_piece: "FA-1" }),
    ]);
    expect(open).toHaveLength(0);
    expect(settledIds.sort()).toEqual(["a", "b"]); // archivage netting
  });

  it("NETTING partiel : résidu proposé (facture 1200, acompte 400 → 800 ouvert), rien d'archivé", () => {
    const { open, settledIds } = buildOpenItems([
      ecr({ id: "a", compte_numero: "3421001", debit: 1200, reference_piece: "FA-2" }),
      ecr({ id: "b", compte_numero: "3421001", credit: 400, reference_piece: "FA-2" }),
    ]);
    expect(open).toHaveLength(1);
    expect(open[0].montant).toBeCloseTo(800);
    expect(open[0].ids).toEqual(["a", "b"]); // les 2 lignes du groupe à estampiller
    expect(settledIds).toHaveLength(0);
  });

  it("ignore les comptes non auxiliaires (charges 6x, produits 7x)", () => {
    const { open } = buildOpenItems([
      ecr({ compte_numero: "6111", debit: 500 }),
      ecr({ compte_numero: "7111", credit: 500 }),
    ]);
    expect(open).toHaveLength(0);
  });

  it("sans pièce : chaque ligne est son propre poste (pas de fusion abusive)", () => {
    const { open } = buildOpenItems([
      ecr({ id: "a", compte_numero: "3421001", libelle: "CLIENT A", debit: 500 }),
      ecr({ id: "b", compte_numero: "3421001", libelle: "CLIENT A", debit: 700 }),
    ]);
    expect(open).toHaveLength(2);
    expect(open.map((i) => i.montant).sort()).toEqual([500, 700]);
  });
});

// ─── matchTransactionDeterministe — branche écritures ─────────────────────────
describe("matchTransactionDeterministe — lettrage sur écritures ouvertes", () => {
  const openClient: OpenLedgerItem = { id: "3421001|FA-1", ids: ["a"], type: "client", libelle: "CLIENT ALPHA", montant: 1200 };
  const openFourn: OpenLedgerItem = { id: "4411002|FF-9", ids: ["b"], type: "fournisseur", libelle: "FOURNISSEUR BETA", montant: 800 };

  it("encaissement (crédit) → matche une créance client par montant + tiers", () => {
    const tx = { type: "credit", libelle: "VIREMENT RECU DE CLIENT ALPHA", montant: 1200, rapproche: false };
    const m = matchTransactionDeterministe(tx, emptyCand({ ecrituresOuvertes: [openClient] }), freshUsed());
    expect(m).toEqual({ kind: "ecriture", id: "3421001|FA-1" });
  });

  it("paiement (débit) → matche une dette fournisseur", () => {
    const tx = { type: "debit", libelle: "VIR EMIS FOURNISSEUR BETA", montant: 800, rapproche: false };
    const m = matchTransactionDeterministe(tx, emptyCand({ ecrituresOuvertes: [openFourn] }), freshUsed());
    expect(m).toEqual({ kind: "ecriture", id: "4411002|FF-9" });
  });

  it("mauvais sens : un crédit ne matche pas une dette fournisseur", () => {
    const tx = { type: "credit", libelle: "FOURNISSEUR BETA", montant: 800, rapproche: false };
    const m = matchTransactionDeterministe(tx, emptyCand({ ecrituresOuvertes: [openFourn] }), freshUsed());
    expect(m).toBeNull();
  });

  it("montant hors tolérance (>1 MAD) → pas de match", () => {
    const tx = { type: "credit", libelle: "CLIENT ALPHA", montant: 1150, rapproche: false };
    const m = matchTransactionDeterministe(tx, emptyCand({ ecrituresOuvertes: [openClient] }), freshUsed());
    expect(m).toBeNull();
  });

  it("tiers absent du libellé → pas de match (évite le sur-matching)", () => {
    const tx = { type: "credit", libelle: "VIREMENT DIVERS 123", montant: 1200, rapproche: false };
    const m = matchTransactionDeterministe(tx, emptyCand({ ecrituresOuvertes: [openClient] }), freshUsed());
    expect(m).toBeNull();
  });

  it("transaction déjà rapprochée → branche écritures ignorée (idempotence)", () => {
    const tx = { type: "credit", libelle: "CLIENT ALPHA", montant: 1200, rapproche: true };
    const m = matchTransactionDeterministe(tx, emptyCand({ ecrituresOuvertes: [openClient] }), freshUsed());
    expect(m).toBeNull();
  });

  it("dédup intra-lot : un poste déjà utilisé n'est pas repris", () => {
    const used = freshUsed(); used.e.add("3421001|FA-1");
    const tx = { type: "credit", libelle: "CLIENT ALPHA", montant: 1200, rapproche: false };
    const m = matchTransactionDeterministe(tx, emptyCand({ ecrituresOuvertes: [openClient] }), used);
    expect(m).toBeNull();
  });

  it("PRÉSENT (défaut) : facture OCR prioritaire sur l'écriture GL", () => {
    const tx = { type: "credit", libelle: "CLIENT ALPHA", montant: 1200, rapproche: false }; // estPasse absent → présent
    const cand = emptyCand({
      facturesClient: [{ id: "fac-1", montant_ttc: 1200, montant_restant: 1200, clients: { nom: "CLIENT ALPHA" } }],
      ecrituresOuvertes: [openClient],
    });
    const m = matchTransactionDeterministe(tx, cand, freshUsed());
    expect(m).toEqual({ kind: "facture_client", id: "fac-1" });
  });

  it("PASSÉ (migration) : écriture GL prioritaire même si une facture correspond", () => {
    const tx = { type: "credit", libelle: "CLIENT ALPHA", montant: 1200, rapproche: false, estPasse: true };
    const cand = emptyCand({
      facturesClient: [{ id: "fac-1", montant_ttc: 1200, montant_restant: 1200, clients: { nom: "CLIENT ALPHA" } }],
      ecrituresOuvertes: [openClient],
    });
    const m = matchTransactionDeterministe(tx, cand, freshUsed());
    expect(m).toEqual({ kind: "ecriture", id: "3421001|FA-1" });
  });

  it("PASSÉ sans écriture correspondante → repli sur la facture (secours)", () => {
    const tx = { type: "credit", libelle: "CLIENT ALPHA", montant: 1200, rapproche: false, estPasse: true };
    const cand = emptyCand({
      facturesClient: [{ id: "fac-1", montant_ttc: 1200, montant_restant: 1200, clients: { nom: "CLIENT ALPHA" } }],
      ecrituresOuvertes: [], // aucune écriture ouverte
    });
    const m = matchTransactionDeterministe(tx, cand, freshUsed());
    expect(m).toEqual({ kind: "facture_client", id: "fac-1" });
  });

  it("rétro-compat : sans ecrituresOuvertes ni used.e, le matcher fonctionne (champs optionnels)", () => {
    const tx = { type: "credit", libelle: "CLIENT ALPHA", montant: 1200, rapproche: false };
    const m = matchTransactionDeterministe(tx, { facturesClient: [], facturesFourn: [], justificatifs: [] }, { fc: new Set(), ff: new Set(), j: new Set() });
    expect(m).toBeNull();
  });
});
