import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MockDgiService,
  obtenirConnecteurDgi,
  reinitialiserConnecteurDgi,
  type DgiSubmitRequest,
} from "./dgi.connector";
import { construireUblXml, type FactureUbl } from "../lib/ubl-invoice";

const FACTURE_UBL: FactureUbl = {
  numero: "FA-2026-0042",
  date_facture: "2026-08-17",
  lignes: [{ designation: "Conseil", quantite: 10, prix_unitaire: 1500, taux_tva: 20 }],
  vendeur: { nom: "DIGITAL SOLUTIONS", ice: "001547896000073", if_fiscal: "40218963" },
  acheteur: { nom: "CLIENTE SA", ice: "002748193000041", if_fiscal: "51907432" },
};

const XML = construireUblXml(FACTURE_UBL);

function requete(extra: Partial<DgiSubmitRequest> = {}): DgiSubmitRequest {
  return {
    invoice_id: "11111111-1111-4111-8111-111111111111",
    numero: "FA-2026-0042",
    date_facture: "2026-08-17",
    ice_vendeur: "001547896000073",
    ice_acheteur: "002748193000041",
    montant_ht: 15000,
    montant_tva: 3000,
    montant_ttc: 18000,
    xml_ubl: XML,
    hash_sha256: "a".repeat(64),
    ...extra,
  };
}

// Latence à 0 : les tests éprouvent le comportement, pas l'horloge.
function service(compteur = { n: 0 }) {
  return new MockDgiService({
    latenceMs: 0,
    genererUuid: () => `00000000-0000-4000-8000-${String(++compteur.n).padStart(12, "0")}`,
    maintenant: () => new Date("2026-08-17T10:00:00.000Z"),
  });
}

