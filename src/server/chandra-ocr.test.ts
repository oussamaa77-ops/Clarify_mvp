import { describe, it, expect } from "vitest";
import { CHANDRA_OCR_PROMPT, callChandraOcr, chandraDisponible, htmlVersMarkdown } from "./chandra-ocr";
import { parseReleveMarkdown } from "./factures.utils";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function fauxServeur(reponses: Response[]) {
  const appels: { url: string; init?: any }[] = [];
  const fetchImpl = async (url: string, init?: any) => {
    appels.push({ url, init });
    const r = reponses.shift();
    if (!r) throw new Error("appel inattendu");
    return r;
  };
  return { appels, fetchImpl };
}

const completion = (content: string) => json({ choices: [{ message: { content } }] });

describe("chandra-ocr — prompt", () => {
  it("reprend le prompt d'entraînement (chandra/prompts.py, OCR_PROMPT)", () => {
    expect(CHANDRA_OCR_PROMPT.startsWith("OCR this image to HTML.\n\nOnly use these tags ['math', 'br', ")).toBe(true);
    expect(CHANDRA_OCR_PROMPT).toContain("'data-bbox', 'data-label']");
    expect(CHANDRA_OCR_PROMPT.endsWith("Reading order should be correct and natural.")).toBe(true);
  });
});

describe("chandra-ocr — HTML → Markdown", () => {
  it("convertit un tableau de relevé en tableau « pipe », colspan compris", () => {
    const html = `<div data-label="Table"><table>
      <thead><tr><th>Date</th><th>Libellé</th><th>Débit</th><th>Crédit</th></tr></thead>
      <tbody>
        <tr><td>02/03/2026</td><td>PAIEMENT CB IAM</td><td>520,00</td><td></td></tr>
        <tr><td>05/03/2026</td><td>VIR RECU ACME &amp; FILS</td><td></td><td>1 200,00</td></tr>
        <tr><td colspan="2">TOTAL</td><td>520,00</td><td>1 200,00</td></tr>
      </tbody></table></div>`;
    const md = htmlVersMarkdown(html);
    expect(md).toContain("| Date | Libellé | Débit | Crédit |");
    expect(md).toContain("| --- | --- | --- | --- |");
    expect(md).toContain("| 05/03/2026 | VIR RECU ACME & FILS |  | 1 200,00 |");
    expect(md).toContain("| TOTAL |  | 520,00 | 1 200,00 |");
  });

  it("garde le texte hors tableau, titres et sauts de ligne", () => {
    const md = htmlVersMarkdown("```html\n<h2>RELEVÉ DE COMPTE</h2><p>Solde au 01/03 :<br>10 000,00</p>\n```");
    expect(md).toBe("## RELEVÉ DE COMPTE\n\nSolde au 01/03 :\n10 000,00");
  });

  it("échappe un « | » dans une cellule pour ne pas casser les colonnes", () => {
    expect(htmlVersMarkdown("<table><tr><td>A|B</td><td>1</td></tr></table>")).toContain("| A\\|B | 1 |");
  });

  it("le Markdown produit est lisible par le parseur de relevés de l'application", () => {
    const html = `<table>
      <tr><th>Date</th><th>Libellé</th><th>Débit</th><th>Crédit</th></tr>
      <tr><td>02/03/2026</td><td>PAIEMENT CB IAM</td><td>520,00</td><td></td></tr>
      <tr><td>05/03/2026</td><td>VIR RECU ACME</td><td></td><td>1 200,00</td></tr>
    </table>`;
    const { txs } = parseReleveMarkdown(htmlVersMarkdown(html));
    expect(txs.length).toBe(2);
  });
});

describe("chandra-ocr — appel au serveur vLLM", () => {
  const env = { CHANDRA_API_BASE: "https://gpu.example.com/v1/", CHANDRA_API_KEY: "secret", CHANDRA_MODEL: "chandra" };

  it("n'est disponible qu'avec CHANDRA_API_BASE", () => {
    expect(chandraDisponible({})).toBe(false);
    expect(chandraDisponible({ CHANDRA_API_BASE: " " })).toBe(false);
    expect(chandraDisponible(env)).toBe(true);
  });

  it("envoie l'image puis le prompt, avec la clé, et rend le Markdown", async () => {
    const { appels, fetchImpl } = fauxServeur([completion("<p>Bonjour</p>")]);
    const md = await callChandraOcr("QUJD", "image/png", { fetchImpl, env });
    expect(md).toBe("Bonjour");
    expect(appels[0].url).toBe("https://gpu.example.com/v1/chat/completions");
    expect(appels[0].init.headers.Authorization).toBe("Bearer secret");
    const body = JSON.parse(appels[0].init.body);
    expect(body.model).toBe("chandra");
    expect(body.temperature).toBe(0);
    expect(body.messages[0].content[0]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } });
    expect(body.messages[0].content[1].text).toBe(CHANDRA_OCR_PROMPT);
  });

  it("sans CHANDRA_MODEL, prend le premier modèle servi ; sans clé, pas d'en-tête Authorization", async () => {
    const { appels, fetchImpl } = fauxServeur([
      json({ data: [{ id: "datalab-to/chandra-ocr-2" }] }),
      completion("<p>x</p>"),
    ]);
    await callChandraOcr("QUJD", "image/jpeg", { fetchImpl, env: { CHANDRA_API_BASE: "http://gpu:8000/v1" } });
    expect(appels[0].url).toBe("http://gpu:8000/v1/models");
    expect(JSON.parse(appels[1].init.body).model).toBe("datalab-to/chandra-ocr-2");
    expect(appels[1].init.headers.Authorization).toBeUndefined();
  });

  it("refuse un PDF, une URL absente, une erreur HTTP et une réponse vide", async () => {
    await expect(callChandraOcr("x", "application/pdf", { env })).rejects.toThrow(/PDF/);
    await expect(callChandraOcr("x", "image/png", { env: {} })).rejects.toThrow(/CHANDRA_API_BASE/);
    let f = fauxServeur([json({ error: "down" }, 503)]);
    await expect(callChandraOcr("x", "image/png", { fetchImpl: f.fetchImpl, env })).rejects.toThrow(/Chandra 503/);
    f = fauxServeur([completion("   ")]);
    await expect(callChandraOcr("x", "image/png", { fetchImpl: f.fetchImpl, env })).rejects.toThrow(/vide/);
  });
});
