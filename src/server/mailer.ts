// ============================================================================
// mailer.ts — Envoi d'e-mails via SMTP « classique » (nodemailer).
//
// Remplace l'API Brevo (config capricieuse : clé v3, IP autorisées, sender
// validé). Ici on parle SMTP standard : n'importe quel fournisseur convient
// (Gmail/Google Workspace, OVH, Outlook 365, Brevo-SMTP, Mailgun-SMTP, …).
//
// ⚠ ANTI-SPAM — deux niveaux :
//   1) Contenu / en-têtes (géré par ce code) : version texte + HTML
//      (multipart/alternative), Reply-To, List-Unsubscribe, Message-ID sur le
//      domaine expéditeur, Date, encodage propre. Ça fait chuter le score spam.
//   2) Authentification DNS (À FAIRE côté domaine, indispensable pour ne PAS
//      tomber en spam) : SPF, DKIM et DMARC sur le domaine de FROM_EMAIL.
//      → voir .env.example pour le détail. Sans DKIM aligné, Gmail/Outlook
//        classeront le message en indésirable quoi qu'on fasse dans le code.
// ============================================================================

import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

export interface MailAttachment {
  name: string;
  // Fournir UNE des trois sources ci-dessous (priorité : buffer > path > content) :
  content?: string;          // contenu encodé en base64
  path?: string;             // chemin d'un fichier local OU URL (http/https/data:)
  contentBuffer?: Buffer;    // flux binaire déjà en mémoire (ex. fichier téléchargé)
  type?: string;             // type MIME (ex. application/pdf)
}

export interface SendMailInput {
  to: string;
  toName?: string;
  subject: string;
  html: string;
  text?: string;          // fallback texte ; dérivé du HTML si absent
  replyTo?: string;
  attachments?: MailAttachment[];
}

// ── Configuration SMTP depuis l'environnement ────────────────────────────────
function readConfig() {
  const host = (process.env.SMTP_HOST ?? "").trim();
  const port = Number(process.env.SMTP_PORT ?? 587);
  const user = (process.env.SMTP_USER ?? "").trim();
  const pass = (process.env.SMTP_PASS ?? "").trim();
  // `secure` = TLS implicite (port 465). Pour 587 on utilise STARTTLS (secure=false).
  // Auto-déduit du port si SMTP_SECURE n'est pas explicitement posé.
  const secureEnv = (process.env.SMTP_SECURE ?? "").trim().toLowerCase();
  const secure = secureEnv ? secureEnv === "true" || secureEnv === "1" : port === 465;
  // Derrière un proxy d'inspection TLS d'entreprise, le certificat présenté est
  // celui du proxy → la vérif échoue. On autorise à la désactiver explicitement.
  const rejectUnauthorized = (process.env.SMTP_TLS_REJECT_UNAUTHORIZED ?? "true").trim().toLowerCase() !== "false";

  const fromEmail = (process.env.FROM_EMAIL ?? user ?? "noreply@localhost").trim();
  const fromName = (process.env.FROM_NAME ?? "HisabPro").trim();
  return { host, port, user, pass, secure, rejectUnauthorized, fromEmail, fromName };
}

// Transporteur mis en cache (pool de connexions) — recréé si la config change.
let _transporter: Transporter | null = null;
let _sig = "";
function getTransporter(cfg: ReturnType<typeof readConfig>): Transporter {
  const sig = JSON.stringify([cfg.host, cfg.port, cfg.user, cfg.secure, cfg.rejectUnauthorized]);
  if (_transporter && sig === _sig) return _transporter;
  _transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    pool: true,
    maxConnections: 3,
    // Timeouts courts et EXPLICITES. Sans ça, nodemailer attend ses défauts
    // (connectionTimeout ~2 min) avant d'abandonner quand le port SMTP est
    // filtré — ce qui figeait l'inscription : l'envoi du mail d'approbation est
    // best-effort mais reste `await`é, donc son blocage bloque tout le parcours.
    // On préfère un échec rapide (→ « admin non prévenu ») à un formulaire figé.
    connectionTimeout: 10_000,
    greetingTimeout: 8_000,
    socketTimeout: 15_000,
    tls: {
      rejectUnauthorized: cfg.rejectUnauthorized,
      // SNI correct = certains serveurs refusent sinon.
      servername: cfg.host || undefined,
    },
  });
  _sig = sig;
  return _transporter;
}

