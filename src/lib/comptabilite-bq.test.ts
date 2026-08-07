// ============================================================================
// Écritures du journal de banque — et surtout : le retrait d'espèces alimente
// la CAISSE, sur le MÊME compte que les règlements en espèces.
//
// C'est l'invariant qui justifie ces tests : tant que les retraits allaient en
// 5143 (Trésorerie Générale) et les règlements en 51610000, le solde de caisse
// se répartissait sur deux comptes et aucun contrôle ne pouvait boucler.
// ============================================================================

import { describe, it, expect } from "vitest";
import { PCM_MAP, deriveCategorie, genererLignesBQ } from "./comptabilite-bq";
import { COMPTE_CAISSE_DEFAUT, imputationTresorerie } from "./comptes-tresorerie";

const somme = (l: { debit: number; credit: number }[]) => ({
  debit: Math.round(l.reduce((s, x) => s + x.debit, 0) * 100) / 100,
  credit: Math.round(l.reduce((s, x) => s + x.credit, 0) * 100) / 100,
});

describe("retrait d'espèces → compte de caisse", () => {
  it("PCM_MAP impute la caisse, pas 5143", () => {
    expect(PCM_MAP.retrait_especes.code).toBe("51610000");
    expect(PCM_MAP.retrait_especes.code).not.toBe("5143");
    expect(PCM_MAP.retrait_especes.tva).toBe(0);
  });

  it("deriveCategorie rend le même compte pour RETRAIT et pour GAB", () => {
    for (const lib of ["RETRAIT ESPECES GUICHET", "RETRAIT GAB 24/24", "retrait dab casa"]) {
      const r = deriveCategorie(lib, "debit");
      expect(r.categorie).toBe("retrait_especes");
      expect(r.code).toBe(COMPTE_CAISSE_DEFAUT);
    }
  });

  it("l'écriture débite la caisse et crédite la banque", () => {
    const lignes = genererLignesBQ({ libelle: "RETRAIT GAB", type: "debit", montant: 2000 });
    const caisse = lignes.find((l) => l.compte === COMPTE_CAISSE_DEFAUT);
    const banque = lignes.find((l) => l.compte === "5141");
    expect(caisse).toMatchObject({ debit: 2000, credit: 0, categorie: "retrait_especes" });
    expect(banque).toMatchObject({ debit: 0, credit: 2000 });
    const t = somme(lignes);
    expect(t.debit).toBeCloseTo(t.credit, 2);
  });

  it("honore le sous-compte de caisse du dossier", () => {
    const lignes = genererLignesBQ({
      libelle: "RETRAIT ESPECES", type: "debit", montant: 500,
      dossier: { compte_caisse: "51610003" },
    });
    expect(lignes.map((l) => l.compte)).toContain("51610003");
    expect(lignes.map((l) => l.compte)).not.toContain("51610000");
  });

  // Un sous-compte hors rubrique 516 ne doit pas sortir les espèces du poste
  // Caisse : le paramétrage est refusé, pas appliqué.
  it("refuse un sous-compte de caisse hors rubrique 516", () => {
    const lignes = genererLignesBQ({
      libelle: "RETRAIT GAB", type: "debit", montant: 500,
      dossier: { compte_caisse: "5143" },
    });
    expect(lignes.map((l) => l.compte)).toContain(COMPTE_CAISSE_DEFAUT);
    expect(lignes.map((l) => l.compte)).not.toContain("5143");
  });

  // L'invariant central de l'alignement demandé.
  it("retrait et règlement en espèces visent LE MÊME compte", () => {
    const retrait = genererLignesBQ({ libelle: "RETRAIT GAB", type: "debit", montant: 100 })
      .find((l) => l.categorie === "retrait_especes")!.compte;
    expect(retrait).toBe(imputationTresorerie("especes").compte);
  });
});

describe("genererLignesBQ — les autres règles restent inchangées", () => {
  it("transaction orpheline → compte d'attente 4711 / 4712", () => {
    expect(genererLignesBQ({ libelle: "OPERATION INCONNUE", type: "debit", montant: 300 })
      .map((l) => l.compte)).toContain("4711");
    expect(genererLignesBQ({ libelle: "OPERATION INCONNUE", type: "credit", montant: 300 })
      .map((l) => l.compte)).toContain("4712");
  });

  it("facture liée → compte de tiers pour le TTC, jamais de TVA en banque", () => {
    const dette = genererLignesBQ({ libelle: "VIR FOURNISSEUR", type: "debit", montant: 1200, factureLiee: true });
    expect(dette.map((l) => l.compte)).toEqual(["4411", "5141"]);
    const creance = genererLignesBQ({ libelle: "VIR RECU", type: "credit", montant: 1200, factureLiee: true });
    expect(creance.map((l) => l.compte)).toEqual(["3421", "5141"]);
  });

  it("virement interne → 5115, et prime sur le retrait", () => {
    expect(genererLignesBQ({ libelle: "VIR AG EMIS", type: "debit", montant: 800 })
      .map((l) => l.compte)).toContain("5115");
  });

  it("un montant négatif est une SORTIE, quel que soit le champ type", () => {
    const l = genererLignesBQ({ libelle: "RETRAIT GAB", type: "credit", montant: -750 });
    expect(l.find((x) => x.compte === COMPTE_CAISSE_DEFAUT)).toMatchObject({ debit: 750, credit: 0 });
    expect(l.find((x) => x.compte === "5141")).toMatchObject({ debit: 0, credit: 750 });
  });

  it("justificatif éligible EDI → HT + TVA déductible 34552", () => {
    const l = genererLignesBQ({
      libelle: "COMMISSION", type: "debit", montant: 110, categorie: "frais_bancaires",
      justificatif: { compte_pcm: "6347", taux_tva: 10, eligible_edi: true },
    });
    expect(l.map((x) => x.compte)).toEqual(["6347", "34552", "5141"]);
    const t = somme(l);
    expect(t.debit).toBeCloseTo(t.credit, 2);
  });

  it("toute écriture produite est équilibrée", () => {
    const cas = [
      { libelle: "RETRAIT GAB", type: "debit", montant: 1000 },
      { libelle: "CNSS", type: "debit", montant: 4300.55 },
      { libelle: "VIR RECU CLIENT", type: "credit", montant: 9999.99 },
      { libelle: "INCONNU", type: "debit", montant: 0.01 },
    ];
    for (const c of cas) {
      const t = somme(genererLignesBQ(c));
      expect(t.debit).toBeCloseTo(t.credit, 2);
    }
  });
});
