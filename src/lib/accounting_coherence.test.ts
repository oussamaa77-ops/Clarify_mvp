// ============================================================================
// accounting_coherence.test.ts — Les invariants de la chaîne Ventes ⇄ Compta.
//
// Ce fichier ne teste pas des fonctions : il teste des ÉGALITÉS COMPTABLES. Une
// régression ici veut dire qu'un chiffre affiché à l'utilisateur ment.
//
//   (a) CA HT des factures        =  crédits nets de classe 7
//   (b) encours clients            =  postes 342x non lettrés
//   (c) aucun crédit 4191 sur une facture de vente ordinaire
//   (d) statut « payée »           ⇒ encaissement attesté en trésorerie
//   (e) date de règlement          ≥ date de facture
//
// Les scénarios reproduisent des cas RÉELS relevés en base (FA-2026-0084 réglée
// deux mois avant son émission, FA 0005 en acompte, FA-2024-0892 lettrée sans
// écriture de trésorerie estampillée). Une facture inventée testerait le code ;
// celles-ci testent le métier.
// ============================================================================

import { describe, it, expect } from "vitest";
import {
  acomptesIndus, auditerCoherenceVentes, corrigerAnneeReglement,
  datesReglementIncoherentes, preuveEncaissement, rapprocherCaProduits,
  rapprocherEncoursClients, recalerDateReglement, statutsARecalibrer,
  type FactureVente,
} from "@/lib/coherence-ventes";
import {
  assertLignesVente, controlerLignesVente, lignesEcrituresVente,
  normaliserTypeVente, COMPTE_ACOMPTES_CLIENTS,
} from "@/lib/ecritures-vente";
import { validerDateReglement } from "@/lib/date-reglement";
import {
  bornesExercice, dansExercice, exerciceParDefaut, exercicesDisponibles,
  filtrerExercice, horsExercice,
} from "@/lib/exercice-comptable";
import type { LigneGrandLivre } from "@/lib/encours-grandlivre";

// ─── Fabriques ───────────────────────────────────────────────────────────────

const facture = (p: Partial<FactureVente> & { id: string }): FactureVente => ({
  numero: p.id, type: "facture", statut: "conforme", statut_paiement: "non_payee",
  date_facture: "2026-05-17", date_paiement: null,
  montant_ht: 0, montant_ttc: 0, montant_paye: 0, montant_restant: 0, ...p,
});

const ligne = (p: Partial<LigneGrandLivre>): LigneGrandLivre => ({
  id: Math.random().toString(36).slice(2), journal_code: "VTE", compte_numero: "3421",
  date_ecriture: "2026-05-17", debit: 0, credit: 0, reference_piece: null,
  lettrage_code: null, facture_id: null, ...p,
});

/** Les trois lignes d'une vente ordinaire, telles que le générateur les produit. */
const venteComptabilisee = (
  ref: string, ht: number, tva: number, opts: { compte?: string; client?: string; lettrage?: string } = {},
): LigneGrandLivre[] => [
  ligne({ compte_numero: opts.client ?? "34210001", debit: ht + tva, reference_piece: ref, lettrage_code: opts.lettrage ?? null }),
  ligne({ compte_numero: opts.compte ?? "7111", credit: ht, reference_piece: ref }),
  ligne({ compte_numero: "4458", credit: tva, reference_piece: ref }),
];

// ─── (c) L'invariant du générateur ───────────────────────────────────────────

