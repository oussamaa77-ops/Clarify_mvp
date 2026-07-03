import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Download, Loader2, TrendingUp, TrendingDown, Minus, Users, Building2, ThumbsUp, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

// ── Formatage ────────────────────────────────────────────────────────────────
const fmtMad = (n: number) => Number(n).toLocaleString("fr-MA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtNum = (n: number) => Number(n).toLocaleString("fr-MA");
const MOIS = ["janv.","févr.","mars","avr.","mai","juin","juil.","août","sept.","oct.","nov.","déc."];

type Gran = "jour" | "mois" | "trimestre" | "semestre" | "annee";
const GRAN_LABEL: Record<Gran, string> = {
  jour: "Jour", mois: "Mois", trimestre: "Trimestre", semestre: "Semestre", annee: "Année",
};

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m0: number, d: number) => `${y}-${pad(m0 + 1)}-${pad(d)}`;
const lastDay = (y: number, m0: number) => new Date(y, m0 + 1, 0).getDate();
const toISO = (a: Date) => ymd(a.getFullYear(), a.getMonth(), a.getDate());

interface Periode { startStr: string; endStr: string; label: string; }

function periodBounds(gran: Gran, anchorStr: string): Periode {
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

function previousAnchor(gran: Gran, anchorStr: string): string {
  const a = new Date(anchorStr + "T00:00:00");
  if (gran === "jour") a.setDate(a.getDate() - 1);
  else if (gran === "mois") a.setMonth(a.getMonth() - 1);
  else if (gran === "trimestre") a.setMonth(a.getMonth() - 3);
  else if (gran === "semestre") a.setMonth(a.getMonth() - 6);
  else a.setFullYear(a.getFullYear() - 1);
  return toISO(a);
}

const inP = (dateStr: string | null | undefined, p: Periode) => {
  if (!dateStr) return false;
  const ds = dateStr.slice(0, 10);
  return ds >= p.startStr && ds <= p.endStr;
};

type Fmt = "count" | "mad" | "jours";
type Sens = "up_good" | "up_bad" | "neutral";
interface Indic { label: string; fmt: Fmt; sens: Sens; depart: number | null; final: number | null; }

// ── Calcul d'un bloc d'indicateurs (clients OU fournisseurs) pour une période ──
function calcTiers(
  p: Periode,
  tiers: any[],        // clients ou fournisseurs : { id, created_at, deleted_at }
  factures: any[],     // factures clients OU factures_fournisseurs
  tiersKey: string,    // "client_id" | "fournisseur_id"
) {
  // Existants à la fin de la période (créés avant la fin, non supprimés à la fin)
  const existants = tiers.filter(t => t.created_at?.slice(0, 10) <= p.endStr && (!t.deleted_at || t.deleted_at.slice(0, 10) > p.endStr));
  const existantsIds = new Set(existants.map(t => t.id));
  const total = existants.length;
  const nouveaux = tiers.filter(t => inP(t.created_at, p)).length;
  const perdus = tiers.filter(t => inP(t.deleted_at, p)).length;

  const facturesP = factures.filter(f => inP(f.date_facture, p));
  // Actifs = tiers EXISTANTS ayant ≥ 1 facture dans la période. On intersecte avec
  // l'ensemble des existants pour garantir l'invariant : actifs + passifs = total
  // (sans cette intersection, une facture d'un tiers non existant gonflerait actifs).
  const actifsSet = new Set(facturesP.map(f => f[tiersKey]).filter(id => id && existantsIds.has(id)));
  const actifs = actifsSet.size;
  const passifs = total - actifs;

  // CA / Achats HT (hors acomptes côté clients)
  const caTotal = facturesP
    .filter(f => f.type_facture !== "acompte")
    .reduce((s, f) => s + Number(f.montant_ht ?? 0), 0);
  // CA moyen = panier moyen rapporté à TOUS les tiers ayant existé sur la période :
  // existants à la fin (total) + perdus/supprimés durant la période (perdus, exclus de total).
  // Cohérent avec caTotal qui est un flux incluant les factures des tiers désormais partis.
  const baseTiers = total + perdus;
  const caMoyen = baseTiers > 0 ? caTotal / baseTiers : 0;

  // Créances / Dettes = encours restant à la fin de la période
  const encours = factures
    .filter(f => f.date_facture?.slice(0, 10) <= p.endStr && f.statut_paiement !== "payee")
    .reduce((s, f) => s + Number(f.montant_restant ?? f.montant_ttc ?? 0), 0);

  // Délai moyen de paiement (jours) sur les factures réglées dans la période
  const payees = factures.filter(f => inP(f.date_paiement, p) && f.date_facture);
  const delai = payees.length
    ? Math.round(payees.reduce((s, f) => s + (new Date(f.date_paiement).getTime() - new Date(f.date_facture).getTime()) / 86400000, 0) / payees.length)
    : null;

  return { total, nouveaux, perdus, actifs, passifs, caTotal, caMoyen, encours, delai };
}

// ── Définition des indicateurs par type de tiers ───────────────────────────────
const buildIndicsClients = (d: ReturnType<typeof calcTiers>, f: ReturnType<typeof calcTiers>): Indic[] => [
  { label: "Nombre total clients",        fmt: "count", sens: "up_good", depart: d.total,    final: f.total },
  { label: "Nouveaux clients",            fmt: "count", sens: "up_good", depart: d.nouveaux, final: f.nouveaux },
  { label: "Clients perdus",              fmt: "count", sens: "up_bad",  depart: d.perdus,   final: f.perdus },
  { label: "Clients actifs",              fmt: "count", sens: "up_good", depart: d.actifs,   final: f.actifs },
  { label: "Clients passifs",             fmt: "count", sens: "up_bad",  depart: d.passifs,  final: f.passifs },
  { label: "CA Total (HT)",               fmt: "mad",   sens: "up_good", depart: d.caTotal,  final: f.caTotal },
  { label: "CA moyen par client",         fmt: "mad",   sens: "up_good", depart: d.caMoyen,  final: f.caMoyen },
  { label: "Créances clients",            fmt: "mad",   sens: "up_bad",  depart: d.encours,  final: f.encours },
  { label: "Délai moyen de paiement",     fmt: "jours", sens: "up_bad",  depart: d.delai,    final: f.delai },
];

const buildIndicsFourn = (d: ReturnType<typeof calcTiers>, f: ReturnType<typeof calcTiers>): Indic[] => [
  { label: "Nombre total fournisseurs",   fmt: "count", sens: "neutral", depart: d.total,    final: f.total },
  { label: "Nouveaux fournisseurs",       fmt: "count", sens: "up_good", depart: d.nouveaux, final: f.nouveaux },
  { label: "Fournisseurs perdus",         fmt: "count", sens: "neutral", depart: d.perdus,   final: f.perdus },
  { label: "Fournisseurs actifs",         fmt: "count", sens: "up_good", depart: d.actifs,   final: f.actifs },
  { label: "Fournisseurs passifs",        fmt: "count", sens: "neutral", depart: d.passifs,  final: f.passifs },
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
    facturesSelect: "client_id,date_facture,date_paiement,montant_ht,montant_ttc,montant_restant,statut_paiement,type_facture",
    tiersKey: "client_id",
    buildIndics: buildIndicsClients,
  },
  fournisseurs: {
    titre: "Fournisseurs",
    icon: Building2,
    table: "fournisseurs",
    facturesTable: "factures_fournisseurs",
    facturesSelect: "fournisseur_id,fournisseur_nom,date_facture,date_paiement,montant_ht,montant_ttc,montant_restant,statut_paiement",
    tiersKey: "fournisseur_id",
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
  const [departAnchor, setDepartAnchor] = useState(previousAnchor("trimestre", todayISO));

  const [tiers, setTiers] = useState<any[]>([]);
  const [factures, setFactures] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [{ data: t }, { data: f }] = await Promise.all([
        supabase.from(cfg.table).select("id,created_at,deleted_at").eq("dossier_id", dossierId),
        supabase.from(cfg.facturesTable).select(cfg.facturesSelect).eq("dossier_id", dossierId),
      ]);
      setTiers(t ?? []); setFactures(f ?? []);
      setLoading(false);
    })();
  }, [dossierId, kind]);

  // Quand on change de granularité, on recale le départ sur la période précédente.
  const onGranChange = (g: Gran) => {
    setGran(g);
    setDepartAnchor(previousAnchor(g, finalAnchor));
  };

  const pDepart = useMemo(() => periodBounds(gran, departAnchor), [gran, departAnchor]);
  const pFinal = useMemo(() => periodBounds(gran, finalAnchor), [gran, finalAnchor]);

  const indics = useMemo<Indic[]>(() => {
    const d = calcTiers(pDepart, tiers, factures, cfg.tiersKey);
    const f = calcTiers(pFinal, tiers, factures, cfg.tiersKey);
    return cfg.buildIndics(d, f);
  }, [pDepart, pFinal, tiers, factures, kind]);

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
      [`Granularité : ${GRAN_LABEL[gran]}`, `Départ : ${pDepart.label}`, `Final : ${pFinal.label}`],
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
        <CardContent className="pt-4 pb-4 flex flex-wrap items-end gap-4">
          <div>
            <label className="text-xs font-medium mb-1 block text-muted-foreground">Granularité</label>
            <Select value={gran} onValueChange={(v) => onGranChange(v as Gran)}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>{(Object.keys(GRAN_LABEL) as Gran[]).map(g => <SelectItem key={g} value={g}>{GRAN_LABEL[g]}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium mb-1 block text-muted-foreground">Période de départ</label>
            <Input type="date" value={departAnchor} onChange={e => setDepartAnchor(e.target.value)} className="w-44" />
            <p className="text-[11px] text-primary font-medium mt-1">{pDepart.label}</p>
          </div>
          <div className="text-muted-foreground pb-6">→</div>
          <div>
            <label className="text-xs font-medium mb-1 block text-muted-foreground">Période finale</label>
            <Input type="date" value={finalAnchor} onChange={e => setFinalAnchor(e.target.value)} className="w-44" />
            <p className="text-[11px] text-primary font-medium mt-1">{pFinal.label}</p>
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : (
        <IndicTable titre={cfg.titre} icon={cfg.icon} rows={indics} pDepart={pDepart} pFinal={pFinal} synth={synth} />
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
