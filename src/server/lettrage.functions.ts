// ============================================================================
// lettrage.functions.ts — Moteur de lettrage continu (Chantier 2)
//
// Migre la logique déterministe de handleRematcher (auparavant dans le client
// banque.tsx) vers une server function partagée, appelable par événements :
//   • Sens A : après enregistrement d'un relevé  → lettrerDossier({ dossierId, releveId })
//   • Sens B : après upload d'une facture/justif → lettrerDossier({ dossierId, nouveauDoc })
//
// L'écriture passe TOUJOURS par la RPC atomique `lier_transaction` (WHERE
// facture_id IS NULL) → idempotence + anti-concurrence + anti-double-paiement.
// ============================================================================

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

function getSupabase() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    "";
  return createClient(url, key);
}

export type DocKind = "facture_client" | "facture_fournisseur" | "justificatif";
export type MatchResult = { kind: DocKind; id: string } | null;

// ─── Matcher PUR (déterministe, testable) ────────────────────────────────────
// Port fidèle de handleRematcher : montant ±1 MAD + mot-clé du tiers dans le
// libellé + garde mode de règlement / date chèque, puis repli « montant exact
// unique » réservé aux transactions déjà rapprochées (re-lettrage a posteriori).
export function matchTransactionDeterministe(
  tx: { type: string; libelle?: string | null; montant: number; date_operation?: string; rapproche?: boolean; statut?: string },
  cand: { facturesClient: any[]; facturesFourn: any[]; justificatifs: any[] },
  used: { fc: Set<string>; ff: Set<string>; j: Set<string> },
): MatchResult {
  const isCr = tx.type === "credit";
  const libUp = (tx.libelle || "").toUpperCase();
  const isChequeTx = libUp.includes("CHEQUE") || libUp.includes("CHQ");
  const amt = Number(tx.montant);
  const wordHit = (nom: string) =>
    nom.split(/\s+/).filter((w: string) => w.length >= 3).some((w: string) => libUp.includes(w));

  if (isCr) {
    const m = cand.facturesClient.find((f) => {
      if (used.fc.has(f.id)) return false;
      const ttc = Number(f.montant_ttc), restant = Number(f.montant_restant ?? f.montant_ttc);
      if (Math.abs(amt - ttc) >= 1 && Math.abs(amt - restant) >= 1) return false;
      const nom = (f.clients?.nom || "").toUpperCase();
      return !nom || wordHit(nom);
    });
    if (m) return { kind: "facture_client", id: m.id };
  } else {
    const m = cand.facturesFourn.find((f) => {
      if (used.ff.has(f.id)) return false;
      const ttc = Number(f.montant_ttc), restant = Number(f.montant_restant ?? f.montant_ttc);
      if (Math.abs(amt - ttc) >= 1 && Math.abs(amt - restant) >= 1) return false;
      const fourn = (f.fournisseur_nom || "").toUpperCase();
      if (!fourn) return true;
      const mr = (f.mode_reglement || "").toLowerCase();
      if (isChequeTx && (mr === "virement" || mr === "carte")) return false;
      if (isChequeTx) {
        try {
          const raw = String(tx.date_operation || "");
          const txD = new Date(raw.includes("/") ? raw.split("/").reverse().join("-") : raw);
          const ref = f.date_echeance || f.date_facture;
          if (ref && !isNaN(txD.getTime())) {
            const diff = Math.abs(txD.getTime() - new Date(ref).getTime()) / 86400000;
            return diff <= 60;
          }
        } catch { /* date illisible → on n'écarte pas sur ce critère */ }
        return true;
      }
      const modeOk = !f.mode_reglement
        || (libUp.includes(" CB ") && mr === "carte")
        || (libUp.includes("VIR") && mr === "virement")
        || (!libUp.includes("CHEQUE") && !libUp.includes(" CB ") && !libUp.includes("VIR"));
      return wordHit(fourn) && modeOk;
    });
    if (m) return { kind: "facture_fournisseur", id: m.id };
  }

  // Justificatifs (BC / BL / reçu / avis) — montant ±1 + mot-clé tiers
  const mj = cand.justificatifs.find((j) => {
    if (used.j.has(j.id)) return false;
    if (Math.abs(amt - Number(j.montant_ttc)) >= 1) return false;
    const nom = (j.nom_tiers || "").toUpperCase();
    return !nom || wordHit(nom);
  });
  if (mj) return { kind: "justificatif", id: mj.id };

  // Repli « montant exact unique » — uniquement pour transactions déjà rapprochées
  // (relink a posteriori), JAMAIS pour une transaction neuve → évite le sur-matching.
  if (tx.rapproche || tx.statut === "ferme") {
    if (isCr) {
      const c = cand.facturesClient.filter((f) => !used.fc.has(f.id)
        && (Math.abs(amt - Number(f.montant_ttc)) < 1 || Math.abs(amt - Number(f.montant_restant ?? f.montant_ttc)) < 1));
      if (c.length === 1) return { kind: "facture_client", id: c[0].id };
    } else {
      const c = cand.facturesFourn.filter((f) => !used.ff.has(f.id)
        && (Math.abs(amt - Number(f.montant_ttc)) < 1 || Math.abs(amt - Number(f.montant_restant ?? f.montant_ttc)) < 1));
      if (c.length === 1) return { kind: "facture_fournisseur", id: c[0].id };
    }
    const cj = cand.justificatifs.filter((j) => !used.j.has(j.id) && Math.abs(amt - Number(j.montant_ttc)) < 1);
    if (cj.length === 1) return { kind: "justificatif", id: cj[0].id };
  }

  return null;
}

