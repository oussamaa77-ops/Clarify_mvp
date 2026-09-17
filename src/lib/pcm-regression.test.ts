// ============================================================================
// Tests de régression PCM — chaque générateur d'écritures, du fait générateur à
// la balance, contrôlé sur trois questions : les comptes sont-ils recevables
// (référentiel CGNC), chacun est-il dans son RÔLE (client en 342, TVA en 4455…),
// et la partie double tient-elle ?
// ============================================================================

import { describe, expect, it } from "vitest";
import {
  controlerEcrituresRegime, controlerLignesAchat, controlerSensReglement,
  genererEcrituresAchat, genererEcrituresVente, genererOdBasculeTva,
} from "@/lib/genererEcritures";
import { controlerLignesVente } from "@/lib/ecritures-vente";
import {
  construireOdDeclaration, construireOdPaiementDgi, construireOdRegularisationTva, liquiderTva,
} from "@/lib/liquidation-tva";
import { deriveCategorie, genererLignesBQ, PCM_MAP } from "@/lib/comptabilite-bq";
import { imputationTresorerie, journalDeTresorerie } from "@/lib/comptes-tresorerie";
import { compteTiersAuxiliaire } from "@/lib/comptes-auxiliaires";
import { COMPTES_TVA, compteLettrable, planifierLettrage, RACINES_TVA_NON_LETTRABLES } from "@/services/lettrage";
import { auditComptesSuspens, totalGeneralBalance, type LigneBalance } from "@/lib/balance-comptable";
import { deriveTiers, inferJournal, normalizeRows } from "@/lib/import-grandlivre";
import { lignesANouveaux, soldesCloture } from "@/lib/a-nouveaux";
import {
  COMPTE_CHARGE_DEFAUT, COMPTE_PRODUIT_DEFAUT, DICTIONNAIRE_PCM, FALLBACK_SECTEUR,
} from "@/lib/categorization-engine";
import { statutPaiement } from "@/lib/paiements";
import { normaliserComptesLignes, normaliserNumeroCompte } from "@/lib/numero-compte";
import { controlerComptesPcm, PCM, validatePcmAccount, type UsageCompte } from "@/lib/pcm-referentiel";

const D = "22222222-2222-2222-2222-222222222222";
const r2 = (x: number) => Math.round(x * 100) / 100;
type L = { compte_numero?: string | null; compte?: string | null; debit?: any; credit?: any; journal_code?: string | null };
const ecart = (l: L[]) => r2(l.reduce((s, x) => s + Number(x.debit || 0) - Number(x.credit || 0), 0));
const recevables = (l: L[]) => expect(controlerComptesPcm(l).violations).toEqual([]);
const role = (compte: string | null | undefined, usage: UsageCompte) =>
  expect(validatePcmAccount(compte, { usage }).ok, `${compte} hors rôle « ${usage} »`).toBe(true);

/** Lignes de banque (forme `compte`) → lignes de grand livre. */
const versGL = (lignes: { compte: string; libelle: string; debit: number; credit: number }[], date: string, ref: string) =>
  lignes.map((l) => ({
    journal_code: journalDeTresorerie(l.compte === PCM.BANQUE ? l.compte : PCM.BANQUE),
    compte_numero: l.compte, date_ecriture: date, libelle: l.libelle,
    debit: l.debit, credit: l.credit, reference_piece: ref,
  }));

