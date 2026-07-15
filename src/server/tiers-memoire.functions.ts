// ============================================================================
// tiers-memoire.functions.ts — POC « mémoire d'apprentissage » des tiers.
//
// Deux capacités branchées sur le flux FOURNISSEURS :
//   (1) ÉCRITURE à la validation  → memoriserTiers  (occurrences++ par tiers)
//   (3) LECTURE avant le LLM      → rappelerMemoire  (utilisée dans ocrFacture
//                                    pour court-circuiter l'appel IA)
//
// Clés : ICE normalisé (clé forte) puis libellé normalisé (clé principale).
// Dégradation gracieuse : si la table n'existe pas encore (migration non
// appliquée) ou en cas d'erreur réseau, on renvoie null / {ok:false} sans jamais
// casser le scan.
// ============================================================================

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// fetch tolérant au proxy TLS d'entreprise : le fetch global de Node échoue
// (`TypeError: fetch failed`) → repli undici sans vérif TLS. Sans ça, la mémoire des
// tiers (lecture ET écriture) échoue silencieusement → aucun apprentissage, aucun skip.
let PROXY_DIRECT = false;
async function proxyFetch(input: any, init?: any): Promise<Response> {
  const url = String(input);
  if (PROXY_DIRECT) {
    const { fetch: uf, Agent } = await import("undici");
    const agent = new Agent({ connect: { rejectUnauthorized: false } });
    return (uf as any)(url, { ...init, dispatcher: agent }) as Promise<Response>;
  }
  try {
    return await fetch(url, init);
  } catch (e: any) {
    const cause: string = e?.cause?.code ?? e?.cause?.message ?? e?.message ?? "";
    if (/SELF_SIGNED|CERT_|UNABLE_TO_VERIFY|fetch failed|ECONNRESET|EPROTO/i.test(cause) || /fetch failed/i.test(String(e?.message ?? ""))) {
      PROXY_DIRECT = true;
      const { fetch: uf, Agent } = await import("undici");
      const agent = new Agent({ connect: { rejectUnauthorized: false } });
      return (uf as any)(url, { ...init, dispatcher: agent }) as Promise<Response>;
    }
    throw e;
  }
}

function getSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    "";
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (i: any, init?: any) => proxyFetch(i, init) },
  });
}

// Normalisation de libellé (miroir de ia_services/common/text.normalize) :
// accents retirés, MAJUSCULES, ponctuation → espace, espaces compressés.
export function normalizeLibelle(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^0-9A-Z\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const normIce = (ice?: string | null): string =>
  (ice ?? "").replace(/\s+/g, "").trim();

// ── Normalisation LIBELLÉ BANCAIRE (sens='banque') ───────────────────────────
// Retire le bruit transactionnel (VIR/SEPA/PRLV/CB…), les dates, les références
// et montants parasites, les accents → MAJUSCULES. Le résultat sert à la fois de
// clé principale (cle_libelle) ET de `pattern` (signature réutilisée par la
// recherche de similarité).
const BANK_NOISE: RegExp[] = [
  /\bVIR(EMENT)?\b/g, /\bVIRT\b/g, /\bSEPA\b/g, /\bPRLV\b/g, /\bPRELEVEMENT(S)?\b/g,
  /\bCB\b/g, /\bCARTE\b/g, /\bTPE\b/g, /\bPAIEMENT\b/g, /\bPAIMT\b/g, /\bPMT\b/g,
  /\bREGLEMENT\b/g, /\bRECU\b/g, /\bEMIS\b/g, /\bVERS\b/g, /\bCHEQUE\b/g, /\bCHQ\b/g,
  /\bREMISE\b/g, /\bRETRAIT\b/g, /\bGAB\b/g, /\bDAB\b/g, /\bESPECES?\b/g, /\bAVIS\b/g,
  /\bREF\b/g, /\bMANDAT\b/g, /\bECH\b/g, /\bFACT(URE)?\b/g, /\bNO\b/g,
];

export function normalizeBankLabel(s: string | null | undefined): string {
  if (!s) return "";
  let x = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^0-9A-Z\s]+/g, " ");           // ponctuation → espace
  x = x.replace(/\b\d{1,2}[\s\/\-]\d{1,2}[\s\/\-]\d{2,4}\b/g, " "); // dates DD MM YY[YY]
  for (const re of BANK_NOISE) x = x.replace(re, " ");
  x = x.replace(/\b\d{2,}\b/g, " ");          // références / montants (≥2 chiffres)
  return x.replace(/\s+/g, " ").trim();
}

