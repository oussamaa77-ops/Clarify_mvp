import { describe, it, expect } from "vitest";
import {
  suggestAccount,
  suggestAccountWithAi,
  normaliser,
  COMPTE_CHARGE_DEFAUT,
  COMPTE_PRODUIT_DEFAUT,
} from "./categorization-engine";

describe("normaliser", () => {
  it("retire accents, casse et ponctuation", () => {
    expect(normaliser("Électricité")).toBe("electricite");
    expect(normaliser("Rép. & Entretien")).toBe("rep entretien");
    expect(normaliser("  MAROC   TELECOM ")).toBe("maroc telecom");
  });
  it("tolère null/undefined", () => {
    expect(normaliser(null)).toBe("");
    expect(normaliser(undefined)).toBe("");
  });
});

describe("Règle 1 — priorité du compte par défaut du tiers", () => {
  it("le compte du tiers prime sur un mot-clé qui pointerait ailleurs", () => {
    // Description « téléphone » → 61455 par mots-clés, MAIS le tiers impose 6136.
    const s = suggestAccount({
      compteDefautTiers: "6136",
      description: "Abonnement téléphone fixe",
      sens: "charge",
    });
    expect(s.compte).toBe("6136");
    expect(s.source).toBe("tiers");
    expect(s.confiance).toBe("haute");
  });

  it("prime aussi sur le fallback sectoriel", () => {
    const s = suggestAccount({
      compteDefautTiers: "7111",
      secteurActivite: "Services IT",
      sens: "produit",
    });
    expect(s.compte).toBe("7111");
    expect(s.source).toBe("tiers");
  });

  it("un compte tiers vide/espaces est ignoré (on passe aux règles suivantes)", () => {
    const s = suggestAccount({ compteDefautTiers: "   ", description: "loyer bureau" });
    expect(s.source).toBe("mots_cles");
    expect(s.compte).toBe("6131");
  });
});

describe("Règle 2 — dictionnaire de mots-clés (codes PCM Maroc)", () => {
  const cas: Array<[string, string]> = [
    ["Facture Maroc Telecom - abonnement internet", "61455"],
    ["Loyer du local commercial", "6131"],
    ["Prime d'assurance RC Pro", "6134"],
    ["Honoraires expert comptable", "6136"],
    ["Consommation électricité ONEE", "61252"],
    ["Facture d'eau REDAL", "61251"],
    ["Plein de gasoil station Afriquia", "61411"],
    ["Entretien et réparation véhicule", "6133"],
    ["Transport et livraison de marchandises", "6142"],
    ["Note de restaurant - déplacement mission", "6143"],
    ["Campagne publicité marketing", "6144"],
    ["Achat fournitures de bureau et papeterie", "61254"],
    ["Frais bancaires - agios trimestriels", "6147"],
  ];
  it.each(cas)("« %s » → %s", (description, compte) => {
    const s = suggestAccount({ description, sens: "charge" });
    expect(s.compte).toBe(compte);
    expect(s.source).toBe("mots_cles");
  });

  it("auto-complétion exacte : « Maroc Telecom » via le nom du tiers seul", () => {
    const s = suggestAccount({ nomTiers: "MAROC TELECOM SA", description: "" });
    expect(s.compte).toBe("61455");
    expect(s.motCle).toBeTruthy();
  });

  it("un mot-clé de charge ne s'applique pas à une vente", () => {
    // « loyer » est une règle de sens « charge » : en sens « produit » elle est ignorée.
    const s = suggestAccount({ description: "loyer encaissé", sens: "produit" });
    expect(s.source).not.toBe("mots_cles");
  });
});

describe("Règle 3 — fallback sectoriel", () => {
  it("charge : Commerce / Négoce → 6111 (marchandises)", () => {
    const s = suggestAccount({ description: "achat divers", secteurActivite: "Commerce / Négoce" });
    expect(s.compte).toBe("6111");
    expect(s.source).toBe("secteur");
    expect(s.confiance).toBe("moyenne");
  });

  it("produit : Services IT → 7124 (prestations de services)", () => {
    const s = suggestAccount({ description: "prestation", secteurActivite: "Services IT", sens: "produit" });
    expect(s.compte).toBe("7124");
    expect(s.source).toBe("secteur");
  });

  it("BTP → charge 6121 / produit 7121", () => {
    expect(suggestAccount({ secteurActivite: "BTP", sens: "charge" }).compte).toBe("6121");
    expect(suggestAccount({ secteurActivite: "BTP", sens: "produit" }).compte).toBe("7121");
  });
});

