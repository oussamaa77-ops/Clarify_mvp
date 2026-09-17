// ============================================================================
// relances.functions.ts — Recouvrement client : agrège les impayés d'un dossier
// par client, en CUMULANT deux sources (exigence métier) :
//   • flux OCR courant  : factures « conforme » non soldées, échéance dépassée ;
//   • reprise d'historique : postes ouverts de classe 342x (créances clients)
//     issus du Grand Livre importé, non lettrés (transaction_id NULL, lettree=false).
//
// L'e-mail du client provient de sa fiche Tiers (clients.email) ; s'il est absent,
// l'UI impose une saisie manuelle (cas de secours). PCM marocain : clients = 342x.
// ============================================================================

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { CLIENT_PREFIXES, normalizeLibelle } from "@/lib/import-grandlivre";
import { sendMail, type MailAttachment } from "./mailer";
import { dateExigibilite } from "@/lib/factures-filtres";
import { postesRepriseClients } from "@/lib/relances-postes";

let PROXY_DIRECT = false;
async function proxyFetch(input: any, init?: any): Promise<Response> {
  if (PROXY_DIRECT) {
    const { fetch: uf, Agent } = await import("undici");
    return (uf as any)(String(input), { ...init, dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) });
  }
  try { return await fetch(String(input), init); }
  catch (e: any) {
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

export interface RelanceItem {
  source: "facture" | "gl";      // facture OCR courante | écriture GL migrée (342x)
  ref: string;                    // n° facture ou n° pièce / compte auxiliaire
  montant: number;                // restant dû
  date: string | null;           // échéance (facture) ou date d'écriture (GL)
  jours: number;                  // ancienneté / retard en jours
  ecritureIds?: string[];         // GL : lignes du poste (traçabilité)
  factureId?: string;             // facture : id (source du fichier original à joindre)
  fichierUrl?: string | null;    // facture : URL du PDF/image d'origine (bucket factures-originales)
  fichierNom?: string | null;    // facture : nom du fichier original
  fichierType?: string | null;   // facture : type MIME du fichier original
}
export interface RelanceClient {
  key: string;                    // nom normalisé (clé de regroupement)
  nom: string;
  client_id: string | null;
  email: string | null;           // fiche Tiers ; null → saisie manuelle imposée
  total: number;
  maxJours: number;
  items: RelanceItem[];
}

const joursDepuis = (d: string | null, today: number): number =>
  d ? Math.max(0, Math.floor((today - new Date(d).getTime()) / 86400000)) : 0;

export const getRelancesClient = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ dossierId: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const sb = getSupabase();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayMs = today.getTime();

    try {
      const [{ data: factures }, { data: ecr }, { data: cli }] = await Promise.all([
        (sb as any).from("factures")
          .select("id,numero,montant_ttc,montant_paye,montant_restant,date_facture,date_echeance,client_id,fichier_original_url,fichier_original_nom,fichier_original_type,clients(nom,email)")
          .eq("dossier_id", data.dossierId).eq("statut", "conforme").neq("statut_paiement", "payee"),
        // Source 2 = créances 342x de REPRISE. On lit TOUTES les lignes clients, y
        // compris celles liées à une facture ou à un relevé : `postesRepriseClients`
        // les écarte des postes, mais s'en sert pour reconnaître un À-NOUVEAU qui ne
        // fait que reporter une créance déjà présente (sans quoi elle compte double).
        (sb as any).from("ecritures_comptables")
          .select("id,journal_code,compte_numero,libelle,debit,credit,reference_piece,date_ecriture,lettree,lettrage_code,facture_id,transaction_id")
          .eq("dossier_id", data.dossierId).like("compte_numero", "342%"),
        (sb as any).from("clients")
          .select("id,nom,email").eq("dossier_id", data.dossierId).is("deleted_at", null),
      ]);

      // Fiche Tiers : nom normalisé → { id, nom, email } (source de l'e-mail).
      const clientsByNorm = new Map<string, { id: string; nom: string; email: string | null }>();
      for (const c of cli ?? []) clientsByNorm.set(normalizeLibelle(c.nom), { id: c.id, nom: c.nom, email: c.email ?? null });

      const acc = new Map<string, RelanceClient>();
      const getEntry = (nom: string, clientId?: string | null, email?: string | null): RelanceClient => {
        const key = normalizeLibelle(nom) || "?";
        let e = acc.get(key);
        if (!e) {
          const fiche = clientsByNorm.get(key);
          e = { key, nom: fiche?.nom ?? nom, client_id: fiche?.id ?? clientId ?? null, email: fiche?.email ?? email ?? null, total: 0, maxJours: 0, items: [] };
          acc.set(key, e);
        }
        if (!e.email && email) e.email = email;         // complète l'e-mail si trouvé côté facture
        if (!e.client_id && clientId) e.client_id = clientId;
        return e;
      };

      // ── Source 1 : factures en retard (exigibles, non soldées) ────────────────
      // Exigibilité = échéance, à défaut émission : la règle de la balance âgée.
      // Filtrer sur la seule échéance ignorait toute facture qui n'en porte pas.
      const numerosRelances: string[] = [];
      for (const f of factures ?? []) {
        const exigible = dateExigibilite(f);
        if (!exigible || new Date(exigible).getTime() >= todayMs) continue;
        // Montant dû robuste à un montant_restant périmé (0 alors que la facture est non payée).
        const rRaw = Number(f.montant_restant ?? 0);
        const du = rRaw > 0.005 ? rRaw : Math.max(0, Number(f.montant_ttc ?? 0) - Number(f.montant_paye ?? 0));
        if (!(du > 0.005)) continue;
        if (f.numero) numerosRelances.push(f.numero);
        const nom = f.clients?.nom ?? "Client";
        const e = getEntry(nom, f.client_id, f.clients?.email ?? null);
        e.items.push({
          source: "facture", ref: f.numero ?? String(f.id).slice(0, 8), montant: Number(du.toFixed(2)),
          date: exigible, jours: joursDepuis(exigible, todayMs),
          factureId: f.id, fichierUrl: f.fichier_original_url ?? null,
          fichierNom: f.fichier_original_nom ?? null, fichierType: f.fichier_original_type ?? null,
        });
      }

      // ── Source 2 : postes ouverts 342x issus de la reprise (nettés par pièce) ──
      // Les à-nouveaux qui reportent une créance déjà connue et les pièces d'une
      // facture déjà relancée en sortent (cf. src/lib/relances-postes.ts).
      for (const p of postesRepriseClients(ecr ?? [], CLIENT_PREFIXES, numerosRelances)) {
        const e = getEntry(p.nom || `Compte ${p.ref}`);
        e.items.push({ source: "gl", ref: p.ref, montant: p.montant, date: p.date, jours: joursDepuis(p.date, todayMs), ecritureIds: p.ecritureIds });
      }

      // Totaux + tri.
      const clients = Array.from(acc.values())
        .map((e) => {
          e.items.sort((a, b) => b.jours - a.jours);
          e.total = Number(e.items.reduce((s, it) => s + it.montant, 0).toFixed(2));
          e.maxJours = e.items.reduce((m, it) => Math.max(m, it.jours), 0);
          return e;
        })
        .filter((e) => e.items.length > 0)
        .sort((a, b) => b.total - a.total);

      return { ok: true as const, clients };
    } catch (e: any) {
      return { ok: false as const, clients: [] as RelanceClient[], reason: String(e?.message ?? e) };
    }
  });

