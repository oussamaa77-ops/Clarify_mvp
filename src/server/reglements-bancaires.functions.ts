// ============================================================================
// reglements-bancaires.functions.ts — Ce que le rapprochement bancaire doit
// produire au grand livre, une fois la ligne de relevé liée à ses factures.
//
// Le rapprochement (lier_transaction / ventiler_transaction) crée des PAIEMENTS.
// La clôture du relevé crée l'écriture BQ. Rien ne garantissait que les deux se
// rejoignent : la ligne de tiers de l'écriture BQ portait le libellé de la
// banque en référence, une seule ligne pour plusieurs factures, et la TVA d'un
// encaissement partiel ne devenait jamais exigible (seul un lettrage ÉQUILIBRÉ
// la basculait). `comptabiliserReglementsBancaires` referme ces trois trous, en
// une passe idempotente qu'on peut rejouer après chaque clôture ou liaison :
//
//   1. RATTACHER   la ligne de tiers BQ à la pièce qu'elle règle (référence,
//                  compte auxiliaire, facture_id) — et la DÉCOUPER en une ligne
//                  par facture quand la ligne de relevé est ventilée ;
//   2. LETTRER     ce qui se solde désormais (executerLettrageAuto) ;
//   3. RATTRAPER   la TVA des encaissements partiels, versement par versement,
//                  datée de chaque versement (art. 95 CGI, régime des
//                  encaissements). Contrepasser si un paiement a été délié.
// ============================================================================

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { COMPTES_TVA, construireBasculeTva, sensDuCompte, type SensTiers } from "@/services/lettrage";
import { memeCompte, normaliserComptesLignes, normaliserNumeroCompte } from "@/lib/numero-compte";
import { bornesPeriode } from "@/lib/liquidation-tva";
import { COMPTE_COLLECTIF } from "@/lib/comptes-auxiliaires";
import {
  lignesTiersVentilees, planifierRattrapageTva, proposerVentilation,
  type CiblePart, type FactureOuverte, type PartVentilation,
} from "@/lib/ventilation";
import {
  basculerTvaSurReglement, executerLettrageAuto, insererPiece, tvaEnAttenteDeLaPiece,
} from "./lettrage-compta.functions";
import { synchroniserApresLettrage } from "./factures-gl.functions";
import { proxyFetch } from "./proxy-fetch";

function getSupabase() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    "";
  return createClient(url, key, { global: { fetch: (i: any, init?: any) => proxyFetch(i, init) } });
}

const nb = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const r2 = (x: number) => Math.round(x * 100) / 100;
const txt = (v: unknown) => String(v ?? "").trim();

interface Part { facture_id: string | null; facture_fournisseur_id: string | null; montant: number }

export interface ResultatReglementsBancaires {
  /** Lignes de tiers BQ rattachées à leur pièce (référence / compte). */
  lignesRattachees: number;
  /** Lignes de relevé dont l'écriture BQ a été découpée par facture. */
  lignesVentilees: number;
  codes: string[];
  tvaBasculee: number;
  tvaContrepassee: number;
  avertissements: string[];
}

/** Périodes déjà déclarées (OD « DECL-TVA-<période> ») : on n'y date plus rien. */
function periodesDeclarees(refs: string[]): { debut: string; fin: string }[] {
  return [...new Set(refs.filter((r) => r.startsWith("DECL-TVA-")))]
    .map((r) => bornesPeriode(r.slice("DECL-TVA-".length)))
    .filter(Boolean) as { debut: string; fin: string }[];
}

