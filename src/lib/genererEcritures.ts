// ============================================================================
// genererEcritures.ts — LE générateur d'écritures, sous le régime des
// ENCAISSEMENTS. Pur : aucune base, aucun réseau.
//
// ─── Ce que le régime des encaissements impose ───────────────────────────────
// La TVA n'est ni due ni déductible au jour de la FACTURE : elle l'est au jour
// de l'ARGENT. Trois conséquences, et ce fichier existe pour qu'aucune ne soit
// laissée à la vigilance de l'appelant :
//
//   1. À l'ÉMISSION d'une vente, la TVA se pose sur 4458 « TVA facturée en
//      attente ». 44551 n'est PAS mouvementé — il ne l'est qu'au règlement.
//   2. À la RÉCEPTION d'un achat, la TVA se pose sur 3458 « TVA sur achats en
//      attente ». 34552 n'est PAS mouvementé — il ne l'est qu'au décaissement.
//   3. Au RÈGLEMENT (journal BQ ou CAI), et seulement là, une OD bascule au
//      prorata payé :  vente D 4458 / C 44551   —   achat D 34552 / C 3458
//
// Poser 44551 dès la facture n'est pas une nuance d'écriture : la déclaration
// lit ce compte. Une TVA facturée en décembre et encaissée en février serait
// déclarée — et payée — deux mois avant d'être perçue.
//
// ─── Quatre verrous, rendus OPPOSABLES ───────────────────────────────────────
// Les règles ci-dessus ne tiennent que si rien ne les contourne en aval. D'où
// quatre contrôles que l'on passe AVANT tout insert (`assertEcrituresRegime`) :
//
//   • TVA D'ORIGINE — aucun compte de TVA exigible (4455x / 3455x) dans les
//     journaux VTE et ACH. C'est la règle 1 et 2, énoncée côté contrôle.
//   • TRÉSORERIE — aucun 5141 (banque) ni 5161 (caisse) dans le journal OD. Un
//     mouvement d'argent appartient à BQ ou CAI, qui se rapprochent du relevé.
//     Logé en OD, il échappe au rapprochement bancaire : la trésorerie du grand
//     livre diverge de celle de la banque sans qu'aucun écran ne le dise. C'est
//     ce chemin qui produisait la « trésorerie fictive ».
//   • CUT-OFF — la date de la pièce appartient à l'exercice ouvert. Une facture
//     2024 comptabilisée en 2026 fausse deux liasses à la fois : elle gonfle un
//     résultat déjà déposé et en ampute un autre.
//   • UNICITÉ — une même référence ne peut pas vivre à la fois en VTE et en
//     ACH. Elle y désignerait deux pièces distinctes, et tout ce qui raisonne
//     par `reference_piece` — lettrage, bascule de TVA, annulation — mélangerait
//     la vente et l'achat.
//
// Chaque contrôle rend ses griefs en clair ; `assertEcrituresRegime` les
// transforme en refus. Une écriture non conforme n'atteint pas la base, où elle
// coûterait un script de reprise à défaire.
// ============================================================================

import {
  COMPTES_TVA, construireBasculeTva, tvaProportionnelle,
  type LigneOD, type SensTiers,
} from "@/services/lettrage";
import { compteTiersAuxiliaire } from "@/lib/comptes-auxiliaires";
import {
  bornesExercice, dansExercice, exerciceCourant, jourIso, type BornesExercice,
} from "@/lib/exercice-comptable";
import {
  assertLignesVente, controlerLignesVente, lignesEcrituresVente, normaliserTypeVente,
  COMPTE_ACOMPTES_CLIENTS,
  type ContexteEcrituresVente, type LigneVente, type TypeFactureVente,
} from "@/lib/ecritures-vente";

const r2 = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;
const txt = (v: unknown) => String(v ?? "").trim();

// ─── Le vocabulaire du régime, en un seul endroit ────────────────────────────

