// ============================================================================
// lettrage.ts — Moteur de lettrage comptable (PUR, sans I/O).
//
// Le lettrage apparie les lignes d'un compte de tiers qui se soldent entre
// elles : la facture (débit chez un client, crédit chez un fournisseur) et son
// ou ses règlements. Les lignes appariées reçoivent un même CODE — AA, AB, AC…
// — qui matérialise le rapprochement dans le grand livre et dans les exports.
//
// Deux règles gouvernent tout ce fichier :
//
//  1. UN LETTRAGE EST ÉQUILIBRÉ. Σdébit == Σcrédit sur la sélection, sinon on
//     refuse. Un lettrage déséquilibré ferait disparaître un résidu de créance
//     ou de dette du suivi des postes ouverts — c'est-à-dire de la balance âgée
//     et des relances. Le partiel se traite en lettrant la quote-part réglée,
//     jamais en forçant l'appariement.
//
//  2. LE LETTRAGE DÉCLENCHE LA TVA. Sous le régime marocain des encaissements,
//     la TVA n'est exigible qu'au règlement. Le moment où l'on lettre est donc
//     exactement le moment où la TVA bascule du compte d'attente vers le compte
//     exigible. Les deux opérations partagent le même code : délettrer, c'est
//     annuler la bascule, sans exception possible.
//
// Ce module ne touche NI la base NI le réseau : il transforme des lignes en
// décisions. La persistance vit dans src/server/lettrage.functions.ts.
// ============================================================================

import { CLIENT_PREFIXES, FOURNISSEUR_PREFIXES } from "@/lib/import-grandlivre";

const round2 = (x: number) => Math.round(x * 100) / 100;
const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** Tolérance d'équilibre : le centime. En deçà, deux montants sont « égaux ». */
export const TOLERANCE_LETTRAGE = 0.005;

// ─── Comptes de TVA du régime des encaissements ──────────────────────────────
// La TVA transite par un compte d'ATTENTE tant que la pièce n'est pas réglée,
// puis bascule vers le compte EXIGIBLE, qui seul alimente la déclaration.
//
// Ces numéros sont regroupés ici — et pas disséminés dans le code — parce qu'un
// cabinet peut imposer ses propres sous-comptes (44581 plutôt que 4458, par
// exemple) : le jour où cela arrive, c'est cette constante qu'on paramètre.
// Clés = le SENS DU TIERS (et non « vente »/« achat ») : c'est le compte lettré
// qui désigne le couple, et l'indexer directement par `sens` supprime toute
// possibilité de désaccord entre les deux vocabulaires.
// Les comptes d'IMPUTATION sont les SOUS-COMPTES réellement mouvementés par les
// journaux de vente et d'achat — 44551 « TVA facturée » et 34552 « TVA récupérable
// sur charges » — et non leurs racines 4455 / 3455.
//
// C'était le défaut le plus coûteux de ce module : la facture créditait 44551, le
// reclassement débitait 44551, mais la bascule au règlement créditait 4455. La TVA
// exigible se retrouvait donc ÉCLATÉE sur deux comptes, dont un que la déclaration
// ne regarde pas — 1 880,00 MAD échoués sur 4455 et 240,00 sur 3455 dans la base.
// Un seul compte par nature, du fait générateur à la déclaration.
export const COMPTES_TVA = {
  /** Vente : TVA facturée en attente (4458) → TVA collectée exigible (44551). */
  client:      { attente: "4458", exigible: "44551", racineExigible: "4455" },
  /** Achat : TVA sur achats en attente (3458) → TVA récupérable (34552). */
  fournisseur: { attente: "3458", exigible: "34552", racineExigible: "3455" },
} as const;

/**
 * Racines de DÉTECTION des comptes de TRANSIT du régime des encaissements —
 * volontairement plus larges que les comptes d'imputation ci-dessus.
 *
 * Imputer et reconnaître sont deux besoins opposés : on impute sur le compte le
 * PLUS PRÉCIS (44551), on reconnaît sur le plus LARGE (4455, qui couvre 44551 et
 * les écritures historiques restées sur la racine).
 *
 * 4456 N'Y FIGURE PAS, et c'est délibéré : ces racines commandent aussi ce que le
 * délettrage a le droit de SUPPRIMER (cf. `grouperOdBascule`). Y ranger le 4456
 * exposerait l'OD de déclaration périodique — qui touche 44551, 34552 et 4456 —
 * à être emportée par l'annulation d'un règlement. Le 4456 est interdit au
 * lettrage (cf. `RACINES_TVA_NON_LETTRABLES`), ce qui est une autre question.
 */
export const RACINES_TVA_TRANSIT = ["4455", "4458", "3455", "3458"] as const;

