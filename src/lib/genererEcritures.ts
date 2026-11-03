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
  COMPTES_TVA, construireBasculeTva, referencesPiece, tvaProportionnelle,
  type LigneOD, type SensTiers,
} from "@/services/lettrage";
import { compteTiersAuxiliaire } from "@/lib/comptes-auxiliaires";
import { controlerTvaHorsClasse6 } from "@/lib/garde-tva-classe6";
import {
  PCM, RACINES_PCM, controlerComptesPcm, validatePcmAccount,
} from "@/lib/pcm-referentiel";
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
export const RACINES_TVA_EXIGIBLE = [RACINES_PCM.TVA_FACTUREE, RACINES_PCM.TVA_RECUPERABLE] as const;

/**
 * Comptes de trésorerie interdits au journal OD.
 *
 * Détection par PRÉFIXE, et c'est indispensable : le plan réel emploie des
 * sous-comptes (51610000 pour la caisse par défaut, 51410001 pour une seconde
 * banque). Une égalité stricte sur « 5161 » ne verrait aucune des écritures
 * réellement produites.
 */
export const COMPTES_TRESORERIE_HORS_OD = [PCM.BANQUE, PCM.CAISSE] as const;

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

// ─── VERROU 11 — retouche manuelle d'une écriture existante ──────────────────
//
// L'écran Comptabilité laissait modifier et supprimer N'IMPORTE quelle écriture :
// une ligne de facture (VTE / ACH), une ligne lettrée, l'OD d'une déclaration
// de TVA, une écriture d'un exercice antérieur. Une suppression y ouvrait une
// demi-pièce, faisait disparaître un règlement ou une TVA déclarée, sans trace.
// Une écriture validée se corrige par une contre-écriture (avoir, annulation du
// règlement, régularisation), pas par effacement.

/** Ce qu'une retouche doit savoir d'une écriture. */
export interface EcritureRetouchee {
  journal_code?: string | null;
  reference_piece?: string | null;
  lettrage_code?: string | null;
  facture_id?: string | null;
  transaction_id?: string | null;
  paiement_id?: string | null;
  date_ecriture?: string | null;
}

export interface VerdictRetouche {
  /**
   * Motif qui interdit de supprimer la ligne ou d'en changer les montants, la
   * date, le journal ou la référence (null = ligne libre). Le compte et le
   * libellé restent corrigeables : un reclassement ne défait aucune pièce.
   */
  verrou: string | null;
  /** La ligne appartient à un exercice antérieur à l'exercice actif. */
  exerciceAnterieur: boolean;
}

/** Champs dont la modification défait la pièce : interdits sur une ligne verrouillée. */
export const CHAMPS_STRUCTURANTS = ["debit", "credit", "date_ecriture", "journal_code", "reference_piece"] as const;

