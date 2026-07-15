// Logique de périodes et d'indicateurs du reporting Tiers (clients / fournisseurs).
// Pure et testable : le composant TiersReporting ne fait que charger les données et afficher.

export const MOIS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

export type Gran = "jour" | "mois" | "trimestre" | "semestre" | "annee";
export const GRAN_LABEL: Record<Gran, string> = {
  jour: "Jour", mois: "Mois", trimestre: "Trimestre", semestre: "Semestre", annee: "Année",
};

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m0: number, d: number) => `${y}-${pad(m0 + 1)}-${pad(d)}`;
const lastDay = (y: number, m0: number) => new Date(y, m0 + 1, 0).getDate();
export const toISO = (a: Date) => ymd(a.getFullYear(), a.getMonth(), a.getDate());

export interface Periode { startStr: string; endStr: string; label: string; }

/** Bornes civiles de la période contenant `anchorStr` (yyyy-mm-dd), pour la granularité donnée. */
export function periodBounds(gran: Gran, anchorStr: string): Periode {
  const a = new Date(anchorStr + "T00:00:00");
  const y = a.getFullYear(), m = a.getMonth(), d = a.getDate();
  switch (gran) {
    case "jour":      return { startStr: ymd(y, m, d), endStr: ymd(y, m, d), label: `${pad(d)}/${pad(m + 1)}/${y}` };
    case "mois":      return { startStr: ymd(y, m, 1), endStr: ymd(y, m, lastDay(y, m)), label: `${MOIS[m]} ${y}` };
    case "trimestre": { const q = Math.floor(m / 3), sm = q * 3, em = sm + 2; return { startStr: ymd(y, sm, 1), endStr: ymd(y, em, lastDay(y, em)), label: `T${q + 1} ${y}` }; }
    case "semestre":  { const s = m < 6 ? 0 : 1, sm = s * 6, em = sm + 5; return { startStr: ymd(y, sm, 1), endStr: ymd(y, em, lastDay(y, em)), label: `S${s + 1} ${y}` }; }
    case "annee":     return { startStr: ymd(y, 0, 1), endStr: ymd(y, 11, 31), label: `${y}` };
  }
}

/**
 * Ancre de la période qui précède immédiatement celle de `anchorStr`.
 * Dérivée de la veille du premier jour de la période courante : ne peut pas déborder,
 * contrairement à un décalage de mois (setMonth(-3) sur un 31 vise un jour inexistant
 * et JS bascule sur le mois suivant — le 31/12 renvoyait alors le 01/10, même trimestre).
 */
export function previousPeriodAnchor(gran: Gran, anchorStr: string): string {
  const d = new Date(periodBounds(gran, anchorStr).startStr + "T00:00:00");
  d.setDate(d.getDate() - 1);
  return toISO(d);
}

const frDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
/** « du 01/10/2026 au 31/12/2026 » — lève toute ambiguïté sur la période retenue. */
export const formatPeriodeRange = (p: Periode) =>
  p.startStr === p.endStr ? `le ${frDate(p.startStr)}` : `du ${frDate(p.startStr)} au ${frDate(p.endStr)}`;

/**
 * Jour civil local d'une valeur Postgres.
 * DATE (« 2026-10-04 ») est déjà un jour civil : on le garde tel quel.
 * TIMESTAMPTZ est sérialisé en UTC : un tiers créé le 01/10 à 00h30 à Casablanca (UTC+1)
 * porte « 2026-09-30T23:30:00Z » et tombait dans le trimestre précédent.
 */
export function jourLocal(v: string | null | undefined): string | null {
  if (!v) return null;
  if (v.length <= 10) return v.slice(0, 10);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : toISO(d);
}

const dansPeriode = (jour: string | null, p: Periode) => jour !== null && jour >= p.startStr && jour <= p.endStr;

/** Clé de rapprochement d'un nom de tiers : sans accents, sans casse, sans ponctuation. */
export const normNom = (s: string | null | undefined) =>
  (s ?? "")
    .normalize("NFD").replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Index nom normalisé → id de tiers. Un nom porté par plusieurs tiers est marqué
 * ambigu (null) : on préfère ne pas rattacher une facture plutôt que la rattacher au mauvais.
 */
export function indexTiersParNom(tiers: { id: string; nom?: string | null }[]): Map<string, string | null> {
  const m = new Map<string, string | null>();
  for (const t of tiers) {
    const k = normNom(t.nom);
    if (!k) continue;
    m.set(k, m.has(k) ? null : t.id);
  }
  return m;
}

