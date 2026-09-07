// ============================================================================
// lettrage-compta.functions.ts — Lettrage COMPTABLE du grand livre.
//
// À ne pas confondre avec lettrage.functions.ts, qui rapproche les lignes d'un
// RELEVÉ BANCAIRE avec des pièces. Ici on apparie les écritures du GRAND LIVRE
// sur un compte de tiers, on pose un code (AA, AB…) et on rend la TVA exigible.
//
// Toute la décision appartient au moteur pur src/services/lettrage.ts ; ce
// fichier ne fait que lire, écrire, et rester atomique en cas d'échec partiel.
// ============================================================================

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import {
  COMPTES_TVA, controlerEquilibre, planifierDelettrage,
  planifierLettrage, referencesPiece, regrouperParCompte, sensDuCompte,
  type LigneLettrable, type SensTiers,
} from "@/services/lettrage";
import { synchroniserApresLettrage } from "./factures-gl.functions";
import { controlerPiece } from "@/lib/liquidation-tva";
import { controlerEcrituresRegime, estJournalReglement, genererOdBasculeTva } from "@/lib/genererEcritures";
import { memeCompte, normaliserNumeroCompte } from "@/lib/numero-compte";

/**
 * Insère une pièce d'OD construite par le moteur, en dégradant proprement.
 *
 * `paiement_id` est livré par la migration 20260809130000, appliquée à la main
 * dans Supabase (cf. mémoire migrations-manuelles-supabase). Tant qu'elle ne
 * l'est pas, la colonne n'existe pas et l'insert entier échouerait — la TVA ne
 * basculerait plus du tout. On réessaie donc SANS la colonne : la traçabilité
 * fine est perdue, la comptabilité reste juste. C'est le bon ordre de priorité.
 */
// Exportée : les scripts de reprise doivent inscrire par LE MÊME chemin que
// l'application, verrous compris. Un `insert` direct depuis un script
// contournerait `controlerEcrituresRegime` — c'est-à-dire exactement les règles
// que la reprise est censée rétablir.
export async function insererPiece(
  sb: any,
  dossierId: string,
  lignes: { journal_code: string; compte_numero: string; date_ecriture: string; libelle: string;
    debit: number; credit: number; reference_piece: string | null;
    facture_id?: string | null; paiement_id?: string | null }[],
  opts: { lettrageCode?: string | null; origine?: string } = {},
): Promise<{ error: string | null }> {
  // Dernier verrou avant la base : pas de trésorerie en OD, pas de TVA exigible
  // en VTE/ACH, partie double soldée. Rendu comme une erreur et non jeté — cette
  // fonction est appelée depuis des chemins qui ne doivent jamais faire échouer
  // le règlement qu'ils suivent (cf. `comptabiliserReglement`).
  const verdict = controlerEcrituresRegime(lignes);
  if (!verdict.ok) return { error: verdict.violations.join(" ") };

  const base = lignes.map((l) => ({
    dossier_id: dossierId,
    journal_code: l.journal_code,
    // Forme canonique sur 8 chiffres, posée ICI et pas chez l'appelant : c'est
    // le passage obligé de toute pièce d'OD, application comme scripts de
    // reprise. Les verrous ci-dessus raisonnent par racine, donc le padding ne
    // les concerne pas (cf. src/lib/numero-compte.ts).
    compte_numero: normaliserNumeroCompte(l.compte_numero),
    date_ecriture: l.date_ecriture,
    libelle: l.libelle,
    debit: l.debit,
    credit: l.credit,
    reference_piece: l.reference_piece,
    facture_id: l.facture_id ?? null,
    // Chaîne vide → NULL : une OD hors lettrage ne doit pas porter de code
    // fantôme, que l'écran de lettrage afficherait comme un rapprochement.
    lettrage_code: opts.lettrageCode || null,
    lettrage_date: opts.lettrageCode ? new Date().toISOString() : null,
    lettrage_origine: opts.lettrageCode ? (opts.origine ?? "auto") : null,
    valide: true,
  }));

  const avecPaiement = base.map((r, i) => ({ ...r, paiement_id: lignes[i].paiement_id ?? null }));
  const { error } = await sb.from("ecritures_comptables").insert(avecPaiement);
  if (!error) return { error: null };

  // Colonne absente (42703 / message nommant la colonne) → repli sans elle.
  const msg = String(error.message ?? "");
  if (error.code === "42703" || msg.includes("paiement_id")) {
    const { error: e2 } = await sb.from("ecritures_comptables").insert(base);
    return { error: e2 ? String(e2.message ?? e2) : null };
  }
  return { error: msg || "Insertion refusée" };
}

