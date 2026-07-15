// verify_memoire.mjs — vérif bout-en-bout de la « mémoire des tiers ».
// Miroir de src/server/tiers-memoire.functions.ts (memoriserTiers / rappelerMemoire)
// + de la condition skipLLM de src/server/factures.functions.ts.
//
//   Tests : (1) insert  (2) lecture ICE + libellé  (3) update occurrences++  (4) skipLLM réel
//
// Lancement :  node verify_memoire.mjs
// Utilise la SERVICE_ROLE_KEY (bypass RLS) ; nettoie sa ligne de test à la fin.

import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

// ── .env (parse minimal) ─────────────────────────────────────────────────────
const env = Object.fromEntries(
  fs.readFileSync(new URL(".env", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);

const SB_URL = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL;
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_PUBLISHABLE_KEY;
const sb = createClient(SB_URL, SB_KEY);

// Dossier réel DIGITAL SOLUTIONS (ICE 009876543000012).
const DOSSIER_ID = "b64505dd-94ec-4d3a-9ab2-aa5637aec98b";
const SENS = "fournisseur";
const TEST_ICE = "TEST-ICE-987654321";
const TEST_NOM = `Fournisseur Test Mémoire ${Date.now()}`;

// ── Helpers miroir du serveur ────────────────────────────────────────────────
const normalizeLibelle = (s) =>
  (!s ? "" : s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toUpperCase()
    .replace(/[^0-9A-Z\s]+/g, " ").replace(/\s+/g, " ").trim());
const normIce = (ice) => (ice ?? "").replace(/\s+/g, "").trim();

// memoriserTiers (upsert occurrences++)
async function memoriserTiers({ ice, nom, compte_pcm, categorie_pcm, taux_tva }) {
  const cle = normalizeLibelle(nom);
  const iceNorm = normIce(ice) || null;
  const { data: existing } = await sb.from("tiers_memoire")
    .select("id,occurrences").eq("dossier_id", DOSSIER_ID).eq("sens", SENS)
    .eq("cle_libelle", cle).limit(1).maybeSingle();
  if (existing) {
    const occ = Number(existing.occurrences ?? 1) + 1;
    const patch = { occurrences: occ, derniere_validation: new Date().toISOString() };
    if (iceNorm) patch.cle_ice = iceNorm;
    if (compte_pcm) patch.compte_pcm = compte_pcm;
    if (categorie_pcm) patch.categorie_pcm = categorie_pcm;
    if (taux_tva != null) patch.taux_tva = taux_tva;
    await sb.from("tiers_memoire").update(patch).eq("id", existing.id);
    return { ok: true, occurrences: occ, created: false, id: existing.id };
  }
  const { data: ins, error } = await sb.from("tiers_memoire").insert({
    dossier_id: DOSSIER_ID, sens: SENS, cle_ice: iceNorm, cle_libelle: cle,
    compte_pcm: compte_pcm ?? null, categorie_pcm: categorie_pcm ?? null,
    taux_tva: taux_tva ?? null, occurrences: 1,
  }).select("id").single();
  if (error) return { ok: false, reason: error.message };
  return { ok: true, occurrences: 1, created: true, id: ins.id };
}

// rappelerMemoire (lecture ICE forte puis libellé)
async function rappelerMemoire({ ice, nom }) {
  const iceNorm = normIce(ice);
  const cle = normalizeLibelle(nom);
  const toHit = (r, par_ice) => ({
    id: r.id, compte_pcm: r.compte_pcm ?? null, categorie_pcm: r.categorie_pcm ?? null,
    taux_tva: r.taux_tva != null ? Number(r.taux_tva) : null,
    occurrences: Number(r.occurrences ?? 1), par_ice,
  });
  if (iceNorm) {
    const { data } = await sb.from("tiers_memoire").select("*")
      .eq("dossier_id", DOSSIER_ID).eq("sens", SENS).eq("cle_ice", iceNorm)
      .limit(1).maybeSingle();
    if (data) return toHit(data, true);
  }
  if (cle) {
    const { data } = await sb.from("tiers_memoire").select("*")
      .eq("dossier_id", DOSSIER_ID).eq("sens", SENS).eq("cle_libelle", cle)
      .limit(1).maybeSingle();
    if (data) return toHit(data, false);
  }
  return null;
}

// ── Harness ──────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const check = (label, cond, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  cond ? pass++ : fail++;
};

async function cleanup() {
  await sb.from("tiers_memoire").delete()
    .eq("dossier_id", DOSSIER_ID).eq("sens", SENS)
    .eq("cle_libelle", normalizeLibelle(TEST_NOM));
}

(async () => {
  console.log(`\n🧪 verify_memoire — dossier ${DOSSIER_ID}`);
  console.log(`   nom="${TEST_NOM}"  ice="${TEST_ICE}"\n`);
  await cleanup(); // au cas où un run précédent aurait laissé une trace

  // (1) INSERT
  console.log("① INSERT");
  const w1 = await memoriserTiers({
    ice: TEST_ICE, nom: TEST_NOM, compte_pcm: "6110000000",
    categorie_pcm: "Achats", taux_tva: 20,
  });
  check("écriture ok", w1.ok, w1.reason ?? "");
  check("créé (created=true)", w1.created === true);
  check("occurrences=1", w1.occurrences === 1, `occ=${w1.occurrences}`);

  // (2) LECTURE
  console.log("② LECTURE");
  const byIce = await rappelerMemoire({ ice: TEST_ICE, nom: null });
  check("rappel par ICE trouvé", !!byIce);
  check("par_ice=true (clé forte)", byIce?.par_ice === true);
  check("classif restituée (compte 6110000000)", byIce?.compte_pcm === "6110000000", byIce?.compte_pcm);
  check("taux_tva=20", byIce?.taux_tva === 20, String(byIce?.taux_tva));

  const byLib = await rappelerMemoire({ ice: null, nom: TEST_NOM });
  check("rappel par libellé trouvé", !!byLib);
  check("par_ice=false (clé principale)", byLib?.par_ice === false);

  const miss = await rappelerMemoire({ ice: null, nom: "Inconnu Absolu XYZ" });
  check("libellé inconnu → null", miss === null);

  // (3) UPDATE (occurrences++)
  console.log("③ UPDATE (2e validation)");
  const w2 = await memoriserTiers({ ice: TEST_ICE, nom: TEST_NOM });
  check("mise à jour (created=false)", w2.created === false);
  check("occurrences=2", w2.occurrences === 2, `occ=${w2.occurrences}`);
  const after = await rappelerMemoire({ ice: TEST_ICE, nom: null });
  check("occurrences=2 relu en base", after?.occurrences === 2, `occ=${after?.occurrences}`);

  // (4) skipLLM RÉEL — reproduit la condition de factures.functions.ts:704
  console.log("④ skipLLM réel (condition ocrFacture)");
  const memoire = await rappelerMemoire({ ice: TEST_ICE, nom: TEST_NOM });
  const montant_ttc = 1200; // total lisible par la regex
  const skipLLM = !!(memoire?.par_ice && montant_ttc > 0);
  check("skipLLM=true quand ICE connu + TTC>0", skipLLM === true);
  const method = skipLLM ? "memoire" : "ai";
  check("method='memoire' (LLM court-circuité)", method === "memoire");
  // contre-exemple : rappel par libellé seul (par_ice=false) NE court-circuite PAS
  const faible = await rappelerMemoire({ ice: null, nom: TEST_NOM });
  const skipFaible = !!(faible?.par_ice && montant_ttc > 0);
  check("skipLLM=false si rappel faible (libellé seul)", skipFaible === false);

  // ── Nettoyage ──────────────────────────────────────────────────────────────
  await cleanup();
  const gone = await rappelerMemoire({ ice: TEST_ICE, nom: TEST_NOM });
  check("ligne de test supprimée (cleanup)", gone === null);

  console.log(`\n${fail === 0 ? "🎉 TOUT PASSE" : "⚠️  ÉCHECS"} — ${pass} ok / ${fail} ko\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("💥", e); process.exit(2); });
