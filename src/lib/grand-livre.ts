// ============================================================================
// grand-livre.ts — Le GRAND LIVRE, en logique pure (aucune base, aucun réseau).
//
// ─── Journal ≠ Grand Livre ───────────────────────────────────────────────────
// Le Journal Général est CHRONOLOGIQUE : les écritures dans l'ordre où elles
// sont passées, tous comptes mêlés. Le Grand Livre est le même contenu REGROUPÉ
// PAR COMPTE (loi 9-88, CGNC) : chaque compte du plan est un dossier, ouvert par
// son solde initial, suivi de ses mouvements et clos par son solde final.
// Les deux présentent strictement les mêmes montants — c'est ce que vérifie
// `concordanceJournal`, et c'est ce qui rend l'un contrôlable par l'autre.
//
// ─── Le solde initial ────────────────────────────────────────────────────────
// Il est formé de deux sources, et d'elles seules :
//   • les écritures ANTÉRIEURES à la date de début de la période consultée ;
//   • les à-nouveaux (journal AN) datés DANS la période : ils ne décrivent aucune
//     opération de l'exercice, ils reportent le bilan d'ouverture. Les compter en
//     mouvements gonflerait les totaux Débit/Crédit de la période du montant du
//     bilan précédent (option `reportsEnSoldeInitial`, vraie par défaut).
//
// Convention : un solde SIGNÉ est positif quand il est débiteur.
// ============================================================================

import { classeDeCompte, normaliserNumeroCompte } from "@/lib/numero-compte";

const JOURNAL_AN = "AN";
const r2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100 || 0;
const nb = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const txt = (v: unknown) => String(v ?? "").trim();
const jour = (v: unknown) => txt(v).slice(0, 10);

/** Une écriture telle que le grand livre la lit. */
export interface LigneGrandLivre {
  id?: string;
  date_ecriture: string;
  journal_code: string;
  compte_numero: string;
  libelle?: string | null;
  debit?: number | string | null;
  credit?: number | string | null;
  reference_piece?: string | null;
  lettrage_code?: string | null;
  facture_id?: string | null;
  transaction_id?: string | null;
}

export interface OptionsGrandLivre {
  /** Première date de la période (incluse). Absente → aucune antériorité. */
  debut?: string | null;
  /** Dernière date de la période (incluse). Les écritures postérieures sont ignorées. */
  fin?: string | null;
  /** Classes PCM retenues (« 1 » … « 7 »). Vide → toutes. */
  classes?: string[];
  /** Intervalle de comptes, bornes incluses, en forme courte ou longue. */
  compteDe?: string | null;
  compteA?: string | null;
  /** Masquer les comptes dont le solde final est nul. */
  masquerSoldes?: boolean;
  /** Intitulé d'un compte (référentiel, tiers auxiliaires…). */
  intitule?: (compte: string) => string;
  /** À-nouveaux de la période en solde initial (défaut : oui). */
  reportsEnSoldeInitial?: boolean;
}

/** Un mouvement du dossier-compte, avec son solde progressif. */
export interface MouvementGrandLivre extends LigneGrandLivre {
  debit: number;
  credit: number;
  /** Solde SIGNÉ après ce mouvement, solde initial compris. */
  solde: number;
}

export interface CompteGrandLivre {
  /** Numéro canonique (8 chiffres), clé de regroupement. */
  compte: string;
  intitule: string;
  classe: string;
  initialDebit: number;
  initialCredit: number;
  /** Solde initial SIGNÉ (positif = débiteur). */
  soldeInitial: number;
  totalDebit: number;
  totalCredit: number;
  /** Solde final SIGNÉ. */
  soldeFinal: number;
  soldeDebiteur: number;
  soldeCrediteur: number;
  mouvements: MouvementGrandLivre[];
}

export interface TotauxGrandLivre {
  initialDebit: number;
  initialCredit: number;
  totalDebit: number;
  totalCredit: number;
  soldeDebiteur: number;
  soldeCrediteur: number;
}

export interface GrandLivre {
  periode: { debut: string | null; fin: string | null };
  /** Comptes AFFICHÉS, triés par numéro — après filtres et masquage. */
  comptes: CompteGrandLivre[];
  /** Totaux des comptes affichés. */
  totaux: TotauxGrandLivre;
  /** Totaux de TOUS les comptes du périmètre de dates — base du contrôle d'équilibre. */
  totauxPerimetre: TotauxGrandLivre;
  /** Σ débits = Σ crédits sur le périmètre, et Σ SD = Σ SC. */
  equilibre: boolean;
  /** Comptes retirés de l'affichage par le masquage des comptes soldés. */
  nbComptesMasques: number;
}

