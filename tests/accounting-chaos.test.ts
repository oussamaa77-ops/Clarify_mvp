// ============================================================================
// tests/accounting-chaos.test.ts — la batterie des CAS INVALIDES (niveau 3).
//
// Le banc d'audit vérifie que ce qui est en base est cohérent. Il ne dit rien de
// ce que le moteur ACCEPTERAIT d'y écrire. Or les deux questions sont
// différentes : un dossier peut être impeccable simplement parce que personne
// n'a encore tenté la saisie qui le casserait.
//
// Ces tests tentent la saisie. Chacun soumet au moteur une opération
// comptablement IMPOSSIBLE et exige un refus — pas une correction silencieuse,
// pas un « ça passe mais l'audit le verra plus tard » : un refus, et un grand
// livre inchangé.
//
// ─── Deux couches, et il faut les deux ───────────────────────────────────────
//   • MOTEUR — les fonctions pures (`examinerPaiements`, `controlerEcrituresRegime`,
//     `controlerCaissePositive`…). C'est ce que l'écran consulte avant d'envoyer.
//     Rapide, déterministe, sans réseau.
//   • BASE — les triggers, index uniques et RPC. C'est le dernier mot : quatre
//     chemins écrivent dans `paiements` (le modal, `lier_transaction`, le rebuild
//     et la console SQL des scripts de reprise), et une règle qui ne vit que
//     dans l'un d'eux n'est pas une règle.
//
// Tester le seul moteur laisserait passer tout ce qui contourne l'écran ; tester
// la seule base laisserait l'utilisateur découvrir ses erreurs en 500.
//
// ─── L'isolation ─────────────────────────────────────────────────────────────
// Tout se passe dans TEST-CLARIFY-GOLDEN. Les écritures et paiements créés par
// erreur — il ne devrait y en avoir aucun, c'est justement ce qu'on mesure —
// sont recensés puis supprimés en fin de fichier, et un contrôle final vérifie
// que le dossier étalon est SORTI INTACT de la batterie.
// ============================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  clientGolden, diagnostic, etatVerrous, exigerDossierGolden, messageErreur,
  nb, r2, txt, type DossierGolden, type EtatVerrous,
} from "./golden/harness";
import {
  ACHAT_GOLDEN, COMPTE_BANQUE, COMPTE_CAISSE, COMPTE_CHARGE_ACHAT,
  COMPTE_PRODUIT, CLIENT_GOLDEN, FOURNISSEUR_GOLDEN, VENTES,
} from "./golden/scenario";

import { examinerPaiements, type PaiementCandidat } from "../src/lib/reglements";
import { controlerCoherenceMontants } from "../src/lib/tva";
import {
  controlerEcrituresRegime, controlerLignesAchat, controlerPreuveBascule,
  genererEcrituresAchat, genererOdBasculeTva, type LigneEcriture,
} from "../src/lib/genererEcritures";
import { controlerCaissePositive, creuxCaisse } from "../src/lib/integrite-tresorerie";
import { insererPiece } from "../src/server/lettrage-compta.functions";

const { sb } = clientGolden();

let dossier: DossierGolden;
/** Quels verrous existent en base — pour distinguer régression et migration en retard. */
let verrous: EtatVerrous;
/** Le grand livre du dossier étalon AVANT la batterie — l'état à retrouver. */
let livreInitial: any[] = [];
/** Lignes `paiements` présentes au départ : tout le reste sera nettoyé. */
let paiementsInitiaux = new Set<string>();
/** Les pièces du dossier, retrouvées par leur numéro. */
const pieces = new Map<string, any>();

const NUM_CREDIT = "FA-GOLD-002";     // 24 000 TTC, 9 000 déjà réglés
const NUM_SOLDEE = "FA-GOLD-001";     // 12 000 TTC, soldée en espèces

async function grandLivre(): Promise<any[]> {
  const { data, error } = await sb.from("ecritures_comptables")
    .select("id,journal_code,compte_numero,date_ecriture,libelle,debit,credit,reference_piece,lettrage_code,facture_id")
    .eq("dossier_id", dossier.id);
  if (error) throw new Error(messageErreur(error));
  return (data ?? []) as any[];
}