export function verdictRetouche(e: EcritureRetouchee, exerciceActif?: BornesExercice | null): VerdictRetouche {
  const journal = txt(e.journal_code).toUpperCase();
  const ref = txt(e.reference_piece);
  let verrou: string | null = null;
  if (txt(e.lettrage_code)) {
    verrou = `écriture lettrée (${txt(e.lettrage_code)}) — délettrez-la d'abord depuis l'onglet Lettrage`;
  } else if ((JOURNAUX_FACTURATION as readonly string[]).includes(journal)) {
    verrou = "écriture d'une facture — corrigez la pièce d'origine (avoir) plutôt que son écriture";
  } else if (journal === "AN") {
    verrou = "écriture d'à-nouveau — elle se régénère depuis la clôture de l'exercice précédent";
  } else if (PREFIXES_PIECES_TVA_DUE.some((p) => ref.startsWith(p))) {
    verrou = "déclaration ou régularisation de TVA — passez par l'onglet Déclaration de la Fiscalité";
  } else if (txt(e.transaction_id) || txt(e.paiement_id) || txt(e.facture_id)) {
    verrou = "écriture d'un règlement ou d'un rapprochement — annulez le règlement plutôt que son écriture";
  }
  const d = jourIso(e.date_ecriture);
  const exerciceAnterieur = !!exerciceActif && !!d && d < exerciceActif.debut;
  return { verrou, exerciceAnterieur };
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

// ─── VERROU 5 — le SENS d'un règlement ───────────────────────────────────────
//
// Un règlement fait bouger l'argent dans un sens et le compte de tiers dans
// l'autre. Payer un fournisseur ÉTEINT une dette : D 4411x / C 5141. Encaisser
// un client ÉTEINT une créance : D 5141 / C 3421x.
//
// L'écriture inverse — un compte fournisseur CRÉDITÉ dans un journal de
// trésorerie — dit littéralement « le fournisseur nous a versé de l'argent et
// notre dette envers lui a augmenté ». Elle n'est pas déséquilibrée, elle est
// FAUSSE : c'est pourquoi aucun contrôle de partie double ne l'attrape.
// Constatée sur SOMADIR, où le règlement ATLAS PACKAGING débitait la caisse et
// créditait le fournisseur : le tiers affichait 40 320,00 de dette pour une
// facture de 20 160,00, et la balance bouclait à zéro.
//
// La détection porte sur la NATURE du compte, seul discriminant disponible : un
// fournisseur est un compte de passif, un client un compte d'actif. Elle est
// donc aveugle au cas légitime du REMBOURSEMENT — un fournisseur qui restitue
// un trop-payé produit exactement la même forme. Aucun chemin du projet n'en
// produit aujourd'hui ; le jour où il en faudra un, la règle devra recevoir une
// dérogation explicite plutôt que d'être affaiblie pour tout le monde.

/** Racines des comptes de tiers, par nature de solde. */
export const RACINES_TIERS = {
  /** Clients : compte d'ACTIF, éteint par un CRÉDIT à l'encaissement. */
  client: PCM.CLIENTS,
  /** Fournisseurs : compte de PASSIF, éteint par un DÉBIT au décaissement. */
  fournisseur: PCM.FOURNISSEURS,
} as const;

export function controlerSensReglement(lignes: LigneEcriture[]): ControleRegime {
  const violations: string[] = [];
  const tresorerie = (lignes ?? []).filter((l) => estJournalReglement(l.journal_code));
  if (!tresorerie.length) return conforme;

  const fournisseursCredites = tresorerie.filter(
    (l) => commencePar(l.compte_numero, [RACINES_TIERS.fournisseur]) && r2(l.credit) > 0.005);
  if (fournisseursCredites.length) {
    const comptes = [...new Set(fournisseursCredites.map((l) => txt(l.compte_numero)))].join(", ");
    violations.push(
      `Sens du règlement inversé : compte fournisseur CRÉDITÉ dans un journal de `
      + `trésorerie (${comptes}). Un décaissement éteint la dette, donc il la DÉBITE `
      + `— l'argent, lui, est au crédit du compte de trésorerie. En l'état l'écriture `
      + `augmente la dette au lieu de la solder, et la partie double n'y voit rien.`);
  }

  const clientsDebites = tresorerie.filter(
    (l) => commencePar(l.compte_numero, [RACINES_TIERS.client]) && r2(l.debit) > 0.005);
  if (clientsDebites.length) {
    const comptes = [...new Set(clientsDebites.map((l) => txt(l.compte_numero)))].join(", ");
    violations.push(
      `Sens du règlement inversé : compte client DÉBITÉ dans un journal de trésorerie `
      + `(${comptes}). Un encaissement éteint la créance, donc il la CRÉDITE. En l'état `
      + `l'écriture augmente la créance alors que l'argent est déjà rentré.`);
  }

  return violations.length ? { ok: false, violations } : conforme;
}

// ─── VERROU 6 — le 4456 ne se manie que par déclaration ──────────────────────
//
// `4456` (« État — TVA due ») est le compte de LIQUIDATION : il ne porte que le
// résultat d'un acte fiscal. Trois gestes y ont droit, et trois seulement — une
// déclaration, une reprise de déclaration, un paiement à la DGI.
//
// Ce verrou porte sur les MOUVEMENTS et non sur le signe du solde, parce que le
// solde n'a rien d'anormal dans un sens ni dans l'autre : créditeur, on doit de
// la TVA (le cas ordinaire) ; débiteur, on porte un crédit reportable. Interdire
// l'un des deux signalerait le cas normal. Ce qui est vérifiable, en revanche,
// c'est qu'aucune écriture ne s'invite sur ce compte hors des trois gestes : un
// ajustement manuel y crée un solde que plus aucune déclaration n'explique, et
// c'est par là que naissent les crédits de TVA auxquels un dossier n'a pas droit.

/** Racine du compte de liquidation de TVA. Miroir de `COMPTE_TVA_DUE`. */
export const RACINE_TVA_DUE = RACINES_PCM.TVA_DUE;

/**
 * Références des pièces autorisées à mouvementer le 4456.
 *
 * Miroirs de `PREFIXE_DECLARATION_TVA` / `PREFIXE_REGULARISATION_TVA`, dupliqués
 * pour préserver le SENS DES IMPORTS : `liquidation-tva` dépend de ce module, et
 * l'inverse créerait un cycle. Un test verrouille leur identité, si bien qu'une
 * divergence casse la suite au lieu de désarmer le verrou en silence.
 */
export const PREFIXES_PIECES_TVA_DUE = ["DECL-TVA-", "REGUL-TVA-"] as const;

/** Libellé du prélèvement de la DGI. Miroir de `LIBELLE_PAIEMENT_DGI`. */
export const LIBELLE_PAIEMENT_DGI_MIROIR = "Paiement TVA DGI";

export function controlerMouvementsTvaDue(lignes: LigneEcriture[]): ControleRegime {
  const fautives = (lignes ?? []).filter((l) => {
    if (!commencePar(l.compte_numero, [RACINE_TVA_DUE, RACINES_PCM.CREDIT_TVA]) || !mouvementee(l)) return false;
    const ref = txt(l.reference_piece);
    if (PREFIXES_PIECES_TVA_DUE.some((prefixe) => ref.startsWith(prefixe))) return false;
    // Le paiement à la DGI se reconnaît à son LIBELLÉ : il porte la référence de
    // la période déclarée, pas un préfixe qui lui soit propre.
    return !txt(l.libelle).startsWith(LIBELLE_PAIEMENT_DGI_MIROIR);
  });
  if (!fautives.length) return conforme;

  const detail = [...new Set(fautives.map(
    (l) => `${journal(l)} ${txt(l.compte_numero)} « ${txt(l.reference_piece) || "sans référence"} »`,
  ))].join(", ");
  return {
    ok: false,
    violations: [
      `Mouvement non autorisé sur le compte de liquidation ${RACINE_TVA_DUE} (${detail}). `
      + `Seules une déclaration (${PREFIXES_PIECES_TVA_DUE[0]}), une régularisation `
      + `(${PREFIXES_PIECES_TVA_DUE[1]}) ou un paiement DGI y ont droit : hors de là, le `
      + `solde du compte n'est plus explicable par aucun acte fiscal.`,
    ],
  };
}

// ─── VERROU 7 — pas de bascule de TVA sans règlement constaté ────────────────
//
// La bascule est le geste qui rend la TVA exigible (ou déductible). Son fait
// générateur est le RÈGLEMENT : un mouvement d'argent (écriture de trésorerie
// BQ / CAI) ou, exception documentée, une COMPENSATION de créances réciproques
// recevable (OD COMP-<n°>, convention originale signée des deux parties, même
// personne juridique — cf. controlerPieceCompensation), datée de la signature.
//
// Le contrôle du journal (`journalReglement` dans `genererOdBasculeTva`) ne
// suffisait pas : il vérifie que l'appelant PRÉTEND passer par BQ ou CAI, pas
// qu'une ligne de banque existe. C'est ainsi que des bascules ont été posées sur
// des rapprochements fictifs — antérieurs à la facture, ou sans relevé.
//
// La preuve admise est celle du projet : une écriture BQ/CAI reliée à la pièce
// par sa RÉFÉRENCE, par son CODE DE LETTRAGE, ou par `facture_id` — ou une
// compensation recevable rattachée de la même façon. Une ligne de `paiements`
// ne suffit pas — elle dit l'intention, pas le règlement.

/** Ligne de trésorerie servant de preuve à une bascule. */
export interface LigneTresoreriePreuve extends LigneEcriture {
  lettrage_code?: string | null;
  facture_id?: string | null;
}

/**
 * Cette pièce est-elle une BASCULE de TVA ?
 *
 * Signature : elle touche à la fois un compte d'ATTENTE (4458 / 3458) et un
 * compte EXIGIBLE (4455x / 3455x). C'est ce qui la distingue d'une déclaration,
 * qui relie l'exigible au 4456 sans jamais toucher l'attente.
 */
export function estBasculeTva(lignes: LigneEcriture[]): boolean {
  const mouvantes = (lignes ?? []).filter(mouvementee);
  const attente = mouvantes.some((l) => commencePar(l.compte_numero,
    [COMPTE_TVA_ATTENTE.vente, COMPTE_TVA_ATTENTE.achat]));
  return attente && mouvantes.some((l) => estTvaExigible(l.compte_numero));
}

// ─── Conditions du droit à déduction : la facture ────────────────────────────

export interface MentionsFacture {
  fournisseur_nom?: string | null;
  ice_fournisseur?: string | null;
  if_fournisseur?: string | null;
  numero?: string | null;
  date_facture?: string | null;
  /** Désignations des lignes : la nature de ce qui est facturé. */
  designations?: (string | null | undefined)[] | null;
  montant_ht?: number | null;
  montant_tva?: number | null;
  montant_ttc?: number | null;
}

/**
 * Mentions sans lesquelles la facture ne fonde pas le droit à déduction
 * (art. 145-III et 146 CGI) : identité du fournisseur (raison sociale, IF, ICE),
 * numéro et date, nature des biens ou services, montants HT, TVA et TTC
 * cohérents. Ce n'est PAS l'ICE et le numéro seuls ; et ce n'est pas non plus le
 * format de dépôt SIMPL-TVA (cf. `champsManquantsSimplTva`), qui se contrôle à part.
 *
 * Non contrôlables ici faute de donnée : l'adresse du fournisseur et le mode de
 * paiement justifié — à vérifier sur la pièce.
 */
export function controlerMentionsFacture(f: MentionsFacture): { conforme: boolean; manquantes: string[] } {
  const manquantes: string[] = [];
  if (!txt(f.fournisseur_nom)) manquantes.push("raison sociale du fournisseur");
  if (!/^\d{15}$/.test(txt(f.ice_fournisseur).replace(/\s/g, ""))) manquantes.push("ICE du fournisseur (15 chiffres)");
  if (!txt(f.if_fournisseur)) manquantes.push("identifiant fiscal (IF) du fournisseur");
  if (!txt(f.numero)) manquantes.push("numéro de facture");
  if (!jourIso(f.date_facture)) manquantes.push("date de facture");
  if (!(f.designations ?? []).some((d) => txt(d))) manquantes.push("désignation des biens ou services");
  const ht = r2(f.montant_ht), tva = r2(f.montant_tva), ttc = r2(f.montant_ttc);
  if (!(ht > 0) || !(ttc > 0)) manquantes.push("montants HT et TTC");
  else if (Math.abs(r2(ht + tva - ttc)) > 0.05) manquantes.push("cohérence HT + TVA = TTC");
  return { conforme: manquantes.length === 0, manquantes };
}

// ─── Compensation de créances réciproques ────────────────────────────────────
//
// Une créance et une dette réciproques peuvent s'éteindre par COMPENSATION : le
// client est aussi fournisseur, on solde l'une par l'autre, sans mouvement
// d'argent. C'est un mode de règlement (code DGI 6 « compensation ») : il rend la
// TVA exigible et ouvre le droit à déduction comme un paiement — à condition
// d'être DOCUMENTÉ par une convention datée et signée.
//
// Représentation, dans les modules existants :
//   • la convention : un justificatif de catégorie `convention_compensation`, dont
//     le numéro de pièce porte la référence, `date_signature` la date réelle de
//     signature, `signature_parties` l'attestation des deux signatures, et
//     `fichier_original_url` l'original numérisé ;
//   • l'écriture : une OD référencée COMP-<n° de convention>,
//       D 4411x (la dette fournisseur s'éteint) / C 342x (la créance client s'éteint).

/** Préfixe de référence des OD de compensation : COMP-<n° de la convention>. */
export const PREFIXE_COMPENSATION = "COMP-";
/** Catégorie du justificatif qui porte la convention de compensation. */
export const CATEGORIE_CONVENTION_COMPENSATION = "convention_compensation";

export interface ConventionCompensation {
  numero_piece?: string | null;
  date_document?: string | null;
  /** Date RÉELLE de signature : le fait générateur de la TVA compensée. */
  date_signature?: string | null;
  /** Signée par les DEUX parties (attestation de l'utilisateur sur l'original). */
  signature_parties?: boolean | null;
  categorie_pcm?: string | null;
  /** Montant convenu — plafond de tout ce qui se compense sous cette convention. */
  montant_ttc?: number | null;
  /** Original numérisé de la convention : sans lui, rien n'est probant. */
  fichier_original_url?: string | null;
  url_fichier?: string | null;
}

/** Identité fiscale d'un tiers, lue sur sa fiche (client ou fournisseur). */
export interface IdentiteTiers {
  nom?: string | null;
  ice?: string | null;
  if_fiscal?: string | null;
}

const ice15 = (v: unknown) => { const s = txt(v).replace(/\s/g, ""); return /^\d{15}$/.test(s) ? s : ""; };

/**
 * Les deux comptes compensés désignent-ils la MÊME personne juridique ? Une
 * compensation n'éteint que des créances RÉCIPROQUES : le client doit être le
 * fournisseur. ICE identique d'abord ; à défaut d'ICE d'un côté, identifiant
 * fiscal identique. Deux ICE différents — deux sociétés distinctes, fussent-elles
 * du même groupe — sont REFUSÉS ; une identité non établie aussi.
 */
export function memePersonneJuridique(a: IdentiteTiers | null | undefined, b: IdentiteTiers | null | undefined): { ok: boolean; motif: string } {
  if (!a || !b) return { ok: false, motif: "identité d'un des tiers introuvable (compte collectif ou fiche absente)" };
  const iceA = ice15(a.ice), iceB = ice15(b.ice);
  if (iceA && iceB) {
    return iceA === iceB ? { ok: true, motif: "ICE identique" }
      : { ok: false, motif: `ICE différents (${iceA} / ${iceB}) : deux personnes juridiquement distinctes` };
  }
  const ifA = txt(a.if_fiscal), ifB = txt(b.if_fiscal);
  if (ifA && ifB) {
    return ifA === ifB ? { ok: true, motif: "identifiant fiscal identique" }
      : { ok: false, motif: `identifiants fiscaux différents (${ifA} / ${ifB}) : deux personnes juridiquement distinctes` };
  }
  return { ok: false, motif: "identité juridique non établie : ni ICE ni IF renseignés des deux côtés" };
}

/**
 * Une pièce de compensation prouve-t-elle un règlement ? Conditions cumulatives :
 *   1. une convention de compensation, retrouvée par son numéro (COMP-<n°>) ;
 *   2. l'ORIGINAL numérisé de la convention est joint ;
 *   3. elle est signée par les DEUX parties, et sa date réelle de signature est
 *      connue — c'est elle, et non la date comptable de l'OD ni sa date de
 *      saisie, qui fixe le fait générateur ; l'OD ne peut pas la précéder ;
 *   4. l'OD éteint une dette fournisseur (débit 441x) ET une créance client
 *      (crédit 342x), pour le même montant, sans banque ni caisse ;
 *   5. le client et le fournisseur sont la MÊME personne juridique ;
 *   6. le total compensé sous la convention (toutes OD COMP-<n°>, compensations
 *      partielles comprises) ne dépasse pas le montant convenu — pas de double
 *      comptabilisation.
 */
export function controlerPieceCompensation(
  lignes: LigneEcriture[],
  convention: ConventionCompensation | null | undefined,
  contexte: {
    /** Identité du tiers de chaque compte auxiliaire mouvementé. */
    tiersDuCompte?: (compte: string) => IdentiteTiers | null | undefined;
  } = {},
): ControleRegime {
  const v: string[] = [];
  const ref = txt(lignes[0]?.reference_piece);
  if (!convention || txt(convention.categorie_pcm) !== CATEGORIE_CONVENTION_COMPENSATION) {
    v.push(`Compensation « ${ref} » sans convention de compensation enregistrée (justificatif ${ref.slice(PREFIXE_COMPENSATION.length) || "?"}).`);
  } else {
    if (!txt(convention.fichier_original_url) && !txt(convention.url_fichier)) {
      v.push(`Convention « ${txt(convention.numero_piece)} » : l'original numérisé n'est pas joint.`);
    }
    if (convention.signature_parties !== true) {
      v.push(`Convention « ${txt(convention.numero_piece)} » : signature des deux parties non attestée.`);
    }
    const signature = jourIso(convention.date_signature);
    if (!signature) v.push(`Convention « ${txt(convention.numero_piece)} » : date de signature manquante.`);
    const dates = lignes.map((l) => jourIso(l.date_ecriture)).filter(Boolean).sort();
    if (signature && dates[0] && dates[0] < signature) {
      v.push(`OD de compensation datée du ${dates[0]}, avant la signature du ${signature}.`);
    }
  }
  const clients = lignes.filter((l) => txt(l.compte_numero).startsWith(RACINES_TIERS.client));
  const fourns = lignes.filter((l) => txt(l.compte_numero).startsWith(RACINES_PCM.FOURNISSEURS));
  const debitFourn = r2(fourns.reduce((s, l) => s + r2(l.debit) - r2(l.credit), 0));
  const creditClient = r2(clients.reduce((s, l) => s + r2(l.credit) - r2(l.debit), 0));
  if (!(debitFourn > 0.005) || !(creditClient > 0.005)) {
    v.push("Une compensation éteint une dette fournisseur (débit 441x) ET une créance client (crédit 342x).");
  } else if (Math.abs(debitFourn - creditClient) > 0.005) {
    v.push(`Compensation déséquilibrée : ${debitFourn.toFixed(2)} de dette contre ${creditClient.toFixed(2)} de créance.`);
  }
  if (lignes.some((l) => estTresorerieHorsOd(l.compte_numero))) v.push("Une compensation ne mouvemente ni banque ni caisse.");

  // Identité juridique des parties : chaque couple client / fournisseur compensé.
  if (contexte.tiersDuCompte) {
    for (const c of new Set(clients.map((l) => txt(l.compte_numero)))) {
      for (const f of new Set(fourns.map((l) => txt(l.compte_numero)))) {
        const id = memePersonneJuridique(contexte.tiersDuCompte(c), contexte.tiersDuCompte(f));
        if (!id.ok) v.push(`Compensation ${c} / ${f} refusée : ${id.motif}.`);
      }
    }
  } else {
    v.push("Identité juridique des parties non vérifiée : fiches clients et fournisseurs indisponibles.");
  }

  // Montant : le total compensé sous la convention ne dépasse pas le convenu.
  const convenu = r2(convention?.montant_ttc);
  if (convention && convenu > 0 && creditClient > convenu + 0.005) {
    v.push(`Montant compensé ${creditClient.toFixed(2)} supérieur au montant de la convention ${convenu.toFixed(2)} : double comptabilisation ou dépassement.`);
  }
  return v.length ? { ok: false, violations: v } : conforme;
}

export function controlerPreuveBascule(
  lignes: LigneEcriture[], tresorerie: LigneTresoreriePreuve[],
  /** Lignes de pièces de compensation RECEVABLES (cf. `controlerPieceCompensation`). */
  compensations: LigneTresoreriePreuve[] = [],
): ControleRegime {
  if (!estBasculeTva(lignes)) return conforme;

  const refs = new Set(referencesPiece(...lignes.map((l) => l.reference_piece)));
  const lettrages = new Set((lignes as LigneTresoreriePreuve[])
    .map((l) => txt(l.lettrage_code)).filter(Boolean));
  const factures = new Set((lignes as LigneTresoreriePreuve[])
    .map((l) => txt(l.facture_id)).filter(Boolean));

  // La bascule est datée du règlement : une trésorerie POSTÉRIEURE ne la prouve
  // pas, elle la contredit.
  const dates = lignes.map((l) => txt(l.date_ecriture).slice(0, 10)).filter(Boolean).sort();
  const auPlusTard = dates[dates.length - 1] ?? "";

  const rattachee = (t: LigneTresoreriePreuve) => {
    const d = txt(t.date_ecriture).slice(0, 10);
    if (auPlusTard && d && d > auPlusTard) return false;
    return refs.has(txt(t.reference_piece))
      || (txt(t.lettrage_code) !== "" && lettrages.has(txt(t.lettrage_code)))
      || (txt(t.facture_id) !== "" && factures.has(txt(t.facture_id)));
  };
  const preuve = (tresorerie ?? []).some((t) => estJournalReglement(t.journal_code) && mouvementee(t) && rattachee(t))
    // Compensation documentée : un règlement sans mouvement d'argent, mais un
    // règlement — rattachée de la même façon (code de lettrage, référence).
    || (compensations ?? []).some((t) => mouvementee(t) && rattachee(t));
  if (preuve) return conforme;

  const ref = [...refs][0] ?? "sans référence";
  return {
    ok: false,
    violations: [
      `Bascule de TVA sans règlement constaté (pièce « ${ref} »${auPlusTard ? `, ${auPlusTard}` : ""}). `
      + `Sous le régime des encaissements le fait générateur est le règlement : `
      + `il faut une écriture ${JOURNAUX_REGLEMENT.join(" ou ")} rattachée à cette pièce — par `
      + `sa référence, son code de lettrage ou son facture_id — et datée au plus tard du `
      + `même jour, ou une compensation (${PREFIXE_COMPENSATION}…) adossée à une convention datée et signée. `
      + `Sans elle, la TVA devient exigible alors qu'aucun règlement n'a eu lieu.`,
    ],
  };
}

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
  /**
   * Lignes de TRÉSORERIE du dossier, pour prouver le règlement derrière une
   * bascule de TVA (verrou 7).
   *
   * Absentes, le contrôle ne s'exécute PAS : une fonction pure ne peut pas
   * inventer le grand livre, et refuser par défaut casserait tous les appelants
   * qui ne le passent pas. C'est `insererPiece` — le passage obligé vers la
   * base — qui les fournit systématiquement : le verrou est donc facultatif
   * dans la lib et effectif à la frontière.
   */
  tresorerie?: LigneTresoreriePreuve[];
  /** Lignes des pièces de compensation RECEVABLES : un règlement sans argent, mais documenté. */
  compensations?: LigneTresoreriePreuve[];
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
    // VERROU 10 : aucun compte hors référentiel PCM (format, classe, rubrique CGNC).
    ...controlerComptesPcm(lignes).violations,
    ...controlerTvaOrigine(lignes).violations,
    // VERROU 9 : la TVA récupérable ne touche jamais une charge de classe 6.
    ...controlerTvaHorsClasse6(lignes).violations,
    ...controlerJournalOd(lignes).violations,
    ...controlerCutoffExercice(lignes, opts.bornes).violations,
    ...controlerSensReglement(lignes).violations,
    ...controlerMouvementsTvaDue(lignes).violations,
    // Verrou 7 seulement si l'appelant a fourni le grand livre de trésorerie.
    ...(opts.tresorerie ? controlerPreuveBascule(lignes, opts.tresorerie, opts.compensations ?? []).violations : []),
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
// l'invariant du 4421 (acomptes). On le réexporte ici pour que tout le
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
  /**
   * Décision EXPLICITE sur la TVA (art. 106 CGI) : `true` = non récupérable,
   * `false` = récupérable. Absente → `classerTvaAchat` tranche sur la nature de
   * la dépense ; s'il ne peut pas trancher (`a_confirmer`), la TVA reste en
   * attente au 3458 et c'est à l'appelant de faire confirmer l'utilisateur.
   */
  tva_non_recuperable?: boolean | null;
  /** Désignations des lignes / libellé : la NATURE de la dépense, lue par `classerTvaAchat`. */
  designations?: string[] | null;
  /** Secteur d'activité du dossier : porte les exceptions (gasoil des transporteurs). */
  secteur_activite?: string | null;
  /** `avoir` : avoir fournisseur — écriture inverse de l'achat, journal ACH-AVR. */
  type?: "facture" | "avoir" | null;
}

