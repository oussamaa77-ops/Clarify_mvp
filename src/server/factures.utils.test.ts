import { describe, it, expect } from "vitest";
import { parseInvoiceRegex, correctMontants, buildOcrPrompt, parseReleveMarkdown } from "./factures.utils";

// ─── parseInvoiceRegex ────────────────────────────────────────────────────────

describe("parseInvoiceRegex — ICE", () => {
  it("extrait l'ICE émetteur quand présent", () => {
    const text = "SARL DUPONT\nICE: 123456789012345\nDate: 01/06/2024";
    const r = parseInvoiceRegex(text, "Client SA", "000000000000000");
    expect(r.emetteur_ice).toBe("123456789012345");
  });

  it("préfère l'ICE différent du dossierIce", () => {
    const text = "FOURNISSEUR\nICE: 111111111111111\nClient\nICE: 222222222222222";
    const r = parseInvoiceRegex(text, "Client SA", "222222222222222");
    expect(r.emetteur_ice).toBe("111111111111111");
  });

  it("retourne null si aucun ICE dans le texte", () => {
    const r = parseInvoiceRegex("Facture sans ICE", "Dossier", "000000000000000");
    expect(r.emetteur_ice).toBeNull();
  });

  it("ne détecte pas un ICE de moins de 15 chiffres", () => {
    const r = parseInvoiceRegex("ICE: 12345678901234", "D", "000000000000000");
    expect(r.emetteur_ice).toBeNull();
  });
});

describe("parseInvoiceRegex — extraction des montants", () => {
  it("extrait montant TTC via 'Total TTC'", () => {
    const r = parseInvoiceRegex("Total TTC: 12 000,00", "D", "");
    expect(r.montant_ttc).toBe(12000);
  });

  it("extrait montant TTC via 'Net à payer'", () => {
    const r = parseInvoiceRegex("Net à payer: 5 750,00", "D", "");
    expect(r.montant_ttc).toBe(5750);
  });

  it("extrait montant HT via 'Total HT'", () => {
    const r = parseInvoiceRegex("Total HT: 10 000,00", "D", "");
    expect(r.montant_ht).toBe(10000);
  });

  it("extrait TVA via 'TVA 20%'", () => {
    const r = parseInvoiceRegex("TVA 20%: 2 000,00", "D", "");
    expect(r.montant_tva).toBe(2000);
  });

  it("accepte les montants avec point décimal", () => {
    const r = parseInvoiceRegex("Total TTC: 1200.00", "D", "");
    expect(r.montant_ttc).toBe(1200);
  });

  it("retourne 0 si aucun montant trouvé", () => {
    const r = parseInvoiceRegex("Facture sans montants", "D", "");
    expect(r.montant_ttc).toBe(0);
    expect(r.montant_ht).toBe(0);
    expect(r.montant_tva).toBe(0);
  });
});

describe("parseInvoiceRegex — dérivation des montants manquants", () => {
  it("dérive TVA depuis TTC et HT", () => {
    const r = parseInvoiceRegex("Total HT: 1000,00\nTotal TTC: 1200,00", "D", "");
    expect(r.montant_tva).toBe(200);
  });

  it("dérive HT depuis TTC et TVA", () => {
    const r = parseInvoiceRegex("Total TTC: 1200,00\nTVA 20%: 200,00", "D", "");
    expect(r.montant_ht).toBe(1000);
  });

  it("dérive HT et TVA depuis TTC seul (taux 20% par défaut)", () => {
    const r = parseInvoiceRegex("Total TTC: 1200,00", "D", "");
    expect(r.montant_ht).toBeCloseTo(1000, 1);
    expect(r.montant_tva).toBeCloseTo(200, 1);
  });
});