/** TVA d'ORIGINE : le seul compte qu'une facture a le droit de toucher. */
export const COMPTE_TVA_ATTENTE = {
  vente: COMPTES_TVA.client.attente,        // 4458
  achat: COMPTES_TVA.fournisseur.attente,   // 3458
} as const;

/** TVA EXIGIBLE : réservée à l'OD de bascule, au règlement. */
export const COMPTE_TVA_EXIGIBLE = {
  vente: COMPTES_TVA.client.exigible,        // 44551
  achat: COMPTES_TVA.fournisseur.exigible,   // 34552
} as const;

/**
 * Racines de TVA exigible, pour la DÉTECTION. On impute sur le sous-compte
 * (44551) et on reconnaît sur la racine (4455), qui couvre aussi les écritures
 * historiques restées sur elle — sans quoi le contrôle les laisserait passer.
 */
export const RACINES_TVA_EXIGIBLE = ["4455", "3455"] as const;

/**
 * Comptes de trésorerie interdits au journal OD.
 *
 * Détection par PRÉFIXE, et c'est indispensable : le plan réel emploie des
 * sous-comptes (51610000 pour la caisse par défaut, 51410001 pour une seconde
 * banque). Une égalité stricte sur « 5161 » ne verrait aucune des écritures
 * réellement produites.
 */
export const COMPTES_TRESORERIE_HORS_OD = ["5141", "5161"] as const;

/** Journaux qui constatent un fait générateur de facture — jamais un paiement. */
export const JOURNAUX_FACTURATION = ["VTE", "ACH", "VTE-AVR", "ACH-AVR"] as const;

/** Journaux de RÈGLEMENT : les seuls qui déclenchent une bascule de TVA. */
export const JOURNAUX_REGLEMENT = ["BQ", "CAI"] as const;

const commencePar = (compte: unknown, racines: readonly string[]): boolean => {
  const c = txt(compte);
  return c !== "" && racines.some((r) => c === r || c.startsWith(r));
};

/** Ce compte est-il de la TVA EXIGIBLE (44551, 34552, ou leurs racines) ? */
export const estTvaExigible = (compte: string | null | undefined): boolean =>
  commencePar(compte, RACINES_TVA_EXIGIBLE);

/** Ce compte est-il de la trésorerie interdite en OD (5141x / 5161x) ? */
export const estTresorerieHorsOd = (compte: string | null | undefined): boolean =>
  commencePar(compte, COMPTES_TRESORERIE_HORS_OD);

// ─── La forme minimale d'une écriture, vue par les contrôles ─────────────────

/**
 * Le sous-ensemble de colonnes que les contrôles lisent — et rien de plus.
 *
 * PAS d'index signature (`[k: string]: unknown`) : elle rendrait `LigneVente`,
 * `LigneAchat` et `LigneDeclaration` — qui n'en ont pas — inassignables ici, et
 * forcerait un `as any` à chaque appel. Tout champ supplémentaire passe
 * naturellement, les contrôles d'excédent ne s'appliquant qu'aux littéraux.
 */
export interface LigneEcriture {
  journal_code?: string | null;
  compte_numero?: string | null;
  date_ecriture?: string | null;
  libelle?: string | null;
  debit?: number | string | null;
  credit?: number | string | null;
  reference_piece?: string | null;
}

const journal = (l: LigneEcriture) => txt(l.journal_code).toUpperCase();
const mouvementee = (l: LigneEcriture) =>
  Math.abs(r2(l.debit)) > 0.005 || Math.abs(r2(l.credit)) > 0.005;

export interface ControleRegime {
  ok: boolean;
  /** Ce qui empêche l'insertion, en clair. Vide quand tout est conforme. */
  violations: string[];
}

const conforme: ControleRegime = { ok: true, violations: [] };

// ─── VERROU 1 — pas de TVA exigible dans les journaux de facturation ─────────

