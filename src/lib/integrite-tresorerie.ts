// ============================================================================
// integrite-tresorerie.ts — RÈGLE D'INTÉGRITÉ Banque ⇄ Grand Livre.
//
// ─── La règle ────────────────────────────────────────────────────────────────
// Une écriture d'un journal de TRÉSORERIE (BQ / CAI) constate un mouvement
// d'argent. Elle ne peut donc exister que si ce mouvement est ATTESTÉ par une
// pièce, et il n'y en a que deux sortes :
//
//   1. un RELEVÉ BANCAIRE VALIDÉ — l'écriture porte `transaction_id`, et cette
//      transaction est rattachée à un relevé (`releve_id` non nul) ;
//   2. une SAISIE MANUELLE FORMELLE de trésorerie — un `paiements` ou un
//      `encaissements` a été enregistré, et l'écriture en découle.
//
// Tout le reste est une écriture FANTÔME : elle gonfle la trésorerie, rend la
// TVA exigible sur un encaissement qui n'a jamais eu lieu, et fait diverger le
// solde du compte 5141 de celui du relevé.
//
// ─── Le piège que cette règle corrige ────────────────────────────────────────
// `facture_id` N'EST PAS UNE PREUVE. Une écriture de banque peut désigner la
// facture qu'elle prétend solder sans qu'aucun argent n'ait bougé : c'est
// exactement la forme des jeux de démonstration (« Encaissement FAC-…, D 5141 /
// C 3421 », lettré, sans le moindre relevé derrière). L'audit précédent
// acceptait `facture_id` comme pièce et classait ces écritures « adossées » —
// elles passaient donc au travers du filet. Une facture dit ce qui est DÛ, un
// relevé dit ce qui est PAYÉ ; seul le second peut justifier un mouvement de
// trésorerie.
//
// Logique pure : le contrôle à l'écriture (garde) et le contrôle a posteriori
// (audit) partagent les MÊMES règles, pour qu'aucune donnée refusée à l'entrée
// ne soit tolérée à l'audit, et réciproquement.
// ============================================================================

/** Journaux dont les écritures constatent un mouvement d'argent. */
export const JOURNAUX_TRESORERIE = ["BQ", "CAI"] as const;

export function estJournalTresorerie(journal: string | null | undefined): boolean {
  const j = String(journal ?? "").trim().toUpperCase();
  return (JOURNAUX_TRESORERIE as readonly string[]).includes(j);
}

/** D'où vient une écriture de trésorerie — les deux seules origines licites, et l'absence. */
export type OrigineTresorerie = "releve" | "saisie_manuelle" | "aucune";

const round2 = (x: number) => Math.round(x * 100) / 100;
const nb = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const txt = (v: unknown) => String(v ?? "").trim();

// ─── Contrôle A POSTERIORI (audit d'un grand livre existant) ─────────────────

/** Les colonnes d'une écriture nécessaires au verdict. */
export interface LigneTresorerie {
  id?: string;
  journal_code?: string | null;
  compte_numero?: string | null;
  date_ecriture?: string | null;
  libelle?: string | null;
  debit?: number | null;
  credit?: number | null;
  reference_piece?: string | null;
  lettrage_code?: string | null;
  transaction_id?: string | null;
  facture_id?: string | null;
}

/**
 * Les pièces existantes du dossier, indexées pour un verdict en O(1).
 *
 * `transactionsValidees` ne doit contenir QUE des transactions à `releve_id` non
 * nul : les jeux de démonstration ont aussi semé des `transactions_bancaires`
 * orphelines, et les accepter laisserait une donnée fictive en couvrir une autre.
 */
export interface ContexteOrigine {
  /** ids de `transactions_bancaires` RATTACHÉES à un relevé. */
  transactionsValidees?: Iterable<string>;
  /** Clés `date|montant` des `paiements` / `encaissements` saisis à la main (cf. clePiece). */
  piecesManuelles?: Iterable<string>;
}