describe("(c) le journal des ventes ne crédite jamais le 4191 hors acompte", () => {
  const ctx = {
    dossier_id: "D", facture_id: "F1", reference: "FAC-001", date_facture: "2026-05-17",
    montant_ht: 26310, montant_tva: 5262, montant_ttc: 31572,
    compte_client: "34210003", compte_produit: "7124",
  };

  it("facture ordinaire : le produit est crédité, le 4191 est absent", () => {
    const l = lignesEcrituresVente({ ...ctx, type: "facture" });
    expect(l.some((x) => x.compte_numero === COMPTE_ACOMPTES_CLIENTS)).toBe(false);
    expect(l.find((x) => x.compte_numero === "7124")?.credit).toBe(26310);
    expect(controlerLignesVente(l, "facture").ok).toBe(true);
  });

  it("facture d'acompte : le 4191 est crédité, AUCUN produit ne l'est", () => {
    const l = lignesEcrituresVente({ ...ctx, type: "acompte" });
    expect(l.find((x) => x.compte_numero === COMPTE_ACOMPTES_CLIENTS)?.credit).toBe(26310);
    expect(l.some((x) => x.compte_numero.startsWith("7"))).toBe(false);
    expect(controlerLignesVente(l, "acompte").ok).toBe(true);
  });

  it("facture de solde : le produit est constaté ET le 4191 soldé par l'OD", () => {
    const l = lignesEcrituresVente({ ...ctx, type: "solde" });
    const solde4191 = l
      .filter((x) => x.compte_numero === COMPTE_ACOMPTES_CLIENTS)
      .reduce((s, x) => s + x.debit - x.credit, 0);
    // Le débit de l'OD annule l'avance : sans acompte antérieur il resterait
    // débiteur, c'est le prix à payer pour que la paire acompte/solde boucle.
    expect(solde4191).toBe(26310);
    expect(l.filter((x) => x.journal_code === "OD")).toHaveLength(2);
    expect(controlerLignesVente(l, "solde").ok).toBe(true);
  });

  it("les trois jeux respectent la partie double", () => {
    for (const type of ["facture", "acompte", "solde"] as const) {
      expect(controlerLignesVente(lignesEcrituresVente({ ...ctx, type }), type).ecart).toBe(0);
    }
  });

  it("un type inconnu est traité comme une facture ORDINAIRE, pas comme un acompte", () => {
    // C'est le sens de sécurité utile : dans le doute on constate le produit.
    expect(normaliserTypeVente("avoir")).toBe("facture");
    expect(normaliserTypeVente(null)).toBe("facture");
    expect(normaliserTypeVente("Acompte")).toBe("acompte");
  });

  it("l'assertion REFUSE un crédit du 4191 glissé sur une facture ordinaire", () => {
    const l = lignesEcrituresVente({ ...ctx, type: "acompte" });
    // Mêmes lignes, mais présentées comme une facture ordinaire : c'est
    // exactement la régression que l'invariant doit intercepter.
    expect(() => assertLignesVente(l, "facture")).toThrow(/4191/);
  });

  it("l'assertion REFUSE une vente sans aucun produit de classe 7", () => {
    const l = lignesEcrituresVente({ ...ctx, type: "facture" })
      .map((x) => (x.compte_numero === "7124" ? { ...x, compte_numero: "4191" } : x));
    expect(() => assertLignesVente(l, "facture")).toThrow();
  });

  it("détecte le crédit 4191 sur le STOCK d'écritures, pas seulement au flux", () => {
    const f = facture({ id: "F1", montant_ht: 42000, montant_ttc: 50400 });
    const lignes = [
      ligne({ compte_numero: "34210001", debit: 50400, reference_piece: "F1" }),
      ligne({ compte_numero: "4191", credit: 42000, reference_piece: "F1" }),
      ligne({ compte_numero: "44551", credit: 8400, reference_piece: "F1" }),
    ];
    const indus = acomptesIndus([f], lignes, () => "7124");
    expect(indus).toHaveLength(1);
    expect(indus[0].montant).toBe(42000);
    expect(indus[0].compteCible).toBe("7124");

    // La même facture typée « acompte » est parfaitement régulière.
    expect(acomptesIndus([{ ...f, type: "acompte" }], lignes, () => "7124")).toHaveLength(0);
  });
});

// ─── (a) CA HT ⇄ classe 7 ────────────────────────────────────────────────────

