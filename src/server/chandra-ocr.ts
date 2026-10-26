// ============================================================================
// chandra-ocr.ts — OCR par Chandra, le modèle open source de Datalab,
// AUTO-HÉBERGÉ (github.com/datalab-to/chandra, poids datalab-to/chandra-ocr-2).
//
// ─── Pourquoi Chandra ────────────────────────────────────────────────────────
// Chandra est entraîné pour ce qui met les OCR génériques en difficulté :
// tableaux denses (colonnes Débit/Crédit d'un relevé), formulaires, écriture
// manuscrite. Il tourne sur NOTRE serveur : aucune plateforme tierce, aucune
// clé ni facturation à la page. Licence des poids (OpenRAIL-M modifiée) :
// gratuite pour la recherche, l'usage personnel et les sociétés de moins de
// 2 M$ de chiffre d'affaires ou de levée ; au-delà, licence commerciale Datalab.
//
// ─── Le serveur ──────────────────────────────────────────────────────────────
// Modèle de 5 milliards de paramètres : il lui faut un GPU (Railway n'en a
// pas). On le sert avec vLLM, qui expose une API compatible OpenAI :
//     vllm serve datalab-to/chandra-ocr-2 [--api-key <secret>]
// ou `chandra_vllm` (paquet chandra-ocr). L'application lui parle par
//     CHANDRA_API_BASE  ex. https://mon-gpu.example.com/v1   (obligatoire)
//     CHANDRA_API_KEY   le --api-key de vLLM                  (facultatif)
//     CHANDRA_MODEL     nom servi ; à défaut, lu sur /models  (facultatif)
//
// ─── Ce qu'il rend ───────────────────────────────────────────────────────────
// Chandra lit une IMAGE (une page) et rend du HTML. L'aval de l'application
// (parseReleveMarkdown, extraction LLM) attend du Markdown, comme Mistral OCR :
// `htmlVersMarkdown` fait la conversion, tableaux compris. Un PDF n'est pas
// accepté ici — les pages sont rendues en images côté navigateur ; sinon
// l'appelant retombe sur Mistral OCR.
// ============================================================================

// Prompt d'entraînement de Chandra, recopié de chandra/prompts.py (OCR_PROMPT).
// Le modèle a appris CE texte : le paraphraser dégraderait la lecture.
const ALLOWED_TAGS = [
  "math", "br", "i", "b", "u", "del", "sup", "sub", "table", "tr", "td", "p", "th",
  "div", "pre", "h1", "h2", "h3", "h4", "h5", "ul", "ol", "li", "input", "a", "span",
  "img", "hr", "tbody", "small", "caption", "strong", "thead", "big", "code", "chem",
];
const ALLOWED_ATTRIBUTES = [
  "class", "colspan", "rowspan", "display", "checked", "type", "border", "value",
  "style", "href", "alt", "align", "data-bbox", "data-label",
];
/** Rendu d'une liste Python (`str(list)`), tel que le f-string d'origine le produit. */
const listePython = (l: string[]) => `[${l.map((x) => `'${x}'`).join(", ")}]`;

export const CHANDRA_OCR_PROMPT = `OCR this image to HTML.

Only use these tags ${listePython(ALLOWED_TAGS)}, and these attributes ${listePython(ALLOWED_ATTRIBUTES)}.

Guidelines:
* Inline math: Surround math with <math>...</math> tags. Math expressions should be rendered in KaTeX-compatible LaTeX. Use display for block math.
* Tables: Use colspan and rowspan attributes to match table structure.
* Formatting: Maintain consistent formatting with the image, including spacing, indentation, subscripts/superscripts, and special characters.
* Images: Include a description of any images in the alt attribute of an <img> tag. Do not fill out the src property. Describe in detail inside the div tag. Also convert charts to high fidelity data, and convert diagrams to mermaid.
* Forms: Mark checkboxes and radio buttons properly.
* Text: join lines together properly into paragraphs using <p>...</p> tags.  Use <br> tags for line breaks within paragraphs, but only when absolutely necessary to maintain meaning.
* Chemistry: Use <chem>...</chem> tags for chemical formulas with reactive SMILES.
* Lists: Preserve indents and proper list markers.
* Use the simplest possible HTML structure that accurately represents the content of the block.
* Make sure the text is accurate and easy for a human to read and interpret.  Reading order should be correct and natural.`;

/** Budget de sortie par page — MAX_OUTPUT_TOKENS de chandra/settings.py. */
const MAX_OUTPUT_TOKENS = 12384;

type Env = Record<string, string | undefined>;

