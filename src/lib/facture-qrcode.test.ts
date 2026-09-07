import { describe, expect, it } from "vitest";
import {
  construirePayloadQr,
  genererQrDataUrl,
  genererQrPng,
  genererQrSvg,
  lirePayloadQr,
  QR_FORMAT_VERSION,
  type DonneesQrFacture,
} from "./facture-qrcode";
import { calculerHashFacture } from "./invoice-hash";

const SECRET = "clef-de-test-suffisamment-longue";

const DONNEES: DonneesQrFacture = {
  numero: "FA-2026-0042",
  date_facture: "2026-08-17",
  ice_vendeur: "001547896000073",
  ice_acheteur: "002748193000041",
  montant_ttc: 19070,
  montant_tva: 3070,
  dgi_uuid: "DGI-2026-8F3A21C4",
  hash_sha256: calculerHashFacture(
    {
      numero: "FA-2026-0042",
      date_facture: "2026-08-17",
      ice_vendeur: "001547896000073",
      ice_acheteur: "002748193000041",
      montant_ttc: 19070,
    },
    SECRET,
  ),
};

describe("construirePayloadQr", () => {
  it("place l'en-tête de format en tête", () => {
    expect(construirePayloadQr(DONNEES).startsWith(`${QR_FORMAT_VERSION}|`)).toBe(true);
  });

  // Le QR doit annoncer EXACTEMENT ce qui a été haché : un second formatage
  // parallèle des mêmes champs finirait par diverger du premier.
  it("reprend la chaîne canonique du hash telle quelle", () => {
    const payload = construirePayloadQr(DONNEES);
    expect(payload).toContain("|FA-2026-0042|2026-08-17|001547896000073|002748193000041|19070.00|");
  });

  it("porte la TVA, l'UUID DGI et l'empreinte", () => {
    const payload = construirePayloadQr(DONNEES);
    expect(payload).toContain("|3070.00|");
    expect(payload).toContain("|DGI-2026-8F3A21C4|");
    expect(payload.endsWith(DONNEES.hash_sha256)).toBe(true);
  });

  it("laisse le champ UUID vide tant que la DGI n'a pas répondu", () => {
    const payload = construirePayloadQr({ ...DONNEES, dgi_uuid: null });
    expect(payload).toContain("||");
    expect(lirePayloadQr(payload)?.dgi_uuid).toBe("");
  });

  // Au-delà d'environ 200 caractères, la matrice change de version et devient
  // illisible sur une impression laser ordinaire au format retenu (25 mm).
  it("tient sous 200 caractères", () => {
    expect(construirePayloadQr(DONNEES).length).toBeLessThan(200);
  });
});

describe("lirePayloadQr", () => {
  it("fait l'aller-retour sans perte", () => {
    const relu = lirePayloadQr(construirePayloadQr(DONNEES));
    expect(relu).toEqual({
      numero: "FA-2026-0042",
      date_facture: "2026-08-17",
      ice_vendeur: "001547896000073",
      ice_acheteur: "002748193000041",
      montant_ttc: "19070.00",
      montant_tva: "3070.00",
      dgi_uuid: "DGI-2026-8F3A21C4",
      hash_sha256: DONNEES.hash_sha256,
    });
  });

  it("refuse ce qui n'est pas une charge utile du format", () => {
    expect(lirePayloadQr("bonjour")).toBeNull();
    expect(lirePayloadQr("")).toBeNull();
    expect(lirePayloadQr("XX1|a|b|c|d|e|f|g|h|i")).toBeNull();
  });
});

describe("génération d'image", () => {
  it("rend un SVG autonome", async () => {
    const svg = await genererQrSvg(DONNEES);
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
    expect(svg).toContain("viewBox");
  });

  it("rend un PNG reconnaissable à sa signature", async () => {
    const png = await genererQrPng(DONNEES);
    expect(png.length).toBeGreaterThan(100);
    // Signature PNG : 0x89 'P' 'N' 'G'
    expect([...png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("rend une data URL directement affichable", async () => {
    const url = await genererQrDataUrl(DONNEES);
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("survit à un niveau de correction élevé", async () => {
    const png = await genererQrPng(DONNEES, { correction: "H", taille: 512 });
    expect(png.length).toBeGreaterThan(100);
  });
});
