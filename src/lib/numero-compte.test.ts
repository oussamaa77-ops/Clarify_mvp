import { describe, it, expect } from "vitest";
import {
  LARGEUR_COMPTE, LARGEUR_MIN_COMPTE,
  normaliserNumeroCompte, numeroSignificatif, memeCompte,
  estSousCompteDe, classeDeCompte, normaliserComptesLignes,
} from "./numero-compte";
import { estTvaExigible, estTresorerieHorsOd, RACINES_TVA_EXIGIBLE } from "./genererEcritures";
import { compteTiersAuxiliaire, collectifDeCompte, estCompteDeTiers } from "./comptes-auxiliaires";
import { estCompteDeBilan, estCompteDeGestion } from "./a-nouveaux";

describe("normaliserNumeroCompte", () => {
  it("complète à droite sur 8 chiffres — les 3 cas du cahier des charges", () => {
    expect(normaliserNumeroCompte("5141")).toBe("51410000");
    expect(normaliserNumeroCompte("34552")).toBe("34552000");
    expect(normaliserNumeroCompte("4458")).toBe("44580000");
  });

  it("laisse intact ce qui est déjà canonique", () => {
    expect(normaliserNumeroCompte("44110005")).toBe("44110005");
    expect(normaliserNumeroCompte("51610000")).toBe("51610000");
  });

  it("est idempotente", () => {
    for (const c of ["4458", "44551", "44110005", "3421", "1161"]) {
      expect(normaliserNumeroCompte(normaliserNumeroCompte(c))).toBe(normaliserNumeroCompte(c));
    }
  });

  it("ne tronque JAMAIS un compte plus long que 8", () => {
    expect(normaliserNumeroCompte("441100051")).toBe("441100051");
  });

  it("ne retouche pas un code non numérique, et tolère le vide", () => {
    expect(normaliserNumeroCompte("F0005")).toBe("F0005");
    expect(normaliserNumeroCompte("  4458  ")).toBe("44580000");
    expect(normaliserNumeroCompte("")).toBe("");
    expect(normaliserNumeroCompte(null)).toBe("");
    expect(normaliserNumeroCompte(undefined)).toBe("");
  });
});

describe("numeroSignificatif", () => {
  it("retire les zéros de complément", () => {
    expect(numeroSignificatif("44580000")).toBe("4458");
    expect(numeroSignificatif("34552000")).toBe("34552");
    expect(numeroSignificatif("51610000")).toBe("5161");
  });

  it("ne descend pas sous la longueur PCM minimale", () => {
    expect(numeroSignificatif("10000000")).toBe("1000");
    expect(numeroSignificatif("1000")).toBe("1000");
    expect(numeroSignificatif("1000")).toHaveLength(LARGEUR_MIN_COMPTE);
  });

  it("préserve un compte auxiliaire, qui ne finit pas par un zéro de complément", () => {
    expect(numeroSignificatif("44110005")).toBe("44110005");
  });

  it("annule le padding : significatif de la forme canonique rend la forme courte", () => {
    for (const c of ["4458", "44551", "34552", "5141", "1161", "4712"]) {
      expect(numeroSignificatif(normaliserNumeroCompte(c))).toBe(c);
    }
  });
});

describe("memeCompte", () => {
  it("réconcilie les longueurs mêlées de la base", () => {
    expect(memeCompte("5141", "51410000")).toBe(true);
    expect(memeCompte("34552", "34552000")).toBe(true);
    expect(memeCompte("44110005", "44110005")).toBe(true);
  });

  it("ne confond pas un collectif complété et son auxiliaire", () => {
    expect(memeCompte("4411", "44110005")).toBe(false);
    expect(memeCompte("44110000", "44110005")).toBe(false);
  });

  it("un compte vide n'égale rien, pas même un autre vide", () => {
    expect(memeCompte("", "")).toBe(false);
    expect(memeCompte(null, undefined)).toBe(false);
  });
});

describe("estSousCompteDe", () => {
  it("reconnaît la racine sur la forme canonique", () => {
    expect(estSousCompteDe("44551000", "4455")).toBe(true);
    expect(estSousCompteDe("44110005", "4411")).toBe(true);
    expect(estSousCompteDe("47120000", "47")).toBe(true);
  });

  it("distingue les racines voisines", () => {
    expect(estSousCompteDe("34552000", "4455")).toBe(false);
    expect(estSousCompteDe("44580000", "4455")).toBe(false);
  });
});

