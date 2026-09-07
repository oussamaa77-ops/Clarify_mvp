import { beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DgiEInvoicingService } from "./efacture.service";
import { MockDgiService } from "./dgi.connector";

const SECRET = "clef-de-test-suffisamment-longue";

// ─── Double Supabase ─────────────────────────────────────────────────────────
// Assez de surface pour exercer le service : lire une facture avec ses
// jointures, la mettre à jour, insérer une trace d'audit. `colonnesAbsentes`
// rejoue le cas où la migration n'a pas encore été appliquée à la main.

interface EtatBase {
  facture: Record<string, any>;
  dossier: Record<string, any>;
  client: Record<string, any> | null;
  colonnesAbsentes: string[];
  audit: any[];
  updates: Record<string, any>[];
}

function faireBase(etat: EtatBase): SupabaseClient {
  const lire = () => ({
    ...etat.facture,
    dossiers: etat.dossier,
    clients: etat.client,
  });

  const api: any = {
    from(table: string) {
      if (table === "audit_logs") {
        return { insert: async (row: any) => { etat.audit.push(row); return { error: null }; } };
      }
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: lire(), error: null }),
          }),
        }),
        update: (champs: Record<string, any>) => ({
          eq: async () => {
            const absente = Object.keys(champs).find((c) => etat.colonnesAbsentes.includes(c));
            if (absente) {
              // Message calqué sur celui que renvoie réellement PostgREST.
              return { error: { message: `Could not find the '${absente}' column of 'factures' in the schema cache` } };
            }
            etat.updates.push({ ...champs });
            Object.assign(etat.facture, champs);
            return { error: null };
          },
        }),
      };
    },
  };
  return api as SupabaseClient;
}

function etatInitial(surcharges: Partial<EtatBase> = {}): EtatBase {
  return {
    facture: {
      id: "11111111-1111-4111-8111-111111111111",
      dossier_id: "22222222-2222-4222-8222-222222222222",
      client_id: "33333333-3333-4333-8333-333333333333",
      numero: "FA-2026-0042",
      type: "facture",
      date_facture: "2026-08-17",
      date_echeance: "2026-09-16",
      montant_ht: 15000,
      montant_tva: 3000,
      montant_ttc: 18000,
      lignes: [{ designation: "Conseil", quantite: 10, prix_unitaire: 1500, taux_tva: 20 }],
      dgi_status: "DRAFT",
      dgi_response_payload: [],
    },
    dossier: {
      nom_societe: "DIGITAL SOLUTIONS SARL",
      ice: "001547896000073",
      if_fiscal: "40218963",
      rc: "123456",
      patente: "30185274",
      adresse: "12 rue Ibn Batouta",
    },
    client: {
      nom: "SOCIÉTÉ CLIENTE SA",
      ice: "002748193000041",
      if_fiscal: "51907432",
      adresse: "5 avenue Hassan II",
    },
    colonnesAbsentes: [],
    audit: [],
    updates: [],
    ...surcharges,
  };
}

let compteur = 0;
function connecteur() {
  return new MockDgiService({
    latenceMs: 0,
    genererUuid: () => `00000000-0000-4000-8000-${String(++compteur).padStart(12, "0")}`,
    maintenant: () => new Date("2026-08-17T10:00:00.000Z"),
  });
}

function service(etat: EtatBase, dgi = connecteur()) {
  return new DgiEInvoicingService(faireBase(etat), dgi, SECRET);
}

beforeEach(() => {
  compteur = 0;
});

