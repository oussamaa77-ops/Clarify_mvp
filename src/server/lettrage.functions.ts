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
import { CLIENT_PREFIXES, FOURNISSEUR_PREFIXES } from "@/lib/import-grandlivre";

function getSupabase() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    "";
  return createClient(url, key);
}

export type DocKind = "facture_client" | "facture_fournisseur" | "justificatif" | "ecriture";
export type MatchResult = { kind: DocKind; id: string } | null;

// ─── Postes ouverts du Grand Livre importé (créances 342x / dettes 441x) ─────
// Un « poste ouvert » = le résidu NON soldé d'une pièce comptable sur un compte
// auxiliaire. On nette par pièce (reference_piece) pour ne pas proposer au lettrage
// une facture déjà réglée à l'intérieur même du Grand Livre.
export interface OpenLedgerItem {
  id: string;        // clé de groupe (compte|pièce) — sert au dédup et au stamping
  ids: string[];     // ids des écritures ouvertes du groupe (à estampiller transaction_id)
  type: "client" | "fournisseur";
  libelle: string;   // libellé représentatif (côté facture) → mot-clé tiers
  montant: number;   // résidu > 0 : créance = Σdébit−Σcrédit ; dette = Σcrédit−Σdébit
}

export function buildOpenItems(
  rows: Array<{
    id: string; compte_numero: string | null; libelle: string | null;
    debit: number | string | null; credit: number | string | null; reference_piece: string | null;
  }>,
): { open: OpenLedgerItem[]; settledIds: string[] } {
  const groups = new Map<string, { ids: string[]; type: "client" | "fournisseur"; libelle: string; debit: number; credit: number }>();
  for (const r of rows) {
    const c = (r.compte_numero ?? "").trim();
    if (!c) continue;
    // Fournisseurs (441x) testés avant clients (342x) — préfixes disjoints, ordre indifférent.
    const type: "client" | "fournisseur" | null =
      FOURNISSEUR_PREFIXES.some((p) => c.startsWith(p)) ? "fournisseur"
      : CLIENT_PREFIXES.some((p) => c.startsWith(p)) ? "client"
      : null;
    if (!type) continue;
    const piece = (r.reference_piece ?? "").trim();
    // Groupé par pièce pour netter une même facture ; sans pièce → chaque ligne est son propre poste.
    const key = piece ? `${c}|${piece}` : `${c}|#${r.id}`;
    const g = groups.get(key) ?? { ids: [], type, libelle: "", debit: 0, credit: 0 };
    g.ids.push(r.id);
    g.debit += Number(r.debit ?? 0);
    g.credit += Number(r.credit ?? 0);
    // Libellé représentatif = ligne côté facture (débit pour un client, crédit pour un fournisseur).
    const invoiceSide = type === "client" ? Number(r.debit ?? 0) > 0 : Number(r.credit ?? 0) > 0;
    if (!g.libelle && invoiceSide) g.libelle = (r.libelle ?? "").trim();
    groups.set(key, g);
  }
  const open: OpenLedgerItem[] = [];
  const settledIds: string[] = [];
  for (const [key, g] of groups) {
    const residual = g.type === "client" ? g.debit - g.credit : g.credit - g.debit;
    if (Math.abs(residual) <= 0.01) {
      // Pièce équilibrée dans le GL (déjà réglée) → à archiver (netting), pas un candidat.
      settledIds.push(...g.ids);
    } else if (residual > 0.01) {
      open.push({ id: key, ids: g.ids, type: g.type, libelle: g.libelle, montant: Number(residual.toFixed(2)) });
    }
    // residual < 0 (sens inverse : avance/avoir) → ni candidat ni archivé pour le MVP.
  }
  return { open, settledIds };
}

