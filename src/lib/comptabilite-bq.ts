// ============================================================================
// comptabilite-bq.ts — Génération des écritures du Journal de Banque (BQ)
//
// Logique partagée entre la liste des relevés (banque.tsx) et le détail d'un
// relevé (banque.$releveId.tsx) pour la clôture « modèle Odoo / Grand Livre
// continu » : toute transaction non clôturée est comptabilisée, les orphelines
// étant parquées sur le compte d'attente PCM 4711 (débit) / 4712 (crédit).
//
// Source de vérité UNIQUE — ne pas dupliquer ces règles dans les composants.
// ============================================================================

// PCM_MAP selon CGI Art.106 — TVA déductible ou non au Maroc
export const PCM_MAP: Record<string, { code: string; tva: number }> = {
  encaissement_client:  { code: "3421",  tva: 0 },   // Encaissement → pas de TVA
  paiement_fournisseur: { code: "4411",  tva: 20 },  // Achats fournisseur → TVA 20% déductible
  salaires:             { code: "6171",  tva: 0 },   // Salaires → hors champ TVA
  cnss_amo:             { code: "4441",  tva: 0 },   // CNSS/AMO → solde la dette sociale 4441 (la charge 6174 est au journal des salaires)
  tva_dgi:              { code: "4456",  tva: 0 },   // Impôts → solde la dette fiscale, pas de TVA sur TVA
  loyers:               { code: "6131",  tva: 0 },   // Local nu = exonéré; local meublé → modifier manuellement
  eau_electricite:      { code: "6125",  tva: 14 },  // Électricité 14%, eau 7% → déductible
  telecom:              { code: "6145",  tva: 20 },  // IAM/Inwi/Orange → 6145 Frais postaux et télécom, TVA 20% déductible
  gasoil:               { code: "61241", tva: 0 },   // Gasoil véhicules → NON déductible (CGI Art.106)
  assurance:            { code: "6161",  tva: 0 },   // Assurance → exonérée TVA
  entretien:            { code: "6141",  tva: 20 },  // Réparations → TVA 20% déductible
  frais_bancaires:      { code: "6347",  tva: 10 },  // Commissions bancaires → TVA 10% déductible
  taxe_professionnelle: { code: "6313",  tva: 0 },   // Taxes → pas de TVA
  retrait_especes:      { code: "5143",  tva: 0 },   // Retrait → caisse 5143 (PCM), pas de TVA
  virement_interne:     { code: "5115",  tva: 0 },   // Mouvement de fonds entre comptes → compte de liaison, pas de TVA
  interets_crediteurs:  { code: "7611",  tva: 0 },   // Intérêts → hors champ TVA
  frais_representation: { code: "6147",  tva: 0 },   // Restaurant/réception → NON déductible (CGI Art.106)
  frais_douane:         { code: "6146",  tva: 0 },   // Droits douane → pas de TVA récupérable
  transport:            { code: "6142",  tva: 14 },  // Transport marchandises → 6142 Transports, TVA 14% déductible
  autre:                { code: "6141",  tva: 0 },   // Divers → par défaut sans TVA
};

// ─── Dérive une catégorie PCM depuis le libellé bancaire (fallback sans IA) ──
// Mouvements de fonds internes : VIR AG EMIS, VERS/VERSEMENT (cf. analyse-regles-pcm.md règle 4)
export const RX_VIREMENT_INTERNE = /VIR\.?\s*AG\.?\s*EMIS|VIREMENT\s+INTERNE|^VERS(EMENT)?\b/;

export function deriveCategorie(libelle: string, type: "credit" | "debit"): { categorie: string; code: string; tva: number } {
  const u = (libelle || "").toUpperCase();
  if (RX_VIREMENT_INTERNE.test(u))                        return { categorie: "virement_interne",     code: "5115",  tva: 0 };
  if (type === "credit") return { categorie: "encaissement_client", code: "3421", tva: 0 };
  if (/\bCNSS\b|AMO\b/.test(u))                          return { categorie: "cnss_amo",             code: "4441",  tva: 0 };
  if (/\bTVA\b|\bDGI\b|\bIR\b|\bIS\b|IMPOT/.test(u))    return { categorie: "tva_dgi",              code: "4456",  tva: 0 };
  if (/SALAIRE|PAIE|REMUNERATION/.test(u))                return { categorie: "salaires",             code: "6171",  tva: 0 };
  if (/\bIAM\b|ORANGE|INWI|TELECOM|INTERNET/.test(u))    return { categorie: "telecom",              code: "6145",  tva: 20 };
  if (/LOYER|LOCATION/.test(u))                           return { categorie: "loyers",               code: "6131",  tva: 0 };
  if (/\bEAU\b|ONEE|ELECTRICITE/.test(u))                return { categorie: "eau_electricite",      code: "6125",  tva: 14 };
  if (/GASOIL|CARBURANT|STATION/.test(u))                 return { categorie: "gasoil",              code: "61241", tva: 0 };
  if (/ASSURANCE/.test(u))                                return { categorie: "assurance",            code: "6161",  tva: 0 };
  if (/COMMISSION|FRAIS|AGIOS|TENUE|TIMBRE/.test(u))     return { categorie: "frais_bancaires",      code: "6347",  tva: 10 };
  if (/RETRAIT|GAB/.test(u))                              return { categorie: "retrait_especes",      code: "5143",  tva: 0 };
  if (/DOUANE|IMPORT/.test(u))                            return { categorie: "frais_douane",         code: "6146",  tva: 0 };
  if (/TRANSPORT|DEPLACEMENT/.test(u))                    return { categorie: "transport",            code: "6142",  tva: 14 };
  return { categorie: "paiement_fournisseur", code: "4411", tva: 20 };
}