describe("(a) le CA HT facturé égale les crédits de classe 7", () => {
  it("s'équilibre quand chaque facture est comptabilisée", () => {
    const factures = [
      facture({ id: "A", montant_ht: 26310, montant_ttc: 31572 }),
      facture({ id: "B", montant_ht: 17500, montant_ttc: 21000 }),
    ];
    const lignes = [...venteComptabilisee("A", 26310, 5262), ...venteComptabilisee("B", 17500, 3500)];
    const r = rapprocherCaProduits(factures, lignes);
    expect(r.caHt).toBe(43810);
    expect(r.credits7).toBe(43810);
    expect(r.ok).toBe(true);
  });

  it("dénonce une facture jamais comptabilisée, et la nomme", () => {
    // Cas réel SOMADIR : F2024-001 (13 500 HT) rejetée à la DGI, donc jamais
    // portée au journal — l'écart de 13 500 venait de là, pas d'un 4191.
    const factures = [
      facture({ id: "F2024-001", montant_ht: 13500, montant_ttc: 16200 }),
      facture({ id: "OK", montant_ht: 9400, montant_ttc: 11280 }),
    ];
    const r = rapprocherCaProduits(factures, venteComptabilisee("OK", 9400, 1880));
    expect(r.ok).toBe(false);
    expect(r.ecart).toBe(13500);
    expect(r.nonComptabilisees.map((f) => f.numero)).toEqual(["F2024-001"]);
  });

  it("EXCLUT une facture REJETÉE : la comptabilité n'a pas à la porter", () => {
    // Cas réel SOMADIR : F2024-001 rejetée par la DGI, donc jamais comptabilisée
    // — à juste titre. La compter fabriquait un écart permanent de 13 500 MAD
    // qui n'était pas une anomalie.
    const factures = [
      facture({ id: "F2024-001", statut: "rejetee", montant_ht: 13500, montant_ttc: 16200, montant_restant: 16200 }),
      facture({ id: "OK", montant_ht: 9400, montant_ttc: 11280 }),
    ];
    const r = rapprocherCaProduits(factures, venteComptabilisee("OK", 9400, 1880));
    expect(r.ok).toBe(true);
    expect(r.caHt).toBe(9400);
    // Elle n'est pas ignorée pour autant : elle ressort, chiffrée et nommée.
    expect(r.horsPerimetre.map((f) => f.numero)).toEqual(["F2024-001"]);
    expect(r.htHorsPerimetre).toBe(13500);
    // …et ne fausse pas non plus l'encours, faute de ligne 342x.
    expect(rapprocherEncoursClients(factures, venteComptabilisee("OK", 9400, 1880)).ok).toBe(true);
  });

  it("EXCLUT les acomptes du CA : une avance n'est pas un produit", () => {
    const factures = [
      facture({ id: "ACPT", type: "acompte", montant_ht: 42000, montant_ttc: 50400 }),
      facture({ id: "V", montant_ht: 17500, montant_ttc: 21000 }),
    ];
    const r = rapprocherCaProduits(factures, venteComptabilisee("V", 17500, 3500));
    expect(r.caHt).toBe(17500);
    expect(r.ok).toBe(true);
  });

  it("un crédit 4191 au lieu du produit casse l'égalité du montant exact", () => {
    const f = facture({ id: "X", montant_ht: 42000, montant_ttc: 50400 });
    const lignes = [
      ligne({ compte_numero: "34210001", debit: 50400, reference_piece: "X" }),
      ligne({ compte_numero: "4191", credit: 42000, reference_piece: "X" }),
      ligne({ compte_numero: "4458", credit: 8400, reference_piece: "X" }),
    ];
    expect(rapprocherCaProduits([f], lignes).ecart).toBe(42000);
    // …et l'égalité est rétablie une fois la ligne reclassée par le script.
    const reclassees = lignes.map((l) => (l.compte_numero === "4191" ? { ...l, compte_numero: "7124" } : l));
    expect(rapprocherCaProduits([f], reclassees).ok).toBe(true);
  });
});

// ─── (b) Encours ⇄ 342x non lettré ───────────────────────────────────────────

