import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useServerFn } from "@tanstack/react-start";
import { genererBulletin, validerBulletin, TAUX_PAIE } from "@/server/paie.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus, Users, FileText, CheckCircle, Download, Loader2, X, Calculator } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_app/dossiers/$dossierId/paie")({ component: PaiePage });

const fmt = (n: number) => Number(n).toLocaleString("fr-MA", { minimumFractionDigits: 2 });
const fmtMAD = (n: number) => fmt(n) + " MAD";

interface Employe {
  id: string; matricule: string | null; nom: string; prenom: string;
  type_contrat: string; poste: string | null; salaire_base: number;
  situation_familiale: string; nombre_enfants: number; actif: boolean;
  cnss_assujetti: boolean; amo_assujetti: boolean; cimr_taux: number;
}
interface Bulletin {
  id: string; employe_id: string; periode: string; statut: string;
  salaire_base: number; net_a_payer: number; cout_employeur: number;
  ir_net: number; cnss_salarie: number; amo_salarie: number;
  cnss_patronal: number; amo_patronal: number; ecriture_creee: boolean;
}

const TYPE_CONTRAT_LABEL: Record<string, string> = {
  cdi: "CDI", cdd: "CDD", interim: "Intérim", stage: "Stage", anapec: "ANAPEC"
};