/**
 * C'est la règle du régime des encaissements, énoncée du côté du contrôle : une
 * facture n'a que le compte d'ATTENTE à sa disposition (4458 / 3458).
 *
 * Une ligne à 0,00 ne déclenche rien : elle ne déplace aucune TVA, et refuser
 * une contrepartie technique nulle bloquerait des pièces par ailleurs saines.
 */
export function controlerTvaOrigine(lignes: LigneEcriture[]): ControleRegime {
  const fautives = lignes.filter(
    (l) => (JOURNAUX_FACTURATION as readonly string[]).includes(journal(l))
      && estTvaExigible(l.compte_numero) && mouvementee(l),
  );
  if (!fautives.length) return conforme;

  const detail = [...new Set(fautives.map((l) => `${journal(l)} ${txt(l.compte_numero)}`))].join(", ");
  return {
    ok: false,
    violations: [
      `TVA exigible imputée à la facturation (${detail}). Sous le régime des `
      + `encaissements la TVA d'origine se pose sur ${COMPTE_TVA_ATTENTE.vente} (vente) ou `
      + `${COMPTE_TVA_ATTENTE.achat} (achat) ; ${COMPTE_TVA_EXIGIBLE.vente} / `
      + `${COMPTE_TVA_EXIGIBLE.achat} n'est atteint que par l'OD de bascule, au règlement.`,
    ],
  };
}

// ─── VERROU 2 — pas de trésorerie dans le journal OD ─────────────────────────

export function controlerJournalOd(lignes: LigneEcriture[]): ControleRegime {
  const fautives = lignes.filter(
    (l) => journal(l) === "OD" && estTresorerieHorsOd(l.compte_numero) && mouvementee(l),
  );
  if (!fautives.length) return conforme;

  const comptes = [...new Set(fautives.map((l) => txt(l.compte_numero)))].join(", ");
  return {
    ok: false,
    violations: [
      `Trésorerie interdite au journal OD : ${comptes}. Un mouvement d'argent se passe en `
      + `${JOURNAUX_REGLEMENT.join(" (banque) ou ")} (caisse), seuls journaux que le `
      + "rapprochement bancaire lit.",
    ],
  };
}

// ─── VERROU 3 — cut-off d'exercice ───────────────────────────────────────────

export interface OptionsCutoff {
  /** Bornes de l'exercice ouvert. Absentes → aucun contrôle de date. */
  bornes?: BornesExercice | null;
}

/**
 * Toutes les lignes tombent-elles DANS l'exercice ouvert ?
 *
 * Le grief nomme la date ET les bornes : « pièce hors exercice » seul laisserait
 * l'utilisateur deviner s'il s'est trompé de pièce ou d'exercice ouvert — deux
 * gestes correctifs opposés.
 *
 * Une ligne SANS date est refusée elle aussi, et volontairement : elle n'entre
 * dans aucun exercice, donc dans aucune liasse, et se retrouverait invisible de
 * tout écran borné (cf. `filtrerExercice`).
 */
export function controlerCutoffExercice(
  lignes: LigneEcriture[], bornes: BornesExercice | null | undefined,
): ControleRegime {
  if (!bornes) return conforme;

  const horsBornes = lignes.filter((l) => !dansExercice(l.date_ecriture, bornes));
  if (!horsBornes.length) return conforme;

  const dates = [...new Set(horsBornes.map((l) => jourIso(l.date_ecriture) || "(sans date)"))].join(", ");
  return {
    ok: false,
    violations: [
      `Pièce hors de l'exercice ${bornes.exercice} : ${dates}. L'exercice ouvert court du `
      + `${bornes.debut} au ${bornes.fin} — comptabiliser hors de ces bornes fausse deux `
      + "liasses à la fois. Rouvrez l'exercice concerné, ou passez un report à nouveau.",
    ],
  };
}

/** Raccourci : cut-off sur le millésime `annee`, date de début d'activité comprise. */
export const controlerCutoffAnnee = (
  lignes: LigneEcriture[], annee: number, dateDebutActivite?: string | null,
): ControleRegime => controlerCutoffExercice(lignes, bornesExercice(annee, dateDebutActivite));