// Le proxy TLS d'entreprise fait échouer le `fetch` global côté serveur : sans
// ce repli undici, supabase-js rend des erreurs réseau opaques et le lettrage
// paraît « ne rien faire ».
let PROXY_DIRECT = false;
async function proxyFetch(input: any, init?: any): Promise<Response> {
  const direct = async () => {
    const { fetch: uf, Agent } = await import("undici");
    return (uf as any)(String(input), { ...init, dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) });
  };
  if (PROXY_DIRECT) return direct();
  try { return await fetch(String(input), init); }
  catch { PROXY_DIRECT = true; return direct(); }
}

function getSupabase() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    "";
  return createClient(url, key, { global: { fetch: (i: any, init?: any) => proxyFetch(i, init) } });
}

/** Colonnes nécessaires au lettrage — une seule définition, réutilisée partout. */
// `facture_id` est chargé pour tracer l'OD de bascule sur la facture dont la TVA
// devient exigible (cf. `LigneOD.facture_id`).
const COLS_LETTRAGE =
  "id,compte_numero,libelle,debit,credit,date_ecriture,reference_piece,journal_code,lettrage_code,lettrage_date,lettrage_origine,facture_id";

const nb = (v: unknown) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const round2 = (x: number) => Math.round(x * 100) / 100;


// ─── getPostesTiers : alimente l'écran de lettrage manuel ────────────────────
export const getPostesTiers = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({
      dossierId: z.string().uuid(),
      /** Compte de tiers à afficher. Absent → liste des comptes seulement. */
      compte: z.string().optional(),
      /** false → affiche aussi les lignes déjà lettrées (filtre « Tous »). */
      seulementNonLettres: z.boolean().default(true),
    }).parse(input),
  )
  .handler(async ({ data }) => {
    const sb = getSupabase();
    try {
      const { data: toutes, error } = await (sb as any).from("ecritures_comptables")
        .select(COLS_LETTRAGE).eq("dossier_id", data.dossierId);
      if (error) throw error;

      const lignesTiers = ((toutes ?? []) as LigneLettrable[])
        .filter((l) => sensDuCompte(l.compte_numero) !== null);

      const comptes = regrouperParCompte(lignesTiers).map((p) => ({
        compte: p.compte,
        sens: sensDuCompte(p.compte),
        nbLignes: p.lignes.length,
        nbNonLettrees: p.lignes.length - p.nbLettrees,
        solde: p.solde,
        // Libellé représentatif : le premier libellé non vide suffit à identifier
        // le tiers dans le sélecteur, sans jointure supplémentaire.
        libelle: p.lignes.find((l) => (l.libelle ?? "").trim())?.libelle ?? null,
      })).filter((c) => c.nbLignes > 0);

      const lignes = data.compte
        ? lignesTiers
            .filter((l) => memeCompte(l.compte_numero, data.compte))
            .filter((l) => !data.seulementNonLettres || !String(l.lettrage_code ?? "").trim())
            .sort((a, b) => String(a.date_ecriture ?? "").localeCompare(String(b.date_ecriture ?? "")))
        : [];

      return { ok: true as const, comptes, lignes, reason: null as string | null };
    } catch (e: any) {
      // Migration non appliquée (colonne lettrage_code absente) → l'écran doit le
      // dire, plutôt qu'afficher un tableau vide qu'on lirait « rien à lettrer ».
      return {
        ok: false as const, comptes: [] as any[], lignes: [] as LigneLettrable[],
        reason: String(e?.message ?? e),
      };
    }
  });

/**
 * TVA d'une pièce vue depuis le compte d'attente, et TTC de cette pièce côté tiers.
 *
 * On lit la TVA depuis les ÉCRITURES (compte d'attente) et non depuis la facture :
 * le grand livre est ce qui sera exporté et déclaré, c'est donc lui qui fait foi,
 * et une pièce importée sans facture rattachée reste traitable.
 *
 * Trois grandeurs, et la distinction entre les deux premières est essentielle :
 *
 *  • `tvaTotale`   — TVA d'ORIGINE de la pièce (le seul côté alimenté par la
 *    facture : crédit pour une vente, débit pour un achat). C'est la base du
 *    prorata d'un règlement partiel.
 *  • `tvaAttente`  — ce qu'il RESTE à basculer (origine − bascules déjà passées).
 *    Sert de plafond, et rend l'opération idempotente sur un règlement échelonné.
 *  • `ttcPiece`    — TTC porté par le compte de tiers, dénominateur du prorata.
 *
 * Proratiser sur `tvaAttente` au lieu de `tvaTotale` sous-évaluerait chaque
 * versement après le premier : sur 200 de TVA réglés en deux fois, le second
 * versement ne basculerait que 50 (la moitié du reste) au lieu de 100, et 50 de
 * TVA resteraient éternellement en attente sur une facture pourtant soldée.
 */
