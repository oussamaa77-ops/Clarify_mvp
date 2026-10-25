import { describe, it, expect } from "vitest";
import { AccesRefuse, exigerAcces, extraireReferences, utilisateurDuJeton } from "./acces";

const D1 = "11111111-1111-4111-8111-111111111111"; // dossier de l'utilisateur
const D2 = "22222222-2222-4222-8222-222222222222"; // dossier d'un autre cabinet
const F1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // facture client de D1
const F2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // facture fournisseur de D2
const U = "99999999-9999-4999-8999-999999999999";

/** Faux client Supabase : des tables en mémoire, has_dossier_access = D1 seul. */
function fauxSb(tables: Record<string, { id: string; dossier_id: string }[]> = {}) {
  return {
    auth: {
      getUser: async (jeton: string) =>
        jeton === "bon" ? { data: { user: { id: U } }, error: null } : { data: { user: null }, error: { message: "bad" } },
    },
    from: (table: string) => ({
      select: () => ({
        in: async (_col: string, ids: string[]) => ({
          data: (tables[table] ?? []).filter((r) => ids.includes(r.id)),
          error: null,
        }),
      }),
    }),
    rpc: async (_fn: string, args: { _user_id: string; _dossier_id: string }) => ({
      data: args._user_id === U && args._dossier_id === D1,
      error: null,
    }),
  } as any;
}

const tables = {
  factures: [{ id: F1, dossier_id: D1 }],
  factures_fournisseurs: [{ id: F2, dossier_id: D2 }],
};

async function statut(p: Promise<unknown>): Promise<number | "ok"> {
  try { await p; return "ok"; } catch (e) { return e instanceof AccesRefuse ? e.status : Promise.reject(e); }
}

describe("extraireReferences", () => {
  it("lit les deux orthographes du dossier et les pièces connues", () => {
    const r = extraireReferences({ dossierId: D1, dossier_id: D2, facture_id: F1, ecritureIds: [F1, F1], autre: F2 });
    expect(r.dossiers.sort()).toEqual([D1, D2]);
    expect(r.pieces).toEqual([
      { cle: "facture_id", ids: [F1] },
      { cle: "ecritureIds", ids: [F1] },
    ]);
  });

  it("ignore ce qui n'est pas un UUID (job « inline »)", () => {
    expect(extraireReferences({ job_id: "inline", dossier_id: "" })).toEqual({ dossiers: [], pieces: [] });
  });
});

describe("utilisateurDuJeton", () => {
  it("refuse 401 sans en-tête, avec un schéma autre que Bearer, ou un jeton invalide", async () => {
    expect(await statut(utilisateurDuJeton(fauxSb(), null))).toBe(401);
    expect(await statut(utilisateurDuJeton(fauxSb(), "Basic bon"))).toBe(401);
    expect(await statut(utilisateurDuJeton(fauxSb(), "Bearer mauvais"))).toBe(401);
  });

  it("rend l'utilisateur d'un jeton valide", async () => {
    expect(await utilisateurDuJeton(fauxSb(), "Bearer bon")).toBe(U);
  });
});

describe("exigerAcces", () => {
  it("laisse passer son propre dossier et ses propres pièces", async () => {
    expect(await statut(exigerAcces(fauxSb(tables), U, { dossierId: D1, facture_id: F1 }))).toBe("ok");
  });

  it("refuse le dossier d'un autre cabinet", async () => {
    expect(await statut(exigerAcces(fauxSb(tables), U, { dossier_id: D2 }))).toBe(403);
  });

  it("refuse SON dossier accompagné de la pièce d'un autre (contrôle du dossier relu en base)", async () => {
    expect(await statut(exigerAcces(fauxSb(tables), U, { dossierId: D1, facture_id: F2 }))).toBe(403);
  });

  it("refuse une pièce introuvable", async () => {
    expect(await statut(exigerAcces(fauxSb(tables), U, { client_id: F1 }))).toBe(403);
  });

  it("laisse passer une entrée sans dossier ni pièce (l'authentification suffit)", async () => {
    expect(await statut(exigerAcces(fauxSb(tables), U, { to: "x@y.ma" }))).toBe("ok");
  });
});
