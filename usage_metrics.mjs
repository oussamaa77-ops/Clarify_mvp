// usage_metrics.mjs — tableau de bord CLI de l'usage IA / mémoire.
// Lit analytics_usage et agrège par jour : % skipLLM, appels IA évités, coût économisé.
// Miroir de agregerUsage() dans src/server/analytics.functions.ts.
//
//   node usage_metrics.mjs [jours] [dossier_id]
//   ex: node usage_metrics.mjs 30
//       node usage_metrics.mjs 7 b64505dd-94ec-4d3a-9ab2-aa5637aec98b

import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  fs.readFileSync(new URL(".env", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const days = Number(process.argv[2] || 30);
const dossierId = process.argv[3] || null;

function agregerUsage(rows) {
  const byDay = new Map();
  const blank = (jour) => ({ jour, total: 0, appels_ia: 0, ia_evites: 0, pct_skip: 0, cout_economise: 0, cout_depense: 0 });
  const glob = blank("TOTAL");
  for (const r of rows) {
    const jour = (r.created_at ?? "").slice(0, 10) || "?";
    const d = byDay.get(jour) ?? blank(jour);
    const cout = Number(r.cout_estime ?? 0);
    for (const m of [d, glob]) {
      m.total += 1;
      if (r.skip_llm) { m.ia_evites += 1; m.cout_economise += cout; }
      else if (r.method === "llm") { m.appels_ia += 1; m.cout_depense += cout; }
    }
    byDay.set(jour, d);
  }
  const fin = (m) => { m.pct_skip = m.total ? Math.round((m.ia_evites / m.total) * 1000) / 10 : 0; return m; };
  return { par_jour: [...byDay.values()].map(fin).sort((a, b) => b.jour.localeCompare(a.jour)), global: fin(glob) };
}

const usd = (n) => `$${n.toFixed(4)}`;
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

(async () => {
  const probe = await sb.from("analytics_usage").select("id").limit(1);
  if (probe.error) {
    console.error("\n❌ Table analytics_usage absente : " + probe.error.message);
    console.error("   → Applique supabase/migrations/20260704150000_analytics_usage.sql puis relance.\n");
    process.exit(3);
  }

  const since = new Date(Date.now() - days * 86400_000).toISOString();
  let q = sb.from("analytics_usage").select("sens,method,skip_llm,cout_estime,created_at")
    .gte("created_at", since).order("created_at", { ascending: false }).limit(50000);
  if (dossierId) q = q.eq("dossier_id", dossierId);
  const { data: rows, error } = await q;
  if (error) { console.error("💥", error.message); process.exit(2); }

  const { par_jour, global } = agregerUsage(rows ?? []);

  console.log(`\n📊 Usage IA / mémoire — ${days} derniers jours${dossierId ? ` · dossier ${dossierId.slice(0, 8)}…` : " · tous dossiers"}`);
  console.log(`   ${rows?.length ?? 0} traitement(s) journalisé(s)\n`);
  if (!rows?.length) { console.log("   (aucune donnée — lance un scan de facture ou de relevé)\n"); process.exit(0); }

  console.log("  " + pad("Jour", 12) + padL("Total", 7) + padL("IA", 6) + padL("Évités", 8) + padL("%skip", 8) + padL("Économisé", 12) + padL("Dépensé", 11));
  console.log("  " + "─".repeat(64));
  for (const d of par_jour) {
    console.log("  " + pad(d.jour, 12) + padL(d.total, 7) + padL(d.appels_ia, 6) + padL(d.ia_evites, 8) + padL(d.pct_skip + "%", 8) + padL(usd(d.cout_economise), 12) + padL(usd(d.cout_depense), 11));
  }
  console.log("  " + "─".repeat(64));
  console.log("  " + pad("TOTAL", 12) + padL(global.total, 7) + padL(global.appels_ia, 6) + padL(global.ia_evites, 8) + padL(global.pct_skip + "%", 8) + padL(usd(global.cout_economise), 12) + padL(usd(global.cout_depense), 11));

  console.log(`\n  ⚡ ${global.ia_evites} appel(s) IA évité(s) sur ${global.total} (${global.pct_skip}%)`);
  console.log(`  💰 Coût IA économisé : ${usd(global.cout_economise)} (dépensé : ${usd(global.cout_depense)})\n`);
  process.exit(0);
})().catch((e) => { console.error("💥", e); process.exit(2); });
