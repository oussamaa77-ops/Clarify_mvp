import { describe, it, expect, afterEach } from "vitest";
import {
  luminance709,
  convertirPixelsEnGris,
  octetsDepuisBase64,
  cumulerMesures,
  grayscaleActif,
  basculerGrayscale,
  CLE_STOCKAGE_GRAYSCALE,
  type MesureGrayscale,
} from "./bank-grayscale";

/** Installe un faux `window` (URL + localStorage) le temps d'un test. */
function installerWindow(recherche = "", stockage: Record<string, string> = {}) {
  (globalThis as any).window = {
    location: { search: recherche },
    localStorage: {
      getItem: (k: string) => (k in stockage ? stockage[k] : null),
      setItem: (k: string, v: string) => { stockage[k] = v; },
      removeItem: (k: string) => { delete stockage[k]; },
    },
  };
  return stockage;
}

afterEach(() => { delete (globalThis as any).window; });

describe("luminance709", () => {
  it("respecte la pondération perceptuelle Rec. 709", () => {
    expect(luminance709(255, 255, 255)).toBe(255);
    expect(luminance709(0, 0, 0)).toBe(0);
    expect(luminance709(255, 0, 0)).toBe(54);  // 0.2126 × 255
    expect(luminance709(0, 255, 0)).toBe(182); // 0.7152 × 255
    expect(luminance709(0, 0, 255)).toBe(18);  // 0.0722 × 255
  });

  it("laisse un gris déjà neutre inchangé", () => {
    for (const v of [0, 17, 64, 128, 200, 255]) expect(luminance709(v, v, v)).toBe(v);
  });
});

describe("convertirPixelsEnGris", () => {
  it("neutralise les trois canaux sans toucher à l'alpha", () => {
    const px = new Uint8ClampedArray([255, 0, 0, 128, 0, 0, 255, 255]);
    convertirPixelsEnGris(px);
    expect(Array.from(px)).toEqual([54, 54, 54, 128, 18, 18, 18, 255]);
  });

  it("ne modifie PAS la dynamique : ni étirement, ni seuillage, ni saturation", () => {
    // Un gris pâle (chiffre matriciel effacé) doit rester pâle — c'est tout
    // l'enjeu : un rehaussement de contraste le ferait disparaître ou saturer.
    const paleClair = new Uint8ClampedArray([235, 235, 235, 255]);
    convertirPixelsEnGris(paleClair);
    expect(paleClair[0]).toBe(235);

    const paleSombre = new Uint8ClampedArray([200, 200, 200, 255]);
    convertirPixelsEnGris(paleSombre);
    expect(paleSombre[0]).toBe(200);

    // L'écart entre l'encre pâle et le fond est CONSERVÉ, pas amplifié.
    expect(235 - 200).toBe(35);
  });

  it("est idempotent (appliqué deux fois = appliqué une fois)", () => {
    const a = new Uint8ClampedArray([12, 200, 77, 255, 4, 4, 250, 10]);
    const b = new Uint8ClampedArray(a);
    convertirPixelsEnGris(a);
    convertirPixelsEnGris(b);
    convertirPixelsEnGris(b);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("laisse une image déjà en gris strictement identique", () => {
    const gris = new Uint8ClampedArray([10, 10, 10, 255, 240, 240, 240, 255]);
    const avant = Array.from(gris);
    convertirPixelsEnGris(gris);
    expect(Array.from(gris)).toEqual(avant);
  });

  it("préserve le nombre de pixels (donc les dimensions)", () => {
    const px = new Uint8ClampedArray(4 * 100);
    convertirPixelsEnGris(px);
    expect(px.length).toBe(400);
  });

  it("gère un buffer vide", () => {
    const px = new Uint8ClampedArray(0);
    expect(() => convertirPixelsEnGris(px)).not.toThrow();
  });
});

describe("octetsDepuisBase64", () => {
  it("retrouve le poids réel, padding compris", () => {
    for (const n of [1, 2, 3, 10, 999, 4096]) {
      const b64 = Buffer.from(new Uint8Array(n)).toString("base64");
      expect(octetsDepuisBase64(b64)).toBe(n);
    }
  });

  it("renvoie 0 sur une chaîne vide", () => {
    expect(octetsDepuisBase64("")).toBe(0);
  });
});

describe("grayscaleActif — résolution du drapeau", () => {
  it("est DÉSACTIVÉ par défaut", () => {
    installerWindow("", {});
    expect(grayscaleActif()).toBe(false);
  });

  it("l'URL ?grayscale=1 l'active immédiatement", () => {
    installerWindow("?grayscale=1");
    expect(grayscaleActif()).toBe(true);
  });

  it("l'URL prime sur le localStorage (retour au flux couleur en un clic)", () => {
    installerWindow("?grayscale=0", { [CLE_STOCKAGE_GRAYSCALE]: "1" });
    expect(grayscaleActif()).toBe(false);
  });

  it("le localStorage persiste la bascule", () => {
    installerWindow("", { [CLE_STOCKAGE_GRAYSCALE]: "1" });
    expect(grayscaleActif()).toBe(true);
  });

  it("basculerGrayscale écrit puis efface l'override", () => {
    const stockage = installerWindow("", {});
    basculerGrayscale(true);
    expect(grayscaleActif()).toBe(true);
    basculerGrayscale(false);
    expect(grayscaleActif()).toBe(false);
    basculerGrayscale(null);
    expect(stockage[CLE_STOCKAGE_GRAYSCALE]).toBeUndefined();
    expect(grayscaleActif()).toBe(false); // retour au défaut de build
  });

  it("ne casse pas si localStorage est inaccessible (navigation privée)", () => {
    (globalThis as any).window = {
      location: { search: "" },
      get localStorage() { throw new Error("accès refusé"); },
    };
    expect(() => grayscaleActif()).not.toThrow();
    expect(grayscaleActif()).toBe(false);
  });

  it("hors navigateur (SSR), retombe sur le défaut de build", () => {
    expect(grayscaleActif()).toBe(false);
  });
});

describe("cumulerMesures", () => {
  const mesure = (o: Partial<MesureGrayscale>): MesureGrayscale => ({
    actif: false, octetsCouleur: 0, octetsGris: null, reductionPct: null,
    msConversion: 0, msEncodageCouleur: 0, msEncodageGris: null, ...o,
  });

  it("agrège le poids et recalcule le gain global", () => {
    const total = cumulerMesures([
      mesure({ actif: true, octetsCouleur: 1000, octetsGris: 900, msConversion: 5 }),
      mesure({ actif: true, octetsCouleur: 1000, octetsGris: 800, msConversion: 5 }),
    ])!;
    expect(total.octetsCouleur).toBe(2000);
    expect(total.octetsGris).toBe(1700);
    expect(total.reductionPct).toBeCloseTo(15, 5);
    expect(total.msConversion).toBe(10);
  });

  it("drapeau OFF : pas de variante gris, pas de pourcentage inventé", () => {
    const total = cumulerMesures([mesure({ octetsCouleur: 500 }), mesure({ octetsCouleur: 700 })])!;
    expect(total.actif).toBe(false);
    expect(total.octetsGris).toBeNull();
    expect(total.reductionPct).toBeNull();
  });

  it("renvoie null sans mesure", () => {
    expect(cumulerMesures([])).toBeNull();
  });
});
