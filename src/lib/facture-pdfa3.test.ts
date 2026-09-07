import { describe, expect, it } from "vitest";
import { PDFDocument, PDFDict, PDFName, PDFArray, PDFHexString } from "pdf-lib";
import { construirePdfA3 } from "./facture-pdfa3";
import { construireUblXml, type FactureUbl } from "./ubl-invoice";
import { construireProfilSrgb } from "./icc-srgb";
import { genererQrPng } from "./facture-qrcode";
import { calculerHashFacture } from "./invoice-hash";

const SECRET = "clef-de-test-suffisamment-longue";

const FACTURE: FactureUbl = {
  numero: "FA-2026-0042",
  date_facture: "2026-08-17",
  date_echeance: "2026-09-16",
  lignes: [
    { designation: "Prestation de conseil", quantite: 10, prix_unitaire: 1500, taux_tva: 20 },
    { designation: "Fournitures de bureau", quantite: 4, prix_unitaire: 250, taux_tva: 7 },
  ],
  vendeur: {
    nom: "DIGITAL SOLUTIONS SARL",
    ice: "001547896000073",
    if_fiscal: "40218963",
    rc: "123456",
    patente: "30185274",
    adresse: "12 rue Ibn Batouta",
    ville: "Casablanca",
    code_postal: "20000",
  },
  acheteur: {
    nom: "SOCIÉTÉ CLIENTE SA",
    ice: "002748193000041",
    if_fiscal: "51907432",
    adresse: "5 avenue Hassan II",
    ville: "Rabat",
  },
};

const XML = construireUblXml(FACTURE);
const HASH = calculerHashFacture(
  {
    numero: FACTURE.numero,
    date_facture: FACTURE.date_facture,
    ice_vendeur: FACTURE.vendeur.ice,
    ice_acheteur: FACTURE.acheteur.ice,
    montant_ttc: 19070,
  },
  SECRET,
);

async function produire(extra: Partial<Parameters<typeof construirePdfA3>[1]> = {}) {
  return construirePdfA3(FACTURE, {
    xmlUbl: XML,
    hashSha256: HASH,
    dgiUuid: "DGI-2026-8F3A21C4",
    statutDgi: "Conforme DGI",
    dateCreation: new Date(2026, 7, 17, 10, 0, 0),
    ...extra,
  });
}

describe("construireProfilSrgb", () => {
  const icc = construireProfilSrgb();
  const vue = new DataView(icc.buffer, icc.byteOffset, icc.byteLength);

  it("annonce dans son en-tête la taille réellement écrite", () => {
    expect(vue.getUint32(0, false)).toBe(icc.length);
  });

  // « acsp » à l'offset 36 est LA signature qui identifie un fichier ICC :
  // sans elle, aucun lecteur ne reconnaît le profil et l'OutputIntent est vide
  // de sens.
  it("porte la signature de fichier ICC", () => {
    const sig = String.fromCharCode(icc[36], icc[37], icc[38], icc[39]);
    expect(sig).toBe("acsp");
  });

  it("se déclare profil moniteur RGB vers l'espace de connexion XYZ", () => {
    const lire = (o: number) => String.fromCharCode(icc[o], icc[o + 1], icc[o + 2], icc[o + 3]);
    expect(lire(12)).toBe("mntr");
    expect(lire(16)).toBe("RGB ");
    expect(lire(20)).toBe("XYZ ");
  });

  it("contient les neuf tags obligatoires d'un profil matriciel", () => {
    const nb = vue.getUint32(128, false);
    const tags: string[] = [];
    for (let i = 0; i < nb; i++) {
      const o = 132 + i * 12;
      tags.push(String.fromCharCode(icc[o], icc[o + 1], icc[o + 2], icc[o + 3]));
    }
    expect(tags).toEqual(expect.arrayContaining(["desc", "wtpt", "rXYZ", "gXYZ", "bXYZ", "rTRC", "gTRC", "bTRC", "cprt"]));
  });

  it("place chaque tag dans les limites du fichier et aligné sur 4 octets", () => {
    const nb = vue.getUint32(128, false);
    for (let i = 0; i < nb; i++) {
      const o = 132 + i * 12;
      const debut = vue.getUint32(o + 4, false);
      const taille = vue.getUint32(o + 8, false);
      expect(debut % 4).toBe(0);
      expect(debut + taille).toBeLessThanOrEqual(icc.length);
    }
  });

  // Un profil daté à l'instant de génération rendrait deux PDF de la même
  // facture différents octet pour octet.
  it("est reproductible à l'octet près", () => {
    expect([...construireProfilSrgb()]).toEqual([...construireProfilSrgb()]);
  });
});

