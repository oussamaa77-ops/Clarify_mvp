import { describe, it, expect } from "vitest";
import { traiterPagesEnPipeline } from "./pipeline-pages";

/** Promesse résolue manuellement, pour piloter l'ordonnancement au tour près. */
function differee<T>() {
  let resoudre!: (v: T) => void;
  let rejeter!: (e: unknown) => void;
  const promesse = new Promise<T>((res, rej) => { resoudre = res; rejeter = rej; });
  return { promesse, resoudre, rejeter };
}

describe("traiterPagesEnPipeline", () => {
  it("traite chaque page une fois, dans l'ordre", async () => {
    const journal: string[] = [];
    const res = await traiterPagesEnPipeline(
      4,
      async (p) => { journal.push(`rendu${p}`); return `img${p}`; },
      async (img, p) => { journal.push(`ocr${p}`); return `${img}->tx${p}`; },
    );

    expect(res).toEqual(["img1->tx1", "img2->tx2", "img3->tx3", "img4->tx4"]);
    expect(journal.filter((e) => e.startsWith("ocr"))).toEqual(["ocr1", "ocr2", "ocr3", "ocr4"]);
    expect(journal.filter((e) => e.startsWith("rendu"))).toEqual(["rendu1", "rendu2", "rendu3", "rendu4"]);
  });

  it("lance le rendu de la page suivante AVANT la fin du traitement courant", async () => {
    // C'est la propriété qui produit le gain de temps : on la vérifie, on ne la
    // suppose pas. `ocr1` est bloqué tant qu'on ne le résout pas à la main ;
    // `rendu2` doit malgré tout avoir démarré.
    const journal: string[] = [];
    const ocr1 = differee<string>();

    const enCours = traiterPagesEnPipeline(
      2,
      async (p) => { journal.push(`rendu${p}`); return `img${p}`; },
      async (_img, p) => {
        journal.push(`ocr${p}:début`);
        if (p === 1) return ocr1.promesse;
        return `tx${p}`;
      },
    );

    // Laisse tourner les microtâches : ocr1 est en vol, non résolu.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(journal).toContain("rendu2");
    expect(journal).not.toContain("ocr2:début"); // le traitement, lui, n'a PAS doublé

    ocr1.resoudre("tx1");
    await expect(enCours).resolves.toEqual(["tx1", "tx2"]);
  });

  it("n'appelle jamais deux traitements en parallèle", async () => {
    let enVol = 0;
    let maxEnVol = 0;
    await traiterPagesEnPipeline(
      5,
      async (p) => `img${p}`,
      async () => {
        enVol++;
        maxEnVol = Math.max(maxEnVol, enVol);
        await new Promise((r) => setTimeout(r, 1));
        enVol--;
        return "ok";
      },
    );
    expect(maxEnVol).toBe(1);
  });

  it("transmet à chaque traitement SA propre image (pas celle de la page 1)", async () => {
    // Régression : oublier de faire avancer le rendu courant rejouerait la même
    // image à chaque tour — toutes les pages produiraient le contenu de la page 1.
    const vues: string[] = [];
    await traiterPagesEnPipeline(
      3,
      async (p) => `img${p}`,
      async (img) => { vues.push(img); return null; },
    );
    expect(vues).toEqual(["img1", "img2", "img3"]);
  });

  it("gère le document d'une seule page", async () => {
    const res = await traiterPagesEnPipeline(1, async () => "img1", async (i) => i);
    expect(res).toEqual(["img1"]);
  });

  it("ne fait rien sur un document vide", async () => {
    let appels = 0;
    const res = await traiterPagesEnPipeline(0, async () => { appels++; return "x"; }, async (i) => i);
    expect(res).toEqual([]);
    expect(appels).toBe(0);
  });

  it("propage l'échec d'un traitement", async () => {
    await expect(
      traiterPagesEnPipeline(
        3,
        async (p) => `img${p}`,
        async (_i, p) => { if (p === 2) throw new Error("OCR page 2 KO"); return "ok"; },
      ),
    ).rejects.toThrow("OCR page 2 KO");
  });

  it("propage l'échec d'un rendu anticipé au tour où il est consommé", async () => {
    await expect(
      traiterPagesEnPipeline(
        3,
        async (p) => { if (p === 3) throw new Error("rendu page 3 KO"); return `img${p}`; },
        async () => "ok",
      ),
    ).rejects.toThrow("rendu page 3 KO");
  });

  it("un rendu anticipé qui échoue pendant un traitement long ne casse pas le tour courant", async () => {
    // Le rejet de rendu(2) survient AVANT la fin de ocr(1) : il doit rester en
    // attente sans provoquer d'unhandled rejection, puis être levé au tour 2.
    const rejets: unknown[] = [];
    const handler = (e: any) => rejets.push(e);
    process.on("unhandledRejection", handler);

    const p = traiterPagesEnPipeline(
      2,
      async (page) => { if (page === 2) throw new Error("rendu 2 KO"); return `img${page}`; },
      async () => { await new Promise((r) => setTimeout(r, 10)); return "ok"; },
    );

    await expect(p).rejects.toThrow("rendu 2 KO");
    await new Promise((r) => setTimeout(r, 20));
    process.off("unhandledRejection", handler);
    expect(rejets).toEqual([]);
  });
});
