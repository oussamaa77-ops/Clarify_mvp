// ============================================================================
// quota.ts — logique de quota PURE (aucun I/O, aucun Supabase).
//
// L'enforcement réel est en base (RPC consume_scan_quota, atomique). Ce module
// tient la logique *dérivée* — état, période, messages — partagée par le serveur
// (garde-fou avant OCR) et l'UI (barre de consommation, page abonnement), pour
// que les deux ne divergent jamais.
//
// Règle : SCANS_ILLIMITES (-1) est un plan sans limite ; toute limite >= 0 est
// une limite dure.
// ============================================================================

export const SCANS_ILLIMITES = -1;

export type SubscriptionStatus = "trial" | "active" | "past_due" | "canceled" | "inactive";

export type NiveauQuota = "ok" | "alerte" | "critique" | "epuise";

/** Raisons de refus renvoyées par consume_scan_quota (contrat SQL ↔ TS). */
export type RaisonRefus =
  | "quota_depasse"
  | "essai_expire"
  | "abonnement_impaye"
  | "aucun_abonnement"
  | "dossier_introuvable";

export interface Plan {
  id: string;
  code: string;
  name: string;
  price_monthly: number;
  currency: string;
  scans_limit: number;
  features: string[];
}

export interface QuotaStatus {
  has_subscription: boolean;
  status?: SubscriptionStatus;
  plan?: Plan;
  used?: number;
  limit?: number;
  remaining?: number;
  period_start?: string;
  period_end?: string;
  trial_ends_at?: string | null;
  reason?: string;
}

export interface EtatQuota {
  illimite: boolean;
  utilises: number;
  limite: number;
  restants: number;
  /** 0–100, borné. Toujours 0 en illimité. */
  pourcentage: number;
  niveau: NiveauQuota;
  epuise: boolean;
}

/** Seuils d'alerte UI (et de relance commerciale). */
const SEUIL_ALERTE = 0.8;
const SEUIL_CRITIQUE = 0.95;

/**
 * État dérivé du couple (consommé, limite). Tolère des entrées sales
 * (négatives, NaN, undefined) : l'UI ne doit jamais afficher NaN%.
 */
export function etatQuota(input: { used?: number | null; limit?: number | null }): EtatQuota {
  const limite = Number.isFinite(Number(input.limit)) ? Number(input.limit) : 0;
  const utilises = Math.max(0, Number.isFinite(Number(input.used)) ? Number(input.used) : 0);

  if (limite < 0) {
    return {
      illimite: true, utilises, limite: SCANS_ILLIMITES, restants: Infinity,
      pourcentage: 0, niveau: "ok", epuise: false,
    };
  }

  const restants = Math.max(0, limite - utilises);
  const ratio = limite === 0 ? 1 : utilises / limite;
  const pourcentage = Math.min(100, Math.round(ratio * 100));

  let niveau: NiveauQuota = "ok";
  if (restants === 0) niveau = "epuise";
  else if (ratio >= SEUIL_CRITIQUE) niveau = "critique";
  else if (ratio >= SEUIL_ALERTE) niveau = "alerte";

  return { illimite: false, utilises, limite, restants, pourcentage, niveau, epuise: restants === 0 };
}

/** Un scan de `quantite` documents passerait-il ? (pré-check UI, non contraignant) */
export function peutConsommer(etat: EtatQuota, quantite = 1): boolean {
  return etat.illimite || etat.restants >= quantite;
}

/**
 * Miroir TS de quota_periode_courante() : fait avancer la fenêtre mensuelle
 * tant qu'elle est échue. Les périodes sont [debut, fin) — une période qui se
 * termine aujourd'hui est déjà close.
 */
export function periodeCourante(
  debut: string | Date, fin: string | Date, aujourdhui: string | Date = new Date(),
): { debut: Date; fin: Date } {
  let d = jour(debut);
  let f = jour(fin);
  const today = jour(aujourdhui);

  if (f <= d) f = ajouterMois(d, 1);
  // Borne de sécurité : 1200 itérations = 100 ans, jamais atteint en pratique.
  for (let i = 0; f <= today && i < 1200; i++) {
    d = f;
    f = ajouterMois(f, 1);
  }
  return { debut: d, fin: f };
}

/**
 * L'abonnement autorise-t-il de scanner ? (hors quota, qui est vérifié à part)
 * — 'active' : oui ; 'trial' : oui tant que l'essai court ; le reste : non.
 */
export function abonnementActif(
  sub: { status?: SubscriptionStatus | null; trial_ends_at?: string | Date | null } | null | undefined,
  aujourdhui: string | Date = new Date(),
): boolean {
  if (!sub?.status) return false;
  if (sub.status === "active") return true;
  if (sub.status !== "trial") return false;
  if (!sub.trial_ends_at) return true;             // essai sans échéance = ouvert
  return jour(sub.trial_ends_at) >= jour(aujourdhui);
}

/** Message utilisateur pour un refus serveur. Une seule source de vérité. */
export function messageRefus(reason: string | undefined, ctx?: { limite?: number; plan?: string }): string {
  switch (reason) {
    case "quota_depasse":
      return `Quota mensuel atteint${ctx?.limite != null ? ` (${ctx.limite} scans)` : ""}. `
        + `Passez à un plan supérieur pour continuer à scanner.`;
    case "essai_expire":
      return "Votre période d'essai est terminée. Choisissez un plan pour reprendre les scans.";
    case "abonnement_impaye":
      return "Votre abonnement est en attente de règlement. Régularisez pour reprendre les scans.";
    case "aucun_abonnement":
      return "Aucun abonnement actif sur ce cabinet. Choisissez un plan pour commencer.";
    case "dossier_introuvable":
      return "Dossier introuvable ou non rattaché à un cabinet.";
    default:
      return "Scan refusé : quota indisponible.";
  }
}

/** 399 → « 399 MAD / mois ». */
export function formatPrix(montant: number, devise = "MAD"): string {
  const n = new Intl.NumberFormat("fr-MA", { maximumFractionDigits: 0 }).format(montant);
  return `${n} ${devise} / mois`;
}

// ── helpers date (locaux, sans dépendance) ──────────────────────────────────

/** « 2026-07-01 » en date LOCALE. Le parsing natif la lirait en UTC : sous un
 *  fuseau positif, minuit UTC retombe la veille et toute la période glisse. */
export function jour(v: string | Date): Date {
  if (typeof v === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  const d = v instanceof Date ? new Date(v.getTime()) : new Date(v);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Date locale → « YYYY-MM-DD » (toISOString repasserait en UTC). */
export function formatJour(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * +1 mois en butant sur la fin de mois (31 janv. → 28/29 févr.), comme le fait
 * l'arithmétique d'intervalle de Postgres — sinon le JS déborde sur mars et les
 * périodes TS/SQL divergeraient.
 */
function ajouterMois(d: Date, n: number): Date {
  const jourDuMois = d.getDate();
  const r = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const dernierJour = new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate();
  r.setDate(Math.min(jourDuMois, dernierJour));
  r.setHours(0, 0, 0, 0);
  return r;
}
