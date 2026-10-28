// ============================================================================
// ventilation.ts — Une ligne de relevé, plusieurs factures (PUR, sans I/O).
//
// Trois décisions, toutes testables sans base :
//
//   1. PROPOSER une répartition d'une ligne de relevé entre des factures
//      ouvertes — « VIR SAHARA LOGISTIQUE FA-0103 FA-0104 » règle les deux.
//   2. DÉCOUPER la ligne de tiers de l'écriture BQ en une ligne par facture,
//      chacune portant la référence de SA pièce : c'est ce qui permet au
//      lettrage (qui raisonne par référence) de solder chaque facture.
//   3. PLANIFIER la bascule de TVA due au titre des encaissements PARTIELS.
//      Sous le régime des encaissements (art. 95 CGI), chaque versement rend
//      exigible sa quote-part de TVA — pas seulement le dernier, qui solde la
//      facture et permet le lettrage.
//
// La persistance vit dans src/server/reglements-bancaires.functions.ts.
// ============================================================================

import { PCM } from "@/lib/pcm-referentiel";

const r2 = (n: number) => Math.round(n * 100) / 100;
const nb = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

/** Écart toléré entre une ligne de relevé et la somme des factures qu'elle règle. */
export const TOLERANCE_VENTILATION = 1;

export interface FactureOuverte {
  id: string;
  numero?: string | null;
  /** Ce qui reste dû — c'est ce qu'une ventilation peut régler au plus. */
  restant: number;
  /** Nom du tiers, pour reconnaître le payeur dans le libellé. */
  tiers?: string | null;
  date_facture?: string | null;
}

export interface PartVentilation { facture_id: string; montant: number }

/** Forme comparable d'un libellé ou d'un numéro : majuscules, chiffres et lettres seuls. */
const compact = (s: string | null | undefined) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * Factures dont le NUMÉRO figure dans le libellé de la ligne.
 *
 * Comparaison compactée (« FA-2026-0103 » ≡ « FA20260103 ») : les banques
 * tronquent ou recollent les références. Un numéro trop court (« 12 ») se
 * retrouverait dans n'importe quel montant ou RIB : on l'ignore.
 */
export function facturesCitees(libelle: string | null | undefined, factures: FactureOuverte[]): FactureOuverte[] {
  const lib = compact(libelle);
  if (!lib) return [];
  return factures.filter((f) => {
    const num = compact(f.numero);
    return num.length >= 5 && lib.includes(num);
  });
}

const tiersCite = (libelle: string, tiers: string | null | undefined) => {
  const lib = libelle.toUpperCase();
  return String(tiers ?? "").toUpperCase().split(/\s+/)
    .filter((w) => w.length >= 3 && !["SARL", "SOCIETE", "STE"].includes(w))
    .some((w) => lib.includes(w));
};

/** Sous-ensembles (taille ≥ 2) dont la somme des restants égale `cible`, à `tol` près. */
function sousEnsemblesExacts(fs: FactureOuverte[], cible: number, tol: number, limite = 2): FactureOuverte[][] {
  const res: FactureOuverte[][] = [];
  const rec = (i: number, choix: FactureOuverte[], somme: number) => {
    if (res.length >= limite) return;
    if (choix.length >= 2 && Math.abs(somme - cible) <= tol) { res.push([...choix]); return; }
    if (i >= fs.length || somme > cible + tol) return;
    choix.push(fs[i]); rec(i + 1, choix, somme + fs[i].restant); choix.pop();
    rec(i + 1, choix, somme);
  };
  rec(0, [], 0);
  return res;
}

