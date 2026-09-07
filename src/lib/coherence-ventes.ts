// ============================================================================
// coherence-ventes.ts — Les contrôles qui font tenir la chaîne Ventes ⇄ Compta.
//
// Quatre égalités doivent être vraies, dossier par dossier et exercice par
// exercice. Quand l'une casse, un chiffre de l'application ment :
//
//   (a) CA HT des factures  =  Σ des crédits nets de classe 7
//         Casse quand une facture n'est pas comptabilisée, ou quand son produit
//         a été porté au 4191 (compte de PASSIF) au lieu d'un compte de vente.
//         Le compte de résultat est alors amputé du montant.
//
//   (b) Encours clients  =  postes DÉBITEURS non lettrés du compte 342x
//         Casse quand le statut commercial d'une facture avance sans que la
//         comptabilité suive : « payée » sans écriture, ou l'inverse.
//
//   (c) Aucun crédit du 4191 sur une facture ordinaire
//         L'invariant du générateur (cf. src/lib/ecritures-vente.ts), vérifié
//         cette fois sur le STOCK et non sur le flux.
//
//   (d) Statut « payée » ⇒ encaissement ATTESTÉ
//         Une facture ne se solde pas parce qu'une colonne le dit : il faut une
//         écriture de trésorerie (BQ/CAI) qui débite la banque ou la caisse et
//         crédite le client, ou à défaut une pièce de règlement formelle.
//
// S'y ajoute un contrôle de VRAISEMBLANCE : une facture ne peut pas être réglée
// avant d'être émise.
//
// Tout est pur. Le même calcul sert à l'écran, au script de reprise et aux tests
// d'intégration — c'est la seule façon qu'ils ne divergent pas.
// ============================================================================

import {
  COMPTE_CLIENTS, encoursTiersGrandLivre, estLettree, relevantDe,
  situationFactureGrandLivre, type LigneGrandLivre, type PieceReglement,
} from "@/lib/encours-grandlivre";
import { estJournalTresorerie } from "@/lib/integrite-tresorerie";
import { COMPTE_ACOMPTES_CLIENTS, normaliserTypeVente } from "@/lib/ecritures-vente";
import { statutDepuisMontants, statutStocke, type StatutStocke } from "@/lib/statut-paiement";
import { dansExercice, jourIso, type BornesExercice } from "@/lib/exercice-comptable";
import { sansANouveaux } from "@/lib/a-nouveaux";

const r2 = (x: unknown) => Math.round((Number(x) || 0) * 100) / 100;
const nb = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const txt = (v: unknown) => String(v ?? "").trim();

/** Le sous-ensemble de `factures` dont ces contrôles ont besoin. */
export interface FactureVente {
  id: string;
  numero?: string | null;
  type?: string | null;
  statut?: string | null;
  statut_paiement?: string | null;
  date_facture?: string | null;
  date_paiement?: string | null;
  montant_ht?: number | null;
  montant_ttc?: number | null;
  montant_paye?: number | null;
  montant_restant?: number | null;
}

/** Une facture d'ACOMPTE n'est pas du chiffre d'affaires : elle en est exclue. */
export const estAcompte = (f: FactureVente): boolean => normaliserTypeVente(f.type) === "acompte";

/**
 * Statuts d'une facture que la comptabilité n'a PAS à porter.
 *
 * `generateFactureXml` ne comptabilise que les factures CONFORMES : une pièce
 * rejetée par la DGI, annulée ou restée en brouillon n'a, à juste titre, aucune
 * écriture. La compter dans le rapprochement CA ⇄ classe 7 fabriquerait un écart
 * permanent qui n'est pas une anomalie — c'est exactement ce que faisait le
 * premier passage sur SOMADIR : 13 500 MAD d'« écart » qui n'étaient que la
 * facture F2024-001, rejetée à la transmission.
 *
 * Ces factures ne sont pas ignorées pour autant : elles ressortent dans
 * `horsPerimetre`, où elles disent ce qu'elles sont — du CA facturé qui n'entrera
 * jamais en comptabilité tant que la pièce n'est pas corrigée et retransmise.
 */
export const STATUTS_NON_COMPTABILISABLES = ["rejetee", "annulee", "brouillon"] as const;

export const estComptabilisable = (f: FactureVente): boolean =>
  !(STATUTS_NON_COMPTABILISABLES as readonly string[]).includes(txt(f.statut).toLowerCase());

