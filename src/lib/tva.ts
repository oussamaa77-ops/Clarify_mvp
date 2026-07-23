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
