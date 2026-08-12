// ============================================================================
// Comptabilisation d'un règlement : lettrage automatique + TVA sur encaissement.
//
// Ces deux mécanismes ne sont testables qu'ENSEMBLE et contre un état : « la TVA
// bascule-t-elle deux fois ? », « le second acompte bascule-t-il la bonne
// quote-part ? » sont des questions sur une séquence d'écritures, pas sur une
// fonction pure. D'où le faux client Supabase ci-dessous, qui tient un grand
// livre en mémoire et supporte le sous-ensemble de l'API réellement employé.
// ============================================================================

import { describe, it, expect } from "vitest";
import { basculerTvaSurReglement, comptabiliserReglement } from "./lettrage-compta.functions";

// ─── Faux client Supabase sur un grand livre en mémoire ─────────────────────
interface Ecriture {
  id: string; dossier_id: string; journal_code: string; compte_numero: string;
  date_ecriture: string; libelle?: string; debit: number; credit: number;
  reference_piece: string | null; lettrage_code?: string | null;
  lettrage_date?: string | null; lettrage_origine?: string | null;
}

function fakeSb(initial: Partial<Ecriture>[]) {
  let seq = 0;
  const rows: Ecriture[] = initial.map((e) => ({
    id: e.id ?? `l${++seq}`, dossier_id: e.dossier_id ?? "D1",
    journal_code: e.journal_code ?? "VTE", compte_numero: e.compte_numero ?? "3421",
    date_ecriture: e.date_ecriture ?? "2026-01-01", libelle: e.libelle ?? "",
    debit: Number(e.debit ?? 0), credit: Number(e.credit ?? 0),
    reference_piece: e.reference_piece ?? null, lettrage_code: e.lettrage_code ?? null,
    lettrage_date: null, lettrage_origine: null,
  }));

  const sb = {
    rows,
    from() {
      const filtres: ((r: Ecriture) => boolean)[] = [];
      let op: "select" | "update" | "delete" | "insert" = "select";
      let patch: any = null;
      let inserted: any[] = [];

      const cibles = () => rows.filter((r) => filtres.every((f) => f(r)));
      const executer = () => {
        if (op === "insert") {
          for (const p of inserted) {
            rows.push({ ...p, id: `l${++seq}`, debit: Number(p.debit ?? 0), credit: Number(p.credit ?? 0) });
          }
          return { data: null, error: null, count: inserted.length };
        }
        const t = cibles();
        if (op === "update") { for (const r of t) Object.assign(r, patch); return { data: t, error: null, count: t.length }; }
        if (op === "delete") { for (const r of t) rows.splice(rows.indexOf(r), 1); return { data: null, error: null, count: t.length }; }
        return { data: t.map((r) => ({ ...r })), error: null, count: t.length };
      };

      const q: any = {
        select() { return q; },
        insert(payload: any) { op = "insert"; inserted = Array.isArray(payload) ? payload : [payload]; return q; },
        update(p: any) { op = "update"; patch = p; return q; },
        delete() { op = "delete"; return q; },
        eq(c: string, v: any) { filtres.push((r: any) => String(r[c] ?? "") === String(v)); return q; },
        in(c: string, vs: any[]) { filtres.push((r: any) => vs.map(String).includes(String(r[c] ?? ""))); return q; },
        is(c: string, v: any) { filtres.push((r: any) => (v === null ? r[c] == null : r[c] === v)); return q; },
        not(c: string, _o: string, _v: any) { filtres.push((r: any) => r[c] != null); return q; },
        order() { return q; },
        then(res: any, rej: any) { try { return Promise.resolve(executer()).then(res, rej); } catch (e) { return Promise.reject(e).catch(rej); } },
      };
      return q;
    },
  };
  return sb;
}

/** Somme signée d'un compte : débit − crédit. */
const solde = (sb: any, compte: string) =>
  Math.round(sb.rows.filter((r: Ecriture) => r.compte_numero === compte)
    .reduce((s: number, r: Ecriture) => s + r.debit - r.credit, 0) * 100) / 100;

/** Facture de vente 1 200 TTC (1 000 HT + 200 TVA en attente), non réglée. */
const factureVente = () => [
  { id: "f-tiers", journal_code: "VTE", compte_numero: "34210001", debit: 1200, credit: 0, reference_piece: "FA-1" },
  { id: "f-prod", journal_code: "VTE", compte_numero: "7111", debit: 0, credit: 1000, reference_piece: "FA-1" },
  { id: "f-tva", journal_code: "VTE", compte_numero: "4458", debit: 0, credit: 200, reference_piece: "FA-1" },
];