/**
 * Bornes de l'exercice ACTIF d'un dossier — celui dans lequel on a le droit de
 * comptabiliser aujourd'hui.
 *
 * Il n'existe pas de colonne « exercice ouvert » sur `dossiers` : l'exercice
 * actif est donc celui de l'HORLOGE (l'exercice marocain est l'année civile,
 * art. 20 CGI), resserré au premier exercice par la date de début d'activité.
 *
 * `aujourdhui` est un paramètre et non `new Date()` en dur, pour deux raisons :
 * les tests doivent pouvoir fixer la date, et le script de reconstruction doit
 * pouvoir rejouer un dossier dans SON exercice sans que l'horloge le refuse.
 *
 * ─── Ce que ce choix implique ────────────────────────────────────────────────
 * Une facture datée de décembre N saisie en janvier N+1 est REFUSÉE : l'exercice
 * actif est alors N+1. C'est le comportement demandé — le cut-off interdit toute
 * pièce hors des bornes de l'exercice actif — mais c'est aussi le cas limite à
 * connaître, car cette saisie-là est régulière tant que l'exercice N n'est pas
 * clos. Le geste correctif est d'ouvrir l'exercice N (paramètre `annee`), pas de
 * forcer la date de la pièce.
 */
export function bornesExerciceActif(
  dossier?: { date_debut_activite?: string | null } | null,
  aujourdhui: Date | string = new Date(),
  annee?: number | null,
): BornesExercice {
  return bornesExercice(annee ?? exerciceCourant(aujourdhui), dossier?.date_debut_activite ?? null);
}

// ─── VERROU 4 — unicité de la référence entre VTE et ACH ─────────────────────

export interface CollisionReference {
  reference: string;
  journaux: string[];
}

/**
 * Une même référence vit-elle à la fois en VTE et en ACH ?
 *
 * Le contrôle porte sur les DEUX journaux de facturation opposés, et sur eux
 * seuls : une référence partagée entre VTE et son OD d'imputation d'acompte est
 * normale (c'est la même pièce), une référence partagée entre une vente et un
 * achat ne l'est jamais.
 *
 * `existantes` est le grand livre déjà en base. Sans lui le contrôle ne verrait
 * que la collision INTERNE à la pièce en cours — c'est-à-dire presque jamais le
 * cas réel, qui est une pièce nouvelle heurtant une pièce ancienne.
 */
export function controlerUniciteReference(
  lignes: LigneEcriture[], existantes: LigneEcriture[] = [],
): ControleRegime & { collisions: CollisionReference[] } {
  const parReference = new Map<string, Set<string>>();
  for (const l of [...existantes, ...lignes]) {
    const j = journal(l);
    if (j !== "VTE" && j !== "ACH") continue;
    const ref = txt(l.reference_piece);
    if (!ref) continue;
    const vus = parReference.get(ref) ?? new Set<string>();
    vus.add(j);
    parReference.set(ref, vus);
  }

  const collisions = [...parReference.entries()]
    .filter(([, journaux]) => journaux.size > 1)
    .map(([reference, journaux]) => ({ reference, journaux: [...journaux].sort() }));
  if (!collisions.length) return { ...conforme, collisions: [] };

  const detail = collisions.map((c) => `${c.reference} (${c.journaux.join(" + ")})`).join(", ");
  return {
    ok: false,
    collisions,
    violations: [
      `Référence de pièce présente en VTE ET en ACH : ${detail}. Une référence désigne UNE `
      + "pièce ; partagée entre une vente et un achat, elle fait converger le lettrage, la "
      + "bascule de TVA et l'annulation sur les deux à la fois.",
    ],
  };
}

// ─── Le verdict d'ensemble ───────────────────────────────────────────────────

