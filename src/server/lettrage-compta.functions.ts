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
  COMPTES_TVA, construireBasculeTva, planifierDelettrage, planifierLettrage,
  regrouperParCompte, sensDuCompte, tvaProportionnelle,
  type LigneLettrable, type SensTiers,
} from "@/services/lettrage";

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
const COLS_LETTRAGE =
  "id,compte_numero,libelle,debit,credit,date_ecriture,reference_piece,journal_code,lettrage_code,lettrage_date,lettrage_origine";

const nb = (v: unknown) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const round2 = (x: number) => Math.round(x * 100) / 100;

/** Tous les comptes de TVA gérés par la bascule, quel que soit le sens. */
const COMPTES_TVA_TOUS = new Set<string>(
  Object.values(COMPTES_TVA).flatMap((c) => [c.attente, c.exigible]),
);

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
            .filter((l) => String(l.compte_numero ?? "").trim() === data.compte)
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
 * TVA restant en attente sur une pièce, et TTC de cette pièce côté tiers.
 *
 * On lit la TVA depuis les ÉCRITURES (compte d'attente) et non depuis la facture :
 * le grand livre est ce qui sera exporté et déclaré, c'est donc lui qui fait foi,
 * et une pièce importée sans facture rattachée reste traitable.
 *
 * Le solde du compte d'attente décroît à chaque bascule : relire ce solde rend
 * l'opération naturellement idempotente sur un règlement échelonné.
 */
async function tvaEnAttenteDeLaPiece(
  sb: any, dossierId: string, reference: string, sens: SensTiers,
): Promise<{ tvaAttente: number; ttcPiece: number }> {
  const { data } = await sb.from("ecritures_comptables")
    .select("compte_numero,debit,credit")
    .eq("dossier_id", dossierId).eq("reference_piece", reference);

  const lignes = (data ?? []) as any[];
  const attente = COMPTES_TVA[sens].attente;

  // Vente : l'attente est créditée à la facture puis débitée à chaque bascule.
  // Achat : l'inverse. Dans les deux cas le solde restant est le reste à basculer.
  const tvaAttente = lignes
    .filter((l) => String(l.compte_numero ?? "").trim() === attente)
    .reduce((s, l) => s + (sens === "client" ? nb(l.credit) - nb(l.debit) : nb(l.debit) - nb(l.credit)), 0);

  const ttcPiece = lignes
    .filter((l) => sensDuCompte(l.compte_numero) === sens)
    .reduce((s, l) => s + (sens === "client" ? nb(l.debit) : nb(l.credit)), 0);

  return { tvaAttente: Math.max(0, round2(tvaAttente)), ttcPiece: round2(ttcPiece) };
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
export async function executerLettrage(sb: any, data: Required<EntreeLettrage>): Promise<ResultatLettrage> {
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

    const aujourdhui = new Date().toISOString().slice(0, 10);
    const plan = planifierLettrage({
      lignes,
      codesExistants: ((codes ?? []) as any[]).map((c) => c.lettrage_code),
      date: aujourdhui,
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
        const { tvaAttente, ttcPiece } = await tvaEnAttenteDeLaPiece(sb, data.dossierId, ref, sens);
        if (tvaAttente <= 0) continue;   // pièce sans TVA, ou TVA déjà basculée

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

        const base = ttcPiece > 0 ? ttcPiece : montantSolde;
        const aBasculer = Math.min(tvaAttente, tvaProportionnelle(montantSolde, base, tvaAttente));
        const od = construireBasculeTva({
          sens, montantTva: aBasculer, date: aujourdhui,
          reference: ref, lettrageCode: plan.code,
        });
        if (!od.length) continue;

        const { error: eOd } = await (sb as any).from("ecritures_comptables").insert(
          od.map((l) => ({
            dossier_id: data.dossierId,
            journal_code: l.journal_code,
            compte_numero: l.compte_numero,
            date_ecriture: l.date_ecriture,
            libelle: l.libelle,
            debit: l.debit,
            credit: l.credit,
            reference_piece: l.reference_piece,
            lettrage_code: l.lettrage_code,
            lettrage_date: maintenant,
            lettrage_origine: data.origine,
            valide: true,
          })),
        );
        if (eOd) {
          await annulerEstampillage();
          return { ok: false, reason: `Bascule de TVA impossible : ${eOd.message}`, code: null };
        }
        odInserees += od.length;
        tvaBasculee += aBasculer;
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
    }).parse(input),
  )
  .handler(({ data }): Promise<ResultatLettrage> => executerLettrage(getSupabase(), data));

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
    // Garde-fou : on ne supprime QUE des lignes de journal OD sur un compte de
    // TVA. Une ligne de facture ne doit jamais disparaître d'un délettrage.
    const odSupprimables = ((concernees ?? []) as any[])
      .filter((l: any) => plan.odASupprimer.includes(l.id))
      .filter((l: any) => l.journal_code === "OD" && COMPTES_TVA_TOUS.has(String(l.compte_numero ?? "").trim()))
      .map((l: any) => l.id);
    if (odSupprimables.length) {
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
  .handler(({ data }): Promise<ResultatDelettrage> => executerDelettrage(getSupabase(), data));

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
export async function executerLettrageAuto(
  sb: any, data: { dossierId: string; compte?: string },
): Promise<ResultatLettrageAuto> {
    const { apparierAutomatiquement } = await import("@/services/lettrage");

    const { data: toutes, error } = await (sb as any).from("ecritures_comptables")
      .select(COLS_LETTRAGE).eq("dossier_id", data.dossierId);
    if (error) return { ok: false, reason: error.message, codes: [], lettres: 0 };

    const lignesTiers = ((toutes ?? []) as LigneLettrable[])
      .filter((l) => sensDuCompte(l.compte_numero) !== null)
      .filter((l) => !data.compte || String(l.compte_numero ?? "").trim() === data.compte);

    // L'appariement raisonne compte par compte : un groupe ne doit jamais
    // mélanger deux tiers (cf. controlerEquilibre).
    const codesPoses: string[] = [];
    for (const poste of regrouperParCompte(lignesTiers)) {
      for (const groupe of apparierAutomatiquement(poste.lignes)) {
        // Appel DIRECT au cœur, pas à la server function : celle-ci ne rendrait
        // rien à un appelant serveur, et les codes posés seraient perdus.
        const r = await executerLettrage(sb, {
          dossierId: data.dossierId, ligneIds: groupe.map((l) => l.id), origine: "auto",
        });
        if (r.ok && r.code) codesPoses.push(r.code);
      }
    }
    return { ok: true, codes: codesPoses, lettres: codesPoses.length, reason: null };
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
  .handler(({ data }): Promise<ResultatLettrageAuto> => executerLettrageAuto(getSupabase(), data));
