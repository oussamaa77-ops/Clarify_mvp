import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { DatePicker } from "@/components/ui/date-picker";
import { Loader2, Mail, Copy, AlertTriangle, Send, Users, Clock, ArrowLeft, Paperclip } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { getRelancesClient, envoyerRelance, type RelanceClient, type RelanceItem } from "@/server/relances.functions";
import { normalizeLibelle } from "@/lib/import-grandlivre";

export const Route = createFileRoute("/_app/dossiers/$dossierId/relances")({
  validateSearch: (s: Record<string, unknown>): { client?: string } =>
    ({ client: typeof s.client === "string" ? s.client : undefined }),
  component: RelancesPage,
});

type Niveau = "soft" | "normal" | "ferme";
const NIVEAUX: { key: Niveau; label: string }[] = [
  { key: "soft", label: "Soft" }, { key: "normal", label: "Normal" }, { key: "ferme", label: "Ferme" },
];
const fmt = (n: number) => Number(n).toLocaleString("fr-MA", { minimumFractionDigits: 2 }) + " MAD";
const fmtDate = (d: string | null) => d ? new Date(d).toLocaleDateString("fr-MA") : "—";
const isEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.trim());
const joursBadge = (j: number) => j > 60 ? "bg-red-100 text-red-700" : j > 30 ? "bg-orange-100 text-orange-700" : "bg-yellow-100 text-yellow-700";

// ── Génération dynamique du message selon le niveau / mode ────────────────────
function genMessage(opts: {
  client: RelanceClient; items: RelanceItem[]; niveau: Niveau; societe: string; dateLimite: string | null;
}): string {
  const { client, items, niveau, societe, dateLimite } = opts;
  const total = items.reduce((s, it) => s + it.montant, 0);
  const lignes = items
    .map((it) => `  • ${it.ref} — ${fmt(it.montant)} — échéance ${fmtDate(it.date)} (${it.jours} j de retard)`)
    .join("\n");
  const limite = dateLimite ? new Date(dateLimite).toLocaleDateString("fr-MA") : "8 jours";
  const intro: Record<Niveau, string> = {
    soft: `Nous espérons que vous allez bien. Sauf erreur de notre part, nous nous permettons de vous rappeler aimablement que le(s) montant(s) suivant(s) reste(nt) en attente de règlement :`,
    normal: `Sauf erreur ou omission de notre part, nous constatons que les factures ci-dessous demeurent impayées à ce jour. Nous vous remercions de bien vouloir procéder à leur règlement dans les meilleurs délais :`,
    ferme: `Malgré nos précédentes relances, nous constatons que votre compte présente toujours un solde impayé. Nous vous demandons de régulariser la situation sans délai afin d'éviter toute suspension de nos prestations ou procédure de recouvrement :`,
  };
  const cloture: Record<Niveau, string> = {
    soft: `Nous restons à votre disposition pour tout complément d'information et vous remercions par avance de votre règlement.`,
    normal: `Merci de nous confirmer la date de règlement prévue. Nous restons disponibles pour toute question.`,
    ferme: `À défaut de règlement avant le ${limite}, nous nous réservons le droit d'engager les démarches de recouvrement prévues.`,
  };
  return [
    `Objet : Relance — solde impayé`,
    ``,
    `Bonjour ${client.nom},`,
    ``,
    intro[niveau],
    ``,
    lignes,
    ``,
    `TOTAL DÛ : ${fmt(total)}`,
    ``,
    cloture[niveau],
    ``,
    `Cordialement,`,
    societe || "Le service comptabilité",
  ].join("\n");
}