export interface OptionsControleRegime extends OptionsCutoff {
  /**
   * Écritures DÉJÀ en base pour ce dossier, pour le contrôle d'unicité. Seules
   * `journal_code` et `reference_piece` sont lues : un select réduit suffit.
   */
  existantes?: LigneEcriture[];
  /**
   * Unicité VTE/ACH en ALERTE plutôt qu'en refus. Le script de reconstruction
   * s'en sert : il doit pouvoir rapporter toutes les collisions d'un dossier
   * repris, pas s'arrêter à la première.
   */
  uniciteNonBloquante?: boolean;
}

export interface VerdictRegime extends ControleRegime {
  /** Griefs qui n'empêchent pas l'insertion mais doivent être remontés. */
  alertes: string[];
  collisions: CollisionReference[];
}

/** Les quatre verrous, plus la partie double, en un seul verdict. */
export function controlerEcrituresRegime(
  lignes: LigneEcriture[], opts: OptionsControleRegime = {},
): VerdictRegime {
  const unicite = controlerUniciteReference(lignes, opts.existantes ?? []);
  const violations = [
    ...controlerTvaOrigine(lignes).violations,
    ...controlerJournalOd(lignes).violations,
    ...controlerCutoffExercice(lignes, opts.bornes).violations,
    ...(opts.uniciteNonBloquante ? [] : unicite.violations),
  ];
  const alertes = opts.uniciteNonBloquante ? [...unicite.violations] : [];

  const ecart = r2(lignes.reduce((s, l) => s + r2(l.debit) - r2(l.credit), 0));
  if (lignes.length && Math.abs(ecart) > 0.005) {
    violations.push(`Partie double déséquilibrée de ${ecart.toFixed(2)} MAD.`);
  }
  return { ok: violations.length === 0, violations, alertes, collisions: unicite.collisions };
}

/**
 * Même contrôle, BLOQUANT. C'est la porte qu'emprunte toute persistance
 * d'écriture : conforme, ou rien.
 */
export function assertEcrituresRegime(
  lignes: LigneEcriture[], opts: OptionsControleRegime = {},
): void {
  const c = controlerEcrituresRegime(lignes, opts);
  if (!c.ok) {
    throw new Error(`Écriture non conforme au régime des encaissements — ${c.violations.join(" ")}`);
  }
}

// ─── 1. VENTES — D 3421 TTC / C 7xxx HT / C 4458 TVA ─────────────────────────
//
// Le corps du générateur vit dans `ecritures-vente.ts`, qui porte en plus
// l'invariant du 4191 (acomptes). On le réexporte ici pour que tout le
// vocabulaire du régime soit atteignable d'un seul import.

export {
  lignesEcrituresVente as genererEcrituresVente,
  controlerLignesVente, assertLignesVente, normaliserTypeVente, COMPTE_ACOMPTES_CLIENTS,
};
export type { ContexteEcrituresVente, LigneVente, TypeFactureVente };

// ─── 2. ACHATS — D 6xxx HT / D 3458 TVA / C 4411 TTC ─────────────────────────

export interface ContexteEcrituresAchat {
  dossier_id: string;
  /** FK vers `factures_fournisseurs`. Sert aussi de `reference_piece` par défaut. */
  facture_id: string;
  /** Référence portée par les écritures. Côté achat, c'est l'ID de la facture. */
  reference?: string | null;
  date_facture: string;
  montant_ht: number;
  montant_tva: number;
  montant_ttc: number;
  /** Compte de charge issu du moteur de catégorisation. Repli 6141. */
  compte_charge?: string | null;
  /** Nom du fournisseur, pour le libellé. */
  fournisseur_nom?: string | null;
  /** Code auxiliaire (F0005) → 44110005. Absent → collectif 4411. */
  code_auxiliaire?: string | null;
  /** Compte de tiers imposé, s'il est déjà connu (prime sur `code_auxiliaire`). */
  compte_tiers?: string | null;
}

export interface LigneAchat {
  dossier_id: string;
  journal_code: "ACH";
  compte_numero: string;
  date_ecriture: string;
  libelle: string;
  debit: number;
  credit: number;
  reference_piece: string;
  valide: true;
}