/** Journal des avoirs fournisseurs (déjà déclaré dans JOURNAUX_FACTURATION). */
export const JOURNAL_AVOIRS_FOURNISSEURS = "ACH-AVR";

export type StatutTvaAchat = "deductible" | "non_recuperable" | "a_confirmer";

export interface ClassementTvaAchat {
  statut: StatutTvaAchat;
  /** Pourquoi — affiché à l'utilisateur et porté au libellé de l'écriture. */
  motif: string;
}

const norm = (s: unknown) => txt(s).toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const RX_RECEPTION = /\b(RECEPTIONS?|REPRESENTATION|RESTAURANT|RESTAURATION|REPAS|DEJEUNERS?|DINERS?|TRAITEUR|BANQUET|COCKTAIL|SEMINAIRE FESTIF)\b/;
const RX_LIBERALITE = /\b(CADEAUX?|DONS?|LIBERALITES?|GRATIFICATIONS?)\b/;
const RX_MISSION = /\b(MISSIONS?|DEPLACEMENTS?|VOYAGES?|HOTELS?|HEBERGEMENT|NUITEES?|BILLETS?|AVION|TRAIN|TAXI|PEAGES?)\b/;
const RX_VEHICULE_PERSONNES = /\b(VOITURES?|VEHICULES? (DE TOURISME|PARTICULIERS?|DE SERVICE)|VP|BERLINE|SUV|LOCATION (DE )?(VOITURE|VEHICULE)|LEASING (AUTO|VEHICULE)|LLD|LOA)\b/;
const RX_NON_EXPLOITATION = /\b(PERSONNEL(LE)?S? DU GERANT|PRIVEE?S?|FAMILIALE?S?|DOMICILE|VACANCES|USAGE PERSONNEL)\b/;
const RX_CARBURANT = /\b(CARBURANTS?|GASOIL|GAZOIL|GAZOLE|DIESEL|ESSENCE|SANS PLOMB|STATION[- ]?SERVICE)\b/;
const RX_GASOIL = /\b(GASOIL|GAZOIL|GAZOLE|DIESEL)\b/;
const RX_COMBUSTIBLE = /\b(FIOUL|FUEL OIL|PROPANE|BUTANE|GAZ INDUSTRIEL|COMBUSTIBLES?|CHAUDIERE|FOUR|GROUPE ELECTROGENE)\b/;
const RX_SECTEUR_TRANSPORT = /\b(TRANSPORTS?|TRANSPORTEUR|LOGISTIQUE|MESSAGERIE|FRET|TAXI|AUTOCAR|AERIEN|FERROVIAIRE)\b/;