/** Ligne de règlement client : crédit du compte de tiers au journal de caisse. */
const reglementClient = (montant: number, id = "r1") =>
  ({ id, journal_code: "CAI", compte_numero: "34210001", debit: 0, credit: montant, reference_piece: "FA-1" });

describe("comptabiliserReglement — lettrage au règlement total", () => {
  it("pose le MÊME code sur la ligne de facture (VTE) et de règlement (CAI)", async () => {
    const sb = fakeSb([...factureVente(), reglementClient(1200)]);
    const r = await comptabiliserReglement(sb, {
      dossierId: "D1", compte: "34210001", references: ["FA-1"],
      montantRegle: 1200, date: "2026-02-01",
    });

    expect(r.lettre).toBe(true);
    expect(r.code).toBe("AA");
    const vte = sb.rows.find((l: Ecriture) => l.id === "f-tiers");
    const cai = sb.rows.find((l: Ecriture) => l.id === "r1");
    expect(vte!.lettrage_code).toBe("AA");
    expect(cai!.lettrage_code).toBe(vte!.lettrage_code);
    expect(vte!.lettrage_origine).toBe("auto");
  });

  it("rend la TVA exigible : 4458 soldé, 44551 crédité de 200", async () => {
    const sb = fakeSb([...factureVente(), reglementClient(1200)]);
    const r = await comptabiliserReglement(sb, {
      dossierId: "D1", compte: "34210001", references: ["FA-1"],
      montantRegle: 1200, date: "2026-02-01",
    });

    expect(r.tvaBasculee).toBeCloseTo(200, 2);
    expect(solde(sb, "4458")).toBeCloseTo(0, 2);     // attente vidée
    expect(solde(sb, "44551")).toBeCloseTo(-200, 2);  // exigible au crédit
    // L'OD de bascule porte le code du lettrage : délettrer la défera.
    const od = sb.rows.filter((l: Ecriture) => l.journal_code === "OD");
    expect(od).toHaveLength(2);
    expect(od.every((l: Ecriture) => l.lettrage_code === "AA")).toBe(true);
  });

  it("ne lettre pas une ligne d'un AUTRE compte de tiers portant la même référence", async () => {
    const sb = fakeSb([
      ...factureVente(),
      reglementClient(1200),
      { id: "autre", journal_code: "CAI", compte_numero: "34210099", debit: 0, credit: 1200, reference_piece: "FA-1" },
    ]);
    await comptabiliserReglement(sb, {
      dossierId: "D1", compte: "34210001", references: ["FA-1"], montantRegle: 1200, date: "2026-02-01",
    });
    expect(sb.rows.find((l: Ecriture) => l.id === "autre")!.lettrage_code).toBeNull();
  });
});

// ─── La DATE DE RÈGLEMENT réelle, pas la date de saisie ──────────────────────
// Sous le régime des encaissements, la TVA devient exigible le jour où l'argent
// est reçu. Un encaissement du 28 juin saisi le 3 juillet appartient à la
// déclaration de JUIN : dater l'OD du jour de saisie la décalerait d'une période.
describe("comptabiliserReglement — date de l'OD de TVA", () => {
  const aujourdhui = new Date().toISOString().slice(0, 10);

  it("date l'OD du jour du RÈGLEMENT, pas du jour de la saisie", async () => {
    const sb = fakeSb([...factureVente(), reglementClient(1200)]);
    await comptabiliserReglement(sb, {
      dossierId: "D1", compte: "34210001", references: ["FA-1"],
      montantRegle: 1200, date: "2026-06-28",
    });
    const od = sb.rows.filter((l: Ecriture) => l.journal_code === "OD");
    expect(od).toHaveLength(2);
    for (const l of od) {
      expect(l.date_ecriture).toBe("2026-06-28");
      expect(l.date_ecriture).not.toBe(aujourdhui);
    }
  });

  it("date aussi l'OD d'un ACOMPTE du jour du règlement", async () => {
    const sb = fakeSb([...factureVente(), reglementClient(600)]);
    await comptabiliserReglement(sb, {
      dossierId: "D1", compte: "34210001", references: ["FA-1"],
      montantRegle: 600, date: "2026-06-28",
    });
    const od = sb.rows.filter((l: Ecriture) => l.journal_code === "OD");
    expect(od.every((l: Ecriture) => l.date_ecriture === "2026-06-28")).toBe(true);
  });

  it("un règlement ANTIDATÉ reste dans sa période", async () => {
    const sb = fakeSb([...factureVente(), reglementClient(1200)]);
    await comptabiliserReglement(sb, {
      dossierId: "D1", compte: "34210001", references: ["FA-1"],
      montantRegle: 1200, date: "2025-12-31",
    });
    expect(sb.rows.filter((l: Ecriture) => l.journal_code === "OD")
      .every((l: Ecriture) => l.date_ecriture === "2025-12-31")).toBe(true);
  });
});

