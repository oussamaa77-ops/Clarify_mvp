// Filtres et retards de paiement des tableaux de factures (Ventes et Achats).
// Logique pure, sans dépendance framework : la même règle sert aux deux écrans,
// et reste testable sans rendu React.
//
// Les tranches d'ancienneté reprennent EXACTEMENT celles de la balance âgée
// (src/components/BalanceAgee.tsx) : un comptable doit pouvoir rapprocher les
// deux écrans sans convertir mentalement des découpages différents.

export type StatutFiltre = "toutes" | "payees" | "partiel" | "impayees" | "retard";

/** Champ de date sur lequel porte le filtre de période. */
export type ChampDate = "date_facture" | "date_echeance";

export interface FactureFiltrable {
  numero?: string | null;
  date_facture?: string | null;
  date_echeance?: string | null;
  montant_ttc?: number | null;
  montant_paye?: number | null;
  montant_restant?: number | null;
  statut_paiement?: string | null;
}

export interface CriteresFiltre {
  /** Recherche libre : n° de facture, référence, nom du tiers. */
  texte?: string;
  statut?: StatutFiltre;
  /** Identifiant du tiers (client ou fournisseur) ; "" = tous. */
  tiersId?: string;
  /** Bornes de période incluses, au format YYYY-MM-DD. */
  debut?: string;
  fin?: string;
  champDate?: ChampDate;
}

/**
 * Convertit une date en numéro de jour UTC, pour comparer des jours calendaires
 * sans se faire piéger par l'heure ni le fuseau. `null` si la date est absente
 * ou illisible (une facture sans échéance n'est jamais « en retard »).
 */
function jourUTC(d: string | Date | null | undefined): number | null {
  if (!d) return null;
  if (d instanceof Date) {
    if (isNaN(d.getTime())) return null;
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000;
  }
  // Format ISO 'YYYY-MM-DD' (éventuellement suivi d'une heure) → on ne garde que le jour.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d.trim());
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000;
}

/**
 * Reste dû sur la facture. `montant_restant` peut être NULL sur les factures
 * antérieures au moteur de paiement → on retombe sur le TTC.
 */
export function resteAPayer(f: FactureFiltrable): number {
  const restant = f.montant_restant;
  if (restant != null && restant !== undefined) return Number(restant) || 0;
  return Number(f.montant_ttc) || 0;
}

/** Une facture est soldée si elle ne doit plus rien, ou si son statut le dit. */
export function estPayee(f: FactureFiltrable): boolean {
  return resteAPayer(f) <= 0 || f.statut_paiement === "payee";
}

/**
 * Date à partir de laquelle une facture est EXIGIBLE : son échéance, à défaut sa
 * date d'émission.
 *
 * C'est la règle de la vue SQL `v_balance_agee` (COALESCE(date_echeance,
 * date_facture)), et elle doit être la seule de l'application. Le Dashboard
 * lisait l'échéance SEULE : une facture sans échéance y restait « dans les
 * temps » pour toujours, pendant que le module Fournisseurs, adossé à la vue, la
 * classait « Urgent (+60 j) ». FF-GOLD-001, émise le 20/04/2026 sans échéance,
 * était ainsi à 147 jours de retard d'un côté et à 0 de l'autre.
 *
 * Compter le retard dès l'émission quand aucune échéance n'a été saisie est la
 * lecture PRUDENTE — et surtout celle que la balance âgée affiche déjà. Un
 * délai convenu se matérialise en renseignant `date_echeance`, qui prime.
 */
export function dateExigibilite(
  f: Pick<FactureFiltrable, "date_echeance" | "date_facture">,
): string | null {
  const ech = String(f.date_echeance ?? "").trim();
  if (ech && jourUTC(ech) != null) return ech;
  const emission = String(f.date_facture ?? "").trim();
  return emission && jourUTC(emission) != null ? emission : null;
}

/**
 * Nombre de jours de retard à la date du jour (recalculé à chaque affichage —
 * c'est ce qui rend le retard « dynamique »). `null` si la facture est soldée,
 * sans date exploitable, ou si elle n'est pas encore exigible.
 *
 * Le retard court depuis la date d'EXIGIBILITÉ (cf. `dateExigibilite`).
 */
