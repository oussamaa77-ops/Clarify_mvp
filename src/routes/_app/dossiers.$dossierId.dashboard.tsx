import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, Wallet, FileText, ShoppingCart, AlertCircle, CheckCircle, Clock, AlertTriangle, Users, Building2, Receipt } from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";

export const Route = createFileRoute("/_app/dossiers/$dossierId/dashboard")({ component: DashboardPage });

const fmt = (n: number) => Number(n).toLocaleString("fr-MA", { minimumFractionDigits: 2 }) + " MAD";

function DashboardPage() {
  const { dossierId } = Route.useParams();
  const [dossier, setDossier] = useState<any>(null);
  const [factures, setFactures] = useState<any[]>([]);
  const [ff, setFf] = useState<any[]>([]);
  const [alertes, setAlertes] = useState<any[]>([]);
  const [ecrTva, setEcrTva] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const [{ data: d }, { data: f }, { data: ffData }, { data: al }, { data: tva }] = await Promise.all([
        supabase.from("dossiers").select("nom_societe,ice,statut").eq("id", dossierId).single(),
        // Ajouter montant_paye et montant_restant pour calculs corrects + tiers pour les alertes
        supabase.from("factures").select("numero,statut,statut_paiement,montant_ht,montant_ttc,montant_tva,montant_paye,montant_restant,type_facture,date_facture,date_echeance,clients(nom)").eq("dossier_id", dossierId),
        supabase.from("factures_fournisseurs").select("numero,fournisseur_nom,statut_paiement,montant_ttc,montant_paye,montant_restant,date_echeance,date_facture").eq("dossier_id", dossierId),
        supabase.from("alertes").select("*").eq("dossier_id", dossierId).eq("lue", false).order("created_at", { ascending: false }).limit(5),
        // Écritures TVA (mêmes comptes que la page Fiscalité) pour l'échéance de trésorerie
        supabase.from("ecritures_comptables").select("compte_numero,debit,credit,date_ecriture").eq("dossier_id", dossierId).in("compte_numero", ["44551", "34552"]),
      ]);
      setDossier(d);
      setFactures(f ?? []);
      setFf(ffData ?? []);
      setAlertes(al ?? []);
      setEcrTva(tva ?? []);
      setLoading(false);
    })();
  }, [dossierId]);

  // ── KPIs ──────────────────────────────────────────────────────────────────
  const conformes = factures.filter(f => f.statut === "conforme");

  // CA HT = factures standard conformes uniquement (acompte → 4191, pas CA)
  const caHT = conformes
    .filter(f => f.type_facture !== "acompte")
    .reduce((s, f) => s + Number(f.montant_ht), 0);

  // CA TTC facturé (hors acomptes)
  const caTTC = conformes
    .filter(f => f.type_facture !== "acompte")
    .reduce((s, f) => s + Number(f.montant_ttc), 0);

  // CA encaissé = factures standard payées ou partielles (pas les acomptes)
  const caEncaisse = conformes
    .filter(f => f.type_facture !== "acompte" && f.statut_paiement !== "non_payee")
    .reduce((s, f) => s + Number(f.montant_paye ?? 0), 0);

  // Encours = montant_restant de toutes les factures non soldées (acompte + standard)
  const encours = conformes
    .filter(f => f.statut_paiement !== "payee")
    .reduce((s, f) => s + Number(f.montant_restant ?? f.montant_ttc), 0);

  const tvaCollectee = conformes.reduce((s, f) => s + Number(f.montant_tva), 0);

  // Dettes fournisseurs = montant_restant (ou montant_ttc si pas encore renseigné)
  const dettes = ff
    .filter(f => f.statut_paiement !== "payee")
    .reduce((s, f) => s + Number(f.montant_restant ?? f.montant_ttc), 0);

  const enAnalyse = factures.filter(f => f.statut === "envoyee").length;

  // ── CENTRE D'ALERTES : retards clients / fournisseurs / échéance TVA ─────────
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const joursDepuis = (d: string) => Math.floor((today.getTime() - new Date(d).getTime()) / 86400000);

  // Retards clients : factures conformes non soldées dont l'échéance est dépassée.
  const retardsClients = factures
    .filter(f => f.statut === "conforme" && f.statut_paiement !== "payee" && f.date_echeance && new Date(f.date_echeance) < today)
    .map(f => ({
      id: f.numero ?? "—",
      tiers: (f as any).clients?.nom ?? "Client",
      restant: Number(f.montant_restant ?? f.montant_ttc),
      jours: joursDepuis(f.date_echeance),
    }))
    .sort((a, b) => b.jours - a.jours);
  const totalRetardsClients = retardsClients.reduce((s, r) => s + r.restant, 0);
  const maxJoursClients = retardsClients[0]?.jours ?? 0;

  // Retards fournisseurs : factures fournisseurs non payées dont l'échéance est dépassée.
  const retardsFourn = ff
    .filter(f => f.statut_paiement !== "payee" && f.date_echeance && new Date(f.date_echeance) < today)
    .map(f => ({
      id: f.numero ?? "—",
      tiers: f.fournisseur_nom ?? "Fournisseur",
      restant: Number(f.montant_restant ?? f.montant_ttc),
      jours: joursDepuis(f.date_echeance),
    }))
    .sort((a, b) => b.jours - a.jours);
  const totalRetardsFourn = retardsFourn.reduce((s, r) => s + r.restant, 0);
  const maxJoursFourn = retardsFourn[0]?.jours ?? 0;

  // Échéance TVA : TVA nette du dernier mois clos, due le 20 du mois suivant (régime mensuel).
  const moisTva = [...new Set(ecrTva.map(e => e.date_ecriture?.slice(0, 7)).filter(Boolean))].sort() as string[];
  const dernierMoisTva = moisTva[moisTva.length - 1] ?? null;
  const tvaMois = dernierMoisTva ? ecrTva.filter(e => e.date_ecriture?.startsWith(dernierMoisTva)) : [];
  const tvaCollecteeMois = tvaMois.filter(e => e.compte_numero === "44551").reduce((s, e) => s + Number(e.credit) - Number(e.debit), 0);
  const tvaRecupMois = tvaMois.filter(e => e.compte_numero === "34552").reduce((s, e) => s + Number(e.debit) - Number(e.credit), 0);
  const tvaNetteMois = tvaCollecteeMois - tvaRecupMois;
  // Échéance = 20 du mois suivant le dernier mois déclaré.
  const echeanceTva = dernierMoisTva ? new Date(Number(dernierMoisTva.slice(0, 4)), Number(dernierMoisTva.slice(5, 7)), 20) : null;
  const joursTva = echeanceTva ? Math.ceil((echeanceTva.getTime() - today.getTime()) / 86400000) : null;
  const tvaAPayer = tvaNetteMois > 0;

  // ── Graphe 6 mois ─────────────────────────────────────────────────────────
  const now = new Date();
  const chartData = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - 5 + i, 1);
    const mois = d.toLocaleDateString("fr-MA", { month: "short", year: "2-digit" });
    const m = d.getMonth();
    const y = d.getFullYear();

    // CA HT facturé ce mois
    const caHtMois = factures
      .filter(f => {
        const fd = new Date(f.date_facture);
        return fd.getMonth() === m && fd.getFullYear() === y && f.statut === "conforme";
      })
      .reduce((s, f) => s + Number(f.montant_ht), 0);

    // Encaissé ce mois = montant_paye des factures de ce mois (payee + partielle)
    const encaisseMois = factures
      .filter(f => {
        const fd = new Date(f.date_facture);
        return fd.getMonth() === m && fd.getFullYear() === y && f.statut === "conforme";
      })
      .reduce((s, f) => s + Number(f.montant_paye ?? 0), 0);

    return { mois, caHT: Math.round(caHtMois), encaisse: Math.round(encaisseMois) };
  });

  const kpis = [
    { icon: TrendingUp, label: "CA HT facturé (conformes DGI)", value: fmt(caHT), sub: `TTC: ${fmt(caTTC)}`, color: "text-green-600" },
    { icon: Wallet, label: "CA encaissé (payé + partiel)", value: fmt(caEncaisse), color: "text-emerald-600" },
    { icon: FileText, label: "Encours clients (restant à encaisser)", value: fmt(encours), color: "text-blue-600" },
    { icon: ShoppingCart, label: "Dettes fournisseurs", value: fmt(dettes), color: "text-orange-600" },
    { icon: CheckCircle, label: "TVA collectée", value: fmt(tvaCollectee), color: "text-purple-600" },
    { icon: AlertCircle, label: "En analyse DGI", value: String(enAnalyse), color: "text-yellow-600" },
  ];

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="mb-8">
        <h1 className="text-3xl font-bold">{dossier?.nom_societe ?? "Dashboard"}</h1>
        <div className="flex items-center gap-3 mt-1">
          {dossier?.ice && <span className="font-mono text-xs text-muted-foreground">ICE: {dossier.ice}</span>}
          <Badge variant="outline" className="text-green-600">{dossier?.statut}</Badge>
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          {Array(6).fill(0).map((_, i) => <div key={i} className="h-24 bg-muted rounded-xl animate-pulse" />)}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
            {kpis.map(k => (
              <Card key={k.label}><CardContent className="pt-5 pb-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">{k.label}</p>
                    <p className={`text-2xl font-bold ${k.color}`}>{k.value}</p>
                    {(k as any).sub && <p className="text-xs text-muted-foreground mt-0.5">{(k as any).sub}</p>}
                  </div>
                  <k.icon className={`h-8 w-8 ${k.color} opacity-40`} />
                </div>
              </CardContent></Card>
            ))}
          </div>

          {/* ── CENTRE D'ALERTES ─────────────────────────────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-8">
            {/* Retards clients */}
            <AlerteCard
              icon={Users}
              titre="Retards de paiement clients"
              count={retardsClients.length}
              maxJours={maxJoursClients}
              montant={totalRetardsClients}
              montantLabel="à encaisser en retard"
              to="/dossiers/$dossierId/clients"
              dossierId={dossierId}
              items={retardsClients.slice(0, 4)}
              sens="recevoir"
            />
            {/* Retards fournisseurs */}
            <AlerteCard
              icon={Building2}
              titre="Retards de paiement fournisseurs"
              count={retardsFourn.length}
              maxJours={maxJoursFourn}
              montant={totalRetardsFourn}
              montantLabel="à régler en retard"
              to="/dossiers/$dossierId/fournisseurs"
              dossierId={dossierId}
              items={retardsFourn.slice(0, 4)}
              sens="payer"
            />
            {/* Échéance TVA */}
            <Card className={
              joursTva === null ? "" :
              joursTva < 0 ? "border-red-300 bg-red-50 dark:bg-red-950/20" :
              joursTva <= 7 ? "border-orange-300 bg-orange-50 dark:bg-orange-950/20" :
              "border-blue-200 bg-blue-50/50 dark:bg-blue-950/10"
            }>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Receipt className="h-4 w-4" />Échéance de trésorerie — TVA
                </CardTitle>
              </CardHeader>
              <CardContent>
                {dernierMoisTva === null ? (
                  <p className="text-sm text-muted-foreground">Aucune écriture TVA enregistrée.</p>
                ) : !tvaAPayer ? (
                  <div className="text-sm">
                    <p className="text-blue-600 font-medium">Crédit de TVA — {fmt(Math.abs(tvaNetteMois))}</p>
                    <p className="text-xs text-muted-foreground mt-1">Période {dernierMoisTva} · rien à verser</p>
                  </div>
                ) : (
                  <>
                    <div className="flex items-baseline justify-between">
                      <p className="text-2xl font-bold text-orange-600">{fmt(tvaNetteMois)}</p>
                      {joursTva! < 0
                        ? <Badge variant="destructive" className="text-xs">⚠️ {Math.abs(joursTva!)} j de retard</Badge>
                        : <Badge variant={joursTva! <= 7 ? "destructive" : "outline"} className="text-xs">Dans {joursTva} j</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      TVA nette {dernierMoisTva} · échéance le {echeanceTva?.toLocaleDateString("fr-MA")}
                    </p>
                    <Link to="/dossiers/$dossierId/fiscalite" params={{ dossierId }} className="text-xs text-primary hover:underline mt-2 inline-block">
                      Voir la déclaration →
                    </Link>
                  </>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <Card className="lg:col-span-2">
              <CardHeader><CardTitle className="text-base">Chiffre d'affaires — 6 mois</CardTitle></CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart data={chartData}>
                    <defs>
                      <linearGradient id="colorRev" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#2563eb" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#2563eb" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="colorEnc" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="mois" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
                    <Tooltip formatter={(v: any, name: string) => [fmt(v), name === "caHT" ? "CA HT facturé" : "Encaissé"]} />
                    <Legend formatter={(v: string) => v === "caHT" ? "CA HT facturé" : "Encaissé"} />
                    <Area type="monotone" dataKey="caHT" stroke="#2563eb" strokeWidth={2} fill="url(#colorRev)" name="caHT" />
                    <Area type="monotone" dataKey="encaisse" stroke="#10b981" strokeWidth={2} fill="url(#colorEnc)" name="encaisse" />
                  </AreaChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-base">Alertes</CardTitle></CardHeader>
              <CardContent>
                {alertes.length === 0 ? (
                  <div className="text-center py-6 text-muted-foreground text-sm">
                    <CheckCircle className="h-8 w-8 mx-auto mb-2 opacity-30" />
                    Aucune alerte active
                  </div>
                ) : alertes.map(a => (
                  <div key={a.id} className={`p-3 rounded-lg mb-2 text-sm ${a.type === "danger" ? "bg-red-50 dark:bg-red-950/20 text-red-700" : "bg-yellow-50 dark:bg-yellow-950/20 text-yellow-700"}`}>
                    <p className="font-medium">{a.titre}</p>
                    {a.message && <p className="text-xs opacity-80 mt-0.5">{a.message}</p>}
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

// ── Carte d'alerte de retard (clients ou fournisseurs) avec compteurs de jours ──
interface AlerteItem { id: string; tiers: string; restant: number; jours: number; }
function AlerteCard({
  icon: Icon, titre, count, maxJours, montant, montantLabel, to, dossierId, items, sens,
}: {
  icon: typeof Users; titre: string; count: number; maxJours: number; montant: number;
  montantLabel: string; to: string; dossierId: string; items: AlerteItem[]; sens: "recevoir" | "payer";
}) {
  const severite = count === 0 ? "ok" : maxJours > 60 ? "danger" : maxJours > 30 ? "warning" : "mild";
  const cardCls =
    severite === "danger" ? "border-red-300 bg-red-50 dark:bg-red-950/20" :
    severite === "warning" ? "border-orange-300 bg-orange-50 dark:bg-orange-950/20" :
    severite === "mild" ? "border-yellow-200 bg-yellow-50/60 dark:bg-yellow-950/10" : "";
  const joursBadge = (j: number) =>
    j > 60 ? "bg-red-100 text-red-700" : j > 30 ? "bg-orange-100 text-orange-700" : "bg-yellow-100 text-yellow-700";

  return (
    <Card className={cardCls}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2"><Icon className="h-4 w-4" />{titre}</CardTitle>
      </CardHeader>
      <CardContent>
        {count === 0 ? (
          <div className="flex items-center gap-2 text-sm text-green-600">
            <CheckCircle className="h-4 w-4" />Aucun retard
          </div>
        ) : (
          <>
            <div className="flex items-baseline justify-between">
              <div>
                <span className="text-2xl font-bold text-red-600">{count}</span>
                <span className="text-xs text-muted-foreground ml-1">facture{count > 1 ? "s" : ""} en retard</span>
              </div>
              <Badge variant="destructive" className="text-xs flex items-center gap-1">
                <Clock className="h-3 w-3" />jusqu'à {maxJours} j
              </Badge>
            </div>
            <p className="text-sm font-semibold mt-1">{fmt(montant)}</p>
            <p className="text-[11px] text-muted-foreground">{montantLabel}</p>
            <div className="mt-2 space-y-1">
              {items.map((it, i) => (
                <div key={i} className="flex items-center justify-between text-xs">
                  <span className="truncate max-w-[60%]" title={it.tiers}>{it.tiers} <span className="text-muted-foreground">· {it.id}</span></span>
                  <span className={`px-1.5 py-0.5 rounded font-medium ${joursBadge(it.jours)}`}>{it.jours} j</span>
                </div>
              ))}
            </div>
            <Link to={to as any} params={{ dossierId }} className="text-xs text-primary hover:underline mt-2 inline-block">
              {sens === "recevoir" ? "Relancer les clients" : "Voir les fournisseurs"} →
            </Link>
          </>
        )}
      </CardContent>
    </Card>
  );
}

