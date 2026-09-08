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

/**
 * Ventilation du solde d'un compte sur DEUX colonnes (norme Sage 100 / CGNC) :
 * un compte alimente soit « solde débiteur », soit « solde créditeur », jamais
 * les deux. C'est cette ventilation — et non un badge de sens — qui rend les
 * colonnes additionnables, donc la balance contrôlable.
 *
 * Le solde est recalculé depuis les cumuls plutôt que lu dans `solde`/`sens` :
 * les deux champs sont dérivés côté appelant et ne peuvent pas servir de source
 * de vérité pour un total.
 */
export function ventilerSolde(l: LigneBalance): { debiteur: number; crediteur: number } {
  const delta = round2(n(l.total_debit) - n(l.total_credit));
  return delta >= 0 ? { debiteur: delta, crediteur: 0 } : { debiteur: 0, crediteur: -delta };
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
  /** Σ des soldes DÉBITEURS des comptes de la classe (colonne Sage). */
  solde_debiteur: number;
  /** Σ des soldes CRÉDITEURS des comptes de la classe (colonne Sage). */
  solde_crediteur: number;
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
  const acc = new Map<string, { nb: number; debit: number; credit: number; sd: number; sc: number }>();

  for (const l of balance) {
    const premier = String(l.compte ?? "").trim().charAt(0);
    const classe = /^[0-9]$/.test(premier) ? premier : "?";
    const cell = acc.get(classe) ?? { nb: 0, debit: 0, credit: 0, sd: 0, sc: 0 };
    const { debiteur, crediteur } = ventilerSolde(l);
    cell.nb += 1;
    cell.debit += n(l.total_debit);
    cell.credit += n(l.total_credit);
    // Ventilation ligne à ligne, jamais sur le net de la classe : un fournisseur
    // débiteur ne doit pas être compensé par un fournisseur créditeur.
    cell.sd += debiteur;
    cell.sc += crediteur;
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
        solde_debiteur: round2(v.sd),
        solde_crediteur: round2(v.sc),
      };
    });
}

export interface TotalGeneralBalance {
  nbComptes: number;
  total_debit: number;
  total_credit: number;
  /** Σ des soldes débiteurs de tous les comptes. */
  total_solde_debiteur: number;
  /** Σ des soldes créditeurs de tous les comptes. */
  total_solde_crediteur: number;
  /** |Σ débits − Σ crédits| : 0 sur une balance équilibrée. */
  ecart: number;
  /** |Σ soldes débiteurs − Σ soldes créditeurs| — égal à `ecart`, cf. ci-dessous. */
  ecart_soldes: number;
  equilibre: boolean;
}

/**
 * Total général — le double contrôle de la partie double.
 *
 * Les deux couples de colonnes doivent s'égaliser : Σ débits = Σ crédits ET
 * Σ soldes débiteurs = Σ soldes créditeurs. Ce n'est pas une coïncidence mais
 * une identité — Σ SD − Σ SC = Σ(Dᵢ − Cᵢ) = Σ D − Σ C — donc `ecart_soldes`
 * vaut toujours `ecart` : les soldes ne s'égalisent que si les mouvements
 * s'égalisent. On calcule quand même les deux séparément pour que l'écran
 * affiche l'anomalie plutôt que de la masquer par un total recopié.
 */
