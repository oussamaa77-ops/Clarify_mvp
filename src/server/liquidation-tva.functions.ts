// ============================================================================
// liquidation-tva.functions.ts — Déclaration périodique de TVA et paiement DGI.
//
// Deux opérations, et une seule règle : on ne génère RIEN qui ne soit équilibré,
// et on ne génère JAMAIS deux fois la même période.
//
//   • `declarerTva`      → OD D 44551 / C 34552 / C 4456 (cf. src/lib/liquidation-tva.ts)
//   • `payerTvaDgi`      → OD D 4456 / C 5141, éteint la dette
//   • `etatPeriodeTva`   → lecture seule : position, bouclage, cohérence dashboard
//   • `pointerTvaPeriode`      → coche/décoche le règlement DGI sur le 4456
//   • `enregistrerQuittanceTva`→ trace le PDF SIMPL-TVA sur la ligne de banque
//
// L'IDEMPOTENCE passe par `reference_piece = 'DECL-TVA-<période>'` : une période
// déjà déclarée est refusée plutôt que doublée. C'est le seul garde-fou qui
// tienne quand deux utilisateurs cliquent le même jour.
//
// ─── Pointage et quittance (migration 20260809130000) ────────────────────────
// Le lettrage est INTERDIT sur les comptes de TVA — ils se soldent par la
// déclaration, pas par rapprochement de tiers. `pointe` est l'équivalent sans
// lettrage : cocher que la dette déclarée a bien été prélevée, et que le 4456
// est retombé à 0,00. La quittance SIMPL-TVA, elle, se range sur la LIGNE DE
// BANQUE du prélèvement — c'est elle que le contrôleur rapproche du débit.
//
// Ces colonnes viennent d'une migration appliquée à la main ; toutes les
// lectures les demandent d'abord, puis retombent sur le jeu de colonnes
// historique si la base ne les a pas encore. Un select nommé sur une colonne
// absente rend `data = null`, pas une erreur parlante : sans ce repli, l'écran
// afficherait une période vide au lieu de dire ce qui manque.
// ============================================================================

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  COMPTE_TVA_DUE, bornesPeriode, construireOdDeclaration, construireOdPaiementDgi,
  controlerBouclagePeriode, controlerPiece, liquiderTva, referenceDeclaration,
  type LiquidationTva,
} from "@/lib/liquidation-tva";

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
function getSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (i: any, init?: any) => proxyFetch(i, init) } });
}

/**
 * Périodes acceptées : mensuelle « AAAA-MM » ou trimestrielle « AAAA-Tn ».
 *
 * Une seule définition, partagée par l'entrée générique et par le validateur
 * HTTP : deux expressions séparées finiraient par diverger, et l'écart se
 * paierait par une période acceptée d'un côté, refusée de l'autre.
 */
export const PERIODE_TVA_REGEX = /^\d{4}-(0[1-9]|1[0-2]|T[1-4])$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COLS = "id,journal_code,compte_numero,date_ecriture,debit,credit,reference_piece,libelle";
/** Colonnes de traçabilité livrées par la migration 20260809130000. */
const COLS_TRACE = `${COLS},pointe,pointe_le,transaction_id`;

/** Une erreur Postgres « colonne inconnue » — la migration n'est pas appliquée. */
const colonneAbsente = (error: any): boolean =>
  error?.code === "42703" || /column .* does not exist/i.test(String(error?.message ?? ""));

export const MSG_MIGRATION_ABSENTE =
  "Colonnes de traçabilité absentes : appliquez la migration 20260809130000 dans Supabase "
  + "(pointe, pointe_le, quittance_path).";

/**
 * Lecture des écritures du dossier, avec ou sans les colonnes de traçabilité.
 *
 * `tracable` dit LEQUEL des deux jeux a répondu : c'est ce drapeau que l'écran
 * utilise pour désactiver le pointage plutôt que de laisser l'utilisateur
 * cliquer sur un bouton qui échouera.
 */
