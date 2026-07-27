import { describe, it, expect } from "vitest";
import {
  calculerDimensionsCible,
  doitOptimiser,
  octetsVersBase64,
  preparerImagePourOcr,
  OCR_MAX_DIMENSION,
} from "./image-optimize";

describe("calculerDimensionsCible", () => {
  it("ramène le côté long à la cible en gardant le ratio", () => {
    // Photo de téléphone 12 Mpx (4032×3024) → 1800×1350
    const r = calculerDimensionsCible(4032, 3024);
    expect(r.redimensionne).toBe(true);
    expect(r.largeur).toBe(1800);
    expect(r.hauteur).toBe(1350);
    expect(r.largeur / r.hauteur).toBeCloseTo(4032 / 3024, 3);
  });

  it("gère le portrait (c'est la HAUTEUR qui est bornée)", () => {
    const r = calculerDimensionsCible(3024, 4032);
    expect(r.hauteur).toBe(1800);
    expect(r.largeur).toBe(1350);
  });

  it("n'agrandit JAMAIS une image plus petite que la cible", () => {
    const r = calculerDimensionsCible(1200, 800);
    expect(r).toEqual({ largeur: 1200, hauteur: 800, redimensionne: false });
  });

  it("laisse intacte une image pile à la dimension max", () => {
    expect(calculerDimensionsCible(OCR_MAX_DIMENSION, 900).redimensionne).toBe(false);
  });

  it("ne renvoie jamais 0 px sur une bande très allongée", () => {
    const r = calculerDimensionsCible(9000, 3);
    expect(r.largeur).toBe(1800);
    expect(r.hauteur).toBeGreaterThanOrEqual(1);
  });

  it("tolère des dimensions absurdes sans planter", () => {
    expect(calculerDimensionsCible(0, 0).redimensionne).toBe(false);
    expect(calculerDimensionsCible(Number.NaN, 100).redimensionne).toBe(false);
  });
});

describe("doitOptimiser", () => {
  const Mo = 1024 * 1024;

  it("accepte les bitmaps lourds", () => {
    expect(doitOptimiser({ type: "image/jpeg", size: 4 * Mo })).toBe(true);
    expect(doitOptimiser({ type: "image/png", size: 2 * Mo })).toBe(true);
    expect(doitOptimiser({ type: "image/webp", size: 900 * 1024 })).toBe(true);
  });

  it("laisse passer tel quel ce qui est déjà léger", () => {
    // Recompresser 120 Ko ne gagne rien et ajoute des artefacts JPEG.
    expect(doitOptimiser({ type: "image/jpeg", size: 120 * 1024 })).toBe(false);
  });

  it("ne touche ni aux PDF ni aux formats non gérés", () => {
    expect(doitOptimiser({ type: "application/pdf", size: 8 * Mo })).toBe(false);
    expect(doitOptimiser({ type: "image/heic", size: 8 * Mo })).toBe(false);
    expect(doitOptimiser({ type: "image/tiff", size: 8 * Mo })).toBe(false);
    expect(doitOptimiser({ type: "", size: 8 * Mo })).toBe(false);
  });

  it("est insensible à la casse du MIME", () => {
    expect(doitOptimiser({ type: "IMAGE/JPEG", size: 4 * Mo })).toBe(true);
  });
});

describe("octetsVersBase64", () => {
  it("encode comme Buffer.toString('base64')", () => {
    const octets = new Uint8Array([0, 1, 2, 253, 254, 255, 65, 66]);
    expect(octetsVersBase64(octets)).toBe(Buffer.from(octets).toString("base64"));
  });

  it("encode 5 Mo sans débordement de pile (le vrai cas d'usage)", () => {
    const gros = new Uint8Array(5 * 1024 * 1024);
    for (let i = 0; i < gros.length; i++) gros[i] = i % 256;
    expect(octetsVersBase64(gros)).toBe(Buffer.from(gros).toString("base64"));
  });

  it("gère le tableau vide", () => {
    expect(octetsVersBase64(new Uint8Array(0))).toBe("");
  });
});

describe("preparerImagePourOcr — repli sans DOM (SSR / worker)", () => {
  it("renvoie les octets d'origine intacts quand canvas est indisponible", async () => {
    const octets = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const fichier = new File([octets], "facture.png", { type: "image/png" });

    const payload = await preparerImagePourOcr(fichier);

    expect(payload.optimise).toBe(false);
    expect(payload.mimeType).toBe("image/png");
    expect(payload.base64).toBe(Buffer.from(octets).toString("base64"));
    expect(payload.octets).toBe(octets.length);
  });

  it("conserve le MIME d'origine et n'invente pas de type", async () => {
    const fichier = new File([new Uint8Array([1, 2, 3])], "x.bin", { type: "" });
    const payload = await preparerImagePourOcr(fichier);
    expect(payload.mimeType).toBe("image/jpeg"); // défaut explicite du contrat ocrFacture
    expect(payload.optimise).toBe(false);
  });
});
