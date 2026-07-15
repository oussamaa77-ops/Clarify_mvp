import { useMemo, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PieChart, X } from "lucide-react";
import { CATEGORIES, trierDetail, type CategorieTiers, type DetailTiers, type Periode } from "@/lib/tiers-reporting";
import { cheminSegment } from "@/lib/chart-shapes";

const fmtMad = (n: number) => Number(n).toLocaleString("fr-MA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const CAT_LABEL: Record<CategorieTiers, string> = {
  actif: "Actifs", passif: "Passifs", nouveau_sans_facture: "Nouveaux sans facture",
};
// Slots catégoriels validés (cf. --tiers-* dans styles.css). L'ordre est la sécurité
// daltonisme : il ne se permute pas, et une 4e catégorie n'inventerait pas une 4e teinte.
const CAT_VAR: Record<CategorieTiers, string> = {
  actif: "var(--tiers-actif)", passif: "var(--tiers-passif)", nouveau_sans_facture: "var(--tiers-nouveau)",
};
// Label posé DANS le fill : l'encre l'emporte sur le blanc pour les six teintes (clair+sombre).
// Noir pur et non l'encre primaire : sur le bleu clair, #0b0b0b plafonne à 4,46:1, #000 atteint 4,76:1.
const LABEL_INK = "#000000";

const BAR_SIZE = 24;
const GAP = 1;      // 1px de chaque côté → 2px de surface entre deux segments accolés
const RAYON = 4;    // extrémité de donnée arrondie ; le pied du barreau reste carré

interface PeriodeDetail { cle: string; periode: Periode; detail: DetailTiers[] }
interface Selection { cle: string; categorie: CategorieTiers }

interface LigneComposition {
  cle: string; label: string; total: number; dernier: CategorieTiers | null;
  actif: number; passif: number; nouveau_sans_facture: number;
}

export function TiersComposition({ kind, periodes }: { kind: "clients" | "fournisseurs"; periodes: PeriodeDetail[] }) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const nom = kind === "clients" ? "clients" : "fournisseurs";

  const data = useMemo<LigneComposition[]>(() => periodes.map(({ cle, periode, detail }) => {
    const compte = { actif: 0, passif: 0, nouveau_sans_facture: 0 };
    for (const d of detail) compte[d.categorie]++;
    // Le dernier segment non vide porte l'extrémité arrondie et le total.
    const dernier = [...CATEGORIES].reverse().find(c => compte[c] > 0) ?? null;
    return { cle, label: periode.label, total: detail.length, dernier, ...compte };
  }), [periodes]);

  const maxTotal = Math.max(1, ...data.map(d => d.total));
  const vide = data.every(d => d.total === 0);

  const choisir = (cle: string, categorie: CategorieTiers, compte: number) => {
    if (compte === 0) return;
    setSelection(s => (s && s.cle === cle && s.categorie === categorie ? null : { cle, categorie }));
  };

  const sel = selection ? periodes.find(p => p.cle === selection.cle) : undefined;
  const lignesDrill = useMemo(
    () => (sel && selection ? trierDetail(sel.detail.filter(d => d.categorie === selection.categorie)) : []),
    [sel, selection],
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <PieChart className="h-4 w-4" />Composition du portefeuille
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Actifs + Passifs + Nouveaux sans facture = nombre total de {nom}. Cliquez une section pour voir la liste nominative.
        </p>
      </CardHeader>
      <CardContent>
        {vide ? (
          <p className="text-sm text-muted-foreground py-8 text-center">Aucun {nom.slice(0, -1)} sur ces périodes.</p>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={data.length * 58 + 8}>
              <BarChart layout="vertical" data={data} margin={{ top: 4, right: 64, bottom: 4, left: 4 }}>
                {/* Une seule échelle. L'axe des valeurs est porté par les labels directs et le tableau. */}
                <XAxis type="number" hide domain={[0, maxTotal]} />
                <YAxis
                  type="category" dataKey="label" width={96}
                  tickLine={false} axisLine={false}
                  tick={{ fontSize: 12, fill: "var(--muted-foreground)" }}
                />
                <Tooltip
                  cursor={{ fill: "var(--muted)", opacity: 0.3 }}
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const l = payload[0].payload as LigneComposition;
                    return (
                      <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-md">
                        <p className="font-semibold mb-1">{l.label}</p>
                        {CATEGORIES.map(c => (
                          <p key={c} className="flex items-center gap-1.5 text-muted-foreground">
                            <span className="h-2 w-2 rounded-sm shrink-0" style={{ background: CAT_VAR[c] }} />
                            {CAT_LABEL[c]} : <span className="font-mono text-foreground">{l[c]}</span>
                            {l.total > 0 && <span>({Math.round((l[c] / l.total) * 100)} %)</span>}
                          </p>
                        ))}
                        <p className="mt-1 pt-1 border-t text-muted-foreground">Total : <span className="font-mono text-foreground">{l.total}</span></p>
                      </div>
                    );
                  }}
                />
                {CATEGORIES.map(cat => (
                  <Bar
                    key={cat} dataKey={cat} stackId="tiers" barSize={BAR_SIZE} isAnimationActive={false}
                    shape={(props: any) => {
                      const { x, y, width, height, payload } = props;
                      const compte = payload[cat] as number;
                      if (!width || compte === 0) return <g />;

                      const estMisEnAvant = !selection || (selection.cle === payload.cle && selection.categorie === cat);
                      const w = Math.max(0, width - 2 * GAP);
                      const r = payload.dernier === cat ? RAYON : 0;
                      const texte = String(compte);
                      // Un label n'entre dans un segment que s'il y tient avec sa marge : sinon
                      // il part dans l'infobulle et le tableau, jamais rogné par `overflow: hidden`.
                      const tient = w >= texte.length * 8 + 14;

                      return (
                        <g
                          role="button" tabIndex={0} style={{ cursor: "pointer", outline: "none" }}
                          aria-label={`${CAT_LABEL[cat]}, ${payload.label} : ${compte} ${nom} — afficher la liste`}
                          onClick={() => choisir(payload.cle, cat, compte)}
                          onKeyDown={e => {
                            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choisir(payload.cle, cat, compte); }
                          }}
                        >
                          {/* Seul le remplissage s'estompe : atténuer le groupe entraînerait le label
                              avec lui, et l'encre choisie pour le fill plein perdrait son contraste. */}
                          <path
                            d={cheminSegment(x + GAP, y, w, height, r)} fill={CAT_VAR[cat]}
                            style={{ opacity: estMisEnAvant ? 1 : "var(--tiers-dim)" }}
                          />
                          {tient && (
                            <text
                              x={x + GAP + w / 2} y={y + height / 2} dy="0.36em" textAnchor="middle"
                              fontSize={12} fontWeight={600} pointerEvents="none"
                              fill={estMisEnAvant ? LABEL_INK : "var(--muted-foreground)"}
                            >
                              {texte}
                            </text>
                          )}
                          {payload.dernier === cat && (
                            <text
                              x={x + GAP + w + 10} y={y + height / 2} dy="0.36em"
                              fontSize={12} fontWeight={600} fill="var(--foreground)" pointerEvents="none"
                            >
                              {payload.total}
                            </text>
                          )}
                        </g>
                      );
                    }}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>

            {/* Légende : l'identité ne repose jamais sur la seule couleur. */}
            <div className="flex flex-wrap gap-x-5 gap-y-1.5 pt-1 pl-1">
              {CATEGORIES.map(c => (
                <span key={c} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ background: CAT_VAR[c] }} />
                  {CAT_LABEL[c]}
                </span>
              ))}
            </div>
          </>
        )}

        {selection && sel && (
          <DrillDown
            titre={`${CAT_LABEL[selection.categorie]} · ${sel.periode.label}`}
            nom={nom}
            categorie={selection.categorie}
            lignes={lignesDrill}
            onClose={() => setSelection(null)}
          />
        )}
      </CardContent>
    </Card>
  );
}

