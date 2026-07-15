import { describe, it, expect } from "vitest";
import {
  periodBounds, previousPeriodAnchor, formatPeriodeRange, jourLocal, normNom,
  indexTiersParNom, calcTiers, detailTiers, trierDetail, CATEGORIES,
  type TiersRow, type FactureRow,
} from "./tiers-reporting";

const FOURN = { tiersKey: "fournisseur_id", factureNomKey: "fournisseur_nom" };

describe("periodBounds — mapping strict date → période", () => {
  it("place chaque mois dans le bon trimestre", () => {
    const cas: [string, string][] = [
      ["2026-01-01", "T1 2026"], ["2026-03-31", "T1 2026"],
      ["2026-04-10", "T2 2026"], ["2026-06-30", "T2 2026"],
      ["2026-07-01", "T3 2026"], ["2026-09-30", "T3 2026"],
      ["2026-10-04", "T4 2026"], ["2026-12-31", "T4 2026"],
    ];
    for (const [d, label] of cas) expect(periodBounds("trimestre", d).label).toBe(label);
  });

  it("octobre est T4, jamais T2", () => {
    expect(periodBounds("trimestre", "2026-10-04")).toEqual({
      startStr: "2026-10-01", endStr: "2026-12-31", label: "T4 2026",
    });
  });

  it("borne les mois de février bissextiles", () => {
    expect(periodBounds("mois", "2028-02-10").endStr).toBe("2028-02-29");
    expect(periodBounds("mois", "2026-02-10").endStr).toBe("2026-02-28");
  });

  it("découpe semestres et années", () => {
    expect(periodBounds("semestre", "2026-06-30").label).toBe("S1 2026");
    expect(periodBounds("semestre", "2026-07-01").label).toBe("S2 2026");
    expect(periodBounds("annee", "2026-10-04")).toEqual({ startStr: "2026-01-01", endStr: "2026-12-31", label: "2026" });
  });
});

