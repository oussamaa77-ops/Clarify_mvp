import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Download, Loader2, TrendingUp, TrendingDown, Minus, Users, Building2, ThumbsUp, AlertTriangle, Info } from "lucide-react";
import { toast } from "sonner";
import {
  type Gran, type Periode, type IndicsTiers, GRAN_LABEL,
  periodBounds, previousPeriodAnchor, formatPeriodeRange, toISO, calcTiers, detailTiers,
} from "@/lib/tiers-reporting";
import { TiersComposition } from "@/components/TiersComposition";

// ── Formatage ────────────────────────────────────────────────────────────────
const fmtMad = (n: number) => Number(n).toLocaleString("fr-MA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtNum = (n: number) => Number(n).toLocaleString("fr-MA");

type Fmt = "count" | "mad" | "jours";
type Sens = "up_good" | "up_bad" | "neutral";
interface Indic { label: string; fmt: Fmt; sens: Sens; depart: number | null; final: number | null; }

// ── Définition des indicateurs par type de tiers ───────────────────────────────
const buildIndicsClients = (d: IndicsTiers, f: IndicsTiers): Indic[] => [
  { label: "Nombre total clients",        fmt: "count", sens: "up_good", depart: d.total,    final: f.total },
  { label: "Nouveaux clients",            fmt: "count", sens: "up_good", depart: d.nouveaux, final: f.nouveaux },
  { label: "Clients perdus",              fmt: "count", sens: "up_bad",  depart: d.perdus,   final: f.perdus },
  { label: "Clients actifs",              fmt: "count", sens: "up_good", depart: d.actifs,   final: f.actifs },
  { label: "Clients passifs",             fmt: "count", sens: "up_bad",  depart: d.passifs,  final: f.passifs },
  { label: "Nouveaux clients sans facture", fmt: "count", sens: "up_bad", depart: d.nouveauxSansFacture, final: f.nouveauxSansFacture },
  { label: "CA Total (HT)",               fmt: "mad",   sens: "up_good", depart: d.caTotal,  final: f.caTotal },
  { label: "CA moyen par client",         fmt: "mad",   sens: "up_good", depart: d.caMoyen,  final: f.caMoyen },
  { label: "Créances clients",            fmt: "mad",   sens: "up_bad",  depart: d.encours,  final: f.encours },
  { label: "Délai moyen de paiement",     fmt: "jours", sens: "up_bad",  depart: d.delai,    final: f.delai },
];

const buildIndicsFourn = (d: IndicsTiers, f: IndicsTiers): Indic[] => [
  { label: "Nombre total fournisseurs",   fmt: "count", sens: "neutral", depart: d.total,    final: f.total },
  { label: "Nouveaux fournisseurs",       fmt: "count", sens: "up_good", depart: d.nouveaux, final: f.nouveaux },
  { label: "Fournisseurs perdus",         fmt: "count", sens: "neutral", depart: d.perdus,   final: f.perdus },
  { label: "Fournisseurs actifs",         fmt: "count", sens: "up_good", depart: d.actifs,   final: f.actifs },
  { label: "Fournisseurs passifs",        fmt: "count", sens: "neutral", depart: d.passifs,  final: f.passifs },
  { label: "Nouveaux fournisseurs sans facture", fmt: "count", sens: "neutral", depart: d.nouveauxSansFacture, final: f.nouveauxSansFacture },
  { label: "Achats Total (HT)",           fmt: "mad",   sens: "neutral", depart: d.caTotal,  final: f.caTotal },
  { label: "Achat moyen par fournisseur", fmt: "mad",   sens: "neutral", depart: d.caMoyen,  final: f.caMoyen },
  { label: "Dettes fournisseurs",         fmt: "mad",   sens: "up_bad",  depart: d.encours,  final: f.encours },
  { label: "Délai moyen de paiement",     fmt: "jours", sens: "neutral", depart: d.delai,    final: f.delai },
];

// ── Configuration selon le type de tiers ───────────────────────────────────────
const CONFIG = {
  clients: {
    titre: "Clients",
    icon: Users,
    table: "clients",
    facturesTable: "factures",
    facturesSelect: "client_id,date_facture,date_paiement,montant_ht,montant_ttc,montant_restant,statut_paiement,type",
    // `factures.client_id` est la seule voie de rattachement : la table ne porte pas de nom dénormalisé.
    join: { tiersKey: "client_id" },
    buildIndics: buildIndicsClients,
  },
  fournisseurs: {
    titre: "Fournisseurs",
    icon: Building2,
    table: "fournisseurs",
    facturesTable: "factures_fournisseurs",
    facturesSelect: "fournisseur_id,fournisseur_nom,date_facture,date_paiement,montant_ht,montant_ttc,montant_restant,statut_paiement",
    // `factures_fournisseurs.fournisseur_id` est nullable (saisie ou OCR sans fournisseur résolu) :
    // on retombe sur `fournisseur_nom` pour ne pas déclarer passif un fournisseur qui facture.
    join: { tiersKey: "fournisseur_id", factureNomKey: "fournisseur_nom" },
    buildIndics: buildIndicsFourn,
  },
} as const;

/**
 * Reporting & Évolution pour UN seul type de tiers (clients OU fournisseurs).
 * S'intègre dans la section Clients et dans la section Fournisseurs — jamais fusionné.
 */
export function TiersReporting({ dossierId, kind }: { dossierId: string; kind: "clients" | "fournisseurs" }) {
  const cfg = CONFIG[kind];

  const [gran, setGran] = useState<Gran>("trimestre");
  const todayISO = toISO(new Date());
  const [finalAnchor, setFinalAnchor] = useState(todayISO);
  const [departAnchor, setDepartAnchor] = useState(previousPeriodAnchor("trimestre", todayISO));

  const [tiers, setTiers] = useState<any[]>([]);
  const [factures, setFactures] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [{ data: t }, { data: f }] = await Promise.all([
        supabase.from(cfg.table).select("id,nom,created_at,deleted_at").eq("dossier_id", dossierId),
        supabase.from(cfg.facturesTable).select(cfg.facturesSelect).eq("dossier_id", dossierId),
      ]);
      setTiers(t ?? []); setFactures(f ?? []);
      setLoading(false);
    })();
  }, [dossierId, kind]);

  const pDepart = useMemo(() => periodBounds(gran, departAnchor), [gran, departAnchor]);
  const pFinal = useMemo(() => periodBounds(gran, finalAnchor), [gran, finalAnchor]);

  // Changer de granularité re-découpe les deux ancres sans les déplacer : la date saisie
  // par l'utilisateur est conservée. Il choisit lui-même de recaler le départ.
  const recalerDepart = () => setDepartAnchor(previousPeriodAnchor(gran, finalAnchor));

  // Deux ancres tombant dans la même période donnent des évolutions nulles : on le dit,
  // au lieu de réécrire silencieusement la saisie.
  const memePeriode = pDepart.startStr === pFinal.startStr;
  const departApresFinal = pDepart.startStr > pFinal.startStr;

  const indics = useMemo<Indic[]>(() => {
    const d = calcTiers(pDepart, tiers, factures, cfg.join);
    const f = calcTiers(pFinal, tiers, factures, cfg.join);
    return cfg.buildIndics(d, f);
  }, [pDepart, pFinal, tiers, factures, kind]);

  // Détail nominatif des deux périodes : alimente le graphique ET son drill-down, à partir
  // de la même partition que les indicateurs ci-dessus.
  const periodesDetail = useMemo(() => [
    { cle: "depart", periode: pDepart, detail: detailTiers(pDepart, tiers, factures, cfg.join) },
    { cle: "final", periode: pFinal, detail: detailTiers(pFinal, tiers, factures, cfg.join) },
  ], [pDepart, pFinal, tiers, factures, kind]);

  // ── Synthèse : améliorations vs alertes ──
  const synth = useMemo(() => {
    const ameliorations: string[] = [], alertes: string[] = [];
    for (const r of indics) {
      if (r.sens === "neutral" || r.depart === null || r.final === null) continue;
      const evol = r.final - r.depart;
      if (evol === 0) continue;
      const bon = r.sens === "up_good" ? evol > 0 : evol < 0;
      const txt = `${r.label} : ${fmtVal(r.depart, r.fmt)} → ${fmtVal(r.final, r.fmt)} (${signe(evol)}${fmtVal(Math.abs(evol), r.fmt)})`;
      (bon ? ameliorations : alertes).push(txt);
    }
    return { ameliorations, alertes };
  }, [indics]);

  // ── Export Excel ──
  const exportExcel = async () => {
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    const data = [
      [cfg.titre],
      [`Granularité : ${GRAN_LABEL[gran]}`, `Départ : ${pDepart.label} (${formatPeriodeRange(pDepart)})`, `Final : ${pFinal.label} (${formatPeriodeRange(pFinal)})`],
      [],
      ["Indicateur", `Départ (${pDepart.label})`, `Final (${pFinal.label})`, "Évolution", "Taux évolution"],
      ...indics.map(r => {
        const evol = r.depart !== null && r.final !== null ? r.final - r.depart : null;
        const taux = tauxEvol(r.depart, r.final);
        return [r.label, valOrDash(r.depart, r.fmt), valOrDash(r.final, r.fmt), evol === null ? "—" : fmtVal(evol, r.fmt), taux === null ? "—" : `${taux > 0 ? "+" : ""}${taux.toFixed(1)} %`];
      }),
    ];
    const ws = XLSX.utils.aoa_to_sheet(data);
    ws["!cols"] = [{ wch: 32 }, { wch: 20 }, { wch: 20 }, { wch: 16 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(wb, ws, cfg.titre);
    XLSX.writeFile(wb, `Reporting_${cfg.titre}_${GRAN_LABEL[gran]}_${pFinal.label.replace(/[\/ ]/g, "-")}.xlsx`);
    toast.success("Export Excel généré");
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-bold">Reporting & Évolution</h2>
          <p className="text-muted-foreground text-sm mt-0.5">Indicateurs {cfg.titre.toLowerCase()} · comparaison de deux périodes</p>
        </div>
        <Button variant="outline" onClick={exportExcel}><Download className="h-4 w-4 mr-2" />Export Excel</Button>
      </div>

      {/* Sélecteurs de période */}
      <Card>
        <CardContent className="pt-4 pb-4 space-y-3">
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <label className="text-xs font-medium mb-1 block text-muted-foreground">Granularité</label>
              <Select value={gran} onValueChange={(v) => setGran(v as Gran)}>
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>{(Object.keys(GRAN_LABEL) as Gran[]).map(g => <SelectItem key={g} value={g}>{GRAN_LABEL[g]}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium mb-1 block text-muted-foreground">Période de départ</label>
              <Input type="date" value={departAnchor} onChange={e => setDepartAnchor(e.target.value)} className="w-44" />
              <p className="text-[11px] text-primary font-medium mt-1">{pDepart.label}</p>
              <p className="text-[11px] text-muted-foreground">{formatPeriodeRange(pDepart)}</p>
            </div>
            <div className="text-muted-foreground pb-10">→</div>
            <div>
              <label className="text-xs font-medium mb-1 block text-muted-foreground">Période finale</label>
              <Input type="date" value={finalAnchor} onChange={e => setFinalAnchor(e.target.value)} className="w-44" />
              <p className="text-[11px] text-primary font-medium mt-1">{pFinal.label}</p>
              <p className="text-[11px] text-muted-foreground">{formatPeriodeRange(pFinal)}</p>
            </div>
            <Button variant="ghost" size="sm" className="pb-0 mb-6" onClick={recalerDepart}>
              Départ = période précédente
            </Button>
          </div>

          {(memePeriode || departApresFinal) && (
            <p className="text-[11px] text-amber-700 flex items-center gap-1.5">
              <Info className="h-3.5 w-3.5 shrink-0" />
              {memePeriode
                ? `Les deux dates tombent dans ${pFinal.label} — toutes les évolutions seront nulles.`
                : `La période de départ (${pDepart.label}) est postérieure à la période finale (${pFinal.label}) — les évolutions sont inversées.`}
            </p>
          )}
        </CardContent>
      </Card>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : (
        <>
          <TiersComposition kind={kind} periodes={periodesDetail} />
          <IndicTable titre={cfg.titre} icon={cfg.icon} rows={indics} pDepart={pDepart} pFinal={pFinal} synth={synth} />
        </>
      )}
    </div>
  );
}

// ── Helpers de formatage de valeurs ────────────────────────────────────────────
function fmtVal(v: number, fmt: Fmt): string {
  if (fmt === "mad") return fmtMad(v) + " MAD";
  if (fmt === "jours") return fmtNum(v) + " j";
  return fmtNum(v);
}
const valOrDash = (v: number | null, fmt: Fmt) => v === null ? "—" : fmtVal(v, fmt);
const signe = (n: number) => n > 0 ? "+" : n < 0 ? "−" : "";
function tauxEvol(depart: number | null, final: number | null): number | null {
  if (depart === null || final === null) return null;
  if (depart === 0) return final === 0 ? 0 : null; // base nulle → taux non défini
  return ((final - depart) / Math.abs(depart)) * 100;
}

// ── Tableau d'indicateurs + synthèse ───────────────────────────────────────────
function IndicTable({ titre, icon: Icon, rows, pDepart, pFinal, synth }: {
  titre: string; icon: typeof Users; rows: Indic[]; pDepart: Periode; pFinal: Periode;
  synth: { ameliorations: string[]; alertes: string[] };
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><Icon className="h-4 w-4" />{titre}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted text-xs uppercase text-muted-foreground">
                <th className="text-left font-semibold px-4 py-2">Indicateur</th>
                <th className="text-right font-semibold px-4 py-2">Départ<br /><span className="normal-case font-normal text-primary">{pDepart.label}</span></th>
                <th className="text-right font-semibold px-4 py-2">Final<br /><span className="normal-case font-normal text-primary">{pFinal.label}</span></th>
                <th className="text-right font-semibold px-4 py-2">Évolution</th>
                <th className="text-right font-semibold px-4 py-2">Taux évol.</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const evol = r.depart !== null && r.final !== null ? r.final - r.depart : null;
                const taux = tauxEvol(r.depart, r.final);
                const dir = evol === null || evol === 0 ? "neutral" : (r.sens === "up_good" ? (evol > 0 ? "good" : "bad") : r.sens === "up_bad" ? (evol > 0 ? "bad" : "good") : "neutral");
                const cls = dir === "good" ? "text-green-600" : dir === "bad" ? "text-red-600" : "text-muted-foreground";
                const Arrow = evol === null || evol === 0 ? Minus : evol > 0 ? TrendingUp : TrendingDown;
                return (
                  <tr key={r.label} className={`border-b ${i % 2 ? "bg-muted/20" : ""}`}>
                    <td className="px-4 py-2">{r.label}</td>
                    <td className="px-4 py-2 text-right font-mono">{valOrDash(r.depart, r.fmt)}</td>
                    <td className="px-4 py-2 text-right font-mono font-medium">{valOrDash(r.final, r.fmt)}</td>
                    <td className={`px-4 py-2 text-right font-mono ${cls}`}>
                      <span className="inline-flex items-center gap-1 justify-end">
                        <Arrow className="h-3 w-3" />
                        {evol === null ? "—" : `${signe(evol)}${fmtVal(Math.abs(evol), r.fmt)}`}
                      </span>
                    </td>
                    <td className={`px-4 py-2 text-right font-mono ${cls}`}>
                      {taux === null ? "—" : `${taux > 0 ? "+" : ""}${taux.toFixed(1)} %`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Améliorations + alertes */}
        {(synth.ameliorations.length > 0 || synth.alertes.length > 0) && (
          <div className="grid md:grid-cols-2 gap-3 p-4 border-t">
            <div>
              <p className="text-xs font-semibold text-green-700 flex items-center gap-1 mb-1"><ThumbsUp className="h-3.5 w-3.5" />Améliorations</p>
              {synth.ameliorations.length === 0 ? <p className="text-xs text-muted-foreground">—</p> :
                synth.ameliorations.map((t, i) => <p key={i} className="text-xs text-green-700/90">• {t}</p>)}
            </div>
            <div>
              <p className="text-xs font-semibold text-red-700 flex items-center gap-1 mb-1"><AlertTriangle className="h-3.5 w-3.5" />Alertes</p>
              {synth.alertes.length === 0 ? <p className="text-xs text-muted-foreground">—</p> :
                synth.alertes.map((t, i) => <p key={i} className="text-xs text-red-700/90">• {t}</p>)}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