/** Ordre stable des mouvements : date, journal, pièce, puis ordre d'arrivée. */
function comparerMouvements(a: { l: LigneGrandLivre; i: number }, b: { l: LigneGrandLivre; i: number }): number {
  return jour(a.l.date_ecriture).localeCompare(jour(b.l.date_ecriture))
    || txt(a.l.journal_code).localeCompare(txt(b.l.journal_code))
    || txt(a.l.reference_piece).localeCompare(txt(b.l.reference_piece))
    || a.i - b.i;
}

const LARGEUR = 8;

/** Le compte appartient-il à l'intervalle [de, a] ? Bornes complétées : 3421 → 34210000 … 44119999. */
export function dansIntervalle(compte: string, de?: string | null, a?: string | null): boolean {
  const c = normaliserNumeroCompte(compte).slice(0, LARGEUR);
  const bas = txt(de) ? txt(de).padEnd(LARGEUR, "0").slice(0, LARGEUR) : "";
  const haut = txt(a) ? txt(a).padEnd(LARGEUR, "9").slice(0, LARGEUR) : "";
  return (!bas || c >= bas) && (!haut || c <= haut);
}

/** Ventile un solde signé sur les deux colonnes exclusives d'un grand livre. */
export function ventiler(soldeSigne: number): { debiteur: number; crediteur: number } {
  const s = r2(soldeSigne);
  return s >= 0 ? { debiteur: s, crediteur: 0 } : { debiteur: 0, crediteur: -s };
}

function totaliser(comptes: CompteGrandLivre[]): TotauxGrandLivre {
  const t = comptes.reduce((acc, c) => {
    acc.initialDebit += c.initialDebit; acc.initialCredit += c.initialCredit;
    acc.totalDebit += c.totalDebit; acc.totalCredit += c.totalCredit;
    acc.soldeDebiteur += c.soldeDebiteur; acc.soldeCrediteur += c.soldeCrediteur;
    return acc;
  }, { initialDebit: 0, initialCredit: 0, totalDebit: 0, totalCredit: 0, soldeDebiteur: 0, soldeCrediteur: 0 });
  return {
    initialDebit: r2(t.initialDebit), initialCredit: r2(t.initialCredit),
    totalDebit: r2(t.totalDebit), totalCredit: r2(t.totalCredit),
    soldeDebiteur: r2(t.soldeDebiteur), soldeCrediteur: r2(t.soldeCrediteur),
  };
}