function DrillDown({ titre, nom, categorie, lignes, onClose }: {
  titre: string; nom: string; categorie: CategorieTiers; lignes: DetailTiers[]; onClose: () => void;
}) {
  const totalDette = lignes.reduce((s, l) => s + l.encours, 0);
  return (
    <div className="mt-4 border-t pt-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ background: CAT_VAR[categorie] }} />
          <p className="text-sm font-semibold">{titre}</p>
          <span className="text-xs text-muted-foreground">
            {lignes.length} {lignes.length > 1 ? nom : nom.slice(0, -1)}
            {totalDette > 0 && ` · ${fmtMad(totalDette)} MAD de dette`}
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Fermer la liste">
          <X className="h-4 w-4" />
        </Button>
      </div>

      {lignes.length === 0 ? (
        <p className="text-xs text-muted-foreground py-3">Aucun {nom.slice(0, -1)} dans cette catégorie.</p>
      ) : (
        <div className="max-h-80 overflow-y-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted">
              <tr className="text-xs uppercase text-muted-foreground">
                <th className="text-left font-semibold px-3 py-1.5">Nom</th>
                <th className="text-right font-semibold px-3 py-1.5">Dernière facture</th>
                <th className="text-right font-semibold px-3 py-1.5">Achats période (HT)</th>
                <th className="text-right font-semibold px-3 py-1.5">Dette</th>
              </tr>
            </thead>
            <tbody>
              {lignes.map((l, i) => (
                <tr key={l.id} className={`border-b last:border-0 ${i % 2 ? "bg-muted/20" : ""}`}>
                  <td className="px-3 py-1.5">{l.nom}</td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                    {l.derniereFacture
                      ? `${l.derniereFacture.slice(8, 10)}/${l.derniereFacture.slice(5, 7)}/${l.derniereFacture.slice(0, 4)}`
                      : "jamais"}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">{l.caPeriode > 0 ? fmtMad(l.caPeriode) : "—"}</td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums font-medium">{l.encours > 0 ? fmtMad(l.encours) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
