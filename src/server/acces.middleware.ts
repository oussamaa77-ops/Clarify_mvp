// ============================================================================
// acces.middleware.ts — middleware GLOBAL des server functions (src/start.ts).
//
// Côté navigateur : joint le jeton de session Supabase à chaque appel. Les
// server fns ne le portaient pas jusqu'ici, si bien que le serveur ne savait
// jamais QUI appelait.
// Côté serveur : refuse tout appel sans session valide (hors FONCTIONS_PUBLIQUES),
// puis tout appel qui vise un dossier ou une pièce hors de portée de
// l'utilisateur. Voir acces.ts pour le pourquoi.
// ============================================================================
import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { supabase } from "@/integrations/supabase/client";
import { AccesRefuse, FONCTIONS_PUBLIQUES, exigerAcces, utilisateurDuJeton } from "./acces";
import { getSupabaseAdmin } from "./supabase-admin";

export const accesMiddleware = createMiddleware({ type: "function" })
  .client(async ({ next }) => {
    let headers: Record<string, string> | undefined;
    try {
      const { data } = await supabase.auth.getSession();
      const jeton = data.session?.access_token;
      if (jeton) headers = { Authorization: `Bearer ${jeton}` };
    } catch {
      // Pas de session lisible : l'appel part sans jeton, le serveur tranchera.
    }
    return next({ headers });
  })
  .server(async ({ next, data, serverFnMeta }) => {
    if (FONCTIONS_PUBLIQUES.has(serverFnMeta.name)) return next({ context: { userId: null as string | null } });

    const sb = getSupabaseAdmin();
    try {
      const userId = await utilisateurDuJeton(sb, getRequest()?.headers.get("authorization") ?? null);
      await exigerAcces(sb, userId, data);
      return next({ context: { userId: userId as string | null } });
    } catch (err) {
      if (err instanceof AccesRefuse) {
        console.warn(`[acces] ${serverFnMeta.name} refusée (${err.status}) : ${err.message}`);
        throw new Response(err.message, { status: err.status });
      }
      throw err;
    }
  });
