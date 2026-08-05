import { describe, it, expect } from "vitest";
import {
  COMPTES_TVA, TOLERANCE_LETTRAGE,
  apparierAutomatiquement, codeLettrageDepuisRang, construireBasculeTva,
  controlerEquilibre, planifierDelettrage, planifierLettrage, prochainCodeLettrage,
  rangDepuisCodeLettrage, regrouperParCompte, sensDuCompte, suiteCodesLettrage,
  tvaProportionnelle, type LigneLettrable,
} from "./lettrage";

// Fabrique de lignes : seuls les champs utiles au test sont renseignés.
let seq = 0;
const ligne = (p: Partial<LigneLettrable> = {}): LigneLettrable => ({
  id: p.id ?? `l${++seq}`,
  compte_numero: p.compte_numero ?? "34210001",
  debit: p.debit ?? 0,
  credit: p.credit ?? 0,
  libelle: p.libelle ?? null,
  reference_piece: p.reference_piece ?? null,
  date_ecriture: p.date_ecriture ?? "2026-03-10",
  lettrage_code: p.lettrage_code ?? null,
});

describe("génération des codes de lettrage", () => {
  it("démarre à AA et progresse lettre à lettre", () => {
    expect(codeLettrageDepuisRang(1)).toBe("AA");
    expect(codeLettrageDepuisRang(2)).toBe("AB");
    expect(codeLettrageDepuisRang(26)).toBe("AZ");
  });

  it("passe à la lettre de poids fort après AZ", () => {
    expect(codeLettrageDepuisRang(27)).toBe("BA");
    expect(codeLettrageDepuisRang(28)).toBe("BB");
    expect(codeLettrageDepuisRang(676)).toBe("ZZ");
  });

  it("élargit à trois lettres une fois ZZ atteint", () => {
    expect(codeLettrageDepuisRang(677)).toBe("AAA");
    expect(codeLettrageDepuisRang(678)).toBe("AAB");
  });

  // Le vrai risque de cette numérotation est la COLLISION : deux rangs
  // différents produisant le même code feraient porter la même lettre à deux
  // rapprochements sans rapport. On balaie toute la plage à deux lettres.
  it("n'attribue jamais deux fois le même code", () => {
    const codes = Array.from({ length: 800 }, (_, i) => codeLettrageDepuisRang(i + 1));
    expect(new Set(codes).size).toBe(800);
  });

  it("le rang et le code sont inverses l'un de l'autre", () => {
    for (const rang of [1, 2, 26, 27, 675, 676, 677, 800]) {
      expect(rangDepuisCodeLettrage(codeLettrageDepuisRang(rang))).toBe(rang);
    }
  });

  it("rejette un rang invalide", () => {
    expect(() => codeLettrageDepuisRang(0)).toThrow();
    expect(() => codeLettrageDepuisRang(-3)).toThrow();
  });

  it("ignore les codes illisibles au calcul du suivant", () => {
    expect(rangDepuisCodeLettrage("A")).toBeNull();      // code à 1 lettre = import Sage
    expect(rangDepuisCodeLettrage("12")).toBeNull();
    expect(rangDepuisCodeLettrage("")).toBeNull();
  });
});

describe("prochainCodeLettrage", () => {
  it("rend AA sur un dossier vierge", () => {
    expect(prochainCodeLettrage([])).toBe("AA");
    expect(prochainCodeLettrage([null, undefined, ""])).toBe("AA");
  });

  it("repart du maximum, pas du nombre de codes", () => {
    expect(prochainCodeLettrage(["AA", "AB", "AC"])).toBe("AD");
  });

  // Un délettrage laisse un trou. Le réutiliser ferait resurgir dans un nouvel
  // export un code déjà imprimé dans un état antérieur du grand livre.
  it("ne recycle pas le code d'un lettrage annulé", () => {
    expect(prochainCodeLettrage(["AA", "AC"])).toBe("AD");
  });

  it("ignore les codes d'origine importés (une seule lettre)", () => {
    expect(prochainCodeLettrage(["A", "B", "AB"])).toBe("AC");
  });

  it("suiteCodesLettrage rend des codes consécutifs et libres", () => {
    expect(suiteCodesLettrage(["AA"], 3)).toEqual(["AB", "AC", "AD"]);
    expect(suiteCodesLettrage([], 0)).toEqual([]);
  });
});

