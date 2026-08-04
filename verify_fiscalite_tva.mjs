// verify_fiscalite_tva.mjs — LECTURE SEULE. Rejoue l'onglet TVA (régime de
// l'encaissement) sur le dossier qui porte le plus de factures, et compare le
// nouveau calcul (factures + paiements) à l'ancien (écritures 44551 / 34552).
//
// Lancement :  node --import tsx verify_fiscalite_tva.mjs

import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { synthetiserTva, periodesTva, bornesDuMois, tvaRecuperableEnCours } from "./src/lib/dashboard-fiscal.ts";
import { statutTva } from "./src/lib/fiscalite-ma.ts";

const env = Object.fromEntries(
  fs.readFileSync(new URL(".env", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);
let PROXY_DIRECT = false;
async function proxyFetch(input, init) {
  const direct = async () => {
    const { fetch: uf, Agent } = await import("undici");
    return uf(String(input), { ...init, dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) });
  };
  if (PROXY_DIRECT) return direct();
  try { return await fetch(String(input), init); }
  catch { PROXY_DIRECT = true; return direct(); }
}
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { global: { fetch: proxyFetch } });
const fmt = (n) => Number(n).toFixed(2).padStart(12);

(async () => {
  // Dossier le plus fourni en factures.
  const { data: toutes } = await sb.from("factures").select("dossier_id").limit(5000);
  const compte = new Map();
  for (const f of toutes ?? []) compte.set(f.dossier_id, (compte.get(f.dossier_id) ?? 0) + 1);
  const [dossierId, nb] = [...compte.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (!dossierId) { console.log("⛔ Aucune facture en base."); process.exit(4); }
  const { data: dos } = await sb.from("dossiers").select("nom_societe").eq("id", dossierId).single();
  console.log(`Dossier : « ${dos?.nom_societe} » — ${nb} facture(s) de vente\n`);

  const [v, a, pay, ecr] = await Promise.all([
    sb.from("factures").select("id,statut,statut_paiement,montant_ht,montant_tva,montant_ttc,montant_paye,montant_restant,type,date_facture,date_echeance").eq("dossier_id", dossierId),
    sb.from("factures_fournisseurs").select("id,statut_paiement,montant_ht,montant_tva,montant_ttc,montant_paye,montant_restant,date_facture,date_echeance").eq("dossier_id", dossierId),
    sb.from("paiements").select("facture_id,facture_fournisseur_id,montant,date_paiement").eq("dossier_id", dossierId),
    sb.from("ecritures_comptables").select("compte_numero,debit,credit,date_ecriture").eq("dossier_id", dossierId),
  ]);
  const ventes = (v.data ?? []).filter((f) => f.statut !== "rejetee");
  const achats = a.data ?? [];
  const paiements = pay.data ?? [];
  console.log(`ventes ${ventes.length} · achats ${achats.length} · règlements datés ${paiements.length} · écritures ${(ecr.data ?? []).length}`);

  const total = synthetiserTva(ventes, achats, { paiements });
  console.log(`\nTOTAL (toutes périodes) — régime de l'encaissement :`);
  console.log(`  TVA collectée sur encaissements  ${fmt(total.collectee)}`);
  console.log(`  TVA déductible sur décaissements ${fmt(total.deductible)}`);
  console.log(`  TVA nette                        ${fmt(total.nette)}  → « ${statutTva(total.nette).label} »`);
  console.log(`  TVA récupérable en cours         ${fmt(tvaRecuperableEnCours(achats))}  (achats non réglés)`);
  console.log(`  couverture par règlements datés  ${Math.round(total.couverture * 100)} %`);

  // Ancien calcul (écritures TVA) pour mesurer l'écart.
  const solde = (num, sens) => (ecr.data ?? []).filter((e) => e.compte_numero === num)
    .reduce((s, e) => s + (sens === "credit" ? Number(e.credit) - Number(e.debit) : Number(e.debit) - Number(e.credit)), 0);
  console.log(`\nANCIEN calcul (comptes du grand livre, fait générateur comptable) :`);
  console.log(`  44551 TVA collectée   ${fmt(solde("44551", "credit"))}`);
  console.log(`  34552 TVA récupérable ${fmt(solde("34552", "debit"))}`);
  console.log(`  → l'écart est ATTENDU : le grand livre comptabilise à la facturation,`);
  console.log(`    l'onglet n'exige la TVA qu'à l'encaissement.`);

  // Ventilation mensuelle + contrôle qu'aucune TVA ne se perd.
  const mois = periodesTva(ventes, achats, paiements);
  console.log(`\nVentilation par mois d'exigibilité (${mois.length} mois) :`);
  let sc = 0, sd = 0;
  for (const m of mois) {
    const b = bornesDuMois(m);
    const s = synthetiserTva(ventes, achats, { ...b, paiements });
    sc += s.collectee; sd += s.deductible;
    console.log(`  ${m}  collectée ${fmt(s.collectee)}  déductible ${fmt(s.deductible)}  nette ${fmt(s.nette)}  ${statutTva(s.nette).label}`);
  }
  const ok = Math.abs(sc - total.collectee) < 0.05 && Math.abs(sd - total.deductible) < 0.05;
  console.log(`\n${ok ? "✅" : "❌"} Σ des mois = total (collectée ${sc.toFixed(2)}/${total.collectee.toFixed(2)}, déductible ${sd.toFixed(2)}/${total.deductible.toFixed(2)})`);
  process.exit(ok ? 0 : 1);
})();