async function lireEcritures(
  sb: any, dossierId: string,
): Promise<{ lignes: any[]; tracable: boolean; erreur: string | null }> {
  const complet = await sb.from("ecritures_comptables").select(COLS_TRACE).eq("dossier_id", dossierId);
  if (!complet.error) return { lignes: (complet.data ?? []) as any[], tracable: true, erreur: null };
  if (!colonneAbsente(complet.error)) {
    return { lignes: [], tracable: false, erreur: String(complet.error.message ?? complet.error) };
  }
  const base = await sb.from("ecritures_comptables").select(COLS).eq("dossier_id", dossierId);
  if (base.error) return { lignes: [], tracable: false, erreur: String(base.error.message ?? base.error) };
  return { lignes: (base.data ?? []) as any[], tracable: false, erreur: null };
}

/** Lignes du 4456 qui portent le cycle de CETTE période (déclaration + paiement). */
const lignesDuCycle = (lignes: any[], periode: string): any[] => {
  const ref = referenceDeclaration(periode);
  return lignes.filter((l) => String(l.reference_piece ?? "") === ref
    && String(l.compte_numero ?? "").startsWith(COMPTE_TVA_DUE));
};

export interface EtatPeriodeTva {
  ok: boolean;
  raison: string | null;
  periode: string;
  liquidation: LiquidationTva | null;
  /** La déclaration a-t-elle déjà été générée ? */
  declaree: boolean;
  /** Montant restant au 4456 : 0,00 quand la TVA déclarée a été prélevée. */
  resteAPayer: number;
  /** La période est-elle close ? Un crédit reportable ne l'en empêche pas. */
  bouclee: boolean;
  detailBouclage: string | null;
  /** Crédit de TVA légué aux périodes suivantes (positif), 0 dans le cas courant. */
  creditReporte: number;
  /** Le règlement DGI est-il pointé sur le 4456 ? Faux tant qu'une ligne ne l'est pas. */
  pointe: boolean;
  pointeLe: string | null;
  /** Ligne de relevé rapprochée du prélèvement, quand elle est connue. */
  transactionId: string | null;
  /** Quittance SIMPL-TVA tracée en base sur cette ligne de banque. */
  quittancePath: string | null;
  quittanceNom: string | null;
  /** La migration 20260809130000 est-elle appliquée ? Sinon, pointage indisponible. */
  tracable: boolean;
}

/** CŒUR — lecture seule de l'état d'une période. */
export async function lireEtatPeriodeTva(
  sb: any, data: { dossierId: string; periode: string },
): Promise<EtatPeriodeTva> {
  const vide: EtatPeriodeTva = {
    ok: false, raison: null, periode: data.periode, liquidation: null,
    declaree: false, resteAPayer: 0, bouclee: false, detailBouclage: null,
    creditReporte: 0, pointe: false, pointeLe: null, transactionId: null,
    quittancePath: null, quittanceNom: null, tracable: false,
  };
  const bornes = bornesPeriode(data.periode);
  if (!bornes) return { ...vide, raison: `Période illisible : « ${data.periode} ». Attendu « AAAA-MM » ou « AAAA-Tn ».` };

  const { lignes, tracable, erreur } = await lireEcritures(sb, data.dossierId);
  if (erreur) return { ...vide, raison: erreur };

  const liquidation = liquiderTva(lignes, data.periode);
  const cycle = lignesDuCycle(lignes, data.periode);
  const declaree = cycle.length > 0;

  // Le cycle n'est pointé que si TOUTES ses lignes le sont : une déclaration
  // cochée dont le prélèvement ne l'est pas n'est pas un règlement vérifié.
  const pointe = tracable && declaree && cycle.every((l) => l.pointe === true);
  const pointeLe = cycle.map((l) => l.pointe_le).filter(Boolean).sort().pop() ?? null;
  const transactionId = cycle.map((l) => l.transaction_id).find((v) => !!v) ?? null;

  let quittancePath: string | null = null;
  let quittanceNom: string | null = null;
  if (tracable && transactionId) {
    const q = await sb.from("transactions_bancaires")
      .select("quittance_path,quittance_nom").eq("id", transactionId).maybeSingle();
    if (!q.error && q.data) {
      quittancePath = q.data.quittance_path ?? null;
      quittanceNom = q.data.quittance_nom ?? null;
    }
  }

  const bouclage = controlerBouclagePeriode(lignes, data.periode);
  return {
    ok: true, raison: null, periode: bornes.label, liquidation, declaree,
    resteAPayer: bouclage?.due ?? 0,
    bouclee: bouclage?.solde ?? false,
    detailBouclage: bouclage?.raison ?? null,
    creditReporte: bouclage?.creditReporte ?? 0,
    pointe, pointeLe, transactionId, quittancePath, quittanceNom, tracable,
  };
}

