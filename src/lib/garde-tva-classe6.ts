// ============================================================================
// garde-tva-classe6.ts — la TVA RÉCUPÉRABLE ne touche JAMAIS une charge.
//
// ─── La règle (CGNC / PCM marocain) ─────────────────────────────────────────
// La TVA récupérable est une CRÉANCE sur l'État : elle vit au bilan, sur 3455x
// (déductible exigible) ou 3458 (en attente), et la TVA facturée sur 4455x /
// 4458, soldées par 4456. Débitée en classe 6, elle gonfle les charges du
// montant qu'on déduira par ailleurs — le résultat est faux, et la déclaration
// déduit une TVA déjà passée en charge.
//
// Seule exception, explicite : la TVA NON récupérable (CGI art. 106 — carburant,
// frais de réception…) est un COÛT et s'incorpore légitimement à la charge. Elle
// doit alors le DIRE dans son libellé (« non récupérable » / « non déductible »).
//
// ─── Comment on la reconnaît sans numéro de compte ──────────────────────────
// Une ligne de classe 6 n'a rien, dans son numéro, qui trahisse la TVA : c'est
// son LIBELLÉ qui le fait. Les générateurs de l'application nomment toutes leurs
// lignes de TVA de la même façon (« TVA en attente … », « TVA … » en banque,
// « Bascule TVA … », « TVA déductible … ») : un libellé qui COMMENCE par TVA, ou
// qui en désigne une nature récupérable, sur un compte 6xxx, est une TVA mal
// imputée. On ne signale PAS un libellé qui la mentionne en passant (« Frais de
// tenue de compte HT, TVA 10 % à part ») : bloquer une clôture bancaire pour un
// mot serait pire que le défaut surveillé.
//
// Logique pure — aucun accès base.
// ============================================================================

export interface LigneControleeTva {
  compte_numero?: string | null;
  libelle?: string | null;
  debit?: number | string | null;
  credit?: number | string | null;
  reference_piece?: string | null;
  journal_code?: string | null;
  date_ecriture?: string | null;
}

const txt = (v: unknown) => String(v ?? "").trim();
const nb = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

/** Libellé qui POSE une ligne de TVA (et non qui la cite en passant). */
const RX_LIGNE_TVA = new RegExp(
  [
    String.raw`^\s*(?:bascule\s+)?t\.?\s?v\.?\s?a\b`,
    String.raw`\bt\.?\s?v\.?\s?a\s+(?:d[ée]ductible|r[ée]cup[ée]rable|collect[ée]e|factur[ée]e|exigible|en\s+attente|sur\s+(?:achats?|ventes?|encaissements?|immobilisations?))`,
    String.raw`taxe\s+sur\s+la\s+valeur\s+ajout[ée]e`,
  ].join("|"),
  "i",
);

/** La TVA non récupérable est un coût : elle a le droit d'être en classe 6. */
const RX_TVA_COUT = /non[\s-]*(?:r[ée]cup[ée]rable|d[ée]ductible)/i;

/** Un compte de charge (classe 6). */
export const estCompteDeCharge = (compte: string | null | undefined): boolean =>
  /^6/.test(txt(compte));

/** Cette ligne impute-t-elle de la TVA récupérable sur une charge ? */
export function estTvaEnClasse6(l: LigneControleeTva): boolean {
  if (!estCompteDeCharge(l.compte_numero)) return false;
  if (Math.abs(nb(l.debit)) < 0.005 && Math.abs(nb(l.credit)) < 0.005) return false;
  const lib = txt(l.libelle);
  return RX_LIGNE_TVA.test(lib) && !RX_TVA_COUT.test(lib);
}

export interface ControleTvaClasse6 {
  ok: boolean;
  violations: string[];
  /** Les lignes fautives, pour situer le défaut. */
  lignes: LigneControleeTva[];
}

/** Contrôle NON bloquant : rend les griefs, laisse l'appelant décider. */
export function controlerTvaHorsClasse6(lignes: LigneControleeTva[]): ControleTvaClasse6 {
  const fautives = (lignes ?? []).filter(estTvaEnClasse6);
  const violations = fautives.map((l) => {
    const montant = nb(l.debit) - nb(l.credit);
    return `TVA récupérable imputée en classe 6 : ${txt(l.compte_numero)} `
      + `« ${txt(l.libelle).slice(0, 80)} » (${montant.toFixed(2)} MAD`
      + `${l.reference_piece ? `, pièce ${txt(l.reference_piece)}` : ""}). `
      + "La TVA déductible va au 3455x / 3458, la TVA facturée au 4455x / 4458 : "
      + "en charge, elle fausse le résultat du montant qu'on déduit par ailleurs. "
      + "Une TVA réellement NON récupérable (CGI art. 106) doit le dire dans son libellé.";
  });
  return { ok: violations.length === 0, violations, lignes: fautives };
}

/** Même contrôle, BLOQUANT — pour le calcul d'un bilan ou d'une clôture. */
export function assertTvaHorsClasse6(lignes: LigneControleeTva[], contexte = "Calcul refusé"): void {
  const c = controlerTvaHorsClasse6(lignes);
  if (!c.ok) throw new Error(`${contexte} — ${c.violations.join(" ")}`);
}
