/**
 * Carte TVA du tableau de bord = écran Fiscalité = OD de liquidation, sur un
 * dossier de PLUS DE 1 000 écritures portant des frais bancaires avec TVA.
 *
 * PostgREST plafonne une réponse à 1 000 lignes. Les frais bancaires (TVA 10 %
 * au 34552, journal BQ) sont placés APRÈS la 1 000e ligne : une lecture non
 * paginée les perd, et la TVA déductible affichée diverge de la déclaration.
 */
import { describe, it, expect } from "vitest";
import { lireToutesPages } from "./exercice-comptable";
import { synthetiserTva, classerDeductibiliteAchats, tvaHorsFactures } from "./dashboard-fiscal";
import { liquiderTva } from "./liquidation-tva";
import { lireEtatPeriodeTva } from "@/server/liquidation-tva.functions";

const PERIODE = "2026-09";
const BORNES = { debut: "2026-09-01", fin: "2026-09-30" };

/** 1 500 lignes de banque sans TVA (mai), puis les pièces de septembre. */
function grandLivre() {
  const lignes: any[] = [];
  let k = 0;
  const id = () => `e${String(++k).padStart(5, "0")}`;
  for (let i = 0; i < 1500; i++) {
    lignes.push({ id: id(), journal_code: "BQ", compte_numero: "51410000", date_ecriture: "2026-05-10",
      debit: 1, credit: 0, reference_piece: `VIR-${i}`, lettrage_code: null, facture_id: null });
  }
  const l = (o: any) => lignes.push({ id: id(), lettrage_code: null, facture_id: null, ...o });
  // Vente FA-1 : 1 000 HT + 200 TVA, encaissée le 15/09, TVA basculée le 15/09.
  l({ journal_code: "VTE", compte_numero: "34210001", date_ecriture: "2026-09-01", debit: 1200, credit: 0, reference_piece: "FA-1" });
  l({ journal_code: "VTE", compte_numero: "44580000", date_ecriture: "2026-09-01", debit: 0, credit: 200, reference_piece: "FA-1" });
  l({ journal_code: "BQ", compte_numero: "51410000", date_ecriture: "2026-09-15", debit: 1200, credit: 0, reference_piece: "FA-1" });
  l({ journal_code: "BQ", compte_numero: "34210001", date_ecriture: "2026-09-15", debit: 0, credit: 1200, reference_piece: "FA-1" });
  l({ journal_code: "OD", compte_numero: "44580000", date_ecriture: "2026-09-15", debit: 200, credit: 0, reference_piece: "FA-1" });
  l({ journal_code: "OD", compte_numero: "44551000", date_ecriture: "2026-09-15", debit: 0, credit: 200, reference_piece: "FA-1" });
  // Achat ff1 : 500 HT + 100 TVA, décaissé le 10/09, TVA basculée le 10/09.
  l({ journal_code: "ACH", compte_numero: "34580000", date_ecriture: "2026-09-05", debit: 100, credit: 0, reference_piece: "ff1" });
  l({ journal_code: "ACH", compte_numero: "44110001", date_ecriture: "2026-09-05", debit: 0, credit: 600, reference_piece: "ff1" });
  l({ journal_code: "BQ", compte_numero: "44110001", date_ecriture: "2026-09-10", debit: 600, credit: 0, reference_piece: "ff1" });
  l({ journal_code: "BQ", compte_numero: "51410000", date_ecriture: "2026-09-10", debit: 0, credit: 600, reference_piece: "ff1" });
  l({ journal_code: "OD", compte_numero: "34552000", date_ecriture: "2026-09-10", debit: 100, credit: 0, reference_piece: "ff1" });
  l({ journal_code: "OD", compte_numero: "34580000", date_ecriture: "2026-09-10", debit: 0, credit: 100, reference_piece: "ff1" });
  // Frais bancaires du 20/09 : 100 HT + TVA 10 DISTINCTE au relevé, sans facture.
  l({ journal_code: "BQ", compte_numero: "34552000", date_ecriture: "2026-09-20", debit: 10, credit: 0, reference_piece: "FRAIS-09" });
  l({ journal_code: "BQ", compte_numero: "51410000", date_ecriture: "2026-09-20", debit: 0, credit: 110, reference_piece: "FRAIS-09" });
  return lignes;
}

