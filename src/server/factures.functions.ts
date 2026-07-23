// ============================================================
// facture.functions.ts — VERSION CORRIGÉE
//
// CORRECTIONS APPORTÉES :
// 1. PDF.js : tous les imports unpkg → cdnjs (fix CORS localhost)
// 2. Matching relevé : alignement index Groq ↔ transactions_brutes
//    par position stricte (i), avec fallback si Groq renvoie moins
//    d'analyses que de transactions
// 3. analyserReleveIA : post-traitement robuste — on mappe par i
//    avec vérification d'existence avant d'accéder à tx
// 4. Suppression de analyserTransactions (doublon de analyserReleveIA,
//    gardé en export aliasé pour compatibilité sans casser les imports)
// 5. ocrFacture : import pdf dynamique depuis cdnjs, plus unpkg
// ============================================================

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createHash } from "crypto";
import { createClient } from "@supabase/supabase-js";
import { emailFactureClient, emailFactureRejetee } from "./email.templates";
import { sendMail } from "./mailer";
import { validerXmlUBL } from "./dgi_validator";
import { parseInvoiceRegex, correctMontants, buildOcrPrompt } from "./factures.utils";
import { puTtcToHt } from "../lib/tva";
import { rappelerMemoire } from "./tiers-memoire.functions";
import { logUsage, logUsageBatch, estimerCoutIA } from "./analytics.functions";
import { guardScan, libererScan } from "./billing";
import { enregistrerPaiement } from "@/lib/paiements";

function getSupabase() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    "";
  // Derrière le proxy TLS d'entreprise, le fetch global de Node échoue
  // (`TypeError: fetch failed`) → on route supabase-js par proxyFetch (repli undici),
  // comme les appels IA, sinon TOUTE écriture/lecture serveur échoue silencieusement.
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input: any, init?: any) => proxyFetch(String(input), init) },
  });
}

const ligneSchema = z.object({
  designation: z.string().min(1),
  quantite: z.number().positive(),
  prix_unitaire: z.number().nonnegative(),
  taux_tva: z.number().min(0).max(100).default(20),
});

// ─── Email via SMTP « classique » (nodemailer) ────────────────────────────────
// Best-effort : renvoie false sur échec (config SMTP absente / serveur KO) sans
// jamais bloquer la génération de facture. Détail anti-spam dans ./mailer.
async function envoyerEmail(
  to: string,
  subject: string,
  html: string,
  attachments?: { name: string; content: string; type: string }[]
): Promise<boolean> {
  try {
    await sendMail({ to, subject, html, attachments });
    return true;
  } catch (e: any) {
    console.error("[email] envoi échoué:", e?.message ?? e);
    return false;
  }
}

// ─── fetch tolérant au proxy SSL d'entreprise ───────────────────────────────
// Derrière un proxy d'inspection TLS, le PREMIER `fetch` échoue (SELF_SIGNED_CERT)
// et on doit réessayer via undici sans vérif TLS. Pour ne PAS payer cet échec sur
// CHAQUE appel (OCR + extraction + N lots de matching), on mémorise la détection :
// une fois le proxy vu, tous les appels suivants passent DIRECTEMENT par undici.
let PROXY_DIRECT = false;
async function proxyFetch(url: string, opts: any): Promise<Response> {
  if (PROXY_DIRECT) {
    const { fetch: undiciFetch, Agent } = await import("undici");
    const agent = new Agent({ connect: { rejectUnauthorized: false } });
    return await (undiciFetch as any)(url, { ...opts, dispatcher: agent }) as Response;
  }
  try {
    return await fetch(url, opts);
  } catch (fetchErr: any) {
    const cause: string = fetchErr?.cause?.code ?? fetchErr?.cause?.message ?? fetchErr?.message ?? "";
    // Proxy d'inspection TLS : le premier fetch échoue soit sur le certificat
    // (SELF_SIGNED/CERT_), soit avec un « fetch failed » générique. Dans les deux
    // cas, on rebascule sur undici sans vérif TLS (le proxy présente son propre CA).
    if (/SELF_SIGNED|CERT_|UNABLE_TO_VERIFY|fetch failed|ECONNRESET|EPROTO/i.test(cause) || /fetch failed/i.test(String(fetchErr?.message ?? ""))) {
      PROXY_DIRECT = true; // mémorise → plus aucun échec de fetch sur les appels suivants
      const { fetch: undiciFetch, Agent } = await import("undici");
      const agent = new Agent({ connect: { rejectUnauthorized: false } });
      return await (undiciFetch as any)(url, { ...opts, dispatcher: agent }) as Response;
    }
    throw new Error(`Réseau KO: ${cause || "fetch failed"}`);
  }
}

// ─── Appel IA (Groq — SECOURS) ───────────────────────────────────────────────
// Groq n'est plus le moteur principal : il prend le relais quand Mistral est
// indisponible (clé absente, 429, panne, réponse inexploitable).
// Texte : openai/gpt-oss-120b. Vision : llama-4-scout — gpt-oss-120b est
// TEXT-ONLY, il ne peut pas remplacer le modèle vision.
async function callAI(
  prompt: string,
  imageBase64?: string,
  mimeType?: string,
  maxTokens?: number,
  visionModel?: string
): Promise<string> {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) throw new Error("GROQ_API_KEY manquante");

  const model = imageBase64
    ? (visionModel ?? "meta-llama/llama-4-scout-17b-16e-instruct")
    : "openai/gpt-oss-120b";

  const userContent: any = imageBase64
    ? [
        { type: "text", text: prompt },
        {
          type: "image_url",
          image_url: {
            url: `data:${mimeType ?? "image/jpeg"};base64,${imageBase64}`,
          },
        },
      ]
    : prompt;

  // gpt-oss-120b est un modèle À RAISONNEMENT : ses tokens de réflexion sont
  // facturés/comptés dans la sortie AVANT le JSON. Avec max_tokens trop bas, la
  // réflexion épuise le budget et Groq renvoie 400 json_validate_failed (sortie
  // vide). D'où reasoning_effort "low" + un plancher de sortie confortable.
  const defaultTokens = imageBase64 ? 2000 : 3000;
  const groqBody = JSON.stringify({
    model,
    max_tokens: maxTokens ?? defaultTokens,
    temperature: 0,
    messages: [{ role: "user", content: userContent }],
    ...(imageBase64
      ? {}
      : { response_format: { type: "json_object" }, reasoning_effort: "low" }),
  });

  const groqHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${groqKey}`,
  };

  const res: Response = await proxyFetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: groqHeaders,
    body: groqBody,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = (await res.json()) as any;
  const content = data.choices?.[0]?.message?.content ?? "{}";
  console.log("[Groq] model:", model, "| chars:", content.length);
  return content
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();
}

// ─── Mistral OCR (mistral-ocr-latest) ────────────────────────────────────────
// OCR document dédié : renvoie le relevé en Markdown (un objet par page). On
// concatène le Markdown de toutes les pages DANS L'ORDRE puis on le parse via
// parseReleveMarkdown(). Journalise pour chaque page le Markdown brut et le
// nombre de transactions extraites.
async function callMistralOcr(base64: string, mimeType: string): Promise<string> {
  const key = process.env.MISTRAL_API_KEY;
  if (!key) throw new Error("MISTRAL_API_KEY manquante");

  const isPdf = /pdf/i.test(mimeType);
  const dataUrl = `data:${mimeType};base64,${base64}`;
  const document = isPdf
    ? { type: "document_url", document_url: dataUrl }
    : { type: "image_url", image_url: dataUrl };

  const body = JSON.stringify({
    model: "mistral-ocr-latest",
    document,
    include_image_base64: false,
  });
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`,
  };
  const ENDPOINT = "https://api.mistral.ai/v1/ocr";

  const res: Response = await proxyFetch(ENDPOINT, { method: "POST", headers, body });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Mistral OCR ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = (await res.json()) as any;
  const pages: any[] = Array.isArray(data.pages) ? data.pages : [];
  if (pages.length === 0) throw new Error("Mistral OCR : aucune page retournée");

  // Concatène le Markdown de toutes les pages dans l'ordre (index croissant).
  const { parseReleveMarkdown } = await import("./factures.utils");
  const ordered = [...pages].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const parts: string[] = [];
  ordered.forEach((p, i) => {
    const md: string = p.markdown ?? "";
    const pageNo = (p.index ?? i) + 1;
    const nbTx = parseReleveMarkdown(md).txs.length; // diagnostic par page
    console.log(`[MISTRAL OCR PAGE ${pageNo}] markdown brut (${md.length} chars):\n${md}`);
    console.log(`[MISTRAL OCR PAGE ${pageNo}] → ${nbTx} transactions parsées`);
    parts.push(md);
  });

  return parts.join("\n\n");
}

// ─── Mistral chat (mistral-large-latest) — raisonnement texte / JSON ─────────
// Utilisé pour la catégorisation comptable et le rapprochement facture/
// justificatif des transactions du relevé (équivalent du callAI texte Groq,
// mais sur Mistral). Mode JSON strict. Gère le proxy SSL d'entreprise.
async function callMistralChat(prompt: string, maxTokens?: number, model: string = "mistral-large-latest"): Promise<string> {
  const key = process.env.MISTRAL_API_KEY;
  if (!key) throw new Error("MISTRAL_API_KEY manquante");

  const body = JSON.stringify({
    model,
    max_tokens: maxTokens ?? 4096,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: prompt }],
  });
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`,
  };
  const ENDPOINT = "https://api.mistral.ai/v1/chat/completions";

  const res: Response = await proxyFetch(ENDPOINT, { method: "POST", headers, body });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Mistral chat ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = (await res.json()) as any;
  const content = data.choices?.[0]?.message?.content ?? "{}";
  console.log("[MISTRAL CHAT] model:", model, "| chars:", content.length);
  return content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
}

// ─── Extraction facture / justificatif : Mistral principal, Groq secours ─────
// Même cascade que le relevé, appliquée au document unitaire :
//   • document scanné (pas de couche texte) → mistral-ocr-latest rend le
//     Markdown, puis mistral-large-latest en extrait le JSON métier ;
//   • PDF avec couche texte → un seul appel mistral-large sur le texte.
// Secours Groq (vision llama-4-scout / texte gpt-oss-120b) si Mistral est
// indisponible ou rend un JSON inexploitable. Retourne aussi le fournisseur
// réellement utilisé, pour la journalisation.
type FactureExtraction = { ai: any; provider: "mistral" | "groq" };

async function extraireFactureIA(args: {
  dossierNom: string;
  dossierIce: string;
  text: string;
  imageBase64?: string;
  mimeType: string;
  useVision: boolean;
}): Promise<FactureExtraction> {
  const { dossierNom, dossierIce, text, imageBase64, mimeType, useVision } = args;

  if (process.env.MISTRAL_API_KEY) {
    try {
      // Un scan sans couche texte passe d'abord par l'OCR document Mistral.
      let contenu = text;
      if (useVision && imageBase64) {
        contenu = await callMistralOcr(imageBase64, mimeType);
        if (!contenu.trim()) throw new Error("Mistral OCR : Markdown vide");
        console.log(`[OCR FACTURE] mistral-ocr → ${contenu.length} chars de Markdown`);
      }
      const raw = await callMistralChat(buildOcrPrompt(dossierNom, dossierIce, contenu), 4000);
      return { ai: JSON.parse(raw), provider: "mistral" };
    } catch (e: any) {
      // Pas de throw : Mistral KO ne doit pas faire échouer le scan, Groq prend le relais.
      console.warn("[OCR FACTURE] Mistral échoué → secours Groq:", String(e?.message ?? e).slice(0, 200));
    }
  }

  const prompt = buildOcrPrompt(dossierNom, dossierIce, text);
  const raw = useVision && imageBase64
    ? await callAI(prompt, imageBase64, mimeType)
    : await callAI(prompt);
  return { ai: JSON.parse(raw), provider: "groq" };
}

// ─── Contrôle d'équilibre du relevé ──────────────────────────────────────────
// Identité : solde_final = solde_initial(signé) + Σ crédits − Σ débits. Un écart
// signifie qu'au moins une transaction a été oubliée ou mal lue. Banque Populaire
// affiche « SOLDE A REPORTER » en VALEUR ABSOLUE (sans signe) et le compte peut
// être débiteur : on teste les deux conventions de signe du solde de départ
// (+SI créditeur / −SI débiteur) et on garde le plus petit écart, en comparant
// des valeurs absolues.
function releveEcart(soldeInitial: number, soldeFinal: number, txs: any[]): number {
  const cr = txs.reduce((s, t) => s + (t.montant_credit || 0), 0);
  const db = txs.reduce((s, t) => s + (t.montant_debit || 0), 0);
  const flux = cr - db;
  const ecartCred = Math.abs(Math.abs(soldeInitial + flux) - soldeFinal);
  const ecartDeb = Math.abs(Math.abs(-soldeInitial + flux) - soldeFinal);
  return Math.round(Math.min(ecartCred, ecartDeb) * 100) / 100;
}

// ─── Réconciliation par équilibre (mistral-large) ────────────────────────────
// Si le solde final calculé ne correspond pas au solde final scanné, on
// redemande à Mistral (chat) d'extraire TOUTES les transactions depuis le texte
// OCR (Markdown), en imposant l'égalité comptable — récupère les transactions
// oubliées par le parsing. Retourne le tableau normalisé, ou null si échec.
async function reconcileReleveTxs(
  markdown: string,
  soldeInitial: number,
  soldeFinal: number,
  feedback?: { prevTxs: any[]; prevEcart: number; attempt: number },
): Promise<any[] | null> {
  if (!process.env.MISTRAL_API_KEY) return null;

  // Contrainte d'équilibre seulement si les deux soldes sont connus.
  const hasTarget = soldeInitial > 0 && soldeFinal > 0;
  const controleBloc = hasTarget
    ? `SOLDE INITIAL (solde de départ) : ${soldeInitial}
SOLDE FINAL (cible) : ${soldeFinal}

CONTRÔLE OBLIGATOIRE avant de répondre :
  solde_initial + (somme des crédits) − (somme des débits) DOIT être égal au SOLDE FINAL cible.

Si l'égalité n'est PAS vérifiée, l'écart vient FORCÉMENT de l'une de ces erreurs de LECTURE (jamais d'une transaction à inventer) — vérifie DANS CET ORDRE :
  1) LE SOLDE DE DEPART N'EST PAS UNE TRANSACTION. Le premier montant du relevé (ligne « SOLDE REPORT / SOLDE DEPART / SOLDE A NOUVEAU / REPORT A NOUVEAU / ANCIEN SOLDE », égal à ${soldeInitial}) est le solde initial : il ne doit JAMAIS figurer dans la liste des transactions. Si tu l'as compté par erreur (ex. première transaction dont le montant = ${soldeInitial}), RETIRE-le.
  2) Une vraie transaction PRÉSENTE dans le texte a été oubliée → ajoute-la (elle a une date ET un libellé visibles dans le texte OCR).
  3) Un montant a été mal lu (ex. 100 au lieu de 1000), ou un débit/crédit a été inversé → corrige-le d'après le texte.
  4) Le solde de départ a été confondu avec le montant de la première vraie transaction → corrige.
Recalcule l'équilibre après correction.

