import { describe, it, expect } from "vitest";
import {
  resolveJustificatifKind,
  justificatifDetails,
  extrairePeriode,
} from "./justificatif-details";

describe("resolveJustificatifKind", () => {
  // La contrainte CHECK en base rabat la plupart des quittances sur "recu" :
  // le type réel doit se retrouver via la catégorie PCM ou le compte comptable.
  it("reconnaît une quittance de loyer stockée en 'recu'", () => {
    expect(resolveJustificatifKind({ type_document: "recu", categorie_pcm: "loyers" }))
      .toBe("quittance_loyer");
    expect(resolveJustificatifKind({ type_document: "recu", compte_pcm: "61312" }))
      .toBe("quittance_loyer");
  });

  it("reconnaît une quittance CNSS par son type, sa catégorie ou son compte 6174", () => {
    expect(resolveJustificatifKind({ type_document: "quittance_cnss" })).toBe("cnss");
    expect(resolveJustificatifKind({ type_document: "recu", categorie_pcm: "cnss_amo" })).toBe("cnss");
    expect(resolveJustificatifKind({ type_document: "recu", categorie_pcm: "charges_sociales" })).toBe("cnss");
    expect(resolveJustificatifKind({ type_document: "recu", compte_pcm: "61741" })).toBe("cnss");
  });

  it("reconnaît une quittance DGI / TGR sans la confondre avec un reçu", () => {
    expect(resolveJustificatifKind({ type_document: "quittance_dgi" })).toBe("dgi");
    expect(resolveJustificatifKind({ type_document: "recu", categorie_pcm: "taxe_professionnelle" })).toBe("dgi");
    expect(resolveJustificatifKind({ type_document: "recu", compte_pcm: "6313" })).toBe("dgi");
  });

  it("distingue bon de livraison, bon de commande et DUM", () => {
    expect(resolveJustificatifKind({ type_document: "bon_livraison" })).toBe("bon_livraison");
    expect(resolveJustificatifKind({ type_document: "bon_commande" })).toBe("bon_commande");
    expect(resolveJustificatifKind({ type_document: "recu", categorie_pcm: "acompte_fournisseur" }))
      .toBe("bon_commande");
    expect(resolveJustificatifKind({ type_document: "dum" })).toBe("dum");
  });

  it("classe eau/électricité, carburant et restauration", () => {
    expect(resolveJustificatifKind({ type_document: "recu", compte_pcm: "6125" })).toBe("energie");
    expect(resolveJustificatifKind({ type_document: "recu", categorie_pcm: "gasoil" })).toBe("carburant");
    expect(resolveJustificatifKind({ type_document: "addition" })).toBe("restauration");
  });

  it("retombe sur facture / reçu sans indice de catégorie", () => {
    expect(resolveJustificatifKind({ type_document: "facture" })).toBe("facture");
    expect(resolveJustificatifKind({ type_document: "recu" })).toBe("recu");
  });
});

describe("extrairePeriode", () => {
  it("lit une période explicite dans la désignation d'une ligne", () => {
    expect(extrairePeriode({ lignes: [{ designation: "Consommation eau — période 03/2026" }] }))
      .toBe("03/2026");
  });

  it("déduit mois/année d'une désignation numérique", () => {
    expect(extrairePeriode({ lignes: [{ designation: "Loyer 04/2026" }] })).toBe("avril 2026");
  });

  it("retombe sur le mois de la date du document", () => {
    expect(extrairePeriode({ date_document: "2026-05-10", lignes: [] })).toBe("mai 2026");
  });

  it("rend null sans ligne ni date", () => {
    expect(extrairePeriode({})).toBeNull();
  });
});

