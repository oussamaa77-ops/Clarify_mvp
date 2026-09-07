/**
 * normaliser-numeros-comptes.ts — porte les numéros de comptes de la base à
 * leur forme CANONIQUE : 8 chiffres, complétés à droite par des zéros.
 *
 * ─── Le défaut ───────────────────────────────────────────────────────────────
 * La base portait trois longueurs à la fois, par couches successives : 4 pour le
 * PCM de base (5141, 4458), 5 pour les sous-comptes (44551, 34552, 61254), 8
 * pour la comptabilité auxiliaire (44110005) et la caisse (51610000).
 *
 * Ce n'est pas une coquette d'affichage. « 5141 » et « 51410000 » désignent la
 * même banque et s'additionnent en DEUX lignes de balance ; un export Sage, qui
 * exige une longueur fixe, en refuse une sur deux ; et le jour où un import
 * Excel arrive dans l'autre convention, le dossier se dédouble en silence.
 *
 * ─── Pourquoi compléter à DROITE ─────────────────────────────────────────────
 * Parce que c'est la convention du plan comptable marocain, et surtout parce que
 * c'est la seule qui préserve la LECTURE PAR RACINE dont dépend tout le code :
 * `44551000` commence toujours par `4455` (TVA exigible), `44110005` par `4411`
 * (collectif fournisseur), la classe reste le premier chiffre. Compléter à
 * gauche casserait les quatre à la fois.
 *
 * ─── Ce que le script NE touche pas ──────────────────────────────────────────
 * `pcm_reference` : c'est le référentiel de nomenclature, pas de la comptabilité
 * mouvementée. Ses clefs restent courtes, et `intitulePcm` fait le pont.
 *
 * Un compte de `comptes_comptables` dont la forme canonique EXISTE DÉJÀ dans le
 * même dossier n'est pas normalisé : la mise à jour violerait l'unicité, et
 * fusionner deux comptes n'est pas une opération mécanique (les soldes initiaux
 * ne s'additionnent pas sans arbitrage). Ces cas sont listés, à fusionner à la
 * main.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   node --import tsx scripts/normaliser-numeros-comptes.ts
 *   node --import tsx scripts/normaliser-numeros-comptes.ts --apply
 *   node --import tsx scripts/normaliser-numeros-comptes.ts --dossier="SMERT"
 *   node --import tsx scripts/normaliser-numeros-comptes.ts --rollback=backup_....json
 *
 * DRY-RUN par défaut : sans `--apply`, aucune écriture. La sauvegarde est prise
 * AVANT toute mise à jour et porte l'ancienne valeur ligne à ligne — le rollback
 * la repose telle quelle.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { normaliserNumeroCompte } from "../src/lib/numero-compte";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const flag = (nom: string) => {
  const hit = argv.find((a) => a === `--${nom}` || a.startsWith(`--${nom}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf("=");
  return eq === -1 ? "" : hit.slice(eq + 1).replace(/^["']|["']$/g, "");
};
const APPLY = flag("apply") !== undefined;
const ROLLBACK = flag("rollback") || null;
const CIBLE = flag("dossier") || null;

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env"), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
) as Record<string, string>;

// Le proxy TLS de l'entreprise casse le `fetch` global ; undici en direct passe
// (cf. mémoire « proxy-supabase-server »). On n'essaie le repli qu'une fois.
let PROXY_DIRECT = false;
async function proxyFetch(input: any, init?: any): Promise<any> {
  const direct = async () => {
    const { fetch: uf, Agent } = await import("undici");
    return uf(String(input), { ...init, dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) } as any);
  };
  if (PROXY_DIRECT) return direct();
  try { return await fetch(String(input), init); }
  catch { PROXY_DIRECT = true; return direct(); }
}
const sb = createClient(env.SUPABASE_URL || env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  global: { fetch: proxyFetch as any }, auth: { persistSession: false, autoRefreshToken: false },
});

const txt = (v: unknown) => String(v ?? "").trim();
const pad = (s: unknown, n: number) => String(s).padEnd(n);

/** PostgREST plafonne à 1000 lignes : sans pagination, un gros dossier est tronqué en silence. */
async function paginer(table: string, colonnes: string, filtre?: (q: any) => any): Promise<any[]> {
  let tout: any[] = [], de = 0;
  for (;;) {
    let q = (sb.from(table) as any).select(colonnes).range(de, de + 999);
    if (filtre) q = filtre(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table} : ${error.message}`);
    tout = tout.concat(data ?? []);
    if ((data ?? []).length < 1000) break;
    de += 1000;
  }
  return tout;
}

// ─── Rollback ───────────────────────────────────────────────────────────────
if (ROLLBACK) {
  const sauv = JSON.parse(fs.readFileSync(path.join(ROOT, ROLLBACK), "utf8"));
  console.log(`\n⏪ ROLLBACK depuis ${ROLLBACK} — ${sauv.modifications.length} ligne(s)\n`);
  let ok = 0, ko = 0;
  for (const m of sauv.modifications) {
    const { error } = await (sb.from(m.table) as any)
      .update({ [m.colonne]: m.avant }).eq("id", m.id);
    if (error) { ko++; console.error(`   ❌ ${m.table} ${m.id} : ${error.message}`); }
    else ok++;
  }
  console.log(`\n   ${ok} restaurée(s), ${ko} en échec.\n`);
  process.exit(ko ? 1 : 0);
}

console.log(`\n${APPLY ? "🔧 APPLICATION" : "🔍 SIMULATION (dry-run)"} — normalisation des numéros de comptes sur 8 chiffres\n`);

// ─── Périmètre ──────────────────────────────────────────────────────────────
let dossierIds: string[] | null = null;
if (CIBLE) {
  let q = (sb.from("dossiers") as any).select("id,nom_societe");
  q = /^[0-9a-f-]{36}$/i.test(CIBLE) ? q.eq("id", CIBLE) : q.ilike("nom_societe", `%${CIBLE}%`);
  const { data, error } = await q;
  if (error) { console.error(`❌ ${error.message}`); process.exit(1); }
  if (!(data ?? []).length) { console.error(`❌ aucun dossier pour « ${CIBLE} »`); process.exit(1); }
  dossierIds = (data as any[]).map((d) => d.id);
  console.log(`  Périmètre : ${(data as any[]).map((d) => d.nom_societe).join(", ")}\n`);
}
const borner = dossierIds ? (q: any) => q.in("dossier_id", dossierIds) : undefined;

interface Modif { table: string; colonne: string; id: string; avant: string; apres: string }
const modifications: Modif[] = [];
const bloques: string[] = [];

// ─── 1. Écritures comptables ────────────────────────────────────────────────
const ecritures = await paginer("ecritures_comptables", "id,compte_numero", borner);
for (const e of ecritures) {
  const avant = txt(e.compte_numero);
  const apres = normaliserNumeroCompte(avant);
  if (avant && apres !== avant) {
    modifications.push({ table: "ecritures_comptables", colonne: "compte_numero", id: e.id, avant, apres });
  }
}

// ─── 2. Plan comptable du dossier ───────────────────────────────────────────
const comptes = await paginer("comptes_comptables", "id,dossier_id,numero", borner);
// Index des numéros DÉJÀ présents par dossier : c'est lui qui détecte la collision.
const parDossier = new Map<string, Set<string>>();
for (const c of comptes) {
  const cle = txt(c.dossier_id);
  if (!parDossier.has(cle)) parDossier.set(cle, new Set());
  parDossier.get(cle)!.add(txt(c.numero));
}
for (const c of comptes) {
  const avant = txt(c.numero);
  const apres = normaliserNumeroCompte(avant);
  if (!avant || apres === avant) continue;
  if (parDossier.get(txt(c.dossier_id))?.has(apres)) {
    bloques.push(`comptes_comptables · dossier ${txt(c.dossier_id).slice(0, 8)} · « ${avant} » → « ${apres} » existe déjà`);
    continue;
  }
  modifications.push({ table: "comptes_comptables", colonne: "numero", id: c.id, avant, apres });
}

// ─── Rapport ────────────────────────────────────────────────────────────────
const parTable = new Map<string, Modif[]>();
for (const m of modifications) {
  if (!parTable.has(m.table)) parTable.set(m.table, []);
  parTable.get(m.table)!.push(m);
}

if (!modifications.length && !bloques.length) {
  console.log("✅ Tous les numéros de comptes sont déjà à la forme canonique. Rien à faire.\n");
  process.exit(0);
}

for (const [table, lignes] of parTable) {
  console.log(`  ${table} — ${lignes.length} ligne(s) à normaliser`);
  const paires = new Map<string, number>();
  for (const m of lignes) paires.set(`${m.avant} → ${m.apres}`, (paires.get(`${m.avant} → ${m.apres}`) ?? 0) + 1);
  for (const [paire, n] of [...paires.entries()].sort()) {
    console.log(`     ${pad(paire, 26)} ${String(n).padStart(5)} ligne(s)`);
  }
  console.log("");
}

if (bloques.length) {
  console.log(`  ⚠️  ${bloques.length} cas NON normalisé(s) — collision d'unicité, à fusionner à la main :`);
  for (const b of bloques) console.log(`     • ${b}`);
  console.log("     (les deux comptes coexistent ; leurs soldes initiaux ne s'additionnent pas sans arbitrage)\n");
}

if (!APPLY) {
  console.log(`🔍 Dry-run — rien n'a été écrit. Ajoutez --apply pour normaliser.\n`);
  process.exit(0);
}

// ─── Sauvegarde AVANT écriture ──────────────────────────────────────────────
const horodatage = new Date().toISOString().replace(/[:.]/g, "-");
const chemin = `backup_normalisation_comptes_${horodatage}.json`;
fs.writeFileSync(path.join(ROOT, chemin), JSON.stringify({
  date: new Date().toISOString(), dossiers: dossierIds, modifications, bloques,
}, null, 2), "utf8");
console.log(`💾 Sauvegarde : ${chemin}\n`);

// ─── Application ────────────────────────────────────────────────────────────
let ok = 0, ko = 0;
for (const m of modifications) {
  const { error } = await (sb.from(m.table) as any)
    .update({ [m.colonne]: m.apres }).eq("id", m.id);
  if (error) { ko++; console.error(`   ❌ ${m.table} ${m.id} : ${error.message}`); }
  else ok++;
}

console.log(`✅ ${ok} ligne(s) normalisée(s)${ko ? `, ${ko} en échec` : ""}.`);
console.log(`\nRollback : node --import tsx scripts/normaliser-numeros-comptes.ts --rollback=${chemin}\n`);
process.exit(ko ? 1 : 0);