export interface TiersRow { id: string; nom?: string | null; created_at?: string | null; deleted_at?: string | null; }
export interface FactureRow {
  date_facture?: string | null; date_paiement?: string | null;
  montant_ht?: number | null; montant_ttc?: number | null; montant_restant?: number | null;
  statut_paiement?: string | null;
  /** Nature/rôle du document (enum consolidé `factures.type`) : 'acompte' exclu du CA. */
  type?: string | null;
  [k: string]: unknown;
}
export interface TiersJoin {
  /** Colonne de clé étrangère : "client_id" | "fournisseur_id". */
  tiersKey: string;
  /** Colonne de nom dénormalisé sur la facture, si la FK est nullable ("fournisseur_nom"). */
  factureNomKey?: string;
}

/**
 * Les trois états d'un tiers existant à la fin de la période. C'est une partition :
 * actifs + passifs + nouveaux sans facture = total. L'ordre est celui de l'empilement
 * du graphique de composition, et il fixe l'ordre des couleurs — jamais recyclé.
 */
export type CategorieTiers = "actif" | "passif" | "nouveau_sans_facture";
export const CATEGORIES: readonly CategorieTiers[] = ["actif", "passif", "nouveau_sans_facture"] as const;

export interface IndicsTiers {
  total: number; nouveaux: number; perdus: number;
  actifs: number; passifs: number; nouveauxSansFacture: number;
  caTotal: number; caMoyen: number; encours: number; delai: number | null;
}

export interface DetailTiers {
  id: string; nom: string; categorie: CategorieTiers;
  /** Achats/CA HT du tiers sur la période, hors acomptes. */
  caPeriode: number;
  /** Reste dû cumulé à la fin de la période. */
  encours: number;
  /** Dernière facture émise à la fin de la période, ou null si le tiers n'a jamais facturé. */
  derniereFacture: string | null;
}

/**
 * Socle commun aux agrégats et au détail nominatif : une seule définition de
 * « existant », « nouveau » et « actif », pour que le graphique, le tableau et le
 * drill-down ne puissent pas raconter trois histoires différentes.
 */
function partitionner(p: Periode, tiers: TiersRow[], factures: FactureRow[], join: TiersJoin) {
  const cree = (t: TiersRow) => jourLocal(t.created_at);
  const supprime = (t: TiersRow) => jourLocal(t.deleted_at);

  // Existants à la fin de la période (créés avant la fin, non supprimés à la fin).
  const existants = tiers.filter(t => {
    const c = cree(t), s = supprime(t);
    return c !== null && c <= p.endStr && (s === null || s > p.endStr);
  });
  const existantsIds = new Set(existants.map(t => t.id));

  // Flux de la période : `nouveaux` inclut un tiers créé puis supprimé avant la fin
  // (absent de `total`, présent dans `perdus`).
  const nouveauxIds = new Set(tiers.filter(t => dansPeriode(cree(t), p)).map(t => t.id));
  const perdus = tiers.filter(t => dansPeriode(supprime(t), p)).length;

  // Rattachement facture → tiers : la FK d'abord, le nom dénormalisé en secours.
  // Sans ce secours, toute facture saisie sans fournisseur_id (fournisseur_nom seul)
  // rendait son fournisseur passif alors qu'il facturait sur la période.
  const parNom = join.factureNomKey ? indexTiersParNom(existants) : null;
  const resoudre = (f: FactureRow): string | null => {
    const fk = f[join.tiersKey];
    if (typeof fk === "string" && fk) return fk;
    if (!parNom || !join.factureNomKey) return null;
    const k = normNom(f[join.factureNomKey] as string | null);
    const id = k ? parNom.get(k) ?? null : null;
    return id !== null && existantsIds.has(id) ? id : null;
  };

  const facturesP = factures.filter(f => dansPeriode(jourLocal(f.date_facture), p));

  // Actif = tiers existant portant ≥ 1 facture sur la période.
  const actifsIds = new Set(
    facturesP.map(resoudre).filter((id): id is string => id !== null && existantsIds.has(id)),
  );

  // Passif = existant, sans facture sur la période, et déjà présent avant elle. Un tiers
  // créé sur la période n'est pas passif : il n'a pas eu le temps de le devenir. Il est
  // « nouveau sans facture » tant qu'il n'a rien facturé — une catégorie à part entière,
  // sans quoi actifs + passifs ne retomberait pas sur le total.
  const categorie = (id: string): CategorieTiers =>
    actifsIds.has(id) ? "actif" : nouveauxIds.has(id) ? "nouveau_sans_facture" : "passif";

  return { existants, existantsIds, nouveauxIds, perdus, resoudre, facturesP, actifsIds, categorie };
}

