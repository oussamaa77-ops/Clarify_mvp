/**
 * Logique d'affichage propre à CHAQUE type de justificatif.
 *
 * Un justificatif ne se lit pas de la même façon selon sa nature : une quittance
 * de loyer se résume à une période et un bailleur, une quittance CNSS à une
 * période de cotisation hors champ TVA, un bon de livraison à des quantités
 * livrées SANS montant. Ce module centralise cette logique pour que les tableaux
 * (Clients, Fournisseurs) affichent les « détails essentiels » du type, et non
 * six colonnes génériques dont la moitié est vide.
 *
 * Pourquoi ne pas se fier au seul `type_document` ? La contrainte CHECK en base
 * rabat la plupart des quittances sur "recu" (cf. toDbType dans la page
 * Justificatifs) : le type réel doit donc être re-dérivé à partir du trio
 * type_document + categorie_pcm + compte_pcm.
 */

export interface JustificatifLike {
  type_document?: string | null;
  categorie_pcm?: string | null;
  compte_pcm?: string | null;
  nom_tiers?: string | null;
  numero_piece?: string | null;
  numero_commande?: string | null;
  date_document?: string | null;
  date_commande?: string | null;
  montant_ht?: number | null;
  montant_ttc?: number | null;
  taux_tva?: number | null;
  eligible_edi?: boolean | null;
  lignes?: { designation?: string | null; quantite?: number | null }[] | null;
}

export type JustificatifKind =
  | "quittance_loyer"
  | "cnss"
  | "bon_livraison"
  | "bon_commande"
  | "dum"
  | "energie"
  | "carburant"
  | "restauration"
  | "timbre_bancaire"
  | "telecom"
  | "assurance"
  | "facture"
  | "recu";

export interface DetailChip {
  label: string;
  value: string;
  /** Met la valeur en avant (police mono/semibold) : montants, numéros de pièce. */
  mono?: boolean;
}

export interface JustificatifDetails {
  kind: JustificatifKind;
  /** Libellé métier affiché dans le badge Type. */
  label: string;
  /** Classes du badge — une couleur par famille de logique. */
  cls: string;
  /** Détails essentiels du type, dans l'ordre de lecture métier. */
  chips: DetailChip[];
  /** Montant à afficher en colonne, ou null si le type n'en porte pas (BL). */
  montant: number | null;
  /** Règle fiscale attachée au type (Art. 106, RAS IR, hors champ TVA…). */
  note?: string;
}

const fmtMad = (n: number) =>
  Number(n).toLocaleString("fr-MA", { minimumFractionDigits: 2 }) + " MAD";

const fmtDate = (d?: string | null) =>
  d ? new Date(d).toLocaleDateString("fr-MA") : "—";

const MOIS_FR = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];

/**
 * Période couverte par le document (loyer, cotisation, consommation).
 * On la cherche d'abord dans les désignations de lignes — l'OCR y écrit
 * « période 03/2026 », « Consommation eau — période … » — puis on retombe sur
 * le mois de la date du document, qui est la convention pour un loyer mensuel.
 */
export function extrairePeriode(j: JustificatifLike): string | null {
  const textes = (j.lignes ?? [])
    .map((l) => (l?.designation ?? "").trim())
    .filter(Boolean);

  for (const t of textes) {
    const explicite = t.match(/p[ée]riode\s*:?\s*([^—\-·|]+)/i);
    if (explicite) return explicite[1].trim();
    const moisAnnee = t.match(/\b(0?[1-9]|1[0-2])\s*[\/\-]\s*(20\d{2})\b/);
    if (moisAnnee) return `${MOIS_FR[Number(moisAnnee[1]) - 1]} ${moisAnnee[2]}`;
    const nomMois = t.match(
      /\b(janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre)\s+(20\d{2})\b/i,
    );
    if (nomMois) return `${nomMois[1].toLowerCase()} ${nomMois[2]}`;
  }

  if (j.date_document) {
    const d = new Date(j.date_document);
    if (!isNaN(d.getTime())) return `${MOIS_FR[d.getMonth()]} ${d.getFullYear()}`;
  }
  return null;
}

const compteCommence = (j: JustificatifLike, ...prefixes: string[]) => {
  const c = String(j.compte_pcm ?? "");
  return prefixes.some((p) => c.startsWith(p));
};

/**
 * Type effectif du justificatif — voir l'en-tête du module : le `type_document`
 * stocké est appauvri par la contrainte CHECK, la catégorie PCM et le compte
 * comptable font foi dès qu'ils sont plus précis.
 */
