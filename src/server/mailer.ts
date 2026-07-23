// ============================================================================
// mailer.ts — Point d'entrée UNIQUE de l'envoi d'e-mails. Aiguille vers le
// transport disponible ; tout le reste de l'app n'appelle que `sendMail`.
//
// ORDRE DES TRANSPORTS :
//   1. API Resend  (HTTPS/443) — DÉFAUT en production, dès que RESEND_API_KEY
//      est posée. Voir mailer.resend.ts.
//   2. SMTP        (nodemailer, ce fichier) — utilisé si aucune clé HTTP n'est
//      posée, et sur un réseau qui laisse sortir le 587/465.
//   3. API Brevo   (HTTPS/443) — filet historique, conservé.
//
// ⚠ POURQUOI RESEND EN PREMIER : Railway filtre le SMTP sortant
//   (smtp.gmail.com:587 → ENETUNREACH / ETIMEDOUT au bout de 10 s), tout comme
//   le réseau filaire du poste de dev. Le code SMTP était bon, le port était
//   fermé — c'est ce qui a tué le mail d'approbation d'inscription pendant des
//   jours. Le 443 passe partout.
//
// Si un jour vous revenez au SMTP, sonder les ports AVANT de relire ce fichier :
//     GET /api/diag-mail?token=…&sonde=1   (teste 25/465/587/2525)
//   Gmail écoute en 587 (STARTTLS) ET en 465 (TLS implicite) ; si l'un est
//   filtré, l'autre passe souvent. SMTP_PORT=465 suffit alors, SMTP_SECURE
//   étant déduit du port.
//
// Filet de secours SMTP : si le port se révèle filtré ET que BREVO_API_KEY est
// posée, l'envoi repart par l'API HTTP Brevo. Purement optionnel.
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

/** Surcharge ponctuelle de la config, pour ESSAYER un autre couple hôte/port
 *  sans toucher aux variables d'environnement du serveur (cf. /api/diag-mail,
 *  qui cherche quel port l'hébergeur laisse sortir). */
export interface SmtpOverride {
  host?: string;
  port?: number;
}

