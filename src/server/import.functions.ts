// ============================================================================
// import.functions.ts — Import RÉVERSIBLE du Grand Livre (Excel).
//
// Le parsing/mapping se fait côté client (src/lib/import-grandlivre.ts) ; ces
// server functions ne font QUE persister de façon transactionnelle et traçable :
//   • importerGrandLivre → crée un lot (import_batches), insère les écritures
//     taguées batch_id + dérive/dédup les tiers (clients/fournisseurs).
//   • annulerImport      → supprime le lot (écritures en CASCADE) + tiers du lot
//     non référencés → réversibilité stricte « en un clic ».
//   • listerImports      → historique des lots (undo persistant dans l'UI).
//
// getSupabase()+proxyFetch : miroir de tiers-memoire.functions.ts pour survivre
// au proxy TLS d'entreprise (sinon `fetch failed` côté serveur).
// ============================================================================

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { normalizeLibelle } from "@/lib/import-grandlivre";

let PROXY_DIRECT = false;
async function proxyFetch(input: any, init?: any): Promise<Response> {
  const url = String(input);
  if (PROXY_DIRECT) {
    const { fetch: uf, Agent } = await import("undici");
    const agent = new Agent({ connect: { rejectUnauthorized: false } });
    return (uf as any)(url, { ...init, dispatcher: agent }) as Promise<Response>;
  }
  try {
    return await fetch(url, init);
  } catch (e: any) {
    const cause: string = e?.cause?.code ?? e?.cause?.message ?? e?.message ?? "";
    if (/SELF_SIGNED|CERT_|UNABLE_TO_VERIFY|fetch failed|ECONNRESET|EPROTO/i.test(cause) || /fetch failed/i.test(String(e?.message ?? ""))) {
      PROXY_DIRECT = true;
      const { fetch: uf, Agent } = await import("undici");
      const agent = new Agent({ connect: { rejectUnauthorized: false } });
      return (uf as any)(url, { ...init, dispatcher: agent }) as Promise<Response>;
    }
    throw e;
  }
}

function getSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    "";
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (i: any, init?: any) => proxyFetch(i, init) },
  });
}

async function insertChunked(sb: SupabaseClient, table: string, rows: any[], size = 500): Promise<void> {
  for (let i = 0; i < rows.length; i += size) {
    const { error } = await (sb.from(table) as any).insert(rows.slice(i, i + size));
    if (error) throw new Error(error.message);
  }
}

const ecritureSchema = z.object({
  date: z.string().nullable(),          // ISO ou null → ligne ignorée (date_ecriture NOT NULL)
  journal_code: z.string().default("OD"),
  compte_numero: z.string().default(""),
  libelle: z.string().default(""),
  debit: z.number().default(0),
  credit: z.number().default(0),
  reference_piece: z.string().nullable().default(null),
  code_lettrage: z.string().nullable().default(null),  // lettre(s) de pointage Sage
});

const tierSchema = z.object({
  type: z.enum(["client", "fournisseur"]),
  nom: z.string(),
  compte_numero: z.string().default(""),
});