describe("construirePdfA3", () => {
  it("produit un PDF valide et rechargeable", async () => {
    const { pdf } = await produire();
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
    const relu = await PDFDocument.load(pdf);
    expect(relu.getPageCount()).toBe(1);
    expect(relu.getTitle()).toBe("Facture FA-2026-0042");
  });

  it("embarque une police réelle — condition de conformité PDF/A", async () => {
    const { conformite, avertissements } = await produire();
    expect(conformite).toBe("complete");
    expect(avertissements).toEqual([]);
  });

  // Sans `pdfaid:part`, le fichier n'est PAS un PDF/A : c'est un PDF ordinaire
  // qui se trouve bien construit.
  it("déclare PDF/A-3B dans ses métadonnées XMP", async () => {
    const { pdf } = await produire();
    const relu = await PDFDocument.load(pdf);
    const metadata = relu.catalog.lookup(PDFName.of("Metadata"));
    expect(metadata).toBeDefined();
    const xmp = new TextDecoder().decode(pdf);
    expect(xmp).toContain("<pdfaid:part>3</pdfaid:part>");
    expect(xmp).toContain("<pdfaid:conformance>B</pdfaid:conformance>");
  });

  it("annonce la pièce jointe fiscale via un schéma d'extension XMP", async () => {
    const { pdf } = await produire();
    const contenu = new TextDecoder().decode(pdf);
    expect(contenu).toContain("urn:dgi:ma:einvoice:1p0#");
    expect(contenu).toContain("<dgima:DocumentType>INVOICE</dgima:DocumentType>");
    expect(contenu).toContain("<dgima:Version>UBL-2.1</dgima:Version>");
  });

  it("déclare un OutputIntent avec profil ICC embarqué", async () => {
    const { pdf } = await produire();
    const relu = await PDFDocument.load(pdf);
    const intents = relu.catalog.lookup(PDFName.of("OutputIntents"), PDFArray);
    expect(intents.size()).toBe(1);
    const intent = intents.lookup(0, PDFDict);
    // « GTS_PDFA1 » désigne la SÉRIE PDF/A, pas la partie 1 : « GTS_PDFA3 »
    // est une erreur classique qui invalide le fichier.
    expect(intent.get(PDFName.of("S"))?.toString()).toBe("/GTS_PDFA1");
    expect(intent.get(PDFName.of("DestOutputProfile"))).toBeDefined();
  });

  it("porte un identifiant de fichier dans la remorque", async () => {
    const { pdf } = await produire();
    const contenu = new TextDecoder().decode(pdf);
    expect(contenu).toMatch(/\/ID \[ <[0-9A-F]{32}> <[0-9A-F]{32}> \]/);
  });

  // Le cœur de l'hybride : le XML doit être là, entier, et repérable.
  it("embarque le XML UBL comme fichier associé de relation Data", async () => {
    const { pdf } = await produire();
    const relu = await PDFDocument.load(pdf);

    const af = relu.catalog.lookup(PDFName.of("AF"), PDFArray);
    expect(af.size()).toBe(1);
    const specification = af.lookup(0, PDFDict);
    expect(specification.get(PDFName.of("AFRelationship"))?.toString()).toBe("/Data");
    expect(specification.get(PDFName.of("Type"))?.toString()).toBe("/Filespec");

    const names = relu.catalog.lookup(PDFName.of("Names"), PDFDict);
    expect(names.lookup(PDFName.of("EmbeddedFiles"), PDFDict)).toBeDefined();
  });

  it("restitue à l'identique le XML transmis, sans le régénérer", async () => {
    const { pdf } = await produire();
    // Le flux du fichier embarqué est compressé : on le décompresse pour
    // vérifier que c'est bien l'octet transmis à la DGI qui voyage dans le PDF.
    const relu = await PDFDocument.load(pdf);
    const af = relu.catalog.lookup(PDFName.of("AF"), PDFArray);
    const spec = af.lookup(0, PDFDict);
    const ef = spec.lookup(PDFName.of("EF"), PDFDict);
    const flux = ef.lookup(PDFName.of("F")) as any;
    const brut: Uint8Array = flux.getContents();
    const { inflateSync } = await import("node:zlib");
    const xml = new TextDecoder().decode(inflateSync(Buffer.from(brut)));
    expect(xml).toBe(XML);
  });

  // Le nom voyage en chaîne hexadécimale UTF-16BE — c'est la forme normale
  // d'une chaîne de texte PDF, pas de l'ASCII lisible dans le fichier brut.
  it("nomme le fichier embarqué comme demandé", async () => {
    const { pdf } = await produire({ nomFichierXml: "FA-2026-0042-ubl.xml" });
    const relu = await PDFDocument.load(pdf);
    const spec = relu.catalog.lookup(PDFName.of("AF"), PDFArray).lookup(0, PDFDict);
    const nom = spec.lookup(PDFName.of("UF"), PDFHexString).decodeText();
    expect(nom).toBe("FA-2026-0042-ubl.xml");
  });

  it("insère le QR code quand il est fourni", async () => {
    const qr = await genererQrPng({
      numero: FACTURE.numero,
      date_facture: FACTURE.date_facture,
      ice_vendeur: FACTURE.vendeur.ice,
      ice_acheteur: FACTURE.acheteur.ice,
      montant_ttc: 19070,
      montant_tva: 3070,
      dgi_uuid: "DGI-2026-8F3A21C4",
      hash_sha256: HASH,
    });
    const sansQr = await produire();
    const avecQr = await produire({ qrPng: qr });
    expect(avecQr.pdf.length).toBeGreaterThan(sansQr.pdf.length);
    expect(avecQr.avertissements).toEqual([]);
  });

  // Un QR corrompu ne doit pas faire échouer l'émission : l'empreinte reste
  // imprimée en clair et la facture reste juridiquement complète.
  it("émet quand même si le QR est illisible, en le signalant", async () => {
    const { pdf, avertissements } = await produire({ qrPng: new Uint8Array([1, 2, 3, 4]) });
    expect(pdf.length).toBeGreaterThan(0);
    expect(avertissements.join(" ")).toMatch(/QR code illisible/);
  });

  // Le PDF est une page ; le XML porte tout. Perdre des lignes en silence
  // ferait diverger ce que le client lit de ce qui a été déclaré.
  it("signale les lignes qui ne tiennent pas sur la page", async () => {
    const longue: FactureUbl = {
      ...FACTURE,
      lignes: Array.from({ length: 60 }, (_, i) => ({
        designation: `Article ${i + 1}`,
        quantite: 1,
        prix_unitaire: 100,
        taux_tva: 20,
      })),
    };
    const { avertissements } = await construirePdfA3(longue, {
      xmlUbl: construireUblXml(longue),
      dateCreation: new Date(2026, 7, 17),
    });
    expect(avertissements.join(" ")).toMatch(/ligne\(s\) non imprimée\(s\)/);
    expect(avertissements.join(" ")).toMatch(/XML UBL embarqué contient l'intégralité/);
  });

  it("accepte un profil ICC de remplacement", async () => {
    const profil = construireProfilSrgb();
    const { pdf } = await produire({ profilIcc: profil });
    const relu = await PDFDocument.load(pdf);
    expect(relu.catalog.lookup(PDFName.of("OutputIntents"), PDFArray).size()).toBe(1);
  });
});