// ─── Un cycle complet : vente, achat, règlements, bascules, déclaration ──────
const vente = genererEcrituresVente({
  dossier_id: D, facture_id: "FV1", reference: "FA-2026-001", date_facture: "2026-03-02",
  montant_ht: 10000, montant_tva: 2000, montant_ttc: 12000,
  compte_client: compteTiersAuxiliaire("client", "C0002"), compte_produit: PCM.VENTES_SERVICES, type: "facture",
});
const achat = genererEcrituresAchat({
  dossier_id: D, facture_id: "FF1", reference: "FF-2026-010", date_facture: "2026-03-03",
  montant_ht: 5000, montant_tva: 1000, montant_ttc: 6000,
  compte_charge: PCM.ENTRETIEN_REPARATIONS, code_auxiliaire: "F0005",
});
const encaissement = versGL(genererLignesBQ({ libelle: "VIR CLIENT FA-2026-001", type: "credit", montant: 12000, factureLiee: true }), "2026-03-20", "FA-2026-001");
const decaissement = versGL(genererLignesBQ({ libelle: "VIR FOURNISSEUR FF-2026-010", type: "debit", montant: 6000, factureLiee: true }), "2026-03-25", "FF-2026-010");
const basculeVente = genererOdBasculeTva({
  sens: "client", montantTva: 2000, montantTtc: 12000, montantRegle: 12000,
  date: "2026-03-20", journalReglement: "BQ", reference: "FA-2026-001", lettrageCode: "AA",
});
const basculeAchat = genererOdBasculeTva({
  sens: "fournisseur", montantTva: 1000, montantTtc: 6000, montantRegle: 6000,
  date: "2026-03-25", journalReglement: "BQ", reference: "FF-2026-010", lettrageCode: "AB",
});
const flux = [...vente, ...achat, ...encaissement, ...decaissement, ...basculeVente, ...basculeAchat];
const liquidation = liquiderTva(flux, "2026-03")!;
const declaration = construireOdDeclaration(liquidation);
const paiementDgi = construireOdPaiementDgi({ montant: liquidation.montant, date: "2026-04-20", periode: "2026-03" });
const grandLivre = [...flux, ...declaration, ...paiementDgi];

const PIECES: [string, L[]][] = [
  ["vente", vente], ["achat", achat], ["encaissement", encaissement], ["décaissement", decaissement],
  ["bascule vente", basculeVente], ["bascule achat", basculeAchat],
  ["déclaration TVA", declaration], ["paiement DGI", paiementDgi],
];

describe("génération des écritures — chaque pièce du cycle", () => {
  it.each(PIECES)("%s : équilibrée, comptes recevables, régime respecté", (_nom, piece) => {
    expect(piece.length).toBeGreaterThan(0);
    expect(ecart(piece)).toBe(0);
    recevables(piece);
    expect(controlerEcrituresRegime(piece as any).violations).toEqual([]);
  });

  it("reste recevable après la frontière de normalisation (8 chiffres)", () => {
    recevables(normaliserComptesLignes(grandLivre));
    expect(ecart(normaliserComptesLignes(grandLivre))).toBe(0);
  });
});

describe("ventes — client 3421, produit classe 7, TVA en attente 4458", () => {
  it("impute chaque ligne dans son rôle", () => {
    role(vente.find((l) => l.debit > 0)!.compte_numero, "client");
    role(vente.find((l) => l.compte_numero.startsWith("7"))!.compte_numero, "produit");
    role(vente.find((l) => l.compte_numero === COMPTES_TVA.client.attente)!.compte_numero, "tva_attente_vente");
    expect(controlerLignesVente(vente, "facture").ok).toBe(true);
  });

  it("acompte (4191 — dérogation à valider) et solde restent recevables et équilibrés", () => {
    const base = {
      dossier_id: D, facture_id: "FV2", reference: "FA-2026-002", date_facture: "2026-03-05",
      montant_ht: 1000, montant_tva: 200, montant_ttc: 1200, compte_client: "3421", compte_produit: "7111",
    };
    for (const type of ["acompte", "solde"] as const) {
      const l = genererEcrituresVente({ ...base, type });
      expect(controlerLignesVente(l, type).violations, type).toEqual([]);
      expect(ecart(l), type).toBe(0);
    }
  });

  it("REFUSE un compte client pris chez les fournisseurs", () => {
    const l = genererEcrituresVente({ ...venteCtx(), compte_client: "44110001" });
    expect(controlerLignesVente(l, "facture").violations.join(" ")).toMatch(/compte client/);
  });

  it("REFUSE un produit hors référentiel (7611) ou pris en classe 6", () => {
    for (const compte_produit of ["7611", "6141"]) {
      const l = genererEcrituresVente({ ...venteCtx(), compte_produit });
      expect(controlerLignesVente(l, "facture").ok, compte_produit).toBe(false);
    }
  });
});