describe("genererUbl", () => {
  it("valide, scelle et enregistre le document", async () => {
    const etat = etatInitial();
    const r = await service(etat).genererUbl(etat.facture.id);

    expect(r.succes).toBe(true);
    expect(r.hash_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.xml_ubl).toContain("<cbc:ID>FA-2026-0042</cbc:ID>");
    expect(etat.facture.xml_ubl).toBe(r.xml_ubl);
    expect(etat.facture.hash_sha256).toBe(r.hash_sha256);
  });

  // Le snapshot des identités : c'est ce qui rend l'empreinte recalculable
  // même après modification de la fiche client.
  it("fige les identités fiscales sur la facture", async () => {
    const etat = etatInitial();
    await service(etat).genererUbl(etat.facture.id);
    expect(etat.facture).toMatchObject({
      ice_vendeur: "001547896000073",
      if_vendeur: "40218963",
      rc_vendeur: "123456",
      patente_vendeur: "30185274",
      ice_acheteur: "002748193000041",
    });
  });

  it("refuse d'émettre sans ICE vendeur valide", async () => {
    const etat = etatInitial();
    etat.dossier.ice = "123";
    const r = await service(etat).genererUbl(etat.facture.id);
    expect(r.succes).toBe(false);
    expect((r.erreurs as any[]).map((e) => e.champ)).toContain("ice_vendeur");
    expect(etat.facture.xml_ubl).toBeUndefined();
  });

  // Motif de rejet DGI n° 1 : on l'attrape AVANT l'aller-retour réseau.
  it("refuse d'émettre sur une incohérence de totaux, en la chiffrant", async () => {
    const etat = etatInitial();
    etat.facture.montant_ttc = 19000;
    const r = await service(etat).genererUbl(etat.facture.id);
    expect(r.succes).toBe(false);
    const messages = (r.erreurs as any[]).map((e) => e.message).join(" ");
    expect(messages).toMatch(/18000|19000/);
  });

  it("tolère l'absence d'ICE acheteur quand il n'y a pas de client (B2C)", async () => {
    const etat = etatInitial({ client: null });
    const r = await service(etat).genererUbl(etat.facture.id);
    expect(r.succes).toBe(true);
  });

  it("signale RC et patente manquants sans bloquer", async () => {
    const etat = etatInitial();
    delete etat.dossier.rc;
    delete etat.dossier.patente;
    const r = await service(etat).genererUbl(etat.facture.id);
    expect(r.succes).toBe(true);
    expect(r.avertissements.join(" ")).toMatch(/RC du vendeur|Patente/);
  });

  // La migration s'applique à la main : tant qu'elle ne l'est pas, il faut le
  // DIRE, pas planter sur une « erreur inconnue ».
  it("explique quoi faire quand la migration n'est pas encore appliquée", async () => {
    const etat = etatInitial({ colonnesAbsentes: ["ice_vendeur"] });
    const r = await service(etat).genererUbl(etat.facture.id);
    expect(r.succes).toBe(true);
    expect(r.avertissements.join(" ")).toContain("20260817120000_efacture_dgi.sql");
    // Le socle ancien, lui, doit avoir été écrit malgré tout.
    expect(etat.facture.xml_ubl).toBeTruthy();
    expect(etat.facture.hash_sha256).toBeTruthy();
  });
});

