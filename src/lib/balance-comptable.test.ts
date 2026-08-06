import { describe, it, expect } from "vitest";
import {
  sousTotauxParClasse, totalGeneralBalance, resultatNetBalance, synthetiserBalance,
  ventilerSolde, CLASSES_CGNC, type LigneBalance,
} from "./balance-comptable";

/** Ligne de balance ; le solde/sens sont dérivés comme dans l'écran. */
const l = (compte: string, debit: number, credit: number): LigneBalance => ({
  compte, total_debit: debit, total_credit: credit,
  solde: Math.abs(debit - credit), sens: debit >= credit ? "D" : "C",
});

/** Dossier jouet, équilibré : achat 1000 HT + TVA, vente 3000 HT + TVA. */
const BALANCE: LigneBalance[] = [
  l("34552", 200, 0),      // TVA récupérable
  l("44551", 0, 600),      // TVA collectée
  l("44110", 0, 1200),     // fournisseurs
  l("34210", 3600, 0),     // clients
  l("61110", 1000, 0),     // achats
  l("71110", 0, 3000),     // ventes
];

describe("ventilerSolde", () => {
  it("porte le solde sur la SEULE colonne débiteur quand le débit l'emporte", () => {
    expect(ventilerSolde(l("34210", 3600, 600))).toEqual({ debiteur: 3000, crediteur: 0 });
  });

  it("porte le solde sur la SEULE colonne créditeur quand le crédit l'emporte", () => {
    expect(ventilerSolde(l("44110", 200, 1200))).toEqual({ debiteur: 0, crediteur: 1000 });
  });

  it("laisse les deux colonnes à zéro sur un compte soldé", () => {
    expect(ventilerSolde(l("51110", 5000, 5000))).toEqual({ debiteur: 0, crediteur: 0 });
  });

  it("ignore les champs solde/sens de l'appelant et recalcule depuis les cumuls", () => {
    // Ligne volontairement incohérente : le sens dit « C », les cumuls disent « D ».
    const menteuse: LigneBalance = { compte: "61110", total_debit: 900, total_credit: 100, solde: 42, sens: "C" };
    expect(ventilerSolde(menteuse)).toEqual({ debiteur: 800, crediteur: 0 });
  });
});

describe("sousTotauxParClasse", () => {
  it("produit une ligne TOTAUX par classe présente, dans l'ordre", () => {
    const st = sousTotauxParClasse(BALANCE);
    expect(st.map(s => s.label)).toEqual(["TOTAUX 3", "TOTAUX 4", "TOTAUX 6", "TOTAUX 7"]);
  });

  it("cumule débits et crédits de la classe", () => {
    const c3 = sousTotauxParClasse(BALANCE).find(s => s.classe === "3")!;
    expect(c3.nbComptes).toBe(2);            // 34552 + 34210
    expect(c3.total_debit).toBe(3800);
    expect(c3.total_credit).toBe(0);
    expect(c3.solde).toBe(3800);
    expect(c3.sens).toBe("D");
  });

  it("donne le sens créditeur quand les crédits l'emportent", () => {
    const c4 = sousTotauxParClasse(BALANCE).find(s => s.classe === "4")!;
    expect(c4.total_credit).toBe(1800);      // 44551 + 44110
    expect(c4.sens).toBe("C");
  });

  it("ventile les soldes de la classe SANS compenser entre comptes", () => {
    // Un fournisseur débiteur (avance) ne doit pas s'annuler avec un fournisseur
    // créditeur : les deux colonnes de la classe sont servies simultanément.
    const c4 = sousTotauxParClasse([l("44110", 0, 1200), l("44111", 300, 0)]).find(s => s.classe === "4")!;
    expect(c4.solde_debiteur).toBe(300);
    expect(c4.solde_crediteur).toBe(1200);
    // Le solde net historique reste la différence des deux colonnes.
    expect(c4.solde).toBe(Math.abs(c4.solde_debiteur - c4.solde_crediteur));
  });

  it("n'invente pas les classes absentes", () => {
    const classes = sousTotauxParClasse(BALANCE).map(s => s.classe);
    expect(classes).not.toContain("9");
    expect(classes).not.toContain("1");
  });

  it("porte l'intitulé CGNC de la classe", () => {
    const st = sousTotauxParClasse(BALANCE);
    expect(st.find(s => s.classe === "6")!.intitule).toBe(CLASSES_CGNC["6"]);
    expect(st.find(s => s.classe === "7")!.intitule).toBe("Produits");
  });

  it("ne perd pas un compte au numéro non numérique", () => {
    const st = sousTotauxParClasse([...BALANCE, l("", 50, 0), l("XX1", 0, 50)]);
    const inconnu = st.find(s => s.classe === "?")!;
    expect(inconnu.nbComptes).toBe(2);
    expect(inconnu.intitule).toBe("Comptes non classés");
    // Le total général reste juste : rien n'a disparu en route.
    expect(st.reduce((s, c) => s + c.total_debit, 0)).toBe(totalGeneralBalance([...BALANCE, l("", 50, 0), l("XX1", 0, 50)]).total_debit);
  });

  it("rend un tableau vide sur une balance vide", () => {
    expect(sousTotauxParClasse([])).toEqual([]);
  });
});

