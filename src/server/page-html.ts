// ============================================================================
// page-html.ts — mini-pages HTML des liens d'administration (approbation et
// refus d'une inscription), ouvertes depuis l'e-mail de l'admin.
// ============================================================================

/** Échappe une valeur avant de l'insérer dans le HTML. L'e-mail vient du
 *  formulaire d'inscription : sans échappement, une adresse à partie locale
 *  entre guillemets (`"<img src=x onerror=…>"@x.com`) exécuterait du script
 *  dans la session de l'admin qui ouvre le lien. */
export function echapper(valeur: string): string {
  return valeur
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** `titre` et `corps` sont du HTML de confiance : toute valeur venue de
 *  l'extérieur doit y entrer par `echapper`. */
export function page(titre: string, corps: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="fr"><head><meta charset="utf-8">
     <meta name="viewport" content="width=device-width,initial-scale=1">
     <title>${titre}</title></head>
     <body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:60px auto;padding:0 20px;color:#111">
     ${corps}</body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}