describe("(b) l'encours clients égale les postes 342x non lettrés", () => {
  it("s'équilibre sur une facture ouverte", () => {
    const f = facture({ id: "A", montant_ht: 20000, montant_ttc: 24000, montant_restant: 24000 });
    const r = rapprocherEncoursClients([f], venteComptabilisee("A", 20000, 4000));
    expect(r.encoursGrandLivre).toBe(24000);
    expect(r.encoursFactures).toBe(24000);
    expect(r.ok).toBe(true);
  });

  it("une facture lettrée sort de l'encours des DEUX côtés", () => {
    const f = facture({
      id: "A", montant_ht: 17500, montant_ttc: 21000,
      statut_paiement: "payee", montant_paye: 21000, montant_restant: 0,
    });
    const lignes = [
      ...venteComptabilisee("A", 17500, 3500, { lettrage: "AA" }),
      ligne({ journal_code: "CAI", compte_numero: "34210001", credit: 21000, lettrage_code: "AA", date_ecriture: "2026-07-22" }),
      ligne({ journal_code: "CAI", compte_numero: "51610000", debit: 21000, date_ecriture: "2026-07-22" }),
    ];
    const r = rapprocherEncoursClients([f], lignes);
    expect(r.encoursGrandLivre).toBe(0);
    expect(r.encoursFactures).toBe(0);
    expect(r.ok).toBe(true);
  });

  it("dénonce le cas SMERT : facture « payée » alors que son 342x reste ouvert", () => {
    // 31 572 débiteurs au grand livre, 0 de reste dû sur la facture : l'encours
    // du tableau de bord et le compte 3421 racontaient deux histoires.
    const f = facture({
      id: "FA-2026-0084", montant_ht: 26310, montant_ttc: 31572,
      statut_paiement: "payee", montant_paye: 31572, montant_restant: 0,
    });
    const r = rapprocherEncoursClients([f], venteComptabilisee("FA-2026-0084", 26310, 5262));
    expect(r.ok).toBe(false);
    expect(r.ecart).toBe(31572);
  });

  it("ne rapproche rien sur un dossier sans aucune ligne 342x", () => {
    const f = facture({ id: "A", montant_ttc: 24000, montant_restant: 24000 });
    const r = rapprocherEncoursClients([f], []);
    expect(r.comptabilise).toBe(false);
    expect(r.ok).toBe(true);   // rien à comparer n'est pas une anomalie
  });

  it("ne COMPENSE pas l'avance d'un client par la dette d'un autre", () => {
    const lignes = [
      ligne({ compte_numero: "34210001", debit: 10000 }),
      ligne({ compte_numero: "34210002", credit: 4000 }),
    ];
    const r = rapprocherEncoursClients([], lignes);
    expect(r.encoursGrandLivre).toBe(10000);   // et non 6 000
  });
});

// ─── (d) Statut « payée » ⇒ encaissement attesté ─────────────────────────────