/** Construit le grand livre : un dossier par compte, soldes et mouvements. */
export function construireGrandLivre(lignes: LigneGrandLivre[], opts: OptionsGrandLivre = {}): GrandLivre {
  const debut = txt(opts.debut) || null;
  const fin = txt(opts.fin) || null;
  const reports = opts.reportsEnSoldeInitial !== false;

  const parCompte = new Map<string, { initial: LigneGrandLivre[]; mvts: { l: LigneGrandLivre; i: number }[] }>();
  (lignes ?? []).forEach((l, i) => {
    const d = jour(l.date_ecriture);
    const compte = normaliserNumeroCompte(l.compte_numero);
    if (!compte) return;
    if (fin && d > fin) return;
    const cell = parCompte.get(compte) ?? { initial: [], mvts: [] };
    const anterieure = !!debut && d < debut;
    const report = reports && txt(l.journal_code).toUpperCase() === JOURNAL_AN;
    if (anterieure || report) cell.initial.push(l);
    else cell.mvts.push({ l, i });
    parCompte.set(compte, cell);
  });

  const tous: CompteGrandLivre[] = [];
  for (const [compte, { initial, mvts }] of parCompte) {
    const initialDebit = r2(initial.reduce((s, l) => s + nb(l.debit), 0));
    const initialCredit = r2(initial.reduce((s, l) => s + nb(l.credit), 0));
    let solde = r2(initialDebit - initialCredit);
    const soldeInitial = solde;
    const mouvements = mvts.sort(comparerMouvements).map(({ l }) => {
      const debit = r2(nb(l.debit));
      const credit = r2(nb(l.credit));
      solde = r2(solde + debit - credit);
      return { ...l, debit, credit, solde };
    });
    const totalDebit = r2(mouvements.reduce((s, m) => s + m.debit, 0));
    const totalCredit = r2(mouvements.reduce((s, m) => s + m.credit, 0));
    const soldeFinal = r2(soldeInitial + totalDebit - totalCredit);
    const v = ventiler(soldeFinal);
    tous.push({
      compte, intitule: opts.intitule?.(compte) ?? "", classe: classeDeCompte(compte),
      initialDebit, initialCredit, soldeInitial, totalDebit, totalCredit, soldeFinal,
      soldeDebiteur: v.debiteur, soldeCrediteur: v.crediteur, mouvements,
    });
  }
  tous.sort((a, b) => a.compte.localeCompare(b.compte));

  const totauxPerimetre = totaliser(tous);
  const classes = (opts.classes ?? []).filter(Boolean);
  const filtres = tous.filter((c) =>
    (!classes.length || classes.includes(c.classe)) && dansIntervalle(c.compte, opts.compteDe, opts.compteA));
  const comptes = opts.masquerSoldes ? filtres.filter((c) => Math.abs(c.soldeFinal) >= 0.005) : filtres;

  const t = totauxPerimetre;
  return {
    periode: { debut, fin },
    comptes,
    totaux: totaliser(comptes),
    totauxPerimetre,
    equilibre: Math.abs(r2(t.initialDebit + t.totalDebit - t.initialCredit - t.totalCredit)) < 0.01
      && Math.abs(r2(t.soldeDebiteur - t.soldeCrediteur)) < 0.01,
    nbComptesMasques: filtres.length - comptes.length,
  };
}

// ─── Concordance Journal Général ⇄ Grand Livre ───────────────────────────────

export interface ConcordanceJournal {
  journalDebit: number;
  journalCredit: number;
  grandLivreDebit: number;
  grandLivreCredit: number;
  ecartDebit: number;
  ecartCredit: number;
  /** Les deux livres portent exactement les mêmes montants. */
  ok: boolean;
}

/**
 * Σ du Journal Général (écritures jusqu'à la fin de période) contre Σ du Grand
 * Livre (soldes initiaux + mouvements de TOUS les comptes, avant filtres). Un
 * écart dit qu'une écriture est lue par l'un et pas par l'autre — compte vide,
 * date hors bornes — et c'est une anomalie, pas un arrondi.
 */
export function concordanceJournal(journal: LigneGrandLivre[], gl: GrandLivre): ConcordanceJournal {
  const fin = gl.periode.fin;
  const retenues = (journal ?? []).filter((l) => !fin || jour(l.date_ecriture) <= fin);
  const journalDebit = r2(retenues.reduce((s, l) => s + nb(l.debit), 0));
  const journalCredit = r2(retenues.reduce((s, l) => s + nb(l.credit), 0));
  const t = gl.totauxPerimetre;
  const grandLivreDebit = r2(t.initialDebit + t.totalDebit);
  const grandLivreCredit = r2(t.initialCredit + t.totalCredit);
  const ecartDebit = r2(journalDebit - grandLivreDebit);
  const ecartCredit = r2(journalCredit - grandLivreCredit);
  return {
    journalDebit, journalCredit, grandLivreDebit, grandLivreCredit, ecartDebit, ecartCredit,
    ok: Math.abs(ecartDebit) < 0.005 && Math.abs(ecartCredit) < 0.005,
  };
}

// ─── Pièce source ─────────────────────────────────────────────────────────────

export type PieceSource =
  | { type: "facture_client"; id: string }
  | { type: "transaction"; id: string }
  | { type: "facture_fournisseur"; id: string }
  | { type: "numero"; numero: string }
  | { type: "piece_comptable"; journal: string; reference: string | null; date: string };

const RX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Où chercher la pièce d'une écriture, du lien le plus sûr au plus faible.
 *
 * Observé en base : `facture_id` ne désigne que des factures CLIENT ; une
 * écriture de banque porte `transaction_id` (qui mène au justificatif, à la
 * facture ou au relevé) ; une écriture d'achat porte l'identifiant de la facture
 * fournisseur dans `reference_piece`. La pièce comptable elle-même — les lignes
 * de la même écriture — est toujours le dernier recours, et toujours disponible.
 */
