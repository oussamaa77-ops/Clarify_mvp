import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { sendMail } from "./mailer";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ── Webhook Inbound (Brevo / autre fournisseur) ───────────────────────────────
// Brevo appelle ce endpoint quand un email est reçu sur votre adresse inbound
// Configuration sur brevo.com → Transactional → Inbound → Add a new inbound webhook
// URL: https://VOTRE_URL/api/mail/inbound

export const handleInboundMail = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.any().parse(input))
  .handler(async ({ data }) => {
    try {
      const mail = data as any;

      // Extraire les infos de base
      const expediteur = mail.From?.Address ?? mail.from ?? "";
      const sujet = mail.Subject ?? mail.subject ?? "";
      const corps = mail.HtmlBody ?? mail.TextBody ?? mail.body ?? "";
      const dateRecu = new Date().toISOString();

      console.log(`[MAIL INBOUND] De: ${expediteur} | Sujet: ${sujet}`);

      // Identifier le dossier depuis l'email de l'expéditeur
      // Chercher un client ou un utilisateur avec cet email
      const { data: client } = await supabase
        .from("clients")
        .select("id, nom, dossier_id")
        .eq("email", expediteur)
        .maybeSingle();

      const { data: profil } = await supabase
        .from("profiles")
        .select("id, email")
        .eq("email", expediteur)
        .maybeSingle();

      const dossierId = client?.dossier_id ?? null;

      // Traiter les pièces jointes (relevés bancaires, factures)
      const attachments = mail.Attachments ?? mail.attachments ?? [];
      const pjTraitees: string[] = [];

      for (const pj of attachments) {
        const nomFichier = pj.Name ?? pj.filename ?? "fichier";
        const contenuBase64 = pj.ContentBase64 ?? pj.content ?? "";
        const typeMime = pj.ContentType ?? pj.type ?? "application/octet-stream";

        if (!contenuBase64) continue;

        // Convertir base64 en buffer
        const buffer = Buffer.from(contenuBase64, "base64");

        // Stocker dans Supabase Storage
        const cheminFichier = `inbound/${dossierId ?? "general"}/${dateRecu.slice(0,10)}_${nomFichier}`;

        const { error: uploadError } = await supabase.storage
          .from("documents")
          .upload(cheminFichier, buffer, {
            contentType: typeMime,
            upsert: true,
          });

        if (!uploadError) {
          const { data: urlData } = supabase.storage
            .from("documents")
            .getPublicUrl(cheminFichier);

          // Enregistrer dans ged_documents si dossier identifié
          if (dossierId) {
            await supabase.from("ged_documents").insert({
              dossier_id: dossierId,
              nom_fichier: nomFichier,
              type_document: detecterTypeDocument(nomFichier, sujet),
              url_fichier: urlData.publicUrl,
              source: "email",
              expediteur,
              sujet_mail: sujet,
              created_at: dateRecu,
            });
          }

          pjTraitees.push(nomFichier);
          console.log(`[MAIL INBOUND] PJ sauvegardée: ${nomFichier}`);
        }
      }

      // Créer une alerte si dossier identifié
      if (dossierId) {
        await supabase.from("alertes").insert({
          dossier_id: dossierId,
          type: "info",
          titre: `Nouveau mail reçu de ${client?.nom ?? expediteur}`,
          message: `Sujet: ${sujet}${pjTraitees.length > 0 ? ` | Pièces jointes: ${pjTraitees.join(", ")}` : ""}`,
          lue: false,
        });
      }

      return {
        success: true,
        expediteur,
        dossier_id: dossierId,
        pieces_jointes: pjTraitees.length,
        message: dossierId
          ? `Mail traité et lié au dossier ${client?.nom}`
          : `Mail reçu mais aucun dossier trouvé pour ${expediteur}`,
      };
    } catch (e: any) {
      console.error("[MAIL INBOUND] Erreur:", e.message);
      return { success: false, error: e.message };
    }
  });

// ── Envoi d'email via SMTP « classique » (nodemailer) ─────────────────────────
// Anciennement Brevo (API v3). Le passage au SMTP standard élimine les blocages
// « clé API / IP autorisées / sender validé » ; l'anti-spam (texte+HTML, en-têtes,
// DKIM/SPF/DMARC côté DNS) est géré dans ./mailer (voir .env.example).
export const envoyerMail = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({
      to: z.string().email(),
      toName: z.string().optional(),
      subject: z.string(),
      html: z.string(),
      text: z.string().optional(),
      replyTo: z.string().email().optional(),
      // Une PJ = base64 (`content`) OU une URL / un chemin (`path`). Le Buffer
      // binaire n'est pas transportable en JSON → réservé aux appels serveur→serveur
      // qui passent par `sendMail` directement (ex. envoyerRelance).
      attachments: z.array(z.object({
        name: z.string(),
        content: z.string().optional(), // base64
        path: z.string().optional(),    // URL http(s) ou chemin fichier
        type: z.string().optional(),
      })).optional(),
    }).parse(input)
  )
  .handler(async ({ data }) => {
    return await sendMail(data);
  });

// Alias de compatibilité : d'anciens imports référencent encore `envoyerMailBrevo`.
export const envoyerMailBrevo = envoyerMail;

// ── Utilitaires ───────────────────────────────────────────────────────────────
function detecterTypeDocument(nomFichier: string, sujet: string): string {
  const nom = nomFichier.toLowerCase();
  const suj = sujet.toLowerCase();

  if (nom.includes("releve") || nom.includes("relevé") || suj.includes("releve"))
    return "releve_bancaire";
  if (nom.includes("facture") || nom.includes("invoice") || suj.includes("facture"))
    return "facture";
  if (nom.includes("contrat") || suj.includes("contrat"))
    return "contrat";
  if (nom.includes("bon_commande") || suj.includes("bon de commande"))
    return "bon_commande";

  return "document";
}
