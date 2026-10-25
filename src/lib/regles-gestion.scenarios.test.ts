import { describe, it, expect } from "vitest";
// Banc de scénarios métier : chaque attendu est calculé À LA MAIN d'après le CGNC,
// le CGI 2026 et les taux CNSS 2026 — jamais relu dans le code testé. Un écart
// ici est une règle de gestion fausse, pas un test à « mettre à jour ».
import { calculBulletin } from "@/server/paie.functions";
import { lignesEcrituresPaie, controlerLignesPaie } from "@/lib/ecritures-paie";
import { deriveCategorie, genererLignesBQ, type LigneBQ } from "@/lib/comptabilite-bq";
import { genererEcrituresAchat, controlerLignesAchat, genererOdBasculeTva } from "@/lib/genererEcritures";
import { lignesEcrituresVente, controlerLignesVente } from "@/lib/ecritures-vente";
import { liquiderTva, construireOdDeclaration, controlerBouclagePeriode, controlerPiece, type LigneTva } from "@/lib/liquidation-tva";
import { soldesCloture, lignesANouveaux } from "@/lib/a-nouveaux";
import { TVA_TAUX_EN_VIGUEUR, puHtToTtc } from "@/lib/tva";

const r2 = (n: number) => Math.round(n * 100) / 100;
const racine = (c: string) => c.replace(/0+$/, "");
const solde = (lignes: { compte_numero?: string | null; debit?: number | null; credit?: number | null }[], prefixe: string) =>
  r2(lignes.filter((l) => String(l.compte_numero).startsWith(prefixe))
    .reduce((s, l) => s + (l.debit ?? 0) - (l.credit ?? 0), 0));
const equilibreBQ = (l: LigneBQ[]) => r2(l.reduce((s, x) => s + x.debit - x.credit, 0));