describe("MockDgiService.submitInvoice", () => {
  it("accepte une facture conforme et attribue un récépissé", async () => {
    const r = await service().submitInvoice(requete());
    expect(r.accepte).toBe(true);
    expect(r.statut).toBe("VALIDATED_BY_DGI");
    expect(r.dgi_uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.erreurs).toEqual([]);
  });

  it("consigne la requête et la réponse dans la charge brute", async () => {
    const r = await service().submitInvoice(requete());
    expect(r.brut).toMatchObject({ service: "MockDgiService", resultat: "ACCEPTE" });
    expect((r.brut as any).taille_xml).toBe(XML.length);
  });

  // Un rejet métier est une RÉPONSE, pas une panne : il ne doit jamais lever,
  // sans quoi l'appelant le traiterait comme un incident au lieu de l'écrire
  // dans le journal et de le montrer au comptable.
  it("rejette un ICE vendeur invalide sans lever", async () => {
    const r = await service().submitInvoice(requete({ ice_vendeur: "123" }));
    expect(r.accepte).toBe(false);
    expect(r.statut).toBe("REJECTED_BY_DGI");
    expect(r.dgi_uuid).toBeNull();
    expect(r.erreurs.map((e) => e.code)).toContain("DGI-ERR-ICE-VENDEUR");
  });

  it("rejette un ICE acheteur erroné, mais tolère son absence", async () => {
    const faux = await service().submitInvoice(requete({ ice_acheteur: "42" }));
    expect(faux.erreurs.map((e) => e.code)).toContain("DGI-ERR-ICE-ACHETEUR");

    const b2c = await service().submitInvoice(requete({ ice_acheteur: null }));
    expect(b2c.accepte).toBe(true);
  });

  // Le motif de rejet n° 1 en production.
  it("rejette une incohérence HT + TVA ≠ TTC en expliquant le calcul", async () => {
    const r = await service().submitInvoice(requete({ montant_ttc: 19000 }));
    expect(r.accepte).toBe(false);
    const erreur = r.erreurs.find((e) => e.code === "DGI-ERR-TOTAUX");
    expect(erreur?.message).toContain("15000");
    expect(erreur?.message).toContain("19000");
  });

  it("tolère un centime d'arrondi sur les totaux", async () => {
    const r = await service().submitInvoice(requete({ montant_ttc: 18000.01 }));
    expect(r.accepte).toBe(true);
  });

  it("rejette un montant nul, un XML non UBL et une empreinte malformée", async () => {
    const nul = await service().submitInvoice(requete({ montant_ht: 0, montant_tva: 0, montant_ttc: 0 }));
    expect(nul.erreurs.map((e) => e.code)).toContain("DGI-ERR-MONTANT");

    const xml = await service().submitInvoice(requete({ xml_ubl: "<html></html>" }));
    expect(xml.erreurs.map((e) => e.code)).toContain("DGI-ERR-XML");

    const hash = await service().submitInvoice(requete({ hash_sha256: "pas-un-hash" }));
    expect(hash.erreurs.map((e) => e.code)).toContain("DGI-ERR-HASH");
  });

  it("accumule plusieurs motifs de rejet en un seul aller-retour", async () => {
    const r = await service().submitInvoice(requete({ ice_vendeur: "1", numero: "", montant_ttc: 999 }));
    expect(r.erreurs.length).toBeGreaterThanOrEqual(3);
  });

  // Sans idempotence, un double-clic ferait exister deux fois la même vente au
  // fichier fiscal, chacune avec son propre récépissé.
  it("rend le MÊME récépissé si la même facture est resoumise à l'identique", async () => {
    const dgi = service();
    const premiere = await dgi.submitInvoice(requete());
    const seconde = await dgi.submitInvoice(requete());
    expect(seconde.accepte).toBe(true);
    expect(seconde.dgi_uuid).toBe(premiere.dgi_uuid);
    expect((seconde.brut as any).resultat).toBe("DEJA_TRANSMISE");
  });

  // Une facture transmise ne se corrige pas : elle s'annule et se remplace.
  it("rejette en doublon un même numéro au contenu modifié", async () => {
    const dgi = service();
    const premiere = await dgi.submitInvoice(requete());
    const seconde = await dgi.submitInvoice(requete({ hash_sha256: "b".repeat(64), montant_ttc: 18000 }));
    expect(seconde.accepte).toBe(false);
    expect(seconde.erreurs[0].code).toBe("DGI-ERR-DOUBLON");
    expect(seconde.erreurs[0].message).toContain(premiere.dgi_uuid!);
  });

  // Le numéro n'est unique QUE par émetteur : deux sociétés peuvent chacune
  // avoir leur facture n° 1.
  it("n'oppose pas de doublon entre deux émetteurs différents", async () => {
    const dgi = service();
    await dgi.submitInvoice(requete());
    const autre = await dgi.submitInvoice(requete({ ice_vendeur: "003841927000056" }));
    expect(autre.accepte).toBe(true);
  });

  it("laisse réémettre un numéro dont la facture a été annulée", async () => {
    const dgi = service();
    const premiere = await dgi.submitInvoice(requete());
    await dgi.cancelInvoice(premiere.dgi_uuid!, "Erreur de client");
    const reprise = await dgi.submitInvoice(requete({ hash_sha256: "c".repeat(64) }));
    expect(reprise.accepte).toBe(true);
    expect(reprise.dgi_uuid).not.toBe(premiere.dgi_uuid);
  });
});

describe("MockDgiService.checkStatus", () => {
  it("retrouve une facture transmise", async () => {
    const dgi = service();
    const soumission = await dgi.submitInvoice(requete());
    const statut = await dgi.checkStatus(soumission.dgi_uuid!);
    expect(statut.statut).toBe("VALIDATED_BY_DGI");
    expect(statut.valide_le).toBe("2026-08-17T10:00:00.000Z");
    expect(statut.erreurs).toEqual([]);
  });

  it("signale un récépissé inconnu sans lever", async () => {
    const statut = await service().checkStatus("00000000-0000-4000-8000-999999999999");
    expect(statut.erreurs.map((e) => e.code)).toContain("DGI-ERR-INCONNU");
  });
});

