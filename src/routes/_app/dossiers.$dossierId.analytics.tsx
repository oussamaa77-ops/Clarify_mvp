import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Zap, Bot, Coins, Activity, Sparkles, RefreshCw, PiggyBank, TrendingUp } from "lucide-react";
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import { usageMetrics, MODULE_LABELS } from "@/server/analytics.functions";
import { getQuotaStatus } from "@/server/billing.functions";
import { JaugeQuota, BadgePlan } from "@/components/JaugeQuota";
import type { QuotaStatus } from "@/lib/quota";
import { Link } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/dossiers/$dossierId/analytics")({ component: AnalyticsPage });

type DayMetric = {
  jour: string; total: number; appels_ia: number; ia_evites: number;
  pct_skip: number; cout_economise: number; cout_depense: number;
};
type GroupMetric = {
  cle: string; total: number; appels_ia: number; ia_evites: number;
  pct_skip: number; cout_economise: number; cout_depense: number;
};

// Taux de conversion indicatif USD → MAD (dirham). Le coût IA est estimé en USD
// (tarifs Mistral/Groq) puis converti pour l'affichage comptable en DH.
const USD_TO_MAD = 10.2;
const usd = (n: number) => `$${(n ?? 0).toFixed(4)}`;
const dh = (n: number) =>
  `${((n ?? 0) * USD_TO_MAD).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} DH`;
const PERIODES = [7, 30, 90] as const;
const PHASE_LABELS: Record<string, string> = { ocr: "Extraction OCR", analyse: "Rapprochement", inconnu: "Non ventilé" };