describe("parseInvoiceRegex — numéro de facture", () => {
  it("extrait le numéro via 'Facture N°'", () => {
    const r = parseInvoiceRegex("Facture N° FAC-2024-001\nTotal HT: 100", "D", "");
    expect(r.numero_facture).toBe("FAC-2024-001");
  });

  it("extrait via 'N° Facture:'", () => {
    const r = parseInvoiceRegex("N° Facture: 2024/123", "D", "");
    expect(r.numero_facture).toBe("2024/123");
  });

  it("retourne null si aucun numéro", () => {
    const r = parseInvoiceRegex("Facture sans numéro", "D", "");
    expect(r.numero_facture).toBeNull();
  });
});

describe("parseInvoiceRegex — dates", () => {
  it("parse une date DD/MM/YYYY", () => {
    const r = parseInvoiceRegex("Date: 15/06/2024", "D", "");
    expect(r.date_facture).toBe("2024-06-15");
  });

  it("parse une date YYYY-MM-DD", () => {
    const r = parseInvoiceRegex("Date: 2024-06-15", "D", "");
    expect(r.date_facture).toBe("2024-06-15");
  });

  it("assigne la première date à date_facture et la deuxième à date_echeance", () => {
    const r = parseInvoiceRegex("Date: 01/06/2024\nÉchéance: 30/06/2024", "D", "");
    expect(r.date_facture).toBe("2024-06-01");
    expect(r.date_echeance).toBe("2024-06-30");
  });

  it("ignore les dates avec année < 2000", () => {
    const r = parseInvoiceRegex("Date: 01/06/1999", "D", "");
    expect(r.date_facture).toBeNull();
  });

  it("retourne null si aucune date", () => {
    const r = parseInvoiceRegex("Facture sans date", "D", "");
    expect(r.date_facture).toBeNull();
  });
});

describe("parseInvoiceRegex — mode de règlement", () => {
  it("détecte 'virement'", () => {
    const r = parseInvoiceRegex("Paiement par virement bancaire", "D", "");
    expect(r.mode_reglement).toBe("virement");
  });

  it("détecte 'cheque'", () => {
    const r = parseInvoiceRegex("Règlement par chèque", "D", "");
    expect(r.mode_reglement).toBe("cheque");
  });

  it("détecte 'especes'", () => {
    const r = parseInvoiceRegex("Paiement en espèces", "D", "");
    expect(r.mode_reglement).toBe("especes");
  });

  it("détecte 'carte'", () => {
    const r = parseInvoiceRegex("Paiement par carte bancaire", "D", "");
    expect(r.mode_reglement).toBe("carte");
  });

  it("retourne 'virement' par défaut si absent", () => {
    const r = parseInvoiceRegex("Facture sans mode de paiement", "D", "");
    expect(r.mode_reglement).toBe("virement");
  });
});

describe("parseInvoiceRegex — confidence score", () => {
  it("confidence 'high' avec TTC + HT + date + ICE + numéro", () => {
    const text = [
      "SARL FOURNISSEUR",
      "ICE: 123456789012345",
      "Facture N° FAC-001",
      "Date: 01/06/2024",
      "Total HT: 10000,00",
      "TVA 20%: 2000,00",
      "Total TTC: 12000,00",
    ].join("\n");
    const r = parseInvoiceRegex(text, "CLIENT SA", "000000000000000");
    expect(r.confidence).toBe("high");
  });

  it("confidence 'medium' avec TTC + date seulement", () => {
    const r = parseInvoiceRegex("Date: 01/06/2024\nTotal TTC: 1200,00", "D", "");
    expect(r.confidence).toBe("medium");
  });

  it("confidence 'low' sans montant ni date", () => {
    const r = parseInvoiceRegex("Texte quelconque", "D", "");
    expect(r.confidence).toBe("low");
  });
});

describe("parseInvoiceRegex — nom émetteur", () => {
  it("extrait le nom avant l'ICE", () => {
    const text = "SARL ALPHA SERVICES\nRC: 12345\nICE: 123456789012345\n";
    const r = parseInvoiceRegex(text, "Client", "000000000000000");
    expect(r.emetteur_nom).toBe("SARL ALPHA SERVICES");
  });

  it("ignore les lignes commençant par un chiffre", () => {
    const text = "12 Rue Quelconque\nBONNE SOCIÉTÉ\nICE: 123456789012345";
    const r = parseInvoiceRegex(text, "Client", "000000000000000");
    expect(r.emetteur_nom).toBe("BONNE SOCIÉTÉ");
  });
});

