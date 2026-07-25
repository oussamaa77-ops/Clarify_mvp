import { describe, it, expect } from "vitest";
import {
  resteAPayer,
  estPayee,
  joursRetard,
  trancheRetard,
  correspondStatut,
  filtrerFactures,
  type FactureFiltrable,
} from "./factures-filtres";

// Date de référence figée : les retards sont calculés « à aujourd'hui », donc
// les tests doivent injecter leur propre date sous peine d'expirer avec le temps.
const AUJ = new Date(2026, 6, 24); // 24/07/2026 (mois 0-indexé)

const f = (o: Partial<FactureFiltrable>): FactureFiltrable => ({
  numero: "F-001", montant_ttc: 1200, montant_paye: 0, montant_restant: 1200,
  date_facture: "2026-06-01", date_echeance: "2026-06-30", statut_paiement: "non_payee",
  ...o,
});

describe("resteAPayer", () => {
  it("utilise montant_restant quand il est renseigné", () => {
    expect(resteAPayer(f({ montant_restant: 500 }))).toBe(500);
  });

  it("retombe sur le TTC si montant_restant est NULL (factures anciennes)", () => {
    expect(resteAPayer(f({ montant_restant: null, montant_ttc: 900 }))).toBe(900);
  });

  it("respecte un restant à 0 (facture soldée) sans repli sur le TTC", () => {
    expect(resteAPayer(f({ montant_restant: 0, montant_ttc: 900 }))).toBe(0);
  });
});

describe("estPayee", () => {
  it("solde nul → payée", () => {
    expect(estPayee(f({ montant_restant: 0 }))).toBe(true);
  });

  it("statut_paiement=payee fait foi même si le restant est incohérent", () => {
    expect(estPayee(f({ montant_restant: 1200, statut_paiement: "payee" }))).toBe(true);
  });

  it("restant > 0 → non payée", () => {
    expect(estPayee(f({ montant_restant: 1 }))).toBe(false);
  });
});

describe("joursRetard — recalculé à la date du jour", () => {
  it("compte les jours calendaires depuis l'échéance", () => {
    // 30/06 → 24/07 = 24 jours
    expect(joursRetard(f({ date_echeance: "2026-06-30" }), AUJ)).toBe(24);
  });

  it("échéance future → aucun retard", () => {
    expect(joursRetard(f({ date_echeance: "2026-08-15" }), AUJ)).toBeNull();
  });

  it("échéance du jour même → pas encore en retard", () => {
    expect(joursRetard(f({ date_echeance: "2026-07-24" }), AUJ)).toBeNull();
  });

  it("facture soldée → jamais en retard, même échue", () => {
    expect(joursRetard(f({ date_echeance: "2026-01-01", montant_restant: 0 }), AUJ)).toBeNull();
  });

  it("sans échéance → pas de retard calculable", () => {
    expect(joursRetard(f({ date_echeance: null }), AUJ)).toBeNull();
  });

  it("date illisible → pas de retard (aucune invention)", () => {
    expect(joursRetard(f({ date_echeance: "30/06/2026" }), AUJ)).toBeNull();
  });

  it("ignore l'heure et le fuseau (comparaison de jours calendaires)", () => {
    const tard = new Date(2026, 6, 24, 23, 59);
    expect(joursRetard(f({ date_echeance: "2026-07-23" }), tard)).toBe(1);
  });
});

describe("trancheRetard — alignée sur la balance âgée", () => {
  it("bornes des tranches", () => {
    expect(trancheRetard(1)?.cle).toBe("retard_1_30");
    expect(trancheRetard(30)?.cle).toBe("retard_1_30");
    expect(trancheRetard(31)?.cle).toBe("retard_31_60");
    expect(trancheRetard(60)?.cle).toBe("retard_31_60");
    expect(trancheRetard(61)?.cle).toBe("retard_60_plus");
  });

  it("aucun retard → aucune tranche", () => {
    expect(trancheRetard(null)).toBeNull();
    expect(trancheRetard(0)).toBeNull();
  });
});