describe("transmettre", () => {
  it("transmet une facture conforme et enregistre le récépissé", async () => {
    const etat = etatInitial();
    const r = await service(etat).transmettre(etat.facture.id);

    expect(r.succes).toBe(true);
    expect(r.statut).toBe("VALIDATED_BY_DGI");
    expect(r.dgi_uuid).toBe("00000000-0000-4000-8000-000000000001");
    expect(etat.facture.dgi_status).toBe("VALIDATED_BY_DGI");
    expect(etat.facture.dgi_uuid).toBe(r.dgi_uuid);
    expect(etat.facture.dgi_validated_at).toBe("2026-08-17T10:00:00.000Z");
  });

  // Si le processus meurt pendant l'appel, la facture doit rester « en
  // attente » : la laisser en brouillon la ferait retransmettre, et elle
  // existerait deux fois au fichier fiscal.
  it("passe en PENDING_DGI AVANT d'appeler la plateforme", async () => {
    const etat = etatInitial();
    await service(etat).transmettre(etat.facture.id);
    const statutsEcrits = etat.updates.filter((u) => "dgi_status" in u).map((u) => u.dgi_status);
    expect(statutsEcrits.indexOf("PENDING_DGI")).toBeLessThan(statutsEcrits.indexOf("VALIDATED_BY_DGI"));
    expect(etat.facture.dgi_submission_at).toBeTruthy();
  });

  it("consigne requête ET réponse dans le journal des échanges", async () => {
    const etat = etatInitial();
    await service(etat).transmettre(etat.facture.id);
    const journal = etat.facture.dgi_response_payload as any[];
    const soumission = journal.filter((e) => e.operation === "submitInvoice");
    expect(soumission.map((e) => e.sens)).toEqual(["requete", "reponse"]);
    expect(soumission[0].connecteur).toBe("MockDgiService");
    // Le XML ne se recopie pas dans le journal : il pèse des kilo-octets et
    // vit déjà dans `xml_ubl`.
    expect(soumission[0].payload.xml_ubl).toMatch(/^\[\d+ octets\]$/);
  });

  it("enregistre un rejet DGI sans lever", async () => {
    const etat = etatInitial();
    // ICE valide côté saisie, mais refusé par la plateforme : on force le rejet
    // en cassant les totaux APRÈS le contrôle local, via un connecteur qui a
    // déjà vu ce numéro avec un autre contenu.
    const dgi = connecteur();
    const svc = service(etat, dgi);
    await svc.transmettre(etat.facture.id);

    // Deuxième facture, même numéro, contenu différent → doublon côté DGI.
    const etat2 = etatInitial();
    etat2.facture.montant_ht = 16000;
    etat2.facture.montant_tva = 3200;
    etat2.facture.montant_ttc = 19200;
    etat2.facture.lignes = [{ designation: "Conseil", quantite: 10, prix_unitaire: 1600, taux_tva: 20 }];
    const r = await service(etat2, dgi).transmettre(etat2.facture.id);

    expect(r.succes).toBe(false);
    expect(r.statut).toBe("REJECTED_BY_DGI");
    expect((r.erreurs as any[])[0].code).toBe("DGI-ERR-DOUBLON");
    expect(etat2.facture.dgi_status).toBe("REJECTED_BY_DGI");
  });

  it("refuse de retransmettre une facture déjà validée", async () => {
    const etat = etatInitial();
    const svc = service(etat);
    await svc.transmettre(etat.facture.id);
    const seconde = await svc.transmettre(etat.facture.id);

    expect(seconde.succes).toBe(false);
    expect((seconde.erreurs as any[])[0].code).toBe("ETAT-INTERDIT");
    expect((seconde.erreurs as any[])[0].message).toMatch(/annulez-la puis émettez un avoir/i);
  });

  it("laisse repartir une facture rejetée après correction", async () => {
    const etat = etatInitial();
    etat.facture.dgi_status = "REJECTED_BY_DGI";
    const r = await service(etat).transmettre(etat.facture.id);
    expect(r.succes).toBe(true);
  });

  // Une panne réseau n'est PAS un rejet : la DGI a peut-être reçu et validé.
  it("reste en PENDING_DGI sur incident technique, sans conclure au rejet", async () => {
    const etat = etatInitial();
    const dgi = new MockDgiService({ latenceMs: 0, tauxPanne: 1 });
    const r = await service(etat, dgi).transmettre(etat.facture.id);

    expect(r.succes).toBe(false);
    expect(r.statut).toBe("PENDING_DGI");
    expect((r.erreurs as any[])[0].code).toBe("DGI-INJOIGNABLE");
    expect((r.erreurs as any[])[0].message).toMatch(/plutôt que de la retransmettre/);
    expect(etat.facture.dgi_status).toBe("PENDING_DGI");
  });

  // Sans cette mention, un récépissé simulé est indiscernable d'un vrai.
  it("avertit que le récépissé du bac à sable n'a aucune valeur fiscale", async () => {
    const etat = etatInitial();
    const r = await service(etat).transmettre(etat.facture.id);
    expect(r.avertissements.join(" ")).toMatch(/BAC À SABLE/);
  });

  it("trace la transmission dans le journal d'audit", async () => {
    const etat = etatInitial();
    await service(etat).transmettre(etat.facture.id);
    expect(etat.audit.map((a) => a.action)).toContain("efacture_transmise");
  });

  it("bloque avant tout appel réseau si les identités sont incomplètes", async () => {
    const etat = etatInitial();
    etat.dossier.ice = null;
    const r = await service(etat).transmettre(etat.facture.id);
    expect(r.succes).toBe(false);
    expect(etat.facture.dgi_status).toBe("DRAFT");
  });
});