// ─── 1. Paie 2026 ────────────────────────────────────────────────────────────
describe("paie 2026 — bulletins calculés à la main", () => {
  it("5 000 MAD, célibataire : IR nul, frais pro 35 %", () => {
    // CNSS 5000×4,48 % = 224 ; AMO 5000×2,26 % = 113 ; frais pro 35 % = 1 750.
    // Base IR 5000−1750−224−113 = 2 913/mois = 34 956/an ≤ 40 000 → IR 0.
    const b = calculBulletin({ salaire_base: 5000 });
    expect(b).toMatchObject({ cnss_salarie: 224, amo_salarie: 113, ir_net: 0, net_a_payer: 4663 });
    // Patronal : 5000×8,98 % + 5000×6,40 % = 449 + 320 = 769 ; AMO 205,50 ; TFP 80.
    expect(b).toMatchObject({ cnss_patronal: 769, amo_patronal: 205.5, tfp: 80, cout_employeur: 6054.5 });
  });

  it("15 000 MAD, marié 2 enfants : plafond CNSS, frais pro plafonnés, 3 personnes à charge", () => {
    // CNSS 6000×4,48 % = 268,80 ; AMO 15000×2,26 % = 339.
    // Frais pro : 180 000/an > 78 000 → 25 % = 45 000, plafonné 35 000 → 2 916,67/mois.
    // Base IR = 15000−2916,67−268,80−339 = 11 475,53 → 137 706,40/an
    // IR = 137 706,40×34 % − 22 000 = 24 820,18/an = 2 068,35/mois
    // Charges de famille 3×600/12 = 150 → IR net 1 918,35.
    const b = calculBulletin({ salaire_base: 15000, situation_familiale: "marie", nombre_enfants: 2 });
    expect(b.cnss_salarie).toBe(268.8);
    expect(b.amo_salarie).toBe(339);
    expect(b.ir_net).toBe(1918.35);
    expect(b.net_a_payer).toBe(12473.85);
    // Patronal : 6000×8,98 % = 538,80 + AF 15000×6,40 % = 960 → 1 498,80 ; AMO 616,50 ; TFP 240.
    expect(b.cnss_patronal).toBe(1498.8);
    expect(b.cout_employeur).toBe(17355.3);
  });

  it("30 000 MAD, marié 7 enfants : tranche 37 %, charges de famille plafonnées à 6 personnes", () => {
    // Base IR = 30000−2916,67−268,80−678 = 26 136,53 → 313 638,40/an
    // IR = ×37 % − 27 400 = 88 646,21/an = 7 387,18/mois ; famille 6×600/12 = 300.
    const b = calculBulletin({ salaire_base: 30000, situation_familiale: "marie", nombre_enfants: 7 });
    expect(b.ir_net).toBe(7087.18);
  });

  it("6 500 MAD : 78 000/an pile, frais pro encore à 35 %", () => {
    // Frais pro 6500×35 % = 2 275. CNSS 268,80 ; AMO 146,90.
    // Base 6500−2275−268,80−146,90 = 3 809,30 → 45 711,60/an → 10 % − 4 000 = 571,16/an = 47,60/mois.
    const b = calculBulletin({ salaire_base: 6500 });
    expect(b.ir_net).toBe(47.6);
  });

  it("indemnités exonérées : VERSÉES au salarié, hors base CNSS et IR", () => {
    // Salaire 5 000 + indemnité de transport exonérée 500.
    // Brut global 5 500 ; brut imposable 5 000 ; cotisations sur 5 000 → 224 + 113.
    // Net à payer = 5 500 − 337 = 5 163 : l'indemnité est payée, pas retenue.
    const b = calculBulletin({ salaire_base: 5000, indemnites_exo: 500 });
    expect(b.brut_global).toBe(5500);
    expect(b.brut_imposable).toBe(5000);
    expect(b.cnss_salarie).toBe(224);
    expect(b.amo_salarie).toBe(113);
    expect(b.net_a_payer).toBe(5163);
  });

  it("avantage en nature : imposable et cotisable, mais NON versé en espèces", () => {
    // Salaire 8 000 + logement de fonction évalué 1 000.
    // Brut 9 000 ; CNSS 6000×4,48 % = 268,80 ; AMO 9000×2,26 % = 203,40.
    // Frais pro 108 000/an > 78 000 → 25 % = 27 000/an = 2 250/mois.
    // Base IR = 9000−2250−268,80−203,40 = 6 277,80 → 75 333,60/an → 20 % − 10 000 = 5 066,72/an = 422,23.
    // Net à payer = 9 000 − (268,80+203,40+422,23) − 1 000 (avantage non versé) = 7 105,57.
    const b = calculBulletin({ salaire_base: 8000, avantages_nature: 1000 });
    expect(b.ir_net).toBe(422.23);
    expect(b.net_a_payer).toBe(7105.57);
  });

  it("l'écriture de paie est équilibrée et sur les bons comptes CGNC", () => {
    const b = calculBulletin({ salaire_base: 15000, situation_familiale: "marie", nombre_enfants: 2, cimr_taux: 6 });
    const lignes = lignesEcrituresPaie({
      dossier_id: "D", periode: "2026-03", net_a_payer: b.net_a_payer, total_retenues: b.total_retenues,
      cnss_salarie: b.cnss_salarie, amo_salarie: b.amo_salarie, ir_net: b.ir_net, cimr_salarie: b.cimr_salarie,
      cnss_patronal: b.cnss_patronal, amo_patronal: b.amo_patronal, taxe_formation_pro: b.tfp, cimr_patronal: b.cimr_patronal,
    }, "Alami");
    expect(controlerLignesPaie(lignes).ok).toBe(true);
    const comptes = new Set(lignes.map((l) => racine(l.compte_numero)));
    expect([...comptes].sort()).toEqual(["4432", "4441", "4443", "44525", "6171", "6174"].sort());
    expect(solde(lignes, "6171")).toBe(15000);            // brut
    expect(-solde(lignes, "44525")).toBe(b.ir_net);         // IR retenu
    expect(-solde(lignes, "4443")).toBe(r2(b.cimr_salarie + b.cimr_patronal)); // CIMR 2 × 900
    expect(lignes[0].date_ecriture).toBe("2026-03-31");     // fin de mois sans date de paiement
  });
});

