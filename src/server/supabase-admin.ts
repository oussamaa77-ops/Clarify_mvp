// ============================================================================
// supabase-admin.ts — client Supabase serveur (service_role) partagé.
//
// Deux choses que tout appel serveur doit faire et qu'on ne veut pas
// re-écrire dans chaque module :
//   • proxyFetch : le fetch global de Node meurt derrière le proxy TLS
//     d'entreprise (`TypeError: fetch failed`) → repli undici sans vérif TLS.
//     Sans ça, TOUTE requête serveur vers Supabase échoue en silence.
//   • createClient en singleton paresseux (une connexion, pas une par appel).
// ============================================================================
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let PROXY_DIRECT = false;

export async function proxyFetch(input: any, init?: any): Promise<Response> {
  const url = String(input);
  if (PROXY_DIRECT) return undiciFetch(url, init);
  try {
    return await fetch(url, init);
  } catch (e: any) {
    const cause: string = e?.cause?.code ?? e?.cause?.message ?? e?.message ?? "";
    if (/SELF_SIGNED|CERT_|UNABLE_TO_VERIFY|fetch failed|ECONNRESET|EPROTO/i.test(cause)) {
      PROXY_DIRECT = true;
      return undiciFetch(url, init);
    }
    throw e;
  }
}

async function undiciFetch(url: string, init?: any): Promise<Response> {
  const { fetch: uf, Agent } = await import("undici");
  const agent = new Agent({ connect: { rejectUnauthorized: false } });
  return (uf as any)(url, { ...init, dispatcher: agent }) as Promise<Response>;
}

let _client: SupabaseClient | undefined;

/** Client service_role : contourne RLS. Jamais exposé au navigateur. */
export function getSupabaseAdmin(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    "";
  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (i: any, init?: any) => proxyFetch(i, init) },
  });
  return _client;
}

/**
 * Résout l'utilisateur d'un jeton de session, puis son cabinet.
 * Les server fns TanStack ne portent pas l'en-tête Authorization : le client
 * transmet donc son access_token explicitement, et on le VÉRIFIE ici. Sans
 * cette vérification, un cabinet_id envoyé par le client permettrait de changer
 * le plan d'un autre cabinet.
 */
export async function resoudreCabinet(accessToken: string): Promise<{ userId: string; cabinetId: string }> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb.auth.getUser(accessToken);
  if (error || !data?.user) throw new Error("Session invalide ou expirée.");

  const { data: profil } = await sb
    .from("profiles" as any)
    .select("cabinet_id")
    .eq("id", data.user.id)
    .maybeSingle();

  const cabinetId = (profil as any)?.cabinet_id as string | null;
  if (!cabinetId) throw new Error("Utilisateur non rattaché à un cabinet.");
  return { userId: data.user.id, cabinetId };
}
