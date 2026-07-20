// ============================================================================
// /api/reject-user — cible du bouton « Refuser » du mail d'approbation.
//
// Refuser SUPPRIME le compte (profil et cabinet suivent en cascade). Le laisser
// simplement banni aurait l'air équivalent — il ne peut pas se connecter dans
// les deux cas — mais l'adresse resterait prise à vie : la personne refusée par
// erreur ne pourrait jamais se réinscrire, et l'admin n'a aucun écran pour
// nettoyer. Un refus rend donc l'adresse libre.
//
// GET  = page de confirmation (ne modifie RIEN)
// POST = suppression effective
//
// Pourquoi ce détour en deux temps, alors que l'approbation agit dès le GET :
// les clients mail (Gmail, Outlook) et les antivirus PRÉ-CHARGENT les liens
// d'un message pour les analyser. Sur l'approbation, un préchargement est
// bénin — le pire cas approuve un compte que l'admin allait approuver. Sur un
// refus, il détruirait le compte sans que personne n'ait cliqué. La suppression
// exige donc une action que seul un humain déclenche.
// ============================================================================
import { createFileRoute } from "@tanstack/react-router";
import { verifyApprovalToken } from "@/server/approval.token";
import { getSupabaseAdmin } from "@/server/approval.functions";

function page(titre: string, corps: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="fr"><head><meta charset="utf-8">
     <meta name="viewport" content="width=device-width,initial-scale=1">
     <title>${titre}</title></head>
     <body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:60px auto;padding:0 20px;color:#111">
     ${corps}</body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

/** Le jeton est le même HMAC que pour l'approbation : un admin qui détient le
 *  lien du mail détient les deux pouvoirs, approuver et refuser. */
function jetonValide(userId: string, token: string): { ok: boolean; erreur?: Response } {
  try {
    if (!verifyApprovalToken(userId, token)) {
      return { ok: false, erreur: page("Lien invalide", `<h2>Lien invalide ou expiré</h2><p style="color:#555">Ce lien de refus n'est pas valide. Aucune action n'a été effectuée.</p>`, 400) };
    }
    return { ok: true };
  } catch (err: any) {
    // APPROVAL_TOKEN_SECRET absent → échec fermé, comme /api/approve-user.
    console.error("[reject-user] configuration:", err?.message ?? err);
    return { ok: false, erreur: page("Indisponible", `<h2>Refus indisponible</h2><p style="color:#555">Le serveur n'est pas configuré (APPROVAL_TOKEN_SECRET).</p>`, 500) };
  }
}

export const Route = createFileRoute("/api/reject-user")({
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

        // L'e-mail est relu en base : l'admin doit voir QUI il refuse, et le
        // paramètre d'URL ne peut pas le lui mentir.
        let email = "(compte inconnu)";
        try {
          const sb = getSupabaseAdmin();
          const { data } = await sb.from("profiles").select("email").eq("id", userId).maybeSingle();
          if (!data) return page("Introuvable", `<h2>Compte introuvable</h2><p style="color:#555">Ce compte a déjà été supprimé. Rien à faire.</p>`);
          email = (data as any).email ?? email;
        } catch (err: any) {
          console.error("[reject-user] lecture profil:", err?.message ?? err);
          return page("Erreur", `<h2>Erreur serveur</h2><p style="color:#555">Impossible de lire le compte. Consultez les logs.</p>`, 500);
        }

        return page(
          "Confirmer le refus",
          `<h2 style="margin:0 0 4px">Refuser cette inscription ?</h2>
           <p style="color:#555;margin:0 0 24px">
             Le compte <strong>${email}</strong> sera <strong>définitivement supprimé</strong>, ainsi que son cabinet.
             L'adresse redeviendra libre : la personne pourra se réinscrire.
           </p>
           <form method="POST">
             <input type="hidden" name="userId" value="${userId}">
             <input type="hidden" name="token" value="${token}">
             <button type="submit" style="background:#dc2626;color:#fff;border:0;padding:12px 22px;border-radius:6px;font-weight:600;font-size:15px;cursor:pointer">
               Oui, refuser et supprimer
             </button>
           </form>
           <p style="color:#888;font-size:13px;margin-top:24px">Fermez cette page pour annuler — le compte restera en attente.</p>`
        );
      },

      // Suppression effective.
      POST: async ({ request }) => {
        const form = await request.formData();
        const userId = String(form.get("userId") ?? "");
        const token = String(form.get("token") ?? "");

        const v = jetonValide(userId, token);
        if (!v.ok) return v.erreur!;

        try {
          const sb = getSupabaseAdmin();
          const { data: prof } = await sb.from("profiles").select("email").eq("id", userId).maybeSingle();
          const email = (prof as any)?.email ?? userId;

          // deleteUser purge auth.users ; profiles et cabinets suivent par la
          // cascade des clés étrangères.
          const { error } = await sb.auth.admin.deleteUser(userId);
          if (error) throw new Error(error.message);

          console.log(`[reject-user] inscription refusée, compte supprimé : ${email}`);
          return page(
            "Inscription refusée",
            `<h2 style="margin:0 0 4px">Inscription refusée</h2>
             <p style="color:#555">Le compte <strong>${email}</strong> a été supprimé. Il ne peut pas se connecter, et l'adresse est de nouveau disponible.</p>`
          );
        } catch (err: any) {
          console.error("[reject-user] échec:", err?.message ?? err);
          return page("Erreur", `<h2>Refus impossible</h2><p style="color:#555">Erreur serveur. Consultez les logs.</p>`, 500);
        }
      },
    },
  },
});
