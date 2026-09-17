// ============================================================================
// tests/golden-anomalies.test.ts — les 4 anomalies, rejouées sur la VRAIE base.
//
// Pendant INTÉGRATION de src/lib/anomalies-golden.test.ts : on lit le dossier
// TEST-CLARIFY-GOLDEN tel que le semeur l'a écrit, et on fait parler ENSEMBLE
// les calculs des écrans (Dashboard, Relances, Fiscalité), la vue SQL
// `v_balance_agee` et le grand livre. Chaque test pose la même question : deux
// sources qui décrivent la même réalité donnent-elles le même chiffre ?
//
// Prérequis : `npm run seed:golden`. Lecture seule — rien n'est écrit.
// ============================================================================

import { beforeAll, describe, expect, it } from "vitest";
import { clientGolden, exigerDossierGolden, nb, r2, txt } from "./golden/harness";
import { ATTENDUS } from "./golden/scenario";
import { encoursTiersGrandLivre, COMPTE_CLIENTS } from "../src/lib/encours-grandlivre";
import { sansANouveaux, soldesCloture } from "../src/lib/a-nouveaux";
import { balanceAgeeDashboard, synthetiserTva } from "../src/lib/dashboard-fiscal";
import { dateExigibilite, joursRetard } from "../src/lib/factures-filtres";
import { postesRepriseClients } from "../src/lib/relances-postes";
import { CLIENT_PREFIXES } from "../src/lib/import-grandlivre";
import { controlerTvaHorsClasse6 } from "../src/lib/garde-tva-classe6";

const { sb } = clientGolden();

let factures: any[] = [];
let achats: any[] = [];
let paiements: any[] = [];
let grandLivre: any[] = [];
let vue: any[] = [];

beforeAll(async () => {
  const d = await exigerDossierGolden(sb);
  const [f, a, p, gl, v] = await Promise.all([
    sb.from("factures").select("*").eq("dossier_id", d.id),
    sb.from("factures_fournisseurs").select("*").eq("dossier_id", d.id),
    sb.from("paiements").select("facture_id,facture_fournisseur_id,montant,date_paiement,origine,reference").eq("dossier_id", d.id),
    sb.from("ecritures_comptables")
      .select("id,journal_code,compte_numero,libelle,date_ecriture,debit,credit,reference_piece,lettree,lettrage_code,facture_id,transaction_id")
      .eq("dossier_id", d.id),
    sb.from("v_balance_agee").select("*").eq("dossier_id", d.id),
  ]);
  for (const r of [f, a, p, gl, v]) if (r.error) throw new Error(r.error.message);
  factures = f.data; achats = a.data; paiements = p.data; grandLivre = gl.data; vue = v.data;
});

const somme = (lignes: any[], pred: (l: any) => boolean, sens: "D" | "C") =>
  r2(lignes.filter(pred).reduce((s, l) => s + (sens === "D" ? nb(l.debit) : nb(l.credit)), 0));

describe("Anomalie 1 — encours clients : 15 000, jamais 30 000", () => {
  it("Dashboard (postes 342x non lettrés) = Σ des restes dus des factures", () => {
    const stock = sansANouveaux(grandLivre.filter((l) => txt(l.date_ecriture) <= "2026-12-31"));
    const gl = encoursTiersGrandLivre(stock, COMPTE_CLIENTS).total;
    const restes = r2(factures.filter((f) => f.statut === "conforme" && f.statut_paiement !== "payee")
      .reduce((s, f) => s + nb(f.montant_restant), 0));
    expect(gl).toBe(ATTENDUS.encoursClients);
    expect(restes).toBe(ATTENDUS.encoursClients);
  });

  it("Relances : la facture en retard + la reprise GL ne comptent pas l'à-nouveau en double", () => {
    const aujourdhui = new Date().toISOString().slice(0, 10);
    const source1 = factures.filter((f) => f.statut === "conforme" && f.statut_paiement !== "payee"
      && (dateExigibilite(f) ?? "9999") < aujourdhui && nb(f.montant_restant) > 0.005);
    const source2 = postesRepriseClients(
      grandLivre.filter((l) => txt(l.compte_numero).startsWith("342")),
      CLIENT_PREFIXES, source1.map((f) => f.numero));
    // Le semis porte bien un AN-2027 sur le 34210001 : c'est lui qui doublait.
    expect(grandLivre.some((l) => l.journal_code === "AN" && txt(l.compte_numero).startsWith("342"))).toBe(true);
    expect(source1.map((f) => f.numero)).toEqual(["FA-GOLD-002"]);
    expect(source2).toEqual([]);
    const total = r2(source1.reduce((s, f) => s + nb(f.montant_restant), 0)
      + source2.reduce((s, p) => s + p.montant, 0));
    expect(total).toBe(ATTENDUS.encoursClients);
  });
});

