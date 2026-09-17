import { describe, expect, it } from "vitest";
import { postesRepriseClients, type EcritureRelance } from "./relances-postes";
import { CLIENT_PREFIXES } from "./import-grandlivre";

let seq = 0;
const e = (o: Partial<EcritureRelance>): EcritureRelance => ({
  id: `e${++seq}`, journal_code: "VTE", compte_numero: "34210001", libelle: "Client",
  debit: 0, credit: 0, reference_piece: null, date_ecriture: "2026-04-06",
  lettree: false, lettrage_code: null, facture_id: null, transaction_id: null, ...o,
});

/** Le compte 34210001 de TEST-CLARIFY-GOLDEN, réduit à ce qui compte ici. */
const golden = (): EcritureRelance[] => [
  e({ journal_code: "VTE", reference_piece: "FA-GOLD-002", debit: 24000, facture_id: "fa2" }),
  e({ journal_code: "BQ", reference_piece: "REG-GOLD-002-1", credit: 9000, date_ecriture: "2026-05-11", facture_id: "fa2" }),
  e({ journal_code: "VTE", reference_piece: "FA-GOLD-003", debit: 9600, lettrage_code: "AC", facture_id: "fa3" }),
  // L'à-nouveau : SANS facture_id — c'est lui qui passait pour une créance de reprise.
  e({ journal_code: "AN", reference_piece: "AN-2027", libelle: "A nouveau 34210001", debit: 15000, date_ecriture: "2027-01-01" }),
];

describe("postesRepriseClients — l'encours de la relance n'est plus doublé", () => {
  it("TEST-CLARIFY-GOLDEN : l'à-nouveau qui REPORTE FA-GOLD-002 n'est pas une créance", () => {
    // Avant le correctif : un poste de 15 000 (AN-2027) s'ajoutait aux 15 000 de
    // FA-GOLD-002 relancée en source 1 → 30 000 MAD pour 15 000 réellement dus.
    expect(postesRepriseClients(golden(), CLIENT_PREFIXES, ["FA-GOLD-002"])).toEqual([]);
  });

  it("garde l'à-nouveau quand il est la SEULE trace (dossier repris en AN)", () => {
    const repris = [e({ journal_code: "AN", reference_piece: "AN-2026", libelle: "SOMADIR", debit: 8000, date_ecriture: "2026-01-01" })];
    const p = postesRepriseClients(repris, CLIENT_PREFIXES);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ ref: "AN-2026", montant: 8000, nom: "SOMADIR" });
  });

  it("garde une vraie créance de reprise (import de grand livre, sans facture)", () => {
    const p = postesRepriseClients([
      e({ journal_code: "OD", reference_piece: "RAN-0042", libelle: "ATLAS", debit: 5000, date_ecriture: "2025-12-01" }),
      e({ journal_code: "OD", reference_piece: "RAN-0042", libelle: "ATLAS", credit: 1000, date_ecriture: "2025-12-15" }),
    ], CLIENT_PREFIXES);
    expect(p).toEqual([expect.objectContaining({ ref: "RAN-0042", montant: 4000, date: "2025-12-01" })]);
  });

  it("n'ajoute pas une pièce dont la facture est déjà relancée en source 1", () => {
    const p = postesRepriseClients([
      e({ journal_code: "OD", reference_piece: "FA-77", debit: 3000 }),
    ], CLIENT_PREFIXES, ["FA-77"]);
    expect(p).toEqual([]);
  });

  it("écarte les lignes lettrées (code ou drapeau) et celles d'un relevé", () => {
    const p = postesRepriseClients([
      e({ reference_piece: "X1", debit: 100, lettrage_code: "AA" }),
      e({ reference_piece: "X2", debit: 100, lettree: true }),
      e({ reference_piece: "X3", debit: 100, transaction_id: "t1" }),
    ], CLIENT_PREFIXES);
    expect(p).toEqual([]);
  });

  it("ignore les comptes qui ne sont pas des clients", () => {
    expect(postesRepriseClients([e({ compte_numero: "44110001", debit: 100 })], CLIENT_PREFIXES)).toEqual([]);
  });
});