/** Compte de charge par défaut, aligné sur le moteur de catégorisation. */
export const COMPTE_CHARGE_DEFAUT_ACHAT = "6141";

/**
 * Les écritures du journal des ACHATS pour une facture fournisseur.
 *
 *   D 6xxx   HT    charge
 *   D 3458   TVA   TVA en attente — le droit à déduction ne naît qu'au paiement
 *   C 4411x  TTC   dette envers le fournisseur (auxiliaire quand il est codé)
 *
 * La ligne de TVA est OMISE quand la TVA est nulle : un achat exonéré, hors
 * champ ou non récupérable ne doit pas produire une ligne 3458 à 0,00 que la
 * bascule irait ensuite chercher. La pièce reste équilibrée — l'appelant a
 * alors HT = TTC.
 */
export function genererEcrituresAchat(ctx: ContexteEcrituresAchat): LigneAchat[] {
  const ht = r2(ctx.montant_ht);
  const tva = r2(ctx.montant_tva);
  const ttc = r2(ctx.montant_ttc);
  const ref = txt(ctx.reference) || txt(ctx.facture_id);
  const nom = txt(ctx.fournisseur_nom) || "Fournisseur";
  const suffixe = `${nom} ${ref}`.trim();

  const base = {
    dossier_id: ctx.dossier_id,
    journal_code: "ACH" as const,
    date_ecriture: ctx.date_facture,
    reference_piece: ref,
    valide: true as const,
  };

  const lignes: LigneAchat[] = [
    {
      ...base, compte_numero: txt(ctx.compte_charge) || COMPTE_CHARGE_DEFAUT_ACHAT,
      libelle: `Achat ${suffixe}`.slice(0, 200), debit: ht, credit: 0,
    },
  ];

  if (tva > 0.005) {
    lignes.push({
      ...base, compte_numero: COMPTE_TVA_ATTENTE.achat,
      libelle: `TVA en attente ${suffixe}`.slice(0, 200), debit: tva, credit: 0,
    });
  }

  lignes.push({
    ...base,
    compte_numero: txt(ctx.compte_tiers) || compteTiersAuxiliaire("fournisseur", ctx.code_auxiliaire ?? null),
    libelle: `Dette ${suffixe}`.slice(0, 200), debit: 0, credit: ttc,
  });

  return lignes;
}

export interface ControleLignesAchat extends ControleRegime {
  /** Écart de la partie double, en MAD (0 quand l'écriture est équilibrée). */
  ecart: number;
}

/**
 * Contrôle des écritures d'achat AVANT insertion.
 *
 * Trois griefs, dans l'ordre de gravité :
 *   1. de la TVA sur 34552 — le droit à déduction né avant le décaissement ;
 *   2. aucune charge de classe 6 débitée — l'achat serait invisible du compte
 *      de résultat, exactement comme une vente sans crédit de classe 7 ;
 *   3. une partie double déséquilibrée.
 */
export function controlerLignesAchat(lignes: LigneEcriture[]): ControleLignesAchat {
  const violations = [...controlerTvaOrigine(lignes).violations];

  const debitCharge = lignes.reduce(
    (s, l) => txt(l.compte_numero).startsWith("6") ? s + r2(l.debit) - r2(l.credit) : s, 0);
  if (r2(debitCharge) <= 0.005) {
    violations.push("Aucune charge de classe 6 débitée : cet achat n'apparaîtrait pas au compte de résultat.");
  }

  const ecart = r2(lignes.reduce((s, l) => s + r2(l.debit) - r2(l.credit), 0));
  if (Math.abs(ecart) > 0.005) {
    violations.push(`Partie double déséquilibrée de ${ecart.toFixed(2)} MAD.`);
  }
  return { ok: violations.length === 0, violations, ecart };
}

/** Contrôle d'achat BLOQUANT — le pendant exact d'`assertLignesVente`. */
export function assertLignesAchat(lignes: LigneEcriture[]): void {
  const c = controlerLignesAchat(lignes);
  if (!c.ok) throw new Error(`Écriture d'achat non conforme — ${c.violations.join(" ")}`);
}

