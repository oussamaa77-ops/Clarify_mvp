// Écriture des règlements via la table `paiements` (source de vérité), avec repli
// gracieux sur l'ancien comportement tant que la migration n'est pas appliquée.
//
// Pourquoi un repli : la table `paiements` + son trigger sont livrés par migration SQL,
// appliquée à la main dans Supabase. Entre le déploiement de ce code et l'application de
// la migration, `paiements` n'existe pas encore. Le repli refait alors la mise à jour
// directe de montant_paye/montant_restant (exactement l'ancien code), pour que l'appli
// ne casse pas dans cet intervalle. Une fois la migration en place, tout passe par
// `paiements` et le trigger recalcule les colonnes : plus aucune écriture directe.
//
// `sb` est laissé en `any` : le schéma généré est `Database = any` (cf. mémoire
// supabase-types-placeholder), tout le code accède déjà aux tables via `(supabase as any)`.

export type TableFacture = "factures" | "factures_fournisseurs";

/** Colonne de clé étrangère de `paiements` selon le sens de la facture. */
export const fkPaiement = (t: TableFacture) =>
  t === "factures" ? "facture_id" : "facture_fournisseur_id";

/** Statut de paiement déduit des montants. Seuil 1 MAD, cohérent avec la RPC lier_transaction. */
export const statutPaiement = (ttc: number, paye: number): "non_payee" | "partielle" | "payee" =>
  paye <= 0 ? "non_payee" : ttc - paye <= 1 ? "payee" : "partielle";

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface PaiementRef {
  dossierId: string;
  table: TableFacture;
  factureId: string;
  montant: number;
  date: string;
  origine: "encaissement" | "lettrage" | "manuel";
  /** Pièce d'origine — porte l'idempotence (une ligne de relevé / un encaissement = un paiement). */
  transactionId?: string | null;
  encaissementId?: string | null;
  /**
   * Étiquette d'idempotence pour un paiement SANS pièce persistée (ex. solde depuis le
   * scanner de relevé, qui n'insère pas de transaction). Rejouer purge le paiement de
   * même (facture, référence) avant de réinsérer.
   */
  reference?: string | null;
}

/** Repli avant migration : applique un delta directement sur les colonnes dérivées. */
async function majMontantDirect(sb: any, table: TableFacture, factureId: string, delta: number, date: string | null) {
  const { data: f } = await sb.from(table).select("montant_ttc,montant_paye").eq("id", factureId).single();
  if (!f) return;
  const paye = Math.max(0, r2(Number(f.montant_paye ?? 0) + delta));
  const ttc = Number(f.montant_ttc ?? 0);
  const upd: any = {
    montant_paye: paye,
    montant_restant: Math.max(0, r2(ttc - paye)),
    statut_paiement: statutPaiement(ttc, paye),
  };
  if (date) upd.date_paiement = date;
  await sb.from(table).update(upd).eq("id", factureId);
}

/**
 * Enregistre un règlement. Idempotent : rejoue le même encaissement / la même ligne de
 * relevé ne crée pas de doublon (on purge d'abord le paiement de cette pièce). Le trigger
 * SQL recalcule montant_paye/montant_restant/statut de la facture.
 */
export async function enregistrerPaiement(sb: any, p: PaiementRef): Promise<void> {
  const fk = fkPaiement(p.table);
  try {
    // Idempotence : par pièce (transaction / encaissement) ou, à défaut, par (facture, référence).
    if (p.transactionId) await sb.from("paiements").delete().eq("transaction_id", p.transactionId);
    else if (p.encaissementId) await sb.from("paiements").delete().eq("encaissement_id", p.encaissementId);
    else if (p.reference) await sb.from("paiements").delete().eq(fk, p.factureId).eq("reference", p.reference);

    const { error } = await sb.from("paiements").insert({
      dossier_id: p.dossierId,
      [fk]: p.factureId,
      montant: r2(p.montant),
      date_paiement: p.date,
      origine: p.origine,
      transaction_id: p.transactionId ?? null,
      encaissement_id: p.encaissementId ?? null,
      reference: p.reference ?? null,
    });
    if (error) throw error;                       // table absente / RLS → repli ci-dessous
  } catch {
    await majMontantDirect(sb, p.table, p.factureId, r2(p.montant), p.date);
  }
}

/**
 * Reconstruit les paiements dérivés (lettrage / encaissement) d'un dossier depuis leurs
 * sources authoritatives, via la RPC `synchroniser_paiements_dossier`. À appeler après
 * toute opération de lettrage/délettrage/encaissement qui touche `transactions_bancaires`
 * ou `encaissements` directement (sans passer par la RPC lier_transaction).
 *
 * Retourne `false` si la fonction n'existe pas encore (avant migration) : l'appelant
 * retombe alors sur l'ancienne mise à jour directe des colonnes.
 */
export async function reconcilierPaiements(sb: any, dossierId: string): Promise<boolean> {
  try {
    const { error } = await sb.rpc("synchroniser_paiements_dossier", { p_dossier: dossierId });
    return !error;
  } catch {
    return false;
  }
}
