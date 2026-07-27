/**
 * DonutRepartitionPcm — donut de répartition par COMPTE PCM, partagé par les
 * dépenses (classe 6) et les ventes (classe 7).
 *
 * Un seul rendu pour les deux widgets : c'est ce qui garantit qu'ils ne
 * divergeront pas (mêmes seuils d'étiquette, même infobulle, même palette
 * validée). Les composants publics `RepartitionDepensesPcm` et
 * `RepartitionVentesPcm` ne font que le nommer — le calcul, lui, vit dans
 * `ventilerChargesParCompte` / `ventilerVentesParCompte` (logique pure, testée).
 *
 * ─── Couleurs ────────────────────────────────────────────────────────────────
 * Palette catégorielle vérifiée par le validateur daltonisme sur ses paires
 * ADJACENTES, dans les deux thèmes (worst CVD ΔE 9.1 clair / 8.4 sombre, seuil
 * 8 ; vision normale 22.9 / 16.1, plancher 15). Les tranches étant ordonnées par
 * poids, l'adjacence dans l'anneau EST l'ordre des slots : les couleurs sont donc
 * attribuées dans l'ordre d'affichage, ce qui est précisément l'ordre validé.
 * Le reliquat sort de la palette (gris neutre) : ce n'est pas un poste mais un
 * regroupement, et il occupe toujours la dernière tranche.
 *
 * Trois teintes claires passent sous 3:1 de contraste sur fond clair : la règle
 * de relief impose alors des étiquettes visibles — d'où le code PCM + le
 * pourcentage écrits DIRECTEMENT sur chaque tranche, doublés d'une légende
 * détaillée. L'identité d'une tranche ne repose jamais sur la seule couleur.
 */

import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { COMPTE_AUTRES, type PartComptePcm } from "@/lib/dashboard-fiscal";