async function tvaEnAttenteDeLaPiece(
  sb: any, dossierId: string, reference: string, sens: SensTiers,
): Promise<{ tvaAttente: number; tvaTotale: number; ttcPiece: number }> {
  // `referencesPiece` ajoute la référence du RECLASSEMENT (RECLASS-TVA-<ref>) :
  // pour une facture antérieure au régime des encaissements, c'est l'OD de
  // reclassement — et elle seule — qui a mis la TVA en attente. La lire sous la
  // seule référence de la pièce rendrait cette TVA invisible, et le règlement ne
  // basculerait rien.
  const { data } = await sb.from("ecritures_comptables")
    .select("compte_numero,debit,credit")
    .eq("dossier_id", dossierId).in("reference_piece", referencesPiece(reference));

  const lignes = (data ?? []) as any[];
  const attente = COMPTES_TVA[sens].attente;
  // `memeCompte` et non une égalité stricte : `attente` est la racine PCM
  // (« 4458 »), tandis que la base porte la forme canonique sur 8 chiffres
  // (« 44580000 »). Avec une égalité stricte, `dejaBasculee` retombait à zéro et
  // le SECOND acompte rebasculait la TVA ENTIÈRE au lieu du reste — la TVA
  // devenait exigible deux fois sur une même facture.
  const lignesAttente = lignes
    .filter((l) => memeCompte(l.compte_numero, attente));

  // Vente : l'attente est créditée à la facture puis débitée à chaque bascule.
  // Achat : l'inverse.
  const tvaTotale = lignesAttente
    .reduce((s, l) => s + (sens === "client" ? nb(l.credit) : nb(l.debit)), 0);
  const dejaBasculee = lignesAttente
    .reduce((s, l) => s + (sens === "client" ? nb(l.debit) : nb(l.credit)), 0);

  const ttcPiece = lignes
    .filter((l) => sensDuCompte(l.compte_numero) === sens)
    .reduce((s, l) => s + (sens === "client" ? nb(l.debit) : nb(l.credit)), 0);

  return {
    tvaTotale: Math.max(0, round2(tvaTotale)),
    tvaAttente: Math.max(0, round2(tvaTotale - dejaBasculee)),
    ttcPiece: round2(ttcPiece),
  };
}

export interface BasculeTva {
  /** TVA effectivement rendue exigible par cet appel. */
  tva: number;
  /** Lignes d'OD insérées (0 ou 2). */
  od: number;
  error?: string | null;
}

/**
 * Rend exigible la TVA d'une pièce, au prorata du montant qui vient d'être réglé.
 *
 * Appelée depuis DEUX endroits, et c'est voulu :
 *  • `executerLettrage`, quand le règlement solde la pièce et qu'un code est posé ;
 *  • `comptabiliserReglement`, quand le règlement est PARTIEL et qu'aucun lettrage
 *    n'est possible (un lettrage doit être équilibré). Sans ce second appel, la
 *    TVA d'un acompte encaissé resterait en attente alors qu'elle est due — le
 *    fait générateur, sous le régime des encaissements, est l'encaissement, pas
 *    le solde de la facture.
 *
 * `lettrageCode` est NULL dans le second cas : l'OD n'appartient à aucun
 * rapprochement. Elle reste réversible — l'annulation du paiement supprime les
 * OD de TVA portant la référence de la pièce (cf. paiements.functions.ts).
 */
export async function basculerTvaSurReglement(
  sb: any,
  p: {
    dossierId: string; reference: string; sens: SensTiers;
    montantRegle: number; date: string;
    lettrageCode?: string | null; origine?: "auto" | "manuel";
    /** Traçabilité en base de l'OD produite (cf. `LigneOD`). */
    factureId?: string | null; paiementId?: string | null;
  },
): Promise<BasculeTva> {
  const { tvaAttente, tvaTotale, ttcPiece } =
    await tvaEnAttenteDeLaPiece(sb, p.dossierId, p.reference, p.sens);
  if (tvaAttente <= 0) return { tva: 0, od: 0 };      // pièce sans TVA, ou déjà basculée
  if (p.montantRegle <= 0.005) return { tva: 0, od: 0 };

  // Le prorata appartient au générateur (src/lib/genererEcritures.ts), et à lui
  // seul : la règle « au prorata de la TVA d'ORIGINE, plafonné au reste en
  // attente » vivait ici ET là-bas, et deux copies d'une règle de calcul finissent
  // par diverger. Le plafond `tvaAttente` est ce qui rend l'échelonnement
  // idempotent ; la base du prorata est le TTC de la pièce, ou à défaut (pièce
  // sans ligne de tiers exploitable) le montant réglé — bascule alors intégrale.
  const od = genererOdBasculeTva({
    sens: p.sens,
    montantTva: tvaTotale > 0 ? tvaTotale : tvaAttente,
    montantTtc: ttcPiece,
    montantRegle: p.montantRegle,
    plafond: tvaAttente,
    date: p.date,
    reference: p.reference,
    lettrageCode: p.lettrageCode ?? "",
    factureId: p.factureId ?? null, paiementId: p.paiementId ?? null,
  });
  if (!od.length) return { tva: 0, od: 0 };
  // Les deux lignes portent le même montant, l'une au débit l'autre au crédit :
  // le débit de la première EST la TVA basculée, quel que soit le sens.
  const aBasculer = round2(nb(od[0].debit));

  // INVARIANT : toute pièce générée est équilibrée. Le contrôle est ici, juste
  // avant l'insertion — une OD boiteuse insérée ne se voit plus qu'à la balance,
  // des semaines plus tard, sans qu'on sache d'où vient l'écart.
  const ctrl = controlerPiece(od);
  if (!ctrl.ok) return { tva: 0, od: 0, error: ctrl.raison ?? "Pièce déséquilibrée" };

  const { error } = await insererPiece(sb, p.dossierId, od, {
    lettrageCode: p.lettrageCode || null,
    origine: p.origine ?? "auto",
  });
  if (error) return { tva: 0, od: 0, error };
  return { tva: aBasculer, od: od.length };
}