// ─── (a) CA HT ⇄ crédits de classe 7 ─────────────────────────────────────────

export interface EcartCaProduits {
  /** Σ des HT facturés, acomptes exclus. */
  caHt: number;
  /** Σ des crédits nets (crédit − débit) des comptes de classe 7. */
  credits7: number;
  /** caHt − credits7. Positif = du CA n'est pas comptabilisé. */
  ecart: number;
  ok: boolean;
  /** Factures sans AUCUNE ligne au grand livre — la cause la plus fréquente. */
  nonComptabilisees: FactureVente[];
  /** Factures rejetées / annulées / en brouillon, exclues du rapprochement. */
  horsPerimetre: FactureVente[];
  /** Σ HT des factures hors périmètre — du CA facturé, jamais comptabilisé. */
  htHorsPerimetre: number;
}

/** Les écritures qui désignent cette facture, par `facture_id` ou par référence. */
export function lignesDeLaFacture(lignes: LigneGrandLivre[], f: FactureVente): LigneGrandLivre[] {
  const num = txt(f.numero);
  return (lignes ?? []).filter(
    (l) => txt(l.facture_id) === txt(f.id) || (num !== "" && txt(l.reference_piece) === num),
  );
}

export function rapprocherCaProduits(
  factures: FactureVente[], lignes: LigneGrandLivre[],
): EcartCaProduits {
  const horsAcompte = (factures ?? []).filter((f) => !estAcompte(f));
  const retenues = horsAcompte.filter(estComptabilisable);
  const horsPerimetre = horsAcompte.filter((f) => !estComptabilisable(f));

  const caHt = r2(retenues.reduce((s, f) => s + nb(f.montant_ht), 0));
  const credits7 = r2((lignes ?? [])
    .filter((l) => txt(l.compte_numero).startsWith("7"))
    .reduce((s, l) => s + nb(l.credit) - nb(l.debit), 0));
  const nonComptabilisees = retenues.filter((f) => lignesDeLaFacture(lignes, f).length === 0);
  const ecart = r2(caHt - credits7);
  return {
    caHt, credits7, ecart, ok: Math.abs(ecart) <= 0.005, nonComptabilisees,
    horsPerimetre, htHorsPerimetre: r2(horsPerimetre.reduce((s, f) => s + nb(f.montant_ht), 0)),
  };
}

// ─── (b) Encours clients ⇄ 342x non lettré ───────────────────────────────────

export interface EcartEncours {
  /** Σ des soldes débiteurs NON LETTRÉS des comptes 342x. */
  encoursGrandLivre: number;
  /** Σ des restes dus portés par les colonnes de `factures`. */
  encoursFactures: number;
  ecart: number;
  ok: boolean;
  /** `false` si le dossier ne porte aucune ligne 342x : rien à rapprocher. */
  comptabilise: boolean;
}

export function rapprocherEncoursClients(
  factures: FactureVente[], lignes: LigneGrandLivre[],
): EcartEncours {
  const gl = encoursTiersGrandLivre(lignes ?? [], COMPTE_CLIENTS);
  const comptabilise = (lignes ?? []).some((l) => relevantDe(l.compte_numero, COMPTE_CLIENTS));
  // Le reste dû stocké vaut 0 sur les factures antérieures au trigger de
  // recalcul : on retombe alors sur TTC − payé, comme le fait le dialogue de
  // règlement, plutôt que de compter une facture impayée pour zéro.
  // Même périmètre que le rapprochement (a) : une facture rejetée n'a pas de
  // ligne 342x, son reste dû ne peut donc pas s'y retrouver.
  const encoursFactures = r2((factures ?? [])
    .filter((f) => estComptabilisable(f) && statutStocke(f.statut_paiement) !== "payee")
    .reduce((s, f) => {
      const reste = nb(f.montant_restant);
      return s + (reste > 0.005 ? reste : Math.max(0, r2(nb(f.montant_ttc) - nb(f.montant_paye))));
    }, 0));
  const ecart = r2(gl.total - encoursFactures);
  return {
    encoursGrandLivre: gl.total, encoursFactures, ecart,
    ok: !comptabilise || Math.abs(ecart) <= 0.005, comptabilise,
  };
}

// ─── (c) Acomptes indus ──────────────────────────────────────────────────────

