import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Loader2, Download, Trash2, Plus, Save, RefreshCw, AlertTriangle, CheckCircle } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_app/dossiers/$dossierId/comptabilite")({
  component: ComptabilitePage,
});

interface Ecriture {
  id: string;
  date_ecriture: string;
  journal_code: string;
  compte_numero: string;
  libelle: string;
  debit: number;
  credit: number;
  reference_piece: string | null;
  valide: boolean;
  _modifie?: boolean;
  _nouveau?: boolean;
}

interface LigneBalance {
  compte: string;
  total_debit: number;
  total_credit: number;
  solde: number;
  sens: "D" | "C";
}

const JOURNAUX = ["BQ","VTE","ACH","CAI","OD","VTE-AVR","ACH-AVR"];

// ── 3 Grands Livres distincts (Sage) ──
// Le journal_code est déjà ventilé à l'insertion (ventes→VTE, achats→ACH,
// trésorerie→BQ/CAI). On regroupe ces codes en 3 livres + une vue « Tous ».
type LivreKey = "tous" | "ventes" | "achats" | "tresorerie" | "divers";
const LIVRES: Record<LivreKey, { label: string; court: string; journaux: string[] }> = {
  tous:       { label: "Tous les journaux",         court: "Tous",            journaux: [] },
  ventes:     { label: "Grand Livre des Ventes",    court: "Ventes",          journaux: ["VTE","VTE-AVR"] },
  achats:     { label: "Grand Livre des Achats",    court: "Achats",          journaux: ["ACH","ACH-AVR"] },
  tresorerie: { label: "Grand Livre de Trésorerie", court: "Trésorerie",      journaux: ["BQ","CAI"] },
  divers:     { label: "Opérations diverses & TVA", court: "Divers (OD/TVA)", journaux: ["OD","TVA"] },
};

const fmt = (n: number) => Number(n).toLocaleString("fr-MA", { minimumFractionDigits: 2 });