export interface ResultatLettrage {
  ok: boolean;
  reason?: string | null;
  code: string | null;
  lignesLettrees?: number;
  odInserees?: number;
  tvaBasculee?: number;
  montantLettre?: number;
  avertissement?: string | null;
}

export interface EntreeLettrage {
  dossierId: string;
  ligneIds: string[];
  origine?: "auto" | "manuel";
  /**
   * Date de RÈGLEMENT réelle, celle que l'utilisateur a saisie. Elle date l'OD de
   * bascule de TVA — et c'est elle qui compte : sous le régime des encaissements,
   * la TVA devient exigible au jour où l'argent est reçu, pas au jour où
   * quelqu'un l'enregistre dans l'application. Un encaissement du 28 juin saisi
   * le 3 juillet appartient à la déclaration de JUIN ; le dater du jour de saisie
   * le décalait d'une période et faussait la déclaration.
   *
   * Absente → date du jour (lettrage manuel depuis l'écran comptable, où aucune
   * date de règlement n'est saisie).
   */
  dateReglement?: string | null;
  /** Règlement déclencheur, tracé sur l'OD de bascule (`ecritures_comptables.paiement_id`). */
  paiementId?: string | null;
}

/**
 * CŒUR du lettrage — fonction ordinaire, pas une server function.
 *
 * Cette séparation n'est pas cosmétique : le retour d'une server function
 * TanStack ne remonte PAS à un appelant serveur. Un appel serveur→serveur rend
 * `undefined` alors que l'écriture en base a bien eu lieu — l'appelant en
 * conclut « rien n'a été fait » et l'annonce à l'utilisateur. Tous les appels
 * internes passent donc par ici, et la server function n'est qu'une porte
 * d'entrée HTTP pour le navigateur.
 */