function RelancesPage() {
  const { dossierId } = Route.useParams();
  const { client: clientParam } = Route.useSearch();

  const [loading, setLoading] = useState(true);
  const [clients, setClients] = useState<RelanceClient[]>([]);
  const [societe, setSociete] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const [niveau, setNiveau] = useState<Niveau>("normal");
  const [mode, setMode] = useState<"groupe" | "unique">("groupe");
  const [uniqueRef, setUniqueRef] = useState<string>("");
  const [dateLimite, setDateLimite] = useState<string | null>(null);
  const [emailManuel, setEmailManuel] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  // Chargement des impayés + nom société.
  useEffect(() => {
    (async () => {
      setLoading(true);
      const [res, dos] = await Promise.all([
        getRelancesClient({ data: { dossierId } }),
        supabase.from("dossiers").select("nom_societe").eq("id", dossierId).maybeSingle(),
      ]);
      const list = ((res as any).clients ?? []) as RelanceClient[];
      setClients(list);
      setSociete((dos.data as any)?.nom_societe ?? "");
      setLoading(false);
    })();
  }, [dossierId]);

  // Pré-sélection depuis ?client= (nom affiché depuis le dashboard) ou 1er client.
  useEffect(() => {
    if (!clients.length) { setSelectedKey(null); return; }
    if (clientParam) {
      const norm = normalizeLibelle(clientParam);
      const hit = clients.find((c) => c.key === norm || c.nom.toLowerCase() === clientParam.toLowerCase());
      if (hit) { setSelectedKey(hit.key); return; }
    }
    setSelectedKey((prev) => prev && clients.some((c) => c.key === prev) ? prev : clients[0].key);
  }, [clients, clientParam]);

  const selected = useMemo(() => clients.find((c) => c.key === selectedKey) ?? null, [clients, selectedKey]);

  // Items concernés selon le mode (groupé = tous ; unique = 1 pièce).
  const itemsCibles = useMemo<RelanceItem[]>(() => {
    if (!selected) return [];
    if (mode === "unique") { const it = selected.items.find((i) => i.ref === uniqueRef); return it ? [it] : []; }
    return selected.items;
  }, [selected, mode, uniqueRef]);

  // (Re)génère le message quand le contexte change (l'utilisateur peut ensuite l'éditer).
  useEffect(() => {
    if (!selected) { setMessage(""); return; }
    setMessage(genMessage({ client: selected, items: itemsCibles, niveau, societe, dateLimite }));
  }, [selected, itemsCibles, niveau, societe, dateLimite]);

  // Reset du mode/ref à chaque changement de client.
  useEffect(() => { setMode("groupe"); setUniqueRef(""); setEmailManuel(""); }, [selectedKey]);

  const emailCible = (selected?.email ?? "").trim() || emailManuel.trim();
  const emailValide = isEmail(emailCible);

  const copier = async () => {
    try { await navigator.clipboard.writeText(message); toast.success("Message copié — collez-le sur WhatsApp / e-mail"); }
    catch { toast.error("Copie impossible"); }
  };

  // Factures (en périmètre) dont on possède le fichier original → pièces jointes.
  const facturesAJoindre = useMemo(
    () => itemsCibles
      .filter((it) => it.source === "facture" && !!it.fichierUrl)
      .map((it) => ({ url: it.fichierUrl as string, nom: it.fichierNom ?? `Facture_${it.ref}.pdf`, type: it.fichierType ?? undefined })),
    [itemsCibles],
  );

  const envoyer = async () => {
    if (!selected) return;
    if (!emailValide) { toast.error("Adresse e-mail invalide"); return; }
    setSending(true);
    try {
      const html = `<div style="font-family:Arial,sans-serif;white-space:pre-wrap;line-height:1.5">${message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>`;
      // On fournit aussi la version texte brute (le message est déjà en clair) →
      // e-mail multipart/alternative, meilleur pour ne pas tomber en spam.
      // Le contrôleur récupère les factures originales côté serveur et les joint.
      const res = await envoyerRelance({
        data: {
          to: emailCible, toName: selected.nom,
          subject: `Relance — solde impayé (${societe || "Comptabilité"})`,
          html, text: message, factures: facturesAJoindre,
        },
      });
      const nbJointes = (res as any)?.jointes?.length ?? 0;
      const nbIgnorees = (res as any)?.ignorees?.length ?? 0;
      toast.success(
        `E-mail de relance envoyé à ${emailCible}` +
        (nbJointes ? ` — ${nbJointes} facture(s) jointe(s)` : "") +
        (nbIgnorees ? ` (${nbIgnorees} pièce(s) non jointe(s))` : "")
      );
    } catch (e: any) {
      toast.error("Échec de l'envoi : " + (e?.message ?? e));
    } finally { setSending(false); }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Mail className="h-6 w-6" />Relances clients</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Recouvrement — factures OCR en retard + créances migrées (Grand Livre 342x)</p>
        </div>
        <Link to="/dossiers/$dossierId/dashboard" params={{ dossierId }} className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1">
          <ArrowLeft className="h-4 w-4" />Tableau de bord
        </Link>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : clients.length === 0 ? (
        <Card><CardContent className="py-16 text-center text-muted-foreground">
          🎉 Aucun impayé client en cours. Rien à relancer.
        </CardContent></Card>
      ) : (
        <div className="grid md:grid-cols-[280px_1fr] gap-4">
          {/* ── Liste des clients en retard ── */}
          <Card className="h-fit">
            <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Users className="h-4 w-4" />Clients à relancer ({clients.length})</CardTitle></CardHeader>
            <CardContent className="p-2 space-y-1 max-h-[70vh] overflow-y-auto">
              {clients.map((c) => (
                <button key={c.key} onClick={() => setSelectedKey(c.key)}
                  className={`w-full text-left rounded-md px-3 py-2 transition-colors ${selectedKey === c.key ? "bg-primary/10 ring-1 ring-primary" : "hover:bg-muted"}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-sm truncate">{c.nom}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${joursBadge(c.maxJours)}`}>{c.maxJours} j</span>
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground mt-0.5">
                    <span>{c.items.length} pièce{c.items.length > 1 ? "s" : ""}</span>
                    <span className="font-semibold text-red-600">{fmt(c.total)}</span>
                  </div>
                  {!c.email && <span className="text-[10px] text-amber-600">⚠ sans e-mail</span>}
                </button>
              ))}
            </CardContent>
          </Card>

          {/* ── Détail + rédaction ── */}
          {selected && (
            <div className="space-y-4">
              {/* Bloc client + e-mail */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center justify-between">
                    <span>{selected.nom}</span>
                    <Badge variant="destructive" className="flex items-center gap-1"><Clock className="h-3 w-3" />jusqu'à {selected.maxJours} j</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {selected.email ? (
                    <div className="text-sm flex items-center gap-2">
                      <Mail className="h-4 w-4 text-muted-foreground" />
                      <span className="text-muted-foreground">E-mail (fiche Tiers) :</span>
                      <span className="font-medium">{selected.email}</span>
                    </div>
                  ) : (
                    <div className="rounded-md border border-amber-300 bg-amber-50 p-3 space-y-2">
                      <div className="flex items-center gap-2 text-sm text-amber-800 font-medium">
                        <AlertTriangle className="h-4 w-4" />Aucun e-mail enregistré pour ce client
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Saisir une adresse e-mail (obligatoire pour envoyer)</Label>
                        <Input type="email" placeholder="client@exemple.ma" value={emailManuel}
                          onChange={(e) => setEmailManuel(e.target.value)}
                          className={emailManuel && !isEmail(emailManuel) ? "border-red-400" : ""} />
                        {emailManuel && !isEmail(emailManuel) && <p className="text-[11px] text-red-600">Adresse e-mail invalide.</p>}
                      </div>
                    </div>
                  )}

                  {/* Tableau des impayés */}
                  <div className="border rounded-lg overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-muted">
                        <tr className="text-left">
                          {["Réf.", "Source", "Échéance", "Retard", "Montant dû"].map((h) => (
                            <th key={h} className="px-2 py-1.5 font-medium whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {selected.items.map((it, i) => (
                          <tr key={i} className="border-t">
                            <td className="px-2 py-1 whitespace-nowrap">{it.ref}</td>
                            <td className="px-2 py-1">
                              {it.source === "facture"
                                ? <Badge variant="outline" className="text-emerald-700 border-emerald-200 text-[10px]">Facture OCR</Badge>
                                : <Badge variant="outline" className="text-sky-700 border-sky-200 text-[10px]">GL 342x (migration)</Badge>}
                            </td>
                            <td className="px-2 py-1 whitespace-nowrap">{fmtDate(it.date)}</td>
                            <td className="px-2 py-1"><span className={`px-1.5 py-0.5 rounded text-xs ${joursBadge(it.jours)}`}>{it.jours} j</span></td>
                            <td className="px-2 py-1 text-right font-mono whitespace-nowrap">{fmt(it.montant)}</td>
                          </tr>
                        ))}
                        <tr className="border-t bg-muted/40 font-semibold">
                          <td className="px-2 py-1.5" colSpan={4}>TOTAL DÛ</td>
                          <td className="px-2 py-1.5 text-right font-mono text-red-600">{fmt(selected.total)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>

              {/* Bloc rédaction */}
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm">Message de relance</CardTitle></CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex flex-wrap items-end gap-4">
                    {/* Mode */}
                    <div className="space-y-1">
                      <Label className="text-xs">Portée</Label>
                      <div className="flex rounded-md border overflow-hidden w-fit">
                        <button onClick={() => setMode("groupe")} className={`px-3 py-1.5 text-xs ${mode === "groupe" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}>Mail groupé (recommandé)</button>
                        <button onClick={() => { setMode("unique"); setUniqueRef(selected.items[0]?.ref ?? ""); }} className={`px-3 py-1.5 text-xs border-l ${mode === "unique" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}>Facture unique</button>
                      </div>
                    </div>
                    {mode === "unique" && (
                      <div className="space-y-1">
                        <Label className="text-xs">Pièce</Label>
                        <select value={uniqueRef} onChange={(e) => setUniqueRef(e.target.value)} className="h-8 text-sm border rounded-md px-2">
                          {selected.items.map((it) => <option key={it.ref} value={it.ref}>{it.ref} — {fmt(it.montant)}</option>)}
                        </select>
                      </div>
                    )}
                    {/* Niveau */}
                    <div className="space-y-1">
                      <Label className="text-xs">Ton</Label>
                      <div className="flex rounded-md border overflow-hidden w-fit">
                        {NIVEAUX.map((n) => (
                          <button key={n.key} onClick={() => setNiveau(n.key)} className={`px-3 py-1.5 text-xs ${niveau === n.key ? "bg-primary text-primary-foreground" : "hover:bg-muted"} ${n.key !== "soft" ? "border-l" : ""}`}>{n.label}</button>
                        ))}
                      </div>
                    </div>
                    {/* Date limite (DatePicker autonome) */}
                    <div className="space-y-1">
                      <Label className="text-xs">Date limite de règlement</Label>
                      <div className="w-44"><DatePicker value={dateLimite} onChange={setDateLimite} placeholder="JJ/MM/AAAA" /></div>
                    </div>
                  </div>

                  <Textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={14} className="font-mono text-xs" />

                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground flex items-center gap-2">
                      {mode === "groupe" ? `${selected.items.length} pièce(s) récapitulée(s)` : `Pièce ${uniqueRef}`}
                      {facturesAJoindre.length > 0 && (
                        <span className="inline-flex items-center gap-1 text-emerald-700">
                          <Paperclip className="h-3 w-3" />{facturesAJoindre.length} facture(s) jointe(s)
                        </span>
                      )}
                    </span>
                    <div className="flex gap-2">
                      <Button variant="outline" onClick={copier}><Copy className="h-4 w-4 mr-2" />Copier le message</Button>
                      <Button onClick={envoyer} disabled={sending || !emailValide} title={!emailValide ? "E-mail requis" : ""}>
                        {sending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
                        Envoyer par Email
                      </Button>
                    </div>
                  </div>
                  {!emailValide && <p className="text-[11px] text-amber-600 text-right">Renseignez une adresse e-mail valide pour activer l'envoi.</p>}
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
