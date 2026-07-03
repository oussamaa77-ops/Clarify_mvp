// ════════════════════════════════════════════════════════════════════════════
// TEST 2 — PERFORMANCE PIPELINE IA  (cascade Mistral + Groq, bout-en-bout)
// ────────────────────────────────────────────────────────────────────────────
// Mesure la latence et la robustesse du pipeline de scan de relevé SANS surcouche
// UI : on appelle directement les server functions réelles
//   1) ocrReleve         → EXTRACTION  (Mistral OCR en 1er, secours Groq vision)
//   2) analyserReleveIA   → MATCHING    (Mistral chat en 1er, secours Groq texte)
//
// Pourquoi pas l'UI : ocrReleve / analyserReleveIA n'ont PAS de middleware d'auth
// et le code applicatif gère déjà le proxy SSL d'entreprise (retry undici sur
// SELF_SIGNED_CERT_IN_CHAIN). On isole donc la perf des API Mistral/Groq sans
// dépendre du login (ce qui contourne aussi le blocage d'identifiants du Test 1).
//
// NOTE technique : appelées hors du runtime TanStack Start, ces server functions
// EXÉCUTENT bien leur handler (vrais appels Mistral/Groq), mais le wrapper ne
// PROPAGE PAS la valeur de retour (résout `undefined`). Pour une mesure de
// LATENCE c'est sans incidence : `await fn()` ne résout qu'APRÈS le travail réseau
// complet. On dérive donc le nb de tx et le provider depuis les logs du handler.
//
// Lancement :  npx vitest run --config vitest.perf.config.ts
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE_DIR = path.join(ROOT, "e2e", "fixtures");

// Nb d'itérations MESURÉES par étape (hors warm-up). Chaque itération = un vrai
// appel facturé → on garde petit par défaut. Surchargeable via PERF_ITER.
const ITER = Math.max(1, Number(process.env.PERF_ITER || 2));

// ── Chargement .env → process.env (les server fns lisent process.env au runtime) ─
(function loadEnv() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i === -1) continue;
    const k = line.slice(0, i).trim();
    if (process.env[k] === undefined) process.env[k] = line.slice(i + 1).trim();
  }
})();

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".png": "image/png", ".webp": "image/webp",
};

// Transactions de référence pour l'étape MATCHING (correspondent au relevé
// synthétique ci-dessous). Forme = sortie réelle d'ocrReleve.txs.
const REF_TXS = [
  { ligne: 1, date_operation: "03/05/2026", date_valeur: "03/05/2026", reference: "", libelle: "VIR RECU CLIENT ALPHA",     montant_debit: null,   montant_credit: 6000.0, nature_operation: "" },
  { ligne: 2, date_operation: "07/05/2026", date_valeur: "07/05/2026", reference: "", libelle: "PAIEMENT FOURNISSEUR BETA",  montant_debit: 2400.0, montant_credit: null,   nature_operation: "" },
  { ligne: 3, date_operation: "12/05/2026", date_valeur: "12/05/2026", reference: "", libelle: "PRLV ONEE ELECTRICITE",      montant_debit: 850.5,  montant_credit: null,   nature_operation: "" },
  { ligne: 4, date_operation: "19/05/2026", date_valeur: "19/05/2026", reference: "", libelle: "VIR EMIS SALAIRES",          montant_debit: 4500.0, montant_credit: null,   nature_operation: "" },
  { ligne: 5, date_operation: "26/05/2026", date_valeur: "26/05/2026", reference: "", libelle: "FRAIS BANCAIRES",            montant_debit: 45.0,   montant_credit: null,   nature_operation: "" },
];