describe("comptabiliserReglement — règlement PARTIEL", () => {
  it("ne lettre pas (déséquilibré) mais rend la TVA exigible au prorata", async () => {
    const sb = fakeSb([...factureVente(), reglementClient(600)]);
    const r = await comptabiliserReglement(sb, {
      dossierId: "D1", compte: "34210001", references: ["FA-1"],
      montantRegle: 600, date: "2026-02-01",
    });

    expect(r.lettre).toBe(false);
    expect(r.code).toBeNull();
    expect(r.raison).toMatch(/partiel/i);
    // 600 / 1200 de 200 = 100
    expect(r.tvaBasculee).toBeCloseTo(100, 2);
    // 4458 est CRÉDITÉ de 200 à la facture puis débité de 100 : solde signé −100,
    // soit 100 encore en attente au crédit.
    expect(solde(sb, "4458")).toBeCloseTo(-100, 2);
    expect(solde(sb, "44551")).toBeCloseTo(-100, 2);
  });

  it("l'OD d'un acompte ne porte AUCUN code — elle n'appartient à aucun lettrage", async () => {
    const sb = fakeSb([...factureVente(), reglementClient(600)]);
    await comptabiliserReglement(sb, {
      dossierId: "D1", compte: "34210001", references: ["FA-1"], montantRegle: 600, date: "2026-02-01",
    });
    const od = sb.rows.filter((l: Ecriture) => l.journal_code === "OD");
    expect(od).toHaveLength(2);
    expect(od.every((l: Ecriture) => l.lettrage_code == null)).toBe(true);
  });

  // LE cas que corrige `tvaTotale` : proratiser sur le RESTE d'attente au lieu
  // de la TVA d'origine ne basculerait que 50 au second versement (la moitié du
  // reste), laissant 50 de TVA en attente sur une facture pourtant soldée.
  it("deux acomptes de 600 basculent 100 + 100, jamais 100 + 50", async () => {
    const sb = fakeSb([...factureVente(), reglementClient(600, "r1")]);
    const a = await comptabiliserReglement(sb, {
      dossierId: "D1", compte: "34210001", references: ["FA-1"], montantRegle: 600, date: "2026-02-01",
    });
    sb.rows.push({ ...reglementClient(600, "r2"), dossier_id: "D1", date_ecriture: "2026-03-01", lettrage_code: null } as any);
    const b = await comptabiliserReglement(sb, {
      dossierId: "D1", compte: "34210001", references: ["FA-1"], montantRegle: 600, date: "2026-03-01",
    });

    expect(a.tvaBasculee).toBeCloseTo(100, 2);
    expect(b.tvaBasculee).toBeCloseTo(100, 2);
    expect(solde(sb, "4458")).toBeCloseTo(0, 2);
    expect(solde(sb, "44551")).toBeCloseTo(-200, 2);
    // Le second versement solde la pièce : le lettrage devient possible et
    // emporte la facture ET les deux acomptes.
    expect(b.lettre).toBe(true);
    expect(sb.rows.find((l: Ecriture) => l.id === "r1")!.lettrage_code).toBe(b.code);
    expect(sb.rows.find((l: Ecriture) => l.id === "r2")!.lettrage_code).toBe(b.code);
  });

  it("ne bascule jamais plus que la TVA de la pièce, même en cas de sur-paiement", async () => {
    const sb = fakeSb([...factureVente(), reglementClient(5000)]);
    const r = await comptabiliserReglement(sb, {
      dossierId: "D1", compte: "34210001", references: ["FA-1"], montantRegle: 5000, date: "2026-02-01",
    });
    expect(r.tvaBasculee).toBeCloseTo(200, 2);
    expect(solde(sb, "4458")).toBeCloseTo(0, 2);
  });
});