// ─── 2. Banque : catégorisation et écritures BQ ──────────────────────────────
describe("relevé bancaire — catégorisation déterministe", () => {
  const cas: [string, "debit" | "credit", string, number][] = [
    ["FRAIS TENUE DE COMPTE", "debit", "61473", 10],
    ["COMMISSION SUR VIREMENT", "debit", "61473", 10],
    ["TVA S/COMMISSION", "debit", "34552", 0],
    ["PRLV CNSS 03/2026", "debit", "4441", 0],
    ["VIR SALAIRE MARS", "debit", "4432", 0],
    ["PAIEMENT TVA 03/2026", "debit", "4456", 0],
    ["VIR IR SALAIRES MARS", "debit", "44525", 0],
    ["ACOMPTE IS T1 2026", "debit", "3453", 0],
    ["RETRAIT GAB CASA", "debit", "5161", 0],
    ["VIREMENT INTERNE", "debit", "5115", 0],
    ["FACTURE IAM MARS", "debit", "6145", 20],
    ["ONEE ELECTRICITE", "debit", "61251", 20],
    ["STATION AFRIQUIA GASOIL", "debit", "61223", 0],
    ["DROIT DE TIMBRE", "debit", "61671", 0],
    ["VIR RECU CLIENT ATLAS", "credit", "3421", 0],
  ];
  it.each(cas)("« %s » (%s) → %s, TVA %d %%", (libelle, sens, compte, tva) => {
    const c = deriveCategorie(libelle, sens);
    expect(racine(c.code)).toBe(compte);
    expect(c.tva).toBe(tva);
  });

  it("un nom contenant « AMO » n'est pas un prélèvement CNSS", () => {
    expect(deriveCategorie("PRLV CLINIQUE SALAMO", "debit").categorie).not.toBe("cnss_amo");
  });
});

describe("relevé bancaire — écritures du journal BQ", () => {
  it("dépense sans pièce → 3497, recette sans pièce → 4497, jamais une charge devinée", () => {
    const d = genererLignesBQ({ libelle: "PRLV INCONNU", type: "debit", montant: -500 });
    expect(d.map((l) => [l.compte, l.debit, l.credit])).toEqual([["3497", 500, 0], ["5141", 0, 500]]);
    const c = genererLignesBQ({ libelle: "VIR RECU X", type: "credit", montant: 800 });
    expect(c.map((l) => [l.compte, l.debit, l.credit])).toEqual([["4497", 0, 800], ["5141", 800, 0]]);
  });

  it("règlement d'une facture fournisseur → 4411 au TTC, aucune TVA en banque", () => {
    const l = genererLignesBQ({ libelle: "VIR FOURNISSEUR", type: "debit", montant: -1200, factureLiee: true });
    expect(l.map((x) => [x.compte, x.debit, x.credit])).toEqual([["4411", 1200, 0], ["5141", 0, 1200]]);
  });

  it("justificatif à 20 % déductible : HT en charge, TVA au 34552", () => {
    const l = genererLignesBQ({ libelle: "ACHAT FOURNITURES", type: "debit", montant: -1200,
      justificatif: { compte_pcm: "61254", taux_tva: 20, eligible_edi: true } });
    expect(l.map((x) => [x.compte, x.debit])).toEqual([["61254", 1000], ["34552", 200], ["5141", 0]]);
    expect(equilibreBQ(l)).toBe(0);
  });

  it("carburant : TVA non déductible (art. 106 CGI), TTC intégral en 61223", () => {
    const l = genererLignesBQ({ libelle: "STATION GASOIL", type: "debit", montant: -600,
      justificatif: { compte_pcm: "61223", taux_tva: 10, eligible_edi: false } });
    expect(l.map((x) => [x.compte, x.debit])).toEqual([["61223", 600], ["5141", 0]]);
  });

  it("commission bancaire puis sa TVA : 61473 + 34552", () => {
    const f = genererLignesBQ({ libelle: "FRAIS TENUE DE COMPTE", type: "debit", montant: -50,
      categorie: "frais_bancaires", justificatif: { compte_pcm: "61473", taux_tva: 0, eligible_edi: false } });
    const t = genererLignesBQ({ libelle: "TVA S/FRAIS TENUE", type: "debit", montant: -5 });
    expect(f[0].compte).toBe("61473");
    expect(t[0].compte).toBe("34552");
  });
});