export interface AcompteIndu {
  facture: FactureVente;
  /** Les lignes fautives : crédit du 4191 hors facture d'acompte. */
  lignes: LigneGrandLivre[];
  montant: number;
  /** Compte de produit sur lequel la reclasser. */
  compteCible: string;
}

/**
 * Crédits du 4191 rattachés à une facture qui n'est PAS un acompte.
 *
 * `compteProduit` est rendu par l'appelant : le choix du 7111 / 7121 / 7124
 * dépend des désignations et du secteur (cf. src/lib/compte-vente.ts), données
 * que ce module n'a pas à connaître.
 */
export function acomptesIndus(
  factures: FactureVente[], lignes: LigneGrandLivre[],
  compteProduit: (f: FactureVente) => string,
): AcompteIndu[] {
  const indus: AcompteIndu[] = [];
  for (const f of factures ?? []) {
    if (estAcompte(f)) continue;
    const fautives = lignesDeLaFacture(lignes, f).filter(
      (l) => txt(l.compte_numero).startsWith(COMPTE_ACOMPTES_CLIENTS) && nb(l.credit) > 0.005,
    );
    if (!fautives.length) continue;
    indus.push({
      facture: f, lignes: fautives,
      montant: r2(fautives.reduce((s, l) => s + nb(l.credit), 0)),
      compteCible: compteProduit(f),
    });
  }
  return indus;
}

// ─── (d) Preuve d'encaissement ───────────────────────────────────────────────

export type SourcePreuve = "tresorerie" | "lettrage" | "piece" | "aucune";

export interface OptionsPreuve {
  /**
   * Une PIÈCE de règlement (`paiements`) suffit-elle à réputer la facture
   * encaissée, en l'absence de toute écriture de trésorerie ?
   *
   * `true` (défaut) — comportement historique, prudent : on ne détruit jamais la
   * trace d'un règlement saisi avant sa comptabilisation.
   *
   * `false` — RÈGLE STRICTE : seule une écriture de trésorerie (directe ou
   * lettrée) atteste un encaissement. C'est ce que le contrôle réclame, et c'est
   * ce qui a fait apparaître le cas SMERT WATER : deux factures « payées » sur la
   * foi d'une ligne bancaire SANS RELEVÉ, ANTÉRIEURE à l'émission, et dont aucune
   * écriture n'a jamais été tirée. Le compte 3421 restait ouvert de 81 972 MAD
   * pendant que les factures s'affichaient soldées.
   *
   * Passer à `false` ne supprime AUCUNE donnée : les lignes de `paiements` et les
   * transactions bancaires restent en base, prêtes à être relettrées proprement.
   */
  accepterPieces?: boolean;
}

export interface PreuveEncaissement {
  /** Montant réellement attesté — 0 quand rien ne l'atteste. */
  montant: number;
  source: SourcePreuve;
  /** Date du dernier encaissement attesté, ou `null`. */
  date: string | null;
  /** Statut que la facture DOIT porter au vu de cette preuve. */
  statut: StatutStocke;
  /**
   * `true` quand une pièce de règlement existe mais qu'AUCUNE écriture de
   * trésorerie ne la porte. Ce n'est pas une facture oubliée : c'est un
   * règlement enregistré dont la comptabilisation n'a jamais eu lieu. Le geste
   * de réparation est de la relettrer, pas de ressaisir le paiement.
   */
  pieceSansEcriture?: boolean;
}

/**
 * Ce qu'un encaissement laisse comme trace, de la plus forte à la plus faible :
 *
 *   1. une écriture de TRÉSORERIE (BQ/CAI) qui désigne la facture et CRÉDITE son
 *      compte de tiers — la contrepartie du débit banque/caisse. C'est la preuve
 *      que l'argent est entré, et c'est celle qu'exige la règle métier ;
 *   2. le LETTRAGE, quand l'écriture de trésorerie ne porte ni `facture_id` ni
 *      référence mais partage un code avec la ligne de vente ;
 *   3. une PIÈCE de règlement formelle (`paiements`), pour les factures réglées
 *      avant que l'écriture ne soit passée.
 *
 * On retient la PLUS FORTE : chacune est une borne inférieure de ce qui a été
 * encaissé, et chacune peut être en retard sur les autres. Ramener à zéro une
 * facture attestée par l'une d'elles détruirait la seule trace du règlement.
 */
