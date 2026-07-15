import { describe, it, expect } from "vitest";
import {
  etatQuota, peutConsommer, periodeCourante, abonnementActif, messageRefus, formatPrix,
  formatJour, SCANS_ILLIMITES,
} from "./quota";

const iso = formatJour;

describe("etatQuota", () => {
  it("calcule restants et pourcentage", () => {
    const e = etatQuota({ used: 25, limit: 100 });
    expect(e.restants).toBe(75);
    expect(e.pourcentage).toBe(25);
    expect(e.niveau).toBe("ok");
    expect(e.epuise).toBe(false);
  });

  it("passe en alerte à 80% puis critique à 95%", () => {
    expect(etatQuota({ used: 79, limit: 100 }).niveau).toBe("ok");
    expect(etatQuota({ used: 80, limit: 100 }).niveau).toBe("alerte");
    expect(etatQuota({ used: 95, limit: 100 }).niveau).toBe("critique");
  });

  it("marque épuisé à la limite exacte, pas avant", () => {
    expect(etatQuota({ used: 99, limit: 100 }).epuise).toBe(false);
    const plein = etatQuota({ used: 100, limit: 100 });
    expect(plein.epuise).toBe(true);
    expect(plein.niveau).toBe("epuise");
    expect(plein.restants).toBe(0);
  });

  it("borne le dépassement (jamais de restants négatifs ni de % > 100)", () => {
    const e = etatQuota({ used: 150, limit: 100 });
    expect(e.restants).toBe(0);
    expect(e.pourcentage).toBe(100);
    expect(e.epuise).toBe(true);
  });

  it("traite limit = -1 comme illimité", () => {
    const e = etatQuota({ used: 5000, limit: SCANS_ILLIMITES });
    expect(e.illimite).toBe(true);
    expect(e.epuise).toBe(false);
    expect(e.pourcentage).toBe(0);
    expect(peutConsommer(e, 999)).toBe(true);
  });

  it("ne produit jamais NaN sur des entrées sales", () => {
    const e = etatQuota({ used: null, limit: undefined });
    expect(e.pourcentage).not.toBeNaN();
    expect(e.utilises).toBe(0);
    // limite 0 = plan sans scan → épuisé d'emblée, pas une division par zéro.
    expect(e.epuise).toBe(true);
  });
});

describe("peutConsommer", () => {
  it("autorise le dernier scan et refuse celui d'après", () => {
    const e = etatQuota({ used: 99, limit: 100 });
    expect(peutConsommer(e, 1)).toBe(true);
    expect(peutConsommer(e, 2)).toBe(false);
  });
});

describe("periodeCourante", () => {
  it("laisse la période en place tant qu'elle court", () => {
    const p = periodeCourante("2026-07-01", "2026-08-01", "2026-07-13");
    expect(iso(p.debut)).toBe("2026-07-01");
    expect(iso(p.fin)).toBe("2026-08-01");
  });

  it("bascule sur la période suivante dès le jour de fin (bornes [debut, fin))", () => {
    const p = periodeCourante("2026-07-01", "2026-08-01", "2026-08-01");
    expect(iso(p.debut)).toBe("2026-08-01");
    expect(iso(p.fin)).toBe("2026-09-01");
  });

  it("rattrape plusieurs mois d'inactivité d'un coup", () => {
    const p = periodeCourante("2026-01-10", "2026-02-10", "2026-07-13");
    expect(iso(p.debut)).toBe("2026-07-10");
    expect(iso(p.fin)).toBe("2026-08-10");
  });

  it("bute sur la fin de mois comme Postgres (31 janv. → 28 févr.)", () => {
    const p = periodeCourante("2026-01-31", "2026-02-28", "2026-02-28");
    expect(iso(p.debut)).toBe("2026-02-28");
    expect(iso(p.fin)).toBe("2026-03-28");
  });
});

describe("abonnementActif", () => {
  it("accepte un abonnement actif", () => {
    expect(abonnementActif({ status: "active" }, "2026-07-13")).toBe(true);
  });

  it("accepte un essai en cours, refuse un essai expiré", () => {
    expect(abonnementActif({ status: "trial", trial_ends_at: "2026-07-20" }, "2026-07-13")).toBe(true);
    expect(abonnementActif({ status: "trial", trial_ends_at: "2026-07-13" }, "2026-07-13")).toBe(true); // dernier jour inclus
    expect(abonnementActif({ status: "trial", trial_ends_at: "2026-07-12" }, "2026-07-13")).toBe(false);
  });

  it("refuse impayé, annulé, inactif et absent", () => {
    expect(abonnementActif({ status: "past_due" }, "2026-07-13")).toBe(false);
    expect(abonnementActif({ status: "canceled" }, "2026-07-13")).toBe(false);
    expect(abonnementActif({ status: "inactive" }, "2026-07-13")).toBe(false);
    expect(abonnementActif(null, "2026-07-13")).toBe(false);
  });
});

describe("messageRefus", () => {
  it("rend la limite dans le message de quota dépassé", () => {
    expect(messageRefus("quota_depasse", { limite: 100 })).toContain("100 scans");
  });

  it("a un message pour chaque raison du contrat SQL", () => {
    for (const r of ["quota_depasse", "essai_expire", "abonnement_impaye", "aucun_abonnement", "dossier_introuvable"]) {
      expect(messageRefus(r)).not.toContain("quota indisponible");
    }
    expect(messageRefus(undefined)).toContain("quota indisponible");
  });
});

describe("formatPrix", () => {
  it("formate en MAD par mois", () => {
    expect(formatPrix(399)).toMatch(/399\s?MAD \/ mois/);
    expect(formatPrix(1999)).toContain("MAD / mois");
  });
});