const fmtMad = (n: number) =>
  Number(n).toLocaleString("fr-MA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " MAD";
const fmtPart = (p: number) => (p * 100).toLocaleString("fr-MA", { maximumFractionDigits: 1 }) + " %";

/**
 * Slots catégoriels, dans l'ordre validé. Chaque valeur est une variable CSS
 * déclarée sur le conteneur avec sa déclinaison sombre : la couleur suit le
 * thème sans que le composant ait à connaître le thème courant.
 */
const SLOTS = ["var(--viz-1)", "var(--viz-2)", "var(--viz-3)", "var(--viz-4)", "var(--viz-5)"];
const SLOT_AUTRES = "var(--viz-autres)";

/** Teintes clair / sombre des slots (cf. en-tête : jeu validé, ne pas panacher). */
const VARS_COULEURS = [
  "[--viz-1:#2a78d6]", "dark:[--viz-1:#3987e5]",
  "[--viz-2:#eb6834]", "dark:[--viz-2:#d95926]",
  "[--viz-3:#1baf7a]", "dark:[--viz-3:#199e70]",
  "[--viz-4:#eda100]", "dark:[--viz-4:#c98500]",
  "[--viz-5:#4a3aa7]", "dark:[--viz-5:#9085e9]",
  "[--viz-autres:#898781]",
  // Fond de la carte : sert de séparateur de 2 px entre deux tranches.
  "[--viz-surface:#fcfcfb]", "dark:[--viz-surface:#1a1a19]",
].join(" ");

const couleur = (p: PartComptePcm, i: number) =>
  p.compte === COMPTE_AUTRES ? SLOT_AUTRES : SLOTS[i % SLOTS.length];

/** En dessous, l'étiquette collée à la tranche chevaucherait sa voisine. */
const SEUIL_ETIQUETTE = 0.04;

/**
 * Résumé du reliquat dans la légende. Le regroupement s'applique dès le 6e
 * compte : le reliquat peut donc n'en contenir qu'un seul, et on le nomme alors
 * plutôt que d'afficher un décompte qui cacherait une information disponible.
 */
const resumeRegroupes = (comptes: string[]) =>
  comptes.length === 1 ? comptes[0] : `${comptes.length} comptes regroupés`;

export interface DonutRepartitionPcmProps {
  parts: PartComptePcm[];
  /** Total HT affiché (somme exacte des tranches). */
  total: number;
  /** Légende du total au centre de l'anneau (« Charges HT », « Ventes HT »). */
  libelleTotal: string;
  /** Message affiché quand il n'y a rien à ventiler. */
  messageVide: string;
}

export function DonutRepartitionPcm({ parts, total, libelleTotal, messageVide }: DonutRepartitionPcmProps) {
  if (parts.length === 0) {
    return <p className="text-sm text-muted-foreground py-12 text-center">{messageVide}</p>;
  }

  // Étiquette directe : code PCM + part, posée à l'extérieur de la tranche.
  // Recharts fournit le milieu du secteur ; on projette le texte au-delà du
  // rayon et on l'aligne selon le côté pour qu'il ne rentre pas dans le donut.
  const etiquette = (props: any) => {
    const { cx, cy, midAngle, outerRadius, index } = props;
    const p = parts[index];
    if (!p || p.part < SEUIL_ETIQUETTE) return null;
    const rad = -midAngle * (Math.PI / 180);
    const x = cx + (outerRadius + 16) * Math.cos(rad);
    const y = cy + (outerRadius + 16) * Math.sin(rad);
    return (
      <text
        x={x} y={y}
        textAnchor={x > cx ? "start" : "end"}
        dominantBaseline="central"
        className="fill-foreground"
        style={{ fontSize: 10, fontWeight: 600 }}
      >
        {p.compte === COMPTE_AUTRES ? "Autres" : p.compte} · {fmtPart(p.part)}
      </text>
    );
  };

  return (
    <div className={VARS_COULEURS}>
      <div className="relative">
        <ResponsiveContainer width="100%" height={260}>
          <PieChart margin={{ top: 8, right: 56, bottom: 8, left: 56 }}>
            <Pie
              data={parts}
              dataKey="montant"
              nameKey="compte"
              innerRadius={58}
              outerRadius={92}
              paddingAngle={2}
              startAngle={90}
              endAngle={-270}
              isAnimationActive={false}
              label={etiquette}
              labelLine={false}
            >
              {parts.map((p, i) => (
                <Cell
                  key={p.compte}
                  fill={couleur(p, i)}
                  stroke="var(--viz-surface)"
                  strokeWidth={2}
                />
              ))}
            </Pie>
            <Tooltip content={<TooltipPoste />} cursor={false} />
          </PieChart>
        </ResponsiveContainer>

        {/* Total au centre du donut : la somme EXACTE des tranches dessinées. */}
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{libelleTotal}</span>
          {/* Chiffre isolé : chasse proportionnelle. `tabular-nums` est réservé
              aux colonnes de la légende, qui elles doivent s'aligner. */}
          <span className="text-sm font-bold">{fmtMad(total)}</span>
        </div>
      </div>

      {/* Légende détaillée : code, intitulé, montant et part exacte. C'est elle
          qui porte l'identité des tranches — jamais la couleur seule. */}
      <ul className="mt-3 space-y-1.5">
        {parts.map((p, i) => (
          <li key={p.compte} className="flex items-center gap-2 text-xs">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
              style={{ backgroundColor: couleur(p, i) }}
              aria-hidden
            />
            <span className="font-mono font-semibold shrink-0">
              {p.compte === COMPTE_AUTRES ? "Autres" : p.compte}
            </span>
            <span
              className="text-muted-foreground truncate"
              title={p.regroupe ? p.regroupe.join(", ") : p.intitule}
            >
              {p.regroupe ? resumeRegroupes(p.regroupe) : p.intitule}
            </span>
            <span className="ml-auto shrink-0 tabular-nums font-medium">{fmtMad(p.montant)}</span>
            <span className="shrink-0 w-14 text-right tabular-nums text-muted-foreground">
              {fmtPart(p.part)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Infobulle : code PCM, libellé, montant en MAD, part exacte. */
function TooltipPoste({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload as PartComptePcm;
  const estAutres = p.compte === COMPTE_AUTRES;
  return (
    <div className="rounded-md border bg-popover px-3 py-2 shadow-md text-popover-foreground">
      <p className="font-mono text-xs font-semibold">
        {estAutres ? p.intitule : `${p.compte} — ${p.intitule || "compte non répertorié"}`}
      </p>
      <p className="text-sm font-bold mt-0.5 tabular-nums">{fmtMad(p.montant)}</p>
      <p className="text-xs text-muted-foreground">{fmtPart(p.part)} du total HT</p>
      {p.regroupe && (
        <p className="text-[10px] text-muted-foreground mt-1 max-w-52">
          {p.regroupe.length === 1 ? "Compte regroupé" : "Comptes regroupés"} : {p.regroupe.join(", ")}
        </p>
      )}
    </div>
  );
}
