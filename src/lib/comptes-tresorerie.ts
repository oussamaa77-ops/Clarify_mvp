// ============================================================================
// comptes-tresorerie.ts — Comptes de trésorerie du PCM marocain (PUR, sans I/O).
//
// Rappel du CGNC, rubrique 51 « Trésorerie - Actif » :
//
//   514  Banques, Trésorerie Générale et Chèques postaux
//        5141 Banques (soldes débiteurs)   ← virement, chèque, carte, prélèvement
//        5143 Trésorerie Générale
//        5146 Chèques postaux
//   516  Caisses, Régies d'avances et accréditifs
//        5161 Caisses                       ← ESPÈCES
//        5165 Régies d'avances et accréditifs
//
// Le règlement en espèces s'impute donc en 516, JAMAIS en 514 : 5143 est le
// compte de la Trésorerie Générale, pas celui de la caisse. L'erreur ne se voit
// pas au journal (le montant y est juste), mais elle décale le poste « Caisse »
// du bilan et fausse tout contrôle de caisse.
//
// Un cabinet peut ouvrir un sous-compte par caisse (51610000, 51610001 pour une
// seconde caisse, une agence…). Le compte du dossier prime donc sur le défaut,
// à condition de rester dans la bonne rubrique — un sous-compte mal saisi
// enverrait les espèces hors du poste Caisse, ce qu'on refuse silencieusement.
// ============================================================================

import { PCM, RACINES_PCM } from "@/lib/pcm-referentiel";

/** Caisse par défaut : sous-compte à 8 chiffres de 5161, aligné sur les auxiliaires. */
export const COMPTE_CAISSE_DEFAUT = PCM.CAISSE_DEFAUT;
/** Banque par défaut — inchangé, c'est déjà le compte employé partout. */
export const COMPTE_BANQUE_DEFAUT = PCM.BANQUE;

/** Rubriques PCM autorisées pour chacun des deux comptes. */
export const PREFIXE_CAISSE = RACINES_PCM.CAISSE;
export const PREFIXE_BANQUE = RACINES_PCM.BANQUE;

/** Paramètres de trésorerie portés par le dossier (colonnes optionnelles). */
export interface ComptesTresorerieDossier {
  compte_caisse?: string | null;
  compte_banque?: string | null;
}

/** Un compte n'est retenu que s'il est numérique ET dans la bonne rubrique. */
function retenir(compte: string | null | undefined, prefixe: string, defaut: string): string {
  const c = String(compte ?? "").trim();
  if (!c) return defaut;
  if (!/^\d{3,10}$/.test(c)) return defaut;
  return c.startsWith(prefixe) ? c : defaut;
}

/** Compte de caisse du dossier, ou 51610000. */
export const compteCaisse = (d?: ComptesTresorerieDossier | null): string =>
  retenir(d?.compte_caisse, PREFIXE_CAISSE, COMPTE_CAISSE_DEFAUT);

/** Compte de banque du dossier, ou 5141. */
export const compteBanque = (d?: ComptesTresorerieDossier | null): string =>
  retenir(d?.compte_banque, PREFIXE_BANQUE, COMPTE_BANQUE_DEFAUT);

/** Modes de règlement qui passent par la caisse. Tout le reste passe en banque. */
export const MODES_ESPECES = ["especes", "espèces", "cash", "caisse"];

/**
 * Journal qui correspond à un COMPTE de trésorerie : CAI pour la caisse (516),
 * BQ pour tout le reste.
 *
 * C'est la réciproque d'`imputationTresorerie`, qui part du mode de règlement.
 * Ici on part du compte — le cas de la reprise, où l'on hérite d'une écriture
 * dont on connaît le compte mais plus le mode.
 *
 * Une seule définition, parce que la règle était écrite en clair à deux endroits
 * (l'OD de paiement DGI et la repasse du script). Deux copies d'une règle
 * d'aiguillage finissent par diverger, et l'écart ne se voit qu'au rapprochement
 * bancaire, des semaines plus tard.
 */
export function journalDeTresorerie(compte: string | null | undefined): "BQ" | "CAI" {
  return String(compte ?? "").trim().startsWith(PREFIXE_CAISSE) ? "CAI" : "BQ";
}

export interface ImputationTresorerie {
  /** Compte à mouvementer : caisse pour les espèces, banque sinon. */
  compte: string;
  /** Journal correspondant — CAI pour la caisse, BQ pour la banque. */
  journal: "CAI" | "BQ";
  especes: boolean;
}

/**
 * Couple (compte, journal) d'un règlement, d'après son mode.
 *
 * Le compte et le journal sont rendus ENSEMBLE, et jamais choisis séparément :
 * c'est la seule façon d'empêcher qu'un règlement dise « espèces » au journal de
 * caisse tout en débitant un compte de banque.
 */
export function imputationTresorerie(
  mode: string | null | undefined,
  dossier?: ComptesTresorerieDossier | null,
): ImputationTresorerie {
  const m = String(mode ?? "").trim().toLowerCase();
  const especes = MODES_ESPECES.includes(m);
  return especes
    ? { compte: compteCaisse(dossier), journal: "CAI", especes: true }
    : { compte: compteBanque(dossier), journal: "BQ", especes: false };
}
