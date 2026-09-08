// ============================================================================
// factures-gl.functions.ts — Projection des factures DEPUIS le grand livre.
//
// Architecture Pennylane : la comptabilité est la source, `factures.montant_paye
// / montant_restant / statut_paiement` n'en est qu'une VUE MATÉRIALISÉE. Après
// tout événement de lettrage, on recalcule cette vue depuis les écritures et on
// n'écrit que les factures qui ont réellement bougé.
//
// Pourquoi ici plutôt que dans `executerLettrage` : ce module appelle `factures`
// et `factures_fournisseurs`, deux tables que le cœur du lettrage ne touche pas.
// Le brancher DANS le cœur mêlerait deux responsabilités et rendrait le lettrage
// dépendant d'un schéma facture. On le branche donc sur les PORTES D'ENTRÉE —
// c'est là que se situe la transaction métier « un règlement vient d'avoir lieu ».
//
// Ne jette JAMAIS : un lettrage réussi ne doit pas être annulé parce que la
// projection a échoué. L'échec est rendu dans `raison`.
// ============================================================================

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  projeterSituationFacture, situationDivergente, situationFactureGrandLivre,
  type LigneGrandLivre, type PieceReglement, type SituationFacture,
} from "@/lib/encours-grandlivre";

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

const COLS_GL = "id,journal_code,compte_numero,date_ecriture,debit,credit,reference_piece,lettrage_code,facture_id";

export interface FactureRealignee {
  table: "factures" | "factures_fournisseurs";
  id: string;
  numero: string | null;
  avant: { montant_paye: number; montant_restant: number; statut_paiement: string | null };
  apres: SituationFacture;
}

export interface ResultatSyncGL {
  ok: boolean;
  raison: string | null;
  /** Factures examinées, tous sens confondus. */
  examinees: number;
  /** Factures dont la projection divergeait du grand livre. */
  divergentes: FactureRealignee[];
  /** Factures effectivement réécrites (0 en simulation). */
  corrigees: number;
  simulation: boolean;
}

/**
 * CŒUR de la resynchronisation — testable, sans dépendance au runtime serveur.
 *
 * `simulation: true` calcule et rapporte sans rien écrire : c'est le mode du
 * script d'audit, et le seul honnête quand on découvre un dossier.
 */
