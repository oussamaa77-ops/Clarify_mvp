// ============================================================================
// relances-postes.ts — les créances de REPRISE (grand livre 342x) d'une relance,
// sans jamais compter deux fois la même dette.
//
// ─── Le ×2 que ce module existe pour empêcher ────────────────────────────────
// La relance CUMULE deux sources : les factures non soldées (source 1) et les
// postes 342x non lettrés sans facture rattachée (source 2, reprise d'un grand
// livre importé). Or un À-NOUVEAU (journal AN) n'a pas de `facture_id` : il
// reporte un SOLDE, il ne crée pas de créance. Sur TEST-CLARIFY-GOLDEN, la ligne
// AN-2027 du 34210001 (15 000) passait donc pour une créance de reprise, et
// s'ajoutait au reste dû de FA-GOLD-002 qu'elle ne fait que reporter :
// 30 000 MAD à recouvrer pour 15 000 réellement dus.
//
// ─── La règle ────────────────────────────────────────────────────────────────
// Un à-nouveau n'est retenu que s'il est la SEULE trace de la créance — dossier
// repris dont l'ouverture a été saisie en AN, sans aucune écriture d'origine sur
// le compte. Dès qu'une écriture ordinaire du même compte le précède, il en est
// le report et sort (même raisonnement que `lignesDeCloture`, qui ne peut PAS
// écarter tous les AN sans détruire ces dossiers-là).
//
// Une pièce dont la référence est le numéro d'une facture déjà relancée en
// source 1 sort aussi : c'est la même créance, vue par le grand livre.
//
// Logique pure — aucun accès base.
// ============================================================================

import { JOURNAL_AN } from "./a-nouveaux";

export interface EcritureRelance {
  id: string;
  journal_code?: string | null;
  compte_numero?: string | null;
  libelle?: string | null;
  debit?: number | null;
  credit?: number | null;
  reference_piece?: string | null;
  date_ecriture?: string | null;
  lettree?: boolean | null;
  lettrage_code?: string | null;
  facture_id?: string | null;
  transaction_id?: string | null;
}

export interface PosteReprise {
  compte: string;
  ref: string;
  /** Nom tiré du libellé côté débit (celui de la créance). */
  nom: string;
  /** Créance nette (débit − crédit), toujours > 0. */
  montant: number;
  /** Date de la plus ancienne ligne du poste. */
  date: string | null;
  ecritureIds: string[];
}

const txt = (v: unknown) => String(v ?? "").trim();
const nb = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const jour = (v: unknown) => txt(v).slice(0, 10);

/**
 * Postes 342x ouverts issus de la reprise, un par (compte, pièce).
 *
 * `ecritures` doit contenir TOUTES les lignes des comptes clients du dossier —
 * y compris celles rattachées à une facture ou à une transaction : c'est elles
 * qui prouvent qu'un à-nouveau est un report et non une ouverture.
 */
export function postesRepriseClients(
  ecritures: EcritureRelance[],
  prefixes: readonly string[],
  numerosFacturesRelancees: Iterable<string> = [],
): PosteReprise[] {
  const estClient = (c: string) => prefixes.some((p) => c.startsWith(p));
  const dejaRelancees = new Set([...numerosFacturesRelancees].map(txt).filter(Boolean));

  // Première écriture ORDINAIRE (hors AN) de chaque compte client.
  const premiereOrdinaire = new Map<string, string>();
  for (const r of ecritures ?? []) {
    const c = txt(r.compte_numero);
    if (!c || !estClient(c) || txt(r.journal_code).toUpperCase() === JOURNAL_AN) continue;
    const d = jour(r.date_ecriture);
    if (!d) continue;
    const avant = premiereOrdinaire.get(c);
    if (!avant || d < avant) premiereOrdinaire.set(c, d);
  }

  const groupes = new Map<string, {
    ids: string[]; nom: string; debit: number; credit: number; minDate: string | null; ref: string; compte: string;
  }>();
  for (const r of ecritures ?? []) {
    const c = txt(r.compte_numero);
    if (!c || !estClient(c)) continue;
    if (r.lettree === true || txt(r.lettrage_code)) continue;   // soldé par lettrage
    if (r.facture_id || r.transaction_id) continue;              // pendant d'une facture / d'un relevé
    if (txt(r.journal_code).toUpperCase() === JOURNAL_AN) {
      const origine = premiereOrdinaire.get(c);
      // Une écriture ordinaire antérieure existe : l'AN n'en est que le report.
      if (origine && origine < jour(r.date_ecriture)) continue;
    }
    const piece = txt(r.reference_piece);
    if (piece && dejaRelancees.has(piece)) continue;
    const cle = piece ? `${c}|${piece}` : `${c}|#${r.id}`;
    const g = groupes.get(cle) ?? { ids: [], nom: "", debit: 0, credit: 0, minDate: null, ref: piece || c, compte: c };
    g.ids.push(r.id);
    g.debit += nb(r.debit);
    g.credit += nb(r.credit);
    if (nb(r.debit) > 0 && !g.nom) g.nom = txt(r.libelle);
    const d = jour(r.date_ecriture);
    if (d && (!g.minDate || d < g.minDate)) g.minDate = d;
    groupes.set(cle, g);
  }

  const postes: PosteReprise[] = [];
  for (const g of groupes.values()) {
    const residuel = Math.round((g.debit - g.credit) * 100) / 100;
    if (!(residuel > 0.01)) continue;                            // soldé ou sens inverse
    postes.push({ compte: g.compte, ref: g.ref, nom: g.nom, montant: residuel, date: g.minDate, ecritureIds: g.ids });
  }
  return postes;
}
