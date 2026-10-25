// ============================================================================
// comptabilite-bq.ts — Génération des écritures du Journal de Banque (BQ)
//
// Logique partagée entre la liste des relevés (banque.tsx) et le détail d'un
// relevé (banque.$releveId.tsx) pour la clôture « modèle Odoo / Grand Livre
// continu » : toute transaction non clôturée est comptabilisée, les orphelines
// étant parquées sur les comptes transitoires ou d'attente du CGNC 3497
// (débiteurs) / 4497 (créditeurs).
//
// Source de vérité UNIQUE — ne pas dupliquer ces règles dans les composants.
// ============================================================================

import {
  COMPTE_CAISSE_DEFAUT, compteCaisse, type ComptesTresorerieDossier,
} from "@/lib/comptes-tresorerie";
import { PCM, validatePcmAccount } from "@/lib/pcm-referentiel";

// PCM_MAP — compte CGNC et taux de TVA par défaut (CGI 2026 : 20 % / 10 %),
// déductibilité selon l'art. 106 CGI. Le taux ne sert qu'à défaut de pièce :
// dès qu'un document est lié, ce sont SES montants qui font foi.
export const PCM_MAP: Record<string, { code: string; tva: number }> = {
  encaissement_client:  { code: PCM.CLIENTS,  tva: 0 },   // Encaissement → pas de TVA
  // Règlement fournisseur : on solde le 4411 au TTC. La TVA est portée par la
  // facture (journal ACH), jamais reconstituée sur le relevé.
  paiement_fournisseur: { code: PCM.FOURNISSEURS,  tva: 0 },
  salaires:             { code: PCM.REMUNERATIONS_DUES_PERSONNEL,  tva: 0 },   // Virement de paie → solde 4432 (la charge 6171 est au journal des salaires)
  cnss_amo:             { code: PCM.CNSS,  tva: 0 },   // CNSS/AMO → solde la dette sociale 4441 (la charge 6174 est au journal des salaires)
  tva_dgi:              { code: PCM.TVA_DUE,  tva: 0 },   // Paiement TVA → solde 4456, pas de TVA sur TVA
  // TVA prélevée par la banque sur ses commissions : TVA RÉCUPÉRABLE sur
  // charges, pas une dette envers l'État (4456).
  tva_frais_bancaires:  { code: PCM.TVA_RECUPERABLE_CHARGES,  tva: 0 },
  ir_salaires:          { code: PCM.IR_RETENU_SALAIRES,  tva: 0 },   // Versement de l'IR retenu → solde 44525
  acompte_is:           { code: PCM.ACOMPTES_IS,  tva: 0 },   // Acompte d'IS → 3453, une créance jusqu'à la liquidation
  loyers:               { code: PCM.LOCATIONS,  tva: 0 },   // Local nu = exonéré; local meublé → modifier manuellement
  // Électricité 20 % depuis le 01/01/2026 (14 % jusqu'en 2023, 16 % en 2024,
  // 18 % en 2025) ; eau non domestique 10 %, domestique exonérée.
  eau_electricite:      { code: PCM.EAU_ELECTRICITE,  tva: 20 },
  telecom:              { code: PCM.FRAIS_POSTAUX_TELECOMMUNICATIONS,  tva: 20 },  // 6145 Frais postaux et télécom, TVA 20% déductible
  // 61223 « Achats de combustibles ». C'était 61241, « Variation des stocks de
  // matières premières ». TVA non déductible sur le carburant des véhicules (art. 106 CGI).
  gasoil:               { code: PCM.ACHATS_COMBUSTIBLES, tva: 0 },
  // 6134 « Primes d'assurances ». C'était 6161, qui est « Impôts et taxes directs ».
  assurance:            { code: PCM.PRIMES_ASSURANCES,  tva: 0 },   // Assurance → hors champ TVA (taxe sur les contrats d'assurance)
  // 6133 « Entretien et réparations ». C'était 6141 « Études, recherches et documentation ».
  entretien:            { code: PCM.ENTRETIEN_REPARATIONS,  tva: 20 },  // Réparations → TVA 20% déductible
  // 61473 « Frais et commissions sur services bancaires ». C'était 6347 : la rubrique 634 n'existe pas au CGNC.
  frais_bancaires:      { code: PCM.SERVICES_BANCAIRES,  tva: 10 },  // Commissions bancaires → TVA 10% déductible
  // 6161 « Impôts et taxes directs ». C'était 6313, un compte de charges d'INTÉRÊTS.
  taxe_professionnelle: { code: PCM.IMPOTS_TAXES_DIRECTS,  tva: 0 },   // Taxes → pas de TVA
  // 61671 « Droits d'enregistrement et de timbre » : un impôt, pas un service bancaire, sans TVA.
  droits_timbre:        { code: PCM.DROITS_ENREGISTREMENT_TIMBRE,  tva: 0 },
  // Retrait → CAISSE, rubrique 516 du PCM. C'était 5143, qui est la Trésorerie
  // Générale : les espèces sorties du GAB n'alimentaient donc pas le compte que
  // mouvementent les règlements en espèces, et le solde de caisse était faux des
  // deux côtés. Cf. src/lib/comptes-tresorerie.ts.
  retrait_especes:      { code: COMPTE_CAISSE_DEFAUT, tva: 0 },
  virement_interne:     { code: PCM.VIREMENTS_DE_FONDS,  tva: 0 },   // Mouvement de fonds entre comptes → compte de liaison, pas de TVA
  // 7381 « Intérêts et produits assimilés ». C'était 7611 : la rubrique 76 n'existe pas au CGNC.
  interets_crediteurs:  { code: PCM.INTERETS_PRODUITS_ASSIMILES,  tva: 0 },   // Intérêts → hors champ TVA
  // 6143 « Déplacements, missions et réceptions ». C'était 6147, « Services bancaires ».
  frais_representation: { code: PCM.DEPLACEMENTS_MISSIONS_RECEPTIONS,  tva: 0 },   // Restaurant/réception → NON déductible (CGI Art.106)
  // 61678 « Autres impôts, taxes et droits assimilés ». C'était 6146, « Cotisations
  // et dons ». Droits liés à des marchandises stockées : à incorporer au coût d'achat (611x/612x).
  frais_douane:         { code: PCM.AUTRES_IMPOTS_TAXES,  tva: 0 },
  // 10 % depuis le 01/01/2026 pour le transport urbain et routier (14 % jusqu'en
  // 2023, 13 % en 2024, 12 % en 2025) ; les autres transports sont à 20 %.
  transport:            { code: PCM.TRANSPORTS,  tva: 10 },
  autre:                { code: PCM.CHARGE_DEFAUT,  tva: 0 },   // Divers → par défaut sans TVA
};

