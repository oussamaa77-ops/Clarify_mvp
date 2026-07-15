import { describe, it, expect, vi } from "vitest";
import { fkPaiement, statutPaiement, enregistrerPaiement, reconcilierPaiements } from "./paiements";

describe("fkPaiement", () => {
  it("mappe la table sur la bonne clé étrangère", () => {
    expect(fkPaiement("factures")).toBe("facture_id");
    expect(fkPaiement("factures_fournisseurs")).toBe("facture_fournisseur_id");
  });
});

describe("statutPaiement", () => {
  it("non payé quand rien n'est réglé", () => {
    expect(statutPaiement(1000, 0)).toBe("non_payee");
  });
  it("partiel entre 0 et le solde", () => {
    expect(statutPaiement(1000, 400)).toBe("partielle");
  });
  it("payé au seuil de 1 MAD (arrondis)", () => {
    expect(statutPaiement(1000, 999.5)).toBe("payee");
    expect(statutPaiement(1000, 1000)).toBe("payee");
  });
  it("reste partiel juste sous le seuil", () => {
    expect(statutPaiement(1000, 998)).toBe("partielle");
  });
});

// Faux client supabase : enregistre les appels et permet de simuler l'absence de `paiements`.
function fakeSb({ paiementsExiste = true } = {}) {
  const calls: any[] = [];
  const make = (table: string) => ({
    insert: (row: any) => { calls.push(["insert", table, row]); return paiementsExiste || table !== "paiements" ? { error: null } : { error: { message: "relation paiements does not exist" } }; },
    delete: () => ({ eq: (c: string, v: any) => { calls.push(["delete", table, c, v]); return { error: paiementsExiste || table !== "paiements" ? null : { message: "absent" } }; } }),
    update: (row: any) => ({ eq: (c: string, v: any) => { calls.push(["update", table, row, v]); return { error: null }; } }),
    select: (_cols: string) => ({ eq: () => ({ single: () => ({ data: { montant_ttc: 1000, montant_paye: 200 } }) }) }),
  });
  return { sb: { from: (t: string) => make(t) }, calls };
}

describe("enregistrerPaiement — migration appliquée", () => {
  it("insère dans paiements et ne touche PAS montant_paye (le trigger s'en charge)", async () => {
    const { sb, calls } = fakeSb({ paiementsExiste: true });
    await enregistrerPaiement(sb, {
      dossierId: "d1", table: "factures_fournisseurs", factureId: "f1",
      montant: 300, date: "2026-07-10", origine: "lettrage", transactionId: "tx1",
    });
    // purge idempotente puis insert, sur la bonne FK
    expect(calls).toContainEqual(["delete", "paiements", "transaction_id", "tx1"]);
    const insert = calls.find(c => c[0] === "insert" && c[1] === "paiements");
    expect(insert[2].facture_fournisseur_id).toBe("f1");
    expect(insert[2].montant).toBe(300);
    // aucune écriture directe sur la facture
    expect(calls.some(c => c[0] === "update" && c[1] === "factures_fournisseurs")).toBe(false);
  });
});

describe("enregistrerPaiement — repli avant migration", () => {
  it("retombe sur la maj directe de montant_paye si paiements est absente", async () => {
    const { sb, calls } = fakeSb({ paiementsExiste: false });
    await enregistrerPaiement(sb, {
      dossierId: "d1", table: "factures", factureId: "f1",
      montant: 300, date: "2026-07-10", origine: "encaissement", encaissementId: "e1",
    });
    const upd = calls.find(c => c[0] === "update" && c[1] === "factures");
    expect(upd).toBeTruthy();
    // 200 déjà payé + 300 = 500 ; reste 500 ; partiel
    expect(upd[2].montant_paye).toBe(500);
    expect(upd[2].montant_restant).toBe(500);
    expect(upd[2].statut_paiement).toBe("partielle");
  });
});

describe("reconcilierPaiements", () => {
  it("appelle la RPC et renvoie true si elle réussit", async () => {
    const calls: any[] = [];
    const sb = { rpc: (name: string, args: any) => { calls.push([name, args]); return { error: null }; } };
    const ok = await reconcilierPaiements(sb, "d1");
    expect(ok).toBe(true);
    expect(calls).toContainEqual(["synchroniser_paiements_dossier", { p_dossier: "d1" }]);
  });
  it("renvoie false si la RPC est absente (avant migration) — déclenche le repli appelant", async () => {
    const sb = { rpc: () => ({ error: { message: "function does not exist" } }) };
    expect(await reconcilierPaiements(sb, "d1")).toBe(false);
  });
});