// ─── 3. Achats et ventes, régime des encaissements ───────────────────────────
describe("achats — TVA en attente jusqu'au paiement", () => {
  it("facture 1 000 HT + 200 TVA : D charge / D 3458 / C 4411, puis bascule au prorata", () => {
    const a = genererEcrituresAchat({ dossier_id: "D", facture_id: "FA1", date_facture: "2026-04-02",
      montant_ht: 1000, montant_tva: 200, montant_ttc: 1200, compte_charge: "61254", code_auxiliaire: null });
    expect(controlerLignesAchat(a).ok).toBe(true);
    expect(a.map((l) => [racine(l.compte_numero), l.debit, l.credit]))
      .toEqual([["61254", 1000, 0], ["3458", 200, 0], ["4411", 0, 1200]]);
    // Paiement partiel de 600 TTC → 50 % de la TVA devient déductible : 100.
    const od = genererOdBasculeTva({ sens: "fournisseur", montantTva: 200, montantTtc: 1200,
      montantRegle: 600, date: "2026-04-20", journalReglement: "BQ" });
    expect(solde(od, "34552")).toBe(100);
    expect(solde(od, "3458")).toBe(-100);
    // Un « règlement » passé en OD n'est pas un mouvement d'argent : aucune bascule.
    expect(genererOdBasculeTva({ sens: "fournisseur", montantTva: 200, montantTtc: 1200,
      montantRegle: 600, date: "2026-04-20", journalReglement: "OD" })).toEqual([]);
  });
});

describe("ventes — acompte puis facture de solde", () => {
  const base = { dossier_id: "D", date_facture: "2026-05-02", compte_client: "3421", compte_produit: "7124" };

  it("facture ordinaire : D 3421 TTC / C 7124 HT / C 4458 TVA", () => {
    const v = lignesEcrituresVente({ ...base, facture_id: "F1", reference: "FAC-1",
      montant_ht: 10000, montant_tva: 2000, montant_ttc: 12000, type: "facture" });
    expect(controlerLignesVente(v, "facture").ok).toBe(true);
    expect(v.map((l) => [racine(l.compte_numero), l.debit, l.credit]))
      .toEqual([["3421", 12000, 0], ["7124", 0, 10000], ["4458", 0, 2000]]);
  });

  it("commande de 10 000 HT : acompte 3 000 HT puis solde 7 000 HT → CA 10 000, 4421 soldé", () => {
    const acompte = lignesEcrituresVente({ ...base, facture_id: "A1", reference: "ACP-1",
      montant_ht: 3000, montant_tva: 600, montant_ttc: 3600, type: "acompte" });
    const soldeFacture = lignesEcrituresVente({ ...base, facture_id: "S1", reference: "FAC-2",
      montant_ht: 7000, montant_tva: 1400, montant_ttc: 8400, type: "solde", montant_acomptes_ht: 3000 });
    expect(controlerLignesVente(acompte, "acompte").ok).toBe(true);
    expect(controlerLignesVente(soldeFacture, "solde").ok).toBe(true);
    const gl = [...acompte, ...soldeFacture];
    expect(-solde(gl, "7124")).toBe(10000);   // chiffre d'affaires de la commande, une seule fois
    expect(solde(gl, "4421")).toBe(0);        // l'avance est entièrement imputée
    expect(-solde(gl, "4458")).toBe(2000);    // TVA de la commande : 600 + 1 400
    expect(solde(gl, "3421")).toBe(12000);    // le client doit 3 600 + 8 400
  });

  it("facture de solde sans acompte retrouvé : pas d'OD d'imputation", () => {
    const v = lignesEcrituresVente({ ...base, facture_id: "S2", reference: "FAC-3",
      montant_ht: 7000, montant_tva: 1400, montant_ttc: 8400, type: "solde" });
    expect(v.some((l) => l.journal_code === "OD")).toBe(false);
    expect(-solde(v, "7124")).toBe(7000);
  });
});

