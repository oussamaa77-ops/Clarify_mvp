// verify_lettrage_reprise.mjs — valide la migration 20260708150000 (date de reprise
// + archivage netting) de bout en bout au niveau BDD :
//   1. colonnes présentes (dossiers.date_reprise, ecritures_comptables.lettree/date_lettrage) ;
//   2. écriture/lecture réactive de date_reprise sur le dossier de test (puis restauration) ;
//   3. archivage netting : lettree/date_lettrage écrivables sur une écriture temporaire.
//
// Lancement :  node verify_lettrage_reprise.mjs   (SERVICE_ROLE_KEY, nettoie sa trace)

import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  fs.readFileSync(new URL(".env", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);

let PROXY_DIRECT = false;
async function proxyFetch(input, init) {
  if (PROXY_DIRECT) {
    const { fetch: uf, Agent } = await import("undici");
    return uf(String(input), { ...init, dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) });
  }
  try { return await fetch(String(input), init); }
  catch { PROXY_DIRECT = true; const { fetch: uf, Agent } = await import("undici");
    return uf(String(input), { ...init, dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) }); }
}
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { global: { fetch: proxyFetch } });
const DOSSIER_ID = "b64505dd-94ec-4d3a-9ab2-aa5637aec98b"; // DIGITAL SOLUTIONS

let pass = 0, fail = 0;
const check = (label, cond, detail = "") => { console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`); cond ? pass++ : fail++; };

(async () => {
  // 0) Colonnes de la migration présentes ?
  const probeDos = await sb.from("dossiers").select("date_reprise").eq("id", DOSSIER_ID).limit(1);
  const probeEcr = await sb.from("ecritures_comptables").select("lettree,date_lettrage").limit(1);
  if (probeDos.error || probeEcr.error) {
    console.error("\n❌ Migration NON appliquée : " + (probeDos.error?.message || probeEcr.error?.message));
    console.error("   → Exécute supabase/migrations/20260708150000_lettrage_reprise.sql dans Supabase, puis relance.\n");
    process.exit(3);
  }

  console.log(`\n🧪 verify_lettrage_reprise — dossier ${DOSSIER_ID}\n`);

  // 1) date_reprise : écriture/lecture réactive (sauvegarde puis restauration).
  const { data: before } = await sb.from("dossiers").select("date_reprise").eq("id", DOSSIER_ID).single();
  const original = before?.date_reprise ?? null;
  await sb.from("dossiers").update({ date_reprise: "2026-01-01" }).eq("id", DOSSIER_ID);
  const { data: after } = await sb.from("dossiers").select("date_reprise").eq("id", DOSSIER_ID).single();
  check("date_reprise écrite et relue", String(after?.date_reprise).slice(0, 10) === "2026-01-01", String(after?.date_reprise));
  await sb.from("dossiers").update({ date_reprise: original }).eq("id", DOSSIER_ID); // restauration
  const { data: restored } = await sb.from("dossiers").select("date_reprise").eq("id", DOSSIER_ID).single();
  check("date_reprise restaurée à sa valeur initiale", (restored?.date_reprise ?? null) === original, String(restored?.date_reprise ?? "null"));

  // 2) Archivage netting : lettree/date_lettrage écrivables sur une écriture temporaire.
  const { data: e, error: eIns } = await sb.from("ecritures_comptables")
    .insert({ dossier_id: DOSSIER_ID, journal_code: "OD", compte_numero: "3421999", date_ecriture: "2025-12-31", libelle: "__VERIFY REPRISE__", debit: 100, credit: 0, valide: true })
    .select("id,lettree").single();
  check("écriture temporaire créée (lettree défaut false)", !eIns && e?.lettree === false, eIns?.message);
  await sb.from("ecritures_comptables").update({ lettree: true, date_lettrage: new Date().toISOString() }).eq("id", e.id);
  const { data: e2 } = await sb.from("ecritures_comptables").select("lettree,date_lettrage").eq("id", e.id).single();
  check("écriture archivée (lettree=true + date_lettrage)", e2?.lettree === true && !!e2?.date_lettrage);
  await sb.from("ecritures_comptables").delete().eq("id", e.id); // nettoyage
  const { data: gone } = await sb.from("ecritures_comptables").select("id").eq("id", e.id).maybeSingle();
  check("trace de test nettoyée", !gone);

  console.log(`\n${fail === 0 ? "🎉 TOUT PASSE" : "⚠️  ÉCHECS"} — ${pass} ok / ${fail} ko\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("💥", e); process.exit(2); });
