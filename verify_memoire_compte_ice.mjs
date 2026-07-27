// verify_memoire_compte_ice.mjs — preuve BOUT EN BOUT, sur la VRAIE base, que le
// compte auxiliaire saisi sur une facture est mémorisé par ICE puis rappelé au scan
// suivant. Le test vitest utilise un faux Supabase ; celui-ci valide le vrai
// PostgREST (colonnes, contraintes, normalisation des clés).
//
//   node --import tsx verify_memoire_compte_ice.mjs      (SERVICE_ROLE, nettoie sa trace)

import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { rappelerMemoire, normalizeLibelle } from "./src/server/tiers-memoire.functions.ts";
import { suggestAccount, COMPTE_CHARGE_DEFAUT } from "./src/lib/categorization-engine.ts";

const env = Object.fromEntries(
  fs.readFileSync(new URL(".env", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);
let DIRECT = false;
async function pf(u, i) {
  const d = async () => { const { fetch: uf, Agent } = await import("undici"); return uf(String(u), { ...i, dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) }); };
  if (DIRECT) return d(); try { return await fetch(String(u), i); } catch { DIRECT = true; return d(); }
}
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { global: { fetch: pf } });

const DOSSIER = "b64505dd-94ec-4d3a-9ab2-aa5637aec98b";   // DIGITAL SOLUTIONS
const ICE = "002345678000012";
const COMPTE_AUX = "44110005";
const NOM = "SOCIETE ALPHA SARL (TEST MEMOIRE)";

let pass = 0, fail = 0;
const check = (l, c, d = "") => { console.log(`  ${c ? "✅" : "❌"} ${l}${d ? ` — ${d}` : ""}`); c ? pass++ : fail++; };
const cleanup = async () => {
  await sb.from("tiers_memoire").delete().eq("dossier_id", DOSSIER).eq("sens", "fournisseur").eq("cle_libelle", normalizeLibelle(NOM));
};

(async () => {
  console.log(`\n🧪 verify_memoire_compte_ice — ICE ${ICE} → compte ${COMPTE_AUX}\n`);
  const probe = await sb.from("tiers_memoire").select("cle_ice,compte_pcm").limit(1);
  if (probe.error) { console.error(`❌ tiers_memoire illisible : ${probe.error.message}`); process.exit(3); }
  await cleanup();

  console.log("① Avant toute validation, le scan ne connaît pas ce tiers :");
  const avant = await rappelerMemoire(sb, { dossier_id: DOSSIER, sens: "fournisseur", ice: ICE, nom: NOM });
  check("aucun rappel", avant === null);
  const sugAvant = suggestAccount({ sens: "charge", compteMemoireTiers: avant?.compte_pcm ?? null, nomTiers: NOM });
  check(`compte proposé = générique ${COMPTE_CHARGE_DEFAUT}`, sugAvant.compte === COMPTE_CHARGE_DEFAUT, sugAvant.compte);

  console.log("\n② Validation d'une facture : {ICE → 44110005} écrit en base");
  const ins = await sb.from("tiers_memoire").insert({
    dossier_id: DOSSIER, sens: "fournisseur", cle_ice: ICE, cle_libelle: normalizeLibelle(NOM),
    pattern: normalizeLibelle(NOM), compte_pcm: COMPTE_AUX, taux_tva: 20, occurrences: 1, type_tiers: "fournisseur",
  });
  check("insertion acceptée par PostgREST", !ins.error, ins.error?.message ?? "ok");

  console.log("\n③ 2e scan, MÊME ICE (libellé OCR différent, ICE espacé) :");
  const hit = await rappelerMemoire(sb, { dossier_id: DOSSIER, sens: "fournisseur", ice: "0023 4567 8000 012", nom: "Sté ALPHA S.A.R.L." });
  check("rappel trouvé", !!hit);
  check("clé forte = ICE", hit?.match_kind === "ice" && hit?.par_ice === true, hit?.match_kind);
  check(`compte_pcm = ${COMPTE_AUX}`, hit?.compte_pcm === COMPTE_AUX, String(hit?.compte_pcm));

  console.log("\n④ Le moteur applique ce compte (Règle 1b) :");
  const sug = suggestAccount({ sens: "charge", compteMemoireTiers: hit?.compte_pcm ?? null, description: "Fournitures", nomTiers: "Sté ALPHA S.A.R.L." });
  check(`compte final = ${COMPTE_AUX}`, sug.compte === COMPTE_AUX, sug.compte);
  check("source = memoire_tiers", sug.source === "memoire_tiers", sug.source);
  check("PAS le générique 4411/6141", sug.compte !== "4411" && sug.compte !== COMPTE_CHARGE_DEFAUT);

  await cleanup();
  check("trace de test nettoyée", (await rappelerMemoire(sb, { dossier_id: DOSSIER, sens: "fournisseur", ice: ICE, nom: NOM })) === null);

  console.log(`\n${fail === 0 ? "🎉 TOUT PASSE" : "⚠️  ÉCHECS"} — ${pass} ok / ${fail} ko\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("💥", e); process.exit(2); });