describe("contrôle d'équilibre", () => {
  it("accepte une facture soldée par son règlement", () => {
    const r = controlerEquilibre([ligne({ debit: 1200 }), ligne({ credit: 1200 })]);
    expect(r.ok).toBe(true);
    expect(r.totalDebit).toBe(1200);
    expect(r.ecart).toBe(0);
  });

  it("refuse un règlement partiel", () => {
    const r = controlerEquilibre([ligne({ debit: 1200 }), ligne({ credit: 500 })]);
    expect(r.ok).toBe(false);
    expect(r.ecart).toBe(700);
    expect(r.raison).toMatch(/déséquilibrée/);
  });

  it("refuse une ligne seule", () => {
    expect(controlerEquilibre([ligne({ debit: 100 })]).ok).toBe(false);
  });

  it("refuse de solder la dette d'un tiers avec la créance d'un autre", () => {
    const r = controlerEquilibre([
      ligne({ compte_numero: "34210001", debit: 500 }),
      ligne({ compte_numero: "44110002", credit: 500 }),
    ]);
    expect(r.ok).toBe(false);
    expect(r.raison).toMatch(/comptes différents/);
  });

  it("refuse une sélection à montant nul", () => {
    expect(controlerEquilibre([ligne({ debit: 0 }), ligne({ credit: 0 })]).ok).toBe(false);
  });

  it("tolère l'arrondi au centime", () => {
    // 3 × 400,00 face à 1 200,01 : écart d'un centime, admis.
    const r = controlerEquilibre([
      ligne({ debit: 400 }), ligne({ debit: 400 }), ligne({ debit: 400.01 }),
      ligne({ credit: 1200.01 }),
    ]);
    expect(r.ok).toBe(true);
    expect(TOLERANCE_LETTRAGE).toBeLessThan(0.01);
  });

  it("solde une facture par plusieurs règlements", () => {
    const r = controlerEquilibre([
      ligne({ debit: 1200 }), ligne({ credit: 700 }), ligne({ credit: 500 }),
    ]);
    expect(r.ok).toBe(true);
  });
});

describe("sens du compte", () => {
  it("reconnaît clients et fournisseurs par préfixe PCM", () => {
    expect(sensDuCompte("34210001")).toBe("client");
    expect(sensDuCompte("3421")).toBe("client");
    expect(sensDuCompte("44110005")).toBe("fournisseur");
    expect(sensDuCompte("4411")).toBe("fournisseur");
  });

  it("rend null hors comptes de tiers", () => {
    expect(sensDuCompte("6111")).toBeNull();
    expect(sensDuCompte("5141")).toBeNull();
    expect(sensDuCompte(null)).toBeNull();
  });
});

describe("bascule de TVA au règlement", () => {
  it("VENTE : débite l'attente 4458, crédite l'exigible 4455", () => {
    const od = construireBasculeTva({
      sens: "client", montantTva: 200, date: "2026-04-01",
      reference: "FA-12", lettrageCode: "AA",
    });
    expect(od).toHaveLength(2);
    expect(od[0]).toMatchObject({ compte_numero: "4458", debit: 200, credit: 0, journal_code: "OD" });
    expect(od[1]).toMatchObject({ compte_numero: "4455", debit: 0, credit: 200 });
    expect(od.every((l) => l.lettrage_code === "AA")).toBe(true);
    expect(od[0].libelle).toMatch(/exigible sur encaissement/i);
  });

  it("ACHAT : débite l'exigible 3455, crédite l'attente 3458", () => {
    const od = construireBasculeTva({
      sens: "fournisseur", montantTva: 96.33, date: "2026-04-01", lettrageCode: "AB",
    });
    expect(od[0]).toMatchObject({ compte_numero: "3455", debit: 96.33, credit: 0 });
    expect(od[1]).toMatchObject({ compte_numero: "3458", debit: 0, credit: 96.33 });
    expect(od[0].libelle).toMatch(/déductible sur décaissement/i);
  });

  it("l'OD de bascule est équilibrée", () => {
    for (const sens of ["client", "fournisseur"] as const) {
      const od = construireBasculeTva({ sens, montantTva: 137.5, date: "2026-04-01", lettrageCode: "AA" });
      const d = od.reduce((s, l) => s + l.debit, 0);
      const c = od.reduce((s, l) => s + l.credit, 0);
      expect(d).toBeCloseTo(c, 2);
    }
  });

  // Une facture exonérée ou hors champ ne rend aucune TVA exigible : passer une
  // OD à zéro polluerait le journal sans rien constater.
  it("ne produit aucune écriture sans TVA", () => {
    expect(construireBasculeTva({ sens: "client", montantTva: 0, date: "2026-04-01", lettrageCode: "AA" })).toEqual([]);
    expect(construireBasculeTva({ sens: "client", montantTva: -5, date: "2026-04-01", lettrageCode: "AA" })).toEqual([]);
  });

  it("les comptes de TVA sont paramétrables", () => {
    const od = construireBasculeTva({
      sens: "client", montantTva: 100, date: "2026-04-01", lettrageCode: "AA",
      comptes: { client: { attente: "44581", exigible: "44551" }, fournisseur: COMPTES_TVA.fournisseur },
    });
    expect(od.map((l) => l.compte_numero)).toEqual(["44581", "44551"]);
  });
});