/**
 * Tous les comptes de TVA interdits au lettrage — transit ET 4456 « État TVA due ».
 * Aucun ne porte de créance : ils se soldent par la déclaration périodique.
 */
export const RACINES_TVA_NON_LETTRABLES = [...RACINES_TVA_TRANSIT, "4456"] as const;

export type SensTiers = "client" | "fournisseur";
export type ComptesTva = Record<SensTiers, { attente: string; exigible: string; racineExigible?: string }>;

// ─── Référence propre des OD de reclassement ─────────────────────────────────
//
// Le reclassement (passage de la TVA du régime des débits à celui des
// encaissements) portait la référence de la FACTURE, comme les écritures de la
// pièce elle-même. Il devenait alors indiscernable d'une bascule au règlement :
// mêmes comptes, aucun code de lettrage, même référence — seul le sens différait.
// C'est ce qui a permis à une annulation de paiement de le mutiler (FAC-2024-307).
//
// Il porte désormais une référence PRÉFIXÉE. Le préfixe lui donne une identité
// propre — aucune requête sur la référence de la pièce ne peut plus le ramener
// par accident, et le lot entier se retrouve par `like 'RECLASS-TVA-%'`.
//
// Le préfixe CONSERVE la référence d'origine, et ce n'est pas un détail : c'est
// par `reference_piece` que `tvaEnAttenteDeLaPiece` retrouve la TVA en attente
// d'une pièce. Une référence entièrement disjointe (un horodatage, par exemple)
// couperait ce lien : les factures reclassées n'auraient plus de TVA visible en
// attente, et leur règlement ne basculerait plus rien.
export const PREFIXE_RECLASS_TVA = "RECLASS-TVA-";

/** Référence à poser sur une OD de reclassement de la pièce `ref`. */
export const referenceReclassement = (ref: string | null | undefined): string =>
  `${PREFIXE_RECLASS_TVA}${String(ref ?? "").trim()}`;

/** Vraie référence d'une pièce, préfixe de reclassement retiré s'il y est. */
export const referenceSansPrefixe = (ref: string | null | undefined): string => {
  const r = String(ref ?? "").trim();
  return r.startsWith(PREFIXE_RECLASS_TVA) ? r.slice(PREFIXE_RECLASS_TVA.length) : r;
};

/**
 * Toutes les références sous lesquelles vivent les écritures d'une pièce : la
 * sienne, et celle de son éventuel reclassement. À employer dans TOUT filtre
 * qui doit voir la pièce en entier — lecture de la TVA en attente, suppression
 * d'une facture. Une requête qui n'utiliserait que `ref` laisserait le
 * reclassement invisible, donc orphelin.
 */
export const referencesPiece = (...refs: (string | null | undefined)[]): string[] => {
  const base = [...new Set(refs.map((r) => String(r ?? "").trim()).filter(Boolean))];
  return [...base, ...base.map(referenceReclassement)];
};

// ─── 1. Génération des codes de lettrage ─────────────────────────────────────

/**
 * Code de lettrage à partir d'un rang (1 → AA, 2 → AB, …).
 *
 * La séquence est bijective base 26 sur DEUX lettres au minimum : AA…AZ, BA…ZZ,
 * puis AAA au-delà de 676. Le minimum à deux lettres est délibéré — il évite
 * toute confusion avec les codes à une lettre (A, B, C…) que les logiciels
 * comptables produisent et que `code_lettrage` conserve à l'import.
 */
export function codeLettrageDepuisRang(rang: number): string {
  if (!Number.isInteger(rang) || rang < 1) {
    throw new Error(`Rang de lettrage invalide : ${rang}`);
  }
  // Base 26 à largeur FIXE, élargie quand la largeur courante est saturée :
  // 2 lettres couvrent 676 codes (AA…ZZ), puis on passe à 3 (AAA…). Une
  // numération bijective ferait collisionner le rang 1 et le rang 27 sur « AA »
  // dès qu'on impose un minimum de deux lettres.
  let idx = rang - 1;
  let largeur = 2;
  let capacite = 26 ** largeur;
  while (idx >= capacite) {
    idx -= capacite;
    largeur += 1;
    capacite = 26 ** largeur;
  }
  let code = "";
  for (let i = 0; i < largeur; i++) {
    code = String.fromCharCode(65 + (idx % 26)) + code;
    idx = Math.floor(idx / 26);
  }
  return code;
}

/** Rang d'un code de lettrage (AA → 1). Inverse exact de `codeLettrageDepuisRang`. */
export function rangDepuisCodeLettrage(code: string): number | null {
  const c = String(code ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2,}$/.test(c)) return null;
  let idx = 0;
  for (const ch of c) idx = idx * 26 + (ch.charCodeAt(0) - 65);
  // Décale du nombre total de codes que couvrent les largeurs inférieures.
  let base = 0;
  for (let w = 2; w < c.length; w++) base += 26 ** w;
  return base + idx + 1;
}

