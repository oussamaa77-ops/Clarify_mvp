// ============================================================================
// Projection des factures depuis le grand livre.
//
// Faux client Supabase multi-tables : contrairement au grand livre en mémoire de
// lettrage-compta, ce module lit TROIS tables et en écrit deux. Le faux les tient
// donc séparées — sans quoi une écriture de facture irait patcher une écriture
// comptable, et le test passerait pour de mauvaises raisons.
// ============================================================================

import { describe, it, expect } from "vitest";
import { executerSyncFacturesGL } from "./factures-gl.functions";

function fakeSb(tables: Record<string, any[]>, opts: { erreurSur?: string } = {}) {
  const store: Record<string, any[]> = {};
  for (const [t, rows] of Object.entries(tables)) store[t] = rows.map((r) => ({ ...r }));

  return {
    store,
    from(table: string) {
      const filtres: ((r: any) => boolean)[] = [];
      let op: "select" | "update" = "select";
      let patch: any = null;
      const rows = () => store[table] ?? [];
      const cibles = () => rows().filter((r) => filtres.every((f) => f(r)));
      const executer = () => {
        if (opts.erreurSur === table) return { data: null, error: { message: `échec sur ${table}` } };
        if (op === "update") {
          const t = cibles();
          for (const r of t) Object.assign(r, patch);
          return { data: t, error: null };
        }
        return { data: cibles().map((r) => ({ ...r })), error: null };
      };
      const q: any = {
        select() { return q; },
        update(p: any) { op = "update"; patch = p; return q; },
        eq(c: string, v: any) { filtres.push((r) => String(r[c] ?? "") === String(v)); return q; },
        then(res: any, rej: any) { return Promise.resolve(executer()).then(res, rej); },
      };
      return q;
    },
  };
}

const D = "11111111-1111-1111-1111-111111111111";

/** Vente comptabilisée, non lettrée : la facture est ouverte. */
const GL_OUVERT = [
  { dossier_id: D, journal_code: "VTE", compte_numero: "34210002", date_ecriture: "2026-04-15", debit: 9000, credit: 0, reference_piece: "FAC-2026-001", lettrage_code: null, facture_id: "f1" },
  { dossier_id: D, journal_code: "VTE", compte_numero: "7124", date_ecriture: "2026-04-15", debit: 0, credit: 7500, reference_piece: "FAC-2026-001", lettrage_code: null, facture_id: "f1" },
];

/** La même, soldée par un règlement de banque lettré AA. */
const GL_SOLDE = [
  { dossier_id: D, journal_code: "VTE", compte_numero: "34210002", date_ecriture: "2026-04-15", debit: 9000, credit: 0, reference_piece: "FAC-2026-001", lettrage_code: "AA", facture_id: "f1" },
  { dossier_id: D, journal_code: "BQ", compte_numero: "34210002", date_ecriture: "2026-07-09", debit: 0, credit: 9000, reference_piece: "FAC-2026-001", lettrage_code: "AA", facture_id: "f1" },
];

const facture = (p: Record<string, unknown> = {}) => ({
  id: "f1", dossier_id: D, numero: "FAC-2026-001", montant_ttc: 9000,
  montant_paye: 0, montant_restant: 9000, statut_paiement: "non_payee", ...p,
});

