// ============================================================================
// conformite-nouveau-dossier.test.ts — un dossier NEUF applique-t-il encore
// toutes les règles, du premier enregistrement à la déclaration de TVA ?
//
// ─── Ce que ces tests protègent, et de quoi ──────────────────────────────────
// Les tests existants vérifient chaque brique isolément : le générateur de
// ventes, la bascule de TVA, la balance, la normalisation des numéros. Aucun ne
// vérifiait l'ENCHAÎNEMENT — et c'est là que les régressions passent, parce
// qu'une brique reste juste tout en étant appelée au mauvais endroit, ou sans
// franchir la frontière qui normalise.
//
// On rejoue donc le cycle de vie complet d'un dossier vide : facture de vente,
// facture d'achat, encaissement, décaissement, déclaration. Puis on soumet
// l'intégralité du grand livre produit aux contrôles d'insertion — les VRAIS,
// pas des copies — et à la forme canonique.
//
// Trois familles de garanties :
//   1. tout compte qui atteint la base fait 8 chiffres ;
//   2. le régime des encaissements tient de bout en bout (TVA d'origine sur
//      4458/3458, exigible seulement au règlement, pas de trésorerie en OD) ;
//   3. la frontière d'écriture normalise VRAIMENT — vérifié sur `insererPiece`,
//      le point de passage de l'application comme des scripts de reprise.
//
// Le dernier bloc est d'une autre nature : il lit le CODE SOURCE et refuse
// qu'un nouveau site d'insertion apparaisse sans normaliser. C'est le seul test
// capable d'attraper la régression la plus probable — non pas « la règle est
// fausse », mais « quelqu'un a ajouté un chemin qui la contourne ».
// ============================================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  controlerEcrituresRegime, controlerTvaOrigine, controlerJournalOd,
  genererEcrituresAchat, genererOdBasculeTva,
  estTvaExigible, estTresorerieHorsOd,
  COMPTE_TVA_ATTENTE, COMPTE_TVA_EXIGIBLE,
  JOURNAUX_FACTURATION,
} from "@/lib/genererEcritures";
import { lignesEcrituresVente } from "@/lib/ecritures-vente";
import { compteTiersAuxiliaire } from "@/lib/comptes-auxiliaires";
import {
  normaliserNumeroCompte, normaliserComptesLignes, memeCompte, LARGEUR_COMPTE,
} from "@/lib/numero-compte";
import { auditComptesSuspens, type LigneBalance } from "@/lib/balance-comptable";
import { liquiderTva, construireOdDeclaration } from "@/lib/liquidation-tva";
import { insererPiece } from "./lettrage-compta.functions";

const D = "11111111-1111-1111-1111-111111111111";
const r2 = (x: number) => Math.round(x * 100) / 100;
const txt = (v: unknown) => String(v ?? "").trim();
const nb = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

/** Toute ligne du grand livre, quelle que soit la brique qui l'a produite. */
interface Ligne {
  journal_code?: string | null;
  compte_numero?: string | null;
  date_ecriture?: string | null;
  debit?: number | null;
  credit?: number | null;
  reference_piece?: string | null;
  libelle?: string | null;
}

