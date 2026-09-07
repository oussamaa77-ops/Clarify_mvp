import { describe, expect, it } from "vitest";
import {
  assertEcrituresRegime, assertLignesAchat, bornesExerciceActif,
  controlerCutoffExercice, controlerEcrituresRegime, controlerJournalOd,
  controlerLignesAchat, controlerTvaOrigine, controlerUniciteReference,
  estTresorerieHorsOd, estTvaExigible, genererEcrituresAchat, genererEcrituresVente,
  genererOdBasculeTva,
} from "@/lib/genererEcritures";
import { bornesExercice } from "@/lib/exercice-comptable";
import { compteLettrable } from "@/services/lettrage";

const D = "11111111-1111-1111-1111-111111111111";
const somme = (l: any[], c: "debit" | "credit") =>
  Math.round(l.reduce((s, x) => s + Number(x[c] || 0), 0) * 100) / 100;

// ─── 1. TVA d'origine : 4458 en vente, 3458 en achat ─────────────────────────

describe("genererEcrituresVente — TVA d'origine sur 4458", () => {
  const lignes = genererEcrituresVente({
    dossier_id: D, facture_id: "f1", reference: "FA-0001", date_facture: "2026-03-10",
    montant_ht: 10000, montant_tva: 2000, montant_ttc: 12000,
    compte_client: "34210001", compte_produit: "7121", type: "facture",
  });

  it("crédite 4458 et jamais 44551", () => {
    expect(lignes.find((l) => l.compte_numero === "4458")).toMatchObject({ credit: 2000, debit: 0 });
    expect(lignes.some((l) => l.compte_numero.startsWith("4455"))).toBe(false);
  });

  it("passe le contrôle de régime", () => {
    expect(controlerEcrituresRegime(lignes).ok).toBe(true);
  });
});

describe("genererEcrituresAchat — TVA d'origine sur 3458", () => {
  const lignes = genererEcrituresAchat({
    dossier_id: D, facture_id: "ff1", date_facture: "2026-03-12",
    montant_ht: 5000, montant_tva: 1000, montant_ttc: 6000,
    compte_charge: "61254", fournisseur_nom: "PAPETERIE SARL", code_auxiliaire: "F0005",
  });

  it("débite la charge, 3458, et crédite le tiers auxiliaire", () => {
    expect(lignes.map((l) => l.compte_numero)).toEqual(["61254", "3458", "44110005"]);
    expect(somme(lignes, "debit")).toBe(6000);
    expect(somme(lignes, "credit")).toBe(6000);
  });

  it("ne mouvemente jamais 34552 à la réception", () => {
    expect(lignes.some((l) => l.compte_numero.startsWith("3455"))).toBe(false);
    expect(controlerLignesAchat(lignes).ok).toBe(true);
  });

  it("retombe sur le collectif 4411 et 6141 sans code ni compte", () => {
    const l = genererEcrituresAchat({
      dossier_id: D, facture_id: "ff2", date_facture: "2026-03-12",
      montant_ht: 100, montant_tva: 20, montant_ttc: 120,
    });
    expect(l[0].compte_numero).toBe("6141");
    expect(l[2].compte_numero).toBe("4411");
  });

  it("omet la ligne de TVA sur un achat exonéré, sans déséquilibrer", () => {
    const l = genererEcrituresAchat({
      dossier_id: D, facture_id: "ff3", date_facture: "2026-03-12",
      montant_ht: 800, montant_tva: 0, montant_ttc: 800,
    });
    expect(l).toHaveLength(2);
    expect(controlerLignesAchat(l).ecart).toBe(0);
  });

  it("refuse un achat sans charge de classe 6", () => {
    const l = genererEcrituresAchat({
      dossier_id: D, facture_id: "ff4", date_facture: "2026-03-12",
      montant_ht: 0, montant_tva: 0, montant_ttc: 0, compte_charge: "4411",
    });
    expect(() => assertLignesAchat(l)).toThrow(/classe 6/);
  });
});

describe("controlerTvaOrigine", () => {
  it("refuse 44551 en VTE et 34552 en ACH", () => {
    expect(controlerTvaOrigine([
      { journal_code: "VTE", compte_numero: "44551", credit: 2000 },
    ]).ok).toBe(false);
    expect(controlerTvaOrigine([
      { journal_code: "ACH", compte_numero: "34552", debit: 1000 },
    ]).ok).toBe(false);
  });

  it("reconnaît aussi la RACINE 4455, employée par les écritures historiques", () => {
    expect(estTvaExigible("4455")).toBe(true);
    expect(estTvaExigible("44551")).toBe(true);
    expect(estTvaExigible("4458")).toBe(false);
  });

  it("laisse passer 44551 hors des journaux de facturation — c'est l'OD de bascule", () => {
    expect(controlerTvaOrigine([
      { journal_code: "OD", compte_numero: "44551", credit: 2000 },
    ]).ok).toBe(true);
  });

  it("ignore une ligne à 0,00 : elle ne déplace aucune TVA", () => {
    expect(controlerTvaOrigine([
      { journal_code: "VTE", compte_numero: "44551", credit: 0, debit: 0 },
    ]).ok).toBe(true);
  });
});

