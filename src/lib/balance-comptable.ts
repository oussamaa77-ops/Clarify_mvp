// ============================================================================
// Balance comptable — regroupement par CLASSE du plan comptable marocain (CGNC)
// et détermination du résultat net.
//
// Une balance sans sous-totaux par classe n'est pas exploitable : c'est par
// classe que se lisent la structure du bilan (1 à 5) et la formation du résultat
// (6 et 7). Le total général, lui, prouve la partie double — Σ débits = Σ crédits.
//
// Logique pure : l'écran et l'export Excel consomment le MÊME calcul, ce qui
// interdit qu'un total affiché diffère d'un total exporté.
// ============================================================================

const round2 = (x: number) => Math.round(x * 100) / 100;

function n(v: unknown): number {
  const x = Number(v);
  return isFinite(x) ? x : 0;
}

/** Une ligne de balance : un compte, ses cumuls et son solde. */
export interface LigneBalance {
  compte: string;
  total_debit: number;
  total_credit: number;
  solde: number;
  sens: "D" | "C";
}

/** Intitulés CGNC des classes de comptes. */
export const CLASSES_CGNC: Record<string, string> = {
  "1": "Financement permanent",
  "2": "Actif immobilisé",
  "3": "Actif circulant (hors trésorerie)",
  "4": "Passif circulant (hors trésorerie)",
  "5": "Trésorerie",
  "6": "Charges",
  "7": "Produits",
  "8": "Résultats",
  "9": "Comptes analytiques",
  "0": "Comptes spéciaux",
};

export interface SousTotalClasse {
  /** Chiffre de la classe (« 1 » … « 7 »). */
  classe: string;
  /** Intitulé CGNC, prêt à afficher. */
  intitule: string;
  /** Libellé de la ligne de sous-total (« TOTAUX 1 »). */
  label: string;
  nbComptes: number;
  total_debit: number;
  total_credit: number;
  /** Solde de la classe, en valeur absolue. */
  solde: number;
  sens: "D" | "C";
}

/**
 * Sous-totaux par classe, dans l'ordre des classes présentes.
 *
 * Seules les classes RÉELLEMENT mouvementées apparaissent : afficher « TOTAUX 9 »
 * à zéro sur un dossier qui n'a pas de comptabilité analytique n'apprend rien et
 * allonge la lecture. Un compte au numéro vide ou non numérique est rattaché à la
 * pseudo-classe « ? » plutôt que d'être silencieusement perdu.
 */
export function sousTotauxParClasse(balance: LigneBalance[]): SousTotalClasse[] {
  const acc = new Map<string, { nb: number; debit: number; credit: number }>();

  for (const l of balance) {
    const premier = String(l.compte ?? "").trim().charAt(0);
    const classe = /^[0-9]$/.test(premier) ? premier : "?";
    const cell = acc.get(classe) ?? { nb: 0, debit: 0, credit: 0 };
    cell.nb += 1;
    cell.debit += n(l.total_debit);
    cell.credit += n(l.total_credit);
    acc.set(classe, cell);
  }

  return [...acc.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([classe, v]) => {
      const debit = round2(v.debit);
      const credit = round2(v.credit);
      return {
        classe,
        intitule: CLASSES_CGNC[classe] ?? "Comptes non classés",
        label: `TOTAUX ${classe}`,
        nbComptes: v.nb,
        total_debit: debit,
        total_credit: credit,
        solde: round2(Math.abs(debit - credit)),
        sens: debit >= credit ? "D" : "C",
      };
    });
}

export interface TotalGeneralBalance {
  nbComptes: number;
  total_debit: number;
  total_credit: number;
  /** |Σ débits − Σ crédits| : 0 sur une balance équilibrée. */
  ecart: number;
  equilibre: boolean;
}

/** Total général — le contrôle de la partie double. */
export function totalGeneralBalance(balance: LigneBalance[]): TotalGeneralBalance {
  const total_debit = round2(balance.reduce((s, l) => s + n(l.total_debit), 0));
  const total_credit = round2(balance.reduce((s, l) => s + n(l.total_credit), 0));
  const ecart = round2(Math.abs(total_debit - total_credit));
  return { nbComptes: balance.length, total_debit, total_credit, ecart, equilibre: ecart < 0.01 };
}

export interface ResultatNet {
  /** Produits de l'exercice (classe 7), en solde créditeur. */
  produits: number;
  /** Charges de l'exercice (classe 6), en solde débiteur. */
  charges: number;
  /** Produits − charges : positif = bénéfice, négatif = perte. */
  resultat: number;
  /** Montant à afficher, toujours positif. */
  montant: number;
  benefice: boolean;
  /** « BÉNÉFICE NET » ou « PERTE NETTE ». */
  label: string;
}

/**
 * Résultat net = classe 7 − classe 6.
 *
 * Chaque classe est prise dans son SENS NATUREL : créditeur pour les produits,
 * débiteur pour les charges. Un avoir sur vente (débit en classe 7) vient donc en
 * diminution du résultat, et non en charge — ce qui est le comportement comptable
 * attendu et ce qu'une simple somme des colonnes ne donnerait pas.
 */
export function resultatNetBalance(balance: LigneBalance[]): ResultatNet {
  const soldeClasse = (classe: "6" | "7") => {
    const lignes = balance.filter((l) => String(l.compte ?? "").startsWith(classe));
    const debit = lignes.reduce((s, l) => s + n(l.total_debit), 0);
    const credit = lignes.reduce((s, l) => s + n(l.total_credit), 0);
    return classe === "7" ? credit - debit : debit - credit;
  };

  const produits = round2(soldeClasse("7"));
  const charges = round2(soldeClasse("6"));
  const resultat = round2(produits - charges);
  return {
    produits, charges, resultat,
    montant: Math.abs(resultat),
    benefice: resultat >= 0,
    label: resultat >= 0 ? "BÉNÉFICE NET" : "PERTE NETTE",
  };
}

export interface SyntheseBalance {
  sousTotaux: SousTotalClasse[];
  total: TotalGeneralBalance;
  resultat: ResultatNet;
}

/** Les trois blocs de pied de balance, calculés d'un seul appel. */
export function synthetiserBalance(balance: LigneBalance[]): SyntheseBalance {
  return {
    sousTotaux: sousTotauxParClasse(balance),
    total: totalGeneralBalance(balance),
    resultat: resultatNetBalance(balance),
  };
}