export async function comptabiliserReglementsBancaires(
  sb: any, dossierId: string, opts: { aujourdhui?: string } = {},
): Promise<ResultatReglementsBancaires> {
  const res: ResultatReglementsBancaires = {
    lignesRattachees: 0, lignesVentilees: 0, codes: [], tvaBasculee: 0, tvaContrepassee: 0, avertissements: [],
  };
  const aujourdhui = opts.aujourdhui ?? new Date().toISOString().slice(0, 10);

  // ── Paiements et ventilations du dossier ─────────────────────────────────
  // Pas de `ventilation_id` ici : la colonne n'existe qu'après 20261028120000,
  // et la lire bloquait TOUTE la passe (lettrage, TVA) tant que la migration
  // n'était pas appliquée — alors que rien ci-dessous ne s'en sert.
  const { data: pai, error: ePai } = await sb.from("paiements")
    .select("id,facture_id,facture_fournisseur_id,montant,date_paiement,origine,transaction_id")
    .eq("dossier_id", dossierId);
  if (ePai) { res.avertissements.push(`Paiements illisibles : ${ePai.message}`); return res; }
  const paiements = (pai ?? []) as any[];

  // Ventilations : table livrée par 20261028120000 — absente, on s'en passe.
  const { data: vents, error: eVent } = await sb.from("ventilations_transaction")
    .select("id,transaction_id,facture_id,facture_fournisseur_id,montant").eq("dossier_id", dossierId);
  const ventilations = eVent ? [] : ((vents ?? []) as any[]);

  const partsParTx = new Map<string, Part[]>();
  const pousser = (tx: string, p: Part) => { const l = partsParTx.get(tx); if (l) l.push(p); else partsParTx.set(tx, [p]); };
  for (const v of ventilations) pousser(v.transaction_id, v);
  const txVentilees = new Set(ventilations.map((v) => v.transaction_id));
  for (const p of paiements) if (p.transaction_id && !txVentilees.has(p.transaction_id)) pousser(p.transaction_id, p);

  // ── Références des pièces ────────────────────────────────────────────────
  const idsClient = [...new Set(paiements.map((p) => p.facture_id).concat(ventilations.map((v) => v.facture_id)).filter(Boolean))];
  const idsFourn = [...new Set(paiements.map((p) => p.facture_fournisseur_id).concat(ventilations.map((v) => v.facture_fournisseur_id)).filter(Boolean))];
  const numeros = new Map<string, string | null>();
  if (idsClient.length) {
    const { data } = await sb.from("factures").select("id,numero").in("id", idsClient);
    for (const f of (data ?? []) as any[]) numeros.set(f.id, f.numero ?? null);
  }
  if (idsFourn.length) {
    const { data } = await sb.from("factures_fournisseurs").select("id,numero").in("id", idsFourn);
    for (const f of (data ?? []) as any[]) numeros.set(f.id, f.numero ?? null);
  }
  // Ventes : la pièce porte le NUMÉRO ; achats : l'ID (cf. genererEcrituresAchat).
  const refDe = (p: Part) => p.facture_id ? txt(numeros.get(p.facture_id) ?? p.facture_id) : txt(p.facture_fournisseur_id);
  const aliasDe = (p: Part) => [...new Set([refDe(p), txt(p.facture_id ?? p.facture_fournisseur_id), txt(numeros.get((p.facture_id ?? p.facture_fournisseur_id)!))].filter(Boolean))];

  // ── 1. Rattacher / découper les lignes de tiers BQ ───────────────────────
  const { data: glBrut, error: eGl } = await sb.from("ecritures_comptables")
    .select("id,dossier_id,journal_code,compte_numero,date_ecriture,libelle,debit,credit,reference_piece,lettrage_code,facture_id,transaction_id,valide")
    .eq("dossier_id", dossierId);
  if (eGl) { res.avertissements.push(`Grand livre illisible : ${eGl.message}`); return res; }
  const gl = (glBrut ?? []) as any[];

  // Compte de tiers de chaque pièce, lu sur sa ligne de facture (VTE / ACH) :
  // l'auxiliaire du client (34210002) quand il en a un, sinon le collectif.
  const compteDePiece = new Map<string, string>();
  for (const l of gl) {
    if (!["VTE", "ACH"].includes(txt(l.journal_code)) || !sensDuCompte(l.compte_numero)) continue;
    const ref = txt(l.reference_piece);
    if (ref && !compteDePiece.has(ref)) compteDePiece.set(ref, txt(l.compte_numero));
  }

  for (const [txId, parts] of partsParTx) {
    const tiers = gl.filter((l) => l.transaction_id === txId && txt(l.journal_code) === "BQ" && sensDuCompte(l.compte_numero));
    if (!tiers.length) continue;                       // relevé pas encore clôturé
    if (tiers.some((l) => txt(l.lettrage_code))) continue;   // déjà lettré : on n'y touche plus

    const cibles: CiblePart[] = parts.map((p) => {
      const sens: SensTiers = p.facture_id ? "client" : "fournisseur";
      const ref = refDe(p);
      return {
        reference: ref,
        compte: compteDePiece.get(ref) ?? normaliserNumeroCompte(COMPTE_COLLECTIF[sens]),
        facture_id: p.facture_id ?? null,
        montant: r2(nb(p.montant)),
      };
    });
    const conforme = tiers.length === cibles.length && cibles.every((c) => tiers.some((l) =>
      txt(l.reference_piece) === c.reference && memeCompte(l.compte_numero, c.compte)
      && Math.abs(nb(l.debit) + nb(l.credit) - c.montant) < 0.005));
    if (conforme) continue;

    const origine = {
      compte_numero: tiers[0].compte_numero,
      debit: r2(tiers.reduce((s, l) => s + nb(l.debit), 0)),
      credit: r2(tiers.reduce((s, l) => s + nb(l.credit), 0)),
      reference_piece: tiers[0].reference_piece ?? null,
    };
    if (cibles.reduce((s, c) => s + c.montant, 0) > origine.debit + origine.credit + 0.01) {
      res.avertissements.push(`Ligne de relevé ${txId} : les paiements dépassent l'écriture de banque — laissée en l'état.`);
      continue;
    }
    const nouvelles = lignesTiersVentilees(origine, cibles);

    if (tiers.length === 1 && nouvelles.length === 1) {
      const n = nouvelles[0];
      const { error } = await sb.from("ecritures_comptables").update({
        compte_numero: normaliserNumeroCompte(n.compte_numero),
        reference_piece: n.reference_piece, facture_id: n.facture_id ?? null,
      }).eq("id", tiers[0].id).is("lettrage_code", null);
      if (error) { res.avertissements.push(error.message); continue; }
      res.lignesRattachees++;
      continue;
    }

    const modele = tiers[0];
    const { error: eDel } = await sb.from("ecritures_comptables").delete()
      .in("id", tiers.map((l) => l.id)).is("lettrage_code", null);
    if (eDel) { res.avertissements.push(eDel.message); continue; }
    const { error: eIns } = await sb.from("ecritures_comptables").insert(nouvelles.map((n) => ({
      dossier_id: dossierId, journal_code: "BQ", date_ecriture: modele.date_ecriture,
      libelle: modele.libelle, valide: modele.valide ?? true, transaction_id: txId,
      compte_numero: normaliserNumeroCompte(n.compte_numero),
      debit: n.debit, credit: n.credit, reference_piece: n.reference_piece, facture_id: n.facture_id ?? null,
    })));
    if (eIns) {
      // Rétablir la ligne d'origine : une écriture de banque amputée de sa
      // contrepartie déséquilibrerait le journal.
      await sb.from("ecritures_comptables").insert(normaliserComptesLignes(tiers.map(({ id: _id, ...l }) => l)));
      res.avertissements.push(`Découpage refusé pour ${txId} : ${eIns.message}`);
      continue;
    }
    res.lignesVentilees++;
  }

  // ── 2. Lettrage de ce qui se solde ───────────────────────────────────────
  const auto = await executerLettrageAuto(sb, { dossierId });
  if (auto.ok) res.codes = auto.codes;
  else if (auto.reason) res.avertissements.push(auto.reason);

  // ── 3. TVA des encaissements partiels ────────────────────────────────────
  const declarees = periodesDeclarees(gl.map((l) => txt(l.reference_piece)));
  const dateExigibilite = (d: string) =>
    declarees.some((p) => d >= p.debut && d <= p.fin) ? aujourdhui : d;

  const parFacture = new Map<string, { part: Part; ps: any[] }>();
  for (const p of paiements) {
    if (p.origine === "avoir") continue;               // une annulation n'est pas un encaissement
    const id = p.facture_id ?? p.facture_fournisseur_id;
    if (!id) continue;
    const g = parFacture.get(id);
    if (g) g.ps.push(p); else parFacture.set(id, { part: p, ps: [p] });
  }
  // Les paiements ont pu être reconstruits par synchroniser_paiements_dossier
  // pendant l'étape 1 : on travaille sur ce qu'on a lu, cohérent en lui-même.
  for (const [id, { part, ps }] of parFacture) {
    const sens: SensTiers = part.facture_id ? "client" : "fournisseur";
    let ref = "", etat = { tvaAttente: 0, tvaTotale: 0, ttcPiece: 0 };
    for (const alias of aliasDe(part)) {
      const e = await tvaEnAttenteDeLaPiece(sb, dossierId, alias, sens);
      if (e.tvaTotale > 0) { ref = alias; etat = e; break; }
    }
    if (!ref) continue;                                // pièce sans TVA

    const plan = planifierRattrapageTva({
      tvaTotale: etat.tvaTotale, tvaAttente: etat.tvaAttente, ttc: etat.ttcPiece,
      paiements: ps.map((p) => ({ id: p.id, montant: nb(p.montant), date: txt(p.date_paiement) })),
    });

    for (const e of plan.etapes) {
      const date = dateExigibilite(e.date);
      if (date !== e.date) {
        res.avertissements.push(`${ref} : encaissement du ${e.date} dans une période déjà déclarée — TVA régularisée au ${date}.`);
      }
      const b = await basculerTvaSurReglement(sb, {
        dossierId, reference: ref, sens, montantRegle: e.montantRegle, date,
        lettrageCode: null, origine: "auto",
        factureId: sens === "client" ? id : null, paiementId: e.paiementId,
      });
      if (b.error) { res.avertissements.push(`${ref} : ${b.error}`); break; }
      res.tvaBasculee = r2(res.tvaBasculee + b.tva);
    }

    if (plan.excedent > 0.005) {
      // Contrepassation, plafonnée aux bascules SANS code de lettrage : celles
      // d'un lettrage s'annulent par le délettrage, jamais par ici.
      const exigible = COMPTES_TVA[sens].exigible;
      const horsLettrage = r2(gl.filter((l) => txt(l.journal_code) === "OD" && txt(l.reference_piece) === ref
        && !txt(l.lettrage_code) && memeCompte(l.compte_numero, exigible))
        .reduce((s, l) => s + (sens === "client" ? nb(l.credit) - nb(l.debit) : nb(l.debit) - nb(l.credit)), 0));
      const montant = r2(Math.min(plan.excedent, horsLettrage));
      if (montant > 0.005) {
        const od = construireBasculeTva({
          sens, montantTva: montant, date: aujourdhui, reference: ref,
          libelle: `Annulation ${ref}`, lettrageCode: "", factureId: sens === "client" ? id : null,
        }).map((l) => ({ ...l, debit: l.credit, credit: l.debit }));
        const { error } = await insererPiece(sb, dossierId, od, { origine: "auto" });
        if (error) res.avertissements.push(`${ref} : contrepassation refusée — ${error}`);
        else res.tvaContrepassee = r2(res.tvaContrepassee + montant);
      }
    }
  }
  return res;
}

