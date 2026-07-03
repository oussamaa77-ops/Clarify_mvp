import { describe, it, expect } from "vitest";
import {
  deduplicateAnalyses,
  applyKeywordOverrides,
  extractTiersFromLibelle,
  nameSimilarity,
  normalizeTelecom,
  preMatchTransactions,
} from "./factures.functions";

// ─── deduplicateAnalyses ──────────────────────────────────────────────────────

describe("deduplicateAnalyses", () => {
  it("ne touche pas les analyses sans doublon", () => {
    const input = [
      { facture_id: "fac-1", confiance: 85 },
      { facture_id: "fac-2", confiance: 70 },
      { facture_id: null,    confiance: 60 },
    ];
    const result = deduplicateAnalyses(input);
    expect(result[0].facture_id).toBe("fac-1");
    expect(result[1].facture_id).toBe("fac-2");
    expect(result[2].facture_id).toBeNull();
    expect(result.every(a => !a.alerte?.includes("Doublon"))).toBe(true);
  });

  it("garde le match à plus haute confiance (pas le premier)", () => {
    const input = [
      { facture_id: "fac-1", facture_num: "FAC001", confiance: 70 }, // premier mais moins bon
      { facture_id: "fac-1", facture_num: "FAC001", confiance: 90 }, // meilleur
    ];
    const result = deduplicateAnalyses(input);
    // Le premier (confiance 70) doit être neutralisé
    expect(result[0].facture_id).toBeNull();
    expect(result[0].alerte).toContain("Doublon");
    // Le second (confiance 90) doit être conservé
    expect(result[1].facture_id).toBe("fac-1");
    expect(result[1].alerte).toBeUndefined();
  });

  it("à confiance égale, garde le premier (idx le plus bas)", () => {
    const input = [
      { facture_id: "fac-1", confiance: 80 },
      { facture_id: "fac-1", confiance: 80 },
    ];
    const result = deduplicateAnalyses(input);
    expect(result[0].facture_id).toBe("fac-1");
    expect(result[1].facture_id).toBeNull();
    expect(result[1].alerte).toContain("Doublon");
  });

  it("réduit la confiance du doublon neutralisé", () => {
    const input = [
      { facture_id: "fac-1", confiance: 50 },
      { facture_id: "fac-1", confiance: 95 },
    ];
    const result = deduplicateAnalyses(input);
    // neutralisé : confiance = max(40, 50-30) = 40
    expect(result[0].confiance).toBe(40);
    // conservé : confiance inchangée
    expect(result[1].confiance).toBe(95);
  });

  it("gère 3 transactions avec la même facture_id", () => {
    const input = [
      { facture_id: "fac-x", confiance: 60 },
      { facture_id: "fac-x", confiance: 95 }, // meilleur → gardé
      { facture_id: "fac-x", confiance: 75 },
    ];
    const result = deduplicateAnalyses(input);
    expect(result[0].facture_id).toBeNull();
    expect(result[1].facture_id).toBe("fac-x");
    expect(result[2].facture_id).toBeNull();
  });

  it("gère plusieurs paires de doublons indépendantes", () => {
    const input = [
      { facture_id: "fac-A", confiance: 80 },
      { facture_id: "fac-B", confiance: 70 },
      { facture_id: "fac-A", confiance: 90 }, // meilleur pour fac-A
      { facture_id: "fac-B", confiance: 85 }, // meilleur pour fac-B
    ];
    const result = deduplicateAnalyses(input);
    expect(result[0].facture_id).toBeNull();   // fac-A doublon
    expect(result[1].facture_id).toBeNull();   // fac-B doublon
    expect(result[2].facture_id).toBe("fac-A");
    expect(result[3].facture_id).toBe("fac-B");
  });

  it("ne modifie pas les analyses sans facture_id", () => {
    const input = [
      { facture_id: null, confiance: 55, categorie: "telecom" },
      { facture_id: null, confiance: 60, categorie: "salaires" },
    ];
    const result = deduplicateAnalyses(input);
    expect(result[0]).toEqual(input[0]);
    expect(result[1]).toEqual(input[1]);
  });

  it("ne mute pas le tableau original (immutabilité)", () => {
    const input = [
      { facture_id: "fac-1", confiance: 80 },
      { facture_id: "fac-1", confiance: 90 },
    ];
    const original = JSON.parse(JSON.stringify(input));
    deduplicateAnalyses(input);
    expect(input).toEqual(original);
  });
});