🚫 INTERDICTION ABSOLUE D'INVENTER : il est STRICTEMENT INTERDIT de créer une transaction pour combler l'écart. NE crée JAMAIS une transaction dont le montant est égal (ou proche) de l'écart restant, ni un libellé d'ajustement (« AJUSTEMENT », « REGULARISATION », « ECART », « DIFFERENCE », « SOLDE »). CHAQUE transaction que tu renvoies DOIT correspondre à une ligne RÉELLEMENT présente dans le TEXTE OCR ci-dessous, avec sa date et son libellé lisibles dans ce texte.
Si tu ne parviens PAS à équilibrer en te basant UNIQUEMENT sur des lignes réelles du texte, alors renvoie quand même UNIQUEMENT les transactions réelles, même si l'équilibre n'est pas atteint. Mieux vaut un écart signalé qu'une transaction inventée.`
    : `Le solde de contrôle n'est pas disponible : sois exhaustif, parcours le tableau ligne par ligne du HAUT vers le BAS et n'oublie AUCUNE ligne, surtout PAS la toute première ni la dernière transaction.
⚠️ CE RELEVÉ N'A PEUT-ÊTRE PAS DE SOLDE INITIAL. Ne prends JAMAIS la première ligne comme solde initial si son libellé ne contient pas un mot-clé SOLDE (SOLDE REPORT / DEPART / A NOUVEAU / ANCIEN SOLDE). Si la première ligne est une opération (ex. « DE CIH 17580 », un virement, un achat), c'est une TRANSACTION : garde son montant, ne la transforme pas en solde et ne la supprime pas.`;

  // Retour d'expérience de la tentative précédente : on montre au modèle ce qu'il
  // a produit et l'écart qui reste, pour qu'il corrige de façon ciblée.
  const feedbackBloc = feedback
    ? `

⚠️ TA TENTATIVE PRÉCÉDENTE (n°${feedback.attempt}) N'ÉTAIT PAS ÉQUILIBRÉE. Voici ce que tu avais extrait :
${JSON.stringify(feedback.prevTxs.map((t) => ({ d: t.date_operation, lib: (t.libelle || "").slice(0, 30), deb: t.montant_debit, cre: t.montant_credit })))}
L'erreur est une erreur de LECTURE du texte OCR, PAS une transaction à ajouter de toutes pièces. Relis le TEXTE OCR ligne par ligne et trouve : une vraie transaction présente dans le texte que tu as oubliée, OU un montant mal lu, OU un débit/crédit inversé, OU le solde de départ compté par erreur.
🚫 NE fabrique SURTOUT PAS une transaction du montant de l'écart pour équilibrer : compare chaque transaction de ta liste avec une ligne réelle du texte. Si une transaction de ta liste précédente n'existe pas dans le texte, SUPPRIME-la.`
    : "";

  const prompt = `Tu es un expert-comptable marocain. Voici le texte OCR (Markdown) d'un relevé bancaire.

${controleBloc}${feedbackBloc}

Extrais TOUTES les transactions, SANS EN OUBLIER AUCUNE (ni la première, ni la dernière).
⚠️ L'EN-TÊTE du tableau peut être ABSENT et certaines lignes mal alignées (pipes manquants, ligne collée à l'en-tête du document). Déduis quand même les colonnes par leur contenu : dates à gauche, puis référence, puis libellé, puis les montants à droite. N'ignore PAS une ligne sous prétexte qu'elle est mal alignée — si elle a un libellé d'opération et un montant, c'est une transaction.
Règles :
1. montant_debit = montant SORTANT (argent qui quitte le compte : paiement, achat par carte, chèque émis, retrait/RETRAIT GAB, prélèvement, virement émis, droits de timbre, frais, commission).
2. montant_credit = montant ENTRANT (argent reçu : virement reçu, versement, remise, encaissement, avoir, intérêts créditeurs, ou libellé du type « DE <banque/tiers> » ex. « DE CIH », « REMISE DE … »).
3. NE JAMAIS INVERSER débit et crédit. Respecte la colonne d'origine du relevé : ce qui est dans la colonne DÉBIT reste en montant_debit, ce qui est dans la colonne CRÉDIT reste en montant_credit.
4. Une transaction a un montant en débit OU en crédit, jamais les deux.
5. Si une cellule est vide → retourner null pour ce champ.
6. NE JAMAIS inventer ni compléter un chiffre illisible → retourner null pour ce montant.
7. N'invente JAMAIS une transaction entière : utilise uniquement les lignes réellement présentes dans le texte.
8. SOLDE INITIAL — RÈGLE STRICTE : une ligne n'est le solde initial QUE si SON LIBELLÉ contient explicitement « SOLDE REPORT / SOLDE DEPART / SOLDE A NOUVEAU / REPORT A NOUVEAU / ANCIEN SOLDE / SOLDE PRECEDENT ». Dans ce cas seulement, ne la compte pas comme transaction. ⚠️ SINON, la première ligne est une VRAIE TRANSACTION même si elle est en tête de tableau (ex. « DE CIH 17580 », « VIREMENT RECU », un achat, un retrait…) : tu DOIS garder son montant et l'inclure. ⚠️ Il peut n'y avoir AUCUNE ligne de solde initial : dans ce cas il n'y a tout simplement pas de solde initial — ne transforme JAMAIS une transaction en solde initial pour combler ce vide.
9. Ignore uniquement les lignes de solde/total (SOLDE DEPART, ANCIEN SOLDE, NOUVEAU SOLDE, SOLDE FINAL, TOTAL DES MOUVEMENTS…).
10. Montants en nombres (1500.00). Dates au format JJ/MM/AAAA.
11. Retourne les transactions dans l'ORDRE des pages, de haut en bas.
12. LES DOUBLONS DE MONTANT NE SONT PAS DES DOUBLONS : si plusieurs lignes ont le MÊME montant (même date et/ou même libellé inclus), ce sont des opérations DISTINCTES bien réelles (ex. plusieurs frais identiques, plusieurs retraits du même montant). Tu DOIS toutes les extraire — ne fusionne, ne supprime et n'ignore JAMAIS une ligne sous prétexte qu'une autre a le même montant.

Ce format est valable pour tous les relevés bancaires marocains (Attijariwafa, Banque Populaire, CIH, BMCE, BMCI, Société Générale).

TEXTE OCR :
<<<
${markdown.slice(0, 24000)}
>>>

Retourne UNIQUEMENT ce JSON :
{"txs":[{"date_operation":"JJ/MM/AAAA","date_valeur":"JJ/MM/AAAA","reference":"","libelle":"","montant_debit":null,"montant_credit":null}]}`;

  try {
    // mistral-large : l'extraction d'un tableau OCR DÉCALÉ exige du raisonnement
    // (mistral-small y inverse/mélange les montants → écart de solde). Précision > vitesse
    // ici ; la voie rapide est la récupération déterministe par delta de solde en amont.
    const content = await callMistralChat(prompt, 8000);
    const parsed = JSON.parse(content);
    const arr: any[] = Array.isArray(parsed) ? parsed : parsed.txs;
    if (!Array.isArray(arr)) return null;
    const toNum = (v: any): number | null => {
      if (v === null || v === undefined || v === "") return null;
      const n = parseFloat(String(v).replace(/\s/g, "").replace(",", "."));
      return Number.isNaN(n) ? null : n;
    };
    // Libellés d'ajustement = signe d'une transaction fabriquée pour équilibrer.
    // On les rejette : une vraie transaction n'a jamais ce libellé.
    const FABRIQUE_KW = /\b(ajustement|r[eé]gularisation|regularisation|[eé]cart|difference|diff[eé]rence|[eé]quilibrage|solde\s+report|balance)\b/i;
    return arr
      .filter((t) => t && typeof t === "object")
      .map((t) => ({
        date_operation: t.date_operation ?? "",
        date_valeur: t.date_valeur ?? t.date_operation ?? "",
        reference: t.reference ?? "",
        libelle: t.libelle ?? "Transaction",
        montant_debit: toNum(t.montant_debit),
        montant_credit: toNum(t.montant_credit),
      }))
      // On garde une transaction si elle a un montant, OU si elle est datée et
      // libellée même sans montant (montant illisible → null) : ne JAMAIS perdre
      // une transaction réelle ; l'utilisateur complètera le montant à la main.
      .filter((t) =>
        t.montant_debit != null ||
        t.montant_credit != null ||
        (!!t.date_operation && !!t.libelle && t.libelle !== "Transaction"),
      )
      .filter((t) => {
        if (FABRIQUE_KW.test(t.libelle)) {
          console.warn("[RECONCILE] transaction d'ajustement rejetée (probable invention):", t.libelle, t.montant_debit ?? t.montant_credit);
          return false;
        }
        return true;
      });
  } catch (e: any) {
    console.warn("[RECONCILE] échec:", e?.message ?? e);
    return null;
  }
}

// ─── Extraction LÉGÈRE des transactions depuis le Markdown OCR ────────────────
// Le parsing regex `parseReleveMarkdown` casse quand mistral-ocr change la mise en
// forme du tableau (colonnes fusionnées/décalées) → montants=null. Le LLM, lui, lit
// n'importe quelle forme. Stratégie RAPIDE (1 seul appel LLM, ni boucle ni vision) :
//   1) regex → en-tête (banque/RIB/soldes) + transactions ;
//   2) si le regex n'a PAS lu tous les montants, UN appel mistral-large relit le
//      markdown ; on garde le résultat qui lit LE PLUS de montants.
// Renvoie { info, txs } — txs au format {reference,date_operation,date_valeur,
// libelle,montant_debit,montant_credit}.
async function extractReleveLean(
  fullMarkdown: string,
): Promise<{ info: { banque: string; rib: string; solde_initial: number; solde_final: number }; txs: any[]; usedLlm: boolean }> {
  const { parseReleveMarkdown } = await import("./factures.utils");
  const md = parseReleveMarkdown(fullMarkdown);
  const info = { banque: md.banque, rib: md.rib, solde_initial: md.solde_initial, solde_final: md.solde_final };
  const regexTxs = md.txs;
  const withAmt = (l: any[]) => l.filter((t) => t.montant_debit != null || t.montant_credit != null).length;

  // Regex a déjà lu TOUS les montants → rapide, pas d'appel LLM.
  if (regexTxs.length > 0 && withAmt(regexTxs) === regexTxs.length) {
    console.log(`[RELEVE] regex complet : ${regexTxs.length} tx, tous montants lus — pas d'appel LLM`);
    return { info, txs: regexTxs, usedLlm: false };
  }

  // ── VOIE RAPIDE : récupération DÉTERMINISTE par DELTA de solde (SANS LLM) ──────
  // Le dernier montant de chaque ligne est le solde courant. Donc pour chaque ligne :
  //   montant = |solde[n] − solde[n−1]|, sens = signe (solde ↑ ⇒ crédit, ↓ ⇒ débit).
  // C'est mathématiquement exact et instantané. On l'accepte SEULEMENT s'il ÉQUILIBRE
  // (solde final calculé == solde final scanné) — garantie anti-erreur. Gère aussi la
  // convention débiteur (solde initial signé −) pour BP. Élimine l'appel LLM (OCR rapide).
  if (regexTxs.length > 0 && info.solde_initial > 0 && regexTxs.every((t) => t.solde_ligne != null)) {
    const build = (si: number) => {
      let prev = si;
      return regexTxs.map((t) => {
        const s = t.solde_ligne as number;
        const delta = Math.round((s - prev) * 100) / 100;
        prev = s;
        return {
          ...t,
          montant_debit: delta < -0.005 ? Math.abs(delta) : null,
          montant_credit: delta > 0.005 ? delta : null,
        };
      });
    };
    // Deux conventions de signe du solde initial (BP peut être débiteur, affiché +).
    for (const si of [info.solde_initial, -info.solde_initial]) {
      const recov = build(si);
      if (releveEcart(info.solde_initial, info.solde_final, recov) <= 1) {
        console.log(`[RELEVE] ✓ récupération DÉTERMINISTE par delta de solde (${recov.length} tx, ${withAmt(recov)} montants) — SANS LLM`);
        return { info, txs: recov, usedLlm: false };
      }
    }
    console.log("[RELEVE] delta de solde non équilibré — bascule extraction LLM");
  }

  if (!process.env.MISTRAL_API_KEY) return { info, txs: regexTxs, usedLlm: false };

  console.log(`[RELEVE] regex incomplet (${withAmt(regexTxs)}/${regexTxs.length} montants) → 1 extraction LLM (mistral-large)`);
  try {
    const llm = await reconcileReleveTxs(fullMarkdown, info.solde_initial, info.solde_final);
    if (llm && llm.length > 0 && withAmt(llm) >= withAmt(regexTxs)) {
      console.log(`[RELEVE] ✓ LLM retenu : ${withAmt(llm)}/${llm.length} montants lus (regex: ${withAmt(regexTxs)}/${regexTxs.length})`);
      return { info, txs: llm, usedLlm: true };
    }
    console.log(`[RELEVE] LLM pas meilleur (${llm ? withAmt(llm) : 0} montants) — on garde le regex`);
  } catch (e: any) {
    console.warn("[RELEVE] extraction LLM échouée:", e?.message ?? e);
  }
  // Un appel LLM A ÉTÉ tenté (coût engagé) même si on garde finalement le regex.
  return { info, txs: regexTxs, usedLlm: true };
}


