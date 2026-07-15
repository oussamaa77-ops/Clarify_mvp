import { createFileRoute, Link, Outlet, useMatchRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { logAudit } from "@/lib/audit";
import { useServerFn } from "@tanstack/react-start";
import { initDossierPCM } from "@/server/ocr.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { DatePicker } from "@/components/ui/date-picker";
import { Plus, Building2, ArrowRight, Loader2, Settings2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_app/dossiers")({ component: DossiersPage });

interface Dossier { id: string; nom_societe: string; ice: string | null; rc: string | null; if_fiscal: string | null; statut: string; created_at: string; date_reprise: string | null; }

function DossiersPage() {
  const initPCM = useServerFn(initDossierPCM);
  const { profile, loading: authLoading } = useAuth();
  const [dossiers, setDossiers] = useState<Dossier[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ nom_societe: "", ice: "", rc: "", if_fiscal: "", email_societe: "", adresse: "" });
  const [search, setSearch] = useState("");
  // Édition des réglages d'un dossier (dont la date de reprise comptable).
  const [editDossier, setEditDossier] = useState<Dossier | null>(null);
  const [editForm, setEditForm] = useState<{ nom_societe: string; ice: string; rc: string; if_fiscal: string; date_reprise: string | null }>({ nom_societe: "", ice: "", rc: "", if_fiscal: "", date_reprise: null });
  const [savingEdit, setSavingEdit] = useState(false);

  const load = async () => {
    setLoading(true);
    // Défense en profondeur : on borne EXPLICITEMENT la liste au cabinet de
    // l'utilisateur courant (en plus de la RLS). Ainsi, même si la RLS venait à
    // être désactivée sur la base, un compte ne voit jamais les dossiers d'un
    // autre cabinet. Sans cabinet_id → aucune donnée (jamais « tout lister »).
    if (!profile?.cabinet_id) { setDossiers([]); setLoading(false); return; }
    const { data, error } = await supabase.from("dossiers").select("*")
      .eq("cabinet_id", profile.cabinet_id)
      .order("created_at", { ascending: false });
    if (error) toast.error(error.message);
    else setDossiers(data as unknown as Dossier[]);
    setLoading(false);
  };
  // Recharge dès que le profil (donc le cabinet_id) est disponible / change.
  useEffect(() => {
    if (authLoading) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, profile?.cabinet_id]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.nom_societe) return toast.error("Nom requis");
    setCreating(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      const { data: prof } = await supabase.from("profiles").select("cabinet_id").eq("id", user!.id).single();
      if (!prof?.cabinet_id) { toast.error("Cabinet non trouvé. Reconnectez-vous."); return; }

      const { data: dossier, error } = await supabase.from("dossiers").insert({nom_societe: form.nom_societe,
      ice: form.ice || null,
      rc: form.rc || null,
      if_fiscal: form.if_fiscal || null,
      email_societe: form.email_societe || null,
      adresse: form.adresse || null,
      cabinet_id: prof.cabinet_id,
      }).select().single();

      if (error) return toast.error(error.message);

      // Auto-init PCM + journaux
      try {
        await initPCM({ data: { dossier_id: dossier.id } });
      } catch { /* non-blocking — can be done manually */ }

      toast.success("Dossier créé avec PCM initialisé ✓");
      setOpen(false);
      setForm({ nom_societe: "", ice: "", rc: "", if_fiscal: "", email_societe: "", adresse: "" });
      load();
    } finally { setCreating(false); }
  };

  const openEdit = (d: Dossier) => {
    setEditDossier(d);
    setEditForm({ nom_societe: d.nom_societe, ice: d.ice ?? "", rc: d.rc ?? "", if_fiscal: d.if_fiscal ?? "", date_reprise: d.date_reprise ?? null });
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editDossier) return;
    setSavingEdit(true);
    try {
      const { error } = await (supabase.from("dossiers") as any).update({
        nom_societe: editForm.nom_societe,
        ice: editForm.ice || null,
        rc: editForm.rc || null,
        if_fiscal: editForm.if_fiscal || null,
        date_reprise: editForm.date_reprise || null,   // MAJ réactive de la date de reprise
      }).eq("id", editDossier.id);
      if (error) { toast.error(error.message); return; }
      logAudit({ dossierId: editDossier.id, action: "modification_dossier", ressourceType: "dossier", ressourceId: editDossier.id, details: { nom_societe: editForm.nom_societe } });
      toast.success("Réglages du dossier enregistrés ✓");
      setEditDossier(null);
      load();
    } finally { setSavingEdit(false); }
  };

  const filtered = dossiers.filter(d =>
    d.nom_societe.toLowerCase().includes(search.toLowerCase()) ||
    (d.ice ?? "").includes(search)
  );

  const matchRoute = useMatchRoute();

  const isSubRoute = 
    matchRoute({ to: "/dossiers/$dossierId/dashboard", fuzzy: true }) ||
    matchRoute({ to: "/dossiers/$dossierId/factures", fuzzy: true }) ||
    matchRoute({ to: "/dossiers/$dossierId/clients", fuzzy: true }) ||
    matchRoute({ to: "/dossiers/$dossierId/fournisseurs", fuzzy: true }) ||
    matchRoute({ to: "/dossiers/$dossierId/comptabilite", fuzzy: true }) ||
    matchRoute({ to: "/dossiers/$dossierId/banque", fuzzy: true }) ||
    matchRoute({ to: "/dossiers/$dossierId/justificatifs", fuzzy: true }) ||
    matchRoute({ to: "/dossiers/$dossierId/ged", fuzzy: true }) ||
    matchRoute({ to: "/dossiers/$dossierId/audit", fuzzy: true }) ||
    matchRoute({ to: "/dossiers/$dossierId", fuzzy: true });

  if (isSubRoute) return <Outlet />;

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold">Mes dossiers</h1>
          <p className="text-muted-foreground mt-1">Sociétés clientes · PCM initialisé automatiquement</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button><Plus className="h-4 w-4 mr-2" />Nouveau dossier</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Créer un dossier société</DialogTitle></DialogHeader>
            <form onSubmit={handleCreate} className="space-y-3">
              <div className="space-y-2"><Label>Raison sociale *</Label><Input required value={form.nom_societe} onChange={e => setForm({ ...form, nom_societe: e.target.value })} /></div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2"><Label>ICE</Label><Input value={form.ice} onChange={e => setForm({ ...form, ice: e.target.value })} placeholder="15 chiffres" /></div>
                <div className="space-y-2"><Label>RC</Label><Input value={form.rc} onChange={e => setForm({ ...form, rc: e.target.value })} /></div>
                <div className="space-y-2"><Label>IF</Label><Input value={form.if_fiscal} onChange={e => setForm({ ...form, if_fiscal: e.target.value })} /></div>
                <div className="space-y-2"><Label>Email société</Label><Input type="email" value={form.email_societe} onChange={e => setForm({ ...form, email_societe: e.target.value })} /></div>
              </div>
              <div className="space-y-2"><Label>Adresse</Label><Input value={form.adresse} onChange={e => setForm({ ...form, adresse: e.target.value })} /></div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>Annuler</Button>
                <Button type="submit" disabled={creating}>
                  {creating && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Créer
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <Input className="mb-6 max-w-sm" placeholder="Rechercher (nom, ICE)…" value={search} onChange={e => setSearch(e.target.value)} />

      {loading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1,2,3].map(i => <div key={i} className="h-44 bg-muted rounded-xl animate-pulse" />)}
        </div>
      ) : !profile?.cabinet_id ? (
        <Card><CardContent className="py-16 text-center">
          <Building2 className="h-12 w-12 mx-auto text-muted-foreground mb-4 opacity-30" />
          <p className="text-muted-foreground">Cabinet non identifié pour ce compte. Reconnectez-vous.</p>
        </CardContent></Card>
      ) : filtered.length === 0 ? (
        <Card><CardContent className="py-16 text-center">
          <Building2 className="h-12 w-12 mx-auto text-muted-foreground mb-4 opacity-30" />
          <p className="text-muted-foreground">{search ? "Aucun dossier correspondant" : "Créez votre premier dossier client."}</p>
        </CardContent></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map(d => (
            <Link key={d.id} to="/dossiers/$dossierId/dashboard" params={{ dossierId: d.id }}>
              <Card className="hover:shadow-md transition cursor-pointer h-full group">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center mb-2">
                      <Building2 className="h-5 w-5 text-primary" />
                    </div>
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground"
                        title="Réglages du dossier"
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); openEdit(d); }}>
                        <Settings2 className="h-4 w-4" />
                      </Button>
                      <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:translate-x-1 transition-transform" />
                    </div>
                  </div>
                  <CardTitle className="text-lg leading-tight">{d.nom_societe}</CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground space-y-1">
                  {d.ice && <div>ICE: <span className="font-mono">{d.ice}</span></div>}
                  {d.rc && <div>RC: {d.rc}</div>}
                  {d.if_fiscal && <div>IF: {d.if_fiscal}</div>}
                  <div className="pt-2 flex items-center gap-2">
                    <Badge variant="outline" className="text-green-600 border-green-200">{d.statut}</Badge>
                    {d.date_reprise && (
                      <Badge variant="outline" className="text-sky-600 border-sky-200">
                        Reprise: {d.date_reprise.split("-").reverse().join("/")}
                      </Badge>
                    )}
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      {/* ── Réglages du dossier (dont la date de reprise comptable) ── */}
      <Dialog open={!!editDossier} onOpenChange={(o) => { if (!o) setEditDossier(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Réglages du dossier</DialogTitle></DialogHeader>
          <form onSubmit={handleSaveEdit} className="space-y-3">
            <div className="space-y-2"><Label>Raison sociale *</Label>
              <Input required value={editForm.nom_societe} onChange={e => setEditForm({ ...editForm, nom_societe: e.target.value })} /></div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-2"><Label>ICE</Label><Input value={editForm.ice} onChange={e => setEditForm({ ...editForm, ice: e.target.value })} /></div>
              <div className="space-y-2"><Label>RC</Label><Input value={editForm.rc} onChange={e => setEditForm({ ...editForm, rc: e.target.value })} /></div>
              <div className="space-y-2"><Label>IF</Label><Input value={editForm.if_fiscal} onChange={e => setEditForm({ ...editForm, if_fiscal: e.target.value })} /></div>
            </div>
            <div className="space-y-2 rounded-md border p-3 bg-muted/30">
              <Label>Date de reprise comptable</Label>
              <DatePicker value={editForm.date_reprise} onChange={(iso) => setEditForm({ ...editForm, date_reprise: iso })} />
              <p className="text-xs text-muted-foreground">
                Avant cette date = <strong>migration</strong> (rapprochement prioritaire sur les écritures du Grand Livre).
                À partir de cette date = <strong>flux courant</strong> (priorité à la facture / justificatif OCR).
              </p>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditDossier(null)}>Annuler</Button>
              <Button type="submit" disabled={savingEdit}>
                {savingEdit && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Enregistrer
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
