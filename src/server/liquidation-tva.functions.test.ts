import { describe, it, expect } from "vitest";
import {
  executerDeclarationTva, executerEnregistrementQuittance, executerPaiementDgi,
  executerPointageTva, liquiderPeriodeTva, lireEtatPeriodeTva,
} from "./liquidation-tva.functions";

// Comparaison de comptes par `memeCompte` et non par égalité stricte : depuis
// la normalisation sur 8 chiffres, les lignes INSÉRÉES par le code ressortent
// canoniques (« 44560000 ») tandis que les fixtures restent en forme courte
// (« 4456 »). `memeCompte` reconnaît les deux, donc le test dit ce qu'il veut
// dire — « le compte de TVA due » — au lieu d'une longueur.
import { memeCompte } from "@/lib/numero-compte";

/**
 * Faux Supabase sur deux tables en mémoire : le grand livre et les lignes de
 * relevé.
 *
 * `sansTracabilite` rejoue la base RÉELLE tant que la migration 20260809130000
 * n'est pas appliquée : un select nommant `pointe` part en erreur 42703. C'est
 * le cas le plus probable en production sur ce poste — il mérite d'être testé
 * autant que le chemin nominal.
 */
function fakeSb(
  initial: any[],
  opts: { erreur?: boolean; sansTracabilite?: boolean; transactions?: any[] } = {},
) {
  const rows = initial.map((r) => ({ dossier_id: "D1", ...r }));
  const transactions = (opts.transactions ?? []).map((t) => ({ ...t }));
  const toucheTracabilite = (cles: string[]) =>
    cles.some((c) => c === "pointe" || c === "pointe_le" || c.startsWith("quittance_"));

  return {
    rows, transactions,
    from(table: string) {
      const cible: any[] = table === "transactions_bancaires" ? transactions : rows;
      const filtres: ((r: any) => boolean)[] = [];
      let op: "select" | "insert" | "update" = "select";
      let inserted: any[] = [];
      let patch: any = null;
      let colonnes = "";
      let unique = false;

      const absente = { data: null, error: { code: "42703", message: 'column "pointe" does not exist' } };
      const executer = () => {
        if (opts.erreur) return { data: null, error: { message: "base indisponible" } };
        if (op === "insert") { cible.push(...inserted); return { data: inserted, error: null }; }
        if (opts.sansTracabilite && op === "select" && toucheTracabilite(colonnes.split(","))) return absente;

        const vises = cible.filter((r) => filtres.every((f) => f(r)));
        if (op === "update") {
          if (opts.sansTracabilite && toucheTracabilite(Object.keys(patch ?? {}))) return absente;
          for (const r of vises) Object.assign(r, patch);
          return { data: vises, error: null };
        }
        return unique ? { data: vises[0] ?? null, error: null } : { data: vises, error: null };
      };

      const q: any = {
        select(c?: string) { if (op === "select") colonnes = c ?? ""; return q; },
        insert(p: any) { op = "insert"; inserted = Array.isArray(p) ? p : [p]; return q; },
        update(p: any) { op = "update"; patch = p; return q; },
        eq(c: string, v: any) { filtres.push((r) => String(r[c] ?? "") === String(v)); return q; },
        like(c: string, motif: string) {
          const prefixe = String(motif).replace(/%/g, "");
          filtres.push((r) => String(r[c] ?? "").startsWith(prefixe));
          return q;
        },
        maybeSingle() { unique = true; return q; },
        then(res: any, rej: any) { return Promise.resolve(executer()).then(res, rej); },
      };
      return q;
    },
  };
}

const D = "11111111-1111-1111-1111-111111111111";
const MARS = [
  { journal_code: "OD", compte_numero: "44551", date_ecriture: "2026-03-05", debit: 0, credit: 12000, dossier_id: D },
  { journal_code: "OD", compte_numero: "34552", date_ecriture: "2026-03-12", debit: 4500, credit: 0, dossier_id: D },
];