// ─── Le risque du changement de référence (FAC-2024-307) ─────────────────────
// Sur une facture ANTÉRIEURE au régime des encaissements, la TVA n'est mise en
// attente que par l'OD de RECLASSEMENT. Depuis qu'elle porte sa référence propre
// « RECLASS-TVA-<ref> », la lire sous la seule référence de la pièce la rendrait
// invisible : le règlement ne basculerait plus rien et la TVA resterait
// éternellement en attente. `referencesPiece` doit couvrir les deux.
describe("comptabiliserReglement — TVA mise en attente par un RECLASSEMENT", () => {
  const factureReclassee = () => [
    // Facture d'origine : TVA collectée directement en 44551 (régime des débits).
    { id: "v-prod", journal_code: "VTE", compte_numero: "7111", debit: 0, credit: 9400, reference_piece: "FAC-307" },
    { id: "v-tva", journal_code: "VTE", compte_numero: "44551", debit: 0, credit: 1880, reference_piece: "FAC-307" },
    { id: "v-tiers", journal_code: "VTE", compte_numero: "34210005", debit: 11280, credit: 0, reference_piece: "FAC-307" },
    // Reclassement vers l'attente — RÉFÉRENCE PROPRE.
    { id: "rc1", journal_code: "OD", compte_numero: "44551", debit: 1880, credit: 0, reference_piece: "RECLASS-TVA-FAC-307" },
    { id: "rc2", journal_code: "OD", compte_numero: "4458", debit: 0, credit: 1880, reference_piece: "RECLASS-TVA-FAC-307" },
  ];

  it("retrouve la TVA en attente malgré la référence préfixée", async () => {
    const sb = fakeSb([
      ...factureReclassee(),
      { id: "r1", journal_code: "CAI", compte_numero: "34210005", debit: 0, credit: 11280, reference_piece: "FAC-307" },
    ]);
    const r = await comptabiliserReglement(sb, {
      dossierId: "D1", compte: "34210005", references: ["FAC-307"],
      montantRegle: 11280, date: "2026-06-01",
    });

    expect(r.lettre).toBe(true);
    expect(r.tvaBasculee).toBeCloseTo(1880, 2);
    expect(solde(sb, "4458")).toBeCloseTo(0, 2);      // attente soldée
    expect(solde(sb, "4455")).toBeCloseTo(0, 2);      // la racine ne reçoit plus rien
    // 1880 C (vente) + 1880 D (reclassement) + 1880 C (bascule) = 1880 au CRÉDIT :
    // la TVA exigible revient sur le compte MÊME que celui de la facture, au lieu
    // de s'échouer sur la racine 4455 que la déclaration ne regarde pas.
    expect(solde(sb, "44551")).toBeCloseTo(-1880, 2);
  });

  it("un acompte bascule sa quote-part de la TVA reclassée", async () => {
    const sb = fakeSb([
      ...factureReclassee(),
      { id: "r1", journal_code: "CAI", compte_numero: "34210005", debit: 0, credit: 5640, reference_piece: "FAC-307" },
    ]);
    const r = await comptabiliserReglement(sb, {
      dossierId: "D1", compte: "34210005", references: ["FAC-307"],
      montantRegle: 5640, date: "2026-06-01",
    });
    expect(r.lettre).toBe(false);
    expect(r.tvaBasculee).toBeCloseTo(940, 2);        // la moitié de 1 880
  });

  // Le reclassement ne doit pas être pris pour la pièce elle-même : ses lignes
  // sont sur des comptes de TVA, elles n'ont rien à faire dans le lettrage.
  it("ne lettre pas les lignes du reclassement", async () => {
    const sb = fakeSb([
      ...factureReclassee(),
      { id: "r1", journal_code: "CAI", compte_numero: "34210005", debit: 0, credit: 11280, reference_piece: "FAC-307" },
    ]);
    await comptabiliserReglement(sb, {
      dossierId: "D1", compte: "34210005", references: ["FAC-307"],
      montantRegle: 11280, date: "2026-06-01",
    });
    expect(sb.rows.find((l: Ecriture) => l.id === "rc1")!.lettrage_code).toBeNull();
    expect(sb.rows.find((l: Ecriture) => l.id === "rc2")!.lettrage_code).toBeNull();
  });
});

