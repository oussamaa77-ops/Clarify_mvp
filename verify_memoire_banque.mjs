// verify_memoire_banque.mjs — vérif de la « mémoire banque » + lettrage auto.
// Miroir de src/server/tiers-memoire.functions.ts (branche sens='banque') et de
// la logique de skipLLM + pré-lettrage de analyserReleveIA (factures.functions.ts).
//
// Scénario : 2 transactions bancaires IDENTIQUES (même tiers, dates différentes).
//   • Transaction #1 → mémoire vide → APPEL IA (llm++) → validation → occ=1
//   • Transaction #2 → mémoire (occ=1 ⇒ 2e occurrence) → LLM SKIPPED,
//     auto-application compte/catégorie/type_tiers + MATCH LETTRAGE (facture).
//   • Variante « VIREMENT GLOVO FOOD SARL » → rappel par SIMILARITÉ (≥0.7).
//
// Lancement :  node verify_memoire_banque.mjs      (SERVICE_ROLE_KEY, nettoie sa trace)

import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

// ── .env ─────────────────────────────────────────────────────────────────────
const env = Object.fromEntries(
  fs.readFileSync(new URL(".env", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const DOSSIER_ID = "b64505dd-94ec-4d3a-9ab2-aa5637aec98b"; // DIGITAL SOLUTIONS
const SENS = "banque";

// ── Helpers MIROIR de tiers-memoire.functions.ts ─────────────────────────────
const BANK_NOISE = [
  /\bVIR(EMENT)?\b/g, /\bVIRT\b/g, /\bSEPA\b/g, /\bPRLV\b/g, /\bPRELEVEMENT(S)?\b/g,
  /\bCB\b/g, /\bCARTE\b/g, /\bTPE\b/g, /\bPAIEMENT\b/g, /\bPAIMT\b/g, /\bPMT\b/g,
  /\bREGLEMENT\b/g, /\bRECU\b/g, /\bEMIS\b/g, /\bVERS\b/g, /\bCHEQUE\b/g, /\bCHQ\b/g,
  /\bREMISE\b/g, /\bRETRAIT\b/g, /\bGAB\b/g, /\bDAB\b/g, /\bESPECES?\b/g, /\bAVIS\b/g,
  /\bREF\b/g, /\bMANDAT\b/g, /\bECH\b/g, /\bFACT(URE)?\b/g, /\bNO\b/g,
];
const normalizeBankLabel = (s) => {
  if (!s) return "";
  let x = s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^0-9A-Z\s]+/g, " ");
  x = x.replace(/\b\d{1,2}[\s\/\-]\d{1,2}[\s\/\-]\d{2,4}\b/g, " ");
  for (const re of BANK_NOISE) x = x.replace(re, " ");
  x = x.replace(/\b\d{2,}\b/g, " ");
  return x.replace(/\s+/g, " ").trim();
};
const patternHash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = (((h << 5) + h) + s.charCodeAt(i)) >>> 0; return h.toString(16); };
const bankSimilarity = (a, b) => {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;
  const ta = new Set(a.split(/\s+/).filter((t) => t.length >= 3));
  const tb = new Set(b.split(/\s+/).filter((t) => t.length >= 3));
  if (!ta.size || !tb.size) return 0;
  let c = 0; for (const t of ta) if (tb.has(t)) c++;
  return c / Math.max(ta.size, tb.size);
};
const confianceFromOccurrences = (occ) => Math.min(1, Math.max(0, occ) / 3);
const BANK_SIM_THRESHOLD = 0.7;

// rappelerMemoire (branche banque : hash exact puis similarité)
async function rappelerMemoire(nom) {
  const cle = normalizeBankLabel(nom);
  if (!cle) return null;
  const ph = patternHash(cle);
  const { data: exact } = await sb.from("tiers_memoire").select("*")
    .eq("dossier_id", DOSSIER_ID).eq("sens", SENS).eq("pattern_hash", ph).limit(1).maybeSingle();
  const toHit = (r, sim, kind) => ({
    id: r.id, compte_pcm: r.compte_pcm, categorie_pcm: r.categorie_pcm,
    taux_tva: r.taux_tva != null ? Number(r.taux_tva) : null,
    occurrences: Number(r.occurrences ?? 1), type_tiers: r.type_tiers,
    confiance: r.confiance != null ? Number(r.confiance) : confianceFromOccurrences(Number(r.occurrences ?? 1)),
    pattern: r.pattern, similarity: sim, match_kind: kind,
  });
  if (exact) return toHit(exact, 1, "pattern_hash");
  const { data: cands } = await sb.from("tiers_memoire").select("*")
    .eq("dossier_id", DOSSIER_ID).eq("sens", SENS).limit(500);
  let best = null, bestSim = 0;
  for (const r of cands ?? []) { const s = bankSimilarity(cle, r.pattern ?? r.cle_libelle ?? ""); if (s > bestSim) { bestSim = s; best = r; } }
  return best && bestSim >= BANK_SIM_THRESHOLD ? toHit(best, bestSim, "similarity") : null;
}