export function planPieceSource(l: LigneGrandLivre): PieceSource[] {
  const plan: PieceSource[] = [];
  if (txt(l.facture_id)) plan.push({ type: "facture_client", id: txt(l.facture_id) });
  if (txt(l.transaction_id)) plan.push({ type: "transaction", id: txt(l.transaction_id) });
  const ref = txt(l.reference_piece);
  if (RX_UUID.test(ref)) plan.push({ type: "facture_fournisseur", id: ref });
  else if (ref) plan.push({ type: "numero", numero: ref });
  plan.push({ type: "piece_comptable", journal: txt(l.journal_code), reference: ref || null, date: jour(l.date_ecriture) });
  return plan;
}

/** Les lignes de la même pièce comptable : même journal, même référence, même jour. */
export function lignesDeLaPiece<T extends LigneGrandLivre>(
  lignes: T[], p: { journal: string; reference: string | null; date: string },
): T[] {
  return (lignes ?? []).filter((l) => txt(l.journal_code) === p.journal
    && (txt(l.reference_piece) || null) === p.reference && jour(l.date_ecriture) === p.date);
}

// ─── Export tabulaire (Excel) ────────────────────────────────────────────────

export interface EnteteGrandLivre {
  raisonSociale: string;
  ice?: string | null;
  identifiantFiscal?: string | null;
  rc?: string | null;
  exercice?: string | number | null;
  editeLe?: string;
}

export type CelluleExport = string | number;

/**
 * Le grand livre en tableau de lignes (feuille Excel), présentation Sage :
 * pour chaque compte, en-tête, report, mouvements, total et solde ; puis le
 * total général. Les montants restent des NOMBRES — un tableur doit pouvoir
 * les additionner.
 */
export function grandLivreEnTableau(gl: GrandLivre, e: EnteteGrandLivre): CelluleExport[][] {
  const lignes: CelluleExport[][] = [
    ["GRAND LIVRE GÉNÉRAL"],
    [e.raisonSociale],
    [[e.identifiantFiscal ? `IF : ${e.identifiantFiscal}` : "", e.ice ? `ICE : ${e.ice}` : "", e.rc ? `RC : ${e.rc}` : ""]
      .filter(Boolean).join("   ")],
    [`Exercice ${e.exercice ?? "—"} — période du ${gl.periode.debut ?? "début"} au ${gl.periode.fin ?? "ce jour"}`
      + (e.editeLe ? ` — édité le ${e.editeLe}` : "")],
    [],
    ["Compte", "Intitulé", "Date", "Journal", "N° pièce", "Libellé", "Lettrage", "Débit", "Crédit", "Solde débiteur", "Solde créditeur"],
  ];
  const soldeCellules = (s: number): CelluleExport[] => {
    const v = ventiler(s);
    return [v.debiteur || "", v.crediteur || ""];
  };
  for (const c of gl.comptes) {
    lignes.push([c.compte, c.intitule]);
    lignes.push([c.compte, c.intitule, gl.periode.debut ?? "", "", "", "Solde initial / report", "",
      c.initialDebit || "", c.initialCredit || "", ...soldeCellules(c.soldeInitial)]);
    for (const m of c.mouvements) {
      lignes.push([c.compte, c.intitule, jour(m.date_ecriture), txt(m.journal_code), txt(m.reference_piece),
        txt(m.libelle), txt(m.lettrage_code), m.debit || "", m.credit || "", ...soldeCellules(m.solde)]);
    }
    lignes.push([c.compte, c.intitule, "", "", "", `Total compte ${c.compte}`, "", c.totalDebit, c.totalCredit, "", ""]);
    lignes.push([c.compte, c.intitule, gl.periode.fin ?? "", "", "", "Solde final", "", "", "", c.soldeDebiteur || "", c.soldeCrediteur || ""]);
    lignes.push([]);
  }
  const t = gl.totaux;
  lignes.push(["", "", "", "", "", "TOTAL SOLDES INITIAUX", "", t.initialDebit, t.initialCredit, "", ""]);
  lignes.push(["", "", "", "", "", "TOTAL MOUVEMENTS DE LA PÉRIODE", "", t.totalDebit, t.totalCredit, "", ""]);
  lignes.push(["", "", "", "", "", "TOTAL GÉNÉRAL", "", r2(t.initialDebit + t.totalDebit), r2(t.initialCredit + t.totalCredit),
    t.soldeDebiteur, t.soldeCrediteur]);
  return lignes;
}
