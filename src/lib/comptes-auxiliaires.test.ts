import { describe, it, expect } from "vitest";
import {
  compteTiersAuxiliaire, estCompteDeTiers, collectifDeCompte, suffixeAuxiliaire,
  COMPTE_COLLECTIF,
} from "./comptes-auxiliaires";
import { nextCodeAuxiliaire } from "./sage-export";

describe("compteTiersAuxiliaire — dérivation du compte de tiers", () => {
  it("fournisseur F0005 → 44110005 (l'exemple de référence)", () => {
    expect(compteTiersAuxiliaire("fournisseur", "F0005")).toBe("44110005");
  });

  it("client C0002 → 34210002", () => {
    expect(compteTiersAuxiliaire("client", "C0002")).toBe("34210002");
  });

  it("sans code auxiliaire → compte COLLECTIF (comportement historique préservé)", () => {
    expect(compteTiersAuxiliaire("fournisseur", null)).toBe("4411");
    expect(compteTiersAuxiliaire("fournisseur", "")).toBe("4411");
    expect(compteTiersAuxiliaire("client", undefined)).toBe("3421");
    expect(compteTiersAuxiliaire("client", "   ")).toBe("3421");
  });

  it("tolère les saisies libres du code", () => {
    expect(compteTiersAuxiliaire("fournisseur", "f-0005")).toBe("44110005");
    expect(compteTiersAuxiliaire("fournisseur", " F 0005 ")).toBe("44110005");
    expect(compteTiersAuxiliaire("fournisseur", "5")).toBe("44110005");
    expect(compteTiersAuxiliaire("client", "FOURN 0002")).toBe("34210002");
  });

  it("un compte DÉJÀ complet est conservé tel quel (pas de double préfixage)", () => {
    expect(compteTiersAuxiliaire("fournisseur", "44110005")).toBe("44110005");
    expect(compteTiersAuxiliaire("client", "34210002")).toBe("34210002");
  });

  it("un code sans chiffre utile retombe sur le collectif", () => {
    expect(compteTiersAuxiliaire("fournisseur", "F")).toBe("4411");
    expect(compteTiersAuxiliaire("fournisseur", "F0000")).toBe("4411");
  });

  it("ne TRONQUE pas un code plus long que 4 chiffres", () => {
    expect(compteTiersAuxiliaire("fournisseur", "F123456")).toBe("4411123456");
  });

  it("le compte auxiliaire commence TOUJOURS par son collectif (clé de la rétro-compat)", () => {
    for (const code of ["F0005", "C0002", "F1", "C9999", null]) {
      expect(compteTiersAuxiliaire("fournisseur", code).startsWith("4411")).toBe(true);
      expect(compteTiersAuxiliaire("client", code).startsWith("3421")).toBe(true);
    }
  });

  it("s'enchaîne avec la séquence de codes de l'export Sage", () => {
    const suivant = nextCodeAuxiliaire("fournisseur", ["F0001", "F0004"]);   // → F0005
    expect(compteTiersAuxiliaire("fournisseur", suivant)).toBe("44110005");
  });

  it("deux tiers distincts → deux comptes auxiliaires distincts", () => {
    const a = compteTiersAuxiliaire("fournisseur", "F0005");
    const b = compteTiersAuxiliaire("fournisseur", "F0006");
    expect(a).not.toBe(b);
  });
});

describe("helpers de lecture du compte de tiers", () => {
  it("estCompteDeTiers reconnaît collectif ET auxiliaire", () => {
    expect(estCompteDeTiers("4411", "fournisseur")).toBe(true);
    expect(estCompteDeTiers("44110005", "fournisseur")).toBe(true);
    expect(estCompteDeTiers("34210002", "fournisseur")).toBe(false);
    expect(estCompteDeTiers("6141", "fournisseur")).toBe(false);
  });

  it("collectifDeCompte regroupe l'auxiliaire sous sa racine", () => {
    expect(collectifDeCompte("44110005")).toBe("4411");
    expect(collectifDeCompte("34210002")).toBe("3421");
    expect(collectifDeCompte("61455")).toBeNull();
  });

  it("suffixeAuxiliaire isole la part tiers", () => {
    expect(suffixeAuxiliaire("44110005")).toBe("0005");
    expect(suffixeAuxiliaire("4411")).toBeNull();
    expect(suffixeAuxiliaire("6141")).toBeNull();
  });

  it("les collectifs exposés sont les comptes PCM marocains", () => {
    expect(COMPTE_COLLECTIF).toEqual({ client: "3421", fournisseur: "4411" });
  });
});

// ─── Cohérence de la PIÈCE comptable (les 3 lignes attendues) ────────────────
// On rejoue ici la structure produite par la saisie d'achat et par la validation
// de vente, pour verrouiller : ligne 1 charge/produit, ligne 2 TVA, ligne 3 tiers
// AUXILIAIRE — et l'équilibre débit = crédit.
describe("structure des écritures : charge/produit + TVA + tiers auxiliaire", () => {
  const piece = (l: { compte: string; debit?: number; credit?: number }[]) => ({
    lignes: l,
    debit: l.reduce((s, x) => s + (x.debit ?? 0), 0),
    credit: l.reduce((s, x) => s + (x.credit ?? 0), 0),
  });

  it("ACHAT : 6xxx HT au débit, 34552 TVA au débit, 4411xxxx TTC au crédit", () => {
    const ht = 1000, tva = 200, ttc = 1200;
    const p = piece([
      { compte: "6111", debit: ht },
      { compte: "34552", debit: tva },
      { compte: compteTiersAuxiliaire("fournisseur", "F0005"), credit: ttc },
    ]);
    expect(p.lignes.map((l) => l.compte)).toEqual(["6111", "34552", "44110005"]);
    expect(p.debit).toBe(p.credit);
    expect(p.lignes[0].compte.startsWith("6")).toBe(true);        // charge
    expect(p.lignes[2].compte.startsWith("4411")).toBe(true);     // collectif fournisseur
    expect(p.lignes[2].compte).not.toBe("4411");                  // …mais auxiliaire
  });

  it("VENTE : 3421xxxx TTC au débit, 7xxx HT au crédit, 44551 TVA au crédit", () => {
    const ht = 1000, tva = 200, ttc = 1200;
    const p = piece([
      { compte: compteTiersAuxiliaire("client", "C0002"), debit: ttc },
      { compte: "7124", credit: ht },
      { compte: "44551", credit: tva },
    ]);
    expect(p.lignes.map((l) => l.compte)).toEqual(["34210002", "7124", "44551"]);
    expect(p.debit).toBe(p.credit);
    expect(p.lignes[1].compte.startsWith("7")).toBe(true);        // produit
    expect(p.lignes[0].compte).not.toBe("3421");
  });

  it("le RÈGLEMENT solde le MÊME compte auxiliaire que la vente", () => {
    const compteVente = compteTiersAuxiliaire("client", "C0002");
    const compteReglement = compteTiersAuxiliaire("client", "C0002");
    expect(compteReglement).toBe(compteVente);   // sinon les 2 comptes restent ouverts
  });

  it("tiers sans code auxiliaire : la pièce reste celle d'avant (4411 / 3421)", () => {
    expect(compteTiersAuxiliaire("fournisseur", null)).toBe("4411");
    expect(compteTiersAuxiliaire("client", null)).toBe("3421");
  });
});