/**
 * Prochain code libre d'un dossier, en repartant du plus grand code DÉJÀ ATTRIBUÉ.
 *
 * On ne compte pas les codes existants, on prend le maximum : un délettrage
 * laisse un trou dans la séquence, et réattribuer ce trou ferait resurgir un
 * code déjà vu dans un export antérieur — deux rapprochements différents
 * porteraient alors la même lettre dans les archives du cabinet.
 */
export function prochainCodeLettrage(codesExistants: (string | null | undefined)[]): string {
  let max = 0;
  for (const c of codesExistants) {
    const r = rangDepuisCodeLettrage(c ?? "");
    if (r !== null && r > max) max = r;
  }
  return codeLettrageDepuisRang(max + 1);
}

/** Suite de `n` codes libres — pour lettrer plusieurs groupes en une passe. */
export function suiteCodesLettrage(codesExistants: (string | null | undefined)[], combien: number): string[] {
  const depart = rangDepuisCodeLettrage(prochainCodeLettrage(codesExistants)) ?? 1;
  return Array.from({ length: Math.max(0, combien) }, (_, i) => codeLettrageDepuisRang(depart + i));
}

// ─── 2. Contrôle d'équilibre ─────────────────────────────────────────────────

/** Ligne du grand livre, vue sous l'angle du lettrage. */
export interface LigneLettrable {
  id: string;
  compte_numero?: string | null;
  libelle?: string | null;
  debit?: number | string | null;
  credit?: number | string | null;
  date_ecriture?: string | null;
  reference_piece?: string | null;
  lettrage_code?: string | null;
  /** Journal — seul le journal OD peut porter une écriture de bascule de TVA. */
  journal_code?: string | null;
}

/**
 * Un compte est-il un compte de TVA du régime des encaissements ?
 *
 * Reconnaissance par PRÉFIXE, et c'est tout l'enjeu : le plan comptable réel
 * emploie des SOUS-COMPTES (44551 « TVA facturée », 34552 « TVA récupérable »,
 * 44581…) là où `COMPTES_TVA` ne nomme que les racines 4455 / 4458 / 3455 / 3458.
 *
 * Une égalité stricte laissait donc échapper toute ligne sur un sous-compte. Au
 * délettrage, la ligne 4458 de l'OD était supprimée et sa contrepartie 44551
 * survivait : une demi-écriture orpheline, et un grand livre déséquilibré du
 * montant de la TVA (constaté sur FAC-2024-307 : 1 880,00 MAD d'écart).
 */
export function estCompteTva(
  compte: string | null | undefined,
  comptes: ComptesTva = COMPTES_TVA,
): boolean {
  const c = String(compte ?? "").trim();
  if (!c) return false;
  return racinesDetection(comptes).some((racine) => c === racine || c.startsWith(racine));
}

/**
 * Racines à comparer pour un paramétrage donné.
 *
 * Sur le plan comptable PAR DÉFAUT, on élargit aux racines de transit : elles
 * couvrent les sous-comptes (44551 ⊂ 4455) et l'existant resté sur la racine.
 *
 * Sur un plan PERSONNALISÉ, on s'en tient STRICTEMENT aux comptes fournis. Un
 * cabinet qui déclare `attente: "44581"` a fait un choix ; y ajouter d'office
 * « 4458 » reconnaîtrait des comptes qu'il n'emploie pas, et le délettrage
 * supprimerait des lignes qui ne le regardent pas.
 */
function racinesDetection(comptes: ComptesTva): string[] {
  if (comptes === (COMPTES_TVA as unknown as ComptesTva)) return [...RACINES_TVA_TRANSIT];
  return Object.values(comptes)
    .flatMap((x) => [x.attente, x.exigible, x.racineExigible])
    .filter((x): x is string => Boolean(x));
}

// ─── Comptes LETTRABLES : les tiers, et eux seuls ────────────────────────────
//
// Le lettrage apparie une créance ou une dette avec son règlement. Il n'a de
// sens que sur un compte de TIERS — 3421x clients, 4411x fournisseurs.
//
// Sur un compte de TVA il n'en a aucun : 4458 / 44551 / 3458 / 34552 / 4456 ne
// portent pas des créances mais des positions fiscales, soldées par la
// déclaration périodique (cf. src/lib/liquidation-tva.ts), jamais par
// appariement. Les y autoriser produisait des « rapprochements » qui masquaient
// des lignes de TVA aux yeux de la déclaration.
//
// NUANCE IMPORTANTE : les OD de bascule portent bien un `lettrage_code`, mais ce
// n'est pas un lettrage — c'est le lien de traçabilité qui rattache l'OD au
// règlement qui l'a déclenchée, posé par le moteur et jamais par l'utilisateur.
// L'interdiction porte sur le lettrage MANUEL (`planifierLettrage`), pas sur ce
// marquage interne.
export interface VerdictLettrable {
  ok: boolean;
  sens: SensTiers | null;
  raison: string | null;
}

