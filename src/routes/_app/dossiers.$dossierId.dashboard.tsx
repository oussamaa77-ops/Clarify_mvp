import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TrendingUp, Wallet, FileText, ShoppingCart, AlertCircle, CheckCircle, Clock, AlertTriangle, Users, Building2, Receipt, Mail, Loader2, Landmark, ArrowLeftRight } from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { envoyerRappelTVA } from "@/server/fiscalite.functions";
import { identifierBanque, identifierBanqueParNom, maskRib } from "@/lib/bank-identity";
import { BankLogo } from "@/components/BankLogo";
import { logAudit } from "@/lib/audit";

export const Route = createFileRoute("/_app/dossiers/$dossierId/dashboard")({ component: DashboardPage });

const fmt = (n: number) => Number(n).toLocaleString("fr-MA", { minimumFractionDigits: 2 }) + " MAD";

// ── Transactions bancaires NON LETTRÉES du dossier, ventilées par relevé ────────
// « non lettrée » = ni facture ni justificatif lié (même définition que la colonne
// nb_orphelines de v_releves_stats, donc mêmes chiffres que la page Banque).
//
// Seules les transactions PORTÉES PAR UN RELEVÉ sont comptées : le total affiché est la
// somme des relevés listés, et rien d'autre. Les transactions à `releve_id` NULL (import
// antérieur aux relevés parents) sont volontairement ignorées — elles n'apparaissent dans
// aucun écran, les compter donnerait un total que l'utilisateur ne peut rapprocher de rien.
//
// On lit les transactions plutôt que v_releves_stats pour ne pas dépendre d'une vue dont
// les colonnes varient selon les bases. `ok: false` en cas d'échec : on n'annonce JAMAIS
// « rapproché » sur une requête qui n'a pas abouti.
interface FluxNonLettres { parReleve: Record<string, number>; ok: boolean }
const PAGE_TX = 1000; // limite de lignes par requête PostgREST

async function chargerFluxNonLettres(dossierId: string): Promise<FluxNonLettres> {
  const parReleve: Record<string, number> = {};
  for (let from = 0; ; from += PAGE_TX) {
    const { data, error } = await (supabase.from("transactions_bancaires") as any)
      .select("id,releve_id")
      .eq("dossier_id", dossierId)
      .is("facture_id", null)
      .is("justificatif_id", null)
      .not("releve_id", "is", null)
      .order("id")
      .range(from, from + PAGE_TX - 1);
    if (error) {
      console.error("[DASHBOARD] flux non lettrés illisibles:", error.message);
      return { parReleve: {}, ok: false };
    }
    const rows = (data ?? []) as { id: string; releve_id: string }[];
    for (const t of rows) parReleve[t.releve_id] = (parReleve[t.releve_id] ?? 0) + 1;
    if (rows.length < PAGE_TX) break;
  }
  return { parReleve, ok: true };
}