/**
 * Classement de la TVA d'un achat au regard de l'art. 106 CGI. Le module ne
 * présume JAMAIS la déduction : un achat n'est « deductible » que s'il est
 * positivement identifié — nature décrite, aucune exclusion ni ambiguïté. La
 * CONFORMITÉ de la facture se contrôle à part (controlerMentionsFacture) et
 * bloque la bascule de TVA tant qu'elle n'est pas établie.
 *
 *   EXCLUSIONS (non_recuperable) — quand la nature est sans ambiguïté :
 *     • frais de réception, de représentation, de restauration ;
 *     • libéralités : cadeaux, dons, gratifications ;
 *     • carburant de véhicule, hors entreprise de transport (cf. plus bas) ;
 *   (une dépense marquée personnelle / privée passe en « à confirmer » : le
 *    libellé seul ne prouve pas qu'elle est étrangère à l'exploitation).
 *
 *   À CONFIRMER (a_confirmer) — le module ne tranche pas :
 *     • aucune désignation exploitable : la nature de la dépense est inconnue ;
 *     • frais de mission et de déplacement (hôtel, billets, taxi, péage) ;
 *     • véhicule de transport de personnes (achat, location, leasing, entretien) :
 *       exclu sauf véhicule utilitaire, transport public ou transport collectif
 *       du personnel — une affectation à justifier. L'activité de LOCATION de
 *       véhicules n'est PAS retenue comme exception : aucune base vérifiée ;
 *     • gasoil d'une entreprise de TRANSPORT : déductible seulement s'il alimente
 *       des véhicules affectés au transport (routier, ferroviaire, aérien) ; le
 *       secteur du dossier ne le prouve pas, un justificatif d'utilisation oui ;
 *     • compte 6143 ou 61223 sans nature identifiée.
 *
 *   DÉDUCTIBLE : facture conforme, désignation présente, aucune exclusion ni
 *   ambiguïté — combustible d'exploitation (fioul, gaz, four) compris.
 */