describe("consulterStatut", () => {
  it("actualise le statut depuis la plateforme", async () => {
    const etat = etatInitial();
    const dgi = connecteur();
    const svc = service(etat, dgi);
    await svc.transmettre(etat.facture.id);

    await dgi.cancelInvoice(etat.facture.dgi_uuid, "Annulation hors application");
    const r = await svc.consulterStatut(etat.facture.id);

    expect(r.statut).toBe("CANCELLED_BY_DGI");
    expect(etat.facture.dgi_status).toBe("CANCELLED_BY_DGI");
  });

  it("refuse poliment quand il n'y a pas encore de récépissé", async () => {
    const etat = etatInitial();
    const r = await service(etat).consulterStatut(etat.facture.id);
    expect(r.succes).toBe(false);
    expect((r.erreurs as any[])[0].code).toBe("SANS-RECEPISSE");
  });
});

describe("annuler", () => {
  it("annule auprès de la DGI et bascule la facture", async () => {
    const etat = etatInitial();
    const svc = service(etat);
    await svc.transmettre(etat.facture.id);
    const r = await svc.annuler(etat.facture.id, "Erreur sur le client destinataire");

    expect(r.succes).toBe(true);
    expect(etat.facture.dgi_status).toBe("CANCELLED_BY_DGI");
    expect(etat.facture.statut).toBe("annulee");
    expect(etat.audit.map((a) => a.action)).toContain("efacture_annulee");
  });

  it("consigne le motif dans le journal", async () => {
    const etat = etatInitial();
    const svc = service(etat);
    await svc.transmettre(etat.facture.id);
    await svc.annuler(etat.facture.id, "Marchandise retournée");
    const journal = etat.facture.dgi_response_payload as any[];
    const requete = journal.find((e) => e.operation === "cancelInvoice" && e.sens === "requete");
    expect(requete.payload.motif).toBe("Marchandise retournée");
  });

  it("ne prétend pas annuler une facture jamais transmise", async () => {
    const etat = etatInitial();
    const r = await service(etat).annuler(etat.facture.id, "Peu importe");
    expect(r.succes).toBe(false);
    expect((r.erreurs as any[])[0].code).toBe("SANS-RECEPISSE");
  });
});