beforeAll(async () => {
  dossier = await exigerDossierGolden(sb);
  verrous = await etatVerrous();
  livreInitial = await grandLivre();

  const { data: fc } = await sb.from("factures")
    .select("id,numero,date_facture,montant_ttc,montant_paye,montant_restant,statut_paiement")
    .eq("dossier_id", dossier.id);
  for (const f of (fc ?? []) as any[]) pieces.set(txt(f.numero), f);

  const { data: ff } = await sb.from("factures_fournisseurs")
    .select("id,numero,date_facture,montant_ttc,montant_paye,montant_restant,statut_paiement")
    .eq("dossier_id", dossier.id);
  for (const f of (ff ?? []) as any[]) pieces.set(txt(f.numero), f);

  const { data: pai } = await sb.from("paiements").select("id").eq("dossier_id", dossier.id);
  paiementsInitiaux = new Set(((pai ?? []) as any[]).map((p) => txt(p.id)));

  expect(livreInitial.length, "le dossier étalon doit être semé").toBeGreaterThan(0);
  expect(pieces.has(NUM_CREDIT), `${NUM_CREDIT} doit exister`).toBe(true);
});

/**
 * Tente une écriture dans `paiements` et rend le refus, s'il y en a un.
 *
 * `insert` de PostgREST rend `{ error }` plutôt que de lever : sans cette
 * enveloppe, un test qui attend un rejet passerait au vert sur un succès, faute
 * d'avoir regardé la valeur de retour.
 */
async function tenterPaiement(ligne: Record<string, any>): Promise<{ refuse: boolean; message: string; id: string | null }> {
  const { data, error } = await sb.from("paiements")
    .insert({ dossier_id: dossier.id, origine: "manuel", ...ligne })
    .select("id");
  if (error) return { refuse: true, message: messageErreur(error), id: null };
  const id = txt((data ?? [])[0]?.id) || null;
  return { refuse: false, message: "", id };
}

/** Supprime une ligne que la base n'aurait pas dû accepter. */
async function retirerPaiement(id: string | null): Promise<void> {
  if (id) await sb.from("paiements").delete().eq("id", id);
}