/** Clé d'appariement d'une saisie manuelle : sa date et son montant, au centime. */
export function clePiece(date: string | null | undefined, montant: number): string {
  return `${txt(date).slice(0, 10)}|${round2(Math.abs(nb(montant))).toFixed(2)}`;
}

export interface VerdictOrigine {
  origine: OrigineTresorerie;
  /** `false` = écriture fantôme : aucun mouvement d'argent connu ne la justifie. */
  ok: boolean;
  raison: string;
}

/**
 * Verdict sur UNE ligne de trésorerie déjà écrite.
 *
 * Une ligne hors journal de trésorerie est toujours acceptée : la règle ne porte
 * que sur les mouvements d'argent. Une vente à crédit (VTE) n'a pas à s'appuyer
 * sur un relevé.
 */
export function origineEcritureTresorerie(
  ligne: LigneTresorerie, contexte: ContexteOrigine = {},
): VerdictOrigine {
  if (!estJournalTresorerie(ligne.journal_code)) {
    return { origine: "saisie_manuelle", ok: true, raison: "Hors journal de trésorerie." };
  }

  const tx = txt(ligne.transaction_id);
  if (tx) {
    const validees = new Set([...(contexte.transactionsValidees ?? [])].map(String));
    // Sans index fourni, on fait confiance à l'estampille : l'appelant qui ne
    // charge pas les transactions ne peut pas prouver le contraire.
    if (!contexte.transactionsValidees || validees.has(tx)) {
      return { origine: "releve", ok: true, raison: "Ligne de relevé bancaire validé." };
    }
    return {
      origine: "aucune", ok: false,
      raison: "Transaction bancaire rattachée à AUCUN relevé : elle ne prouve rien.",
    };
  }

  const manuelles = new Set([...(contexte.piecesManuelles ?? [])].map(String));
  const montant = Math.max(nb(ligne.debit), nb(ligne.credit));
  if (manuelles.has(clePiece(ligne.date_ecriture, montant))) {
    return { origine: "saisie_manuelle", ok: true, raison: "Saisie manuelle de trésorerie (paiement / encaissement)." };
  }

  return {
    origine: "aucune", ok: false,
    raison: txt(ligne.facture_id)
      // Le cas exact des données de démonstration — nommé, pour qu'on ne le
      // reprenne pas pour un simple lien perdu.
      ? "Écriture de banque rattachée à une facture mais à AUCUN relevé ni saisie de trésorerie : une facture dit ce qui est dû, pas ce qui est payé."
      : "Aucun relevé bancaire ni saisie manuelle ne justifie ce mouvement.",
  };
}

/**
 * Clé d'ÉCRITURE — l'unité indivisible de la partie double.
 *
 * La référence de pièce prime sur le libellé : les deux lignes d'un règlement
 * portent des libellés DIFFÉRENTS (« Encaissement FAC-… » au débit de la banque,
 * « Règlement client FAC-… » au crédit du tiers) mais la même référence. Grouper
 * sur le libellé les séparait, et supprimer la moitié d'une écriture
 * déséquilibrait le grand livre du montant du règlement.
 *
 * Grouper TROP LARGE est sans danger — le lot est affiché ligne à ligne et refusé
 * s'il ne se solde pas. Grouper trop étroit, lui, casse la partie double.
 */
export function cleEcritureTresorerie(l: LigneTresorerie): string {
  const base = `${txt(l.journal_code).toUpperCase()}|${txt(l.date_ecriture).slice(0, 10)}`;
  const ref = txt(l.reference_piece);
  return ref ? `${base}|ref:${ref}` : `${base}|lib:${txt(l.libelle)}`;
}

