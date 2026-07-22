/**
 * Mode de règlement RÉELLEMENT constaté d'une facture (client ou fournisseur).
 *
 * Une facture peut être soldée par trois chemins, qui laissent chacun une trace
 * différente — c'est cette trace, et non le mode « prévu » saisi à la création,
 * qui dit comment l'argent a circulé :
 *
 *   1. Encaissement / décaissement manuel (page Banque) → `encaissements.type`
 *      vaut 'especes' ou 'cheque'. Trace EXACTE : l'utilisateur l'a choisi.
 *   2. Lettrage d'une ligne de relevé → `transactions_bancaires.facture_id`.
 *      L'instrument n'est pas stocké : il se lit dans le libellé bancaire
 *      ("VIR RECU", "CHQ N°…", "PRLV", "TPE"). Trace DÉDUITE.
 *   3. Bouton « Payer en espèces » (factures clients) → `marquerPayee` estampille
 *      `factures.mode_reglement = 'especes'` au moment du règlement.
 *
 * D'où l'ordre de priorité : pièce explicite (1) > libellé bancaire (2) > mode
 * stocké sur la facture (3). Le mode stocké arrive en dernier car, tant qu'aucun
 * règlement ne l'a estampillé, il ne vaut que ce que l'OCR a lu sur le document —
 * une intention, pas un fait.
 *
 * Aucune colonne nouvelle en base : tout se déduit de l'existant, y compris pour
 * les factures déjà réglées (cf. mémoire migrations-manuelles-supabase).
 */

export type ModePaiement =
  | "especes"
  | "cheque"
  | "virement"
  | "prelevement"
  | "carte"
  | "effet";

export const MODE_PAIEMENT_LABEL: Record<ModePaiement, string> = {
  especes:     "Espèces",
  cheque:      "Chèque",
  virement:    "Virement",
  prelevement: "Prélèvement",
  carte:       "Carte",
  effet:       "Effet / LCN",
};

/** Pastille colorée : une couleur par instrument, pour lire la colonne d'un coup d'œil. */
export const MODE_PAIEMENT_CLS: Record<ModePaiement, string> = {
  especes:     "bg-emerald-50 text-emerald-700 border-emerald-200",
  cheque:      "bg-sky-50 text-sky-700 border-sky-200",
  virement:    "bg-indigo-50 text-indigo-700 border-indigo-200",
  prelevement: "bg-amber-50 text-amber-700 border-amber-200",
  carte:       "bg-violet-50 text-violet-700 border-violet-200",
  effet:       "bg-rose-50 text-rose-700 border-rose-200",
};

const norm = (v: string | null | undefined) =>
  (v ?? "").toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/**
 * Instrument lu dans le libellé d'une ligne de relevé bancaire.
 *
 * L'ordre des tests compte : "REMISE CHEQUE" et "VIREMENT" peuvent cohabiter dans
 * un même libellé (ex. « VIR RECU REGL CHQ 4412 »), et c'est alors l'instrument le
 * plus spécifique qui gagne. Un libellé non reconnu rend null — on préfère une
 * colonne vide à un mode inventé.
 */
export function modeDepuisLibelle(...textes: (string | null | undefined)[]): ModePaiement | null {
  const t = norm(textes.filter(Boolean).join(" "));
  if (!t) return null;

  // Effets de commerce : LCN / lettre de change, très présents au Maroc.
  if (/\bLCN\b|LETTRE\s+DE\s+CHANGE|\bTRAITE\b|\bEFFET(S)?\b/.test(t)) return "effet";
  // Chèque : "CHQ", "CHEQUE", "REMISE CHQ", "CHEQUE GUICHET".
  if (/\bCHEQUE\b|\bCHQ\b|\bCHEQ\b|REMISE\s+CH/.test(t)) return "cheque";
  if (/\bPRELEVEMENT|\bPRLV\b|\bDOMICILIATION\b|\bAVIS\s+DE\s+PRELEV/.test(t)) return "prelevement";
  // Carte : TPE (terminal commerçant), CB, "PAIEMENT CARTE". "GAB" seul est un
  // retrait d'espèces, pas un paiement par carte — il est traité plus bas.
  if (/\bTPE\b|\bCARTE\b|\bCB\b|PAIEMENT\s+PAR\s+CARTE/.test(t)) return "carte";
  // Espèces : un versement/retrait n'est de l'espèce que si le libellé le dit.
  // « VERSEMENT » seul reste ambigu (versement de fonds par virement interne).
  if (/\bESPECES?\b|\bESP\b|\bNUMERAIRE\b|\bCASH\b|VERSEMENT\s+(D')?ESP|RETRAIT\s+(D')?ESP|\bGAB\b|RETRAIT\s+DAB/.test(t))
    return "especes";
  if (/\bVIREMENT\b|\bVIRT?\b|\bVIR\b|\bTRANSFERT\b|\bSWIFT\b|\bRTGS\b/.test(t)) return "virement";
  return null;
}

