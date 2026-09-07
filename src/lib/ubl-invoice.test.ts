import { describe, expect, it } from "vitest";
import {
  baseLigne,
  codeTypeDocument,
  construireUblXml,
  controlerTotaux,
  codePaiementUbl,
  CODE_PAIEMENT_UNCL4461,
  echapperXml,
  encoderXmlUtf8,
  controlerProfilUbl,
  lireTotauxUbl,
  reparerMojibake,
  scellementXml,
  tauxReconnu,
  totauxFacture,
  ventilerParTaux,
  DGI_SCELLEMENT_NAMESPACE,
  DGI_TAX_SCHEME_ID,
  PEPPOL_TAX_SCHEME_ID,
  UBL_EXT_NAMESPACE,
  type FactureUbl,
  type LigneUbl,
} from "./ubl-invoice";

const VENDEUR = {
  nom: "DIGITAL SOLUTIONS SARL",
  ice: "001547896000073",
  if_fiscal: "40218963",
  rc: "123456",
  patente: "30185274",
  adresse: "12 rue Ibn Batouta",
  ville: "Casablanca",
  code_postal: "20000",
  email: "contact@digital.ma",
};

const ACHETEUR = {
  nom: "SOCIETE CLIENTE SA",
  ice: "002748193000041",
  if_fiscal: "51907432",
  adresse: "5 avenue Hassan II",
  ville: "Rabat",
};

function facture(lignes: LigneUbl[], extra: Partial<FactureUbl> = {}): FactureUbl {
  return {
    numero: "FA-2026-0042",
    date_facture: "2026-08-17",
    date_echeance: "2026-09-16",
    lignes,
    vendeur: VENDEUR,
    acheteur: ACHETEUR,
    ...extra,
  };
}

/**
 * Isole le `cac:TaxTotal` DU DOCUMENT. Chaque `InvoiceLine` en porte un aussi :
 * prendre le premier ou le dernier du XML donne un sous-total de ligne, dont
 * la forme diffère (pas de `cbc:Percent` au niveau du sous-total). Le bloc
 * racine est le seul situé entre le client et les totaux monétaires.
 */
function taxTotalRacine(xml: string): string {
  const entre = xml.slice(
    xml.indexOf("</cac:AccountingCustomerParty>"),
    xml.indexOf("<cac:LegalMonetaryTotal>"),
  );
  return entre.match(/<cac:TaxTotal>[\s\S]*?<\/cac:TaxTotal>/)![0];
}

describe("ventilerParTaux", () => {
  it("regroupe les lignes par taux et ordonne par taux croissant", () => {
    const v = ventilerParTaux([
      { designation: "A", quantite: 1, prix_unitaire: 1000, taux_tva: 20 },
      { designation: "B", quantite: 2, prix_unitaire: 500, taux_tva: 7 },
      { designation: "C", quantite: 1, prix_unitaire: 300, taux_tva: 20 },
    ]);
    expect(v.map((x) => x.taux)).toEqual([7, 20]);
    expect(v[0]).toMatchObject({ base_ht: 1000, montant_tva: 70, categorie: "S" });
    expect(v[1]).toMatchObject({ base_ht: 1300, montant_tva: 260, categorie: "S" });
  });

  // L'ordre de sortie ne doit pas dépendre de l'ordre de saisie, sinon deux
  // saisies de la même facture produiraient deux XML donc deux hashs.
  it("produit la même ventilation quel que soit l'ordre des lignes", () => {
    const a = ventilerParTaux([
      { designation: "A", quantite: 1, prix_unitaire: 100, taux_tva: 20 },
      { designation: "B", quantite: 1, prix_unitaire: 200, taux_tva: 10 },
    ]);
    const b = ventilerParTaux([
      { designation: "B", quantite: 1, prix_unitaire: 200, taux_tva: 10 },
      { designation: "A", quantite: 1, prix_unitaire: 100, taux_tva: 20 },
    ]);
    expect(a).toEqual(b);
  });

  it("classe le taux 0 en catégorie Z avec un motif d'exonération", () => {
    const v = ventilerParTaux([{ designation: "Export", quantite: 1, prix_unitaire: 5000, taux_tva: 0 }]);
    expect(v[0]).toMatchObject({ taux: 0, categorie: "Z", montant_tva: 0 });
    expect(v[0].motif_exoneration).toBeTruthy();
  });

  it("reprend le motif d'exonération porté par la ligne", () => {
    const v = ventilerParTaux([
      { designation: "Export", quantite: 1, prix_unitaire: 5000, taux_tva: 0, motif_exoneration: "Exportation art. 92 CGI" },
    ]);
    expect(v[0].motif_exoneration).toBe("Exportation art. 92 CGI");
  });

  it("couvre les cinq taux marocains sur une même facture", () => {
    const v = ventilerParTaux(
      [0, 7, 10, 14, 20].map((t) => ({ designation: `T${t}`, quantite: 1, prix_unitaire: 1000, taux_tva: t })),
    );
    expect(v.map((x) => x.taux)).toEqual([0, 7, 10, 14, 20]);
    expect(v.map((x) => x.montant_tva)).toEqual([0, 70, 100, 140, 200]);
    expect(v.every((x) => tauxReconnu(x.taux))).toBe(true);
  });
});