function PaiePage() {
  const { dossierId } = Route.useParams();
  const genFn = useServerFn(genererBulletin);
  const valFn = useServerFn(validerBulletin);

  const [tab, setTab] = useState<"employes" | "bulletins" | "etat">("employes");
  const [employes, setEmployes] = useState<Employe[]>([]);
  const [bulletins, setBulletins] = useState<Bulletin[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState<string | null>(null);

  // Modal employé
  const [openEmp, setOpenEmp] = useState(false);
  const [editEmp, setEditEmp] = useState<Employe | null>(null);
  const [formEmp, setFormEmp] = useState({
    matricule: "", nom: "", prenom: "", cin: "", date_naissance: "",
    date_embauche: new Date().toISOString().slice(0, 10),
    type_contrat: "cdi", poste: "", departement: "",
    salaire_base: 0, situation_familiale: "celibataire", nombre_enfants: 0,
    cnss_assujetti: true, amo_assujetti: true, cimr_taux: 0,
    rib: "", email: "", telephone: "",
  });

  // Modal bulletin
  const [openBulletin, setOpenBulletin] = useState(false);
  const [selectedEmpId, setSelectedEmpId] = useState("");
  const [periode, setPeriode] = useState(new Date().toISOString().slice(0, 7));
  const [heuresSup, setHeuresSup] = useState(0);
  const [primes, setPrimes] = useState(0);
  const [indemnitesExo, setIndemnitesExo] = useState(0);
  const [avantagesNature, setAvantagesNature] = useState(0);
  const [lignesExtra, setLignesExtra] = useState<Array<{ type: "prime" | "retenue" | "indemnite" | "avantage"; libelle: string; montant: number; imposable: boolean }>>([]);
  const [simulation, setSimulation] = useState<any>(null);

  // Modal détail bulletin
  const [viewBulletin, setViewBulletin] = useState<Bulletin | null>(null);

  const load = async () => {
    setLoading(true);
    const [{ data: e }, { data: b }] = await Promise.all([
      (supabase as any).from("employes").select("*").eq("dossier_id", dossierId).order("nom"),
      (supabase as any).from("bulletins_paie").select("*").eq("dossier_id", dossierId).order("periode", { ascending: false }),
    ]);
    setEmployes((e ?? []) as Employe[]);
    setBulletins((b ?? []) as Bulletin[]);
    setLoading(false);
  };
  useEffect(() => { load(); }, [dossierId]);

  // Simulation en temps réel
  useEffect(() => {
    const emp = employes.find(e => e.id === selectedEmpId);
    if (!emp) { setSimulation(null); return; }
    // Calcul local pour aperçu rapide
    const sb = Number(emp.salaire_base);
    const th = sb / 191;
    const mhs = heuresSup * th * 1.25;
    const bg = sb + mhs + primes + avantagesNature;
    const bi = bg - indemnitesExo;
    const baseCnss = Math.min(bg, TAUX_PAIE.cnss_plafond);
    const cnss = emp.cnss_assujetti ? baseCnss * TAUX_PAIE.cnss_salarie : 0;
    const amo = emp.amo_assujetti ? bg * TAUX_PAIE.amo_salarie : 0;
    const fp = Math.min(bi * TAUX_PAIE.frais_pro_taux, TAUX_PAIE.frais_pro_max);
    const baseIR = Math.max(0, bi - fp - cnss - amo);
    const irAnnuel = baseIR * 12;
    let irB = 0;
    const BAREME = [[0,30000,0,0],[30001,50000,0.10,3000],[50001,60000,0.15,5500],[60001,80000,0.20,8500],[80001,180000,0.30,16500],[180001,Infinity,0.34,23700]];
    for (const [min,,taux,ded] of BAREME) {
      if (irAnnuel > min) { irB = Math.max(0, irAnnuel * taux - ded); if (irAnnuel <= BAREME[BAREME.indexOf([min,,taux,ded] as any)][1]) break; }
    }
    const irM = irB / 12;
    const dedFam = ((emp.situation_familiale !== "celibataire" ? 360 : 0) + Math.min(emp.nombre_enfants, 6) * 360) / 12;
    const irNet = Math.max(0, irM - dedFam);
    const retenues = cnss + amo + irNet;
    const net = Math.round((bg - retenues) * 100) / 100;
    const cnssP = emp.cnss_assujetti ? baseCnss * TAUX_PAIE.cnss_patronal : 0;
    const amoP = emp.amo_assujetti ? bg * TAUX_PAIE.amo_patronal : 0;
    const tfp = bg * TAUX_PAIE.tfp;
    setSimulation({ brut: bg, cnss: Math.round(cnss*100)/100, amo: Math.round(amo*100)/100, irNet: Math.round(irNet*100)/100, retenues: Math.round(retenues*100)/100, net, cout: Math.round((bg+cnssP+amoP+tfp)*100)/100 });
  }, [selectedEmpId, heuresSup, primes, indemnitesExo, avantagesNature, employes]);

  const handleSaveEmp = async () => {
    if (!formEmp.nom || !formEmp.prenom) return toast.error("Nom et prénom requis");
    const payload = { ...formEmp, dossier_id: dossierId, salaire_base: Number(formEmp.salaire_base), nombre_enfants: Number(formEmp.nombre_enfants), cimr_taux: Number(formEmp.cimr_taux) };
    const { error } = editEmp
      ? await (supabase as any).from("employes").update(payload).eq("id", editEmp.id)
      : await (supabase as any).from("employes").insert(payload);
    if (error) return toast.error(error.message);
    toast.success(editEmp ? "Employé mis à jour" : "Employé créé");
    setOpenEmp(false); load();
  };

  const handleGenBulletin = async () => {
    if (!selectedEmpId) return toast.error("Sélectionnez un employé");
    setProcessing("gen");
    try {
      await genFn({ data: {
        dossier_id: dossierId, employe_id: selectedEmpId, periode,
        heures_sup: heuresSup, primes, indemnites_exo: indemnitesExo,
        avantages_nature: avantagesNature, lignes_extra: lignesExtra,
      }});
      toast.success("Bulletin généré");
      setOpenBulletin(false);
      setLignesExtra([]); setHeuresSup(0); setPrimes(0); setIndemnitesExo(0); setAvantagesNature(0);
      load(); setTab("bulletins");
    } catch (e: any) { toast.error(e.message); }
    finally { setProcessing(null); }
  };

  const handleValider = async (bid: string) => {
    setProcessing(bid);
    try {
      await valFn({ data: { bulletin_id: bid } });
      toast.success("Bulletin validé + écritures PCM créées");
      load();
    } catch (e: any) { toast.error(e.message); }
    finally { setProcessing(null); }
  };

  // Export état des salaires
  const exportEtat = (mois: string) => {
    const bs = bulletins.filter(b => b.periode === mois);
    const rows = [
      [`ÉTAT DES SALAIRES — ${mois}`],
      [""],
      ["Matricule", "Nom", "Prénom", "Salaire base", "Net à payer", "CNSS sal.", "AMO sal.", "IR", "Coût employeur"],
      ...bs.map(b => {
        const emp = employes.find(e => e.id === b.employe_id);
        return [emp?.matricule ?? "", emp?.nom ?? "", emp?.prenom ?? "", fmt(b.salaire_base), fmt(b.net_a_payer), fmt(b.cnss_salarie), fmt(b.amo_salarie), fmt(b.ir_net), fmt(b.cout_employeur)];
      }),
      ["", "", "TOTAL", fmt(bs.reduce((s,b)=>s+Number(b.salaire_base),0)), fmt(bs.reduce((s,b)=>s+Number(b.net_a_payer),0)), fmt(bs.reduce((s,b)=>s+Number(b.cnss_salarie),0)), fmt(bs.reduce((s,b)=>s+Number(b.amo_salarie),0)), fmt(bs.reduce((s,b)=>s+Number(b.ir_net),0)), fmt(bs.reduce((s,b)=>s+Number(b.cout_employeur),0))],
    ];
    const csv = rows.map(r => r.join(";")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `etat_salaires_${mois}.csv`; a.click();
  };

  const moisBulletins = [...new Set(bulletins.map(b => b.periode))].sort().reverse();
  const [moisEtat, setMoisEtat] = useState(moisBulletins[0] ?? "");

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">Paie & Ressources Humaines</h1>
          <p className="text-muted-foreground mt-1">Bulletins de paie · CNSS/AMO · IR salarial · Barème 2024</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setOpenBulletin(true)}>
            <FileText className="h-4 w-4 mr-2" />Nouveau bulletin
          </Button>
          <Button onClick={() => { setEditEmp(null); setFormEmp({ matricule:"",nom:"",prenom:"",cin:"",date_naissance:"",date_embauche:new Date().toISOString().slice(0,10),type_contrat:"cdi",poste:"",departement:"",salaire_base:0,situation_familiale:"celibataire",nombre_enfants:0,cnss_assujetti:true,amo_assujetti:true,cimr_taux:0,rib:"",email:"",telephone:"" }); setOpenEmp(true); }}>
            <Plus className="h-4 w-4 mr-2" />Employé
          </Button>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {[
          { label: "Employés actifs", value: String(employes.filter(e => e.actif).length), color: "text-blue-600" },
          { label: "Masse salariale brute", value: fmtMAD(employes.filter(e=>e.actif).reduce((s,e)=>s+Number(e.salaire_base),0)), color: "text-green-600" },
          { label: "Bulletins ce mois", value: String(bulletins.filter(b=>b.periode===new Date().toISOString().slice(0,7)).length), color: "text-purple-600" },
          { label: "En attente validation", value: String(bulletins.filter(b=>b.statut==="brouillon").length), color: "text-orange-600" },
        ].map(k => (
          <Card key={k.label}><CardContent className="pt-4 pb-4">
            <p className="text-xs text-muted-foreground">{k.label}</p>
            <p className={`text-xl font-bold mt-1 ${k.color}`}>{k.value}</p>
          </CardContent></Card>
        ))}
      </div>

      <Tabs value={tab} onValueChange={v => setTab(v as any)}>
        <TabsList>
          <TabsTrigger value="employes">Employés ({employes.length})</TabsTrigger>
          <TabsTrigger value="bulletins">Bulletins ({bulletins.length})</TabsTrigger>
          <TabsTrigger value="etat">État des salaires</TabsTrigger>
        </TabsList>

        {/* ── EMPLOYÉS ── */}
        <TabsContent value="employes" className="mt-4">
          <Card><CardContent className="p-0">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Matricule</TableHead><TableHead>Nom</TableHead><TableHead>Poste</TableHead>
                <TableHead>Contrat</TableHead><TableHead className="text-right">Salaire base</TableHead>
                <TableHead>Situation</TableHead><TableHead>Statut</TableHead><TableHead></TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {loading ? <TableRow><TableCell colSpan={8} className="text-center py-8"><Loader2 className="h-5 w-5 animate-spin mx-auto" /></TableCell></TableRow>
                  : employes.length === 0 ? <TableRow><TableCell colSpan={8} className="text-center py-10 text-muted-foreground"><Users className="h-8 w-8 mx-auto mb-2 opacity-30" />Aucun employé</TableCell></TableRow>
                  : employes.map(e => (
                    <TableRow key={e.id}>
                      <TableCell className="font-mono text-xs">{e.matricule ?? "—"}</TableCell>
                      <TableCell className="font-medium">{e.prenom} {e.nom}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{e.poste ?? "—"}</TableCell>
                      <TableCell><Badge variant="outline" className="text-xs">{TYPE_CONTRAT_LABEL[e.type_contrat]}</Badge></TableCell>
                      <TableCell className="text-right font-mono text-sm">{fmtMAD(Number(e.salaire_base))}</TableCell>
                      <TableCell className="text-xs">{e.situation_familiale} {e.nombre_enfants > 0 ? `(${e.nombre_enfants} enf.)` : ""}</TableCell>
                      <TableCell><Badge variant={e.actif ? "default" : "secondary"} className="text-xs">{e.actif ? "Actif" : "Inactif"}</Badge></TableCell>
                      <TableCell>
                        <Button size="sm" variant="ghost" onClick={() => {
                          setEditEmp(e);
                          setFormEmp({ matricule: e.matricule??""  , nom: e.nom, prenom: e.prenom, cin:"", date_naissance:"", date_embauche:"", type_contrat: e.type_contrat, poste: e.poste??"", departement:"", salaire_base: Number(e.salaire_base), situation_familiale: e.situation_familiale, nombre_enfants: e.nombre_enfants, cnss_assujetti: e.cnss_assujetti, amo_assujetti: e.amo_assujetti, cimr_taux: Number(e.cimr_taux), rib:"", email:"", telephone:"" });
                          setOpenEmp(true);
                        }}>Modifier</Button>
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </CardContent></Card>
        </TabsContent>

        {/* ── BULLETINS ── */}
        <TabsContent value="bulletins" className="mt-4">
          <Card><CardContent className="p-0">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Période</TableHead><TableHead>Employé</TableHead>
                <TableHead className="text-right">Salaire base</TableHead>
                <TableHead className="text-right">Net à payer</TableHead>
                <TableHead className="text-right">Coût employeur</TableHead>
                <TableHead>Statut</TableHead><TableHead>Actions</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {bulletins.length === 0
                  ? <TableRow><TableCell colSpan={7} className="text-center py-10 text-muted-foreground">Aucun bulletin — générez le premier bulletin</TableCell></TableRow>
                  : bulletins.map(b => {
                    const emp = employes.find(e => e.id === b.employe_id);
                    return (
                      <TableRow key={b.id}>
                        <TableCell className="font-mono text-sm">{b.periode}</TableCell>
                        <TableCell className="font-medium">{emp?.prenom} {emp?.nom}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{fmtMAD(Number(b.salaire_base))}</TableCell>
                        <TableCell className="text-right font-mono text-sm font-bold text-green-600">{fmtMAD(Number(b.net_a_payer))}</TableCell>
                        <TableCell className="text-right font-mono text-sm text-orange-600">{fmtMAD(Number(b.cout_employeur))}</TableCell>
                        <TableCell>
                          <Badge variant={b.statut === "valide" ? "default" : b.statut === "paye" ? "default" : "secondary"} className="text-xs">
                            {b.statut === "valide" ? "✅ Validé" : b.statut === "paye" ? "💰 Payé" : "Brouillon"}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            <Button size="sm" variant="ghost" onClick={() => setViewBulletin(b)}>Détail</Button>
                            {b.statut === "brouillon" && (
                              <Button size="sm" variant="outline" disabled={processing === b.id} onClick={() => handleValider(b.id)}>
                                {processing === b.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle className="h-3 w-3 mr-1" />}Valider
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
              </TableBody>
            </Table>
          </CardContent></Card>
        </TabsContent>

        {/* ── ÉTAT DES SALAIRES ── */}
        <TabsContent value="etat" className="mt-4">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold">État des salaires mensuel</h2>
            <div className="flex gap-2">
              <Select value={moisEtat} onValueChange={setMoisEtat}>
                <SelectTrigger className="w-36"><SelectValue placeholder="Choisir mois" /></SelectTrigger>
                <SelectContent>{moisBulletins.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent>
              </Select>
              <Button size="sm" variant="outline" onClick={() => exportEtat(moisEtat)} disabled={!moisEtat}>
                <Download className="h-4 w-4 mr-2" />Exporter CSV
              </Button>
            </div>
          </div>
          {moisEtat && (
            <Card><CardContent className="p-0">
              <Table>
                <TableHeader><TableRow>
                  <TableHead>Employé</TableHead>
                  <TableHead className="text-right">Base</TableHead>
                  <TableHead className="text-right">CNSS sal.</TableHead>
                  <TableHead className="text-right">AMO sal.</TableHead>
                  <TableHead className="text-right">IR</TableHead>
                  <TableHead className="text-right">Net à payer</TableHead>
                  <TableHead className="text-right">Coût emp.</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {bulletins.filter(b => b.periode === moisEtat).map(b => {
                    const emp = employes.find(e => e.id === b.employe_id);
                    return (
                      <TableRow key={b.id}>
                        <TableCell className="font-medium">{emp?.prenom} {emp?.nom}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{fmt(Number(b.salaire_base))}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{fmt(Number(b.cnss_salarie))}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{fmt(Number(b.amo_salarie))}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{fmt(Number(b.ir_net))}</TableCell>
                        <TableCell className="text-right font-mono text-sm font-bold text-green-600">{fmt(Number(b.net_a_payer))}</TableCell>
                        <TableCell className="text-right font-mono text-sm text-orange-600">{fmt(Number(b.cout_employeur))}</TableCell>
                      </TableRow>
                    );
                  })}
                  {/* Totaux */}
                  {(() => {
                    const bs = bulletins.filter(b => b.periode === moisEtat);
                    return bs.length > 0 ? (
                      <TableRow className="font-bold bg-muted/50">
                        <TableCell>TOTAL</TableCell>
                        <TableCell className="text-right font-mono">{fmt(bs.reduce((s,b)=>s+Number(b.salaire_base),0))}</TableCell>
                        <TableCell className="text-right font-mono">{fmt(bs.reduce((s,b)=>s+Number(b.cnss_salarie),0))}</TableCell>
                        <TableCell className="text-right font-mono">{fmt(bs.reduce((s,b)=>s+Number(b.amo_salarie),0))}</TableCell>
                        <TableCell className="text-right font-mono">{fmt(bs.reduce((s,b)=>s+Number(b.ir_net),0))}</TableCell>
                        <TableCell className="text-right font-mono text-green-600">{fmt(bs.reduce((s,b)=>s+Number(b.net_a_payer),0))}</TableCell>
                        <TableCell className="text-right font-mono text-orange-600">{fmt(bs.reduce((s,b)=>s+Number(b.cout_employeur),0))}</TableCell>
                      </TableRow>
                    ) : null;
                  })()}
                </TableBody>
              </Table>
            </CardContent></Card>
          )}
        </TabsContent>
      </Tabs>

      {/* ── Modal employé ── */}
      <Dialog open={openEmp} onOpenChange={setOpenEmp}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{editEmp ? "Modifier employé" : "Nouvel employé"}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-2"><Label>Matricule</Label><Input value={formEmp.matricule} onChange={e => setFormEmp({...formEmp, matricule: e.target.value})} placeholder="EMP-001" /></div>
              <div className="space-y-2"><Label>Prénom *</Label><Input required value={formEmp.prenom} onChange={e => setFormEmp({...formEmp, prenom: e.target.value})} /></div>
              <div className="space-y-2"><Label>Nom *</Label><Input required value={formEmp.nom} onChange={e => setFormEmp({...formEmp, nom: e.target.value})} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Type de contrat</Label>
                <Select value={formEmp.type_contrat} onValueChange={v => setFormEmp({...formEmp, type_contrat: v})}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{Object.entries(TYPE_CONTRAT_LABEL).map(([k,v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-2"><Label>Poste</Label><Input value={formEmp.poste} onChange={e => setFormEmp({...formEmp, poste: e.target.value})} /></div>
              <div className="space-y-2"><Label>Date d'embauche</Label><Input type="date" value={formEmp.date_embauche} onChange={e => setFormEmp({...formEmp, date_embauche: e.target.value})} /></div>
              <div className="space-y-2"><Label>Salaire de base (MAD) *</Label><Input type="number" value={formEmp.salaire_base} onChange={e => setFormEmp({...formEmp, salaire_base: parseFloat(e.target.value)||0})} /></div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-2">
                <Label>Situation familiale</Label>
                <Select value={formEmp.situation_familiale} onValueChange={v => setFormEmp({...formEmp, situation_familiale: v})}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="celibataire">Célibataire</SelectItem>
                    <SelectItem value="marie">Marié(e)</SelectItem>
                    <SelectItem value="divorce">Divorcé(e)</SelectItem>
                    <SelectItem value="veuf">Veuf/Veuve</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2"><Label>Nb enfants</Label><Input type="number" min="0" max="6" value={formEmp.nombre_enfants} onChange={e => setFormEmp({...formEmp, nombre_enfants: parseInt(e.target.value)||0})} /></div>
              <div className="space-y-2"><Label>CIMR taux (%)</Label><Input type="number" min="0" max="10" step="0.5" value={formEmp.cimr_taux} onChange={e => setFormEmp({...formEmp, cimr_taux: parseFloat(e.target.value)||0})} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2"><Label>Email</Label><Input type="email" value={formEmp.email} onChange={e => setFormEmp({...formEmp, email: e.target.value})} /></div>
              <div className="space-y-2"><Label>RIB</Label><Input value={formEmp.rib} onChange={e => setFormEmp({...formEmp, rib: e.target.value})} /></div>
            </div>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={formEmp.cnss_assujetti} onChange={e => setFormEmp({...formEmp, cnss_assujetti: e.target.checked})} />
                Assujetti CNSS
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={formEmp.amo_assujetti} onChange={e => setFormEmp({...formEmp, amo_assujetti: e.target.checked})} />
                Assujetti AMO
              </label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenEmp(false)}>Annuler</Button>
            <Button onClick={handleSaveEmp}>{editEmp ? "Sauvegarder" : "Créer"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Modal bulletin ── */}
      <Dialog open={openBulletin} onOpenChange={setOpenBulletin}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Générer un bulletin de paie</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Employé *</Label>
                <Select value={selectedEmpId} onValueChange={setSelectedEmpId}>
                  <SelectTrigger><SelectValue placeholder="Sélectionner…" /></SelectTrigger>
                  <SelectContent>{employes.filter(e=>e.actif).map(e => <SelectItem key={e.id} value={e.id}>{e.prenom} {e.nom}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-2"><Label>Période</Label><Input type="month" value={periode} onChange={e => setPeriode(e.target.value)} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2"><Label>Heures supplémentaires</Label><Input type="number" min="0" value={heuresSup} onChange={e => setHeuresSup(parseFloat(e.target.value)||0)} /></div>
              <div className="space-y-2"><Label>Primes imposables (MAD)</Label><Input type="number" min="0" value={primes} onChange={e => setPrimes(parseFloat(e.target.value)||0)} /></div>
              <div className="space-y-2"><Label>Indemnités exonérées (MAD)</Label><Input type="number" min="0" value={indemnitesExo} onChange={e => setIndemnitesExo(parseFloat(e.target.value)||0)} placeholder="Transport, panier…" /></div>
              <div className="space-y-2"><Label>Avantages en nature (MAD)</Label><Input type="number" min="0" value={avantagesNature} onChange={e => setAvantagesNature(parseFloat(e.target.value)||0)} /></div>
            </div>

            {/* Lignes extra */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <Label>Lignes supplémentaires</Label>
                <Button type="button" variant="outline" size="sm" onClick={() => setLignesExtra(ls => [...ls, { type: "prime", libelle: "", montant: 0, imposable: true }])}>
                  <Plus className="h-3 w-3 mr-1" />Ligne
                </Button>
              </div>
              {lignesExtra.map((l, i) => (
                <div key={i} className="grid grid-cols-12 gap-2 items-center mb-2">
                  <Select value={l.type} onValueChange={v => setLignesExtra(ls => ls.map((x,j) => j===i ? {...x, type: v as any} : x))}>
                    <SelectTrigger className="col-span-3"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="prime">Prime</SelectItem>
                      <SelectItem value="retenue">Retenue</SelectItem>
                      <SelectItem value="indemnite">Indemnité</SelectItem>
                      <SelectItem value="avantage">Avantage</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input className="col-span-5" placeholder="Libellé" value={l.libelle} onChange={e => setLignesExtra(ls => ls.map((x,j) => j===i ? {...x, libelle: e.target.value} : x))} />
                  <Input className="col-span-2" type="number" placeholder="Montant" value={l.montant} onChange={e => setLignesExtra(ls => ls.map((x,j) => j===i ? {...x, montant: parseFloat(e.target.value)||0} : x))} />
                  <Button type="button" variant="ghost" size="icon" className="col-span-1" onClick={() => setLignesExtra(ls => ls.filter((_,j) => j!==i))}><X className="h-4 w-4" /></Button>
                </div>
              ))}
            </div>

            {/* Simulation */}
            {simulation && (
              <div className="p-4 bg-blue-50 dark:bg-blue-950/20 rounded-xl border border-blue-200 dark:border-blue-800">
                <p className="text-xs font-bold text-blue-700 dark:text-blue-300 mb-3 flex items-center gap-2"><Calculator className="h-4 w-4" />Simulation en temps réel</p>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  {[
                    ["Brut global", fmtMAD(simulation.brut)],
                    ["CNSS salarial (4.48%)", fmtMAD(simulation.cnss)],
                    ["AMO salariale (2.26%)", fmtMAD(simulation.amo)],
                    ["IR net", fmtMAD(simulation.irNet)],
                    ["Total retenues", fmtMAD(simulation.retenues)],
                  ].map(([l, v]) => (
                    <div key={l} className="flex justify-between text-xs">
                      <span className="text-muted-foreground">{l}</span>
                      <span className="font-mono">{v}</span>
                    </div>
                  ))}
                </div>
                <div className="flex justify-between font-bold mt-3 pt-3 border-t border-blue-200">
                  <span className="text-green-700">NET À PAYER</span>
                  <span className="font-mono text-green-700 text-lg">{fmtMAD(simulation.net)}</span>
                </div>
                <div className="flex justify-between text-xs mt-1 text-orange-600">
                  <span>Coût employeur total</span>
                  <span className="font-mono">{fmtMAD(simulation.cout)}</span>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenBulletin(false)}>Annuler</Button>
            <Button onClick={handleGenBulletin} disabled={processing === "gen"}>
              {processing === "gen" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <FileText className="h-4 w-4 mr-2" />}
              Générer le bulletin
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Modal détail bulletin ── */}
      <Dialog open={!!viewBulletin} onOpenChange={() => setViewBulletin(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Bulletin de paie — {employes.find(e=>e.id===viewBulletin?.employe_id)?.prenom} {employes.find(e=>e.id===viewBulletin?.employe_id)?.nom} — {viewBulletin?.periode}</DialogTitle>
          </DialogHeader>
          {viewBulletin && (
            <div className="space-y-3 text-sm">
              <div className="p-3 bg-muted rounded-lg space-y-1">
                <p className="font-bold text-xs uppercase text-muted-foreground mb-2">Rémunération brute</p>
                {[
                  ["Salaire de base", fmtMAD(Number(viewBulletin.salaire_base))],
                  ["Total brut", fmtMAD(Number(viewBulletin.salaire_base))],
                ].map(([l,v]) => <div key={l} className="flex justify-between"><span className="text-muted-foreground">{l}</span><span className="font-mono">{v}</span></div>)}
              </div>
              <div className="p-3 bg-red-50 dark:bg-red-950/20 rounded-lg space-y-1">
                <p className="font-bold text-xs uppercase text-muted-foreground mb-2">Retenues salariales</p>
                {[
                  ["CNSS salarial (4.48%)", fmtMAD(Number(viewBulletin.cnss_salarie))],
                  ["AMO salariale (2.26%)", fmtMAD(Number(viewBulletin.amo_salarie))],
                  ["IR net", fmtMAD(Number(viewBulletin.ir_net))],
                ].map(([l,v]) => <div key={l} className="flex justify-between"><span className="text-muted-foreground">{l}</span><span className="font-mono text-red-600">{v}</span></div>)}
              </div>
              <div className="p-3 bg-green-50 dark:bg-green-950/20 rounded-lg">
                <div className="flex justify-between font-bold text-base">
                  <span>NET À PAYER</span>
                  <span className="font-mono text-green-700">{fmtMAD(Number(viewBulletin.net_a_payer))}</span>
                </div>
              </div>
              <div className="p-3 bg-orange-50 dark:bg-orange-950/20 rounded-lg space-y-1">
                <p className="font-bold text-xs uppercase text-muted-foreground mb-2">Charges patronales</p>
                {[
                  ["CNSS patronal (8.98%)", fmtMAD(Number(viewBulletin.cnss_patronal))],
                  ["AMO patronale (4.11%)", fmtMAD(Number(viewBulletin.amo_patronal))],
                  ["Coût total employeur", fmtMAD(Number(viewBulletin.cout_employeur))],
                ].map(([l,v]) => <div key={l} className="flex justify-between"><span className="text-muted-foreground">{l}</span><span className="font-mono text-orange-600">{v}</span></div>)}
              </div>
            </div>
          )}
          <DialogFooter><Button onClick={() => setViewBulletin(null)}>Fermer</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