// ─── Lignes d'écriture Journal de Banque (BQ) — règles PCM (cf. analyse-regles-pcm.md) ──
// 1. Sans document lié → compte d'attente 4711 (débit) / 4712 (crédit), jamais de compte de charge deviné
// 2. Facture fournisseur liée → Débit 4411 TTC / Crédit 5141 TTC (la TVA est gérée au journal d'achats)
// 3. Justificatif lié → Débit compte charge HT + Débit 34552 TVA si eligible_edi=true et taux > 0, sinon TTC intégral
// 4. Virement interne (VIR AG EMIS / VERS) → 5115 Virements de fonds, pas de TVA
// 5. Retrait espèces → 5143 Caisse (5161 n'existe pas au PCM)
// 6. CNSS → 4441 (dette sociale) ; TVA/IS/DGI → 4456 — on solde la dette, pas de charge directe
// 7. Facture client liée (crédit) → Débit 5141 / Crédit 3421
export type LigneBQ = { compte: string; libelle: string; debit: number; credit: number; categorie: string };

export function genererLignesBQ(p: {
  libelle: string | null;
  type: string;
  montant: number;
  categorie?: string | null;
  // Compte PCM affiché dans l'UI pour la transaction. NON UTILISÉ pour choisir la
  // contrepartie : depuis le modèle « bank suspense », une transaction sans pièce va
  // toujours en 4711/4712, jamais sur un compte de charge deviné. Conservé car des
  // appelants le passent encore.
  compteComptable?: string | null;
  factureLiee?: boolean;
  justificatif?: { compte_pcm?: string | null; taux_tva?: number | null; eligible_edi?: boolean | null } | null;
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
    const compte = justif.compte_pcm || (PCM_MAP[cat]?.code ?? "6141");
    const taux = Number(justif.taux_tva) || 0;
    if (!isCr && justif.eligible_edi === true && taux > 0) {
      const ht = Math.round(m / (1 + taux / 100) * 100) / 100;
      const tva = Math.round((m - ht) * 100) / 100;
      cp(compte, ht);
      cp("34552", tva, { libelle: `TVA ${lib.slice(0, 50)}`, categorie: "tva_deductible" });
    } else {
      cp(compte, m);
    }
  } else if (p.factureLiee) {
    // Règles 2 et 7 — solder le compte de tiers pour le TTC, jamais de TVA en banque
    catEff = isCr ? "encaissement_client" : "paiement_fournisseur";
    cp(isCr ? "3421" : "4411", m);
  } else if (cat === "cnss_amo" || /\bCNSS\b|\bAMO\b/.test(u)) {
    catEff = "cnss_amo";
    cp("4441", m);
  } else if (cat === "tva_dgi") {
    cp("4456", m);
  } else if (cat === "retrait_especes" || /RETRAIT|\bGAB\b/.test(u)) {
    catEff = "retrait_especes";
    cp("5143", m);
  } else if (cat === "virement_interne" || RX_VIREMENT_INTERNE.test(u)) {
    catEff = "virement_interne";
    cp("5115", m);
  } else if (isCr && cat === "interets_crediteurs") {
    cp("7611", m);
  } else {
    // Règle 1 (modèle Odoo / Bank Suspense) — transaction orpheline (aucune pièce
    // liée et hors catégories déterministes ci-dessus) : on la parque sur le compte
    // d'attente PCM 4711 (débit) / 4712 (crédit). Le Grand Livre reste équilibré ;
    // le compte définitif sera substitué automatiquement (trigger SQL) dès qu'un
    // justificatif/facture sera associé, même après clôture.
    catEff = "en_attente";
    cp(isCr ? "4712" : "4711", m);
  }

  return [
    ...contreparties,
    { compte: "5141", libelle: lib, debit: isCr ? m : 0, credit: isCr ? 0 : m, categorie: catEff },
  ];
}