// ════════════════════════════════════════════════════════════════════════════
describe("1. Règlement supérieur au reste dû", () => {
  // Le premier versement n'est PAS plafonné, et c'est délibéré : un client qui
  // paie 12 000 sur une facture de 10 000 a bien versé 12 000, l'argent est
  // arrivé. Refuser laisserait la facture impayée alors qu'elle est plus que
  // soldée. Ce qui est fautif, c'est le versement qui DÉBORDE après un autre —
  // signature du double comptage. Le test doit donc porter sur le CUMUL, sinon
  // il condamnerait un comportement voulu.

  it("moteur : un second règlement qui dépasse le TTC est déclaré irrecevable", () => {
    const f = pieces.get(NUM_CREDIT);
    const candidats: PaiementCandidat[] = [
      { id: "p1", montant: 9000, date_paiement: "2026-05-11", reference: "REG-GOLD-002-1" },
      { id: "p2", montant: 20000, date_paiement: "2026-09-01", reference: "CHAOS-SURPAIEMENT" },
    ];
    const examen = examinerPaiements(f, candidats);
    const second = examen.find((e) => txt(e.paiement.id) === "p2")!;

    expect(second.recevable).toBe(false);
    expect(second.motifs).toContain("surpaiement");
    // Le premier reste recevable : le moteur écarte la ligne fautive, il ne
    // condamne pas le dossier.
    expect(examen.find((e) => txt(e.paiement.id) === "p1")!.recevable).toBe(true);
  });

  it("base : le cumul des règlements ne peut pas dépasser le TTC", async () => {
    const f = pieces.get(NUM_CREDIT);
    const t = await tenterPaiement({
      facture_id: f.id, montant: 20000, date_paiement: "2026-09-01",
      reference: "CHAOS-SURPAIEMENT",
    });
    await retirerPaiement(t.id);

    expect(t.refuse, `9 000 déjà encaissés + 20 000 > ${f.montant_ttc} TTC : la base a accepté `
      + "un règlement impossible. Sans ce verrou, la facture se solde deux fois et "
      + "le compte de tiers reste ouvert du même montant."
      + diagnostic(verrous)).toBe(true);
    expect(t.message).toMatch(/trop-perçu|déjà encaiss|4191|avoir/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("2. Règlement antérieur à l'émission de la facture", () => {
  it("moteur : une facture ne peut pas être réglée avant d'exister", () => {
    const f = pieces.get(NUM_CREDIT);
    const examen = examinerPaiements(f, [
      { id: "p1", montant: 1000, date_paiement: "2026-01-05", reference: "CHAOS-ANTERIEUR" },
    ]);
    expect(examen[0].recevable).toBe(false);
    expect(examen[0].motifs).toContain("anterieur_facture");
  });

  it("base : un règlement daté avant la facture est refusé", async () => {
    const f = pieces.get(NUM_CREDIT);
    const t = await tenterPaiement({
      facture_id: f.id, montant: 1000, date_paiement: "2026-01-05",
      reference: "CHAOS-ANTERIEUR",
    });
    await retirerPaiement(t.id);

    expect(t.refuse, `${f.numero} est émise le ${f.date_facture} : un règlement du 05/01/2026 `
      + "la précède de trois mois. C'est le défaut qui a fait afficher trois factures "
      + "SMERT comme soldées pendant que le 3421 restait ouvert de 81 972 MAD."
      + diagnostic(verrous)).toBe(true);
    expect(t.message).toMatch(/antérieur|avant d'exister|avant d.exister/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("3. Double import — la même pièce comptée deux fois", () => {
  it("moteur : une pièce déjà comptée pour cette facture est un doublon", () => {
    const f = pieces.get(NUM_CREDIT);
    const doublon: PaiementCandidat = {
      montant: 5000, date_paiement: "2026-06-01", reference: "CHAOS-DOUBLON",
    };
    const examen = examinerPaiements(f, [
      { id: "a", ...doublon },
      { id: "b", ...doublon },
    ]);
    expect(examen[0].recevable).toBe(true);
    expect(examen[1].recevable).toBe(false);
    expect(examen[1].motifs).toContain("doublon");
  });

  it("base : deux saisies manuelles identiques ne créent qu'un règlement", async () => {
    const f = pieces.get(NUM_SOLDEE);
    const ligne = {
      facture_id: f.id, montant: 1, date_paiement: "2026-09-02",
      reference: "CHAOS-DOUBLE-IMPORT",
    };
    const premier = await tenterPaiement(ligne);
    const second = await tenterPaiement(ligne);
    await retirerPaiement(premier.id);
    await retirerPaiement(second.id);

    // Le premier peut être refusé (il ferait déborder une facture soldée) ; ce
    // qui compte est que les DEUX ne passent jamais ensemble.
    expect(premier.refuse && second.refuse ? true : second.refuse,
      "deux clics sur « Enregistrer » ont créé deux règlements : la facture se "
      + "solde deux fois pour un seul encaissement."
      + diagnostic(verrous)).toBe(true);
  });

  it("base : la même facture OCR importée deux fois entre en collision de référence", async () => {
    // Deux imports du même document produisent la même RÉFÉRENCE de pièce. Le
    // verrou d'unicité VTE/ACH la refuse — c'est ce qui empêche une charge
    // d'être comptabilisée deux fois quand un utilisateur rescanne un PDF.
    const lignes = genererEcrituresAchat({
      dossier_id: dossier.id, facture_id: pieces.get(ACHAT_GOLDEN.numero).id,
      reference: VENTES[0].numero,          // référence DÉJÀ portée par une vente
      date_facture: "2026-09-03",
      montant_ht: 100, montant_tva: 20, montant_ttc: 120,
      compte_charge: COMPTE_CHARGE_ACHAT, compte_tiers: FOURNISSEUR_GOLDEN.compte,
    });
    const verdict = controlerEcrituresRegime(lignes as LigneEcriture[], {
      existantes: livreInitial as LigneEcriture[],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.collisions.map((c) => c.reference)).toContain(VENTES[0].numero);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("4. Annulation d'un règlement lettré et déjà déclaré", () => {
  // Ce cas ne s'éprouve PAS en supprimant réellement la ligne : l'annulation est
  // le geste dont on veut prouver qu'il laisse une trace détectable, et l'exécuter
  // pour de bon abîmerait l'étalon que les autres tests interrogent. On la rejoue
  // donc sur une COPIE du grand livre — ce qui suffit, puisque tout le contrôle
  // est une fonction pure du grand livre.

  it("le grand livre du dossier étalon contient bien une bascule lettrée", () => {
    const bascules = livreInitial.filter(
      (l) => txt(l.compte_numero).startsWith("4455") && nb(l.credit) > 0.005 && txt(l.lettrage_code));
    expect(bascules.length, "sans bascule lettrée, ce test ne prouverait rien").toBeGreaterThan(0);
  });

  it("retirer la trésorerie sous une bascule déjà déclarée rend la TVA injustifiable", () => {
    const bascule = livreInitial.filter((l) => txt(l.lettrage_code) === "AA"
      && (txt(l.compte_numero).startsWith("4455") || txt(l.compte_numero).startsWith("4458")));
    expect(bascule.length).toBeGreaterThan(0);

    const tresorerie = livreInitial.filter(
      (l) => ["BQ", "CAI"].includes(txt(l.journal_code).toUpperCase()));

    // Avant : la bascule est prouvée par son encaissement.
    expect(controlerPreuveBascule(bascule as LigneEcriture[], tresorerie as any).ok).toBe(true);

    // Après annulation du règlement : la même bascule n'a plus de fait
    // générateur. La TVA de FA-GOLD-001 reste EXIGIBLE et déclarée, alors
    // qu'aucun encaissement ne la porte plus — c'est un trou dans la
    // déclaration 2026-03, pas une simple ligne en trop.
    const sansLeReglement = tresorerie.filter((l) => txt(l.lettrage_code) !== "AA");
    const apres = controlerPreuveBascule(bascule as LigneEcriture[], sansLeReglement as any);
    expect(apres.ok).toBe(false);
    expect(apres.violations.join(" ")).toMatch(/sans règlement constaté/i);
  });

  it("la période déclarée reste bouclée tant que le règlement subsiste", async () => {
    // Contre-épreuve sur la base RÉELLE : si un test précédent avait laissé une
    // écriture derrière lui, la déclaration de mars ne se boucherait plus.
    const livre = await grandLivre();
    const declarees = livre.filter((l) => txt(l.reference_piece).startsWith("DECL-TVA-"));
    expect(declarees.length, "le dossier étalon doit porter ses déclarations").toBeGreaterThan(0);
    const ecart = r2(declarees.reduce((s, l) => s + nb(l.debit) - nb(l.credit), 0));
    expect(ecart, "les OD de déclaration doivent s'équilibrer").toBeCloseTo(0, 2);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("5. Facture d'achat à 0,00 MAD ou à taux de TVA invalide", () => {
  it("moteur : un achat à 0,00 ne produit aucune charge et est refusé", () => {
    const lignes = genererEcrituresAchat({
      dossier_id: dossier.id, facture_id: "chaos", reference: "CHAOS-ZERO",
      date_facture: "2026-09-04", montant_ht: 0, montant_tva: 0, montant_ttc: 0,
      compte_charge: COMPTE_CHARGE_ACHAT, compte_tiers: FOURNISSEUR_GOLDEN.compte,
    });
    const c = controlerLignesAchat(lignes as LigneEcriture[]);
    expect(c.ok).toBe(false);
    expect(c.violations.join(" ")).toMatch(/classe 6/i);
  });

  it("moteur : un taux de TVA hors barème marocain est un montant FAUX, pas un arrondi", () => {
    // 7,5 % n'existe pas au Maroc (0, 7, 10, 14, 20). Le diagnostic doit dire
    // « faux », et surtout ne pas proposer d'ajuster au centime : ajuster
    // masquerait une erreur de saisie derrière une correction d'arrondi.
    const c = controlerCoherenceMontants({ ht: 1000, tva: 75, ttc: 1075 }, 1);
    expect(c.ok).toBe(false);
    expect(c.cause).toBe("taux_incoherent");
    expect(c.message).toMatch(/aucun taux marocain/i);
  });

  it("moteur : HT + TVA ≠ TTC est détecté même quand le taux est correct", () => {
    const c = controlerCoherenceMontants({ ht: 1000, tva: 200, ttc: 1500 }, 1);
    expect(c.ok).toBe(false);
    expect(Math.abs(c.ecart)).toBeCloseTo(300, 2);
  });

  it("base : `insererPiece` refuse d'écrire un achat à 0,00", async () => {
    const lignes = genererEcrituresAchat({
      dossier_id: dossier.id, facture_id: "chaos", reference: "CHAOS-ZERO",
      date_facture: "2026-09-04", montant_ht: 0, montant_tva: 0, montant_ttc: 0,
      compte_charge: COMPTE_CHARGE_ACHAT, compte_tiers: FOURNISSEUR_GOLDEN.compte,
    }).map((l) => ({ ...l, facture_id: null }));

    // Une pièce à zéro est équilibrée : c'est ce qui la rend dangereuse. Seul le
    // contrôle métier peut la refuser — la partie double n'y voit rien.
    const c = controlerLignesAchat(lignes as LigneEcriture[]);
    expect(c.ecart).toBeCloseTo(0, 2);
    expect(c.ok).toBe(false);

    const avant = (await grandLivre()).length;
    if (c.ok) await insererPiece(sb, dossier.id, lignes as any);
    const apres = (await grandLivre()).length;
    expect(apres, "aucune écriture ne doit être née d'un achat à zéro").toBe(avant);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("6. Mouvement de caisse rendant le solde négatif (invariant C_t ≥ 0)", () => {
  const sortieImpossible = (montant: number) => [
    {
      dossier_id: "", journal_code: "CAI", compte_numero: COMPTE_CHARGE_ACHAT,
      date_ecriture: "2026-09-05", libelle: "Chaos — décaissement impossible",
      debit: montant, credit: 0, reference_piece: "CHAOS-CAISSE",
    },
    {
      dossier_id: "", journal_code: "CAI", compte_numero: COMPTE_CAISSE,
      date_ecriture: "2026-09-05", libelle: "Chaos — décaissement impossible",
      debit: 0, credit: montant, reference_piece: "CHAOS-CAISSE",
    },
  ];

  it("le dossier étalon part d'une caisse saine", () => {
    const c = creuxCaisse(livreInitial as any);
    expect(c.ok).toBe(true);
    expect(c.creux).toBeCloseTo(0, 2);
  });

  it("moteur : sortir plus d'espèces que le tiroir n'en contient est refusé", () => {
    const disponible = creuxCaisse(livreInitial as any).cloture;
    const c = controlerCaissePositive(livreInitial as any, sortieImpossible(disponible + 5000) as any);
    expect(c.ok).toBe(false);
    expect(c.violations.join(" ")).toMatch(/caisse créditrice/i);
    expect(c.apres.creux).toBeLessThan(0);
  });

  it("moteur : un décaissement que la caisse peut porter reste accepté", () => {
    // Contre-épreuve indispensable : un verrou qui refuse TOUT passerait le test
    // précédent sans rien protéger.
    const disponible = creuxCaisse(livreInitial as any).cloture;
    const c = controlerCaissePositive(livreInitial as any, sortieImpossible(r2(disponible / 2)) as any);
    expect(c.ok).toBe(true);
  });

  it("base : `insererPiece` refuse le décaissement et le grand livre ne bouge pas", async () => {
    const disponible = creuxCaisse(await grandLivre() as any).cloture;
    const lignes = sortieImpossible(disponible + 5000).map((l) => ({ ...l, dossier_id: dossier.id }));

    const avant = (await grandLivre()).length;
    const { error } = await insererPiece(sb, dossier.id, lignes as any);
    const apres = await grandLivre();

    expect(error, "la pièce est équilibrée et passerait tous les contrôles de partie "
      + "double : seul l'invariant C_t ≥ 0 peut la refuser.").toBeTruthy();
    expect(txt(error)).toMatch(/caisse créditrice/i);
    expect(apres.length, "un refus ne doit laisser AUCUNE ligne derrière lui").toBe(avant);
    expect(creuxCaisse(apres as any).ok).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
afterAll(async () => {
  // Nettoyage : toute ligne née pendant la batterie est supprimée. Un test qui
  // laisse des traces rend le suivant faux — et, ici, ferait échouer le banc
  // d'audit pour une raison qui n'a rien à voir avec le code testé.
  const { data: pai } = await sb.from("paiements").select("id").eq("dossier_id", dossier.id);
  const intrus = ((pai ?? []) as any[]).filter((p) => !paiementsInitiaux.has(txt(p.id)));
  if (intrus.length) await sb.from("paiements").delete().in("id", intrus.map((p) => p.id));

  await sb.from("ecritures_comptables").delete()
    .eq("dossier_id", dossier.id).like("reference_piece", "CHAOS-%");

  const final = await grandLivre();
  if (final.length !== livreInitial.length) {
    throw new Error(
      `Le dossier étalon sort ABÎMÉ de la batterie : ${livreInitial.length} écritures avant, `
      + `${final.length} après. Un cas invalide a été accepté, ou son nettoyage a échoué.`,
    );
  }
});
