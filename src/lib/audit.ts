// ============================================================================
// Journalisation d'audit — helper client partagé.
//
// Insère une entrée dans public.audit_logs. Le scellement cryptographique
// (hash SHA-256 chaîné) est calculé côté base par le trigger trg_audit_logs_seal
// (migration 20260715122000). On renseigne quand même user_id / user_email pour
// satisfaire la policy RLS `user_id = auth.uid()` même si le trigger n'est pas
// encore appliqué.
//
// Best-effort : ne JAMAIS bloquer ni faire échouer l'action métier appelante.
// ============================================================================
import { supabase } from "@/integrations/supabase/client";

export type AuditAction =
  | "connexion" | "deconnexion" | "ouverture_dossier"
  | "scan_facture" | "scan_releve"
  | "creation_facture" | "facture_conforme"
  | "modification_dossier" | "modification_client" | "modification_fournisseur"
  | (string & {});

export interface AuditEntry {
  dossierId?: string | null;
  action: AuditAction;
  /** Type de ressource concernée (ex. "facture", "client"). */
  ressourceType?: string | null;
  /** UUID de la ressource — UNIQUEMENT un UUID (colonne typée uuid), sinon omettre. */
  ressourceId?: string | null;
  details?: Record<string, unknown> | null;
}

export async function logAudit(entry: AuditEntry): Promise<void> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const user = session?.user;
    await (supabase.from("audit_logs") as any).insert({
      dossier_id:     entry.dossierId ?? null,
      action:         entry.action,
      ressource_type: entry.ressourceType ?? null,
      ressource_id:   entry.ressourceId ?? null,
      details:        entry.details ?? null,
      user_id:        user?.id ?? null,
      user_email:     user?.email ?? null,
    });
  } catch (e) {
    // Journalisation non bloquante : on trace en console et on continue.
    console.warn("[audit] entrée non journalisée:", e);
  }
}
