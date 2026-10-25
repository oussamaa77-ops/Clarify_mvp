// ============================================================================
// ecritures-paie.ts — Les écritures d'un bulletin de paie, en logique pure.
//
// Extrait de `validerBulletin` (paie.functions.ts), où les lignes étaient
// construites en clair au milieu de l'insert. Deux défauts y vivaient, que
// l'extraction rend testables :
//
//   1. Le NET À PAYER était crédité au 4441 « CNSS ». Le salaire dû au salarié
//      n'est pas une dette envers la sécurité sociale : il relève de 4432
//      « Rémunérations dues au personnel » (CGNC, et référentiel `pcm_reference`
//      du projet). La CNSS affichait une dette gonflée du net de chaque paie.
//
//   2. La pièce n'était ÉQUILIBRÉE que sans CIMR ni retenue diverse. Le débit du
//      6171 reprend le brut (net + TOUTES les retenues), mais seules CNSS, AMO et
//      IR étaient créditées. La CIMR (salariale ET patronale) est désormais
//      créditée au 4443 « Caisses de retraite » ; l'IR au 44525 « État, IGR ». Les
//      retenues libres (avances, saisies…) n'ont pas de compte arbitré : la pièce
//      qui en porte est REFUSÉE plutôt qu'insérée déséquilibrée.
// ============================================================================

import { PCM, controlerComptesPcm } from "@/lib/pcm-referentiel";

const r2 = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;

/** « 2026-02 » → « 2026-02-28 ». Une période illisible est rendue telle quelle + « -01 ». */
function finDeMois(periode: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(String(periode ?? "").trim());
  if (!m) return `${periode}-01`;
  const jour = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
  return `${m[1]}-${m[2]}-${String(jour).padStart(2, "0")}`;
}

/** Le sous-ensemble d'un bulletin (`bulletins_paie`) que la comptabilité lit. */
export interface BulletinComptable {
  dossier_id: string;
  periode: string;
  date_paiement?: string | null;
  net_a_payer: number;
  total_retenues: number;
  cnss_salarie: number;
  amo_salarie: number;
  ir_net: number;
  cimr_salarie?: number | null;
  /** Part patronale CNSS : prestations sociales + allocations familiales. */
  cnss_patronal: number;
  amo_patronal: number;
  taxe_formation_pro: number;
  cimr_patronal?: number | null;
}

export interface LignePaie {
  dossier_id: string;
  journal_code: "OD";
  compte_numero: string;
  date_ecriture: string;
  libelle: string;
  debit: number;
  credit: number;
  reference_piece: string;
  valide: true;
}

/**
 *   D 6171  brut (net + retenues)       C 4441   CNSS + AMO salariales
 *                                        C 4443   CIMR salariale
 *                                        C 44525  IR retenu à la source
 *                                        C 4432   net à payer
 *   D 6174  charges patronales          C 4441   CNSS + AF + AMO + TFP patronales
 *                                        C 4443   CIMR patronale
 *
 * Les lignes à 0,00 sont omises : elles ne portent rien et polluent le journal.
 * À défaut de date de paiement, la pièce est datée du DERNIER jour de la
 * période : la charge du mois appartient au mois, quel que soit le jour du virement.
 */
export function lignesEcrituresPaie(b: BulletinComptable, nomSalarie: string): LignePaie[] {
  const date = b.date_paiement || finDeMois(b.periode);
  const base = {
    dossier_id: b.dossier_id,
    journal_code: "OD" as const,
    date_ecriture: date,
    reference_piece: `PAIE-${b.periode}`,
    valide: true as const,
  };
  const nom = nomSalarie.trim();
  const patronalCnss = r2(r2(b.cnss_patronal) + r2(b.amo_patronal) + r2(b.taxe_formation_pro));
  const cimrPatronal = r2(b.cimr_patronal);

  const lignes: LignePaie[] = [
    { ...base, compte_numero: PCM.REMUNERATIONS_PERSONNEL, libelle: `Salaire ${nom} ${b.periode}`,
      debit: r2(r2(b.net_a_payer) + r2(b.total_retenues)), credit: 0 },
    { ...base, compte_numero: PCM.CNSS, libelle: `CNSS salarial ${nom}`,
      debit: 0, credit: r2(r2(b.cnss_salarie) + r2(b.amo_salarie)) },
    { ...base, compte_numero: PCM.CAISSES_RETRAITE, libelle: `CIMR salariale ${nom}`,
      debit: 0, credit: r2(b.cimr_salarie) },
    { ...base, compte_numero: PCM.IR_RETENU_SALAIRES, libelle: `IR/salaire ${nom}`,
      debit: 0, credit: r2(b.ir_net) },
    { ...base, compte_numero: PCM.REMUNERATIONS_DUES_PERSONNEL, libelle: `Net à payer ${nom}`,
      debit: 0, credit: r2(b.net_a_payer) },
    { ...base, compte_numero: PCM.CHARGES_SOCIALES, libelle: `Charges sociales patronales ${nom}`,
      debit: r2(patronalCnss + cimrPatronal), credit: 0 },
    { ...base, compte_numero: PCM.CNSS, libelle: `CNSS/AMO patronal ${nom}`,
      debit: 0, credit: patronalCnss },
    { ...base, compte_numero: PCM.CAISSES_RETRAITE, libelle: `CIMR patronale ${nom}`,
      debit: 0, credit: cimrPatronal },
  ];
  return lignes.filter((l) => l.debit > 0.005 || l.credit > 0.005);
}

export interface ControleLignesPaie {
  ok: boolean;
  violations: string[];
  ecart: number;
}

export function controlerLignesPaie(lignes: LignePaie[], b?: BulletinComptable): ControleLignesPaie {
  const violations = [...controlerComptesPcm(lignes).violations];
  const ecart = r2(lignes.reduce((s, l) => s + l.debit - l.credit, 0)) || 0; // jamais -0
  if (Math.abs(ecart) > 0.005) {
    const detail = b
      ? ` Retenues sans contrepartie : ${ecart.toFixed(2)} MAD (retenues diverses : avances, `
        + "saisies…). Leur compte n'est pas arbitré : à imputer par l'expert-comptable "
        + "(3431 pour une avance au personnel)."
      : "";
    violations.push(`Écriture de paie déséquilibrée de ${ecart.toFixed(2)} MAD.${detail}`);
  }
  return { ok: violations.length === 0, violations, ecart };
}

export function assertLignesPaie(lignes: LignePaie[], b?: BulletinComptable): void {
  const c = controlerLignesPaie(lignes, b);
  if (!c.ok) throw new Error(`Écriture de paie refusée — ${c.violations.join(" ")}`);
}