// ─── generateFactureXml ───────────────────────────────────────────────────────
export const generateFactureXml = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ facture_id: z.string().uuid() }).parse(input)
  )
  .handler(async ({ data }) => {
    const supabase = getSupabase();
    const { data: facture, error: fErr } = await supabase
      .from("factures")
      .select(
        "*, clients(nom,ice,if_fiscal,adresse,email), dossiers(nom_societe,ice,if_fiscal,adresse)"
      )
      .eq("id", data.facture_id)
      .single();
    if (fErr || !facture) throw new Error("Facture introuvable");

    const lignes = ((facture.lignes ?? []) as unknown[]).map((l) =>
      ligneSchema.parse(l)
    );
    const societe = (facture as any).dossiers;
    const client = (facture as any).clients;
    const esc = (s: string | null | undefined) =>
      (s ?? "").replace(
        /[<>&'"]/g,
        (c: string) =>
          (
            {
              "<": "&lt;",
              ">": "&gt;",
              "&": "&amp;",
              "'": "&apos;",
              '"': "&quot;",
            } as Record<string, string>
          )[c]
      );

    const lignesXml = lignes
      .map((l, i) => {
        const ht = l.quantite * l.prix_unitaire;
        const tva = ht * (l.taux_tva / 100);
        return `  <cac:InvoiceLine>
    <cbc:ID>${i + 1}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="C62">${l.quantite}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="MAD">${ht.toFixed(2)}</cbc:LineExtensionAmount>
    <cac:TaxTotal><cbc:TaxAmount currencyID="MAD">${tva.toFixed(2)}</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="MAD">${ht.toFixed(2)}</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="MAD">${tva.toFixed(2)}</cbc:TaxAmount>
        <cac:TaxCategory><cbc:Percent>${l.taux_tva}</cbc:Percent><cac:TaxScheme><cbc:ID>TVA</cbc:ID></cac:TaxScheme></cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:Item><cbc:Name>${esc(l.designation)}</cbc:Name></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="MAD">${l.prix_unitaire.toFixed(2)}</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>`;
      })
      .join("\n");

    if (
      facture.date_echeance &&
      facture.date_echeance <= facture.date_facture
    ) {
      const d = new Date(facture.date_facture);
      d.setDate(d.getDate() + 30);
      (facture as any).date_echeance = d.toISOString().slice(0, 10);
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:dgi="urn:dgi-ma:2026:1.0">
  <cbc:CustomizationID>DGI-MA:2026:1.0</cbc:CustomizationID>
  <cbc:ProfileID>urn:fdc:dgi.gov.ma:2026:einvoice</cbc:ProfileID>
  <cbc:ID>${esc(facture.numero ?? facture.id)}</cbc:ID>
  <cbc:IssueDate>${facture.date_facture}</cbc:IssueDate>
  ${facture.date_echeance ? `<cbc:DueDate>${facture.date_echeance}</cbc:DueDate>` : ""}
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>MAD</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty><cac:Party>
    <cac:PartyName><cbc:Name>${esc(societe?.nom_societe)}</cbc:Name></cac:PartyName>
    <cac:PostalAddress><cbc:StreetName>${esc(societe?.adresse)}</cbc:StreetName><cac:Country><cbc:IdentificationCode>MA</cbc:IdentificationCode></cac:Country></cac:PostalAddress>
    <cac:PartyTaxScheme><cbc:CompanyID>${esc(societe?.ice)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>ICE</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
  </cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party>
    <cac:PartyName><cbc:Name>${esc(client?.nom)}</cbc:Name></cac:PartyName>
    <cac:PartyTaxScheme><cbc:CompanyID>${esc(client?.ice)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>ICE</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
  </cac:Party></cac:AccountingCustomerParty>
  <cac:TaxTotal><cbc:TaxAmount currencyID="MAD">${Number(facture.montant_tva).toFixed(2)}</cbc:TaxAmount></cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="MAD">${Number(facture.montant_ht).toFixed(2)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="MAD">${Number(facture.montant_ht).toFixed(2)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="MAD">${Number(facture.montant_ttc).toFixed(2)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="MAD">${Number(facture.montant_ttc).toFixed(2)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
${lignesXml}
</Invoice>`;

    const hash = createHash("sha256").update(xml).digest("hex");
    await supabase
      .from("factures")
      .update({
        xml_ubl: xml,
        hash_sha256: hash,
        statut: "envoyee",
        statut_dgi: "en_analyse",
      })
      .eq("id", data.facture_id);

    const validation = await validerXmlUBL(xml);
    const { conforme, erreurs, avertissements, source } = validation;
    const dgi_uuid = conforme
      ? `DGI-${Date.now().toString(36).toUpperCase()}-${Math.random()
          .toString(36)
          .slice(2, 8)
          .toUpperCase()}`
      : null;
    const dgi_response = {
      source,
      conforme,
      timestamp: new Date().toISOString(),
      uuid: dgi_uuid,
      message: conforme ? "Facture validée" : "Facture rejetée",
      erreurs,
      avertissements,
    };

    await supabase
      .from("factures")
      .update({
        dgi_uuid,
        dgi_response,
        statut: conforme ? "conforme" : "rejetee",
        statut_dgi: conforme ? "conforme" : "rejetee",
      })
      .eq("id", data.facture_id);

    if (conforme && Number(facture.montant_ttc) > 0) {
      const ref = facture.numero ?? facture.id;
      const typeFacture = (facture as any).type ?? "facture";
      if (typeFacture === "acompte") {
        await supabase.from("ecritures_comptables").insert([
          { dossier_id: facture.dossier_id, journal_code: "VTE", compte_numero: "3421",  date_ecriture: facture.date_facture, libelle: `Acompte ${ref}`,     debit: Number(facture.montant_ttc), credit: 0, reference_piece: ref, facture_id: facture.id, valide: true },
          { dossier_id: facture.dossier_id, journal_code: "VTE", compte_numero: "4191",  date_ecriture: facture.date_facture, libelle: `Avance reçue ${ref}`, debit: 0, credit: Number(facture.montant_ht), reference_piece: ref, facture_id: facture.id, valide: true },
          { dossier_id: facture.dossier_id, journal_code: "VTE", compte_numero: "44551", date_ecriture: facture.date_facture, libelle: `TVA acompte ${ref}`,  debit: 0, credit: Number(facture.montant_tva), reference_piece: ref, facture_id: facture.id, valide: true },
        ]);
      } else if (typeFacture === "solde") {
        await supabase.from("ecritures_comptables").insert([
          { dossier_id: facture.dossier_id, journal_code: "VTE", compte_numero: "3421",  date_ecriture: facture.date_facture, libelle: `Solde ${ref}`, debit: Number(facture.montant_ttc), credit: 0, reference_piece: ref, facture_id: facture.id, valide: true },
          { dossier_id: facture.dossier_id, journal_code: "VTE", compte_numero: "7111",  date_ecriture: facture.date_facture, libelle: `Vente ${ref}`, debit: 0, credit: Number(facture.montant_ht), reference_piece: ref, facture_id: facture.id, valide: true },
          { dossier_id: facture.dossier_id, journal_code: "VTE", compte_numero: "44551", date_ecriture: facture.date_facture, libelle: `TVA ${ref}`, debit: 0, credit: Number(facture.montant_tva), reference_piece: ref, facture_id: facture.id, valide: true },
          { dossier_id: facture.dossier_id, journal_code: "OD",  compte_numero: "4191",  date_ecriture: facture.date_facture, libelle: `Imputation acompte ${ref}`, debit: Number(facture.montant_ht), credit: 0, reference_piece: ref, facture_id: facture.id, valide: true },
          { dossier_id: facture.dossier_id, journal_code: "OD",  compte_numero: "7111",  date_ecriture: facture.date_facture, libelle: `Imputation acompte ${ref}`, debit: 0, credit: Number(facture.montant_ht), reference_piece: ref, facture_id: facture.id, valide: true },
        ]);
      } else {
        await supabase.from("ecritures_comptables").insert([
          { dossier_id: facture.dossier_id, journal_code: "VTE", compte_numero: "3421",  date_ecriture: facture.date_facture, libelle: `Vente ${ref}`, debit: Number(facture.montant_ttc), credit: 0, reference_piece: ref, facture_id: facture.id, valide: true },
          { dossier_id: facture.dossier_id, journal_code: "VTE", compte_numero: "7111",  date_ecriture: facture.date_facture, libelle: `Vente ${ref}`, debit: 0, credit: Number(facture.montant_ht), reference_piece: ref, facture_id: facture.id, valide: true },
          { dossier_id: facture.dossier_id, journal_code: "VTE", compte_numero: "44551", date_ecriture: facture.date_facture, libelle: `TVA collectée ${ref}`, debit: 0, credit: Number(facture.montant_tva), reference_piece: ref, facture_id: facture.id, valide: true },
        ]);
      }
      await supabase.from("ged_documents").insert({
        dossier_id: facture.dossier_id,
        facture_id: facture.id,
        nom_fichier: `${facture.numero ?? facture.id}.xml`,
        type_document: "facture_client",
        hash_sha256: hash,
        dgi_uuid,
        horodatage: new Date().toISOString(),
        taille_bytes: xml.length,
        mime_type: "application/xml",
      });
      if (client?.email) {
        const { subject, html } = emailFactureClient({
          clientNom: client.nom,
          numeroFacture: facture.numero ?? facture.id,
          montantTTC: Number(facture.montant_ttc),
          dateEcheance: facture.date_echeance,
          dgiUuid: dgi_uuid ?? "",
          hashSha256: hash,
          societeNom: societe?.nom_societe ?? "HisabPro",
        });
        await envoyerEmail(client.email, subject, html);
      }
    } else if (!conforme) {
      const { data: prof } = await supabase
        .from("profiles")
        .select("email")
        .limit(1)
        .maybeSingle();
      if (prof?.email) {
        const { subject, html } = emailFactureRejetee({
          comptableEmail: prof.email,
          numeroFacture: facture.numero ?? facture.id,
          clientNom: client?.nom ?? "Client",
          erreurs,
          dgiResponse: dgi_response,
        });
        await envoyerEmail(prof.email, subject, html);
      }
    }

    await supabase.from("audit_logs").insert({
      dossier_id: facture.dossier_id,
      action: conforme ? "efacture_conforme" : "efacture_rejetee",
      ressource_type: "facture",
      ressource_id: facture.id,
      details: { dgi_uuid, hash: hash.slice(0, 16) },
    });

    return {
      success: true,
      conforme,
      xml,
      hash,
      dgi_uuid,
      dgi_response,
      email_sent: conforme && !!client?.email,
      client_email_manquant: conforme && !client?.email,
    };
  });

// ─── CACHE OCR DOCUMENT ──────────────────────────────────────────────────────
// Empreinte stable d'un document scanné : on normalise le texte extrait (accents,
// ponctuation et espaces retirés → MAJUSCULES) puis on le hashe. Deux scans du même
// document (même fichier, ou re-saisie identique) produisent le MÊME hash → cache-hit
// → le LLM est court-circuité. Si le texte est trop pauvre (PDF scanné image), on se
// rabat sur le hash des octets image (un doublon de fichier reste détecté).
function normalizeOcrText(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")   // accents
    .toUpperCase()
    .replace(/[^0-9A-Z]+/g, "");       // ne garde que lettres + chiffres
}
function ocrInputHash(text: string, imageBase64?: string): string | null {
  const norm = normalizeOcrText(text);
  if (norm.length >= 200) return "t:" + createHash("sha256").update(norm).digest("hex");
  if (imageBase64 && imageBase64.length > 100) return "i:" + createHash("sha256").update(imageBase64).digest("hex");
  if (norm.length > 0) return "t:" + createHash("sha256").update(norm).digest("hex");
  return null;
}
// Lecture du cache (best-effort : table absente / proxy → null, jamais bloquant).
async function lookupOcrCache(sb: any, dossierId: string, hash: string): Promise<any | null> {
  try {
    const { data, error } = await sb.from("ocr_cache")
      .select("result").eq("dossier_id", dossierId).eq("input_hash", hash).limit(1).maybeSingle();
    if (error) { console.error("[ocr_cache] lookup ÉCHOUÉ:", error.message ?? error); return null; }
    return (data as any)?.result ?? null;
  } catch (e: any) { console.error("[ocr_cache] lookup EXCEPTION:", e?.message ?? e); return null; }
}
// Écriture du cache (upsert idempotent sur (dossier_id, input_hash)).
async function storeOcrCache(sb: any, dossierId: string, hash: string, result: any): Promise<void> {
  try {
    const { error } = await sb.from("ocr_cache").upsert(
      { dossier_id: dossierId, input_hash: hash, result, created_at: new Date().toISOString() },
      { onConflict: "dossier_id,input_hash" },
    );
    if (error) console.error("[ocr_cache] store ÉCHOUÉ:", error.message ?? error);
  } catch (e: any) { console.error("[ocr_cache] store EXCEPTION:", e?.message ?? e); }
}

// ─── ocrFacture ───────────────────────────────────────────────────────────────
// FIX: Le texte extrait du PDF est passé côté serveur — le worker PDF.js

// est uniquement utilisé côté client (scan.tsx / factures.tsx).
// Ce handler ne fait qu'appeler l'IA avec le texte déjà extrait.
export const ocrFacture = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({
      extracted_text: z.string().default(""),
      image_base64: z.string().optional(),
      mime_type: z.string().default("image/jpeg"),
      dossier_id: z.string().uuid(),
      // POC mémoire des tiers : "fournisseur" active le rappel avant LLM (émetteur).
      sens_hint: z.enum(["client", "fournisseur"]).optional(),
    }).parse(input)
  )
  .handler(async ({ data }) => {
    // Quota AVANT tout appel IA : un scan refusé ne doit rien coûter.
    // Idempotent sur le contenu → un re-scan du même document ne redécompte pas.
    // Le crédit est RENDU en fin de handler si le document n'a finalement
    // déclenché aucun appel IA (cache OCR ou mémoire des tiers).
    const scanQuota = {
      dossier_id: data.dossier_id,
      kind: "facture" as const,
      contenu: data.image_base64 || data.extracted_text || "",
    };
    const decisionQuota = await guardScan(scanQuota);

    const supabase = getSupabase();
    const { data: dossier } = await supabase
      .from("dossiers" as any)
      .select("nom_societe,ice")
      .eq("id", data.dossier_id)
      .maybeSingle();
    const dossierNom = (dossier as any)?.nom_societe ?? "";
    const dossierIce = (dossier as any)?.ice ?? "";
    const text = data.extracted_text ?? "";

    const _textNonWs = text.replace(/\s/g, "").length;
    const _likelyScan = _textNonWs < 300 || /camscanner/i.test(text);
    if (_likelyScan && !data.image_base64) {
      throw new Error("PDF non lisible, envoyez une image");
    }

    // ── Step 1: Regex deterministic extraction ────────────────────────────────
    const rx = parseInvoiceRegex(text, dossierNom, dossierIce);

    let result: any = {
      client_nom_extrait: "",
      ice_client: null,
      numero_facture: rx.numero_facture,
      date_facture: rx.date_facture,
      date_echeance: rx.date_echeance,
      delai_paiement_jours: 30,
      montant_ht: rx.montant_ht,
      montant_tva: rx.montant_tva,
      montant_ttc: rx.montant_ttc,
      taux_tva: null,
      lignes: [],
      type_facture: "standard",
      numero_commande: null,
      numero_acompte: null,
      montant_commande_total_ht: null,
      montant_commande_total_ttc: null,
      montant_restant_du: null,
      sens_facture: rx.sens_facture,
      emetteur_nom: rx.emetteur_nom,
      emetteur_ice: rx.emetteur_ice,
      mode_reglement: rx.mode_reglement,
      notes_manuscrites: null,
    };
    let confidence: "high" | "medium" | "low" = rx.confidence;
    let method = "regex";

    // ── POC MÉMOIRE (point 3) : rappel du tiers AVANT le LLM ───────────────────
    // Si l'émetteur (fournisseur) est déjà connu (ICE exact = clé forte, ou libellé),
    // on rappelle sa classification apprise. Un rappel FORT (ICE) + un total lisible
    // par la regex permet de COURT-CIRCUITER l'appel IA (méthode = "memoire").
    let memoire: Awaited<ReturnType<typeof rappelerMemoire>> = null;
    let skipLLM = false;
    if (data.sens_hint === "fournisseur" && (rx.emetteur_ice || rx.emetteur_nom)) {
      memoire = await rappelerMemoire(supabase, {
        dossier_id: data.dossier_id, sens: "fournisseur",
        ice: rx.emetteur_ice, nom: rx.emetteur_nom,
      });
      if (memoire?.par_ice && rx.montant_ttc > 0) {
        skipLLM = true;
        console.log(`[OCR] Mémoire: fournisseur reconnu par ICE (${memoire.occurrences} usage(s)) → LLM court-circuité`);
      }
    }

    // ── CACHE DOCUMENT : même facture déjà scannée → réutiliser le résultat OCR ─
    // Empreinte du contenu (texte normalisé, sinon octets image). Un cache-hit
    // court-circuite l'appel LLM (méthode = "cache", skip_llm = true dans l'usage).
    const inputHash = ocrInputHash(text, data.image_base64);
    if (!skipLLM && inputHash) {
      const cached = await lookupOcrCache(supabase, data.dossier_id, inputHash);
      if (cached) {
        result = { ...result, ...cached };
        confidence = "high";
        method = "cache";
        skipLLM = true;
        console.log(`[OCR] Cache document (hash ${inputHash.slice(0, 10)}…) → LLM court-circuité`);
      }
    }

    // ── Step 2: call AI for semantic fields (name, sens, type, lignes) — SAUF si
    //    la mémoire a permis de court-circuiter (skipLLM).
    // Regex results are a fallback — PDF column layouts make positional text
    // extraction unreliable for company names. AI reads the full text semantically.
    if (!skipLLM) try {
      const useVision = _likelyScan && !!data.image_base64;
      console.log("[OCR] useVision:", useVision, "| textNonWs:", _textNonWs, "| hasImage:", !!data.image_base64, "| mime:", data.mime_type);
      const { ai, provider } = await extraireFactureIA({
        dossierNom,
        dossierIce,
        text,
        imageBase64: data.image_base64,
        mimeType: data.mime_type,
        useVision,
      });
      console.log("[OCR] extraction par:", provider);

      // AI wins for all fields; regex values are fallback for fields AI left empty/zero
      result = {
        ...result,
        sens_facture: ai.sens_facture ?? result.sens_facture,
        emetteur_nom: ai.emetteur_nom || result.emetteur_nom,
        emetteur_ice: ai.emetteur_ice || result.emetteur_ice,
        client_nom_extrait: ai.client_nom ?? "",
        ice_client: ai.client_ice ?? null,
        numero_facture: ai.numero || result.numero_facture,
        date_facture: ai.date || result.date_facture,
        date_echeance: ai.date_echeance || result.date_echeance,
        date_commande: ai.date_commande ?? null,
        dates_reference: Array.isArray(ai.dates_reference) ? ai.dates_reference : [],
        montant_ht: Number(ai.montant_ht) || result.montant_ht,
        montant_tva: Number(ai.montant_tva) || result.montant_tva,
        montant_ttc: Number(ai.montant_ttc) || result.montant_ttc,
        taux_tva: ai.taux_tva != null ? Number(ai.taux_tva) : null,
        type_facture: ai.type_facture ?? "standard",
        type_document_justificatif: ai.type_document_justificatif ?? null,
        categorie_pcm: ai.categorie_pcm ?? null,
        compte_pcm: ai.compte_pcm ?? null,
        periode: ai.periode ?? null,
        numero_compteur: ai.numero_compteur ?? null,
        numero_commande: ai.numero_commande ?? null,
        numero_acompte: ai.numero_acompte ?? null,
        montant_commande_total_ht: Number(ai.montant_commande_total_ht) || null,
        montant_commande_total_ttc: Number(ai.montant_commande_total_ttc) || null,
        montant_restant_du: Number(ai.montant_restant_du) || null,
        mode_reglement: ai.mode_reglement ?? result.mode_reglement,
        lignes: (ai.lignes ?? []).map((l: any) => {
          // Taux de la ligne, sinon taux global de la facture — sert à reconstituer
          // le HT quand la facture n'affiche QUE le prix unitaire TTC.
          const tauxLigne =
            l.taux_tva != null ? Number(l.taux_tva)
            : ai.taux_tva != null ? Number(ai.taux_tva)
            : null;
          let prix_unitaire = Number(l.prix_unitaire_ht ?? l.prix_unitaire) || 0;
          const puTtc = Number(l.prix_unitaire_ttc) || 0;
          // Source de vérité interne = HT. Si seul le TTC est présent → on le convertit.
          if (!prix_unitaire && puTtc > 0) prix_unitaire = puTtcToHt(puTtc, tauxLigne);
          return {
            designation: l.description ?? l.designation ?? "Prestation",
            quantite: Number(l.quantite) || 1,
            prix_unitaire,
            taux_tva: tauxLigne,
          };
        }),
        notes_manuscrites: typeof ai.notes_manuscrites === "string" && ai.notes_manuscrites.trim()
          ? ai.notes_manuscrites.trim()
          : null,
      };
      confidence = "high";
      method = "ai";

      // ── Post-correction mathématique des montants ────────────────────────────
      const corrected = correctMontants({
        montant_ht:  Number(result.montant_ht)  || 0,
        montant_tva: Number(result.montant_tva) || 0,
        montant_ttc: Number(result.montant_ttc) || 0,
        taux_tva:    result.taux_tva != null ? Number(result.taux_tva) : null,
      });
      result.montant_ht  = corrected.montant_ht;
      result.montant_tva = corrected.montant_tva;
      result.montant_ttc = corrected.montant_ttc;
      result.taux_tva    = corrected.taux_tva;

      // ── Normalisation + validation des dates ────────────────────────────────
      // Convertit DD/MM/YYYY ou DD-MM-YYYY → YYYY-MM-DD avant toute validation
      const toISO = (d: string | null | undefined): string | null => {
        if (!d) return null;
        const s = d.trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
        const m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
        if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
        return null;
      };
      const today = new Date();
      const validDate = (d: string | null | undefined): string | null => {
        const iso = toISO(d);
        if (!iso) return null;
        const dt = new Date(iso);
        if (isNaN(dt.getTime())) return null;
        if (dt.getFullYear() < 2000 || dt.getFullYear() > today.getFullYear() + 1) return null;
        return iso;
      };
      result.date_facture  = validDate(result.date_facture);
      result.date_echeance = validDate(result.date_echeance);
      // Échéance ne peut pas être avant la date de facture
      if (result.date_facture && result.date_echeance && result.date_echeance < result.date_facture)
        result.date_echeance = null;

      // ── Mémorise le résultat OCR pour ce document → prochain scan identique = cache-hit.
      if (inputHash) await storeOcrCache(supabase, data.dossier_id, inputHash, result);

    } catch (e: any) {
      const msg = String(e?.message ?? e);
      console.error("[OCR] IA échouée:", msg);
      // TLS / réseau → pas la peine de propager, retourner résultat regex partiel
      // avec confidence low pour que l'utilisateur puisse compléter manuellement.
      // Pour toute autre erreur sur PDF scanné sans texte, on re-throw.
      const isTlsOrNetwork = /SELF_SIGNED|CERT|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed/i.test(msg);
      if (_likelyScan && !text && !isTlsOrNetwork) throw e;
      confidence = isTlsOrNetwork ? "low" : rx.confidence;
      method = "regex";
      if (isTlsOrNetwork) {
        console.warn("[OCR] Proxy SSL détecté — résultat partiel (regex). Ajoutez NODE_TLS_REJECT_UNAUTHORIZED=0 dans .env pour activer l'OCR vision.");
      }
    }

    // ── POC MÉMOIRE : application de la classification apprise ─────────────────
    // La mémoire fait autorité sur la TVA / compte / catégorie du tiers connu.
    if (memoire) {
      if (memoire.taux_tva != null) result.taux_tva = Number(memoire.taux_tva);
      result.compte_pcm = memoire.compte_pcm ?? result.compte_pcm ?? null;
      result.categorie_pcm = memoire.categorie_pcm ?? result.categorie_pcm ?? null;
      if (skipLLM) {
        // Aucun appel IA : on s'appuie sur la regex (montants) + la mémoire (classif).
        method = "memoire";
        confidence = "high";
        result.emetteur_nom = result.emetteur_nom || rx.emetteur_nom;
        result.emetteur_ice = result.emetteur_ice || rx.emetteur_ice;
        result.sens_facture = "fournisseur";
      }
    }

    // Auto-fill echéance if missing
    if (!result.date_echeance && result.date_facture) {
      const d = new Date(result.date_facture);
      d.setDate(d.getDate() + 30);
      result.date_echeance = d.toISOString().slice(0, 10);
    }

    // Default line if none extracted
    if (!result.lignes?.length && result.montant_ttc > 0) {
      result.lignes = [
        {
          designation: "Prestation (à préciser)",
          quantite: 1,
          prix_unitaire: result.montant_ht,
          taux_tva: result.taux_tva ?? 20,
        },
      ];
    }

    // ── Résolution fournisseur en base (pour factures fournisseurs) ────────────
    let fournisseur_id: string | null = null;
    let fournisseur_action: "found" | "not_found" = "not_found";
    let fournisseur_trouve: any = null;
    const emNom = result.emetteur_nom?.trim();
    const emIce = result.emetteur_ice?.trim();

    if ((emNom || emIce) && result.sens_facture === "fournisseur") {
      if (emIce) {
        const { data: byIce } = await supabase
          .from("fournisseurs")
          .select("*")
          .eq("dossier_id", data.dossier_id)
          .eq("ice", emIce)
          .is("deleted_at", null)
          .maybeSingle();
        if (byIce) {
          fournisseur_id = (byIce as any).id;
          fournisseur_action = "found";
          fournisseur_trouve = byIce;
        }
      }
      if (!fournisseur_id && emNom) {
        const { data: byNom } = await supabase
          .from("fournisseurs")
          .select("*")
          .eq("dossier_id", data.dossier_id)
          .ilike("nom", `%${emNom.slice(0, 20)}%`)
          .is("deleted_at", null)
          .maybeSingle();
        if (byNom) {
          fournisseur_id = (byNom as any).id;
          fournisseur_action = "found";
          fournisseur_trouve = byNom;
        }
      }
    }

    // ── Résolution client en base ─────────────────────────────────────────────
    let client_id: string | null = null;
    let client_action: "found" | "created" | "not_found" = "not_found";
    let client_trouve: any = null;
    const nomClient = result.client_nom_extrait?.trim();
    const iceClient = result.ice_client?.trim();

    if ((nomClient || iceClient) && result.sens_facture !== "fournisseur") {
      if (iceClient) {
        const { data: byIce } = await supabase
          .from("clients")
          .select("*")
          .eq("dossier_id", data.dossier_id)
          .eq("ice", iceClient)
          .is("deleted_at", null)
          .maybeSingle();
        if (byIce) {
          client_id = byIce.id;
          client_action = "found";
          client_trouve = byIce;
        }
      }
      if (!client_id && nomClient) {
        const { data: byNom } = await supabase
          .from("clients")
          .select("*")
          .eq("dossier_id", data.dossier_id)
          .ilike("nom", `%${nomClient.slice(0, 20)}%`)
          .is("deleted_at", null)
          .maybeSingle();
        if (byNom) {
          client_id = byNom.id;
          client_action = "found";
          client_trouve = byNom;
        }
      }
      if (!client_id && result.sens_facture === "client" && nomClient) {
        const { data: nouveau } = await supabase
          .from("clients")
          .insert({ dossier_id: data.dossier_id, nom: nomClient, ice: iceClient ?? null })
          .select()
          .single();
        if (nouveau) {
          client_id = nouveau.id;
          client_action = "created";
          client_trouve = nouveau;
        }
      }
    }

    console.log("[OCR] final:", {
      confidence,
      method,
      sens: result.sens_facture,
      client: result.client_nom_extrait,
      emetteur: result.emetteur_nom,
      ttc: result.montant_ttc,
    });
    // ── Logging usage (best-effort) : facture via mémoire / IA / regex ────────
    // Module = sens détecté (client/fournisseur), à défaut l'indice d'appel.
    const factureModule =
      result.sens_facture === "client" ? "facture_client"
      : result.sens_facture === "fournisseur" ? "facture_fournisseur"
      : data.sens_hint === "client" ? "facture_client" : "facture_fournisseur";
    await logUsage(supabase, {
      dossier_id: data.dossier_id,
      sens: "facture",
      method: skipLLM ? "memoire" : method === "ai" ? "llm" : "regex",
      skip_llm: skipLLM,
      cout_estime: estimerCoutIA("facture"),
      module: factureModule,
      phase: "ocr",
      libelle: result.emetteur_nom ?? null,
    });

    // ── Quota : un document servi par le cache ou la mémoire n'a coûté AUCUN
    // appel IA → on lui rend son crédit. Sur un rejeu (`replay`), le crédit est
    // celui du scan d'origine, qui lui a bien payé l'IA : on n'y touche pas.
    let quotaRendu = false;
    if (skipLLM && !decisionQuota.replay && !decisionQuota.degraded) {
      quotaRendu = await libererScan(scanQuota);
    }

    return {
      result: {
        ...result,
        confidence,
        method,
        // L'UI peut ainsi dire « scan non décompté » sur un cache/mémoire.
        quota_non_decompte: quotaRendu || Boolean(decisionQuota.replay),
        client_id,
        client_action,
        client_trouve,
        fournisseur_id,
        fournisseur_action,
        fournisseur_trouve,
        // POC mémoire : métadonnées de rappel (null si aucun rappel).
        memoire: memoire
          ? {
              par_ice: memoire.par_ice,
              occurrences: memoire.occurrences,
              compte_pcm: memoire.compte_pcm,
              categorie_pcm: memoire.categorie_pcm,
              taux_tva: memoire.taux_tva,
              llm_court_circuite: skipLLM,
            }
          : null,
      },
    };
  });

// ─── marquerPayee ─────────────────────────────────────────────────────────────
export const marquerPayee = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({
      facture_id: z.string().uuid(),
      date_paiement: z.string(),
      mode: z.string().default("especes"),
    }).parse(input)
  )
  .handler(async ({ data }) => {
    const supabase = getSupabase();
    const { data: f } = await supabase
      .from("factures")
      .select("dossier_id,montant_ttc,montant_paye,numero,statut")
      .eq("id", data.facture_id)
      .single();
    if (!f) throw new Error("Facture introuvable");
    // Ce bouton est le règlement COMPTANT du guichet : les espèces passent par la
    // caisse (journal CAI / 5143, comme l'encaissement manuel de la page Banque),
    // tout autre mode par la banque (BQ / 5141). Sans ce couple, le libellé du
    // bouton dirait « espèces » pendant que l'écriture débiterait la banque.
    const especes = data.mode === "especes";
    const journal = especes ? "CAI" : "BQ";
    const compteTresorerie = especes ? "5143" : "5141";
    // Le règlement passe par un paiement `manuel` couvrant le reste dû ; le trigger
    // recalcule montant_paye/montant_restant/statut. Le montant du paiement = solde
    // restant (TTC − déjà payé), pour ne pas sur-payer une facture partiellement réglée.
    const dejaPaye = Number((f as any).montant_paye ?? 0);
    const solde = Math.max(0, Math.round((Number(f.montant_ttc) - dejaPaye) * 100) / 100);
    if (solde > 0) {
      await enregistrerPaiement(supabase, {
        dossierId: f.dossier_id, table: "factures", factureId: data.facture_id,
        montant: solde, date: data.date_paiement, origine: "manuel",
      });
    }
    const ref = f.numero ?? data.facture_id;
    await supabase.from("ecritures_comptables").insert([
      { dossier_id: f.dossier_id, journal_code: journal, compte_numero: compteTresorerie, date_ecriture: data.date_paiement, libelle: `Encaissement ${especes ? "espèces " : ""}${ref}`, debit: Number(f.montant_ttc), credit: 0, reference_piece: ref, facture_id: data.facture_id, valide: true },
      { dossier_id: f.dossier_id, journal_code: journal, compte_numero: "3421", date_ecriture: data.date_paiement, libelle: `Règlement client ${ref}`, debit: 0, credit: Number(f.montant_ttc), reference_piece: ref, facture_id: data.facture_id, valide: true },
    ]);
    // Estampille du mode réellement employé : c'est elle que lit la colonne
    // « Mode de paiement » quand aucune pièce bancaire n'explique le règlement
    // (cf. src/lib/mode-paiement.ts). Sans elle, la facture réglée au comptant
    // afficherait le mode PRÉVU lu par l'OCR à la création.
    await supabase.from("factures").update({ mode_reglement: data.mode }).eq("id", data.facture_id);
    return { ok: true };
  });

// ─── ajouterEmailClient ───────────────────────────────────────────────────────
export const ajouterEmailClient = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({
      client_id: z.string().uuid(),
      email: z.string().email(),
    }).parse(input)
  )
  .handler(async ({ data }) => {
    const supabase = getSupabase();
    const { error } = await supabase
      .from("clients")
      .update({ email: data.email })
      .eq("id", data.client_id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ─── analyserReleveIA ─────────────────────────────────────────────────────────
// CORRECTIONS CLÉS :
// 1. Groq reçoit maintenant les transactions indexées avec leur position
//    RÉELLE dans le tableau (propriété `_idx`), pas un `i` auto-incrémenté
//    que Groq peut décaler ou sauter.
// 2. Le post-traitement mappe par `_idx` (ou `i` comme fallback), puis
//    reconstruit le tableau final dans le même ordre que transactions_brutes.
// 3. Si Groq renvoie moins d'analyses que de transactions (truncation),
//    les transactions manquantes reçoivent une analyse par défaut
//    (nécessite_remarque: true) au lieu de disparaître silencieusement.
// 4. Règles absolues appliquées en post-traitement côté serveur,
//    indépendamment de ce que Groq retourne.

// ─── Fonctions pures (exportées pour les tests unitaires) ────────────────────

// Alias télécom : MAROC TELECOM, ITISSALAT → IAM ; MEDITEL → ORANGE, etc.
// Normalisé des deux côtés (libellé ET nom fournisseur) pour unifier le matching.
const TELECOM_CANONICAL: Record<string, string[]> = {
  IAM:    ["IAM", "MAROC TELECOM", "ITISSALAT"],
  ORANGE: ["ORANGE", "MEDITEL", "MEDITELECOM"],
  INWI:   ["INWI", "WANA"],
  ONEE:   ["ONEE", "RADEEF", "RADEEMA", "AMENDIS", "LYONNAISE"],
};

export function normalizeTelecom(name: string): string {
  const u = name.toUpperCase();
  for (const [canonical, variants] of Object.entries(TELECOM_CANONICAL)) {
    // Matching par mot entier pour éviter les faux positifs (ex: "IT" dans "MEDITEL")
    if (variants.some((v) => new RegExp(`(?:^|\\W)${v}(?:\\W|$)`).test(u))) return canonical;
  }
  return u;
}

// Préfixes bancaires à supprimer avant d'extraire le nom du tiers
const PAYMENT_PREFIXES = [
  /^PAIEMENT\s+CB\s+\d{1,2}\s+\d{1,2}\s+\d{2,4}\s+/i,
  /^PAIEMENT\s+CHEQ(?:UE)?\s+(?:N[°O]?\s*\w+\s+)?/i,
  /^VIREMENT\s+RECU\s+(?:DE\s+)?/i,
  /^VIR(?:EMENT)?\s+(?:AG\s+)?EMIS\s+(?:VERS\s+)?/i,
  /^VIREMENT\s+/i,
  /^PAIEMENT\s+/i,
  /^REMISE\s+CHE?Q\S*\s+/i,
  /^RETRAIT\s+(?:GAB|ESPECES?)\s+/i,
  /^PRELEVEMENT\s+/i,
];

/** Extrait le nom du tiers depuis un libellé bancaire brut. */
export function extractTiersFromLibelle(libelle: string): string {
  let s = libelle.trim();
  for (const re of PAYMENT_PREFIXES) s = s.replace(re, "").trim();
  // Supprimer une date DD MM YY[YY] en début (ex: "26 03 26 TESDRAMENVEST")
  s = s.replace(/^\d{1,2}[\s\/\-]\d{1,2}[\s\/\-]\d{2,4}\s+/, "").trim();
  // Supprimer une date en fin
  s = s.replace(/\s+\d{1,2}[\s\/\-]\d{1,2}[\s\/\-]\d{2,4}$/, "").trim();
  return s;
}

/** Score de similarité [0-1] entre deux noms de tiers. */
export function nameSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  // Normaliser alias télécom des deux côtés
  const au = normalizeTelecom(a.toUpperCase());
  const bu = normalizeTelecom(b.toUpperCase());
  if (au === bu) return 1;
  if (au.includes(bu) || bu.includes(au)) return 0.92;
  // Overlap de tokens ≥ 3 chars
  const tokA = new Set(au.split(/\W+/).filter((t) => t.length >= 3));
  const tokB = new Set(bu.split(/\W+/).filter((t) => t.length >= 3));
  if (!tokA.size || !tokB.size) return 0;
  let common = 0;
  for (const t of tokA) {
    if (tokB.has(t)) { common += 1; continue; }
    for (const bt of tokB) {
      if (bt.startsWith(t) || t.startsWith(bt)) { common += 0.8; break; }
    }
  }
  return Math.min(1, common / Math.max(tokA.size, tokB.size));
}

/**
 * Pré-matching déterministe avant Groq.
 * Pour chaque transaction, tente de trouver une facture via :
 *   1. Similarité de nom tiers (libellé nettoyé ↔ fournisseur_nom / client_nom)
 *   2. Montant restant ±2 MAD (tolérance arrondi)
 * Retourne null si aucun match fiable (seuil nameSimilarity < 0.70).
 */
/**
 * Résout la chaîne de documents liés (devis → BC → BL) et retourne
 * le document "feuille" (dernier dans la chaîne, celui qui n'est
 * référencé par aucun autre document).
 */
function findLeafJustificatif(startId: string, all: any[]): any {
  let currentId = startId;
  for (let depth = 0; depth < 8; depth++) {
    const children = all.filter(
      j => j.bon_commande_id === currentId || j.devis_id === currentId
    );
    if (children.length === 0) break;
    // Préférer BL sur BC, puis le plus récent
    const child =
      children.find(j => j.type_document === "bon_livraison") ??
      children.sort((a, b) =>
        (b.created_at ?? "").localeCompare(a.created_at ?? "")
      )[0];
    currentId = child.id;
  }
  return all.find(j => j.id === currentId) ?? null;
}

type PreMatch = {
  facture_id: string | null;
  facture_num: string | null;
  justificatif_id: string | null;
  confiance: number;
};

export function preMatchTransactions(
  transactions: any[],
  facturesFourn: any[],
  facturesClient: any[],
  justificatifs: any[] = [],
): Array<PreMatch | null> {
  return transactions.map((tx) => {
    const libelle = (tx.libelle ?? tx.nature_operation ?? "").toUpperCase();
    const montant = (tx.montant_debit ?? 0) || (tx.montant_credit ?? 0);
    const tiers   = extractTiersFromLibelle(libelle);

    // Factures fournisseurs (débits) — priorité 1
    if (tx.montant_debit) {
      for (const fac of facturesFourn) {
        const nom     = (fac.fournisseur_nom ?? "").toUpperCase();
        const restant = Number(fac.montant_restant ?? fac.montant_ttc);
        const sim     = nameSimilarity(tiers, nom);
        if (sim >= 0.70 && Math.abs(montant - restant) <= 2) {
          return { facture_id: fac.id, facture_num: fac.numero ?? null, justificatif_id: null, confiance: Math.round(sim * 95) };
        }
      }
    }

    // Factures clients (crédits) — priorité 1
    if (tx.montant_credit) {
      for (const fac of facturesClient) {
        const nom     = (fac.clients?.nom ?? "").toUpperCase();
        const restant = Number(fac.montant_restant ?? fac.montant_ttc);
        const sim     = nameSimilarity(tiers, nom);
        if (sim >= 0.70 && Math.abs(montant - restant) <= 2) {
          return { facture_id: fac.id, facture_num: fac.numero ?? null, justificatif_id: null, confiance: Math.round(sim * 95) };
        }
      }
    }

    // Justificatifs (BC / BL / reçu / note frais) — priorité 2, si pas de facture
    if (justificatifs.length > 0) {
      for (const j of justificatifs) {
        const nom = (j.nom_tiers ?? "").toUpperCase();
        const ttc = Number(j.montant_ttc || 0);
        const sim = nameSimilarity(tiers, nom);
        if (sim >= 0.70 && Math.abs(montant - ttc) <= 2) {
          // Résoudre la chaîne : prendre le dernier document lié (BL > BC > devis)
          const leaf = findLeafJustificatif(j.id, justificatifs);
          const leafId = leaf?.id ?? j.id;
          const leafNum = leaf?.numero_piece ?? j.numero_piece ?? null;
          return {
            facture_id: null,
            facture_num: leafNum,
            justificatif_id: leafId,
            confiance: Math.round(sim * 88),
          };
        }
      }
    }

    return null;
  });
}

const TELECOM_KEYWORDS = ["IAM", "ORANGE", "INWI", "MAROC TELECOM", "MEDITEL"];
const RETRAIT_KEYWORDS = ["RETRAIT ESPECES", "RETRAIT GAB", "RETRAIT DISTRIBUTEUR"];

/**
 * Applique les overrides par mots-clés (télécom, retrait).
 * Pour IAM/ORANGE/etc. : garde facture_id si l'IA a trouvé un match facture,
 * sinon catégorise en telecom. Ne force JAMAIS facture_id à null pour télécom.
 */
export function applyKeywordOverrides(
  analyses: any[],
  transactions: any[],
): any[] {
  return analyses.map((a, idx) => {
    const tx = transactions[idx];
    if (!tx) return a;
    const lib = (tx.libelle ?? tx.nature_operation ?? "").toUpperCase();
    const brut = (tx.montant_debit ?? 0) || (tx.montant_credit ?? 0);
    const ht   = brut > 0 ? Math.round((brut / 1.2) * 100) / 100 : 0;
    const tva  = brut > 0 ? Math.round((brut - ht) * 100) / 100 : 0;

    if (TELECOM_KEYWORDS.some((k) => lib.includes(k))) {
      const hasMatch = !!a.facture_id;
      return {
        ...a,
        // Si l'IA a matché une facture fournisseur IAM, garder paiement_fournisseur
        // pour que handleValider marque la facture comme payée.
        // Sinon, catégoriser en telecom (pas de facture à rapprocher).
        categorie: hasMatch ? "paiement_fournisseur" : "telecom",
        code_pcm: "6145",
        taux_tva: 20,
        montant_ht: ht,
        montant_tva: tva,
        etape_rapprochement: hasMatch ? a.etape_rapprochement : "mots_cles",
        confiance: hasMatch ? Math.max(a.confiance ?? 0, 85) : 90,
        // facture_id conservé si l'IA l'a trouvé — pas de reset forcé
        alerte: null,
        necessite_remarque: false,
      };
    }

    if (RETRAIT_KEYWORDS.some((k) => lib.includes(k))) {
      return {
        ...a,
        categorie: "retrait_especes",
        code_pcm: "5143",
        taux_tva: 0,
        montant_ht: tx.montant_debit ?? 0,
        montant_tva: 0,
        etape_rapprochement: "mots_cles",
        confiance: 99,
        facture_id: null,
        alerte: null,
        necessite_remarque: false,
      };
    }

    return a;
  });
}

/**
 * Déduplique les matches facture : si la même facture_id apparaît sur plusieurs
 * transactions, seule celle avec la confiance la PLUS HAUTE est conservée.
 * L'ancienne version gardait la PREMIÈRE — ce qui causait le bug "Doublon détecté"
 * sur le bon match quand une transaction moins pertinente était listée avant.
 */
export function deduplicateAnalyses(analyses: any[]): any[] {
  const result = analyses.map((a) => ({ ...a }));

  // Déduplication facture_id
  const bestFacIdx = new Map<string, number>();
  for (let i = 0; i < result.length; i++) {
    const fid = result[i].facture_id;
    if (!fid) continue;
    const prev = bestFacIdx.get(fid);
    if (prev === undefined || (result[i].confiance ?? 0) > (result[prev].confiance ?? 0)) {
      bestFacIdx.set(fid, i);
    }
  }
  for (let i = 0; i < result.length; i++) {
    const fid = result[i].facture_id;
    if (!fid || bestFacIdx.get(fid) === i) continue;
    result[i] = {
      ...result[i],
      facture_id: null,
      facture_num: null,
      alerte: `Doublon neutralisé : facture ${result[i].facture_num ?? fid.slice(0, 8)} — match de plus haute confiance sur une autre transaction`,
      necessite_remarque: true,
      confiance: Math.max(40, (result[i].confiance ?? 0) - 30),
    };
  }

  // Déduplication justificatif_id (même logique)
  const bestJustIdx = new Map<string, number>();
  for (let i = 0; i < result.length; i++) {
    const jid = result[i].justificatif_id;
    if (!jid) continue;
    const prev = bestJustIdx.get(jid);
    if (prev === undefined || (result[i].confiance ?? 0) > (result[prev].confiance ?? 0)) {
      bestJustIdx.set(jid, i);
    }
  }
  for (let i = 0; i < result.length; i++) {
    const jid = result[i].justificatif_id;
    if (!jid || bestJustIdx.get(jid) === i) continue;
    result[i] = {
      ...result[i],
      justificatif_id: null,
      alerte: `Doublon neutralisé : justificatif ${jid.slice(0, 8)} — match de plus haute confiance sur une autre transaction`,
      necessite_remarque: true,
      confiance: Math.max(40, (result[i].confiance ?? 0) - 30),
    };
  }

  return result;
}

// ─── ocrReleve ────────────────────────────────────────────────────────────────
// Extrait les transactions d'un relevé bancaire image (JPEG/PNG) ou PDF scanné.
// Retourne le même format que parserTransactions() côté client.
export const ocrReleve = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({
      image_base64: z.string(),
      mime_type: z.string().default("image/jpeg"),
      solde_initial_override: z.number().optional(),
      dossier_id: z.string().uuid().nullish(),  // pour attribuer l'usage IA (analytics)
      // Clé au niveau DOCUMENT : un relevé multi-pages appelle ocrReleve une fois
      // par page. Cette clé regroupe les pages pour ne décompter QU'UN scan
      // (le quota se vend en documents/mois, pas en pages).
      scan_key: z.string().nullish(),
    }).parse(input)
  )
  .handler(async ({ data }) => {
    if (data.dossier_id) {
      await guardScan({
        dossier_id: data.dossier_id,
        kind: "releve",
        contenu: data.scan_key || data.image_base64,
      });
    }

    const { buildReleveImagePrompt } = await import("./factures.utils");
    const prompt = buildReleveImagePrompt();
    console.log("[OCR-RELEVE] mime:", data.mime_type, "| base64 KB:", Math.round(data.image_base64.length * 0.75 / 1024), data.solde_initial_override != null ? `| solde_override: ${data.solde_initial_override}` : "");

    // ── CACHE DOCUMENT : même relevé rescanné → réutiliser l'extraction (skip OCR LLM).
    // Clé = octets image + solde initial reporté (qui change le calcul multi-pages).
    const releveHash = "r:" + createHash("sha256")
      .update(data.image_base64).update("|" + (data.solde_initial_override ?? "")).digest("hex");
    if (data.dossier_id) {
      const cached = await lookupOcrCache(getSupabase(), data.dossier_id, releveHash);
      if (cached?.txs) {
        console.log(`[OCR-RELEVE] Cache document (hash ${releveHash.slice(0, 10)}…) → OCR LLM court-circuité (${cached.txs.length} tx)`);
        await logUsage(getSupabase(), {
          dossier_id: data.dossier_id, sens: "banque", method: "regex", skip_llm: true,
          cout_estime: estimerCoutIA("releve_ocr"), module: "releve", phase: "ocr",
          libelle: `OCR relevé (cache) — ${cached.txs.length} tx`,
        });
        return { txs: cached.txs, info: cached.info };
      }
    }

    const RELEVE_MAX_TOKENS = 8192;
    let parsed: any;
    // Traçage usage IA (analytics) : quelle voie OCR + le LLM de relecture a-t-il été
    // utilisé (llm) ou évité grâce au regex/delta de solde (regex → économie) ?
    let ocrUsedLlm = false;      // relecture mistral-large réellement appelée
    let ocrAiCalled = false;     // un appel OCR IA a bien eu lieu (Mistral OCR ou Groq vision)

    // ── OPTION PRINCIPALE : Mistral OCR (mistral-ocr-latest) — rapide & direct ─
    // Appelé EN PREMIER. S'il renvoie des transactions, on s'arrête là. Sinon
    // (clé absente, échec réseau, 0 transaction) → secours Groq vision.
    if (process.env.MISTRAL_API_KEY) {
      try {
        const markdown = await callMistralOcr(data.image_base64, data.mime_type);
        ocrAiCalled = true;   // appel Mistral OCR effectué
        // Extraction LÉGÈRE : regex pour l'en-tête + 1 appel LLM si des montants
        // manquent (robuste aux changements de format de mistral-ocr). Rapide.
        const { info: mdInfo, txs: mdTxs, usedLlm } = await extractReleveLean(markdown);
        ocrUsedLlm = usedLlm;
        if (mdTxs.length > 0) {
          parsed = {
            banque: mdInfo.banque,
            rib: mdInfo.rib,
            solde_initial: mdInfo.solde_initial,
            solde_final: mdInfo.solde_final,
            txs: mdTxs.map((t: any) => ({
              date_operation: t.date_operation,
              date_valeur: t.date_valeur,
              reference: t.reference,
              libelle: t.libelle,
              montant: t.montant_debit ?? t.montant_credit ?? null,
              montant_debit: t.montant_debit,
              montant_credit: t.montant_credit,
              solde_courant: t.solde_courant ?? null,
              // Sens déjà déterminé (colonne regex ou LLM) → on le marque via `_side`.
              _side: t.montant_credit != null ? "credit" : t.montant_debit != null ? "debit" : undefined,
            })),
          };
          console.log(`[MISTRAL OCR] ✓ ${parsed.txs.length} transactions parsées`);
        } else {
          console.warn("[MISTRAL OCR] 0 transaction parsée — secours Groq vision");
        }
      } catch (e: any) {
        console.warn("[MISTRAL OCR] échec:", e.message, "— secours Groq vision");
      }
    }

    // ── SECOURS (uniquement si Mistral indisponible/échec) : Groq vision ──────
    if (!parsed) {
      const raw = await callAI(prompt, data.image_base64, data.mime_type, RELEVE_MAX_TOKENS);
      ocrAiCalled = true; ocrUsedLlm = true;   // vision Groq = appel LLM complet

      try {
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
      } catch {
        // JSON tronqué (réponse coupée) → récupération partielle
        console.warn("[OCR-RELEVE] JSON tronqué — tentative de récupération partielle");
        try {
          const banque  = raw.match(/"banque"\s*:\s*"([^"]*)"/)?.[1]  ?? "";
          const rib     = raw.match(/"rib"\s*:\s*"([^"]*)"/)?.[1]     ?? "";
          const soldeI  = parseFloat(raw.match(/"solde_initial"\s*:\s*([\d.,]+)/)?.[1]?.replace(",",".") ?? "0");
          const soldeF  = parseFloat(raw.match(/"solde_final"\s*:\s*([\d.,]+)/)?.[1]?.replace(",",".") ?? "0");
          // Extraire les objets tx complets (délimités par { ... }) avant la coupure
          const txRaw   = raw.match(/"txs"\s*:\s*\[([\s\S]*)/)?.[1] ?? "";
          const txObjs  = [...txRaw.matchAll(/\{[^{}]+\}/g)].map(m => { try { return JSON.parse(m[0]); } catch { return null; } }).filter(Boolean);
          parsed = { banque, rib, solde_initial: soldeI, solde_final: soldeF, txs: txObjs };
          console.log("[OCR-RELEVE] Récupération partielle:", txObjs.length, "transactions");
          if (txObjs.length === 0) throw new Error("aucune transaction récupérée");
        } catch (recoverErr: any) {
          throw new Error("OCR relevé : réponse IA non parsable — " + raw.slice(0, 200));
        }
      }
    } // fin secours (!parsed)

    const toNum = (v: any): number => {
      if (v === null || v === undefined || v === "") return 0;
      return parseFloat(String(v).replace(/\s/g, "").replace(",", ".")) || 0;
    };

    const looksCredit = (libelle: string): boolean => {
      const u = (libelle || "").toUpperCase();
      return ["RECU","REÇU","VIR RECU","VIRT RECU","VIREMENT RECU","VIR.WEB RECU","VIR INST RECU",
        "REMISE","VERSEMENT","DEPOT","ENCAISSEMENT","AVOIR","AVIS DE CREDIT",
        "INTERETS CREDIT","INTERETS CREDITEUR","RECOUVREMENT","CREDIT VIREMENT",
      ].some(k => u.includes(k));
    };

    const info = {
      banque: parsed.banque ?? "Banque (image)",
      rib: parsed.rib ?? "",
      solde_initial: toNum(parsed.solde_initial),
      solde_final: toNum(parsed.solde_final),
    };

    // Quand on traite la page 2+, l'image ne contient plus de "SOLDE DEPART",
    // donc le modèle retourne solde_initial=0. On utilise l'override transmis
    // par le client (= solde_final de la page précédente).
    if (data.solde_initial_override != null && data.solde_initial_override > 0) {
      info.solde_initial = data.solde_initial_override;
    }

    // ── Filtre : supprime les fausses transactions "SOLDE REPORTÉ" ───────────
    // Sur les pages 2+, le modèle inclut parfois la ligne de report de solde comme
    // une transaction. On la détecte par : date vide ET libellé contient "SOLDE"/
    // "REPORT"/"ANCIEN", OU montant très proche du solde_initial (report de page).
    // Mots-clés identifiant une ligne de report de solde inter-pages (pas une transaction)
    const SOLDE_REPORT_KW = /\b(solde\s*report[eé]?|rapport\s*solde|ancien\s*solde|solde\s*pr[eé]c[eé]dent)\b/i;
    const rawTxs: any[] = (parsed.txs ?? []).filter((t: any) => {
      const lib = (t.libelle ?? t.nature_operation ?? "").trim();
      if (SOLDE_REPORT_KW.test(lib)) {
        // Récupère son montant comme solde_initial si absent (page 2+ sans en-tête SOLDE DEPART)
        const m = toNum(t.montant) || toNum(t.solde_courant);
        if (m > 0 && info.solde_initial === 0) info.solde_initial = m;
        console.log("[OCR-RELEVE] Ligne SOLDE REPORTÉ filtrée:", lib, "→ solde_initial:", info.solde_initial);
        return false;
      }
      return true;
    });

    // ── Méthode principale : delta du solde courant ───────────────────────────
    // Direction = signe(solde_courant[n] - solde_courant[n-1])
    // C'est mathématiquement déterministe — pas d'hallucination possible.
    let prevSolde: number | null = info.solde_initial > 0 ? info.solde_initial : null;
    let deltaMethodCount = 0;
    let fallbackCount = 0;

    const txs = rawTxs.map((t: any, i: number) => {
      const montant = toNum(t.montant) || toNum(t.montant_debit) || toNum(t.montant_credit) || 0;
      const soldeCourant = t.solde_courant != null ? toNum(t.solde_courant) : null;

      let montant_debit: number | null = null;
      let montant_credit: number | null = null;

      if ((t._side === "debit" || t._side === "credit") && montant > 0) {
        // Colonnes Débit/Crédit explicites (Mistral OCR Markdown) : on fait
        // confiance au tableau, sans re-deviner par delta/mots-clés.
        if (t._side === "credit") montant_credit = montant;
        else montant_debit = montant;
        if (soldeCourant !== null && soldeCourant > 0) prevSolde = soldeCourant;
        else if (prevSolde !== null) {
          prevSolde = montant_credit
            ? Math.round((prevSolde + montant_credit) * 100) / 100
            : Math.round((prevSolde - (montant_debit ?? 0)) * 100) / 100;
        }
        deltaMethodCount++;
      } else if (soldeCourant !== null && soldeCourant > 0 && prevSolde !== null) {
        // Méthode delta : fiable à 100%
        const delta = soldeCourant - prevSolde;
        if (delta > 0.005) {
          montant_credit = montant > 0 ? montant : Math.round(Math.abs(delta) * 100) / 100;
        } else if (delta < -0.005) {
          montant_debit = montant > 0 ? montant : Math.round(Math.abs(delta) * 100) / 100;
        } else if (montant > 0) {
          // delta ≈ 0 : rare (opération nulle), on garde montant brut côté débit
          montant_debit = montant;
        }
        prevSolde = soldeCourant;
        deltaMethodCount++;
      } else {
        // Fallback : mots-clés libellé
        if (montant > 0) {
          if (looksCredit(t.libelle ?? "")) {
            montant_credit = montant;
          } else {
            montant_debit = montant;
          }
        }
        // Mettre à jour prevSolde pour la prochaine tx
        if (soldeCourant !== null && soldeCourant > 0) {
          prevSolde = soldeCourant;
        } else if (prevSolde !== null && montant > 0) {
          prevSolde = montant_credit
            ? Math.round((prevSolde + montant_credit) * 100) / 100
            : Math.round((prevSolde - (montant_debit ?? 0)) * 100) / 100;
        }
        fallbackCount++;
      }

      // Dernier recours : si montant=0 mais solde_courant a été posé à une valeur
      // qui ressemble à un montant de transaction (< prevSolde initial), tenter
      // de récupérer via le delta. Cela couvre le cas où le modèle a confondu
      // la colonne CRÉDIT avec la colonne SOLDE dans un format deux-colonnes.
      if (montant_debit === null && montant_credit === null && soldeCourant !== null) {
        const impliedDelta = soldeCourant - (prevSolde ?? soldeCourant);
        if (Math.abs(impliedDelta) > 0.005 && Math.abs(impliedDelta) < soldeCourant * 0.8) {
          if (impliedDelta > 0) montant_credit = Math.round(impliedDelta * 100) / 100;
          else montant_debit = Math.round(Math.abs(impliedDelta) * 100) / 100;
        }
      }

      return {
        ligne: i + 1,
        date_operation: t.date_operation ?? "",
        date_valeur: t.date_valeur ?? t.date_operation ?? "",
        reference: t.reference ?? "",
        libelle: t.libelle ?? "",
        montant_debit,
        montant_credit,
        nature_operation: t.nature_operation ?? "",
      };
    // Filtre : ne supprime que les entrées sans date (totaux, en-têtes) — les
    // transactions datées sont conservées même si on n'a pas pu lire le montant.
    }).filter((t: any) => {
      if (t.montant_debit || t.montant_credit) return true;
      const hasDate = (t.date_operation || "").trim().length > 0;
      if (hasDate) console.warn("[OCR-RELEVE] Tx datée sans montant conservée:", t.date_operation, t.libelle);
      return hasDate;
    });

    // Vérification et calcul solde_final si absent
    const totalCrOcr = txs.reduce((s: number, t: any) => s + (t.montant_credit || 0), 0);
    const totalDbOcr = txs.reduce((s: number, t: any) => s + (t.montant_debit || 0), 0);
    const soldeFinalCalculeOcr = Math.round((info.solde_initial + totalCrOcr - totalDbOcr) * 100) / 100;
    const ecartOcr = info.solde_final !== 0 ? Math.abs(soldeFinalCalculeOcr - info.solde_final) : 0;

    if (info.solde_final === 0 && txs.length > 0) {
      info.solde_final = soldeFinalCalculeOcr;
    }

    console.log(
      `[OCR-RELEVE] ${txs.length} tx | banque: ${info.banque}`,
      `| delta-method: ${deltaMethodCount} | fallback: ${fallbackCount}`,
      `| SI:${info.solde_initial} CR:${totalCrOcr.toFixed(2)} DB:${totalDbOcr.toFixed(2)}`,
      `| SF_extrait:${info.solde_final} SF_calculé:${soldeFinalCalculeOcr}`,
      `| écart: ${ecartOcr.toFixed(2)} MAD${ecartOcr > 5 ? " ⚠ ÉCART" : " ✓ OK"}`
    );

    // ── Logging usage IA (best-effort) : OCR du relevé ────────────────────────
    // Une ligne PAR scan de relevé. skip_llm = le LLM de relecture a été ÉVITÉ
    // (regex/delta de solde ont suffi). Loggé même si le dossier n'enregistre pas
    // le document — c'est l'appel IA qui compte, pas la persistance.
    if (ocrAiCalled) {
      await logUsage(getSupabase(), {
        dossier_id: data.dossier_id ?? null,
        sens: "banque",
        method: ocrUsedLlm ? "llm" : "regex",
        skip_llm: !ocrUsedLlm,
        cout_estime: estimerCoutIA("releve_ocr"),
        module: "releve",
        phase: "ocr",
        libelle: `OCR relevé ${info.banque || ""} — ${txs.length} tx`.trim(),
      });
    }

    // Mémorise l'extraction → prochain scan identique = cache-hit (OCR LLM évité).
    if (data.dossier_id && txs.length > 0) {
      await storeOcrCache(getSupabase(), data.dossier_id, releveHash, { txs, info });
    }

    return { txs, info };
  });

// ─── extraireTransactionsPage ───────────────────────────────────────────────────
// Fallback LLM page par page : reçoit le TEXTE d'une page de relevé reconstruit
// ligne par ligne (tri géométrique X/Y côté client) et ré-extrait les transactions
// via Groq (llama-3.3-70b) en JSON Mode. Utilisé quand le parser regex échoue sur
// une page (scan CamScanner corrompu). Retourne un tableau d'objets
// { date_operation, date_valeur, reference, libelle, montant_debit, montant_credit }
// avec montants en number | null.
export const extraireTransactionsPage = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ pageText: z.string() }).parse(input)
  )
  .handler(async ({ data }) => {
    const systeme =
      "Tu es un expert comptable marocain de haute précision. Analyse ce texte de relevé bancaire reconstruit ligne par ligne. " +
      "Extrais TOUTES les transactions sous forme d'un tableau d'objets JSON. " +
      "Utilise les motifs standards marocains (dates JJ/MM/AAAA ou JJ MM, montants avec virgules ou points, mots-clés comme REMISE, VERSEMENT, PAIEMENT CB, VIR EMIS). " +
      "Ne rate aucune transaction, attention aux montants de crédit et débit.";

    const prompt = `${systeme}

Réponds UNIQUEMENT avec un objet JSON valide (aucun texte avant ou après), au format exact :
{
  "transactions": [
    { "date_operation": "JJ/MM/AAAA", "date_valeur": "JJ/MM/AAAA", "reference": "", "libelle": "", "montant_debit": null, "montant_credit": null }
  ]
}

RÈGLES STRICTES :
- "montant_debit" et "montant_credit" sont des NOMBRES (ex: 1250.50) ou null — jamais de texte, de signe ni d'espace.
- Une transaction = exactement UNE ligne datée : soit un débit, soit un crédit (l'autre champ vaut null). Ne regroupe jamais plusieurs montants dans un même objet.
- Conserve l'ordre visuel des lignes (haut → bas).
- Si la page ne contient aucune transaction, retourne {"transactions": []}.

TEXTE DU RELEVÉ (reconstruit ligne par ligne) :
${data.pageText}`;

    let raw: string;
    try {
      raw = await callAI(prompt, undefined, undefined, 4096);
    } catch (e: any) {
      console.warn("[EXTRAIRE-PAGE] échec Groq:", e?.message ?? e);
      return [] as any[];
    }

    let parsed: any;
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(m ? m[0] : raw);
    } catch {
      console.warn("[EXTRAIRE-PAGE] JSON non parsable:", raw.slice(0, 200));
      return [] as any[];
    }

    const arr: any[] = Array.isArray(parsed)
      ? parsed
      : (parsed.transactions ?? parsed.txs ?? []);

    const toNum = (v: any): number | null => {
      if (v === null || v === undefined || v === "") return null;
      const n = parseFloat(String(v).replace(/\s/g, "").replace(",", "."));
      return Number.isNaN(n) ? null : n;
    };

    const txs = arr
      .map((t: any) => ({
        date_operation: t.date_operation ?? "",
        date_valeur: t.date_valeur ?? t.date_operation ?? "",
        reference: t.reference ?? "",
        libelle: t.libelle ?? "Transaction",
        montant_debit: toNum(t.montant_debit),
        montant_credit: toNum(t.montant_credit),
      }))
      .filter((t: any) => t.montant_debit != null || t.montant_credit != null);

    console.log(`[EXTRAIRE-PAGE] ${txs.length} transactions extraites par Groq (llama-3.3-70b)`);
    return txs;
  });

// ─── normaliserVisionTxs (helper) ────────────────────────────────────────────
// Normalise le tableau brut renvoyé par le modèle vision : montants → nombres,
// champs texte par défaut. Garde les lignes ayant au moins un montant.
function normaliserVisionTxs(arr: any[]): any[] {
  const toNum = (v: any): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = parseFloat(String(v).replace(/\s/g, "").replace(",", "."));
    return Number.isNaN(n) ? null : n;
  };
  return (Array.isArray(arr) ? arr : [])
    .filter((t: any) => t && typeof t === "object")
    .map((t: any) => ({
      date_operation: t.date_operation ?? "",
      date_valeur: t.date_valeur ?? t.date_operation ?? "",
      reference: t.reference ?? "",
      libelle: t.libelle ?? "Transaction",
      montant_debit: toNum(t.montant_debit),
      montant_credit: toNum(t.montant_credit),
    }))
    .filter((t: any) => t.montant_debit != null || t.montant_credit != null);
}

// ─── extraireTransactionsVision ───────────────────────────────────────────────
// Extrait les transactions d'un relevé. Principal : Mistral OCR (mistral-ocr-latest)
// sur le PDF complet. Secours : Groq Vision, une image (= une page) par appel.
// `images` = les pages du PDF en base64 (le client envoie toutes les pages en un appel).
// Retourne {ligne, reference, date_operation, date_valeur, libelle, montant_debit, montant_credit}.
export const extraireTransactionsVision = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({
      images: z.array(z.object({
        base64: z.string(),
        mime_type: z.string().default("image/jpeg"),
      })),
      // PDF complet (base64) pour l'OCR Mistral en un seul appel — préférable aux
      // demi-pages car les en-têtes de colonnes et l'ordre des pages sont conservés.
      pdf_base64: z.string().optional(),
    }).parse(input)
  )
  .handler(async ({ data }) => {
    const { images } = data;
    const nbPages = images.length;

    // ── OPTION PRINCIPALE : Mistral OCR (mistral-ocr-latest) — rapide & direct ─
    // PDF complet en un appel si fourni, sinon OCR de chaque image. On parse le
    // Markdown → transactions. Secours sur Vision Groq seulement si Mistral
    // est absent, échoue, ou ne renvoie aucune transaction.
    if (process.env.MISTRAL_API_KEY) {
      try {
        // OCR → on accumule le Markdown COMPLET (toutes pages) pour permettre
        // l'extraction sur l'ensemble du relevé.
        let fullMarkdown = "";
        if (data.pdf_base64) {
          fullMarkdown = await callMistralOcr(data.pdf_base64, "application/pdf");
        } else {
          for (const img of images) {
            fullMarkdown += (await callMistralOcr(img.base64, img.mime_type)) + "\n\n";
          }
        }
        // Markdown OCR COMPLET (toutes pages) tel que renvoyé par Mistral, AVANT
        // le parsing local — pour vérifier ce que le modèle a réellement lu.
        console.log(`[MISTRAL OCR] ===== MARKDOWN BRUT COMPLET (${fullMarkdown.length} chars) =====\n${fullMarkdown}\n[MISTRAL OCR] ===== FIN MARKDOWN BRUT =====`);

        // Extraction LÉGÈRE : regex pour l'en-tête + 1 appel LLM si des montants
        // manquent (robuste aux changements de format de mistral-ocr). Rapide.
        const { info: mdInfo, txs: mdTxs } = await extractReleveLean(fullMarkdown);

        if (mdTxs.length > 0) {
          console.log(`[MISTRAL OCR] ✓ ${mdTxs.length} transactions (extraireTransactionsVision) | banque:${mdInfo.banque} SI:${mdInfo.solde_initial} SF:${mdInfo.solde_final}`);
          return {
            info: mdInfo,
            markdown: fullMarkdown, // DEBUG : Markdown OCR brut renvoyé au client
            txs: mdTxs.map((t, i) => ({
              ligne: i + 1,
              reference: t.reference,
              date_operation: t.date_operation,
              date_valeur: t.date_valeur,
              libelle: t.libelle,
              montant_debit: t.montant_debit,
              montant_credit: t.montant_credit,
            })),
          };
        }
        console.warn("[MISTRAL OCR] 0 transaction — secours Groq vision");
      } catch (e: any) {
        console.warn("[MISTRAL OCR] échec — secours Groq vision:", e?.message ?? e);
      }
    }

    // Modèle vision Groq. Alternative plus légère : "llama-3.2-11b-vision-preview".
    // Repli automatique sur llama-4-scout si le modèle preview est indisponible.
    const VISION_MODEL = "llama-3.2-90b-vision-preview";

    const prompt =
`Tu lis l'image d'un relevé bancaire marocain. Extrais TOUTES les transactions du tableau, ligne par ligne de haut en bas.

Colonnes possibles selon la banque : un CODE/numéro d'opération, une DATE D'OPÉRATION, une DATE DE VALEUR (parfois absente), un LIBELLÉ, un montant en colonnes DÉBIT et CRÉDIT, et parfois un SOLDE.
Respecte l'alignement des colonnes : ne colle jamais le code avec la date, ni une date avec le libellé, ni un montant avec une autre transaction. Si une cellule est vide, mets null (montant) ou "" (texte).
Montants au format marocain "1 500,00" → 1500.00. Ignore les lignes de totaux/soldes (SOLDE DEPART, SOLDE FINAL, ANCIEN SOLDE, SOLDE REPORTÉ, TOTAL).

Réponds UNIQUEMENT avec un tableau JSON valide (aucun texte avant ni après), un objet par transaction :
[
  {"reference":"","date_operation":"JJ/MM/AAAA","date_valeur":"JJ/MM/AAAA","libelle":"description","montant_debit":null,"montant_credit":1250.50}
]
Si la page ne contient aucune transaction, retourne [].`;

    // ── Vision : Groq (secours quand Mistral OCR n'a rien renvoyé) ────────────
    // Repli modèle preview → scout si le modèle vision principal est indisponible.
    const callGroqVision = async (base64: string, mimeType: string): Promise<string> => {
      try {
        return await callAI(prompt, base64, mimeType, 4096, VISION_MODEL);
      } catch (modelErr: any) {
        if (/decommission|not\s*found|does not exist|400|model/i.test(modelErr?.message ?? "")) {
          return await callAI(prompt, base64, mimeType, 4096);
        }
        throw modelErr;
      }
    };

    const allTxs: any[] = [];
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      let raw: string | null = null;

      try {
        raw = await callGroqVision(img.base64, img.mime_type);
      } catch (e: any) {
        console.warn(`[VISION PAGE ${i + 1}/${nbPages}] Groq échoué:`, (e?.message ?? "").slice(0, 100));
      }

      // Parsing de la réponse
      if (raw !== null) {
        const arrMatch = raw.match(/\[[\s\S]*\]/);
        if (arrMatch) {
          const pageTxs = normaliserVisionTxs(JSON.parse(arrMatch[0]));
          console.log(`[VISION PAGE ${i + 1}/${nbPages}] (Groq) -> ${pageTxs.length} transactions`);
          allTxs.push(...pageTxs);
        } else {
          console.warn(`[VISION PAGE ${i + 1}/${nbPages}] (Groq) aucun tableau JSON trouvé dans la réponse`);
        }
      }
    }

    // ── Déduplication du RECOUVREMENT entre moitiés de page ───────────────────
    // Chaque page est envoyée en 2 moitiés qui se recouvrent : les transactions de la
    // zone de recouvrement apparaissent 2 fois. On les fusionne par clé (date + libellé
    // + montants), en gardant la 1re occurrence et l'ordre.
    const seen = new Set<string>();
    const deduped: any[] = [];
    for (const t of allTxs) {
      const key = `${(t.date_operation || "").replace(/\s/g, "")}|${(t.libelle || "").toUpperCase().replace(/\s+/g, "").slice(0, 20)}|${t.montant_debit ?? "x"}|${t.montant_credit ?? "x"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(t);
    }
    console.log(`[VISION] ${allTxs.length} lignes brutes → ${deduped.length} après dédup recouvrement`);

    // La vision Groq n'extrait pas l'en-tête (banque/RIB/soldes) : info nul.
    // Le client conserve alors l'info qu'il a parsée lui-même (parserRelevePDF).
    return {
      info: null,
      markdown: null, // chemin vision Groq : pas de Markdown OCR
      txs: deduped.map((t, i) => ({ ...t, ligne: i + 1 })),
    };
  });

export const analyserReleveIA = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({
      // Optionnel : requis pour activer la MÉMOIRE BANQUE (scoped par dossier).
      dossier_id: z.string().uuid().optional(),
      transactions_brutes: z.array(z.any()),
      factures_client: z.array(z.any()),
      factures_fourn: z.array(z.any()),
      justificatifs: z.array(z.any()).optional().default([]),
      clients: z.array(z.any()),
      fournisseurs: z.array(z.any()),
      dossier_nom: z.string().default(""),
      dossier_ice: z.string().default(""),
      remarques: z.string().optional(),
    }).parse(input)
  )
  .handler(async ({ data }) => {
    const nbTx = data.transactions_brutes.length;

    // ── CACHE DOCUMENT : même relevé + même contexte (factures/justificatifs) déjà
    // analysé → réutiliser les analyses (skip TOUS les appels LLM de matching). La clé
    // inclut les transactions ET l'empreinte du contexte : si tu enregistres une
    // facture, le contexte change → cache manqué (ré-analyse), ce qui est correct.
    const analyseHash = "a:" + createHash("sha256").update(JSON.stringify({
      t: data.transactions_brutes.map((x: any) => [x.date_operation, x.libelle, x.montant_debit, x.montant_credit, x.reference]),
      fc: (data.factures_client ?? []).map((f: any) => [f.id, f.montant_ttc]),
      ff: (data.factures_fourn ?? []).map((f: any) => [f.id, f.montant_ttc]),
      ju: (data.justificatifs ?? []).map((j: any) => [j.id, j.montant]),
      r: data.remarques ?? "",
    })).digest("hex");
    if (data.dossier_id) {
      const cached = await lookupOcrCache(getSupabase(), data.dossier_id, analyseHash);
      if (cached?.analyses && Array.isArray(cached.analyses) && cached.analyses.length === nbTx) {
        console.log(`[RELEVE AI] Cache document (hash ${analyseHash.slice(0, 10)}…) → analyse LLM court-circuitée (${nbTx} tx)`);
        await logUsageBatch(getSupabase(), cached.analyses.map((_: any, idx: number) => ({
          dossier_id: data.dossier_id!, sens: "banque" as const, method: "memoire" as const, skip_llm: true,
          cout_estime: estimerCoutIA("banque"), module: "releve" as const, phase: "analyse" as const,
          libelle: data.transactions_brutes[idx]?.libelle ?? null,
        })));
        return { analyses: cached.analyses };
      }
    }

    // Pré-matching déterministe (avant Groq) — extrait le tiers du libellé,
    // compare nom + montant ±2 MAD sur factures ET justificatifs.
    // Groq utilise ces suggestions comme NIVEAU 0 (priorité absolue).
    const preMatches = preMatchTransactions(
      data.transactions_brutes,
      data.factures_fourn,
      data.factures_client,
      data.justificatifs,
    );

    // ── MÉMOIRE BANQUE (point 3) : rappel par transaction AVANT le LLM ─────────
    // Pour chaque transaction, on interroge tiers_memoire (sens='banque') par
    // pattern (libellé normalisé) exact ou similaire. Si occurrences >= 2 (tiers
    // déjà validé au moins 2 fois → confiance ≥ 0.66), on AUTO-APPLIQUE sa
    // classification apprise (compte/catégorie/type_tiers) + pré-lettrage
    // déterministe, et on COURT-CIRCUITE l'appel IA (skipLLM) pour cette ligne.
    const memHits = new Array<Awaited<ReturnType<typeof rappelerMemoire>>>(nbTx).fill(null);
    const skipIdx = new Set<number>();
    if (data.dossier_id) {
      const sb = getSupabase();
      await Promise.all(
        data.transactions_brutes.map(async (tx: any, idx: number) => {
          const libelle = tx.libelle ?? tx.nature_operation ?? "";
          if (!libelle) return;
          const hit = await rappelerMemoire(sb, {
            dossier_id: data.dossier_id!, sens: "banque", nom: libelle,
          });
          if (!hit) return;
          memHits[idx] = hit;
          // `occurrences` = validations ANTÉRIEURES du tiers. Cette transaction
          // est donc la (occurrences+1)-ième occurrence. On court-circuite le LLM
          // dès la 2e occurrence au total (⇔ au moins 1 validation antérieure).
          const occurrencesTotales = hit.occurrences + 1;
          if (occurrencesTotales >= 2) {
            skipIdx.add(idx);
            const pm = preMatches[idx];
            console.log(
              `[RELEVE AI] MEMOIRE BANQUE HIT tx#${idx} « ${String(libelle).slice(0, 40)} » ` +
              `→ ${hit.match_kind} (sim ${hit.similarity.toFixed(2)}, ${hit.occurrences} usages, ` +
              `conf ${hit.confiance.toFixed(2)}) | ${hit.categorie_pcm ?? "?"}/${hit.compte_pcm ?? "?"}` +
              `/${hit.type_tiers ?? "?"} | LLM SKIPPED` +
              (pm?.facture_id || pm?.justificatif_id
                ? ` | MATCH LETTRAGE ${pm.facture_num ?? pm.facture_id ?? pm.justificatif_id} (conf ${pm.confiance})`
                : ""),
            );
          }
        }),
      );
      console.log(
        `[RELEVE AI] Mémoire banque : ${memHits.filter(Boolean).length}/${nbTx} rappels, ` +
        `${skipIdx.size} LLM court-circuité(s)`,
      );
    }

    const txIndexed = data.transactions_brutes
      .map((tx: any, idx: number) => ({ tx, idx }))
      .filter(({ idx }) => !skipIdx.has(idx))     // les tx mémorisées ne partent PAS au LLM
      .map(({ tx, idx }) => ({
      _idx: idx,
      date: tx.date_operation,
      libelle: tx.libelle ?? tx.nature_operation ?? "",
      debit: tx.montant_debit ?? 0,
      credit: tx.montant_credit ?? 0,
      // Hint serveur : injecté si le pré-matching a trouvé un match sûr
      ...(preMatches[idx]
        ? {
            pre_match_facture_id: preMatches[idx]!.facture_id,
            pre_match_num: preMatches[idx]!.facture_num,
            pre_match_confiance: preMatches[idx]!.confiance,
          }
        : {}),
    }));

    // Limiter le contexte à 30 éléments max pour chaque liste (évite prompt > 8k tokens)
    const maxCtx = 30;
    const facturesClientCtx = data.factures_client.slice(0, maxCtx);
    const facturesFournCtx  = data.factures_fourn.slice(0, maxCtx);
    const justificatifsCtx  = data.justificatifs.slice(0, maxCtx);

    const buildPrompt = (batchTx: any[]) => { const n = batchTx.length; return `Tu es expert-comptable marocain certifié PCM/CGNC. Analyse chaque transaction bancaire selon l'algorithme ci-dessous. Retourne UNIQUEMENT un JSON valide.

CONTEXTE:
Société gérée: "${data.dossier_nom}" (ICE: ${data.dossier_ice || "?"})
${data.remarques ? `INSTRUCTIONS PRIORITAIRES: ${data.remarques}` : ""}

FACTURES CLIENTS NON ENCAISSÉES:
${JSON.stringify(
  facturesClientCtx.map((f: any) => ({
    id: f.id,
    num: f.numero,
    client: f.clients?.nom,
    ttc: Number(f.montant_ttc),
    montant_paye: Number(f.montant_paye || 0),
    montant_restant: Number(f.montant_restant || f.montant_ttc),
    mode_reglement: f.mode_reglement,
    echeance: f.date_echeance,
    type: f.type,
  }))
)}

FACTURES FOURNISSEURS NON PAYÉES:
${JSON.stringify(
  facturesFournCtx.map((f: any) => ({
    id: f.id,
    num: f.numero,
    fournisseur: f.fournisseur_nom,
    ttc: Number(f.montant_ttc),
    montant_paye: Number(f.montant_paye || 0),
    montant_restant: Number(f.montant_restant || f.montant_ttc),
    mode_reglement: f.mode_reglement,
    echeance: f.date_echeance,
  }))
)}

JUSTIFICATIFS DISPONIBLES (reçus, bons commande, bons livraison, notes frais):
${JSON.stringify(justificatifsCtx.map((j: any) => ({
  id: j.id, type: j.type_document, tiers: j.nom_tiers,
  ttc: Number(j.montant_ttc), date: j.date_document,
  eligible_edi: j.eligible_edi
})))}

CLIENTS CONNUS: ${JSON.stringify(data.clients.map((c: any) => c.nom))}
FOURNISSEURS CONNUS: ${JSON.stringify(data.fournisseurs.map((f: any) => f.nom))}

TRANSACTIONS (${n} au total — traite-les TOUTES, ne saute aucune):
${JSON.stringify(batchTx)}

RÈGLE ABSOLUE SUR LE RETOUR :
- Retourne EXACTEMENT ${n} objets dans "analyses", un par transaction.
- Chaque objet DOIT contenir "_idx" avec la valeur exacte de la transaction correspondante.
- Ne saute aucune transaction. Si tu ne sais pas, mets categorie="autre", confiance=50, necessite_remarque=true.

══════════════════════════════════════════════════════
ALGORITHME DE MATCHING (ordre strict)
══════════════════════════════════════════════════════

[NIVEAU 0] PRÉ-MATCH SERVEUR (PRIORITÉ ABSOLUE) :
  Si une transaction a un champ "pre_match_facture_id" non nul, utilise OBLIGATOIREMENT
  ce facture_id et cette confiance. Ne pas override, ne pas ignorer.
  Exemple: si pre_match_facture_id="abc-123" et pre_match_confiance=90,
  retourne facture_id="abc-123" et confiance=90.
  Alias télécom déjà résolus : "MAROC TELECOM" = "IAM", "MEDITEL" = "ORANGE", etc.
  Les dates DD MM YY dans les libellés (ex: "26 03 26") sont des dates, pas des tiers.

[NIVEAU 1] INSTRUCTIONS COMPTABLE → confiance 100%

[NIVEAU 2] RAPPROCHEMENT FACTURE:

  Extraire depuis le libellé:
  - Moyen de paiement: ignorer préfixes "VIREMENT RECU DE", "VIR AG EMIS VERS", "PAIEMENT CB DD MM YY", "PAIEMENT CHEQUE N°"
  - Supprimer les séquences de type "DD MM YY" ou "DD MM YYYY" (dates)
  - Nom du tiers: ce qui reste après ces suppressions
  - Référence facture si présente

  Critères et scores:

  CRITÈRE A — NOM TIERS (prioritaire):
  Tolérer abréviations/initiales → +35 points si identifié, 0 sinon.
  Note: IAM = MAROC TELECOM = ITISSALAT ; ORANGE = MEDITEL ; INWI = WANA

  CRITÈRE B — MONTANT (⛔ OBLIGATOIRE, CONDITION ÉLIMINATOIRE) :
  montant_ttc ±2 MAD → +30 pts | montant_restant ±2 MAD → +30 pts
  ⛔ Si le montant de la transaction ne correspond NI au montant_ttc NI au montant_restant
  à ±2 MAD près → AUCUN LIEN POSSIBLE : facture_id = null, quel que soit le nom. Le nom
  seul (sans montant qui colle) ne justifie JAMAIS un lien. Le montant identique est la
  condition de base de tout rapprochement.

  CRITÈRE C — MODE RÈGLEMENT:
  Cohérent → +20 pts | Incohérent → -15 pts | Absent → 0 pt

  CRITÈRE D — DATE:
  tx ≤ echeance+15j → +15 pts | tx > echeance+30j → -15 pts | tx < date_facture → -30 pts

  Score ≥ 80 → match, retourner facture_id
  Score 60-79 → match avec alerte
  Score < 60 → pas de match facture

  UNICITÉ ABSOLUE: Chaque facture_id une seule fois dans tout le JSON.

[NIVEAU 2b] RAPPROCHEMENT JUSTIFICATIF (si pas de facture fournisseur correspondante):
  On lie un JUSTIFICATIF à un débit UNIQUEMENT si LES DEUX conditions sont réunies :
    (1) montant transaction = montant_ttc du justificatif à ±2 MAD (OBLIGATOIRE), ET
    (2) nom du tiers cohérent (le nom du justificatif apparaît, même abrégé, dans le libellé).
  ⛔ INTERDIT de lier sur la seule SIMILARITÉ DE CATÉGORIE : un reçu de restaurant NE se lie
  PAS à un paiement de restaurant si le MONTANT diffère ou si le NOM du restaurant diffère.
  « tous les deux = restaurant » n'est PAS un critère de lien. Sans montant identique ET nom
  cohérent → justificatif_id = null, necessite_remarque = true. Mieux vaut AUCUN lien qu'un
  FAUX lien. Ne jamais retourner facture_id et justificatif_id en même temps.

[NIVEAU 3] CATÉGORISATION PAR NATURE (si pas de match facture):

  RÈGLE FONDAMENTALE: "PAIEMENT CB", "PAIEMENT CHEQUE", "VIREMENT" = moyen, PAS catégorie. Analyser ce qui suit.

  3a. B2B (SARL, SA, STE, SOCIETE, ENT, ETS, GROUP, etc.) → paiement_fournisseur (débit) ou encaissement_client (crédit), 75%
  3b. Services:
    - CNSS, AMO → cnss_amo/4441/0% (solde de la dette sociale, pas le compte de charge 6174)
    - TVA, DGI, IR, IS → tva_dgi/4456/0%
    - EAU, ONEE, AMENAU → eau_electricite/6125/7%
    - IAM, ORANGE, INWI, MAROC TELECOM, MEDITEL → telecom/6145/20% (PRIORITÉ ABSOLUE)
    - Assurance → assurance/6161/0%
    - FACTURE + nom de service → service, pas restaurant
  3c. Bancaire: COMMISSION, FRAIS, AGIOS, ARRETE, TENUE → frais_bancaires/6347/10%
  3d. Personnel: SALAIRE, PAIE, REMUNERATION → salaires/6171/0%
  3e. Restauration (payé CB sur place, nom court, pas de FACTURE dans libellé) → frais_representation/6147/0%
  3f. Autres:
    - GASOIL, STATION → gasoil/61241/0%
    - RETRAIT ESPECES, RETRAIT GAB → retrait_especes/5143/0% (PRIORITÉ ABSOLUE)
    - VIR AG EMIS, VERSEMENT, VIREMENT INTERNE (mouvement entre comptes propres) → virement_interne/5115/0%
    - DOUANE, IMPORT → frais_douane/6146/0%
    - TRANSPORT, DEPLACEMENT → transport/6142/14%
    - LOYER, LOCATION → loyers/6131/0%
    - ENTRETIEN, REPARATION → entretien/6141/20%

[NIVEAU 4] PAR DÉFAUT:
  Crédit → encaissement_client/3421, 55%
  Débit → paiement_fournisseur/4411, 55%
  Ambigu total → necessite_remarque=true

══════════════════════════════════════════════════════

FORMAT JSON DE RETOUR (${n} objets OBLIGATOIRES):
{
  "analyses": [
    {
      "_idx": 0,
      "categorie": "encaissement_client",
      "code_pcm": "3421",
      "tiers_nom": null,
      "facture_num": null,
      "facture_id": null,
      "justificatif_id": null,
      "montant_ht": 0,
      "montant_tva": 0,
      "taux_tva": 0,
      "confiance": 60,
      "etape_rapprochement": "direction",
      "alerte": null,
      "necessite_remarque": false,
      "message_pour_comptable": null
    }
  ]
}

Catégories valides: encaissement_client|paiement_fournisseur|salaires|cnss_amo|tva_dgi|loyers|eau_electricite|telecom|gasoil|assurance|entretien|frais_bancaires|taxe_professionnelle|retrait_especes|virement_interne|interets_crediteurs|frais_representation|frais_douane|transport|autre`; };

    // ── BATCHING pour rester sous la limite TPM (12000 tokens/min, tier on_demand) ──
    // Groq compte prompt_tokens + max_tokens dans la limite TPM. Un relevé dense
    // (prompt fixe ~6k tokens + 40 transactions + max_tokens 8192) dépasse 12000 et
    // déclenche un 413. On découpe les transactions en lots dont chacun
    // (prompt + sortie réservée) reste sous TPM_BUDGET tokens.
    const estimateTokens = (s: string) => Math.ceil(s.length / 4);
    const headerTokens = estimateTokens(buildPrompt([])) + 50; // prompt fixe (algo + contexte), hors transactions
    // Mistral a des limites TPM bien plus hautes que Groq → gros lots possibles
    // = MOINS de lots = moins d'appels enchaînés = plus rapide. Côté Groq de
    // secours, gpt-oss-120b plafonne à 8000 TPM (tier gratuit) — bien moins que
    // les 12000 de llama-3.3-70b : le budget des lots baisse en conséquence.
    const useMistralChat = !!process.env.MISTRAL_API_KEY;
    const TPM_BUDGET = useMistralChat ? 60000 : 7500;
    const OUT_PER_TX = 200;    // tokens de sortie réservés par transaction
    // LATENCE : le temps de génération est ~proportionnel aux tokens de SORTIE. Un gros
    // lot génère son JSON en SÉRIE ; plusieurs PETITS lots le génèrent EN PARALLÈLE.
    // → on plafonne à ~12 tx/lot (Mistral) et on monte la concurrence : latence divisée.
    const MAX_TX_PER_BATCH = useMistralChat ? 12 : 40;

    const batches: any[][] = [];
    let cur: any[] = [];
    const fits = (arr: any[]) => {
      if (arr.length > MAX_TX_PER_BATCH) return false;
      const inTok = headerTokens + estimateTokens(JSON.stringify(arr));
      // Réserve fixe : sur Groq, gpt-oss-120b brûle ~1000 tokens de raisonnement
      // avant d'écrire le JSON — sans cette marge la réponse est tronquée.
      const outTok = arr.length * OUT_PER_TX + (useMistralChat ? 400 : 1200);
      // Plafonné aussi par la limite de SORTIE du modèle (~8192 tokens/réponse).
      return outTok <= 8000 && inTok + outTok <= TPM_BUDGET;
    };
    for (const tx of txIndexed) {
      if (cur.length && !fits([...cur, tx])) { batches.push(cur); cur = []; }
      cur.push(tx);
    }
    if (cur.length) batches.push(cur);
    console.log(`[RELEVE AI] ${nbTx} transactions → ${batches.length} lot(s) (budget ${TPM_BUDGET} TPM, header ~${headerTokens} tk)`);

    // Catégorisation + matching : Mistral (mistral-large-latest) en priorité,
    // repli automatique sur Groq (callAI) si MISTRAL_API_KEY absente ou en échec.
    const callCategorize = async (p: string, maxOut: number): Promise<string> => {
      if (useMistralChat) {
        try {
          // mistral-LARGE : le RAPPROCHEMENT facture/justificatif exige du raisonnement
          // (comparer noms + montants, scoring, unicité). mistral-small bâclait → liens
          // ratés OU faux (lie sur la catégorie sans vérifier montant/nom). La vitesse
          // vient des petits lots PARALLÈLES, pas d'un modèle plus faible.
          return await callMistralChat(p, maxOut, "mistral-large-latest");
        } catch (e: any) {
          console.warn("[RELEVE AI] Mistral chat échoué — fallback Groq:", e?.message ?? e);
        }
      }
      return callAI(p, undefined, undefined, maxOut);
    };

    // FIX 2 : Reconstruction du tableau par _idx réel — fusion de tous les lots.
    // callAI (Groq) gère proxy SSL et undici fallback. Un lot en échec laisse
    // ses transactions prendre l'analyse par défaut plus bas.
    // Traite un lot (appel + parse) → renvoie ses analyses ([] si échec/JSON KO).
    const runBatch = async (batch: any[], b: number): Promise<any[]> => {
      const maxOut = Math.min(8000, batch.length * OUT_PER_TX + 400);
      let content: string;
      try {
        content = await callCategorize(buildPrompt(batch), maxOut);
      } catch (e: any) {
        console.warn(`[RELEVE AI] lot ${b + 1}/${batches.length} (${batch.length} tx) — échec appel:`, e?.message ?? e);
        return [];
      }
      try {
        return (JSON.parse(content) as { analyses: any[] }).analyses ?? [];
      } catch (parseErr) {
        console.warn(`[RELEVE AI] lot ${b + 1}/${batches.length} — JSON invalide:`, String(parseErr).slice(0, 120));
        return [];
      }
    };

    // Lots exécutés EN PARALLÈLE (concurrence bornée) — les API Mistral/Groq
    // acceptent des requêtes concurrentes : la latence passe de N×appel à ~1×appel
    // par vague de CONCURRENCY. C'était le principal goulot (lots enchaînés).
    const analyseByIdx = new Map<number, any>();
    // Concurrence élevée sur Mistral (limites généreuses) → tous les petits lots
    // partent quasi ensemble. Groq (TPM serré) reste prudent.
    const CONCURRENCY = useMistralChat ? 8 : 2;
    for (let start = 0; start < batches.length; start += CONCURRENCY) {
      const wave = batches.slice(start, start + CONCURRENCY);
      const results = await Promise.all(wave.map((batch, k) => runBatch(batch, start + k)));
      for (const analyses of results) {
        for (const a of analyses) {
          // Groq/Mistral retournent _idx ; fallback sur i pour compat ancienne version.
          const idx = a._idx ?? a.i;
          if (typeof idx === "number" && idx >= 0 && idx < nbTx) analyseByIdx.set(idx, a);
        }
      }
    }

    // FIX 3 : Analyse par défaut pour les transactions manquantes
    const analyseDefaut = (idx: number): any => {
      const tx = data.transactions_brutes[idx];
      const montant =
        (tx?.montant_debit ?? 0) || (tx?.montant_credit ?? 0);
      const isCredit = (tx?.montant_credit ?? 0) > 0;
      return {
        _idx: idx,
        categorie: isCredit ? "encaissement_client" : "paiement_fournisseur",
        code_pcm: isCredit ? "3421" : "4411",
        tiers_nom: null,
        facture_num: null,
        facture_id: null,
        montant_ht: montant,
        montant_tva: 0,
        taux_tva: 0,
        confiance: 40,
        etape_rapprochement: "direction",
        alerte: "Non analysé par l'IA — vérification manuelle requise",
        necessite_remarque: true,
        message_pour_comptable: "Transaction non couverte par l'analyse IA",
      };
    };

    // Analyse dérivée de la MÉMOIRE BANQUE (pas d'appel IA pour cette ligne).
    // On s'appuie sur la classif apprise + le pré-lettrage déterministe (montant
    // + nom tiers) déjà calculé dans preMatches.
    const analyseMemoire = (idx: number): any => {
      const hit = memHits[idx]!;
      const tx = data.transactions_brutes[idx];
      const montant = (tx?.montant_debit ?? 0) || (tx?.montant_credit ?? 0);
      const isCredit = (tx?.montant_credit ?? 0) > 0;
      const taux = hit.taux_tva != null ? Number(hit.taux_tva) : 0;
      const ht = taux > 0 && montant > 0 ? Math.round((montant / (1 + taux / 100)) * 100) / 100 : montant;
      const tva = taux > 0 && montant > 0 ? Math.round((montant - ht) * 100) / 100 : 0;
      const pm = preMatches[idx];
      const categorie = hit.categorie_pcm
        ?? (isCredit ? "encaissement_client" : "paiement_fournisseur");
      const code_pcm = hit.compte_pcm ?? (isCredit ? "3421" : "4411");
      return {
        _idx: idx,
        categorie,
        code_pcm,
        type_tiers: hit.type_tiers ?? null,
        tiers_nom: null,
        facture_num: pm?.facture_num ?? null,
        facture_id: pm?.facture_id ?? null,
        justificatif_id: pm?.justificatif_id ?? null,
        montant_ht: ht,
        montant_tva: tva,
        taux_tva: taux,
        confiance: Math.max(90, Math.round(hit.confiance * 100)),
        etape_rapprochement: pm?.facture_id || pm?.justificatif_id ? "memoire+lettrage" : "memoire_banque",
        source: "memoire",
        alerte: null,
        necessite_remarque: false,
        message_pour_comptable: `Reconnu par la mémoire banque (${hit.occurrences} usages, confiance ${hit.confiance.toFixed(2)}).`,
      };
    };

    const analyseFinale: any[] = Array.from({ length: nbTx }, (_, idx) =>
      skipIdx.has(idx) ? analyseMemoire(idx) : (analyseByIdx.get(idx) ?? analyseDefaut(idx))
    );

    // Passe 0 : forcer les pré-matches serveur si Groq les a ignorés
    // Couvre factures ET justificatifs (avec résolution de chaîne BC→BL→…)
    for (let idx = 0; idx < nbTx; idx++) {
      const pm = preMatches[idx];
      if (!pm) continue;
      const a = analyseFinale[idx];
      const groqHasMatch = !!(a.facture_id || a.justificatif_id);
      // Forcer le pré-match si Groq n'a rien trouvé ou a une confiance plus faible
      if (!groqHasMatch || (pm.confiance > (a.confiance ?? 0))) {
        analyseFinale[idx] = {
          ...a,
          facture_id:      pm.facture_id,
          facture_num:     pm.facture_num,
          justificatif_id: pm.justificatif_id,
          confiance:       pm.confiance,
          etape_rapprochement: pm.justificatif_id ? "justificatif_tiers" : "nom_tiers",
          alerte: null,
          necessite_remarque: false,
        };
      }
    }

    // Passe 0.5 : VALIDATION SERVEUR des liens — GARDE-FOU anti-faux-lien.
    // Un lien facture/justificatif proposé par le LLM n'est VALIDE que si le montant
    // du document = montant de la transaction (±2 MAD). Le montant identique est la
    // condition sine qua non d'un rapprochement fiable. Sinon on ANNULE le lien (le
    // LLM a lié sur le nom/la catégorie sans vérifier le montant → faux lien).
    // Les liens du PRÉ-MATCH serveur sont déjà validés (nom+montant) → on les garde.
    const facMontantById = new Map<string, number>();
    for (const f of (data.factures_fourn ?? [])) facMontantById.set(f.id, Number(f.montant_restant ?? f.montant_ttc ?? 0));
    for (const f of (data.factures_client ?? [])) facMontantById.set(f.id, Number(f.montant_restant ?? f.montant_ttc ?? 0));
    const jusMontantById = new Map<string, number>();
    for (const j of (data.justificatifs ?? [])) jusMontantById.set(j.id, Number(j.montant_ttc ?? 0));
    for (let idx = 0; idx < nbTx; idx++) {
      const a = analyseFinale[idx];
      if (!a.facture_id && !a.justificatif_id) continue;
      const pm = preMatches[idx];
      const estPreMatch = !!pm && ((pm.facture_id && pm.facture_id === a.facture_id) || (pm.justificatif_id && pm.justificatif_id === a.justificatif_id));
      if (estPreMatch) continue; // pré-match déterministe = fiable
      const tx = data.transactions_brutes[idx];
      const montant = (tx?.montant_debit ?? 0) || (tx?.montant_credit ?? 0);
      const linkMontant = a.facture_id ? facMontantById.get(a.facture_id) : jusMontantById.get(a.justificatif_id);
      if (linkMontant === undefined || Math.abs(montant - linkMontant) > 2) {
        console.warn(`[RELEVE AI] LIEN REJETÉ tx#${idx} : montant tx ${montant} ≠ document ${linkMontant ?? "introuvable"} (>2 MAD) — faux lien LLM annulé`);
        a.facture_id = null; a.facture_num = null; a.justificatif_id = null;
        a.necessite_remarque = true;
        a.alerte = `Lien annulé automatiquement : le montant de la transaction (${montant}) ne correspond pas au document (${linkMontant ?? "?"}).`;
      }
    }

    // Post-traitement : overrides mots-clés + déduplication best-match-wins
    const withOverrides = applyKeywordOverrides(analyseFinale, data.transactions_brutes);
    const withDedup    = deduplicateAnalyses(withOverrides);
    for (let idx = 0; idx < nbTx; idx++) analyseFinale[idx] = withDedup[idx];

    // Autorité finale de la MÉMOIRE BANQUE : la classif apprise (compte/catégorie/
    // type_tiers/TVA) prime sur les overrides mots-clés pour les tx court-circuitées.
    // Le pré-lettrage (facture/justificatif) reste celui retenu par la Passe 0.
    for (const idx of skipIdx) {
      const hit = memHits[idx]!;
      const a = analyseFinale[idx];
      if (hit.categorie_pcm) a.categorie = hit.categorie_pcm;
      if (hit.compte_pcm) a.code_pcm = hit.compte_pcm;
      if (hit.type_tiers) a.type_tiers = hit.type_tiers;
      if (hit.taux_tva != null) a.taux_tva = Number(hit.taux_tva);
      a.source = "memoire";
      a.confiance = Math.max(a.confiance ?? 0, 90);
      a.necessite_remarque = false;
      if (a.facture_id || a.justificatif_id) {
        console.log(
          `[RELEVE AI] MATCH LETTRAGE tx#${idx} (mémoire) → ` +
          `${a.facture_num ?? a.facture_id ?? a.justificatif_id} (conf ${a.confiance})`,
        );
      }
    }

    const nbMatchees = analyseFinale.filter(
      (a) => a.facture_id !== null
    ).length;
    console.log(
      `[RELEVE AI] OK — ${analyseFinale.length}/${nbTx} analyses, ${nbMatchees} matchées, ` +
      `${skipIdx.size} via mémoire (LLM SKIPPED)`
    );

    // ── Logging usage (best-effort, 1 seul insert groupé → rapide) ────────────
    if (data.dossier_id) {
      const coutTx = estimerCoutIA("banque");
      await logUsageBatch(
        getSupabase(),
        analyseFinale.map((_a, idx) => ({
          dossier_id: data.dossier_id!,
          sens: "banque" as const,
          method: skipIdx.has(idx) ? ("memoire" as const) : ("llm" as const),
          skip_llm: skipIdx.has(idx),
          cout_estime: coutTx,
          module: "releve" as const,
          phase: "analyse" as const,
          libelle: data.transactions_brutes[idx]?.libelle ?? data.transactions_brutes[idx]?.nature_operation ?? null,
        })),
      );
    }

    // Mémorise l'analyse → prochain scan identique (même contexte) = cache-hit total.
    if (data.dossier_id) {
      await storeOcrCache(getSupabase(), data.dossier_id, analyseHash, { analyses: analyseFinale });
    }

    return { analyses: analyseFinale };
  });

// ─── analyserTransactions ─────────────────────────────────────────────────────
// COMPATIBILITÉ : cet export est gardé pour ne pas casser les imports existants.
// Il délègue directement à analyserReleveIA avec la même structure d'entrée.
// Si vous n'importez plus analyserTransactions nulle part, vous pouvez supprimer cet alias.
export const analyserTransactions = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({
      dossier_id: z.string().uuid(),
      dossier_nom: z.string().default(""),
      dossier_ice: z.string().default(""),
      transactions_brutes: z.array(z.any()),
      factures_client: z.array(z.any()),
      factures_fourn: z.array(z.any()),
      fournisseurs: z.array(z.any()),
      clients: z.array(z.any()),
      remarques: z.string().optional(),
    }).parse(input)
  )
  .handler(async ({ data }) => {
    // Délègue à analyserReleveIA (même logique, prompt unique, sans doublon)
    return analyserReleveIA({
      data: {
        dossier_id: data.dossier_id,
        transactions_brutes: data.transactions_brutes,
        factures_client: data.factures_client,
        factures_fourn: data.factures_fourn,
        clients: data.clients,
        fournisseurs: data.fournisseurs,
        dossier_nom: data.dossier_nom,
        dossier_ice: data.dossier_ice,
        remarques: data.remarques,
      },
    });
  });

// ─── matcherDocumentAvecTransactions ──────────────────────────────────────────
// Algorithme déterministe (sans IA) : cherche une transaction bancaire ouvertedu
// dossier qui correspond au document (facture/justificatif) en cours de création.
// Barème : montant bloquant (50 pts) + tiers (30 pts) + date ±30j (10 pts) + mode (10 pts)
// Seuil : ≥ 80 pts → liaison automatique + statut='ferme' sur la transaction.
export const matcherDocumentAvecTransactions = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({
      dossier_id:      z.string(),
      document_id:     z.string(),
      document_type:   z.enum(["facture_client", "facture_fournisseur", "justificatif"]),
      montant_ttc:     z.number(),
      nom_tiers:       z.string().default(""),
      date_document:   z.string().default(""),
      mode_reglement:  z.string().default(""),
      numero_piece:    z.string().default(""),
    }).parse(input)
  )
  .handler(async ({ data }) => {
    const sb = getSupabase();

    const { data: txs } = await sb
      .from("transactions_bancaires")
      .select("id, date_operation, libelle, type, montant")
      .eq("dossier_id", data.dossier_id)
      .eq("statut", "ouvert");

    if (!txs?.length) return { match: false, tx_id: null, score: 0, tx_date: null, tx_montant: null };

    // Normaliser nom tiers : supprimer suffixes juridiques marocains courants
    const normTiers = (s: string) =>
      s.toUpperCase()
        .replace(/\b(STE|SARL|SA\b|AU\b|ETS|ENT|EURL|SARLAU|SUARL|SC|GIE)\b/g, "")
        .replace(/[^\w\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const tiersMots = normTiers(data.nom_tiers)
      .split(/\s+/)
      .filter(w => w.length >= 3);

    // facture_client → transaction crédit ; tout le reste → débit
    const expectedType = data.document_type === "facture_client" ? "credit" : "debit";

    let bestScore = 0;
    let bestTx: any = null;

    for (const tx of txs) {
      if (tx.type !== expectedType) continue;

      const montantTx  = Number(tx.montant);
      const montantDoc = data.montant_ttc;

      const libUp      = (tx.libelle || "").toUpperCase();
      const libCompact = libUp.replace(/\s/g, "");
      // CHQ sans espace requis : "CHQ12345", "CHEQUE N°", "PAIEMENT CHQ", etc.
      // LCN traité comme un chèque : nom du tiers absent du libellé, délai variable
      const isChequeTx = libUp.includes("CHEQUE") || libUp.includes("CHQ") || libUp.includes("LCN");

      // N° de pièce du document (LCN, chèque, avis) retrouvé dans le libellé bancaire.
      // Comparaison sur les CHIFFRES uniquement, zéros de tête ignorés : "0630238" ≡ "630238".
      // Match si une référence du libellé se termine par le numéro du document ou
      // inversement (préfixes/suffixes ajoutés par la banque tolérés).
      const numeroNorm = (data.numero_piece || "").replace(/\D/g, "").replace(/^0+/, "");
      const libRefs    = (libUp.match(/\d{4,}/g) || []).map(r => r.replace(/^0+/, ""));
      const numeroMatch = numeroNorm.length >= 4 &&
        libRefs.some(r => r === numeroNorm || r.endsWith(numeroNorm) || numeroNorm.endsWith(r));

      // BLOQUANT — N° de pièce contradictoire : le libellé porte une référence
      // LCN/CHQ explicite qui ne correspond pas à celle du document → exclusion
      if (numeroNorm.length >= 4 && !numeroMatch) {
        const refLib = libUp.match(/(?:LCN|CHQ|CHEQUE)\s*(?:N[°ºO])?\s*[:.]?\s*\d{4,}/);
        if (refLib) { console.log(`[MATCH] tx "${libUp.slice(0,40)}" exclue : réf LCN/CHQ ≠ ${numeroNorm}`); continue; }
      }

      // BLOQUANT — Montant : strict ±1 DH ; tolérance élargie à +10 (commission/timbre
      // inclus dans le débit) UNIQUEMENT si le N° de pièce confirme la correspondance
      const tolHaute = numeroMatch ? 10 : 1;
      if (montantTx < montantDoc - 1 || montantTx > montantDoc + tolHaute) continue;

      let score = 50;
      // N° de pièce confirmé → identifiant fort (+40)
      // Ex : justificatif numero_piece "630238" ↔ libellé "COM REMISE LCN N° 630238"
      if (numeroMatch) score += 40;
      const mr = (data.mode_reglement || "").toLowerCase();
      // Incompatibilité explicite : document virement/carte mais transaction chèque
      const modeIncompat = isChequeTx && (mr === "virement" || mr === "carte");

      if (modeIncompat) continue;

      // Nom tiers dans libellé (+30) ou bonus chèque/LCN (+20)
      // Pour les chèques, le nom du fournisseur n'apparaît pas dans le libellé bancaire.
      // Si le document porte un N° de pièce NON confirmé par le libellé, pas de bonus :
      // deux LCN de même montant (timbres 5 DH...) ne doivent se départager que par le N°.
      if (tiersMots.length > 0 && tiersMots.some(w => libUp.includes(w))) {
        score += 30;
      } else if (isChequeTx && (numeroNorm.length < 4 || numeroMatch)) {
        score += 20;
      }

      // Date : ±30j standard (+10) ou ±60j pour chèque (+20 — délai d'encaissement variable)
      if (data.date_document) {
        try {
          const docDate = new Date(data.date_document);
          const p = tx.date_operation.split("/");
          const txDate = p.length === 3
            ? new Date(`${p[2]}-${p[1]}-${p[0]}`)
            : new Date(tx.date_operation);
          const diffDays = Math.abs(txDate.getTime() - docDate.getTime()) / 86400000;
          if (isChequeTx) {
            if (diffDays <= 60) score += 20;
          } else {
            if (diffDays <= 30) score += 10;
          }
        } catch { /* date malformée → pas de bonus */ }
      }

      // Mode règlement cohérent (+10) — uniquement pour les paiements non-chèque
      if (!isChequeTx && data.mode_reglement) {
        if (
          (mr === "cheque"   && libUp.includes("CHEQUE")) ||
          (mr === "carte"    && libUp.includes(" CB "))   ||
          (mr === "virement" && libUp.includes("VIR"))
        ) score += 10;
      }

      console.log(`[MATCH] tx ${tx.date_operation} "${(tx.libelle || "").slice(0, 40)}" ${montantTx} MAD → score ${score} (numéro:${numeroMatch ? "✓" : "✗"})`);
      if (score > bestScore) { bestScore = score; bestTx = tx; }
    }

    console.log(`[MATCH] doc ${data.document_type} ${data.montant_ttc} MAD pièce="${data.numero_piece}" | ${txs.length} tx ouvertes | meilleur score: ${bestScore}/80${bestTx ? ` → "${(bestTx.libelle || "").slice(0, 40)}"` : ""}`);

    if (bestScore >= 80 && bestTx) {
      // Écriture ATOMIQUE via la RPC lier_transaction : pose le lien UNIQUEMENT si la
      // transaction est encore orpheline (WHERE facture_id IS NULL → anti-concurrence)
      // et met à jour le document (montant payé / statut) sans double-comptage. Sans
      // ce lien, la transaction serait fermée « à vide » et tomberait en compte
      // d'attente 4711 à la clôture.
      const { data: linked, error: rpcErr } = await (sb as any).rpc("lier_transaction", {
        p_tx_id:   bestTx.id,
        p_doc_id:  data.document_id,
        p_doc_kind: data.document_type,
      });
      if (rpcErr) throw rpcErr;

      if (linked === true) {
        return {
          match:      true,
          tx_id:      bestTx.id as string,
          score:      bestScore,
          tx_date:    bestTx.date_operation as string,
          tx_montant: Number(bestTx.montant),
        };
      }
      // La transaction a été liée entre-temps par un autre événement (course) → pas de match.
      return { match: false, tx_id: null, score: bestScore, tx_date: null, tx_montant: null };
    }

    return { match: false, tx_id: null, score: bestScore, tx_date: null, tx_montant: null };
  });

// ─── lettrerJustificatif ──────────────────────────────────────────────────────
// Flux d'enregistrement ISOLÉ d'un justificatif : rapprochement PRÉCIS basé sur un
// montant EXACT + une date (paiement OU échéance, marge bancaire ±2 j). La recherche
// porte sur TOUS les comptes du dossier (filtre dossier_id seul), y compris les
// transactions clôturées, tant qu'elles ne sont pas déjà lettrées (facture_id ET
// justificatif_id NULL = statut_lettrage false). En cas de succès : pose le lien de
// façon atomique, passe le justificatif à 'rapproche' et GÉNÈRE l'écriture comptable
// (journal BQ) imputant le compte PCM → répercussion immédiate sur le Grand Livre.
// Ne touche PAS au moteur de lettrage global (matcherDocumentAvecTransactions / RPC).

const DAY_MS = 86400000;
const MARGE_BANCAIRE_J = 2; // délai technique d'imputation bancaire

// Parse une date 'YYYY-MM-DD' ou 'DD/MM/YYYY' → timestamp UTC (ms) ; null si invalide
function parseDateFlexible(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = String(s).trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]);
  const d = Date.parse(t);
  return isNaN(d) ? null : d;
}

const lettrerJustificatifInput = z.object({
  dossier_id:      z.string().uuid(),
  justificatif_id: z.string().uuid(),
  montant_ttc:     z.number().positive(),
  // Dates utilisées UNIQUEMENT pour départager plusieurs transactions de même montant.
  // Le compte PCM / l'écriture sont gérés par le trigger DB (sync_ecriture_contrepartie).
  date_paiement:   z.string().default(""), // quittances/reçus : souvent = date du document
  date_echeance:   z.string().default(""), // échéance éventuelle (fallback si pas de paiement)
});

export const lettrerJustificatif = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => lettrerJustificatifInput.parse(input))
  .handler(async ({ data }) => {
    const sb = getSupabase();

    // 1. Débits NON lettrés de TOUS les comptes ET de TOUS les relevés du dossier —
    //    statut indifférent : inclut les transactions 'ouvert', 'ferme', 'cloture'
    //    (relevés Actifs OU Clôturés). Seule exclusion : déjà lettrées, c.-à-d. liées
    //    à un document (facture_id OU justificatif_id non NULL).
    const { data: txs, error: txErr } = await (sb as any)
      .from("transactions_bancaires")
      .select("id, date_operation, libelle, montant, type, statut")
      .eq("dossier_id", data.dossier_id)
      .eq("type", "debit")
      .is("facture_id", null)
      .is("justificatif_id", null);
    if (txErr) throw txErr;
    if (!txs?.length) {
      return { match: false as const, reason: "no_tx", tx_id: null, tx_date: null, tx_montant: null };
    }

    // 2. Candidats au MONTANT EXACT (< 0,01 MAD d'écart).
    const exact = txs.filter((tx: any) => Math.abs(Number(tx.montant) - data.montant_ttc) < 0.01);
    if (!exact.length) {
      return { match: false as const, reason: "no_amount_match", tx_id: null, tx_date: null, tx_montant: null };
    }

    // 3. Sélection de la transaction cible.
    let cible: any;
    let via: string;
    if (exact.length === 1) {
      // CANDIDAT UNIQUE au montant exact dans tout le dossier → lien validé
      // automatiquement, MÊME si la date du justificatif s'écarte de celle de la
      // transaction (relevé clôturé, saisie tardive…). La date ne bloque pas.
      cible = exact[0];
      via = "montant_unique";
    } else {
      // Plusieurs transactions du même montant exact → on départage par la date
      // (paiement prioritaire, sinon échéance ; marge bancaire ±2 j).
      const refPaiement = parseDateFlexible(data.date_paiement);
      const refEcheance = parseDateFlexible(data.date_echeance);
      const refDate = refPaiement ?? refEcheance;
      const usingPaiement = refPaiement != null;
      const parDate = refDate == null ? [] : exact
        .map((tx: any) => {
          const txDate = parseDateFlexible(tx.date_operation);
          if (txDate == null) return null;
          const diffJ = (txDate - refDate) / DAY_MS;
          const dateOk = usingPaiement
            ? diffJ >= -MARGE_BANCAIRE_J && diffJ <= MARGE_BANCAIRE_J
            : Math.abs(diffJ) <= MARGE_BANCAIRE_J;
          return dateOk ? { tx, ecart: Math.abs(diffJ) } : null;
        })
        .filter(Boolean)
        .sort((a: any, b: any) => a.ecart - b.ecart);
      if (!parDate.length) {
        // Plusieurs montants identiques et aucune date concordante → ambiguïté non
        // levée : on s'abstient plutôt que de lier la mauvaise transaction.
        return { match: false as const, reason: "ambiguous_amount", tx_id: null, tx_date: null, tx_montant: null };
      }
      cible = (parDate[0] as any).tx;
      via = usingPaiement ? "paiement" : "echeance";
    }

    // 4. Lien ATOMIQUE via la RPC sanctionnée `lier_transaction` :
    //    • ne lie QUE si la transaction est encore orpheline (anti-concurrence),
    //      transactions CLÔTURÉES comprises (verrou 'cloture' levé) ;
    //    • conserve le statut 'cloture' ; passe le justificatif à 'rapproche' ;
    //    • déclenche le trigger `sync_ecriture_contrepartie` qui rebascule la ligne
    //      de contrepartie du compte d'attente 4711/4712 vers le compte PCM du
    //      justificatif (ex. 61312) → Grand Livre mis à jour SANS double comptage.
    //    On NE génère donc PAS d'écriture ici : elle existe déjà (Grand Livre continu).
    const { data: ok, error: rpcErr } = await (sb as any).rpc("lier_transaction", {
      p_tx_id:    cible.id,
      p_doc_id:   data.justificatif_id,
      p_doc_kind: "justificatif",
    });
    if (rpcErr) throw rpcErr;
    if (ok !== true) {
      // Liée entre-temps par un autre événement → pas de double-lettrage.
      return { match: false as const, reason: "race", tx_id: null, tx_date: null, tx_montant: null };
    }

    return {
      match: true as const,
      tx_id: cible.id as string,
      tx_date: cible.date_operation as string,
      tx_montant: Number(cible.montant),
      via,
    };
  });