/** Ce compte peut-il être lettré ? Rend le sens du tiers quand oui. */
export function compteLettrable(
  compte: string | null | undefined,
  comptes: ComptesTva = COMPTES_TVA,
): VerdictLettrable {
  const c = String(compte ?? "").trim();
  if (!c) return { ok: false, sens: null, raison: "Ligne sans compte : rien à lettrer." };

  // Interdiction plus large que `estCompteTva` : elle englobe le 4456, qui n'est
  // pas un compte de transit mais reste une position fiscale, non appariable.
  const interdits = [
    ...RACINES_TVA_NON_LETTRABLES,
    ...Object.values(comptes).flatMap((x) => [x.attente, x.exigible, x.racineExigible]),
  ].filter((x): x is string => Boolean(x));
  if (interdits.some((r) => c === r || c.startsWith(r))) {
    return {
      ok: false, sens: null,
      raison: `Lettrage interdit sur le compte de TVA ${c} : la TVA se solde par la `
        + "déclaration périodique, pas par appariement.",
    };
  }
  const sens = sensDuCompte(c);
  if (!sens) {
    return {
      ok: false, sens: null,
      raison: `Lettrage réservé aux comptes de tiers : ${c} n'est ni un client (3421x) `
        + "ni un fournisseur (4411x).",
    };
  }
  return { ok: true, sens, raison: null };
}

/**
 * Ce groupe d'OD est-il une bascule de RÈGLEMENT, et non une autre écriture de
 * TVA qui aurait la même allure ?
 *
 * Le sens tranche, et il n'y a que lui pour trancher :
 *
 *   bascule au règlement (VENTE)   D attente (4458)   / C exigible (4455/44551)
 *   reclassement vers l'attente    D exigible (44551) / C attente  (4458)
 *
 * Ce sont deux écritures EXACTEMENT inverses, sur les deux mêmes comptes, sans
 * code de lettrage, portant la même référence de facture. Sans ce test, annuler
 * un paiement supprimait le RECLASSEMENT — une écriture qui n'a rien à voir avec
 * le règlement (constaté sur FAC-2024-307 : la moitié du reclassement effacée,
 * 1 880,00 MAD d'écart au grand livre, et la TVA de la facture disparue du
 * passif alors que la facture était redevenue impayée).
 */
export function estBasculeReglement(
  groupe: LigneLettrable[],
  comptes: ComptesTva = COMPTES_TVA,
): boolean {
  const surCompte = (racine: string, cote: "debit" | "credit") =>
    groupe.some((l) =>
      String(l.compte_numero ?? "").trim().startsWith(racine) && n(l[cote]) > 0);

  // Détection sur la RACINE de l'exigible, jamais sur le sous-compte d'imputation :
  // les bascules déjà en base visent 4455 / 3455, les nouvelles 44551 / 34552. Ne
  // reconnaître que les secondes rendrait les premières indélettrables — leur ligne
  // d'attente serait supprimée et leur contrepartie survivrait, en demi-écriture.
  const exigible = (s: SensTiers) => comptes[s].racineExigible ?? comptes[s].exigible;

  // Vente : l'attente est DÉBITÉE (on la solde) et l'exigible CRÉDITÉ.
  const vente = surCompte(comptes.client.attente, "debit")
    && surCompte(exigible("client"), "credit");
  // Achat : le déductible est DÉBITÉ (le droit naît) et l'attente CRÉDITÉE.
  const achat = surCompte(exigible("fournisseur"), "debit")
    && surCompte(comptes.fournisseur.attente, "credit");
  return vente || achat;
}

/**
 * Regroupe les lignes de bascule de TVA en ÉCRITURES, et rend les identifiants
 * de toutes les lignes des écritures concernées.
 *
 * L'unité de suppression est l'ÉCRITURE, jamais la ligne : c'est la seule
 * formulation qui garantisse la partie double. Dès qu'une ligne d'une OD est
 * reconnue comme TVA, TOUTES les lignes de cette OD partent avec elle — y
 * compris une contrepartie sur un compte qu'on n'aurait pas su classer.
 *
 * Clé de regroupement : le code de lettrage quand il existe (les deux lignes
 * d'une bascule le partagent), sinon la référence de pièce + la date — cas des
 * bascules d'acompte, qui ne portent aucun code.
 */
