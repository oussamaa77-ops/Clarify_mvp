// ============================================================================
// Non-régression HORS LIGNE des 4 anomalies relevées sur TEST-CLARIFY-GOLDEN.
//
// Les données sont celles du scénario étalon (tests/golden/scenario.ts), telles
// que le semeur les écrit — mêmes montants, mêmes dates, mêmes lignes
// `paiements`. La version EN BASE de ces contrôles vit dans
// tests/golden-anomalies.test.ts ; celle-ci tourne à chaque `npm test`.
// ============================================================================

import { describe, expect, it } from "vitest";
import {
  ACHAT_GOLDEN, AVOIR_IMPUTE, REGLEMENTS, VENTES,
} from "../../tests/golden/scenario";
import {
  balanceAgeeDashboard, periodesTva, synthetiserTva,
  type FactureFiscale, type PaiementFiscal,
} from "./dashboard-fiscal";
import { joursRetard, trancheRetard } from "./factures-filtres";

/** La date où l'écart a été constaté : FF-GOLD-001 a alors 147 jours. */
const CONSTAT = new Date(2026, 8, 14); // 14/09/2026

/** Ventes semées : restes dus recalés sur `paiements`, avoir compris. */
function ventesSemees(): FactureFiscale[] {
  const paye = new Map<string, number>();
  for (const p of paiementsSemes()) {
    if (p.facture_id) paye.set(p.facture_id, (paye.get(p.facture_id) ?? 0) + Number(p.montant));
  }
  return VENTES.map((v) => {
    const regle = paye.get(v.numero) ?? 0;
    const solde = v.ttc <= 0 || Math.abs(v.ttc - regle) <= 1;
    return {
      id: v.numero, numero: v.numero, type: v.type,
      montant_ht: v.ht, montant_tva: v.tva, montant_ttc: v.ttc,
      montant_paye: v.ttc <= 0 ? 0 : regle,
      montant_restant: v.ttc <= 0 ? 0 : Math.max(0, v.ttc - regle),
      statut_paiement: solde ? "payee" : regle > 0 ? "partielle" : "non_payee",
      date_facture: v.date, date_echeance: null,
    };
  });
}

function paiementsSemes(dateImputationAvoir: string = AVOIR_IMPUTE.date): PaiementFiscal[] {
  const lignes: PaiementFiscal[] = [];
  for (const r of REGLEMENTS) {
    const ttc = (n: string) => Math.abs(VENTES.find((v) => v.numero === n)?.ttc ?? ACHAT_GOLDEN.ttc);
    for (const n of r.factures) {
      const montant = r.factures.length > 1 ? ttc(n) : r.montant;
      lignes.push(r.sens === "client"
        ? { facture_id: n, montant, date_paiement: r.date, origine: "manuel", reference: r.reference }
        : { facture_fournisseur_id: n, montant, date_paiement: r.date, origine: "manuel", reference: r.reference });
    }
  }
  lignes.push({
    facture_id: AVOIR_IMPUTE.facture, montant: AVOIR_IMPUTE.montant,
    date_paiement: dateImputationAvoir, origine: "avoir", reference: AVOIR_IMPUTE.avoir,
  });
  return lignes;
}

const achatSeme = (): FactureFiscale => ({
  id: ACHAT_GOLDEN.numero, numero: ACHAT_GOLDEN.numero,
  montant_ht: ACHAT_GOLDEN.ht, montant_tva: ACHAT_GOLDEN.tva, montant_ttc: ACHAT_GOLDEN.ttc,
  montant_paye: 8400, montant_restant: 6000, statut_paiement: "partielle",
  date_facture: ACHAT_GOLDEN.date, date_echeance: null,
});

// ─── Anomalie 2 — balance âgée ───────────────────────────────────────────────

describe("Anomalie 2 — FF-GOLD-001 : un seul retard pour tous les écrans", () => {
  it("147 jours de retard, depuis l'émission (aucune échéance saisie)", () => {
    expect(joursRetard(achatSeme(), CONSTAT)).toBe(147);
    expect(trancheRetard(147)?.cle).toBe("retard_60_plus");
  });

  it("le Dashboard la range en « +60 jours », et non plus « Dans les temps »", () => {
    const b = balanceAgeeDashboard([], [achatSeme()], CONSTAT);
    expect(b.find((t) => t.cle === "retard_60_plus")!.dettes).toBe(6000);
    expect(b.find((t) => t.cle === "non_echu")!.dettes).toBe(0);
  });

  it("la créance FA-GOLD-002 (15 000) suit la même règle côté clients", () => {
    const b = balanceAgeeDashboard(ventesSemees(), [], CONSTAT);
    expect(b.find((t) => t.cle === "retard_60_plus")!.creances).toBe(15000);
    expect(b.reduce((s, t) => s + t.creances, 0)).toBe(15000);
  });
});