describe("(d) une facture n'est payée que si un encaissement l'atteste", () => {
  it("aucune trace : la facture redevient non payée", () => {
    const f = facture({
      id: "FA-2026-0084", montant_ht: 26310, montant_ttc: 31572,
      statut_paiement: "payee", montant_paye: 31572, montant_restant: 0,
      date_paiement: "2026-03-10",
    });
    const p = preuveEncaissement(f, venteComptabilisee("FA-2026-0084", 26310, 5262));
    expect(p.source).toBe("aucune");
    expect(p.montant).toBe(0);
    expect(p.statut).toBe("non_payee");

    const [c] = statutsARecalibrer([f], venteComptabilisee("FA-2026-0084", 26310, 5262));
    expect(c.apres.statut_paiement).toBe("non_payee");
    expect(c.apres.montant_restant).toBe(31572);
    // Une facture non payée ne conserve pas de date de règlement.
    expect(c.apres.date_paiement).toBeNull();
    expect(c.motif).toMatch(/sans aucune écriture de trésorerie/);
  });

  it("écriture de trésorerie estampillée : la facture est soldée", () => {
    const lignes = [
      ...venteComptabilisee("V", 17500, 3500),
      ligne({ journal_code: "CAI", compte_numero: "34210001", credit: 21000, reference_piece: "V", date_ecriture: "2026-07-22" }),
      ligne({ journal_code: "CAI", compte_numero: "51610000", debit: 21000, reference_piece: "V", date_ecriture: "2026-07-22" }),
    ];
    const f = facture({ id: "V", montant_ht: 17500, montant_ttc: 21000 });
    const p = preuveEncaissement(f, lignes);
    expect(p.source).toBe("tresorerie");
    expect(p.montant).toBe(21000);
    expect(p.statut).toBe("payee");
    expect(p.date).toBe("2026-07-22");
  });

  it("cas SOMADIR : le LETTRAGE atteste, même sans estampille sur la ligne de banque", () => {
    // FA-2024-0892 : la ligne CAI ne porte ni facture_id ni référence, seul le
    // code AA la relie à la vente. La ramener à « non payée » aurait détruit la
    // seule trace du règlement.
    const lignes = [
      ...venteComptabilisee("FA-2024-0892", 2890, 578, { client: "34210002", lettrage: "AA" }),
      ligne({ journal_code: "CAI", compte_numero: "34210002", credit: 3468, lettrage_code: "AA", date_ecriture: "2026-05-06" }),
    ];
    const f = facture({ id: "FA-2024-0892", date_facture: "2024-05-12", montant_ht: 2890, montant_ttc: 3468 });
    const p = preuveEncaissement(f, lignes);
    expect(p.source).toBe("lettrage");
    expect(p.montant).toBe(3468);
    expect(p.statut).toBe("payee");
  });

  it("à défaut d'écriture, une PIÈCE de règlement suffit — si on l'admet", () => {
    const f = facture({ id: "V", montant_ht: 10000, montant_ttc: 12000 });
    const p = preuveEncaissement(f, venteComptabilisee("V", 10000, 2000), [
      { montant: 12000, date: "2026-06-30" },
    ]);
    expect(p.source).toBe("piece");
    expect(p.statut).toBe("payee");
  });

  it("RÈGLE STRICTE : une pièce sans écriture n'atteste RIEN (cas SMERT)", () => {
    // FA-2026-0084 : ligne de `paiements` issue d'un lettrage contre une
    // transaction bancaire SANS relevé et ANTÉRIEURE de 68 jours à l'émission.
    // Aucune écriture BQ/CAI n'en a jamais été tirée : le 3421 restait ouvert de
    // 31 572 MAD pendant que la facture s'affichait soldée.
    const f = facture({
      id: "FA-2026-0084", montant_ht: 26310, montant_ttc: 31572,
      statut_paiement: "payee", montant_paye: 31572, montant_restant: 0,
      date_paiement: "2026-03-10",
    });
    const lignes = venteComptabilisee("FA-2026-0084", 26310, 5262, { client: "34210003", compte: "7124" });
    const pieces = [{ montant: 31572, date: "2026-03-10" }];

    const strict = preuveEncaissement(f, lignes, pieces, { accepterPieces: false });
    expect(strict.source).toBe("aucune");
    expect(strict.statut).toBe("non_payee");
    // On distingue « rien ne s'est passé » de « la pièce existe, l'écriture non ».
    expect(strict.pieceSansEcriture).toBe(true);

    const [c] = statutsARecalibrer(
      [f], lignes, new Map([[f.id, pieces]]), { accepterPieces: false },
    );
    expect(c.apres.statut_paiement).toBe("non_payee");
    expect(c.apres.montant_restant).toBe(31572);
    expect(c.motif).toMatch(/QUE LA COMPTABILITÉ NE PORTE PAS/);

    // …et le reste dû rétabli fait enfin coïncider l'encours avec le 3421.
    const apres = { ...f, statut_paiement: "non_payee", montant_paye: 0, montant_restant: 31572 };
    expect(rapprocherEncoursClients([apres], lignes).ok).toBe(true);
  });

  it("le mode strict n'invente rien : une écriture lettrée reste une preuve", () => {
    const lignes = [
      ...venteComptabilisee("V", 2890, 578, { client: "34210002", lettrage: "AA" }),
      ligne({ journal_code: "CAI", compte_numero: "34210002", credit: 3468, lettrage_code: "AA", date_ecriture: "2026-05-06" }),
    ];
    const f = facture({ id: "V", montant_ht: 2890, montant_ttc: 3468 });
    const p = preuveEncaissement(f, lignes, [{ montant: 3468, date: "2026-05-06" }], { accepterPieces: false });
    expect(p.source).toBe("lettrage");
    expect(p.statut).toBe("payee");
  });

  it("un encaissement PARTIEL donne « partielle », pas « payée »", () => {
    const lignes = [
      ...venteComptabilisee("V", 20000, 4000),
      ligne({ journal_code: "BQ", compte_numero: "34210001", credit: 10000, reference_piece: "V", date_ecriture: "2026-06-01" }),
    ];
    const p = preuveEncaissement(facture({ id: "V", montant_ht: 20000, montant_ttc: 24000 }), lignes);
    expect(p.montant).toBe(10000);
    expect(p.statut).toBe("partielle");
  });

  it("une écriture VTE n'est PAS un encaissement, même au crédit du 342x", () => {
    // Un avoir crédite le compte client sans qu'un centime ait bougé : seul le
    // journal de trésorerie atteste une entrée d'argent.
    const lignes = [
      ...venteComptabilisee("V", 20000, 4000),
      ligne({ journal_code: "VTE", compte_numero: "34210001", credit: 24000, reference_piece: "V" }),
    ];
    expect(preuveEncaissement(facture({ id: "V", montant_ttc: 24000 }), lignes).source).toBe("aucune");
  });

  it("ne touche pas une facture déjà cohérente", () => {
    const lignes = [
      ...venteComptabilisee("V", 17500, 3500),
      ligne({ journal_code: "CAI", compte_numero: "34210001", credit: 21000, reference_piece: "V", date_ecriture: "2026-07-22" }),
    ];
    const f = facture({
      id: "V", montant_ht: 17500, montant_ttc: 21000, date_facture: "2026-01-26",
      statut_paiement: "payee", montant_paye: 21000, montant_restant: 0, date_paiement: "2026-07-22",
    });
    expect(statutsARecalibrer([f], lignes)).toHaveLength(0);
  });

  it("un encaissement de l'exercice SUIVANT solde bien la facture", () => {
    // Le recalibrage lit le grand livre entier : le borner à l'exercice ferait
    // « démarquer » toute facture réglée après la clôture.
    const lignes = [
      ...venteComptabilisee("V", 17500, 3500),
      ligne({ journal_code: "BQ", compte_numero: "34210001", credit: 21000, reference_piece: "V", date_ecriture: "2027-01-15" }),
    ];
    const f = facture({
      id: "V", date_facture: "2026-12-20", montant_ht: 17500, montant_ttc: 21000,
      statut_paiement: "payee", montant_paye: 21000, montant_restant: 0, date_paiement: "2027-01-15",
    });
    const r = auditerCoherenceVentes([f], lignes, { bornes: bornesExercice(2026) });
    expect(r.statuts).toHaveLength(0);
  });
});