export function classerTvaAchat(p: {
  compte?: string | null;
  designations?: (string | null | undefined)[] | null;
  secteur_activite?: string | null;
}): ClassementTvaAchat {
  const compte = txt(p.compte);
  const texte = norm((p.designations ?? []).filter(Boolean).join(" "));
  const transporteur = RX_SECTEUR_TRANSPORT.test(norm(p.secteur_activite));
  const carburant = RX_CARBURANT.test(texte);

  // 1. Exclusions sans ambiguïté.
  if (RX_RECEPTION.test(texte)) return { statut: "non_recuperable", motif: "frais de réception / représentation (art. 106 CGI)" };
  if (RX_LIBERALITE.test(texte)) return { statut: "non_recuperable", motif: "libéralité : cadeau, don ou gratification (art. 106 CGI)" };
  if (carburant && !(transporteur && RX_GASOIL.test(texte))) {
    return { statut: "non_recuperable", motif: "carburant de véhicule — produit pétrolier non utilisé comme combustible (art. 106 CGI)" };
  }

  // 2. La CONFORMITÉ de la facture ne se décide pas ici : elle ne se « confirme »
  //    pas, elle s'établit (cf. controlerMentionsFacture). Une facture incomplète
  //    garde sa TVA en attente au 3458, et la bascule au paiement la refuse.

  // 3. Situations ambiguës : l'utilisateur tranche, pièce d'utilisation à l'appui.
  if (RX_NON_EXPLOITATION.test(texte)) {
    return { statut: "a_confirmer", motif: "dépense peut-être étrangère à l'exploitation (usage personnel / privé) : exclue si c'est le cas (art. 106 CGI)" };
  }
  if (carburant) {
    return { statut: "a_confirmer", motif: "gasoil d'une entreprise de transport : déductible s'il alimente des véhicules affectés au transport — justifier l'utilisation" };
  }
  if (RX_VEHICULE_PERSONNES.test(texte)) {
    return { statut: "a_confirmer", motif: "véhicule de transport de personnes : exclu sauf véhicule utilitaire, transport public ou transport collectif du personnel — justifier l'affectation" };
  }
  if (RX_MISSION.test(texte)) return { statut: "a_confirmer", motif: "frais de mission ou de déplacement : confirmer la déductibilité" };
  if (compte.startsWith(PCM.DEPLACEMENTS_MISSIONS_RECEPTIONS)) {
    return { statut: "a_confirmer", motif: "compte 6143 sans nature identifiée : réception (exclue) ou déplacement / mission ?" };
  }
  if (compte.startsWith(PCM.ACHATS_COMBUSTIBLES) && !RX_COMBUSTIBLE.test(texte)) {
    return { statut: "a_confirmer", motif: "compte 61223 sans nature identifiée : carburant de véhicule (exclu) ou combustible ?" };
  }
  if (!texte.trim()) return { statut: "a_confirmer", motif: "nature de la dépense non décrite : aucune désignation exploitable" };

  // 4. Identifié, conforme, sans exclusion.
  return { statut: "deductible", motif: RX_COMBUSTIBLE.test(texte) ? "combustible utilisé pour l'exploitation" : "achat d'exploitation identifié" };
}

