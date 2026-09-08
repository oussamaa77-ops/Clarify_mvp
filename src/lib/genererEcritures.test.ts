import { describe, expect, it } from "vitest";
import {
  assertEcrituresRegime, assertLignesAchat, bornesExerciceActif,
  controlerCutoffExercice, controlerEcrituresRegime, controlerJournalOd,
  controlerLignesAchat, controlerTvaOrigine, controlerUniciteReference,
  estTresorerieHorsOd, estTvaExigible, genererEcrituresAchat, genererEcrituresVente,
  genererOdBasculeTva,
  controlerSensReglement, controlerMouvementsTvaDue, controlerPreuveBascule,
  estBasculeTva, RACINES_TIERS, RACINE_TVA_DUE, PREFIXES_PIECES_TVA_DUE,
  LIBELLE_PAIEMENT_DGI_MIROIR,
} from "@/lib/genererEcritures";
import {
  COMPTE_TVA_DUE, LIBELLE_PAIEMENT_DGI,
  PREFIXE_DECLARATION_TVA, PREFIXE_REGULARISATION_TVA,
} from "@/lib/liquidation-tva";
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

// ─── VERROU 5 — le sens d'un règlement ───────────────────────────────────────
//
// Le cas SOMADIR : la caisse débitée en payant, le fournisseur crédité. La
// pièce était ÉQUILIBRÉE, donc invisible pour tout contrôle de partie double —
// c'est la raison d'être de ce verrou.
describe("controlerSensReglement", () => {
  const reglement = (compte: string, sens: "D" | "C", journal = "CAI") => [
    { journal_code: journal, compte_numero: compte, date_ecriture: "2026-05-04",
      debit: sens === "D" ? 20160 : 0, credit: sens === "C" ? 20160 : 0, reference_piece: "P1" },
    { journal_code: journal, compte_numero: "51610000", date_ecriture: "2026-05-04",
      debit: sens === "D" ? 0 : 20160, credit: sens === "D" ? 20160 : 0, reference_piece: "P1" },
  ];

  it("REFUSE un fournisseur crédité en journal de trésorerie — le bug SOMADIR", () => {
    const v = controlerSensReglement(reglement("44110001", "C"));
    expect(v.ok).toBe(false);
    expect(v.violations[0]).toMatch(/fournisseur CRÉDITÉ/);
    expect(v.violations[0]).toContain("44110001");
  });

  it("accepte le décaissement juste : fournisseur DÉBITÉ", () => {
    expect(controlerSensReglement(reglement("44110001", "D")).ok).toBe(true);
  });

  it("REFUSE un client débité en journal de trésorerie", () => {
    const v = controlerSensReglement(reglement("34210002", "D"));
    expect(v.ok).toBe(false);
    expect(v.violations[0]).toMatch(/client DÉBITÉ/);
  });

  it("accepte l'encaissement juste : client CRÉDITÉ", () => {
    expect(controlerSensReglement(reglement("34210002", "C")).ok).toBe(true);
  });

  it("vaut pour la BANQUE comme pour la caisse", () => {
    expect(controlerSensReglement(reglement("44110001", "C", "BQ")).ok).toBe(false);
    expect(controlerSensReglement(reglement("44110001", "D", "BQ")).ok).toBe(true);
  });

  it("ne dit rien HORS journal de trésorerie : la facture crédite le fournisseur", () => {
    // D 6141 / C 4411 en journal ACH est la dette qui naît : parfaitement normal.
    expect(controlerSensReglement([
      { journal_code: "ACH", compte_numero: "61410000", debit: 16800, credit: 0, reference_piece: "A1" },
      { journal_code: "ACH", compte_numero: "44110001", debit: 0, credit: 16800, reference_piece: "A1" },
    ]).ok).toBe(true);
  });

  it("laisse passer une trésorerie SANS compte de tiers", () => {
    // Frais bancaires : C 5141 / D 6147. Aucun tiers, rien à vérifier.
    expect(controlerSensReglement([
      { journal_code: "BQ", compte_numero: "51410000", debit: 0, credit: 120, reference_piece: "F" },
      { journal_code: "BQ", compte_numero: "61470000", debit: 120, credit: 0, reference_piece: "F" },
    ]).ok).toBe(true);
    // Virement interne banque → caisse : deux comptes de trésorerie, pas de tiers.
    expect(controlerSensReglement([
      { journal_code: "BQ", compte_numero: "51410000", debit: 0, credit: 5000, reference_piece: "V" },
      { journal_code: "CAI", compte_numero: "51610000", debit: 5000, credit: 0, reference_piece: "V" },
    ]).ok).toBe(true);
  });

  it("ignore l'attente bancaire 4711/4712, qui n'est pas un compte de tiers", () => {
    expect(controlerSensReglement([
      { journal_code: "BQ", compte_numero: "51410000", debit: 3000, credit: 0, reference_piece: "X" },
      { journal_code: "BQ", compte_numero: "47120000", debit: 0, credit: 3000, reference_piece: "X" },
    ]).ok).toBe(true);
  });

  it("détecte sur la forme canonique comme sur la forme courte", () => {
    expect(controlerSensReglement(reglement("4411", "C")).ok).toBe(false);
    expect(controlerSensReglement(reglement("44110000", "C")).ok).toBe(false);
  });

  it("les racines exposées sont celles du PCM marocain", () => {
    expect(RACINES_TIERS).toEqual({ client: "3421", fournisseur: "4411" });
  });
});

