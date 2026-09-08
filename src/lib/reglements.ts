// ============================================================================
// reglements.ts — LA source de vérité d'un règlement.
//
// ─── Le défaut qu'il ferme ───────────────────────────────────────────────────
// Le reste dû d'une facture était établi par trois autorités qui ne se parlaient
// pas : les colonnes `factures.montant_paye/…`, la table `paiements`, et le grand
// livre. Chacune pouvait avoir raison seule. Le dossier SMERT WATER en donne la
// forme pure : deux factures affichées « payées » pour 81 972 MAD, sur la foi de
// deux lignes de `paiements` dérivées de virements bancaires ANTÉRIEURS À
// L'ÉMISSION des factures (9 et 68 jours), et dont le grand livre n'a jamais rien
// su — le compte 3421 restait ouvert du même montant.
//
// La réconciliation en vigueur retenait le MAXIMUM des deux preuves, par prudence
// (« ne jamais perdre la trace d'un règlement »). Prudence retournée contre
// elle-même : une pièce IMPOSSIBLE l'emportait sur un grand livre correct, et le
// maximum garantissait qu'aucune resynchronisation ne pourrait jamais la déloger.
//
// ─── La règle ────────────────────────────────────────────────────────────────
// Une pièce n'est une preuve que si elle est RECEVABLE. La recevabilité se juge
// AVANT toute comparaison de montants, et sur des impossibilités, pas sur des
// préférences :
//
//   • un règlement ne précède pas l'émission de ce qu'il règle ;
//   • une même pièce ne règle qu'une fois (idempotence) ;
//   • un règlement a un montant strictement positif ;
//   • la somme des règlements ne dépasse pas ce qui est dû.
//
// Une pièce irrecevable n'est ni comptée, ni supprimée : elle est RENDUE, avec son
// motif, à qui doit en décider. C'est la différence entre corriger un chiffre et
// effacer un fait.
//
// ─── Pourquoi un module à part ───────────────────────────────────────────────
// `encours-grandlivre.ts` sait lire le grand livre, `coherence-ventes.ts` sait
// dénoncer un écart, `date-reglement.ts` sait dater. Aucun ne pouvait porter la
// question « cette pièce compte-t-elle ? » sans que les deux autres la reposent
// autrement. Elle est ici, une fois, et les trois s'y adossent.
//
// Logique PURE : l'écran, la server function, le script de reprise et les tests
// consomment le même calcul. C'est la seule façon qu'ils ne divergent pas.
// ============================================================================

import { statutPaiement } from "@/lib/paiements";