// ─── applyKeywordOverrides ────────────────────────────────────────────────────

describe("applyKeywordOverrides", () => {
  const makeTx = (libelle: string, debit?: number, credit?: number) => ({
    nature_operation: libelle,
    montant_debit:  debit  ?? null,
    montant_credit: credit ?? null,
  });

  it("IAM sans facture_id → categorie=telecom, code=6145, facture_id=null", () => {
    const analyses = [{ facture_id: null, confiance: 60, categorie: "paiement_fournisseur" }];
    const txs = [makeTx("PAIEMENT IAM TELECOM", 520)];
    const result = applyKeywordOverrides(analyses, txs);
    expect(result[0].categorie).toBe("telecom");
    expect(result[0].code_pcm).toBe("6145");
    expect(result[0].facture_id).toBeNull();
    expect(result[0].taux_tva).toBe(20);
  });

  it("IAM AVEC facture_id → categorie=paiement_fournisseur, facture_id conservé", () => {
    // Cas clé : une facture IAM a été matchée → ne pas forcer null
    const fid = "iam-facture-uuid";
    const analyses = [{ facture_id: fid, confiance: 88, categorie: "paiement_fournisseur" }];
    const txs = [makeTx("PAIEMENT IAM TELECOM", 520)];
    const result = applyKeywordOverrides(analyses, txs);
    expect(result[0].facture_id).toBe(fid);          // conservé ✓
    expect(result[0].categorie).toBe("paiement_fournisseur"); // pour que handleValider marque payée ✓
    expect(result[0].code_pcm).toBe("6145");          // code télécom pour l'écriture ✓
    expect(result[0].confiance).toBeGreaterThanOrEqual(85);
  });

  it("ORANGE INWI MAROC TELECOM MEDITEL → même traitement que IAM", () => {
    const keywords = ["PAIEMENT ORANGE", "PAIEMENT INWI", "VIREMENT MAROC TELECOM", "PAIEMENT MEDITEL"];
    keywords.forEach(kw => {
      const analyses = [{ facture_id: null, confiance: 50 }];
      const txs = [makeTx(kw, 300)];
      const result = applyKeywordOverrides(analyses, txs);
      expect(result[0].categorie).toBe("telecom");
      expect(result[0].code_pcm).toBe("6145");
    });
  });

  it("calcule HT et TVA correctement sur 520 MAD TTC à 20%", () => {
    const analyses = [{ facture_id: null, confiance: 60 }];
    const txs = [makeTx("PAIEMENT IAM", 520)];
    const result = applyKeywordOverrides(analyses, txs);
    expect(result[0].montant_ht).toBeCloseTo(433.33, 1);
    expect(result[0].montant_tva).toBeCloseTo(86.67, 1);
  });

  it("RETRAIT ESPECES → retrait_especes, code=5143, facture_id=null", () => {
    const analyses = [{ facture_id: "fac-x", confiance: 70 }];
    const txs = [makeTx("RETRAIT ESPECES GAB", 1000)];
    const result = applyKeywordOverrides(analyses, txs);
    expect(result[0].categorie).toBe("retrait_especes");
    expect(result[0].code_pcm).toBe("5143");
    expect(result[0].facture_id).toBeNull(); // retrait → jamais de facture
    expect(result[0].confiance).toBe(99);
  });

  it("RETRAIT GAB → retrait_especes", () => {
    const analyses = [{ facture_id: null, confiance: 50 }];
    const txs = [makeTx("RETRAIT GAB 24/24", 500)];
    const result = applyKeywordOverrides(analyses, txs);
    expect(result[0].categorie).toBe("retrait_especes");
  });

  it("transaction ordinaire non concernée → inchangée", () => {
    const analyses = [{ facture_id: "fac-1", confiance: 85, categorie: "encaissement_client" }];
    const txs = [makeTx("VIREMENT RECU DE TESDRAMENVEST", undefined, 433)];
    const result = applyKeywordOverrides(analyses, txs);
    expect(result[0]).toEqual(analyses[0]); // strictement inchangée
  });

  it("transaction CNSS → non affectée par les overrides télécom/retrait", () => {
    const analyses = [{ facture_id: null, categorie: "cnss_amo", code_pcm: "6174" }];
    const txs = [makeTx("PAIEMENT CNSS", 3500)];
    const result = applyKeywordOverrides(analyses, txs);
    expect(result[0].categorie).toBe("cnss_amo");
    expect(result[0].code_pcm).toBe("6174");
  });

  it("tableau vide → tableau vide", () => {
    expect(applyKeywordOverrides([], [])).toEqual([]);
  });

  it("ne mute pas le tableau original (immutabilité)", () => {
    const analyses = [{ facture_id: null, confiance: 60, categorie: "autre" }];
    const txs = [makeTx("PAIEMENT IAM", 520)];
    const originalCategorie = analyses[0].categorie;
    applyKeywordOverrides(analyses, txs);
    expect(analyses[0].categorie).toBe(originalCategorie); // non muté
  });
});