// ─── 4. Déclarations de TVA sur trois mois ───────────────────────────────────
describe("TVA mensuelle — dette, crédit reporté, imputation", () => {
  it("janvier dû 6 000 ; février crédit 1 500 ; mars 2 500 brut − 1 500 imputé = 1 000 dû", () => {
    const gl: LigneTva[] = [
      { journal_code: "OD", compte_numero: "44551000", date_ecriture: "2026-01-15", debit: 0, credit: 10000 },
      { journal_code: "OD", compte_numero: "34552000", date_ecriture: "2026-01-20", debit: 4000, credit: 0 },
    ];
    const jan = liquiderTva(gl, "2026-01")!;
    expect(jan).toMatchObject({ net: 6000, dette: true });
    gl.push(...construireOdDeclaration(jan));

    gl.push(
      { journal_code: "OD", compte_numero: "44551000", date_ecriture: "2026-02-10", debit: 0, credit: 500 },
      { journal_code: "OD", compte_numero: "34552000", date_ecriture: "2026-02-12", debit: 2000, credit: 0 },
    );
    const fev = liquiderTva(gl, "2026-02")!;
    expect(fev).toMatchObject({ net: -1500, dette: false, montant: 1500 });
    const odFev = construireOdDeclaration(fev);
    expect(controlerPiece(odFev).ok).toBe(true);
    expect(solde(odFev, "3456")).toBe(1500);
    gl.push(...odFev);

    gl.push(
      { journal_code: "OD", compte_numero: "44551000", date_ecriture: "2026-03-05", debit: 0, credit: 3000 },
      { journal_code: "OD", compte_numero: "34552000", date_ecriture: "2026-03-08", debit: 500, credit: 0 },
    );
    const mars = liquiderTva(gl, "2026-03")!;
    expect(mars).toMatchObject({ creditAnterieur: 1500, creditImpute: 1500, net: 1000, dette: true });
    gl.push(...construireOdDeclaration(mars));
    expect(solde(gl, "3456")).toBe(0);
    expect(solde(gl, "4456")).toBe(-7000);          // 6 000 (janvier) + 1 000 (mars), non encore payés
    expect(controlerBouclagePeriode(gl, "2026-03")!.creditReporte).toBe(0);
  });
});

// ─── 5. Clôture et à-nouveaux ────────────────────────────────────────────────
describe("à-nouveaux — seul le bilan est reporté, le résultat attend son affectation", () => {
  const exercice = (venteHt: number, chargeHt: number) => [
    { compte_numero: "51410000", date_ecriture: "2026-06-01", debit: venteHt, credit: 0 },
    { compte_numero: "71240000", date_ecriture: "2026-06-01", debit: 0, credit: venteHt },
    { compte_numero: "61254000", date_ecriture: "2026-07-01", debit: chargeHt, credit: 0 },
    { compte_numero: "51410000", date_ecriture: "2026-07-01", debit: 0, credit: chargeHt },
  ];

  it("bénéfice 30 000 → crédit 1181, aucune classe 6/7 reportée", () => {
    const plan = lignesANouveaux(soldesCloture(exercice(50000, 20000), "2027-01-01"), { dossier_id: "D", date: "2027-01-01" });
    expect(plan.violations).toEqual([]);
    expect(plan.ecart).toBe(0);
    expect(plan.lignes.some((l) => /^[67]/.test(l.compte_numero))).toBe(false);
    expect(plan.lignes.find((l) => l.compte_numero === "1181")).toMatchObject({ debit: 0, credit: 30000 });
  });

  it("perte 5 000 → débit 1189", () => {
    const plan = lignesANouveaux(soldesCloture(exercice(10000, 15000), "2027-01-01"), { dossier_id: "D", date: "2027-01-01" });
    expect(plan.lignes.find((l) => l.compte_numero === "1189")).toMatchObject({ debit: 5000, credit: 0 });
  });
});

// ─── 6. Taux de TVA ──────────────────────────────────────────────────────────
describe("taux de TVA 2026", () => {
  it("deux taux en vigueur, 20 % et 10 %, plus l'exonération", () => {
    expect([...TVA_TAUX_EN_VIGUEUR]).toEqual([0, 10, 20]);
    expect(puHtToTtc(100, 20)).toBe(120);
    expect(puHtToTtc(100, 10)).toBe(110);
  });
});