// memoriserTiers (banque)
async function memoriserTiers({ nom, compte_pcm, categorie_pcm, taux_tva, type_tiers }) {
  const cle = normalizeBankLabel(nom);
  if (!cle) return { ok: false };
  const pHash = patternHash(cle);
  const { data: existing } = await sb.from("tiers_memoire").select("id,occurrences")
    .eq("dossier_id", DOSSIER_ID).eq("sens", SENS).eq("cle_libelle", cle).limit(1).maybeSingle();
  if (existing) {
    const occ = Number(existing.occurrences ?? 1) + 1;
    await sb.from("tiers_memoire").update({
      occurrences: occ, confiance: confianceFromOccurrences(occ), pattern: cle, pattern_hash: pHash,
      type_tiers, compte_pcm, categorie_pcm, taux_tva, derniere_validation: new Date().toISOString(),
    }).eq("id", existing.id);
    return { ok: true, occurrences: occ, created: false };
  }
  await sb.from("tiers_memoire").insert({
    dossier_id: DOSSIER_ID, sens: SENS, cle_libelle: cle, pattern: cle, pattern_hash: pHash,
    type_tiers, compte_pcm, categorie_pcm, taux_tva, occurrences: 1, confiance: confianceFromOccurrences(1),
  });
  return { ok: true, occurrences: 1, created: true };
}

// Pré-lettrage déterministe (miroir de preMatchTransactions : token tiers + montant ±2)
function preLettrage(tx, facturesFourn) {
  const toks = normalizeBankLabel(tx.libelle).split(/\s+/).filter((t) => t.length >= 3);
  const montant = tx.montant_debit ?? tx.montant_credit ?? 0;
  for (const f of facturesFourn) {
    const nom = (f.fournisseur_nom || "").toUpperCase();
    const restant = Number(f.montant_restant ?? f.montant_ttc);
    if (toks.some((t) => nom.includes(t)) && Math.abs(montant - restant) <= 2)
      return { facture_id: f.id, facture_num: f.numero ?? null, confiance: 90 };
  }
  return null;
}

// Pipeline mono-transaction (miroir de la décision skipLLM de analyserReleveIA)
async function analyserTx(tx, facturesFourn, llm) {
  const hit = await rappelerMemoire(tx.libelle);
  if (hit && hit.occurrences + 1 >= 2) {          // 2e occurrence au total ⇒ skip
    const pm = preLettrage(tx, facturesFourn);
    console.log(`  [MEMOIRE BANQUE HIT] « ${tx.libelle} » → ${hit.match_kind} (${hit.occurrences} usages) | LLM SKIPPED`
      + (pm ? ` | MATCH LETTRAGE ${pm.facture_num} (conf ${pm.confiance})` : ""));
    return { source: "memoire", skipLLM: true, code_pcm: hit.compte_pcm, categorie: hit.categorie_pcm, type_tiers: hit.type_tiers, lettrage: pm };
  }
  llm.n++;                                          // appel IA réel (compté)
  console.log(`  [LLM CALLED] « ${tx.libelle} » (mémoire vide/insuffisante)`);
  return { source: "llm", skipLLM: false, code_pcm: "6147", categorie: "frais_representation", type_tiers: "fournisseur", lettrage: null };
}

// ── Harness ──────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const check = (label, cond, detail = "") => { console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`); cond ? pass++ : fail++; };
async function cleanup() {
  for (const lib of ["PAIEMENT CB 12 03 26 GLOVO FOOD 250,00", "VIREMENT GLOVO FOOD SARL"]) {
    await sb.from("tiers_memoire").delete().eq("dossier_id", DOSSIER_ID).eq("sens", SENS).eq("cle_libelle", normalizeBankLabel(lib));
  }
}

