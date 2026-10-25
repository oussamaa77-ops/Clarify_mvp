// ============================================================================
// acces.ts — contrôle d'accès commun à TOUTES les server functions.
//
// Une server function TanStack est un point d'entrée HTTP public
// (POST /_serverFn/<id>, l'id se lit dans le bundle du navigateur). Les nôtres
// travaillent avec la clé service_role, donc HORS RLS : sans contrôle ici,
// n'importe qui sur Internet, même sans compte, pouvait lire ou modifier le
// dossier d'un cabinet en passant son identifiant.
//
// Ce module dit QUI appelle (jeton de session vérifié) et S'IL A LE DROIT de
// toucher chaque dossier et chaque pièce cités dans l'entrée. Le middleware
// global (src/server/acces.middleware.ts) l'applique avant chaque handler.
// ============================================================================
import type { SupabaseClient } from "@supabase/supabase-js";

/** Server functions appelables sans session : l'inscription, la grille
 *  tarifaire publique, et celles qui vérifient elles-mêmes un access_token
 *  passé dans l'entrée (resoudreCabinet). */
export const FONCTIONS_PUBLIQUES = new Set<string>([
  "inscrireEnAttente",
  "listPlans",
  "getBillingOverview",
  "activerPlanChoisi",
  "changePlan",
]);

/** Clés d'entrée qui désignent directement un dossier. */
const CLES_DOSSIER = ["dossierId", "dossier_id"] as const;

/** Clés d'entrée qui désignent une pièce, et les tables où la chercher. Le
 *  dossier de la pièce est relu en base : c'est LUI qu'on contrôle, jamais un
 *  dossier_id fourni à côté (sinon : son propre dossier + la facture d'un autre). */
export const CLES_PIECE: Record<string, readonly string[]> = {
  facture_id: ["factures", "factures_fournisseurs"],
  document_id: ["factures", "factures_fournisseurs", "justificatifs"],
  justificatif_id: ["justificatifs"],
  client_id: ["clients"],
  fournisseur_id: ["fournisseurs"],
  employe_id: ["employes"],
  bulletin_id: ["bulletins_paie"],
  job_id: ["document_jobs"],
  batch_id: ["import_batches"],
  txId: ["transactions_bancaires"],
  transactionId: ["transactions_bancaires"],
  ecritureIds: ["ecritures_comptables"],
  ligneIds: ["ecritures_comptables"],
};

export class AccesRefuse extends Error {
  constructor(message: string, readonly status: 401 | 403) {
    super(message);
    this.name = "AccesRefuse";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Seuls les UUID désignent une ligne : une autre valeur (le job « inline »
 *  de jobs.functions, par exemple) ne peut rien atteindre en base. */
function idsDe(valeur: unknown): string[] {
  const brut = Array.isArray(valeur) ? valeur : [valeur];
  return brut.filter((v): v is string => typeof v === "string" && UUID.test(v));
}

/** Extrait de l'entrée brute les dossiers et les pièces à contrôler. */
export function extraireReferences(data: unknown): {
  dossiers: string[];
  pieces: { cle: string; ids: string[] }[];
} {
  const dossiers = new Set<string>();
  const pieces: { cle: string; ids: string[] }[] = [];
  if (!data || typeof data !== "object") return { dossiers: [], pieces };

  const entree = data as Record<string, unknown>;
  for (const cle of CLES_DOSSIER) for (const id of idsDe(entree[cle])) dossiers.add(id);
  for (const cle of Object.keys(CLES_PIECE)) {
    const ids = idsDe(entree[cle]);
    if (ids.length) pieces.push({ cle, ids: [...new Set(ids)] });
  }
  return { dossiers: [...dossiers], pieces };
}

/** Rend l'identifiant de l'utilisateur du jeton, ou lève 401. */
export async function utilisateurDuJeton(sb: SupabaseClient, authorization: string | null): Promise<string> {
  const jeton = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!jeton) throw new AccesRefuse("Session requise.", 401);
  const { data, error } = await sb.auth.getUser(jeton);
  if (error || !data?.user?.id) throw new AccesRefuse("Session invalide ou expirée.", 401);
  return data.user.id;
}

/** Dossiers des pièces citées. Une pièce introuvable est un refus : on ne
 *  laisse pas un handler service_role décider seul de ce qu'il en fait. */
async function dossiersDesPieces(sb: SupabaseClient, cle: string, ids: string[]): Promise<string[]> {
  const restants = new Set(ids);
  const dossiers = new Set<string>();
  for (const table of CLES_PIECE[cle]) {
    if (!restants.size) break;
    const { data, error } = await (sb.from(table as any) as any)
      .select("id, dossier_id")
      .in("id", [...restants]);
    if (error) throw new AccesRefuse(`Contrôle d'accès impossible (${table}) : ${error.message}`, 403);
    for (const r of (data ?? []) as { id: string; dossier_id: string | null }[]) {
      restants.delete(r.id);
      if (r.dossier_id) dossiers.add(r.dossier_id);
    }
  }
  if (restants.size) throw new AccesRefuse(`Pièce introuvable (${cle}).`, 403);
  return [...dossiers];
}

/** Lève 403 si l'utilisateur n'a pas accès à l'un des dossiers ou des pièces
 *  désignés par l'entrée. */
export async function exigerAcces(sb: SupabaseClient, userId: string, data: unknown): Promise<void> {
  const { dossiers, pieces } = extraireReferences(data);
  const aControler = new Set(dossiers);
  for (const p of pieces) for (const d of await dossiersDesPieces(sb, p.cle, p.ids)) aControler.add(d);

  for (const dossierId of aControler) {
    const { data: ok, error } = await sb.rpc("has_dossier_access" as any, {
      _user_id: userId,
      _dossier_id: dossierId,
    });
    if (error) throw new AccesRefuse(`Contrôle d'accès impossible : ${error.message}`, 403);
    if (ok !== true) throw new AccesRefuse("Accès refusé à ce dossier.", 403);
  }
}