export function joursRetard(f: FactureFiltrable, aujourdhui: Date = new Date()): number | null {
  if (estPayee(f)) return null;
  const ech = jourUTC(dateExigibilite(f));
  const now = jourUTC(aujourdhui);
  if (ech == null || now == null) return null;
  const jours = now - ech;
  return jours > 0 ? jours : null;
}

export interface TrancheRetard {
  cle: "retard_1_30" | "retard_31_60" | "retard_60_plus";
  label: string;
  /** Classes Tailwind du badge — intensité croissante avec l'ancienneté. */
  cls: string;
}

/** Tranche d'ancienneté d'un retard, alignée sur la balance âgée. */
export function trancheRetard(jours: number | null): TrancheRetard | null {
  if (jours == null || jours <= 0) return null;
  if (jours <= 30) return { cle: "retard_1_30", label: "1-30 j", cls: "bg-amber-100 text-amber-800" };
  if (jours <= 60) return { cle: "retard_31_60", label: "31-60 j", cls: "bg-orange-100 text-orange-800" };
  return { cle: "retard_60_plus", label: "+60 j", cls: "bg-red-100 text-red-700" };
}

/**
 * Prédicat de statut. Volontairement NON exclusif : une facture en retard peut
 * être aussi « partiellement payée ». Filtrer sur « En retard » doit donc la
 * retenir, sans quoi on masquerait des créances réellement dues.
 */
export function correspondStatut(
  f: FactureFiltrable,
  statut: StatutFiltre = "toutes",
  aujourdhui: Date = new Date(),
): boolean {
  if (statut === "toutes") return true;
  const paye = Number(f.montant_paye) || 0;
  const payee = estPayee(f);
  switch (statut) {
    case "payees":   return payee;
    case "partiel":  return !payee && paye > 0;
    case "impayees": return !payee && paye <= 0;
    case "retard":   return joursRetard(f, aujourdhui) != null;
  }
}

/**
 * Applique tous les critères. Les filtres se cumulent (ET logique) ; un critère
 * vide est neutre. `nomTiers` permet à chaque écran de fournir le libellé du
 * tiers, qui n'est pas toujours porté par la facture elle-même (côté ventes il
 * faut résoudre `client_id` via l'annuaire).
 */
export function filtrerFactures<T extends FactureFiltrable>(
  factures: T[],
  criteres: CriteresFiltre = {},
  opts: {
    nomTiers?: (f: T) => string | null | undefined;
    idTiers?: (f: T) => string | null | undefined;
    /** Champs libres supplémentaires balayés par la recherche (référence, objet…). */
    texteExtra?: (f: T) => (string | null | undefined)[];
    aujourdhui?: Date;
  } = {},
): T[] {
  const aujourdhui = opts.aujourdhui ?? new Date();
  const q = (criteres.texte ?? "").trim().toLowerCase();
  const champ: ChampDate = criteres.champDate ?? "date_facture";
  const debut = jourUTC(criteres.debut);
  const fin = jourUTC(criteres.fin);

  return factures.filter((f) => {
    // ── Recherche libre ─────────────────────────────────────────────────────
    if (q) {
      const cibles = [
        f.numero,
        opts.nomTiers?.(f),
        ...(opts.texteExtra?.(f) ?? []),
      ];
      if (!cibles.some((c) => (c ?? "").toString().toLowerCase().includes(q))) return false;
    }

    // ── Statut ──────────────────────────────────────────────────────────────
    if (!correspondStatut(f, criteres.statut ?? "toutes", aujourdhui)) return false;

    // ── Tiers ───────────────────────────────────────────────────────────────
    if (criteres.tiersId) {
      if ((opts.idTiers?.(f) ?? null) !== criteres.tiersId) return false;
    }

    // ── Période ─────────────────────────────────────────────────────────────
    if (debut != null || fin != null) {
      const j = jourUTC(f[champ] as string | null | undefined);
      // Une facture sans la date filtrée ne peut pas prouver qu'elle est dans la
      // période : on l'exclut plutôt que de la laisser passer silencieusement.
      if (j == null) return false;
      if (debut != null && j < debut) return false;
      if (fin != null && j > fin) return false;
    }

    return true;
  });
}