// ─── Matcher PUR (déterministe, testable) ────────────────────────────────────
// Port fidèle de handleRematcher : montant ±1 MAD + mot-clé du tiers dans le
// libellé + garde mode de règlement / date chèque, puis repli « montant exact
// unique » réservé aux transactions déjà rapprochées (re-lettrage a posteriori).
export function matchTransactionDeterministe(
  tx: { type: string; libelle?: string | null; montant: number; date_operation?: string; rapproche?: boolean; statut?: string; estPasse?: boolean },
  cand: { facturesClient: any[]; facturesFourn: any[]; justificatifs: any[]; ecrituresOuvertes?: OpenLedgerItem[] },
  used: { fc: Set<string>; ff: Set<string>; j: Set<string>; e?: Set<string> },
): MatchResult {
  const isCr = tx.type === "credit";
  const libUp = (tx.libelle || "").toUpperCase();
  const isChequeTx = libUp.includes("CHEQUE") || libUp.includes("CHQ");
  const amt = Number(tx.montant);
  const wordHit = (nom: string) =>
    nom.split(/\s+/).filter((w: string) => w.length >= 3).some((w: string) => libUp.includes(w));

  // ── Sources de candidats, chacune renvoie un MatchResult ou null ──────────────
  const tryFactures = (): MatchResult => {
    if (isCr) {
      const m = cand.facturesClient.find((f) => {
        if (used.fc.has(f.id)) return false;
        const ttc = Number(f.montant_ttc), restant = Number(f.montant_restant ?? f.montant_ttc);
        if (Math.abs(amt - ttc) >= 1 && Math.abs(amt - restant) >= 1) return false;
        const nom = (f.clients?.nom || "").toUpperCase();
        return !nom || wordHit(nom);
      });
      return m ? { kind: "facture_client", id: m.id } : null;
    }
    const mf = cand.facturesFourn.find((f) => {
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
    return mf ? { kind: "facture_fournisseur", id: mf.id } : null;
  };

  // Justificatifs (BC / BL / reçu / avis) — montant ±1 + mot-clé tiers
  const tryJustificatifs = (): MatchResult => {
    const mj = cand.justificatifs.find((j) => {
      if (used.j.has(j.id)) return false;
      if (Math.abs(amt - Number(j.montant_ttc)) >= 1) return false;
      const nom = (j.nom_tiers || "").toUpperCase();
      return !nom || wordHit(nom);
    });
    return mj ? { kind: "justificatif", id: mj.id } : null;
  };

  // Écritures ouvertes du Grand Livre importé (créances 342x / dettes 441x nettées).
  // Permet de lettrer SANS facture physique. Réservée aux transactions non encore
  // rapprochées → une fois lettrée (rapproche=true), plus jamais reprise (idempotent).
  const tryEcritures = (): MatchResult => {
    if (tx.rapproche) return null;
    const open = cand.ecrituresOuvertes ?? [];
    const usedE = used.e ?? new Set<string>();
    const wantType = isCr ? "client" : "fournisseur"; // crédit = encaissement client ; débit = paiement fournisseur
    const mo = open.find((o) => {
      if (usedE.has(o.id)) return false;
      if (o.type !== wantType) return false;
      if (Math.abs(amt - o.montant) >= 1) return false;
      const nom = (o.libelle || "").toUpperCase();
      return !nom || wordHit(nom);
    });
    return mo ? { kind: "ecriture", id: mo.id } : null;
  };

  // Repli « montant exact unique » — uniquement pour transactions déjà rapprochées
  // (relink a posteriori), JAMAIS pour une transaction neuve → évite le sur-matching.
  const tryRepli = (): MatchResult => {
    if (!(tx.rapproche || tx.statut === "ferme")) return null;
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
    return null;
  };

  // ── Ordre de priorité selon PASSÉ / PRÉSENT (arbitrage Pennylane/Odoo) ────────
  //  • PASSÉ (migration, avant date de reprise) : écriture GL prioritaire — valide
  //    les soldes de départ sans exiger le scan des vieilles factures.
  //  • PRÉSENT (flux courant) : facture / justificatif OCR prioritaire, l'écriture
  //    GL ne servant que de secours (piste d'audit à compléter par un PDF).
  const ordre = tx.estPasse
    ? [tryEcritures, tryFactures, tryJustificatifs, tryRepli]
    : [tryFactures, tryJustificatifs, tryEcritures, tryRepli];
  for (const source of ordre) {
    const r = source();
    if (r) return r;
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

    // Date de reprise du dossier → arbitrage PASSÉ (migration) / PRÉSENT (flux courant).
    // Absente (migration non appliquée / non renseignée) → tout est « présent » (facture OCR prioritaire).
    let dateReprise: string | null = null;
    try {
      const { data: dos } = await (supabase as any).from("dossiers")
        .select("date_reprise").eq("id", data.dossierId).maybeSingle();
      dateReprise = dos?.date_reprise ?? null;
    } catch { /* colonne absente → pas d'arbitrage passé/présent */ }
    const estPasse = (dateOp?: string | null): boolean =>
      !!dateReprise && !!dateOp && String(dateOp) < String(dateReprise);

    // 2) Candidats. Sens B → un seul document ; Sens A → tous les documents ouverts.
    const cand = { facturesClient: [] as any[], facturesFourn: [] as any[], justificatifs: [] as any[], ecrituresOuvertes: [] as OpenLedgerItem[] };
    const openByKey = new Map<string, OpenLedgerItem>();
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

      // 4e source : postes ouverts du Grand Livre importé (écritures 342x/441x non
      // encore lettrées = transaction_id NULL). Nettés par pièce pour éviter les
      // doublons internes au GL. Absents du Sens B (nouveauDoc) — non pertinents là.
      const { data: ecr } = await (supabase as any).from("ecritures_comptables")
        .select("id,compte_numero,libelle,debit,credit,reference_piece,lettree")
        .eq("dossier_id", data.dossierId)
        .is("transaction_id", null);
      // Exclut les pièces déjà archivées (netting antérieur) si la colonne existe.
      const ouvertes = (ecr ?? []).filter((r: any) => r.lettree !== true);
      const { open, settledIds } = buildOpenItems(ouvertes);
      cand.ecrituresOuvertes = open;
      for (const o of open) openByKey.set(o.id, o);

      // NETTING : archive automatiquement les pièces déjà soldées dans le GL
      // (débit facture = crédit règlement) → elles ne réapparaissent plus en candidat.
      if (settledIds.length) {
        try {
          await (supabase as any).from("ecritures_comptables")
            .update({ lettree: true, date_lettrage: new Date().toISOString() })
            .in("id", settledIds);
        } catch { /* colonne lettree absente (migration non appliquée) → ignore */ }
      }
    }

    // 3) Matching déterministe + écriture atomique. Dédup intra-lot via `used`.
    const used = { fc: new Set<string>(), ff: new Set<string>(), j: new Set<string>(), e: new Set<string>() };
    const details: Array<{ txId: string; kind: DocKind; docId: string }> = [];

    for (const tx of txCibles) {
      // Arbitrage passé/présent injecté au matcher (réordonne les sources de candidats).
      const m = matchTransactionDeterministe({ ...tx, estPasse: estPasse(tx.date_operation) }, cand, used);
      if (!m) continue;

      // Poste ouvert du Grand Livre : lettrage par estampillage de transaction_id
      // sur les écritures du groupe (WHERE transaction_id IS NULL → idempotent).
      // Pas de RPC lier_transaction (réservée aux factures : elle pose facture_id).
      if (m.kind === "ecriture") {
        const item = openByKey.get(m.id);
        if (!item) continue;
        const { error: eStamp } = await (supabase as any).from("ecritures_comptables")
          .update({ transaction_id: tx.id })   // lien critique (existe depuis bank_suspense)
          .in("id", item.ids)
          .is("transaction_id", null);
        if (eStamp) throw eStamp;
        // Archive le poste (best-effort : colonne lettree absente si migration non appliquée).
        try {
          await (supabase as any).from("ecritures_comptables")
            .update({ lettree: true, date_lettrage: new Date().toISOString() }).in("id", item.ids);
        } catch { /* colonne lettree absente → ignore */ }
        // Reflète le rapprochement côté transaction (sans facture_id) → sort de cette branche ensuite.
        await (supabase as any).from("transactions_bancaires").update({ rapproche: true }).eq("id", tx.id);
        used.e.add(m.id);
        details.push({ txId: tx.id, kind: "ecriture", docId: m.id });
        continue;
      }

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

// ─── getRapprochementGL : données pour l'UI Banque (candidats GL + audit) ──────
// Renvoie les postes ouverts du Grand Livre (candidats « secours/migration »), la
// liste des transactions déjà liées à une écriture GL (pour l'encadré « justificatif
// manquant »), et la date de reprise (pour distinguer passé/présent côté UI).
export const getRapprochementGL = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ dossierId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }) => {
    const sb = getSupabase();
    try {
      const [{ data: ecr }, { data: liens }, { data: dos }] = await Promise.all([
        (sb as any).from("ecritures_comptables")
          .select("id,compte_numero,libelle,debit,credit,reference_piece,lettree")
          .eq("dossier_id", data.dossierId).is("transaction_id", null),
        (sb as any).from("ecritures_comptables")
          .select("transaction_id").eq("dossier_id", data.dossierId).not("transaction_id", "is", null),
        (sb as any).from("dossiers").select("date_reprise").eq("id", data.dossierId).maybeSingle(),
      ]);
      const ouvertes = (ecr ?? []).filter((r: any) => r.lettree !== true);
      const { open } = buildOpenItems(ouvertes);
      const ledgerTxIds: string[] = Array.from(
        new Set((liens ?? []).map((r: any) => String(r.transaction_id)).filter(Boolean)),
      );
      const dateReprise: string | null = dos?.date_reprise ?? null;
      return { ok: true as const, open, ledgerTxIds, dateReprise, reason: null as string | null };
    } catch (e: any) {
      // Migration non appliquée (colonnes absentes) → dégrade sans casser l'UI.
      return { ok: false as const, open: [] as OpenLedgerItem[], ledgerTxIds: [] as string[], dateReprise: null as string | null, reason: String(e?.message ?? e) };
    }
  });

// ─── lierTransactionEcriture : lettrage manuel tx ↔ poste ouvert du GL ─────────
// Estampille transaction_id (+ archive lettree) sur les écritures du poste, et
// marque la transaction rapprochée. Pas de facture_id (pas de pièce OCR) → l'UI
// affichera l'encadré « justificatif manquant » pour compléter la piste d'audit.
export const lierTransactionEcriture = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({
      dossierId: z.string().uuid(),
      txId: z.string().uuid(),
      ecritureIds: z.array(z.string().uuid()).min(1),
      cloture: z.boolean().optional(),
    }).parse(input),
  )
  .handler(async ({ data }) => {
    const sb = getSupabase();
    const { error: eStamp, count } = await (sb as any).from("ecritures_comptables")
      .update({ transaction_id: data.txId }, { count: "exact" })
      .in("id", data.ecritureIds)
      .eq("dossier_id", data.dossierId)
      .is("transaction_id", null);
    if (eStamp) return { ok: false as const, reason: eStamp.message };
    try {
      await (sb as any).from("ecritures_comptables")
        .update({ lettree: true, date_lettrage: new Date().toISOString() }).in("id", data.ecritureIds);
    } catch { /* colonne lettree absente → ignore */ }
    await (sb as any).from("transactions_bancaires")
      .update({ rapproche: true, statut: data.cloture ? "cloture" : "ferme" })
      .eq("id", data.txId).eq("dossier_id", data.dossierId);
    return { ok: true as const, stamped: count ?? data.ecritureIds.length };
  });