// ─── Dérive une catégorie PCM depuis le libellé bancaire (fallback sans IA) ──
// Mouvements de fonds internes : VIR AG EMIS, VERS/VERSEMENT (cf. analyse-regles-pcm.md règle 4)
export const RX_VIREMENT_INTERNE = /VIR\.?\s*AG\.?\s*EMIS|VIREMENT\s+INTERNE|^VERS(EMENT)?\b/;
// TVA facturée par la banque sur ses commissions (« TVA S/COMMISSION », « TVA/FRAIS »…).
export const RX_TVA_FRAIS_BANCAIRES = /\bT\.?V\.?A\b.*(COMM|FRAIS|AGIOS|TENUE|INTER|CARTE|PACK|ABONN)|(COMM|FRAIS|AGIOS|TENUE).*\bT\.?V\.?A\b/;

/** La catégorie et SON compte, lu dans PCM_MAP : une seule table, jamais deux. */
const cat = (categorie: string) => ({ categorie, code: PCM_MAP[categorie].code, tva: PCM_MAP[categorie].tva });

export function deriveCategorie(libelle: string, type: "credit" | "debit"): { categorie: string; code: string; tva: number } {
  const u = (libelle || "").toUpperCase();
  if (RX_VIREMENT_INTERNE.test(u))                        return cat("virement_interne");
  if (type === "credit") return cat("encaissement_client");
  if (/\bCNSS\b|\bAMO\b/.test(u))                        return cat("cnss_amo");
  if (RX_TVA_FRAIS_BANCAIRES.test(u))                     return cat("tva_frais_bancaires");
  if (/\bTVA\b/.test(u))                                  return cat("tva_dgi");
  if (/\bIS\b|IMPOT\s+SUR\s+LES\s+SOCIETES/.test(u))      return cat("acompte_is");
  if (/\bIR\b|\bIGR\b/.test(u))                           return cat("ir_salaires");
  if (/\bDGI\b|IMPOT/.test(u))                            return cat("tva_dgi");
  if (/SALAIRE|PAIE|REMUNERATION/.test(u))                return cat("salaires");
  if (/\bIAM\b|ORANGE|INWI|TELECOM|INTERNET/.test(u))    return cat("telecom");
  if (/LOYER|LOCATION/.test(u))                           return cat("loyers");
  if (/\bEAU\b|ONEE|ELECTRICITE/.test(u))                return cat("eau_electricite");
  if (/GASOIL|CARBURANT|STATION/.test(u))                 return cat("gasoil");
  if (/ASSURANCE/.test(u))                                return cat("assurance");
  if (/TIMBRE/.test(u))                                   return cat("droits_timbre");
  if (/COMMISSION|FRAIS|AGIOS|TENUE/.test(u))            return cat("frais_bancaires");
  if (/RETRAIT|GAB/.test(u))                              return cat("retrait_especes");
  if (/DOUANE|IMPORT/.test(u))                            return cat("frais_douane");
  if (/TRANSPORT|DEPLACEMENT/.test(u))                    return cat("transport");
  return cat("paiement_fournisseur");
}

