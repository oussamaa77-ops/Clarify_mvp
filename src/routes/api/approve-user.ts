// ============================================================================
// /api/approve-user — cible du lien d'approbation reçu par l'administrateur.
//
// GET  ?userId=<uuid>&token=<hmac> = page de confirmation (ne modifie RIEN)
// POST (mêmes champs, en formulaire)  = approbation effective :
//   1. vérifie la signature du jeton (HMAC de l'userId, comparaison à temps
//      constant) — sans quoi il suffirait de deviner un UUID pour s'approuver ;
//   2. passe is_approved à true via la CLÉ DE SERVICE (la RLS interdit cette
//      écriture à tout le monde, y compris à l'intéressé — cf. le trigger
//      prevent_self_approval) ;
//   3. renvoie vers /auth avec un message.
//
// Pourquoi deux temps : les clients mail (Outlook Safe Links, Gmail) et les
// antivirus PRÉ-CHARGENT les liens d'un message pour les analyser. Une
// approbation dès le GET validait donc CHAQUE inscription sans que l'admin ait
// cliqué — le filtre d'approbation ne filtrait plus rien. Même schéma que
// /api/reject-user.
//
// Route SERVEUR pure : pas de composant, uniquement `server.handlers`. C'est la
// convention de TanStack Start 1.167 (createServerFileRoute n'existe plus).
// ============================================================================
import { createFileRoute } from "@tanstack/react-router";
import { verifyApprovalToken } from "@/server/approval.token";
import { getSupabaseAdmin } from "@/server/approval.functions";
import { echapper, page } from "@/server/page-html";

function redirige(vers: string): Response {
  // 303 : force le navigateur à faire un GET sur la cible.
  return new Response(null, { status: 303, headers: { Location: vers } });
}

/** verifyApprovalToken lève si APPROVAL_TOKEN_SECRET est absent : c'est voulu
 *  (échec fermé). On le distingue d'un jeton invalide pour que l'admin
 *  comprenne qu'il s'agit d'une config serveur, pas d'un lien mort. */
function jetonValide(userId: string, token: string): { ok: boolean; erreur?: Response } {
  try {
    if (!verifyApprovalToken(userId, token)) {
      console.warn(`[approve-user] jeton refusé pour userId=${userId}`);
      return { ok: false, erreur: redirige("/auth?approbation=invalide") };
    }
    return { ok: true };
  } catch (err: any) {
    console.error("[approve-user] configuration:", err?.message ?? err);
    return {
      ok: false,
      erreur: new Response(
        "Approbation indisponible : le serveur n'est pas configuré (APPROVAL_TOKEN_SECRET).",
        { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } }
      ),
    };
  }
}

export const Route = createFileRoute("/api/approve-user")({
  server: {
    handlers: {
      // Confirmation. Aucun effet de bord : un préchargement par le client mail
      // n'affiche que cette page.
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const userId = url.searchParams.get("userId") ?? "";
        const token = url.searchParams.get("token") ?? "";

        const v = jetonValide(userId, token);
        if (!v.ok) return v.erreur!;

        // L'e-mail est relu en base : l'admin doit voir QUI il approuve.
        let email: string;
        try {
          const { data } = await getSupabaseAdmin()
            .from("profiles").select("email, is_approved").eq("id", userId).maybeSingle();
          if (!data) return redirige("/auth?approbation=introuvable");
          if ((data as any).is_approved) return redirige("/auth?approbation=ok");
          email = (data as any).email ?? "(adresse inconnue)";
        } catch (err: any) {
          console.error("[approve-user] lecture profil:", err?.message ?? err);
          return page("Erreur", `<h2>Erreur serveur</h2><p style="color:#555">Impossible de lire le compte. Consultez les logs.</p>`, 500);
        }

        return page(
          "Confirmer l'approbation",
          `<h2 style="margin:0 0 4px">Approuver cette inscription ?</h2>
           <p style="color:#555;margin:0 0 24px">
             Le compte <strong>${echapper(email)}</strong> pourra se connecter et accéder à son cabinet.
           </p>
           <form method="POST">
             <input type="hidden" name="userId" value="${echapper(userId)}">
             <input type="hidden" name="token" value="${echapper(token)}">
             <button type="submit" style="background:#16a34a;color:#fff;border:0;padding:12px 22px;border-radius:6px;font-weight:600;font-size:15px;cursor:pointer">
               Oui, approuver
             </button>
           </form>
           <p style="color:#888;font-size:13px;margin-top:24px">Fermez cette page pour annuler — le compte restera en attente.</p>`
        );
      },

      // Approbation effective.
      POST: async ({ request }) => {
        const form = await request.formData();
        const userId = String(form.get("userId") ?? "");
        const token = String(form.get("token") ?? "");

        const v = jetonValide(userId, token);
        if (!v.ok) return v.erreur!;

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

          // Lever le bannissement posé à l'inscription : sans ça, is_approved
          // aurait beau être true, le serveur d'auth continuerait de refuser
          // tout jeton et le compte resterait inutilisable.
          const { error: debanErr } = await sb.auth.admin.updateUserById(userId, { ban_duration: "none" });
          if (debanErr) throw new Error(`compte approuvé mais toujours banni : ${debanErr.message}`);

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