/**
 * Factures ouvertes d'un dossier, au format attendu par `proposerVentilation`.
 * Ventes au crédit du relevé, achats au débit.
 */
export async function facturesOuvertes(sb: any, dossierId: string, sens: SensTiers): Promise<FactureOuverte[]> {
  if (sens === "client") {
    const { data } = await sb.from("factures")
      .select("id,numero,montant_ttc,montant_restant,date_facture,statut,clients(nom)")
      .eq("dossier_id", dossierId).eq("statut", "conforme");
    return ((data ?? []) as any[]).map((f) => ({
      id: f.id, numero: f.numero, restant: r2(nb(f.montant_restant ?? f.montant_ttc)),
      tiers: f.clients?.nom ?? null, date_facture: f.date_facture,
    })).filter((f) => f.restant > 0.005);
  }
  const { data } = await sb.from("factures_fournisseurs")
    .select("id,numero,montant_ttc,montant_restant,date_facture,fournisseur_nom").eq("dossier_id", dossierId);
  return ((data ?? []) as any[]).map((f) => ({
    id: f.id, numero: f.numero, restant: r2(nb(f.montant_restant ?? f.montant_ttc)),
    tiers: f.fournisseur_nom ?? null, date_facture: f.date_facture,
  })).filter((f) => f.restant > 0.005);
}

