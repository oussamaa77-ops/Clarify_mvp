// ============================================================================
// mailer.resend.ts — Envoi d'e-mails par l'API HTTP Resend (port 443).
//
// TRANSPORT PAR DÉFAUT dès que RESEND_API_KEY est posée. Raison : le port SMTP
// sortant est FILTRÉ sur les deux réseaux qui comptent ici.
//   • Railway (production) : smtp.gmail.com:587 → ENETUNREACH / ETIMEDOUT.
//     Blocage anti-spam de l'hébergeur, rien à régler côté code.
//   • Le poste de dev en filaire : idem, tous ports SMTP bloqués.
// Conséquence : ni le mail d'approbation d'inscription ni les relances de
// factures ne partaient. L'API Resend parle HTTPS sur 443 — le seul port qui
// passe partout. SMTP et Brevo restent en secours (cf. mailer.ts).
//
// ⚠ EXPÉDITEUR — Resend n'accepte QUE :
//     • onboarding@resend.dev (bac à sable, valeur par défaut ici) ;
//     • une adresse sur un domaine VÉRIFIÉ dans le compte Resend.
//   Toute autre adresse (un gmail.com par exemple) est refusée en 403.
//   ⚠ Le bac à sable n'écrit QU'À l'adresse propriétaire du compte Resend : les
//     relances vers de vrais clients ne partiront qu'une fois un domaine vérifié
//     (https://resend.com/domains) et RESEND_FROM posé dessus.
// ============================================================================

import { readFile } from "node:fs/promises";
import { Resend } from "resend";
import type { SendMailInput } from "./mailer";

const ENDPOINT = "https://api.resend.com/emails";

/** Adresse expéditrice par défaut : le bac à sable Resend, toujours accepté.
 *  À remplacer par RESEND_FROM (domaine vérifié) pour écrire à de vrais clients. */
const FROM_DEFAUT = "Clarify <onboarding@resend.dev>";

/** L'envoi du mail d'approbation est `await`é pendant l'inscription : sans borne,
 *  une API muette figerait le formulaire. */
const TIMEOUT_MS = 15_000;

export function resendApiKey(): string {
  return (process.env.RESEND_API_KEY ?? "").trim();
}

/** Expéditeur au format « Nom <adresse> ». RESEND_FROM l'emporte ; sinon on
 *  reste sur le bac à sable plutôt que sur FROM_EMAIL, qui pointe en général
 *  vers un domaine non vérifié chez Resend (403 garanti). */
export function resendFrom(): string {
  return (process.env.RESEND_FROM ?? "").trim() || FROM_DEFAUT;
}

/** Adresse nue extraite de « Nom <adresse> », pour le Reply-To. */
function adresseNue(from: string): string {
  return from.match(/<([^>]+)>/)?.[1]?.trim() ?? from;
}

let _client: Resend | null = null;
let _cle = "";
function getClient(key: string): Resend {
  if (!_client || key !== _cle) {
    _client = new Resend(key);
    _cle = key;
  }
  return _client;
}

/** Le proxy TLS d'entreprise casse le fetch global de Node — donc aussi celui
 *  qu'utilise le SDK Resend. On garde une voie directe par undici pour le poste
 *  de dev ; sur Railway le fetch global marche et ce chemin ne sert jamais. */
async function proxyFetch(url: string, init: RequestInit): Promise<Response> {
  const { fetch: uf, Agent } = await import("undici");
  return (uf as any)(url, {
    ...init,
    dispatcher: new Agent({ connect: { rejectUnauthorized: false } }),
  });
}