export function chandraDisponible(env: Env = process.env): boolean {
  return !!(env.CHANDRA_API_BASE ?? "").trim();
}

// ─── HTML → Markdown ─────────────────────────────────────────────────────────

function decoderEntites(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

/** Texte brut d'un fragment HTML, sur une ligne. */
function texteCellule(html: string): string {
  return decoderEntites(html.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\|/g, "\\|");
}

function tableVersMarkdown(table: string): string {
  const lignes: string[][] = [];
  for (const tr of table.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? []) {
    const cellules: string[] = [];
    for (const m of tr.matchAll(/<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
      const colspan = Math.max(1, Number(/colspan\s*=\s*["']?(\d+)/i.exec(m[2])?.[1] ?? 1));
      cellules.push(texteCellule(m[3]));
      // Une cellule fusionnée occupe plusieurs colonnes : on garde l'alignement.
      for (let k = 1; k < colspan; k++) cellules.push("");
    }
    if (cellules.length) lignes.push(cellules);
  }
  if (!lignes.length) return "";
  const largeur = Math.max(...lignes.map((l) => l.length));
  const rendre = (l: string[]) => `| ${[...l, ...Array(largeur - l.length).fill("")].join(" | ")} |`;
  return [rendre(lignes[0]), `|${" --- |".repeat(largeur)}`, ...lignes.slice(1).map(rendre)].join("\n");
}

/**
 * Convertit le HTML de Chandra en Markdown : tableaux en tableaux « pipe »
 * (la forme que rend Mistral OCR et que parseReleveMarkdown sait lire),
 * paragraphes et titres en lignes de texte.
 */
export function htmlVersMarkdown(html: string): string {
  const tables: string[] = [];
  let s = String(html ?? "")
    .replace(/^```(?:html)?\s*|```\s*$/gi, "")
    .replace(/<table\b[\s\S]*?<\/table>/gi, (t) => {
      tables.push(tableVersMarkdown(t));
      return `\n\n\u0000T${tables.length - 1}\u0000\n\n`;
    })
    .replace(/<h([1-5])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n\n${"#".repeat(Number(n))} ${texteCellule(t)}\n\n`)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|ul|ol|li|pre|caption)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "");
  s = decoderEntites(s)
    .split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\u0000T(\d+)\u0000/g, (_, i) => tables[Number(i)]);
  return s.trim();
}

// ─── Appel au serveur ────────────────────────────────────────────────────────

export interface OptionsChandra {
  fetchImpl?: (url: string, init?: any) => Promise<Response>;
  env?: Env;
}

/**
 * Lit une page (image en base64) avec Chandra et rend son Markdown.
 * Lève une erreur explicite en cas d'échec : l'appelant décide du repli.
 */
export async function callChandraOcr(
  base64: string,
  mimeType: string,
  opts: OptionsChandra = {},
): Promise<string> {
  const env = opts.env ?? process.env;
  const base = (env.CHANDRA_API_BASE ?? "").trim().replace(/\/+$/, "");
  if (!base) throw new Error("CHANDRA_API_BASE manquante");
  if (/pdf/i.test(mimeType)) throw new Error("Chandra lit des images, pas un PDF");
  const fetchImpl = opts.fetchImpl ?? ((u: string, i?: any) => fetch(u, i));
  const cle = (env.CHANDRA_API_KEY ?? "").trim();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cle) headers.Authorization = `Bearer ${cle}`;

  let model = (env.CHANDRA_MODEL ?? "").trim();
  if (!model) {
    // Comme le client officiel : à défaut de nom, le premier modèle servi.
    const r = await fetchImpl(`${base}/models`, { headers });
    if (!r.ok) throw new Error(`Chandra /models ${r.status}: ${(await r.text()).slice(0, 200)}`);
    model = String(((await r.json()) as any)?.data?.[0]?.id ?? "");
    if (!model) throw new Error("Chandra : aucun modèle servi");
  }

  const res = await fetchImpl(`${base}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      // Paramètres du client officiel (chandra/model/vllm.py) : image d'abord.
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mimeType || "image/png"};base64,${base64}` } },
          { type: "text", text: CHANDRA_OCR_PROMPT },
        ],
      }],
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0,
      top_p: 0.1,
    }),
  });
  if (!res.ok) throw new Error(`Chandra ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const html = String(((await res.json()) as any)?.choices?.[0]?.message?.content ?? "");
  const markdown = htmlVersMarkdown(html);
  if (!markdown) throw new Error("Chandra : réponse vide");
  console.log(`[CHANDRA OCR] ✓ ${html.length} chars HTML → ${markdown.length} chars Markdown`);
  return markdown;
}
