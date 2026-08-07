import { describe, it, expect } from "vitest";
import { dateReglementFacture, indexerDatesReglement } from "./date-reglement";

const idx = (s: Parameters<typeof indexerDatesReglement>[1], sens: "client" | "fournisseur" = "client") =>
  indexerDatesReglement(sens, s);

describe("indexerDatesReglement — d'où vient la date", () => {
  it("prend la date saisie dans le modal de règlement manuel", () => {
    const m = idx({ paiements: [{ facture_id: "f1", date_paiement: "2026-06-28", montant: 500 }] });
    expect(m.get("f1")).toEqual({ date: "2026-06-28", source: "manuel", nbReglements: 1 });
  });

  it("prend la date de l'opération pour une facture rapprochée d'un relevé", () => {
    const m = idx({ transactions: [{ facture_id: "f1", document_type: "facture_client", date_operation: "2026-05-12" }] });
    expect(m.get("f1")).toEqual({ date: "2026-05-12", source: "banque", nbReglements: 1 });
  });

  it("prend la date d'un encaissement espèces / chèque", () => {
    const m = idx({ encaissements: [{ facture_id: "f1", date_encaissement: "2026-04-02" }] });
    expect(m.get("f1")?.source).toBe("encaissement");
  });

  it("tolère un horodatage complet et n'en garde que le jour", () => {
    const m = idx({ transactions: [{ facture_id: "f1", date_operation: "2026-05-12T14:33:00.000Z" }] });
    expect(m.get("f1")?.date).toBe("2026-05-12");
  });

  it("ignore une date absente ou illisible", () => {
    const m = idx({ paiements: [
      { facture_id: "f1", date_paiement: null, montant: 100 },
      { facture_id: "f2", date_paiement: "date inconnue", montant: 100 },
    ] });
    expect(m.size).toBe(0);
  });
});

describe("indexerDatesReglement — plusieurs pièces sur une facture", () => {
  // Une facture réglée en trois fois est soldée le jour du DERNIER versement :
  // retenir le premier ferait passer pour ancienne une créance encaissée hier.
  it("retient la date la PLUS RÉCENTE", () => {
    const m = idx({ paiements: [
      { facture_id: "f1", date_paiement: "2026-01-10", montant: 300 },
      { facture_id: "f1", date_paiement: "2026-03-05", montant: 300 },
      { facture_id: "f1", date_paiement: "2026-02-01", montant: 400 },
    ] });
    expect(m.get("f1")?.date).toBe("2026-03-05");
    expect(m.get("f1")?.nbReglements).toBe(3);
  });

  it("compte les règlements quel que soit leur ordre d'arrivée", () => {
    const m = idx({
      paiements: [{ facture_id: "f1", date_paiement: "2026-02-01", montant: 500 }],
      transactions: [{ facture_id: "f1", date_operation: "2026-01-15" }],
    });
    expect(m.get("f1")).toEqual({ date: "2026-02-01", source: "manuel", nbReglements: 2 });
  });

  // À date égale, la banque l'emporte : sa date d'opération n'est pas une saisie.
  it("à date ÉGALE, la banque prime sur la saisie manuelle", () => {
    const m = idx({
      paiements: [{ facture_id: "f1", date_paiement: "2026-02-01", montant: 500 }],
      transactions: [{ facture_id: "f1", date_operation: "2026-02-01" }],
    });
    expect(m.get("f1")?.source).toBe("banque");
  });

  it("une date manuelle POSTÉRIEURE l'emporte tout de même sur la banque", () => {
    const m = idx({
      paiements: [{ facture_id: "f1", date_paiement: "2026-02-10", montant: 500 }],
      transactions: [{ facture_id: "f1", date_operation: "2026-02-01" }],
    });
    expect(m.get("f1")).toMatchObject({ date: "2026-02-10", source: "manuel" });
  });
});

describe("indexerDatesReglement — sens de la facture", () => {
  it("côté fournisseur, lit facture_fournisseur_id", () => {
    const m = idx({
      paiements: [
        { facture_fournisseur_id: "ff1", date_paiement: "2026-03-01", montant: 900 },
        { facture_id: "f1", date_paiement: "2026-03-02", montant: 900 },
      ],
    }, "fournisseur");
    expect(m.get("ff1")?.date).toBe("2026-03-01");
    expect(m.has("f1")).toBe(false);
  });

  it("écarte une transaction rattachée à l'autre sens", () => {
    const m = idx({ transactions: [{ facture_id: "f1", document_type: "facture_fournisseur", date_operation: "2026-03-01" }] });
    expect(m.size).toBe(0);
  });

  it("accepte les lignes lettrées avant l'introduction de document_type", () => {
    for (const dt of [null, undefined, "inconnu"]) {
      const m = idx({ transactions: [{ facture_id: "f1", document_type: dt as any, date_operation: "2026-03-01" }] });
      expect(m.get("f1")?.source).toBe("banque");
    }
  });

  it("ignore un paiement à montant nul ou négatif", () => {
    const m = idx({ paiements: [
      { facture_id: "f1", date_paiement: "2026-03-01", montant: 0 },
      { facture_id: "f2", date_paiement: "2026-03-01", montant: -50 },
    ] });
    expect(m.size).toBe(0);
  });
});

describe("dateReglementFacture — ce qui s'affiche dans la colonne", () => {
  const index = indexerDatesReglement("client", {
    paiements: [{ facture_id: "f1", date_paiement: "2026-06-28", montant: 500 }],
  });

  it("rend la date constatée pour une facture réglée", () => {
    expect(dateReglementFacture({ id: "f1", statut_paiement: "payee" }, index)?.date).toBe("2026-06-28");
  });

  it("rend la date aussi sur un règlement PARTIEL", () => {
    expect(dateReglementFacture({ id: "f1", statut_paiement: "partielle" }, index)?.date).toBe("2026-06-28");
  });

  // Une facture en attente n'a pas de date de règlement : en afficher une
  // laisserait croire qu'elle est réglée.
  it("rend null tant que la facture n'est pas réglée", () => {
    expect(dateReglementFacture({ id: "f1", statut_paiement: "non_payee", date_paiement: "2026-06-28" }, index)).toBeNull();
  });

  it("retombe sur factures.date_paiement quand aucune pièce n'est rattachée", () => {
    const r = dateReglementFacture({ id: "inconnue", statut_paiement: "payee", date_paiement: "2026-02-14" }, index);
    expect(r).toEqual({ date: "2026-02-14", source: "facture", nbReglements: 1 });
  });

  it("rend null si même le repli est vide", () => {
    expect(dateReglementFacture({ id: "inconnue", statut_paiement: "payee", date_paiement: null }, index)).toBeNull();
  });
});