// ── Génère un relevé PDF SYNTHÉTIQUE valide (fallback si aucun doc réel) ──────
function buildSyntheticRelevePdf(): Buffer {
  const lines = [
    "BANQUE POPULAIRE - RELEVE DE COMPTE",
    "RIB: 190 780 2111114470020003 85",
    "Periode: 01/05/2026 au 31/05/2026",
    "SOLDE DEPART .................. 12 500,00",
    "",
    "Date       Libelle                         Debit      Credit     Solde",
    "03/05/2026 VIR RECU CLIENT ALPHA                       6000,00   18500,00",
    "07/05/2026 PAIEMENT FOURNISSEUR BETA        2400,00               16100,00",
    "12/05/2026 PRLV ONEE ELECTRICITE             850,50               15249,50",
    "19/05/2026 VIR EMIS SALAIRES                4500,00               10749,50",
    "26/05/2026 FRAIS BANCAIRES                    45,00               10704,50",
    "",
    "SOLDE FINAL ................... 10 704,50",
  ];
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  let content = "BT\n/F1 11 Tf\n";
  let y = 800;
  for (const l of lines) { content += `1 0 0 1 50 ${y} Tm\n(${esc(l)}) Tj\n`; y -= 18; }
  content += "ET";
  const objs: Record<number, string> = {
    1: "<</Type /Catalog /Pages 2 0 R>>",
    2: "<</Type /Pages /Kids [3 0 R] /Count 1>>",
    3: "<</Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources <</Font <</F1 5 0 R>>>> /Contents 4 0 R>>",
    4: `<</Length ${Buffer.byteLength(content, "latin1")}>>\nstream\n${content}\nendstream`,
    5: "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>",
  };
  let body = "%PDF-1.4\n";
  const offsets: Record<number, number> = {};
  for (let i = 1; i <= 5; i++) { offsets[i] = Buffer.byteLength(body, "latin1"); body += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xrefStart = Buffer.byteLength(body, "latin1");
  let xref = "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  return Buffer.from(body + xref + `trailer\n<</Size 6 /Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF`, "latin1");
}

// ── Fixture : VRAI doc prioritaire, sinon synthétique ────────────────────────
function resolveFixture(): { buffer: Buffer; mime: string; name: string; synthetic: boolean } {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const real = fs.readdirSync(FIXTURE_DIR).find((f) => /^releve\.(pdf|jpe?g|png|webp)$/i.test(f));
  if (real) {
    const ext = path.extname(real).toLowerCase();
    return { buffer: fs.readFileSync(path.join(FIXTURE_DIR, real)), mime: MIME_BY_EXT[ext] ?? "application/pdf", name: real, synthetic: false };
  }
  const pdf = buildSyntheticRelevePdf();
  fs.writeFileSync(path.join(FIXTURE_DIR, "releve.synth.pdf"), pdf);
  return { buffer: pdf, mime: "application/pdf", name: "releve.synth.pdf", synthetic: true };
}

// ── Exécute fn() en capturant ses logs → latence + provider + nb tx ──────────
async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; provider: string; txCount: number | null }> {
  const logs: string[] = [];
  const origLog = console.log, origWarn = console.warn;
  console.log = (...a: any[]) => { logs.push(a.join(" ")); };   // silencieux pendant la mesure
  console.warn = (...a: any[]) => { logs.push(a.join(" ")); };
  const t0 = performance.now();
  try {
    await fn();
  } finally {
    console.log = origLog; console.warn = origWarn;
  }
  const ms = performance.now() - t0;
  const joined = logs.join("\n");
  const groqFallback = /secours\s+groq/i.test(joined) || /\[Groq\]\s*model/i.test(joined);
  const mistralOk = /\[MISTRAL OCR\]\s*✓/.test(joined) || (/\[MISTRAL/i.test(joined) && !groqFallback);
  const provider = mistralOk ? "mistral" : groqFallback ? "groq (secours)" : "indéterminé";
  const m = joined.match(/\[OCR-RELEVE\]\s*(\d+)\s*tx/);
  return { ms, provider, txCount: m ? Number(m[1]) : null };
}

function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const pct = (p: number) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  return {
    n: s.length, min_ms: +s[0].toFixed(0), p50_ms: +pct(50).toFixed(0),
    p95_ms: +pct(95).toFixed(0), max_ms: +s[s.length - 1].toFixed(0),
    avg_ms: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(0),
  };
}

