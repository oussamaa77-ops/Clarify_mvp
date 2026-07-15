// ============================================================================
// paiements.functions.ts — Annulation du paiement d'une facture (client OU fournisseur).
//
// Une facture peut être marquée payée par TROIS chemins distincts, qui laissent
// chacun une trace différente. L'annulation doit défaire exactement la bonne :
//
//   1. Bouton « Payée » (marquerPayee, clients seulement) → 2 écritures journal BQ
//      portant facture_id.
//   2. Encaissement espèces/chèque → 1 ligne `encaissements` + 2 écritures journal
//      CAI (espèces) ou BQ (chèque). Depuis handleEncaissement, ces écritures sont
//      ESTAMPILLÉES : facture_id pour un client, reference_piece pour un fournisseur
//      (la FK ecritures_comptables.facture_id → factures interdit d'y mettre un id
//      de facture fournisseur). Les écritures antérieures à cet estampillage sont
//      retrouvées par un repli journal + date + montant + comptes.
//   3. Lettrage d'un relevé bancaire → `transactions_bancaires.facture_id` posé par
//      la RPC lier_transaction (+ écritures estampillées transaction_id).
//
// RÈGLE MÉTIER CENTRALE : la ligne du relevé bancaire est un fait bancaire, elle
// n'est JAMAIS supprimée. On se contente de la délettrer (facture_id → NULL) pour
// qu'elle redevienne « à lettrer ». Seuls l'encaissement saisi à la main et les
// écritures de RÈGLEMENT sont supprimés — jamais l'écriture de VENTE (journal VTE)
// ni celle d'ACHAT (journal ACH) : d'où le filtre sur journal_code partout.
// ============================================================================

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let PROXY_DIRECT = false;
async function proxyFetch(input: any, init?: any): Promise<Response> {
  if (PROXY_DIRECT) {
    const { fetch: uf, Agent } = await import("undici");
    return (uf as any)(String(input), { ...init, dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) });
  }
  try { return await fetch(String(input), init); }
  catch {
    PROXY_DIRECT = true;
    const { fetch: uf, Agent } = await import("undici");
    return (uf as any)(String(input), { ...init, dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) });
  }
}
function getSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (i: any, init?: any) => proxyFetch(i, init) } });
}

// Journaux de TRÉSORERIE. Une écriture de règlement y vit ; la vente est en VTE, l'achat en ACH.
// C'est le SEUL discriminant sûr : les numéros de compte réels divergent du code
// (caisse en 5161 en base, 5143 dans handleEncaissement), donc on ne filtre jamais dessus.
const JOURNAUX_REGLEMENT = ["BQ", "CAI"];

export interface AnnulationPaiement {
  ok: boolean;
  dejaImpayee: boolean;
  txDeliees: number;              // lignes de relevé délettrées (jamais supprimées)
  encaissementsSupprimes: number;
  ecrituresSupprimees: number;
}

