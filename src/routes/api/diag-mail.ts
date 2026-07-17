// ============================================================================
// /api/diag-mail — pourquoi le mail d'approbation ne part-il pas ?
//
// Les logs Railway sont authentifiés et l'envoi SMTP n'est testable que DEPUIS
// le serveur (le port 587 est bloqué sur le réseau du poste de dev). Cette
// route fait donc parler le serveur lui-même : elle rapporte l'état de la
// configuration et tente un envoi réel, en renvoyant l'erreur SMTP telle quelle.
//
//   GET /api/diag-mail?token=<HMAC de "diag-mail">
//
// ⚠️ ROUTE DE DIAGNOSTIC TEMPORAIRE — à supprimer une fois le mail réparé.
//
// Sécurité : jeton signé avec APPROVAL_TOKEN_SECRET (même mécanisme que le lien
// d'approbation), donc non devinable. Aucun secret n'est renvoyé : uniquement la
// PRÉSENCE des variables et la longueur du mot de passe. Le mail de test part à
// l'adresse admin fixe, jamais à une adresse fournie dans l'URL.
// ============================================================================
import { createFileRoute } from "@tanstack/react-router";
import { verifyApprovalToken } from "@/server/approval.token";
import { getAdminEmail, getAppUrl } from "@/server/approval.functions";
import { sendMail } from "@/server/mailer";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/** Présence d'une variable, sans jamais révéler sa valeur. */
const etat = (v: string | undefined) => (v && v.trim() ? `présent (${v.trim().length} car.)` : "❌ ABSENT");

export const Route = createFileRoute("/api/diag-mail")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const token = new URL(request.url).searchParams.get("token") ?? "";

        // Si le secret manque, verifyApprovalToken lève. C'est en soi le
        // diagnostic : sans lui, aucun mail d'approbation ne peut partir, car
        // le lien est signé AVANT l'envoi.
        try {
          if (!verifyApprovalToken("diag-mail", token)) {
            return json({ erreur: "jeton invalide — APPROVAL_TOKEN_SECRET diffère de celui du poste de dev" }, 403);
          }
        } catch (err: any) {
          return json({
            cause_probable: "APPROVAL_TOKEN_SECRET absent ou trop court SUR CE SERVEUR",
            consequence: "le lien d'approbation ne peut pas être signé, donc le mail n'est jamais envoyé",
            detail: err?.message ?? String(err),
          }, 200);
        }

        const config = {
          SMTP_HOST: process.env.SMTP_HOST ?? "❌ ABSENT",
          SMTP_PORT: process.env.SMTP_PORT ?? "(défaut 587)",
          SMTP_USER: process.env.SMTP_USER ?? "❌ ABSENT",
          SMTP_PASS: etat(process.env.SMTP_PASS),
          SMTP_SECURE: process.env.SMTP_SECURE ?? "(auto d'après le port)",
          FROM_EMAIL: process.env.FROM_EMAIL ?? "(repli sur SMTP_USER)",
          APPROVAL_TOKEN_SECRET: etat(process.env.APPROVAL_TOKEN_SECRET),
          destinataire_admin: getAdminEmail(),
          url_des_liens: getAppUrl(),
        };

        // L'envoi réel : c'est lui qui donne la vraie cause.
        const t0 = Date.now();
        try {
          const r = await sendMail({
            to: getAdminEmail(),
            subject: "Test HisabPro — diagnostic d'envoi",
            html: "<p>Si vous lisez ceci, le SMTP du serveur fonctionne.</p><p>Le mail d'approbation emprunte exactement ce chemin.</p>",
          });
          return json({
            envoi: "✅ RÉUSSI",
            messageId: r.messageId,
            duree_ms: Date.now() - t0,
            suite: `Le SMTP fonctionne. Si rien n'arrive sur ${getAdminEmail()}, regardez les SPAMS — le problème est la délivrabilité, pas l'envoi.`,
            config,
          });
        } catch (err: any) {
          return json({
            envoi: "❌ ÉCHOUÉ",
            duree_ms: Date.now() - t0,
            cause: err?.message ?? String(err),
            config,
          });
        }
      },
    },
  },
});