function ComptabilitePage() {
  const { dossierId } = Route.useParams();
  const [tab, setTab] = useState<"grandlivre"|"balance"|"saisie">("grandlivre");
  const [livre, setLivre] = useState<LivreKey>("tous");
  const [ecritures, setEcritures] = useState<Ecriture[]>([]);
  const [pcmComptes, setPcmComptes] = useState<{ numero: string; intitule: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Filtres
  const [filtreJournal, setFiltreJournal] = useState("TOUS");
  const [filtreCompte, setFiltreCompte] = useState("");
  const [filtreDateDeb, setFiltreDateDeb] = useState("");
  const [filtreDateFin, setFiltreDateFin] = useState("");

  // Nouvelle écriture
  const [newDate, setNewDate] = useState(new Date().toISOString().slice(0,10));
  const [newJournal, setNewJournal] = useState("OD");
  const [newCompte, setNewCompte] = useState("");
  const [newLibelle, setNewLibelle] = useState("");
  const [newDebit, setNewDebit] = useState(0);
  const [newCredit, setNewCredit] = useState(0);
  const [newRef, setNewRef] = useState("");

  // Suppression
  const [deleteIds, setDeleteIds] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteLot, setDeleteLot] = useState<{journal?:string;date?:string}|null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    let query = supabase.from("ecritures_comptables")
      .select("*").eq("dossier_id", dossierId)
      .order("date_ecriture", { ascending: false })
      .order("journal_code").order("created_at", { ascending: true });

    if (filtreJournal !== "TOUS") query = query.eq("journal_code", filtreJournal);
    if (filtreCompte) query = query.eq("compte_numero", filtreCompte);
    if (filtreDateDeb) query = query.gte("date_ecriture", filtreDateDeb);
    if (filtreDateFin) query = query.lte("date_ecriture", filtreDateFin);

    const { data, error } = await query.limit(1000);
    if (error) { toast.error(error.message); setLoading(false); return; }
    setEcritures((data ?? []) as Ecriture[]);
    setLoading(false);
    setDeleteIds(new Set());
  }, [dossierId, filtreJournal, filtreCompte, filtreDateDeb, filtreDateFin]);

  useEffect(() => { load(); }, [load]);

  // PCM (référentiel global) pour l'autocomplétion des comptes — chargé une fois.
  useEffect(() => {
    (async () => {
      const { data } = await (supabase as any)
        .from("pcm_reference")
        .select("numero,intitule")
        .order("numero");
      setPcmComptes((data ?? []) as { numero: string; intitule: string }[]);
    })();
  }, []);

  // Modifier une écriture
  const updateEcriture = (id: string, field: keyof Ecriture, value: any) => {
    setEcritures(prev => prev.map(e =>
      e.id === id ? { ...e, [field]: value, _modifie: true } : e
    ));
  };

  // Sauvegarder les modifications
  const sauvegarder = async () => {
    const modifiees = ecritures.filter(e => e._modifie && !e._nouveau);
    if (!modifiees.length) { toast.info("Aucune modification"); return; }
    setSaving(true);
    try {
      for (const e of modifiees) {
        const { error } = await supabase.from("ecritures_comptables").update({
          date_ecriture: e.date_ecriture,
          journal_code: e.journal_code,
          compte_numero: e.compte_numero,
          libelle: e.libelle,
          debit: Number(e.debit),
          credit: Number(e.credit),
          reference_piece: e.reference_piece,
        }).eq("id", e.id);
        if (error) throw error;
      }
      toast.success(`${modifiees.length} écriture(s) sauvegardée(s)`);
      load();
    } catch (e: any) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  // Ajouter écriture manuelle
  const ajouterEcriture = async () => {
    if (!newCompte || !newDate || (!newDebit && !newCredit)) {
      toast.error("Compte, date et montant requis"); return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.from("ecritures_comptables").insert({
        dossier_id: dossierId,
        journal_code: newJournal,
        compte_numero: newCompte,
        date_ecriture: newDate,
        libelle: newLibelle,
        debit: newDebit || 0,
        credit: newCredit || 0,
        reference_piece: newRef || null,
        valide: true,
      });
      if (error) throw error;
      toast.success("Écriture ajoutée");
      setNewDebit(0); setNewCredit(0); setNewLibelle(""); setNewRef(""); setNewCompte("");
      load();
    } catch (e: any) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  // Suppression sélective
  const supprimerSelection = async () => {
    if (!deleteIds.size) { toast.warning("Aucune écriture sélectionnée"); return; }
    setSaving(true);
    try {
      const ids = Array.from(deleteIds);
      const { error } = await supabase.from("ecritures_comptables").delete().in("id", ids);
      if (error) throw error;
      toast.success(`${ids.length} écriture(s) supprimée(s)`);
      setDeleteIds(new Set()); setConfirmDelete(false);
      load();
    } catch (e: any) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  // Suppression par lot (journal + date)
  const supprimerLot = async () => {
    if (!deleteLot) return;
    setSaving(true);
    try {
      let query = supabase.from("ecritures_comptables").delete().eq("dossier_id", dossierId);
      if (deleteLot.journal) query = query.eq("journal_code", deleteLot.journal);
      if (deleteLot.date) query = query.eq("date_ecriture", deleteLot.date);
      const { error } = await query;
      if (error) throw error;
      toast.success("Écritures supprimées");
      setDeleteLot(null); setConfirmDelete(false);
      load();
    } catch (e: any) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  // Toggle sélection
  const toggleSelect = (id: string) => {
    setDeleteIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // ── Écritures du Grand Livre sélectionné (Achats / Ventes / Trésorerie / Tous) ──
  const livreJournaux = LIVRES[livre].journaux;
  const livreEcritures = livreJournaux.length
    ? ecritures.filter(e => livreJournaux.includes(e.journal_code))
    : ecritures;
  const livreTotalDebit = livreEcritures.reduce((s, e) => s + Number(e.debit), 0);
  const livreTotalCredit = livreEcritures.reduce((s, e) => s + Number(e.credit), 0);
  const livreEquilibre = Math.abs(livreTotalDebit - livreTotalCredit) < 0.01;
  const compteCount = (k: LivreKey) =>
    LIVRES[k].journaux.length ? ecritures.filter(e => LIVRES[k].journaux.includes(e.journal_code)).length : ecritures.length;

  // « Tout sélectionner » agit sur les écritures VISIBLES (livre courant).
  const toggleAll = () => {
    const visibleIds = livreEcritures.map(e => e.id);
    const allSelected = visibleIds.length > 0 && visibleIds.every(id => deleteIds.has(id));
    setDeleteIds(allSelected ? new Set() : new Set(visibleIds));
  };

  // Calcul balance
  const balance: LigneBalance[] = Object.values(
    ecritures.reduce((acc: Record<string, LigneBalance>, e) => {
      const c = e.compte_numero;
      if (!acc[c]) acc[c] = { compte: c, total_debit: 0, total_credit: 0, solde: 0, sens: "D" };
      acc[c].total_debit += Number(e.debit);
      acc[c].total_credit += Number(e.credit);
      return acc;
    }, {})
  ).map(l => {
    const solde = Math.abs(l.total_debit - l.total_credit);
    const sens: "D" | "C" = l.total_debit >= l.total_credit ? "D" : "C";
    return { ...l, solde, sens };
  }).sort((a, b) => a.compte.localeCompare(b.compte));

  const totalDebit = ecritures.reduce((s, e) => s + Number(e.debit), 0);
  const totalCredit = ecritures.reduce((s, e) => s + Number(e.credit), 0);
  const equilibre = Math.abs(totalDebit - totalCredit) < 0.01;

  // Export Excel
  const exportExcel = async () => {
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();

    // Grand livre
    const glData = [
      ["Date", "Journal", "Compte", "Libellé", "Débit", "Crédit", "Réf."],
      ...ecritures.map(e => [e.date_ecriture, e.journal_code, e.compte_numero, e.libelle, Number(e.debit)||"", Number(e.credit)||"", e.reference_piece||""]),
    ];
    const wsGL = XLSX.utils.aoa_to_sheet(glData);
    const glCols = [{wch:12},{wch:8},{wch:10},{wch:50},{wch:14},{wch:14},{wch:15}];
    wsGL["!cols"] = glCols;
    XLSX.utils.book_append_sheet(wb, wsGL, "Grand Livre");

    // Un onglet par Grand Livre distinct (Ventes / Achats / Trésorerie / Divers)
    (["ventes","achats","tresorerie","divers"] as LivreKey[]).forEach(k => {
      const lignes = ecritures.filter(e => LIVRES[k].journaux.includes(e.journal_code));
      const td = lignes.reduce((s,e)=>s+Number(e.debit),0);
      const tc = lignes.reduce((s,e)=>s+Number(e.credit),0);
      const data = [
        ["Date","Journal","Compte","Libellé","Débit","Crédit","Réf."],
        ...lignes.map(e => [e.date_ecriture, e.journal_code, e.compte_numero, e.libelle, Number(e.debit)||"", Number(e.credit)||"", e.reference_piece||""]),
        ["TOTAL","","","", td, tc, ""],
      ];
      const ws = XLSX.utils.aoa_to_sheet(data);
      ws["!cols"] = glCols;
      XLSX.utils.book_append_sheet(wb, ws, LIVRES[k].court);
    });

    // Balance
    const balData = [
      ["Compte", "Total Débit", "Total Crédit", "Solde", "Sens"],
      ...balance.map(l => [l.compte, l.total_debit, l.total_credit, l.solde, l.sens]),
      ["TOTAL", totalDebit, totalCredit, Math.abs(totalDebit-totalCredit), equilibre?"✅":"⚠️"],
    ];
    const wsBal = XLSX.utils.aoa_to_sheet(balData);
    XLSX.utils.book_append_sheet(wb, wsBal, "Balance");

    XLSX.writeFile(wb, `Comptabilite_${dossierId.slice(0,8)}_${new Date().toISOString().slice(0,10)}.xlsx`);
    toast.success("Export Excel généré");
  };

  const modifiees = ecritures.filter(e => e._modifie).length;

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Comptabilité</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Grand livre · Balance · Saisie manuelle</p>
        </div>
        <div className="flex gap-2">
          {modifiees > 0 && (
            <Button onClick={sauvegarder} disabled={saving} className="bg-green-600 hover:bg-green-700">
              {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin"/> : <Save className="h-4 w-4 mr-2"/>}
              Sauvegarder ({modifiees})
            </Button>
          )}
          {deleteIds.size > 0 && (
            <Button variant="destructive" onClick={()=>setConfirmDelete(true)}>
              <Trash2 className="h-4 w-4 mr-2"/>Supprimer ({deleteIds.size})
            </Button>
          )}
          <Button variant="outline" onClick={exportExcel}><Download className="h-4 w-4 mr-2"/>Export Excel</Button>
          <Button variant="outline" onClick={load}><RefreshCw className="h-4 w-4 mr-2"/>Actualiser</Button>
        </div>
      </div>

      {/* Équilibre */}
      <div className={`flex items-center gap-2 mb-4 p-3 rounded-lg ${equilibre?"bg-green-50 text-green-700":"bg-red-50 text-red-700"}`}>
        {equilibre ? <CheckCircle className="h-4 w-4"/> : <AlertTriangle className="h-4 w-4"/>}
        <span className="text-sm font-medium">
          {equilibre ? "✅ Balance équilibrée" : `⚠️ Écart: ${fmt(Math.abs(totalDebit-totalCredit))} MAD`}
          &nbsp;— Total Débit: <strong>{fmt(totalDebit)}</strong> / Total Crédit: <strong>{fmt(totalCredit)}</strong>
        </span>
      </div>

      {/* Filtres */}
      <div className="flex gap-3 mb-4 flex-wrap">
        <Select value={filtreJournal} onValueChange={setFiltreJournal}>
          <SelectTrigger className="w-32"><SelectValue placeholder="Journal"/></SelectTrigger>
          <SelectContent>
            <SelectItem value="TOUS">Tous journaux</SelectItem>
            {JOURNAUX.map(j => <SelectItem key={j} value={j}>{j}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input placeholder="Compte (ex: 3421)" value={filtreCompte} onChange={e=>setFiltreCompte(e.target.value)} className="w-36"/>
        <Input type="date" value={filtreDateDeb} onChange={e=>setFiltreDateDeb(e.target.value)} className="w-36"/>
        <Input type="date" value={filtreDateFin} onChange={e=>setFiltreDateFin(e.target.value)} className="w-36"/>
        <Button variant="outline" size="sm" onClick={()=>{setFiltreJournal("TOUS");setFiltreCompte("");setFiltreDateDeb("");setFiltreDateFin("");}}>Réinitialiser</Button>
        {(filtreJournal!=="TOUS"||filtreDateDeb) && (
          <Button variant="destructive" size="sm" onClick={()=>{setDeleteLot({journal:filtreJournal!=="TOUS"?filtreJournal:undefined,date:filtreDateDeb||undefined});setConfirmDelete(true);}}>
            <Trash2 className="h-3.5 w-3.5 mr-1"/>Supprimer filtre
          </Button>
        )}
      </div>

      <Tabs value={tab} onValueChange={v=>setTab(v as any)}>
        <TabsList>
          <TabsTrigger value="grandlivre">Grand Livre ({ecritures.length})</TabsTrigger>
          <TabsTrigger value="balance">Balance ({balance.length} comptes)</TabsTrigger>
          <TabsTrigger value="saisie">Saisie manuelle</TabsTrigger>
        </TabsList>

        {/* ── GRAND LIVRE ÉDITABLE ── */}
        <TabsContent value="grandlivre" className="mt-4">
          {/* Sélecteur des 3 Grands Livres distincts */}
          <div className="flex items-center gap-1 mb-3 p-1 bg-muted rounded-lg w-fit">
            {(Object.keys(LIVRES) as LivreKey[]).map(k => (
              <button key={k} onClick={()=>setLivre(k)}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors
                  ${livre===k ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
                {LIVRES[k].court} <span className="text-xs opacity-60">({compteCount(k)})</span>
              </button>
            ))}
          </div>
          {livre!=="tous" && (
            <div className={`flex items-center gap-2 mb-3 px-3 py-1.5 rounded-md text-xs ${livreEquilibre?"bg-green-50 text-green-700":"bg-amber-50 text-amber-700"}`}>
              <span className="font-semibold">{LIVRES[livre].label}</span>
              <span>· journaux {LIVRES[livre].journaux.join(", ")}</span>
              <span className="ml-auto">{livreEquilibre ? "Équilibré" : `Écart ${fmt(Math.abs(livreTotalDebit-livreTotalCredit))}`}</span>
            </div>
          )}
          {loading ? (
            <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin"/></div>
          ) : livreEcritures.length===0 ? (
            <div className="text-center py-12 text-muted-foreground text-sm">Aucune écriture dans ce Grand Livre.</div>
          ) : (
            <div className="rounded-lg border overflow-hidden">
              {/* En-tête */}
              <div className="grid grid-cols-12 gap-1 px-3 py-2 bg-muted text-xs font-semibold text-muted-foreground uppercase sticky top-0 z-10">
                <div className="col-span-1 flex items-center gap-1">
                  <input type="checkbox" checked={livreEcritures.length>0&&livreEcritures.every(e=>deleteIds.has(e.id))} onChange={toggleAll} className="h-3 w-3"/>
                  <span>#</span>
                </div>
                <div className="col-span-1">Date</div>
                <div className="col-span-1">Journal</div>
                <div className="col-span-1">Compte</div>
                <div className="col-span-4">Libellé</div>
                <div className="col-span-2 text-right">Débit</div>
                <div className="col-span-2 text-right">Crédit</div>
              </div>

              {/* Lignes éditables */}
              <div className="max-h-[60vh] overflow-y-auto">
                {livreEcritures.map((e, idx) => (
                  <div key={e.id}
                    className={`grid grid-cols-12 gap-1 px-3 py-1 border-b items-center text-xs
                      ${deleteIds.has(e.id) ? "bg-red-50 dark:bg-red-950/20" : idx%2===0 ? "bg-white dark:bg-background" : "bg-muted/20"}
                      ${e._modifie ? "border-l-2 border-l-blue-400" : ""}
                    `}>
                    <div className="col-span-1 flex items-center gap-1">
                      <input type="checkbox" checked={deleteIds.has(e.id)} onChange={()=>toggleSelect(e.id)} className="h-3 w-3"/>
                      <span className="text-muted-foreground">{idx+1}</span>
                    </div>
                    <div className="col-span-1">
                      <input type="date" value={e.date_ecriture}
                        onChange={ev=>updateEcriture(e.id,"date_ecriture",ev.target.value)}
                        className="w-full text-xs bg-transparent border-0 focus:outline-none focus:ring-1 focus:ring-primary rounded px-1"/>
                    </div>
                    <div className="col-span-1">
                      <select value={e.journal_code} onChange={ev=>updateEcriture(e.id,"journal_code",ev.target.value)}
                        className="w-full text-xs bg-transparent border-0 focus:outline-none focus:ring-1 focus:ring-primary rounded">
                        {JOURNAUX.map(j=><option key={j} value={j}>{j}</option>)}
                      </select>
                    </div>
                    <div className="col-span-1">
                      <input value={e.compte_numero}
                        onChange={ev=>updateEcriture(e.id,"compte_numero",ev.target.value)}
                        className="w-full text-xs font-mono bg-transparent border-0 focus:outline-none focus:ring-1 focus:ring-primary rounded px-1"/>
                    </div>
                    <div className="col-span-4">
                      <input value={e.libelle||""}
                        onChange={ev=>updateEcriture(e.id,"libelle",ev.target.value)}
                        className="w-full text-xs bg-transparent border-0 focus:outline-none focus:ring-1 focus:ring-primary rounded px-1"/>
                    </div>
                    <div className="col-span-2">
                      <input type="number" step="0.01" value={e.debit||""}
                        onChange={ev=>updateEcriture(e.id,"debit",parseFloat(ev.target.value)||0)}
                        className={`w-full text-xs font-mono text-right bg-transparent border-0 focus:outline-none focus:ring-1 focus:ring-primary rounded px-1 ${e.debit>0?"text-red-600":""}`}/>
                    </div>
                    <div className="col-span-2">
                      <input type="number" step="0.01" value={e.credit||""}
                        onChange={ev=>updateEcriture(e.id,"credit",parseFloat(ev.target.value)||0)}
                        className={`w-full text-xs font-mono text-right bg-transparent border-0 focus:outline-none focus:ring-1 focus:ring-primary rounded px-1 ${e.credit>0?"text-green-600":""}`}/>
                    </div>
                  </div>
                ))}
              </div>

              {/* Totaux */}
              <div className="grid grid-cols-12 gap-1 px-3 py-2 bg-muted font-semibold text-xs border-t">
                <div className="col-span-8">TOTAUX {LIVRES[livre].court} ({livreEcritures.length} écritures)</div>
                <div className="col-span-2 text-right text-red-600">{fmt(livreTotalDebit)}</div>
                <div className="col-span-2 text-right text-green-600">{fmt(livreTotalCredit)}</div>
              </div>
            </div>
          )}
        </TabsContent>

        {/* ── BALANCE ── */}
        <TabsContent value="balance" className="mt-4">
          <div className="rounded-lg border overflow-hidden">
            <div className="grid grid-cols-10 gap-1 px-4 py-2 bg-muted text-xs font-semibold uppercase text-muted-foreground">
              <div className="col-span-2">Compte</div>
              <div className="col-span-3 text-right">Total Débit</div>
              <div className="col-span-3 text-right">Total Crédit</div>
              <div className="col-span-1 text-right">Solde</div>
              <div className="col-span-1 text-center">Sens</div>
            </div>
            <div className="max-h-[60vh] overflow-y-auto">
              {balance.map((l, i) => (
                <div key={l.compte} className={`grid grid-cols-10 gap-1 px-4 py-1.5 border-b text-sm ${i%2===0?"bg-white dark:bg-background":"bg-muted/20"}`}>
                  <div className="col-span-2 font-mono font-medium">{l.compte}</div>
                  <div className="col-span-3 text-right font-mono text-red-600">{l.total_debit>0?fmt(l.total_debit):"—"}</div>
                  <div className="col-span-3 text-right font-mono text-green-600">{l.total_credit>0?fmt(l.total_credit):"—"}</div>
                  <div className="col-span-1 text-right font-mono font-semibold">{fmt(l.solde)}</div>
                  <div className="col-span-1 text-center">
                    <Badge className={l.sens==="D"?"bg-red-100 text-red-700 text-xs":"bg-green-100 text-green-700 text-xs"}>{l.sens}</Badge>
                  </div>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-10 gap-1 px-4 py-2 bg-muted font-semibold text-sm border-t">
              <div className="col-span-2">TOTAL</div>
              <div className="col-span-3 text-right font-mono text-red-600">{fmt(totalDebit)}</div>
              <div className="col-span-3 text-right font-mono text-green-600">{fmt(totalCredit)}</div>
              <div className="col-span-2 text-right">
                {equilibre ? <span className="text-green-600 text-xs">✅ Équilibrée</span> : <span className="text-red-600 text-xs">⚠️ {fmt(Math.abs(totalDebit-totalCredit))}</span>}
              </div>
            </div>
          </div>
        </TabsContent>

        {/* ── SAISIE MANUELLE ── */}
        <TabsContent value="saisie" className="mt-4">
          <Card className="max-w-2xl">
            <CardContent className="pt-6 space-y-4">
              <h3 className="font-semibold">Nouvelle écriture manuelle</h3>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="text-xs font-medium mb-1 block">Date *</label>
                  <Input type="date" value={newDate} onChange={e=>setNewDate(e.target.value)}/></div>
                <div><label className="text-xs font-medium mb-1 block">Journal *</label>
                  <Select value={newJournal} onValueChange={setNewJournal}>
                    <SelectTrigger><SelectValue/></SelectTrigger>
                    <SelectContent>{JOURNAUX.map(j=><SelectItem key={j} value={j}>{j}</SelectItem>)}</SelectContent>
                  </Select></div>
                <div><label className="text-xs font-medium mb-1 block">Compte *</label>
                  <Input value={newCompte} onChange={e=>setNewCompte(e.target.value)} placeholder="3421" list="comptes-list"/>
                  <datalist id="comptes-list">{pcmComptes.map(c=><option key={c.numero} value={c.numero}>{c.numero} — {c.intitule}</option>)}</datalist>
                </div>
                <div><label className="text-xs font-medium mb-1 block">Réf. pièce</label>
                  <Input value={newRef} onChange={e=>setNewRef(e.target.value)} placeholder="FAC-001"/></div>
              </div>
              <div><label className="text-xs font-medium mb-1 block">Libellé *</label>
                <Input value={newLibelle} onChange={e=>setNewLibelle(e.target.value)} placeholder="Description de l'écriture"/></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="text-xs font-medium mb-1 block text-red-600">Débit (MAD)</label>
                  <Input type="number" step="0.01" value={newDebit||""} onChange={e=>{setNewDebit(parseFloat(e.target.value)||0);if(e.target.value)setNewCredit(0);}}/></div>
                <div><label className="text-xs font-medium mb-1 block text-green-600">Crédit (MAD)</label>
                  <Input type="number" step="0.01" value={newCredit||""} onChange={e=>{setNewCredit(parseFloat(e.target.value)||0);if(e.target.value)setNewDebit(0);}}/></div>
              </div>
              <Button onClick={ajouterEcriture} disabled={saving} className="w-full">
                {saving?<Loader2 className="h-4 w-4 mr-2 animate-spin"/>:<Plus className="h-4 w-4 mr-2"/>}
                Ajouter l'écriture
              </Button>
            </CardContent>
          </Card>

          {/* Suppression rapide par lot pour les tests */}
          <Card className="max-w-2xl mt-4 border-red-200">
            <CardContent className="pt-4 pb-4">
              <p className="text-sm font-medium text-red-700 mb-3 flex items-center gap-2">
                <Trash2 className="h-4 w-4"/>Zone de test — Suppression par lot
              </p>
              <div className="grid grid-cols-3 gap-2">
                {JOURNAUX.map(j => (
                  <Button key={j} variant="outline" size="sm" className="border-red-200 text-red-600 hover:bg-red-50"
                    onClick={()=>{setDeleteLot({journal:j});setConfirmDelete(true);}}>
                    Supprimer tout {j}
                  </Button>
                ))}
                <Button variant="destructive" size="sm"
                  onClick={()=>{setDeleteLot({});setConfirmDelete(true);}}>
                  ⚠️ Tout supprimer
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Confirmation suppression */}
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader><DialogTitle>Confirmer la suppression</DialogTitle></DialogHeader>
          <div className="text-sm text-muted-foreground">
            {deleteLot !== null ? (
              deleteLot.journal||deleteLot.date
                ? `Supprimer toutes les écritures ${deleteLot.journal?`du journal ${deleteLot.journal}`:""}${deleteLot.date?` du ${deleteLot.date}`:""} ?`
                : "⚠️ Supprimer TOUTES les écritures comptables de ce dossier ?"
            ) : (
              `Supprimer ${deleteIds.size} écriture(s) sélectionnée(s) ?`
            )}
            <p className="mt-2 text-red-600 font-medium">Cette action est irréversible.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={()=>{setConfirmDelete(false);setDeleteLot(null);}}>Annuler</Button>
            <Button variant="destructive" disabled={saving}
              onClick={deleteLot!==null ? supprimerLot : supprimerSelection}>
              {saving?<Loader2 className="h-4 w-4 mr-2 animate-spin"/>:<Trash2 className="h-4 w-4 mr-2"/>}
              Confirmer la suppression
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