// ─── 2. Bascule au règlement seulement ───────────────────────────────────────

describe("genererOdBasculeTva", () => {
  const base = {
    sens: "client" as const, montantTva: 2000, montantTtc: 12000,
    date: "2026-04-05", reference: "FA-0001",
  };

  it("bascule 4458 → 44551 au prorata de l'encaissement", () => {
    const od = genererOdBasculeTva({ ...base, montantRegle: 6000, journalReglement: "BQ" });
    expect(od).toHaveLength(2);
    expect(od[0]).toMatchObject({ compte_numero: "4458", debit: 1000, credit: 0 });
    expect(od[1]).toMatchObject({ compte_numero: "44551", debit: 0, credit: 1000 });
  });

  it("bascule 34552 → 3458 côté achat", () => {
    const od = genererOdBasculeTva({
      ...base, sens: "fournisseur", montantRegle: 12000, journalReglement: "CAI",
    });
    expect(od[0]).toMatchObject({ compte_numero: "34552", debit: 2000 });
    expect(od[1]).toMatchObject({ compte_numero: "3458", credit: 2000 });
  });

  it("ne bascule RIEN hors d'un journal de règlement", () => {
    for (const j of ["VTE", "ACH", "OD", "AN"]) {
      expect(genererOdBasculeTva({ ...base, montantRegle: 12000, journalReglement: j })).toEqual([]);
    }
  });

  it("plafonne au reste en attente — un échelonnement ne crée pas de TVA", () => {
    const od = genererOdBasculeTva({
      ...base, montantRegle: 12000, journalReglement: "BQ", plafond: 500,
    });
    expect(od[0].debit).toBe(500);
  });

  it("ne produit rien sur une pièce exonérée ni sur un règlement nul", () => {
    expect(genererOdBasculeTva({ ...base, montantTva: 0, montantRegle: 6000 })).toEqual([]);
    expect(genererOdBasculeTva({ ...base, montantRegle: 0 })).toEqual([]);
  });
});

// ─── 3. Trésorerie interdite en OD ───────────────────────────────────────────

describe("controlerJournalOd — 5141 / 5161 interdits", () => {
  it("refuse la banque et la caisse en OD", () => {
    expect(controlerJournalOd([{ journal_code: "OD", compte_numero: "5141", credit: 7500 }]).ok).toBe(false);
    expect(controlerJournalOd([{ journal_code: "OD", compte_numero: "5161", debit: 300 }]).ok).toBe(false);
  });

  it("attrape les SOUS-COMPTES, seule forme réellement écrite", () => {
    expect(estTresorerieHorsOd("51610000")).toBe(true);
    expect(estTresorerieHorsOd("51410001")).toBe(true);
    expect(controlerJournalOd([{ journal_code: "OD", compte_numero: "51610000", credit: 300 }]).ok).toBe(false);
  });

  it("laisse la même trésorerie passer en BQ et en CAI", () => {
    expect(controlerJournalOd([{ journal_code: "BQ", compte_numero: "5141", credit: 7500 }]).ok).toBe(true);
    expect(controlerJournalOd([{ journal_code: "CAI", compte_numero: "51610000", credit: 300 }]).ok).toBe(true);
  });

  it("n'attrape pas 5143 (Trésorerie Générale), qui n'est pas visé", () => {
    expect(estTresorerieHorsOd("5143")).toBe(false);
  });
});

// ─── 4. Lettrage : 3421* et 4411* seulement ──────────────────────────────────

describe("compteLettrable — limité aux comptes de tiers", () => {
  it("accepte 3421x et 4411x", () => {
    expect(compteLettrable("3421")).toMatchObject({ ok: true, sens: "client" });
    expect(compteLettrable("34210002")).toMatchObject({ ok: true, sens: "client" });
    expect(compteLettrable("4411")).toMatchObject({ ok: true, sens: "fournisseur" });
    expect(compteLettrable("44110005")).toMatchObject({ ok: true, sens: "fournisseur" });
  });

  it("refuse les autres comptes de classe 3 et 4, avec un grief explicite", () => {
    for (const c of ["3425", "3427", "4417", "4441", "4456", "3455", "4191"]) {
      const v = compteLettrable(c);
      expect(v.ok, `${c} ne doit pas être lettrable`).toBe(false);
      expect(v.sens).toBeNull();
      expect(v.raison).toBeTruthy();
    }
  });

  it("refuse la trésorerie et les comptes de résultat", () => {
    expect(compteLettrable("5141").ok).toBe(false);
    expect(compteLettrable("7121").ok).toBe(false);
    expect(compteLettrable("6141").ok).toBe(false);
  });
});

// ─── 5. Cut-off d'exercice ───────────────────────────────────────────────────