// ─── Anomalie 4 — TVA au régime de l'encaissement ────────────────────────────

describe("Anomalie 4 — base TVA encaissée : l'avoir n'est pas une recette", () => {
  it("l'argent réellement reçu vaut 37 800 TTC ; les 40 200 comptent l'avoir comme encaissé", () => {
    const clients = paiementsSemes().filter((p) => p.facture_id);
    const tout = clients.reduce((s, p) => s + Number(p.montant), 0);
    const reel = clients.filter((p) => p.origine !== "avoir").reduce((s, p) => s + Number(p.montant), 0);
    expect(tout).toBe(40200);   // le chiffre avancé comme « encaissements réels »
    expect(reel).toBe(37800);   // 12 000 + 9 000 + 7 200 + 6 000 + 3 600
    expect(reel / 1.2).toBe(31500);
  });

  it("TVA collectée 6 300 → base HT encaissée 31 500, égale au 44551 du grand livre", () => {
    // 44551 crédité par les bascules : 2 000 + 1 500 + 1 200 + 1 000 + 600.
    const s = synthetiserTva(ventesSemees(), [], { paiements: paiementsSemes() });
    expect(s.collectee).toBe(6300);
    expect(s.collectee / 0.2).toBe(31500);
    expect(s.couverture).toBe(1);
  });

  it("FA-GOLD-003 : 7 200 encaissés portent 1 200 de TVA, en JUIN, avoir déduit", () => {
    const juin = synthetiserTva(ventesSemees(), [], {
      paiements: paiementsSemes(), debut: "2026-06-01", fin: "2026-06-30",
    });
    expect(juin.collectee).toBe(1200);
  });

  it("un avoir imputé un AUTRE mois ne déplace plus de TVA d'une déclaration à l'autre", () => {
    // Avant : juin 800 (1 600 − 400 d'avoir daté du 08/06), juillet 400 (l'imputation
    // comptée comme un encaissement). Le grand livre, lui, dit juin 1 200, juillet 0.
    const paiements = paiementsSemes("2026-07-10");
    const juin = synthetiserTva(ventesSemees(), [], { paiements, debut: "2026-06-01", fin: "2026-06-30" });
    const juillet = synthetiserTva(ventesSemees(), [], { paiements, debut: "2026-07-01", fin: "2026-07-31" });
    expect(juin.collectee).toBe(1200);
    expect(juillet.collectee).toBe(0);
    expect(periodesTva(ventesSemees(), [], paiements)).not.toContain("2026-07");
  });

  it("un avoir NON imputé garde son effet propre, à sa date", () => {
    const ventes = ventesSemees();
    const sansImputation = paiementsSemes().filter((p) => p.origine !== "avoir");
    // FA-GOLD-003 n'a plus que 7 200 réglés sur 9 600 ; l'avoir émis (payé) retire 400.
    ventes.find((v) => v.numero === "FA-GOLD-003")!.statut_paiement = "partielle";
    ventes.find((v) => v.numero === "FA-GOLD-003")!.montant_paye = 7200;
    const s = synthetiserTva(ventes, [], { paiements: sansImputation });
    expect(s.collectee).toBe(5900); // 6 300 − 400 : l'avoir n'a éteint aucune facture
  });

  it("une imputation dont l'avoir est introuvable n'est pas retranchée deux fois", () => {
    const paiements = paiementsSemes().map((p) =>
      p.origine === "avoir" ? { ...p, reference: "AV-INCONNU" } : p);
    expect(synthetiserTva(ventesSemees(), [], { paiements }).collectee).toBe(6300);
  });

  it("sans table `paiements` (repli historique), le total reste exact", () => {
    expect(synthetiserTva(ventesSemees(), []).collectee).toBe(6300);
  });

  it("TVA déductible : 8 400 décaissés sur 14 400 → 1 400", () => {
    const s = synthetiserTva([], [achatSeme()], { paiements: paiementsSemes() });
    expect(s.deductible).toBe(1400);
  });
});
