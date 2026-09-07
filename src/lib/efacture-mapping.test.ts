import { describe, expect, it } from "vitest";
import {
  ajouterAuJournal,
  construireFactureUbl,
  estFigeeFiscalement,
  JOURNAL_MAX,
  lireLignes,
  normaliserStatutDgi,
  peutTransmettre,
  reconstituerJournal,
  presenterStatutDgi,
  resoudreIdentites,
  typeFiscal,
  type EntreeJournal,
  type LigneFactureStockee,
} from "./efacture-mapping";

const SOCIETE = {
  nom_societe: "DIGITAL SOLUTIONS SARL",
  ice: "001547896000073",
  if_fiscal: "40218963",
  rc: "123456",
  patente: "30185274",
  adresse: "12 rue Ibn Batouta",
};

const CLIENT = {
  nom: "SOCIÉTÉ CLIENTE SA",
  ice: "002748193000041",
  if_fiscal: "51907432",
  adresse: "5 avenue Hassan II",
};

function facture(extra: Partial<LigneFactureStockee> = {}): LigneFactureStockee {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    numero: "FA-2026-0042",
    type: "facture",
    date_facture: "2026-08-17",
    date_echeance: "2026-09-16",
    montant_ht: 15000,
    montant_tva: 3000,
    montant_ttc: 18000,
    lignes: [{ designation: "Conseil", quantite: 10, prix_unitaire: 1500, taux_tva: 20 }],
    ...extra,
  };
}

describe("resoudreIdentites", () => {
  it("amorce les identités depuis les fiches tant que rien n'est figé", () => {
    expect(resoudreIdentites(facture(), SOCIETE, CLIENT)).toEqual({
      ice_vendeur: "001547896000073",
      if_vendeur: "40218963",
      rc_vendeur: "123456",
      patente_vendeur: "30185274",
      ice_acheteur: "002748193000041",
      if_acheteur: "51907432",
    });
  });

  // LA règle du module : une facture transmise porte les identifiants DÉCLARÉS.
  // Relire la fiche ferait bouger l'empreinte d'une facture pourtant intacte,
  // et un contrôle conclurait à une falsification.
  it("fait primer l'identité FIGÉE sur la fiche modifiée depuis", () => {
    const figee = facture({ ice_acheteur: "009999999000011", if_acheteur: "11223344" });
    const resolu = resoudreIdentites(figee, SOCIETE, { ...CLIENT, ice: "002748193000041" });
    expect(resolu.ice_acheteur).toBe("009999999000011");
    expect(resolu.if_acheteur).toBe("11223344");
  });

  it("rend null plutôt qu'undefined quand rien n'est connu", () => {
    expect(resoudreIdentites(facture(), null, null)).toEqual({
      ice_vendeur: null,
      if_vendeur: null,
      rc_vendeur: null,
      patente_vendeur: null,
      ice_acheteur: null,
      if_acheteur: null,
    });
  });
});

describe("lireLignes", () => {
  it("normalise le JSONB de forme non garantie", () => {
    expect(
      lireLignes([{ designation: "  Conseil  ", quantite: "3", prix_unitaire: "100.5", taux_tva: null }]),
    ).toEqual([
      { designation: "Conseil", quantite: 3, prix_unitaire: 100.5, taux_tva: 20, unite: undefined, motif_exoneration: null },
    ]);
  });

  it("survit à un contenu qui n'est pas un tableau", () => {
    expect(lireLignes(null)).toEqual([]);
    expect(lireLignes("[]")).toEqual([]);
    expect(lireLignes({ a: 1 })).toEqual([]);
  });

  // Une ligne à zéro produit un InvoiceLine vide que la DGI compte comme une
  // anomalie de structure.
  it("écarte les lignes sans quantité NI prix", () => {
    expect(lireLignes([{ designation: "Vide", quantite: 0, prix_unitaire: 0, taux_tva: 20 }])).toEqual([]);
  });

  it("conserve une ligne offerte (prix nul mais quantité réelle)", () => {
    expect(lireLignes([{ designation: "Offert", quantite: 2, prix_unitaire: 0, taux_tva: 20 }])).toHaveLength(1);
  });
});