/** Normalise un mode déjà stocké (`encaissements.type`, `factures.mode_reglement`). */
export function normaliserMode(v: string | null | undefined): ModePaiement | null {
  const t = norm(v).trim();
  if (!t) return null;
  if (t.startsWith("ESPECE") || t === "CASH" || t === "CAISSE") return "especes";
  if (t.startsWith("CHEQUE") || t === "CHQ") return "cheque";
  if (t.startsWith("VIREMENT") || t === "VIR") return "virement";
  if (t.startsWith("PRELEV")) return "prelevement";
  if (t.startsWith("CARTE") || t === "CB" || t === "TPE") return "carte";
  if (t.startsWith("EFFET") || t === "LCN" || t.startsWith("TRAITE")) return "effet";
  return null;
}

/** Sens de la facture, qui décide de la colonne de rattachement des pièces. */
export type SensFacture = "client" | "fournisseur";

export interface EncaissementRef {
  facture_id?: string | null;
  facture_fournisseur_id?: string | null;
  type?: string | null;
}

export interface TransactionRef {
  facture_id?: string | null;
  document_type?: string | null;
  libelle?: string | null;
  reference?: string | null;
}

/**
 * Index facture → instrument constaté, construit depuis les pièces de règlement.
 *
 * Les transactions sont posées d'abord, puis les encaissements les recouvrent :
 * un mode choisi à la main prime toujours sur un mode déduit d'un libellé.
 */
export function indexerModesPaiement(
  sens: SensFacture,
  sources: { transactions?: TransactionRef[]; encaissements?: EncaissementRef[] },
): Map<string, ModePaiement> {
  const index = new Map<string, ModePaiement>();
  const docType = sens === "client" ? "facture_client" : "facture_fournisseur";

  for (const t of sources.transactions ?? []) {
    if (!t?.facture_id) continue;
    // document_type absent : lignes lettrées avant son introduction (backfill
    // 'inconnu'). On les accepte — l'id de facture suffit à trancher le sens.
    if (t.document_type && t.document_type !== docType && t.document_type !== "inconnu") continue;
    const mode = modeDepuisLibelle(t.libelle, t.reference);
    if (mode && !index.has(t.facture_id)) index.set(t.facture_id, mode);
  }

  for (const e of sources.encaissements ?? []) {
    const id = sens === "client" ? e?.facture_id : e?.facture_fournisseur_id;
    const mode = normaliserMode(e?.type);
    if (id && mode) index.set(id, mode);
  }

  return index;
}

export interface FactureModeRef {
  id: string;
  statut_paiement?: string | null;
  mode_reglement?: string | null;
}

/**
 * Mode à afficher pour une facture. Rend null tant qu'aucun règlement n'est
 * enregistré : une facture en attente n'a pas de mode de paiement, seulement un
 * mode prévu — l'afficher laisserait croire qu'elle est réglée.
 */
export function modePaiementFacture(
  f: FactureModeRef,
  index: Map<string, ModePaiement>,
): ModePaiement | null {
  if (f.statut_paiement !== "payee" && f.statut_paiement !== "partielle") return null;
  return index.get(f.id) ?? normaliserMode(f.mode_reglement);
}