/** Regroupe des lignes en écritures complètes, par `cleEcritureTresorerie`. */
export function grouperEnEcritures<T extends LigneTresorerie>(lignes: T[]): Map<string, T[]> {
  const groupes = new Map<string, T[]>();
  for (const l of lignes) {
    const c = cleEcritureTresorerie(l);
    const g = groupes.get(c);
    if (g) g.push(l); else groupes.set(c, [l]);
  }
  return groupes;
}

/** Σ débits − Σ crédits d'un lot : nul sur une écriture complète. */
export function ecartPartieDouble(lignes: LigneTresorerie[]): number {
  return round2(lignes.reduce((s, l) => s + nb(l.debit) - nb(l.credit), 0));
}

// ─── Contrôle À L'ÉCRITURE (garde du moteur de trésorerie) ───────────────────

/** Ce qu'on s'apprête à insérer dans `ecritures_comptables`. */
export interface EcritureAInserer {
  journal_code?: string | null;
  compte_numero?: string | null;
  libelle?: string | null;
  transaction_id?: string | null;
  [k: string]: unknown;
}

export interface ContexteEcriture {
  /**
   * Origine REVENDIQUÉE par l'appelant. `releve` engage à estampiller chaque
   * ligne d'un `transaction_id` ; `saisie_manuelle` engage à fournir `piece`.
   */
  origine: OrigineTresorerie;
  /**
   * Référence de la pièce manuelle qui vient d'être enregistrée (id de
   * `paiements` / `encaissements`, ou à défaut la référence du règlement).
   * Exigée dès que l'origine est `saisie_manuelle` : c'est elle qui distingue
   * une saisie FORMELLE d'une écriture posée à la main sur un écran.
   */
  piece?: string | null;
}

export interface ControleEcriture {
  ok: boolean;
  raison: string | null;
  /** Lignes de trésorerie refusées — les autres journaux ne sont pas concernés. */
  refusees: EcritureAInserer[];
}

/**
 * Garde du moteur de trésorerie : contrôle un lot d'écritures AVANT insertion.
 *
 * On valide le lot ENTIER ou rien : insérer les lignes conformes et rejeter les
 * autres déséquilibrerait le grand livre, ce qui est pire que le refus.
 */
export function controlerEcrituresTresorerie(
  lignes: EcritureAInserer[], contexte: ContexteEcriture,
): ControleEcriture {
  const tresorerie = lignes.filter((l) => estJournalTresorerie(l.journal_code));
  if (!tresorerie.length) return { ok: true, raison: null, refusees: [] };

  if (contexte.origine === "releve") {
    const sansTx = tresorerie.filter((l) => !txt(l.transaction_id));
    if (sansTx.length) {
      return {
        ok: false, refusees: sansTx,
        raison: `${sansTx.length} écriture(s) de trésorerie sans transaction bancaire : `
          + "une écriture issue d'un relevé doit porter le `transaction_id` de sa ligne de relevé.",
      };
    }
    return { ok: true, raison: null, refusees: [] };
  }

  if (contexte.origine === "saisie_manuelle") {
    if (!txt(contexte.piece)) {
      return {
        ok: false, refusees: tresorerie,
        raison: "Saisie manuelle de trésorerie sans pièce : enregistrez d'abord le paiement "
          + "ou l'encaissement, son identifiant justifie l'écriture.",
      };
    }
    return { ok: true, raison: null, refusees: [] };
  }

  return {
    ok: false, refusees: tresorerie,
    raison: `${tresorerie.length} écriture(s) de trésorerie sans origine : le journal de banque `
      + "n'accepte qu'un relevé bancaire validé ou une saisie manuelle formelle.",
  };
}

/** Même contrôle, en version bloquante — à placer juste avant l'`insert`. */
export function assertEcrituresTresorerie(
  lignes: EcritureAInserer[], contexte: ContexteEcriture,
): void {
  const r = controlerEcrituresTresorerie(lignes, contexte);
  if (!r.ok) throw new Error(`Intégrité Banque ⇄ Compta : ${r.raison}`);
}