/**
 * Répartition proposée d'une ligne de relevé, ou `null` quand elle n'est pas
 * CERTAINE — le doute se tranche à la main, jamais par un pari.
 *
 * Règles, par ordre de confiance :
 *   A. Le libellé cite UNE facture et le montant n'excède pas son restant dû :
 *      règlement (éventuellement partiel — une tranche) de cette facture.
 *   B. Le libellé cite PLUSIEURS factures :
 *        • la somme de leurs restants égale le montant → toutes soldées ;
 *        • sinon, s'il existe UNE SEULE façon de solder toutes les factures
 *          citées sauf une, et d'imputer le reliquat à celle-ci → retenue.
 *          (« FA-0102 FA-0107 » pour 19 000 : FA-0107 soldée à 9 000, 10 000
 *          sur FA-0102 — la seule lecture possible.)
 *   C. Rien de cité : parmi les factures du payeur reconnu dans le libellé,
 *      UNE SEULE combinaison (≥ 2 factures) dont la somme égale le montant.
 *
 * Les montants sont plafonnés au restant de chaque facture : une ventilation ne
 * crée jamais de trop-perçu.
 */
export function proposerVentilation(
  tx: { libelle?: string | null; montant: number },
  factures: FactureOuverte[],
): PartVentilation[] | null {
  const montant = r2(Math.abs(nb(tx.montant)));
  if (montant <= 0) return null;
  const ouvertes = factures.filter((f) => nb(f.restant) > 0.005);
  const citees = facturesCitees(tx.libelle, ouvertes);

  // A. Une seule facture citée, qui peut absorber le montant. Sinon la ligne
  // règle davantage que la facture citée : on cherche plus bas (règle C).
  if (citees.length === 1 && montant <= r2(citees[0].restant) + TOLERANCE_VENTILATION) {
    return [{ facture_id: citees[0].id, montant: Math.min(montant, r2(citees[0].restant)) }];
  }

  // B. Plusieurs factures citées.
  if (citees.length >= 2) {
    const total = r2(citees.reduce((s, f) => s + f.restant, 0));
    if (Math.abs(total - montant) <= TOLERANCE_VENTILATION) {
      return citees.map((f) => ({ facture_id: f.id, montant: r2(f.restant) }));
    }
    if (montant < total) {
      const lectures = citees.filter((k) => {
        const autres = r2(total - k.restant);
        const reliquat = r2(montant - autres);
        return reliquat > 0.005 && reliquat <= k.restant + 0.005;
      });
      if (lectures.length === 1) {
        const k = lectures[0];
        return citees.map((f) => ({
          facture_id: f.id,
          montant: f.id === k.id ? r2(montant - (total - k.restant)) : r2(f.restant),
        }));
      }
    }
    return null;
  }

  // C. Aucune facture citée : combinaison unique chez le payeur reconnu.
  const lib = String(tx.libelle ?? "");
  const duPayeur = ouvertes.filter((f) => tiersCite(lib, f.tiers)).slice(0, 14);
  if (duPayeur.length < 2) return null;
  const combinaisons = sousEnsemblesExacts(duPayeur, montant, 0.01);
  if (combinaisons.length !== 1) return null;
  return combinaisons[0].map((f) => ({ facture_id: f.id, montant: r2(f.restant) }));
}

// ─── Découpage de la ligne de tiers de l'écriture BQ ─────────────────────────

export interface LigneTiersBQ {
  compte_numero: string;
  debit: number;
  credit: number;
  reference_piece: string | null;
  facture_id?: string | null;
}

export interface CiblePart {
  /** Référence de la pièce réglée (n° de facture client, id de facture fournisseur). */
  reference: string;
  /** Compte de tiers de la pièce — l'auxiliaire du client s'il en a un. */
  compte: string;
  /** Rattachement `ecritures_comptables.facture_id` (factures CLIENT seulement). */
  facture_id: string | null;
  montant: number;
}

/**
 * Lignes de tiers qu'AURAIT dû produire la clôture d'une ligne réglant `parts`.
 *
 * Le sens (débit / crédit) est celui de la ligne d'origine. Un reliquat non
 * ventilé reste au compte d'attente — 4497 pour un encaissement, 3497 pour un
 * décaissement — et non sur le compte du tiers, où il passerait pour un
 * règlement de facture.
 */
