// ============================================================================
// tests/grand-livre-concordance.test.ts — Grand Livre ≡ Journal Général, sur la
// VRAIE base, pour CHAQUE dossier et CHAQUE exercice.
//
// Pendant intégration de src/lib/grand-livre.test.ts. On lit les écritures telles
// qu'elles sont en base, on construit le grand livre de l'exercice avec le MÊME
// code que l'écran, puis on le confronte à un recalcul indépendant, écriture par
// écriture : totaux du journal, soldes par compte, nombre de mouvements du
// drill-down. LECTURE SEULE — rien n'est écrit.
// ============================================================================

import { beforeAll, describe, expect, it } from "vitest";
import { clientGolden, nb, r2, txt } from "./golden/harness";
import { concordanceJournal, construireGrandLivre, type LigneGrandLivre } from "../src/lib/grand-livre";
import { bornesExercice, exercicesDisponibles } from "../src/lib/exercice-comptable";
import { normaliserNumeroCompte } from "../src/lib/numero-compte";

const { sb } = clientGolden();

interface DossierLu { nom: string; debutActivite: string | null; lignes: LigneGrandLivre[] }
const dossiers: DossierLu[] = [];

beforeAll(async () => {
  const { data, error } = await sb.from("dossiers").select("id,nom_societe,date_debut_activite");
  if (error) throw new Error(error.message);
  for (const d of data ?? []) {
    let lignes: LigneGrandLivre[] = [];
    for (let de = 0; ; de += 1000) {
      const r = await sb.from("ecritures_comptables")
        .select("id,date_ecriture,journal_code,compte_numero,libelle,debit,credit,reference_piece,facture_id,transaction_id")
        .eq("dossier_id", d.id).order("id").range(de, de + 999);
      if (r.error) throw new Error(r.error.message);
      lignes = lignes.concat((r.data ?? []) as LigneGrandLivre[]);
      if ((r.data ?? []).length < 1000) break;
    }
    dossiers.push({ nom: d.nom_societe, debutActivite: d.date_debut_activite ?? null, lignes });
  }
});

/** Chaque couple (dossier, exercice) portant des écritures. */
function exercices() {
  return dossiers.flatMap((d) => exercicesDisponibles(d.lignes.map((l) => l.date_ecriture)).map((annee) => {
    const b = bornesExercice(annee, d.debutActivite);
    const journal = d.lignes.filter((l) => txt(l.date_ecriture).slice(0, 10) >= b.debut && txt(l.date_ecriture).slice(0, 10) <= b.fin);
    return { dossier: d.nom, annee, bornes: b, journal, gl: construireGrandLivre(journal, { debut: b.debut, fin: b.fin }) };
  }));
}

describe("Grand Livre ≡ Journal Général — tous dossiers, tous exercices", () => {
  it("la base porte des écritures à contrôler", () => {
    expect(exercices().length).toBeGreaterThan(0);
  });

  it("Σ Débits et Σ Crédits du grand livre = ceux du journal général", () => {
    const ecarts = exercices()
      .map((e) => ({ e, c: concordanceJournal(e.journal, e.gl) }))
      .filter(({ c }) => !c.ok)
      .map(({ e, c }) => `${e.dossier} ${e.annee} : journal ${c.journalDebit}/${c.journalCredit} ≠ GL ${c.grandLivreDebit}/${c.grandLivreCredit}`);
    expect(ecarts).toEqual([]);
  });

  it("chaque grand livre d'exercice est équilibré (Σ D = Σ C, Σ SD = Σ SC)", () => {
    expect(exercices().filter((e) => !e.gl.equilibre).map((e) => `${e.dossier} ${e.annee}`)).toEqual([]);
  });

  it("solde de chaque compte = recalcul indépendant écriture par écriture", () => {
    const ecarts: string[] = [];
    for (const e of exercices()) {
      for (const c of e.gl.comptes) {
        const siennes = e.journal.filter((l) => normaliserNumeroCompte(l.compte_numero) === c.compte);
        const attendu = r2(siennes.reduce((s, l) => s + nb(l.debit) - nb(l.credit), 0));
        if (Math.abs(attendu - c.soldeFinal) > 0.005) ecarts.push(`${e.dossier} ${e.annee} ${c.compte} : ${c.soldeFinal} ≠ ${attendu}`);
      }
    }
    expect(ecarts).toEqual([]);
  });

  it("drill-down : chaque écriture non reportée apparaît UNE fois dans son dossier-compte", () => {
    const ecarts: string[] = [];
    for (const e of exercices()) {
      const vus = new Set(e.gl.comptes.flatMap((c) => c.mouvements.map((m) => m.id)));
      const attendus = e.journal.filter((l) => txt(l.journal_code).toUpperCase() !== "AN" && txt(l.compte_numero));
      const nbMouvements = e.gl.comptes.reduce((s, c) => s + c.mouvements.length, 0);
      if (nbMouvements !== attendus.length || attendus.some((l) => !vus.has(l.id))) {
        ecarts.push(`${e.dossier} ${e.annee} : ${nbMouvements} mouvements pour ${attendus.length} écritures`);
      }
    }
    expect(ecarts).toEqual([]);
  });
});