export function calcTiers(p: Periode, tiers: TiersRow[], factures: FactureRow[], join: TiersJoin): IndicsTiers {
  const { existants, nouveauxIds, perdus, facturesP, actifsIds, categorie } = partitionner(p, tiers, factures, join);

  const total = existants.length;
  const actifs = actifsIds.size;
  const passifs = existants.filter(t => categorie(t.id) === "passif").length;
  const nouveauxSansFacture = existants.filter(t => categorie(t.id) === "nouveau_sans_facture").length;

  // CA / Achats HT (hors acomptes côté clients).
  const caTotal = facturesP
    .filter(f => f.type !== "acompte")
    .reduce((s, f) => s + Number(f.montant_ht ?? 0), 0);
  // Rapporté à tous les tiers ayant existé sur la période : existants à la fin + partis en cours.
  const baseTiers = total + perdus;
  const caMoyen = baseTiers > 0 ? caTotal / baseTiers : 0;

  // Créances / dettes restant dues à la fin de la période.
  const encours = factures
    .filter(f => {
      const j = jourLocal(f.date_facture);
      return j !== null && j <= p.endStr && f.statut_paiement !== "payee";
    })
    .reduce((s, f) => s + Number(f.montant_restant ?? f.montant_ttc ?? 0), 0);

  // Délai moyen de paiement (jours) sur les factures réglées dans la période.
  const payees = factures.filter(f => dansPeriode(jourLocal(f.date_paiement), p) && f.date_facture);
  const delai = payees.length
    ? Math.round(payees.reduce((s, f) => s + (Date.parse(f.date_paiement!) - Date.parse(f.date_facture!)) / 86400000, 0) / payees.length)
    : null;

  return { total, nouveaux: nouveauxIds.size, perdus, actifs, passifs, nouveauxSansFacture, caTotal, caMoyen, encours, delai };
}

/** Détail nominatif des tiers existants à la fin de la période — support du drill-down. */
export function detailTiers(p: Periode, tiers: TiersRow[], factures: FactureRow[], join: TiersJoin): DetailTiers[] {
  const { existants, resoudre, facturesP, categorie } = partitionner(p, tiers, factures, join);

  const ca = new Map<string, number>();
  for (const f of facturesP) {
    const id = resoudre(f);
    if (id === null || f.type === "acompte") continue;
    ca.set(id, (ca.get(id) ?? 0) + Number(f.montant_ht ?? 0));
  }

  const encours = new Map<string, number>();
  const derniere = new Map<string, string>();
  for (const f of factures) {
    const j = jourLocal(f.date_facture);
    if (j === null || j > p.endStr) continue;
    const id = resoudre(f);
    if (id === null) continue;
    const d = derniere.get(id);
    if (d === undefined || j > d) derniere.set(id, j);
    if (f.statut_paiement !== "payee") {
      encours.set(id, (encours.get(id) ?? 0) + Number(f.montant_restant ?? f.montant_ttc ?? 0));
    }
  }

  return existants.map(t => ({
    id: t.id,
    nom: t.nom?.trim() || "(sans nom)",
    categorie: categorie(t.id),
    caPeriode: ca.get(t.id) ?? 0,
    encours: encours.get(t.id) ?? 0,
    derniereFacture: derniere.get(t.id) ?? null,
  }));
}

/**
 * Ordre décroissant demandé au comptable : la plus grosse dette d'abord. À dette égale,
 * le plus gros volume d'achats, puis le plus anciennement facturé (« jamais » en tête,
 * c'est le plus passif de tous), puis le nom.
 */
export function trierDetail(rows: DetailTiers[]): DetailTiers[] {
  return [...rows].sort((a, b) => {
    if (b.encours !== a.encours) return b.encours - a.encours;
    if (b.caPeriode !== a.caPeriode) return b.caPeriode - a.caPeriode;
    const da = a.derniereFacture ?? "", db = b.derniereFacture ?? "";
    if (da !== db) return da < db ? -1 : 1;
    return a.nom.localeCompare(b.nom, "fr");
  });
}