export function lignesTiersVentilees(origine: LigneTiersBQ, parts: CiblePart[]): LigneTiersBQ[] {
  const auCredit = nb(origine.credit) > 0;
  const total = r2(nb(origine.credit) + nb(origine.debit));
  const lignes: LigneTiersBQ[] = parts.map((p) => ({
    compte_numero: p.compte,
    debit: auCredit ? 0 : r2(p.montant),
    credit: auCredit ? r2(p.montant) : 0,
    reference_piece: p.reference,
    facture_id: p.facture_id,
  }));
  const reliquat = r2(total - parts.reduce((s, p) => s + p.montant, 0));
  if (reliquat > 0.005) {
    lignes.push({
      compte_numero: auCredit ? PCM.ATTENTE_BANQUE_CREDIT : PCM.ATTENTE_BANQUE_DEBIT,
      debit: auCredit ? 0 : reliquat, credit: auCredit ? reliquat : 0,
      reference_piece: origine.reference_piece, facture_id: null,
    });
  }
  return lignes;
}

// ─── Rattrapage de la TVA des encaissements partiels ─────────────────────────

export interface PaiementTva { id?: string | null; montant: number; date: string }

export interface EtapeBascule {
  /** Part du règlement dont la TVA n'a pas encore été rendue exigible. */
  montantRegle: number;
  date: string;
  paiementId: string | null;
}

/**
 * Bascules de TVA manquantes d'une pièce, versement par versement.
 *
 * Idempotent PAR CONSTRUCTION : on ne mémorise pas « ce paiement a déjà
 * basculé », on compare ce qui DEVRAIT être exigible (prorata du cumul encaissé)
 * à ce qui l'EST déjà (TVA d'origine − TVA encore en attente). Rejouer la passe
 * cent fois ne produit rien de plus que la première — et une bascule faite par
 * un autre chemin (bouton « Payer », lettrage) est comptée d'office.
 *
 * Chaque étape est datée de SON versement : la TVA d'une tranche de septembre
 * appartient à la déclaration de septembre, pas à celle du jour du rattrapage.
 *
 * `excedent` > 0 signale l'inverse : plus de TVA exigible que d'encaissements
 * (un paiement délié après coup) — l'appelant contrepasse.
 */
export function planifierRattrapageTva(p: {
  tvaTotale: number; tvaAttente: number; ttc: number; paiements: PaiementTva[];
}): { etapes: EtapeBascule[]; excedent: number } {
  const tvaTotale = r2(p.tvaTotale), ttc = r2(p.ttc);
  if (tvaTotale <= 0.005 || ttc <= 0.005) return { etapes: [], excedent: 0 };
  const deja = r2(tvaTotale - Math.max(0, r2(p.tvaAttente)));
  // Montant encaissé dont la TVA est DÉJÀ exigible.
  let couvert = r2(ttc * deja / tvaTotale);
  const tries = [...p.paiements].filter((x) => nb(x.montant) > 0)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const totalPaye = r2(tries.reduce((s, x) => s + nb(x.montant), 0));
  const cible = r2(Math.min(tvaTotale, tvaTotale * totalPaye / ttc));
  if (deja > cible + 0.01) return { etapes: [], excedent: r2(deja - cible) };

  // `couvert` est reconstitué depuis une TVA arrondie au centime : 1 666,67 de
  // TVA « couvre » 10 000,02 et non 10 000. Sans recalage sur la borne de
  // versement la plus proche, la tranche suivante ne basculerait que 9 999,98.
  const marge = ttc / tvaTotale * 0.01 + 0.005;
  let borne = 0;
  for (const x of tries) {
    borne = r2(borne + nb(x.montant));
    if (Math.abs(couvert - borne) <= marge) { couvert = borne; break; }
  }

  const etapes: EtapeBascule[] = [];
  let cumul = 0;
  for (const x of tries) {
    const avant = cumul;
    cumul = r2(cumul + nb(x.montant));
    const nonCouvert = r2(Math.min(cumul, ttc) - Math.max(avant, couvert));
    if (nonCouvert > 0.005) {
      etapes.push({ montantRegle: nonCouvert, date: String(x.date).slice(0, 10), paiementId: x.id ?? null });
      couvert = r2(couvert + nonCouvert);
    }
  }
  return { etapes, excedent: 0 };
}