// ── importerGrandLivre ───────────────────────────────────────────────────────
export const importerGrandLivre = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({
      dossier_id: z.string().uuid(),
      filename: z.string().default("import.xlsx"),
      mapping: z.record(z.string(), z.number()).default({}),
      rows: z.array(ecritureSchema),
      tiers: z.array(tierSchema).default([]),
    }).parse(input),
  )
  .handler(async ({ data }) => {
    const sb = getSupabase();

    // 1) Créer le lot. Si la table manque → erreur claire (on ne casse PAS la
    //    réversibilité en insérant des écritures non taguées).
    const { data: batch, error: eBatch } = await (sb.from("import_batches") as any)
      .insert({
        dossier_id: data.dossier_id,
        type: "grand_livre",
        filename: data.filename,
        source_rows: data.rows.length,
        mapping: data.mapping,
      })
      .select("id")
      .single();
    if (eBatch || !batch?.id) {
      const msg = eBatch?.message ?? "création du lot impossible";
      const migrationManquante = /import_batches|relation|does not exist|schema cache/i.test(msg);
      return {
        ok: false as const,
        reason: migrationManquante
          ? "Migration import_batches non appliquée (exécuter 20260708130000_import_batches.sql)."
          : msg,
      };
    }
    const batchId: string = batch.id;

    try {
      // 2) Écritures — on ignore les lignes sans date (date_ecriture NOT NULL).
      const valides = data.rows.filter((r) => !!r.date);
      const skippedNoDate = data.rows.length - valides.length;
      const ecritures = valides.map((r) => ({
        dossier_id: data.dossier_id,
        batch_id: batchId,
        journal_code: r.journal_code || "OD",
        compte_numero: r.compte_numero || null,
        date_ecriture: r.date,
        libelle: r.libelle || null,
        debit: r.debit || 0,
        credit: r.credit || 0,
        reference_piece: r.reference_piece || null,
        code_lettrage: r.code_lettrage || null,   // pointage d'origine conservé
        valide: true,
      }));
      try {
        await insertChunked(sb, "ecritures_comptables", ecritures);
      } catch (e: any) {
        // Repli si la colonne code_lettrage n'existe pas encore (migration non
        // appliquée) : on réimporte SANS le lettrage plutôt que d'échouer.
        if (String(e?.message ?? e).toLowerCase().includes("code_lettrage")) {
          const sansLettrage = ecritures.map(({ code_lettrage, ...rest }) => rest);
          await insertChunked(sb, "ecritures_comptables", sansLettrage);
        } else {
          throw e;
        }
      }

      // 3) Tiers — dédup contre l'existant (par nom normalisé), insère les manquants.
      let insertedTiers = 0;
      for (const type of ["client", "fournisseur"] as const) {
        const table = type === "client" ? "clients" : "fournisseurs";
        const wanted = data.tiers.filter((t) => t.type === type);
        if (!wanted.length) continue;

        const { data: existing } = await (sb.from(table) as any)
          .select("nom")
          .eq("dossier_id", data.dossier_id)
          .is("deleted_at", null);
        const existSet = new Set((existing ?? []).map((r: any) => normalizeLibelle(r.nom)));

        const seen = new Set<string>();
        const toInsert: any[] = [];
        for (const t of wanted) {
          const key = normalizeLibelle(t.nom);
          if (!key || existSet.has(key) || seen.has(key)) continue;
          seen.add(key);
          toInsert.push({ dossier_id: data.dossier_id, nom: t.nom, import_batch_id: batchId });
        }
        if (toInsert.length) {
          await insertChunked(sb, table, toInsert);
          insertedTiers += toInsert.length;
        }
      }

      // 4) Compteurs du lot.
      await (sb.from("import_batches") as any)
        .update({ inserted_ecritures: ecritures.length, inserted_tiers: insertedTiers })
        .eq("id", batchId);

      return {
        ok: true as const,
        batch_id: batchId,
        inserted_ecritures: ecritures.length,
        inserted_tiers: insertedTiers,
        skipped_no_date: skippedNoDate,
      };
    } catch (e: any) {
      // Rollback best-effort : supprimer le lot (écritures + tiers taggés partent en cascade/SET NULL).
      await (sb.from("import_batches") as any).delete().eq("id", batchId);
      await (sb.from("clients") as any).delete().eq("import_batch_id", batchId);
      await (sb.from("fournisseurs") as any).delete().eq("import_batch_id", batchId);
      return { ok: false as const, reason: String(e?.message ?? e) };
    }
  });

// ── annulerImport ────────────────────────────────────────────────────────────
export const annulerImport = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ dossier_id: z.string().uuid(), batch_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }) => {
    const sb = getSupabase();
    try {
      // 1) Supprimer les tiers du lot NON référencés par une facture (sûr côté FK).
      let deletedTiers = 0;
      for (const type of ["client", "fournisseur"] as const) {
        const table = type === "client" ? "clients" : "fournisseurs";
        const factureTable = type === "client" ? "factures" : "factures_fournisseurs";
        const fk = type === "client" ? "client_id" : "fournisseur_id";

        const { data: tiers } = await (sb.from(table) as any)
          .select("id").eq("import_batch_id", data.batch_id);
        const ids = (tiers ?? []).map((r: any) => r.id);
        if (!ids.length) continue;

        const { data: refs } = await (sb.from(factureTable) as any)
          .select(fk).in(fk, ids);
        const referenced = new Set((refs ?? []).map((r: any) => r[fk]));
        const deletable = ids.filter((id: string) => !referenced.has(id));
        if (deletable.length) {
          const { error } = await (sb.from(table) as any).delete().in("id", deletable);
          if (!error) deletedTiers += deletable.length;
        }
      }

      // 2) Compter puis supprimer le lot → écritures supprimées en CASCADE.
      const { count } = await (sb.from("ecritures_comptables") as any)
        .select("id", { count: "exact", head: true }).eq("batch_id", data.batch_id);
      const { error: eDel } = await (sb.from("import_batches") as any)
        .delete().eq("id", data.batch_id).eq("dossier_id", data.dossier_id);
      if (eDel) return { ok: false as const, reason: eDel.message };

      return { ok: true as const, deleted_ecritures: count ?? 0, deleted_tiers: deletedTiers };
    } catch (e: any) {
      return { ok: false as const, reason: String(e?.message ?? e) };
    }
  });

// ── listerImports ────────────────────────────────────────────────────────────
export const listerImports = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ dossier_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }) => {
    const sb = getSupabase();
    try {
      const { data: batches, error } = await (sb.from("import_batches") as any)
        .select("id,filename,source_rows,inserted_ecritures,inserted_tiers,created_at")
        .eq("dossier_id", data.dossier_id)
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) return { ok: false as const, reason: error.message, batches: [] };
      return { ok: true as const, batches: batches ?? [] };
    } catch (e: any) {
      return { ok: false as const, reason: String(e?.message ?? e), batches: [] };
    }
  });