// ─── Server function : lettrerDossier ────────────────────────────────────────
export const lettrerDossier = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({
      dossierId: z.string().uuid(),
      // Sens A : restreint le lettrage aux transactions du relevé qu'on vient d'enregistrer.
      releveId: z.string().uuid().optional(),
      // Sens B : un seul nouveau document à confronter aux transactions en attente.
      nouveauDoc: z.object({
        id: z.string().uuid(),
        kind: z.enum(["facture_client", "facture_fournisseur", "justificatif"]),
      }).optional(),
    }).parse(input)
  )
  .handler(async ({ data }) => {
    const supabase = getSupabase();

    // 1) Cibles : transactions du dossier encore orphelines.
    // Les clôturées orphelines (parquées sur compte d'attente 4711/4712) sont
    // INCLUSES → lettrage tardif permis ; le RPC conserve leur statut 'cloture'
    // et le trigger SQL bascule le compte d'attente vers le compte final.
    let q = (supabase.from("transactions_bancaires") as any)
      .select("id,date_operation,libelle,type,montant,statut,rapproche,reference")
      .eq("dossier_id", data.dossierId)
      .is("facture_id", null)
      .is("justificatif_id", null);
    if (data.releveId) q = q.eq("releve_id", data.releveId);
    const { data: txCibles, error: txErr } = await q;
    if (txErr) throw txErr;
    if (!txCibles?.length) return { lies: 0, details: [] as Array<{ txId: string; kind: DocKind; docId: string }> };

    // 2) Candidats. Sens B → un seul document ; Sens A → tous les documents ouverts.
    const cand = { facturesClient: [] as any[], facturesFourn: [] as any[], justificatifs: [] as any[] };
    if (data.nouveauDoc) {
      const { id, kind } = data.nouveauDoc;
      if (kind === "facture_client") {
        const { data: d } = await (supabase as any).from("factures")
          .select("id,numero,montant_ttc,montant_paye,montant_restant,date_facture,date_echeance,mode_reglement,clients(id,nom)")
          .eq("id", id).maybeSingle();
        if (d) cand.facturesClient = [d];
      } else if (kind === "facture_fournisseur") {
        const { data: d } = await (supabase as any).from("factures_fournisseurs")
          .select("id,numero,montant_ttc,montant_paye,montant_restant,date_facture,date_echeance,fournisseur_nom,mode_reglement")
          .eq("id", id).maybeSingle();
        if (d) cand.facturesFourn = [d];
      } else {
        const { data: d } = await (supabase as any).from("justificatifs")
          .select("id,montant_ttc,nom_tiers,type_document,statut")
          .eq("id", id).maybeSingle();
        if (d) cand.justificatifs = [d];
      }
    } else {
      const [{ data: fc }, { data: ff }, { data: j }] = await Promise.all([
        (supabase as any).from("factures")
          .select("id,numero,montant_ttc,montant_paye,montant_restant,date_facture,date_echeance,mode_reglement,clients(id,nom)")
          .eq("dossier_id", data.dossierId).eq("statut", "conforme"),
        (supabase as any).from("factures_fournisseurs")
          .select("id,numero,montant_ttc,montant_paye,montant_restant,date_facture,date_echeance,fournisseur_nom,mode_reglement")
          .eq("dossier_id", data.dossierId),
        (supabase as any).from("justificatifs")
          .select("id,montant_ttc,nom_tiers,type_document,statut")
          .eq("dossier_id", data.dossierId),
      ]);
      cand.facturesClient = fc ?? [];
      cand.facturesFourn = ff ?? [];
      cand.justificatifs = j ?? [];
    }

    // 3) Matching déterministe + écriture atomique (RPC). Dédup intra-lot via `used`.
    const used = { fc: new Set<string>(), ff: new Set<string>(), j: new Set<string>() };
    const details: Array<{ txId: string; kind: DocKind; docId: string }> = [];

    for (const tx of txCibles) {
      const m = matchTransactionDeterministe(tx, cand, used);
      if (!m) continue;
      const { data: ok, error } = await (supabase as any).rpc("lier_transaction", {
        p_tx_id: tx.id, p_doc_id: m.id, p_doc_kind: m.kind,
      });
      if (error) throw error;
      if (ok === true) {
        if (m.kind === "facture_client") used.fc.add(m.id);
        else if (m.kind === "facture_fournisseur") used.ff.add(m.id);
        else used.j.add(m.id);
        details.push({ txId: tx.id, kind: m.kind, docId: m.id });
      }
    }

    return { lies: details.length, details };
  });
