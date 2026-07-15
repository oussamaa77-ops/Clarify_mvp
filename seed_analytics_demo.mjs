// seed_analytics_demo.mjs — remplit analytics_usage avec des données de DÉMO
// réalistes (~14 jours) pour visualiser l'écran « Usage IA ».
// Toutes les lignes sont taguées libelle commençant par "DEMO ·" → nettoyables.
//
//   node seed_analytics_demo.mjs           → insère les données de démo
//   node seed_analytics_demo.mjs --clean   → supprime uniquement les lignes DEMO

import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  fs.readFileSync(new URL(".env", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const DOSSIER_ID = "b64505dd-94ec-4d3a-9ab2-aa5637aec98b"; // DIGITAL SOLUTIONS
const COUT = { facture: 0.012, banque: 0.004 };
const TAG = "DEMO ·";

const TIERS_BANQUE = ["GLOVO FOOD", "IAM TELECOM", "ONEE ELEC", "SALAIRE PAIE", "AMENDIS EAU", "SHELL STATION", "CNSS", "LOYER IMMEUBLE"];
const TIERS_FACT = ["TESDRA MENVEST", "SARL ATLAS DISTRIB", "STE MAROC PLAST", "GROUPE BENNANI"];
const rnd = (n) => Math.floor(Math.random() * n);

async function clean() {
  const { error, count } = await sb.from("analytics_usage").delete({ count: "exact" }).like("libelle", `${TAG}%`);
  if (error) { console.error("ERR clean:", error.message); process.exit(2); }
  console.log(`🧹 ${count} ligne(s) DEMO supprimée(s).`);
}

async function seed() {
  await clean(); // repart propre
  const rows = [];
  const JOURS = 14;
  for (let d = JOURS - 1; d >= 0; d--) {
    const date = new Date(); date.setDate(date.getDate() - d); date.setHours(9 + rnd(8), rnd(60), 0, 0);
    // Le taux de skip croît avec le temps (mémoire qui apprend) : ~8% → ~72%.
    const progress = (JOURS - 1 - d) / (JOURS - 1);
    const skipRate = 0.08 + progress * 0.64;
    const nbBanque = 6 + rnd(14);   // transactions de relevé
    const nbFacture = 1 + rnd(4);   // factures scannées

    for (let i = 0; i < nbBanque; i++) {
      const skip = Math.random() < skipRate;
      rows.push({
        dossier_id: DOSSIER_ID, sens: "banque",
        method: skip ? "memoire" : "llm", skip_llm: skip,
        cout_estime: COUT.banque,
        libelle: `${TAG} ${TIERS_BANQUE[rnd(TIERS_BANQUE.length)]}`,
        created_at: new Date(date.getTime() + i * 60000).toISOString(),
      });
    }
    for (let i = 0; i < nbFacture; i++) {
      const skip = Math.random() < skipRate * 0.7; // les factures skippent un peu moins
      rows.push({
        dossier_id: DOSSIER_ID, sens: "facture",
        method: skip ? "memoire" : "llm", skip_llm: skip,
        cout_estime: COUT.facture,
        libelle: `${TAG} ${TIERS_FACT[rnd(TIERS_FACT.length)]}`,
        created_at: new Date(date.getTime() + (nbBanque + i) * 60000).toISOString(),
      });
    }
  }
  // Insert par lots de 500.
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from("analytics_usage").insert(rows.slice(i, i + 500));
    if (error) { console.error("ERR insert:", error.message); process.exit(2); }
  }
  const skipped = rows.filter((r) => r.skip_llm).length;
  const eco = rows.filter((r) => r.skip_llm).reduce((s, r) => s + r.cout_estime, 0);
  console.log(`✅ ${rows.length} lignes DEMO insérées sur ${JOURS} jours (${skipped} skip, ~$${eco.toFixed(4)} économisés).`);
  console.log(`   → Ouvre l'onglet « Usage IA » du dossier DIGITAL SOLUTIONS pour voir l'écran peuplé.`);
  console.log(`   Nettoyage : node seed_analytics_demo.mjs --clean`);
}

(async () => {
  if (process.argv.includes("--clean")) { await clean(); process.exit(0); }
  await seed();
  process.exit(0);
})().catch((e) => { console.error("💥", e); process.exit(2); });
