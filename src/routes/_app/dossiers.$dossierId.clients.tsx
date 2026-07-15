import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus, Pencil, Trash2, Users, X, FileText, Download, Wand2, BarChart2, Scale } from "lucide-react";
import { toast } from "sonner";
import { logAudit } from "@/lib/audit";
import { downloadSageTiers, nextCodeAuxiliaire } from "@/lib/sage-export";
import { TiersReporting } from "@/components/TiersReporting";
import { BalanceAgee } from "@/components/BalanceAgee";
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart,
  Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";

export const Route = createFileRoute("/_app/dossiers/$dossierId/clients")({ component: ClientsPage });

export function TiersPage({ table, titre }: { table: "clients" | "fournisseurs"; titre: string }) {
  const { dossierId } = Route.useParams ? Route.useParams() : { dossierId: "" };
  return <ClientsPage />;
}

interface Tiers {
  id: string; nom: string; ice: string | null; if_fiscal: string | null;
  rc: string | null; email: string | null; telephone: string | null; adresse: string | null;
  code_auxiliaire: string | null;
}

interface Facture {
  id: string; numero: string | null; date_facture: string | null; date_echeance: string | null;
  date_paiement: string | null; montant_ttc: number; montant_paye: number;
  montant_restant: number | null; statut_paiement: string | null; fichier_original_url: string | null;
}

const EMPTY = { nom: "", ice: "", if_fiscal: "", rc: "", email: "", telephone: "", adresse: "", code_auxiliaire: "" };
const fmt = (n: number) => Number(n).toLocaleString("fr-MA", { minimumFractionDigits: 2 }) + " MAD";
const MONTHS_FR = ["Jan", "Fév", "Mar", "Avr", "Mai", "Jun", "Jul", "Aoû", "Sep", "Oct", "Nov", "Déc"];
const PIE_COLORS = ["#22c55e", "#f59e0b", "#ef4444"];

const TYPE_DOC_LBL: Record<string, string> = {
  recu: "Reçu", bon_commande: "Bon de commande", bon_livraison: "Bon de livraison",
  note_frais: "Note de frais", addition: "Addition", dum: "DUM / Import",
};
const CATEG_PCM_LBL: Record<string, string> = {
  paiement_fournisseur: "Achat fourn.", acompte_fournisseur: "Acompte BC",
  encaissement_client: "Encaiss. client", loyers: "Loyer", gasoil: "Carburant",
  frais_representation: "Restaurant", transport: "Transport", tva_import: "TVA import",
  charges_sociales: "Charges Sociales",
};

function statutLabel(f: Facture): { label: string; cls: string } {
  const restant = Number(f.montant_restant ?? f.montant_ttc);
  if (restant <= 0 || f.statut_paiement === "payee") return { label: "Payée", cls: "bg-green-100 text-green-700" };
  if (f.date_echeance && new Date(f.date_echeance) < new Date()) return { label: "En retard", cls: "bg-red-100 text-red-700" };
  return { label: "En attente", cls: "bg-yellow-100 text-yellow-700" };
}

