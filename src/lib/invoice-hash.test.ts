import { describe, expect, it } from "vitest";
import {
  calculerHashFacture,
  chaineCanonique,
  dateCanonique,
  montantCanonique,
  numeroCanonique,
  verifierHashFacture,
  HASH_VERSION,
  type ChampsHash,
} from "./invoice-hash";

const SECRET = "clef-de-test-suffisamment-longue";

const FACTURE: ChampsHash = {
  numero: "FA-2026-0042",
  date_facture: "2026-08-17",
  ice_vendeur: "001547896000073",
  ice_acheteur: "002748193000041",
  montant_ttc: 19070,
};

describe("dateCanonique", () => {
  it("accepte l'ISO et le format français", () => {
    expect(dateCanonique("2026-08-17")).toBe("2026-08-17");
    expect(dateCanonique("17/08/2026")).toBe("2026-08-17");
    expect(dateCanonique("2026-08-17T14:32:00.000Z")).toBe("2026-08-17");
  });

  // `toISOString()` bascule en UTC : une date née à minuit heure locale rendrait
  // la veille, et l'empreinte porterait un jour de décalage avec la facture.
  it("lit les composantes LOCALES d'un objet Date", () => {
    expect(dateCanonique(new Date(2026, 7, 17, 0, 30))).toBe("2026-08-17");
    expect(dateCanonique(new Date(2026, 0, 1, 23, 59))).toBe("2026-01-01");
  });

  it("refuse ce qu'elle ne sait pas lire", () => {
    expect(() => dateCanonique("hier")).toThrow(/non reconnue/);
    expect(() => dateCanonique(new Date("n'importe quoi"))).toThrow(/invalide/);
  });
});

describe("numeroCanonique", () => {
  it("compacte les espaces et passe en majuscules", () => {
    expect(numeroCanonique("  fa-2026  0042 ")).toBe("FA-2026 0042");
  });

  // Un `|` dans le numéro ferait réapparaître l'ambiguïté que le séparateur
  // sert précisément à supprimer.
  it("neutralise le séparateur de format", () => {
    expect(numeroCanonique("FA|2026")).toBe("FA/2026");
  });
});

describe("montantCanonique", () => {
  it("force deux décimales", () => {
    expect(montantCanonique(19070)).toBe("19070.00");
    expect(montantCanonique(1200.5)).toBe("1200.50");
    expect(montantCanonique(0.005)).toBe("0.01");
  });

  it("ne produit jamais de -0.00", () => {
    expect(montantCanonique(-0)).toBe("0.00");
  });

  it("refuse un montant non fini", () => {
    expect(() => montantCanonique(Number.NaN)).toThrow(/invalide/);
  });
});

describe("chaineCanonique", () => {
  it("assemble les champs versionnés et séparés", () => {
    expect(chaineCanonique(FACTURE)).toBe(
      `${HASH_VERSION}|FA-2026-0042|2026-08-17|001547896000073|002748193000041|19070.00`,
    );
  });

  // Sans normalisation, l'empreinte dépendrait de la frappe de l'utilisateur et
  // le recalcul de contrôle échouerait sur une facture pourtant intacte.
  it("est insensible à la forme de saisie des identifiants", () => {
    expect(chaineCanonique({ ...FACTURE, ice_vendeur: "001 547 896 000 073" })).toBe(chaineCanonique(FACTURE));
  });

  it("distingue deux factures que la concaténation nue confondrait", () => {
    // « FA12 » + ICE « 3… » contre « FA1 » + ICE « 23… » : même suite de
    // caractères une fois collés, empreintes pourtant distinctes ici.
    const a = chaineCanonique({ ...FACTURE, numero: "FA12", ice_vendeur: "345678901234567" });
    const b = chaineCanonique({ ...FACTURE, numero: "FA1", ice_vendeur: "234567890123456" });
    expect(a).not.toBe(b);
  });
});

describe("calculerHashFacture", () => {
  it("rend 64 hexadécimaux minuscules", () => {
    expect(calculerHashFacture(FACTURE, SECRET)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("est reproductible", () => {
    expect(calculerHashFacture(FACTURE, SECRET)).toBe(calculerHashFacture(FACTURE, SECRET));
  });

  // Le cœur de l'inaltérabilité : toucher un champ scellé casse l'empreinte.
  it.each([
    ["le numéro", { numero: "FA-2026-0043" }],
    ["la date", { date_facture: "2026-08-18" }],
    ["l'ICE vendeur", { ice_vendeur: "001547896000074" }],
    ["l'ICE acheteur", { ice_acheteur: "002748193000042" }],
    ["le montant TTC", { montant_ttc: 19070.01 }],
  ])("change dès qu'on retouche %s", (_libelle, modification) => {
    expect(calculerHashFacture({ ...FACTURE, ...modification }, SECRET)).not.toBe(
      calculerHashFacture(FACTURE, SECRET),
    );
  });

  it("change avec la clef secrète", () => {
    expect(calculerHashFacture(FACTURE, SECRET)).not.toBe(
      calculerHashFacture(FACTURE, "une-autre-clef-tout-aussi-longue"),
    );
  });

  it("propose HMAC comme variante, distincte du défaut", () => {
    const parDefaut = calculerHashFacture(FACTURE, SECRET);
    const hmac = calculerHashFacture(FACTURE, SECRET, { algorithme: "hmac-sha256" });
    expect(hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(hmac).not.toBe(parDefaut);
  });

  // Un repli silencieux sur une clef vide produirait un sceau que n'importe qui
  // peut recalculer : pire qu'aucun sceau, car il inspire confiance.
  it("refuse de sceller sans clef, ou avec une clef trop courte", () => {
    expect(() => calculerHashFacture(FACTURE, "")).toThrow(/Clef secrète/);
    expect(() => calculerHashFacture(FACTURE, "trop-court")).toThrow(/16 caractères/);
  });
});

describe("verifierHashFacture", () => {
  it("valide une empreinte authentique", () => {
    const h = calculerHashFacture(FACTURE, SECRET);
    expect(verifierHashFacture(FACTURE, SECRET, h)).toBe(true);
    expect(verifierHashFacture(FACTURE, SECRET, h.toUpperCase())).toBe(true);
  });

  it("rejette une facture retouchée après scellement", () => {
    const h = calculerHashFacture(FACTURE, SECRET);
    expect(verifierHashFacture({ ...FACTURE, montant_ttc: 1907 }, SECRET, h)).toBe(false);
  });

  // La comparaison à temps constant exige des tampons de même taille : une
  // empreinte tronquée doit sortir sur le contrôle de forme, pas lever.
  it("rejette proprement une empreinte malformée", () => {
    expect(verifierHashFacture(FACTURE, SECRET, "abc")).toBe(false);
    expect(verifierHashFacture(FACTURE, SECRET, "")).toBe(false);
    expect(verifierHashFacture(FACTURE, SECRET, "z".repeat(64))).toBe(false);
  });

  it("vérifie avec le même algorithme que celui du calcul", () => {
    const hmac = calculerHashFacture(FACTURE, SECRET, { algorithme: "hmac-sha256" });
    expect(verifierHashFacture(FACTURE, SECRET, hmac, { algorithme: "hmac-sha256" })).toBe(true);
    expect(verifierHashFacture(FACTURE, SECRET, hmac)).toBe(false);
  });
});