export function preuveEncaissement(
  f: FactureVente, lignes: LigneGrandLivre[], pieces: PieceReglement[] = [],
  options: OptionsPreuve = {},
): PreuveEncaissement {
  const ttc = r2(f.montant_ttc);

  // 1. Écriture de trésorerie désignant la facture, au crédit d'un compte 342x.
  const directes = lignesDeLaFacture(lignes, f).filter(
    (l) => estJournalTresorerie(l.journal_code) && relevantDe(l.compte_numero, COMPTE_CLIENTS),
  );
  const montantDirect = r2(directes.reduce((s, l) => s + nb(l.credit) - nb(l.debit), 0));
  const datesDirectes = directes.map((l) => jourIso(l.date_ecriture)).filter(Boolean).sort();

  // 2. Lettrage — le calcul de référence, déjà éprouvé.
  const gl = situationFactureGrandLivre(lignes ?? [], {
    references: [f.numero, f.id], id: f.id, montant_ttc: ttc, sens: "client",
  });

  // 3. Pièces formelles.
  const montantPieces = r2((pieces ?? []).reduce((s, p) => s + nb(p.montant), 0));
  const datesPieces = (pieces ?? []).map((p) => jourIso(p.date)).filter(Boolean).sort();

  const candidats: { montant: number; source: SourcePreuve; date: string | null }[] = [
    { montant: Math.max(0, montantDirect), source: "tresorerie", date: datesDirectes.at(-1) ?? null },
    { montant: Math.max(0, gl.montant_paye), source: "lettrage", date: gl.date_paiement },
  ];
  // Les deux premières sont des preuves COMPTABLES ; la pièce n'en est une que
  // si on l'admet (cf. OptionsPreuve.accepterPieces).
  if (options.accepterPieces !== false) {
    candidats.push({ montant: Math.max(0, montantPieces), source: "piece", date: datesPieces.at(-1) ?? null });
  }
  // À montant ÉGAL, l'ordre du tableau départage : la trésorerie prime, car
  // c'est la preuve que la règle métier exige nommément.
  const meilleur = candidats.reduce((a, b) => (b.montant > a.montant + 0.005 ? b : a));

  if (meilleur.montant <= 0.005) {
    return {
      montant: 0, source: "aucune", date: null, statut: "non_payee",
      // Distingue « rien ne s'est passé » de « une pièce existe mais aucune
      // écriture ne la porte » — deux situations qui appellent des gestes
      // opposés : la première ne demande rien, la seconde demande de relettrer.
      pieceSansEcriture: montantPieces > 0.005,
    };
  }
  const montant = Math.min(meilleur.montant, ttc);
  return {
    montant: r2(montant), source: meilleur.source, date: meilleur.date,
    statut: statutStocke(statutDepuisMontants(ttc, montant)),
  };
}

export interface StatutARecalibrer {
  facture: FactureVente;
  avant: { statut_paiement: StatutStocke; montant_paye: number; montant_restant: number; date_paiement: string | null };
  apres: { statut_paiement: StatutStocke; montant_paye: number; montant_restant: number; date_paiement: string | null };
  preuve: PreuveEncaissement;
  /** En clair, ce qui justifie la correction — destiné au rapport du script. */
  motif: string;
}

/**
 * Factures dont le statut commercial contredit la comptabilité.
 *
 * La date de règlement est corrigée dans le même mouvement, car les deux vont de
 * pair : une facture ramenée à « non payée » ne peut pas conserver une date de
 * règlement, et une facture attestée doit porter la date de SA pièce, pas celle
 * qu'un import a déposée.
 */