export function resolveJustificatifKind(j: JustificatifLike): JustificatifKind {
  const type = String(j.type_document ?? "");
  const cat = String(j.categorie_pcm ?? "");

  // Les pièces de flux commercial se reconnaissent à leur seul type_document.
  if (type === "bon_livraison") return "bon_livraison";
  if (type === "bon_commande" || cat === "acompte_fournisseur") return "bon_commande";
  if (type === "dum" || cat === "tva_import" || cat === "frais_douane") return "dum";

  // Quittances : le compte comptable est le discriminant le plus fiable.
  if (type === "quittance_loyer" || cat === "loyers" || compteCommence(j, "6131")) return "quittance_loyer";
  if (cat === "cnss_amo" || cat === "charges_sociales" || compteCommence(j, "6174")) return "cnss";
  if (cat === "eau_electricite" || compteCommence(j, "6125")) return "energie";
  if (cat === "gasoil" || compteCommence(j, "61241", "61223")) return "carburant";
  if (cat === "telecom" || compteCommence(j, "6132")) return "telecom";
  if (cat === "assurance" || compteCommence(j, "6161")) return "assurance";
  if (cat === "frais_representation" || type === "addition" || compteCommence(j, "6147")) return "restauration";
  if (cat === "droits_timbre" || cat === "frais_bancaires" || type === "avis_debit" || compteCommence(j, "61671", "6347"))
    return "timbre_bancaire";

  if (type === "facture") return "facture";
  return "recu";
}

/**
 * Détails essentiels + règle fiscale du justificatif, selon sa logique propre.
 */