describe("totauxFacture", () => {
  it("dérive TTC = HT + TVA par construction", () => {
    const t = totauxFacture([
      { designation: "A", quantite: 3, prix_unitaire: 1250.5, taux_tva: 20 },
      { designation: "B", quantite: 1, prix_unitaire: 400, taux_tva: 7 },
    ]);
    expect(t.total_ht).toBe(4151.5);
    expect(t.total_tva).toBe(778.3); // 3751,50 × 20 % = 750,30 puis 400 × 7 % = 28,00
    expect(t.total_ttc).toBe(4929.8);
    expect(t.total_ttc).toBe(t.total_ht + t.total_tva);
  });

  // Le cœur de la règle d'arrondi : ligne par ligne, 0,015 × 3 arrondis
  // individuellement donnent 0,06 ; sur la base agrégée, 0,05. C'est l'écart
  // d'un centime qui fait rejeter la facture.
  it("arrondit sur la base agrégée du taux, pas ligne par ligne", () => {
    const lignes: LigneUbl[] = Array.from({ length: 3 }, (_, i) => ({
      designation: `L${i}`,
      quantite: 1,
      prix_unitaire: 0.25,
      taux_tva: 7,
    }));
    const sommeArrondisLigne = lignes.reduce((s, l) => s + Math.round(baseLigne(l) * 0.07 * 100) / 100, 0);
    const t = totauxFacture(lignes);
    expect(t.total_tva).toBe(0.05); // 0,75 × 7 % = 0,0525 → 0,05
    expect(sommeArrondisLigne).toBe(0.06); // 3 × 0,02 (0,0175 arrondi)
    expect(t.total_tva).not.toBe(sommeArrondisLigne);
  });

  it("rend des totaux nuls sur une facture sans ligne", () => {
    expect(totauxFacture([])).toEqual({ total_ht: 0, total_tva: 0, total_ttc: 0, ventilation: [] });
  });
});

describe("controlerTotaux", () => {
  const lignes: LigneUbl[] = [{ designation: "A", quantite: 1, prix_unitaire: 1000, taux_tva: 20 }];

  it("accepte des totaux déclarés conformes", () => {
    const r = controlerTotaux(lignes, { total_ht: 1000, total_tva: 200, total_ttc: 1200 });
    expect(r.coherent).toBe(true);
    expect(r.ecarts).toEqual([]);
  });

  it("tolère un centime d'écart d'arrondi", () => {
    const r = controlerTotaux(lignes, { total_ht: 1000, total_tva: 200.01, total_ttc: 1200.01 });
    expect(r.coherent).toBe(true);
  });

  it("signale une TVA déclarée qui ne correspond pas aux lignes", () => {
    const r = controlerTotaux(lignes, { total_ht: 1000, total_tva: 100, total_ttc: 1100 });
    expect(r.coherent).toBe(false);
    expect(r.ecarts.map((e) => e.champ)).toContain("total_tva");
  });

  // Motif de rejet DGI n° 1 : détectable sans même connaître les lignes.
  it("signale la rupture de l'identité HT + TVA = TTC", () => {
    const r = controlerTotaux(lignes, { total_ht: 1000, total_tva: 200, total_ttc: 1500 });
    expect(r.coherent).toBe(false);
    const identite = r.ecarts.find((e) => e.champ === "identite");
    expect(identite).toMatchObject({ calcule: 1200, declare: 1500, ecart: -300 });
  });
});

describe("echapperXml", () => {
  it("échappe les cinq entités prédéfinies", () => {
    expect(echapperXml(`Ets "Ben & Fils" <SARL> l'aîné`)).toBe(
      "Ets &quot;Ben &amp; Fils&quot; &lt;SARL&gt; l&apos;aîné",
    );
  });

  // Un OCR ou un collage depuis un tableur ramène des octets de contrôle
  // invisibles ; laissés en place, le XML n'est pas parsable du tout.
  it("retire les caractères de contrôle interdits par XML 1.0", () => {
    expect(echapperXml("Presta\u0000tion\u001F X")).toBe("Prestation X");
    expect(echapperXml("ligne1\nligne2\tfin")).toBe("ligne1\nligne2\tfin");
  });
});