// ─── envoyerRelance ───────────────────────────────────────────────────────────
// Contrôleur d'envoi de relance : AVANT d'appeler le service SMTP, il RÉCUPÈRE le
// fichier original de chaque facture concernée (bucket public factures-originales)
// et le joint au mail. Le téléchargement passe par proxyFetch (repli undici) pour
// rester tolérant au proxy TLS d'entreprise. Une PJ introuvable/trop lourde est
// simplement ignorée (best-effort) : le mail part quand même, sans bloquer.
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024; // garde-fou : 15 Mo / pièce jointe

export const envoyerRelance = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({
      to: z.string().email(),
      toName: z.string().optional(),
      subject: z.string(),
      html: z.string(),
      text: z.string().optional(),
      // Factures à joindre : URL du fichier original + nom + type (issus de RelanceItem).
      factures: z.array(z.object({
        url: z.string().url(),
        nom: z.string().optional(),
        type: z.string().optional(),
      })).optional(),
    }).parse(input)
  )
  .handler(async ({ data }) => {
    // Récupère chaque facture et la convertit en pièce jointe binaire.
    const attachments: MailAttachment[] = [];
    const jointes: string[] = [];
    const ignorees: string[] = [];
    for (const f of data.factures ?? []) {
      const nom = (f.nom && f.nom.trim()) || deriverNomFichier(f.url);
      try {
        const res = await proxyFetch(f.url);
        if (!res.ok) { ignorees.push(nom); continue; }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0 || buf.length > MAX_ATTACHMENT_BYTES) { ignorees.push(nom); continue; }
        const type = f.type || res.headers.get("content-type") || undefined;
        attachments.push({ name: nom, contentBuffer: buf, type: type ?? undefined });
        jointes.push(nom);
      } catch {
        ignorees.push(nom);
      }
    }

    // L'envoi lui-même : lève une erreur explicite si le SMTP est mal configuré.
    const r = await sendMail({
      to: data.to,
      toName: data.toName,
      subject: data.subject,
      html: data.html,
      text: data.text,
      attachments: attachments.length ? attachments : undefined,
    });

    return { success: true as const, messageId: r.messageId, jointes, ignorees };
  });

// Déduit un nom de fichier lisible depuis une URL de storage (dernier segment).
function deriverNomFichier(url: string): string {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
    return last || "Facture.pdf";
  } catch {
    return "Facture.pdf";
  }
}