export function justificatifDetails(j: JustificatifLike): JustificatifDetails {
  const kind = resolveJustificatifKind(j);
  const ttc = Number(j.montant_ttc ?? 0);
  const ht = Number(j.montant_ht ?? 0);
  const tva = Math.max(0, ttc - ht);
  const tiers = j.nom_tiers?.trim() || null;
  const piece = j.numero_piece?.trim() || null;
  const periode = extrairePeriode(j);
  const nbLignes = (j.lignes ?? []).length;

  switch (kind) {
    // Loyer : ce qui compte est la période louée et l'identité du bailleur —
    // le montant est net de TVA, et la RAS IR dépend du statut du propriétaire.
    case "quittance_loyer":
      return {
        kind, label: "Quittance loyer", cls: "bg-amber-50 text-amber-700 border-amber-200",
        montant: ttc,
        chips: [
          { label: "Période", value: periode ?? "—" },
          { label: "Bailleur", value: tiers ?? "—" },
          { label: "N° quittance", value: piece ?? "—", mono: true },
          { label: "Loyer", value: fmtMad(ttc), mono: true },
        ],
        note: "RAS IR (Art. 57 CGI) si le bailleur est un particulier · hors relevé de déduction EDI.",
      };

    // CNSS : une déclaration de cotisation, pas un achat. Ni TVA ni EDI.
    case "cnss":
      return {
        kind, label: "Quittance CNSS", cls: "bg-sky-50 text-sky-700 border-sky-200",
        montant: ttc,
        chips: [
          { label: "Période de cotisation", value: periode ?? "—" },
          { label: "Organisme", value: tiers ?? "CNSS" },
          { label: "N° affiliation", value: piece ?? "—", mono: true },
          { label: "Cotisations", value: fmtMad(ttc), mono: true },
        ],
        note: "Charges sociales (6174) — hors champ TVA, à exclure du relevé de déduction EDI DGI.",
      };

    // Bon de livraison : pièce de suivi physique. Il n'a pas de valeur comptable :
    // afficher un montant/TVA ici induirait en erreur, on montre les quantités.
    case "bon_livraison": {
      const qte = (j.lignes ?? []).reduce((s, l) => s + Number(l?.quantite ?? 0), 0);
      return {
        kind, label: "Bon de livraison", cls: "bg-violet-50 text-violet-700 border-violet-200",
        montant: null,
        chips: [
          { label: "N° BL", value: piece ?? "—", mono: true },
          { label: "Date livraison", value: fmtDate(j.date_document) },
          { label: "Réf. commande", value: j.numero_commande?.trim() || "—", mono: true },
          { label: "Articles livrés", value: qte > 0 ? String(qte) : String(nbLignes) },
        ],
        note: "Pièce de suivi sans portée comptable — à rapprocher du bon de commande puis de la facture.",
      };
    }

    // Bon de commande / acompte : un engagement, pas une charge. Compte 3411.
    case "bon_commande":
      return {
        kind, label: "Bon de commande", cls: "bg-indigo-50 text-indigo-700 border-indigo-200",
        montant: ttc,
        chips: [
          { label: "N° commande", value: j.numero_commande?.trim() || piece || "—", mono: true },
          { label: "Date commande", value: fmtDate(j.date_commande ?? j.date_document) },
          { label: "Montant engagé", value: fmtMad(ttc), mono: true },
          { label: "Articles", value: String(nbLignes) },
        ],
        note: "Acompte / engagement (3411) — pas de TVA déductible tant que la livraison n'est pas faite.",
      };

    // DUM : c'est le numéro de quittance douanière qui tient lieu de n° de facture.
    case "dum":
      return {
        kind, label: "DUM / Import", cls: "bg-teal-50 text-teal-700 border-teal-200",
        montant: ttc,
        chips: [
          { label: "N° quittance douanière", value: piece ?? "—", mono: true },
          { label: "Dédouanement", value: fmtDate(j.date_document) },
          { label: "Base HT", value: fmtMad(ht), mono: true },
          { label: "TVA import", value: fmtMad(tva), mono: true },
        ],
        note: "TVA récupérable à l'importation (Art. 92 CGI) — le n° de quittance remplace le n° de facture pour l'EDI DGI.",
      };

    // Eau / électricité : période de consommation + taux TVA spécifique (7 % / 14 %).
    case "energie":
      return {
        kind, label: "Quittance eau / élec.", cls: "bg-cyan-50 text-cyan-700 border-cyan-200",
        montant: ttc,
        chips: [
          { label: "Période de consommation", value: periode ?? "—" },
          { label: "Distributeur", value: tiers ?? "—" },
          { label: "N° police", value: piece ?? "—", mono: true },
          { label: "HT / TVA", value: `${fmtMad(ht)} · ${fmtMad(tva)}`, mono: true },
        ],
        note: "TVA récupérable au taux du fluide (eau 7 % · électricité 14 %).",
      };

    // Carburant : TVA non déductible → seul le TTC a un sens comptable.
    case "carburant":
      return {
        kind, label: "Carburant", cls: "bg-orange-50 text-orange-700 border-orange-200",
        montant: ttc,
        chips: [
          { label: "Date", value: fmtDate(j.date_document) },
          { label: "Station", value: tiers ?? "—" },
          { label: "Montant TTC", value: fmtMad(ttc), mono: true },
          { label: "N° ticket", value: piece ?? "—", mono: true },
        ],
        note: "Art. 106 CGI — TVA non déductible sur carburant (véhicules de tourisme). TTC intégral en charge.",
      };

    // Restauration / réception : idem, TVA non déductible et hors EDI.
    case "restauration":
      return {
        kind, label: "Restaurant / Réception", cls: "bg-rose-50 text-rose-700 border-rose-200",
        montant: ttc,
        chips: [
          { label: "Date", value: fmtDate(j.date_document) },
          { label: "Établissement", value: tiers ?? "—" },
          { label: "Montant TTC", value: fmtMad(ttc), mono: true },
          { label: "Postes", value: String(nbLignes) },
        ],
        note: "Art. 106 CGI — TVA non déductible sur frais de bouche et de réception (6147).",
      };

    // Timbres / frais bancaires : taxes et commissions, hors champ TVA déductible.
    case "timbre_bancaire":
      return {
        kind, label: "Timbre / Frais bancaires", cls: "bg-slate-100 text-slate-700 border-slate-200",
        montant: ttc,
        chips: [
          { label: "Date", value: fmtDate(j.date_document) },
          { label: "Banque / Émetteur", value: tiers ?? "—" },
          { label: "N° pièce", value: piece ?? "—", mono: true },
          { label: "Montant", value: fmtMad(ttc), mono: true },
        ],
        note: "Hors champ TVA (taxe / commission) — à exclure du relevé de déduction EDI DGI.",
      };

    case "telecom":
      return {
        kind, label: "Télécom", cls: "bg-blue-50 text-blue-700 border-blue-200",
        montant: ttc,
        chips: [
          { label: "Période", value: periode ?? "—" },
          { label: "Opérateur", value: tiers ?? "—" },
          { label: "N° ligne / contrat", value: piece ?? "—", mono: true },
          { label: "HT / TVA", value: `${fmtMad(ht)} · ${fmtMad(tva)}`, mono: true },
        ],
        note: "TVA 20 % récupérable sur abonnement professionnel (6132).",
      };

    case "assurance":
      return {
        kind, label: "Assurance", cls: "bg-emerald-50 text-emerald-700 border-emerald-200",
        montant: ttc,
        chips: [
          { label: "Période couverte", value: periode ?? "—" },
          { label: "Assureur", value: tiers ?? "—" },
          { label: "N° police", value: piece ?? "—", mono: true },
          { label: "Prime", value: fmtMad(ttc), mono: true },
        ],
        note: "Prime d'assurance (6161) — opération exonérée de TVA.",
      };

    // Facture / reçu : la lecture classique HT · TVA · TTC.
    default:
      return {
        kind, label: kind === "facture" ? "Facture" : "Reçu",
        cls: "bg-muted text-foreground/80 border-border",
        montant: ttc,
        chips: [
          { label: "N° pièce", value: piece ?? "—", mono: true },
          { label: "Date", value: fmtDate(j.date_document) },
          { label: "HT", value: fmtMad(ht), mono: true },
          { label: `TVA${j.taux_tva ? ` ${j.taux_tva}%` : ""}`, value: fmtMad(tva), mono: true },
        ],
      };
  }
}
