// verify_quotas.mjs — à lancer APRÈS avoir appliqué la migration
//   20260713120000_saas_plans_quotas
//
// Contrôle, en service_role :
//   1. les 3 plans existent aux bons tarifs / quotas ;
//   2. chaque cabinet a un abonnement vivant (trigger + backfill) ;
//   3. consume_scan_quota décompte, est IDEMPOTENT et REFUSE au-delà de la limite ;
//   4. get_quota_status reflète la consommation.
//
// Le test 3 écrit dans usage_records sur un dossier réel, puis NETTOIE derrière
// lui (clés d'idempotence préfixées `verify:`), et restaure le plan d'origine.
// Sort 0 si tout est vert, 3 si la migration manque, 1 si une incohérence subsiste.
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

const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }, global: { fetch: pf },
});

let echecs = 0;
const ok = (c, m) => { console.log(`  [${c ? "OK" : "!!"}] ${m}`); if (!c) echecs++; };

// ── 1. PLANS ────────────────────────────────────────────────────────────────
console.log("\n1. Catalogue des plans");
const { data: plans, error: ePlans } = await sb
  .from("plans").select("code,name,price_monthly,scans_limit").order("sort_order");
if (ePlans) { console.log(`  migration non appliquée (${ePlans.code} ${ePlans.message}). STOP.`); process.exit(3); }

const attendus = { starter: [399, 100], pro: [799, 400], cabinet: [1999, 800] };
for (const [code, [prix, limite]] of Object.entries(attendus)) {
  const p = plans.find(x => x.code === code);
  ok(!!p, `plan « ${code} » présent`);
  if (p) {
    ok(Number(p.price_monthly) === prix, `${code} : ${p.price_monthly} MAD (attendu ${prix})`);
    ok(p.scans_limit === limite, `${code} : ${p.scans_limit} scans (attendu ${limite})`);
  }
}

// ── 2. ABONNEMENTS ──────────────────────────────────────────────────────────
console.log("\n2. Abonnements des cabinets");
const { data: cabinets } = await sb.from("cabinets").select("id,nom");
const { data: subs, error: eSubs } = await sb
  .from("subscriptions").select("id,cabinet_id,plan_id,status,current_period_start,current_period_end");
if (eSubs) { console.log(`  table subscriptions absente (${eSubs.code}). STOP.`); process.exit(3); }

const vivants = (subs ?? []).filter(s => ["trial", "active", "past_due"].includes(s.status));
ok((cabinets ?? []).length > 0, `${(cabinets ?? []).length} cabinet(s) en base`);
for (const c of cabinets ?? []) {
  const n = vivants.filter(s => s.cabinet_id === c.id).length;
  ok(n === 1, `cabinet « ${c.nom} » → ${n} abonnement vivant (attendu 1)`);
}

// ── 3. consume_scan_quota ───────────────────────────────────────────────────
console.log("\n3. Décompte, idempotence et refus au-delà de la limite");
const { data: dossier } = await sb.from("dossiers").select("id,nom_societe,cabinet_id").limit(1).maybeSingle();

if (!dossier) {
  console.log("  (aucun dossier en base — test de consommation ignoré)");
} else {
  const marqueur = `verify:${Date.now()}`;
  const sub = vivants.find(s => s.cabinet_id === dossier.cabinet_id);
  const planOrigine = sub?.plan_id;

  // Plan jetable à 2 scans : on éprouve la limite sans dépendre du plan réel
  // ni consommer 100 scans.
  const { data: planTest, error: ePT } = await sb.from("plans")
    .upsert({ code: "verify_tmp", name: "Verify", price_monthly: 0, scans_limit: 2, is_active: false, sort_order: 99 },
            { onConflict: "code" })
    .select("id").single();
  if (ePT) { console.log(`  !! plan de test non créé : ${ePT.message}`); echecs++; }

  if (planTest) {
    await sb.from("subscriptions").update({ plan_id: planTest.id, status: "active", trial_ends_at: null }).eq("id", sub.id);

    const conso = async (cle) => {
      const { data, error } = await sb.rpc("consume_scan_quota", {
        _dossier_id: dossier.id, _kind: "facture", _idempotency_key: `${marqueur}:${cle}`, _quantity: 1,
      });
      if (error) { console.log(`  !! RPC en échec : ${error.message}`); echecs++; return {}; }
      return data;
    };

    const base = (await sb.from("usage_records").select("quantity")
      .eq("cabinet_id", dossier.cabinet_id).eq("period_start", sub.current_period_start))
      .data?.reduce((s, r) => s + r.quantity, 0) ?? 0;

    if (base > 0) {
      console.log(`  (le cabinet a déjà ${base} scan(s) sur la période — le test de refus vise la limite absolue)`);
    }

    const a = await conso("a");
    ok(a.allowed === true, `1er scan accepté (used=${a.used}/${a.limit})`);

    const rejeu = await conso("a");
    ok(rejeu.allowed === true && rejeu.replay === true && rejeu.used === a.used,
       `même clé rejouée → non recomptée (used reste ${rejeu.used})`);

    const b = await conso("b");
    const c = await conso("c");
    const refus = [a, b, c].find(r => r.allowed === false) ?? (await conso("d"));
    ok(refus.allowed === false && refus.reason === "quota_depasse",
       `refus au-delà de 2 scans (raison « ${refus.reason} »)`);
    ok(refus.remaining === 0, `restants = 0 au refus`);

    // ── État lu sans consommer ────────────────────────────────────────────
    const { data: statut, error: eSt } = await sb.rpc("get_quota_status", { _cabinet_id: dossier.cabinet_id });
    if (eSt) { console.log(`  !! get_quota_status en échec : ${eSt.message}`); echecs++; }
    else {
      ok(statut.has_subscription === true, "get_quota_status : abonnement trouvé");
      ok(statut.limit === 2, `get_quota_status : limite ${statut.limit} (attendu 2)`);
      ok(statut.used >= 2, `get_quota_status : ${statut.used} scans consommés`);
    }

    // ── Nettoyage ─────────────────────────────────────────────────────────
    await sb.from("usage_records").delete().like("idempotency_key", `${marqueur}%`);
    if (planOrigine) {
      await sb.from("subscriptions").update({ plan_id: planOrigine, status: sub.status }).eq("id", sub.id);
    }
    await sb.from("plans").delete().eq("code", "verify_tmp");
    console.log("  (nettoyage : scans de test supprimés, plan d'origine restauré)");
  }
}

console.log(echecs === 0 ? "\n✅ Quotas opérationnels.\n" : `\n❌ ${echecs} contrôle(s) en échec.\n`);
process.exit(echecs === 0 ? 0 : 1);