describe("Anomalie 2 — balance âgée : Dashboard ≡ v_balance_agee", () => {
  it("FF-GOLD-001 a le MÊME retard dans le Dashboard et dans la vue du module Fournisseurs", () => {
    const ligneVue = vue.find((r) => r.sens === "fournisseur");
    const ff = achats.find((f) => f.numero === "FF-GOLD-001");
    // ±1 jour : la vue lit CURRENT_DATE côté serveur (UTC), le poste local son fuseau.
    expect(Math.abs((joursRetard(ff, new Date()) ?? 0) - ligneVue.jours_retard_max)).toBeLessThanOrEqual(1);
    expect(ligneVue.jours_retard_max).toBeGreaterThan(60);
  });

  it("chaque tranche du Dashboard égale la tranche de même clé dans la vue", () => {
    const b = balanceAgeeDashboard(factures.filter((f) => f.type !== "avoir"), achats, new Date());
    for (const cle of ["non_echu", "retard_1_30", "retard_31_60", "retard_60_plus"]) {
      const tranche = b.find((t) => t.cle === cle)!;
      const vueCle = (sens: string) => r2(vue.filter((r) => r.sens === sens).reduce((s, r) => s + nb(r[cle]), 0));
      expect(tranche.creances, `créances ${cle}`).toBe(vueCle("client"));
      expect(tranche.dettes, `dettes ${cle}`).toBe(vueCle("fournisseur"));
    }
  });
});

describe("Anomalie 3 — PCM : aucune TVA en classe 6", () => {
  it("le grand livre de l'étalon passe le garde-fou, et sa clôture se calcule", () => {
    const c = controlerTvaHorsClasse6(grandLivre);
    expect(c.violations).toEqual([]);
    expect(() => soldesCloture(grandLivre, "2027-01-01")).not.toThrow();
  });

  it("61671000 ne porte que les 1 200 MAD de droits de timbre, hors champ de TVA", () => {
    const l6167 = grandLivre.filter((l) => txt(l.compte_numero).startsWith("6167"));
    expect(l6167).toHaveLength(1);
    expect(l6167[0]).toMatchObject({ journal_code: "CAI", reference_piece: "CAI-GOLD-001" });
    expect(nb(l6167[0].debit)).toBe(1200);
  });

  it("la TVA de l'achat est au bilan (3458 → 34552), la charge 6111 est HT", () => {
    const ach = grandLivre.filter((l) => l.reference_piece === "FF-GOLD-001");
    expect(somme(ach, (l) => txt(l.compte_numero).startsWith("6"), "D")).toBe(12000);
    expect(somme(ach, (l) => txt(l.compte_numero).startsWith("3458"), "D")).toBe(2400);
  });
});

describe("Anomalie 4 — TVA encaissement : la synthèse égale le 44551", () => {
  const horsDeclaration = (l: any) => !txt(l.reference_piece).startsWith("DECL-TVA-") && l.journal_code !== "AN";
  const ventes = () => factures.filter((f) => f.statut !== "rejetee");

  it("TVA collectée = Σ crédits 44551 des bascules (6 300) → base HT 31 500", () => {
    const gl = somme(grandLivre, (l) => txt(l.compte_numero).startsWith("4455") && horsDeclaration(l), "C");
    const s = synthetiserTva(ventes(), achats, { paiements });
    expect(gl).toBe(6300);
    expect(s.collectee).toBe(gl);
    expect(r2(s.collectee / 0.2)).toBe(31500);
  });

  it("TVA déductible = Σ débits 34552 des bascules (1 400)", () => {
    const gl = somme(grandLivre, (l) => txt(l.compte_numero).startsWith("3455") && horsDeclaration(l), "D");
    expect(synthetiserTva(ventes(), achats, { paiements }).deductible).toBe(gl);
  });

  it("mois par mois, la synthèse coïncide avec le grand livre", () => {
    for (const mois of ["2026-03", "2026-05", "2026-06", "2026-07", "2026-08"]) {
      const debut = `${mois}-01`, fin = `${mois}-31`;
      const dansMois = (l: any) => txt(l.date_ecriture) >= debut && txt(l.date_ecriture) <= fin;
      const gl = somme(grandLivre, (l) => txt(l.compte_numero).startsWith("4455") && horsDeclaration(l) && dansMois(l), "C");
      expect(synthetiserTva(ventes(), achats, { paiements, debut, fin }).collectee, mois).toBe(gl);
    }
  });

  it("l'imputation de l'avoir (origine « avoir ») n'est pas un encaissement", () => {
    const imputation = paiements.filter((p) => p.origine === "avoir");
    expect(imputation).toHaveLength(1);
    const encaisse = r2(paiements.filter((p) => p.facture_id && p.origine !== "avoir")
      .reduce((s, p) => s + nb(p.montant), 0));
    expect(encaisse).toBe(37800);
    // Σ BQ/CAI au débit de la trésorerie côté clients : la même somme, vue du grand livre.
    const glEncaisse = somme(grandLivre,
      (l) => ["BQ", "CAI"].includes(l.journal_code) && txt(l.compte_numero).startsWith("342"), "C");
    expect(glEncaisse).toBe(encaisse);
  });
});