describe("lireTotauxUbl", () => {
  const xml = construireUblXml(
    facture([
      { designation: "Conseil", quantite: 10, prix_unitaire: 1500, taux_tva: 20 },
      { designation: "Fournitures", quantite: 4, prix_unitaire: 250, taux_tva: 7 },
    ]),
  );

  it("relit les totaux d'un document déjà émis", () => {
    expect(lireTotauxUbl(xml)).toEqual({ total_ht: 16000, total_tva: 3070, total_ttc: 19070 });
  });

  // `cbc:TaxAmount` figure aussi dans chaque ligne et chaque sous-total : la
  // première rencontrée n'est pas celle du document. On dérive donc la TVA.
  it("ne se laisse pas prendre par les TaxAmount des lignes", () => {
    const relu = lireTotauxUbl(xml)!;
    expect(relu.total_tva).toBe(relu.total_ttc - relu.total_ht);
    expect(relu.total_tva).not.toBe(3000); // la TVA de la première ligne
  });

  it("rend null sur un document sans bloc de totaux", () => {
    expect(lireTotauxUbl("<Invoice/>")).toBeNull();
    expect(lireTotauxUbl("")).toBeNull();
  });

  it("fait l'aller-retour avec les totaux calculés", () => {
    const calcules = totauxFacture([{ designation: "A", quantite: 3, prix_unitaire: 1250.5, taux_tva: 20 }]);
    const relu = lireTotauxUbl(
      construireUblXml(facture([{ designation: "A", quantite: 3, prix_unitaire: 1250.5, taux_tva: 20 }])),
    );
    expect(relu).toEqual({
      total_ht: calcules.total_ht,
      total_tva: calcules.total_tva,
      total_ttc: calcules.total_ttc,
    });
  });
});

describe("codeTypeDocument", () => {
  it("associe le bon code UNCL1001", () => {
    expect(codeTypeDocument("facture")).toBe("380");
    expect(codeTypeDocument("avoir")).toBe("381");
    expect(codeTypeDocument("acompte")).toBe("386");
    expect(codeTypeDocument("proforma")).toBe("325");
    expect(codeTypeDocument(undefined)).toBe("380");
  });
});