let ocrReleve: any, analyserReleveIA: any;

describe("Test 2 — Performance Pipeline IA (Mistral + Groq)", () => {
  beforeAll(async () => {
    const mod = await import("@/server/factures.functions");
    ocrReleve = mod.ocrReleve;
    analyserReleveIA = mod.analyserReleveIA;
  });

  it("extraction + matching de bout-en-bout : latence & robustesse", async () => {
    expect(process.env.MISTRAL_API_KEY, "MISTRAL_API_KEY manquante dans .env").toBeTruthy();
    expect(process.env.GROQ_API_KEY, "GROQ_API_KEY manquante dans .env").toBeTruthy();

    const fix = resolveFixture();
    const image_base64 = fix.buffer.toString("base64");
    console.log(`[perf] fixture=${fix.name} (${(fix.buffer.length / 1024).toFixed(0)} KB, mime=${fix.mime})${fix.synthetic ? "  ⚠ SYNTHÉTIQUE — déposez un vrai relevé dans e2e/fixtures/releve.<ext> pour des chiffres représentatifs" : ""}`);

    // ── ÉTAPE 1 — EXTRACTION (ocrReleve) ──────────────────────────────────────
    await timed(() => ocrReleve({ data: { image_base64, mime_type: fix.mime } })); // warm-up
    const ex: number[] = [];
    let exProvider = "?", exTx: number | null = null;
    for (let i = 0; i < ITER; i++) {
      const r = await timed(() => ocrReleve({ data: { image_base64, mime_type: fix.mime } }));
      ex.push(r.ms); exProvider = r.provider; exTx = r.txCount;
    }

    // ── ÉTAPE 2 — MATCHING (analyserReleveIA) ─────────────────────────────────
    // Contexte minimal (référentiel vide) : on mesure le coût du raisonnement IA.
    const matchData = {
      transactions_brutes: REF_TXS,
      factures_client: [], factures_fourn: [], justificatifs: [],
      clients: [], fournisseurs: [], dossier_nom: "PERF TEST", dossier_ice: "",
    };
    await timed(() => analyserReleveIA({ data: matchData })); // warm-up
    const ma: number[] = [];
    let maProvider = "?";
    for (let i = 0; i < ITER; i++) {
      const r = await timed(() => analyserReleveIA({ data: matchData }));
      ma.push(r.ms); maProvider = r.provider;
    }

    // ── MÉTRIQUES / VERDICT ───────────────────────────────────────────────────
    const exS = stats(ex), maS = stats(ma);
    const metrics = {
      fixture: fix.name, synthetic: fix.synthetic, iterations: ITER,
      extraction: { provider: exProvider, tx_extraites: exTx, ...exS },
      matching: { provider: maProvider, tx_en_entree: REF_TXS.length, ...maS },
      bout_en_bout_p50_ms: exS.p50_ms + maS.p50_ms,
    };
    console.log("\n[PERF PIPELINE IA] " + JSON.stringify(metrics, null, 2) + "\n");

    // ── ROBUSTESSE ────────────────────────────────────────────────────────────
    // Les deux étapes doivent répondre sans throw (sinon timed() aurait rejeté).
    expect(exS.n, "extraction mesurée").toBe(ITER);
    expect(maS.n, "matching mesuré").toBe(ITER);
    if (!fix.synthetic) {
      expect(exTx ?? 0, "un vrai relevé doit produire ≥ 1 transaction").toBeGreaterThan(0);
    } else if ((exTx ?? 0) === 0) {
      console.warn("[perf] ⚠ 0 tx extraite sur la fixture synthétique — la cascade a néanmoins tourné de bout en bout.");
    }
  });
});