export const annulerPaiementFacture = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({
      facture_id: z.string().uuid(),
      type: z.enum(["client", "fournisseur"]).default("client"),
    }).parse(input)
  )
  .handler(async ({ data }): Promise<AnnulationPaiement> => {
    const sb = getSupabase();
    const estClient = data.type === "client";
    const table = estClient ? "factures" : "factures_fournisseurs";
    const colEncaissement = estClient ? "facture_id" : "facture_fournisseur_id";

    const { data: f, error: eF } = await (sb as any)
      .from(table).select("id,dossier_id,montant_ttc,statut_paiement").eq("id", data.facture_id).single();
    if (eF || !f) throw new Error("Facture introuvable");

    if (f.statut_paiement === "non_payee") {
      return { ok: true, dejaImpayee: true, txDeliees: 0, encaissementsSupprimes: 0, ecrituresSupprimees: 0 };
    }

    let txDeliees = 0, encaissementsSupprimes = 0, ecrituresSupprimees = 0;
    const supprimerEcritures = async (ids: string[], quoi: string) => {
      if (!ids.length) return;
      const { error } = await (sb as any).from("ecritures_comptables").delete().in("id", ids);
      if (error) throw new Error(`Suppression des écritures ${quoi} impossible : ${error.message}`);
      ecrituresSupprimees += ids.length;
    };

    // ── 1. Relevé bancaire : DÉLETTRAGE (la transaction reste en base) ────────
    // transactions_bancaires.facture_id porte aussi bien un id client qu'un id
    // fournisseur ; document_type tranche. Les ids étant uniques, le filtre suffit.
    const { data: txs } = await (sb as any)
      .from("transactions_bancaires").select("id,statut").eq("facture_id", f.id);
    for (const tx of (txs ?? []) as { id: string; statut: string | null }[]) {
      // Dé-estampiller les écritures rapprochées via cette transaction. `lettree`
      // n'existe pas sur toutes les bases → repli sur la seule colonne critique.
      const { error: eEcr } = await (sb as any).from("ecritures_comptables")
        .update({ transaction_id: null, lettree: false, date_lettrage: null }).eq("transaction_id", tx.id);
      if (eEcr) await (sb as any).from("ecritures_comptables").update({ transaction_id: null }).eq("transaction_id", tx.id);

      // Une période clôturée le reste : on ne rouvre que les transactions « fermées ».
      const { error: eTx } = await (sb as any).from("transactions_bancaires").update({
        facture_id: null, document_type: null, rapproche: false,
        statut: tx.statut === "cloture" ? "cloture" : "ouvert",
      }).eq("id", tx.id);
      if (eTx) throw new Error(`Délettrage impossible : ${eTx.message}`);
      txDeliees++;
    }

    // ── 2. Écritures de RÈGLEMENT estampillées (bouton « Payée » + encaissements) ──
    // Ciblage EXACT par l'ancre de la facture. Le filtre journal_code est impératif :
    // l'écriture de VENTE porte aussi facture_id, et on ne doit jamais y toucher.
    const qEstamp = (sb as any).from("ecritures_comptables").select("id")
      .eq("dossier_id", f.dossier_id).in("journal_code", JOURNAUX_REGLEMENT);
    const { data: estampillees } = estClient
      ? await qEstamp.eq("facture_id", f.id)
      : await qEstamp.eq("reference_piece", f.id);
    const idsEstampilles = ((estampillees ?? []) as any[]).map((x) => x.id);
    await supprimerEcritures(idsEstampilles, "de règlement");

    // ── 3. Encaissements espèces/chèque ──────────────────────────────────────
    // Leurs écritures sont déjà parties si elles étaient estampillées. Sinon (lignes
    // antérieures à l'estampillage) : repli journal + date + montant, borné aux
    // écritures SANS aucun rattachement, et discriminé par le libellé — c'est lui qui
    // porte la référence de la facture (« Paiement 24-0892 »), seul moyen de séparer
    // deux encaissements de même date et même montant.
    //
    // Aucun filtre sur compte_numero : le plan comptable réel diverge du code (caisse
    // en 5161, pas 5143), et un mauvais filtre ne supprimerait qu'une moitié de
    // l'écriture — laissant une contrepartie orpheline, donc un journal déséquilibré.
    //
    // Ce repli est désactivé dès qu'une estampille a été trouvée, pour qu'un second
    // encaissement de la même facture n'aille pas piocher au hasard.
    const { data: encs } = await (sb as any).from("encaissements").select("*").eq(colEncaissement, f.id);
    for (const e of (encs ?? []) as any[]) {
      if (!idsEstampilles.length) {
        let q = (sb as any).from("ecritures_comptables")
          .select("id,debit,credit")
          .eq("dossier_id", f.dossier_id).eq("journal_code", e.type === "especes" ? "CAI" : "BQ")
          .eq("date_ecriture", e.date_encaissement)
          .is("facture_id", null).is("reference_piece", null).is("transaction_id", null);
        if (e.libelle) q = q.eq("libelle", e.libelle);
        const { data: cand } = await q.order("created_at");

        const montant = Number(e.montant);
        const colle = (v: any) => Math.abs(Number(v ?? 0) - montant) < 0.005;
        // L'encaissement génère exactement 2 lignes : un débit trésorerie et un crédit
        // tiers. On prend la première de chaque sens, jamais deux fois le même.
        const debit = ((cand ?? []) as any[]).find((x) => colle(x.debit));
        const credit = ((cand ?? []) as any[]).find((x) => colle(x.credit));
        await supprimerEcritures([debit?.id, credit?.id].filter(Boolean) as string[], "d'encaissement");
      }
      const { error: eDel } = await (sb as any).from("encaissements").delete().eq("id", e.id);
      if (eDel) throw new Error(`Suppression de l'encaissement impossible : ${eDel.message}`);
      encaissementsSupprimes++;
    }

    // ── 4. Effacer les paiements de la facture (le trigger la remet à jour) ───
    // La table `paiements` est désormais la source de vérité : on supprime les lignes
    // de cette facture, et le trigger paiements_resync recalcule montant_paye/restant/
    // statut. Repli avant migration (table absente) : remise à zéro directe comme avant.
    const colPaiement = estClient ? "facture_id" : "facture_fournisseur_id";
    const { error: eDelPaie } = await (sb as any).from("paiements").delete().eq(colPaiement, f.id);
    if (eDelPaie) {
      const { error: eMaj } = await (sb as any).from(table).update({
        statut_paiement: "non_payee", montant_paye: 0,
        montant_restant: Number(f.montant_ttc), date_paiement: null,
      }).eq("id", f.id);
      if (eMaj) throw new Error(`Mise à jour de la facture impossible : ${eMaj.message}`);
    }

    return { ok: true, dejaImpayee: false, txDeliees, encaissementsSupprimes, ecrituresSupprimees };
  });