// Hash court (djb2) du pattern → lookup exact O(1) en base.
export function patternHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

// Similarité simple [0..1] entre deux libellés normalisés : égalité, inclusion,
// puis recouvrement de tokens (≥3 chars). Suffisant pour un POC (pas de Levenshtein).
export function bankSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;
  const ta = new Set(a.split(/\s+/).filter((t) => t.length >= 3));
  const tb = new Set(b.split(/\s+/).filter((t) => t.length >= 3));
  if (!ta.size || !tb.size) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common += 1;
  return common / Math.max(ta.size, tb.size);
}

// Confiance 0..1 dérivée des occurrences (miroir de la colonne SQL `confiance`).
export const confianceFromOccurrences = (occ: number): number =>
  Math.min(1, Math.max(0, occ) / 3);

// Seuil de similarité pour considérer un rappel banque comme fiable.
export const BANK_SIM_THRESHOLD = 0.7;

export interface TiersMemoireHit {
  id: string;
  compte_pcm: string | null;
  categorie_pcm: string | null;
  taux_tva: number | null;
  occurrences: number;
  fournisseur_id: string | null;
  par_ice: boolean; // true = rappel par ICE exact (clé forte) → autorise le court-circuit LLM
  // ── Champs banque / apprentissage ──
  type_tiers: string | null;              // 'client' | 'fournisseur' | 'autre'
  pattern: string | null;                 // libellé bancaire normalisé
  confiance: number;                      // 0..1 dérivé des occurrences
  similarity: number;                     // score du rappel (1 = exact)
  match_kind: "ice" | "libelle" | "pattern_hash" | "similarity";
}

// ── Lecture bas-niveau réutilisable (appelée côté serveur, AVANT le LLM) ──────
export async function rappelerMemoire(
  sb: SupabaseClient,
  args: { dossier_id: string; sens: string; ice?: string | null; nom?: string | null },
): Promise<TiersMemoireHit | null> {
  const iceNorm = normIce(args.ice);
  const isBanque = args.sens === "banque";
  const cle = isBanque ? normalizeBankLabel(args.nom) : normalizeLibelle(args.nom);
  const toHit = (
    r: any,
    similarity: number,
    match_kind: TiersMemoireHit["match_kind"],
  ): TiersMemoireHit => {
    const occurrences = Number(r.occurrences ?? 1);
    return {
      id: r.id,
      compte_pcm: r.compte_pcm ?? null,
      categorie_pcm: r.categorie_pcm ?? null,
      taux_tva: r.taux_tva != null ? Number(r.taux_tva) : null,
      occurrences,
      fournisseur_id: r.fournisseur_id ?? null,
      par_ice: match_kind === "ice",
      type_tiers: r.type_tiers ?? null,
      pattern: r.pattern ?? null,
      confiance: r.confiance != null ? Number(r.confiance) : confianceFromOccurrences(occurrences),
      similarity,
      match_kind,
    };
  };

  try {
    // ── Branche BANQUE : pattern_hash exact puis similarité sur le pattern ────
    if (isBanque) {
      if (!cle) return null;
      const ph = patternHash(cle);
      // 1) Pattern hash exact (clé forte, lookup O(1)).
      const { data: exact } = await (sb.from("tiers_memoire") as any)
        .select("*")
        .eq("dossier_id", args.dossier_id).eq("sens", "banque")
        .eq("pattern_hash", ph).limit(1).maybeSingle();
      if (exact) return toHit(exact, 1, "pattern_hash");
      // 2) Similarité (includes / recouvrement de tokens) sur les patterns connus.
      const { data: cands } = await (sb.from("tiers_memoire") as any)
        .select("*")
        .eq("dossier_id", args.dossier_id).eq("sens", "banque").limit(500);
      let best: any = null, bestSim = 0;
      for (const r of cands ?? []) {
        const sim = bankSimilarity(cle, r.pattern ?? r.cle_libelle ?? "");
        if (sim > bestSim) { bestSim = sim; best = r; }
      }
      if (best && bestSim >= BANK_SIM_THRESHOLD) return toHit(best, bestSim, "similarity");
      return null;
    }

    // ── Branche FOURNISSEUR / CLIENT : ICE fort puis libellé ─────────────────
    // 1) ICE exact (clé forte).
    if (iceNorm) {
      const { data } = await (sb.from("tiers_memoire") as any)
        .select("*")
        .eq("dossier_id", args.dossier_id)
        .eq("sens", args.sens)
        .eq("cle_ice", iceNorm)
        .limit(1)
        .maybeSingle();
      if (data) return toHit(data, 1, "ice");
    }
    // 2) Libellé normalisé (clé principale).
    if (cle) {
      const { data } = await (sb.from("tiers_memoire") as any)
        .select("*")
        .eq("dossier_id", args.dossier_id)
        .eq("sens", args.sens)
        .eq("cle_libelle", cle)
        .limit(1)
        .maybeSingle();
      if (data) return toHit(data, 1, "libelle");
    }
  } catch {
    // table absente / réseau → pas de rappel, le scan continue normalement
  }
  return null;
}