export interface ResultatDeclaration {
  ok: boolean;
  raison: string | null;
  periode: string;
  liquidation: LiquidationTva | null;
  lignesInserees: number;
  /** Montant porté au 4456 : dette si `dette`, crédit reportable sinon. */
  montant: number;
  dette: boolean;
}

/** CŒUR de la déclaration périodique. */
export async function executerDeclarationTva(
  sb: any, data: { dossierId: string; periode: string; simulation?: boolean },
): Promise<ResultatDeclaration> {
  const vide: ResultatDeclaration = {
    ok: false, raison: null, periode: data.periode, liquidation: null,
    lignesInserees: 0, montant: 0, dette: true,
  };

  const etat = await lireEtatPeriodeTva(sb, data);
  if (!etat.ok) return { ...vide, raison: etat.raison };
  const liq = etat.liquidation!;

  if (liq.neant) {
    return { ...vide, ok: true, liquidation: liq, periode: liq.periode,
      raison: "Période néant : aucune TVA collectée ni déductible, aucune écriture générée." };
  }
  // IDEMPOTENCE : une période déjà déclarée ne se redéclare pas. Doubler l'OD
  // doublerait la dette au 4456 et la déclaration serait fausse du simple au double.
  if (etat.declaree) {
    return { ...vide, liquidation: liq, periode: liq.periode,
      raison: `La période ${liq.periode} est déjà déclarée. Annulez l'OD ${referenceDeclaration(liq.periode)} avant de la regénérer.` };
  }

  const od = construireOdDeclaration(liq);
  const ctrl = controlerPiece(od);
  if (!ctrl.ok) return { ...vide, liquidation: liq, raison: ctrl.raison };

  if (data.simulation) {
    return { ...vide, ok: true, liquidation: liq, periode: liq.periode,
      montant: liq.montant, dette: liq.dette,
      raison: "Simulation : aucune écriture n'a été générée." };
  }

  const { error } = await sb.from("ecritures_comptables").insert(
    od.map((l) => ({ ...l, dossier_id: data.dossierId, valide: true })),
  );
  if (error) return { ...vide, liquidation: liq, raison: String(error.message ?? error) };

  return {
    ok: true, raison: null, periode: liq.periode, liquidation: liq,
    lignesInserees: od.length, montant: liq.montant, dette: liq.dette,
  };
}

/**
 * ENTRÉE GÉNÉRIQUE de la liquidation : un dossier, une période, rien d'autre.
 *
 * `executerDeclarationTva` reçoit son client Supabase par injection — c'est ce
 * qui la rend testable, mais c'est aussi un détail d'implémentation que ni
 * l'écran ni un script n'ont à connaître. Cette fonction est la porte d'entrée
 * stable : elle valide ses deux arguments, ouvre le client par défaut, et
 * délègue. Aucun dossier, aucune période, aucune date n'y est écrite en dur —
 * elle vaut pour n'importe quel dossier et n'importe quelle période.
 *
 * Les arguments sont VALIDÉS plutôt que présumés : appelée depuis un script ou
 * une future route, elle recevra tôt ou tard un identifiant vide ou une période
 * mal formée. Un filtre `.eq("dossier_id", "")` ne lève pas — il rend zéro
 * ligne, donc une période « néant » parfaitement crédible et parfaitement
 * fausse. Mieux vaut le dire.
 *
 * @param dossierId  UUID du dossier — quel qu'il soit.
 * @param periode    « AAAA-MM » (mensuel) ou « AAAA-Tn » (trimestriel).
 * @param options.simulation  Calcule et contrôle sans rien écrire.
 * @param options.client      Client Supabase à réutiliser (tests, scripts).
 */