// ─── Le cycle de vie d'un dossier neuf ──────────────────────────────────────
//
// Une vente 12 000 HT + 2 400 TVA encaissée INTÉGRALEMENT, et un achat
// 5 000 HT + 1 000 TVA payé INTÉGRALEMENT. Les deux règlements tombent dans la
// période, si bien que la déclaration doit voir 2 400 collectés et 1 000
// déductibles — ni plus (rien n'est exigible avant l'argent), ni moins.
function grandLivreNouveauDossier(): Ligne[] {
  const vente = lignesEcrituresVente({
    dossier_id: D,
    facture_id: "fac-1",
    reference: "FA-2026-0001",
    date_facture: "2026-03-10",
    montant_ht: 12000, montant_tva: 2400, montant_ttc: 14400,
    compte_client: compteTiersAuxiliaire("client", "C0001"),
    compte_produit: "7111",
    type: "facture",
  });

  const achat = genererEcrituresAchat({
    dossier_id: D,
    facture_id: "ach-1",
    reference: "ACH-0001",
    date_facture: "2026-03-12",
    montant_ht: 5000, montant_tva: 1000, montant_ttc: 6000,
    compte_charge: "61110",
    fournisseur_nom: "FOURNISSEUR TEST",
    code_auxiliaire: "F0001",
  });

  // L'encaissement client : la banque débitée, le tiers crédité.
  const encaissement: Ligne[] = [
    { journal_code: "BQ", compte_numero: "5141", date_ecriture: "2026-03-20",
      debit: 14400, credit: 0, reference_piece: "FA-2026-0001", libelle: "Encaissement FA-2026-0001" },
    { journal_code: "BQ", compte_numero: compteTiersAuxiliaire("client", "C0001"), date_ecriture: "2026-03-20",
      debit: 0, credit: 14400, reference_piece: "FA-2026-0001", libelle: "Encaissement FA-2026-0001" },
  ];
  // Le décaissement fournisseur.
  const decaissement: Ligne[] = [
    { journal_code: "BQ", compte_numero: compteTiersAuxiliaire("fournisseur", "F0001"), date_ecriture: "2026-03-25",
      debit: 6000, credit: 0, reference_piece: "ACH-0001", libelle: "Règlement ACH-0001" },
    { journal_code: "BQ", compte_numero: "5141", date_ecriture: "2026-03-25",
      debit: 0, credit: 6000, reference_piece: "ACH-0001", libelle: "Règlement ACH-0001" },
  ];

  // Les DEUX bascules — le seul chemin vers la TVA exigible.
  const basculeVente = genererOdBasculeTva({
    sens: "client", montantTva: 2400, montantTtc: 14400, montantRegle: 14400,
    date: "2026-03-20", journalReglement: "BQ", reference: "FA-2026-0001",
  });
  const basculeAchat = genererOdBasculeTva({
    sens: "fournisseur", montantTva: 1000, montantTtc: 6000, montantRegle: 6000,
    date: "2026-03-25", journalReglement: "BQ", reference: "ACH-0001",
  });

  return [
    ...vente, ...achat, ...encaissement, ...decaissement,
    ...basculeVente as Ligne[], ...basculeAchat as Ligne[],
  ] as Ligne[];
}

/** Ce que la base recevra vraiment : le grand livre passé par la frontière. */
const canonique = () => normaliserComptesLignes(grandLivreNouveauDossier());

describe("nouveau dossier — forme canonique des comptes", () => {
  it("chaque compte qui atteint la base fait 8 chiffres", () => {
    const lignes = canonique();
    expect(lignes.length).toBeGreaterThan(8);
    for (const l of lignes) {
      const c = txt(l.compte_numero);
      expect(c, `compte « ${c} » (${l.journal_code} ${l.reference_piece})`).toHaveLength(LARGEUR_COMPTE);
      expect(c).toMatch(/^[0-9]{8}$/);
    }
  });

  it("la normalisation ne DÉPLACE aucun compte — seule la longueur change", () => {
    const avant = grandLivreNouveauDossier();
    const apres = canonique();
    expect(apres).toHaveLength(avant.length);
    for (let i = 0; i < avant.length; i++) {
      expect(memeCompte(avant[i].compte_numero, apres[i].compte_numero)).toBe(true);
      // Et rien d'autre n'est touché : montants, dates, références intacts.
      expect(apres[i].debit).toBe(avant[i].debit);
      expect(apres[i].credit).toBe(avant[i].credit);
      expect(apres[i].reference_piece).toBe(avant[i].reference_piece);
      expect(apres[i].date_ecriture).toBe(avant[i].date_ecriture);
    }
  });

  it("les comptes auxiliaires, déjà canoniques, ne bougent pas", () => {
    const lignes = canonique();
    const comptes = lignes.map((l) => txt(l.compte_numero));
    expect(comptes).toContain("34210001");   // client C0001
    expect(comptes).toContain("44110001");   // fournisseur F0001
  });

  it("est idempotente : repasser la frontière ne change plus rien", () => {
    expect(normaliserComptesLignes(canonique())).toEqual(canonique());
  });
});