export async function executerLettrage(
  sb: any,
  // `dateReglement` et `paiementId` restent OPTIONNELS : le lettrage manuel depuis
  // l'écran comptable ne connaît ni l'un ni l'autre.
  data: Omit<Required<EntreeLettrage>, "dateReglement" | "paiementId">
    & { dateReglement?: string | null; paiementId?: string | null },
): Promise<ResultatLettrage> {
    // 1) Relire les lignes EN BASE plutôt que de faire confiance au client :
    // un montant falsifié côté navigateur produirait un lettrage déséquilibré.
    const { data: lignesBase, error: eLire } = await (sb as any).from("ecritures_comptables")
      .select(COLS_LETTRAGE).eq("dossier_id", data.dossierId).in("id", data.ligneIds);
    if (eLire) return { ok: false, reason: eLire.message, code: null };
    const lignes = (lignesBase ?? []) as LigneLettrable[];
    if (lignes.length !== data.ligneIds.length) {
      return { ok: false, reason: "Certaines lignes sont introuvables dans ce dossier.", code: null };
    }

    // 2) Codes déjà attribués → détermine le prochain.
    const { data: codes } = await (sb as any).from("ecritures_comptables")
      .select("lettrage_code").eq("dossier_id", data.dossierId).not("lettrage_code", "is", null);

    // Date de l'OD de TVA : celle du RÈGLEMENT quand on la connaît, sinon le jour
    // même (lettrage manuel, où aucune date n'est saisie). Voir `dateReglement`.
    const aujourdhui = new Date().toISOString().slice(0, 10);
    const dateTva = String(data.dateReglement ?? "").slice(0, 10) || aujourdhui;
    const plan = planifierLettrage({
      lignes,
      codesExistants: ((codes ?? []) as any[]).map((c) => c.lettrage_code),
      date: dateTva,
    });
    if (!plan.ok) return { ok: false, reason: plan.raison, code: null };

    // 3) Estampiller les lignes. Le garde `is("lettrage_code", null)` rend
    // l'opération idempotente : deux clics concurrents ne posent qu'un code.
    const maintenant = new Date().toISOString();
    const { error: eMaj, count } = await (sb as any).from("ecritures_comptables")
      .update(
        { lettrage_code: plan.code, lettrage_date: maintenant, lettrage_origine: data.origine },
        { count: "exact" },
      )
      .in("id", plan.ligneIds)
      .eq("dossier_id", data.dossierId)
      .is("lettrage_code", null);
    if (eMaj) return { ok: false, reason: eMaj.message, code: null };
    if (!count) return { ok: false, reason: "Lignes déjà lettrées entre-temps.", code: null };

    // Remet les lignes dans leur état d'avant en cas d'échec de la bascule :
    // un code posé sans TVA rendue exigible serait pire que pas de lettrage.
    const annulerEstampillage = async () => {
      await (sb as any).from("ecritures_comptables")
        .update({ lettrage_code: null, lettrage_date: null, lettrage_origine: null })
        .in("id", plan.ligneIds).eq("dossier_id", data.dossierId);
    };

    // 4) Bascule de TVA, une OD par pièce concernée. Sans sens de tiers
    // identifiable, on lettre sans basculer (cf. plan.raison).
    let odInserees = 0;
    let tvaBasculee = 0;
    const sens = plan.sens;
    if (sens) {
      const refs = [...new Set(
        lignes.map((l) => String(l.reference_piece ?? "").trim()).filter(Boolean),
      )];
      for (const ref of refs) {
        // Part de la pièce que ce lettrage solde, mesurée sur le côté FACTURE
        // (débit pour un client, crédit pour un fournisseur).
        //
        // On ne mesure PAS côté règlement : la ligne de banque porte son propre
        // libellé en `reference_piece` (« VIR SEPA RECU / … »), pas le numéro de
        // la facture. Additionner les règlements par référence donnerait donc
        // zéro, et aucune TVA ne deviendrait exigible — le cas exact rencontré
        // sur FAC-2024-309.
        //
        // Mesurer côté facture est aussi plus juste : le lettrage n'est accepté
        // que s'il est ÉQUILIBRÉ, donc les lignes de facture retenues sont
        // exactement ce que le règlement solde.
        const montantSolde = lignes
          .filter((l) => String(l.reference_piece ?? "").trim() === ref)
          .reduce((s, l) => s + (sens === "client" ? nb(l.debit) : nb(l.credit)), 0);
        if (montantSolde <= 0.005) continue;   // aucune ligne de facture de cette pièce ici

        // Traçabilité : la facture est celle qu'estampillent les lignes de CETTE
        // référence. On la lit sur les lignes plutôt que de la demander à
        // l'appelant — le lettrage manuel ne la connaît pas.
        const factureId = lignes
          .filter((l) => String(l.reference_piece ?? "").trim() === ref)
          .map((l) => (l as any).facture_id).find(Boolean) ?? null;

        const r = await basculerTvaSurReglement(sb, {
          dossierId: data.dossierId, reference: ref, sens,
          montantRegle: montantSolde, date: dateTva,
          lettrageCode: plan.code, origine: data.origine,
          factureId, paiementId: data.paiementId ?? null,
        });
        if (r.error) {
          await annulerEstampillage();
          return { ok: false, reason: `Bascule de TVA impossible : ${r.error}`, code: null };
        }
        odInserees += r.od;
        tvaBasculee += r.tva;
      }
    }

    return {
      ok: true,
      code: plan.code,
      lignesLettrees: count ?? plan.ligneIds.length,
      odInserees,
      tvaBasculee: round2(tvaBasculee),
      montantLettre: plan.montantLettre,
      avertissement: plan.raison,
    };
}

/** Porte d'entrée HTTP du lettrage — le navigateur passe par là. */
export const lettrerSelection = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({
      dossierId: z.string().uuid(),
      ligneIds: z.array(z.string().uuid()).min(2),
      origine: z.enum(["auto", "manuel"]).default("manuel"),
      /** Date de règlement réelle — date l'OD de TVA. Absente → jour même. */
      dateReglement: z.string().optional().nullable(),
    }).parse(input),
  )
  .handler(async ({ data }): Promise<ResultatLettrage> => {
    const sb = getSupabase();
    const r = await executerLettrage(sb, data);
    // Le lettrage vient de changer ce qui est soldé : la projection portée par
    // `factures` doit suivre dans la même requête, sinon l'écran affiche encore
    // l'ancien restant dû (cf. src/server/factures-gl.functions.ts).
    if (r.ok) await synchroniserApresLettrage(sb, data.dossierId);
    return r;
  });

export interface EntreeDelettrage {
  dossierId: string;
  ligneIds?: string[];
  codes?: string[];
}

export interface ResultatDelettrage {
  ok: boolean;
  reason?: string | null;
  codes: string[];
  lignesDelettrees?: number;
  odSupprimees?: number;
}