function AnalyticsPage() {
  const { dossierId } = Route.useParams();
  const [days, setDays] = useState<number>(30);
  const [parJour, setParJour] = useState<DayMetric[]>([]);
  const [global, setGlobal] = useState<DayMetric | null>(null);
  const [parModule, setParModule] = useState<GroupMetric[]>([]);
  const [parPhase, setParPhase] = useState<GroupMetric[]>([]);
  const [loading, setLoading] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);
  const [quota, setQuota] = useState<QuotaStatus | null>(null);

  // Quota : indépendant de la période choisie (il porte sur le mois d'abonnement
  // en cours) et de l'état des métriques — il s'affiche même sans aucun usage.
  useEffect(() => {
    getQuotaStatus({ data: { dossier_id: dossierId } })
      .then((res) => setQuota(res.quota as QuotaStatus))
      .catch((e) => console.warn("[analytics] quota illisible:", e?.message ?? e));
  }, [dossierId]);

  const charger = useCallback(async () => {
    setLoading(true); setErreur(null);
    try {
      const res = await usageMetrics({ data: { dossier_id: dossierId, days } });
      if (!res.ok) { setErreur(res.reason ?? "Erreur"); setParJour([]); setGlobal(null); setParModule([]); setParPhase([]); }
      else {
        setParJour(res.par_jour as DayMetric[]); setGlobal(res.global as DayMetric);
        setParModule((res.par_module ?? []) as GroupMetric[]); setParPhase((res.par_phase ?? []) as GroupMetric[]);
      }
    } catch (e: any) {
      setErreur(String(e?.message ?? e));
    } finally { setLoading(false); }
  }, [dossierId, days]);

  useEffect(() => { charger(); }, [charger]);

  // Graphe chronologique (par_jour est trié desc → on inverse).
  const chartData = [...parJour].reverse().map((d) => ({
    jour: d.jour.slice(5),           // MM-DD
    "IA évités": d.ia_evites,
    "Appels IA": d.appels_ia,
    "% skip": d.pct_skip,
  }));

  // Coût IA potentiel = ce qu'auraient coûté TOUS les traitements sans mémoire/cache.
  const coutPotentiel = global ? global.cout_depense + global.cout_economise : 0;
  // Cartes secondaires (volume de traitements).
  const kpis = global ? [
    { icon: Bot,      label: "Appels IA réels",        value: String(global.appels_ia),  color: "text-slate-700 dark:text-slate-200", sub: "partis au LLM" },
    { icon: Zap,      label: "Appels IA évités",       value: String(global.ia_evites),  color: "text-emerald-600", sub: "cache / mémoire des tiers" },
    { icon: Activity, label: "Traitements journalisés", value: String(global.total),     color: "text-purple-600", sub: `${days} derniers jours` },
  ] : [];

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Sparkles className="h-7 w-7 text-primary" />Usage IA & Mémoire
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Mesure du court-circuit LLM (mémoire des tiers) et du coût IA économisé.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border overflow-hidden">
            {PERIODES.map((p) => (
              <button
                key={p}
                onClick={() => setDays(p)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${days === p ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
              >
                {p} j
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={charger} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`} />Actualiser
          </Button>
        </div>
      </div>

      {/* ── Quota de scans du cabinet ─────────────────────────────────────── */}
      {quota && (
        <Card className="mb-6">
          <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
            <div>
              <CardTitle className="text-base">Documents scannés ce mois</CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                Quota du cabinet
                {quota.period_end && ` · renouvellement le ${new Date(quota.period_end).toLocaleDateString("fr-FR")}`}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <BadgePlan quota={quota} />
              <Link to="/abonnement" className="text-xs text-primary hover:underline whitespace-nowrap">
                Gérer
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            {quota.has_subscription ? (
              <JaugeQuota
                quota={quota}
                note="Seuls les documents réellement partis au LLM décomptent : un scan servi par le cache OCR ou la mémoire des tiers est rendu au quota."
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                Aucun abonnement actif sur ce cabinet — <Link to="/abonnement" className="text-primary hover:underline">choisissez un plan</Link>.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {loading ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array(4).fill(0).map((_, i) => <div key={i} className="h-24 bg-muted rounded-xl animate-pulse" />)}
        </div>
      ) : erreur ? (
        <Card className="border-red-300 bg-red-50 dark:bg-red-950/20">
          <CardContent className="py-6 text-sm text-red-700">
            <p className="font-medium">Impossible de charger les métriques.</p>
            <p className="text-xs mt-1 opacity-80">{erreur}</p>
            <p className="text-xs mt-2 opacity-80">La table <code>analytics_usage</code> est-elle bien créée ?</p>
          </CardContent>
        </Card>
      ) : !global || global.total === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Activity className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="font-medium">Aucune donnée d'usage sur la période.</p>
            <p className="text-sm mt-1">Lance un scan de facture ou de relevé bancaire pour alimenter le tableau de bord.</p>
          </CardContent>
        </Card>
      ) : global ? (
        <>
          {/* ── HERO COÛT IA : métrique principale ───────────────────────────── */}
          <div className="grid gap-4 lg:grid-cols-3 mb-6">
            {/* Coût IA dépensé (primaire) */}
            <Card className="lg:col-span-1 border-primary/30 bg-primary/5">
              <CardContent className="pt-6 pb-5">
                <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground mb-2">
                  <Coins className="h-4 w-4 text-primary" /> Coût IA total dépensé
                </div>
                <p className="text-4xl font-bold tracking-tight leading-none">{dh(global.cout_depense)}</p>
                <p className="text-sm text-muted-foreground mt-2">
                  ≈ {usd(global.cout_depense)} · {global.appels_ia} appel(s) IA réel(s)
                </p>
              </CardContent>
            </Card>

            {/* Coût IA économisé */}
            <Card className="border-emerald-300/40 bg-emerald-50/40 dark:bg-emerald-950/10">
              <CardContent className="pt-6 pb-5">
                <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground mb-2">
                  <PiggyBank className="h-4 w-4 text-emerald-600" /> Coût IA économisé
                </div>
                <p className="text-4xl font-bold tracking-tight leading-none text-emerald-600">{dh(global.cout_economise)}</p>
                <p className="text-sm text-muted-foreground mt-2">
                  ≈ {usd(global.cout_economise)} · sur un potentiel de {dh(coutPotentiel)}
                </p>
              </CardContent>
            </Card>

            {/* Taux de skip LLM */}
            <Card className="border-blue-300/40 bg-blue-50/40 dark:bg-blue-950/10">
              <CardContent className="pt-6 pb-5">
                <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground mb-2">
                  <TrendingUp className="h-4 w-4 text-blue-600" /> Taux de skip LLM
                </div>
                <p className="text-4xl font-bold tracking-tight leading-none text-blue-600">{global.pct_skip}%</p>
                <p className="text-sm text-muted-foreground mt-2">
                  {global.ia_evites} évité(s) / {global.total} traitement(s)
                </p>
                <div className="mt-3 h-2 w-full rounded-full bg-muted overflow-hidden">
                  <div className="h-full rounded-full bg-blue-500 transition-all" style={{ width: `${Math.min(100, global.pct_skip)}%` }} />
                </div>
              </CardContent>
            </Card>
          </div>

          {/* ── KPIs secondaires (volume) ────────────────────────────────────── */}
          <div className="grid grid-cols-3 gap-4 mb-8">
            {kpis.map((k) => (
              <Card key={k.label}><CardContent className="pt-5 pb-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">{k.label}</p>
                    <p className={`text-2xl font-bold ${k.color}`}>{k.value}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{k.sub}</p>
                  </div>
                  <k.icon className={`h-8 w-8 ${k.color} opacity-40`} />
                </div>
              </CardContent></Card>
            ))}
          </div>

          {/* ── Ventilation par MODULE ───────────────────────────────────────── */}
          <Card className="mb-8">
            <CardHeader>
              <CardTitle className="text-base">Usage IA par module</CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                Factures client / fournisseurs et relevés bancaires — appels IA réels, évités (mémoire ou regex/delta) et coût.
              </p>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-xs text-muted-foreground uppercase tracking-wide">
                      <th className="text-left font-medium px-4 py-2">Module</th>
                      <th className="text-right font-medium px-4 py-2">Traitements</th>
                      <th className="text-right font-medium px-4 py-2">IA réels</th>
                      <th className="text-right font-medium px-4 py-2">IA évités</th>
                      <th className="text-right font-medium px-4 py-2">% skip</th>
                      <th className="text-right font-medium px-4 py-2">Économisé (DH)</th>
                      <th className="text-right font-medium px-4 py-2">Dépensé (DH)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parModule.length === 0 ? (
                      <tr><td colSpan={7} className="px-4 py-4 text-center text-muted-foreground text-xs">Aucune ventilation par module sur la période.</td></tr>
                    ) : parModule.map((m) => (
                      <tr key={m.cle} className="border-b last:border-0 hover:bg-muted/30">
                        <td className="px-4 py-2 font-medium">{MODULE_LABELS[m.cle] ?? m.cle}</td>
                        <td className="px-4 py-2 text-right">{m.total}</td>
                        <td className="px-4 py-2 text-right text-muted-foreground">{m.appels_ia}</td>
                        <td className="px-4 py-2 text-right text-green-600 font-medium">{m.ia_evites}</td>
                        <td className="px-4 py-2 text-right">
                          <Badge variant="outline" className={m.pct_skip >= 50 ? "text-green-600" : "text-muted-foreground"}>{m.pct_skip}%</Badge>
                        </td>
                        <td className="px-4 py-2 text-right text-blue-600 font-mono text-xs" title={usd(m.cout_economise)}>{dh(m.cout_economise)}</td>
                        <td className="px-4 py-2 text-right text-muted-foreground font-mono text-xs" title={usd(m.cout_depense)}>{dh(m.cout_depense)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* ── Ventilation par PHASE (OCR vs rapprochement) ──────────────────── */}
          {parPhase.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
              {parPhase.map((p) => (
                <Card key={p.cle}><CardContent className="pt-5 pb-4">
                  <p className="text-xs text-muted-foreground mb-1">{PHASE_LABELS[p.cle] ?? p.cle}</p>
                  <p className="text-2xl font-bold">{p.total} <span className="text-sm font-normal text-muted-foreground">traitement(s)</span></p>
                  <div className="flex items-center gap-3 mt-2 text-xs">
                    <span className="text-green-600 font-medium">{p.ia_evites} évité(s)</span>
                    <span className="text-muted-foreground">{p.appels_ia} appel(s) IA</span>
                    <Badge variant="outline" className={p.pct_skip >= 50 ? "text-green-600" : "text-muted-foreground"}>{p.pct_skip}% skip</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">Économisé {dh(p.cout_economise)} · dépensé {dh(p.cout_depense)}</p>
                </CardContent></Card>
              ))}
            </div>
          )}

          {/* ── Graphe par jour ──────────────────────────────────────────────── */}
          <Card className="mb-8">
            <CardHeader><CardTitle className="text-base">Appels IA évités vs réels — par jour</CardTitle></CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="jour" tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="left" tick={{ fontSize: 11 }} allowDecimals={false} />
                  <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
                  <Tooltip formatter={(v: any, name: string) => name === "% skip" ? [`${v}%`, name] : [v, name]} />
                  <Legend />
                  <Bar yAxisId="left" dataKey="IA évités" stackId="a" fill="#10b981" radius={[0, 0, 0, 0]} />
                  <Bar yAxisId="left" dataKey="Appels IA" stackId="a" fill="#cbd5e1" radius={[3, 3, 0, 0]} />
                  <Line yAxisId="right" type="monotone" dataKey="% skip" stroke="#2563eb" strokeWidth={2} dot={{ r: 2 }} />
                </ComposedChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* ── Détail par jour ──────────────────────────────────────────────── */}
          <Card>
            <CardHeader><CardTitle className="text-base">Détail journalier</CardTitle></CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-xs text-muted-foreground uppercase tracking-wide">
                      <th className="text-left font-medium px-4 py-2">Jour</th>
                      <th className="text-right font-medium px-4 py-2">Total</th>
                      <th className="text-right font-medium px-4 py-2">IA réels</th>
                      <th className="text-right font-medium px-4 py-2">IA évités</th>
                      <th className="text-right font-medium px-4 py-2">% skip</th>
                      <th className="text-right font-medium px-4 py-2">Économisé (DH)</th>
                      <th className="text-right font-medium px-4 py-2">Dépensé (DH)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parJour.map((d) => (
                      <tr key={d.jour} className="border-b last:border-0 hover:bg-muted/30">
                        <td className="px-4 py-2 font-mono text-xs">{d.jour}</td>
                        <td className="px-4 py-2 text-right">{d.total}</td>
                        <td className="px-4 py-2 text-right text-muted-foreground">{d.appels_ia}</td>
                        <td className="px-4 py-2 text-right text-green-600 font-medium">{d.ia_evites}</td>
                        <td className="px-4 py-2 text-right">
                          <Badge variant="outline" className={d.pct_skip >= 50 ? "text-green-600" : "text-muted-foreground"}>{d.pct_skip}%</Badge>
                        </td>
                        <td className="px-4 py-2 text-right text-blue-600 font-mono text-xs" title={usd(d.cout_economise)}>{dh(d.cout_economise)}</td>
                        <td className="px-4 py-2 text-right text-muted-foreground font-mono text-xs" title={usd(d.cout_depense)}>{dh(d.cout_depense)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 font-semibold bg-muted/40">
                      <td className="px-4 py-2">TOTAL</td>
                      <td className="px-4 py-2 text-right">{global.total}</td>
                      <td className="px-4 py-2 text-right">{global.appels_ia}</td>
                      <td className="px-4 py-2 text-right text-green-600">{global.ia_evites}</td>
                      <td className="px-4 py-2 text-right">{global.pct_skip}%</td>
                      <td className="px-4 py-2 text-right text-blue-600 font-mono text-xs" title={usd(global.cout_economise)}>{dh(global.cout_economise)}</td>
                      <td className="px-4 py-2 text-right text-muted-foreground font-mono text-xs" title={usd(global.cout_depense)}>{dh(global.cout_depense)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
