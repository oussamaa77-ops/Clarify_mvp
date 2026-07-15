// document-processing.service.ts — CŒUR RÉUTILISABLE du traitement documentaire.
//
// Unique point d'orchestration OCR → LLM → mémoire → (résultat), appelé aussi
// bien par le WORKER BullMQ que par le fallback INLINE de la server fn. Réutilise
// la logique existante (ocrFacture / analyserReleveIA) SANS la dupliquer :
// ces server fns, appelées côté serveur, exécutent directement leur handler.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ocrFacture, analyserReleveIA } from "@/server/factures.functions";

function getSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    "";
  return createClient(url, key);
}

export interface DocumentJobInput {
  job_id: string;
  dossier_id: string;
  type: "facture" | "releve" | "justificatif";
  bucket?: string | null;
  file_path?: string | null;
  payload?: Record<string, any> | null;
}

// Télécharge un fichier du storage → base64 (fallback si le payload ne contient
// pas déjà extracted_text / image_base64).
async function downloadAsBase64(
  supabase: SupabaseClient,
  bucket: string,
  path: string,
): Promise<{ base64: string; mime: string } | null> {
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error || !data) return null;
  const buf = Buffer.from(await data.arrayBuffer());
  return { base64: buf.toString("base64"), mime: (data as any).type || "application/octet-stream" };
}

// Contexte de rapprochement d'un relevé (mêmes requêtes que l'écran scanner).
async function fetchReleveContext(supabase: SupabaseClient, dossierId: string) {
  const [{ data: fc }, { data: ff }, { data: fo }, { data: cl }, { data: jj }, { data: dos }] = await Promise.all([
    (supabase as any).from("factures").select("id,numero,montant_ht,montant_ttc,montant_tva,montant_paye,montant_restant,date_facture,date_echeance,mode_reglement,type,clients(id,nom,ice)").eq("dossier_id", dossierId).eq("statut", "conforme").neq("statut_paiement", "payee"),
    (supabase as any).from("factures_fournisseurs").select("id,numero,montant_ht,montant_ttc,montant_tva,montant_paye,montant_restant,date_facture,date_echeance,fournisseur_nom,fournisseur_id,mode_reglement").eq("dossier_id", dossierId).neq("statut_paiement", "payee"),
    (supabase as any).from("fournisseurs").select("id,nom,ice").eq("dossier_id", dossierId),
    (supabase as any).from("clients").select("id,nom,ice").eq("dossier_id", dossierId),
    (supabase as any).from("justificatifs").select("id,type_document,nom_tiers,montant_ttc,numero_piece,date_document,bon_commande_id,devis_id,created_at,statut,eligible_edi").eq("dossier_id", dossierId).order("created_at", { ascending: false }),
    (supabase as any).from("dossiers").select("nom_societe,ice").eq("id", dossierId).maybeSingle(),
  ]);
  return {
    factures_client: fc ?? [], factures_fourn: ff ?? [], fournisseurs: fo ?? [],
    clients: cl ?? [], justificatifs: jj ?? [],
    dossier_nom: (dos as any)?.nom_societe ?? "", dossier_ice: (dos as any)?.ice ?? "",
  };
}

/**
 * Traite UN job documentaire de bout en bout et renvoie le résultat brut.
 * (La persistance du statut/résultat est faite par l'appelant : worker ou server fn.)
 * La mémoire des tiers est appliquée À L'INTÉRIEUR de ocrFacture / analyserReleveIA.
 */
export async function processDocumentJob(job: DocumentJobInput): Promise<any> {
  const supabase = getSupabase();
  const p = job.payload ?? {};

  if (job.type === "facture" || job.type === "justificatif") {
    let image_base64: string | undefined = p.image_base64;
    let extracted_text: string = p.extracted_text ?? "";
    let mime_type: string = p.mime_type ?? "image/jpeg";
    // Rien de préparé → on télécharge le fichier du storage.
    if (!image_base64 && !extracted_text && job.file_path) {
      const dl = await downloadAsBase64(supabase, job.bucket ?? "factures-originales", job.file_path);
      if (dl) { image_base64 = dl.base64; mime_type = dl.mime; }
    }
    // 1+2+3 : OCR + LLM + mémoire (tout est dans ocrFacture). Appel server-side
    // direct de la server fn (exécute son handler et renvoie le résultat).
    return await ocrFacture({
      data: {
        dossier_id: job.dossier_id,
        extracted_text,
        image_base64,
        mime_type,
        sens_hint: p.sens_hint ?? "fournisseur",
      },
    });
  }

  if (job.type === "releve") {
    const ctx = await fetchReleveContext(supabase, job.dossier_id);
    // 1+2+3 : (OCR déjà fait à l'upload → transactions_brutes) + LLM + mémoire banque.
    return await analyserReleveIA({
      data: {
        dossier_id: job.dossier_id,
        transactions_brutes: p.transactions_brutes ?? [],
        ...ctx,
        remarques: p.remarques,
      },
    });
  }

  throw new Error(`Type de job inconnu : ${job.type}`);
}
