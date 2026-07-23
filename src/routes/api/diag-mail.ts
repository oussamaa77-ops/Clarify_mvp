// ============================================================================
// /api/diag-mail — pourquoi le mail d'approbation ne part-il pas ?
//
// Les logs Railway sont authentifiés et l'envoi SMTP n'est testable que DEPUIS
// le serveur (le port 587 est bloqué sur le réseau du poste de dev). Cette
// route fait donc parler le serveur lui-même : elle rapporte l'état de la
// configuration et tente un envoi réel, en renvoyant l'erreur SMTP telle quelle.
//
//   GET /api/diag-mail?token=<HMAC de "diag-mail">
//        → état de la config + tentative d'envoi réel avec la config en place.
//   GET /api/diag-mail?token=…&sonde=1
//        → sonde TCP des ports SMTP usuels (25/465/587/2525) DEPUIS le serveur.
//          C'est ce qui a révélé la panne : Railway filtre le 587 sortant.
//   GET /api/diag-mail?token=…&port=465[&host=smtp.gmail.com]
//        → envoi réel en forçant ce port, sans modifier la config du serveur.
//          Sert à valider un port AVANT de figer SMTP_PORT dans Railway.
//
// ⚠️ ROUTE DE DIAGNOSTIC TEMPORAIRE — à supprimer une fois le mail réparé.
//
// Sécurité : jeton signé avec APPROVAL_TOKEN_SECRET (même mécanisme que le lien
// d'approbation), donc non devinable. Aucun secret n'est renvoyé : uniquement la
// PRÉSENCE des variables et la longueur du mot de passe. Le mail de test part à
// l'adresse admin fixe, jamais à une adresse fournie dans l'URL.
// ============================================================================
import { createFileRoute } from "@tanstack/react-router";
import { connect } from "node:net";
import { verifyApprovalToken } from "@/server/approval.token";
import { getAdminEmail, getAppUrl } from "@/server/approval.functions";
import { sendMail, sendMailEssai } from "@/server/mailer";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/** Présence d'une variable, sans jamais révéler sa valeur. */
const etat = (v: string | undefined) => (v && v.trim() ? `présent (${v.trim().length} car.)` : "❌ ABSENT");

/** Ports SMTP à sonder. Gmail écoute en 587 (STARTTLS) et 465 (TLS implicite) ;
 *  les relais tiers ajoutent souvent le 2525, précisément parce que les
 *  hébergeurs filtrent les ports SMTP « officiels ». Le 25 est bloqué partout,
 *  il sert de témoin. */
const PORTS_SONDES: Array<{ host: string; port: number; note: string }> = [
  { host: "smtp.gmail.com", port: 587, note: "STARTTLS — le port actuellement configuré" },
  { host: "smtp.gmail.com", port: 465, note: "TLS implicite — repli le plus probable" },
  { host: "smtp.gmail.com", port: 25, note: "témoin : bloqué chez tous les hébergeurs" },
  { host: "smtp-relay.brevo.com", port: 587, note: "relais tiers" },
  { host: "smtp-relay.brevo.com", port: 2525, note: "port alternatif des relais tiers" },
];

/** Ouvre une socket TCP et referme aussitôt : on ne teste QUE l'accessibilité
 *  du port, pas l'authentification. Un timeout = port filtré par l'hébergeur. */
function sonderPort(host: string, port: number, timeoutMs = 6000): Promise<string> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const socket = connect({ host, port });
    const fini = (verdict: string) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(`${verdict} (${Date.now() - t0} ms)`);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => fini("✅ OUVERT"));
    socket.once("timeout", () => fini("❌ FILTRÉ — timeout"));
    socket.once("error", (e: any) => fini(`❌ ${e?.code ?? e?.message ?? "erreur"}`));
  });
}

export const Route = createFileRoute("/api/diag-mail")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const params = new URL(request.url).searchParams;
        const token = params.get("token") ?? "";

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

        // Sonde des ports : aucune donnée envoyée, on ouvre et on referme.
        if (params.get("sonde")) {
          const ports: Record<string, string> = {};
          await Promise.all(
            PORTS_SONDES.map(async ({ host, port, note }) => {
              ports[`${host}:${port}`] = `${await sonderPort(host, port)}  — ${note}`;
            })
          );
          return json({
            sonde: "ports SMTP sortants, vus DEPUIS le serveur",
            ports,
            lecture:
              "Un port ✅ OUVERT peut porter le SMTP : posez SMTP_PORT (et SMTP_HOST si besoin) " +
              "sur cette valeur, puis validez par un envoi réel avec ?port=<n> avant de redéployer. " +
              "Si TOUS sont filtrés, l'hébergeur interdit le SMTP sortant : il faut un envoi HTTP (443).",
          });
        }

        // Envoi réel sur un port imposé, pour valider un candidat de la sonde.
        const portForce = Number(params.get("port") ?? 0);
        if (portForce) {
          const hostForce = params.get("host")?.trim() || undefined;
          const t = Date.now();
          try {
            const r = await sendMailEssai(
              {
                to: getAdminEmail(),
                subject: `Test HisabPro — envoi via le port ${portForce}`,
                html: `<p>Ce message est parti par <strong>${hostForce ?? process.env.SMTP_HOST}:${portForce}</strong>.</p><p>Ce port fonctionne : posez-le dans SMTP_PORT côté serveur.</p>`,
              },
              { host: hostForce, port: portForce }
            );
            return json({
              essai: `✅ RÉUSSI sur ${hostForce ?? process.env.SMTP_HOST}:${portForce}`,
              messageId: r.messageId,
              duree_ms: Date.now() - t,
              suite: `Posez SMTP_PORT=${portForce}${hostForce ? ` et SMTP_HOST=${hostForce}` : ""} dans les variables Railway, puis redéployez.`,
            });
          } catch (err: any) {
            return json({
              essai: `❌ ÉCHOUÉ sur ${hostForce ?? process.env.SMTP_HOST}:${portForce}`,
              duree_ms: Date.now() - t,
              cause: err?.message ?? String(err),
            });
          }
        }

        const config = {
          RESEND_API_KEY: etat(process.env.RESEND_API_KEY),
          RESEND_FROM: process.env.RESEND_FROM ?? "(défaut : Clarify <onboarding@resend.dev>)",
          BREVO_API_KEY: etat(process.env.BREVO_API_KEY),
          MAIL_TRANSPORT: process.env.MAIL_TRANSPORT ?? "(auto : Resend d'abord, puis SMTP, puis Brevo)",
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
            html: "<p>Si vous lisez ceci, l'envoi d'e-mails du serveur fonctionne.</p><p>Le mail d'approbation emprunte exactement ce chemin.</p>",
          });
          return json({
            envoi: "✅ RÉUSSI",
            messageId: r.messageId,
            duree_ms: Date.now() - t0,
            suite: `L'envoi fonctionne. Si rien n'arrive sur ${getAdminEmail()}, regardez les SPAMS — le problème est la délivrabilité, pas l'envoi.`,
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