// ─── VERROU 6 — le 4456 ne se manie que par déclaration ──────────────────────
describe("controlerMouvementsTvaDue", () => {
  const ligne4456 = (ref: string | null, libelle = "x", sens: "D" | "C" = "C") => [{
    journal_code: "OD", compte_numero: "44560000", date_ecriture: "2026-07-31",
    libelle, debit: sens === "D" ? 1880 : 0, credit: sens === "C" ? 1880 : 0,
    reference_piece: ref,
  }];

  it("accepte une DÉCLARATION", () => {
    expect(controlerMouvementsTvaDue(ligne4456("DECL-TVA-2026-07", "TVA due")).ok).toBe(true);
  });

  it("accepte une RÉGULARISATION", () => {
    expect(controlerMouvementsTvaDue(ligne4456("REGUL-TVA-2024-11")).ok).toBe(true);
  });

  it("accepte un PAIEMENT DGI, reconnu à son libellé", () => {
    expect(controlerMouvementsTvaDue([{
      journal_code: "BQ", compte_numero: "44560000", date_ecriture: "2026-08-12",
      libelle: "Paiement TVA DGI - 2026-05", debit: 5262, credit: 0,
      reference_piece: "DECL-TVA-2026-05",
    }]).ok).toBe(true);
  });

  it("REFUSE un ajustement manuel — la porte par laquelle naît un solde inexplicable", () => {
    const v = controlerMouvementsTvaDue(ligne4456("AJUST-2026"));
    expect(v.ok).toBe(false);
    expect(v.violations[0]).toContain("44560000");
    expect(v.violations[0]).toMatch(/acte fiscal/);
  });

  it("REFUSE une ligne 4456 sans référence", () => {
    const v = controlerMouvementsTvaDue(ligne4456(null));
    expect(v.ok).toBe(false);
    expect(v.violations[0]).toMatch(/sans référence/);
  });

  it("porte sur les MOUVEMENTS, pas sur le signe : les deux sens sont admis", () => {
    // Créditeur = TVA due, le cas ORDINAIRE. Débiteur = crédit reportable.
    // Interdire l'un des deux signalerait le normal.
    expect(controlerMouvementsTvaDue(ligne4456("DECL-TVA-2026-07", "TVA due", "C")).ok).toBe(true);
    expect(controlerMouvementsTvaDue(
      ligne4456("DECL-TVA-2026-06", "Crédit de TVA reportable", "D")).ok).toBe(true);
  });

  it("ne se déclenche pas sur une ligne à 0,00", () => {
    expect(controlerMouvementsTvaDue([{
      journal_code: "OD", compte_numero: "44560000", debit: 0, credit: 0, reference_piece: null,
    }]).ok).toBe(true);
  });

  it("ignore les comptes voisins : 4455 et 4458 ne sont pas le 4456", () => {
    for (const c of ["44551000", "44580000"]) {
      expect(controlerMouvementsTvaDue([{
        journal_code: "OD", compte_numero: c, debit: 100, credit: 0, reference_piece: null,
      }]).ok).toBe(true);
    }
  });

  it("les constantes MIROIR ne divergent pas de liquidation-tva", () => {
    // Le miroir existe pour préserver le sens des imports ; ce test est ce qui
    // empêche qu'il dérive en silence et désarme le verrou.
    expect(RACINE_TVA_DUE).toBe(COMPTE_TVA_DUE);
    expect(PREFIXES_PIECES_TVA_DUE[0]).toBe(PREFIXE_DECLARATION_TVA);
    expect(PREFIXES_PIECES_TVA_DUE[1]).toBe(PREFIXE_REGULARISATION_TVA);
    expect(LIBELLE_PAIEMENT_DGI_MIROIR).toBe(LIBELLE_PAIEMENT_DGI);
  });
});