/** CŒUR du délettrage — voir `executerLettrage` pour le pourquoi de la séparation. */
export async function executerDelettrage(sb: any, data: EntreeDelettrage): Promise<ResultatDelettrage> {
    let codes = data.codes ?? [];
    if (!codes.length && data.ligneIds?.length) {
      const { data: sel } = await (sb as any).from("ecritures_comptables")
        .select("lettrage_code").eq("dossier_id", data.dossierId).in("id", data.ligneIds);
      codes = [...new Set(((sel ?? []) as any[])
        .map((l) => String(l.lettrage_code ?? "").trim()).filter(Boolean))];
    }
    if (!codes.length) {
      return { ok: false as const, reason: "Aucune ligne lettrée dans la sélection.", codes: [] as string[] };
    }

    // TOUTES les lignes portant ces codes — y compris non sélectionnées :
    // délettrer partiellement laisserait un rapprochement déséquilibré.
    const { data: concernees, error: eLire } = await (sb as any).from("ecritures_comptables")
      .select(COLS_LETTRAGE).eq("dossier_id", data.dossierId).in("lettrage_code", codes);
    if (eLire) return { ok: false as const, reason: eLire.message, codes };

    const toutes = (concernees ?? []) as LigneLettrable[];
    const plan = planifierDelettrage(toutes, toutes);
    if (!plan.ok) return { ok: false as const, reason: plan.raison, codes };

    // 1) Supprimer les OD de bascule — la TVA redevient « en attente ».
    // Garde-fou : on ne supprime QUE des lignes de journal OD. Une ligne de
    // facture ne doit jamais disparaître d'un délettrage.
    //
    // Le filtre sur le compte a été RETIRÉ ici : `grouperOdBascule` a déjà
    // sélectionné des écritures COMPLÈTES, et refiltrer ligne à ligne sur une
    // liste de comptes exacte est exactement ce qui laissait survivre la
    // contrepartie 44551 d'une OD dont la ligne 4458 partait — une demi-écriture
    // orpheline, et le grand livre déséquilibré du montant de la TVA.
    const odSupprimables = ((concernees ?? []) as any[])
      .filter((l: any) => plan.odASupprimer.includes(l.id))
      .filter((l: any) => String(l.journal_code ?? "").trim().toUpperCase() === "OD")
      .map((l: any) => l.id);
    if (odSupprimables.length) {
      // Contrôle de partie double AVANT d'écrire : si le groupe à supprimer ne
      // se solde pas, le supprimer créerait précisément l'écart qu'on corrige.
      const aSupp = ((concernees ?? []) as any[]).filter((l: any) => odSupprimables.includes(l.id));
      const ecart = round2(
        aSupp.reduce((s: number, l: any) => s + nb(l.debit) - nb(l.credit), 0),
      );
      if (Math.abs(ecart) > 0.005) {
        return {
          ok: false as const, codes,
          reason: `Bascule TVA déséquilibrée (écart ${ecart.toFixed(2)} MAD) : délettrage refusé pour ne pas creuser l'écart. Lancez scripts/reparer-od-tva-orphelines.ts.`,
        };
      }
      const { error: eDel } = await (sb as any).from("ecritures_comptables")
        .delete().in("id", odSupprimables).eq("dossier_id", data.dossierId);
      if (eDel) return { ok: false as const, reason: `Annulation de la bascule TVA impossible : ${eDel.message}`, codes };
    }

    // 2) Effacer le code sur les lignes lettrées.
    const { error: eMaj, count } = await (sb as any).from("ecritures_comptables")
      .update({ lettrage_code: null, lettrage_date: null, lettrage_origine: null }, { count: "exact" })
      .in("id", plan.ligneIds).eq("dossier_id", data.dossierId);
    if (eMaj) return { ok: false as const, reason: eMaj.message, codes };

    return {
      ok: true as const,
      codes: plan.codes,
      lignesDelettrees: count ?? plan.ligneIds.length,
      odSupprimees: odSupprimables.length,
      reason: null as string | null,
    };
}

/** Porte d'entrée HTTP du délettrage. */
export const delettrerSelection = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({
      dossierId: z.string().uuid(),
      /** Lignes sélectionnées — leur(s) code(s) seront délettrés EN ENTIER. */
      ligneIds: z.array(z.string().uuid()).min(1).optional(),
      /** Ou directement des codes (délettrage automatique à l'annulation d'un paiement). */
      codes: z.array(z.string()).min(1).optional(),
    }).refine((v) => v.ligneIds?.length || v.codes?.length, {
      message: "Fournir des lignes ou des codes à délettrer.",
    }).parse(input),
  )
  .handler(async ({ data }): Promise<ResultatDelettrage> => {
    const sb = getSupabase();
    const r = await executerDelettrage(sb, data);
    // Symétrique du lettrage : une facture délettrée redevient un poste ouvert,
    // et son restant dû doit remonter aussitôt.
    if (r.ok) await synchroniserApresLettrage(sb, data.dossierId);
    return r;
  });

// ─── Lettrage automatique : passe d'appariement sûr sur un compte ────────────
// Utilisée après un paiement/rapprochement : n'apparie que les cas certains
// (même référence de pièce, ou montant exact et unique en face).
export interface ResultatLettrageAuto {
  ok: boolean;
  reason?: string | null;
  codes: string[];
  lettres: number;
}