describe("totalGeneralBalance", () => {
  it("somme les colonnes et constate l'équilibre", () => {
    const t = totalGeneralBalance(BALANCE);
    expect(t.nbComptes).toBe(6);
    expect(t.total_debit).toBe(4800);
    expect(t.total_credit).toBe(4800);
    expect(t.ecart).toBe(0);
    expect(t.equilibre).toBe(true);
  });

  it("égalise rigoureusement les deux totaux de soldes sur une balance juste", () => {
    const t = totalGeneralBalance(BALANCE);
    expect(t.total_solde_debiteur).toBe(4800);
    expect(t.total_solde_crediteur).toBe(4800);
    expect(t.total_solde_debiteur).toBe(t.total_solde_crediteur);
    expect(t.ecart_soldes).toBe(0);
  });

  it("somme les colonnes de solde des sous-totaux jusqu'au total général", () => {
    // Le pied de balance doit être la somme des lignes TOTAUX affichées au-dessus,
    // sinon l'écran additionne autre chose que ce qu'il montre.
    const st = sousTotauxParClasse(BALANCE);
    const t = totalGeneralBalance(BALANCE);
    expect(st.reduce((s, c) => s + c.solde_debiteur, 0)).toBe(t.total_solde_debiteur);
    expect(st.reduce((s, c) => s + c.solde_crediteur, 0)).toBe(t.total_solde_crediteur);
  });

  it("répercute un déséquilibre sur les soldes autant que sur les mouvements", () => {
    const t = totalGeneralBalance([...BALANCE, l("61200", 250, 0)]);
    expect(t.ecart_soldes).toBe(250);
    expect(t.ecart_soldes).toBe(t.ecart);
    expect(t.equilibre).toBe(false);
  });

  it("signale un déséquilibre et le chiffre", () => {
    const t = totalGeneralBalance([...BALANCE, l("61200", 250, 0)]);
    expect(t.equilibre).toBe(false);
    expect(t.ecart).toBe(250);
  });

  it("absorbe le bruit d'arrondi sous le centime, mais signale un centime plein", () => {
    // Sous le centime : l'écart n'existe pas à l'échelle de la monnaie.
    expect(totalGeneralBalance([l("6", 100, 100.004)]).equilibre).toBe(true);
    // Un centime entier est un vrai déséquilibre — il doit remonter.
    const centime = totalGeneralBalance([l("6", 100, 100.01)]);
    expect(centime.equilibre).toBe(false);
    expect(centime.ecart).toBe(0.01);
  });
});

describe("resultatNetBalance", () => {
  it("calcule bénéfice = classe 7 − classe 6", () => {
    const r = resultatNetBalance(BALANCE);
    expect(r.produits).toBe(3000);
    expect(r.charges).toBe(1000);
    expect(r.resultat).toBe(2000);
    expect(r.benefice).toBe(true);
    expect(r.label).toBe("BÉNÉFICE NET");
    expect(r.montant).toBe(2000);
  });

  it("bascule en perte quand les charges dépassent les produits", () => {
    const r = resultatNetBalance([l("61110", 5000, 0), l("71110", 0, 3000)]);
    expect(r.resultat).toBe(-2000);
    expect(r.benefice).toBe(false);
    expect(r.label).toBe("PERTE NETTE");
    expect(r.montant).toBe(2000);            // affiché positif
  });

  it("prend chaque classe dans son sens naturel (un avoir diminue le résultat)", () => {
    // 7129 « RRR accordés » fonctionne au débit : il réduit le produit, il n'est
    // pas une charge.
    const r = resultatNetBalance([l("71110", 0, 3000), l("71290", 500, 0), l("61110", 1000, 0)]);
    expect(r.produits).toBe(2500);
    expect(r.charges).toBe(1000);
    expect(r.resultat).toBe(1500);
  });

  it("rend un résultat nul sans classe 6 ni 7", () => {
    const r = resultatNetBalance([l("34210", 1000, 0), l("44110", 0, 1000)]);
    expect(r.resultat).toBe(0);
    expect(r.benefice).toBe(true);
    expect(r.label).toBe("BÉNÉFICE NET");
  });
});

describe("synthetiserBalance", () => {
  it("assemble les trois blocs de pied de balance", () => {
    const s = synthetiserBalance(BALANCE);
    expect(s.sousTotaux).toHaveLength(4);
    expect(s.total.equilibre).toBe(true);
    expect(s.resultat.resultat).toBe(2000);
  });

  it("croise avec les sous-totaux : résultat = solde 7 − solde 6", () => {
    const s = synthetiserBalance(BALANCE);
    const c6 = s.sousTotaux.find(c => c.classe === "6")!;
    const c7 = s.sousTotaux.find(c => c.classe === "7")!;
    expect(s.resultat.resultat).toBe(c7.solde - c6.solde);
  });
});
