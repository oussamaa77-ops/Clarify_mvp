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

// ─── Cohérence HT / TVA / TTC d'une facture ─────────────────────────────────
//
// ─── Pourquoi identifier la cause AVANT de corriger ──────────────────────────
// Un écart de quelques centimes entre `montant_ht + montant_tva` et
// `montant_ttc` a toujours l'air d'un arrondi. Il ne l'est pas toujours, et le
// « corriger » sans savoir revient à effacer l'anomalie plutôt que le défaut :
//
//   • ARRONDI DE LIGNE — la TVA se calcule ligne par ligne puis s'additionne ;
//     chaque arrondi au centime peut décaler le total. C'est légitime, la
//     facture est juste, il n'y a rien à corriger.
//   • TAUX INCOHÉRENT — la TVA ne correspond à AUCUN taux marocain appliqué au
//     HT. Là, c'est le montant qui est faux, et le rectifier au centime près
//     masquerait une erreur qui se chiffre en dirhams.
//   • TOTAL INCOHÉRENT — HT + TVA ≠ TTC de plus qu'un arrondi de lignes ne peut
//     l'expliquer : un des trois montants a été saisi ou extrait de travers.
//
// Le contrôle NE CORRIGE RIEN. Il nomme, chiffre, et rend la décision.
//
// ─── Le cas qui l'a motivé ───────────────────────────────────────────────────
// PRO-FLUIDES MAROC (FA-2026-00964) : HT 2 190,85 · TVA 438,17 · TTC 2 629,02.
// Tout est exact — 1 × 1 450,00 + 5 × 148,17 = 2 190,85, et 20 % font 438,17.
// Mais le chèque n° 0398450 du 30/03/2026 porte 2 629,00 : DEUX CENTIMES de
// moins. L'écart n'est pas dans la facture, il est entre la facture et le
// règlement — le fournisseur a arrondi son chèque. Rectifier le TTC de la
// facture pour « faire tomber juste » aurait détruit une facture correcte afin
// d'accommoder un paiement qui, lui, est incomplet de 0,02 MAD.

/** Ce qui explique un écart entre HT + TVA et TTC. */
export type CauseEcartTva =
  /** Somme des arrondis de TVA ligne à ligne — la facture est juste. */
  | "arrondi_lignes"
  /** La TVA ne correspond à aucun taux marocain appliqué au HT. */
  | "taux_incoherent"
  /** HT + TVA ≠ TTC, au-delà de ce qu'un arrondi de lignes explique. */
  | "total_incoherent"
  /** Aucun écart. */
  | "aucune";

export interface CoherenceMontants {
  ht: number;
  tva: number;
  ttc: number;
  /** (HT + TVA) − TTC, signé. */
  ecart: number;
  /** Taux effectif constaté : TVA / HT × 100. `null` si le HT est nul. */
  tauxEffectif: number | null;
  /** Taux marocain le plus proche du taux effectif, `null` si aucun ne colle. */
  tauxReconnu: number | null;
  cause: CauseEcartTva;
  /** `true` quand rien ne cloche, ou que le seul écart est un arrondi de lignes. */
  ok: boolean;
  /** Le diagnostic en clair — jamais une instruction de correction. */
  message: string | null;
}

/**
 * Contrôle la cohérence interne des montants d'une facture.
 *
 * `nbLignes` borne l'arrondi ADMISSIBLE : chaque ligne peut décaler la TVA d'un
 * demi-centime, donc le total d'au plus `nbLignes × 0,01` MAD. Sans cette borne,
 * on ne saurait pas distinguer un arrondi légitime d'une saisie fausse : tout
 * écart passerait pour un arrondi, ce qui est exactement l'erreur à éviter.
 * À défaut d'information sur les lignes, on admet un centime.
 */
export function controlerCoherenceMontants(
  montants: { ht: number | null | undefined; tva: number | null | undefined; ttc: number | null | undefined },
  nbLignes = 1,
): CoherenceMontants {
  const ht = round2(Number(montants.ht) || 0);
  const tva = round2(Number(montants.tva) || 0);
  const ttc = round2(Number(montants.ttc) || 0);
  const ecart = round2(ht + tva - ttc);
  const toleranceLignes = round2(Math.max(1, nbLignes) * 0.01);

  const tauxEffectif = ht > 0.005 ? round2((tva / ht) * 100) : null;
  // Un taux est « reconnu » si le HT × taux redonne la TVA à l'arrondi de lignes
  // près. On compare des MONTANTS, pas des pourcentages : un taux effectif de
  // 19,997 % sur 2 190,85 MAD est un 20 % parfaitement arrondi, alors qu'il
  // s'écarte de 0,003 point.
  const tauxReconnu = TVA_RATES_MA.find(
    (t) => Math.abs(round2(ht * t / 100) - tva) <= toleranceLignes,
  ) ?? null;

  if (Math.abs(ecart) <= 0.005 && (tauxReconnu !== null || ht <= 0.005)) {
    return { ht, tva, ttc, ecart: 0, tauxEffectif, tauxReconnu, cause: "aucune", ok: true, message: null };
  }

  if (tauxReconnu === null && ht > 0.005) {
    return {
      ht, tva, ttc, ecart, tauxEffectif, tauxReconnu, cause: "taux_incoherent", ok: false,
      message: `TVA de ${tva.toFixed(2)} MAD sur ${ht.toFixed(2)} HT, soit `
        + `${tauxEffectif?.toFixed(3)} % : aucun taux marocain (${TVA_RATES_MA.join(", ")} %) `
        + "ne l'explique. C'est un montant faux, pas un arrondi — ne pas l'ajuster au centime.",
    };
  }

  if (Math.abs(ecart) <= toleranceLignes) {
    return {
      ht, tva, ttc, ecart, tauxEffectif, tauxReconnu, cause: "arrondi_lignes", ok: true,
      message: `Écart de ${ecart.toFixed(2)} MAD entre HT + TVA et TTC, explicable par `
        + `l'arrondi au centime de ${Math.max(1, nbLignes)} ligne(s) au taux de ${tauxReconnu} %. `
        + "La facture est juste : aucune correction à faire.",
    };
  }

  return {
    ht, tva, ttc, ecart, tauxEffectif, tauxReconnu, cause: "total_incoherent", ok: false,
    message: `HT ${ht.toFixed(2)} + TVA ${tva.toFixed(2)} = ${round2(ht + tva).toFixed(2)}, `
      + `mais le TTC porte ${ttc.toFixed(2)} : ${Math.abs(ecart).toFixed(2)} MAD d'écart, `
      + `au-delà des ${toleranceLignes.toFixed(2)} MAD qu'un arrondi de lignes peut expliquer. `
      + "Un des trois montants est faux — identifier lequel avant de corriger.",
  };
}
