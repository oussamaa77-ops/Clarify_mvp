// Client Supabase service-role pour le seeding/teardown/RPC (bypass RLS).
// Réservé aux tests — n'importe JAMAIS depuis le code applicatif.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { CONFIG } from "./config";

let _admin: SupabaseClient | undefined;

export function admin(): SupabaseClient {
  if (!CONFIG.SUPABASE_URL || !CONFIG.SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquants dans .env");
  }
  if (!_admin) {
    _admin = createClient(CONFIG.SUPABASE_URL, CONFIG.SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _admin;
}

// Résout le dossier (id + nom) via son ICE.
export async function resolveDossier(ice = CONFIG.TARGET_ICE): Promise<{ id: string; nom: string }> {
  const { data, error } = await admin()
    .from("dossiers")
    .select("id, nom_societe, ice")
    .eq("ice", ice)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`Dossier introuvable pour ICE ${ice}`);
  return { id: (data as any).id as string, nom: (data as any).nom_societe as string };
}

// Compat : ne renvoie que l'UUID.
export async function resolveDossierId(ice = CONFIG.TARGET_ICE): Promise<string> {
  return (await resolveDossier(ice)).id;
}