function DashboardPage() {
  const { dossierId } = Route.useParams();
  const [dossier, setDossier] = useState<any>(null);
  const [factures, setFactures] = useState<any[]>([]);
  const [ff, setFf] = useState<any[]>([]);
  const [alertes, setAlertes] = useState<any[]>([]);
  const [ecrTva, setEcrTva] = useState<any[]>([]);
  const [comptesBancaires, setComptesBancaires] = useState<CompteBancaire[]>([]);
  const [releves, setReleves] = useState<ReleveResume[]>([]);
  const [flux, setFlux] = useState<FluxNonLettres>({ parReleve: {}, ok: true });
  const [loading, setLoading] = useState(true);
  const [sendingTva, setSendingTva] = useState(false);
  const { user, profile } = useAuth();

  // Tracé d'audit : ouverture / changement de dossier (une fois par dossierId).
  useEffect(() => { logAudit({ dossierId, action: "ouverture_dossier", ressourceType: "dossier", ressourceId: dossierId }); }, [dossierId]);

  useEffect(() => {
    (async () => {
      const [{ data: d }, { data: f }, { data: ffData }, { data: al }, { data: tva }, { data: cb }, { data: rel }, fluxNonLettres] = await Promise.all([
        supabase.from("dossiers").select("nom_societe,ice,statut").eq("id", dossierId).single(),
        // Ajouter montant_paye et montant_restant pour calculs corrects + tiers pour les alertes
        supabase.from("factures").select("numero,statut,statut_paiement,montant_ht,montant_ttc,montant_tva,montant_paye,montant_restant,type,date_facture,date_echeance,clients(nom)").eq("dossier_id", dossierId),
        supabase.from("factures_fournisseurs").select("numero,fournisseur_nom,statut_paiement,montant_ttc,montant_paye,montant_restant,date_echeance,date_facture").eq("dossier_id", dossierId),
        supabase.from("alertes").select("*").eq("dossier_id", dossierId).eq("lue", false).order("created_at", { ascending: false }).limit(5),
        // Écritures TVA (mêmes comptes que la page Fiscalité) pour l'échéance de trésorerie
        supabase.from("ecritures_comptables").select("compte_numero,debit,credit,date_ecriture").eq("dossier_id", dossierId).in("compte_numero", ["44551", "34552"]),
        // Comptes & flux bancaires : TOUS les comptes du dossier + relevés + transactions
        // non lettrées comptées par relevé (cf. chargerFluxNonLettres).
        supabase.from("comptes_bancaires").select("id,banque,intitule,rib,solde_actuel").eq("dossier_id", dossierId).order("created_at"),
        // `select("*")` volontaire (comme la page Banque) : les colonnes méta banque/rib/
        // periode_* n'existent pas sur toutes les bases (migration « briques » appliquée
        // manuellement). Un select nommé y échoue et renvoie data=null pour TOUTE la
        // requête — la carte croirait alors qu'il n'y a aucun relevé.
        (supabase.from("releves_bancaires") as any).select("*").eq("dossier_id", dossierId).order("created_at", { ascending: false }),
        chargerFluxNonLettres(dossierId),
      ]);
      setDossier(d);
      setFactures(f ?? []);
      setFf(ffData ?? []);
      setAlertes(al ?? []);
      setEcrTva(tva ?? []);
      setComptesBancaires((cb ?? []) as CompteBancaire[]);
      setReleves((rel ?? []) as ReleveResume[]);
      setFlux(fluxNonLettres);
      setLoading(false);
    })();
  }, [dossierId]);

  // ── KPIs ──────────────────────────────────────────────────────────────────
  const conformes = factures.filter(f => f.statut === "conforme");

  // CA HT = factures standard conformes uniquement (acompte → 4191, pas CA)
  const caHT = conformes
    .filter(f => f.type !== "acompte")
    .reduce((s, f) => s + Number(f.montant_ht), 0);

  // CA TTC facturé (hors acomptes)
  const caTTC = conformes
    .filter(f => f.type !== "acompte")
    .reduce((s, f) => s + Number(f.montant_ttc), 0);

  // CA encaissé = factures standard payées ou partielles (pas les acomptes)
  const caEncaisse = conformes
    .filter(f => f.type !== "acompte" && f.statut_paiement !== "non_payee")
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
  // Montant réellement dû, robuste à un montant_restant périmé (0 par défaut alors que
  // la facture est non payée) : on retombe sur TTC − payé si le restant stocké est nul.
  const duFacture = (f: any) => {
    const r = Number(f.montant_restant ?? 0);
    return r > 0.005 ? r : Math.max(0, Number(f.montant_ttc ?? 0) - Number(f.montant_paye ?? 0));
  };

  // Retards clients : factures conformes non soldées dont l'échéance est dépassée.
  const retardsClients = factures
    .filter(f => f.statut === "conforme" && f.statut_paiement !== "payee" && f.date_echeance && new Date(f.date_echeance) < today
      && duFacture(f) > 0.005)   // exclut les factures réellement soldées
    .map(f => ({
      id: f.numero ?? "—",
      tiers: (f as any).clients?.nom ?? "Client",
      restant: duFacture(f),
      jours: joursDepuis(f.date_echeance),
    }))
    .sort((a, b) => b.jours - a.jours);
  const totalRetardsClients = retardsClients.reduce((s, r) => s + r.restant, 0);
  const maxJoursClients = retardsClients[0]?.jours ?? 0;

  // Retards fournisseurs : factures fournisseurs non payées dont l'échéance est dépassée.
  const retardsFourn = ff
    .filter(f => f.statut_paiement !== "payee" && f.date_echeance && new Date(f.date_echeance) < today
      && duFacture(f) > 0.005)   // exclut les factures réellement soldées
    .map(f => ({
      id: f.numero ?? "—",
      tiers: f.fournisseur_nom ?? "Fournisseur",
      restant: duFacture(f),
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

  // Rappel INTERNE : envoie au gérant/utilisateur courant (jamais un tiers) un
  // récap de l'échéance TVA (montant net, période, date limite) via SMTP.
  const envoyerRappelTvaMail = async () => {
    const to = user?.email ?? profile?.email ?? "";
    if (!to) { toast.error("Aucune adresse e-mail pour l'utilisateur courant."); return; }
    if (!dernierMoisTva || !echeanceTva) { toast.error("Aucune échéance TVA à rappeler."); return; }
    setSendingTva(true);
    try {
      const gerantNom = [profile?.prenom, profile?.nom].filter(Boolean).join(" ").trim();
      await envoyerRappelTVA({
        data: {
          to,
          gerantNom: gerantNom || undefined,
          societeNom: dossier?.nom_societe ?? "HisabPro",
          montantTVA: Number(tvaNetteMois.toFixed(2)),
          periode: dernierMoisTva,
          dateEcheance: echeanceTva.toLocaleDateString("fr-MA"),
          joursRestants: joursTva ?? undefined,
        },
      });
      toast.success(`Rappel d'échéance TVA envoyé à ${to}`);
    } catch (e: any) {
      toast.error("Échec de l'envoi : " + (e?.message ?? e));
    } finally {
      setSendingTva(false);
    }
  };

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
              to="/dossiers/$dossierId/relances"
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
                    <div className="flex items-center gap-3 mt-3">
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={envoyerRappelTvaMail} disabled={sendingTva}
                        title="M'envoyer par e-mail un rappel de cette échéance TVA">
                        {sendingTva ? <Loader2 className="h-3 w-3 mr-1.5 animate-spin" /> : <Mail className="h-3 w-3 mr-1.5" />}
                        M'envoyer un rappel
                      </Button>
                      <Link to="/dossiers/$dossierId/fiscalite" params={{ dossierId }} className="text-xs text-primary hover:underline">
                        Voir la déclaration →
                      </Link>
                    </div>
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

            <ComptesFluxBancairesCard dossierId={dossierId} comptes={comptesBancaires} releves={releves} flux={flux} />
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
              {items.map((it, i) => {
                const contenu = (
                  <>
                    <span className="truncate max-w-[60%]" title={it.tiers}>{it.tiers} <span className="text-muted-foreground">· {it.id}</span></span>
                    <span className={`px-1.5 py-0.5 rounded font-medium ${joursBadge(it.jours)}`}>{it.jours} j</span>
                  </>
                );
                // Clients (recevoir) : ligne cliquable → module de relance pré-filtré sur le tiers.
                return sens === "recevoir" ? (
                  <Link key={i} to={to as any} params={{ dossierId } as any} search={{ client: it.tiers } as any}
                    className="flex items-center justify-between text-xs rounded px-1 -mx-1 hover:bg-white/70 dark:hover:bg-white/10 cursor-pointer transition-colors">
                    {contenu}
                  </Link>
                ) : (
                  <div key={i} className="flex items-center justify-between text-xs">{contenu}</div>
                );
              })}
            </div>
            <Link to={to as any} params={{ dossierId } as any} className="text-xs text-primary hover:underline mt-2 inline-block font-medium">
              {sens === "recevoir" ? "Relancer les clients" : "Voir les fournisseurs"} →
            </Link>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Comptes & Flux Bancaires — suivi de synchronisation + rapprochement (style Pennylane) ──
// Données RÉELLES du dossier : TOUS les comptes bancaires (logo/RIB/solde), les relevés
// importés, et les transactions NON LETTRÉES ventilées par relevé (cf. chargerFluxNonLettres).
// Le total « en attente » est, par construction, la somme des lignes affichées.
// Chaque relevé est cliquable et mène directement à son détail dans la section Banque.
interface CompteBancaire { id: string; banque: string | null; intitule: string | null; rib: string | null; solde_actuel: number | null; }
// Champs méta optionnels : absents des bases où la migration « briques » n'est pas appliquée.
interface ReleveResume {
  id: string; compte_id: string | null; statut: string; fichier_nom: string | null;
  banque?: string | null; rib?: string | null;
  periode_debut?: string | null; periode_fin?: string | null;
  date_debut?: string | null; date_fin?: string | null;
}
function ComptesFluxBancairesCard({
  dossierId, comptes, releves, flux,
}: {
  dossierId: string; comptes: CompteBancaire[]; releves: ReleveResume[]; flux: FluxNonLettres;
}) {
  const soldeTotal = comptes.reduce((s, c) => s + Number(c?.solde_actuel ?? 0), 0);
  const nbReleves = releves.length;

  // Identité bancaire — même règle que les cartes de comptes de la page Banque : RIB
  // autoritaire, repli sur le libellé. Un relevé sans méta (base non migrée) hérite de
  // celles de son compte porteur, pour ne jamais afficher de logo générique à tort.
  const identifier = (rib?: string | null, nom?: string | null) =>
    rib ? identifierBanque({ rib, texte: nom ?? "" }) : identifierBanqueParNom(nom);
  const identReleve = (r: ReleveResume) => {
    const cpt = comptes.find((c) => c.id === r.compte_id);
    return identifier(r.rib || cpt?.rib, r.banque || cpt?.banque);
  };

  // Relevés (actifs ou clôturés) portant encore des transactions non lettrées.
  const relevesEnAttente = releves
    .map((r) => ({ releve: r, nb: flux.parReleve[r.id] ?? 0 }))
    .filter((x) => x.nb > 0)
    .sort((a, b) => b.nb - a.nb);
  // Total = somme exacte des relevés listés ⇒ l'addition est vérifiable à l'œil.
  const nbNonLettrees = relevesEnAttente.reduce((s, x) => s + x.nb, 0);
  const MAX_LIGNES = 4;
  const visibles = relevesEnAttente.slice(0, MAX_LIGNES);
  const masques = relevesEnAttente.slice(MAX_LIGNES);
  const nbMasquees = masques.reduce((s, x) => s + x.nb, 0);
  const periodeReleve = (r: ReleveResume) => r.periode_fin ?? r.date_fin ?? null;

  // Aucun compte enregistré → état vide harmonisé (invite à configurer).
  if (comptes.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Landmark className="h-4 w-4" />Comptes &amp; Flux Bancaires
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-6 text-muted-foreground text-sm">
            <Landmark className="h-8 w-8 mx-auto mb-2 opacity-30" />
            Aucun compte bancaire synchronisé
          </div>
          <div className="flex justify-end">
            <Link to="/dossiers/$dossierId/banque" params={{ dossierId }} className="text-xs text-primary hover:underline font-medium">
              Ajouter un compte →
            </Link>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Landmark className="h-4 w-4" />Comptes &amp; Flux Bancaires
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Solde consolidé — puis le détail de CHAQUE compte, pour que le total affiché
            corresponde visiblement aux comptes listés en dessous. */}
        <div>
          <p className="text-2xl font-bold">{fmt(soldeTotal)}</p>
          <p className="text-[11px] text-muted-foreground">
            {comptes.length > 1 ? `Solde total · ${comptes.length} comptes` : "Solde bancaire courant"}
            {` · ${nbReleves} relevé${nbReleves > 1 ? "s" : ""} importé${nbReleves > 1 ? "s" : ""}`}
          </p>
        </div>

        <div className="space-y-1">
          {comptes.map((c) => {
            const ident = identifier(c.rib, c.banque);
            const ribMasque = maskRib(c.rib);
            return (
              <div key={c.id} className="flex items-center gap-2 py-1">
                <BankLogo ident={ident} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium truncate">{c.intitule || c.banque || ident.nom}</p>
                  <p className="text-[10px] text-muted-foreground font-mono truncate">
                    {ribMasque || "RIB non renseigné"}
                  </p>
                </div>
                <span className={`text-xs font-mono font-semibold shrink-0 ${Number(c.solde_actuel ?? 0) < 0 ? "text-red-600" : ""}`}>
                  {fmt(Number(c.solde_actuel ?? 0))}
                </span>
              </div>
            );
          })}
        </div>

        {/* Section Rapprochement — total + détail par relevé (chaque ligne mène au relevé) */}
        {!flux.ok ? (
          // Requête en échec : ne jamais annoncer « rapproché » sur une donnée qu'on n'a pas.
          <div className="rounded-lg border border-muted bg-muted/40 p-3">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <AlertTriangle className="h-4 w-4" />Flux non lettrés indisponibles
            </div>
          </div>
        ) : nbNonLettrees > 0 ? (
          <div className="rounded-lg border border-orange-200 bg-orange-50/70 dark:border-orange-900/50 dark:bg-orange-950/20 p-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-orange-700 dark:text-orange-400">
              <ArrowLeftRight className="h-4 w-4" />{nbNonLettrees} transaction{nbNonLettrees > 1 ? "s" : ""} en attente
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">
              Transactions bancaires non rapprochées de leurs factures (PCM/CGNC)
              {relevesEnAttente.length > 0 && `, réparties sur ${relevesEnAttente.length} relevé${relevesEnAttente.length > 1 ? "s" : ""}`}.
            </p>

            <div className="mt-3 space-y-1">
              {visibles.map(({ releve: r, nb }) => {
                const ident = identReleve(r);
                const compte = comptes.find((c) => c.id === r.compte_id);
                const titre = r.banque || compte?.banque || ident.nom;
                const sousTitre = [r.fichier_nom, periodeReleve(r)].filter(Boolean).join(" · ");
                return (
                  <Link
                    key={r.id}
                    to="/dossiers/$dossierId/banque/$releveId"
                    params={{ dossierId, releveId: r.id }}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 -mx-1 hover:bg-orange-100/60 dark:hover:bg-orange-900/20 transition-colors"
                  >
                    <BankLogo ident={ident} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium truncate">
                        {titre}
                        {r.statut === "cloture" && <span className="ml-1 text-[10px] text-muted-foreground font-normal">(clôturé)</span>}
                      </p>
                      {sousTitre && <p className="text-[10px] text-muted-foreground truncate">{sousTitre}</p>}
                    </div>
                    <Badge className="text-[10px] shrink-0 bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300">
                      {nb} en attente
                    </Badge>
                  </Link>
                );
              })}
            </div>

            {masques.length > 0 && (
              <p className="text-[11px] text-muted-foreground mt-2">
                + {masques.length} autre{masques.length > 1 ? "s" : ""} relevé{masques.length > 1 ? "s" : ""} ({nbMasquees} transaction{nbMasquees > 1 ? "s" : ""})
              </p>
            )}
          </div>
        ) : nbReleves === 0 ? (
          // Aucun relevé importé : ne PAS annoncer « rapproché » (il n'y a rien à
          // rapprocher). État neutre invitant à importer un relevé.
          <div className="rounded-lg border border-muted bg-muted/40 p-3">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Landmark className="h-4 w-4" />Aucun relevé enregistré
            </div>
          </div>
        ) : (
          // Il y a des relevés ET toutes leurs transactions sont rapprochées.
          <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 dark:border-emerald-900/50 dark:bg-emerald-950/20 p-3">
            <div className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-400">
              <CheckCircle className="h-4 w-4" />Tous les flux sont rapprochés
            </div>
          </div>
        )}

        <div className="flex justify-end">
          <Link to="/dossiers/$dossierId/banque" params={{ dossierId }} className="text-xs text-primary hover:underline font-medium inline-flex items-center gap-1">
            {nbNonLettrees > 0 ? "Rapprocher mes flux →" : "Voir mes comptes →"}
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

