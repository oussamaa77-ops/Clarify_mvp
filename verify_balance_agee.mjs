// verify_balance_agee.mjs — à lancer APRÈS avoir appliqué les migrations
//   20260710130000_paiements_source_of_truth
//   20260710131000_lier_transaction_via_paiements
//   20260710132000_consolidation_type_facture
//   20260710133000_balance_agee
// Contrôle, en LECTURE SEULE (service_role) :
//   1. paiements existe et montant_restant == montant_ttc − SUM(paiements) partout ;
//   2. type_facture a bien disparu, type porte acompte/solde ;
//   3. la vue v_balance_agee est cohérente (tranches == total, rien de négatif).
// Sort 0 si tout est vert, 3 si une migration manque, 1 si une incohérence subsiste.
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
const env = Object.fromEntries(
  fs.readFileSync(new URL(".env", import.meta.url), "utf8")
    .split(/\r?\n/).filter(l => l && !l.startsWith("#") && l.includes("="))
    .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);
let D = false;
async function pf(i, x) {
  if (D) { const { fetch: uf, Agent } = await import("undici"); return uf(String(i), { ...x, dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) }); }
  try { return await fetch(String(i), x); } catch { D = true; const { fetch: uf, Agent } = await import("undici"); return uf(String(i), { ...x, dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) }); }
}
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false }, global: { fetch: pf } });
const n = v => Number(v ?? 0);
let echecs = 0;
const ok = (c, m) => console.log(`  [${c ? "OK" : "!!"}] ${m}`) || (c ? 0 : echecs++);

// 1. Table paiements présente ?
const pais = await sb.from("paiements").select("id", { head: false }).limit(1);
if (pais.error) { console.log(`  migration paiements non appliquée (${pais.error.code}). STOP.`); process.exit(3); }
console.log("=== 1. Colonnes dérivées == ttc − SUM(paiements) ===");
for (const [t, fk] of [["factures", "facture_id"], ["factures_fournisseurs", "facture_fournisseur_id"]]) {
  const { data: fac } = await sb.from(t).select("id,montant_ttc,montant_paye,montant_restant");
  const { data: pay } = await sb.from("paiements").select(`${fk},montant`).not(fk, "is", null);
  const somme = new Map();
  for (const p of pay ?? []) somme.set(p[fk], (somme.get(p[fk]) ?? 0) + n(p.montant));
  let faux = 0;
  for (const f of fac ?? []) {
    const attenduPaye = somme.get(f.id) ?? 0;
    const attenduRestant = Math.max(0, n(f.montant_ttc) - attenduPaye);
    if (Math.abs(attenduPaye - n(f.montant_paye)) > 0.02 || Math.abs(attenduRestant - n(f.montant_restant)) > 0.02) faux++;
  }
  ok(faux === 0, `${t} : ${faux} ligne(s) incohérente(s)`);
}

// 2. Consolidation du type
console.log("=== 2. Consolidation type_facture ===");
const tf = await sb.from("factures").select("type_facture").limit(1);
ok(!!tf.error, `colonne type_facture supprimée (${tf.error ? tf.error.code : "ENCORE PRÉSENTE"})`);
const { data: types } = await sb.from("factures").select("type");
const vus = [...new Set((types ?? []).map(r => r.type))];
ok(vus.every(v => ["facture", "avoir", "proforma", "acompte", "solde"].includes(v)), `valeurs de type : ${vus.join(", ")}`);

// 3. Vue balance âgée
console.log("=== 3. Vue v_balance_agee ===");
const bal = await sb.from("v_balance_agee").select("*");
if (bal.error) { console.log(`  vue absente (${bal.error.code}). STOP.`); process.exit(3); }
let incoh = 0, neg = 0;
for (const r of bal.data ?? []) {
  const somme = n(r.non_echu) + n(r.retard_1_30) + n(r.retard_31_60) + n(r.retard_60_plus);
  if (Math.abs(somme - n(r.total_du)) > 0.02) incoh++;
  if ([r.total_du, r.non_echu, r.retard_1_30, r.retard_31_60, r.retard_60_plus].some(v => n(v) < -0.01)) neg++;
}
ok(incoh === 0, `${bal.data.length} ligne(s), invariant tranches==total : ${incoh} écart(s)`);
ok(neg === 0, `aucun montant négatif : ${neg} anomalie(s)`);
const totC = (bal.data ?? []).filter(r => r.sens === "client").reduce((s, r) => s + n(r.total_du), 0);
const totF = (bal.data ?? []).filter(r => r.sens === "fournisseur").reduce((s, r) => s + n(r.total_du), 0);
console.log(`  créances clients = ${totC.toFixed(2)} MAD · dettes fournisseurs = ${totF.toFixed(2)} MAD`);

console.log(echecs === 0 ? "\n✅ Base saine." : `\n❌ ${echecs} contrôle(s) en échec.`);
process.exit(echecs === 0 ? 0 : 1);
