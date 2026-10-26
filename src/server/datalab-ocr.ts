// ============================================================================
// datalab-ocr.ts — OCR document par l'API Datalab (moteurs Marker / Chandra).
//
// ─── Pourquoi Datalab ────────────────────────────────────────────────────────
// Chandra, le modèle OCR de Datalab, est fait pour ce qui met Mistral OCR en
// difficulté : tableaux denses à colonnes Débit/Crédit, formulaires, écriture
// manuscrite. Un relevé bancaire marocain est exactement ce cas.
//
// L'API hébergée (et non le modèle open source, qui exige un GPU dont Railway ne
// dispose pas) offre un quota mensuel gratuit, puis un paiement à la page.
//
// ─── Place dans la chaîne ────────────────────────────────────────────────────
// Datalab est le moteur PRINCIPAL dès que DATALAB_API_KEY est définie. Il rend
// du Markdown, comme Mistral OCR : tout l'aval (parseReleveMarkdown, extraction
// LLM, contrôle d'équilibre) reste inchangé. En cas d'échec, l'appelant retombe
// sur Mistral OCR, puis sur la vision Groq.
//
// ─── Le protocole (documentation.datalab.to, oct. 2026) ──────────────────────
//   POST https://www.datalab.to/api/v1/convert   (multipart, en-tête X-API-Key)
//     → { request_check_url }
//   GET request_check_url  jusqu'à status = "complete"
//     → { success, markdown | result_url, error }
// `result_url` (traitement en UE) se télécharge SANS la clé.
// ============================================================================

export const DATALAB_ENDPOINT = "https://www.datalab.to/api/v1/convert";

/** Modes Datalab : fast (défaut API), balanced (recommandé), accurate. */
const MODES = new Set(["fast", "balanced", "accurate"]);

export interface OptionsDatalab {
  fetchImpl?: (url: string, init?: any) => Promise<Response>;
  /** Attente entre deux sondages (injectable pour les tests). */
  attendre?: (ms: number) => Promise<void>;
  intervalleMs?: number;
  /** Délai maximal avant abandon. Un relevé de 10 pages se traite en ~20 s. */
  delaiMaxMs?: number;
  env?: Record<string, string | undefined>;
}

export function datalabDisponible(env: Record<string, string | undefined> = process.env): boolean {
  return !!(env.DATALAB_API_KEY ?? "").trim();
}

function nomFichier(mimeType: string): string {
  if (/pdf/i.test(mimeType)) return "document.pdf";
  if (/png/i.test(mimeType)) return "document.png";
  if (/webp/i.test(mimeType)) return "document.webp";
  return "document.jpg";
}

/**
 * Convertit un document (PDF ou image, en base64) en Markdown via Datalab.
 * Lève une erreur explicite en cas d'échec : l'appelant décide du repli.
 */
export async function callDatalabOcr(
  base64: string,
  mimeType: string,
  opts: OptionsDatalab = {},
): Promise<string> {
  const env = opts.env ?? process.env;
  const key = (env.DATALAB_API_KEY ?? "").trim();
  if (!key) throw new Error("DATALAB_API_KEY manquante");
  const fetchImpl = opts.fetchImpl ?? ((u: string, i?: any) => fetch(u, i));
  const attendre = opts.attendre ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const intervalle = opts.intervalleMs ?? 2000;
  const delaiMax = opts.delaiMaxMs ?? 180_000;
  const modeEnv = (env.DATALAB_MODE ?? "").trim().toLowerCase();
  const mode = MODES.has(modeEnv) ? modeEnv : "balanced";

  const form = new FormData();
  const type = mimeType || "application/octet-stream";
  form.append("file", new Blob([Buffer.from(base64, "base64")], { type }), nomFichier(type));
  form.append("output_format", "markdown");
  form.append("mode", mode);
  // Les images du document ne servent à rien en aval : on ne paie pas leur extraction.
  form.append("disable_image_extraction", "true");

  const soumis = await fetchImpl(DATALAB_ENDPOINT, {
    method: "POST",
    headers: { "X-API-Key": key },
    body: form,
  });
  if (!soumis.ok) {
    throw new Error(`Datalab ${soumis.status}: ${(await soumis.text()).slice(0, 200)}`);
  }
  const depart = (await soumis.json()) as any;
  const checkUrl: string | undefined = depart?.request_check_url;
  if (!checkUrl) throw new Error("Datalab : request_check_url absente de la réponse");

  const maxSondages = Math.max(1, Math.ceil(delaiMax / Math.max(1, intervalle)));
  for (let sondage = 1; ; sondage++) {
    await attendre(intervalle);
    const r = await fetchImpl(checkUrl, { headers: { "X-API-Key": key } });
    if (!r.ok) throw new Error(`Datalab suivi ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const etat = (await r.json()) as any;
    if (etat?.status === "complete") {
      if (etat.success === false) throw new Error(`Datalab : ${String(etat.error ?? "conversion échouée").slice(0, 200)}`);
      let markdown: unknown = etat.markdown;
      if (typeof markdown !== "string" && etat.result_url) {
        // Résultat déposé en UE : URL signée, téléchargée SANS la clé.
        const res = await fetchImpl(String(etat.result_url));
        if (!res.ok) throw new Error(`Datalab résultat ${res.status}`);
        markdown = ((await res.json()) as any)?.markdown;
      }
      if (typeof markdown !== "string" || !markdown.trim()) throw new Error("Datalab : Markdown vide");
      console.log(
        `[DATALAB OCR] ✓ ${etat.page_count ?? "?"} page(s), ${markdown.length} chars` +
        (etat.parse_quality_score != null ? `, qualité ${etat.parse_quality_score}/5` : ""),
      );
      return markdown;
    }
    if (sondage >= maxSondages) throw new Error(`Datalab : délai dépassé (${Math.round(delaiMax / 1000)} s)`);
  }
}
