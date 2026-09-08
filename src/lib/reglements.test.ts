// ============================================================================
// reglements.test.ts — Les dix invariants du cycle de règlement.
//
// Ce fichier ne teste pas des fonctions, il teste des IMPOSSIBILITÉS. Chacun des
// dix blocs ci-dessous correspond à une situation qui a réellement produit un
// chiffre faux à l'écran, ou qui le produirait si le verrou sautait :
//
//    1. paiement PARTIEL          — le reste dû survit, le statut le dit
//    2. paiement TOTAL            — soldé, et daté de sa pièce
//    3. paiement ABSENT           — aucune trace ⇒ aucune créance effacée
//    4. paiement AVANT la facture — impossible, donc écarté (cas SMERT)
//    5. DOUBLON                   — une pièce règle une fois
//    6. LETTRAGE incohérent       — un code déséquilibré sort une créance non réglée
//    7. TVA incohérente           — un taux qui n'existe pas n'est pas un arrondi
//    8. ARRONDI                   — identifié par sa cause, jamais « corrigé »
//    9. mouvement 471 non identifié — pas d'imputation d'office, résultat réservé
//   10. RESYNCHRONISATION         — la projection suit le grand livre, dans les deux sens
//
// Les scénarios reprennent les montants RÉELS du dossier SMERT WATER : FA 0005
// (AGAF, 50 400) réglée neuf jours avant son émission, FA-2026-0084 (31 572)
// soixante-huit jours avant, FAC002_2026 (REPERAL, 14 785) adossée à un chèque de
// 2024, PRO-FLUIDES (2 629,02) réglée par un chèque de 2 629,00, et 41 500 MAD
// parqués au 47120000 depuis 2024. Une facture inventée testerait le code ;
// celles-ci testent le métier.
// ============================================================================

import { describe, it, expect } from "vitest";
import {
  clePaiement, examinerPaiements, paiementsIrrecevables, paiementsRecevables,
  projeterEtatReglement, reglementDivergent, TOLERANCE_REGLEMENT,
  type FactureReglee, type PaiementCandidat,
} from "@/lib/reglements";
import {
  controlerEquilibreLettrage, encaissementsTiersGrandLivre, caHtGrandLivre,
  encoursTiersGrandLivre, projeterSituationFacture, situationFactureGrandLivre,
  type LigneGrandLivre,
} from "@/lib/encours-grandlivre";
import { controlerCoherenceMontants } from "@/lib/tva";
import { resultatDefinitif, type LigneBalance } from "@/lib/balance-comptable";
import {
  estComptabilisable, rapprocherCaProduits, rapprocherEncoursClients,
  type FactureVente,
} from "@/lib/coherence-ventes";

// ─── Fabriques ───────────────────────────────────────────────────────────────

const ligne = (p: Partial<LigneGrandLivre>): LigneGrandLivre => ({
  id: Math.random().toString(36).slice(2), journal_code: "VTE", compte_numero: "34210001",
  date_ecriture: "2026-05-17", debit: 0, credit: 0, reference_piece: null,
  lettrage_code: null, facture_id: null, ...p,
});

/** Les trois lignes d'une vente, telles que le générateur les produit. */
const vente = (
  ref: string, ht: number, tva: number,
  o: { client?: string; lettrage?: string; date?: string } = {},
): LigneGrandLivre[] => [
  ligne({ compte_numero: o.client ?? "34210001", debit: ht + tva, reference_piece: ref,
          lettrage_code: o.lettrage ?? null, date_ecriture: o.date }),
  ligne({ compte_numero: "71110000", credit: ht, reference_piece: ref, date_ecriture: o.date }),
  ligne({ compte_numero: "44580000", credit: tva, reference_piece: ref, date_ecriture: o.date }),
];

/** Les deux lignes d'un encaissement client, en journal de trésorerie. */
const encaissement = (
  ref: string, montant: number, date: string,
  o: { client?: string; lettrage?: string; journal?: string } = {},
): LigneGrandLivre[] => [
  ligne({ journal_code: o.journal ?? "BQ", compte_numero: o.client ?? "34210001",
          credit: montant, reference_piece: ref, date_ecriture: date, lettrage_code: o.lettrage ?? null }),
  ligne({ journal_code: o.journal ?? "BQ", compte_numero: "51410000",
          debit: montant, reference_piece: ref, date_ecriture: date, lettrage_code: o.lettrage ?? null }),
];

const paiement = (p: Partial<PaiementCandidat>): PaiementCandidat => ({
  montant: 0, date_paiement: null, origine: "manuel",
  transaction_id: null, encaissement_id: null, reference: null, ...p,
});