// ─── 3. OD de BASCULE — le seul chemin vers la TVA exigible ──────────────────

export interface ContexteBasculeTva {
  sens: SensTiers;
  /** TVA d'ORIGINE de la pièce — base du prorata, jamais le reste à basculer. */
  montantTva: number;
  /** TTC de la pièce — dénominateur du prorata. */
  montantTtc: number;
  /** Ce qui vient d'être encaissé ou décaissé. */
  montantRegle: number;
  /** Date de l'ARGENT, pas de la saisie : c'est elle qui date l'exigibilité. */
  date: string;
  /**
   * Journal du RÈGLEMENT qui déclenche la bascule. Contrôlé quand il est fourni :
   * seuls BQ et CAI constatent un mouvement d'argent, et le régime des
   * encaissements ne connaît pas d'autre fait générateur.
   */
  journalReglement?: string | null;
  reference?: string | null;
  libelle?: string | null;
  /** Code du lettrage déclencheur. Vide sur un règlement partiel, non lettrable. */
  lettrageCode?: string | null;
  factureId?: string | null;
  paiementId?: string | null;
  /** Plafond : ce qu'il reste réellement en attente. Rend l'échelonnement idempotent. */
  plafond?: number | null;
}

/** Ce journal constate-t-il un mouvement d'argent ? */
export const estJournalReglement = (code: string | null | undefined): boolean =>
  (JOURNAUX_REGLEMENT as readonly string[]).includes(txt(code).toUpperCase());

/**
 * L'OD qui rend la TVA exigible, au PRORATA du règlement.
 *
 *   VENTE   D 4458  / C 44551   la TVA devient due
 *   ACHAT   D 34552 / C 3458    le droit à déduction naît
 *
 * Rend un tableau VIDE quand il n'y a rien à basculer — pièce exonérée, règlement
 * nul, ou TVA déjà entièrement basculée. Une OD à zéro ne prouve rien et pollue
 * le journal.
 *
 * `plafond` est ce qui rend l'opération sûre sur un règlement échelonné : le
 * prorata se calcule sur la TVA d'ORIGINE (sinon chaque versement après le
 * premier serait sous-évalué), mais ne peut jamais dépasser ce qui reste dû.
 */
export function genererOdBasculeTva(ctx: ContexteBasculeTva): LigneOD[] {
  // Le fait générateur est le mouvement d'argent. Un « règlement » passé en VTE
  // ou en OD n'en est pas un : basculer sur sa foi rendrait la TVA exigible sans
  // qu'aucun euro ait bougé.
  if (ctx.journalReglement != null && !estJournalReglement(ctx.journalReglement)) return [];

  const regle = r2(ctx.montantRegle);
  if (regle <= 0.005) return [];

  const tvaOrigine = r2(ctx.montantTva);
  if (tvaOrigine <= 0.005) return [];

  // Base du prorata : le TTC de la pièce. À défaut, le montant réglé lui-même —
  // la bascule est alors intégrale, ce qui est le comportement voulu d'une pièce
  // dont on ne connaît que le règlement.
  const base = r2(ctx.montantTtc) > 0 ? r2(ctx.montantTtc) : regle;
  const proratise = tvaProportionnelle(regle, base, tvaOrigine);
  const plafond = ctx.plafond == null ? tvaOrigine : Math.max(0, r2(ctx.plafond));
  const aBasculer = r2(Math.min(proratise, plafond));
  if (aBasculer <= 0.005) return [];

  return construireBasculeTva({
    sens: ctx.sens,
    montantTva: aBasculer,
    date: ctx.date,
    reference: ctx.reference ?? null,
    libelle: ctx.libelle ?? null,
    lettrageCode: ctx.lettrageCode ?? "",
    factureId: ctx.factureId ?? null,
    paiementId: ctx.paiementId ?? null,
  });
}