describe("typeFiscal", () => {
  it("réduit les deux vocabulaires du modèle aux types fiscaux", () => {
    expect(typeFiscal("avoir")).toBe("avoir");
    expect(typeFiscal("acompte")).toBe("acompte");
    // Un « solde » est fiscalement une facture ordinaire.
    expect(typeFiscal("solde")).toBe("facture");
    expect(typeFiscal("standard")).toBe("facture");
    expect(typeFiscal(null)).toBe("facture");
  });
});

describe("construireFactureUbl", () => {
  it("assemble vendeur, acheteur et lignes", () => {
    const f = construireFactureUbl(facture(), SOCIETE, CLIENT);
    expect(f.numero).toBe("FA-2026-0042");
    expect(f.vendeur).toMatchObject({ nom: "DIGITAL SOLUTIONS SARL", ice: "001547896000073", pays: "MA" });
    expect(f.acheteur).toMatchObject({ nom: "SOCIÉTÉ CLIENTE SA", ice: "002748193000041" });
    expect(f.lignes).toHaveLength(1);
  });

  // Un `cbc:ID` vide rend le document INVALIDE ; mal nommé vaut mieux qu'invalide.
  it("retombe sur l'identifiant technique si le numéro manque", () => {
    expect(construireFactureUbl(facture({ numero: "   " }), SOCIETE, CLIENT).numero).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("tronque les dates horodatées au jour", () => {
    const f = construireFactureUbl(facture({ date_facture: "2026-08-17T00:00:00+01:00" }), SOCIETE, CLIENT);
    expect(f.date_facture).toBe("2026-08-17");
  });

  it("nomme « — » les parties inconnues plutôt que de rendre une chaîne vide", () => {
    const f = construireFactureUbl(facture(), null, null);
    expect(f.vendeur.nom).toBe("—");
    expect(f.acheteur.nom).toBe("—");
  });
});

describe("ajouterAuJournal", () => {
  const entree = (n: number): EntreeJournal => ({
    sens: "requete",
    operation: "submitInvoice",
    at: `2026-08-17T10:00:${String(n).padStart(2, "0")}.000Z`,
    payload: { n },
  });

  it("part d'un journal vide ou mal formé sans broncher", () => {
    expect(ajouterAuJournal(null, entree(1))).toHaveLength(1);
    expect(ajouterAuJournal("pas un tableau", entree(1))).toHaveLength(1);
  });

  it("accepte plusieurs entrées d'un coup", () => {
    expect(ajouterAuJournal([], [entree(1), entree(2)])).toHaveLength(2);
  });

  // Sans plafond, une facture interrogée en boucle alourdirait CHAQUE lecture
  // de la liste des factures.
  it("plafonne le journal en gardant les échanges les plus récents", () => {
    const long = Array.from({ length: JOURNAL_MAX + 10 }, (_, i) => entree(i));
    const resultat = ajouterAuJournal(long, entree(99));
    expect(resultat).toHaveLength(JOURNAL_MAX);
    expect((resultat.at(-1)!.payload as any).n).toBe(99);
    expect((resultat[0].payload as any).n).toBe(11);
  });
});

describe("reconstituerJournal", () => {
  // Un vide ferait croire à une facture jamais transmise — le contraire exact
  // de ce qu'annonce son statut « Conforme DGI ».
  it("reconstitue les échanges depuis les traces d'audit", () => {
    const journal = reconstituerJournal({}, [
      { action: "efacture_transmise", details: { dgi_uuid: "u-1" }, created_at: "2026-08-17T10:00:00.000Z" },
      { action: "efacture_annulee", details: { motif: "Erreur client" }, created_at: "2026-08-18T09:00:00.000Z" },
    ]);
    expect(journal).toHaveLength(2);
    expect(journal[0]).toMatchObject({ sens: "reponse", operation: "submitInvoice", at: "2026-08-17T10:00:00.000Z" });
    expect(journal[1].operation).toBe("cancelInvoice");
    expect((journal[0].payload as any).origine).toBe("audit_logs");
    expect((journal[1].payload as any).motif).toBe("Erreur client");
  });

  it("se rabat sur la dernière réponse brute à défaut de trace", () => {
    const journal = reconstituerJournal({
      dgi_response: { conforme: true, uuid: "u-1" },
      updated_at: "2026-08-17T10:00:00.000Z",
    });
    expect(journal).toHaveLength(1);
    expect((journal[0].payload as any).origine).toMatch(/avant journal structuré/);
    expect((journal[0].payload as any).uuid).toBe("u-1");
    expect(journal[0].at).toBe("2026-08-17T10:00:00.000Z");
  });

  // Superposer les deux sources ferait apparaître deux fois le même échange.
  it("ne cumule pas la réponse brute avec les traces d'audit", () => {
    const journal = reconstituerJournal({ dgi_response: { conforme: true } }, [
      { action: "efacture_transmise", details: {}, created_at: "2026-08-17T10:00:00.000Z" },
    ]);
    expect(journal).toHaveLength(1);
    expect((journal[0].payload as any).origine).toBe("audit_logs");
  });

  it("rend un journal vide quand il n'y a vraiment rien", () => {
    expect(reconstituerJournal({})).toEqual([]);
    expect(reconstituerJournal({ dgi_response: null }, [])).toEqual([]);
  });
});

describe("normaliserStatutDgi", () => {
  it("accepte les états normalisés", () => {
    expect(normaliserStatutDgi("VALIDATED_BY_DGI")).toBe("VALIDATED_BY_DGI");
    expect(normaliserStatutDgi("pending_dgi")).toBe("PENDING_DGI");
  });

  // Sans reprise, une facture émise avant la migration s'afficherait
  // « Brouillon » alors qu'elle porte un récépissé DGI.
  it("reprend les valeurs héritées de l'ancienne colonne statut_dgi", () => {
    expect(normaliserStatutDgi("conforme")).toBe("VALIDATED_BY_DGI");
    expect(normaliserStatutDgi("rejetee")).toBe("REJECTED_BY_DGI");
    expect(normaliserStatutDgi("en_analyse")).toBe("PENDING_DGI");
    expect(normaliserStatutDgi("annulee")).toBe("CANCELLED_BY_DGI");
  });

  it("retombe sur DRAFT devant l'inconnu", () => {
    expect(normaliserStatutDgi(null)).toBe("DRAFT");
    expect(normaliserStatutDgi("n'importe quoi")).toBe("DRAFT");
  });
});

describe("presenterStatutDgi", () => {
  it("rend un libellé et un ton pour chaque état", () => {
    expect(presenterStatutDgi("DRAFT")).toMatchObject({ libelle: "Brouillon", ton: "neutre" });
    expect(presenterStatutDgi("PENDING_DGI")).toMatchObject({ libelle: "En attente DGI", ton: "attente" });
    expect(presenterStatutDgi("conforme")).toMatchObject({ libelle: "Conforme DGI", ton: "succes" });
    expect(presenterStatutDgi("REJECTED_BY_DGI")).toMatchObject({ libelle: "Rejetée", ton: "erreur" });
  });

  it("explique chaque état en une phrase", () => {
    expect(presenterStatutDgi("VALIDATED_BY_DGI").description).toMatch(/ne peut plus être modifiée/);
  });
});

describe("règles d'état", () => {
  it("fige une facture transmise ou validée", () => {
    expect(estFigeeFiscalement("VALIDATED_BY_DGI")).toBe(true);
    expect(estFigeeFiscalement("PENDING_DGI")).toBe(true);
    expect(estFigeeFiscalement("DRAFT")).toBe(false);
    expect(estFigeeFiscalement("REJECTED_BY_DGI")).toBe(false);
  });

  // Retransmettre une facture validée créerait un doublon au fichier fiscal ;
  // une rejetée, au contraire, DOIT pouvoir repartir après correction.
  it("n'autorise la transmission que depuis brouillon ou rejet", () => {
    expect(peutTransmettre("DRAFT")).toBe(true);
    expect(peutTransmettre("REJECTED_BY_DGI")).toBe(true);
    expect(peutTransmettre("PENDING_DGI")).toBe(false);
    expect(peutTransmettre("VALIDATED_BY_DGI")).toBe(false);
    expect(peutTransmettre("CANCELLED_BY_DGI")).toBe(false);
  });
});