// ─── Tests d'intégration (pipeline complet) ───────────────────────────────────

describe("Pipeline complet : overrides puis déduplication", () => {
  it("TESDRAMENVEST : une seule transaction → pas de doublon", () => {
    const analyses = [
      { facture_id: "tesdra-uuid", facture_num: "FAC433", confiance: 85, categorie: "encaissement_client" },
      { facture_id: null, confiance: 55, categorie: "paiement_fournisseur" },
    ];
    const txs = [
      { nature_operation: "VIREMENT RECU TESDRAMENVEST", montant_credit: 433, montant_debit: null },
      { nature_operation: "PAIEMENT FOURNISSEUR XYZ",    montant_debit: 200, montant_credit: null },
    ];
    const withOverrides = applyKeywordOverrides(analyses, txs);
    const result = deduplicateAnalyses(withOverrides);
    // La facture TESDRAMENVEST doit rester matchée, pas de doublon
    expect(result[0].facture_id).toBe("tesdra-uuid");
    expect(result[0].alerte).toBeFalsy();
  });

  it("IAM avec facture matchée → facture_id conservé après pipeline", () => {
    const fid = "iam-fac-uuid";
    const analyses = [
      { facture_id: fid, facture_num: "IAM-2026-05", confiance: 88, categorie: "paiement_fournisseur" },
    ];
    const txs = [
      { nature_operation: "PAIEMENT IAM TELECOM", montant_debit: 624, montant_credit: null },
    ];
    const withOverrides = applyKeywordOverrides(analyses, txs);
    const result = deduplicateAnalyses(withOverrides);
    expect(result[0].facture_id).toBe(fid);
    expect(result[0].categorie).toBe("paiement_fournisseur");
    expect(result[0].code_pcm).toBe("6145");
  });

  it("même facture_id sur 2 transactions IAM → meilleur match conservé, autre neutralisé", () => {
    const fid = "iam-fac-uuid";
    const analyses = [
      { facture_id: fid, confiance: 70, categorie: "paiement_fournisseur" },
      { facture_id: fid, confiance: 92, categorie: "paiement_fournisseur" },
    ];
    const txs = [
      { nature_operation: "PAIEMENT IAM", montant_debit: 624, montant_credit: null },
      { nature_operation: "PAIEMENT MAROC TELECOM IAM", montant_debit: 624, montant_credit: null },
    ];
    const withOverrides = applyKeywordOverrides(analyses, txs);
    const result = deduplicateAnalyses(withOverrides);
    expect(result[0].facture_id).toBeNull();   // confiance 70 → neutralisé
    expect(result[1].facture_id).toBe(fid);    // confiance 92 → conservé
  });
});