// ─── (e) Dates de règlement ──────────────────────────────────────────────────

describe("(e) une facture ne se règle pas avant d'être émise", () => {
  it("repère les deux anomalies constatées en base", () => {
    const anomalies = datesReglementIncoherentes([
      facture({ id: "FA-2026-0084", date_facture: "2026-05-17", date_paiement: "2026-03-10" }),
      facture({ id: "FA 0005", date_facture: "2026-03-11", date_paiement: "2026-03-02" }),
      facture({ id: "OK", date_facture: "2026-01-26", date_paiement: "2026-07-22" }),
    ]);
    expect(anomalies.map((a) => a.facture.numero)).toEqual(["FA-2026-0084", "FA 0005"]);
    expect(anomalies[0].joursAvant).toBe(68);
    expect(anomalies[0].dateCorrigee).toBe("2026-05-17");
  });

  it("corrige d'abord le MILLÉSIME, sans perdre le jour réel (cas REPERAL)", () => {
    // Règlement au 16/07/2024 pour une facture du 20/06/2026 : le jour et le
    // mois sont crédibles, seule l'année ne l'est pas. Ramener au 20/06 perdrait
    // la date réelle du chèque.
    expect(corrigerAnneeReglement("2026-06-20", "2024-07-16")).toBe("2026-07-16");
    // Règlement de janvier pour une facture de décembre : l'année SUIVANTE.
    expect(corrigerAnneeReglement("2026-12-20", "2024-01-15")).toBe("2027-01-15");
    // Rien à corriger.
    expect(corrigerAnneeReglement("2026-01-26", "2026-07-22")).toBe("2026-07-22");
    // La veille de l'émission : l'année suivante ferait un bond de 364 jours,
    // bien pire que l'anomalie corrigée → repli sur la date de facture.
    expect(corrigerAnneeReglement("2026-06-20", "2024-06-19")).toBe("2026-06-20");
    expect(corrigerAnneeReglement(null, "2024-07-16")).toBe("2024-07-16");
    expect(corrigerAnneeReglement("2026-06-20", null)).toBeNull();
  });

  it("recale sur la date de facture, et ne touche pas une date valide", () => {
    expect(recalerDateReglement("2026-05-17", "2026-03-10")).toBe("2026-05-17");
    expect(recalerDateReglement("2026-05-17", "2026-07-01")).toBe("2026-07-01");
    // Date d'émission inconnue : on ne peut rien affirmer, on ne touche à rien.
    expect(recalerDateReglement(null, "2026-03-10")).toBe("2026-03-10");
    expect(recalerDateReglement("2026-05-17", null)).toBeNull();
  });

  it("la validation de saisie refuse l'antériorité et le futur", () => {
    const hier = "2026-08-19";
    expect(validerDateReglement("2026-05-17", "2026-03-10", hier).ok).toBe(false);
    expect(validerDateReglement("2026-05-17", "2026-03-10", hier).message).toMatch(/antérieure/);
    expect(validerDateReglement("2026-05-17", "2026-09-30", hier).ok).toBe(false);
    expect(validerDateReglement("2026-05-17", "2026-06-01", hier).ok).toBe(true);
    // Même jour : un règlement au comptant à l'émission est parfaitement licite.
    expect(validerDateReglement("2026-05-17", "2026-05-17", hier).ok).toBe(true);
    // Facture sans date d'émission : on ne bloque pas une saisie légitime.
    expect(validerDateReglement(null, "2026-06-01", hier).ok).toBe(true);
    expect(validerDateReglement("2026-05-17", "", hier).ok).toBe(false);
  });
});