const r2 = (x: unknown) => Math.round((Number(x) || 0) * 100) / 100;
const nb = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const txt = (v: unknown) => String(v ?? "").trim();
const jour = (v: unknown): string => {
  const d = txt(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : "";
};

/**
 * Tolérance en MAD sur le reste dû, alignée sur `statutDepuisMontants` et sur la
 * RPC `lier_transaction`. Un seul seuil dans toute la chaîne : deux seuils
 * différents produiraient une facture « payée » à l'écran et « partielle » en
 * base, ce qui est exactement la classe de bug qu'on ferme.
 *
 * Elle borne le DÉPASSEMENT admis, jamais le reste conservé : un règlement de
 * 2 629,00 sur une facture de 2 629,02 laisse bien 0,02 MAD au compte du client.
 * Le seuil décide d'un STATUT, il n'efface aucun centime.
 */
export const TOLERANCE_REGLEMENT = 1;

/**
 * Marqueur porté par la `reference` d'un règlement dont la pièce d'origine s'est
 * révélée FAUSSE, alors que la comptabilité porte bien le règlement.
 *
 * Le cas : REPERAL (FAC002_2026). L'écriture de trésorerie du 16/07/2026 est
 * équilibrée, lettrée, et sa bascule de TVA suit — mais elle s'adossait à un
 * chèque du 16/07/**2024**. Supprimer le règlement démarquerait une facture que
 * le grand livre dit réglée ; le laisser adossé à la fausse pièce maintiendrait
 * un mensonge. On détache donc, et on MARQUE.
 *
 * Sans ce marqueur, le règlement détaché redeviendrait une pièce de règlement
 * ordinaire : il justifierait l'écriture de trésorerie, et le contrôle
 * d'intégrité cesserait de voir que cette écriture n'a plus aucune pièce
 * bancaire derrière elle. La correction masquerait alors le problème qu'elle
 * vient de mettre au jour.
 *
 * `estPieceARetrouver` est le SEUL endroit qui connaît la forme du marqueur : le
 * script qui le pose et le contrôle qui le lit s'y adossent tous les deux.
 */
export const MARQUEUR_PIECE_A_RETROUVER = "PIECE-A-RETROUVER";

export const estPieceARetrouver = (reference: unknown): boolean =>
  String(reference ?? "").startsWith(MARQUEUR_PIECE_A_RETROUVER);

export type MotifRejet =
  /** Montant nul ou négatif : ce n'est pas un règlement. */
  | "montant_nul"
  /** Daté avant l'émission de la facture — impossible. */
  | "anterieur_facture"
  /** Même pièce déjà comptée (transaction, encaissement, ou triplet identique). */
  | "doublon"
  /** Ferait dépasser le TTC de plus que la tolérance. */
  | "surpaiement";

export const LIBELLES_REJET: Record<MotifRejet, string> = {
  montant_nul: "montant nul ou négatif",
  anterieur_facture: "règlement antérieur à l'émission de la facture",
  doublon: "pièce déjà comptée pour cette facture",
  surpaiement: "dépasse le montant dû",
};

/** Le sous-ensemble d'une ligne `paiements` dont la recevabilité a besoin. */
export interface PaiementCandidat {
  id?: string | null;
  montant?: number | null;
  date_paiement?: string | null;
  origine?: string | null;
  transaction_id?: string | null;
  encaissement_id?: string | null;
  reference?: string | null;
}

/** Le sous-ensemble d'une facture dont la recevabilité a besoin. */
export interface FactureReglee {
  id?: string | null;
  numero?: string | null;
  date_facture?: string | null;
  montant_ttc?: number | null;
}

export interface ExamenPaiement {
  paiement: PaiementCandidat;
  recevable: boolean;
  /** Tous les griefs, pas seulement le premier : un doublon peut aussi être antérieur. */
  motifs: MotifRejet[];
  /** Grief en clair, prêt pour un rapport ou une infobulle. `null` si recevable. */
  message: string | null;
}

/**
 * Identité d'une pièce, pour la détection de doublon.
 *
 * La pièce d'origine prime quand elle existe — c'est elle que les index uniques
 * de `paiements` protègent. À défaut (règlement manuel), le triplet
 * date + montant + référence tient lieu d'identité : deux règlements du même
 * jour, du même montant et de la même référence sur la même facture sont le même
 * règlement saisi deux fois.
 *
 * Deux acomptes du même montant à des dates DIFFÉRENTES restent deux règlements :
 * la date est dans la clé, et c'est délibéré — le contraire ferait disparaître le
 * second versement d'un échéancier régulier.
 */
export function clePaiement(p: PaiementCandidat): string {
  const tx = txt(p.transaction_id);
  if (tx) return `tx:${tx}`;
  const enc = txt(p.encaissement_id);
  if (enc) return `enc:${enc}`;
  return `saisie:${jour(p.date_paiement)}|${r2(p.montant).toFixed(2)}|${txt(p.reference).toLowerCase()}`;
}

export interface OptionsRecevabilite {
  /**
   * Refuser un règlement antérieur à l'émission. `true` par défaut.
   *
   * Le désactiver n'a qu'un usage : rejouer un audit sur l'état AVANT correction
   * pour mesurer ce que la règle change. Jamais en écriture.
   */
  controlerAnteriorite?: boolean;
  /** Refuser ce qui dépasse le TTC. `true` par défaut. */
  controlerSurpaiement?: boolean;
}

/**
 * Passe au crible les pièces d'UNE facture, dans l'ordre chronologique.
 *
 * L'ordre compte pour le seul contrôle CUMULATIF, le surpaiement : c'est le
 * dernier versement arrivé qui fait déborder, pas le premier. Trier autrement
 * ferait porter le grief à un règlement légitime.
 *
 * Les pièces sans date passent en tête : une pièce non datée ne peut pas être
 * ce qui fait déborder un cumul qu'on ne sait pas situer dans le temps.
 */
export function examinerPaiements(
  facture: FactureReglee,
  paiements: PaiementCandidat[],
  options: OptionsRecevabilite = {},
): ExamenPaiement[] {
  const controlerAnteriorite = options.controlerAnteriorite !== false;
  const controlerSurpaiement = options.controlerSurpaiement !== false;

  const ttc = r2(facture.montant_ttc);
  const emission = jour(facture.date_facture);

  const ordonnes = [...(paiements ?? [])].sort((a, b) => {
    const da = jour(a.date_paiement), db = jour(b.date_paiement);
    if (da === db) return 0;
    if (!da) return -1;
    if (!db) return 1;
    return da < db ? -1 : 1;
  });

  const vues = new Set<string>();
  let cumul = 0;
  const examens: ExamenPaiement[] = [];

  for (const p of ordonnes) {
    const motifs: MotifRejet[] = [];
    const montant = r2(p.montant);

    if (montant <= 0.005) motifs.push("montant_nul");

    // Antériorité — le contrôle qui manquait. Une date de facture absente ou
    // illisible ne bloque rien : elle ne prouve pas l'impossibilité, et bloquer
    // rendrait inutilisables les factures importées sans date d'émission.
    const regle = jour(p.date_paiement);
    if (controlerAnteriorite && emission && regle && regle < emission) {
      motifs.push("anterieur_facture");
    }

    const cle = clePaiement(p);
    if (vues.has(cle)) motifs.push("doublon");

    // Surpaiement : un contrôle CUMULATIF, et seulement cumulatif.
    //
    // `cumul > 0.005` n'est pas une précaution, c'est la règle. Un PREMIER
    // règlement supérieur au TTC n'est pas un règlement fictif : l'argent est
    // arrivé, avec un trop-perçu. Le rejeter ferait passer la facture pour
    // impayée alors qu'elle est plus que soldée — on le retient donc, et la
    // projection le plafonne au TTC (le trop-perçu relève d'un avoir ou du 4191).
    //
    // Ce qui est fautif, c'est le règlement qui déborde APRÈS un autre : c'est la
    // signature du double comptage, et c'est cela qu'on écarte.
    //
    // Le cumul ne retient que ce qui a DÉJÀ été accepté : un règlement rejeté
    // pour antériorité ne doit pas, en plus, faire rejeter le suivant.
    if (controlerSurpaiement && !motifs.length && ttc > 0.005
        && cumul > 0.005 && cumul + montant > ttc + TOLERANCE_REGLEMENT) {
      motifs.push("surpaiement");
    }

    const recevable = motifs.length === 0;
    // Un doublon reste « vu » : trois saisies identiques donnent un accepté et
    // deux rejetés, pas un accepté, un rejeté et un troisième réadmis.
    vues.add(cle);
    if (recevable) cumul = r2(cumul + montant);

    examens.push({
      paiement: p, recevable, motifs,
      message: recevable ? null : formulerRejet(facture, p, motifs, { emission, ttc, cumul }),
    });
  }

  return examens;
}

function formulerRejet(
  facture: FactureReglee, p: PaiementCandidat, motifs: MotifRejet[],
  ctx: { emission: string; ttc: number; cumul: number },
): string {
  const ref = txt(facture.numero) || txt(facture.id).slice(0, 8) || "facture";
  const montant = r2(p.montant).toFixed(2);
  const date = jour(p.date_paiement) || "sans date";
  const details = motifs.map((m) => {
    if (m === "anterieur_facture") return `réglé le ${date} pour une facture du ${ctx.emission}`;
    if (m === "surpaiement") return `${ctx.cumul.toFixed(2)} déjà reçus + ${montant} > ${ctx.ttc.toFixed(2)} dus`;
    if (m === "doublon") return `pièce ${clePaiement(p)} déjà comptée`;
    return LIBELLES_REJET[m];
  });
  return `${ref} — règlement de ${montant} MAD écarté : ${details.join(" ; ")}.`;
}

/** Les seules pièces qu'on accepte de compter. */
export function paiementsRecevables(
  facture: FactureReglee, paiements: PaiementCandidat[], options: OptionsRecevabilite = {},
): PaiementCandidat[] {
  return examinerPaiements(facture, paiements, options)
    .filter((e) => e.recevable).map((e) => e.paiement);
}

/** Les pièces écartées, avec leur motif — ce qu'un rapport doit montrer. */
export function paiementsIrrecevables(
  facture: FactureReglee, paiements: PaiementCandidat[], options: OptionsRecevabilite = {},
): ExamenPaiement[] {
  return examinerPaiements(facture, paiements, options).filter((e) => !e.recevable);
}

// ─── Projection : l'état de règlement d'une facture ──────────────────────────

/** D'où vient le montant retenu. */
export type PreuveReglement =
  /** Écriture de trésorerie lettrée : la preuve comptable. */
  | "grand_livre"
  /** Pièce recevable, pas encore portée en écriture. */
  | "piece"
  /** Rien ne l'atteste. */
  | "aucune";

export interface EtatReglement {
  montant_paye: number;
  /** TTC − payé, à l'exactitude du centime. Jamais lissé par la tolérance. */
  montant_restant: number;
  statut_paiement: "non_payee" | "partielle" | "payee";
  /** Date du DERNIER règlement retenu, ou `null`. */
  date_reglement: string | null;
  preuve: PreuveReglement;
  /**
   * Une pièce recevable existe, mais aucune écriture ne la porte. Ce n'est pas
   * une facture oubliée : c'est un règlement à COMPTABILISER. Le geste de
   * réparation est de le lettrer, pas de ressaisir le paiement.
   */
  aComptabiliser: number;
  /** Pièces écartées et pourquoi — jamais silencieux. */
  ecartees: ExamenPaiement[];
}

export interface OptionsProjection extends OptionsRecevabilite {
  /**
   * Une pièce recevable mais NON COMPTABILISÉE suffit-elle à réputer la facture
   * réglée ?
   *
   * `true` (défaut) — on retient la plus forte des deux preuves. C'est ce qui
   * évite de « démarquer » les factures d'un dossier réglé avant d'être lettré.
   *
   * `false` — RÈGLE STRICTE : seule la comptabilité fait foi. C'est le mode de
   * l'arrêté et du contrôle de conformité, où un chiffre non justifié par une
   * écriture n'a pas à figurer.
   *
   * Dans les DEUX modes, une pièce irrecevable ne compte pas : la recevabilité
   * se juge avant, et elle ne se négocie pas.
   */
  accepterPiecesNonComptabilisees?: boolean;
}

/**
 * L'état de règlement d'une facture, depuis le grand livre et les pièces.
 *
 * `montantComptabilise` est ce que le grand livre atteste — calculé ailleurs
 * (`situationFactureGrandLivre`), parce que le lire suppose de connaître le
 * lettrage, les journaux de trésorerie et les comptes auxiliaires. Ce module
 * n'en a pas besoin : il arbitre entre deux nombres et une liste de pièces.
 */
export function projeterEtatReglement(
  facture: FactureReglee,
  montantComptabilise: number,
  dateComptabilisee: string | null,
  paiements: PaiementCandidat[],
  options: OptionsProjection = {},
): EtatReglement {
  const ttc = r2(facture.montant_ttc);
  const examens = examinerPaiements(facture, paiements, options);
  const recus = examens.filter((e) => e.recevable);
  const ecartees = examens.filter((e) => !e.recevable);

  const comptabilise = Math.max(0, r2(montantComptabilise));
  const surPieces = r2(recus.reduce((s, e) => s + nb(e.paiement.montant), 0));
  // Ce qu'une pièce recevable apporte EN PLUS de ce que la comptabilité porte.
  const aComptabiliser = Math.max(0, r2(surPieces - comptabilise));

  const accepterPieces = options.accepterPiecesNonComptabilisees !== false;
  const retenu = accepterPieces ? Math.max(comptabilise, surPieces) : comptabilise;

  // Le payé ne dépasse jamais le dû : au-delà, ce n'est plus un règlement de
  // cette facture mais un trop-perçu, qui relève d'un avoir ou du 4191.
  const paye = ttc > 0.005 ? Math.min(retenu, ttc) : retenu;

  const datesPieces = recus.map((e) => jour(e.paiement.date_paiement)).filter(Boolean).sort();
  const preuve: PreuveReglement = paye <= 0.005
    ? "aucune"
    : comptabilise >= paye - 0.005 ? "grand_livre" : "piece";

  return {
    montant_paye: r2(paye),
    montant_restant: Math.max(0, r2(ttc - paye)),
    statut_paiement: statutPaiement(ttc, paye),
    date_reglement: paye <= 0.005
      ? null
      : preuve === "grand_livre"
        ? (dateComptabilisee ?? datesPieces[datesPieces.length - 1] ?? null)
        : (datesPieces[datesPieces.length - 1] ?? dateComptabilisee ?? null),
    preuve,
    aComptabiliser,
    ecartees,
  };
}

/** Vrai si l'état stocké sur la facture contredit l'état projeté. */
export function reglementDivergent(
  stocke: {
    montant_paye?: number | null; montant_restant?: number | null;
    statut_paiement?: string | null; date_paiement?: string | null;
  },
  projete: EtatReglement,
): boolean {
  return Math.abs(r2(nb(stocke.montant_paye) - projete.montant_paye)) > 0.005
    || Math.abs(r2(nb(stocke.montant_restant) - projete.montant_restant)) > 0.005
    || txt(stocke.statut_paiement) !== projete.statut_paiement
    || (jour(stocke.date_paiement) || null) !== projete.date_reglement;
}