/** Pose une ventilation (RPC atomique) puis rejoue la comptabilisation. */
export async function executerVentilation(
  sb: any, data: { dossierId: string; transactionId: string; parts: PartVentilation[] },
): Promise<{ ok: boolean; reason?: string; compta?: ResultatReglementsBancaires }> {
  const { data: tx, error: eTx } = await sb.from("transactions_bancaires")
    .select("id,dossier_id,type,montant").eq("id", data.transactionId).maybeSingle();
  if (eTx) return { ok: false, reason: eTx.message };
  // Cloisonnement : la RPC tourne sous service_role, c'est donc ICI que la
  // ligne doit appartenir au dossier contrôlé par le middleware.
  if (!tx || tx.dossier_id !== data.dossierId) return { ok: false, reason: "Ligne de relevé introuvable dans ce dossier." };
  const parts = data.parts.filter((p) => nb(p.montant) > 0.005);
  if (!parts.length) return { ok: false, reason: "Aucune facture à régler." };

  const kind = String(tx.type).toLowerCase().startsWith("c") ? "client" : "fournisseur";
  const { error } = await sb.rpc("ventiler_transaction", {
    p_tx_id: data.transactionId, p_kind: kind,
    p_lignes: parts.map((p) => ({ facture_id: p.facture_id, montant: r2(nb(p.montant)) })),
  });
  if (error) return { ok: false, reason: error.message };
  const compta = await comptabiliserReglementsBancaires(sb, data.dossierId);
  await synchroniserApresLettrage(sb, data.dossierId).catch(() => null);
  return { ok: true, compta };
}