// ─── Isolation par exercice ──────────────────────────────────────────────────

describe("isolation stricte par exercice", () => {
  it("borne l'exercice sur l'année civile", () => {
    const b = bornesExercice(2026);
    expect(b).toMatchObject({ debut: "2026-01-01", fin: "2026-12-31", premierExercice: false });
  });

  it("le PREMIER exercice s'ouvre à la date de début d'activité", () => {
    const b = bornesExercice(2026, "2026-03-12");
    expect(b.debut).toBe("2026-03-12");
    expect(b.premierExercice).toBe(true);
    // Les exercices suivants sont des années civiles pleines.
    expect(bornesExercice(2027, "2026-03-12").debut).toBe("2027-01-01");
  });

  it("écarte les écritures de 2024 et 2025 d'une vue 2026", () => {
    const lignes = [
      ligne({ date_ecriture: "2024-05-12", credit: 2890, compte_numero: "7111" }),
      ligne({ date_ecriture: "2025-11-03", credit: 1000, compte_numero: "7111" }),
      ligne({ date_ecriture: "2026-05-17", credit: 26310, compte_numero: "7124" }),
    ];
    const b = bornesExercice(2026);
    expect(filtrerExercice(lignes, b)).toHaveLength(1);
    expect(horsExercice(lignes, b).anterieures).toHaveLength(2);
    expect(dansExercice("2026-12-31", b)).toBe(true);
    expect(dansExercice("2027-01-01", b)).toBe(false);
    expect(dansExercice(null, b)).toBe(false);
  });

  it("l'audit d'un exercice ignore le CA des exercices antérieurs", () => {
    const factures = [
      facture({ id: "V2024", date_facture: "2024-05-12", montant_ht: 2890, montant_ttc: 3468 }),
      facture({ id: "V2026", date_facture: "2026-05-17", montant_ht: 26310, montant_ttc: 31572 }),
    ];
    const lignes = [
      ...venteComptabilisee("V2024", 2890, 578).map((l) => ({ ...l, date_ecriture: "2024-05-12" })),
      ...venteComptabilisee("V2026", 26310, 5262),
    ];
    const r = auditerCoherenceVentes(factures, lignes, { bornes: bornesExercice(2026) });
    expect(r.ca.caHt).toBe(26310);
    expect(r.ca.credits7).toBe(26310);
    expect(r.ca.ok).toBe(true);
    expect(r.horsExercice).toBe(3);   // les trois lignes de 2024, signalées à part
  });

  it("propose les exercices RÉELLEMENT portés par le dossier", () => {
    const dispo = exercicesDisponibles(["2026-05-17", "2024-05-12", "2026-01-26", null, "n/a"]);
    expect(dispo).toEqual([2026, 2024]);
    // Ouvre sur l'exercice courant s'il porte des écritures…
    expect(exerciceParDefaut(dispo, "2026-08-20")).toBe(2026);
    // …sinon sur le plus récent, pour ne pas afficher un écran vide.
    expect(exerciceParDefaut([2024, 2023], "2026-08-20")).toBe(2024);
    expect(exerciceParDefaut([], "2026-08-20")).toBe(2026);
  });
});