describe("justificatifDetails", () => {
  it("met en avant période et bailleur pour une quittance de loyer", () => {
    const d = justificatifDetails({
      type_document: "quittance_loyer", nom_tiers: "SCI ATLAS",
      numero_piece: "Q-2026-04", montant_ttc: 8000, montant_ht: 8000,
      date_document: "2026-04-01", lignes: [{ designation: "Loyer avril 2026" }],
    });
    expect(d.label).toBe("Quittance loyer");
    expect(d.chips.map(c => c.label)).toEqual(["Période", "Bailleur", "N° quittance", "Loyer"]);
    expect(d.chips[0].value).toBe("avril 2026");
    expect(d.chips[1].value).toBe("SCI ATLAS");
    expect(d.note).toMatch(/RAS IR/);
  });

  it("affiche la période de cotisation et signale le hors champ TVA pour la CNSS", () => {
    const d = justificatifDetails({
      type_document: "recu", categorie_pcm: "cnss_amo", nom_tiers: "CNSS",
      numero_piece: "AFF-99887", montant_ttc: 12500, date_document: "2026-03-31",
    });
    expect(d.kind).toBe("cnss");
    expect(d.chips.map(c => c.label)).toContain("Période de cotisation");
    expect(d.chips.map(c => c.label)).toContain("N° affiliation");
    expect(d.note).toMatch(/hors champ TVA/i);
  });

  it("affiche l'organisme et le hors champ TVA pour une quittance DGI", () => {
    const d = justificatifDetails({
      type_document: "quittance_dgi", nom_tiers: "DGI", numero_piece: "SIMPL-2026-4471",
      montant_ttc: 31200, montant_ht: 31200, date_document: "2026-03-31",
    });
    expect(d.kind).toBe("dgi");
    expect(d.label).toBe("Quittance DGI");
    expect(d.chips.map(c => c.label)).toContain("N° quittance");
    expect(d.note).toMatch(/hors champ TVA/i);
  });

  // Un BL n'a pas de valeur comptable : le montant doit rester non valorisé.
  it("ne valorise pas un bon de livraison et remonte les quantités", () => {
    const d = justificatifDetails({
      type_document: "bon_livraison", numero_piece: "BL-114", numero_commande: "BC-77",
      montant_ttc: 4200, date_document: "2026-02-12",
      lignes: [{ designation: "Ciment", quantite: 10 }, { designation: "Sable", quantite: 5 }],
    });
    expect(d.montant).toBeNull();
    expect(d.chips.find(c => c.label === "Articles livrés")?.value).toBe("15");
    expect(d.chips.find(c => c.label === "Réf. commande")?.value).toBe("BC-77");
    expect(d.chips.some(c => /TVA/.test(c.label))).toBe(false);
  });

  it("expose la TVA import et le n° de quittance douanière sur une DUM", () => {
    const d = justificatifDetails({
      type_document: "dum", numero_piece: "QD-55021",
      montant_ht: 100000, montant_ttc: 120000, date_document: "2026-01-20",
    });
    expect(d.chips.find(c => c.label === "N° quittance douanière")?.value).toBe("QD-55021");
    expect(d.chips.find(c => c.label === "TVA import")?.value).toMatch(/^20[\s .]000,00 MAD$/);
    expect(d.note).toMatch(/Art\. 92/);
  });

  it("signale la TVA non déductible sur carburant et restauration", () => {
    expect(justificatifDetails({ type_document: "recu", categorie_pcm: "gasoil", montant_ttc: 400 }).note)
      .toMatch(/Art\. 106/);
    expect(justificatifDetails({ type_document: "addition", montant_ttc: 650 }).note)
      .toMatch(/Art\. 106/);
  });

  it("garde la lecture HT / TVA / TTC pour une facture ordinaire", () => {
    const d = justificatifDetails({
      type_document: "facture", numero_piece: "FA-9", montant_ht: 1000,
      montant_ttc: 1200, taux_tva: 20, date_document: "2026-06-01",
    });
    expect(d.label).toBe("Facture");
    expect(d.montant).toBe(1200);
    expect(d.chips.map(c => c.label)).toEqual(["N° pièce", "Date", "HT", "TVA 20%"]);
  });
});