describe("lireEtatPeriodeTva", () => {
  it("rend la position de la période et son bouclage", async () => {
    const e = await lireEtatPeriodeTva(fakeSb(MARS), { dossierId: D, periode: "2026-03" });
    expect(e.ok).toBe(true);
    expect(e.liquidation).toMatchObject({ collectee: 12000, deductible: 4500, net: 7500 });
    expect(e.declaree).toBe(false);
    expect(e.bouclee).toBe(false);
  });

  it("refuse une période illisible sans toucher la base", async () => {
    const e = await lireEtatPeriodeTva(fakeSb(MARS), { dossierId: D, periode: "mars" });
    expect(e.ok).toBe(false);
    expect(e.raison).toMatch(/Période illisible/);
  });

  it("remonte l'échec de lecture au lieu d'annoncer « néant »", async () => {
    const e = await lireEtatPeriodeTva(fakeSb(MARS, { erreur: true }), { dossierId: D, periode: "2026-03" });
    expect(e.ok).toBe(false);
    expect(e.raison).toMatch(/indisponible/);
  });
});

describe("executerDeclarationTva", () => {
  it("génère l'OD équilibrée et constate la dette au 4456", async () => {
    const sb = fakeSb(MARS);
    const r = await executerDeclarationTva(sb, { dossierId: D, periode: "2026-03" });
    expect(r.ok).toBe(true);
    expect(r.lignesInserees).toBe(3);
    expect(r).toMatchObject({ montant: 7500, dette: true });

    const od = sb.rows.filter((l) => l.reference_piece === "DECL-TVA-2026-03");
    const debit = od.reduce((s, l) => s + Number(l.debit ?? 0), 0);
    const credit = od.reduce((s, l) => s + Number(l.credit ?? 0), 0);
    expect(debit).toBeCloseTo(credit, 2);
    expect(od.find((l) => memeCompte(l.compte_numero, "4456"))).toMatchObject({ credit: 7500 });
  });

  it("REFUSE de déclarer deux fois la même période", async () => {
    const sb = fakeSb(MARS);
    await executerDeclarationTva(sb, { dossierId: D, periode: "2026-03" });
    const r2 = await executerDeclarationTva(sb, { dossierId: D, periode: "2026-03" });
    expect(r2.ok).toBe(false);
    expect(r2.raison).toMatch(/déjà déclarée/);
    // La dette n'a pas doublé.
    expect(sb.rows.filter((l) => memeCompte(l.compte_numero, "4456"))).toHaveLength(1);
  });

  it("ne génère rien sur une période néant, et le dit", async () => {
    const sb = fakeSb([]);
    const r = await executerDeclarationTva(sb, { dossierId: D, periode: "2026-03" });
    expect(r.ok).toBe(true);
    expect(r.lignesInserees).toBe(0);
    expect(r.raison).toMatch(/néant/i);
  });

  it("n'écrit rien en simulation", async () => {
    const sb = fakeSb(MARS);
    const r = await executerDeclarationTva(sb, { dossierId: D, periode: "2026-03", simulation: true });
    expect(r.ok).toBe(true);
    expect(r.montant).toBe(7500);
    expect(sb.rows).toHaveLength(2);
  });

  it("gère le crédit de TVA sans produire de montant négatif", async () => {
    const sb = fakeSb([
      { journal_code: "OD", compte_numero: "44551", date_ecriture: "2026-03-05", debit: 0, credit: 1000, dossier_id: D },
      { journal_code: "OD", compte_numero: "34552", date_ecriture: "2026-03-05", debit: 4000, credit: 0, dossier_id: D },
    ]);
    const r = await executerDeclarationTva(sb, { dossierId: D, periode: "2026-03" });
    expect(r).toMatchObject({ ok: true, montant: 3000, dette: false });
    expect(sb.rows.find((l) => memeCompte(l.compte_numero, "4456"))).toMatchObject({ debit: 3000 });
  });
});