function venteCtx() {
  return {
    dossier_id: D, facture_id: "FV9", reference: "FA-9", date_facture: "2026-03-09",
    montant_ht: 100, montant_tva: 20, montant_ttc: 120,
    compte_client: "3421", compte_produit: "7124", type: "facture" as const,
  };
}

describe("achats — charge classe 6, TVA en attente 3458, fournisseur 4411", () => {
  it("impute chaque ligne dans son rôle", () => {
    role(achat[0].compte_numero, "charge");
    role(achat.find((l) => l.compte_numero === COMPTES_TVA.fournisseur.attente)!.compte_numero, "tva_attente_achat");
    role(achat.find((l) => l.credit > 0)!.compte_numero, "fournisseur");
    expect(achat.find((l) => l.credit > 0)!.compte_numero).toBe("44110005");
    expect(controlerLignesAchat(achat).ok).toBe(true);
  });

  const achatCtx = {
    dossier_id: D, facture_id: "FF9", date_facture: "2026-03-09",
    montant_ht: 100, montant_tva: 20, montant_ttc: 120,
  };

  it("REFUSE une charge hors référentiel (6226, plan français)", () => {
    const c = controlerLignesAchat(genererEcrituresAchat({ ...achatCtx, compte_charge: "6226" }));
    expect(c.violations.join(" ")).toMatch(/rubrique 62/);
  });

  it("REFUSE une dette portée sur un compte client", () => {
    const c = controlerLignesAchat(genererEcrituresAchat({ ...achatCtx, compte_tiers: "34210001" }));
    expect(c.violations.join(" ")).toMatch(/compte fournisseur/);
  });
});

describe("TVA — bascule, déclaration, paiement, régularisation", () => {
  it("la bascule vente passe 4458 → 44551, la bascule achat 3458 → 34552", () => {
    expect(basculeVente.map((l) => [l.compte_numero, l.debit, l.credit]))
      .toEqual([["4458", 2000, 0], ["44551", 0, 2000]]);
    expect(basculeAchat.map((l) => [l.compte_numero, l.debit, l.credit]))
      .toEqual([["34552", 1000, 0], ["3458", 0, 1000]]);
    role(basculeVente[1].compte_numero, "tva_collectee");
    role(basculeAchat[0].compte_numero, "tva_recuperable");
  });

  it("la déclaration solde 44551 et 34552 contre 4456", () => {
    expect(liquidation).toMatchObject({ collectee: 2000, deductible: 1000, net: 1000, dette: true });
    expect(declaration.map((l) => l.compte_numero)).toEqual(["44551", "34552", "4456"]);
    role(declaration[2].compte_numero, "tva_due");
  });

  it("le paiement DGI part en BQ sur la banque, en CAI sur la caisse", () => {
    expect(paiementDgi.map((l) => [l.journal_code, l.compte_numero])).toEqual([["BQ", "4456"], ["BQ", "5141"]]);
    const caisse = construireOdPaiementDgi({ montant: 10, date: "2026-04-20", periode: "2026-03", compteBanque: PCM.CAISSE_DEFAUT });
    expect(caisse.every((l) => l.journal_code === "CAI")).toBe(true);
    recevables(caisse);
  });

  it("un règlement partiel ne bascule que le prorata", () => {
    const partiel = genererOdBasculeTva({
      sens: "client", montantTva: 2000, montantTtc: 12000, montantRegle: 6000, date: "2026-03-20", journalReglement: "BQ",
    });
    expect(partiel[0].debit).toBe(1000);
    expect(ecart(partiel)).toBe(0);
  });

  it("la régularisation reste hors flux, équilibrée, sur des comptes de TVA", () => {
    const regul = construireOdRegularisationTva({ periodeRegularisee: "2026-01", sens: "deduction", montant: 30, date: "2026-03-31" });
    expect(regul.map((l) => l.compte_numero)).toEqual(["34552", "4456"]);
    expect(ecart(regul)).toBe(0);
    expect(controlerEcrituresRegime(regul).ok).toBe(true);
  });
});