export function statutsARecalibrer(
  factures: FactureVente[], lignes: LigneGrandLivre[],
  piecesParFacture: Map<string, PieceReglement[]> = new Map(),
  options: OptionsPreuve = {},
): StatutARecalibrer[] {
  const corrections: StatutARecalibrer[] = [];
  for (const f of factures ?? []) {
    const ttc = r2(f.montant_ttc);
    const preuve = preuveEncaissement(f, lignes, piecesParFacture.get(txt(f.id)) ?? [], options);
    const avant = {
      statut_paiement: statutStocke(f.statut_paiement),
      montant_paye: r2(f.montant_paye),
      montant_restant: r2(f.montant_restant),
      date_paiement: jourIso(f.date_paiement) || null,
    };
    // La date retenue : celle de la pièce quand elle existe ; sinon on conserve
    // la date stockée, mais RECALÉE si elle précède l'émission (cf. plus bas).
    const dateBrute = preuve.date ?? avant.date_paiement;
    const apres = {
      statut_paiement: preuve.statut,
      montant_paye: preuve.montant,
      montant_restant: Math.max(0, r2(ttc - preuve.montant)),
      date_paiement: preuve.statut === "non_payee" ? null : recalerDateReglement(f.date_facture, dateBrute),
    };

    const bouge = avant.statut_paiement !== apres.statut_paiement
      || Math.abs(avant.montant_paye - apres.montant_paye) > 0.005
      || Math.abs(avant.montant_restant - apres.montant_restant) > 0.005
      || avant.date_paiement !== apres.date_paiement;
    if (!bouge) continue;

    const motif = preuve.source !== "aucune"
      ? `encaissement attesté par ${preuve.source} : ${preuve.montant.toFixed(2)} MAD sur ${ttc.toFixed(2)}`
      : preuve.pieceSansEcriture
        ? `statut « ${avant.statut_paiement} » adossé à une pièce de règlement QUE LA COMPTABILITÉ NE PORTE PAS `
          + "(aucune écriture BQ/CAI, aucun lettrage) — à relettrer"
        : `statut « ${avant.statut_paiement} » sans aucune écriture de trésorerie ni pièce de règlement`;
    corrections.push({ facture: f, avant, apres, preuve, motif });
  }
  return corrections;
}

// ─── Vraisemblance des dates de règlement ────────────────────────────────────

/**
 * Une date de règlement antérieure à l'émission est impossible : on la RECALE
 * sur la date de facture.
 *
 * Pourquoi la date de facture plutôt que rien : effacer la date ferait perdre le
 * fait qu'un règlement a eu lieu, alors que la seule chose dont on soit sûr est
 * qu'il n'a pas pu précéder l'émission. Le recalage est la correction minimale.
 */
export function recalerDateReglement(
  dateFacture: string | null | undefined, dateReglement: string | null | undefined,
): string | null {
  const regl = jourIso(dateReglement);
  if (!regl) return null;
  const fact = jourIso(dateFacture);
  return fact && regl < fact ? fact : regl;
}

/**
 * Corrige d'abord l'ANNÉE, avant de se rabattre sur la date de facture.
 *
 * `recalerDateReglement` ramène brutalement une date impossible sur le jour de
 * l'émission. C'est la correction minimale sûre, mais elle perd le jour réel du
 * règlement quand la faute est un simple millésime — le cas le plus fréquent :
 * REPERAL portait un règlement au 16/07/**2024** pour une facture du 20/06/2026.
 * Le jour et le mois sont crédibles, seule l'année ne l'est pas.
 *
 * On tente donc le millésime de la facture : 2024-07-16 → 2026-07-16, qui suit
 * bien l'émission. Si la substitution ne suffit pas (règlement en janvier pour
 * une facture de décembre), on essaie l'année SUIVANTE — un encaissement de
 * début d'année solde couramment une facture de fin d'année précédente.
 *
 * Cette seconde tentative est BORNÉE à `FENETRE_REGLEMENT_JOURS`. Sans borne,
 * une facture du 20/06 réglée « le 19/06 » verrait sa date propulsée au 19/06 de
 * l'année suivante — 364 jours plus tard, ce qui est bien pire que l'anomalie
 * corrigée. Au-delà de la fenêtre, on retombe sur la date de facture, qui est la
 * seule chose dont on soit certain.
 */
export const FENETRE_REGLEMENT_JOURS = 180;

export function corrigerAnneeReglement(
  dateFacture: string | null | undefined, dateReglement: string | null | undefined,
): string | null {
  const regl = jourIso(dateReglement);
  const fact = jourIso(dateFacture);
  if (!regl) return null;
  if (!fact || regl >= fact) return regl;

  const anneeFacture = Number(fact.slice(0, 4));
  const candidats = [
    { annee: anneeFacture, borne: Infinity },
    { annee: anneeFacture + 1, borne: FENETRE_REGLEMENT_JOURS },
  ];
  for (const { annee, borne } of candidats) {
    const candidat = `${annee}${regl.slice(4)}`;
    // Le 29 février d'une année non bissextile ne survit pas à la substitution.
    if (!jourIso(candidat) || Number.isNaN(Date.parse(candidat))) continue;
    if (candidat < fact) continue;
    const jours = (Date.parse(candidat) - Date.parse(fact)) / 86400000;
    if (jours <= borne) return candidat;
  }
  return fact;
}

