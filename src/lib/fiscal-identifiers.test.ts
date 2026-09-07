import { describe, expect, it } from "vitest";
import {
  normaliserIdentifiant,
  normaliserIdentites,
  validerEmission,
  validerIce,
  validerIf,
  validerPatente,
  validerRc,
} from "./fiscal-identifiers";

// ICE plausible : 15 chiffres, ni constants ni en suite.
const ICE_OK = "001547896000073";
const ICE_OK_2 = "002748193000041";

describe("normaliserIdentifiant", () => {
  it("retire les séparateurs de recopie manuelle", () => {
    expect(normaliserIdentifiant(" 001 547 896 000 073 ")).toBe(ICE_OK);
    expect(normaliserIdentifiant("001-547-896-000-073")).toBe(ICE_OK);
    expect(normaliserIdentifiant("001.547.896.000.073")).toBe(ICE_OK);
  });

  it("rend une chaîne vide sur null/undefined", () => {
    expect(normaliserIdentifiant(null)).toBe("");
    expect(normaliserIdentifiant(undefined)).toBe("");
  });
});

describe("validerIce", () => {
  it("accepte 15 chiffres, y compris saisis avec des espaces", () => {
    expect(validerIce(ICE_OK)).toEqual({ valide: true, normalise: ICE_OK });
    expect(validerIce("001 547 896 000 073").valide).toBe(true);
  });

  it("refuse une longueur autre que 15", () => {
    expect(validerIce("00154789600007").code).toBe("LONGUEUR"); // 14
    expect(validerIce("0015478960000731").code).toBe("LONGUEUR"); // 16
  });

  it("refuse tout caractère non numérique", () => {
    expect(validerIce("00154789600007A").code).toBe("NON_NUMERIQUE");
  });

  it("refuse l'absence", () => {
    expect(validerIce("").code).toBe("MANQUANT");
    expect(validerIce(null).code).toBe("MANQUANT");
  });

  // Ces valeurs ont la bonne FORME : sans ce garde-fou elles partiraient à la
  // DGI et reviendraient en rejet, la facture étant alors à réémettre.
  it("refuse les séquences dégénérées de bonne longueur", () => {
    expect(validerIce("000000000000000").code).toBe("SEQUENCE_INVALIDE");
    expect(validerIce("111111111111111").code).toBe("SEQUENCE_INVALIDE");
    expect(validerIce("123456789012345").code).toBe("SEQUENCE_INVALIDE");
    expect(validerIce("543210987654321").code).toBe("SEQUENCE_INVALIDE");
  });
});

describe("validerIf", () => {
  it("accepte 6 à 9 chiffres", () => {
    expect(validerIf("40218963").valide).toBe(true);
    expect(validerIf("152047").valide).toBe(true);
    expect(validerIf("402189635").valide).toBe(true);
  });

  it("refuse hors bornes", () => {
    expect(validerIf("40218").code).toBe("LONGUEUR");
    expect(validerIf("4021896351").code).toBe("LONGUEUR");
  });

  it("refuse les séquences dégénérées", () => {
    expect(validerIf("1234567").code).toBe("SEQUENCE_INVALIDE");
  });
});

describe("validerRc", () => {
  it("ne garde que la partie numérique de tête", () => {
    // Forme très courante en en-tête de facture marocaine.
    expect(validerRc("123456/Casablanca")).toEqual({ valide: true, normalise: "123456" });
    expect(validerRc("RC 48521").normalise).toBe("");
  });

  it("refuse au-delà de 12 chiffres", () => {
    expect(validerRc("1234567890123").code).toBe("LONGUEUR");
  });
});

describe("validerPatente", () => {
  it("accepte 6 à 10 chiffres", () => {
    expect(validerPatente("30185274").valide).toBe(true);
  });

  it("refuse trop court", () => {
    expect(validerPatente("3018").code).toBe("LONGUEUR");
  });
});

describe("validerEmission", () => {
  const completes = {
    ice_vendeur: ICE_OK,
    if_vendeur: "40218963",
    rc_vendeur: "123456",
    patente_vendeur: "30185274",
    ice_acheteur: ICE_OK_2,
    if_acheteur: "51907432",
  };

  it("valide un jeu complet sans réserve", () => {
    const r = validerEmission(completes);
    expect(r.ok).toBe(true);
    expect(r.erreurs).toEqual([]);
    expect(r.avertissements).toEqual([]);
  });

  it("bloque sur ICE ou IF vendeur — la facture n'a pas d'émetteur", () => {
    const r = validerEmission({ ...completes, ice_vendeur: "123", if_vendeur: null });
    expect(r.ok).toBe(false);
    expect(r.erreurs.map((e) => e.champ)).toEqual(["ice_vendeur", "if_vendeur"]);
  });

  it("bloque sur ICE acheteur manquant en B2B", () => {
    const r = validerEmission({ ...completes, ice_acheteur: null });
    expect(r.ok).toBe(false);
    expect(r.erreurs.map((e) => e.champ)).toContain("ice_acheteur");
  });

  // Sans cette tolérance, aucune vente à particulier ne pourrait être émise.
  it("tolère l'absence d'ICE acheteur en B2C", () => {
    const r = validerEmission({ ...completes, ice_acheteur: null, if_acheteur: null }, { b2c: true });
    expect(r.ok).toBe(true);
  });

  it("mais refuse en B2C un ICE acheteur saisi et faux", () => {
    const r = validerEmission({ ...completes, ice_acheteur: "42" }, { b2c: true });
    expect(r.ok).toBe(false);
    expect(r.erreurs.map((e) => e.champ)).toContain("ice_acheteur");
  });

  // RC et patente sont obligatoires sur le papier mais ne provoquent pas de
  // rejet DGI : bloquer dessus empêcherait d'émettre une facture valide.
  it("n'émet qu'un avertissement sur RC et patente absents", () => {
    const r = validerEmission({ ...completes, rc_vendeur: null, patente_vendeur: null });
    expect(r.ok).toBe(true);
    expect(r.avertissements.map((a) => a.champ)).toEqual(["rc_vendeur", "patente_vendeur"]);
  });

  it("porte un message lisible sur chaque anomalie", () => {
    const r = validerEmission({ ...completes, ice_vendeur: "0015478960000" });
    expect(r.erreurs[0].message).toBe("ICE du vendeur doit compter exactement 15 chiffres.");
  });
});

describe("normaliserIdentites", () => {
  // Le hash d'inaltérabilité est calculé sur ces valeurs : si la forme dépendait
  // des espaces tapés, deux saisies du même ICE donneraient deux hashs.
  it("rend la forme canonique, indépendante de la frappe", () => {
    expect(
      normaliserIdentites({
        ice_vendeur: "001 547 896 000 073",
        if_vendeur: "40-218-963",
        rc_vendeur: "123456/Rabat",
        patente_vendeur: "",
        ice_acheteur: null,
        if_acheteur: undefined,
      }),
    ).toEqual({
      ice_vendeur: ICE_OK,
      if_vendeur: "40218963",
      rc_vendeur: "123456",
      patente_vendeur: null,
      ice_acheteur: null,
      if_acheteur: null,
    });
  });
});