export function grouperOdBascule(
  lignes: LigneLettrable[],
  comptes: ComptesTva = COMPTES_TVA,
  opts: {
    /**
     * N'emporter que les groupes dont le SENS est celui d'une bascule de
     * règlement. Indispensable quand on cible des OD SANS code (annulation d'un
     * acompte) : sans ce filtre on emporte le reclassement, qui a la même
     * signature à la direction près. Inutile sur les OD portant un code — le
     * code prouve à lui seul qu'elles viennent d'un lettrage.
     */
    seulementBascules?: boolean;
  } = {},
): string[] {
  const journal = (l: LigneLettrable) => String(l.journal_code ?? "").trim().toUpperCase();
  const ids = new Set<string>();

  // 1) Journal OD CONNU → regroupement, et le groupe part en entier.
  const groupes = new Map<string, LigneLettrable[]>();
  for (const l of lignes.filter((x) => journal(x) === "OD")) {
    const code = String(l.lettrage_code ?? "").trim();
    const cle = code
      ? `C:${code}`
      : `R:${String(l.reference_piece ?? "").trim()}|${String(l.date_ecriture ?? "").trim()}`;
    const g = groupes.get(cle);
    if (g) g.push(l); else groupes.set(cle, [l]);
  }
  for (const [, groupe] of groupes) {
    if (!groupe.some((l) => estCompteTva(l.compte_numero, comptes))) continue;
    if (opts.seulementBascules && !estBasculeReglement(groupe, comptes)) continue;
    for (const l of groupe) ids.add(l.id);
  }

  // 2) Journal INCONNU (appelant qui ne l'a pas chargé) → on retombe sur le seul
  // test du compte, sans regroupement. Compléter un groupe dont on ignore le
  // journal emporterait la ligne de FACTURE, qui partage code et référence avec
  // sa bascule : on supprimerait la vente pour annuler un règlement.
  if (!opts.seulementBascules) {
    for (const l of lignes.filter((x) => journal(x) === "")) {
      if (estCompteTva(l.compte_numero, comptes)) ids.add(l.id);
    }
  }

  return [...ids];
}

export interface ControleEquilibre {
  ok: boolean;
  totalDebit: number;
  totalCredit: number;
  ecart: number;
  raison: string | null;
}

/**
 * Une sélection est lettrable si elle porte au moins deux lignes, ne mélange pas
 * plusieurs comptes de tiers, et se solde exactement.
 *
 * Le contrôle « un seul compte » n'est pas une coquetterie : lettrer ensemble
 * deux comptes auxiliaires différents solderait la dette d'un tiers avec la
 * créance d'un autre. Cela n'a de sens qu'en compensation, qui suppose une
 * convention signée entre les parties et se passe alors en OD explicite.
 */
export function controlerEquilibre(lignes: LigneLettrable[]): ControleEquilibre {
  const totalDebit = round2(lignes.reduce((s, l) => s + n(l.debit), 0));
  const totalCredit = round2(lignes.reduce((s, l) => s + n(l.credit), 0));
  const ecart = round2(totalDebit - totalCredit);
  const base = { totalDebit, totalCredit, ecart };

  if (lignes.length < 2) {
    return { ...base, ok: false, raison: "Sélectionnez au moins deux lignes à apparier." };
  }
  const comptes = new Set(lignes.map((l) => String(l.compte_numero ?? "").trim()).filter(Boolean));
  if (comptes.size > 1) {
    return { ...base, ok: false, raison: `Lettrage impossible entre comptes différents (${[...comptes].join(", ")}).` };
  }
  if (Math.abs(ecart) > TOLERANCE_LETTRAGE) {
    return {
      ...base, ok: false,
      raison: `Sélection déséquilibrée : débit ${totalDebit.toFixed(2)} ≠ crédit ${totalCredit.toFixed(2)} (écart ${ecart.toFixed(2)}).`,
    };
  }
  if (totalDebit === 0 && totalCredit === 0) {
    return { ...base, ok: false, raison: "Sélection sans montant : rien à lettrer." };
  }
  return { ...base, ok: true, raison: null };
}

/** Sens d'un compte de tiers, d'après son préfixe PCM (342x client / 441x fournisseur). */
export function sensDuCompte(compte: string | null | undefined): SensTiers | null {
  const c = String(compte ?? "").trim();
  if (!c) return null;
  if (FOURNISSEUR_PREFIXES.some((p) => c.startsWith(p))) return "fournisseur";
  if (CLIENT_PREFIXES.some((p) => c.startsWith(p))) return "client";
  return null;
}

// ─── 3. Bascule de TVA (régime des encaissements) ────────────────────────────

