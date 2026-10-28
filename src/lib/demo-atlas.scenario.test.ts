// ============================================================================
// Scénario de DÉMO « DEMO ATLAS NEGOCE » rejoué dans le vrai moteur comptable.
//
// 8 factures de vente, 2 relevés (sept./oct. 2026) — cf. scripts/demo/scenario.mjs.
// On enchaîne ce que fait l'application côté banque :
//   1. validation DGI       → lignesEcrituresVente (D 3421 / C 7111 / C 4458)
//   2. rapprochement        → matcher « un pour un », sinon proposerVentilation
//                             (tranche d'une facture citée, ou plusieurs factures)
//                             → paiements / ventilations, comme les RPC
//   3. clôture du relevé    → genererLignesBQ (référence = libellé de banque)
//   4. comptabilisation     → comptabiliserReglementsBancaires : rattachement et
//                             découpage des lignes BQ, lettrage, TVA des
//                             encaissements partiels
//   5. déclaration TVA      → liquiderTva par mois
// Les attendus sont calculés à la main (régime des encaissements, art. 95 CGI).
// ============================================================================
import { describe, it, expect, beforeAll } from "vitest";
import { lignesEcrituresVente } from "@/lib/ecritures-vente";
import { genererLignesBQ, deriveCategorie } from "@/lib/comptabilite-bq";
import { matchTransactionDeterministe } from "@/server/lettrage.functions";
import { comptabiliserReglementsBancaires } from "@/server/reglements-bancaires.functions";
import { proposerVentilation } from "@/lib/ventilation";
import { liquiderTva } from "@/lib/liquidation-tva";
// @ts-expect-error module JS sans types
import { FACTURES, CLIENTS, RELEVES, totaux } from "../../scripts/demo/scenario.mjs";

const r2 = (n: number) => Math.round(n * 100) / 100;

// ─── Faux client Supabase multi-tables (sous-ensemble employé par le moteur) ──
function fakeSb() {
  let seq = 0;
  const tables: Record<string, any[]> = {};
  const T = (t: string) => (tables[t] ??= []);
  const sb = {
    tables,
    from(table: string) {
      const rows = T(table);
      const filtres: ((r: any) => boolean)[] = [];
      let op: "select" | "update" | "delete" | "insert" = "select";
      let patch: any = null; let inserted: any[] = []; let unique = false;
      const cibles = () => rows.filter((r) => filtres.every((f) => f(r)));
      const executer = () => {
        if (op === "insert") {
          for (const p of inserted) rows.push({ lettrage_code: null, ...p, id: p.id ?? `${table}-${++seq}`,
            ...(table === "ecritures_comptables" ? { debit: Number(p.debit ?? 0), credit: Number(p.credit ?? 0) } : {}) });
          return { data: null, error: null, count: inserted.length };
        }
        const t = cibles();
        if (op === "update") { for (const r of t) Object.assign(r, patch); return { data: t, error: null, count: t.length }; }
        if (op === "delete") { for (const r of t) rows.splice(rows.indexOf(r), 1); return { data: null, error: null, count: t.length }; }
        const data = t.map((r) => ({ ...r }));
        return { data: unique ? (data[0] ?? null) : data, error: null, count: t.length };
      };
      const q: any = {
        select() { return q; },
        insert(p: any) { op = "insert"; inserted = Array.isArray(p) ? p : [p]; return q; },
        update(p: any) { op = "update"; patch = p; return q; },
        delete() { op = "delete"; return q; },
        eq(c: string, v: any) { filtres.push((r) => String(r[c] ?? "") === String(v)); return q; },
        neq(c: string, v: any) { filtres.push((r) => String(r[c] ?? "") !== String(v)); return q; },
        in(c: string, vs: any[]) { filtres.push((r) => vs.map(String).includes(String(r[c] ?? ""))); return q; },
        is(c: string, v: any) { filtres.push((r) => (v === null ? r[c] == null : r[c] === v)); return q; },
        not(c: string) { filtres.push((r) => r[c] != null); return q; },
        order() { return q; },
        maybeSingle() { unique = true; return q; },
        then(res: any, rej: any) { try { return Promise.resolve(executer()).then(res, rej); } catch (e) { return Promise.reject(e).catch(rej); } },
      };
      return q;
    },
  };
  return sb;
}