export function totalGeneralBalance(balance: LigneBalance[]): TotalGeneralBalance {
  const total_debit = round2(balance.reduce((s, l) => s + n(l.total_debit), 0));
  const total_credit = round2(balance.reduce((s, l) => s + n(l.total_credit), 0));
  const total_solde_debiteur = round2(balance.reduce((s, l) => s + ventilerSolde(l).debiteur, 0));
  const total_solde_crediteur = round2(balance.reduce((s, l) => s + ventilerSolde(l).crediteur, 0));
  const ecart = round2(Math.abs(total_debit - total_credit));
  const ecart_soldes = round2(Math.abs(total_solde_debiteur - total_solde_crediteur));
  return {
    nbComptes: balance.length,
    total_debit, total_credit,
    total_solde_debiteur, total_solde_crediteur,
    ecart, ecart_soldes,
    equilibre: ecart < 0.01 && ecart_soldes < 0.01,
  };
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


// ── Contrôle d'arrêté : les comptes d'ATTENTE non apurés ─────────────────────
//
// Un compte de la classe 47 (« comptes transitoires ou d'attente ») n'a pas
// vocation à porter un solde. Il sert de PARKING : le rapprochement bancaire y
// pose les transactions sans pièce justificative — 4711 au débit, 4712 au
// crédit (cf. src/lib/comptabilite-bq.ts) — en attendant qu'on les impute.
//
// Le laisser garni à la clôture n'est pas une imprécision de présentation, et
// c'est pourquoi ce contrôle existe :
//
//   • l'à-nouveau REPORTE le solde (classe 4 = bilan), donc l'attente traverse
//     l'exercice et le nouvel exercice ouvre déjà en anomalie ;
//   • la charge ou le produit correspondant n'a jamais été comptabilisé : le
//     résultat de l'exercice qu'on arrête est FAUX du montant parqué ;
//   • aucun écran ne le disait — un 4712 créditeur se lit comme une dette
//     ordinaire au milieu des fournisseurs.
//
// Le contrôle ALERTE, il ne bloque pas. Un arrêté peut légitimement se faire
// avec une attente résiduelle (une pièce manquante qu'on obtiendra), et refuser
// l'à-nouveau laisserait le dossier sans exercice ouvert — bien pire que le
// défaut signalé. La décision reste au comptable ; ce qui n'est plus permis,
// c'est de ne pas la voir.

/** Racine PCM des comptes transitoires ou d'attente. */
export const RACINE_COMPTES_SUSPENS = "47";

/**
 * Comptes d'attente posés automatiquement par le rapprochement bancaire.
 * Ce sont les seuls que l'application ALIMENTE seule : ils méritent d'être
 * nommés, parce qu'un solde résiduel y désigne un travail inachevé et non un
 * choix de comptabilisation.
 */
export const COMPTES_ATTENTE_BANQUE = ["4711", "4712"] as const;

/** Un compte d'attente qui porte encore un solde à l'arrêté. */
export interface CompteSuspens {
  /** Numéro tel qu'il figure en balance. */
  compte: string;
  /** Solde, en valeur absolue. */
  solde: number;
  sens: "D" | "C";
  /** Posé par le rapprochement bancaire (4711 / 4712) ? */
  attenteBancaire: boolean;
  /** Grief en clair, prêt à afficher. */
  message: string;
}

/**
 * Comptes d'attente (47*) non apurés, du plus lourd au plus léger.
 *
 * Le solde est recalculé depuis les cumuls — jamais lu dans `solde`/`sens`, qui
 * sont dérivés côté appelant (même raison que `ventilerSolde`).
 *
 * La détection se fait par RACINE et non par égalité : le plan réel emploie des
 * sous-comptes, et « 47120000 » comme « 4712 » désignent le même parking. C'est
 * aussi ce qui rend le contrôle insensible à la normalisation des numéros de
 * comptes sur 8 chiffres (cf. src/lib/numero-compte.ts).
 */
export function comptesSuspensNonApures(
  balance: LigneBalance[],
  options: { seuil?: number } = {},
): CompteSuspens[] {
  const seuil = options.seuil ?? 0.01;
  const out: CompteSuspens[] = [];

  for (const l of balance ?? []) {
    const compte = String(l.compte ?? "").trim();
    if (!compte.startsWith(RACINE_COMPTES_SUSPENS)) continue;
    const delta = round2(n(l.total_debit) - n(l.total_credit));
    if (Math.abs(delta) < seuil) continue;

    const sens: "D" | "C" = delta > 0 ? "D" : "C";
    const solde = Math.abs(delta);
    const attenteBancaire = COMPTES_ATTENTE_BANQUE.some((c) => compte.startsWith(c));
    out.push({
      compte, solde, sens, attenteBancaire,
      message: attenteBancaire
        ? `Compte d'attente bancaire ${compte} non apuré : ${solde.toFixed(2)} MAD `
          + `au ${sens === "D" ? "débit" : "crédit"}. Ces mouvements de banque n'ont `
          + "reçu aucune pièce justificative — la charge ou le produit correspondant "
          + "manque au résultat de l'exercice."
        : `Compte transitoire ${compte} non apuré : ${solde.toFixed(2)} MAD `
          + `au ${sens === "D" ? "débit" : "crédit"}. Un compte de la classe 47 doit `
          + "être soldé à la clôture ; sinon l'attente est reportée à l'exercice suivant.",
    });
  }

  return out.sort((a, b) => b.solde - a.solde);
}

/** Bilan du contrôle des comptes d'attente, pour un pied de balance ou un arrêté. */
export interface AuditSuspens {
  comptes: CompteSuspens[];
  /** Σ des soldes en valeur absolue — l'ampleur de ce qui reste à imputer. */
  total: number;
  /** `true` quand aucun compte 47 ne porte de solde : l'arrêté est propre. */
  apure: boolean;
  /** Résumé en une phrase, ou `null` si rien à signaler. */
  alerte: string | null;
}

/**
 * Le contrôle, sous la forme qu'un écran ou un script d'arrêté consomme.
 *
 * `apure: true` sur un dossier sans aucun compte 47 : l'absence d'attente et
 * l'attente soldée sont le même état comptable, et les distinguer obligerait
 * chaque appelant à traiter deux cas pour un seul verdict.
 */
export function auditComptesSuspens(
  balance: LigneBalance[],
  options: { seuil?: number } = {},
): AuditSuspens {
  const comptes = comptesSuspensNonApures(balance, options);
  const total = round2(comptes.reduce((s, c) => s + c.solde, 0));
  if (!comptes.length) return { comptes, total: 0, apure: true, alerte: null };

  const liste = comptes.map((c) => `${c.compte} (${c.solde.toFixed(2)} ${c.sens})`).join(", ");
  return {
    comptes, total, apure: false,
    alerte: `${comptes.length} compte(s) d'attente non apuré(s) pour ${total.toFixed(2)} MAD : `
      + `${liste}. À imputer AVANT l'arrêté : la classe 47 est reportée à `
      + "l'exercice suivant par l'à-nouveau, et le résultat arrêté est faux d'autant.",
  };
}

// ── Le résultat DÉFINITIF, et ce que l'attente lui retire ────────────────────

export interface ResultatDefinitif {
  /** Le résultat tel que la balance le donne aujourd'hui. */
  provisoire: ResultatNet;
  /** Σ des soldes 47* non apurés, en valeur absolue. */
  enAttente: number;
  /**
   * Le résultat est-il DÉFINITIF ? `false` dès qu'un compte d'attente porte un
   * solde : la charge ou le produit correspondant n'est pas encore imputé.
   */
  definitif: boolean;
  /**
   * Fourchette dans laquelle le résultat définitif tombera, une fois l'attente
   * imputée. Bornes = provisoire ∓ l'attente, car on ignore de quel côté du
   * compte de résultat elle ira — c'est justement ce qu'on ne sait pas.
   */
  borneBasse: number;
  borneHaute: number;
  /** Ce qu'il faut dire à l'écran ou en pied d'état. `null` si rien à signaler. */
  reserve: string | null;
}

/**
 * Le résultat, assorti de la RÉSERVE que les comptes d'attente lui imposent.
 *
 * ─── Pourquoi ne rien imputer d'office ──────────────────────────────────────
 * Un solde de la classe 47 est de l'argent dont on ne sait pas encore la nature.
 * Sur SMERT WATER, le 47120000 porte 41 500 MAD depuis le 31/07/2024 : un
 * « ENCAISSEMENT EFFET N 7402907 TIRE SUR ATW », authentique — il figure sur un
 * relevé — mais qui ne correspond au montant d'AUCUNE facture du dossier. Le
 * ranger d'autorité en produit gonflerait le résultat de 41 500 MAD, en charge il
 * le creuserait d'autant, et le lettrer sur une créance au prétexte qu'elle est
 * du même ordre de grandeur fabriquerait un encaissement qui n'a pas eu lieu.
 *
 * Aucune de ces trois erreurs n'est meilleure que la quatrième option, la seule
 * honnête : NE PAS L'IMPUTER, dire que le résultat n'est pas définitif, et donner
 * la fourchette. Un chiffre assorti de sa réserve est utilisable ; un chiffre
 * faux ne l'est pas.
 *
 * La fourchette est symétrique parce que l'ignorance l'est : tant que la pièce
 * n'est pas retrouvée, l'encaissement peut aussi bien être un produit oublié
 * qu'un remboursement de dette — le premier ajoute au résultat, le second n'y
 * touche pas, et un avoir client le retrancherait.
 */
export function resultatDefinitif(balance: LigneBalance[]): ResultatDefinitif {
  const provisoire = resultatNetBalance(balance);
  const suspens = auditComptesSuspens(balance);
  const enAttente = round2(suspens.total);

  if (suspens.apure) {
    return {
      provisoire, enAttente: 0, definitif: true,
      borneBasse: provisoire.resultat, borneHaute: provisoire.resultat, reserve: null,
    };
  }

  const comptes = suspens.comptes.map((c) => c.compte).join(", ");
  return {
    provisoire, enAttente, definitif: false,
    borneBasse: round2(provisoire.resultat - enAttente),
    borneHaute: round2(provisoire.resultat + enAttente),
    reserve:
      `Résultat NON DÉFINITIF : ${enAttente.toFixed(2)} MAD restent en attente `
      + `d'imputation (${comptes}). Tant que la pièce justificative n'est pas `
      + `identifiée, le résultat se situe entre ${round2(provisoire.resultat - enAttente).toFixed(2)} `
      + `et ${round2(provisoire.resultat + enAttente).toFixed(2)} MAD. `
      + "Ce solde n'est imputé d'office nulle part : le ranger au hasard en produit "
      + "ou en charge fausserait le résultat du même montant qu'il est censé corriger.",
  };
}

export interface SyntheseBalance {
  sousTotaux: SousTotalClasse[];
  total: TotalGeneralBalance;
  resultat: ResultatNet;
  /** Contrôle d'audit des comptes d'attente (47*) — vide quand tout est apuré. */
  suspens: AuditSuspens;
  /** Le résultat assorti de sa réserve d'attente (cf. `resultatDefinitif`). */
  definitif: ResultatDefinitif;
}

/** Les blocs de pied de balance, calculés d'un seul appel. */
export function synthetiserBalance(balance: LigneBalance[]): SyntheseBalance {
  return {
    sousTotaux: sousTotauxParClasse(balance),
    total: totalGeneralBalance(balance),
    resultat: resultatNetBalance(balance),
    suspens: auditComptesSuspens(balance),
    definitif: resultatDefinitif(balance),
  };
}
