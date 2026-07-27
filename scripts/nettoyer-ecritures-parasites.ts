/**
 * nettoyer-ecritures-parasites.ts — nettoyage des parasites listés par
 * `audit-ecritures-parasites.ts` (en-têtes / soldes / métadonnées de relevé
 * comptabilisés comme des opérations).
 *
 *   node --import tsx scripts/nettoyer-ecritures-parasites.ts            # DRY-RUN
 *   node --import tsx scripts/nettoyer-ecritures-parasites.ts --apply    # exécute
 *   node --import tsx scripts/nettoyer-ecritures-parasites.ts --rollback=<backup.json>
 *
 * Deux voies, selon l'origine :
 *   • lot d'IMPORT   → on rejoue la sémantique de `annulerImport` (suppression du
 *     lot → écritures en CASCADE, + tiers du lot non référencés par une facture).
 *   • écritures HORS lot → suppression ciblée, mais SEULEMENT après avoir vérifié
 *     que la pièce entière est parasite et ÉQUILIBRÉE : supprimer une seule jambe
 *     d'un couple déséquilibrerait le journal.
 *
 * Les transactions bancaires SOURCES (lignes d'en-tête prises pour des opérations)
 * sont supprimées aussi, sinon un prochain rapprochement les re-comptabilise.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { estEnteteOuMetaReleve } from "../src/lib/releve-attijari";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (nom: string): string | undefined => {
  const hit = argv.find((a) => a === `--${nom}` || a.startsWith(`--${nom}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf("=");
  return eq === -1 ? "" : hit.slice(eq + 1).replace(/^["']|["']$/g, "");
};
const APPLY = flag("apply") !== undefined;
const ROLLBACK = flag("rollback") || null;

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env"), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
) as Record<string, string>;
let PROXY_DIRECT = false;
async function proxyFetch(input: any, init?: any): Promise<any> {
  const direct = async () => {
    const { fetch: uf, Agent } = await import("undici");
    return uf(String(input), { ...init, dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) } as any);
  };
  if (PROXY_DIRECT) return direct();
  try { return await fetch(String(input), init); } catch { PROXY_DIRECT = true; return direct(); }
}
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  global: { fetch: proxyFetch as any }, auth: { persistSession: false },
});

const n = (v: any) => Number(v ?? 0);
const fmt = (v: number) => v.toLocaleString("fr-MA", { minimumFractionDigits: 2 });

// ── Cibles (issues de l'audit) ───────────────────────────────────────────────
const LOT_A_PURGER = { dossierId: "d5f33267-5443-45f3-9275-609bf5427103", dossier: "Societe 1_3", batchId: "14332830-101d-4824-8665-6abfbfd6970a" };
const DOSSIER_CIBLE_DIRECT = { dossierId: "8c37a591-1dfa-44ee-bd31-9f15f40c0a9d", dossier: "SOMADIR S.A." };

// ── Rollback ────────────────────────────────────────────────────────────────
if (ROLLBACK) {
  const f = path.isAbsolute(ROLLBACK) ? ROLLBACK : path.join(ROOT, ROLLBACK);
  const bk = JSON.parse(fs.readFileSync(f, "utf8"));
  console.log(`\n↩️  ROLLBACK depuis ${path.basename(f)}\n`);
  // Ordre : le lot d'abord (les écritures y font référence par FK batch_id).
  if (bk.import_batch) {
    const { error } = await sb.from("import_batches").insert(bk.import_batch);
    console.log(`  ${error ? "❌" : "✅"} lot d'import restauré${error ? ` (${error.message})` : ""}`);
  }
  for (const [table, rows] of Object.entries(bk.rows as Record<string, any[]>)) {
    if (!rows?.length) continue;
    const { error } = await sb.from(table).insert(rows);
    console.log(`  ${error ? "❌" : "✅"} ${table} : ${rows.length} ligne(s)${error ? ` — ${error.message}` : ""}`);
  }
  console.log("");
  process.exit(0);
}

console.log(`\n🧹 NETTOYAGE DES PARASITES — ${APPLY ? "MODE ÉCRITURE (--apply)" : "SIMULATION (dry-run)"}\n`);
const backup: { date: string; import_batch: any; rows: Record<string, any[]> } = {
  date: new Date().toISOString(), import_batch: null, rows: {},
};
const collecter = (table: string, rows: any[]) => { backup.rows[table] = [...(backup.rows[table] ?? []), ...rows]; };

// ═══ 1. Societe 1_3 — purge du LOT D'IMPORT (sémantique annulerImport) ═══════
console.log(`▸ ${LOT_A_PURGER.dossier} — purge du lot ${LOT_A_PURGER.batchId.slice(0, 8)}`);
const { data: lot } = await sb.from("import_batches").select("*").eq("id", LOT_A_PURGER.batchId).maybeSingle();
if (!lot) {
  console.log(`   ℹ️  lot introuvable (déjà purgé ?) — rien à faire`);
} else {
  const { data: ecrLot } = await sb.from("ecritures_comptables").select("*").eq("batch_id", LOT_A_PURGER.batchId);
  console.log(`   lot « ${lot.filename} » — ${ecrLot?.length ?? 0} écriture(s) (supprimées en CASCADE avec le lot)`);
  // Tiers du lot non référencés par une facture (miroir strict d'annulerImport).
  const tiersSupprimables: { table: string; ids: string[] }[] = [];
  for (const [table, factureTable, fk] of [["clients", "factures", "client_id"], ["fournisseurs", "factures_fournisseurs", "fournisseur_id"]] as const) {
    const { data: tiers } = await sb.from(table).select("*").eq("import_batch_id", LOT_A_PURGER.batchId);
    const ids = (tiers ?? []).map((t: any) => t.id);
    if (!ids.length) continue;
    const { data: refs } = await sb.from(factureTable).select(fk).in(fk, ids);
    const referenced = new Set((refs ?? []).map((r: any) => r[fk]));
    const deletable = ids.filter((id: string) => !referenced.has(id));
    console.log(`   ${table} du lot : ${ids.length} — supprimables (non référencés) : ${deletable.length}`);
    if (deletable.length) {
      collecter(table, (tiers ?? []).filter((t: any) => deletable.includes(t.id)));
      tiersSupprimables.push({ table, ids: deletable });
    }
  }
  if (APPLY) {
    collecter("ecritures_comptables", ecrLot ?? []);
    backup.import_batch = lot;
    for (const t of tiersSupprimables) {
      const { error } = await sb.from(t.table).delete().in("id", t.ids);
      console.log(`   ${error ? "❌" : "✅"} ${t.ids.length} ${t.table} supprimé(s)${error ? ` — ${error.message}` : ""}`);
    }
    const { error } = await sb.from("import_batches").delete().eq("id", LOT_A_PURGER.batchId).eq("dossier_id", LOT_A_PURGER.dossierId);
    console.log(`   ${error ? "❌" : "✅"} lot supprimé → ${ecrLot?.length ?? 0} écriture(s) en cascade${error ? ` — ${error.message}` : ""}`);
  } else {
    console.log(`   → SIMULATION : le lot, ses ${ecrLot?.length ?? 0} écritures et les tiers non référencés seraient supprimés.`);
  }
}

// ═══ 2. SOMADIR — écritures parasites HORS lot, par PIÈCE ÉQUILIBRÉE ═════════
console.log(`\n▸ ${DOSSIER_CIBLE_DIRECT.dossier} — écritures parasites hors lot`);
const { data: ecrSom } = await sb.from("ecritures_comptables").select("*").eq("dossier_id", DOSSIER_CIBLE_DIRECT.dossierId);
// Une écriture est parasite si son libellé est un en-tête/méta/solde de relevé.
const parasites = (ecrSom ?? []).filter((e) => estEnteteOuMetaReleve(e.libelle) || /\bsolde\s+(final|precedent|pr[eé]c[eé]dent)\b/i.test(String(e.libelle ?? "")));
const parPiece = new Map<string, any[]>();
for (const e of parasites) {
  const k = e.reference_piece ?? `__sans_ref_${e.id}`;
  parPiece.set(k, [...(parPiece.get(k) ?? []), e]);
}
const aSupprimer: any[] = [];
for (const [ref, lignes] of parPiece) {
  // Toutes les écritures de la pièce (parasites ou non) : la pièce doit être
  // INTÉGRALEMENT parasite, sinon on casserait une opération réelle.
  const pieceComplete = (ecrSom ?? []).filter((e) => (e.reference_piece ?? `__sans_ref_${e.id}`) === ref);
  const toutesParasites = pieceComplete.every((e) => parasites.some((p) => p.id === e.id));
  const debit = pieceComplete.reduce((s, e) => s + n(e.debit), 0);
  const credit = pieceComplete.reduce((s, e) => s + n(e.credit), 0);
  const equilibree = Math.abs(debit - credit) < 0.01;
  const ok = toutesParasites && equilibree;
  console.log(`   ${ok ? "✅" : "⛔"} pièce « ${String(ref).slice(0, 40)} » — ${pieceComplete.length} ligne(s), D ${fmt(debit)} / C ${fmt(credit)}`
    + `${toutesParasites ? "" : " | CONTIENT DES LIGNES SAINES → conservée"}${equilibree ? "" : " | DÉSÉQUILIBRÉE → conservée"}`);
  for (const e of pieceComplete) console.log(`        ${String(e.compte_numero).padEnd(6)} D=${String(fmt(n(e.debit))).padStart(14)} C=${String(fmt(n(e.credit))).padStart(14)}  « ${String(e.libelle).slice(0, 48)} »`);
  if (ok) aSupprimer.push(...pieceComplete);
}
console.log(`   → ${aSupprimer.length} écriture(s) à supprimer (pièces entièrement parasites et équilibrées)`);

// ═══ 3. Transactions bancaires SOURCES (les lignes d'en-tête elles-mêmes) ════
console.log(`\n▸ Transactions bancaires sources (en-têtes/soldes pris pour des opérations)`);
const txParasites: any[] = [];
for (const { dossierId, dossier } of [LOT_A_PURGER, DOSSIER_CIBLE_DIRECT]) {
  const { data: txs } = await sb.from("transactions_bancaires").select("*").eq("dossier_id", dossierId);
  const bad = (txs ?? []).filter((t) =>
    (estEnteteOuMetaReleve(t.libelle) || /\bsolde\s+(final|precedent|pr[eé]c[eé]dent)\b/i.test(String(t.libelle ?? "")))
    && !t.facture_id && !t.justificatif_id);   // jamais une tx rattachée à une pièce réelle
  console.log(`   ${dossier} : ${bad.length} transaction(s) parasite(s) sur ${txs?.length ?? 0}`);
  for (const t of bad) console.log(`        ${t.date_operation} ${String(t.type).padEnd(7)} ${String(fmt(n(t.montant))).padStart(14)}  « ${String(t.libelle).slice(0, 52)} »`);
  txParasites.push(...bad);
}

// ═══ 4. Application ═════════════════════════════════════════════════════════
if (!APPLY) {
  console.log(`\n🔍 SIMULATION terminée — relance avec --apply pour exécuter.\n`);
} else {
  if (aSupprimer.length) {
    collecter("ecritures_comptables", aSupprimer);
    const { error } = await sb.from("ecritures_comptables").delete().in("id", aSupprimer.map((e) => e.id));
    console.log(`\n   ${error ? "❌" : "✅"} ${aSupprimer.length} écriture(s) supprimée(s)${error ? ` — ${error.message}` : ""}`);
  }
  if (txParasites.length) {
    collecter("transactions_bancaires", txParasites);
    const { error } = await sb.from("transactions_bancaires").delete().in("id", txParasites.map((t) => t.id));
    console.log(`   ${error ? "❌" : "✅"} ${txParasites.length} transaction(s) supprimée(s)${error ? ` — ${error.message}` : ""}`);
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const nomFichier = `backup_nettoyage_parasites_${stamp}.json`;
  fs.writeFileSync(path.join(ROOT, nomFichier), JSON.stringify(backup, null, 2), "utf8");
  const total = Object.values(backup.rows).reduce((s, r) => s + r.length, 0);
  console.log(`\n💾 Sauvegarde : ${nomFichier} (${total} ligne(s)${backup.import_batch ? " + le lot d'import" : ""}) — rejouable via --rollback=${nomFichier}\n`);
}
