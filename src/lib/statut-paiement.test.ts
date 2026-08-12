import { describe, it, expect } from "vitest";
import {
  estOuverte, estSoldee, libelleStatut, statutDepuisMontants, statutMetier, statutStocke,
} from "./statut-paiement";

describe("statutMetier — lecture", () => {
  it("traduit les valeurs de l'ENUM Postgres", () => {
    expect(statutMetier("non_payee")).toBe("en_attente");
    expect(statutMetier("partielle")).toBe("partiellement_payee");
    expect(statutMetier("payee")).toBe("payee");
    expect(statutMetier("en_retard")).toBe("en_retard");
  });

  it("retombe sur « en attente » plutôt que d'inventer un statut", () => {
    for (const v of [null, undefined, "", "inconnu"]) expect(statutMetier(v)).toBe("en_attente");
  });
});

describe("statutStocke — écriture", () => {
  it("rend la valeur que l'ENUM accepte", () => {
    expect(statutStocke("en_attente")).toBe("non_payee");
    expect(statutStocke("partiellement_payee")).toBe("partielle");
    expect(statutStocke("payee")).toBe("payee");
  });

  it("laisse passer une valeur déjà stockée — les deux vocabulaires se croisent", () => {
    expect(statutStocke("partielle")).toBe("partielle");
    expect(statutStocke("non_payee")).toBe("non_payee");
  });

  it("n'écrit JAMAIS une valeur hors ENUM", () => {
    // C'est ce qui ferait échouer l'update en base (invalid input value for enum).
    const valides = ["non_payee", "partielle", "payee", "en_retard"];
    for (const v of ["", "n'importe quoi", "PAYEE", null]) {
      expect(valides).toContain(statutStocke(v));
    }
  });

  it("fait l'aller-retour sans perte", () => {
    for (const s of ["non_payee", "partielle", "payee", "en_retard"] as const) {
      expect(statutStocke(statutMetier(s))).toBe(s);
    }
  });
});

describe("statutDepuisMontants", () => {
  it("rien de réglé → en attente", () => {
    expect(statutDepuisMontants(1000, 0)).toBe("en_attente");
  });
  it("acompte → partiellement payée", () => {
    expect(statutDepuisMontants(1000, 400)).toBe("partiellement_payee");
  });
  it("solde au seuil d'1 MAD (arrondis)", () => {
    expect(statutDepuisMontants(1000, 999.5)).toBe("payee");
    expect(statutDepuisMontants(1000, 1000)).toBe("payee");
  });
  it("reste partielle juste sous le seuil", () => {
    expect(statutDepuisMontants(1000, 998)).toBe("partiellement_payee");
  });
  it("un centime encaissé n'est pas « rien »", () => {
    expect(statutDepuisMontants(1000, 0.01)).toBe("partiellement_payee");
  });
});

describe("libellés et prédicats", () => {
  it("affiche du français lisible", () => {
    expect(libelleStatut("partielle")).toBe("Partiellement payée");
    expect(libelleStatut("non_payee")).toBe("En attente");
  });

  it("estSoldee ne vaut que pour « payée »", () => {
    expect(estSoldee("payee")).toBe(true);
    for (const v of ["partielle", "non_payee", "en_retard"]) expect(estSoldee(v)).toBe(false);
  });

  it("estOuverte est l'exact complément", () => {
    for (const v of ["payee", "partielle", "non_payee", "en_retard", null]) {
      expect(estOuverte(v)).toBe(!estSoldee(v));
    }
  });
});