describe("TVA proportionnelle au règlement partiel", () => {
  it("rend la TVA entière sur un règlement total", () => {
    expect(tvaProportionnelle(1200, 1200, 200)).toBe(200);
  });

  it("rend la quote-part sur un règlement partiel", () => {
    expect(tvaProportionnelle(600, 1200, 200)).toBe(100);
    expect(tvaProportionnelle(480, 1200, 200)).toBe(80);
  });

  // Une double saisie de règlement ne doit pas créer de TVA qui n'existe pas.
  it("plafonne au montant de TVA de la pièce", () => {
    expect(tvaProportionnelle(2400, 1200, 200)).toBe(200);
  });

  it("rend zéro sur une pièce sans TVA ou sans TTC", () => {
    expect(tvaProportionnelle(500, 1200, 0)).toBe(0);
    expect(tvaProportionnelle(500, 0, 200)).toBe(0);
    expect(tvaProportionnelle(-100, 1200, 200)).toBe(0);
  });
});

describe("planifierLettrage", () => {
  const piece = { montantTtc: 1200, montantTva: 200, reference: "FA-12" };

  it("produit code, lignes et OD de bascule sur une vente soldée", () => {
    const lignes = [ligne({ debit: 1200 }), ligne({ credit: 1200 })];
    const p = planifierLettrage({ lignes, codesExistants: ["AA"], piece, date: "2026-04-01" });
    expect(p.ok).toBe(true);
    expect(p.code).toBe("AB");
    expect(p.sens).toBe("client");
    expect(p.ligneIds).toHaveLength(2);
    expect(p.od.map((l) => l.compte_numero)).toEqual(["4458", "4455"]);
    expect(p.montantLettre).toBe(1200);
  });

  it("refuse une sélection déséquilibrée sans rien produire", () => {
    const p = planifierLettrage({
      lignes: [ligne({ debit: 1200 }), ligne({ credit: 900 })],
      codesExistants: [], piece,
    });
    expect(p.ok).toBe(false);
    expect(p.code).toBe("");
    expect(p.od).toEqual([]);
    expect(p.ligneIds).toEqual([]);
  });

  it("refuse de relettrer des lignes déjà lettrées", () => {
    const p = planifierLettrage({
      lignes: [ligne({ debit: 500, lettrage_code: "AA" }), ligne({ credit: 500 })],
      codesExistants: ["AA"], piece,
    });
    expect(p.ok).toBe(false);
    expect(p.raison).toMatch(/déjà lettrée/);
  });

  it("lettre sans basculer la TVA hors compte de tiers", () => {
    const p = planifierLettrage({
      lignes: [ligne({ compte_numero: "5141", debit: 800 }), ligne({ compte_numero: "5141", credit: 800 })],
      codesExistants: [], piece,
    });
    expect(p.ok).toBe(true);
    expect(p.sens).toBeNull();
    expect(p.od).toEqual([]);
    expect(p.raison).toMatch(/sans bascule/);
  });

  it("lettre sans OD quand aucune pièce n'est fournie", () => {
    const p = planifierLettrage({
      lignes: [ligne({ debit: 300 }), ligne({ credit: 300 })],
      codesExistants: [],
    });
    expect(p.ok).toBe(true);
    expect(p.od).toEqual([]);
  });

  it("bascule au prorata sur un règlement partiel lettré", () => {
    // 600 réglés sur 1200 TTC → la moitié des 200 de TVA devient exigible.
    const p = planifierLettrage({
      lignes: [ligne({ debit: 600 }), ligne({ credit: 600 })],
      codesExistants: [], piece, date: "2026-04-01",
    });
    expect(p.od[0].debit).toBe(100);
  });
});