describe("executerSyncFacturesGL", () => {
  it("remet à zéro une facture que le grand livre ne dit PAS réglée", async () => {
    // Le cas d'après purge : l'écriture fantôme a disparu, la colonne prétend
    // encore que la facture est payée.
    const sb = fakeSb({
      ecritures_comptables: GL_OUVERT,
      factures: [facture({ montant_paye: 9000, montant_restant: 0, statut_paiement: "payee" })],
      factures_fournisseurs: [],
    });
    const r = await executerSyncFacturesGL(sb, { dossierId: D });
    expect(r.ok).toBe(true);
    expect(r.corrigees).toBe(1);
    expect(sb.store.factures[0]).toMatchObject({
      montant_paye: 0, montant_restant: 9000, statut_paiement: "non_payee", date_paiement: null,
    });
  });

  it("marque payée la facture soldée par un règlement lettré", async () => {
    const sb = fakeSb({
      ecritures_comptables: GL_SOLDE, factures: [facture()], factures_fournisseurs: [],
    });
    await executerSyncFacturesGL(sb, { dossierId: D });
    expect(sb.store.factures[0]).toMatchObject({
      montant_paye: 9000, montant_restant: 0, statut_paiement: "payee", date_paiement: "2026-07-09",
    });
  });

  it("n'écrit RIEN en simulation, mais rapporte la divergence", async () => {
    const sb = fakeSb({
      ecritures_comptables: GL_OUVERT,
      factures: [facture({ montant_paye: 9000, montant_restant: 0, statut_paiement: "payee" })],
      factures_fournisseurs: [],
    });
    const r = await executerSyncFacturesGL(sb, { dossierId: D, simulation: true });
    expect(r.simulation).toBe(true);
    expect(r.corrigees).toBe(0);
    expect(r.divergentes).toHaveLength(1);
    expect(r.divergentes[0]).toMatchObject({ table: "factures", numero: "FAC-2026-001" });
    expect(sb.store.factures[0].statut_paiement).toBe("payee");
  });

  it("laisse tranquille une facture déjà alignée", async () => {
    const sb = fakeSb({
      ecritures_comptables: GL_OUVERT, factures: [facture()], factures_fournisseurs: [],
    });
    const r = await executerSyncFacturesGL(sb, { dossierId: D });
    expect(r.examinees).toBe(1);
    expect(r.divergentes).toHaveLength(0);
    expect(r.corrigees).toBe(0);
  });

  it("NE TOUCHE PAS une facture absente du grand livre", async () => {
    // Elle n'est pas « non payée » : elle n'est pas comptabilisée. La réécrire
    // effacerait un règlement saisi avant sa comptabilisation.
    const sb = fakeSb({
      ecritures_comptables: [],
      factures: [facture({ montant_paye: 9000, montant_restant: 0, statut_paiement: "payee" })],
      factures_fournisseurs: [],
    });
    const r = await executerSyncFacturesGL(sb, { dossierId: D });
    expect(r.divergentes).toHaveLength(0);
    expect(sb.store.factures[0].statut_paiement).toBe("payee");
  });

  it("traite aussi les factures fournisseurs, dans leur sens", async () => {
    const sb = fakeSb({
      ecritures_comptables: [
        { dossier_id: D, journal_code: "ACH", compte_numero: "44110001", date_ecriture: "2026-04-15", debit: 0, credit: 1440, reference_piece: "ff1", lettrage_code: "AB" },
        { dossier_id: D, journal_code: "BQ", compte_numero: "44110001", date_ecriture: "2026-05-01", debit: 1440, credit: 0, reference_piece: "ff1", lettrage_code: "AB" },
      ],
      factures: [],
      factures_fournisseurs: [{ id: "ff1", dossier_id: D, numero: "FR-88", montant_ttc: 1440, montant_paye: 0, montant_restant: 1440, statut_paiement: "non_payee" }],
    });
    await executerSyncFacturesGL(sb, { dossierId: D });
    expect(sb.store.factures_fournisseurs[0]).toMatchObject({
      montant_paye: 1440, montant_restant: 0, statut_paiement: "payee",
    });
  });

  it("NE DÉMARQUE PAS une facture payée dont le règlement n'a jamais été lettré", async () => {
    // Le piège rencontré sur SMERT WATER / SOMADIR : `paiements` atteste le
    // règlement, mais aucune écriture de trésorerie n'existe — donc rien à
    // lettrer. Se fier au seul grand livre aurait effacé six règlements réels.
    const sb = fakeSb({
      ecritures_comptables: GL_OUVERT,
      factures: [facture({ montant_paye: 9000, montant_restant: 0, statut_paiement: "payee" })],
      factures_fournisseurs: [],
      paiements: [{ dossier_id: D, facture_id: "f1", montant: 9000, date_paiement: "2026-03-02" }],
    });
    const r = await executerSyncFacturesGL(sb, { dossierId: D });
    expect(r.divergentes).toHaveLength(0);
    expect(r.corrigees).toBe(0);
    expect(sb.store.factures[0].statut_paiement).toBe("payee");
  });

  it("corrige quand même la facture dont la pièce ne couvre qu'une partie", async () => {
    const sb = fakeSb({
      ecritures_comptables: GL_OUVERT,
      factures: [facture({ montant_paye: 9000, montant_restant: 0, statut_paiement: "payee" })],
      factures_fournisseurs: [],
      paiements: [{ dossier_id: D, facture_id: "f1", montant: 3000, date_paiement: "2026-03-02" }],
    });
    await executerSyncFacturesGL(sb, { dossierId: D });
    expect(sb.store.factures[0]).toMatchObject({
      montant_paye: 3000, montant_restant: 6000, statut_paiement: "partielle",
    });
  });

  it("se replie sur le grand livre seul quand `paiements` n'existe pas", async () => {
    // Migration non appliquée : la table est absente, l'audit reste possible.
    const sb = fakeSb(
      {
        ecritures_comptables: GL_SOLDE, factures: [facture()], factures_fournisseurs: [],
        paiements: [],
      },
      { erreurSur: "paiements" },
    );
    const r = await executerSyncFacturesGL(sb, { dossierId: D });
    expect(r.ok).toBe(true);
    expect(sb.store.factures[0].statut_paiement).toBe("payee");
  });

  it("rend l'échec de lecture du grand livre plutôt que de vider les factures", async () => {
    const sb = fakeSb(
      { ecritures_comptables: GL_OUVERT, factures: [facture()], factures_fournisseurs: [] },
      { erreurSur: "ecritures_comptables" },
    );
    const r = await executerSyncFacturesGL(sb, { dossierId: D });
    expect(r.ok).toBe(false);
    expect(r.raison).toMatch(/échec/);
    expect(r.corrigees).toBe(0);
  });

  it("ne déborde jamais sur un autre dossier", async () => {
    const autre = "22222222-2222-2222-2222-222222222222";
    const sb = fakeSb({
      ecritures_comptables: [...GL_SOLDE, { dossier_id: autre, journal_code: "VTE", compte_numero: "34210002", debit: 500, credit: 0, reference_piece: "FAC-2026-001", lettrage_code: null }],
      factures: [facture(), { ...facture({ id: "f9", dossier_id: autre, statut_paiement: "payee", montant_paye: 500, montant_restant: 0 }) }],
      factures_fournisseurs: [],
    });
    const r = await executerSyncFacturesGL(sb, { dossierId: D });
    expect(r.examinees).toBe(1);
    expect(sb.store.factures.find((f: any) => f.id === "f9").statut_paiement).toBe("payee");
  });
});