describe("executerPaiementDgi", () => {
  const declarer = async () => {
    const sb = fakeSb(MARS);
    await executerDeclarationTva(sb, { dossierId: D, periode: "2026-03" });
    return sb;
  };

  it("éteint la dette et ramène le 4456 à zéro", async () => {
    const sb = await declarer();
    const r = await executerPaiementDgi(sb, { dossierId: D, periode: "2026-03", date: "2026-03-31" });
    expect(r).toMatchObject({ ok: true, montant: 7500, resteApres: 0, lignesInserees: 2 });

    const etat = await lireEtatPeriodeTva(sb, { dossierId: D, periode: "2026-03" });
    expect(etat.bouclee).toBe(true);
    expect(etat.resteAPayer).toBe(0);
  });

  it("REFUSE de payer une période non déclarée", async () => {
    const r = await executerPaiementDgi(fakeSb(MARS), { dossierId: D, periode: "2026-03", date: "2026-03-31" });
    expect(r.ok).toBe(false);
    expect(r.raison).toMatch(/n'est pas déclarée/);
  });

  it("REFUSE un montant supérieur à la dette — le 4456 deviendrait débiteur", async () => {
    const sb = await declarer();
    const r = await executerPaiementDgi(sb, { dossierId: D, periode: "2026-03", date: "2026-03-31", montant: 9000 });
    expect(r.ok).toBe(false);
    expect(r.raison).toMatch(/supérieur à la dette/);
  });

  it("accepte un paiement PARTIEL et laisse le reste au 4456", async () => {
    const sb = await declarer();
    const r = await executerPaiementDgi(sb, { dossierId: D, periode: "2026-03", date: "2026-03-31", montant: 2500 });
    expect(r).toMatchObject({ ok: true, resteApres: 5000 });
    const etat = await lireEtatPeriodeTva(sb, { dossierId: D, periode: "2026-03" });
    expect(etat.resteAPayer).toBe(5000);
    expect(etat.bouclee).toBe(false);
  });

  it("ne fait rien quand la dette est déjà soldée, et dit quel règlement l'a soldée", async () => {
    const sb = await declarer();
    await executerPaiementDgi(sb, { dossierId: D, periode: "2026-03", date: "2026-03-31" });
    const r = await executerPaiementDgi(sb, { dossierId: D, periode: "2026-03", date: "2026-03-31" });
    expect(r.ok).toBe(true);
    expect(r.lignesInserees).toBe(0);
    expect(r.raison).toMatch(/déjà été réglée \(7500\.00 MAD le 2026-03-31\)/);
  });

  // ─── Le prélèvement tombe le mois SUIVANT — le cas normal, en fait ─────────
  // La TVA de mars se paie en avril. Le solde du 4456 arrêté au 31 mars ignore
  // ce règlement : s'y fier laissait la période éternellement « à payer » et
  // autorisait un second prélèvement pour la même déclaration.
  describe("règlement postérieur à la période", () => {
    const payerEnAvril = async () => {
      const sb = await declarer();
      const r = await executerPaiementDgi(sb, { dossierId: D, periode: "2026-03", date: "2026-04-20" });
      expect(r).toMatchObject({ ok: true, montant: 7500, lignesInserees: 2 });
      return sb;
    };

    it("détecte le règlement d'avril sur la déclaration de mars", async () => {
      const etat = await lireEtatPeriodeTva(await payerEnAvril(), { dossierId: D, periode: "2026-03" });
      expect(etat.regle).toBe(true);
      expect(etat.montantRegle).toBe(7500);
      expect(etat.dateReglement).toBe("2026-04-20");
      expect(etat.resteAPayerPeriode).toBe(0);
      expect(etat.resteAPayable).toBe(0);
      expect(etat.solde4456).toBe(0);
      // Le solde ARRÊTÉ AU 31 MARS, lui, porte toujours la dette : c'est correct
      // (au 31 mars elle n'était pas payée) et c'est pourquoi il ne décide plus.
      expect(etat.resteAPayer).toBe(7500);
    });

    it("REFUSE un second prélèvement pour une déclaration déjà réglée", async () => {
      const sb = await payerEnAvril();
      const r = await executerPaiementDgi(sb, { dossierId: D, periode: "2026-03", date: "2026-05-02" });
      expect(r.lignesInserees).toBe(0);
      expect(r.raison).toMatch(/déjà été réglée/);
      expect(sb.rows.filter((l) => memeCompte(l.compte_numero, "4456") && Number(l.debit) > 0)).toHaveLength(1);
    });

    it("débloque le pointage : le 4456 est soldé, même si c'est en avril", async () => {
      const sb = await payerEnAvril();
      const r = await executerPointageTva(sb, { dossierId: D, periode: "2026-03", pointe: true });
      expect(r.ok).toBe(true);
      expect(r.lignesPointees).toBe(2);
    });
  });

  it("crédite le compte bancaire indiqué", async () => {
    const sb = await declarer();
    await executerPaiementDgi(sb, { dossierId: D, periode: "2026-03", date: "2026-03-31", compteBanque: "51420000" });
    expect(sb.rows.some((l) => memeCompte(l.compte_numero, "51420000") && Number(l.credit) === 7500)).toBe(true);
  });
});

// ─── Pointage du règlement (migration 20260809130000) ────────────────────────

const TX = "22222222-2222-2222-2222-222222222222";

/** Période déclarée et prélevée, avec la ligne de relevé rapprochée. */
async function cycleComplet(opts: { sansTracabilite?: boolean; avecTransaction?: boolean } = {}) {
  const sb = fakeSb(MARS, {
    sansTracabilite: opts.sansTracabilite,
    transactions: opts.avecTransaction ? [{ id: TX, dossier_id: D, montant: 7500, pointe: false }] : [],
  });
  await executerDeclarationTva(sb, { dossierId: D, periode: "2026-03" });
  await executerPaiementDgi(sb, {
    dossierId: D, periode: "2026-03", date: "2026-03-31",
    transactionId: opts.avecTransaction ? TX : null,
  });
  return sb;
}

describe("executerPointageTva", () => {
  it("coche toutes les lignes de 4456 du cycle et les horodate", async () => {
    const sb = await cycleComplet();
    const r = await executerPointageTva(sb, { dossierId: D, periode: "2026-03", pointe: true });
    expect(r).toMatchObject({ ok: true, pointe: true, lignesPointees: 2 });

    const cycle = sb.rows.filter((l) => l.reference_piece === "DECL-TVA-2026-03" && memeCompte(l.compte_numero, "4456"));
    expect(cycle).toHaveLength(2);
    expect(cycle.every((l) => l.pointe === true && !!l.pointe_le)).toBe(true);
    // Les comptes de TVA restants ne sont PAS touchés : pointer n'est pas lettrer.
    expect(sb.rows.filter((l) => memeCompte(l.compte_numero, "44551")).every((l) => !l.pointe)).toBe(true);

    const etat = await lireEtatPeriodeTva(sb, { dossierId: D, periode: "2026-03" });
    expect(etat.pointe).toBe(true);
    expect(etat.pointeLe).toBeTruthy();
  });

  it("propage la marque sur la ligne de relevé rapprochée", async () => {
    const sb = await cycleComplet({ avecTransaction: true });
    const r = await executerPointageTva(sb, { dossierId: D, periode: "2026-03", pointe: true });
    expect(r.transactionPointee).toBe(true);
    expect(sb.transactions[0].pointe).toBe(true);
  });

  it("REFUSE de pointer une dette encore ouverte", async () => {
    const sb = fakeSb(MARS);
    await executerDeclarationTva(sb, { dossierId: D, periode: "2026-03" });
    const r = await executerPointageTva(sb, { dossierId: D, periode: "2026-03", pointe: true });
    expect(r.ok).toBe(false);
    expect(r.raison).toMatch(/n'est pas soldé/);
    expect(sb.rows.some((l) => l.pointe === true)).toBe(false);
  });

  it("REFUSE de pointer un crédit de TVA — le 4456 débiteur n'est pas une dette soldée", async () => {
    // Déductible > collectée : l'OD débite le 4456, donc `resteAPayer` est
    // NÉGATIF et passerait une garde qui ne testerait que « ≤ 0 ».
    const sb = fakeSb([
      { journal_code: "OD", compte_numero: "44551", date_ecriture: "2026-03-05", debit: 0, credit: 1000, dossier_id: D },
      { journal_code: "OD", compte_numero: "34552", date_ecriture: "2026-03-12", debit: 4000, credit: 0, dossier_id: D },
    ]);
    await executerDeclarationTva(sb, { dossierId: D, periode: "2026-03" });
    const r = await executerPointageTva(sb, { dossierId: D, periode: "2026-03", pointe: true });
    expect(r.ok).toBe(false);
    expect(r.raison).toMatch(/crédit de TVA reportable/);
  });

  it("REFUSE de pointer une période non déclarée", async () => {
    const r = await executerPointageTva(fakeSb(MARS), { dossierId: D, periode: "2026-03", pointe: true });
    expect(r.ok).toBe(false);
    expect(r.raison).toMatch(/n'est pas déclarée/);
  });

  it("laisse toujours se dédire : le dépointage repasse les lignes à faux", async () => {
    const sb = await cycleComplet();
    await executerPointageTva(sb, { dossierId: D, periode: "2026-03", pointe: true });
    const r = await executerPointageTva(sb, { dossierId: D, periode: "2026-03", pointe: false });
    expect(r).toMatchObject({ ok: true, pointe: false });

    const cycle = sb.rows.filter((l) => l.reference_piece === "DECL-TVA-2026-03" && memeCompte(l.compte_numero, "4456"));
    expect(cycle.every((l) => l.pointe === false && l.pointe_le === null)).toBe(true);
  });

  it("dit quelle migration manque au lieu d'échouer en « colonne inconnue »", async () => {
    const sb = await cycleComplet({ sansTracabilite: true });
    const etat = await lireEtatPeriodeTva(sb, { dossierId: D, periode: "2026-03" });
    // La lecture retombe sur les colonnes historiques : la période reste lisible.
    expect(etat.ok).toBe(true);
    expect(etat.tracable).toBe(false);
    expect(etat.liquidation).toMatchObject({ collectee: 12000, deductible: 4500 });

    const r = await executerPointageTva(sb, { dossierId: D, periode: "2026-03", pointe: true });
    expect(r.ok).toBe(false);
    expect(r.raison).toMatch(/20260809130000/);
  });
});

// ─── Quittance SIMPL-TVA ─────────────────────────────────────────────────────

describe("executerEnregistrementQuittance", () => {
  const CHEMIN = `${D}/DECL-TVA-2026-03.pdf`;

  it("trace le chemin du PDF sur la ligne de relevé du prélèvement", async () => {
    const sb = await cycleComplet({ avecTransaction: true });
    const r = await executerEnregistrementQuittance(sb, {
      dossierId: D, periode: "2026-03", path: CHEMIN, nom: "quittance.pdf",
    });
    expect(r).toMatchObject({ ok: true, traceEnBase: true, quittancePath: CHEMIN });
    expect(sb.transactions[0]).toMatchObject({ quittance_path: CHEMIN, quittance_nom: "quittance.pdf" });

    const etat = await lireEtatPeriodeTva(sb, { dossierId: D, periode: "2026-03" });
    expect(etat.quittancePath).toBe(CHEMIN);
  });

  it("accepte sans tracer quand aucune ligne de relevé n'est rapprochée", async () => {
    const sb = await cycleComplet();
    const r = await executerEnregistrementQuittance(sb, { dossierId: D, periode: "2026-03", path: CHEMIN });
    // Le PDF est déjà dans le bucket : refuser ici le rendrait introuvable.
    expect(r.ok).toBe(true);
    expect(r.traceEnBase).toBe(false);
    expect(r.raison).toMatch(/bucket/);
  });

  it("refuse un chemin vide sans toucher la base", async () => {
    const sb = await cycleComplet({ avecTransaction: true });
    const r = await executerEnregistrementQuittance(sb, { dossierId: D, periode: "2026-03", path: "  " });
    expect(r.ok).toBe(false);
    expect(sb.transactions[0].quittance_path).toBeUndefined();
  });
});

// ─── Entrée générique ────────────────────────────────────────────────────────
// Ce qu'on vérifie ici n'est pas le calcul (couvert plus haut) mais la
// GÉNÉRICITÉ : deux arguments, aucun dossier ni aucune période privilégiés, et
// un refus parlant quand les arguments ne tiennent pas.
describe("liquiderPeriodeTva", () => {
  const AUTRE = "99999999-9999-9999-9999-999999999999";

  it("liquide n'importe quel dossier sur n'importe quelle période", async () => {
    // Deux dossiers, deux périodes, deux montants — même appel.
    const lignes = [
      { journal_code: "OD", compte_numero: "44551", date_ecriture: "2026-03-05", debit: 0, credit: 12000, dossier_id: D },
      { journal_code: "OD", compte_numero: "34552", date_ecriture: "2026-03-12", debit: 4500, credit: 0, dossier_id: D },
      { journal_code: "OD", compte_numero: "44551", date_ecriture: "2026-07-09", debit: 0, credit: 800, dossier_id: AUTRE },
    ];
    const sb = fakeSb(lignes);

    const a = await liquiderPeriodeTva(D, "2026-03", { client: sb });
    expect(a).toMatchObject({ ok: true, montant: 7500, dette: true, lignesInserees: 3 });

    const b = await liquiderPeriodeTva(AUTRE, "2026-07", { client: sb });
    expect(b).toMatchObject({ ok: true, montant: 800, dette: true });

    // Chaque OD ne porte que les lignes de SON dossier.
    const od = sb.rows.filter((r: any) => String(r.reference_piece ?? "").startsWith("DECL-TVA-"));
    expect(od.every((r: any) => [D, AUTRE].includes(r.dossier_id))).toBe(true);
    expect(od.filter((r: any) => r.dossier_id === AUTRE)).toHaveLength(2);
  });

  it("accepte les périodes trimestrielles au même titre que les mensuelles", async () => {
    const sb = fakeSb([
      { journal_code: "OD", compte_numero: "44551", date_ecriture: "2026-02-10", debit: 0, credit: 300, dossier_id: D },
    ]);
    const r = await liquiderPeriodeTva(D, "2026-T1", { client: sb });
    expect(r).toMatchObject({ ok: true, montant: 300 });
  });

  it("porte un crédit de TVA au débit du 4456 sans le confondre avec une dette", async () => {
    const sb = fakeSb([
      { journal_code: "OD", compte_numero: "34552", date_ecriture: "2026-05-04", debit: 240, credit: 0, dossier_id: D },
    ]);
    const r = await liquiderPeriodeTva(D, "2026-05", { client: sb });
    expect(r).toMatchObject({ ok: true, montant: 240, dette: false });
    const du = sb.rows.find((x: any) => memeCompte(x.compte_numero, "4456") && x.reference_piece === "DECL-TVA-2026-05");
    expect(du).toMatchObject({ debit: 240, credit: 0 });
  });

  it("ne touche à rien en simulation", async () => {
    const sb = fakeSb(MARS);
    const avant = sb.rows.length;
    const r = await liquiderPeriodeTva(D, "2026-03", { client: sb, simulation: true });
    expect(r).toMatchObject({ ok: true, montant: 7500, lignesInserees: 0 });
    expect(sb.rows).toHaveLength(avant);
  });

  it("refuse un identifiant de dossier qui n'en est pas un, sans interroger la base", async () => {
    // Le piège : `.eq(\"dossier_id\", \"\")` ne lève pas — il rend zéro ligne, donc
    // une période « néant » crédible et fausse.
    const sb = fakeSb(MARS);
    for (const mauvais of ["", "   ", "DIGITAL SOLUTIONS", "42"]) {
      const r = await liquiderPeriodeTva(mauvais, "2026-03", { client: sb });
      expect(r.ok).toBe(false);
      expect(r.raison).toMatch(/dossier invalide/i);
    }
    expect(sb.rows).toHaveLength(MARS.length);
  });

  it("refuse une période mal formée", async () => {
    const sb = fakeSb(MARS);
    for (const mauvaise of ["", "2026", "2026-13", "mars 2026", "2026-T5", "2026-03-01"]) {
      const r = await liquiderPeriodeTva(D, mauvaise, { client: sb });
      expect(r.ok).toBe(false);
      expect(r.raison).toMatch(/Période illisible/i);
    }
    expect(sb.rows).toHaveLength(MARS.length);
  });

  it("reste idempotente : une période déjà liquidée est refusée, pas doublée", async () => {
    const sb = fakeSb(MARS);
    await liquiderPeriodeTva(D, "2026-03", { client: sb });
    const apres = sb.rows.length;
    const rejeu = await liquiderPeriodeTva(D, "2026-03", { client: sb });
    expect(rejeu.ok).toBe(false);
    expect(rejeu.raison).toMatch(/déjà déclarée/i);
    expect(sb.rows).toHaveLength(apres);
  });
});