const D = "DEMO";
const sp = (rows: any[], prefixe: string, au = "9999-12-31") => r2(rows
  .filter((r) => String(r.compte_numero).startsWith(prefixe) && String(r.date_ecriture) <= au)
  .reduce((s, r) => s + r.debit - r.credit, 0));

async function rejouer() {
  const sb = fakeSb();
  const journal: string[] = [];
  const factures: any[] = [];

  // 1) Validation DGI → écritures VTE
  for (const f of FACTURES) {
    const t = totaux(f);
    await sb.from("ecritures_comptables").insert(lignesEcrituresVente({
      dossier_id: D, facture_id: f.num, reference: f.num, date_facture: f.date,
      montant_ht: t.ht, montant_tva: t.tva, montant_ttc: t.ttc,
      compte_client: "34210000", compte_produit: "71110000", type: "facture",
    }));
    factures.push({ id: f.num, numero: f.num, montant_ttc: t.ttc, montant_restant: t.ttc,
      clients: { nom: CLIENTS[f.cli].nom }, date_facture: f.date });
    await sb.from("factures").insert({ id: f.num, numero: f.num, dossier_id: D });
  }

  let tx = 0;
  for (const rl of RELEVES) {
    for (const [date, libelle, debit, credit] of rl.ops) {
      const txId = `tx${++tx}`;
      const type = credit ? "credit" : "debit";
      const montant = credit || debit;
      // 2) Rapprochement — même enchaînement que lettrerDossier
      const used = { fc: new Set<string>(), ff: new Set<string>(), j: new Set<string>() };
      const ouvertes = factures.filter((f) => f.montant_restant > 0.01 && f.date_facture <= date);
      const m = type === "credit"
        ? matchTransactionDeterministe({ type, libelle, montant, date_operation: date }, { facturesClient: ouvertes, facturesFourn: [], justificatifs: [] }, used)
        : null;
      let parts = m ? [{ facture_id: m.id, montant }] : null;
      if (!parts && type === "credit") {
        parts = proposerVentilation({ libelle, montant }, ouvertes.map((f) => ({
          id: f.id, numero: f.numero, restant: f.montant_restant, tiers: f.clients.nom, date_facture: f.date_facture })));
      }
      const mode = m ? "AUTO 1:1" : parts ? (parts.length > 1 ? "VENTIL." : "TRANCHE") : "—";
      if (parts) {
        if (parts.length === 1) {
          await sb.from("paiements").insert({ dossier_id: D, facture_id: parts[0].facture_id, montant: parts[0].montant,
            date_paiement: date, origine: "lettrage", transaction_id: txId });
        } else {
          for (const p of parts) {
            const vId = `v-${txId}-${p.facture_id}`;
            await sb.from("ventilations_transaction").insert({ id: vId, dossier_id: D, transaction_id: txId, facture_id: p.facture_id, montant: p.montant });
            await sb.from("paiements").insert({ dossier_id: D, facture_id: p.facture_id, montant: p.montant,
              date_paiement: date, origine: "lettrage", ventilation_id: vId });
          }
        }
        for (const p of parts) { const f = factures.find((x) => x.id === p.facture_id)!; f.montant_restant = r2(f.montant_restant - p.montant); }
      }
      // 3) Clôture → journal BQ, référence = libellé de la banque (cas le plus défavorable)
      const cat = deriveCategorie(libelle, type);
      const lignes = genererLignesBQ({ libelle, type, montant: type === "debit" ? -montant : montant,
        categorie: cat.categorie, factureLiee: !!parts });
      await sb.from("ecritures_comptables").insert(lignes.map((l) => ({ dossier_id: D, journal_code: "BQ",
        compte_numero: l.compte, date_ecriture: date, libelle: l.libelle, debit: l.debit, credit: l.credit,
        reference_piece: libelle.slice(0, 40), transaction_id: txId, valide: true })));
      journal.push(`${date} ${libelle.padEnd(58)} ${String(montant).padStart(7)}  ${mode.padEnd(8)} ${(parts ?? []).map((p) => `${p.facture_id}:${p.montant}`).join(" + ")}`);
    }
  }
  // 4) Comptabilisation des règlements
  const compta = await comptabiliserReglementsBancaires(sb, D, { aujourdhui: "2026-10-28" });
  return { sb, journal, compta, gl: () => sb.tables.ecritures_comptables };
}