export interface LigneAchat {
  dossier_id: string;
  journal_code: "ACH" | typeof JOURNAL_AVOIRS_FOURNISSEURS;
  compte_numero: string;
  date_ecriture: string;
  libelle: string;
  debit: number;
  credit: number;
  reference_piece: string;
  valide: true;
}

/** Compte de charge par défaut, aligné sur le moteur de catégorisation. */
export const COMPTE_CHARGE_DEFAUT_ACHAT = PCM.CHARGE_DEFAUT;

/**
 * Les écritures du journal des ACHATS pour une facture fournisseur.
 *
 *   D 6xxx   HT    charge
 *   D 3458   TVA   TVA en attente — le droit à déduction ne naît qu'au paiement
 *   C 4411x  TTC   dette envers le fournisseur (auxiliaire quand il est codé)
 *
 * TVA non récupérable : D 6xxx TTC / C 4411x TTC — aucune ligne 3458.
 * AVOIR fournisseur (journal ACH-AVR) : l'écriture inverse —
 *   D 4411x TTC / C 6xxx HT / C 3458 TVA  (ou C 6xxx TTC si non récupérable).
 *
 * La ligne de TVA est OMISE quand la TVA est nulle : un achat exonéré ou hors
 * champ ne doit pas produire une ligne 3458 à 0,00 que la bascule irait chercher.
 */
