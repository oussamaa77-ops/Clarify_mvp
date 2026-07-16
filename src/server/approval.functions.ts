// ============================================================================
// approval.functions.ts — Notification d'une inscription en attente.
//
// Appelée par /auth juste après signUp. Elle n'accepte QUE l'userId : tout le
// reste (email, nom, cabinet) est relu en base avec la clé de service. Un
// appelant ne peut donc pas fabriquer le contenu du mail envoyé à l'admin, et
// un userId inexistant ou déjà approuvé ne déclenche aucun envoi.
// ============================================================================
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { sendMail } from "./mailer";
import { signApprovalToken } from "./approval.token";

// Proxy TLS d'entreprise : le fetch global de Node est bloqué, supabase-js doit
// recevoir un fetch tolérant (même motif que les autres fonctions serveur).
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

/** Client à clé de SERVICE. Contrairement aux autres modules, pas de repli sur
 *  la clé publishable : approuver un compte contourne la RLS par nature, une
 *  clé anonyme échouerait silencieusement. */
export function getSupabaseAdmin(): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont requis côté serveur pour l'approbation des inscriptions."
    );
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (i: any, init?: any) => proxyFetch(i, init) },
  });
}

/** Adresse qui reçoit les demandes d'approbation. */
export function getAdminEmail(): string {
  return (process.env.ADMIN_APPROVAL_EMAIL ?? "oussamakarmaoui7@gmail.com").trim();
}

/** URL publique de l'app, pour construire un lien cliquable depuis un e-mail.
 *  Railway expose RAILWAY_PUBLIC_DOMAIN ; APP_URL permet de forcer la valeur. */
export function getAppUrl(): string {
  const explicite = (process.env.APP_URL ?? "").trim().replace(/\/+$/, "");
  if (explicite) return explicite;
  const railway = (process.env.RAILWAY_PUBLIC_DOMAIN ?? "").trim();
  if (railway) return `https://${railway}`;
  return "http://localhost:3000";
}

export const notifierInscriptionEnAttente = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ userId: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const sb = getSupabaseAdmin();

    const { data: prof, error } = await sb
      .from("profiles")
      .select("id, email, nom, prenom, cabinet_id, is_approved")
      .eq("id", data.userId)
      .maybeSingle();

    if (error) throw new Error(`Lecture du profil impossible : ${error.message}`);
    // Silencieux plutôt qu'erreur : ni un userId inconnu ni un compte déjà
    // approuvé ne doivent renseigner l'appelant ou spammer l'admin.
    if (!prof) return { envoye: false as const, raison: "profil introuvable" };
    if ((prof as any).is_approved) return { envoye: false as const, raison: "déjà approuvé" };

    const p = prof as any;
    const nomComplet = [p.prenom, p.nom].filter(Boolean).join(" ") || "(nom non renseigné)";

    // Nom du cabinet — informatif seulement, on ne bloque pas l'envoi s'il manque.
    let cabinetNom = "(cabinet inconnu)";
    if (p.cabinet_id) {
      const { data: cab } = await sb.from("cabinets").select("nom").eq("id", p.cabinet_id).maybeSingle();
      if (cab) cabinetNom = (cab as any).nom ?? cabinetNom;
    }

    const lien = `${getAppUrl()}/api/approve-user?userId=${encodeURIComponent(p.id)}&token=${signApprovalToken(p.id)}`;

    const html = `
      <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px">
        <h2 style="margin:0 0 4px">Nouvelle inscription à approuver</h2>
        <p style="color:#555;margin:0 0 20px">Ce compte ne peut accéder à aucune donnée tant qu'il n'est pas approuvé.</p>
        <table style="border-collapse:collapse;width:100%;margin-bottom:24px">
          <tr><td style="padding:6px 0;color:#666">Nom</td><td style="padding:6px 0"><strong>${nomComplet}</strong></td></tr>
          <tr><td style="padding:6px 0;color:#666">E-mail</td><td style="padding:6px 0"><strong>${p.email}</strong></td></tr>
          <tr><td style="padding:6px 0;color:#666">Cabinet</td><td style="padding:6px 0"><strong>${cabinetNom}</strong></td></tr>
        </table>
        <a href="${lien}" style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:600">
          Approuver ce compte
        </a>
        <p style="color:#888;font-size:12px;margin-top:24px">
          Si le bouton ne fonctionne pas, copiez ce lien :<br>${lien}
        </p>
        <p style="color:#888;font-size:12px">
          Vous n'attendiez pas cette demande ? Ne cliquez pas : sans approbation, le compte reste sans accès.
        </p>
      </div>`;

    await sendMail({
      to: getAdminEmail(),
      subject: `Inscription à approuver — ${nomComplet} (${p.email})`,
      html,
    });

    return { envoye: true as const };
  });