// ─── correctMontants ──────────────────────────────────────────────────────────

describe("correctMontants — HT + TTC déclarés (priorité facture)", () => {
  it("garde HT et TTC tels quels, dérive TVA par soustraction", () => {
    const r = correctMontants({ montant_ht: 1000, montant_tva: 0, montant_ttc: 1200, taux_tva: null });
    expect(r.montant_ht).toBe(1000);
    expect(r.montant_ttc).toBe(1200);
    expect(r.montant_tva).toBe(200);
  });

  it("dérive TVA à 70 par soustraction (taux 7%)", () => {
    const r = correctMontants({ montant_ht: 1000, montant_tva: 0, montant_ttc: 1070, taux_tva: null });
    expect(r.montant_ht).toBe(1000);
    expect(r.montant_ttc).toBe(1070);
    expect(r.montant_tva).toBe(70);
  });

  it("dérive TVA même si le taux n'est pas un taux marocain standard", () => {
    const r = correctMontants({ montant_ht: 1000, montant_tva: 0, montant_ttc: 1250, taux_tva: null });
    expect(r.montant_ht).toBe(1000);
    expect(r.montant_ttc).toBe(1250);
    expect(r.montant_tva).toBe(250);
  });

  it("ne touche pas à TVA si elle est déjà renseignée", () => {
    const r = correctMontants({ montant_ht: 1000, montant_tva: 200, montant_ttc: 1200, taux_tva: 20 });
    expect(r.montant_tva).toBe(200);
    expect(r.montant_ht).toBe(1000);
    expect(r.montant_ttc).toBe(1200);
  });
});

describe("correctMontants — dérivation TTC depuis HT + taux", () => {
  it("calcule TTC depuis HT + taux 20%", () => {
    const r = correctMontants({ montant_ht: 1000, montant_tva: 0, montant_ttc: 0, taux_tva: 20 });
    expect(r.montant_tva).toBe(200);
    expect(r.montant_ttc).toBe(1200);
  });

  it("calcule TTC depuis HT + taux 10%", () => {
    const r = correctMontants({ montant_ht: 500, montant_tva: 0, montant_ttc: 0, taux_tva: 10 });
    expect(r.montant_tva).toBe(50);
    expect(r.montant_ttc).toBe(550);
  });

  it("utilise 20% si le taux fourni n'est pas dans les taux marocains valides", () => {
    const r = correctMontants({ montant_ht: 1000, montant_tva: 0, montant_ttc: 0, taux_tva: 15 });
    expect(r.taux_tva).toBe(20);
  });
});

describe("correctMontants — dérivation HT depuis TTC + taux", () => {
  it("calcule HT depuis TTC + taux 20%", () => {
    const r = correctMontants({ montant_ht: 0, montant_tva: 0, montant_ttc: 1200, taux_tva: 20 });
    expect(r.montant_ht).toBeCloseTo(1000, 1);
    expect(r.montant_tva).toBeCloseTo(200, 1);
  });

  it("calcule HT depuis TTC + taux 7%", () => {
    const r = correctMontants({ montant_ht: 0, montant_tva: 0, montant_ttc: 1070, taux_tva: 7 });
    expect(r.montant_ht).toBeCloseTo(1000, 1);
  });
});

describe("correctMontants — cas sans correction", () => {
  it("ne modifie pas si tout est déjà cohérent", () => {
    const r = correctMontants({ montant_ht: 1000, montant_tva: 200, montant_ttc: 1200, taux_tva: 20 });
    expect(r.montant_ht).toBe(1000);
    expect(r.montant_tva).toBe(200);
    expect(r.montant_ttc).toBe(1200);
  });

  it("ne modifie pas si tous les montants sont 0", () => {
    const r = correctMontants({ montant_ht: 0, montant_tva: 0, montant_ttc: 0, taux_tva: null });
    expect(r.montant_ttc).toBe(0);
  });
});