export function liquiderPeriodeTva(
  dossierId: string,
  periode: string,
  options: { simulation?: boolean; client?: SupabaseClient | any } = {},
): Promise<ResultatDeclaration> {
  const id = String(dossierId ?? "").trim();
  const per = String(periode ?? "").trim();
  const refus = (raison: string): Promise<ResultatDeclaration> => Promise.resolve({
    ok: false, raison, periode: per, liquidation: null,
    lignesInserees: 0, montant: 0, dette: true,
  });

  if (!UUID_REGEX.test(id)) return refus(`Identifiant de dossier invalide : « ${dossierId} ».`);
  if (!PERIODE_TVA_REGEX.test(per)) {
    return refus(`Période illisible : « ${periode} ». Attendu « AAAA-MM » ou « AAAA-Tn ».`);
  }

  return executerDeclarationTva(options.client ?? getSupabase(), {
    dossierId: id, periode: per, simulation: options.simulation,
  });
}

export interface ResultatPaiementDgi {
  ok: boolean;
  raison: string | null;
  lignesInserees: number;
  montant: number;
  /** Solde du 4456 après l'écriture : 0,00 quand la période est soldée. */
  resteApres: number;
}

/** CŒUR du paiement de la TVA à la DGI. */
export async function executerPaiementDgi(
  sb: any,
  data: {
    dossierId: string; periode: string; date: string;
    /** Absent → le reste dû au 4456, ce qui est le cas normal. */
    montant?: number | null;
    compteBanque?: string | null;
    /** Ligne de relevé correspondant au prélèvement, quand elle est connue. */
    transactionId?: string | null;
  },
): Promise<ResultatPaiementDgi> {
  const vide: ResultatPaiementDgi = { ok: false, raison: null, lignesInserees: 0, montant: 0, resteApres: 0 };

  const etat = await lireEtatPeriodeTva(sb, data);
  if (!etat.ok) return { ...vide, raison: etat.raison };
  if (!etat.declaree) {
    return { ...vide, raison: `La période ${etat.periode} n'est pas déclarée : générez d'abord l'OD de déclaration.` };
  }

  const reste = etat.resteAPayer;
  const montant = data.montant != null ? Math.round(Number(data.montant) * 100) / 100 : reste;
  if (montant <= 0) {
    return { ...vide, ok: true, resteApres: reste,
      raison: reste <= 0 ? "Rien à payer : le compte 4456 est déjà soldé." : "Montant nul." };
  }
  // On tolère un paiement PARTIEL (échéancier DGI) mais jamais un paiement
  // supérieur à la dette : il rendrait le 4456 débiteur, ce qui ne veut rien dire.
  if (montant - reste > 0.005) {
    return { ...vide, raison: `Montant supérieur à la dette de TVA (${reste.toFixed(2)} MAD au compte 4456).` };
  }

  const od = construireOdPaiementDgi({
    montant, date: data.date, periode: etat.periode,
    compteBanque: data.compteBanque ?? undefined,
  });
  const ctrl = controlerPiece(od);
  if (!ctrl.ok) return { ...vide, raison: ctrl.raison };

  const lignes = od.map((l) => ({
    ...l, dossier_id: data.dossierId, valide: true,
    transaction_id: data.transactionId ?? null,
  }));
  let { error } = await sb.from("ecritures_comptables").insert(lignes);
  if (error && (error.code === "42703" || String(error.message ?? "").includes("transaction_id"))) {
    ({ error } = await sb.from("ecritures_comptables")
      .insert(od.map((l) => ({ ...l, dossier_id: data.dossierId, valide: true }))));
  }
  if (error) return { ...vide, raison: String(error.message ?? error) };

  return {
    ok: true, raison: null, lignesInserees: od.length, montant,
    resteApres: Math.round((reste - montant) * 100) / 100,
  };
}