/** Ligne d'OD à insérer, exprimée sans dépendance à la base. */
export interface LigneOD {
  journal_code: "OD";
  compte_numero: string;
  date_ecriture: string;
  libelle: string;
  debit: number;
  credit: number;
  reference_piece: string | null;
  lettrage_code: string;
  /**
   * Traçabilité EN BASE de la bascule : la facture dont la TVA devient exigible
   * et le règlement qui l'a rendue telle.
   *
   * La référence de pièce ne suffisait pas — c'est du texte, tronqué à 50
   * caractères à l'affichage, et deux pièces peuvent la partager. Ces deux clés
   * étrangères rendent l'OD retrouvable sans interprétation, et permettent de
   * répondre à « quel encaissement a rendu cette TVA due ? » d'une jointure.
   *
   * `paiement_id` demande la migration 20260809130000 ; tant qu'elle n'est pas
   * appliquée, la colonne est ignorée à l'insertion (cf. basculerTvaSurReglement).
   */
  facture_id: string | null;
  paiement_id: string | null;
}

export interface OptionsBasculeTva {
  sens: SensTiers;
  /** TVA de la pièce, au prorata de ce qui vient d'être réglé. */
  montantTva: number;
  date: string;
  /** Référence de la pièce d'origine — relie l'OD à la facture réglée. */
  reference?: string | null;
  libelle?: string | null;
  lettrageCode: string;
  comptes?: ComptesTva;
  /** Facture dont la TVA devient exigible (FK `ecritures_comptables.facture_id`). */
  factureId?: string | null;
  /** Règlement déclencheur (FK `ecritures_comptables.paiement_id`). */
  paiementId?: string | null;
}

/**
 * Écriture d'OD qui rend la TVA exigible au moment du règlement.
 *
 *   VENTE   : D 4458 (attente) / C 4455 (exigible)  → la TVA devient due
 *   ACHAT   : D 3455 (exigible) / C 3458 (attente)  → le droit à déduction naît
 *
 * Rend un tableau VIDE si la TVA est nulle : une pièce exonérée ou hors champ
 * ne déclenche aucune bascule, et une OD à zéro ne ferait que polluer le journal.
 */
export function construireBasculeTva(opts: OptionsBasculeTva): LigneOD[] {
  const tva = round2(n(opts.montantTva));
  if (tva <= 0) return [];

  const comptes = (opts.comptes ?? COMPTES_TVA)[opts.sens];
  const ref = opts.reference ? String(opts.reference) : null;

  // Libellé LISIBLE, au format « TVA exigible - FAC-2026-001 ».
  // L'ancien — « TVA exigible sur encaissement FAC - 2026 - 001 » — noyait le
  // numéro de facture, seule information utile au comptable qui parcourt le
  // journal d'OD, dans une phrase qui se répète à chaque ligne. Le séparateur
  // explicite « - » rend aussi le numéro extractible d'un export.
  const quoi = String(opts.libelle ?? ref ?? "").trim();
  const nature = opts.sens === "client" ? "TVA exigible" : "TVA déductible";
  const libelle = quoi ? `${nature} - ${quoi}` : nature;

  const commun = {
    journal_code: "OD" as const,
    date_ecriture: opts.date,
    libelle: libelle.slice(0, 200),
    reference_piece: ref,
    lettrage_code: opts.lettrageCode,
    facture_id: opts.factureId ?? null,
    paiement_id: opts.paiementId ?? null,
  };

  // L'ordre débit puis crédit n'a pas d'effet comptable, mais rend le journal
  // lisible tel quel dans le grand livre et dans les exports.
  return opts.sens === "client"
    ? [
        { ...commun, compte_numero: comptes.attente,  debit: tva, credit: 0 },
        { ...commun, compte_numero: comptes.exigible, debit: 0,   credit: tva },
      ]
    : [
        { ...commun, compte_numero: comptes.exigible, debit: tva, credit: 0 },
        { ...commun, compte_numero: comptes.attente,  debit: 0,   credit: tva },
      ];
}

/**
 * Quote-part de TVA à basculer quand le règlement est PARTIEL.
 *
 * Le droit à déduction naît à proportion du décaissement : régler 40 % d'une
 * facture rend 40 % de sa TVA exigible. On borne à la TVA totale — un cumul de
 * règlements supérieur au TTC (saisie en double) ne crée pas de TVA nouvelle.
 */
export function tvaProportionnelle(montantRegle: number, montantTtc: number, tvaTotale: number): number {
  const ttc = n(montantTtc);
  const tva = n(tvaTotale);
  if (ttc <= 0 || tva <= 0) return 0;
  const part = Math.min(1, Math.max(0, n(montantRegle) / ttc));
  return round2(tva * part);
}

// ─── 4. Décision de lettrage ─────────────────────────────────────────────────

export interface PieceReglee {
  /** TTC de la pièce, base du prorata de TVA. */
  montantTtc: number;
  montantTva: number;
  reference?: string | null;
  /** Clés étrangères tracées sur l'OD de bascule (cf. `LigneOD`). */
  factureId?: string | null;
  paiementId?: string | null;
}

