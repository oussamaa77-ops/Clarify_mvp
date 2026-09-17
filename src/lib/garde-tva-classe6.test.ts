import { describe, expect, it } from "vitest";
import {
  assertTvaHorsClasse6, controlerTvaHorsClasse6, estTvaEnClasse6,
} from "./garde-tva-classe6";
import {
  assertLignesAchat, controlerEcrituresRegime, genererEcrituresAchat,
} from "./genererEcritures";
import { soldesCloture } from "./a-nouveaux";

const ligne = (compte: string, libelle: string, debit = 400, credit = 0) => ({
  journal_code: "ACH", compte_numero: compte, date_ecriture: "2026-06-10",
  libelle, debit, credit, reference_piece: "FF-1",
});

describe("estTvaEnClasse6 — reconnaître une TVA récupérable passée en charge", () => {
  it("dénonce une ligne de TVA posée sur 61671000 « Impôts et taxes »", () => {
    expect(estTvaEnClasse6(ligne("61671000", "TVA déductible FF-GOLD-001"))).toBe(true);
    expect(estTvaEnClasse6(ligne("6167", "TVA en attente CLARIFY FOURNISSEUR"))).toBe(true);
    expect(estTvaEnClasse6(ligne("61410000", "Bascule TVA REG-1"))).toBe(true);
    expect(estTvaEnClasse6(ligne("61250000", "Taxe sur la valeur ajoutée — électricité"))).toBe(true);
  });

  it("laisse la TVA à sa place : 34552 / 3458 / 44551 / 4458 ne sont pas des charges", () => {
    for (const c of ["34552000", "34580000", "44551000", "44580000", "44560000"]) {
      expect(estTvaEnClasse6(ligne(c, "TVA déductible"))).toBe(false);
    }
  });

  it("accepte la TVA NON récupérable (CGI art. 106), qui est un coût", () => {
    expect(estTvaEnClasse6(ligne("61241000", "TVA non récupérable carburant"))).toBe(false);
    expect(estTvaEnClasse6(ligne("61470000", "TVA non-déductible frais de réception"))).toBe(false);
  });

  it("ne confond pas des droits de timbre (hors champ) avec de la TVA", () => {
    // Le cas exact de TEST-CLARIFY-GOLDEN : 1 200 MAD de timbres sur 61671000.
    expect(estTvaEnClasse6(ligne("61671000", "Droits d'enregistrement et de timbres", 1200))).toBe(false);
  });

  it("ne bloque pas un libellé qui CITE la TVA sans la poser", () => {
    expect(estTvaEnClasse6(ligne("63470000", "COMMISSION VIREMENT HT, TVA 10% à part"))).toBe(false);
  });

  it("ignore une ligne à zéro", () => {
    expect(estTvaEnClasse6(ligne("6167", "TVA déductible", 0, 0))).toBe(false);
  });
});

describe("controlerTvaHorsClasse6 / assertTvaHorsClasse6", () => {
  it("rend un grief lisible, pièce et montant compris", () => {
    const c = controlerTvaHorsClasse6([ligne("61671000", "TVA déductible FF-9", 2400)]);
    expect(c.ok).toBe(false);
    expect(c.violations[0]).toMatch(/61671000/);
    expect(c.violations[0]).toMatch(/2400\.00 MAD/);
    expect(c.violations[0]).toMatch(/FF-1/);
  });

  it("assert jette, et laisse passer une pièce saine", () => {
    expect(() => assertTvaHorsClasse6([ligne("61671000", "TVA déductible")])).toThrow(/classe 6/);
    expect(() => assertTvaHorsClasse6([ligne("34552000", "TVA déductible")])).not.toThrow();
  });
});

describe("VERROU 9 — branché sur la porte d'insertion et sur la clôture", () => {
  it("controlerEcrituresRegime (insererPiece) REFUSE une TVA en classe 6", () => {
    const piece = [
      ligne("61110000", "Achat FF-1", 2000),
      ligne("61671000", "TVA déductible FF-1", 400),
      ligne("44110001", "Dette FF-1", 0, 2400),
    ];
    const v = controlerEcrituresRegime(piece, {});
    expect(v.ok).toBe(false);
    expect(v.violations.join(" ")).toMatch(/TVA récupérable imputée en classe 6/);
  });

  it("la même pièce, TVA sur 3458, passe", () => {
    const piece = genererEcrituresAchat({
      dossier_id: "d", facture_id: "ff", reference: "FF-1", date_facture: "2026-06-10",
      montant_ht: 2000, montant_tva: 400, montant_ttc: 2400, compte_charge: "61671000",
    });
    expect(controlerEcrituresRegime(piece, {}).ok).toBe(true);
    expect(() => assertLignesAchat(piece)).not.toThrow();
    // Aucune ligne de classe 6 ne porte la TVA : elle est au 3458.
    expect(piece.filter((l) => l.compte_numero.startsWith("6")).map((l) => l.debit)).toEqual([2000]);
  });

  it("assertLignesAchat refuse une TVA déductible glissée sur la charge", () => {
    expect(() => assertLignesAchat([
      ligne("61110000", "Achat FF-2", 2000),
      ligne("61110000", "TVA déductible FF-2", 400),
      ligne("44110001", "Dette FF-2", 0, 2400),
    ])).toThrow(/classe 6/);
  });

  it("soldesCloture refuse de calculer un bilan qui porte une TVA en charge", () => {
    const lignes = [
      { journal_code: "ACH", compte_numero: "61671000", libelle: "TVA déductible FF-3", date_ecriture: "2026-05-01", debit: 400, credit: 0 },
      { journal_code: "ACH", compte_numero: "44110001", libelle: "Dette FF-3", date_ecriture: "2026-05-01", debit: 0, credit: 400 },
    ];
    expect(() => soldesCloture(lignes, "2027-01-01")).toThrow(/Clôture au 2027-01-01 refusée/);
    // Hors de la période de clôture, la ligne ne bloque rien.
    expect(() => soldesCloture(lignes, "2026-01-01")).not.toThrow();
  });
});