// HTML → texte lisible (fallback multipart/alternative). Un e-mail HTML SANS
// partie texte est un signal spam classique ; on en génère toujours une.
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/(p|div|h[1-6]|li|tr|table|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/**
 * Envoie un e-mail via SMTP. Lève une erreur explicite et actionnable si la
 * config est absente ou si le serveur SMTP refuse le message.
 */
export async function sendMail(
  input: SendMailInput
): Promise<{ success: true; messageId: string }> {
  const cfg = readConfig();

  if (!cfg.host) {
    throw new Error(
      "SMTP non configuré : renseignez SMTP_HOST, SMTP_PORT, SMTP_USER et SMTP_PASS dans .env (voir .env.example), puis redémarrez le serveur."
    );
  }

  const transporter = getTransporter(cfg);

  // Domaine de l'expéditeur → sert au Message-ID (aligné avec le From, meilleur
  // pour la réputation) et au lien de désabonnement RFC 8058.
  const fromDomain = cfg.fromEmail.split("@")[1] || "localhost";

  const text = input.text?.trim() || htmlToText(input.html);

  try {
    const info = await transporter.sendMail({
      from: { name: cfg.fromName, address: cfg.fromEmail },
      to: input.toName ? { name: input.toName, address: input.to } : input.to,
      // Reply-To = adresse expéditeur par défaut → les réponses reviennent bien.
      replyTo: input.replyTo ?? cfg.fromEmail,
      subject: input.subject,
      text,
      html: input.html,
      // Enveloppe SMTP (MAIL FROM) alignée sur le From → SPF passe sur le bon domaine.
      envelope: { from: cfg.fromEmail, to: input.to },
      messageId: `<${Date.now()}.${Math.random().toString(36).slice(2)}@${fromDomain}>`,
      headers: {
        // Réduit le score spam pour les envois transactionnels/relances.
        "List-Unsubscribe": `<mailto:${cfg.fromEmail}?subject=unsubscribe>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        "X-Entity-Ref-ID": `${Date.now()}`,
        "X-Mailer": "HisabPro",
      },
      // Pièces jointes : on mappe chaque source vers l'option nodemailer adéquate.
      //   • contentBuffer → content (flux binaire, idéal pour un fichier téléchargé) ;
      //   • path          → path (fichier local OU URL ; nodemailer le récupère) ;
      //   • content       → content + encoding base64 (compat historique).
      attachments: input.attachments?.map((a) => {
        const base = { filename: a.name, contentType: a.type };
        if (a.contentBuffer) return { ...base, content: a.contentBuffer };
        if (a.path) return { ...base, path: a.path };
        return { ...base, content: a.content ?? "", encoding: "base64" as const };
      }),
    });

    console.log(`[SMTP] Email envoyé à ${input.to} | ID: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (e: any) {
    const code = e?.code ?? "";
    const resp = e?.response ?? e?.message ?? String(e);
    // Messages actionnables sur les échecs SMTP les plus fréquents.
    if (code === "EAUTH" || /535|authentication|invalid login|username and password/i.test(String(resp))) {
      throw new Error(
        `Authentification SMTP refusée. Vérifiez SMTP_USER / SMTP_PASS dans .env. ` +
          `Pour Gmail/Workspace, utilisez un « mot de passe d'application » (pas votre mot de passe habituel). [${resp}]`
      );
    }
    if (code === "ECONNECTION" || code === "ETIMEDOUT" || code === "ESOCKET" || /ECONNREFUSED|EHOSTUNREACH/i.test(String(code))) {
      throw new Error(
        `Connexion au serveur SMTP impossible (${cfg.host}:${cfg.port}). ` +
          `Vérifiez SMTP_HOST / SMTP_PORT et que le pare-feu/proxy autorise le port SMTP sortant. [${code} ${resp}]`
      );
    }
    if (/self.signed|unable to verify|cert/i.test(String(resp))) {
      throw new Error(
        `Certificat TLS refusé par le proxy d'entreprise. Posez SMTP_TLS_REJECT_UNAUTHORIZED=false dans .env pour ce réseau, puis redémarrez. [${resp}]`
      );
    }
    throw new Error(`Envoi SMTP échoué : ${resp}`);
  }
}