// ─── Pointage du règlement DGI (compte 4456) ─────────────────────────────────

export interface ResultatPointage {
  ok: boolean;
  raison: string | null;
  /** État demandé, reflété tel qu'il est en base après l'opération. */
  pointe: boolean;
  lignesPointees: number;
  /** La ligne de relevé a-t-elle été cochée elle aussi ? */
  transactionPointee: boolean;
}

/**
 * CŒUR du pointage : coche (ou décoche) les lignes de 4456 du cycle.
 *
 * Pointer n'écrit AUCUNE écriture — c'est une marque de vérification, pas un
 * fait comptable. On refuse néanmoins de cocher une dette encore ouverte : le
 * pointage affirme « le prélèvement est passé et le compte est retombé à 0,00 »,
 * et cette affirmation doit rester vraie quand on la relit six mois plus tard.
 * Le DÉpointage, lui, est toujours permis : se dédire doit rester possible.
 */
export async function executerPointageTva(
  sb: any, data: { dossierId: string; periode: string; pointe: boolean },
): Promise<ResultatPointage> {
  const vide: ResultatPointage = {
    ok: false, raison: null, pointe: false, lignesPointees: 0, transactionPointee: false,
  };

  const etat = await lireEtatPeriodeTva(sb, data);
  if (!etat.ok) return { ...vide, raison: etat.raison };
  if (!etat.tracable) return { ...vide, raison: MSG_MIGRATION_ABSENTE };
  if (!etat.declaree) {
    return { ...vide, raison: `La période ${etat.periode} n'est pas déclarée : rien à pointer sur le compte 4456.` };
  }
  // Un crédit de TVA laisse le 4456 DÉBITEUR : `resteAPayer` est négatif et
  // passerait la garde suivante. Or rien n'a été prélevé — il n'y a aucune ligne
  // bancaire à rapprocher, donc rien à pointer.
  if (data.pointe && etat.liquidation && !etat.liquidation.dette) {
    return { ...vide, raison:
      `La période ${etat.periode} dégage un crédit de TVA reportable : aucun prélèvement DGI à pointer.` };
  }
  if (data.pointe && etat.resteAPayer > 0.005) {
    return { ...vide, raison:
      `Le compte 4456 n'est pas soldé (${etat.resteAPayer.toFixed(2)} MAD restants) : `
      + "enregistrez le prélèvement DGI avant de pointer le règlement." };
  }

  const marque = data.pointe
    ? { pointe: true, pointe_le: new Date().toISOString() }
    : { pointe: false, pointe_le: null };

  const { data: maj, error } = await sb.from("ecritures_comptables")
    .update(marque)
    .eq("dossier_id", data.dossierId)
    .eq("reference_piece", referenceDeclaration(data.periode))
    .like("compte_numero", `${COMPTE_TVA_DUE}%`)
    .select("id");
  if (error) {
    return { ...vide, raison: colonneAbsente(error) ? MSG_MIGRATION_ABSENTE : String(error.message ?? error) };
  }

  // La ligne de banque porte la même marque quand elle est connue : c'est elle
  // que l'utilisateur retrouve dans le relevé, pas l'écriture.
  let transactionPointee = false;
  if (etat.transactionId) {
    const { error: eTx } = await sb.from("transactions_bancaires")
      .update({ pointe: data.pointe }).eq("id", etat.transactionId);
    transactionPointee = !eTx;
  }

  return {
    ok: true, raison: null, pointe: data.pointe,
    lignesPointees: (maj ?? []).length, transactionPointee,
  };
}

// ─── Quittance SIMPL-TVA ─────────────────────────────────────────────────────