export function genererEcrituresAchat(ctx: ContexteEcrituresAchat): LigneAchat[] {
  const avoir = ctx.type === "avoir";
  // Un avoir peut arriver en négatif (import) : le sens est porté par D / C.
  const ht = Math.abs(r2(ctx.montant_ht));
  const tva = Math.abs(r2(ctx.montant_tva));
  const ttc = Math.abs(r2(ctx.montant_ttc));
  const ref = txt(ctx.reference) || txt(ctx.facture_id);
  const nom = txt(ctx.fournisseur_nom) || "Fournisseur";
  const suffixe = `${nom} ${ref}`.trim();
  const journal: LigneAchat["journal_code"] = avoir ? JOURNAL_AVOIRS_FOURNISSEURS : "ACH";

  const base = {
    dossier_id: ctx.dossier_id,
    journal_code: journal,
    date_ecriture: ctx.date_facture,
    reference_piece: ref,
    valide: true as const,
  };

  const compteCharge = txt(ctx.compte_charge) || COMPTE_CHARGE_DEFAUT_ACHAT;
  const compteTiers = txt(ctx.compte_tiers) || compteTiersAuxiliaire("fournisseur", ctx.code_auxiliaire ?? null);
  // Une TVA figurant sur la facture n'est pas, par là même, récupérable : exclue
  // du droit à déduction, elle alourdit la charge. Posée au 3458, elle aurait
  // basculé en 34552 au paiement et été DÉDUITE à tort.
  const classement = classerTvaAchat({ compte: compteCharge, designations: ctx.designations, secteur_activite: ctx.secteur_activite });
  const nonRecuperable = tva > 0.005
    // Une exclusion réglementaire ne se lève pas par une confirmation : seul un
    // « true » explicite peut AJOUTER une exclusion, jamais un « false » en retirer.
    && (ctx.tva_non_recuperable === true || classement.statut === "non_recuperable");
  // D / C selon le sens de la pièce : un avoir inverse chaque ligne.
  const sens = (montant: number, auDebit: boolean) =>
    (auDebit !== avoir) ? { debit: montant, credit: 0 } : { debit: 0, credit: montant };
  const etiquette = avoir ? "Avoir" : "Achat";

  if (nonRecuperable) {
    return [
      {
        ...base, compte_numero: compteCharge,
        libelle: `${etiquette} ${suffixe} — TVA non récupérable incluse (art. 106 CGI)`.slice(0, 200),
        // Le TTC, et non HT + TVA : la pièce reste équilibrée au centime même
        // quand l'arrondi ligne à ligne écarte les deux.
        ...sens(ttc, true),
      },
      { ...base, compte_numero: compteTiers, libelle: `${avoir ? "Avoir" : "Dette"} ${suffixe}`.slice(0, 200), ...sens(ttc, false) },
    ];
  }

  const lignes: LigneAchat[] = [
    { ...base, compte_numero: compteCharge, libelle: `${etiquette} ${suffixe}`.slice(0, 200), ...sens(ht, true) },
  ];
  if (tva > 0.005) {
    lignes.push({
      ...base, compte_numero: COMPTE_TVA_ATTENTE.achat,
      libelle: `TVA ${avoir ? "avoir " : ""}en attente ${suffixe}`.slice(0, 200), ...sens(tva, true),
    });
  }
  lignes.push({ ...base, compte_numero: compteTiers, libelle: `${avoir ? "Avoir" : "Dette"} ${suffixe}`.slice(0, 200), ...sens(ttc, false) });
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
  const violations = [
    ...controlerComptesPcm(lignes).violations,
    ...controlerTvaOrigine(lignes).violations,
    ...controlerTvaHorsClasse6(lignes).violations,
  ];

  const debitCharge = lignes.reduce(
    (s, l) => txt(l.compte_numero).startsWith(RACINES_PCM.CHARGES) ? s + r2(l.debit) - r2(l.credit) : s, 0);
  // Avoir fournisseur : le MIROIR de l'achat — la charge est créditée, le
  // fournisseur débité. Les contrôles s'inversent avec lui.
  const avoir = lignes.length > 0 && lignes.every((l) => txt(l.journal_code) === JOURNAL_AVOIRS_FOURNISSEURS);
  if (avoir) {
    if (r2(-debitCharge) <= 0.005) violations.push("Un avoir fournisseur doit créditer une charge de classe 6.");
    for (const l of lignes) {
      if (r2(l.debit) > 0.005 && !validatePcmAccount(l.compte_numero, { usage: "fournisseur" }).ok) {
        violations.push(`Compte ${txt(l.compte_numero)} débité sur un avoir fournisseur : l'avoir réduit la dette `
          + `d'un compte fournisseur (${RACINES_PCM.FOURNISSEURS}x).`);
      }
    }
  } else if (r2(debitCharge) <= 0.005) {
    violations.push("Aucune charge de classe 6 débitée : cet achat n'apparaîtrait pas au compte de résultat.");
  }

  // La dette d'une facture d'achat se porte sur un compte FOURNISSEUR (441x) :
  // un crédit sur un compte client ou de produit ferait naître la dette ailleurs.
  for (const l of avoir ? [] : lignes) {
    if (r2(l.credit) > 0.005 && !validatePcmAccount(l.compte_numero, { usage: "fournisseur" }).ok) {
      violations.push(`Compte ${txt(l.compte_numero)} crédité sur un achat : la dette se porte sur `
        + `un compte fournisseur (${RACINES_PCM.FOURNISSEURS}x).`);
    }
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
  // Le fait générateur est le règlement. Un « règlement » passé en VTE ou en OD
  // n'en est pas un (la compensation, seule exception, ne passe pas par ici :
  // elle est prouvée par controlerPreuveBascule) : basculer sur sa foi rendrait
  // la TVA exigible sans règlement.
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