describe("construireUblXml", () => {
  const xml = construireUblXml(
    facture([
      { designation: "Prestation de conseil", quantite: 10, prix_unitaire: 1500, taux_tva: 20 },
      { designation: "Fournitures", quantite: 4, prix_unitaire: 250, taux_tva: 7 },
    ]),
  );

  it("déclare l'en-tête UBL 2.1 et le profil DGI", () => {
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"');
    expect(xml).toContain("<cbc:UBLVersionID>2.1</cbc:UBLVersionID>");
    expect(xml).toContain("<cbc:CustomizationID>urn:dgi.gov.ma:einvoice:1.0</cbc:CustomizationID>");
  });

  it("porte le numéro, les dates, le type et la devise", () => {
    expect(xml).toContain("<cbc:ID>FA-2026-0042</cbc:ID>");
    expect(xml).toContain("<cbc:IssueDate>2026-08-17</cbc:IssueDate>");
    expect(xml).toContain("<cbc:DueDate>2026-09-16</cbc:DueDate>");
    expect(xml).toContain("<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>");
    expect(xml).toContain("<cbc:DocumentCurrencyCode>MAD</cbc:DocumentCurrencyCode>");
  });

  // L'ICE identifie l'ENTREPRISE, l'IF identifie l'ASSUJETTI à la TVA :
  // les intervertir donne un document bien formé que la DGI n'associe à personne.
  it("place l'ICE en PartyIdentification et l'IF en PartyTaxScheme", () => {
    expect(xml).toContain('<cbc:ID schemeID="ICE">001547896000073</cbc:ID>');
    expect(xml).toContain('<cbc:ID schemeID="ICE">002748193000041</cbc:ID>');
    expect(xml).toMatch(/<cac:PartyTaxScheme>[\s\S]*?<cbc:CompanyID>40218963<\/cbc:CompanyID>/);
    expect(xml).toContain('<cbc:ID schemeID="RC">123456</cbc:ID>');
    expect(xml).toContain('<cbc:ID schemeID="PATENTE">30185274</cbc:ID>');
  });

  // La DGI attend « TVA » là où UNCL5153/PEPPOL attendent « VAT ». Le défaut
  // suit la DGI — c'est elle qui reçoit le document ; le code PEPPOL reste
  // atteignable pour soumettre un XML au validateur public en diagnostic.
  it("porte le code de régime DGI « TVA » par défaut", () => {
    expect(DGI_TAX_SCHEME_ID).toBe("TVA");
    expect(xml).toContain("<cac:TaxScheme><cbc:ID>TVA</cbc:ID></cac:TaxScheme>");
    expect(xml).not.toContain("<cbc:ID>VAT</cbc:ID>");
  });

  it("repasse en « VAT » sur demande, sans laisser un seul « TVA » derrière", () => {
    const x = construireUblXml(
      facture([{ designation: "A", quantite: 1, prix_unitaire: 100, taux_tva: 20 }]),
      { taxSchemeId: PEPPOL_TAX_SCHEME_ID },
    );
    expect(x).toContain("<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>");
    // Un document mi-TVA mi-VAT serait rejeté par les DEUX validateurs.
    expect(x).not.toContain("<cbc:ID>TVA</cbc:ID>");
  });

  // Règle DGI B — CGI art. 145 : l'IF et le RC de l'ÉMETTEUR doivent figurer en
  // mentions légales sur la facture, pas seulement comme numéro d'assujetti.
  it("porte l'IF et le RC de l'émetteur en PartyIdentification (CGI art. 145)", () => {
    const vendeur = xml.match(/<cac:AccountingSupplierParty>[\s\S]*?<\/cac:AccountingSupplierParty>/)![0];
    expect(vendeur).toContain('<cac:PartyIdentification><cbc:ID schemeID="IF">40218963</cbc:ID></cac:PartyIdentification>');
    expect(vendeur).toContain('<cac:PartyIdentification><cbc:ID schemeID="RC">123456</cbc:ID></cac:PartyIdentification>');
    // L'IF reste AUSSI en PartyTaxScheme : les deux emplacements répondent à
    // deux questions distinctes, l'ajout ne déplace rien.
    expect(vendeur).toMatch(/<cac:PartyTaxScheme>[\s\S]*?<cbc:CompanyID>40218963<\/cbc:CompanyID>/);
  });

  // `cac:Party` est une séquence : toutes les `PartyIdentification` viennent
  // avant `PartyName`. Insérer l'IF au mauvais endroit casse le document.
  it("garde les PartyIdentification groupées avant PartyName", () => {
    const vendeur = xml.match(/<cac:AccountingSupplierParty>[\s\S]*?<\/cac:AccountingSupplierParty>/)![0];
    expect(vendeur.lastIndexOf("<cac:PartyIdentification>")).toBeLessThan(vendeur.indexOf("<cac:PartyName>"));
    expect(vendeur.match(/schemeID="(ICE|IF|RC|PATENTE)"/g)).toEqual([
      'schemeID="ICE"',
      'schemeID="IF"',
      'schemeID="RC"',
      'schemeID="PATENTE"',
      'schemeID="RC"', // PartyLegalEntity/CompanyID, en fin de bloc
    ]);
  });

  // Une partie sans IF ne doit pas produire un identifiant vide : UBL préfère
  // l'absence au vide, et un `cbc:ID` vide est un rejet de structure.
  it("omet l'identifiant IF quand la partie n'en a pas", () => {
    const x = construireUblXml(
      facture([{ designation: "A", quantite: 1, prix_unitaire: 100, taux_tva: 20 }], {
        vendeur: { ...VENDEUR, if_fiscal: null },
        acheteur: { ...ACHETEUR, if_fiscal: null },
      }),
    );
    expect(x).not.toContain('schemeID="IF"');
  });

  it("ventile la TVA en un TaxSubtotal par taux", () => {
    const soustotaux = xml.match(/<cac:TaxSubtotal>/g) ?? [];
    // 2 lignes (1 sous-total chacune) + 2 taux au niveau document.
    expect(soustotaux.length).toBe(4);
    expect(xml).toContain('<cbc:TaxableAmount currencyID="MAD">15000.00</cbc:TaxableAmount>');
    expect(xml).toContain('<cbc:TaxableAmount currencyID="MAD">1000.00</cbc:TaxableAmount>');
    expect(xml).toContain('<cbc:TaxAmount currencyID="MAD">3000.00</cbc:TaxAmount>');
    expect(xml).toContain('<cbc:TaxAmount currencyID="MAD">70.00</cbc:TaxAmount>');
  });

  // Règle DGI A. Le contrôle recalcule la taxe taux par taux SUR LE TaxTotal
  // RACINE : un sous-total qui n'aurait pas les quatre éléments (base, taxe,
  // taux, régime) le fait échouer, même si les lignes sont, elles, complètes.
  it("donne à chaque TaxSubtotal racine base, taxe, taux et régime", () => {
    const racine = taxTotalRacine(xml);
    const sousTotaux = racine.match(/<cac:TaxSubtotal>[\s\S]*?<\/cac:TaxSubtotal>/g)!;
    expect(sousTotaux).toHaveLength(2);

    // 7 % d'abord : la ventilation est ordonnée par taux croissant.
    expect(sousTotaux[0]).toContain('<cbc:TaxableAmount currencyID="MAD">1000.00</cbc:TaxableAmount>');
    expect(sousTotaux[0]).toContain('<cbc:TaxAmount currencyID="MAD">70.00</cbc:TaxAmount>');
    expect(sousTotaux[0]).toContain("<cbc:Percent>7.00</cbc:Percent>");
    expect(sousTotaux[0]).toContain("<cac:TaxScheme><cbc:ID>TVA</cbc:ID></cac:TaxScheme>");

    expect(sousTotaux[1]).toContain('<cbc:TaxableAmount currencyID="MAD">15000.00</cbc:TaxableAmount>');
    expect(sousTotaux[1]).toContain('<cbc:TaxAmount currencyID="MAD">3000.00</cbc:TaxAmount>');
    expect(sousTotaux[1]).toContain("<cbc:Percent>20.00</cbc:Percent>");
    expect(sousTotaux[1]).toContain("<cac:TaxScheme><cbc:ID>TVA</cbc:ID></cac:TaxScheme>");

    // La somme des sous-totaux doit égaler la taxe annoncée en tête du bloc.
    expect(racine).toMatch(/<cbc:TaxAmount currencyID="MAD">3070\.00<\/cbc:TaxAmount>/);
  });

  // `cac:TaxSubtotal` est une `xsd:sequence` : Percent APRÈS les montants et
  // AVANT TaxCategory. Bien rempli mais mal ordonné = document invalide.
  it("respecte l'ordre normatif à l'intérieur du TaxSubtotal racine", () => {
    const premier = taxTotalRacine(xml).match(/<cac:TaxSubtotal>[\s\S]*?<\/cac:TaxSubtotal>/)![0];
    const positions = ["<cbc:TaxableAmount", "<cbc:TaxAmount", "<cbc:Percent>", "<cac:TaxCategory>"].map((b) =>
      premier.indexOf(b),
    );
    expect(positions.every((x) => x >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("porte des totaux qui vérifient HT + TVA = TTC", () => {
    expect(xml).toContain('<cbc:TaxExclusiveAmount currencyID="MAD">16000.00</cbc:TaxExclusiveAmount>');
    expect(xml).toContain('<cbc:TaxInclusiveAmount currencyID="MAD">19070.00</cbc:TaxInclusiveAmount>');
    expect(xml).toContain('<cbc:PayableAmount currencyID="MAD">19070.00</cbc:PayableAmount>');
  });

  // UBL est une `xsd:sequence` : l'ordre EST la validité.
  it("respecte l'ordre normatif des éléments d'en-tête", () => {
    const positions = [
      "<cbc:UBLVersionID>",
      "<cbc:CustomizationID>",
      "<cbc:ProfileID>",
      "<cbc:ID>",
      "<cbc:IssueDate>",
      "<cbc:DueDate>",
      "<cbc:InvoiceTypeCode>",
      "<cbc:DocumentCurrencyCode>",
      "<cac:AccountingSupplierParty>",
      "<cac:AccountingCustomerParty>",
      "<cac:TaxTotal>",
      "<cac:LegalMonetaryTotal>",
      "<cac:InvoiceLine>",
    ].map((balise) => xml.indexOf(balise));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("numérote les lignes et reporte quantité, unité et prix unitaire", () => {
    expect(xml).toContain('<cbc:InvoicedQuantity unitCode="C62">10</cbc:InvoicedQuantity>');
    expect(xml).toContain('<cbc:PriceAmount currencyID="MAD">1500.00</cbc:PriceAmount>');
    expect(xml).toContain("<cbc:Name>Prestation de conseil</cbc:Name>");
    expect(xml).toContain("<cbc:LineCountNumeric>2</cbc:LineCountNumeric>");
  });

  it("reporte le hash et l'UUID DGI en références documentaires", () => {
    const x = construireUblXml(
      facture([{ designation: "A", quantite: 1, prix_unitaire: 100, taux_tva: 20 }], {
        hash_sha256: "a".repeat(64),
        dgi_uuid: "DGI-2026-0001",
      }),
    );
    expect(x).toContain("<cbc:DocumentType>HASH-SHA256</cbc:DocumentType>");
    expect(x).toContain("<cbc:DocumentType>DGI-UUID</cbc:DocumentType>");
    expect(x).toContain("<cbc:ID>DGI-2026-0001</cbc:ID>");
  });

  // Règle DGI C. `ext:UBLExtensions` est le premier enfant de `Invoice` : c'est
  // là que la plateforme lit le récépissé et l'empreinte, sans balayer le corps.
  it("injecte le scellement en UBLExtensions, avant toute autre balise", () => {
    const x = construireUblXml(
      facture([{ designation: "A", quantite: 1, prix_unitaire: 100, taux_tva: 20 }], {
        hash_sha256: "a".repeat(64),
        dgi_uuid: "DGI-2026-0001",
      }),
    );
    expect(x).toContain(`xmlns:ext="${UBL_EXT_NAMESPACE}"`);
    expect(x).toContain(`<ext:ExtensionURI>${DGI_SCELLEMENT_NAMESPACE}</ext:ExtensionURI>`);
    expect(x).toContain("<dgi:Recepisse>DGI-2026-0001</dgi:Recepisse>");
    expect(x).toContain(`<dgi:Empreinte algorithme="SHA-256">${"a".repeat(64)}</dgi:Empreinte>`);

    // Ordre : l'extension ouvre le document, avant même UBLVersionID.
    expect(x.indexOf("<ext:UBLExtensions>")).toBeGreaterThan(x.indexOf("<Invoice"));
    expect(x.indexOf("<ext:UBLExtensions>")).toBeLessThan(x.indexOf("<cbc:UBLVersionID>"));
  });

  // Un `ext:UBLExtensions` sans aucun `ext:UBLExtension` est invalide au XSD :
  // sur un brouillon non scellé, mieux vaut ne rien émettre du tout.
  it("n'émet aucun UBLExtensions tant que rien n'est scellé", () => {
    expect(xml).not.toContain("<ext:UBLExtensions>");
    expect(scellementXml(facture([]))).toBe("");
  });

  it("scelle même avant l'attribution du récépissé", () => {
    const x = construireUblXml(
      facture([{ designation: "A", quantite: 1, prix_unitaire: 100, taux_tva: 20 }], {
        hash_sha256: "b".repeat(64),
      }),
    );
    expect(x).toContain("<ext:UBLExtensions>");
    expect(x).toContain("<dgi:Empreinte");
    // Pas de balise vide : le récépissé n'existe qu'après validation DGI.
    expect(x).not.toContain("<dgi:Recepisse>");
  });

  it("référence la facture d'origine sur un avoir", () => {
    const x = construireUblXml(
      facture([{ designation: "Retour", quantite: 1, prix_unitaire: 100, taux_tva: 20 }], {
        type: "avoir",
        facture_origine: "FA-2026-0040",
      }),
    );
    expect(x).toContain("<cbc:InvoiceTypeCode>381</cbc:InvoiceTypeCode>");
    expect(x).toMatch(/<cac:BillingReference>[\s\S]*?<cbc:ID>FA-2026-0040<\/cbc:ID>/);
  });

  it("déclare un motif d'exonération sur le taux 0", () => {
    const x = construireUblXml(
      facture([{ designation: "Export", quantite: 1, prix_unitaire: 5000, taux_tva: 0 }]),
    );
    expect(x).toContain("<cbc:ID>Z</cbc:ID>");
    expect(x).toContain("<cbc:TaxExemptionReason>");
  });

  it("échappe les raisons sociales contenant des caractères réservés", () => {
    const x = construireUblXml(
      facture([{ designation: "A & B <test>", quantite: 1, prix_unitaire: 100, taux_tva: 20 }], {
        vendeur: { ...VENDEUR, nom: "Ets \"Ben & Fils\"" },
      }),
    );
    expect(x).toContain("Ets &quot;Ben &amp; Fils&quot;");
    expect(x).toContain("A &amp; B &lt;test&gt;");
  });

  // Condition du hash d'inaltérabilité : deux appels sur la même facture
  // doivent donner exactement le même octet.
  it("est déterministe", () => {
    const f = facture([{ designation: "A", quantite: 1, prix_unitaire: 100, taux_tva: 20 }]);
    expect(construireUblXml(f)).toBe(construireUblXml(f));
  });

  // Un préfixe non déclaré (`ext:`, `dgi:`) rend le document NON PARSABLE : les
  // `toContain` ci-dessus le laisseraient passer, un vrai parseur non.
  it("produit un document scellé parsable, préfixes déclarés", async () => {
    const { JSDOM } = await import("jsdom");
    const x = construireUblXml(
      facture([{ designation: "A", quantite: 1, prix_unitaire: 100, taux_tva: 20 }], {
        hash_sha256: "c".repeat(64),
        dgi_uuid: "DGI-2026-0009",
      }),
    );
    const doc = new JSDOM(x, { contentType: "text/xml" }).window.document;
    expect(doc.querySelector("parsererror")).toBeNull();
    const empreinte = doc.getElementsByTagNameNS(DGI_SCELLEMENT_NAMESPACE, "Empreinte")[0];
    expect(empreinte?.textContent).toBe("c".repeat(64));
    expect(empreinte?.getAttribute("algorithme")).toBe("SHA-256");
    expect(doc.getElementsByTagNameNS(UBL_EXT_NAMESPACE, "UBLExtension")).toHaveLength(1);
  });

  // Les assertions `toContain` ci-dessus vérifient le CONTENU mais pas la
  // syntaxe : une balise non fermée les passerait toutes. On parse pour de vrai.
  it("produit un XML réellement parsable, y compris avec des accents", async () => {
    const { JSDOM } = await import("jsdom");
    const x = construireUblXml(
      facture([{ designation: "Prestation « clé en main » — Été", quantite: 1, prix_unitaire: 100, taux_tva: 20 }], {
        vendeur: { ...VENDEUR, nom: "Société Générale & Cie" },
      }),
    );
    const doc = new JSDOM(x, { contentType: "text/xml" }).window.document;
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.documentElement.tagName).toBe("Invoice");
    // Les accents doivent survivre au passage, pas être mutilés en entités cassées.
    expect(doc.getElementsByTagName("cbc:Name")[0]?.textContent).toBe("Société Générale & Cie");
  });
});


// ─── Encodage ───────────────────────────────────────────────────────────────

describe("reparerMojibake", () => {
  it("répare un texte doublement encodé", () => {
    expect(reparerMojibake("Ã‰tage 4")).toBe("Étage 4");
    expect(reparerMojibake("SociÃ©tÃ© GÃ©nÃ©rale")).toBe("Société Générale");
  });

  it("répare un double tour d'encodage", () => {
    // « Étage » passé DEUX fois dans le même tuyau mal configuré.
    const deuxTours = Buffer.from(Buffer.from("Étage", "utf8").toString("latin1"), "utf8").toString("latin1");
    expect(reparerMojibake(deuxTours)).toBe("Étage");
  });

  it("laisse intact un texte correct — y compris ses accents", () => {
    for (const texte of ["Étage 4", "Société Générale", "Âge du capitaine", "Français", "معدات", "Ça va"]) {
      expect(reparerMojibake(texte)).toBe(texte);
    }
  });

  it("laisse intact un texte que la réparation rendrait invalide", () => {
    // « Ã » suivi d'un caractère de continuation, mais la suite n'est pas de
    // l'UTF-8 valide : le décodeur strict refuse, donc on ne touche à rien.
    const piege = "\u00C3\u00BF\u00BF";
    expect(reparerMojibake(piege)).toBe(piege);
  });

  it("nettoie les accents à la construction du document", () => {
    const xml = construireUblXml(
      facture([{ designation: "MaintenanceÃ‰quipement", quantite: 1, prix_unitaire: 100, taux_tva: 20 }], {
        vendeur: { ...VENDEUR, adresse: "123, Boulevard Mohammed V, Ã‰tage 4" },
      }),
    );
    expect(xml).toContain("Étage 4");
    expect(xml).not.toContain("Ã‰");
  });
});

describe("encoderXmlUtf8", () => {
  it("sérialise en octets UTF-8, sans marque d'ordre par défaut", () => {
    const octets = encoderXmlUtf8("<a>É</a>");
    expect(Array.from(octets.slice(3, 5))).toEqual([0xc3, 0x89]);
    expect(octets[0]).toBe(0x3c);
  });

  it("pose la marque d'ordre sur demande, une seule fois", () => {
    const avec = encoderXmlUtf8("\uFEFF<a/>", { bom: true });
    expect(Array.from(avec.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(Array.from(avec.slice(3, 6))).toEqual([0x3c, 0x61, 0x2f]);
  });

  it("retire une marque d'ordre déjà présente quand on n'en veut pas", () => {
    expect(encoderXmlUtf8("\uFEFF<a/>")[0]).toBe(0x3c);
  });
});

// ─── Reconnaissance d'un document d'un constructeur antérieur ───────────────

describe("controlerProfilUbl", () => {
  const courant = construireUblXml(
    facture([{ designation: "Audit", quantite: 1, prix_unitaire: 5000, taux_tva: 20 }], {
      hash_sha256: "a".repeat(64),
      dgi_uuid: "DGI-TEST-0001",
    }),
  );

  it("reconnaît un document produit par le constructeur courant", () => {
    expect(controlerProfilUbl(courant, { attendScellement: true })).toEqual({ conforme: true, manquants: [] });
  });

  it("signale les trois blocs absents d'un document d'un constructeur antérieur", () => {
    // Document réellement rencontré en base (profil `urn:dgi-ma:2026:1.0`).
    const ancien = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2">',
      "  <cbc:CustomizationID>DGI-MA:2026:1.0</cbc:CustomizationID>",
      "  <cbc:ID>FAC - 2026 - 001</cbc:ID>",
      "  <cac:AccountingSupplierParty><cac:Party>",
      "    <cac:PartyTaxScheme><cbc:CompanyID>009876543000012</cbc:CompanyID></cac:PartyTaxScheme>",
      "  </cac:Party></cac:AccountingSupplierParty>",
      "  <cac:TaxTotal><cbc:TaxAmount currencyID=\"MAD\">1500.00</cbc:TaxAmount></cac:TaxTotal>",
      "</Invoice>",
    ].join("\n");

    const verdict = controlerProfilUbl(ancien, { attendScellement: true });
    expect(verdict.conforme).toBe(false);
    expect(verdict.manquants).toEqual([
      "ext:UBLExtensions (récépissé + empreinte)",
      'PartyIdentification schemeID="IF" (émetteur)',
      'PartyIdentification schemeID="RC" (émetteur)',
      "cac:TaxSubtotal dans le TaxTotal racine",
      "cac:PaymentMeans (mode de règlement)",
    ]);
  });

  it("ne prend PAS le TaxSubtotal d'une ligne pour celui de la racine", () => {
    const sansRacine = courant.replace(
      taxTotalRacine(courant),
      '<cac:TaxTotal><cbc:TaxAmount currencyID="MAD">1000.00</cbc:TaxAmount></cac:TaxTotal>',
    );
    expect(controlerProfilUbl(sansRacine).manquants).toContain("cac:TaxSubtotal dans le TaxTotal racine");
  });

  it("réclame le mode de règlement sur un document qui n'en porte pas", () => {
    const sansPaiement = courant.replace(/<cac:PaymentMeans>[\s\S]*?<\/cac:PaymentMeans>/, "");
    expect(controlerProfilUbl(sansPaiement, { attendScellement: true }).manquants).toEqual([
      "cac:PaymentMeans (mode de règlement)",
    ]);
  });

  it("refuse un document dont les accents sont doublement encodés", () => {
    const abime = courant.replace("Casablanca", "Ã‰tage 4");
    expect(controlerProfilUbl(abime, { attendScellement: true }).manquants).toContain(
      "caractères doublement encodés (UTF-8 relu en Latin-1)",
    );
  });

  it("refuse un scellement qui n'ouvre pas le document", () => {
    const deplace = courant
      .replace(/<ext:UBLExtensions>[\s\S]*?<\/ext:UBLExtensions>\n/, "")
      .replace("<cbc:ID>", "<ext:UBLExtensions><ext:UBLExtension/></ext:UBLExtensions>\n  <cbc:ID>");
    expect(controlerProfilUbl(deplace, { attendScellement: true }).manquants).toContain(
      "ext:UBLExtensions n'est pas le premier enfant de <Invoice>",
    );
  });

  it("ne réclame le scellement que s'il est attendu", () => {
    const brouillon = construireUblXml(facture([{ designation: "A", quantite: 1, prix_unitaire: 10, taux_tva: 20 }]));
    expect(brouillon).not.toContain("<ext:UBLExtensions>");
    expect(controlerProfilUbl(brouillon).conforme).toBe(true);
  });
});


// ─── Mode de règlement ──────────────────────────────────────────────────────

describe("codePaiementUbl", () => {
  it("traduit les modes de l'application en codes UNCL4461", () => {
    expect(codePaiementUbl("virement")).toMatchObject({ code: "30", libelle: "Virement", parDefaut: false });
    expect(codePaiementUbl("cheque")).toMatchObject({ code: "20", libelle: "Chèque" });
    expect(codePaiementUbl("especes")).toMatchObject({ code: "10", libelle: "Espèces" });
    expect(codePaiementUbl("traite")).toMatchObject({ code: "42", libelle: "Effet / LCN" });
  });

  // « traite », « LCN » et « effet » sont le MÊME instrument : c'est
  // `normaliserMode` qui le sait, et ce module ne redéfinit pas ce vocabulaire.
  it("reconnaît les synonymes du vocabulaire applicatif", () => {
    for (const saisi of ["traite", "TRAITE", "LCN", "effet", "Effet"]) {
      expect(codePaiementUbl(saisi).code).toBe("42");
    }
    for (const saisi of ["CHQ", "Chèque", "cheque"]) expect(codePaiementUbl(saisi).code).toBe("20");
  });

  it("couvre TOUS les modes de l'application — aucun ne doit tomber par défaut", () => {
    for (const [mode, code] of Object.entries(CODE_PAIEMENT_UNCL4461)) {
      const r = codePaiementUbl(mode);
      expect(r.parDefaut).toBe(false);
      expect(r.code).toBe(code);
    }
  });

  it("retombe sur le virement, et le SIGNALE", () => {
    for (const rien of [null, undefined, "", "   ", "autre", "n'importe quoi"]) {
      expect(codePaiementUbl(rien)).toMatchObject({ code: "30", libelle: "Virement", parDefaut: true });
    }
  });
});

describe("construireUblXml — cac:PaymentMeans", () => {
  const avec = (mode?: string | null) =>
    construireUblXml(facture([{ designation: "A", quantite: 1, prix_unitaire: 1000, taux_tva: 20 }], { mode_reglement: mode }));

  it("émet le code et son libellé", () => {
    expect(avec("cheque")).toContain('<cbc:PaymentMeansCode listID="UNCL4461" name="Chèque">20</cbc:PaymentMeansCode>');
  });

  it("déclare le virement quand aucun mode n'est donné", () => {
    expect(avec(null)).toContain('<cbc:PaymentMeansCode listID="UNCL4461" name="Virement">30</cbc:PaymentMeansCode>');
  });

  // Le XSD d'UBL déclare une `xsd:sequence` : PaymentMeans vient APRÈS les
  // parties et AVANT TaxTotal. Ailleurs, le document est invalide bien qu'il
  // contienne tout — d'où un test sur la POSITION, pas seulement la présence.
  it("place le bloc entre l'acheteur et le TaxTotal racine", () => {
    const x = avec("virement");
    const acheteur = x.indexOf("</cac:AccountingCustomerParty>");
    const means = x.indexOf("<cac:PaymentMeans>");
    const taxTotal = x.indexOf(taxTotalRacine(x));
    expect(means).toBeGreaterThan(acheteur);
    expect(means).toBeLessThan(taxTotal);
  });

  it("n'apparaît qu'UNE fois — les lignes n'en portent pas", () => {
    expect(avec("especes").match(/<cac:PaymentMeans>/g)).toHaveLength(1);
  });

  it("reporte l'échéance de règlement, et l'omet quand il n'y en a pas", () => {
    expect(avec("virement")).toContain("<cbc:PaymentDueDate>2026-09-16</cbc:PaymentDueDate>");
    const sansEcheance = construireUblXml(
      facture([{ designation: "A", quantite: 1, prix_unitaire: 10, taux_tva: 20 }], { date_echeance: null }),
    );
    expect(sansEcheance).not.toContain("PaymentDueDate");
    expect(sansEcheance).toContain("<cac:PaymentMeans>");
  });

  it("reste reproductible à l'octet près", () => {
    const f = facture([{ designation: "A", quantite: 1, prix_unitaire: 10, taux_tva: 20 }], { mode_reglement: "traite" });
    expect(construireUblXml(f)).toBe(construireUblXml(f));
  });
});
