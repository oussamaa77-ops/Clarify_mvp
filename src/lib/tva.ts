// Conversions TVA pures — HT ⇄ TTC au niveau d'une LIGNE (prix unitaire).
// Aucune dépendance framework : réutilisable côté serveur (extraction OCR) comme
// côté client (UI d'édition des lignes). La source de vérité interne du modèle
// reste le PRIX UNITAIRE HT ; le TTC est toujours dérivé, jamais stocké.

/** Taux de TVA marocains reconnus (%). Hors de cette liste → on retombe sur 20. */
export const TVA_RATES_MA = [0, 7, 10, 14, 20] as const;

/** Arrondi comptable au centime. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Normalise un taux : null/NaN/négatif → 0 (utilisé tel quel, pas de 20 forcé
 *  ici — c'est l'appelant qui décide d'un défaut métier). */
function tauxOrZero(taux: number | null | undefined): number {
  const t = Number(taux);
  return isFinite(t) && t > 0 ? t : 0;
}

/** Prix unitaire HT → TTC : `pu_ttc = pu_ht × (1 + taux/100)`. */
export function puHtToTtc(prixHt: number, tauxTva: number | null | undefined): number {
  const ht = Number(prixHt) || 0;
  return round2(ht * (1 + tauxOrZero(tauxTva) / 100));
}

/** Prix unitaire TTC → HT : `pu_ht = pu_ttc / (1 + taux/100)`. */
export function puTtcToHt(prixTtc: number, tauxTva: number | null | undefined): number {
  const ttc = Number(prixTtc) || 0;
  return round2(ttc / (1 + tauxOrZero(tauxTva) / 100));
}

export interface LigneMontant {
  quantite: number;
  prix_unitaire: number;
  taux_tva: number | null;
}

/**
 * Décide si les prix unitaires des lignes sont HT ou TTC en RÉCONCILIANT leur
 * somme `Σ(quantité × prix_unitaire)` avec le bloc totaux de la facture.
 *
 * Cas visé : une facture affiche un prix unitaire SANS libellé « TTC », mais le
 * bloc totaux (HT, TVA, TTC) prouve, par le calcul, que ce prix était en fait
 * TTC. On convertit alors chaque PU en HT (source de vérité interne).
 *
 * Prudence : ne convertit QUE si HT et TTC sont tous deux connus et distincts, et
 * si la somme des lignes colle NETTEMENT mieux au TTC qu'au HT (dans la tolérance).
 * Dans le doute → on ne touche à rien (le PU reste HT, comportement par défaut).
 */
export function reconcilierLignesHtTtc<T extends LigneMontant>(
  lignes: T[],
  montantHt: number,
  montantTtc: number,
  toleranceRelative = 0.02,
): { lignes: T[]; converti: boolean } {
  const sommePU = lignes.reduce(
    (s, l) => s + (Number(l.quantite) || 0) * (Number(l.prix_unitaire) || 0),
    0,
  );
  const ht = Number(montantHt) || 0;
  const ttc = Number(montantTtc) || 0;
  // Sans lignes chiffrées, sans les DEUX totaux, ou si HT == TTC (pas de TVA) →
  // aucune réconciliation possible ni utile.
  if (sommePU <= 0 || ht <= 0 || ttc <= 0 || Math.abs(ttc - ht) < 0.01) {
    return { lignes, converti: false };
  }
  const ecartHt = Math.abs(sommePU - ht) / ht;
  const ecartTtc = Math.abs(sommePU - ttc) / ttc;
  if (ecartTtc <= toleranceRelative && ecartTtc < ecartHt) {
    return {
      lignes: lignes.map((l) => ({ ...l, prix_unitaire: puTtcToHt(l.prix_unitaire, l.taux_tva) })),
      converti: true,
    };
  }
  return { lignes, converti: false };
}