describe("previousPeriodAnchor — pas de débordement de mois", () => {
  it("recule d'un trimestre plein depuis un 31", () => {
    // setMonth(m-3) sur le 31/12 visait le 31 septembre → JS débordait sur le 01/10 (même trimestre).
    expect(periodBounds("trimestre", previousPeriodAnchor("trimestre", "2026-12-31")).label).toBe("T3 2026");
    expect(periodBounds("trimestre", previousPeriodAnchor("trimestre", "2026-05-31")).label).toBe("T1 2026");
    expect(periodBounds("trimestre", previousPeriodAnchor("trimestre", "2026-10-31")).label).toBe("T3 2026");
  });

  it("recule d'un mois plein depuis un 31", () => {
    expect(periodBounds("mois", previousPeriodAnchor("mois", "2026-03-31")).label).toBe("févr. 2026");
    expect(periodBounds("mois", previousPeriodAnchor("mois", "2026-05-31")).label).toBe("avr. 2026");
  });

  it("ne renvoie jamais la période courante, quelle que soit l'ancre", () => {
    for (const gran of ["jour", "mois", "trimestre", "semestre", "annee"] as const) {
      for (let m = 0; m < 12; m++) {
        for (const d of [1, 28, 29, 30, 31]) {
          const jours = new Date(2026, m + 1, 0).getDate();
          if (d > jours) continue;
          const ancre = `2026-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          const courante = periodBounds(gran, ancre);
          const precedente = periodBounds(gran, previousPeriodAnchor(gran, ancre));
          expect(precedente.endStr < courante.startStr).toBe(true);
        }
      }
    }
  });

  it("franchit l'année", () => {
    expect(periodBounds("trimestre", previousPeriodAnchor("trimestre", "2026-01-15")).label).toBe("T4 2025");
    expect(periodBounds("annee", previousPeriodAnchor("annee", "2026-01-01")).label).toBe("2025");
  });
});

describe("formatPeriodeRange", () => {
  it("affiche les bornes réelles en jj/mm/aaaa", () => {
    expect(formatPeriodeRange(periodBounds("trimestre", "2026-10-04"))).toBe("du 01/10/2026 au 31/12/2026");
    expect(formatPeriodeRange(periodBounds("jour", "2026-10-04"))).toBe("le 04/10/2026");
  });
});

describe("jourLocal", () => {
  it("laisse une DATE intacte", () => {
    expect(jourLocal("2026-10-04")).toBe("2026-10-04");
  });
  it("convertit un TIMESTAMPTZ vers le jour civil local", () => {
    const ts = "2026-09-30T23:30:00Z";
    const attendu = new Date(ts);
    const iso = `${attendu.getFullYear()}-${String(attendu.getMonth() + 1).padStart(2, "0")}-${String(attendu.getDate()).padStart(2, "0")}`;
    expect(jourLocal(ts)).toBe(iso);
  });
  it("tolère null et valeurs invalides", () => {
    expect(jourLocal(null)).toBeNull();
    expect(jourLocal("pas une date du tout")).toBeNull();
  });
});

describe("normNom / indexTiersParNom", () => {
  it("rapproche malgré casse, accents, ponctuation et espaces", () => {
    expect(normNom("  Sté  GÉNÉRALE, ")).toBe(normNom("ste generale"));
    expect(normNom("Attijariwafa-Bank")).toBe(normNom("ATTIJARIWAFA BANK"));
  });
  it("ne devine pas les abréviations : S.A.R.L. ne vaut pas SARL", () => {
    // Rapprochement volontairement littéral : mieux vaut laisser un tiers non rattaché
    // que l'attribuer à un homonyme approximatif.
    expect(normNom("Somadir S.A.R.L.")).not.toBe(normNom("Somadir SARL"));
  });
  it("marque les homonymes comme ambigus", () => {
    const idx = indexTiersParNom([{ id: "a", nom: "Somadir" }, { id: "b", nom: "SOMADIR" }, { id: "c", nom: "Attijari" }]);
    expect(idx.get(normNom("Somadir"))).toBeNull();
    expect(idx.get(normNom("Attijari"))).toBe("c");
  });
});

describe("calcTiers — cohérence actif / passif / nouveau", () => {
  const p = periodBounds("trimestre", "2026-10-04"); // 01/10 → 31/12

  it("rattache une facture sans fournisseur_id via fournisseur_nom", () => {
    const tiers: TiersRow[] = [{ id: "f1", nom: "Somadir", created_at: "2025-01-01T00:00:00Z" }];
    const factures: FactureRow[] = [
      { fournisseur_id: null, fournisseur_nom: "SOMADIR ", date_facture: "2026-11-02", montant_ht: 1000 },
    ];
    const r = calcTiers(p, tiers, factures, FOURN);
    expect(r.actifs).toBe(1);
    expect(r.passifs).toBe(0);
  });

  it("ne rattache pas une facture dont le nom est ambigu", () => {
    const tiers: TiersRow[] = [
      { id: "f1", nom: "Somadir", created_at: "2025-01-01T00:00:00Z" },
      { id: "f2", nom: "somadir", created_at: "2025-01-01T00:00:00Z" },
    ];
    const factures: FactureRow[] = [{ fournisseur_id: null, fournisseur_nom: "Somadir", date_facture: "2026-11-02", montant_ht: 1 }];
    const r = calcTiers(p, tiers, factures, FOURN);
    expect(r.actifs).toBe(0);
    expect(r.passifs).toBe(2);
  });

  it("un nouveau fournisseur sans facture n'est jamais passif", () => {
    const tiers: TiersRow[] = Array.from({ length: 9 }, (_, i) => ({
      id: `n${i}`, nom: `Nouveau ${i}`, created_at: "2026-10-15T09:00:00Z",
    }));
    const r = calcTiers(p, tiers, [], FOURN);
    expect(r.nouveaux).toBe(9);
    expect(r.total).toBe(9);
    expect(r.passifs).toBe(0); // et non 9 — c'était l'incohérence signalée
    expect(r.actifs).toBe(0);
    expect(r.nouveauxSansFacture).toBe(9);
  });

  it("un nouveau qui facture dès sa période est actif, pas « sans facture »", () => {
    const tiers: TiersRow[] = [{ id: "n1", nom: "Neuf", created_at: "2026-10-02T00:00:00Z" }];
    const factures: FactureRow[] = [{ fournisseur_id: "n1", date_facture: "2026-10-20", montant_ht: 400 }];
    const r = calcTiers(p, tiers, factures, FOURN);
    expect(r.nouveaux).toBe(1);
    expect(r.actifs).toBe(1);
    expect(r.nouveauxSansFacture).toBe(0);
    expect(r.passifs).toBe(0);
  });

  it("actifs + passifs + nouveaux sans facture = total (partition exacte)", () => {
    const tiers: TiersRow[] = [
      { id: "a", nom: "Actif ancien", created_at: "2024-01-01T00:00:00Z" },
      { id: "b", nom: "Actif nouveau", created_at: "2026-10-02T00:00:00Z" },
      { id: "c", nom: "Passif", created_at: "2024-01-01T00:00:00Z" },
      { id: "d", nom: "Nouveau sans facture", created_at: "2026-11-01T00:00:00Z" },
      { id: "e", nom: "Supprimé", created_at: "2024-01-01T00:00:00Z", deleted_at: "2026-10-09T00:00:00Z" },
    ];
    const factures: FactureRow[] = [
      { fournisseur_id: "a", date_facture: "2026-10-05", montant_ht: 1 },
      { fournisseur_id: "b", date_facture: "2026-10-06", montant_ht: 1 },
    ];
    const r = calcTiers(p, tiers, factures, FOURN);
    expect(r.total).toBe(4);
    expect(r.actifs).toBe(2);
    expect(r.passifs).toBe(1);
    expect(r.nouveauxSansFacture).toBe(1);
    expect(r.actifs + r.passifs + r.nouveauxSansFacture).toBe(r.total);
  });

  it("passif = ancien tiers sans facture sur la période", () => {
    const tiers: TiersRow[] = [
      { id: "ancien_actif", nom: "A", created_at: "2024-01-01T00:00:00Z" },
      { id: "ancien_passif", nom: "B", created_at: "2024-01-01T00:00:00Z" },
      { id: "nouveau", nom: "C", created_at: "2026-10-20T00:00:00Z" },
    ];
    const factures: FactureRow[] = [
      { fournisseur_id: "ancien_actif", date_facture: "2026-10-05", montant_ht: 500 },
      { fournisseur_id: "ancien_passif", date_facture: "2026-05-05", montant_ht: 500 }, // hors période
    ];
    const r = calcTiers(p, tiers, factures, FOURN);
    expect(r.total).toBe(3);
    expect(r.actifs).toBe(1);
    expect(r.passifs).toBe(1);
    expect(r.nouveaux).toBe(1);
    expect(r.actifs + r.passifs).toBeLessThanOrEqual(r.total);
  });

  it("ignore une facture dont le tiers n'existe plus à la fin de la période", () => {
    const tiers: TiersRow[] = [{ id: "f1", nom: "Parti", created_at: "2024-01-01T00:00:00Z", deleted_at: "2026-10-10T00:00:00Z" }];
    const factures: FactureRow[] = [{ fournisseur_id: "f1", date_facture: "2026-10-05", montant_ht: 800 }];
    const r = calcTiers(p, tiers, factures, FOURN);
    expect(r.total).toBe(0);
    expect(r.actifs).toBe(0);
    expect(r.perdus).toBe(1);
    expect(r.caTotal).toBe(800); // le flux d'achat reste acquis à la période
  });

  it("côté clients, sans colonne de nom, seul client_id rattache", () => {
    const tiers: TiersRow[] = [{ id: "c1", nom: "Client A", created_at: "2024-01-01T00:00:00Z" }];
    const factures: FactureRow[] = [{ client_id: null, date_facture: "2026-10-05", montant_ht: 10 }];
    const r = calcTiers(p, tiers, factures, { tiersKey: "client_id" });
    expect(r.actifs).toBe(0);
    expect(r.passifs).toBe(1);
  });

  it("exclut les acomptes du CA et calcule l'encours à la fin de période", () => {
    const tiers: TiersRow[] = [{ id: "c1", nom: "A", created_at: "2024-01-01T00:00:00Z" }];
    const factures: FactureRow[] = [
      { client_id: "c1", date_facture: "2026-10-05", montant_ht: 1000, montant_restant: 200, statut_paiement: "partielle" },
      { client_id: "c1", date_facture: "2026-10-06", montant_ht: 300, type: "acompte", statut_paiement: "payee" },
      { client_id: "c1", date_facture: "2027-01-05", montant_ht: 999, montant_restant: 999, statut_paiement: "non_payee" }, // après la période
    ];
    const r = calcTiers(p, tiers, factures, { tiersKey: "client_id" });
    expect(r.caTotal).toBe(1000);
    expect(r.encours).toBe(200);
  });

  it("calcule le délai moyen de paiement sur les factures réglées dans la période", () => {
    const tiers: TiersRow[] = [{ id: "c1", nom: "A", created_at: "2024-01-01T00:00:00Z" }];
    const factures: FactureRow[] = [
      { client_id: "c1", date_facture: "2026-10-01", date_paiement: "2026-10-31" }, // 30 j
      { client_id: "c1", date_facture: "2026-10-01", date_paiement: "2026-11-10" }, // 40 j
    ];
    expect(calcTiers(p, tiers, factures, { tiersKey: "client_id" }).delai).toBe(35);
  });

  it("renvoie un délai null sans facture réglée", () => {
    expect(calcTiers(p, [], [], FOURN).delai).toBeNull();
  });
});

describe("detailTiers / trierDetail — drill-down nominatif", () => {
  const p = periodBounds("trimestre", "2026-10-04"); // 01/10 → 31/12

  const tiers: TiersRow[] = [
    { id: "gros", nom: "Gros Passif", created_at: "2024-01-01T00:00:00Z" },
    { id: "petit", nom: "Petit Passif", created_at: "2024-01-01T00:00:00Z" },
    { id: "jamais", nom: "Jamais Facturé", created_at: "2024-01-01T00:00:00Z" },
    { id: "actif", nom: "Actif", created_at: "2024-01-01T00:00:00Z" },
    { id: "neuf", nom: "Tout Neuf", created_at: "2026-10-20T00:00:00Z" },
  ];
  const factures: FactureRow[] = [
    { fournisseur_id: "gros", date_facture: "2026-06-01", montant_ttc: 50000, montant_restant: 40000, statut_paiement: "partielle" },
    { fournisseur_id: "petit", date_facture: "2026-08-15", montant_ttc: 900, montant_restant: 900, statut_paiement: "non_payee" },
    { fournisseur_id: "actif", date_facture: "2026-10-05", montant_ht: 7000, montant_ttc: 8400, montant_restant: 0, statut_paiement: "payee" },
  ];

  it("classe chaque tiers existant dans une et une seule catégorie", () => {
    const rows = detailTiers(p, tiers, factures, FOURN);
    expect(rows).toHaveLength(5);
    const parId = Object.fromEntries(rows.map(r => [r.id, r.categorie]));
    expect(parId).toEqual({
      gros: "passif", petit: "passif", jamais: "passif", actif: "actif", neuf: "nouveau_sans_facture",
    });
    expect(new Set(rows.map(r => r.categorie)).size).toBeLessThanOrEqual(CATEGORIES.length);
  });

  it("porte dette, achats de la période et date de dernière facture", () => {
    const rows = detailTiers(p, tiers, factures, FOURN);
    const gros = rows.find(r => r.id === "gros")!;
    expect(gros.encours).toBe(40000);
    expect(gros.caPeriode).toBe(0); // facture hors période
    expect(gros.derniereFacture).toBe("2026-06-01");

    const actif = rows.find(r => r.id === "actif")!;
    expect(actif.caPeriode).toBe(7000);
    expect(actif.encours).toBe(0); // payée
    expect(rows.find(r => r.id === "jamais")!.derniereFacture).toBeNull();
  });

  it("trie les passifs par dette décroissante, « jamais facturé » en tête à dette nulle", () => {
    const passifs = trierDetail(detailTiers(p, tiers, factures, FOURN).filter(r => r.categorie === "passif"));
    expect(passifs.map(r => r.nom)).toEqual(["Gros Passif", "Petit Passif", "Jamais Facturé"]);
  });

  it("rattache la dette d'une facture sans fournisseur_id via le nom", () => {
    const t: TiersRow[] = [{ id: "f1", nom: "Somadir", created_at: "2024-01-01T00:00:00Z" }];
    const f: FactureRow[] = [
      { fournisseur_id: null, fournisseur_nom: "somadir", date_facture: "2026-09-01", montant_ttc: 1200, montant_restant: 1200, statut_paiement: "non_payee" },
    ];
    const [row] = detailTiers(p, t, f, FOURN);
    expect(row.encours).toBe(1200);
    expect(row.derniereFacture).toBe("2026-09-01");
    expect(row.categorie).toBe("passif"); // facture antérieure à la période
  });

  it("ne mute pas le tableau source", () => {
    const rows = detailTiers(p, tiers, factures, FOURN);
    const avant = rows.map(r => r.id);
    trierDetail(rows);
    expect(rows.map(r => r.id)).toEqual(avant);
  });
});
