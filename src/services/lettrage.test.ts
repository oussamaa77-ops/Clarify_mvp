import { describe, it, expect } from "vitest";
import {
  COMPTES_TVA, TOLERANCE_LETTRAGE,
  apparierAutomatiquement, codeLettrageDepuisRang, construireBasculeTva,
  controlerEquilibre, estBasculeReglement, estCompteTva, grouperOdBascule, planifierDelettrage,
  planifierLettrage, prochainCodeLettrage, rangDepuisCodeLettrage,
  referenceReclassement, referenceSansPrefixe, referencesPiece,
  regrouperParCompte, sensDuCompte, suiteCodesLettrage,
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
  journal_code: p.journal_code ?? null,
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
  // L'exigible est le SOUS-COMPTE réellement mouvementé par les journaux de vente
  // et d'achat — 44551 / 34552 — et non la racine 4455 / 3455. Créditer la racine
  // éclatait la TVA exigible sur deux comptes, dont un que la déclaration ignore.
  it("VENTE : débite l'attente 4458, crédite l'exigible 44551", () => {
    const od = construireBasculeTva({
      sens: "client", montantTva: 200, date: "2026-04-01",
      reference: "FA-12", lettrageCode: "AA",
    });
    expect(od).toHaveLength(2);
    expect(od[0]).toMatchObject({ compte_numero: "4458", debit: 200, credit: 0, journal_code: "OD" });
    expect(od[1]).toMatchObject({ compte_numero: "44551", debit: 0, credit: 200 });
    expect(od.every((l) => l.lettrage_code === "AA")).toBe(true);
    // Libellé lisible : la nature, puis le numéro de pièce, séparés.
    expect(od[0].libelle).toBe("TVA exigible - FA-12");
  });

  it("ACHAT : débite l'exigible 34552, crédite l'attente 3458", () => {
    const od = construireBasculeTva({
      sens: "fournisseur", montantTva: 96.33, date: "2026-04-01", lettrageCode: "AB",
    });
    expect(od[0]).toMatchObject({ compte_numero: "34552", debit: 96.33, credit: 0 });
    expect(od[1]).toMatchObject({ compte_numero: "3458", debit: 0, credit: 96.33 });
    expect(od[0].libelle).toBe("TVA déductible");
  });

  it("trace la facture et le règlement en base", () => {
    const od = construireBasculeTva({
      sens: "client", montantTva: 200, date: "2026-04-01", reference: "FAC-2026-001",
      lettrageCode: "AA", factureId: "f-1", paiementId: "p-1",
    });
    expect(od.every((l) => l.facture_id === "f-1" && l.paiement_id === "p-1")).toBe(true);
    expect(od[0].libelle).toBe("TVA exigible - FAC-2026-001");
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
    expect(p.od.map((l) => l.compte_numero)).toEqual(["4458", "44551"]);
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

  // Le lettrage est RÉSERVÉ AUX COMPTES DE TIERS. Il était auparavant accepté
  // « sans bascule » sur n'importe quel compte, ce qui laissait rapprocher des
  // lignes de banque ou de TVA — un appariement qui ne veut rien dire et qui
  // masquait des lignes de TVA aux yeux de la déclaration.
  it("REFUSE de lettrer un compte de trésorerie", () => {
    const p = planifierLettrage({
      lignes: [ligne({ compte_numero: "5141", debit: 800 }), ligne({ compte_numero: "5141", credit: 800 })],
      codesExistants: [], piece,
    });
    expect(p.ok).toBe(false);
    expect(p.od).toEqual([]);
    expect(p.raison).toMatch(/réservé aux comptes de tiers/i);
  });

  it("REFUSE de lettrer un compte de TVA, 4456 compris", () => {
    for (const compte of ["4458", "44551", "3458", "34552", "4456"]) {
      const p = planifierLettrage({
        lignes: [ligne({ compte_numero: compte, debit: 800 }), ligne({ compte_numero: compte, credit: 800 })],
        codesExistants: [], piece,
      });
      expect(p.ok).toBe(false);
      expect(p.raison).toMatch(/interdit sur le compte de TVA/i);
    }
  });

  it("accepte les comptes de tiers, collectif comme auxiliaire", () => {
    for (const compte of ["3421", "34210002", "4411", "44110005"]) {
      const p = planifierLettrage({
        lignes: [ligne({ compte_numero: compte, debit: 800 }), ligne({ compte_numero: compte, credit: 800 })],
        codesExistants: [],
      });
      expect(p.ok).toBe(true);
    }
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

describe("référence propre du reclassement de TVA", () => {
  it("préfixe la référence de la pièce", () => {
    expect(referenceReclassement("FAC-2024-307")).toBe("RECLASS-TVA-FAC-2024-307");
  });

  it("la référence obtenue n'est JAMAIS celle de la pièce", () => {
    // C'est tout l'objet du changement : plus aucune requête sur la référence
    // de la facture ne peut ramener le reclassement par accident.
    for (const r of ["FAC-1", "uuid-abc", "09/60900087"]) {
      expect(referenceReclassement(r)).not.toBe(r);
    }
  });

  it("retrouve la pièce d'origine — le lien reste dérivable", () => {
    expect(referenceSansPrefixe("RECLASS-TVA-FAC-2024-307")).toBe("FAC-2024-307");
    // Idempotent sur une référence ordinaire : sûr à appliquer partout.
    expect(referenceSansPrefixe("FAC-2024-307")).toBe("FAC-2024-307");
    expect(referenceSansPrefixe(null)).toBe("");
  });

  // Le filtre qui doit voir la pièce EN ENTIER : sans la référence préfixée,
  // la TVA mise en attente par le reclassement resterait invisible et le
  // règlement ne basculerait rien.
  it("referencesPiece couvre la pièce ET son reclassement", () => {
    expect(referencesPiece("FAC-1")).toEqual(["FAC-1", "RECLASS-TVA-FAC-1"]);
  });

  it("referencesPiece accepte plusieurs alias et ignore les vides", () => {
    expect(referencesPiece("FAC-1", "uuid-1", null, "", undefined)).toEqual([
      "FAC-1", "uuid-1", "RECLASS-TVA-FAC-1", "RECLASS-TVA-uuid-1",
    ]);
  });

  it("dédoublonne les alias identiques", () => {
    expect(referencesPiece("FAC-1", "FAC-1")).toEqual(["FAC-1", "RECLASS-TVA-FAC-1"]);
  });
});

describe("estCompteTva — reconnaissance par préfixe", () => {
  it("reconnaît les racines", () => {
    for (const c of ["4458", "4455", "3458", "3455"]) expect(estCompteTva(c)).toBe(true);
  });

  // La cause exacte de l'écart de 1 880,00 MAD : le plan réel emploie des
  // SOUS-COMPTES que l'égalité stricte ne voyait pas.
  it("reconnaît les SOUS-COMPTES employés en base", () => {
    for (const c of ["44551", "44552", "34552", "44581", "34581"]) {
      expect(estCompteTva(c)).toBe(true);
    }
  });

  it("ne confond pas 4456 (TVA due) ni les comptes voisins", () => {
    for (const c of ["4456", "4457", "3421", "44110005", "6141", "5141", "", null, undefined]) {
      expect(estCompteTva(c as any)).toBe(false);
    }
  });

  it("suit un plan de comptes personnalisé", () => {
    const comptes = { client: { attente: "44581", exigible: "44551" }, fournisseur: COMPTES_TVA.fournisseur };
    expect(estCompteTva("445810", comptes)).toBe(true);
    expect(estCompteTva("4458", comptes)).toBe(false);   // pas un préfixe de 44581
  });
});

describe("grouperOdBascule — l'unité de suppression est l'écriture", () => {
  it("groupe par code de lettrage", () => {
    const l = [
      ligne({ id: "a", journal_code: "OD", compte_numero: "4458", debit: 200, lettrage_code: "AA" }),
      ligne({ id: "b", journal_code: "OD", compte_numero: "44551", credit: 200, lettrage_code: "AA" }),
      ligne({ id: "c", journal_code: "OD", compte_numero: "4458", debit: 50, lettrage_code: "AB" }),
      ligne({ id: "d", journal_code: "OD", compte_numero: "44551", credit: 50, lettrage_code: "AB" }),
    ];
    expect(grouperOdBascule(l).sort()).toEqual(["a", "b", "c", "d"]);
  });

  // Les bascules d'acompte ne portent pas de code : elles se groupent par pièce.
  it("groupe les OD SANS code par référence + date", () => {
    const l = [
      ligne({ id: "a", journal_code: "OD", compte_numero: "4458", debit: 100, reference_piece: "FA-1", date_ecriture: "2026-02-01" }),
      ligne({ id: "b", journal_code: "OD", compte_numero: "44551", credit: 100, reference_piece: "FA-1", date_ecriture: "2026-02-01" }),
      // Autre pièce, autre date : groupe distinct, sans TVA → non concerné.
      ligne({ id: "c", journal_code: "OD", compte_numero: "6141", debit: 30, reference_piece: "FA-2", date_ecriture: "2026-03-01" }),
    ];
    expect(grouperOdBascule(l).sort()).toEqual(["a", "b"]);
  });

  it("ignore les lignes qui ne sont pas au journal OD", () => {
    const l = [
      ligne({ id: "vte", journal_code: "VTE", compte_numero: "4458", credit: 200, reference_piece: "FA-1" }),
    ];
    expect(grouperOdBascule(l)).toEqual([]);
  });
});

// ─── RÉGRESSION FAC-2024-307, second volet ───────────────────────────────────
// Le reclassement de TVA et la bascule au règlement portent sur LES DEUX MÊMES
// comptes, sans code, sous la même référence de facture : seul le SENS les
// distingue. Confondre les deux faisait supprimer le reclassement à l'annulation
// d'un paiement — une écriture étrangère au règlement.
describe("estBasculeReglement — sens contre sens", () => {
  const od = (compte: string, debit: number, credit: number) =>
    ligne({ journal_code: "OD", compte_numero: compte, debit, credit, reference_piece: "FAC-2024-307" });

  it("reconnaît la bascule d'une VENTE : D attente / C exigible", () => {
    expect(estBasculeReglement([od("4458", 1880, 0), od("44551", 0, 1880)])).toBe(true);
  });

  it("REJETTE le reclassement inverse : D exigible / C attente", () => {
    expect(estBasculeReglement([od("44551", 1880, 0), od("4458", 0, 1880)])).toBe(false);
  });

  it("reconnaît la bascule d'un ACHAT : D déductible / C attente", () => {
    expect(estBasculeReglement([od("34552", 200, 0), od("3458", 0, 200)])).toBe(true);
  });

  it("REJETTE le reclassement d'achat inverse", () => {
    expect(estBasculeReglement([od("3458", 200, 0), od("34552", 0, 200)])).toBe(false);
  });

  it("rejette une demi-écriture, faute de pouvoir conclure sur le sens", () => {
    expect(estBasculeReglement([od("44551", 1880, 0)])).toBe(false);
  });
});

describe("grouperOdBascule — option seulementBascules", () => {
  const grp = (a: string, ad: number, ac: number, b: string, bd: number, bc: number) => [
    ligne({ id: "x", journal_code: "OD", compte_numero: a, debit: ad, credit: ac, reference_piece: "FA-1", date_ecriture: "2026-05-06" }),
    ligne({ id: "y", journal_code: "OD", compte_numero: b, debit: bd, credit: bc, reference_piece: "FA-1", date_ecriture: "2026-05-06" }),
  ];

  it("emporte une vraie bascule", () => {
    expect(grouperOdBascule(grp("4458", 1880, 0, "44551", 0, 1880), undefined, { seulementBascules: true }).sort())
      .toEqual(["x", "y"]);
  });

  // LE cas de FAC-2024-307 : ne rien toucher.
  it("épargne le reclassement de TVA", () => {
    expect(grouperOdBascule(grp("44551", 1880, 0, "4458", 0, 1880), undefined, { seulementBascules: true }))
      .toEqual([]);
  });

  it("sans l'option, les deux sont emportés (usage du délettrage par code)", () => {
    expect(grouperOdBascule(grp("44551", 1880, 0, "4458", 0, 1880)).sort()).toEqual(["x", "y"]);
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

  // ── RÉGRESSION FAC-2024-307 (écart de 1 880,00 MAD au grand livre) ─────────
  // La bascule est passée sur le SOUS-COMPTE 44551, pas sur la racine 4455. Le
  // filtre par égalité stricte ne reconnaissait que « 4455 » : la ligne 4458
  // était supprimée, sa contrepartie 44551 restait, et le journal se retrouvait
  // déséquilibré du montant de la TVA.
  it("supprime les DEUX lignes d'une OD passée sur un sous-compte (44551)", () => {
    const toutes = [
      ligne({ id: "f1", debit: 11280, lettrage_code: "AA" }),
      ligne({ id: "r1", credit: 11280, lettrage_code: "AA" }),
      ligne({ id: "od1", journal_code: "OD", compte_numero: "4458", debit: 1880, lettrage_code: "AA" }),
      ligne({ id: "od2", journal_code: "OD", compte_numero: "44551", credit: 1880, lettrage_code: "AA" }),
    ];
    const p = planifierDelettrage([toutes[0]], toutes);
    expect(p.odASupprimer.sort()).toEqual(["od1", "od2"]);
    // Et la contrepartie ne doit surtout pas être traitée comme une ligne
    // ordinaire à simplement dé-estampiller : elle disparaîtrait du nettoyage.
    expect(p.ligneIds).not.toContain("od2");
  });

  it("supprime aussi les deux lignes d'une OD d'achat sur 34552", () => {
    const toutes = [
      ligne({ id: "f1", compte_numero: "44110005", credit: 1200, lettrage_code: "AB" }),
      ligne({ id: "r1", compte_numero: "44110005", debit: 1200, lettrage_code: "AB" }),
      ligne({ id: "od1", journal_code: "OD", compte_numero: "34552", debit: 200, lettrage_code: "AB" }),
      ligne({ id: "od2", journal_code: "OD", compte_numero: "3458", credit: 200, lettrage_code: "AB" }),
    ];
    const p = planifierDelettrage([toutes[0]], toutes);
    expect(p.odASupprimer.sort()).toEqual(["od1", "od2"]);
  });

  // Le groupe part en entier même si UNE seule de ses lignes est reconnue : une
  // contrepartie sur un compte inattendu ne doit jamais rester seule.
  it("emporte la contrepartie même sur un compte non reconnu", () => {
    const toutes = [
      ligne({ id: "f1", debit: 600, lettrage_code: "AC" }),
      ligne({ id: "r1", credit: 600, lettrage_code: "AC" }),
      ligne({ id: "od1", journal_code: "OD", compte_numero: "4458", debit: 100, lettrage_code: "AC" }),
      ligne({ id: "od2", journal_code: "OD", compte_numero: "4457", credit: 100, lettrage_code: "AC" }),
    ];
    const p = planifierDelettrage([toutes[0]], toutes);
    expect(p.odASupprimer.sort()).toEqual(["od1", "od2"]);
  });

  it("l'ensemble supprimé est TOUJOURS équilibré (partie double)", () => {
    const toutes = [
      ligne({ id: "f1", debit: 1200, lettrage_code: "AA" }),
      ligne({ id: "r1", credit: 1200, lettrage_code: "AA" }),
      ligne({ id: "od1", journal_code: "OD", compte_numero: "4458", debit: 200, lettrage_code: "AA" }),
      ligne({ id: "od2", journal_code: "OD", compte_numero: "44551", credit: 200, lettrage_code: "AA" }),
    ];
    const p = planifierDelettrage([toutes[0]], toutes);
    const supprimees = toutes.filter((l) => p.odASupprimer.includes(l.id));
    const d = supprimees.reduce((s, l) => s + Number(l.debit ?? 0), 0);
    const c = supprimees.reduce((s, l) => s + Number(l.credit ?? 0), 0);
    expect(d).toBeCloseTo(c, 2);
  });

  // Une OD que le comptable a lettrée à la main sur un compte de TIERS n'est pas
  // une bascule de TVA : elle se dé-estampille, elle ne se supprime pas.
  it("ne supprime pas une OD lettrée manuellement hors compte de TVA", () => {
    const toutes = [
      ligne({ id: "od1", journal_code: "OD", compte_numero: "34210001", debit: 500, lettrage_code: "AD" }),
      ligne({ id: "r1", compte_numero: "34210001", credit: 500, lettrage_code: "AD" }),
    ];
    const p = planifierDelettrage([toutes[0]], toutes);
    expect(p.odASupprimer).toEqual([]);
    expect(p.ligneIds.sort()).toEqual(["od1", "r1"]);
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