export async function executerSyncFacturesGL(
  sb: any, data: { dossierId: string; simulation?: boolean },
): Promise<ResultatSyncGL> {
  const vide: ResultatSyncGL = {
    ok: true, raison: null, examinees: 0, divergentes: [], corrigees: 0,
    simulation: data.simulation === true,
  };

  try {
    const [{ data: ecr, error: eEcr }, { data: fc }, { data: ff }, { data: pai }] = await Promise.all([
      sb.from("ecritures_comptables").select(COLS_GL).eq("dossier_id", data.dossierId),
      sb.from("factures").select("id,numero,date_facture,montant_ttc,montant_paye,montant_restant,statut_paiement")
        .eq("dossier_id", data.dossierId),
      sb.from("factures_fournisseurs").select("id,numero,date_facture,montant_ttc,montant_paye,montant_restant,statut_paiement")
        .eq("dossier_id", data.dossierId),
      // Pièces de règlement formelles — la SECONDE preuve d'un encaissement.
      // Sans elles, une facture réglée mais jamais lettrée serait ramenée à
      // « non payée » et son règlement perdu (cf. projeterSituationFacture).
      sb.from("paiements").select("facture_id,facture_fournisseur_id,montant,date_paiement,transaction_id,encaissement_id,reference")
        .eq("dossier_id", data.dossierId),
    ]);
    if (eEcr) return { ...vide, ok: false, raison: eEcr.message };

    const lignes = (ecr ?? []) as LigneGrandLivre[];
    // Table `paiements` livrée par migration manuelle : absente, la requête
    // échoue et `pai` reste nul. On garde alors le seul grand livre.
    const piecesParFacture = new Map<string, PieceReglement[]>();
    for (const p of ((pai ?? []) as any[])) {
      const cle = String(p.facture_id ?? p.facture_fournisseur_id ?? "");
      if (!cle) continue;
      const l = piecesParFacture.get(cle) ?? [];
      l.push({
        montant: Number(p.montant ?? 0), date: p.date_paiement ?? null,
        // Identité de la pièce : sans elle, deux insertions de la même ligne de
        // relevé sont indiscernables et comptent double (cf. `clePaiement`).
        transaction_id: p.transaction_id ?? null,
        encaissement_id: p.encaissement_id ?? null,
        reference: p.reference ?? null,
      });
      piecesParFacture.set(cle, l);
    }
    const lots: { table: "factures" | "factures_fournisseurs"; sens: "client" | "fournisseur"; rows: any[] }[] = [
      { table: "factures", sens: "client", rows: (fc ?? []) as any[] },
      { table: "factures_fournisseurs", sens: "fournisseur", rows: (ff ?? []) as any[] },
    ];

    const divergentes: FactureRealignee[] = [];
    let examinees = 0;

    for (const lot of lots) {
      for (const f of lot.rows) {
        examinees++;
        const ttc = Number(f.montant_ttc ?? 0);
        const gl = situationFactureGrandLivre(lignes, {
          // Les ventes estampillent le NUMÉRO, les achats l'ID : on passe les deux.
          references: [f.numero, f.id], id: lot.sens === "client" ? f.id : null,
          montant_ttc: ttc, sens: lot.sens,
        });
        // Le grand livre dit ce qui est LETTRÉ ; les pièces disent ce qui a été
        // ENCAISSÉ. On retient la plus forte des deux preuves.
        // La `cible` porte la date d'émission : c'est elle qui permet d'écarter
        // une pièce ANTÉRIEURE à la facture, laquelle emportait sinon la
        // décision face à un grand livre correct (cas SMERT WATER).
        const apres = projeterSituationFacture(
          gl, piecesParFacture.get(String(f.id)) ?? [], ttc,
          { id: f.id, numero: f.numero, date_facture: f.date_facture },
        );
        // Une facture ABSENTE du grand livre n'est pas « non payée » : elle n'est
        // simplement pas comptabilisée. La réécrire effacerait un règlement saisi
        // avant sa comptabilisation — on la laisse donc telle quelle.
        if (!apres.trouvee) continue;

        const avant = {
          montant_paye: Number(f.montant_paye ?? 0),
          montant_restant: Number(f.montant_restant ?? 0),
          statut_paiement: f.statut_paiement ?? null,
        };
        if (!situationDivergente(avant, apres)) continue;
        divergentes.push({ table: lot.table, id: String(f.id), numero: f.numero ?? null, avant, apres });
      }
    }

    if (data.simulation) return { ...vide, divergentes, examinees };

    let corrigees = 0;
    for (const d of divergentes) {
      const patch: any = {
        montant_paye: d.apres.montant_paye,
        montant_restant: d.apres.montant_restant,
        statut_paiement: d.apres.statut_paiement,
      };
      // La date de règlement n'est écrasée que s'il y en a un : effacer celle
      // d'une facture qu'on vient de délettrer est correct, inventer une date
      // ne l'est pas.
      patch.date_paiement = d.apres.date_paiement;
      const { error } = await sb.from(d.table).update(patch).eq("id", d.id);
      if (!error) corrigees++;
    }

    return { ...vide, divergentes, examinees, corrigees };
  } catch (e: any) {
    // Schéma partiel (colonnes de lettrage non migrées) → on le dit, on ne casse pas.
    return { ...vide, ok: false, raison: String(e?.message ?? e) };
  }
}

/**
 * Version « au fil de l'eau », à greffer après un lettrage / délettrage.
 * Avale tout : elle ne doit jamais faire échouer l'opération qu'elle suit.
 */
export async function synchroniserApresLettrage(sb: any, dossierId: string): Promise<ResultatSyncGL | null> {
  try {
    return await executerSyncFacturesGL(sb, { dossierId });
  } catch (e: any) {
    console.warn("[SYNC GL] projection des factures ignorée :", e?.message ?? e);
    return null;
  }
}

/** Porte d'entrée HTTP — resynchronisation manuelle d'un dossier. */
export const synchroniserFacturesGrandLivre = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({
      dossierId: z.string().uuid(),
      /** `true` = rapport seul, aucune écriture. */
      simulation: z.boolean().optional(),
    }).parse(input),
  )
  .handler(({ data }): Promise<ResultatSyncGL> => executerSyncFacturesGL(getSupabase(), data));