/** Faux Supabase : ordonne par id et sert la plage demandée, plafonnée à 1 000 comme PostgREST. */
function fauxSupabase(lignes: any[]) {
  const appels: [number, number][] = [];
  const sb = {
    appels,
    from() {
      let plage: [number, number] = [0, 999];
      const q: any = {
        select: () => q, eq: () => q, or: () => q, lte: () => q, gte: () => q, in: () => q, order: () => q,
        range(de: number, a: number) { plage = [de, a]; appels.push(plage); return q; },
        maybeSingle: () => q,
        then(res: any, rej: any) {
          const tri = [...lignes].sort((x, y) => String(x.id).localeCompare(String(y.id)));
          const fin = Math.min(plage[1], plage[0] + 999);
          return Promise.resolve({ data: tri.slice(plage[0], fin + 1), error: null }).then(res, rej);
        },
      };
      return q;
    },
  };
  return sb;
}

const ventes = [{ id: "v1", numero: "FA-1", statut: "conforme", statut_paiement: "payee", type: "facture",
  montant_ht: 1000, montant_tva: 200, montant_ttc: 1200, montant_paye: 1200, montant_restant: 0, date_facture: "2026-09-01" }];
const achats = [{ id: "ff1", numero: "F-77", statut_paiement: "payee", type: "facture",
  montant_ht: 500, montant_tva: 100, montant_ttc: 600, montant_paye: 600, montant_restant: 0, date_facture: "2026-09-05" }];
const paiements = [
  { facture_id: "v1", facture_fournisseur_id: null, montant: 1200, date_paiement: "2026-09-15", origine: "banque", reference: "FA-1" },
  { facture_id: null, facture_fournisseur_id: "ff1", montant: 600, date_paiement: "2026-09-10", origine: "banque", reference: "ff1" },
];

/** Même calcul que la carte du tableau de bord et l'écran Fiscalité. */
const carte = (ecritures: any[]) => synthetiserTva(ventes as any, achats as any, {
  ...BORNES, paiements: paiements as any, ecritures,
  achatsExclus: classerDeductibiliteAchats(achats as any, ecritures).exclus,
});

describe("TVA sur un dossier de plus de 1 000 écritures, avec frais bancaires", () => {
  it("lireToutesPages lit les 1 514 lignes, en pages de 1 000", async () => {
    const gl = grandLivre();
    const sb = fauxSupabase(gl);
    const { lignes, erreur } = await lireToutesPages((de, a) =>
      sb.from().select("*").eq("dossier_id", "D").order("id").range(de, a));
    expect(erreur).toBeNull();
    expect(lignes).toHaveLength(gl.length);
    expect(sb.appels).toEqual([[0, 999], [1000, 1999]]);
  });

  it("une page en erreur est SIGNALÉE, pas rendue comme une liste complète", async () => {
    let n = 0;
    const r = await lireToutesPages(async () => (++n === 1
      ? { data: Array.from({ length: 1000 }, () => ({})), error: null }
      : { data: null, error: { message: "timeout" } }));
    expect(r.erreur).toEqual({ message: "timeout" });
  });

  it("une lecture tronquée à 1 000 lignes perd la TVA des frais bancaires", () => {
    const tronque = grandLivre().slice(0, 1000);
    expect(tvaHorsFactures(tronque, BORNES).deductible).toBe(0);
  });

  it("carte TVA = liquidation du grand livre : collectée 200, déductible 110 (dont frais 10), nette 90", async () => {
    const gl = grandLivre();
    const { lignes } = await lireToutesPages((de, a) => fauxSupabase(gl).from().order("id").range(de, a));
    expect(tvaHorsFactures(lignes, BORNES)).toEqual({ collectee: 0, deductible: 10 });

    const s = carte(lignes);
    expect(s).toMatchObject({ collectee: 200, deductible: 110, nette: 90 });

    const liq = liquiderTva(lignes, PERIODE)!;
    expect({ collectee: liq.collectee, deductible: liq.deductible, net: liq.net })
      .toEqual({ collectee: s.collectee, deductible: s.deductible, net: s.nette });
  });

  it("l'état de période servi à la déclaration (OD DECL-TVA) lit TOUT le grand livre", async () => {
    const sb = fauxSupabase(grandLivre());
    const etat = await lireEtatPeriodeTva(sb, { dossierId: "D", periode: PERIODE });
    expect(etat.ok).toBe(true);
    expect(etat.liquidation).toMatchObject({ collectee: 200, deductible: 110, net: 90, dette: true });
    expect(sb.appels.length).toBeGreaterThanOrEqual(2);
  });
});