// ─── Lignes d'écriture Journal de Banque (BQ) — règles PCM (cf. analyse-regles-pcm.md) ──
// 1. Sans document lié → compte d'attente 3497 (débit) / 4497 (crédit), jamais de compte de charge deviné
// 2. Facture fournisseur liée → Débit 4411 TTC / Crédit 5141 TTC (la TVA est gérée au journal d'achats)
// 3. Justificatif lié → Débit compte charge HT + Débit 34552 TVA si eligible_edi=true et taux > 0, sinon TTC intégral
// 4. Virement interne (VIR AG EMIS / VERS) → 5115 Virements de fonds, pas de TVA
// 5. Retrait espèces → CAISSE, rubrique 516 (51610000 par défaut, ou le
//    sous-compte de caisse du dossier). PAS 5143, qui est la Trésorerie Générale.
// 6. On solde la dette, jamais de charge directe : CNSS → 4441 ; TVA → 4456 ;
//    IR retenu → 44525 ; acompte d'IS → 3453 (créance)
// 7. Facture client liée (crédit) → Débit 5141 / Crédit 3421
// 8. TVA prélevée par la banque sur ses commissions → 34552 (TVA récupérable)
export type LigneBQ = { compte: string; libelle: string; debit: number; credit: number; categorie: string };