export interface DateReglementIncoherente {
  facture: FactureVente;
  dateFacture: string;
  dateReglement: string;
  /** Date retenue après recalage. */
  dateCorrigee: string;
  /** Nombre de jours d'antériorité constatés. */
  joursAvant: number;
}

export function datesReglementIncoherentes(factures: FactureVente[]): DateReglementIncoherente[] {
  const anomalies: DateReglementIncoherente[] = [];
  for (const f of factures ?? []) {
    const fact = jourIso(f.date_facture);
    const regl = jourIso(f.date_paiement);
    if (!fact || !regl || regl >= fact) continue;
    anomalies.push({
      facture: f, dateFacture: fact, dateReglement: regl,
      dateCorrigee: fact,
      joursAvant: Math.round((Date.parse(fact) - Date.parse(regl)) / 86400000),
    });
  }
  return anomalies;
}

// ─── Rapport d'ensemble ──────────────────────────────────────────────────────

export interface RapportCoherence {
  /** Exercice sur lequel porte le rapport, `null` si tous exercices confondus. */
  bornes: BornesExercice | null;
  ca: EcartCaProduits;
  encours: EcartEncours;
  acomptes: AcompteIndu[];
  statuts: StatutARecalibrer[];
  dates: DateReglementIncoherente[];
  /** Écritures d'exercices ANTÉRIEURS trouvées dans le périmètre demandé. */
  horsExercice: number;
  ok: boolean;
}

export interface OptionsCoherence extends OptionsPreuve {
  /** Restreint tous les contrôles à un exercice. */
  bornes?: BornesExercice | null;
  /** Choix du compte de produit d'une facture — cf. `acomptesIndus`. */
  compteProduit?: (f: FactureVente) => string;
  piecesParFacture?: Map<string, PieceReglement[]>;
}

/**
 * Les cinq contrôles en un passage, pour UN dossier.
 *
 * Quand des bornes d'exercice sont fournies, factures ET écritures y sont
 * restreintes AVANT tout calcul : rapprocher le CA 2026 avec des crédits de
 * classe 7 de 2024 produirait un écart qui n'existe pas.
 */
export function auditerCoherenceVentes(
  factures: FactureVente[], lignes: LigneGrandLivre[], options: OptionsCoherence = {},
): RapportCoherence {
  const bornes = options.bornes ?? null;
  // Les lectures BORNÉES gardent les à-nouveaux — c'est eux qui portent les
  // soldes d'ouverture. Les lectures CUMULÉES les écartent, sous peine de
  // compter deux fois ce qu'ils reportent (cf. src/lib/a-nouveaux.ts).
  const toutesLignes = sansANouveaux(lignes ?? []);
  const F = bornes ? (factures ?? []).filter((f) => dansExercice(f.date_facture, bornes)) : (factures ?? []);
  const L = bornes
    ? (lignes ?? []).filter((l) => dansExercice(l.date_ecriture, bornes))
    : toutesLignes;

  const ca = rapprocherCaProduits(F, L);
  const encours = rapprocherEncoursClients(F, L);
  const acomptes = acomptesIndus(F, L, options.compteProduit ?? (() => "7111"));
  // Le recalibrage des statuts lit le grand livre ENTIER : un encaissement de
  // janvier N+1 solde bien une facture de décembre N, et le borner à l'exercice
  // ferait « démarquer » toutes les factures réglées après la clôture.
  const statuts = statutsARecalibrer(F, toutesLignes, options.piecesParFacture, options);
  const dates = datesReglementIncoherentes(F);
  const horsExercice = bornes
    ? toutesLignes.filter((l) => jourIso(l.date_ecriture) && !dansExercice(l.date_ecriture, bornes)).length
    : 0;

  return {
    bornes, ca, encours, acomptes, statuts, dates, horsExercice,
    ok: ca.ok && encours.ok && acomptes.length === 0 && statuts.length === 0 && dates.length === 0,
  };
}

/** Lignes NON LETTRÉES du 342x — le détail derrière l'encours (contrôle b). */
export function postesOuvertsClients(lignes: LigneGrandLivre[]): LigneGrandLivre[] {
  return (lignes ?? []).filter((l) => relevantDe(l.compte_numero, COMPTE_CLIENTS) && !estLettree(l));
}