function ClientsPage() {
  const { dossierId } = Route.useParams();
  const navigate = Route.useNavigate();
  const [items, setItems] = useState<Tiers[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Tiers | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"annuaire" | "balance" | "reporting">("annuaire");
  const [selectedClient, setSelectedClient] = useState<Tiers | null>(null);
  const [detailTab, setDetailTab] = useState<"kpis" | "factures" | "justificatifs">("kpis");
  const [factures, setFactures] = useState<Facture[]>([]);
  const [facturesLoading, setFacturesLoading] = useState(false);
  const [justificatifsVente, setJustificatifsVente] = useState<any[]>([]);

  const load = async () => {
    setLoading(true);
    const [{ data }, { data: jj }] = await Promise.all([
      supabase.from("clients").select("*").eq("dossier_id", dossierId).is("deleted_at", null).order("nom"),
      (supabase.from("justificatifs") as any).select("*").eq("dossier_id", dossierId).eq("flux_type", "vente").order("created_at", { ascending: false }),
    ]);
    setItems((data ?? []) as Tiers[]);
    setJustificatifsVente(jj ?? []);
    setLoading(false);
  };

  const loadFactures = async (clientId: string) => {
    setFacturesLoading(true);
    const { data } = await supabase
      .from("factures")
      .select("id,numero,date_facture,date_echeance,date_paiement,montant_ttc,montant_paye,montant_restant,statut_paiement,fichier_original_url")
      .eq("dossier_id", dossierId)
      .eq("client_id", clientId)
      .order("date_echeance", { ascending: false });
    setFactures((data ?? []) as Facture[]);
    setFacturesLoading(false);
  };

  useEffect(() => { load(); }, [dossierId]);
  useEffect(() => {
    if (selectedClient) loadFactures(selectedClient.id);
    else setFactures([]);
  }, [selectedClient?.id]);

  // ── KPIs ────────────────────────────────────────────────────────────────────
  const kpis = useMemo(() => {
    const today = new Date();
    const encours = factures.reduce((s, f) => s + Number(f.montant_restant ?? 0), 0);
    const ca = factures.reduce((s, f) => s + Number(f.montant_ttc), 0);
    const total = factures.length;
    const payees = factures.filter(f => f.statut_paiement === "payee").length;
    const en_retard = factures.filter(f =>
      f.statut_paiement !== "payee" &&
      f.date_echeance && new Date(f.date_echeance) < today &&
      Number(f.montant_restant ?? f.montant_ttc) > 0
    ).length;
    const en_attente = total - payees - en_retard;

    const paidFacs = factures.filter(f => f.statut_paiement === "payee" && f.date_facture);
    const delaiMoyen: number | null = paidFacs.length > 0
      ? Math.round(paidFacs.reduce((s, f) => {
          const debut = new Date(f.date_facture!);
          const fin = f.date_paiement
            ? new Date(f.date_paiement)
            : f.date_echeance ? new Date(f.date_echeance) : debut;
          return s + Math.max(0, (fin.getTime() - debut.getTime()) / 86400000);
        }, 0) / paidFacs.length)
      : null;

    return { encours, ca, total, payees, en_attente, en_retard, delaiMoyen };
  }, [factures]);

  // ── BarChart : CA mensuel 12 derniers mois ────────────────────────────────
  const barData = useMemo(() => {
    const now = new Date();
    const months: Record<string, number> = {};
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months[`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`] = 0;
    }
    for (const f of factures) {
      if (!f.date_facture) continue;
      const k = f.date_facture.slice(0, 7);
      if (k in months) months[k] += Number(f.montant_ttc);
    }
    return Object.entries(months).map(([k, v]) => ({
      mois: MONTHS_FR[parseInt(k.split("-")[1]) - 1],
      ca: Math.round(v),
    }));
  }, [factures]);

  // ── PieChart : répartition statuts ───────────────────────────────────────
  const pieData = useMemo(() => [
    { name: "Payées", value: kpis.payees },
    { name: "En attente", value: kpis.en_attente },
    { name: "En retard", value: kpis.en_retard },
  ].filter(d => d.value > 0), [kpis]);

  // ── LineChart : encours 6 derniers mois ──────────────────────────────────
  const lineData = useMemo(() => {
    const now = new Date();
    const months: Record<string, number> = {};
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months[`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`] = 0;
    }
    for (const f of factures) {
      if (!f.date_facture || f.statut_paiement === "payee") continue;
      const k = f.date_facture.slice(0, 7);
      if (k in months) months[k] += Number(f.montant_restant ?? f.montant_ttc);
    }
    return Object.entries(months).map(([k, v]) => ({
      mois: MONTHS_FR[parseInt(k.split("-")[1]) - 1],
      encours: Math.round(v),
    }));
  }, [factures]);

  // ── Top 3 mois de facturation ─────────────────────────────────────────────
  const top3Mois = useMemo(() => {
    const byMonth: Record<string, number> = {};
    for (const f of factures) {
      if (!f.date_facture) continue;
      const k = f.date_facture.slice(0, 7);
      byMonth[k] = (byMonth[k] ?? 0) + Number(f.montant_ttc);
    }
    return Object.entries(byMonth)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, v]) => ({
        mois: `${MONTHS_FR[parseInt(k.split("-")[1]) - 1]} ${k.split("-")[0]}`,
        ca: v,
      }));
  }, [factures]);

  // Justificatifs du client sélectionné (filtre local sur nom_tiers)
  const justisClient = useMemo(() => {
    if (!selectedClient) return [];
    const nameKey = selectedClient.nom.toLowerCase().trim().slice(0, 10);
    return justificatifsVente.filter(j => {
      const tiers = (j.nom_tiers ?? "").toLowerCase().trim();
      return tiers.includes(nameKey) || (tiers.length >= 5 && nameKey.includes(tiers.slice(0, 10)));
    });
  }, [justificatifsVente, selectedClient?.nom]);

  const kpisJustisClient = useMemo(() => {
    const total = justisClient.length;
    const totalTtc = justisClient.reduce((s, j) => s + Number(j.montant_ttc || 0), 0);
    const byType: Record<string, number> = {};
    const byCateg: Record<string, number> = {};
    let ediCount = 0;
    for (const j of justisClient) {
      if (j.type_document) byType[j.type_document] = (byType[j.type_document] ?? 0) + 1;
      if (j.categorie_pcm) byCateg[j.categorie_pcm] = (byCateg[j.categorie_pcm] ?? 0) + 1;
      if (j.eligible_edi) ediCount++;
    }
    return { total, totalTtc, byType, byCateg, ediCount };
  }, [justisClient]);

  const openCreate = () => { setEditing(null); setForm(EMPTY); setOpen(true); };
  const openEdit = (t: Tiers) => {
    setEditing(t);
    setForm({ nom: t.nom, ice: t.ice ?? "", if_fiscal: t.if_fiscal ?? "", rc: t.rc ?? "", email: t.email ?? "", telephone: t.telephone ?? "", adresse: t.adresse ?? "", code_auxiliaire: t.code_auxiliaire ?? "" });
    setOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.nom) return toast.error("Nom requis");
    const payload = { ...form, ice: form.ice || null, if_fiscal: form.if_fiscal || null, rc: form.rc || null, email: form.email || null, telephone: form.telephone || null, adresse: form.adresse || null, code_auxiliaire: form.code_auxiliaire || null };
    const { error } = editing
      ? await supabase.from("clients").update(payload).eq("id", editing.id)
      : await supabase.from("clients").insert({ dossier_id: dossierId, ...payload });
    if (error) return toast.error(error.message);
    logAudit({ dossierId, action: editing ? "modification_client" : "creation_client", ressourceType: "client", ressourceId: editing?.id, details: { nom: form.nom } });
    toast.success(editing ? "Client mis à jour" : "Client créé");
    setOpen(false);
    load();
  };

  const handleDelete = async (id: string) => {
    const { error } = await supabase.from("clients").update({ deleted_at: new Date().toISOString() }).eq("id", id);
    if (error) return toast.error(error.message);
    if (selectedClient?.id === id) setSelectedClient(null);
    toast.success("Client supprimé");
    load();
  };

  const filtered = items.filter(t =>
    t.nom.toLowerCase().includes(search.toLowerCase()) ||
    (t.ice ?? "").includes(search) ||
    (t.email ?? "").includes(search)
  );

  const isPanelOpen = !!selectedClient;

  return (
    <div className="p-8 max-w-full mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">Clients</h1>
          <p className="text-muted-foreground mt-1">{items.length} client{items.length !== 1 ? "s" : ""}</p>
        </div>
        {view === "annuaire" && (
        <div className="flex gap-2">
        <Button variant="outline" onClick={() => {
          if (!items.length) return toast.info("Aucun client à exporter");
          downloadSageTiers(items, "client", dossierId);
          toast.success("Export Sage clients généré");
        }}><Download className="h-4 w-4 mr-2" />Export Sage</Button>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button onClick={openCreate}><Plus className="h-4 w-4 mr-2" />Nouveau client</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>{editing ? "Modifier le client" : "Nouveau client"}</DialogTitle></DialogHeader>
            <form onSubmit={handleSave} className="space-y-3">
              <div className="space-y-2"><Label>Raison sociale *</Label><Input required value={form.nom} onChange={e => setForm({ ...form, nom: e.target.value })} /></div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2"><Label>ICE</Label><Input value={form.ice} onChange={e => setForm({ ...form, ice: e.target.value })} placeholder="15 chiffres" /></div>
                <div className="space-y-2"><Label>IF</Label><Input value={form.if_fiscal} onChange={e => setForm({ ...form, if_fiscal: e.target.value })} /></div>
                <div className="space-y-2"><Label>RC</Label><Input value={form.rc} onChange={e => setForm({ ...form, rc: e.target.value })} /></div>
                <div className="space-y-2"><Label>Téléphone</Label><Input value={form.telephone} onChange={e => setForm({ ...form, telephone: e.target.value })} /></div>
              </div>
              <div className="space-y-2">
                <Label>Code auxiliaire <span className="text-xs text-muted-foreground font-normal">(comptabilité auxiliaire / Sage)</span></Label>
                <div className="flex gap-2">
                  <Input value={form.code_auxiliaire} onChange={e => setForm({ ...form, code_auxiliaire: e.target.value })} placeholder="C0001" className="font-mono" />
                  <Button type="button" variant="outline" size="icon" title="Générer le prochain code"
                    onClick={() => setForm({ ...form, code_auxiliaire: nextCodeAuxiliaire("client", items.map(i => i.code_auxiliaire)) })}>
                    <Wand2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="space-y-2"><Label>Email</Label><Input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></div>
              <div className="space-y-2"><Label>Adresse</Label><Input value={form.adresse} onChange={e => setForm({ ...form, adresse: e.target.value })} /></div>
              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => setOpen(false)}>Annuler</Button>
                <Button type="submit">{editing ? "Sauvegarder" : "Créer"}</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
        </div>
        )}
      </div>

      <Tabs value={view} onValueChange={(v) => setView(v as "annuaire" | "balance" | "reporting")}>
        <TabsList className="mb-4">
          <TabsTrigger value="annuaire"><Users className="h-3 w-3 mr-1" />Annuaire ({items.length})</TabsTrigger>
          <TabsTrigger value="balance"><Scale className="h-3 w-3 mr-1" />Balance âgée</TabsTrigger>
          <TabsTrigger value="reporting"><BarChart2 className="h-3 w-3 mr-1" />Reporting</TabsTrigger>
        </TabsList>

        <TabsContent value="annuaire">
      <Input className="mb-4 max-w-sm" placeholder="Rechercher…" value={search} onChange={e => setSearch(e.target.value)} />

      <div className="flex gap-6 items-start">
        {/* ── Liste clients ─────────────────────────────────────────────────── */}
        <div className={isPanelOpen ? "w-72 flex-shrink-0" : "flex-1"}>
          <Card><CardContent className="p-0">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Nom</TableHead>
                {!isPanelOpen && <><TableHead>Code aux.</TableHead><TableHead>ICE</TableHead><TableHead>IF</TableHead><TableHead>Email</TableHead><TableHead>Tél</TableHead></>}
                <TableHead></TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {loading
                  ? <TableRow><TableCell colSpan={isPanelOpen ? 2 : 7} className="text-center py-8 text-muted-foreground">Chargement…</TableCell></TableRow>
                  : filtered.length === 0
                    ? <TableRow><TableCell colSpan={isPanelOpen ? 2 : 7} className="text-center py-10 text-muted-foreground">
                        <Users className="h-8 w-8 mx-auto mb-2 opacity-30" />
                        Aucun client{search ? " trouvé" : ". Créez votre premier client."}
                      </TableCell></TableRow>
                    : filtered.map(t => (
                      <TableRow
                        key={t.id}
                        className={`cursor-pointer hover:bg-muted/50 transition-colors ${selectedClient?.id === t.id ? "bg-primary/5 border-l-2 border-l-primary" : ""}`}
                        onClick={() => setSelectedClient(selectedClient?.id === t.id ? null : t)}
                      >
                        <TableCell className="font-medium text-sm">{t.nom}</TableCell>
                        {!isPanelOpen && <>
                          <TableCell className="font-mono text-xs">{t.code_auxiliaire ?? <span className="text-muted-foreground">—</span>}</TableCell>
                          <TableCell className="font-mono text-xs">{t.ice ?? "—"}</TableCell>
                          <TableCell className="font-mono text-xs">{t.if_fiscal ?? "—"}</TableCell>
                          <TableCell className="text-sm">{t.email ?? "—"}</TableCell>
                          <TableCell className="text-sm">{t.telephone ?? "—"}</TableCell>
                        </>}
                        <TableCell onClick={e => e.stopPropagation()}>
                          <div className="flex gap-1">
                            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => openEdit(t)}><Pencil className="h-3.5 w-3.5" /></Button>
                            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => handleDelete(t.id)}><Trash2 className="h-3.5 w-3.5 text-destructive" /></Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
              </TableBody>
            </Table>
          </CardContent></Card>
        </div>

        {/* ── Panneau détail ──────────────────────────────────────────────── */}
        {isPanelOpen && (
          <div className="flex-1 min-w-0">
            {/* En-tête panneau */}
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="text-xl font-bold">{selectedClient.nom}</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {[selectedClient.ice && `ICE: ${selectedClient.ice}`, selectedClient.email].filter(Boolean).join(" · ")}
                </p>
              </div>
              <Button size="icon" variant="ghost" onClick={() => setSelectedClient(null)}><X className="h-4 w-4" /></Button>
            </div>

            {facturesLoading
              ? <div className="text-center py-12 text-muted-foreground text-sm">Chargement des données…</div>
              : (
              <Tabs value={detailTab} onValueChange={(v) => setDetailTab(v as "kpis" | "factures" | "justificatifs")}>
                <TabsList className="mb-4">
                  <TabsTrigger value="kpis">KPIs &amp; Charts</TabsTrigger>
                  <TabsTrigger value="factures">Factures ({kpis.total})</TabsTrigger>
                  <TabsTrigger value="justificatifs">Justificatifs ({kpisJustisClient.total})</TabsTrigger>
                </TabsList>

                {/* ─────────── ZONE 1 : KPIs + Charts ─────────── */}
                <TabsContent value="kpis" className="space-y-4">
                  {/* KPI cards */}
                  <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
                    <Card><CardContent className="pt-4 pb-3">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Encours total</p>
                      <p className="text-lg font-bold text-red-600 mt-1">{fmt(kpis.encours)}</p>
                    </CardContent></Card>
                    <Card><CardContent className="pt-4 pb-3">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">CA total</p>
                      <p className="text-lg font-bold text-blue-600 mt-1">{fmt(kpis.ca)}</p>
                    </CardContent></Card>
                    <Card><CardContent className="pt-4 pb-3">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1.5">Factures</p>
                      <div className="flex flex-wrap gap-1">
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-100 text-green-700">{kpis.payees} payées</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-yellow-100 text-yellow-700">{kpis.en_attente} attente</span>
                        {kpis.en_retard > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-700">{kpis.en_retard} retard</span>}
                      </div>
                    </CardContent></Card>
                    <Card><CardContent className="pt-4 pb-3">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Délai moyen paiement</p>
                      {kpis.delaiMoyen !== null
                        ? <p className="text-lg font-bold mt-1">{kpis.delaiMoyen} <span className="text-sm font-normal text-muted-foreground">jours</span></p>
                        : <p className="text-lg font-bold mt-1 text-muted-foreground">N/A</p>
                      }
                    </CardContent></Card>
                  </div>

                  {/* Top 3 mois */}
                  {top3Mois.length > 0 && (
                    <Card><CardContent className="pt-4 pb-3">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-2">Top 3 mois de facturation</p>
                      <div className="flex gap-6">
                        {top3Mois.map((m, i) => (
                          <div key={m.mois} className="flex items-center gap-2">
                            <span className="text-xs font-bold text-muted-foreground">#{i + 1}</span>
                            <div>
                              <p className="text-xs font-semibold">{m.mois}</p>
                              <p className="text-xs text-blue-600 font-mono">{fmt(m.ca)}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </CardContent></Card>
                  )}

                  {/* Charts row */}
                  <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                    {/* BarChart CA mensuel 12 mois */}
                    <Card className="xl:col-span-2"><CardContent className="pt-4">
                      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-3">CA mensuel — 12 derniers mois</p>
                      <ResponsiveContainer width="100%" height={190}>
                        <BarChart data={barData} margin={{ top: 0, right: 4, bottom: 0, left: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
                          <XAxis dataKey="mois" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                          <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false}
                            tickFormatter={v => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)} />
                          <Tooltip formatter={(v: any) => [fmt(Number(v)), "CA"]} />
                          <Bar dataKey="ca" fill="#3b82f6" radius={[3, 3, 0, 0]} maxBarSize={32} />
                        </BarChart>
                      </ResponsiveContainer>
                    </CardContent></Card>

                    {/* PieChart répartition */}
                    <Card><CardContent className="pt-4">
                      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-3">Répartition statuts</p>
                      {pieData.length > 0
                        ? (
                          <ResponsiveContainer width="100%" height={190}>
                            <PieChart>
                              <Pie data={pieData} dataKey="value" nameKey="name"
                                cx="50%" cy="45%" outerRadius={62} innerRadius={32}>
                                {pieData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                              </Pie>
                              <Tooltip formatter={(v: any) => [v, ""]} />
                              <Legend iconSize={8} iconType="circle" wrapperStyle={{ fontSize: 10 }} />
                            </PieChart>
                          </ResponsiveContainer>
                        )
                        : <p className="text-center text-muted-foreground text-xs py-10">Aucune facture</p>
                      }
                    </CardContent></Card>
                  </div>

                  {/* LineChart encours 6 mois */}
                  <Card><CardContent className="pt-4">
                    <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-3">Évolution encours — 6 derniers mois</p>
                    <ResponsiveContainer width="100%" height={150}>
                      <LineChart data={lineData} margin={{ top: 0, right: 10, bottom: 0, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                        <XAxis dataKey="mois" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false}
                          tickFormatter={v => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)} />
                        <Tooltip formatter={(v: any) => [fmt(Number(v)), "Encours"]} />
                        <Line type="monotone" dataKey="encours" stroke="#ef4444" strokeWidth={2} dot={{ r: 3, fill: "#ef4444" }} activeDot={{ r: 5 }} />
                      </LineChart>
                    </ResponsiveContainer>
                  </CardContent></Card>
                </TabsContent>

                {/* ─────────── ZONE 2 : Factures ─────────── */}
                <TabsContent value="factures">
                  <Card><CardContent className="p-0">
                    <Table>
                      <TableHeader><TableRow>
                        <TableHead>N° Facture</TableHead>
                        <TableHead>Date</TableHead>
                        <TableHead>Échéance</TableHead>
                        <TableHead className="text-right">Montant TTC</TableHead>
                        <TableHead className="text-right">Reste à payer</TableHead>
                        <TableHead>Statut</TableHead>
                      </TableRow></TableHeader>
                      <TableBody>
                        {factures.length === 0
                          ? <TableRow><TableCell colSpan={6} className="text-center py-10 text-muted-foreground">
                              <FileText className="h-6 w-6 mx-auto mb-1 opacity-30" />Aucune facture
                            </TableCell></TableRow>
                          : factures.map(f => {
                            const s = statutLabel(f);
                            return (
                              <TableRow
                                key={f.id}
                                className={`${f.fichier_original_url ? "cursor-pointer hover:bg-muted/50" : ""}`}
                                title={f.fichier_original_url ? "Cliquer pour ouvrir le PDF" : undefined}
                                onClick={() => {
                                  if (f.fichier_original_url) window.open(f.fichier_original_url, "_blank");
                                  else toast.info("Aucun PDF disponible pour cette facture");
                                }}
                              >
                                <TableCell className="font-mono text-xs font-medium">{f.numero ?? f.id.slice(0, 8)}</TableCell>
                                <TableCell className="text-xs">{f.date_facture ? new Date(f.date_facture).toLocaleDateString("fr-MA") : "—"}</TableCell>
                                <TableCell className="text-xs">{f.date_echeance ? new Date(f.date_echeance).toLocaleDateString("fr-MA") : "—"}</TableCell>
                                <TableCell className="text-right font-mono text-xs font-semibold">{fmt(Number(f.montant_ttc))}</TableCell>
                                <TableCell className={`text-right font-mono text-xs ${Number(f.montant_restant ?? 0) > 0 ? "text-red-600 font-semibold" : "text-muted-foreground"}`}>
                                  {fmt(Number(f.montant_restant ?? 0))}
                                </TableCell>
                                <TableCell><Badge className={`text-[10px] ${s.cls}`}>{s.label}</Badge></TableCell>
                              </TableRow>
                            );
                          })}
                      </TableBody>
                    </Table>
                  </CardContent></Card>
                </TabsContent>
                {/* ─────────── ZONE 3 : Justificatifs ─────────── */}
                <TabsContent value="justificatifs" className="space-y-4">
                  <div className="grid grid-cols-3 gap-3">
                    <Card><CardContent className="pt-4 pb-3">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Documents</p>
                      <p className="text-lg font-bold mt-1">{kpisJustisClient.total}</p>
                    </CardContent></Card>
                    <Card><CardContent className="pt-4 pb-3">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Total TTC</p>
                      <p className="text-lg font-bold text-blue-600 mt-1">{fmt(kpisJustisClient.totalTtc)}</p>
                    </CardContent></Card>
                    <Card><CardContent className="pt-4 pb-3">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">EDI éligible</p>
                      <p className="text-lg font-bold text-green-600 mt-1">{kpisJustisClient.ediCount}</p>
                    </CardContent></Card>
                  </div>

                  {kpisJustisClient.total > 0 && (
                    <div className="grid grid-cols-2 gap-3">
                      <Card><CardContent className="pt-3 pb-3">
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-2">Par type</p>
                        <div className="flex flex-wrap gap-1">
                          {Object.entries(kpisJustisClient.byType).map(([t, n]) => (
                            <span key={t} className="text-[10px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">
                              {TYPE_DOC_LBL[t] ?? t}: {n}
                            </span>
                          ))}
                        </div>
                      </CardContent></Card>
                      <Card><CardContent className="pt-3 pb-3">
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-2">Par catégorie PCM</p>
                        <div className="flex flex-wrap gap-1">
                          {Object.entries(kpisJustisClient.byCateg).map(([c, n]) => (
                            <span key={c} className="text-[10px] px-2 py-0.5 rounded-full bg-violet-50 text-violet-700">
                              {CATEG_PCM_LBL[c] ?? c}: {n}
                            </span>
                          ))}
                        </div>
                      </CardContent></Card>
                    </div>
                  )}

                  <Card><CardContent className="p-0">
                    <Table>
                      <TableHeader><TableRow>
                        <TableHead>Type</TableHead>
                        <TableHead>Catégorie PCM</TableHead>
                        <TableHead>N° pièce</TableHead>
                        <TableHead className="text-right">TTC</TableHead>
                        <TableHead>Date</TableHead>
                        <TableHead>Statut</TableHead>
                      </TableRow></TableHeader>
                      <TableBody>
                        {justisClient.length === 0
                          ? <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                              <FileText className="h-6 w-6 mx-auto mb-1 opacity-30" />
                              Aucun document associé à ce client
                            </TableCell></TableRow>
                          : justisClient.map(j => (
                            <TableRow key={j.id}>
                              <TableCell>
                                <Badge variant="outline" className="text-xs whitespace-nowrap">
                                  {TYPE_DOC_LBL[j.type_document] ?? j.type_document ?? "—"}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-xs text-muted-foreground">
                                {CATEG_PCM_LBL[j.categorie_pcm] ?? j.categorie_pcm ?? "—"}
                              </TableCell>
                              <TableCell className="font-mono text-xs">{j.numero_piece ?? "—"}</TableCell>
                              <TableCell className="text-right font-mono text-xs font-semibold">
                                {fmt(Number(j.montant_ttc || 0))}
                              </TableCell>
                              <TableCell className="text-xs">{j.date_document ?? "—"}</TableCell>
                              <TableCell>
                                {j.statut === "rapproche"
                                  ? <Badge className="bg-green-100 text-green-700 text-xs">✅ Rapproché</Badge>
                                  : <Badge className="bg-orange-100 text-orange-700 text-xs">⏳ En attente</Badge>}
                              </TableCell>
                            </TableRow>
                          ))}
                      </TableBody>
                    </Table>
                  </CardContent></Card>
                </TabsContent>
              </Tabs>
            )}
          </div>
        )}
      </div>
        </TabsContent>

        {/* ── Balance âgée : reste à payer des créances, ventilé par ancienneté ── */}
        <TabsContent value="balance">
          <BalanceAgee
            dossierId={dossierId}
            sens="client"
            onVoirFactures={(l) => {
              const c = (l.tiers_id ? items.find(t => t.id === l.tiers_id) : null)
                ?? items.find(t => t.nom === l.tiers_nom);
              if (!c) { toast.info("Fiche client introuvable dans l'annuaire"); return; }
              setSelectedClient(c);
              setDetailTab("factures");
              setView("annuaire");
            }}
            onRelancer={(l) => navigate({
              to: "/dossiers/$dossierId/relances",
              params: { dossierId },
              search: { client: l.tiers_nom },
            })}
          />
        </TabsContent>

        {/* ── Reporting & évolution (clients uniquement) ── */}
        <TabsContent value="reporting">
          <TiersReporting dossierId={dossierId} kind="clients" />
        </TabsContent>
      </Tabs>
    </div>
  );
}
