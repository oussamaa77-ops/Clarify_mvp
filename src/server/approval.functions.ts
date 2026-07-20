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

/** Durée du bannissement posé en attendant l'approbation : ~100 ans, soit un
 *  refus permanent en pratique. Supabase n'expose pas de durée infinie ; le
 *  débannissement est de toute façon explicite (cf. /api/approve-user). */
const BAN_EN_ATTENTE = "876000h";

/**
 * Refuse toute authentification au compte tant qu'il n'est pas approuvé.
 *
 * C'est LE verrou de connexion, et il est côté serveur d'auth : un compte banni
 * ne peut obtenir aucun jeton, même en appelant l'API Supabase directement, en
 * contournant totalement le front. La RLS (get_user_cabinet) reste le second
 * rideau sur les DONNÉES ; le signOut du client, lui, n'est que du confort.
 *
 * La confirmation d'e-mail étant désactivée, signUp a déjà émis une session
 * quand on arrive ici. Le ban empêche tout nouveau jeton et invalide le
 * rafraîchissement, mais l'access_token en cours reste valide jusqu'à son
 * expiration — d'où le signOut() côté client juste après l'inscription, et la
 * RLS qui, elle, ne laisse rien lire à un non-approuvé de toute façon.
 * (Pas d'admin.signOut ici : il attend un JWT, pas un userId.)
 */
async function bannirEnAttente(sb: SupabaseClient, userId: string): Promise<void> {
  const { error } = await sb.auth.admin.updateUserById(userId, { ban_duration: BAN_EN_ATTENTE });
  if (error) throw new Error(`Bannissement en attente d'approbation impossible : ${error.message}`);
}

/**
 * Crée un compte EN ATTENTE, sans jamais ouvrir de session.
 *
 * Pourquoi ne pas utiliser supabase.auth.signUp() côté navigateur : la
 * confirmation d'e-mail étant désactivée, signUp renvoie immédiatement un
 * access_token. Le compte a beau être banni dans la foulée (le trigger
 * handle_new_user s'en charge dès l'INSERT), le navigateur détient déjà une
 * session valide et entre dans l'application — c'est précisément ce qu'on
 * refuse. Un signOut() après coup ne suffit pas : la redirection se déclenche
 * avant, et surtout ce serait un rideau purement cosmétique.
 *
 * Ici la création passe par la clé de SERVICE : aucun jeton n'est émis, le
 * client ne reçoit qu'un booléen. La seule façon d'obtenir une session devient
 * signInWithPassword — que le bannissement refuse tant que l'admin n'a pas
 * approuvé.
 */
export const inscrireEnAttente = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({
      email: z.string().email(),
      password: z.string().min(6, "Le mot de passe doit faire au moins 6 caractères."),
      nom: z.string().max(120).optional(),
      prenom: z.string().max(120).optional(),
      cabinet_nom: z.string().max(200).optional(),
      plan_code: z.string().max(40).optional(),
    }).parse(input)
  )
  .handler(async ({ data }) => {
    const sb = getSupabaseAdmin();

    // email_confirm: true — la confirmation d'e-mail est désactivée côté
    // Supabase ; sans ça le compte resterait « non confirmé » et refuserait de
    // se connecter même une fois approuvé.
    const { data: cree, error } = await sb.auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true,
      user_metadata: {
        nom: data.nom ?? null,
        prenom: data.prenom ?? null,
        cabinet_nom: data.cabinet_nom || "Mon Cabinet",
        plan_code: data.plan_code ?? null,
      },
    });

    if (error) {
      // Message tel quel : « User already registered » doit remonter à
      // l'utilisateur, c'est une information utile et non sensible.
      throw new Error(error.message);
    }
    const userId = cree.user!.id;

    // Le trigger handle_new_user a normalement déjà posé banned_until. On le
    // repose explicitement : si la migration n'a pas été appliquée sur cet
    // environnement, le compte serait connectable. Ceinture et bretelles, sur
    // le seul point qui compte vraiment.
    await bannirEnAttente(sb, userId);

    // Prévenir l'admin. Best-effort : le compte EST créé et VERROUILLÉ même si
    // le mail échoue — l'admin peut toujours approuver à la main. Échouer ici
    // laisserait croire à l'utilisateur que son inscription n'a pas abouti.
    try {
      await envoyerDemandeApprobation(sb, userId);
    } catch (err: any) {
      console.warn("[inscription] mail d'approbation non envoyé:", err?.message ?? err);
      return { cree: true as const, mailEnvoye: false as const };
    }
    return { cree: true as const, mailEnvoye: true as const };
  });