describe("classeDeCompte", () => {
  it("rend le premier chiffre, padding ou non", () => {
    expect(classeDeCompte("6141")).toBe("6");
    expect(classeDeCompte("61410000")).toBe("6");
    expect(classeDeCompte("")).toBe("");
    expect(classeDeCompte("X1")).toBe("");
  });
});

describe("normaliserComptesLignes", () => {
  it("normalise les deux conventions de nommage du projet", () => {
    const out = normaliserComptesLignes([
      { compte_numero: "4458", debit: 100 },
      { compte: "5141", credit: 100 },
    ] as any[]);
    expect(out[0].compte_numero).toBe("44580000");
    expect(out[1].compte).toBe("51410000");
  });

  it("préserve les autres champs et n'altère pas l'entrée", () => {
    const entree = [{ compte_numero: "34552", libelle: "TVA", debit: 12.5 }];
    const out = normaliserComptesLignes(entree);
    expect(out[0]).toMatchObject({ libelle: "TVA", debit: 12.5 });
    expect(entree[0].compte_numero).toBe("34552");
  });

  it("tolère un lot vide ou des lignes sans compte", () => {
    expect(normaliserComptesLignes([])).toEqual([]);
    expect(normaliserComptesLignes([{ libelle: "x" }] as any[])).toEqual([{ libelle: "x" }]);
  });
});

// ── Le contrat qui rend la normalisation SÛRE ────────────────────────────────
// Tout le code métier détecte par racine. Si le padding cassait une seule de
// ces lectures, il faudrait le retirer : ces tests sont la garantie qu'il ne le
// fait pas, et ils échoueraient bruyamment si une détection repassait à
// l'égalité stricte.
describe("le padding ne casse aucune détection existante", () => {
  const canonique = (c: string) => normaliserNumeroCompte(c);

  it("TVA exigible : détection par racine 4455 / 3455 préservée", () => {
    expect(estTvaExigible(canonique("44551"))).toBe(true);
    expect(estTvaExigible(canonique("34552"))).toBe(true);
    for (const racine of RACINES_TVA_EXIGIBLE) {
      expect(estTvaExigible(canonique(racine))).toBe(true);
    }
    // La TVA d'ATTENTE reste hors du verrou, padding ou non.
    expect(estTvaExigible(canonique("4458"))).toBe(false);
    expect(estTvaExigible(canonique("3458"))).toBe(false);
    // Et le 4456 reste hors estTvaExigible (cf. mémoire tva-pcm-comptes-unifies).
    expect(estTvaExigible(canonique("4456"))).toBe(false);
  });

  it("trésorerie interdite en OD : 5141x / 5161x préservés", () => {
    expect(estTresorerieHorsOd(canonique("5141"))).toBe(true);
    expect(estTresorerieHorsOd(canonique("5161"))).toBe(true);
    expect(estTresorerieHorsOd("51610000")).toBe(true);
    expect(estTresorerieHorsOd(canonique("5143"))).toBe(false);
  });

  it("lettrage et comptabilité auxiliaire : le collectif reste le préfixe", () => {
    expect(canonique("4411").startsWith("4411")).toBe(true);
    expect(canonique("3421").startsWith("3421")).toBe(true);
    expect(estCompteDeTiers(canonique("4411"), "fournisseur")).toBe(true);
    expect(estCompteDeTiers("44110005", "fournisseur")).toBe(true);
    expect(collectifDeCompte(canonique("4411"))).toBe("4411");
    expect(collectifDeCompte(canonique("3421"))).toBe("3421");
    // Un compte auxiliaire est déjà canonique : le padding ne le déplace pas.
    expect(canonique(compteTiersAuxiliaire("fournisseur", "F0005"))).toBe("44110005");
  });

  it("classes de bilan et de gestion : inchangées", () => {
    for (const c of ["1161", "3421", "4411", "5141", "4712"]) {
      expect(estCompteDeBilan(canonique(c))).toBe(true);
      expect(estCompteDeGestion(canonique(c))).toBe(false);
    }
    for (const c of ["6141", "7111"]) {
      expect(estCompteDeGestion(canonique(c))).toBe(true);
      expect(estCompteDeBilan(canonique(c))).toBe(false);
    }
  });

  it("toute forme canonique fait bien 8 chiffres", () => {
    for (const c of ["1161", "3421", "4411", "5141", "4712", "44551", "34552", "61254"]) {
      expect(normaliserNumeroCompte(c)).toHaveLength(LARGEUR_COMPTE);
    }
  });
});
