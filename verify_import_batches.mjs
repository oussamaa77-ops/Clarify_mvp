// verify_import_batches.mjs — vérifie la migration d'import réversible + le cycle
// de vie d'un lot (créer → tagger écritures + tiers → ANNULER → tout disparaît).
// Miroir de src/server/import.functions.ts (importerGrandLivre / annulerImport).
//
// Lancement :  node verify_import_batches.mjs   (SERVICE_ROLE_KEY, nettoie sa trace)

import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  fs.readFileSync(new URL(".env", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);
// fetch tolérant au proxy TLS d'entreprise (cf. proxy-supabase-server) : repli undici.
let PROXY_DIRECT = false;
async function proxyFetch(input, init) {
  if (PROXY_DIRECT) {
    const { fetch: uf, Agent } = await import("undici");
    return uf(String(input), { ...init, dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) });
  }
  try { return await fetch(String(input), init); }
  catch (e) {
    PROXY_DIRECT = true;
    const { fetch: uf, Agent } = await import("undici");
    return uf(String(input), { ...init, dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) });
  }
}
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { global: { fetch: proxyFetch } });
const DOSSIER_ID = "b64505dd-94ec-4d3a-9ab2-aa5637aec98b"; // DIGITAL SOLUTIONS

let pass = 0, fail = 0;
const check = (label, cond, detail = "") => { console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`); cond ? pass++ : fail++; };

(async () => {
  // 0) Pré-requis : colonnes de la migration présentes ?
  const probeBatch = await sb.from("import_batches").select("id,inserted_ecritures,inserted_tiers").limit(1);
  const probeEcr = await sb.from("ecritures_comptables").select("batch_id").limit(1);
  const probeCli = await sb.from("clients").select("import_batch_id").limit(1);
  if (probeBatch.error || probeEcr.error || probeCli.error) {
    console.error("\n❌ Migration NON appliquée : " + (probeBatch.error?.message || probeEcr.error?.message || probeCli.error?.message));
    console.error("   → Exécute supabase/migrations/20260708130000_import_batches.sql dans Supabase, puis relance.\n");
    process.exit(3);
  }

  console.log(`\n🧪 verify_import_batches — dossier ${DOSSIER_ID}\n`);

  // 1) Créer un lot.
  const { data: batch, error: eB } = await sb.from("import_batches")
    .insert({ dossier_id: DOSSIER_ID, type: "grand_livre", filename: "__verify__.xlsx", source_rows: 2 })
    .select("id").single();
  check("lot créé", !eB && !!batch?.id, eB?.message);
  const batchId = batch?.id;

  // 2) Tagger 2 écritures + 1 tiers avec le lot.
  const { error: eE } = await sb.from("ecritures_comptables").insert([
    { dossier_id: DOSSIER_ID, journal_code: "VTE", compte_numero: "3421999", date_ecriture: "2026-01-15", libelle: "__VERIFY CLIENT TEST__", debit: 1200, credit: 0, valide: true, batch_id: batchId },
    { dossier_id: DOSSIER_ID, journal_code: "VTE", compte_numero: "7111", date_ecriture: "2026-01-15", libelle: "__VERIFY VENTE TEST__", debit: 0, credit: 1200, valide: true, batch_id: batchId },
  ]);
  check("2 écritures taguées insérées", !eE, eE?.message);

  const { data: tiers, error: eT } = await sb.from("clients")
    .insert({ dossier_id: DOSSIER_ID, nom: "__VERIFY CLIENT TEST__", import_batch_id: batchId })
    .select("id").single();
  check("tiers auto-dérivé tagué inséré", !eT && !!tiers?.id, eT?.message);

  const cntEcr = await sb.from("ecritures_comptables").select("id", { count: "exact", head: true }).eq("batch_id", batchId);
  check("2 écritures rattachées au lot", cntEcr.count === 2, `count=${cntEcr.count}`);

  // 3) ANNULER : supprimer le lot → écritures CASCADE ; tiers non référencés supprimés.
  await sb.from("clients").delete().eq("import_batch_id", batchId); // tiers non référencé → suppr directe (miroir annulerImport)
  const { error: eD } = await sb.from("import_batches").delete().eq("id", batchId);
  check("lot supprimé", !eD, eD?.message);

  const afterEcr = await sb.from("ecritures_comptables").select("id", { count: "exact", head: true }).eq("batch_id", batchId);
  check("écritures du lot supprimées en CASCADE", afterEcr.count === 0, `count=${afterEcr.count}`);
  const afterTiers = await sb.from("clients").select("id", { count: "exact", head: true }).eq("import_batch_id", batchId);
  check("tiers du lot supprimés", afterTiers.count === 0, `count=${afterTiers.count}`);

  // Filet de sécurité : purge toute trace résiduelle.
  await sb.from("clients").delete().eq("dossier_id", DOSSIER_ID).eq("nom", "__VERIFY CLIENT TEST__");

  console.log(`\n${fail === 0 ? "🎉 TOUT PASSE" : "⚠️  ÉCHECS"} — ${pass} ok / ${fail} ko\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("💥", e); process.exit(2); });