describe("banque et caisse", () => {
  const ROLE_CONTREPARTIE: Record<string, UsageCompte> = {
    encaissement_client: "client", paiement_fournisseur: "fournisseur", cnss_amo: "organisme_social",
    tva_dgi: "tva_due", retrait_especes: "caisse", virement_interne: "virement_fonds",
    interets_crediteurs: "produit",
  };

  it.each(Object.entries(PCM_MAP))("PCM_MAP.%s : compte recevable et dans son rôle", (categorie, { code }) => {
    role(code, ROLE_CONTREPARTIE[categorie] ?? "charge");
  });

  it("chaque catégorie produit une pièce BQ équilibrée, dans les deux sens", () => {
    for (const categorie of Object.keys(PCM_MAP)) {
      for (const type of ["debit", "credit"]) {
        const l = genererLignesBQ({ libelle: "OPERATION", type, montant: 1234.56, categorie });
        expect(ecart(l), `${categorie} ${type}`).toBe(0);
        recevables(l);
        expect(l.some((x) => x.compte === PCM.BANQUE), categorie).toBe(true);
      }
    }
  });

  it("un justificatif éligible isole HT et TVA sur des comptes recevables", () => {
    const l = genererLignesBQ({
      libelle: "REPARATION", type: "debit", montant: 1200,
      justificatif: { compte_pcm: PCM.ENTRETIEN_REPARATIONS, taux_tva: 20, eligible_edi: true },
    });
    expect(l.map((x) => [x.compte, x.debit, x.credit])).toEqual([["6133", 1000, 0], ["34552", 200, 0], ["5141", 0, 1200]]);
  });

  it("REFUSE un justificatif portant un compte hors référentiel", () => {
    expect(() => genererLignesBQ({
      libelle: "X", type: "debit", montant: 10, justificatif: { compte_pcm: "6226", taux_tva: 0 },
    })).toThrow(/rubrique 62/);
  });

  it("verrouille les corrections de la table bancaire", () => {
    expect({
      telecom: PCM_MAP.telecom.code, assurance: PCM_MAP.assurance.code,
      taxe_professionnelle: PCM_MAP.taxe_professionnelle.code, frais_representation: PCM_MAP.frais_representation.code,
      interets_crediteurs: PCM_MAP.interets_crediteurs.code, entretien: PCM_MAP.entretien.code,
    }).toEqual({
      telecom: "6145", assurance: "6134", taxe_professionnelle: "6161",
      frais_representation: "6143", interets_crediteurs: "7381", entretien: "6133",
    });
    const interets = genererLignesBQ({ libelle: "INTERETS", type: "credit", montant: 50, categorie: "interets_crediteurs" });
    expect(interets[0].compte).toBe("7381");
  });

  it("deriveCategorie lit son compte dans PCM_MAP, sans copie divergente", () => {
    for (const lib of ["RETRAIT GAB", "PRLV IAM", "LOYER MARS", "CNSS FEV", "AGIOS", "ASSURANCE RC", "VIR AG EMIS", "FOURNISSEUR X"]) {
      const d = deriveCategorie(lib, "debit");
      expect(d.code, lib).toBe(PCM_MAP[d.categorie].code);
    }
  });

  it("espèces → caisse 516 en CAI ; tout autre mode → banque 514 en BQ", () => {
    expect(imputationTresorerie("especes")).toMatchObject({ compte: "51610000", journal: "CAI" });
    expect(imputationTresorerie("virement")).toMatchObject({ compte: "5141", journal: "BQ" });
    role(imputationTresorerie("especes").compte, "caisse");
    role(imputationTresorerie("cheque").compte, "banque");
    // Une caisse paramétrée hors rubrique 516 (5143 = Trésorerie Générale) est écartée.
    expect(imputationTresorerie("especes", { compte_caisse: "5143" }).compte).toBe("51610000");
  });

  it("le sens des règlements générés est correct (fournisseur débité, client crédité)", () => {
    expect(controlerSensReglement([...encaissement, ...decaissement]).ok).toBe(true);
    const inverse = decaissement.map((l) => ({ ...l, debit: l.credit, credit: l.debit }));
    expect(controlerSensReglement(inverse).ok).toBe(false);
  });
});