/** CŒUR du lettrage automatique — voir `executerLettrage` pour la séparation. */
/**
 * Date d'exigibilité de la TVA d'un groupe apparié : celle du RÈGLEMENT.
 *
 * Le lettrage automatique n'a pas d'utilisateur pour saisir une date, et il
 * n'en a pas besoin : le groupe qu'il vient d'apparier CONTIENT la ligne de
 * règlement, sur le même compte de tiers mais en journal BQ ou CAI. Sa date est
 * le jour où l'argent a bougé — le fait générateur du régime des encaissements.
 *
 * Il la laissait tomber, et `executerLettrage` retombait alors sur le jour même.
 * Toutes les bascules d'une reprise atterrissaient donc à la date de la reprise :
 * la TVA d'un encaissement de mars devenait exigible en août, disparaissait de
 * la déclaration de mars et réapparaissait dans celle d'août. L'erreur ne se
 * voit pas au journal — les montants sont justes — seulement à la déclaration,
 * une fois déposée.
 *
 * Le MAXIMUM, et non le minimum : sur un règlement échelonné, la pièce n'est
 * soldée qu'au dernier versement, et c'est ce jour-là que le solde devient
 * exigible. Sans ligne de trésorerie identifiable (compensation, avoir passé en
 * OD), on prend la date la plus tardive du groupe : toujours plus proche de la
 * réalité que la date du jour.
 */
export function dateDuReglement(
  groupe: { date_ecriture?: string | null; journal_code?: string | null }[],
): string | null {
  const jour = (l: { date_ecriture?: string | null }) => String(l.date_ecriture ?? "").slice(0, 10);
  const dates = groupe.filter((l) => estJournalReglement(l.journal_code)).map(jour).filter(Boolean);
  const retenues = dates.length ? dates : groupe.map(jour).filter(Boolean);
  if (!retenues.length) return null;
  return retenues.reduce((a, b) => (a > b ? a : b));
}

export async function executerLettrageAuto(
  sb: any, data: { dossierId: string; compte?: string },
): Promise<ResultatLettrageAuto> {
    const { apparierAutomatiquement } = await import("@/services/lettrage");

    const { data: toutes, error } = await (sb as any).from("ecritures_comptables")
      .select(COLS_LETTRAGE).eq("dossier_id", data.dossierId);
    if (error) return { ok: false, reason: error.message, codes: [], lettres: 0 };

    const lignesTiers = ((toutes ?? []) as LigneLettrable[])
      .filter((l) => sensDuCompte(l.compte_numero) !== null)
      .filter((l) => !data.compte || memeCompte(l.compte_numero, data.compte));

    // L'appariement raisonne compte par compte : un groupe ne doit jamais
    // mélanger deux tiers (cf. controlerEquilibre).
    const codesPoses: string[] = [];
    for (const poste of regrouperParCompte(lignesTiers)) {
      for (const groupe of apparierAutomatiquement(poste.lignes)) {
        // Appel DIRECT au cœur, pas à la server function : celle-ci ne rendrait
        // rien à un appelant serveur, et les codes posés seraient perdus.
        const r = await executerLettrage(sb, {
          dossierId: data.dossierId, ligneIds: groupe.map((l) => l.id), origine: "auto",
          dateReglement: dateDuReglement(groupe),
        });
        if (r.ok && r.code) codesPoses.push(r.code);
      }
    }
    return { ok: true, codes: codesPoses, lettres: codesPoses.length, reason: null };
}

// ─── Comptabilisation d'un règlement : lettrage + TVA, en une passe ──────────
//
// Point d'entrée UNIQUE appelé juste après l'enregistrement d'un paiement
// (bouton « Payer en espèces », encaissement, lettrage d'une ligne de relevé).
// Il fait, dans cet ordre, les deux choses qu'un règlement doit déclencher :
//
//   1. LETTRAGE — apparier la ligne de facture (débit client en VTE / crédit
//      fournisseur en ACH) avec la ligne de règlement de sens opposé (CAI ou BQ)
//      et poser le MÊME code sur les deux. Sans cela, la facture réglée reste un
//      poste ouvert : elle continue d'alimenter la balance âgée et les relances.
//
//   2. TVA — rendre la TVA exigible (4458 → 44551 en vente, 3458 → 34552 en achat)
//      IMMÉDIATEMENT, que le lettrage ait pu se faire ou non. Un règlement
//      partiel n'est pas lettrable (un lettrage doit être équilibré) mais il est
//      bel et bien encaissé : sa quote-part de TVA est due le jour même.
//
// Ne jette JAMAIS : un règlement enregistré ne doit pas être annulé parce que
// son lettrage a échoué. L'échec est rendu dans `raison`, à afficher.
export interface ResultatReglementCompta {
  lettre: boolean;
  code: string | null;
  tvaBasculee: number;
  odInserees: number;
  raison: string | null;
}