describe("nouveau dossier — régime des encaissements", () => {
  it("passe les contrôles d'insertion, ceux-là mêmes qui gardent la base", () => {
    const verdict = controlerEcrituresRegime(canonique() as any[]);
    expect(verdict.violations).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it("la facture ne touche QUE la TVA d'attente, jamais l'exigible", () => {
    const facturation = canonique().filter((l) =>
      JOURNAUX_FACTURATION.includes(txt(l.journal_code).toUpperCase() as any));
    expect(facturation.length).toBeGreaterThan(0);
    for (const l of facturation) {
      expect(estTvaExigible(l.compte_numero), `${l.journal_code} ${l.compte_numero}`).toBe(false);
    }
    // …et l'attente, elle, est bien mouvementée : sinon le test passerait sur
    // un dossier sans TVA du tout.
    const attente = facturation.filter((l) =>
      memeCompte(l.compte_numero, COMPTE_TVA_ATTENTE.vente)
      || memeCompte(l.compte_numero, COMPTE_TVA_ATTENTE.achat));
    expect(attente).toHaveLength(2);
  });

  it("la TVA ne devient exigible QUE par une OD de bascule", () => {
    const exigibles = canonique().filter((l) => estTvaExigible(l.compte_numero));
    expect(exigibles.length).toBeGreaterThan(0);
    for (const l of exigibles) {
      expect(txt(l.journal_code).toUpperCase()).toBe("OD");
    }
    const collectee = exigibles.filter((l) => memeCompte(l.compte_numero, COMPTE_TVA_EXIGIBLE.vente));
    const deductible = exigibles.filter((l) => memeCompte(l.compte_numero, COMPTE_TVA_EXIGIBLE.achat));
    expect(r2(collectee.reduce((s, l) => s + nb(l.credit) - nb(l.debit), 0))).toBe(2400);
    expect(r2(deductible.reduce((s, l) => s + nb(l.debit) - nb(l.credit), 0))).toBe(1000);
  });

  it("aucune trésorerie en journal OD — le chemin de la trésorerie fictive", () => {
    const od = canonique().filter((l) => txt(l.journal_code).toUpperCase() === "OD");
    for (const l of od) {
      expect(estTresorerieHorsOd(l.compte_numero), `OD ${l.compte_numero}`).toBe(false);
    }
    expect(controlerJournalOd(canonique() as any[]).ok).toBe(true);
    expect(controlerTvaOrigine(canonique() as any[]).ok).toBe(true);
  });

  it("le grand livre s'équilibre", () => {
    const lignes = canonique();
    const debit = r2(lignes.reduce((s, l) => s + nb(l.debit), 0));
    const credit = r2(lignes.reduce((s, l) => s + nb(l.credit), 0));
    expect(debit).toBe(credit);
    expect(debit).toBeGreaterThan(0);
  });

  it("aucun compte d'attente 47* : un dossier neuf s'ouvre apuré", () => {
    const parCompte = new Map<string, { d: number; c: number }>();
    for (const l of canonique()) {
      const c = txt(l.compte_numero);
      const cell = parCompte.get(c) ?? { d: 0, c: 0 };
      cell.d += nb(l.debit); cell.c += nb(l.credit);
      parCompte.set(c, cell);
    }
    const balance: LigneBalance[] = [...parCompte.entries()].map(([compte, v]) => ({
      compte, total_debit: r2(v.d), total_credit: r2(v.c),
      solde: Math.abs(r2(v.d - v.c)), sens: v.d >= v.c ? "D" : "C",
    }));
    expect(auditComptesSuspens(balance).apure).toBe(true);
  });
});

describe("nouveau dossier — la déclaration lit la position exacte", () => {
  it("déclare ce qui a été encaissé, pas ce qui a été facturé", () => {
    const liq = liquiderTva(canonique() as any[], "2026-03")!;
    expect(liq).not.toBeNull();
    expect(liq.collectee).toBe(2400);
    expect(liq.deductible).toBe(1000);
    expect(liq.net).toBe(1400);
    expect(liq.dette).toBe(true);
    expect(liq.neant).toBe(false);
  });

  it("une période SANS règlement ne déclare rien, la facture fût-elle émise", () => {
    // La facture est de mars, l'argent aussi. En février, rien n'est exigible.
    const liq = liquiderTva(canonique() as any[], "2026-02")!;
    expect(liq.collectee).toBe(0);
    expect(liq.deductible).toBe(0);
    expect(liq.neant).toBe(true);
  });

  it("l'OD de déclaration reste canonique et équilibrée après la frontière", () => {
    const liq = liquiderTva(canonique() as any[], "2026-03")!;
    const od = normaliserComptesLignes(construireOdDeclaration(liq) as any[]);
    expect(od.length).toBeGreaterThan(0);
    for (const l of od) {
      expect(txt((l as any).compte_numero)).toMatch(/^[0-9]{8}$/);
    }
    const ecart = r2(od.reduce((s, l: any) => s + nb(l.debit) - nb(l.credit), 0));
    expect(ecart).toBe(0);
  });
});

// ─── La frontière d'écriture normalise-t-elle VRAIMENT ? ────────────────────
// `insererPiece` est le passage obligé de l'application ET des scripts de
// reprise. Si lui ne normalise pas, tout le reste est décoratif.
describe("insererPiece — la frontière d'écriture", () => {
  const fauxSb = () => {
    const rows: any[] = [];
    return {
      rows,
      from: () => ({
        insert: async (r: any[]) => { rows.push(...r); return { error: null }; },
      }),
    };
  };

  const odCourte = () => [
    { journal_code: "OD", compte_numero: "4458", date_ecriture: "2026-03-20",
      libelle: "Bascule TVA", debit: 240, credit: 0, reference_piece: "FA-1" },
    { journal_code: "OD", compte_numero: "44551", date_ecriture: "2026-03-20",
      libelle: "Bascule TVA", debit: 0, credit: 240, reference_piece: "FA-1" },
  ];

  it("canonise les comptes d'une pièce saisie en forme COURTE", async () => {
    const sb = fauxSb();
    const { error } = await insererPiece(sb, D, odCourte());
    expect(error).toBeNull();
    expect(sb.rows.map((r) => r.compte_numero)).toEqual(["44580000", "44551000"]);
  });

  it("laisse intact ce qui arrive déjà canonique", async () => {
    const sb = fauxSb();
    await insererPiece(sb, D, normaliserComptesLignes(odCourte()) as any);
    expect(sb.rows.map((r) => r.compte_numero)).toEqual(["44580000", "44551000"]);
  });

  it("normalise sans rien perdre du reste de la ligne", async () => {
    const sb = fauxSb();
    await insererPiece(sb, D, odCourte());
    expect(sb.rows[0]).toMatchObject({
      dossier_id: D, journal_code: "OD", date_ecriture: "2026-03-20",
      libelle: "Bascule TVA", debit: 240, credit: 0, reference_piece: "FA-1", valide: true,
    });
  });

  it("refuse toujours une pièce non conforme — la normalisation n'affaiblit aucun verrou", async () => {
    const sb = fauxSb();
    // Trésorerie en OD : interdit, quelle que soit la longueur du compte.
    const { error } = await insererPiece(sb, D, [
      { journal_code: "OD", compte_numero: "51410000", date_ecriture: "2026-03-20",
        libelle: "x", debit: 100, credit: 0, reference_piece: "X" },
      { journal_code: "OD", compte_numero: "61410000", date_ecriture: "2026-03-20",
        libelle: "x", debit: 0, credit: 100, reference_piece: "X" },
    ]);
    expect(error).toBeTruthy();
    expect(sb.rows).toHaveLength(0);
  });

  it("refuse une pièce déséquilibrée, forme courte comprise", async () => {
    const sb = fauxSb();
    const { error } = await insererPiece(sb, D, [
      { journal_code: "OD", compte_numero: "4458", date_ecriture: "2026-03-20",
        libelle: "x", debit: 240, credit: 0, reference_piece: "X" },
    ]);
    expect(error).toBeTruthy();
    expect(sb.rows).toHaveLength(0);
  });
});

// ─── Le verrou 7 s'arme-t-il VRAIMENT à la frontière ? ──────────────────────
//
// Un verrou qui ne se déclenche jamais est pire que pas de verrou : il inspire
// une confiance qu'il ne mérite pas. `insererPiece` doit donc LIRE le grand
// livre et refuser une bascule que rien n'appuie — ce que seul un faux Supabase
// sachant répondre à un `select` peut prouver.
describe("insererPiece — verrou 7, bascule sans règlement constaté", () => {
  /** Faux Supabase qui sait rendre des lignes de trésorerie ET encaisser un insert. */
  const sbAvecGrandLivre = (tresorerie: any[]) => {
    const rows: any[] = [];
    return {
      rows,
      from() {
        let op: "select" | "insert" = "select";
        let payload: any[] = [];
        const q: any = {
          select() { op = "select"; return q; },
          insert(p: any) { op = "insert"; payload = Array.isArray(p) ? p : [p]; return q; },
          eq() { return q; },
          in() { return q; },
          then(res: any, rej: any) {
            if (op === "insert") { rows.push(...payload); return Promise.resolve({ error: null }).then(res, rej); }
            return Promise.resolve({ data: tresorerie, error: null }).then(res, rej);
          },
        };
        return q;
      },
    };
  };

  const basculeVente = (date = "2026-05-06") => [
    { journal_code: "OD", compte_numero: "4458", date_ecriture: date,
      libelle: "TVA exigible", debit: 578, credit: 0, reference_piece: "FA-2024-0892" },
    { journal_code: "OD", compte_numero: "44551", date_ecriture: date,
      libelle: "TVA exigible", debit: 0, credit: 578, reference_piece: "FA-2024-0892" },
  ];

  it("REFUSE la bascule quand le grand livre ne porte aucun règlement", async () => {
    const sb = sbAvecGrandLivre([]);
    const { error } = await insererPiece(sb, D, basculeVente());
    expect(error).toMatch(/sans règlement constaté/);
    expect(sb.rows).toHaveLength(0);
  });

  it("l'accepte dès qu'une trésorerie porte la même référence", async () => {
    const sb = sbAvecGrandLivre([{
      journal_code: "CAI", compte_numero: "34210002", date_ecriture: "2026-05-06",
      debit: 0, credit: 3468, reference_piece: "FA-2024-0892",
    }]);
    const { error } = await insererPiece(sb, D, basculeVente());
    expect(error).toBeNull();
    expect(sb.rows).toHaveLength(2);
    // …et la normalisation reste appliquée au passage.
    expect(sb.rows.map((r) => r.compte_numero)).toEqual(["44580000", "44551000"]);
  });

  it("l'accepte sur preuve par LETTRAGE, la banque n'ayant aucune référence", async () => {
    const sb = sbAvecGrandLivre([{
      journal_code: "CAI", compte_numero: "34210002", date_ecriture: "2026-05-06",
      debit: 0, credit: 3468, reference_piece: null, lettrage_code: "AA",
    }]);
    // Le code de lettrage vit dans les OPTIONS : c'est la greffe faite par
    // insererPiece qui le rend visible au contrôle.
    const { error } = await insererPiece(sb, D, basculeVente(), { lettrageCode: "AA" });
    expect(error).toBeNull();
    expect(sb.rows).toHaveLength(2);
  });

  it("REFUSE une trésorerie POSTÉRIEURE à la bascule", async () => {
    const sb = sbAvecGrandLivre([{
      journal_code: "CAI", compte_numero: "34210002", date_ecriture: "2026-07-01",
      debit: 0, credit: 3468, reference_piece: "FA-2024-0892",
    }]);
    const { error } = await insererPiece(sb, D, basculeVente("2026-05-06"));
    expect(error).toMatch(/sans règlement constaté/);
  });

  it("ne s'arme pas sur une pièce qui N'EST PAS une bascule", async () => {
    // Une déclaration ne touche pas l'attente : aucun règlement à exiger.
    const sb = sbAvecGrandLivre([]);
    const { error } = await insererPiece(sb, D, [
      { journal_code: "OD", compte_numero: "44551", date_ecriture: "2026-07-31",
        libelle: "Déclaration TVA", debit: 1880, credit: 0, reference_piece: "DECL-TVA-2026-07" },
      { journal_code: "OD", compte_numero: "4456", date_ecriture: "2026-07-31",
        libelle: "TVA due", debit: 0, credit: 1880, reference_piece: "DECL-TVA-2026-07" },
    ]);
    expect(error).toBeNull();
    expect(sb.rows).toHaveLength(2);
  });

  it("un client sans `select` laisse le verrou DÉSARMÉ, jamais bloquant", async () => {
    // Choix délibéré : une lecture impossible ne prouve rien et n'infirme rien.
    // Refuser par défaut arrêterait le régime des encaissements sur un incident.
    const rows: any[] = [];
    const sbMuet: any = { from: () => ({ insert: async (r: any[]) => { rows.push(...r); return { error: null }; } }) };
    const { error } = await insererPiece(sbMuet, D, basculeVente());
    expect(error).toBeNull();
    expect(rows).toHaveLength(2);
  });
});

// ─── Le garde-fou d'architecture ────────────────────────────────────────────
//
// La régression la plus probable n'est pas « la règle est fausse » — elle est
// verrouillée par tout ce qui précède. C'est « on a ajouté un chemin d'écriture
// qui ne passe pas par la frontière ». Aucun test de comportement ne peut
// l'attraper : le nouveau chemin n'est, par construction, couvert par aucun.
//
// On lit donc le source. Chaque insertion dans `ecritures_comptables` doit soit
// normaliser dans l'appel lui-même, soit figurer dans la liste ci-dessous avec
// sa raison. Un site nouveau fait ÉCHOUER ce test — c'est le but : son auteur
// doit choisir explicitement entre normaliser et se justifier.
describe("garde-fou d'architecture — aucun chemin d'écriture ne contourne la frontière", () => {
  const RACINE = path.resolve(__dirname, "../..");

  /**
   * Sites où la normalisation a lieu AILLEURS que dans l'argument de l'insert.
   * Chaque entrée doit dire où, sinon elle n'est qu'une dérogation déguisée.
   */
  const DEROGATIONS: Record<string, string> = {
    "src/server/lettrage-compta.functions.ts":
      "insererPiece normalise en construisant `base` (compte_numero: normaliserNumeroCompte(...)) ; "
      + "`base` et `avecPaiement` en héritent, y compris le repli sans paiement_id.",
    "src/routes/_app/dossiers.$dossierId.comptabilite.tsx":
      "saisie manuelle : normaliserNumeroCompte est appliqué au champ compte_numero "
      + "dans le littéral inséré et dans l'update.",
    "scripts/normaliser-numeros-comptes.ts":
      "ne fait que des UPDATE de compte_numero vers la forme canonique — c'est le script de migration lui-même.",
  };

  /** Fichiers à scanner : tout ce qui peut écrire dans le grand livre. */
  function fichiersSources(): string[] {
    const out: string[] = [];
    const parcourir = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) parcourir(p);
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
      }
    };
    parcourir(path.join(RACINE, "src"));
    parcourir(path.join(RACINE, "scripts"));
    return out;
  }

  /** Les insertions dans `ecritures_comptables`, avec le texte de leur appel. */
  function sitesInsertion(): { fichier: string; extrait: string }[] {
    const sites: { fichier: string; extrait: string }[] = [];
    for (const fichier of fichiersSources()) {
      const src = fs.readFileSync(fichier, "utf8");
      const rel = path.relative(RACINE, fichier).replace(/\\/g, "/");
      const re = /from\(\s*["']ecritures_comptables["']\s*\)([\s\S]{0,400})/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const suite = m[1];
        // On ne retient que les INSERTS : un select ou un update de colonne
        // autre que compte_numero ne pose pas la question.
        const insert = suite.match(/^\s*(?:as any\s*\)?)?\s*\.?\s*insert\(([\s\S]{0,300})/);
        if (!insert) continue;
        sites.push({ fichier: rel, extrait: insert[1] });
      }
    }
    return sites;
  }

  it("recense bien des sites d'insertion — sinon le garde-fou ne garde rien", () => {
    expect(sitesInsertion().length).toBeGreaterThanOrEqual(8);
  });

  it("chaque site normalise, ou est une dérogation documentée", () => {
    const fautifs: string[] = [];
    for (const s of sitesInsertion()) {
      const normalise = /normaliserComptesLignes|normaliserNumeroCompte/.test(s.extrait);
      if (normalise) continue;
      if (DEROGATIONS[s.fichier]) continue;
      fautifs.push(`${s.fichier} → insert(${s.extrait.slice(0, 80).replace(/\s+/g, " ").trim()}…)`);
    }
    expect(
      fautifs,
      "Nouveau chemin d'écriture sans normalisation. Enveloppez l'argument dans "
      + "normaliserComptesLignes(...), ou ajoutez une dérogation JUSTIFIÉE à DEROGATIONS "
      + "dans ce test si la normalisation a lieu ailleurs.",
    ).toEqual([]);
  });

  it("aucune dérogation ne survit à la disparition de son fichier", () => {
    // Une dérogation orpheline finirait par couvrir un fichier recréé pour un
    // autre usage, sans que personne ne relise sa justification.
    for (const rel of Object.keys(DEROGATIONS)) {
      expect(fs.existsSync(path.join(RACINE, rel)), `dérogation orpheline : ${rel}`).toBe(true);
    }
  });

  it("la frontière est bien la fonction que les dérogations invoquent", () => {
    const src = fs.readFileSync(
      path.join(RACINE, "src/server/lettrage-compta.functions.ts"), "utf8");
    expect(src).toMatch(/compte_numero:\s*normaliserNumeroCompte\(/);
  });
});

// ─── Un compte hors norme ne peut plus entrer, où qu'il naisse ──────────────
describe("robustesse de la forme canonique", () => {
  it("les longueurs mêlées de l'ancienne base se réconcilient", () => {
    const anciennes = ["5141", "44551", "34552", "4458", "3458", "4456", "4712", "61254"];
    for (const c of anciennes) {
      const canon = normaliserNumeroCompte(c);
      expect(canon).toHaveLength(LARGEUR_COMPTE);
      expect(memeCompte(c, canon)).toBe(true);
    }
  });

  it("un compte de tiers reste rattaché à son collectif après normalisation", () => {
    expect(normaliserNumeroCompte(compteTiersAuxiliaire("client", "C0007")).startsWith("3421")).toBe(true);
    expect(normaliserNumeroCompte(compteTiersAuxiliaire("fournisseur", "F0007")).startsWith("4411")).toBe(true);
    // Le collectif seul, complété, ne devient PAS un auxiliaire.
    expect(normaliserNumeroCompte("4411")).toBe("44110000");
    expect(memeCompte("44110000", "44110007")).toBe(false);
  });
});