describe("correspondStatut", () => {
  const payee    = f({ montant_restant: 0, statut_paiement: "payee" });
  const partiel  = f({ montant_paye: 400, montant_restant: 800, date_echeance: "2026-08-30" });
  const impayee  = f({ montant_paye: 0, montant_restant: 1200, date_echeance: "2026-08-30" });
  const enRetard = f({ montant_paye: 0, montant_restant: 1200, date_echeance: "2026-05-01" });

  it("« toutes » ne filtre rien", () => {
    expect([payee, partiel, impayee].every(x => correspondStatut(x, "toutes", AUJ))).toBe(true);
  });

  it("distingue payée / partielle / impayée", () => {
    expect(correspondStatut(payee, "payees", AUJ)).toBe(true);
    expect(correspondStatut(partiel, "partiel", AUJ)).toBe(true);
    expect(correspondStatut(impayee, "impayees", AUJ)).toBe(true);
    expect(correspondStatut(partiel, "impayees", AUJ)).toBe(false);
    expect(correspondStatut(impayee, "partiel", AUJ)).toBe(false);
  });

  it("« en retard » retient AUSSI une facture partiellement payée et échue", () => {
    // Statuts volontairement non exclusifs : masquer cette créance serait faux.
    const partielEchue = f({ montant_paye: 400, montant_restant: 800, date_echeance: "2026-05-01" });
    expect(correspondStatut(partielEchue, "retard", AUJ)).toBe(true);
    expect(correspondStatut(partielEchue, "partiel", AUJ)).toBe(true);
  });

  it("une facture payée n'est jamais « en retard »", () => {
    expect(correspondStatut(f({ montant_restant: 0, date_echeance: "2026-01-01" }), "retard", AUJ)).toBe(false);
  });
});

describe("filtrerFactures", () => {
  const factures = [
    f({ numero: "FA-2026-001", montant_restant: 0, statut_paiement: "payee", date_facture: "2026-01-15" }),
    f({ numero: "FA-2026-002", montant_restant: 1200, date_facture: "2026-03-10", date_echeance: "2026-04-10" }),
    f({ numero: "AV-2026-003", montant_restant: 500, montant_paye: 700, date_facture: "2026-06-20", date_echeance: "2026-12-01" }),
  ];

  it("sans critère → tout passe", () => {
    expect(filtrerFactures(factures, {}, { aujourdhui: AUJ })).toHaveLength(3);
  });

  it("recherche par n° de facture, insensible à la casse", () => {
    const r = filtrerFactures(factures, { texte: "av-2026" }, { aujourdhui: AUJ });
    expect(r.map(x => x.numero)).toEqual(["AV-2026-003"]);
  });

  it("recherche sur le nom du tiers fourni par l'écran", () => {
    const r = filtrerFactures(
      factures,
      { texte: "dupont" },
      { aujourdhui: AUJ, nomTiers: (x) => (x.numero === "FA-2026-002" ? "Ets Dupont" : "Autre") },
    );
    expect(r.map(x => x.numero)).toEqual(["FA-2026-002"]);
  });

  it("recherche sur un champ libre supplémentaire (référence)", () => {
    const r = filtrerFactures(
      factures,
      { texte: "BC-77" },
      { aujourdhui: AUJ, texteExtra: (x) => (x.numero === "AV-2026-003" ? ["BC-77"] : []) },
    );
    expect(r.map(x => x.numero)).toEqual(["AV-2026-003"]);
  });

  it("filtre par statut", () => {
    expect(filtrerFactures(factures, { statut: "payees" }, { aujourdhui: AUJ })).toHaveLength(1);
    expect(filtrerFactures(factures, { statut: "retard" }, { aujourdhui: AUJ })).toHaveLength(1);
  });

  it("filtre par tiers", () => {
    const r = filtrerFactures(
      factures,
      { tiersId: "cli-1" },
      { aujourdhui: AUJ, idTiers: (x) => (x.numero === "FA-2026-001" ? "cli-1" : "cli-2") },
    );
    expect(r.map(x => x.numero)).toEqual(["FA-2026-001"]);
  });

  it("filtre par période sur la date de facture (bornes incluses)", () => {
    const r = filtrerFactures(factures, { debut: "2026-03-10", fin: "2026-06-20" }, { aujourdhui: AUJ });
    expect(r.map(x => x.numero)).toEqual(["FA-2026-002", "AV-2026-003"]);
  });

  it("filtre par période sur l'échéance quand on le demande", () => {
    const r = filtrerFactures(
      factures,
      { debut: "2026-01-01", fin: "2026-05-01", champDate: "date_echeance" },
      { aujourdhui: AUJ },
    );
    expect(r.map(x => x.numero)).toEqual(["FA-2026-002"]);
  });

  it("exclut une facture dont la date filtrée est absente", () => {
    const sansDate = [f({ numero: "X", date_facture: null })];
    expect(filtrerFactures(sansDate, { debut: "2026-01-01" }, { aujourdhui: AUJ })).toHaveLength(0);
  });

  it("cumule les critères (ET logique)", () => {
    const r = filtrerFactures(
      factures,
      { texte: "FA-", statut: "retard", debut: "2026-01-01" },
      { aujourdhui: AUJ },
    );
    expect(r.map(x => x.numero)).toEqual(["FA-2026-002"]);
  });
});