// ─── buildOcrPrompt — tests d'intégration sur les règles ─────────────────────

describe("buildOcrPrompt — règles présentes (intégration)", () => {
  const promptText = buildOcrPrompt("Dossier SA", "123456789012345", null);
  const promptTextMode = buildOcrPrompt("Dossier SA", "123456789012345", "Texte facture test");

  it("contient la règle priorité bloc totaux", () => {
    expect(promptText).toContain("extrais prioritairement les montants écrits dans le bloc totaux");
  });

  it("contient l'interdiction de recalculer", () => {
    expect(promptText).toContain("ne recalcule JAMAIS");
  });

  it("contient la règle LIGNES DE DÉTAIL en HT", () => {
    expect(promptText).toContain("LIGNES DE DÉTAIL");
    expect(promptText).toContain("Hors Taxes (HT)");
  });

  it("contient la règle NOMS ILLISIBLES → null", () => {
    expect(promptText).toContain("NOMS ILLISIBLES");
    expect(promptText).toContain("renvoie null pour ce champ");
    expect(promptText).toContain("n'invente pas un nom");
  });

  it("mentionne CamScanner et tampon pour les noms illisibles", () => {
    expect(promptText).toContain("CamScanner");
    expect(promptText).toContain("tampon");
  });

  it("le mode image mentionne que P.U. est HT par défaut", () => {
    expect(promptText).toContain("P.U. HT");
    expect(promptText).toContain("P.U. TTC");
  });

  it("le mode image ne demande plus de vérifier les totaux mathématiquement", () => {
    expect(promptText).not.toContain("montant_ttc = montant_ht + montant_tva");
  });

  it("le mode texte injecte le texte de la facture", () => {
    expect(promptTextMode).toContain("TEXTE FACTURE:");
    expect(promptTextMode).toContain("Texte facture test");
  });

  it("le mode image inclut les instructions LECTURE IMAGE SCANNÉE", () => {
    expect(promptText).toContain("INSTRUCTIONS LECTURE IMAGE SCANNÉE");
  });

  it("contient la règle acompte — deux montants distincts", () => {
    expect(promptText).toContain("RÈGLES CRITIQUES POUR FACTURE ACOMPTE");
    expect(promptText).toContain("NE JAMAIS mettre le montant total commande dans montant_ttc");
  });

  it("contient le template JSON EXACT", () => {
    expect(promptText).toContain("JSON EXACT");
    expect(promptText).toContain("prix_unitaire_ht");
  });

  // Bordereaux et attestations d'organismes sociaux / publics (CNSS, DGI, CIMR, AMO) :
  // sans ces règles, l'OCR classe le document en "recu", prend l'employeur pour le
  // tiers et reconstitue une TVA de 20 % sur des cotisations qui en sont exonérées.
  it("classe les documents d'organismes sociaux en quittance_cnss, jamais en reçu/facture", () => {
    expect(promptText).toContain("ORGANISMES SOCIAUX ET PUBLICS");
    expect(promptText).toContain("ATTESTATION DE\n     TELE-REGLEMENT DES COTISATIONS");
    expect(promptText).toContain('type_document_justificatif = "quittance_cnss"');
    expect(promptText).toContain('(JAMAIS "recu", JAMAIS "facture")');
    expect(promptText).toContain('"quittance_dgi"');
  });

  it("impose l'organisme comme tiers et interdit le nom de l'employeur", () => {
    expect(promptText).toContain("IDENTIFICATION DE L'EMPLOYEUR");
    expect(promptText).toContain("JAMAIS l'émetteur");
    expect(promptText).toContain('sens_facture = "fournisseur"');
  });

  it("impose l'absence de TVA et HT = TTC sur les cotisations", () => {
    expect(promptText).toContain("montant_tva = 0 ET taux_tva = 0");
    expect(promptText).toContain('montant_ht = montant_ttc = "MONTANT TOTAL');
    expect(promptText).toContain("Ne JAMAIS reconstituer une TVA");
  });

  it("impose la colonne « Total dû » pour les lignes de cotisation", () => {
    expect(promptText).toContain('colonne "TOTAL DÛ"');
    expect(promptText).toContain("part ouvrière + part patronale");
    expect(promptText).toContain("NE PAS prendre l'assiette");
  });

  it("impose le compte 6174 et interdit les comptes d'assurance pour CNSS / AMO", () => {
    expect(promptText).toContain('categorie_pcm = "charges_sociales" ET compte_pcm =\n     "6174"');
    expect(promptText).toContain("INTERDIT pour la CNSS et l'AMO");
    expect(promptText).toContain("L'AMO est une cotisation sociale, PAS une assurance privée");
  });

  it("priorise la date de transmission et le n° de mandat", () => {
    expect(promptText).toContain('date = "Date de Transmission"');
    expect(promptText).toContain("Date d'Exécution du Prélèvement");
    expect(promptText).toContain("CNSS-DECE-2025-XXXX");
    expect(promptText).toContain("Période de Cotisation");
  });

  it("distingue toujours la CNCA (banque) de la CNSS", () => {
    expect(promptText).toContain('La "CAISSE NATIONALE DE CRÉDIT AGRICOLE" (CNCA) est une BANQUE');
  });

  it("mentionne la société gérée dans le prompt", () => {
    expect(promptText).toContain("Dossier SA");
    expect(promptText).toContain("123456789012345");
  });
});