export interface PlanLettrage {
  ok: boolean;
  raison: string | null;
  code: string;
  ligneIds: string[];
  sens: SensTiers | null;
  /** OD de bascule à insérer — vide si la pièce ne porte pas de TVA. */
  od: LigneOD[];
  montantLettre: number;
}

export interface OptionsPlanLettrage {
  lignes: LigneLettrable[];
  codesExistants: (string | null | undefined)[];
  /** Pièce réglée : sans elle, on lettre sans basculer de TVA. */
  piece?: PieceReglee | null;
  date?: string;
  comptes?: ComptesTva;
}

/**
 * Plan complet d'un lettrage : le code à poser, les lignes à estampiller et
 * l'OD de TVA à passer. Ne fait AUCUN accès base — l'appelant exécute le plan.
 *
 * Refuser tôt (équilibre, comptes mélangés, lignes déjà lettrées) évite qu'un
 * lettrage partiellement appliqué laisse la base dans un état bâtard : soit le
 * plan est valide et s'exécute en entier, soit rien n'est écrit.
 */
export function planifierLettrage(opts: OptionsPlanLettrage): PlanLettrage {
  const vide: Omit<PlanLettrage, "ok" | "raison"> = {
    code: "", ligneIds: [], sens: null, od: [], montantLettre: 0,
  };

  const dejaLettrees = opts.lignes.filter((l) => String(l.lettrage_code ?? "").trim());
  if (dejaLettrees.length) {
    const codes = [...new Set(dejaLettrees.map((l) => l.lettrage_code))].join(", ");
    return { ...vide, ok: false, raison: `Sélection déjà lettrée (${codes}) — délettrez d'abord.` };
  }

  const eq = controlerEquilibre(opts.lignes);
  if (!eq.ok) return { ...vide, ok: false, raison: eq.raison };

  const compte = String(opts.lignes[0]?.compte_numero ?? "").trim();

  // Le lettrage est RÉSERVÉ AUX COMPTES DE TIERS. Sur un compte de TVA il ne veut
  // rien dire : ces comptes se soldent par la déclaration périodique, et les
  // lettrer y masquait des lignes que la déclaration doit voir. On refuse la
  // sélection au lieu de la lettrer « sans bascule », qui la laissait passer.
  const lettrable = compteLettrable(compte, opts.comptes);
  if (!lettrable.ok) return { ...vide, ok: false, raison: lettrable.raison };
  const sens = lettrable.sens;

  const code = prochainCodeLettrage(opts.codesExistants);
  const date = opts.date ?? new Date().toISOString().slice(0, 10);

  // La bascule de TVA n'a de sens que sur un compte de tiers identifié : c'est
  // le sens (client / fournisseur) qui désigne le couple de comptes de TVA.
  const od = sens && opts.piece
    ? construireBasculeTva({
        sens,
        montantTva: tvaProportionnelle(eq.totalDebit, opts.piece.montantTtc, opts.piece.montantTva),
        date,
        reference: opts.piece.reference ?? null,
        lettrageCode: code,
        comptes: opts.comptes,
        factureId: opts.piece.factureId ?? null,
        paiementId: opts.piece.paiementId ?? null,
      })
    : [];

  return {
    ok: true,
    raison: null,
    code,
    ligneIds: opts.lignes.map((l) => l.id),
    sens,
    od,
    montantLettre: eq.totalDebit,
  };
}

// ─── 5. Délettrage ───────────────────────────────────────────────────────────

export interface PlanDelettrage {
  ok: boolean;
  raison: string | null;
  codes: string[];
  /** Lignes à dé-estampiller (lettrage_code → NULL). */
  ligneIds: string[];
  /** OD de bascule TVA à SUPPRIMER — elles portent le code et vivent en journal OD. */
  odASupprimer: string[];
}

/**
 * Plan de délettrage d'une sélection.
 *
 * Le délettrage est un TOUT-OU-RIEN par code : on ne peut pas retirer une seule
 * ligne d'un lettrage à trois lignes sans déséquilibrer les deux qui restent.
 * Sélectionner une ligne lettrée délettre donc l'intégralité de son code — y
 * compris les lignes non sélectionnées, qu'on renvoie explicitement pour que
 * l'appelant puisse le signaler à l'utilisateur.
 */
