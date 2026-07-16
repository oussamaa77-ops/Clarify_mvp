// ============================================================================
// /api/approve-user — cible du lien d'approbation reçu par l'administrateur.
//
// GET ?userId=<uuid>&token=<hmac>
//   1. vérifie la signature du jeton (HMAC de l'userId, comparaison à temps
//      constant) — sans quoi il suffirait de deviner un UUID pour s'approuver ;
//   2. passe is_approved à true via la CLÉ DE SERVICE (la RLS interdit cette
//      écriture à tout le monde, y compris à l'intéressé — cf. le trigger
//      prevent_self_approval) ;
//   3. renvoie vers /auth avec un message.
//
// Route SERVEUR pure : pas de composant, uniquement `server.handlers`. C'est la
// convention de TanStack Start 1.167 (createServerFileRoute n'existe plus).
// ============================================================================
import { createFileRoute } from "@tanstack/react-router";
import { verifyApprovalToken } from "@/server/approval.token";
import { getSupabaseAdmin } from "@/server/approval.functions";

function redirige(vers: string): Response {
  // 303 : force le navigateur à faire un GET sur la cible.
  return new Response(null, { status: 303, headers: { Location: vers } });
}

export const Route = createFileRoute("/api/approve-user")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const userId = url.searchParams.get("userId") ?? "";
        const token = url.searchParams.get("token") ?? "";

        // verifyApprovalToken lève si APPROVAL_TOKEN_SECRET est absent : c'est
        // voulu (échec fermé). On le distingue d'un jeton invalide pour que
        // l'admin comprenne qu'il s'agit d'une config serveur, pas d'un lien mort.
        let valide: boolean;
        try {
          valide = verifyApprovalToken(userId, token);
        } catch (err: any) {
          console.error("[approve-user] configuration:", err?.message ?? err);
          return new Response(
            "Approbation indisponible : le serveur n'est pas configuré (APPROVAL_TOKEN_SECRET).",
            { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } }
          );
        }

        if (!valide) {
          console.warn(`[approve-user] jeton refusé pour userId=${userId}`);
          return redirige("/auth?approbation=invalide");
        }

        try {
          const sb = getSupabaseAdmin();
          const { data, error } = await sb
            .from("profiles")
            .update({ is_approved: true })
            .eq("id", userId)
            .select("email")
            .maybeSingle();

          if (error) throw new Error(error.message);
          if (!data) return redirige("/auth?approbation=introuvable");

          console.log(`[approve-user] compte approuvé : ${(data as any).email}`);
          return redirige("/auth?approbation=ok");
        } catch (err: any) {
          console.error("[approve-user] échec:", err?.message ?? err);
          return new Response("Approbation impossible : erreur serveur. Consultez les logs.", {
            status: 500,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        }
      },
    },
  },
});