// ─── parseReleveMarkdown — solde de fin « SOLDE AU <date> » ───────────────────
// Crédit Agricole, Saham, CIH… : la ligne de solde de fin porte sa date DANS le
// libellé et n'a ni date d'opération ni référence en colonne. Elle ne doit JAMAIS
// être comptée comme une transaction, mais alimenter solde_final.

const HEADER = [
  "| Date | Référence | Libellé | Débit | Crédit | Solde |",
  "| --- | --- | --- | --- | --- | --- |",
];

describe("parseReleveMarkdown — SOLDE AU <date> en fin de tableau", () => {
  it("« SOLDE AU <date> » nu → solde_final, pas une transaction", () => {
    const md = [
      ...HEADER,
      "| 05/12/2024 | REF1 | ACHAT CARTE MAGASIN | 200,00 |  | 12 700,00 |",
      "| 10/12/2024 | REF2 | VIREMENT RECU SALAIRE |  | 500,00 | 13 200,00 |",
      "| SOLDE AU 31/12/2024 |  |  |  |  | 12 500,00 |",
    ].join("\n");
    const r = parseReleveMarkdown(md);
    expect(r.solde_final).toBe(12500);
    expect(r.txs.length).toBe(2);
    expect(r.txs.some((t) => /solde/i.test(t.libelle))).toBe(false);
  });

  it("« SOLDE A REPORTER AU <date> » avec date en colonne → jamais une transaction", () => {
    const md = [
      ...HEADER,
      "| 05/12/2024 | REF1 | ACHAT | 200,00 |  | 12 700,00 |",
      "| 31/12/2024 |  | SOLDE A REPORTER AU 31/12/2024 |  |  | 12 500,00 |",
    ].join("\n");
    const r = parseReleveMarkdown(md);
    expect(r.solde_final).toBe(12500);
    expect(r.txs.length).toBe(1);
    expect(r.txs.some((t) => /solde/i.test(t.libelle))).toBe(false);
  });

  it("« SOLDE AU <date> » AVANT toute transaction → solde_initial (ouverture)", () => {
    const md = [
      ...HEADER,
      "| SOLDE AU 01/12/2024 |  |  |  |  | 12 000,00 |",
      "| 05/12/2024 | REF1 | ACHAT | 200,00 |  | 11 800,00 |",
      "| SOLDE AU 31/12/2024 |  |  |  |  | 11 800,00 |",
    ].join("\n");
    const r = parseReleveMarkdown(md);
    expect(r.solde_initial).toBe(12000);
    expect(r.solde_final).toBe(11800);
    expect(r.txs.length).toBe(1);
  });
});
