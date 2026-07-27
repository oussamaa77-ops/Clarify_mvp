/**
 * releve-coherence — contrôle arithmétique d'une extraction de relevé bancaire.
 *
 * Sert de VERROU au « fast path » texte : quand le PDF possède une vraie couche
 * texte, le parser client extrait les transactions en quelques millisecondes, ce
 * qui évite un aller-retour OCR de plusieurs secondes. Mais on ne fait confiance
 * à cette extraction que si elle est ARITHMÉTIQUEMENT prouvée :
 *
 *     solde_initial + Σ crédits − Σ débits == solde_final
 *
 * Un relevé bancaire est un document bouclé : si l'égalité tombe au centime,
 * c'est qu'aucune ligne n'a été perdue, dupliquée, ni aucun montant mal lu — un
 * chiffre faux ou une transaction manquante casse forcément le total. En cas
 * d'échec (ou d'impossibilité de vérifier), l'appelant DOIT retomber sur le
 * chemin OCR habituel : on n'accélère jamais au prix d'un doute sur les montants.
 */

export type TxControlable = {
  date_operation?: string | null;
  montant_debit?: number | null;
  montant_credit?: number | null;
};

export type SoldesReleve = {
  solde_initial?: number | null;
  solde_final?: number | null;
};

export type ResultatCoherence = {
  /** true = extraction prouvée par l'équation de solde, exploitable telle quelle. */
  fiable: boolean;
  /** Écart constaté en devise (0 quand `fiable`). */
  ecart: number;
  /** Motif du refus, destiné aux logs (null quand `fiable`). */
  raison: string | null;
  /** Détail utile au diagnostic. */
  details: {
    nbTx: number;
    totalDebit: number;
    totalCredit: number;
    variationAttendue: number;
    variationConstatee: number;
  };
};

/** Tolérance par défaut : le centime (absorbe le bruit binaire des flottants). */
export const TOLERANCE_CENTIME = 0.01;

/** Arrondi comptable au centime — évite 0.1 + 0.2 = 0.30000000000000004. */
function auCentime(n: number): number {
  return Math.round(n * 100) / 100;
}

function nombreOuZero(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Vérifie qu'une extraction de relevé boucle sur ses soldes.
 *
 * Refuse (fiable = false) dans tous les cas où la preuve est impossible :
 * aucune transaction, solde final absent, montant des deux côtés à la fois…
 * L'absence de preuve est traitée comme un échec, jamais comme un succès.
 */
export function controlerCoherenceReleve(
  txs: readonly TxControlable[] | null | undefined,
  soldes: SoldesReleve | null | undefined,
  tolerance: number = TOLERANCE_CENTIME,
): ResultatCoherence {
  const lignes = Array.isArray(txs) ? txs : [];
  let totalDebit = 0;
  let totalCredit = 0;
  for (const t of lignes) {
    totalDebit += nombreOuZero(t?.montant_debit);
    totalCredit += nombreOuZero(t?.montant_credit);
  }
  totalDebit = auCentime(totalDebit);
  totalCredit = auCentime(totalCredit);

  const soldeInitial = nombreOuZero(soldes?.solde_initial);
  const soldeFinal = nombreOuZero(soldes?.solde_final);
  const variationAttendue = auCentime(soldeFinal - soldeInitial);
  const variationConstatee = auCentime(totalCredit - totalDebit);
  const ecart = Math.abs(auCentime(variationConstatee - variationAttendue));

  const details = { nbTx: lignes.length, totalDebit, totalCredit, variationAttendue, variationConstatee };
  const refus = (raison: string): ResultatCoherence => ({ fiable: false, ecart, raison, details });

  if (lignes.length === 0) return refus("aucune transaction extraite");

  // Sans solde final, l'équation n'a pas de membre droit : rien à prouver.
  // (solde_final = 0 est indiscernable d'un solde manquant → on refuse.)
  if (soldeFinal === 0) return refus("solde final absent — vérification impossible");

  // Une ligne doit porter un débit OU un crédit, jamais les deux, jamais aucun :
  // sinon le total peut boucler par compensation de deux erreurs.
  for (let i = 0; i < lignes.length; i++) {
    const d = nombreOuZero(lignes[i]?.montant_debit);
    const c = nombreOuZero(lignes[i]?.montant_credit);
    if (d !== 0 && c !== 0) return refus(`ligne ${i + 1} : débit ET crédit renseignés`);
    if (d === 0 && c === 0) return refus(`ligne ${i + 1} : montant nul ou illisible`);
    if (d < 0 || c < 0) return refus(`ligne ${i + 1} : montant négatif`);
    if (!lignes[i]?.date_operation) return refus(`ligne ${i + 1} : date d'opération absente`);
  }

  if (ecart > tolerance) {
    return refus(`équation de solde non bouclée (écart ${ecart.toFixed(2)})`);
  }

  return { fiable: true, ecart, raison: null, details };
}

/** Résumé sur une ligne pour les logs de scan. */
export function resumerCoherence(r: ResultatCoherence): string {
  const { nbTx, totalDebit, totalCredit } = r.details;
  const base = `${nbTx} tx | débits ${totalDebit.toFixed(2)} | crédits ${totalCredit.toFixed(2)}`;
  return r.fiable ? `✓ ${base} | soldes bouclés` : `✗ ${base} | ${r.raison}`;
}