// ── (3) Server function de lecture (exposable à l'UI si besoin) ───────────────
export const rappelerTiersMemoire = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        dossier_id: z.string().uuid(),
        sens: z.enum(["fournisseur", "client", "banque"]).default("fournisseur"),
        ice: z.string().nullish(),
        nom: z.string().nullish(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const hit = await rappelerMemoire(getSupabase(), data);
    return { hit };
  });

// ── (1) Server function d'écriture — upsert avec occurrences++ ────────────────
export const memoriserTiers = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        dossier_id: z.string().uuid(),
        sens: z.enum(["fournisseur", "client", "banque"]).default("fournisseur"),
        ice: z.string().nullish(),
        nom: z.string(),
        fournisseur_id: z.string().uuid().nullish(),
        compte_pcm: z.string().nullish(),
        categorie_pcm: z.string().nullish(),
        taux_tva: z.number().nullish(),
        type_tiers: z.enum(["client", "fournisseur", "autre"]).nullish(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const sb = getSupabase();
    // Clé principale : libellé bancaire normalisé (banque) ou libellé tiers.
    const isBanque = data.sens === "banque";
    const cle = isBanque ? normalizeBankLabel(data.nom) : normalizeLibelle(data.nom);
    if (!cle) return { ok: false, reason: "libellé vide" as const };
    const iceNorm = normIce(data.ice) || null;
    const pattern = isBanque ? cle : null;            // pattern = clé pour la banque
    const pHash = pattern ? patternHash(pattern) : null;

    try {
      // Upsert manuel (occurrences++ non atomique — suffisant pour un POC).
      const { data: existing } = await (sb.from("tiers_memoire") as any)
        .select("id,occurrences")
        .eq("dossier_id", data.dossier_id)
        .eq("sens", data.sens)
        .eq("cle_libelle", cle)
        .limit(1)
        .maybeSingle();

      if (existing) {
        const occ = Number(existing.occurrences ?? 1) + 1;
        // `undefined` → champ non envoyé (on n'écrase pas une valeur connue par null).
        const patch: Record<string, unknown> = {
          occurrences: occ,
          confiance: confianceFromOccurrences(occ),
          derniere_validation: new Date().toISOString(),
        };
        if (iceNorm) patch.cle_ice = iceNorm;
        if (pattern) { patch.pattern = pattern; patch.pattern_hash = pHash; }
        if (data.type_tiers) patch.type_tiers = data.type_tiers;
        if (data.fournisseur_id) patch.fournisseur_id = data.fournisseur_id;
        if (data.compte_pcm) patch.compte_pcm = data.compte_pcm;
        if (data.categorie_pcm) patch.categorie_pcm = data.categorie_pcm;
        if (data.taux_tva != null) patch.taux_tva = data.taux_tva;
        await (sb.from("tiers_memoire") as any).update(patch).eq("id", existing.id);
        return { ok: true as const, occurrences: occ, created: false };
      }

      await (sb.from("tiers_memoire") as any).insert({
        dossier_id: data.dossier_id,
        sens: data.sens,
        cle_ice: iceNorm,
        cle_libelle: cle,
        pattern,
        pattern_hash: pHash,
        type_tiers: data.type_tiers ?? null,
        fournisseur_id: data.fournisseur_id ?? null,
        compte_pcm: data.compte_pcm ?? null,
        categorie_pcm: data.categorie_pcm ?? null,
        taux_tva: data.taux_tva ?? null,
        occurrences: 1,
        confiance: confianceFromOccurrences(1),
      });
      return { ok: true as const, occurrences: 1, created: true };
    } catch (e: any) {
      // Table absente (migration non appliquée) ou erreur → ne bloque pas la validation.
      return { ok: false as const, reason: String(e?.message ?? e) };
    }
  });