describe("DÉMO ATLAS — chaîne vente → banque → lettrage → TVA", () => {
  let R: Awaited<ReturnType<typeof rejouer>>;
  beforeAll(async () => { R = await rejouer(); console.log("\n" + R.journal.join("\n") + "\n", R.compta); });

  it("journal VTE : 82 000 TTC au 3421, 68 500 HT au 7111, 13 500 TVA en attente", () => {
    const vte = R.gl().filter((r) => r.journal_code === "VTE");
    expect(sp(vte, "3421")).toBe(82000);
    expect(sp(vte, "7111")).toBe(-68500);
    expect(sp(vte, "4458")).toBe(-13500);
  });

  it("tous les encaissements clients sont rapprochés (1:1, tranche ou ventilation)", () => {
    expect(R.journal.filter((j) => j.includes("VIR RECU") || j.includes("REMISE CHEQUE")).every((j) => !/\s—\s/.test(j))).toBe(true);
    expect(R.compta.lignesVentilees).toBe(2);   // 12 600 et 19 000 découpés par facture
  });

  it("encours client : 13 000 (tranche 3 de FA-0102 + FA-0108), aucun encaissement client en attente", () => {
    expect(sp(R.gl(), "3421")).toBe(13000);
    expect(sp(R.gl(), "4497")).toBe(0);
  });

  it("lettrage : toutes les factures soldées portent un code", () => {
    const soldees = ["FA-2026-0101", "FA-2026-0103", "FA-2026-0104", "FA-2026-0105", "FA-2026-0106", "FA-2026-0107"];
    for (const ref of soldees) {
      const lignes = R.gl().filter((r) => String(r.compte_numero).startsWith("3421") && r.reference_piece === ref);
      expect(lignes.every((l) => l.lettrage_code), ref).toBe(true);
    }
    const ouvertes = R.gl().filter((r) => String(r.compte_numero).startsWith("3421") && ["FA-2026-0102", "FA-2026-0108"].includes(r.reference_piece));
    expect(ouvertes.some((l) => l.lettrage_code)).toBe(false);
  });

  // Chaque tranche de FA-0102 bascule 1 666,67 (arrondi au centime) : après deux
  // tranches il reste 1 666,66, que la troisième soldera — 5 000 au total.
  it("TVA exigible : septembre 5 766,67 · octobre 5 566,67 · reste en attente 2 166,66", () => {
    const sept = liquiderTva(R.gl(), "2026-09"), oct = liquiderTva(R.gl(), "2026-10");
    console.log("TVA collectée sept :", sept?.collectee, "| oct :", oct?.collectee, "| déductible sept :", sept?.deductible, "| 4458 :", sp(R.gl(), "4458"));
    expect(sept?.collectee).toBe(5766.67);
    expect(oct?.collectee).toBe(5566.67);
    expect(sp(R.gl(), "4458")).toBe(-2166.66);
  });

  it("frais bancaires : TVA 10 % déductible 5 + 5 au 34552", () => {
    expect(sp(R.gl(), "34552")).toBe(10);
  });

  it("chaque pièce générée est équilibrée (grand livre global à zéro)", () => {
    expect(r2(R.gl().reduce((s, r) => s + r.debit - r.credit, 0))).toBe(0);
  });

  it("idempotent : rejouer la passe ne change rien", async () => {
    const avant = JSON.stringify(R.gl().map((r) => [r.compte_numero, r.debit, r.credit, r.reference_piece, r.lettrage_code]));
    const r = await comptabiliserReglementsBancaires(R.sb, D, { aujourdhui: "2026-10-28" });
    expect(r.tvaBasculee).toBe(0);
    expect(r.lignesVentilees + r.lignesRattachees).toBe(0);
    expect(JSON.stringify(R.gl().map((x) => [x.compte_numero, x.debit, x.credit, x.reference_piece, x.lettrage_code]))).toBe(avant);
  });
});
