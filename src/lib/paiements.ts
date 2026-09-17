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
  /**
   * Ce qui a éteint la créance ou la dette. Miroir exact du CHECK
   * `paiements_origine_check` — les élargir séparément ferait accepter ici une
   * valeur que la base refuse, ou l'inverse.
   *
   *   'encaissement' / 'lettrage'  dérivées d'une pièce de trésorerie, et
   *                                RECONSTRUITES par synchroniser_paiements_dossier ;
   *   'manuel'                     versement saisi à la main : de l'argent EST entré ;
   *   'avoir'                      la créance a été ANNULÉE, AUCUN argent n'a circulé.
   *
   * La dernière n'est pas un synonyme de 'manuel' : un état de trésorerie qui
   * somme les règlements pour dire ce qui a été encaissé doit écarter 'avoir',
   * sans quoi il compte une annulation comme une recette.
   */
  origine: "encaissement" | "lettrage" | "manuel" | "avoir";
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
 * Ce qu'un règlement laisse derrière lui.
 *
 * `piece` est la référence de la SAISIE FORMELLE — c'est elle qui autorise
 * l'écriture de trésorerie qui suit (cf. src/lib/integrite-tresorerie.ts). Elle
 * est toujours renseignée : même quand la table `paiements` n'existe pas encore,
 * le règlement a bien été imputé sur la facture, et l'écriture est justifiée.
 */
export interface PaiementEnregistre {
  piece: string;
  /** `paiements` = table de vérité ; `colonnes` = repli avant migration. */
  via: "paiements" | "colonnes";
}

/**
 * Un règlement refusé par les verrous de la base.
 *
 * Distingué d'une panne technique par une classe à part : le repli sur l'écriture
 * directe des colonnes ne doit JAMAIS s'appliquer ici. Il réinstallerait
 * exactement ce que le verrou vient d'écarter — un règlement antérieur à sa
 * facture, un doublon, un dépassement — mais cette fois sans laisser de ligne
 * dans `paiements`, donc sans aucune trace à auditer.
 */
export class ReglementRefuse extends Error {
  constructor(message: string) { super(message); this.name = "ReglementRefuse"; }
}

/**
 * L'erreur dit-elle « cette fonction n'existe pas » plutôt que « ce règlement est
 * invalide » ?
 *
 * Le repli n'est légitime que dans le premier cas — migration pas encore
 * appliquée. PostgREST rend `PGRST202` pour une RPC introuvable ; les refus
 * métier remontent en `check_violation` (23514) avec le message du RAISE.
 */
function rpcAbsente(e: any): boolean {
  const code = String(e?.code ?? "");
  const msg = String(e?.message ?? "").toLowerCase();
  if (code === "PGRST202" || code === "42883") return true;
  return /could not find the function|does not exist|schema cache/.test(msg);
}

/**
 * Enregistre un règlement — par la RPC ATOMIQUE quand elle existe.
 *
 * `enregistrer_reglement` fait la validation, l'insertion et le recalcul de la
 * facture dans UNE transaction, et rend l'état final. La séquence précédente
 * (delete, puis insert, puis relecture de la facture par l'appelant) n'était
 * atomique à aucun moment : une coupure entre deux appels laissait durablement
 * une facture payée sans paiement, ou l'inverse.
 *
 * Trois issues, et trois comportements distincts :
 *   • RPC absente (migration pas encore appliquée) → ancien chemin, à l'identique ;
 *   • règlement REFUSÉ par les verrous → on propage, sans aucun repli ;
 *   • succès → idempotent, la même pièce rejouée rend l'état existant.
 */
export async function enregistrerPaiement(sb: any, p: PaiementRef): Promise<PaiementEnregistre> {
  const fk = fkPaiement(p.table);
  // Référence de la pièce, indépendante de la réussite de l'insert : elle décrit
  // le règlement qu'on vient de saisir, pas la ligne SQL qui l'a stocké.
  const piece = String(p.transactionId ?? p.encaissementId ?? p.reference
    ?? `${p.origine}:${p.factureId}:${p.date}`);

  // `rpc` rend `{ error }` pour un refus SQL et ne LÈVE que sur panne de
  // transport. Les deux se traitent différemment : un refus est une décision
  // métier qu'on propage, une panne laisse sa chance à l'ancien chemin, qui
  // échouera de la même façon s'il n'y a vraiment plus de réseau.
  let refus: string | null = null;
  try {
    const { error } = await sb.rpc("enregistrer_reglement", {
      p_dossier: p.dossierId,
      p_facture: p.factureId,
      p_kind: p.table === "factures" ? "client" : "fournisseur",
      p_montant: r2(p.montant),
      p_date: p.date,
      p_origine: p.origine,
      p_transaction: p.transactionId ?? null,
      p_encaissement: p.encaissementId ?? null,
      p_reference: p.reference ?? null,
    });
    if (!error) return { piece, via: "paiements" };
    if (!rpcAbsente(error)) refus = String(error.message ?? error);
  } catch {
    // Transport : on retombe sur l'ancien chemin.
  }
  if (refus) throw new ReglementRefuse(refus);

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
    return { piece, via: "paiements" };
  } catch {
    await majMontantDirect(sb, p.table, p.factureId, r2(p.montant), p.date);
    return { piece, via: "colonnes" };
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