describe("planifierDelettrage", () => {
  it("annule le lettrage et supprime l'OD de TVA", () => {
    const toutes = [
      ligne({ id: "f1", debit: 1200, lettrage_code: "AA" }),
      ligne({ id: "r1", credit: 1200, lettrage_code: "AA" }),
      ligne({ id: "od1", compte_numero: "4458", debit: 200, lettrage_code: "AA" }),
      ligne({ id: "od2", compte_numero: "4455", credit: 200, lettrage_code: "AA" }),
      ligne({ id: "autre", debit: 50, lettrage_code: "AB" }),
    ];
    const p = planifierDelettrage([toutes[0]], toutes);
    expect(p.ok).toBe(true);
    expect(p.codes).toEqual(["AA"]);
    expect(p.ligneIds.sort()).toEqual(["f1", "r1"]);
    expect(p.odASupprimer.sort()).toEqual(["od1", "od2"]);
    expect(p.ligneIds).not.toContain("autre");
  });

  // Retirer une seule ligne d'un lettrage à trois déséquilibrerait les deux qui
  // restent : le délettrage emporte donc tout le code, sélectionné ou non.
  it("délettre tout le code même si une seule ligne est sélectionnée", () => {
    const toutes = [
      ligne({ id: "a", debit: 1200, lettrage_code: "AA" }),
      ligne({ id: "b", credit: 700, lettrage_code: "AA" }),
      ligne({ id: "c", credit: 500, lettrage_code: "AA" }),
    ];
    expect(planifierDelettrage([toutes[1]], toutes).ligneIds.sort()).toEqual(["a", "b", "c"]);
  });

  it("refuse une sélection non lettrée", () => {
    const l = ligne({ debit: 100 });
    const p = planifierDelettrage([l], [l]);
    expect(p.ok).toBe(false);
    expect(p.raison).toMatch(/Aucune ligne lettrée/);
  });
});

describe("regrouperParCompte", () => {
  it("calcule le résidu ouvert de chaque compte", () => {
    const postes = regrouperParCompte([
      ligne({ compte_numero: "34210001", debit: 1200 }),
      ligne({ compte_numero: "34210001", credit: 500 }),
      ligne({ compte_numero: "44110002", credit: 800, lettrage_code: "AA" }),
    ]);
    expect(postes.map((p) => p.compte)).toEqual(["34210001", "44110002"]);
    expect(postes[0].solde).toBe(700);
    expect(postes[1].nbLettrees).toBe(1);
  });
});

describe("appariement automatique", () => {
  it("apparie par référence de pièce commune", () => {
    const groupes = apparierAutomatiquement([
      ligne({ id: "a", debit: 1200, reference_piece: "FA-12" }),
      ligne({ id: "b", credit: 1200, reference_piece: "FA-12" }),
      ligne({ id: "c", debit: 300, reference_piece: "FA-13" }),
    ]);
    expect(groupes).toHaveLength(1);
    expect(groupes[0].map((l) => l.id).sort()).toEqual(["a", "b"]);
  });

  it("apparie sur un montant exact et unique", () => {
    const groupes = apparierAutomatiquement([
      ligne({ id: "a", debit: 1234.56 }),
      ligne({ id: "b", credit: 1234.56 }),
    ]);
    expect(groupes[0].map((l) => l.id).sort()).toEqual(["a", "b"]);
  });

  // Deux règlements du même montant : impossible de savoir lequel solde quoi.
  // Un appariement arbitraire serait faux une fois sur deux.
  it("s'abstient quand le montant est ambigu", () => {
    expect(apparierAutomatiquement([
      ligne({ id: "a", debit: 500 }),
      ligne({ id: "b", credit: 500 }),
      ligne({ id: "c", credit: 500 }),
    ])).toEqual([]);
  });

  it("ignore les lignes déjà lettrées", () => {
    expect(apparierAutomatiquement([
      ligne({ id: "a", debit: 900, lettrage_code: "AA" }),
      ligne({ id: "b", credit: 900, lettrage_code: "AA" }),
    ])).toEqual([]);
  });

  it("n'utilise jamais deux fois la même ligne", () => {
    const groupes = apparierAutomatiquement([
      ligne({ id: "a", debit: 100, reference_piece: "P1" }),
      ligne({ id: "b", credit: 100, reference_piece: "P1" }),
      ligne({ id: "c", credit: 100 }),
    ]);
    const tousIds = groupes.flat().map((l) => l.id);
    expect(new Set(tousIds).size).toBe(tousIds.length);
  });
});