export function genererLignesBQ(p: {
  libelle: string | null;
  type: string;
  montant: number;
  categorie?: string | null;
  // Compte PCM affiché dans l'UI pour la transaction. NON UTILISÉ pour choisir la
  // contrepartie : depuis le modèle « bank suspense », une transaction sans pièce va
  // toujours en 3497/4497, jamais sur un compte de charge deviné. Conservé car des
  // appelants le passent encore.
  compteComptable?: string | null;
  factureLiee?: boolean;
  justificatif?: { compte_pcm?: string | null; taux_tva?: number | null; eligible_edi?: boolean | null } | null;
  /**
   * Dossier, pour ses sous-comptes de trésorerie (`compte_caisse`). Omis → 51610000.
   * À passer partout où le dossier est déjà chargé : deux écrans qui écriraient
   * les retraits sur deux comptes de caisse différents rendraient le solde
   * intraçable, ce qui est précisément le défaut qu'on corrige.
   */
  dossier?: ComptesTresorerieDossier | null;
}): LigneBQ[] {
  // Sens de l'opération : un montant négatif (signe du relevé) est TOUJOURS une
  // sortie d'argent → 5141 au crédit, contrepartie au débit — même si le champ
  // type est absent ou mal renseigné. Montant toujours exporté en valeur absolue.
  const isCr = p.montant < 0 ? false : /^c/i.test(String(p.type || "").trim());
  const m = Math.abs(Math.round(p.montant * 100) / 100);
  const lib = (p.libelle || "").slice(0, 100);
  const u = lib.toUpperCase();
  const cat = p.categorie || "";
  const justif = p.justificatif ?? null;

  const contreparties: LigneBQ[] = [];
  let catEff = cat || "autre";
  const cp = (compte: string, montant: number, opts?: { libelle?: string; categorie?: string }) =>
    contreparties.push({ compte, libelle: opts?.libelle ?? lib, debit: isCr ? 0 : montant, credit: isCr ? montant : 0, categorie: opts?.categorie ?? catEff });

  if (justif) {
    // Règle 3 — charge avec justificatif : HT + TVA déductible si eligible_edi, sinon TTC intégral
    const compte = justif.compte_pcm || (PCM_MAP[cat]?.code ?? PCM.CHARGE_DEFAUT);
    // Un compte saisi ou proposé par l'IA n'entre au grand livre que s'il est
    // recevable : refuser vaut mieux que deviner un compte de remplacement.
    const verdict = validatePcmAccount(compte);
    if (!verdict.ok) throw new Error(`Justificatif « ${lib} » : ${verdict.erreurs.join(" ")}`);
    const taux = Number(justif.taux_tva) || 0;
    if (!isCr && justif.eligible_edi === true && taux > 0) {
      const ht = Math.round(m / (1 + taux / 100) * 100) / 100;
      const tva = Math.round((m - ht) * 100) / 100;
      cp(compte, ht);
      cp(PCM.TVA_RECUPERABLE_CHARGES, tva, { libelle: `TVA ${lib.slice(0, 50)}`, categorie: "tva_deductible" });
    } else {
      cp(compte, m);
    }
  } else if (p.factureLiee) {
    // Règles 2 et 7 — solder le compte de tiers pour le TTC, jamais de TVA en banque
    catEff = isCr ? "encaissement_client" : "paiement_fournisseur";
    cp(isCr ? PCM.CLIENTS : PCM.FOURNISSEURS, m);
  } else if (cat === "cnss_amo" || /\bCNSS\b|\bAMO\b/.test(u)) {
    catEff = "cnss_amo";
    cp(PCM.CNSS, m);
  } else if (cat === "tva_frais_bancaires" || (!isCr && RX_TVA_FRAIS_BANCAIRES.test(u))) {
    // Règle 8 — la TVA des commissions bancaires est récupérable, pas due.
    catEff = "tva_frais_bancaires";
    cp(PCM.TVA_RECUPERABLE_CHARGES, m);
  } else if (cat === "tva_dgi") {
    cp(PCM.TVA_DUE, m);
  } else if (cat === "ir_salaires") {
    cp(PCM.IR_RETENU_SALAIRES, m);
  } else if (cat === "acompte_is") {
    cp(PCM.ACOMPTES_IS, m);
  } else if (cat === "retrait_especes" || /RETRAIT|\bGAB\b/.test(u)) {
    catEff = "retrait_especes";
    // Contrepartie d'un retrait : la CAISSE est débitée de ce que la banque perd.
    cp(compteCaisse(p.dossier), m);
  } else if (cat === "virement_interne" || RX_VIREMENT_INTERNE.test(u)) {
    catEff = "virement_interne";
    cp(PCM.VIREMENTS_DE_FONDS, m);
  } else if (isCr && cat === "interets_crediteurs") {
    // 7381 — c'était 7611, rubrique absente du CGNC (même correction que PCM_MAP).
    cp(PCM.INTERETS_PRODUITS_ASSIMILES, m);
  } else {
    // Règle 1 (modèle Odoo / Bank Suspense) — transaction orpheline (aucune pièce
    // liée et hors catégories déterministes ci-dessus) : on la parque sur le compte
    // d'attente CGNC 3497 (débit) / 4497 (crédit). Le Grand Livre reste équilibré ;
    // le compte définitif sera substitué automatiquement (trigger SQL) dès qu'un
    // justificatif/facture sera associé, même après clôture.
    catEff = "en_attente";
    cp(isCr ? PCM.ATTENTE_BANQUE_CREDIT : PCM.ATTENTE_BANQUE_DEBIT, m);
  }

  return [
    ...contreparties,
    { compte: PCM.BANQUE, libelle: lib, debit: isCr ? m : 0, credit: isCr ? 0 : m, categorie: catEff },
  ];
}
