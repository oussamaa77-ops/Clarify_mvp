/**
 * synchroniser-factures-grandlivre.ts — réaligne `factures` / `factures_fournisseurs`
 * sur ce que dit VRAIMENT le grand livre.
 *
 * ─── Le problème ─────────────────────────────────────────────────────────────
 * `montant_paye` / `montant_restant` / `statut_paiement` sont écrits au fil des
 * règlements. Toute opération qui touche la comptabilité sans repasser par ce
 * chemin les laisse en arrière : purge d'une écriture fantôme, délettrage manuel,
 * règlement saisi directement en écriture. La facture affiche alors un état que
 * la comptabilité contredit.
 *
 * Ce script recalcule ces trois colonnes depuis les écritures LETTRÉES (cf.
 * src/lib/encours-grandlivre.ts) et n'écrit que les factures qui divergent.
 * C'est le même cœur que celui branché sur le lettrage — le script sert au
 * rattrapage de l'existant, le branchement au maintien.
 *
 * ─── Sûreté ──────────────────────────────────────────────────────────────────
 * • DRY-RUN par défaut : il faut `--apply` pour écrire.
 * • Une facture ABSENTE du grand livre n'est jamais touchée : elle n'est pas
 *   « non payée », elle n'est pas comptabilisée, et la réécrire effacerait un
 *   règlement saisi avant sa comptabilisation.
 * • Backup rejouable de l'état AVANT, pour chaque facture réécrite.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   node --import tsx scripts/synchroniser-factures-grandlivre.ts
 *   node --import tsx scripts/synchroniser-factures-grandlivre.ts --dossier="DIGITAL"
 *   node --import tsx scripts/synchroniser-factures-grandlivre.ts --dossier="DIGITAL" --apply
 *   node --import tsx scripts/synchroniser-factures-grandlivre.ts --rollback=backup_factures_XXX.json
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { executerSyncFacturesGL } from "../src/server/factures-gl.functions";

const ICI = path.dirname(fileURLToPath(import.meta.url));
const RACINE = path.resolve(ICI, "..");
const env = Object.fromEntries(
  fs.readFileSync(path.join(RACINE, ".env"), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);
for (const [k, v] of Object.entries(env)) if (!process.env[k]) process.env[k] = v as string;

let PROXY_DIRECT = false;
async function proxyFetch(input: any, init?: any): Promise<any> {
  const direct = async () => {
    const { fetch: uf, Agent } = await import("undici");
    return (uf as any)(String(input), { ...init, dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) });
  };
  if (PROXY_DIRECT) return direct();
  try { return await fetch(String(input), init); }
  catch { PROXY_DIRECT = true; return direct(); }
}
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  global: { fetch: (i: any, init?: any) => proxyFetch(i, init) },
});

const args = process.argv.slice(2);
const lire = (nom: string): string | null => {
  const a = args.find((x) => x.startsWith(`--${nom}=`));
  return a ? a.slice(nom.length + 3).replace(/^["']|["']$/g, "") : null;
};
const APPLY = args.includes("--apply");
const DOSSIER = lire("dossier");
const ROLLBACK = lire("rollback");

const fmt = (x: number) => Number(x).toLocaleString("fr-MA", { minimumFractionDigits: 2 });

async function rollback(fichier: string) {
  const chemin = path.isAbsolute(fichier) ? fichier : path.join(RACINE, fichier);
  const backup = JSON.parse(fs.readFileSync(chemin, "utf8"));
  console.log(`\n↩️  ROLLBACK depuis ${path.basename(chemin)} — ${backup.factures.length} facture(s)\n`);
  for (const f of backup.factures) {
    const { error } = await sb.from(f.table).update(f.avant).eq("id", f.id);
    console.log(`   ${error ? "❌" : "✅"} ${f.table} ${f.numero ?? f.id}${error ? ` — ${error.message}` : ""}`);
  }
  process.exit(0);
}

async function main() {
  if (ROLLBACK) return rollback(ROLLBACK);

  let q = sb.from("dossiers").select("id,nom_societe");
  if (DOSSIER) q = q.ilike("nom_societe", `%${DOSSIER}%`);
  const { data: dossiers, error } = await q;
  if (error) { console.error("❌", error.message); process.exit(1); }

  console.log(`\n═══ FACTURES ⇄ GRAND LIVRE ${APPLY ? "" : "(DRY-RUN)"} ═══\n`);
  const backup: any[] = [];
  let totalDiv = 0, totalCorr = 0;

  for (const d of (dossiers ?? []) as any[]) {
    // On calcule TOUJOURS en simulation d'abord : c'est ce qui permet de
    // journaliser l'état AVANT, donc de proposer un rollback.
    const vue = await executerSyncFacturesGL(sb, { dossierId: d.id, simulation: true });
    if (!vue.ok) { console.log(`⚠️  ${d.nom_societe} — ${vue.raison}`); continue; }
    if (!vue.divergentes.length) {
      console.log(`✅ ${String(d.nom_societe).padEnd(34)} ${vue.examinees} facture(s), aucune divergence`);
      continue;
    }

    console.log(`\n📁 ${d.nom_societe} — ${vue.divergentes.length}/${vue.examinees} facture(s) divergentes`);
    for (const f of vue.divergentes) {
      console.log(`   ${f.numero ?? f.id}`);
      console.log(`      stocké  : payé ${fmt(f.avant.montant_paye)} · restant ${fmt(f.avant.montant_restant)} · ${f.avant.statut_paiement}`);
      console.log(`      compta  : payé ${fmt(f.apres.montant_paye)} · restant ${fmt(f.apres.montant_restant)} · ${f.apres.statut_paiement}`
        + (f.apres.codes.length ? `  [lettrage ${f.apres.codes.join(", ")}]` : "  [aucun lettrage]"));
      backup.push({ table: f.table, id: f.id, numero: f.numero, avant: f.avant });
    }
    totalDiv += vue.divergentes.length;

    if (APPLY) {
      const r = await executerSyncFacturesGL(sb, { dossierId: d.id });
      totalCorr += r.corrigees;
      console.log(`   ✅ ${r.corrigees} facture(s) réalignée(s).`);
    }
  }

  console.log("\n" + "─".repeat(72));
  console.log(`${totalDiv} facture(s) divergente(s)${APPLY ? ` — ${totalCorr} réalignée(s)` : ""}`);
  if (!APPLY) { console.log("🔍 DRY-RUN — rien n'a été écrit. Ajoutez --apply."); return; }
  if (backup.length) {
    const nom = `backup_factures_${new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14)}.json`;
    fs.writeFileSync(path.join(RACINE, nom), JSON.stringify({ date: new Date().toISOString(), factures: backup }, null, 2), "utf8");
    console.log(`💾 Backup : ${nom}`);
    console.log(`↩️  Rollback : node --import tsx scripts/synchroniser-factures-grandlivre.ts --rollback=${nom}`);
  }
}

main().catch((e) => { console.error("💥", e); process.exit(1); });