describe("comptes d'attente 47 — rapprochement bancaire", () => {
  const orpheline = genererLignesBQ({ libelle: "VIREMENT RECU INCONNU", type: "credit", montant: 500 });
  const sortie = genererLignesBQ({ libelle: "PRELEVEMENT INCONNU", type: "debit", montant: 80 });

  it("une transaction sans pièce est parquée en 4712 (crédit) / 4711 (débit)", () => {
    expect(orpheline[0].compte).toBe(PCM.ATTENTE_BANQUE_CREDIT);
    expect(sortie[0].compte).toBe(PCM.ATTENTE_BANQUE_DEBIT);
    role(orpheline[0].compte, "attente_bancaire");
    expect(ecart([...orpheline, ...sortie])).toBe(0);
  });

  it("l'arrêté les signale comme non apurés, et les avertissements PCM les disent à valider", () => {
    const balance: LigneBalance[] = [orpheline[0], sortie[0]].map((l) => ({
      compte: normaliserNumeroCompte(l.compte), total_debit: l.debit, total_credit: l.credit,
      solde: Math.abs(l.debit - l.credit), sens: l.debit >= l.credit ? "D" : "C",
    }));
    const audit = auditComptesSuspens(balance);
    expect(audit.apure).toBe(false);
    expect(audit.comptes.every((c) => c.attenteBancaire)).toBe(true);
    expect(audit.total).toBe(580);
    expect(controlerComptesPcm(orpheline).avertissements.join(" ")).toMatch(/4497/);
  });
});

describe("lettrage — réservé aux tiers, bascule recevable", () => {
  it("lettre un compte client auxiliaire et produit une OD de TVA recevable", () => {
    const plan = planifierLettrage({
      lignes: [
        { id: "v", compte_numero: "34210002", debit: 12000, journal_code: "VTE", reference_piece: "FA-2026-001" },
        { id: "r", compte_numero: "34210002", credit: 12000, journal_code: "BQ", reference_piece: "FA-2026-001" },
      ],
      codesExistants: ["AA"],
      piece: { montantTtc: 12000, montantTva: 2000, reference: "FA-2026-001" },
      date: "2026-03-20",
    });
    expect(plan.ok).toBe(true);
    expect(plan.od.map((l) => l.compte_numero)).toEqual(["4458", "44551"]);
    recevables(plan.od);
    expect(ecart(plan.od)).toBe(0);
  });

  it("les comptes de TVA, de trésorerie et de charge ne se lettrent pas", () => {
    for (const c of [...RACINES_TVA_NON_LETTRABLES, "51410000", "61330000"]) {
      expect(compteLettrable(c).ok, c).toBe(false);
    }
    for (const c of ["3421", "34210002", "4411", "44110005"]) {
      expect(compteLettrable(c).ok, c).toBe(true);
    }
  });
});