// ── Configuration SMTP depuis l'environnement ────────────────────────────────
function readConfig(o?: SmtpOverride) {
  const host = (o?.host ?? process.env.SMTP_HOST ?? "").trim();
  const port = Number(o?.port ?? process.env.SMTP_PORT ?? 587);
  const user = (process.env.SMTP_USER ?? "").trim();
  const pass = (process.env.SMTP_PASS ?? "").trim();
  // `secure` = TLS implicite (port 465). Pour 587 on utilise STARTTLS (secure=false).
  // Auto-déduit du port si SMTP_SECURE n'est pas explicitement posé — et TOUJOURS
  // déduit quand le port est surchargé, sinon un SMTP_SECURE hérité de l'ancien
  // port ferait échouer l'essai qu'on cherche justement à valider.
  const secureEnv = o?.port ? "" : (process.env.SMTP_SECURE ?? "").trim().toLowerCase();
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
  // Le pool garde des sockets ouvertes : fermer celui qu'on remplace, sinon
  // chaque essai de port via /api/diag-mail en abandonnerait trois derrière lui.
  _transporter?.close();
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

/** Panne RÉSEAU (port filtré) par opposition à un refus applicatif (mauvais mot
 *  de passe, destinataire rejeté). Seule la première justifie de changer de
 *  transport : réessayer un envoi refusé pour authentification serait vain. */
function estBlocageReseau(e: any): boolean {
  const code = String(e?.code ?? "");
  return (
    ["ECONNECTION", "ETIMEDOUT", "ESOCKET", "ECONNREFUSED", "EHOSTUNREACH", "EDNS"].includes(code) ||
    /ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|Connection timeout|Greeting never received/i.test(
      String(e?.message ?? "")
    )
  );
}

/** Une fois le port SMTP constaté filtré, ne plus repayer 10 s de timeout à
 *  chaque envoi : l'inscription attend ce mail pendant que l'utilisateur
 *  regarde le formulaire. Remis à zéro au redémarrage du serveur, ce qui suffit
 *  (changer de réseau implique de toute façon un redéploiement). */
let SMTP_BLOQUE = false;

/**
 * Envoie un e-mail. Resend (HTTPS) est le transport par défaut ; SMTP prend le
 * relais si aucune clé HTTP n'est posée, avec Brevo en dernier filet quand le
 * port se révèle filtré. Lève une erreur explicite et actionnable sinon.
 */
export async function sendMail(
  input: SendMailInput
): Promise<{ success: true; messageId: string }> {
  const cfg = readConfig();
  const { sendMailBrevo, brevoApiKey } = await import("./mailer.brevo");
  const { sendMailResend, resendApiKey } = await import("./mailer.resend");

  const force = (process.env.MAIL_TRANSPORT ?? "auto").trim().toLowerCase();
  const resendDispo = !!resendApiKey() && (force === "auto" || force === "resend");
  const brevoDispo = !!brevoApiKey() && (force === "auto" || force === "brevo");
  const smtpDispo = !!cfg.host && (force === "auto" || force === "smtp");

  if (!resendDispo && !brevoDispo && !smtpDispo) {
    throw new Error(
      "Aucun transport e-mail configuré : posez RESEND_API_KEY dans les variables " +
        "d'environnement du serveur (voir .env.example), puis redémarrez. " +
        "À défaut, renseignez SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS."
    );
  }

  const from = { name: cfg.fromName, email: cfg.fromEmail };
  const text = input.text?.trim() || htmlToText(input.html);
  const repli = brevoDispo ? { sendMailBrevo, from } : null;

  // Resend d'abord : HTTPS/443, le seul port ouvert sur Railway.
  if (resendDispo) {
    try {
      const r = await sendMailResend(input, text);
      console.log(`[Resend] Email envoyé à ${input.to} | ID: ${r.messageId}`);
      return r;
    } catch (e: any) {
      // Sans transport de repli, l'erreur Resend est LA cause : on la remonte
      // telle quelle (domaine non vérifié, clé révoquée… tous actionnables).
      if (!smtpDispo && !brevoDispo) throw e;
      console.warn(`[Resend] Échec (${e?.message ?? e}) — bascule sur le transport de secours.`);
    }
  }

  // SMTP ensuite — sauf si le port a DÉJÀ été constaté filtré sur ce serveur :
  // inutile de repayer 10 s de timeout à chaque envoi.
  if (smtpDispo && !SMTP_BLOQUE) return sendMailSmtp(input, cfg, text, repli);

  if (!repli) return sendMailSmtp(input, cfg, text, null);
  const r = await sendMailBrevo(input, from, text);
  console.log(`[Brevo] Email envoyé à ${input.to} | ID: ${r.messageId}`);
  return r;
}

/**
 * Envoi SMTP sur un hôte/port IMPOSÉS, sans repli et sans toucher à la config
 * du serveur. Réservé au diagnostic (/api/diag-mail) : sert à découvrir quel
 * port l'hébergeur laisse sortir avant de figer SMTP_PORT.
 */
export async function sendMailEssai(
  input: SendMailInput,
  override: SmtpOverride
): Promise<{ success: true; messageId: string }> {
  const cfg = readConfig(override);
  return sendMailSmtp(input, cfg, input.text?.trim() || htmlToText(input.html), null);
}

/** Envoi SMTP proprement dit. `repli` permet de basculer sur Brevo si le port
 *  se révèle filtré depuis ce réseau. */
async function sendMailSmtp(
  input: SendMailInput,
  cfg: ReturnType<typeof readConfig>,
  text: string,
  repli: { sendMailBrevo: any; from: { name: string; email: string } } | null
): Promise<{ success: true; messageId: string }> {
  const transporter = getTransporter(cfg);

  // Domaine de l'expéditeur → sert au Message-ID (aligné avec le From, meilleur
  // pour la réputation) et au lien de désabonnement RFC 8058.
  const fromDomain = cfg.fromEmail.split("@")[1] || "localhost";

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

    // Port SMTP filtré (Railway, réseau d'entreprise) : ce n'est pas au message
    // qu'on en veut, c'est au chemin. On repasse par l'API HTTP si elle est
    // disponible, et on mémorise le blocage pour les envois suivants.
    if (estBlocageReseau(e)) {
      SMTP_BLOQUE = true;
      if (repli) {
        console.warn(`[SMTP] ${cfg.host}:${cfg.port} injoignable (${code}) — bascule sur l'API Brevo.`);
        const r = await repli.sendMailBrevo(input, repli.from, text);
        console.log(`[Brevo] Email envoyé à ${input.to} | ID: ${r.messageId}`);
        return r;
      }
    }

    // Messages actionnables sur les échecs SMTP les plus fréquents.
    if (code === "EAUTH" || /535|authentication|invalid login|username and password/i.test(String(resp))) {
      throw new Error(
        `Authentification SMTP refusée. Vérifiez SMTP_USER / SMTP_PASS dans .env. ` +
          `Pour Gmail/Workspace, utilisez un « mot de passe d'application » (pas votre mot de passe habituel). [${resp}]`
      );
    }
    if (estBlocageReseau(e)) {
      throw new Error(
        `Connexion au serveur SMTP impossible (${cfg.host}:${cfg.port}) : le port est filtré depuis ce réseau ` +
          `(Railway et beaucoup d'hébergeurs bloquent le SMTP sortant). Posez RESEND_API_KEY pour envoyer en HTTPS/443. [${code} ${resp}]`
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