describe("controlerCutoffExercice", () => {
  const bornes = bornesExercice(2026);

  it("accepte une pièce dans les bornes", () => {
    expect(controlerCutoffExercice([{ date_ecriture: "2026-06-30" }], bornes).ok).toBe(true);
    expect(controlerCutoffExercice([{ date_ecriture: "2026-01-01" }], bornes).ok).toBe(true);
    expect(controlerCutoffExercice([{ date_ecriture: "2026-12-31" }], bornes).ok).toBe(true);
  });

  it("refuse une pièce de 2024 dans l'exercice 2026", () => {
    const v = controlerCutoffExercice([{ date_ecriture: "2024-11-02" }], bornes);
    expect(v.ok).toBe(false);
    expect(v.violations[0]).toContain("2024-11-02");
    expect(v.violations[0]).toContain("2026-01-01");
  });

  it("refuse aussi une pièce postérieure et une pièce sans date", () => {
    expect(controlerCutoffExercice([{ date_ecriture: "2027-01-02" }], bornes).ok).toBe(false);
    expect(controlerCutoffExercice([{ date_ecriture: null }], bornes).ok).toBe(false);
  });

  it("resserre l'ouverture du PREMIER exercice sur la date de début d'activité", () => {
    const b = bornesExerciceActif({ date_debut_activite: "2026-03-12" }, "2026-08-28");
    expect(b.debut).toBe("2026-03-12");
    expect(controlerCutoffExercice([{ date_ecriture: "2026-02-01" }], b).ok).toBe(false);
  });

  it("sans bornes, ne contrôle rien", () => {
    expect(controlerCutoffExercice([{ date_ecriture: "1999-01-01" }], null).ok).toBe(true);
  });
});

// ─── 6. Unicité VTE / ACH ────────────────────────────────────────────────────

describe("controlerUniciteReference", () => {
  it("détecte une référence portée à la fois par une vente et un achat", () => {
    const v = controlerUniciteReference(
      [{ journal_code: "ACH", reference_piece: "F-88" }],
      [{ journal_code: "VTE", reference_piece: "F-88" }],
    );
    expect(v.ok).toBe(false);
    expect(v.collisions).toEqual([{ reference: "F-88", journaux: ["ACH", "VTE"] }]);
  });

  it("tolère la même référence répétée dans le MÊME journal — c'est une pièce", () => {
    expect(controlerUniciteReference([
      { journal_code: "VTE", reference_piece: "FA-1" },
      { journal_code: "VTE", reference_piece: "FA-1" },
      { journal_code: "VTE", reference_piece: "FA-1" },
    ]).ok).toBe(true);
  });

  it("ignore les journaux qui ne sont ni VTE ni ACH", () => {
    expect(controlerUniciteReference([
      { journal_code: "VTE", reference_piece: "FA-1" },
      { journal_code: "OD", reference_piece: "FA-1" },
      { journal_code: "BQ", reference_piece: "FA-1" },
    ]).ok).toBe(true);
  });

  it("peut être dégradée en ALERTE pour le script de reconstruction", () => {
    const v = controlerEcrituresRegime(
      [{ journal_code: "ACH", reference_piece: "F-88", debit: 100 },
       { journal_code: "ACH", reference_piece: "F-88", credit: 100 }],
      { existantes: [{ journal_code: "VTE", reference_piece: "F-88" }], uniciteNonBloquante: true },
    );
    expect(v.ok).toBe(true);
    expect(v.alertes).toHaveLength(1);
    expect(v.collisions).toHaveLength(1);
  });
});

// ─── 7. Le verdict d'ensemble ────────────────────────────────────────────────

describe("assertEcrituresRegime", () => {
  it("laisse passer une vente conforme et datée dans l'exercice", () => {
    const lignes = genererEcrituresVente({
      dossier_id: D, facture_id: "f1", reference: "FA-0002", date_facture: "2026-05-04",
      montant_ht: 1000, montant_tva: 200, montant_ttc: 1200,
      compte_client: "3421", compte_produit: "7111", type: "facture",
    });
    expect(() => assertEcrituresRegime(lignes, { bornes: bornesExercice(2026) })).not.toThrow();
  });

  it("refuse une pièce déséquilibrée", () => {
    expect(() => assertEcrituresRegime([
      { journal_code: "VTE", compte_numero: "3421", debit: 1200 },
      { journal_code: "VTE", compte_numero: "7111", credit: 1000 },
    ])).toThrow(/déséquilibrée/);
  });

  it("cumule les griefs plutôt que de s'arrêter au premier", () => {
    const v = controlerEcrituresRegime(
      [{ journal_code: "VTE", compte_numero: "44551", date_ecriture: "2024-01-01", credit: 200 }],
      { bornes: bornesExercice(2026) },
    );
    expect(v.violations.length).toBeGreaterThanOrEqual(3);   // TVA + cut-off + équilibre
  });
});