// ─── Server functions ────────────────────────────────────────────────────────

/** À appeler après chaque clôture de relevé et chaque liaison manuelle. */
export const finaliserReglementsBancaires = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ dossierId: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const sb = getSupabase();
    const r = await comptabiliserReglementsBancaires(sb, data.dossierId);
    if (r.codes.length || r.lignesVentilees || r.tvaBasculee) await synchroniserApresLettrage(sb, data.dossierId).catch(() => null);
    return r;
  });

/** Répartit une ligne de relevé entre plusieurs factures (écran Banque). */
export const ventilerTransaction = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({
    dossierId: z.string().uuid(),
    transactionId: z.string().uuid(),
    parts: z.array(z.object({ facture_id: z.string().uuid(), montant: z.number().positive() })).min(1).max(50),
  }).parse(input))
  .handler(async ({ data }) => executerVentilation(getSupabase(), data));

/** Proposition de répartition, pour pré-remplir l'écran. */
export const proposerVentilationTransaction = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({
    dossierId: z.string().uuid(), transactionId: z.string().uuid(),
  }).parse(input))
  .handler(async ({ data }) => {
    const sb = getSupabase();
    const { data: tx } = await sb.from("transactions_bancaires")
      .select("id,dossier_id,type,montant,libelle").eq("id", data.transactionId).maybeSingle();
    if (!tx || (tx as any).dossier_id !== data.dossierId) return { parts: null as PartVentilation[] | null };
    const sens: SensTiers = String((tx as any).type).toLowerCase().startsWith("c") ? "client" : "fournisseur";
    const ouvertes = await facturesOuvertes(sb, data.dossierId, sens);
    return { parts: proposerVentilation(tx as any, ouvertes) };
  });