describe("pdfA3", () => {
  it("produit la facture hybride avec son XML et son QR", async () => {
    const etat = etatInitial();
    const svc = service(etat);
    await svc.transmettre(etat.facture.id);
    const r = await svc.pdfA3(etat.facture.id);

    expect(r.nom_fichier).toBe("FA-2026-0042.pdf");
    expect(r.conformite).toBe("complete");
    const pdf = Buffer.from(r.pdf_base64, "base64");
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const contenu = pdf.toString("latin1");
    expect(contenu).toContain("<pdfaid:part>3</pdfaid:part>");
  });

  it("refuse de produire un PDF d'une facture non émettable", async () => {
    const etat = etatInitial();
    etat.dossier.ice = null;
    await expect(service(etat).pdfA3(etat.facture.id)).rejects.toThrow(/non émettable/);
  });

  // Le point le plus important du module : le PDF d'une facture transmise doit
  // montrer CE QUI A ÉTÉ TRANSMIS. Régénérer écraserait l'empreinte d'origine
  // et rendrait la facture invérifiable face à ce que détient la DGI.
  it("rend le document ARCHIVÉ d'une facture scellée, sans rien réécrire", async () => {
    const etat = etatInitial();
    const svc = service(etat);
    await svc.transmettre(etat.facture.id);

    const xmlTransmis = etat.facture.xml_ubl;
    const hashTransmis = etat.facture.hash_sha256;

    // La facture est modifiée APRÈS l'envoi — cas d'une correction indue.
    etat.facture.montant_ttc = 99999;
    etat.facture.lignes = [{ designation: "Gonflé", quantite: 1, prix_unitaire: 83332.5, taux_tva: 20 }];
    etat.updates.length = 0;

    const r = await svc.pdfA3(etat.facture.id);

    expect(r.hash_sha256).toBe(hashTransmis);
    expect(etat.facture.xml_ubl).toBe(xmlTransmis);
    expect(etat.facture.hash_sha256).toBe(hashTransmis);
    // Aucune écriture : afficher n'est pas émettre.
    expect(etat.updates).toEqual([]);
  });

  // Sur un brouillon, en revanche, l'aperçu DOIT sceller : l'empreinte imprimée
  // est celle de l'envoi à venir, sinon le PDF montrerait un sceau périmé.
  it("scelle un brouillon pour que l'aperçu porte la bonne empreinte", async () => {
    const etat = etatInitial();
    const r = await service(etat).pdfA3(etat.facture.id);
    expect(etat.facture.hash_sha256).toBe(r.hash_sha256);
    expect(etat.facture.xml_ubl).toBeTruthy();
  });

  // Produire le PDF est une LECTURE. Y ajouter une ligne de journal à chaque
  // ouverture rendrait l'historique illisible au moment précis où il sert :
  // expliquer un rejet.
  it("n'ajoute aucune entrée au journal — c'est un affichage, pas un échange", async () => {
    const etat = etatInitial();
    const svc = service(etat);
    await svc.transmettre(etat.facture.id);
    const avant = (etat.facture.dgi_response_payload as any[]).length;

    await svc.pdfA3(etat.facture.id);
    await svc.pdfA3(etat.facture.id);

    expect((etat.facture.dgi_response_payload as any[]).length).toBe(avant);
  });

  // L'écran a besoin de ces trois valeurs pour son cartouche sans relire la base.
  it("rend le statut, le récépissé et l'empreinte avec le document", async () => {
    const etat = etatInitial();
    const svc = service(etat);
    await svc.transmettre(etat.facture.id);
    const r = await svc.pdfA3(etat.facture.id);

    expect(r.statut).toBe("VALIDATED_BY_DGI");
    expect(r.dgi_uuid).toBe(etat.facture.dgi_uuid);
    expect(r.hash_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  // Un PDF sorti d'un brouillon doit DIRE qu'il en est un : sans bandeau, il
  // circule comme s'il avait été déclaré.
  it("imprime le statut réel, y compris sur un brouillon", async () => {
    const etat = etatInitial();
    const r = await service(etat).pdfA3(etat.facture.id);
    expect(r.statut).toBe("DRAFT");
    // Le libellé est encodé dans le flux de contenu ; on vérifie qu'un bandeau
    // a bien été demandé en s'assurant que le rendu diffère d'un rendu validé.
    const etatValide = etatInitial();
    const svcValide = service(etatValide);
    await svcValide.transmettre(etatValide.facture.id);
    const valide = await svcValide.pdfA3(etatValide.facture.id);
    expect(valide.pdf_base64).not.toBe(r.pdf_base64);
  });
});


// ─── Document servi au téléchargement et au PDF/A-3 ─────────────────────────

/**
 * Document tel qu'il était archivé AVANT les trois règles DGI — profil
 * `urn:dgi-ma:2026:1.0`, sans `ext:UBLExtensions`, sans identifiants légaux de
 * l'émetteur, sans ventilation de TVA à la racine. C'est ce que porte encore
 * en base toute facture scellée à l'époque, et aucune correction du
 * constructeur ne l'atteint : c'est une DONNÉE.
 */
function xmlAncienBuilder(numero: string, ttc: number): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2">',
    "  <cbc:CustomizationID>DGI-MA:2026:1.0</cbc:CustomizationID>",
    `  <cbc:ID>${numero}</cbc:ID>`,
    "  <cac:AccountingSupplierParty><cac:Party>",
    "    <cac:PartyTaxScheme><cbc:CompanyID>40218963</cbc:CompanyID></cac:PartyTaxScheme>",
    "  </cac:Party></cac:AccountingSupplierParty>",
    '  <cac:TaxTotal><cbc:TaxAmount currencyID="MAD">3000.00</cbc:TaxAmount></cac:TaxTotal>',
    "  <cac:LegalMonetaryTotal>",
    '    <cbc:TaxExclusiveAmount currencyID="MAD">15000.00</cbc:TaxExclusiveAmount>',
    `    <cbc:TaxInclusiveAmount currencyID="MAD">${ttc.toFixed(2)}</cbc:TaxInclusiveAmount>`,
    "  </cac:LegalMonetaryTotal>",
    "</Invoice>",
  ].join("\n");
}

function etatScelleAncien(surcharges: Record<string, any> = {}): EtatBase {
  const etat = etatInitial();
  Object.assign(etat.facture, {
    dgi_status: "VALIDATED_BY_DGI",
    dgi_uuid: "DGI-ANCIEN-0001",
    hash_sha256: "b".repeat(64),
    xml_ubl: xmlAncienBuilder("FA-2026-0042", 18000),
    ...surcharges,
  });
  return etat;
}

describe("documentUbl", () => {
  it("remet au profil DGI courant un document d'un constructeur antérieur", async () => {
    const etat = etatScelleAncien();
    const r = await service(etat).documentUbl(etat.facture.id);

    expect(r.regenere).toBe(true);
    // Les trois règles, dans l'ordre où la DGI les contrôle.
    expect(r.xml_ubl.indexOf("<ext:UBLExtensions>")).toBeGreaterThan(r.xml_ubl.indexOf("<Invoice"));
    expect(r.xml_ubl.slice(r.xml_ubl.indexOf("<Invoice"), r.xml_ubl.indexOf("<ext:UBLExtensions>"))).not.toContain("<cbc:");
    expect(r.xml_ubl).toContain('<cbc:ID schemeID="IF">40218963</cbc:ID>');
    expect(r.xml_ubl).toContain('<cbc:ID schemeID="RC">123456</cbc:ID>');
    expect(r.xml_ubl).toContain("<cac:TaxSubtotal>");
  });

  it("CONSERVE l'empreinte et le récépissé : le scellement reste vérifiable", async () => {
    const etat = etatScelleAncien();
    const r = await service(etat).documentUbl(etat.facture.id);

    expect(r.hash_sha256).toBe("b".repeat(64));
    expect(r.dgi_uuid).toBe("DGI-ANCIEN-0001");
    expect(r.xml_ubl).toContain("<dgi:Empreinte");
    expect(r.xml_ubl).toContain("DGI-ANCIEN-0001");
    // Aucune écriture n'a touché au scellement — seul le rendu est refait.
    for (const maj of etat.updates) {
      expect(maj).not.toHaveProperty("hash_sha256");
      expect(maj).not.toHaveProperty("dgi_uuid");
    }
  });

  it("réécrit le document en base, pour que le PDF et le XML concordent", async () => {
    const etat = etatScelleAncien();
    const r = await service(etat).documentUbl(etat.facture.id);
    expect(etat.facture.xml_ubl).toBe(r.xml_ubl);
    expect(etat.audit.map((a) => a.action)).toContain("efacture_ubl_remis_a_niveau");
  });

  it("rend l'ARCHIVE telle quelle si la facture a bougé depuis sa transmission", async () => {
    // TTC transmis 18000, facture aujourd'hui à 24000 : le document refait ne
    // dirait plus ce qui a été déclaré. C'est l'archive qui fait foi.
    const etat = etatScelleAncien({
      lignes: [{ designation: "Conseil", quantite: 10, prix_unitaire: 2000, taux_tva: 20 }],
      montant_ht: 20000,
      montant_tva: 4000,
      montant_ttc: 24000,
    });
    const r = await service(etat).documentUbl(etat.facture.id);

    expect(r.regenere).toBe(false);
    expect(r.xml_ubl).toBe(etat.facture.xml_ubl);
    expect(r.avertissements.join(" ")).toContain("document TRANSMIS");
  });

  it("rend tel quel un document déjà au profil courant", async () => {
    const etat = etatInitial();
    const genere = await service(etat).genererUbl(etat.facture.id);
    Object.assign(etat.facture, { dgi_status: "VALIDATED_BY_DGI", dgi_uuid: "DGI-COURANT-1" });
    // Le document courant porte déjà l'empreinte ; on le rejoue tel quel.
    const r = await service(etat).documentUbl(etat.facture.id);

    expect(r.regenere).toBe(false);
    expect(r.motifs).toEqual([]);
    expect(r.xml_ubl).toBe(genere.xml_ubl);
  });

  it("construit le document d'un brouillon au lieu de servir une archive absente", async () => {
    const etat = etatInitial();
    const r = await service(etat).documentUbl(etat.facture.id);
    expect(r.statut).toBe("DRAFT");
    expect(r.xml_ubl).toContain("<cbc:ID>FA-2026-0042</cbc:ID>");
  });

  // Le cas qui faisait boucler la reprise en lot : le dossier n'a pas de RC, donc
  // le constructeur n'émet pas la mention (UBL préfère l'absence au vide), donc le
  // contrôle de profil la réclame indéfiniment. Réécrire n'y change rien.
  it("ne réécrit RIEN quand la mention manque dans la FICHE, pas dans le document", async () => {
    const etat = etatInitial();
    delete etat.dossier.rc;
    // Le récépissé est posé AVANT la génération : sans lui, l'archive n'aurait
    // pas son bloc de scellement et se refarait à bon droit — ce n'est pas le
    // cas qu'on éprouve ici.
    etat.facture.dgi_uuid = "DGI-SANS-RC";
    const genere = await service(etat).genererUbl(etat.facture.id);
    etat.facture.dgi_status = "VALIDATED_BY_DGI";
    etat.updates.length = 0;
    etat.audit.length = 0;

    const r = await service(etat).documentUbl(etat.facture.id);

    expect(r.etat).toBe("mentions-absentes");
    expect(r.regenere).toBe(false);
    expect(r.xml_ubl).toBe(genere.xml_ubl);
    expect(r.motifs).toEqual(['PartyIdentification schemeID="RC" (émetteur)']);
    expect(r.avertissements.join(" ")).toContain("absentes de la FICHE");
    // Ni écriture ni trace d'audit : il n'y a rien à corriger dans le document.
    expect(etat.updates).toEqual([]);
    expect(etat.audit.map((a) => a.action)).not.toContain("efacture_ubl_remis_a_niveau");
  });

  it("annonce son état en un mot, pour que la reprise en lot n'ait rien à deviner", async () => {
    const scellee = etatScelleAncien();
    expect((await service(scellee).documentUbl(scellee.facture.id)).etat).toBe("remis-a-niveau");
    expect((await service(scellee).documentUbl(scellee.facture.id)).etat).toBe("conforme");

    const brouillon = etatInitial();
    expect((await service(brouillon).documentUbl(brouillon.facture.id)).etat).toBe("genere");
  });

  it("refuse de SIMULER sur un brouillon plutôt que de le sceller à son insu", async () => {
    const etat = etatInitial();
    await expect(service(etat).documentUbl(etat.facture.id, { persister: false })).rejects.toThrow(
      /Simulation impossible sur une facture non scellée/,
    );
    expect(etat.updates).toEqual([]);
  });

  it("simule sans rien écrire quand on le lui demande", async () => {
    const etat = etatScelleAncien();
    const archive = etat.facture.xml_ubl;
    const r = await service(etat).documentUbl(etat.facture.id, { persister: false });

    expect(r.etat).toBe("remis-a-niveau");
    expect(r.xml_ubl).toContain("<ext:UBLExtensions>");
    // La base est intacte : c'est ce qui permet au script de sauvegarder avant.
    expect(etat.facture.xml_ubl).toBe(archive);
    expect(etat.updates).toEqual([]);
    expect(etat.audit).toEqual([]);
  });

  it("le PDF/A-3 embarque le document remis à niveau, pas l'archive", async () => {
    const etat = etatScelleAncien();
    const r = await service(etat).pdfA3(etat.facture.id);

    // Le flux du fichier embarqué est compressé : on le décompresse pour lire
    // ce qui voyage RÉELLEMENT dans le PDF hybride.
    const [{ PDFDocument, PDFName, PDFArray, PDFDict }, { inflateSync }] = await Promise.all([
      import("pdf-lib"),
      import("node:zlib"),
    ]);
    const doc = await PDFDocument.load(Buffer.from(r.pdf_base64, "base64"));
    const spec = doc.catalog.lookup(PDFName.of("AF"), PDFArray).lookup(0, PDFDict);
    const flux = spec.lookup(PDFName.of("EF"), PDFDict).lookup(PDFName.of("F")) as any;
    const xml = new TextDecoder().decode(inflateSync(Buffer.from(flux.getContents())));

    expect(xml).toContain("<ext:UBLExtensions>");
    expect(xml).toContain('<cbc:ID schemeID="RC">123456</cbc:ID>');
    expect(xml).not.toContain("DGI-MA:2026:1.0");
    // Le XML embarqué et celui qu'on télécharge sont le MÊME document.
    expect(xml).toBe(etat.facture.xml_ubl);
  });
});
