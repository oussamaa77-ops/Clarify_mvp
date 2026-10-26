import { describe, it, expect } from "vitest";
import { callDatalabOcr, datalabDisponible, DATALAB_ENDPOINT } from "./datalab-ocr";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Faux serveur Datalab : rejoue une suite de réponses et note chaque requête. */
function fauxDatalab(reponses: Response[]) {
  const appels: { url: string; init?: any }[] = [];
  const fetchImpl = async (url: string, init?: any) => {
    appels.push({ url, init });
    const r = reponses.shift();
    if (!r) throw new Error("appel inattendu");
    return r;
  };
  return { appels, fetchImpl };
}

const env = { DATALAB_API_KEY: "cle-test" };
const sansAttente = async () => {};
const B64 = Buffer.from("%PDF-1.4 test").toString("base64");

describe("datalab-ocr", () => {
  it("n'est disponible qu'avec une clé non vide", () => {
    expect(datalabDisponible({})).toBe(false);
    expect(datalabDisponible({ DATALAB_API_KEY: "  " })).toBe(false);
    expect(datalabDisponible(env)).toBe(true);
  });

  it("soumet le document, sonde jusqu'à complete et rend le Markdown", async () => {
    const { appels, fetchImpl } = fauxDatalab([
      json({ request_check_url: "https://www.datalab.to/api/v1/convert/abc" }),
      json({ status: "processing" }),
      json({ status: "complete", success: true, markdown: "| Date | Débit |\n|---|---|", page_count: 2 }),
    ]);
    const md = await callDatalabOcr(B64, "application/pdf", { fetchImpl, env, attendre: sansAttente });
    expect(md).toContain("Débit");

    expect(appels[0].url).toBe(DATALAB_ENDPOINT);
    expect(appels[0].init.method).toBe("POST");
    expect(appels[0].init.headers["X-API-Key"]).toBe("cle-test");
    const form = appels[0].init.body as FormData;
    expect(form.get("output_format")).toBe("markdown");
    expect(form.get("mode")).toBe("balanced");
    expect((form.get("file") as File).name).toBe("document.pdf");
    expect(appels[1].url).toBe("https://www.datalab.to/api/v1/convert/abc");
    expect(appels).toHaveLength(3);
  });

  it("respecte DATALAB_MODE, et ignore une valeur inconnue", async () => {
    for (const [mode, attendu] of [["accurate", "accurate"], ["n'importe", "balanced"]]) {
      const { appels, fetchImpl } = fauxDatalab([
        json({ request_check_url: "u" }),
        json({ status: "complete", success: true, markdown: "x" }),
      ]);
      await callDatalabOcr(B64, "image/png", { fetchImpl, env: { ...env, DATALAB_MODE: mode }, attendre: sansAttente });
      expect((appels[0].init.body as FormData).get("mode")).toBe(attendu);
    }
  });

  it("télécharge result_url (traitement UE) SANS la clé", async () => {
    const { appels, fetchImpl } = fauxDatalab([
      json({ request_check_url: "u" }),
      json({ status: "complete", success: true, result_url: "https://signed.example/r" }),
      json({ markdown: "contenu UE" }),
    ]);
    const md = await callDatalabOcr(B64, "application/pdf", { fetchImpl, env, attendre: sansAttente });
    expect(md).toBe("contenu UE");
    expect(appels[2].url).toBe("https://signed.example/r");
    expect(appels[2].init).toBeUndefined();
  });

  it("lève une erreur explicite : clé absente, refus HTTP, échec, Markdown vide, délai", async () => {
    await expect(callDatalabOcr(B64, "application/pdf", { env: {} })).rejects.toThrow(/DATALAB_API_KEY/);

    let f = fauxDatalab([json({ error: "quota" }, 402)]);
    await expect(callDatalabOcr(B64, "application/pdf", { fetchImpl: f.fetchImpl, env, attendre: sansAttente }))
      .rejects.toThrow(/Datalab 402/);

    f = fauxDatalab([json({ request_check_url: "u" }), json({ status: "complete", success: false, error: "PDF illisible" })]);
    await expect(callDatalabOcr(B64, "application/pdf", { fetchImpl: f.fetchImpl, env, attendre: sansAttente }))
      .rejects.toThrow(/PDF illisible/);

    f = fauxDatalab([json({ request_check_url: "u" }), json({ status: "complete", success: true, markdown: "  " })]);
    await expect(callDatalabOcr(B64, "application/pdf", { fetchImpl: f.fetchImpl, env, attendre: sansAttente }))
      .rejects.toThrow(/Markdown vide/);

    f = fauxDatalab([json({ request_check_url: "u" }), json({ status: "processing" }), json({ status: "processing" })]);
    await expect(callDatalabOcr(B64, "application/pdf", {
      fetchImpl: f.fetchImpl, env, attendre: sansAttente, intervalleMs: 1000, delaiMaxMs: 2000,
    })).rejects.toThrow(/délai dépassé/);
  });
});