// ─── VERROU 7 — pas de bascule sans règlement constaté ───────────────────────
describe("estBasculeTva", () => {
  const bascule = [
    { journal_code: "OD", compte_numero: "44580000", debit: 578, credit: 0, reference_piece: "FA-1" },
    { journal_code: "OD", compte_numero: "44551000", debit: 0, credit: 578, reference_piece: "FA-1" },
  ];

  it("reconnaît la bascule : attente ET exigible dans la même pièce", () => {
    expect(estBasculeTva(bascule)).toBe(true);
  });

  it("ne confond pas avec une DÉCLARATION, qui ne touche pas l'attente", () => {
    expect(estBasculeTva([
      { journal_code: "OD", compte_numero: "44551000", debit: 578, credit: 0, reference_piece: "DECL-TVA-2024-05" },
      { journal_code: "OD", compte_numero: "44560000", debit: 0, credit: 578, reference_piece: "DECL-TVA-2024-05" },
    ])).toBe(false);
  });

  it("ne confond pas avec une FACTURE, qui ne touche pas l'exigible", () => {
    expect(estBasculeTva([
      { journal_code: "VTE", compte_numero: "34210002", debit: 3468, credit: 0, reference_piece: "FA-1" },
      { journal_code: "VTE", compte_numero: "44580000", debit: 0, credit: 578, reference_piece: "FA-1" },
    ])).toBe(false);
  });
});

describe("controlerPreuveBascule", () => {
  const bascule = (ref: string | null, date = "2026-05-06", lettrage?: string) => [
    { journal_code: "OD", compte_numero: "44580000", date_ecriture: date,
      debit: 578, credit: 0, reference_piece: ref, lettrage_code: lettrage ?? null },
    { journal_code: "OD", compte_numero: "44551000", date_ecriture: date,
      debit: 0, credit: 578, reference_piece: ref, lettrage_code: lettrage ?? null },
  ];
  const encaissement = (ref: string | null, date: string, extra: any = {}) => ({
    journal_code: "CAI", compte_numero: "34210002", date_ecriture: date,
    debit: 0, credit: 3468, reference_piece: ref, ...extra,
  });

  it("REFUSE une bascule qu'aucune trésorerie n'appuie", () => {
    const v = controlerPreuveBascule(bascule("FA-1"), []);
    expect(v.ok).toBe(false);
    expect(v.violations[0]).toMatch(/sans règlement constaté/);
    expect(v.violations[0]).toContain("FA-1");
  });

  it("accepte la preuve par RÉFÉRENCE", () => {
    expect(controlerPreuveBascule(bascule("FA-1"),
      [encaissement("FA-1", "2026-05-06")]).ok).toBe(true);
  });

  it("accepte la preuve par CODE DE LETTRAGE, même sans référence sur la banque", () => {
    // Le cas SOMADIR FA-2024-0892 : la ligne CAI ne porte aucune référence, seul
    // le code AA la relie à la vente.
    expect(controlerPreuveBascule(bascule("FA-1", "2026-05-06", "AA"),
      [encaissement(null, "2026-05-06", { lettrage_code: "AA" })]).ok).toBe(true);
  });

  it("accepte la preuve par facture_id", () => {
    expect(controlerPreuveBascule(
      bascule("FA-1", "2026-05-06").map((l) => ({ ...l, facture_id: "f-42" })),
      [encaissement(null, "2026-05-06", { facture_id: "f-42" })]).ok).toBe(true);
  });

  it("REFUSE une trésorerie POSTÉRIEURE : elle ne prouve pas, elle contredit", () => {
    const v = controlerPreuveBascule(bascule("FA-1", "2026-05-06"),
      [encaissement("FA-1", "2026-07-01")]);
    expect(v.ok).toBe(false);
  });

  it("accepte une trésorerie ANTÉRIEURE — l'argent peut précéder l'écriture", () => {
    expect(controlerPreuveBascule(bascule("FA-1", "2026-05-06"),
      [encaissement("FA-1", "2026-05-02")]).ok).toBe(true);
  });

  it("REFUSE une preuve qui n'est pas de la TRÉSORERIE", () => {
    // Une ligne de vente portant la même référence ne prouve aucun mouvement.
    expect(controlerPreuveBascule(bascule("FA-1"), [
      { journal_code: "VTE", compte_numero: "34210002", date_ecriture: "2026-05-06",
        debit: 3468, credit: 0, reference_piece: "FA-1" },
    ]).ok).toBe(false);
  });

  it("REFUSE une trésorerie à 0,00 — un mouvement nul n'est pas un mouvement", () => {
    expect(controlerPreuveBascule(bascule("FA-1"), [
      { journal_code: "CAI", compte_numero: "34210002", date_ecriture: "2026-05-06",
        debit: 0, credit: 0, reference_piece: "FA-1" },
    ]).ok).toBe(false);
  });

  it("reste MUET sur ce qui n'est pas une bascule", () => {
    const declaration = [
      { journal_code: "OD", compte_numero: "44551000", date_ecriture: "2026-07-31",
        debit: 1880, credit: 0, reference_piece: "DECL-TVA-2026-07" },
      { journal_code: "OD", compte_numero: "44560000", date_ecriture: "2026-07-31",
        debit: 0, credit: 1880, reference_piece: "DECL-TVA-2026-07" },
    ];
    expect(controlerPreuveBascule(declaration, []).ok).toBe(true);
  });

  it("accepte la référence de RECLASSEMENT, que referencesPiece ajoute", () => {
    // Une facture antérieure au régime a sa TVA mise en attente par une OD
    // RECLASS-TVA-<ref> : la trésorerie peut porter l'une ou l'autre.
    expect(controlerPreuveBascule(bascule("FAC-307"),
      [encaissement("RECLASS-TVA-FAC-307", "2026-05-06")]).ok).toBe(true);
  });
});