export async function comptabiliserReglement(
  sb: any,
  p: {
    dossierId: string;
    /** Compte de tiers mouvementé — le lettrage ne raisonne que compte par compte. */
    compte: string;
    /** Références de la pièce. Client : n° de facture ; fournisseur : id. On passe
     *  les deux, les écritures historiques n'emploient pas toujours la même. */
    references: (string | null | undefined)[];
    /** Montant qui vient d'être réglé — base du prorata de TVA. */
    montantRegle: number;
    date: string;
  },
): Promise<ResultatReglementCompta> {
  const vide: ResultatReglementCompta = {
    lettre: false, code: null, tvaBasculee: 0, odInserees: 0, raison: null,
  };
  const sens = sensDuCompte(p.compte);
  const refs = [...new Set(p.references.map((r) => String(r ?? "").trim()).filter(Boolean))];
  if (!sens || !refs.length) {
    return { ...vide, raison: `Compte ${p.compte} hors comptes de tiers : ni lettrage ni bascule de TVA.` };
  }

  try {
    // ── 1. Lettrage ────────────────────────────────────────────────────────────
    // Les lignes candidates : celles de CETTE pièce, sur CE compte de tiers, non
    // encore lettrées. Le filtre sur le compte est indispensable — deux factures
    // de tiers différents peuvent porter la même référence.
    const { data: brutes, error } = await (sb as any).from("ecritures_comptables")
      .select(COLS_LETTRAGE)
      .eq("dossier_id", p.dossierId)
      .eq("compte_numero", p.compte)
      .in("reference_piece", refs)
      .is("lettrage_code", null);
    if (error) return { ...vide, raison: error.message };

    const candidates = (brutes ?? []) as LigneLettrable[];
    let resultat = { ...vide };

    // On ne lettre que si l'ensemble se solde : c'est le cas du règlement TOTAL
    // (ou du dernier versement d'un échelonnement, les acomptes précédents étant
    // eux aussi des lignes ouvertes de cette pièce).
    if (candidates.length >= 2 && controlerEquilibre(candidates).ok) {
      const r = await executerLettrage(sb, {
        dossierId: p.dossierId, ligneIds: candidates.map((l) => l.id), origine: "auto",
        // La date saisie dans le modal date aussi l'OD de TVA — c'est le jour de
        // l'encaissement qui rend la TVA exigible, pas celui de la saisie.
        dateReglement: p.date,
      });
      if (r.ok) {
        resultat = {
          lettre: true, code: r.code, tvaBasculee: r.tvaBasculee ?? 0,
          odInserees: r.odInserees ?? 0, raison: r.avertissement ?? null,
        };
      } else {
        resultat = { ...vide, raison: r.reason ?? null };
      }
    } else if (candidates.length >= 2) {
      const eq = controlerEquilibre(candidates);
      resultat = { ...vide, raison: `Règlement partiel : lettrage différé (${eq.raison ?? "sélection déséquilibrée"}).` };
    } else {
      resultat = { ...vide, raison: "Aucune ligne ouverte à apparier sur cette pièce." };
    }

    // ── 2. TVA ─────────────────────────────────────────────────────────────────
    // Si le lettrage a eu lieu, `executerLettrage` a DÉJÀ basculé — on ne repasse
    // pas dessus (le compte d'attente serait débité deux fois). Sinon on bascule
    // au prorata du montant réglé : c'est le cas de l'acompte.
    if (!resultat.lettre) {
      for (const ref of refs) {
        const b = await basculerTvaSurReglement(sb, {
          dossierId: p.dossierId, reference: ref, sens,
          montantRegle: p.montantRegle, date: p.date, lettrageCode: null, origine: "auto",
        });
        if (b.error) { resultat.raison = `Bascule de TVA impossible : ${b.error}`; break; }
        resultat.tvaBasculee += b.tva;
        resultat.odInserees += b.od;
        // Les références sont deux ALIAS de la même pièce : dès que l'une porte
        // des écritures, inutile d'essayer l'autre — on doublerait la bascule.
        if (b.od > 0) break;
      }
    }
    return resultat;
  } catch (e: any) {
    // Migration `lettrage_code` non appliquée → le règlement reste valide, seul
    // le lettrage manque. On le dit plutôt que de faire échouer le paiement.
    return { ...vide, raison: String(e?.message ?? e) };
  }
}

/** Porte d'entrée HTTP du lettrage automatique. */
export const lettrerAutomatiquement = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({
      dossierId: z.string().uuid(),
      /** Restreint à un compte de tiers ; absent → tous les comptes du dossier. */
      compte: z.string().optional(),
    }).parse(input),
  )
  .handler(async ({ data }): Promise<ResultatLettrageAuto> => {
    const sb = getSupabase();
    const r = await executerLettrageAuto(sb, data);
    if (r.ok && r.lettres > 0) await synchroniserApresLettrage(sb, data.dossierId);
    return r;
  });