// ─── extractTiersFromLibelle ──────────────────────────────────────────────────

describe("extractTiersFromLibelle", () => {
  it("supprime PAIEMENT CB + date + extrait le tiers (cas TESDRAMENVEST réel)", () => {
    // Libellé réel du relevé Attijariwafa : "PAIEMENT CB 26 03 26 TESDRAMENVEST"
    expect(extractTiersFromLibelle("PAIEMENT CB 26 03 26 TESDRAMENVEST")).toBe("TESDRAMENVEST");
  });

  it("supprime PAIEMENT CB 2 chiffres date et extrait tiers", () => {
    expect(extractTiersFromLibelle("PAIEMENT CB 01 06 26 MAROC TELECOM")).toBe("MAROC TELECOM");
  });

  it("supprime VIREMENT RECU DE", () => {
    expect(extractTiersFromLibelle("VIREMENT RECU DE TESDRAMENVEST SA")).toBe("TESDRAMENVEST SA");
  });

  it("supprime PAIEMENT seul", () => {
    expect(extractTiersFromLibelle("PAIEMENT IAM TELECOM")).toBe("IAM TELECOM");
  });

  it("supprime VIR EMIS VERS", () => {
    expect(extractTiersFromLibelle("VIR EMIS VERS ORANGE MAROC")).toBe("ORANGE MAROC");
  });

  it("libellé sans préfixe → retourné tel quel", () => {
    expect(extractTiersFromLibelle("CNSS COTISATION")).toBe("CNSS COTISATION");
  });
});

// ─── normalizeTelecom ─────────────────────────────────────────────────────────

describe("normalizeTelecom", () => {
  it("MAROC TELECOM → IAM", () => {
    expect(normalizeTelecom("MAROC TELECOM")).toBe("IAM");
  });
  it("ITISSALAT → IAM", () => {
    expect(normalizeTelecom("ITISSALAT AL MAGHRIB")).toBe("IAM");
  });
  it("IAM → IAM", () => {
    expect(normalizeTelecom("IAM")).toBe("IAM");
  });
  it("MEDITEL → ORANGE", () => {
    expect(normalizeTelecom("MEDITEL SA")).toBe("ORANGE");
  });
  it("WANA → INWI", () => {
    expect(normalizeTelecom("WANA CORPORATE")).toBe("INWI");
  });
  it("nom sans alias → retourné en majuscules", () => {
    expect(normalizeTelecom("tesdramenvest")).toBe("TESDRAMENVEST");
  });
});

// ─── nameSimilarity ───────────────────────────────────────────────────────────

describe("nameSimilarity", () => {
  it("identique → 1", () => {
    expect(nameSimilarity("TESDRAMENVEST", "TESDRAMENVEST")).toBe(1);
  });

  it("MAROC TELECOM ↔ IAM → 1 (via alias)", () => {
    // Les deux normalisés → IAM = IAM
    expect(nameSimilarity("MAROC TELECOM", "IAM")).toBe(1);
    expect(nameSimilarity("IAM", "MAROC TELECOM")).toBe(1);
  });

  it("sous-chaîne → score élevé", () => {
    expect(nameSimilarity("TESDRAMENVEST", "TESDRAMENVEST SA")).toBeGreaterThanOrEqual(0.88);
  });

  it("noms sans rapport → score < 0.3", () => {
    expect(nameSimilarity("TESDRAMENVEST", "PRO FLUIDES")).toBeLessThan(0.3);
  });

  it("chaîne vide → 0", () => {
    expect(nameSimilarity("", "TESDRAMENVEST")).toBe(0);
    expect(nameSimilarity("TESDRAMENVEST", "")).toBe(0);
  });
});