/** Envoie à l'admin la demande d'approbation d'un compte. Le contenu est relu en
 *  base avec la clé de service : l'appelant ne peut rien dicter du message.
 *  Lève si le profil est introuvable — appelée après création, il doit exister. */
async function envoyerDemandeApprobation(sb: SupabaseClient, userId: string): Promise<void> {
  const { data: prof, error } = await sb
    .from("profiles")
    .select("id, email, nom, prenom, cabinet_id, is_approved")
    .eq("id", userId)
    .maybeSingle();

  if (error) throw new Error(`Lecture du profil impossible : ${error.message}`);
  if (!prof) throw new Error("profil introuvable");

  const p = prof as any;
  const nomComplet = [p.prenom, p.nom].filter(Boolean).join(" ") || "(nom non renseigné)";

  // Nom du cabinet — informatif seulement, on ne bloque pas l'envoi s'il manque.
  let cabinetNom = "(cabinet inconnu)";
  if (p.cabinet_id) {
    const { data: cab } = await sb.from("cabinets").select("nom").eq("id", p.cabinet_id).maybeSingle();
    if (cab) cabinetNom = (cab as any).nom ?? cabinetNom;
  }

  // Un seul jeton pour les deux actions : qui détient le mail décide des deux.
  const jeton = signApprovalToken(p.id);
  const base = `${getAppUrl()}`;
  const lienOui = `${base}/api/approve-user?userId=${encodeURIComponent(p.id)}&token=${jeton}`;
  const lienNon = `${base}/api/reject-user?userId=${encodeURIComponent(p.id)}&token=${jeton}`;

  const html = `
      <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px">
        <h2 style="margin:0 0 4px">Nouvelle inscription à approuver</h2>
        <p style="color:#555;margin:0 0 20px">Ce compte ne peut ni se connecter ni accéder à la moindre donnée tant qu'il n'est pas approuvé.</p>
        <table style="border-collapse:collapse;width:100%;margin-bottom:24px">
          <tr><td style="padding:6px 0;color:#666">Nom</td><td style="padding:6px 0"><strong>${nomComplet}</strong></td></tr>
          <tr><td style="padding:6px 0;color:#666">E-mail</td><td style="padding:6px 0"><strong>${p.email}</strong></td></tr>
          <tr><td style="padding:6px 0;color:#666">Cabinet</td><td style="padding:6px 0"><strong>${cabinetNom}</strong></td></tr>
        </table>
        <table style="border-collapse:separate;border-spacing:0"><tr>
          <td style="padding-right:12px">
            <a href="${lienOui}" style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:600">
              Approuver
            </a>
          </td>
          <td>
            <a href="${lienNon}" style="display:inline-block;background:#fff;color:#dc2626;border:1px solid #dc2626;text-decoration:none;padding:11px 21px;border-radius:6px;font-weight:600">
              Refuser
            </a>
          </td>
        </tr></table>
        <p style="color:#888;font-size:12px;margin-top:24px">
          Approuver : <br>${lienOui}<br><br>
          Refuser (demande une confirmation) : <br>${lienNon}
        </p>
        <p style="color:#888;font-size:12px">
          Vous n'attendiez pas cette demande ? Ne cliquez sur rien : sans approbation, le compte reste sans accès.
        </p>
      </div>`;

  await sendMail({
    to: getAdminEmail(),
    subject: `Inscription à approuver — ${nomComplet} (${p.email})`,
    html,
  });
}