// ─── Le rapport d'ensemble ───────────────────────────────────────────────────

describe("rapport de cohérence d'un dossier", () => {
  it("est vert sur un dossier sain", () => {
    const factures = [
      facture({ id: "A", montant_ht: 20000, montant_ttc: 24000, montant_restant: 24000 }),
      facture({
        id: "B", montant_ht: 17500, montant_ttc: 21000, date_facture: "2026-01-26",
        statut_paiement: "payee", montant_paye: 21000, montant_restant: 0, date_paiement: "2026-07-22",
      }),
    ];
    const lignes = [
      ...venteComptabilisee("A", 20000, 4000),
      ...venteComptabilisee("B", 17500, 3500, { client: "34210002", lettrage: "AA" }),
      ligne({ journal_code: "CAI", compte_numero: "34210002", credit: 21000, lettrage_code: "AA", date_ecriture: "2026-07-22" }),
      ligne({ journal_code: "CAI", compte_numero: "51610000", debit: 21000, date_ecriture: "2026-07-22" }),
    ];
    const r = auditerCoherenceVentes(factures, lignes, { bornes: bornesExercice(2026) });
    expect(r.ok).toBe(true);
  });

  it("cumule les cinq griefs sur le dossier réellement observé", () => {
    const factures = [
      // payée sans trésorerie, et réglée avant émission
      facture({
        id: "FA-2026-0084", date_facture: "2026-05-17", date_paiement: "2026-03-10",
        montant_ht: 26310, montant_ttc: 31572,
        statut_paiement: "payee", montant_paye: 31572, montant_restant: 0,
      }),
      // jamais comptabilisée
      facture({ id: "F2024-001", date_facture: "2026-05-02", montant_ht: 13500, montant_ttc: 16200, montant_restant: 16200 }),
    ];
    const lignes = venteComptabilisee("FA-2026-0084", 26310, 5262, { client: "34210003", compte: "7124" });

    const r = auditerCoherenceVentes(factures, lignes, { bornes: bornesExercice(2026) });
    expect(r.ok).toBe(false);
    expect(r.ca.ecart).toBe(13500);
    expect(r.ca.nonComptabilisees.map((f) => f.numero)).toEqual(["F2024-001"]);
    expect(r.encours.ok).toBe(false);
    expect(r.statuts).toHaveLength(1);
    expect(r.dates).toHaveLength(1);
  });
});