// ─── Le verdict d'ensemble embarque bien les nouveaux verrous ────────────────
describe("controlerEcrituresRegime — les sept verrous", () => {
  it("remonte le sens de règlement inversé", () => {
    const v = controlerEcrituresRegime([
      { journal_code: "CAI", compte_numero: "51610000", date_ecriture: "2026-05-04",
        debit: 20160, credit: 0, reference_piece: null },
      { journal_code: "CAI", compte_numero: "44110000", date_ecriture: "2026-05-04",
        debit: 0, credit: 20160, reference_piece: null },
    ]);
    expect(v.ok).toBe(false);
    expect(v.violations.some((x) => /fournisseur CRÉDITÉ/.test(x))).toBe(true);
  });

  it("remonte un mouvement 4456 non autorisé", () => {
    const v = controlerEcrituresRegime([
      { journal_code: "OD", compte_numero: "44560000", date_ecriture: "2026-07-31",
        libelle: "ajustement", debit: 100, credit: 0, reference_piece: "AJUST" },
      { journal_code: "OD", compte_numero: "61410000", date_ecriture: "2026-07-31",
        libelle: "ajustement", debit: 0, credit: 100, reference_piece: "AJUST" },
    ]);
    expect(v.ok).toBe(false);
    expect(v.violations.some((x) => /44560000/.test(x))).toBe(true);
  });

  it("n'arme le verrou 7 que si l'appelant fournit la trésorerie", () => {
    const bascule = [
      { journal_code: "OD", compte_numero: "44580000", date_ecriture: "2026-05-06",
        debit: 578, credit: 0, reference_piece: "FA-1" },
      { journal_code: "OD", compte_numero: "44551000", date_ecriture: "2026-05-06",
        debit: 0, credit: 578, reference_piece: "FA-1" },
    ];
    // Sans trésorerie : la fonction pure ne peut rien prouver, elle se tait.
    expect(controlerEcrituresRegime(bascule).ok).toBe(true);
    // Avec une trésorerie VIDE : la lecture a eu lieu, la preuve manque.
    expect(controlerEcrituresRegime(bascule, { tresorerie: [] }).ok).toBe(false);
  });

  it("laisse passer un cycle complet et régulier", () => {
    const v = controlerEcrituresRegime([
      { journal_code: "CAI", compte_numero: "44110001", date_ecriture: "2026-05-04",
        debit: 20160, credit: 0, reference_piece: "ACH-1" },
      { journal_code: "CAI", compte_numero: "51610000", date_ecriture: "2026-05-04",
        debit: 0, credit: 20160, reference_piece: "ACH-1" },
    ]);
    expect(v.violations).toEqual([]);
  });
});
