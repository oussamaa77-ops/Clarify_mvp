/**
 * reclasser-tva-racines.ts — ramène la TVA échouée sur les RACINES vers les
 * sous-comptes d'imputation : 4455 → 44551, 3455 → 34552.
 *
 * ─── Le problème ─────────────────────────────────────────────────────────────
 * Les journaux de vente et d'achat créditent / débitent les SOUS-COMPTES (44551
 * « TVA facturée », 34552 « TVA récupérable sur charges »), mais la bascule au
 * règlement visait les RACINES (4455 / 3455). La TVA exigible se retrouvait donc
 * éclatée sur deux comptes pour une même nature — un régime mixte, dont la
 * déclaration ne voyait qu'une moitié.
 *
 * Le code est corrigé (cf. COMPTES_TVA dans src/services/lettrage.ts) ; ce script
 * répare l'EXISTANT.
 *
 * ─── Pourquoi c'est sûr ──────────────────────────────────────────────────────
 * On ne touche QUE `compte_numero`, jamais un montant ni un sens. L'équilibre du
 * grand livre est donc préservé par construction — le contrôle avant/après le
 * vérifie quand même, parce qu'un script qui l'affirme sans le mesurer ne vaut
 * rien.
 *
 * Seules les lignes au compte EXACTEMENT égal à la racine sont reprises : une
 * ligne déjà sur 44551 ou sur un autre sous-compte (44552…) n'est pas touchée.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   node --import tsx scripts/reclasser-tva-racines.ts                 # dry-run
 *   node --import tsx scripts/reclasser-tva-racines.ts --dossier="SOMADIR"
 *   node --import tsx scripts/reclasser-tva-racines.ts --apply
 *   node --import tsx scripts/reclasser-tva-racines.ts --rollback=backup_tva_XXX.json
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

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

/** Racine mal imputée → sous-compte d'imputation correct. */
const RECLASSEMENTS: Record<string, string> = { "4455": "44551", "3455": "34552" };

const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const r2 = (x: number) => Math.round(x * 100) / 100;
const fmt = (x: number) => Number(x).toLocaleString("fr-MA", { minimumFractionDigits: 2 });

async function equilibre(label: string): Promise<boolean> {
  const { data: dos } = await sb.from("dossiers").select("id,nom_societe");
  console.log(`\n═══ ÉQUILIBRE DU GRAND LIVRE (${label}) ═══\n`);
  let toutBon = true;
  for (const d of (dos ?? []) as any[]) {
    const { data } = await sb.from("ecritures_comptables").select("debit,credit").eq("dossier_id", d.id);
    const l = (data ?? []) as any[];
    if (!l.length) continue;
    const e = r2(l.reduce((s, x) => s + n(x.debit) - n(x.credit), 0));
    if (Math.abs(e) > 0.005) toutBon = false;
    console.log(`${Math.abs(e) <= 0.005 ? "✅" : "❌"} ${String(d.nom_societe).padEnd(32)} écart ${fmt(e)}`);
  }
  return toutBon;
}

async function rollback(fichier: string) {
  const chemin = path.isAbsolute(fichier) ? fichier : path.join(RACINE, fichier);
  const backup = JSON.parse(fs.readFileSync(chemin, "utf8"));
  console.log(`\n↩️  ROLLBACK — ${backup.lignes.length} ligne(s) remises sur leur compte d'origine\n`);
  for (const l of backup.lignes) {
    const { error } = await sb.from("ecritures_comptables")
      .update({ compte_numero: l.compte_avant }).eq("id", l.id);
    if (error) console.log(`   ❌ ${l.id} — ${error.message}`);
  }
  console.log("✅ Rollback terminé.");
  await equilibre("après rollback");
  process.exit(0);
}

async function main() {
  if (ROLLBACK) return rollback(ROLLBACK);

  let q = sb.from("dossiers").select("id,nom_societe");
  if (DOSSIER) q = q.ilike("nom_societe", `%${DOSSIER}%`);
  const { data: dossiers, error } = await q;
  if (error) { console.error("❌", error.message); process.exit(1); }

  console.log(`\n═══ RECLASSEMENT TVA ${APPLY ? "" : "(DRY-RUN)"} — 4455 → 44551, 3455 → 34552 ═══`);
  await equilibre("avant");

  const aReclasser: any[] = [];
  for (const d of (dossiers ?? []) as any[]) {
    for (const [racine, cible] of Object.entries(RECLASSEMENTS)) {
      // Égalité STRICTE sur la racine : une ligne déjà sur un sous-compte est
      // correctement imputée et ne doit pas bouger.
      const { data } = await sb.from("ecritures_comptables")
        .select("id,journal_code,date_ecriture,libelle,debit,credit,reference_piece,compte_numero")
        .eq("dossier_id", d.id).eq("compte_numero", racine);
      for (const l of (data ?? []) as any[]) {
        aReclasser.push({ ...l, dossier: d.nom_societe, compte_avant: racine, compte_apres: cible });
      }
    }
  }

  if (!aReclasser.length) {
    console.log("\n✅ Aucune ligne sur les racines 4455 / 3455 : rien à reclasser.\n");
    return;
  }

  const parDossier = new Map<string, any[]>();
  for (const l of aReclasser) parDossier.set(l.dossier, [...(parDossier.get(l.dossier) ?? []), l]);
  for (const [dossier, lignes] of parDossier) {
    console.log(`\n📁 ${dossier} — ${lignes.length} ligne(s)`);
    for (const l of lignes) {
      console.log(`   ${l.compte_avant} → ${l.compte_apres}  ${l.journal_code} ${l.date_ecriture}`
        + `  D ${fmt(n(l.debit)).padStart(11)} C ${fmt(n(l.credit)).padStart(11)}  « ${String(l.libelle ?? "").slice(0, 44)} »`);
    }
  }

  if (!APPLY) {
    console.log(`\n🔍 DRY-RUN — ${aReclasser.length} ligne(s) à reclasser. Ajoutez --apply.\n`);
    return;
  }

  const nomBackup = `backup_tva_${new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14)}.json`;
  fs.writeFileSync(path.join(RACINE, nomBackup),
    JSON.stringify({ date: new Date().toISOString(), lignes: aReclasser }, null, 2), "utf8");

  let faits = 0;
  for (const l of aReclasser) {
    const { error: e } = await sb.from("ecritures_comptables")
      .update({ compte_numero: l.compte_apres }).eq("id", l.id);
    if (e) console.log(`   ❌ ${l.id} — ${e.message}`); else faits++;
  }
  console.log(`\n✅ ${faits}/${aReclasser.length} ligne(s) reclassée(s).`);
  console.log(`💾 Backup : ${nomBackup}`);
  console.log(`↩️  Rollback : node --import tsx scripts/reclasser-tva-racines.ts --rollback=${nomBackup}`);

  const ok = await equilibre("après");
  // Le reclassement ne touche aucun montant : l'équilibre DOIT être inchangé.
  console.log(ok ? "\n✅ Équilibre préservé.\n" : "\n❌ ÉQUILIBRE ROMPU — lancez le rollback immédiatement.\n");
}

main().catch((e) => { console.error("💥", e); process.exit(1); });