/** Le montant que le grand livre atteste pour une facture, et sa date. */
const attesteParGl = (lignes: LigneGrandLivre[], f: FactureReglee) => {
  const s = situationFactureGrandLivre(lignes, {
    references: [f.numero, f.id], id: f.id, montant_ttc: Number(f.montant_ttc), sens: "client",
  });
  return { montant: s.montant_paye, date: s.date_paiement };
};

// ═════════════════════════════════════════════════════════════════════════════
// 1. PAIEMENT PARTIEL
// ═════════════════════════════════════════════════════════════════════════════

describe("1. paiement partiel", () => {
  const f: FactureReglee = {
    id: "f1", numero: "FA-2026-0084", date_facture: "2026-05-17", montant_ttc: 31572,
  };

  it("un acompte laisse le reste dû intact et le statut à « partielle »", () => {
    const gl = [...vente("FA-2026-0084", 26310, 5262), ...encaissement("FA-2026-0084", 10000, "2026-06-01", { lettrage: "AA" })];
    const glLettre = gl.map((l) => l.reference_piece === "FA-2026-0084" && l.compte_numero === "34210001"
      ? { ...l, lettrage_code: "AA" } : l);
    const { montant, date } = attesteParGl(glLettre, f);

    const etat = projeterEtatReglement(f, montant, date, []);
    expect(etat.montant_paye).toBe(10000);
    expect(etat.montant_restant).toBe(21572);
    expect(etat.statut_paiement).toBe("partielle");
    expect(etat.date_reglement).toBe("2026-06-01");
  });

  it("DEUX acomptes successifs s'additionnent — la garde qui bloquait le second a bien disparu", () => {
    const etat = projeterEtatReglement(f, 0, null, [
      paiement({ montant: 10000, date_paiement: "2026-06-01", reference: "AC1" }),
      paiement({ montant: 15000, date_paiement: "2026-07-01", reference: "AC2" }),
    ]);
    expect(etat.montant_paye).toBe(25000);
    expect(etat.montant_restant).toBe(6572);
    expect(etat.statut_paiement).toBe("partielle");
    // La date retenue est celle du DERNIER versement, pas du premier.
    expect(etat.date_reglement).toBe("2026-07-01");
  });

  it("deux versements du même montant à des dates différentes ne sont PAS un doublon", () => {
    const examens = examinerPaiements(f, [
      paiement({ montant: 10000, date_paiement: "2026-06-01" }),
      paiement({ montant: 10000, date_paiement: "2026-07-01" }),
    ]);
    expect(examens.every((e) => e.recevable)).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. PAIEMENT TOTAL
// ═════════════════════════════════════════════════════════════════════════════

describe("2. paiement total", () => {
  // Le seul règlement de SMERT que la comptabilité porte vraiment.
  const f: FactureReglee = {
    id: "f2", numero: "09/60900087", date_facture: "2026-01-26", montant_ttc: 21000,
  };

  it("l'encaissement en caisse solde la facture et la date de SA pièce", () => {
    const gl = [
      ...vente("09/60900087", 17500, 3500, { client: "34210003", lettrage: "AA", date: "2026-01-26" }),
      ...encaissement("09/60900087", 21000, "2026-07-22", { client: "34210003", lettrage: "AA", journal: "CAI" }),
    ];
    const { montant, date } = attesteParGl(gl, f);
    const etat = projeterEtatReglement(f, montant, date, [
      paiement({ montant: 21000, date_paiement: "2026-07-22", origine: "manuel" }),
    ]);

    expect(etat.montant_paye).toBe(21000);
    expect(etat.montant_restant).toBe(0);
    expect(etat.statut_paiement).toBe("payee");
    expect(etat.date_reglement).toBe("2026-07-22");
    // La comptabilité porte le règlement : la pièce n'apporte rien de plus.
    expect(etat.preuve).toBe("grand_livre");
    expect(etat.aComptabiliser).toBe(0);
  });

  it("un règlement UNIQUE supérieur au TTC est retenu et PLAFONNÉ, jamais annulé", () => {
    // L'argent est arrivé, avec un trop-perçu. Le refuser ferait passer pour
    // impayée une facture plus que soldée — le trop-perçu relève d'un avoir.
    const etat = projeterEtatReglement(f, 0, null, [
      paiement({ montant: 25000, date_paiement: "2026-07-22" }),
    ]);
    expect(etat.montant_paye).toBe(21000);
    expect(etat.montant_restant).toBe(0);
    expect(etat.statut_paiement).toBe("payee");
    expect(etat.ecartees).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. PAIEMENT ABSENT
// ═════════════════════════════════════════════════════════════════════════════

describe("3. paiement absent", () => {
  const f: FactureReglee = {
    id: "f3", numero: "FEV-25002568", date_facture: "2025-12-16", montant_ttc: 24600,
  };

  it("aucune pièce, aucune écriture : la créance reste entière et sans date", () => {
    const etat = projeterEtatReglement(f, 0, null, []);
    expect(etat.montant_paye).toBe(0);
    expect(etat.montant_restant).toBe(24600);
    expect(etat.statut_paiement).toBe("non_payee");
    expect(etat.date_reglement).toBeNull();
    expect(etat.preuve).toBe("aucune");
  });

  it("la créance non réglée reste dans l'encours du grand livre", () => {
    const gl = vente("FEV-25002568", 20500, 4100);
    expect(encoursTiersGrandLivre(gl).total).toBe(24600);
  });

  it("un montant nul n'est pas un règlement", () => {
    const [e] = examinerPaiements(f, [paiement({ montant: 0, date_paiement: "2026-01-05" })]);
    expect(e.recevable).toBe(false);
    expect(e.motifs).toContain("montant_nul");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. PAIEMENT AVANT LA FACTURE — le défaut SMERT
// ═════════════════════════════════════════════════════════════════════════════

describe("4. paiement antérieur à la facture", () => {
  const agaf: FactureReglee = {
    id: "f-agaf", numero: "FA 0005", date_facture: "2026-03-11", montant_ttc: 50400,
  };
  const riegonor: FactureReglee = {
    id: "f-0084", numero: "FA-2026-0084", date_facture: "2026-05-17", montant_ttc: 31572,
  };

  it("AGAF : un virement du 02/03 ne règle pas une facture du 11/03", () => {
    const [e] = examinerPaiements(agaf, [
      paiement({ montant: 50400, date_paiement: "2026-03-02", origine: "lettrage", transaction_id: "tx-agaf" }),
    ]);
    expect(e.recevable).toBe(false);
    expect(e.motifs).toEqual(["anterieur_facture"]);
    expect(e.message).toMatch(/réglé le 2026-03-02 pour une facture du 2026-03-11/);
  });

  it("FA-2026-0084 : soixante-huit jours d'avance, la facture redevient non payée", () => {
    const etat = projeterEtatReglement(riegonor, 0, null, [
      paiement({ montant: 31572, date_paiement: "2026-03-10", origine: "lettrage", transaction_id: "tx-0084" }),
    ]);
    expect(etat.montant_paye).toBe(0);
    expect(etat.montant_restant).toBe(31572);
    expect(etat.statut_paiement).toBe("non_payee");
    expect(etat.date_reglement).toBeNull();
    expect(etat.ecartees).toHaveLength(1);
  });

  it("LE VERROU CENTRAL : une pièce impossible ne l'emporte plus sur un grand livre correct", () => {
    // C'est exactement ce qui tenait 81 972 MAD de créances affichées encaissées.
    // La réconciliation retenait le MAXIMUM des deux preuves ; une pièce fausse
    // gagnait donc contre un grand livre vide, à chaque resynchronisation.
    const gl = vente("FA-2026-0084", 26310, 5262);
    const situation = situationFactureGrandLivre(gl, {
      references: ["FA-2026-0084"], id: "f-0084", montant_ttc: 31572, sens: "client",
    });
    const projete = projeterSituationFacture(
      situation, [{ montant: 31572, date: "2026-03-10", transaction_id: "tx-0084" }], 31572,
      { id: "f-0084", numero: "FA-2026-0084", date_facture: "2026-05-17" },
    );
    expect(projete.montant_paye).toBe(0);
    expect(projete.montant_restant).toBe(31572);
    expect(projete.statut_paiement).toBe("non_payee");
  });

  it("REPERAL : la date de paiement recalée sur 2026 ne suffit pas, la PIÈCE reste de 2024", () => {
    // La ligne `paiements` portait 2026-07-16 — crédible — pendant que son chèque
    // restait daté du 16/07/2024. Contrôler la seule date de saisie laisse
    // passer un règlement dont la justification est impossible.
    const f: FactureReglee = {
      id: "f-rep", numero: "FAC002_2026", date_facture: "2026-06-20", montant_ttc: 14785,
    };
    // La date de saisie, prise seule, est parfaitement recevable…
    const [surSaisie] = examinerPaiements(f, [
      paiement({ montant: 14785, date_paiement: "2026-07-16", transaction_id: "tx-rep" }),
    ]);
    expect(surSaisie.recevable).toBe(true);
    // …c'est la DATE DE LA PIÈCE qui est impossible, et c'est le trigger SQL
    // `paiements_valider` qui la contrôle (invariant 1b de la migration).
    const [surPiece] = examinerPaiements(f, [
      paiement({ montant: 14785, date_paiement: "2024-07-16", transaction_id: "tx-rep" }),
    ]);
    expect(surPiece.recevable).toBe(false);
    expect(surPiece.motifs).toContain("anterieur_facture");
  });

  it("une facture SANS date d'émission ne bloque rien : on refuse le faux, pas l'inconnu", () => {
    const sansDate: FactureReglee = { id: "x", numero: "IMPORT-1", montant_ttc: 1000 };
    const [e] = examinerPaiements(sansDate, [paiement({ montant: 1000, date_paiement: "2020-01-01" })]);
    expect(e.recevable).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. DOUBLON
// ═════════════════════════════════════════════════════════════════════════════

describe("5. doublon", () => {
  const f: FactureReglee = {
    id: "f5", numero: "FAC002_2026", date_facture: "2026-06-20", montant_ttc: 14785,
  };

  it("la même ligne de relevé, insérée deux fois, ne règle qu'une fois", () => {
    const p = paiement({ montant: 14785, date_paiement: "2026-07-16", transaction_id: "tx-rep" });
    const etat = projeterEtatReglement(f, 0, null, [p, { ...p }]);
    expect(etat.montant_paye).toBe(14785);
    expect(etat.ecartees).toHaveLength(1);
    expect(etat.ecartees[0].motifs).toContain("doublon");
  });

  it("le double clic sur « Enregistrer » ne solde pas la facture deux fois", () => {
    const saisie = paiement({ montant: 7000, date_paiement: "2026-07-16", reference: "CHQ-41" });
    const recus = paiementsRecevables(f, [saisie, { ...saisie }, { ...saisie }]);
    expect(recus).toHaveLength(1);
  });

  it("TROIS saisies identiques donnent un accepté et DEUX rejetés, jamais un réadmis", () => {
    const saisie = paiement({ montant: 7000, date_paiement: "2026-07-16", reference: "CHQ-41" });
    const examens = examinerPaiements(f, [saisie, { ...saisie }, { ...saisie }]);
    expect(examens.filter((e) => e.recevable)).toHaveLength(1);
    expect(examens.filter((e) => !e.recevable)).toHaveLength(2);
  });

  it("l'identité vient de la PIÈCE quand elle existe, de la saisie sinon", () => {
    expect(clePaiement(paiement({ transaction_id: "tx-1", montant: 5 }))).toBe("tx:tx-1");
    expect(clePaiement(paiement({ encaissement_id: "e-1", montant: 5 }))).toBe("enc:e-1");
    expect(clePaiement(paiement({ montant: 5, date_paiement: "2026-07-16", reference: "A" })))
      .toBe("saisie:2026-07-16|5.00|a");
  });

  it("un SECOND règlement qui fait déborder le TTC est écarté — la signature du double comptage", () => {
    const examens = examinerPaiements(f, [
      paiement({ montant: 14785, date_paiement: "2026-07-16", reference: "CHQ-41" }),
      paiement({ montant: 14785, date_paiement: "2026-07-17", reference: "CHQ-42" }),
    ]);
    expect(examens[0].recevable).toBe(true);
    expect(examens[1].recevable).toBe(false);
    expect(examens[1].motifs).toContain("surpaiement");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. LETTRAGE INCOHÉRENT
// ═════════════════════════════════════════════════════════════════════════════

describe("6. lettrage incohérent", () => {
  it("un code équilibré ne déclenche rien", () => {
    const gl = [
      ...vente("V", 17500, 3500, { lettrage: "AA" }),
      ...encaissement("V", 21000, "2026-07-22", { lettrage: "AA" }),
    ].map((l) => l.compte_numero === "34210001" ? { ...l, lettrage_code: "AA" } : l);
    // Seules les lignes de tiers portent le code ; le contrôle porte sur elles.
    const tiers = gl.filter((l) => l.lettrage_code === "AA" && l.compte_numero === "34210001");
    expect(controlerEquilibreLettrage(tiers)).toHaveLength(0);
  });

  it("un règlement PARTIEL lettré comme s'il soldait la facture est dénoncé", () => {
    const gl = [
      ligne({ compte_numero: "34210001", debit: 31572, reference_piece: "FA-2026-0084", lettrage_code: "AB" }),
      ligne({ journal_code: "BQ", compte_numero: "34210001", credit: 10000, lettrage_code: "AB" }),
    ];
    const [a] = controlerEquilibreLettrage(gl);
    expect(a.code).toBe("AB");
    expect(a.ecart).toBe(21572);
    expect(a.message).toMatch(/SORTIR ses lignes de l'encours/);
  });

  it("un délettrage incomplet — une ligne supprimée d'un côté — est dénoncé", () => {
    const gl = [ligne({ journal_code: "BQ", compte_numero: "34210001", credit: 21000, lettrage_code: "AA" })];
    expect(controlerEquilibreLettrage(gl)[0].ecart).toBe(-21000);
  });

  it("LE DANGER : un code déséquilibré retire de l'encours une créance NON réglée", () => {
    // La partie double du grand livre reste vraie ; seul le sous-ensemble lettré
    // ne l'est pas. Aucun contrôle d'équilibre global ne peut le voir.
    const gl = [
      ligne({ compte_numero: "34210001", debit: 31572, reference_piece: "FA-2026-0084", lettrage_code: "AB" }),
      ligne({ journal_code: "BQ", compte_numero: "34210001", credit: 10000, lettrage_code: "AB" }),
      ligne({ journal_code: "BQ", compte_numero: "51410000", debit: 10000 }),
      ligne({ compte_numero: "71110000", credit: 26310, reference_piece: "FA-2026-0084" }),
      ligne({ compte_numero: "44580000", credit: 5262, reference_piece: "FA-2026-0084" }),
    ];
    const partieDouble = gl.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);
    expect(Math.round(partieDouble * 100) / 100).toBe(0);     // le grand livre est équilibré…
    expect(encoursTiersGrandLivre(gl).total).toBe(0);          // …et pourtant l'encours est vide
    expect(controlerEquilibreLettrage(gl)).toHaveLength(1);    // seul ce contrôle le voit
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. TVA INCOHÉRENTE
// ═════════════════════════════════════════════════════════════════════════════

describe("7. TVA incohérente", () => {
  it("un taux qui n'existe pas au Maroc n'est PAS un arrondi", () => {
    const c = controlerCoherenceMontants({ ht: 10000, tva: 1750, ttc: 11750 });
    expect(c.ok).toBe(false);
    expect(c.cause).toBe("taux_incoherent");
    expect(c.tauxEffectif).toBe(17.5);
    expect(c.message).toMatch(/ne pas l'ajuster au centime/);
  });

  it("HT + TVA ≠ TTC au-delà de l'arrondi : un des trois montants est faux", () => {
    const c = controlerCoherenceMontants({ ht: 26310, tva: 5262, ttc: 31000 }, 1);
    expect(c.ok).toBe(false);
    expect(c.cause).toBe("total_incoherent");
    expect(c.ecart).toBe(572);
  });

  it("les six factures SMERT vérifient toutes HT × taux = TVA et HT + TVA = TTC", () => {
    const reelles = [
      { nom: "ACOSOLUTIONS", ht: 20500, tva: 4100, ttc: 24600, lignes: 1 },
      { nom: "UNIMAGRI", ht: 14583.33, tva: 2916.67, ttc: 17500, lignes: 1 },
      { nom: "PRO-FLUIDES", ht: 2190.85, tva: 438.17, ttc: 2629.02, lignes: 2 },
      { nom: "IAM", ht: 481.66, tva: 96.33, ttc: 577.99, lignes: 2 },
      { nom: "TESDRAMENVEST", ht: 360.83, tva: 72.17, ttc: 433.00, lignes: 2 },
      { nom: "REPERAL", ht: 12320.83, tva: 2464.17, ttc: 14785.00, lignes: 1 },
    ];
    for (const f of reelles) {
      const c = controlerCoherenceMontants(f, f.lignes);
      expect(c.ok, `${f.nom} : ${c.message}`).toBe(true);
      expect(c.tauxReconnu, f.nom).toBe(20);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. ARRONDI — identifié, jamais « corrigé »
// ═════════════════════════════════════════════════════════════════════════════

describe("8. arrondi", () => {
  it("PRO-FLUIDES : la facture est JUSTE, l'écart est entre elle et le chèque", () => {
    // 1 × 1 450,00 + 5 × 148,17 = 2 190,85 HT ; 20 % = 438,17 ; TTC = 2 629,02.
    // Le chèque n° 0398450 porte 2 629,00 : deux centimes de moins.
    const c = controlerCoherenceMontants({ ht: 2190.85, tva: 438.17, ttc: 2629.02 }, 2);
    expect(c.ok).toBe(true);
    expect(c.cause).toBe("aucune");

    const f: FactureReglee = {
      id: "f8", numero: "FA-2026-00964", date_facture: "2026-03-10", montant_ttc: 2629.02,
    };
    const etat = projeterEtatReglement(f, 0, null, [
      paiement({ montant: 2629.00, date_paiement: "2026-03-30", reference: "CHQ-0398450" }),
    ]);
    // Le seuil décide d'un STATUT ; il n'efface aucun centime.
    expect(etat.statut_paiement).toBe("payee");
    expect(etat.montant_restant).toBe(0.02);
    expect(etat.montant_paye).toBe(2629.00);
  });

  it("le reste dû n'est JAMAIS lissé par la tolérance de statut", () => {
    const f: FactureReglee = { id: "f8b", numero: "X", date_facture: "2026-01-01", montant_ttc: 1000 };
    const etat = projeterEtatReglement(f, 0, null, [
      paiement({ montant: 999.05, date_paiement: "2026-02-01" }),
    ]);
    expect(etat.statut_paiement).toBe("payee");         // reste < 1 MAD
    expect(etat.montant_restant).toBe(0.95);            // mais le centime survit
    expect(TOLERANCE_REGLEMENT).toBe(1);
  });

  it("un arrondi de LIGNES est expliqué, et déclaré sans correction à faire", () => {
    // Trois lignes à 33,333 HT : la TVA ligne à ligne peut décaler le total.
    const c = controlerCoherenceMontants({ ht: 100, tva: 20, ttc: 120.02 }, 3);
    expect(c.cause).toBe("arrondi_lignes");
    expect(c.ok).toBe(true);
    expect(c.message).toMatch(/aucune correction à faire/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. MOUVEMENT 471 NON IDENTIFIÉ
// ═════════════════════════════════════════════════════════════════════════════

describe("9. compte d'attente 47 non identifié", () => {
  // Le 47120000 de SMERT : 41 500 MAD depuis le 31/07/2024, contrepartie d'un
  // « ENCAISSEMENT EFFET N 7402907 TIRE SUR ATW » qui ne correspond au montant
  // d'aucune facture du dossier.
  const balance: LigneBalance[] = [
    { compte: "71110000", total_debit: 0, total_credit: 85810 } as LigneBalance,
    { compte: "61110000", total_debit: 37274, total_credit: 0 } as LigneBalance,
    { compte: "47120000", total_debit: 0, total_credit: 41500 } as LigneBalance,
  ];

  it("le résultat n'est pas déclaré définitif tant que l'attente n'est pas imputée", () => {
    const r = resultatDefinitif(balance);
    expect(r.definitif).toBe(false);
    expect(r.enAttente).toBe(41500);
    expect(r.provisoire.resultat).toBe(48536);
    expect(r.reserve).toMatch(/NON DÉFINITIF/);
  });

  it("la fourchette est SYMÉTRIQUE : on ignore de quel côté l'attente ira", () => {
    const r = resultatDefinitif(balance);
    expect(r.borneBasse).toBe(48536 - 41500);
    expect(r.borneHaute).toBe(48536 + 41500);
  });

  it("RIEN n'est imputé d'office : le résultat provisoire reste intact", () => {
    // Le ranger en produit gonflerait le résultat de 41 500, en charge il le
    // creuserait d'autant. Aucune des deux erreurs n'est meilleure que la
    // réserve — le montant reste au 47, et il est dit.
    const r = resultatDefinitif(balance);
    expect(r.provisoire.produits).toBe(85810);
    expect(r.provisoire.charges).toBe(37274);
  });

  it("un dossier sans attente rend un résultat DÉFINITIF et sans réserve", () => {
    const r = resultatDefinitif(balance.filter((l) => !l.compte.startsWith("47")));
    expect(r.definitif).toBe(true);
    expect(r.reserve).toBeNull();
    expect(r.borneBasse).toBe(r.borneHaute);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. RESYNCHRONISATION FACTURE / PAIEMENT
// ═════════════════════════════════════════════════════════════════════════════

describe("10. resynchronisation facture ⇄ paiement", () => {
  const f: FactureReglee = {
    id: "f-0084", numero: "FA-2026-0084", date_facture: "2026-05-17", montant_ttc: 31572,
  };

  it("détecte l'état SMERT : colonnes « payée » contre grand livre ouvert", () => {
    const projete = projeterEtatReglement(f, 0, null, [
      paiement({ montant: 31572, date_paiement: "2026-03-10", transaction_id: "tx-0084" }),
    ]);
    const stocke = {
      montant_paye: 31572, montant_restant: 0,
      statut_paiement: "payee", date_paiement: "2026-03-10",
    };
    expect(reglementDivergent(stocke, projete)).toBe(true);
  });

  it("ne touche PAS une facture déjà cohérente — la resynchronisation est idempotente", () => {
    const gl = [
      ...vente("FA-2026-0084", 26310, 5262, { lettrage: "AA" }),
      ...encaissement("FA-2026-0084", 31572, "2026-06-01", { lettrage: "AA" }),
    ];
    const { montant, date } = attesteParGl(gl, f);
    const projete = projeterEtatReglement(f, montant, date, []);
    const stocke = {
      montant_paye: 31572, montant_restant: 0,
      statut_paiement: "payee", date_paiement: "2026-06-01",
    };
    expect(reglementDivergent(stocke, projete)).toBe(false);
    // IDEMPOTENCE : écrire le résultat de la projection, puis la rejouer, ne
    // doit plus rien bouger. C'est ce qui garantit qu'une resynchronisation
    // périodique ne fera pas osciller les colonnes d'un passage à l'autre.
    const ecrit = {
      montant_paye: projete.montant_paye,
      montant_restant: projete.montant_restant,
      statut_paiement: projete.statut_paiement,
      date_paiement: projete.date_reglement,
    };
    const rejoue = projeterEtatReglement(f, montant, date, []);
    expect(reglementDivergent(ecrit, rejoue)).toBe(false);
  });

  it("SENS INVERSE : un règlement comptabilisé mais non reporté sur la facture est rattrapé", () => {
    const gl = [
      ...vente("FA-2026-0084", 26310, 5262, { lettrage: "AA" }),
      ...encaissement("FA-2026-0084", 31572, "2026-06-01", { lettrage: "AA" }),
    ];
    const { montant, date } = attesteParGl(gl, f);
    const projete = projeterEtatReglement(f, montant, date, []);
    const stocke = { montant_paye: 0, montant_restant: 31572, statut_paiement: "non_payee", date_paiement: null };
    expect(reglementDivergent(stocke, projete)).toBe(true);
    expect(projete.statut_paiement).toBe("payee");
  });

  it("une pièce recevable NON comptabilisée est signalée, pas comptée en douce", () => {
    const projete = projeterEtatReglement(f, 0, null, [
      paiement({ montant: 31572, date_paiement: "2026-06-01", origine: "manuel" }),
    ]);
    expect(projete.preuve).toBe("piece");
    expect(projete.aComptabiliser).toBe(31572);
  });

  it("en mode STRICT, seule la comptabilité fait foi", () => {
    const projete = projeterEtatReglement(f, 0, null, [
      paiement({ montant: 31572, date_paiement: "2026-06-01", origine: "manuel" }),
    ], { accepterPiecesNonComptabilisees: false });
    expect(projete.montant_paye).toBe(0);
    expect(projete.statut_paiement).toBe("non_payee");
    // La pièce n'est pas perdue pour autant : elle reste à comptabiliser.
    expect(projete.aComptabiliser).toBe(31572);
  });

  it("les KPI se recalent sur la comptabilité, pas sur le TTC des factures", () => {
    // L'état SMERT après correction : trois factures émises pour 102 972 TTC,
    // un seul encaissement comptabilisé de 21 000.
    const gl = [
      ...vente("09/60900087", 17500, 3500, { client: "34210003", lettrage: "AA" }),
      ...encaissement("09/60900087", 21000, "2026-07-22", { client: "34210003", lettrage: "AA", journal: "CAI" }),
      ...vente("FA 0005", 42000, 8400, { client: "34210001" }),
      ...vente("FA-2026-0084", 26310, 5262, { client: "34210003" }),
    ];
    expect(caHtGrandLivre(gl).montant).toBe(85810);                    // 17 500 + 42 000 + 26 310
    expect(encaissementsTiersGrandLivre(gl).montant).toBe(21000);      // le seul encaissement réel
    expect(encoursTiersGrandLivre(gl).total).toBe(81972);              // 50 400 + 31 572 restent dus
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 11. PÉRIMÈTRE — ce que la comptabilité n'a PAS à porter
// ═════════════════════════════════════════════════════════════════════════════

describe("11. facture hors périmètre comptable", () => {
  // Les chiffres réels de SOMADIR S.A. : quatre créances ouvertes comptabilisées
  // pour 33 432 MAD, plus F2024-001 — 16 200 MAD REJETÉE par la DGI, jamais
  // encaissée et, à juste titre, jamais comptabilisée.
  const ouvertes = [
    { numero: "FAC-2024-308", ttc: 1200, client: "34210005" },
    { numero: "FAC-2024-309", ttc: 10800, client: "34210005" },
    { numero: "FAC-2024-102", ttc: 10632, client: "34210004" },
    { numero: "FAC-2024-306", ttc: 10800, client: "34210005" },
  ];
  const gl = ouvertes.flatMap((f) =>
    vente(f.numero, f.ttc / 1.2, f.ttc - f.ttc / 1.2, { client: f.client }));

  const facturesVente: FactureVente[] = [
    ...ouvertes.map((f) => ({
      id: f.numero, numero: f.numero, type: "facture", statut: "conforme",
      statut_paiement: "non_payee", date_facture: "2026-04-20", date_paiement: null,
      montant_ht: f.ttc / 1.2, montant_ttc: f.ttc, montant_paye: 0, montant_restant: f.ttc,
    })),
    {
      id: "F2024-001", numero: "F2024-001", type: "facture", statut: "rejetee",
      statut_paiement: "non_payee", date_facture: "2026-05-02", date_paiement: null,
      montant_ht: 13500, montant_ttc: 16200, montant_paye: 0, montant_restant: 16200,
    },
  ];

  it("une facture REJETÉE n'a aucune ligne 342x — et c'est CORRECT", () => {
    // `generateFactureXml` ne comptabilise que les pièces conformes. L'absence
    // d'écriture n'est pas un oubli, c'est la règle.
    expect(gl.filter((l) => l.reference_piece === "F2024-001")).toHaveLength(0);
    expect(encoursTiersGrandLivre(gl).total).toBe(33432);
  });

  it("LE FAUX POSITIF : la compter dans le rapprochement fabrique un écart de 16 200", () => {
    // C'est l'erreur qu'avait la station REPORTING du contrôle de chaîne : elle
    // filtrait les statuts non comptabilisables pour le CA, et les avait oubliés
    // pour l'encours. Les DEUX chiffres étaient justes ; seul le rapprochement
    // comparait des périmètres différents.
    const naif = facturesVente
      .filter((f) => f.statut_paiement !== "payee")
      .reduce((s, f) => s + Number(f.montant_restant), 0);
    expect(naif).toBe(49632);
    expect(naif - encoursTiersGrandLivre(gl).total).toBe(16200);
  });

  it("à périmètre ÉGAL, l'encours se rapproche exactement", () => {
    const r = rapprocherEncoursClients(facturesVente, gl);
    expect(r.encoursGrandLivre).toBe(33432);
    expect(r.encoursFactures).toBe(33432);
    expect(r.ecart).toBe(0);
    expect(r.ok).toBe(true);
  });

  it("la créance rejetée n'est pas EFFACÉE pour autant — elle sort du rapprochement, pas des livres", () => {
    // La resynchroniser à zéro « pour faire tomber juste » prétendrait qu'une
    // facture de 16 200 MAD est soldée alors que rien n'a été encaissé.
    const rejetee = facturesVente.find((f) => f.statut === "rejetee")!;
    expect(estComptabilisable(rejetee)).toBe(false);
    expect(Number(rejetee.montant_restant)).toBe(16200);

    const ca = rapprocherCaProduits(facturesVente, gl);
    expect(ca.horsPerimetre.map((f) => f.numero)).toEqual(["F2024-001"]);
    expect(ca.htHorsPerimetre).toBe(13500);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Garde-fou transverse
// ═════════════════════════════════════════════════════════════════════════════

describe("les pièces écartées ne sont jamais silencieuses", () => {
  it("chaque rejet porte son motif ET sa formulation en clair", () => {
    const f: FactureReglee = {
      id: "f", numero: "FA 0005", date_facture: "2026-03-11", montant_ttc: 50400,
    };
    const rejets = paiementsIrrecevables(f, [
      paiement({ montant: 50400, date_paiement: "2026-03-02", transaction_id: "tx" }),
      paiement({ montant: 0, date_paiement: "2026-04-01" }),
    ]);
    expect(rejets).toHaveLength(2);
    for (const r of rejets) {
      expect(r.motifs.length).toBeGreaterThan(0);
      expect(r.message).toBeTruthy();
      expect(r.message).toContain("FA 0005");
    }
  });
});