describe("Défaut générique — rétro-compatibilité", () => {
  it("aucune règle → compte de charge historique 6141 (comme l'ancienne saisie)", () => {
    const s = suggestAccount({ description: "objet non catégorisable xyz" });
    expect(s.compte).toBe(COMPTE_CHARGE_DEFAUT);
    expect(s.compte).toBe("6141");
    expect(s.source).toBe("defaut");
    expect(s.confiance).toBe("faible");
  });

  it("aucune règle en vente → 7111", () => {
    const s = suggestAccount({ description: "xyz", sens: "produit" });
    expect(s.compte).toBe(COMPTE_PRODUIT_DEFAUT);
    expect(s.compte).toBe("7111");
  });

  it("entrée totalement vide → défaut, jamais null", () => {
    const s = suggestAccount({});
    expect(s.compte).toBe("6141");
    expect(s.source).toBe("defaut");
  });
});

describe("Rétro-compatibilité saisie manuelle ↔ OCR", () => {
  // Le même tiers/libellé doit produire le MÊME compte quel que soit le canal :
  // la saisie manuelle passe `description`, l'OCR passe le libellé extrait —
  // même entrée normalisée ⇒ même sortie déterministe.
  it("saisie manuelle et OCR convergent sur le même compte", () => {
    const manuel = suggestAccount({ description: "Abonnement Internet Maroc Telecom" });
    const ocr = suggestAccount({ nomTiers: "MAROC TELECOM", description: "abonnement internet" });
    expect(manuel.compte).toBe(ocr.compte);
    expect(manuel.compte).toBe("61455");
  });

  it("le compte par défaut d'un tiers connu court-circuite tout le reste (idempotent)", () => {
    const input = { compteDefautTiers: "6135", description: "n'importe quoi", nomTiers: "loyer" } as const;
    expect(suggestAccount(input).compte).toBe("6135");
    expect(suggestAccount(input).compte).toBe(suggestAccount(input).compte);
  });
});

describe("suggestAccountWithAi — fallback IA optionnel", () => {
  it("n'appelle PAS l'IA quand une règle métier a tranché", async () => {
    let appele = false;
    const ai = async () => { appele = true; return "9999"; };
    const s = await suggestAccountWithAi({ description: "loyer local" }, ai);
    expect(s.compte).toBe("6131");     // mots-clés
    expect(appele).toBe(false);
  });

  it("laisse l'IA affiner uniquement le fallback", async () => {
    const ai = async () => "6135";
    const s = await suggestAccountWithAi({ description: "objet flou", secteurActivite: "Services IT" }, ai);
    expect(s.compte).toBe("6135");
    expect(s.source).toBe("secteur");
  });

  it("absorbe une erreur IA et garde la suggestion déterministe", async () => {
    const ai = async () => { throw new Error("timeout"); };
    const s = await suggestAccountWithAi({ description: "objet flou" }, ai);
    expect(s.compte).toBe("6141");     // défaut conservé
  });

  it("sans suggesteur IA, renvoie la suggestion déterministe", async () => {
    const s = await suggestAccountWithAi({ description: "honoraires avocat" });
    expect(s.compte).toBe("6136");
  });
});

// ─── Règle 1b — compte MÉMORISÉ pour le tiers (mémoire ICE/libellé) ───────────
describe("suggestAccount — Règle 1b : compte mémorisé du tiers", () => {
  it("rend le compte mémorisé (auxiliaire) plutôt qu'un compte générique", () => {
    const s = suggestAccount({ sens: "charge", compteMemoireTiers: "44110005", nomTiers: "ALPHA SARL" });
    expect(s.compte).toBe("44110005");
    expect(s.source).toBe("memoire_tiers");
    expect(s.confiance).toBe("haute");
  });

  it("s'efface devant le compte CONFIGURÉ sur le tiers (Règle 1a)", () => {
    const s = suggestAccount({ sens: "charge", compteDefautTiers: "61455", compteMemoireTiers: "44110005" });
    expect(s.compte).toBe("61455");
    expect(s.source).toBe("tiers");
  });

  it("passe DEVANT les mots-clés et le secteur", () => {
    const s = suggestAccount({
      sens: "charge", compteMemoireTiers: "44110005",
      description: "Abonnement internet fibre", nomTiers: "MAROC TELECOM", secteurActivite: "Services IT",
    });
    expect(s.compte).toBe("44110005");
  });

  it("une valeur vide ou blanche est ignorée (pas de compte vide imposé)", () => {
    expect(suggestAccount({ sens: "charge", compteMemoireTiers: "   " }).source).toBe("defaut");
    expect(suggestAccount({ sens: "produit", compteMemoireTiers: null }).compte).toBe(COMPTE_PRODUIT_DEFAUT);
  });

  it("l'IA ne peut pas écraser un compte mémorisé", async () => {
    const s = await suggestAccountWithAi(
      { sens: "charge", compteMemoireTiers: "44110005" },
      async () => "6999",
    );
    expect(s.compte).toBe("44110005");
  });
});