(async () => {
  // 0) Pré-requis : colonnes de la migration présentes ?
  const probe = await sb.from("tiers_memoire").select("pattern,pattern_hash,type_tiers,confiance").limit(1);
  if (probe.error) {
    console.error("\n❌ Migration NON appliquée : " + probe.error.message);
    console.error("   → Exécute supabase/migrations/20260704120000_tiers_memoire_banque.sql dans Supabase, puis relance.\n");
    process.exit(3);
  }

  console.log(`\n🧪 verify_memoire_banque — dossier ${DOSSIER_ID}\n`);
  await cleanup();

  // Facture fournisseur candidate au lettrage (in-memory, comme l'entrée de analyserReleveIA).
  const facturesFourn = [{ id: "fac-glovo-001", numero: "FF-GLOVO-01", fournisseur_nom: "GLOVO MAROC SARL", montant_ttc: 250, montant_restant: 250 }];

  // Deux transactions IDENTIQUES (même tiers, dates différentes → même pattern).
  const tx1 = { libelle: "PAIEMENT CB 12 03 26 GLOVO FOOD 250,00", montant_debit: 250 };
  const tx2 = { libelle: "PAIEMENT CB 27 06 26 GLOVO FOOD 250,00", montant_debit: 250 };
  const llm = { n: 0 };

  console.log(`① Patterns normalisés (bruit retiré) :`);
  check(`tx1 → "GLOVO FOOD"`, normalizeBankLabel(tx1.libelle) === "GLOVO FOOD", normalizeBankLabel(tx1.libelle));
  check(`tx2 → même pattern que tx1`, normalizeBankLabel(tx1.libelle) === normalizeBankLabel(tx2.libelle));

  console.log(`\n② Transaction #1 (mémoire vide) :`);
  const r1 = await analyserTx(tx1, facturesFourn, llm);
  check("appel IA déclenché (skipLLM=false)", r1.skipLLM === false);
  check("compteur IA = 1", llm.n === 1, `llm=${llm.n}`);
  // Validation utilisateur → mémorisation
  const w1 = await memoriserTiers({ nom: tx1.libelle, compte_pcm: "6147", categorie_pcm: "frais_representation", taux_tva: 0, type_tiers: "fournisseur" });
  check("mémorisé (occurrences=1)", w1.occurrences === 1 && w1.created === true);

  console.log(`\n③ Transaction #2 IDENTIQUE (mémoire occ=1 ⇒ 2e occurrence) :`);
  const r2 = await analyserTx(tx2, facturesFourn, llm);
  check("LLM court-circuité (skipLLM=true)", r2.skipLLM === true);
  check("compteur IA TOUJOURS = 1 (pas de 2e appel)", llm.n === 1, `llm=${llm.n}`);
  check("classif auto-appliquée : compte 6147", r2.code_pcm === "6147", r2.code_pcm);
  check("catégorie auto : frais_representation", r2.categorie === "frais_representation", r2.categorie);
  check("type_tiers auto : fournisseur", r2.type_tiers === "fournisseur", r2.type_tiers);
  check("PRÉ-LETTRAGE proposé (facture GLOVO)", r2.lettrage?.facture_id === "fac-glovo-001", r2.lettrage?.facture_num ?? "aucun");

  console.log(`\n④ Variante « VIREMENT GLOVO FOOD SARL » → rappel par SIMILARITÉ :`);
  const hitSim = await rappelerMemoire("VIREMENT GLOVO FOOD SARL");
  check("rappel trouvé", !!hitSim);
  check("match_kind = similarity", hitSim?.match_kind === "similarity", hitSim?.match_kind);
  check("similarité ≥ 0.7", (hitSim?.similarity ?? 0) >= 0.7, String(hitSim?.similarity));

  console.log(`\n⑤ Confiance dérivée des occurrences :`);
  const after = await rappelerMemoire(tx1.libelle);
  check("occurrences=1 en base", after?.occurrences === 1, `occ=${after?.occurrences}`);
  check("confiance = 0.33 (1/3)", Math.abs((after?.confiance ?? 0) - 1 / 3) < 0.01, String(after?.confiance));

  await cleanup();
  const gone = await rappelerMemoire(tx1.libelle);
  check("trace de test nettoyée", gone === null);

  console.log(`\n${fail === 0 ? "🎉 TOUT PASSE" : "⚠️  ÉCHECS"} — ${pass} ok / ${fail} ko`);
  console.log(`   Appels IA sur 2 transactions identiques : ${llm.n} (attendu : 1)\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("💥", e); process.exit(2); });