describe("MockDgiService.cancelInvoice", () => {
  it("annule une facture transmise", async () => {
    const dgi = service();
    const soumission = await dgi.submitInvoice(requete());
    const annulation = await dgi.cancelInvoice(soumission.dgi_uuid!, "Marchandise retournée");
    expect(annulation.annule).toBe(true);
    expect(annulation.statut).toBe("CANCELLED_BY_DGI");
    expect((await dgi.checkStatus(soumission.dgi_uuid!)).statut).toBe("CANCELLED_BY_DGI");
  });

  // Une annulation sans justification n'est pas opposable en contrôle.
  it("exige un motif", async () => {
    const dgi = service();
    const soumission = await dgi.submitInvoice(requete());
    const annulation = await dgi.cancelInvoice(soumission.dgi_uuid!, "   ");
    expect(annulation.annule).toBe(false);
    expect(annulation.erreurs.map((e) => e.code)).toContain("DGI-ERR-MOTIF");
  });

  it("est idempotente", async () => {
    const dgi = service();
    const soumission = await dgi.submitInvoice(requete());
    await dgi.cancelInvoice(soumission.dgi_uuid!, "Doublon");
    const seconde = await dgi.cancelInvoice(soumission.dgi_uuid!, "Doublon");
    expect(seconde.annule).toBe(true);
    expect((seconde.brut as any).resultat).toBe("DEJA_ANNULEE");
  });

  it("refuse un récépissé inconnu", async () => {
    const r = await service().cancelInvoice("00000000-0000-4000-8000-999999999999", "Motif");
    expect(r.annule).toBe(false);
    expect(r.erreurs.map((e) => e.code)).toContain("DGI-ERR-INCONNU");
  });
});

describe("simulation réseau", () => {
  it("attend réellement la latence configurée", async () => {
    const dgi = new MockDgiService({ latenceMs: 60 });
    const debut = Date.now();
    await dgi.submitInvoice(requete());
    expect(Date.now() - debut).toBeGreaterThanOrEqual(50);
  });

  // Le chemin d'erreur TECHNIQUE, lui, doit bien lever : c'est un incident,
  // pas une réponse de la plateforme.
  it("lève sur une panne technique simulée", async () => {
    const dgi = new MockDgiService({ latenceMs: 0, tauxPanne: 1 });
    await expect(dgi.submitInvoice(requete())).rejects.toThrow(/injoignable/);
  });
});

describe("obtenirConnecteurDgi", () => {
  const env = { ...process.env };

  beforeEach(() => reinitialiserConnecteurDgi());
  afterEach(() => {
    process.env = { ...env };
    reinitialiserConnecteurDgi();
  });

  // Lever faute d'accès DGI empêcherait purement et simplement d'émettre.
  it("retombe sur le bac à sable sans variables d'environnement", () => {
    delete process.env.DGI_API_URL;
    delete process.env.DGI_API_KEY;
    const c = obtenirConnecteurDgi();
    expect(c.nom).toBe("MockDgiService");
    expect(c.production).toBe(false);
  });

  it("bascule sur le connecteur réel dès que l'URL et la clef sont fournies", () => {
    process.env.DGI_API_URL = "https://sandbox.dgi.gov.ma/api/v1";
    process.env.DGI_API_KEY = "clef-de-test";
    const c = obtenirConnecteurDgi();
    expect(c.nom).toBe("HttpDgiConnector");
    expect(c.production).toBe(true);
  });

  it("mémorise le connecteur choisi", () => {
    expect(obtenirConnecteurDgi()).toBe(obtenirConnecteurDgi());
  });

  it("accepte un connecteur injecté pour les tests", () => {
    const faux = service();
    expect(obtenirConnecteurDgi(faux)).toBe(faux);
    expect(obtenirConnecteurDgi()).toBe(faux);
  });
});
