import { createServerFn } from "@tanstack/react-start";
import { PCM } from "@/lib/pcm-referentiel";
import { z } from "zod";
import { createHash } from "crypto";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { modele } from "./ai-models";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OcrResult {
  fournisseur_nom: string;
  ice_fournisseur: string | null;
  numero_facture: string | null;
  date_facture: string | null;
  date_echeance: string | null;
  montant_ht: number;
  montant_tva: number;
  montant_ttc: number;
  lignes: Array<{
    designation: string;
    quantite: number;
    prix_unitaire: number;
    taux_tva: number;
  }>;
  confidence: "high" | "medium" | "low";
  method: "regex" | "ai";
}

// ─── Regex parser (pdfplumber/tesseract equivalent in JS) ────────────────────
// In Cloudflare Workers we can't run Python, so we implement the regex
// extraction logic in TypeScript — same approach as pdfplumber text + regex.

function parseAmount(s: string | undefined): number | null {
  if (!s) return null;
  const n = parseFloat(s.replace(/\s/g, "").replace(",", "."));
  return isNaN(n) || n <= 0 ? null : n;
}

function parseTextWithRegex(text: string): Partial<OcrResult> {
  const norm = text.replace(/\r\n/g, "\n").replace(/\s+/g, " ");

  // ICE
  const ice = norm.match(/ICE\s*[:\-]?\s*(\d{15})/i)?.[1] ?? null;

  // Numéro facture
  const numero =
    norm.match(/(?:facture|invoice|n°|num[eé]ro)\s*[:\-]?\s*([A-Z0-9\/\-]+)/i)?.[1] ?? null;

  // Dates YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY
  const dates = [...norm.matchAll(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}[\/\-]\d{2}[\/\-]\d{2})/g)]
    .map((m) => {
      const d = m[1];
      if (/^\d{4}/.test(d)) return d.replace(/\//g, "-");
      const parts = d.split(/[\/\-]/);
      if (parts.length === 3) {
        const [dd, mm, yyyy] = parts;
        return `${yyyy.length === 2 ? "20" + yyyy : yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
      }
      return null;
    })
    .filter(Boolean) as string[];

  // Keyword-based amount extraction — matched by label before the number
  const ttcRaw = norm.match(
    /(?:total\s+ttc|net\s+[àa]\s+payer|montant\s+ttc|net\s+payable)\s*[:\-]?\s*([\d\s]+(?:[,\.]\d{1,2})?)/i,
  )?.[1];
  const htRaw = norm.match(
    /(?:total\s+ht|montant\s+ht|sous[- ]?total\s+ht|hors\s+taxe)\s*[:\-]?\s*([\d\s]+(?:[,\.]\d{1,2})?)/i,
  )?.[1];
  const tvaRaw = norm.match(
    /(?:total\s+tva|montant\s+tva|tva\s+\d+\s*%)\s*[:\-]?\s*([\d\s]+(?:[,\.]\d{1,2})?)/i,
  )?.[1];

  let montant_ttc = parseAmount(ttcRaw);
  let montant_ht = parseAmount(htRaw);
  let montant_tva = parseAmount(tvaRaw);

  // Fallback to generic largest-number heuristic when keyword matching failed
  if (!montant_ttc) {
    const amounts = [...norm.matchAll(/(\d[\d\s]*(?:[,\.]\d{1,2})?)\s*(?:MAD|DH|Dhs?)?/g)]
      .map((m) => parseFloat(m[1].replace(/\s/g, "").replace(",", ".")))
      .filter((n) => !isNaN(n) && n > 0)
      .sort((a, b) => b - a);
    montant_ttc = amounts[0] ?? 0;
    if (!montant_ht) montant_ht = amounts[1] ?? montant_ttc / 1.2;
  }

  // Derive any still-missing amounts
  if (montant_ttc && !montant_ht && !montant_tva) {
    montant_ht = Math.round((montant_ttc / 1.2) * 100) / 100;
  }
  if (montant_ttc && montant_ht && !montant_tva) {
    montant_tva = Math.round((montant_ttc - montant_ht) * 100) / 100;
  }
  if (montant_ttc && montant_tva && !montant_ht) {
    montant_ht = Math.round((montant_ttc - montant_tva) * 100) / 100;
  }

  const ttc = montant_ttc ?? 0;
  const ht = montant_ht ?? ttc / 1.2;
  const tva = montant_tva ?? Math.round((ttc - ht) * 100) / 100;

  // Fournisseur — first non-empty line before "ICE" or "Facture"
  const fournisseurMatch = norm.match(/^(.{3,60}?)(?:\n|ICE|Facture|SIRET)/im);
  const fournisseur_nom = fournisseurMatch?.[1]?.trim() ?? "Fournisseur inconnu";

  return {
    fournisseur_nom,
    ice_fournisseur: ice,
    numero_facture: numero,
    date_facture: dates[0] ?? null,
    date_echeance: dates[1] ?? null,
    montant_ht: ht,
    montant_tva: tva,
    montant_ttc: ttc,
    lignes: ttc > 0
      ? [{ designation: "Prestation", quantite: 1, prix_unitaire: ht, taux_tva: 20 }]
      : [],
  };
}

function scoreConfidence(result: Partial<OcrResult>): "high" | "medium" | "low" {
  let score = 0;
  if (result.montant_ttc && result.montant_ttc > 0) score += 3;
  if (result.montant_ht && result.montant_ht > 0) score += 2;
  if (result.date_facture) score += 2;
  if (result.numero_facture) score += 1;
  if (result.ice_fournisseur) score += 2;
  if (result.fournisseur_nom && result.fournisseur_nom !== "Fournisseur inconnu") score += 1;
  if (result.lignes && result.lignes.length > 0) score += 1;
  if (score >= 9) return "high";
  if (score >= 5) return "medium";
  return "low";
}

// ─── AI fallback (Groq, modèle texte léger — fast, text-only) ────────────────

async function callAIOcr(
  _imageBase64: string,
  _mimeType: string,
  text: string,
  apiKey: string,
): Promise<Partial<OcrResult>> {
  // Modèle texte léger (gpt-oss-20b ; llama-3.1-8b-instant est retiré depuis le
  // 16/08/2026). Texte seul : on envoie le texte extrait, jamais l'image.
  const prompt = `Tu es un expert OCR de factures marocaines.
Voici le texte extrait de la facture :
<texte>${text.slice(0, 3000)}</texte>

Extrais et retourne UNIQUEMENT ce JSON (sans markdown, sans explication) :
{
  "fournisseur_nom": "string",
  "ice_fournisseur": "string|null",
  "numero_facture": "string|null",
  "date_facture": "YYYY-MM-DD|null",
  "date_echeance": "YYYY-MM-DD|null",
  "montant_ht": number,
  "montant_tva": number,
  "montant_ttc": number,
  "lignes": [{"designation":"string","quantite":number,"prix_unitaire":number,"taux_tva":number}]
}`;

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modele("groqTexteLeger"),
      // gpt-oss est un modèle à raisonnement : ses tokens de réflexion passent
      // AVANT le JSON. Effort bas + budget large, sinon la réponse est tronquée.
      max_tokens: 3000,
      reasoning_effort: "low",
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const txt = await response.text();
    throw new Error(`Groq API ${response.status}: ${txt}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content ?? "{}";
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  return jsonMatch ? JSON.parse(jsonMatch[0]) : {};
}

// ─── Server function ──────────────────────────────────────────────────────────

const ocrInput = z.object({
  // Raw text extracted by client-side PDF.js or sent as-is
  extracted_text: z.string().default(""),
  // Optional image for AI fallback
  image_base64: z.string().optional(),
  mime_type: z.string().default("image/jpeg"),
  filename: z.string().default("document"),
  dossier_id: z.string().uuid(),
});

export const runOcr = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => ocrInput.parse(input))
  .handler(async ({ data }) => {
    const text = data.extracted_text;

    // Step 1: regex extraction
    const regexResult = parseTextWithRegex(text);
    const confidence = scoreConfidence(regexResult);

    // Essential fields that must be present to skip the AI call
    const hasEssentials =
      !!regexResult.ice_fournisseur &&
      !!regexResult.date_facture &&
      !!regexResult.montant_ttc &&
      regexResult.montant_ttc > 0;

    let finalResult: OcrResult;

    if (hasEssentials) {
      // All critical fields extracted — no need to call the AI
      finalResult = { ...regexResult, confidence: "high", method: "regex" } as OcrResult;
    } else if (confidence === "low" || confidence === "medium") {
      // Step 2: AI fallback only when essential fields are missing
      const apiKey = process.env.GROQ_API_KEY;
      if (!apiKey) {
        finalResult = { ...regexResult, confidence, method: "regex" } as OcrResult;
      } else {
        try {
          const aiResult = await callAIOcr(
            data.image_base64 ?? "",
            data.mime_type,
            text,
            apiKey,
          );
          // Merge: AI fills gaps left by regex
          finalResult = {
            fournisseur_nom: aiResult.fournisseur_nom ?? regexResult.fournisseur_nom ?? "Inconnu",
            ice_fournisseur: aiResult.ice_fournisseur ?? regexResult.ice_fournisseur ?? null,
            numero_facture: aiResult.numero_facture ?? regexResult.numero_facture ?? null,
            date_facture: aiResult.date_facture ?? regexResult.date_facture ?? null,
            date_echeance: aiResult.date_echeance ?? regexResult.date_echeance ?? null,
            montant_ht: aiResult.montant_ht ?? regexResult.montant_ht ?? 0,
            montant_tva: aiResult.montant_tva ?? regexResult.montant_tva ?? 0,
            montant_ttc: aiResult.montant_ttc ?? regexResult.montant_ttc ?? 0,
            lignes: aiResult.lignes?.length ? aiResult.lignes : (regexResult.lignes ?? []),
            confidence: "high",
            method: "ai",
          };
        } catch {
          finalResult = { ...regexResult, confidence, method: "regex" } as OcrResult;
        }
      }
    } else {
      finalResult = { ...regexResult, confidence, method: "regex" } as OcrResult;
    }

    return { result: finalResult };
  });

// ─── Email server function (Resend — free 3000 emails/month) ─────────────────

const emailInput = z.object({
  to: z.string().email(),
  subject: z.string(),
  html: z.string(),
  from_name: z.string().default("HisabPro"),
});

export const sendEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => emailInput.parse(input))
  .handler(async ({ data }) => {
    const apiKey = process.env.RESEND_API_KEY;
    const fromEmail = process.env.FROM_EMAIL ?? "noreply@hisabpro.ma";

    if (!apiKey) throw new Error("RESEND_API_KEY non configurée");

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${data.from_name} <${fromEmail}>`,
        to: [data.to],
        subject: data.subject,
        html: data.html,
      }),
    });

    if (!response.ok) {
      const txt = await response.text();
      throw new Error(`Resend API ${response.status}: ${txt}`);
    }

    const result = await response.json();
    return { sent: true, id: result.id };
  });

// ─── Audit log helper ─────────────────────────────────────────────────────────

const auditInput = z.object({
  dossier_id: z.string().uuid().optional(),
  action: z.string(),
  ressource_type: z.string().optional(),
  ressource_id: z.string().optional(),
  details: z.record(z.any()).optional(),
});

export const writeAuditLog = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => auditInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // Fetch user email
    const { data: profile } = await supabase
      .from("profiles")
      .select("email")
      .eq("id", userId)
      .maybeSingle();

    // Fetch last hash for chaining
    const { data: lastLog } = await supabase
      .from("audit_logs")
      .select("hash")
      .eq("dossier_id", data.dossier_id ?? "")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const prevHash = lastLog?.hash ?? "GENESIS";
    const payload = JSON.stringify({
      action: data.action,
      user: userId,
      ressource: data.ressource_type,
      id: data.ressource_id,
      details: data.details,
      prev: prevHash,
      ts: new Date().toISOString(),
    });
    const hash = createHash("sha256").update(payload).digest("hex");

    await supabase.from("audit_logs").insert({
      dossier_id: data.dossier_id,
      user_id: userId,
      user_email: profile?.email ?? null,
      action: data.action,
      ressource_type: data.ressource_type ?? null,
      ressource_id: data.ressource_id ?? null,
      details: data.details ?? null,
      hash,
      hash_precedent: prevHash,
    });

    return { ok: true };
  });

// ─── PCM initialisation for new dossier ──────────────────────────────────────

const PCM_COMPTES = [
  // Report à nouveau — les deux contreparties de l'écriture d'à-nouveau, qui
  // rouvre l'exercice en reportant les soldes de bilan (cf. src/lib/a-nouveaux.ts).
  { numero: PCM.REPORT_A_NOUVEAU_CREDITEUR, intitule: "Report à nouveau (solde créditeur)", type_compte: "passif" },
  { numero: PCM.REPORT_A_NOUVEAU_DEBITEUR, intitule: "Report à nouveau (solde débiteur)", type_compte: "passif" },
  // Résultat de l'exercice clos, en attente de la décision d'affectation de l'AGO.
  { numero: PCM.RESULTAT_INSTANCE_AFFECTATION_CREDITEUR, intitule: "Résultats nets en instance d'affectation (solde créditeur)", type_compte: "passif" },
  { numero: PCM.RESULTAT_INSTANCE_AFFECTATION_DEBITEUR, intitule: "Résultats nets en instance d'affectation (solde débiteur)", type_compte: "passif" },
  { numero: PCM.CLIENTS, intitule: "Clients", type_compte: "actif" },
  { numero: PCM.CLIENTS_AVANCES_RECUES, intitule: "Clients — avances et acomptes reçus sur commandes en cours", type_compte: "passif" },
  { numero: PCM.FOURNISSEURS, intitule: "Fournisseurs", type_compte: "passif" },
  { numero: PCM.REMUNERATIONS_DUES_PERSONNEL, intitule: "Rémunérations dues au personnel", type_compte: "passif" },
  { numero: PCM.CNSS, intitule: "Caisse Nationale de la Sécurité Sociale", type_compte: "passif" },
  { numero: PCM.CAISSES_RETRAITE, intitule: "Caisses de retraite", type_compte: "passif" },
  { numero: PCM.IR_RETENU_SALAIRES, intitule: "État, IGR (IR retenu à la source)", type_compte: "passif" },
  { numero: PCM.TVA_FACTUREE_EXIGIBLE, intitule: "État, TVA facturée", type_compte: "passif" },
  { numero: PCM.TVA_DUE, intitule: "État, TVA due (suivant déclarations)", type_compte: "passif" },
  { numero: PCM.TVA_ATTENTE_VENTE, intitule: "État, autres comptes créditeurs (TVA facturée en attente)", type_compte: "passif" },
  { numero: PCM.ATTENTE_BANQUE_CREDIT, intitule: "Comptes transitoires ou d'attente – créditeurs", type_compte: "passif" },
  { numero: PCM.ACOMPTES_IS, intitule: "Acomptes sur impôts sur les résultats", type_compte: "actif" },
  { numero: PCM.TVA_RECUPERABLE_CHARGES, intitule: "État, TVA récupérable sur charges", type_compte: "actif" },
  { numero: PCM.CREDIT_TVA, intitule: "État, crédit de TVA (suivant déclarations)", type_compte: "actif" },
  { numero: PCM.TVA_ATTENTE_ACHAT, intitule: "État, autres comptes débiteurs (TVA sur achats en attente)", type_compte: "actif" },
  { numero: PCM.ATTENTE_BANQUE_DEBIT, intitule: "Comptes transitoires ou d'attente – débiteurs", type_compte: "actif" },
  { numero: PCM.VIREMENTS_DE_FONDS, intitule: "Virements de fonds", type_compte: "actif" },
  { numero: PCM.BANQUE, intitule: "Banque", type_compte: "actif" },
  { numero: PCM.CAISSE, intitule: "Caisse", type_compte: "actif" },
  // Les trois comptes de vente du PCM, avec leurs VRAIS intitulés. Le 7121 était
  // libellé « Ventes de services » alors qu'il porte les BIENS PRODUITS, et le
  // 7124 — le compte des prestations, celui que `compteVente` désigne pour une
  // société de services — n'était pas créé du tout : le plan du dossier ne
  // proposait donc aucun compte pour l'activité la plus courante.
  { numero: PCM.VENTES_MARCHANDISES, intitule: "Ventes de marchandises", type_compte: "produit" },
  { numero: PCM.VENTES_BIENS_PRODUITS, intitule: "Ventes de biens produits", type_compte: "produit" },
  { numero: PCM.VENTES_SERVICES, intitule: "Ventes de services produits", type_compte: "produit" },
  // Intitulés alignés sur `pcm_reference` : 6111 porte les ACHATS DE MARCHANDISES,
  // et 6141 « Études, recherches et documentation ». Les deux étaient inversés /
  // faux, si bien que le plan d'un nouveau dossier annonçait des achats de
  // marchandises sur un compte d'études.
  { numero: PCM.ACHATS_MARCHANDISES, intitule: "Achats de marchandises", type_compte: "charge" },
  { numero: PCM.ETUDES_RECHERCHES_DOCUMENTATION, intitule: "Études, recherches et documentation", type_compte: "charge" },
  { numero: PCM.ACHATS_NON_STOCKES, intitule: "Achats non stockés de matières et fournitures", type_compte: "charge" },
  { numero: PCM.LOCATIONS, intitule: "Locations et charges locatives", type_compte: "charge" },
  { numero: PCM.SERVICES_BANCAIRES, intitule: "Frais et commissions sur services bancaires", type_compte: "charge" },
  { numero: PCM.REMUNERATIONS_PERSONNEL, intitule: "Rémunérations du personnel", type_compte: "charge" },
  { numero: PCM.CHARGES_SOCIALES, intitule: "Charges sociales", type_compte: "charge" },
];

const PCM_JOURNAUX = [
  // Journal technique des à-nouveaux : il ne porte QUE l'écriture d'ouverture.
  // Toute lecture multi-exercices doit l'exclure, sous peine de doubler les
  // soldes qu'il reporte (cf. `sansANouveaux`).
  { code: "AN", intitule: "À-nouveaux (ouverture d'exercice)", type_journal: "od" },
  { code: "VTE", intitule: "Journal des ventes", type_journal: "ventes" },
  { code: "ACH", intitule: "Journal des achats", type_journal: "achats" },
  { code: "BQ", intitule: "Journal de banque", type_journal: "banque" },
  { code: "CAI", intitule: "Journal de caisse", type_journal: "caisse" },
  { code: "OD", intitule: "Opérations diverses", type_journal: "od" },
  { code: "TVA", intitule: "Journal TVA", type_journal: "tva" },
];

export const initDossierPCM = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ dossier_id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase } = context;

    // Check if already initialized
    const { count } = await supabase
      .from("comptes_comptables")
      .select("id", { count: "exact", head: true })
      .eq("dossier_id", data.dossier_id);

    if ((count ?? 0) > 0) return { ok: true, skipped: true };

    await supabase.from("comptes_comptables").insert(
      PCM_COMPTES.map((c) => ({ ...c, dossier_id: data.dossier_id })),
    );
    await supabase.from("journaux_comptables").insert(
      PCM_JOURNAUX.map((j) => ({ ...j, dossier_id: data.dossier_id })),
    );

    return { ok: true, skipped: false };
  });