// ─── preMatchTransactions ─────────────────────────────────────────────────────

describe("preMatchTransactions", () => {
  const factureFourn = (id: string, nom: string, montant: number) => ({
    id,
    fournisseur_nom: nom,
    montant_ttc: montant,
    montant_restant: montant,
    numero: `FAC-${id}`,
    clients: null,
  });

  const factureClient = (id: string, nomClient: string, montant: number) => ({
    id,
    clients: { nom: nomClient },
    montant_ttc: montant,
    montant_restant: montant,
    numero: `CLI-${id}`,
    fournisseur_nom: null,
  });

  it("PAIEMENT CB 26 03 26 TESDRAMENVEST → match facture fournisseur TESDRAMENVEST 433 MAD", () => {
    const txs = [{ nature_operation: "PAIEMENT CB 26 03 26 TESDRAMENVEST", montant_debit: 433, montant_credit: null }];
    const fourn = [factureFourn("fac-tesdra", "TESDRAMENVEST", 433)];
    const result = preMatchTransactions(txs, fourn, []);
    expect(result[0]).not.toBeNull();
    expect(result[0]!.facture_id).toBe("fac-tesdra");
    expect(result[0]!.confiance).toBeGreaterThanOrEqual(85);
  });

  it("PAIEMENT MAROC TELECOM → match facture fournisseur IAM (alias)", () => {
    const txs = [{ nature_operation: "PAIEMENT CB 01 06 26 MAROC TELECOM", montant_debit: 520, montant_credit: null }];
    const fourn = [factureFourn("fac-iam", "IAM", 520)];
    const result = preMatchTransactions(txs, fourn, []);
    expect(result[0]).not.toBeNull();
    expect(result[0]!.facture_id).toBe("fac-iam");
  });

  it("montant différent de > 2 MAD → pas de match", () => {
    const txs = [{ nature_operation: "PAIEMENT CB 26 03 26 TESDRAMENVEST", montant_debit: 500, montant_credit: null }];
    const fourn = [factureFourn("fac-tesdra", "TESDRAMENVEST", 433)];
    const result = preMatchTransactions(txs, fourn, []);
    expect(result[0]).toBeNull();
  });

  it("nom sans rapport → pas de match", () => {
    const txs = [{ nature_operation: "PAIEMENT PRO FLUIDES", montant_debit: 433, montant_credit: null }];
    const fourn = [factureFourn("fac-tesdra", "TESDRAMENVEST", 433)];
    const result = preMatchTransactions(txs, fourn, []);
    expect(result[0]).toBeNull();
  });

  it("encaissement client (crédit) → match facture client", () => {
    const txs = [{ nature_operation: "VIREMENT RECU DE ACME SARL", montant_credit: 1200, montant_debit: null }];
    const clients = [factureClient("cli-acme", "ACME SARL", 1200)];
    const result = preMatchTransactions(txs, [], clients);
    expect(result[0]).not.toBeNull();
    expect(result[0]!.facture_id).toBe("cli-acme");
  });

  it("tolérance ±2 MAD sur le montant", () => {
    const txs = [{ nature_operation: "PAIEMENT CB 26 03 26 TESDRAMENVEST", montant_debit: 431.50, montant_credit: null }];
    const fourn = [factureFourn("fac-t", "TESDRAMENVEST", 433)];
    const result = preMatchTransactions(txs, fourn, []);
    expect(result[0]).not.toBeNull(); // ±1.5 MAD → dans la tolérance
  });

  it("tableau vide → tous null", () => {
    const result = preMatchTransactions([], [], []);
    expect(result).toEqual([]);
  });
});
