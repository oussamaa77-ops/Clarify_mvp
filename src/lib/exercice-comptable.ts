// ============================================================================
// exercice-comptable.ts — L'EXERCICE comme périmètre obligatoire de lecture.
//
// ─── Le problème ─────────────────────────────────────────────────────────────
// Le grand livre, le journal de trésorerie et les KPI du tableau de bord
// lisaient `ecritures_comptables` SANS AUCUN filtre de date. Sur les dossiers
// repris (SMERT WATER, SOMADIR), la base porte des écritures 2024 et 2025 à côté
// de celles de 2026 : le solde 3421, l'encours clients et le résultat affichés
// pour « l'exercice courant » cumulaient donc trois exercices.
//
// Un solde qui agrège plusieurs exercices n'est ni un solde d'ouverture ni un
// solde de clôture : c'est un chiffre qui ne correspond à aucune liasse.
//
// ─── La règle ────────────────────────────────────────────────────────────────
// Toute lecture comptable est BORNÉE. Les bornes sont calculées ici, une seule
// fois, et passées telles quelles au filtre SQL (`gte`/`lte`) comme au filtre
// mémoire — pour que l'écran et l'export ne puissent pas diverger.
//
// ─── L'exercice marocain ─────────────────────────────────────────────────────
// L'exercice est l'ANNÉE CIVILE (art. 20 CGI) : ouverture le 1er janvier,
// clôture le 31 décembre. Deux nuances comptent :
//
//   • le PREMIER exercice s'ouvre à la date de début d'activité, pas au 1er
//     janvier — une société créée le 12 mars 2026 n'a rien à comptabiliser en
//     février 2026, et une écriture antérieure y est une anomalie de reprise ;
//   • le report à nouveau n'est PAS une écriture de l'exercice : les écritures
//     des exercices antérieurs restent lisibles, mais dans LEUR exercice.
//
// Logique pure — aucun accès base, aucune dépendance React.
// ============================================================================

import { parseDateIso } from "@/lib/fiscalite-ma";

/** Bornes inclusives d'un exercice, au format ISO `YYYY-MM-DD`. */
export interface BornesExercice {
  /** Premier jour comptabilisable. */
  debut: string;
  /** Dernier jour comptabilisable. */
  fin: string;
  /** Millésime de l'exercice — celui de la clôture. */
  exercice: number;
  /** `true` si l'ouverture a été ramenée à la date de début d'activité. */
  premierExercice: boolean;
}

/** Normalise une date en `YYYY-MM-DD` ; rend `""` si elle est inutilisable. */
export function jourIso(v: string | null | undefined): string {
  const s = String(v ?? "").trim();
  if (!s) return "";
  const d = s.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : "";
}

/** Millésime de l'exercice courant, d'après l'horloge (ou une date imposée). */
export function exerciceCourant(aujourdhui: Date | string = new Date()): number {
  const iso = typeof aujourdhui === "string"
    ? jourIso(aujourdhui)
    : aujourdhui.toISOString().slice(0, 10);
  const annee = Number(iso.slice(0, 4));
  return Number.isFinite(annee) && annee > 1900 ? annee : new Date().getFullYear();
}

/**
 * Bornes de l'exercice `annee` pour un dossier donné.
 *
 * `dateDebutActivite` ne resserre l'ouverture que sur le PREMIER exercice. Sur
 * les suivants elle est sans effet : une société créée en mars 2024 a bien un
 * exercice 2026 complet.
 */
export function bornesExercice(
  annee: number, dateDebutActivite?: string | null,
): BornesExercice {
  const debutDefaut = `${annee}-01-01`;
  const fin = `${annee}-12-31`;
  const debutActivite = parseDateIso(dateDebutActivite ?? null);

  if (debutActivite && debutActivite.annee === annee) {
    const jour = jourIso(dateDebutActivite);
    // Une date d'activité mal saisie (hors de son propre millésime) ne doit pas
    // produire des bornes vides : on retombe alors sur l'année civile.
    if (jour && jour >= debutDefaut && jour <= fin) {
      return { debut: jour, fin, exercice: annee, premierExercice: true };
    }
  }
  return { debut: debutDefaut, fin, exercice: annee, premierExercice: false };
}

/** La date tombe-t-elle DANS l'exercice ? Une date absente n'y est jamais. */
export function dansExercice(date: string | null | undefined, bornes: BornesExercice): boolean {
  const d = jourIso(date);
  return d !== "" && d >= bornes.debut && d <= bornes.fin;
}

/**
 * Filtre une collection d'écritures sur l'exercice.
 *
 * Le champ de date est paramétrable : les écritures portent `date_ecriture`, les
 * transactions bancaires `date_operation`, les factures `date_facture`.
 */
export function filtrerExercice<T extends Record<string, any>>(
  lignes: T[], bornes: BornesExercice, champ: keyof T & string = "date_ecriture",
): T[] {
  return (lignes ?? []).filter((l) => dansExercice(l?.[champ], bornes));
}

/**
 * Millésimes présents dans un jeu de dates, du plus récent au plus ancien.
 *
 * Sert à peupler le sélecteur d'exercice : proposer 2019..2030 en dur ferait
 * chercher l'utilisateur dans des exercices vides, alors que la seule question
 * utile est « quels exercices ce dossier porte-t-il ? ».
 */
export function exercicesDisponibles(dates: (string | null | undefined)[]): number[] {
  const vus = new Set<number>();
  for (const d of dates ?? []) {
    const j = jourIso(d);
    if (!j) continue;
    const a = Number(j.slice(0, 4));
    if (Number.isFinite(a)) vus.add(a);
  }
  return [...vus].sort((a, b) => b - a);
}

/**
 * Exercice à ouvrir par défaut : l'exercice courant s'il porte des écritures,
 * sinon le plus récent qui en porte.
 *
 * Ouvrir systématiquement sur l'année en cours affiche un écran vide sur un
 * dossier dont la saisie s'arrête en 2024, et l'utilisateur en conclut que ses
 * données ont disparu.
 */
export function exerciceParDefaut(
  disponibles: number[], aujourdhui: Date | string = new Date(),
): number {
  const courant = exerciceCourant(aujourdhui);
  if (!disponibles.length || disponibles.includes(courant)) return courant;
  return disponibles[0];
}

/**
 * Écritures ANTÉRIEURES à l'exercice ouvert — celles qui polluaient la vue.
 *
 * Rendues à part plutôt que jetées : leur existence est une information (report
 * à nouveau à passer, reprise incomplète), et l'écran peut la signaler sans les
 * mêler aux mouvements de l'exercice.
 */
export function horsExercice<T extends Record<string, any>>(
  lignes: T[], bornes: BornesExercice, champ: keyof T & string = "date_ecriture",
): { anterieures: T[]; posterieures: T[] } {
  const anterieures: T[] = [];
  const posterieures: T[] = [];
  for (const l of lignes ?? []) {
    const d = jourIso(l?.[champ]);
    if (!d) continue;
    if (d < bornes.debut) anterieures.push(l);
    else if (d > bornes.fin) posterieures.push(l);
  }
  return { anterieures, posterieures };
}