export function planifierDelettrage(
  selection: LigneLettrable[],
  toutesLignesDuDossier: LigneLettrable[],
  comptes: ComptesTva = COMPTES_TVA,
): PlanDelettrage {
  const codes = [...new Set(
    selection.map((l) => String(l.lettrage_code ?? "").trim()).filter(Boolean),
  )];
  if (!codes.length) {
    return { ok: false, raison: "Aucune ligne lettrée dans la sélection.", codes: [], ligneIds: [], odASupprimer: [] };
  }

  // Toutes les lignes portant l'un de ces codes, sélectionnées ou non.
  const concernees = toutesLignesDuDossier.filter((l) =>
    codes.includes(String(l.lettrage_code ?? "").trim()));

  // L'OD de bascule se supprime par ÉCRITURE ENTIÈRE (partie double), pas ligne
  // à ligne : sinon une contrepartie sur un sous-compte non reconnu survit et
  // déséquilibre le grand livre. Le reste des lignes est simplement dé-estampillé.
  const odASupprimer = grouperOdBascule(concernees, comptes);
  const aSupprimer = new Set(odASupprimer);

  return {
    ok: true,
    raison: null,
    codes,
    ligneIds: concernees.filter((l) => !aSupprimer.has(l.id)).map((l) => l.id),
    odASupprimer,
  };
}

// ─── 6. Postes ouverts d'un compte de tiers (alimente l'écran) ───────────────

export interface PosteTiers {
  compte: string;
  lignes: LigneLettrable[];
  totalDebit: number;
  totalCredit: number;
  /** Résidu non soldé : > 0 = créance (client) ou dette (fournisseur) restante. */
  solde: number;
  nbLettrees: number;
}

/** Regroupe les lignes par compte de tiers et calcule le résidu de chacun. */
export function regrouperParCompte(lignes: LigneLettrable[]): PosteTiers[] {
  const parCompte = new Map<string, LigneLettrable[]>();
  for (const l of lignes) {
    const c = String(l.compte_numero ?? "").trim();
    if (!c) continue;
    const liste = parCompte.get(c);
    if (liste) liste.push(l); else parCompte.set(c, [l]);
  }
  return [...parCompte.entries()]
    .map(([compte, ls]) => {
      const totalDebit = round2(ls.reduce((s, l) => s + n(l.debit), 0));
      const totalCredit = round2(ls.reduce((s, l) => s + n(l.credit), 0));
      return {
        compte,
        lignes: ls,
        totalDebit,
        totalCredit,
        solde: round2(totalDebit - totalCredit),
        nbLettrees: ls.filter((l) => String(l.lettrage_code ?? "").trim()).length,
      };
    })
    .sort((a, b) => a.compte.localeCompare(b.compte));
}

/**
 * Appariement AUTOMATIQUE des postes d'un compte : rapproche les lignes qui se
 * soldent exactement, du plus simple au moins évident.
 *
 *  1. même `reference_piece` de part et d'autre et solde nul → cas le plus sûr,
 *     c'est la facture et son règlement portant la même référence ;
 *  2. montant exact et UNIQUE en face → une facture de 1 234,56 et un unique
 *     règlement de 1 234,56 ne peuvent guère être autre chose.
 *
 * On s'arrête là volontairement. Apparier « au plus proche » ou combiner N
 * lignes contre M produit des rapprochements plausibles mais faux, que le
 * comptable devra défaire un par un : l'écran manuel est fait pour ces cas.
 */
export function apparierAutomatiquement(lignes: LigneLettrable[]): LigneLettrable[][] {
  const ouvertes = lignes.filter((l) => !String(l.lettrage_code ?? "").trim());
  const debits = ouvertes.filter((l) => n(l.debit) > 0);
  const credits = ouvertes.filter((l) => n(l.credit) > 0);
  const consommees = new Set<string>();
  const groupes: LigneLettrable[][] = [];

  // 1) Par référence de pièce commune.
  const parRef = new Map<string, LigneLettrable[]>();
  for (const l of ouvertes) {
    const ref = String(l.reference_piece ?? "").trim();
    if (!ref) continue;
    const g = parRef.get(ref);
    if (g) g.push(l); else parRef.set(ref, [l]);
  }
  for (const [, groupe] of parRef) {
    if (groupe.length < 2) continue;
    if (groupe.some((l) => consommees.has(l.id))) continue;
    if (controlerEquilibre(groupe).ok) {
      groupe.forEach((l) => consommees.add(l.id));
      groupes.push(groupe);
    }
  }

  // 2) Montant exact et unique en face.
  for (const d of debits) {
    if (consommees.has(d.id)) continue;
    const montant = n(d.debit);
    const enFace = credits.filter((c) =>
      !consommees.has(c.id) && Math.abs(n(c.credit) - montant) <= TOLERANCE_LETTRAGE);
    if (enFace.length !== 1) continue;      // ambigu → laissé au comptable
    const paire = [d, enFace[0]];
    if (!controlerEquilibre(paire).ok) continue;
    paire.forEach((l) => consommees.add(l.id));
    groupes.push(paire);
  }

  return groupes;
}