/** Pièces jointes → format Resend : {filename, content(base64)} ou {filename, path(URL)}. */
async function mapAttachments(input: SendMailInput) {
  if (!input.attachments?.length) return undefined;
  const out: Array<{ filename: string; content?: string; path?: string; contentType?: string }> = [];
  for (const a of input.attachments) {
    const base = { filename: a.name, contentType: a.type };
    if (a.contentBuffer) {
      out.push({ ...base, content: a.contentBuffer.toString("base64") });
    } else if (a.content) {
      out.push({ ...base, content: a.content });
    } else if (a.path) {
      // Une URL est transmise telle quelle (Resend la télécharge lui-même) ;
      // un chemin local doit être lu et encodé, Resend n'y a pas accès.
      if (/^https?:\/\//i.test(a.path)) out.push({ ...base, path: a.path });
      else out.push({ ...base, content: (await readFile(a.path)).toString("base64") });
    }
  }
  return out.length ? out : undefined;
}

/** Panne RÉSEAU (proxy, DNS, socket) par opposition à un refus applicatif de
 *  Resend (clé invalide, domaine non vérifié). Seule la première justifie de
 *  refaire l'appel par undici : réessayer un 403 serait vain. */
function estPanneReseau(e: any): boolean {
  const m = `${e?.message ?? e} ${e?.cause?.message ?? ""} ${e?.code ?? ""}`;
  return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|self.signed|unable to verify|certificate|network|socket|abort/i.test(m);
}

/**
 * Envoie via l'API Resend. Lève une erreur portant le message de l'API : ses
 * refus sont explicites (domaine non vérifié, clé révoquée, quota épuisé) et
 * doivent remonter tels quels dans les logs.
 */
export async function sendMailResend(
  input: SendMailInput,
  text: string
): Promise<{ success: true; messageId: string }> {
  const key = resendApiKey();
  if (!key) throw new Error("RESEND_API_KEY absente.");

  const from = resendFrom();
  const attachments = await mapAttachments(input);
  const payload = {
    from,
    to: [input.to],
    replyTo: input.replyTo ?? adresseNue(from),
    subject: input.subject,
    html: input.html,
    text,
    attachments,
  };

  // 1) Le SDK d'abord (chemin nominal, celui de la production).
  try {
    const { data, error } = await avecTimeout(getClient(key).emails.send(payload));
    // Erreur APPLICATIVE : le SDK la rend au lieu de la lever. Elle est
    // définitive, inutile de retenter par un autre chemin réseau.
    if (error) throw new Error(`API Resend : ${error.message ?? JSON.stringify(error)}`);
    return { success: true, messageId: data?.id ?? "" };
  } catch (e: any) {
    if (!estPanneReseau(e)) throw e;
    console.warn(`[Resend] SDK injoignable (${e?.message ?? e}) — nouvel essai en direct via undici.`);
  }

  // 2) Repli : même requête, mais avec un agent undici qui tolère le certificat
  //    du proxy d'inspection TLS d'entreprise. L'API brute est en snake_case,
  //    là où le SDK expose du camelCase — d'où la traduction.
  const res = await avecTimeout(
    proxyFetch(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        ...payload,
        replyTo: undefined,
        reply_to: payload.replyTo,
        attachments: attachments?.map(({ contentType, ...a }) => ({ ...a, content_type: contentType })),
      }),
    })
  ).catch((e: any) => {
    throw new Error(`Appel à l'API Resend impossible : ${e?.message ?? e}`);
  });

  const brut = await res.text();
  if (!res.ok) throw new Error(`API Resend ${res.status} : ${brut.slice(0, 400)}`);

  let messageId = "";
  try {
    messageId = JSON.parse(brut)?.id ?? "";
  } catch {
    /* réponse non-JSON mais 2xx : l'envoi a eu lieu, on n'a juste pas d'id */
  }
  return { success: true, messageId };
}

/** Borne dure sur un appel réseau — ni le SDK ni fetch ne garantissent de rendre
 *  la main, et l'inscription attend ce mail. */
function avecTimeout<T>(p: Promise<T>): Promise<T> {
  let minuteur: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<never>((_, rej) => {
      minuteur = setTimeout(() => rej(new Error(`Timeout API Resend (${TIMEOUT_MS} ms)`)), TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(minuteur)) as Promise<T>;
}