export interface ResultatQuittance {
  ok: boolean;
  raison: string | null;
  /** Le chemin est-il tracé en base, ou seulement rangé dans le bucket ? */
  traceEnBase: boolean;
  quittancePath: string | null;
}

/**
 * CŒUR de l'enregistrement de la quittance : écrit le CHEMIN du PDF sur la ligne
 * de banque du prélèvement.
 *
 * Le fichier est déjà dans le bucket privé quand on arrive ici — cette fonction
 * ne fait que le rattacher. Sans ligne de relevé rapprochée, il n'y a rien à
 * annoter : on le dit (`traceEnBase = false`) au lieu d'échouer, le document
 * reste retrouvable par son chemin déterministe dans le bucket.
 */
export async function executerEnregistrementQuittance(
  sb: any, data: { dossierId: string; periode: string; path: string; nom?: string | null },
): Promise<ResultatQuittance> {
  const vide: ResultatQuittance = { ok: false, raison: null, traceEnBase: false, quittancePath: null };
  const path = String(data.path ?? "").trim();
  if (!path) return { ...vide, raison: "Chemin de quittance vide." };

  const etat = await lireEtatPeriodeTva(sb, data);
  if (!etat.ok) return { ...vide, raison: etat.raison };
  if (!etat.transactionId) {
    return {
      ok: true, raison:
        "Aucune ligne de relevé n'est rapprochée du prélèvement : la quittance reste rangée "
        + "dans le bucket « quittances-tva », sans être tracée sur une écriture.",
      traceEnBase: false, quittancePath: path,
    };
  }

  const { error } = await sb.from("transactions_bancaires")
    .update({ quittance_path: path, quittance_nom: data.nom ?? path.split("/").pop() ?? null })
    .eq("id", etat.transactionId);
  if (error) {
    return { ...vide, quittancePath: path,
      raison: colonneAbsente(error) ? MSG_MIGRATION_ABSENTE : String(error.message ?? error) };
  }
  return { ok: true, raison: null, traceEnBase: true, quittancePath: path };
}

// ─── Portes d'entrée HTTP ────────────────────────────────────────────────────

const periodeSchema = z.string().regex(PERIODE_TVA_REGEX, "Période attendue « AAAA-MM » ou « AAAA-Tn »");

export const etatPeriodeTva = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ dossierId: z.string().uuid(), periode: periodeSchema }).parse(input),
  )
  .handler(({ data }): Promise<EtatPeriodeTva> => lireEtatPeriodeTva(getSupabase(), data));

export const declarerTva = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({
      dossierId: z.string().uuid(), periode: periodeSchema,
      simulation: z.boolean().optional(),
    }).parse(input),
  )
  // Même chemin que les scripts et que tout autre appelant : la porte HTTP ne
  // fait qu'ouvrir, elle ne réimplémente rien.
  .handler(({ data }): Promise<ResultatDeclaration> =>
    liquiderPeriodeTva(data.dossierId, data.periode, { simulation: data.simulation }));

export const payerTvaDgi = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({
      dossierId: z.string().uuid(), periode: periodeSchema,
      date: z.string(),
      montant: z.number().positive().optional().nullable(),
      compteBanque: z.string().optional().nullable(),
      transactionId: z.string().uuid().optional().nullable(),
    }).parse(input),
  )
  .handler(({ data }): Promise<ResultatPaiementDgi> => executerPaiementDgi(getSupabase(), data));

export const pointerTvaPeriode = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({
      dossierId: z.string().uuid(), periode: periodeSchema, pointe: z.boolean(),
    }).parse(input),
  )
  .handler(({ data }): Promise<ResultatPointage> => executerPointageTva(getSupabase(), data));

export const enregistrerQuittanceTva = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({
      dossierId: z.string().uuid(), periode: periodeSchema,
      path: z.string().min(1), nom: z.string().optional().nullable(),
    }).parse(input),
  )
  .handler(({ data }): Promise<ResultatQuittance> => executerEnregistrementQuittance(getSupabase(), data));
