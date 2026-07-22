// ============================================================================
// mailer.brevo.ts — Envoi d'e-mails par l'API HTTP Brevo (port 443).
//
// POURQUOI, alors que mailer.ts fait déjà du SMTP : le port SMTP sortant est
// FILTRÉ sur les deux réseaux qui comptent ici.
//   • Railway (hébergeur de production) : smtp.gmail.com:587 → ETIMEDOUT après
//     10 s. Blocage anti-spam de l'hébergeur, rien à régler côté code.
//   • Le poste de dev en filaire : idem, tous ports SMTP bloqués.
// Conséquence : le mail d'approbation d'inscription ne partait jamais, et
// l'admin ne pouvait pas débloquer les nouveaux comptes.
//
// L'API Brevo parle HTTPS sur 443 — le seul port qui passe partout. C'est donc
// elle le transport par défaut dès que BREVO_API_KEY est posée ; SMTP reste en
// secours (cf. mailer.ts).
//
// ⚠ L'expéditeur doit être un « sender » validé dans le compte Brevo, sinon
//   l'API répond 400. Vérifiable : GET https://api.brevo.com/v3/senders
// ============================================================================

import { readFile } from "node:fs/promises";
import type { SendMailInput } from "./mailer";

const ENDPOINT = "https://api.brevo.com/v3/smtp/email";

/** Le proxy TLS d'entreprise casse le fetch global de Node : on bascule sur
 *  undici en direct au premier échec (même motif que les autres modules
 *  serveur). Sur Railway le fetch global marche, la bascule ne coûte rien. */
let PROXY_DIRECT = false;
async function proxyFetch(url: string, init: RequestInit): Promise<Response> {
  if (!PROXY_DIRECT) {
    try {
      return await fetch(url, init);
    } catch {
      PROXY_DIRECT = true;
    }
  }
  const { fetch: uf, Agent } = await import("undici");
  return (uf as any)(url, {
    ...init,
    dispatcher: new Agent({ connect: { rejectUnauthorized: false } }),
  });
}

export function brevoApiKey(): string {
  return (process.env.BREVO_API_KEY ?? "").trim();
}

/** Pièces jointes → format Brevo : soit {url, name}, soit {content: base64, name}. */
async function mapAttachments(input: SendMailInput) {
  if (!input.attachments?.length) return undefined;
  const out: Array<{ name: string; content?: string; url?: string }> = [];
  for (const a of input.attachments) {
    if (a.contentBuffer) {
      out.push({ name: a.name, content: a.contentBuffer.toString("base64") });
    } else if (a.content) {
      out.push({ name: a.name, content: a.content });
    } else if (a.path) {
      // Une URL est transmise telle quelle (Brevo la télécharge lui-même) ;
      // un chemin local doit être lu et encodé, Brevo n'y a pas accès.
      if (/^https?:\/\//i.test(a.path)) out.push({ name: a.name, url: a.path });
      else out.push({ name: a.name, content: (await readFile(a.path)).toString("base64") });
    }
  }
  return out.length ? out : undefined;
}

/**
 * Envoie via l'API Brevo. Lève une erreur portant le corps de la réponse : les
 * refus Brevo sont explicites (expéditeur non validé, quota du jour épuisé, clé
 * révoquée) et doivent remonter tels quels dans les logs.
 */
export async function sendMailBrevo(
  input: SendMailInput,
  from: { name: string; email: string },
  text: string
): Promise<{ success: true; messageId: string }> {
  const key = brevoApiKey();
  if (!key) throw new Error("BREVO_API_KEY absente.");

  const body = {
    sender: { name: from.name, email: from.email },
    to: [input.toName ? { email: input.to, name: input.toName } : { email: input.to }],
    replyTo: { email: input.replyTo ?? from.email },
    subject: input.subject,
    htmlContent: input.html,
    textContent: text,
    attachment: await mapAttachments(input),
  };

  // Timeout explicite : l'envoi du mail d'approbation est `await`é pendant
  // l'inscription. Sans borne, une API muette figerait le formulaire.
  const ctrl = new AbortController();
  const minuteur = setTimeout(() => ctrl.abort(), 15_000);
  let res: Response;
  try {
    res = await proxyFetch(ENDPOINT, {
      method: "POST",
      headers: { "api-key": key, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e: any) {
    throw new Error(`Appel à l'API Brevo impossible : ${e?.message ?? e}`);
  } finally {
    clearTimeout(minuteur);
  }

  const brut = await res.text();
  if (!res.ok) {
    throw new Error(`API Brevo ${res.status} : ${brut.slice(0, 400)}`);
  }

  let messageId = "";
  try {
    messageId = JSON.parse(brut)?.messageId ?? "";
  } catch {
    /* réponse non-JSON mais 2xx : l'envoi a bien eu lieu, on n'a juste pas d'id */
  }
  return { success: true, messageId };
}