describe("imports du grand livre", () => {
  const { rows } = normalizeRows([
    ["2026-03-05", "4011", "Fournisseur (plan français)", "1200", ""],
    ["2026-03-05", "4411", "Fournisseur ATLAS", "", "1200"],
    ["2026-03-05", "ABC", "Compte illisible", "10", ""],
  ], { date: 0, compte: 1, libelle: 2, debit: 3, credit: 4 });

  it("SIGNALE les comptes hors référentiel sans perdre la ligne", () => {
    expect(rows).toHaveLength(3);
    expect(rows[0].warnings.join(" ")).toMatch(/hors référentiel PCM/);
    expect(rows[1].warnings.join(" ")).not.toMatch(/hors référentiel/);
    expect(rows[2].warnings.join(" ")).toMatch(/hors référentiel PCM/);
  });

  it("déduit le journal par racine PCM et les tiers depuis 441", () => {
    expect(["51610000", "51410000", "71240000", "61330000", "44110005"].map(inferJournal))
      .toEqual(["CAI", "BQ", "VTE", "ACH", "OD"]);
    expect(deriveTiers(rows).map((t) => t.type)).toEqual(["fournisseur"]);
  });
});

describe("factures et paiements", () => {
  it("le statut suit le cumul réglé", () => {
    expect([statutPaiement(12000, 0), statutPaiement(12000, 6000), statutPaiement(12000, 12000)])
      .toEqual(["non_payee", "partielle", "payee"]);
  });

  it("le moteur de catégorisation ne propose que des comptes recevables, dans leur rôle", () => {
    for (const r of DICTIONNAIRE_PCM) role(r.compte, r.sens === "charge" ? "charge" : "produit");
    for (const [secteur, f] of Object.entries(FALLBACK_SECTEUR)) {
      role(f.charge, "charge");
      role(f.produit, "produit");
      expect(secteur).toBeTruthy();
    }
    expect(COMPTE_CHARGE_DEFAUT).toBe(PCM.CHARGE_DEFAUT);
    expect(COMPTE_PRODUIT_DEFAUT).toBe(PCM.VENTES_MARCHANDISES);
  });
});

describe("balance — le cycle complet s'équilibre et solde la TVA", () => {
  const parCompte = new Map<string, { d: number; c: number }>();
  for (const l of normaliserComptesLignes(grandLivre)) {
    const k = l.compte_numero;
    const cell = parCompte.get(k) ?? { d: 0, c: 0 };
    cell.d += Number(l.debit || 0); cell.c += Number(l.credit || 0);
    parCompte.set(k, cell);
  }
  const balance: LigneBalance[] = [...parCompte.entries()].map(([compte, v]) => ({
    compte, total_debit: r2(v.d), total_credit: r2(v.c), solde: Math.abs(r2(v.d - v.c)), sens: v.d >= v.c ? "D" : "C",
  }));
  const solde = (racine: string) => r2(balance.filter((b) => b.compte.startsWith(racine))
    .reduce((s, b) => s + b.total_debit - b.total_credit, 0));

  it("Σ débits = Σ crédits, et Σ soldes débiteurs = Σ soldes créditeurs", () => {
    const t = totalGeneralBalance(balance);
    expect(t.equilibre).toBe(true);
    expect(t.ecart).toBe(0);
  });

  it("tiers, TVA d'attente, TVA exigible et 4456 sont soldés", () => {
    for (const racine of ["342", "441", "4458", "3458", "4455", "3455", "4456"]) {
      expect(solde(racine), racine).toBe(0);
    }
    expect(solde("7")).toBe(-10000);
    expect(solde("6")).toBe(5000);
    expect(solde("514")).toBe(12000 - 6000 - 1000);
  });

  it("l'à-nouveau reporte un bilan recevable, résultat en 1161", () => {
    const plan = lignesANouveaux(soldesCloture(grandLivre, "2027-01-01"), { dossier_id: D, date: "2027-01-01" });
    expect(plan.violations).toEqual([]);
    expect(plan.ecart).toBe(0);
    recevables(plan.lignes);
    role(plan.compteReport, "report_a_nouveau");
    expect(plan.lignes.some((l) => /^[67]/.test(l.compte_numero))).toBe(false);
  });
});