describe("comptabiliserReglement — achats (sens fournisseur)", () => {
  it("le décaissement ouvre le droit à déduction : 3458 → 3455", async () => {
    const sb = fakeSb([
      { id: "a-charge", journal_code: "ACH", compte_numero: "6141", debit: 1000, credit: 0, reference_piece: "uuid-1" },
      { id: "a-tva", journal_code: "ACH", compte_numero: "3458", debit: 200, credit: 0, reference_piece: "uuid-1" },
      { id: "a-tiers", journal_code: "ACH", compte_numero: "44110005", debit: 0, credit: 1200, reference_piece: "uuid-1" },
      { id: "a-regl", journal_code: "CAI", compte_numero: "44110005", debit: 1200, credit: 0, reference_piece: "uuid-1" },
    ]);
    const r = await comptabiliserReglement(sb, {
      dossierId: "D1", compte: "44110005", references: ["uuid-1"], montantRegle: 1200, date: "2026-02-01",
    });

    expect(r.lettre).toBe(true);
    expect(r.tvaBasculee).toBeCloseTo(200, 2);
    expect(solde(sb, "3458")).toBeCloseTo(0, 2);
    expect(solde(sb, "3455")).toBeCloseTo(0, 2);      // la racine ne reçoit plus rien
    expect(solde(sb, "34552")).toBeCloseTo(200, 2);   // déductible, au débit
  });
});

describe("comptabiliserReglement — garde-fous", () => {
  it("refuse un compte hors comptes de tiers, sans rien écrire", async () => {
    const sb = fakeSb(factureVente());
    const avant = sb.rows.length;
    const r = await comptabiliserReglement(sb, {
      dossierId: "D1", compte: "5141", references: ["FA-1"], montantRegle: 1200, date: "2026-02-01",
    });
    expect(r.lettre).toBe(false);
    expect(r.raison).toMatch(/hors comptes de tiers/i);
    expect(sb.rows.length).toBe(avant);
  });

  it("une pièce sans TVA ne produit aucune OD", async () => {
    const sb = fakeSb([
      { id: "t", journal_code: "VTE", compte_numero: "34210001", debit: 1000, credit: 0, reference_piece: "FA-2" },
      { id: "p", journal_code: "VTE", compte_numero: "7111", debit: 0, credit: 1000, reference_piece: "FA-2" },
      { id: "r", journal_code: "CAI", compte_numero: "34210001", debit: 0, credit: 1000, reference_piece: "FA-2" },
    ]);
    const r = await comptabiliserReglement(sb, {
      dossierId: "D1", compte: "34210001", references: ["FA-2"], montantRegle: 1000, date: "2026-02-01",
    });
    expect(r.lettre).toBe(true);
    expect(r.tvaBasculee).toBe(0);
    expect(sb.rows.filter((l: Ecriture) => l.journal_code === "OD")).toHaveLength(0);
  });

  it("les deux alias de référence ne basculent la TVA qu'UNE fois", async () => {
    const sb = fakeSb([...factureVente(), reglementClient(600)]);
    const r = await comptabiliserReglement(sb, {
      dossierId: "D1", compte: "34210001",
      // Le règlement passe le n° de facture ET l'id : une seule porte des écritures.
      references: ["FA-1", "uuid-facture"], montantRegle: 600, date: "2026-02-01",
    });
    expect(r.tvaBasculee).toBeCloseTo(100, 2);
    expect(sb.rows.filter((l: Ecriture) => l.journal_code === "OD")).toHaveLength(2);
  });
});

describe("basculerTvaSurReglement — appelée seule", () => {
  it("ne fait rien sur une pièce dont la TVA est déjà entièrement basculée", async () => {
    const sb = fakeSb([
      ...factureVente(),
      { id: "od1", journal_code: "OD", compte_numero: "4458", debit: 200, credit: 0, reference_piece: "FA-1" },
      { id: "od2", journal_code: "OD", compte_numero: "4455", debit: 0, credit: 200, reference_piece: "FA-1" },
    ]);
    const avant = sb.rows.length;
    const r = await basculerTvaSurReglement(sb, {
      dossierId: "D1", reference: "FA-1", sens: "client", montantRegle: 1200, date: "2026-02-01",
    });
    expect(r.tva).toBe(0);
    expect(r.od).toBe(0);
    expect(sb.rows.length).toBe(avant);
  });

  it("ignore un montant réglé nul", async () => {
    const sb = fakeSb(factureVente());
    const r = await basculerTvaSurReglement(sb, {
      dossierId: "D1", reference: "FA-1", sens: "client", montantRegle: 0, date: "2026-02-01",
    });
    expect(r).toEqual({ tva: 0, od: 0 });
  });
});
