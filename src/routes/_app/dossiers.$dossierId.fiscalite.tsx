import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Download, Calculator, Calendar, AlertCircle, CheckCircle, Clock } from "lucide-react";

export const Route = createFileRoute("/_app/dossiers/$dossierId/fiscalite")({ component: FiscalitePage });

const fmt = (n: number) => Number(n).toLocaleString("fr-MA", { minimumFractionDigits: 2 });
const fmtMAD = (n: number) => fmt(n) + " MAD";

const BAREME_IS = [
  { max: 300000,   taux: 0.20, label: "≤ 300 000 MAD" },
  { max: 1000000,  taux: 0.26, label: "300 001 – 1 000 000 MAD" },
  { max: Infinity, taux: 0.31, label: "> 1 000 000 MAD" },
];

function FiscalitePage() {
  const { dossierId } = Route.useParams();
  const [ecritures, setEcritures] = useState<any[]>([]);
  const [tab, setTab] = useState("tva");
  const [periodeTVA, setPeriodeTVA] = useState("all");
  const [exercice, setExercice] = useState(new Date().getFullYear().toString());

  useEffect(() => {
    supabase.from("ecritures_comptables").select("*").eq("dossier_id", dossierId)
      .then(({ data }) => setEcritures(data ?? []));
  }, [dossierId]);

  // ── Calculs TVA ──────────────────────────────────────────────────────────────
  const filtered = periodeTVA !== "all"
    ? ecritures.filter(e => e.date_ecriture?.startsWith(periodeTVA))
    : ecritures.filter(e => e.date_ecriture?.startsWith(exercice));

  const collectee = filtered.filter(e => e.compte_numero === "44551").reduce((s, e) => s + Number(e.credit) - Number(e.debit), 0);
  const recuperable = filtered.filter(e => e.compte_numero === "34552").reduce((s, e) => s + Number(e.debit) - Number(e.credit), 0);
  const nette = collectee - recuperable;

  // TVA par mois
  const moisDisponibles = [...new Set(ecritures.map(e => e.date_ecriture?.slice(0, 7)).filter(Boolean))].sort().reverse() as string[];
  const tvaMensuelle = moisDisponibles.map(m => {
    const me = ecritures.filter(e => e.date_ecriture?.startsWith(m));
    const c = me.filter(e => e.compte_numero === "44551").reduce((s, e) => s + Number(e.credit) - Number(e.debit), 0);
    const r = me.filter(e => e.compte_numero === "34552").reduce((s, e) => s + Number(e.debit) - Number(e.credit), 0);
    return { mois: m, collectee: c, recuperable: r, nette: c - r };
  });

  // ── Calculs IS ───────────────────────────────────────────────────────────────
  const produits = ecritures.filter(e => e.compte_numero?.startsWith("7") && e.date_ecriture?.startsWith(exercice)).reduce((s, e) => s + Number(e.credit) - Number(e.debit), 0);
  const charges = ecritures.filter(e => e.compte_numero?.startsWith("6") && e.date_ecriture?.startsWith(exercice)).reduce((s, e) => s + Number(e.debit) - Number(e.credit), 0);
  const resultat = produits - charges;
  const ca = produits;

  const tranche = BAREME_IS.find(t => Math.max(0, resultat) <= t.max) ?? BAREME_IS[BAREME_IS.length - 1];
  const isTheorique = Math.max(0, resultat) * tranche.taux;
  const cotisationMin = ca * 0.005;
  const isPaye = Math.max(isTheorique, cotisationMin);
  const acompte = isPaye / 4;

  // ── Export TVA ───────────────────────────────────────────────────────────────
  const exportTVA = () => {
    const rows = [
      ["DÉCLARATION TVA — " + (periodeTVA || exercice)],
      [""],
      ["Rubrique", "Montant MAD"],
      ["TVA collectée (44551)", fmt(collectee)],
      ["TVA récupérable (34552)", fmt(recuperable)],
      ["TVA nette " + (nette >= 0 ? "à payer" : "crédit"), fmt(Math.abs(nette))],
    ];
    const csv = rows.map(r => r.join(";")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = `tva_${dossierId}_${periodeTVA || exercice}.csv`; a.click();
  };

  // ── Calendrier échéances ─────────────────────────────────────────────────────
  const now = new Date();
  const echeances = [
    { date: `${exercice}-01-31`, label: "Taxe Professionnelle — déclaration", type: "tp", statut: "info" },
    { date: `${exercice}-03-31`, label: "DAS — Déclaration Annuelle des Salaires", type: "das", statut: "warning" },
    { date: `${exercice}-03-31`, label: "Liasse fiscale (clôture 31/12 N-1)", type: "liasse", statut: "danger" },
    { date: `${exercice}-04-30`, label: "1er acompte IS", type: "is", statut: "danger" },
    { date: `${exercice}-07-31`, label: "2ème acompte IS", type: "is", statut: "danger" },
    { date: `${exercice}-10-31`, label: "3ème acompte IS", type: "is", statut: "danger" },
    { date: `${exercice}-12-31`, label: "4ème acompte IS", type: "is", statut: "danger" },
  ].map(e => {
    const d = new Date(e.date);
    const jours = Math.ceil((d.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    return { ...e, jours, passe: jours < 0 };
  }).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">Fiscalité</h1>
          <p className="text-muted-foreground mt-1">TVA · IS · Taxe Professionnelle · Calendrier fiscal</p>
        </div>
        <Select value={exercice} onValueChange={setExercice}>
          <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            {[2024, 2025, 2026].map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="tva">TVA</TabsTrigger>
          <TabsTrigger value="is">IS</TabsTrigger>
          <TabsTrigger value="calendrier">Calendrier fiscal</TabsTrigger>
          <TabsTrigger value="tp">Taxe Professionnelle</TabsTrigger>
        </TabsList>

        {/* ── TVA ── */}
        <TabsContent value="tva" className="mt-4 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Déclaration TVA — {exercice}</h2>
            <div className="flex gap-2">
              <Select value={periodeTVA} onValueChange={setPeriodeTVA}>
  <SelectTrigger className="w-40">
    <SelectValue placeholder="Toute l'année" />
  </SelectTrigger>
  <SelectContent>
    {/* Utilisez "all" au lieu d'une chaîne vide */}
    <SelectItem value="all">Toute l'année {exercice}</SelectItem>
    {moisDisponibles.map(m => (
      <SelectItem key={m} value={m}>{m}</SelectItem>
    ))}
  </SelectContent>
</Select>
              <Button size="sm" variant="outline" onClick={exportTVA}><Download className="h-4 w-4 mr-2" />Exporter</Button>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            {[
              { label: "TVA collectée", value: collectee, compte: "44551", color: "text-red-600", bg: "bg-red-50 dark:bg-red-950/20" },
              { label: "TVA récupérable", value: recuperable, compte: "34552", color: "text-green-600", bg: "bg-green-50 dark:bg-green-950/20" },
              { label: nette >= 0 ? "TVA nette à PAYER" : "Crédit TVA", value: Math.abs(nette), compte: "", color: nette >= 0 ? "text-orange-600" : "text-blue-600", bg: nette >= 0 ? "bg-orange-50 dark:bg-orange-950/20" : "bg-blue-50 dark:bg-blue-950/20" },
            ].map(k => (
              <Card key={k.label} className={k.bg}><CardContent className="pt-4 pb-4">
                <p className="text-xs text-muted-foreground mb-1">{k.label} {k.compte && <span className="font-mono text-xs">({k.compte})</span>}</p>
                <p className={`text-2xl font-bold font-mono ${k.color}`}>{fmtMAD(k.value)}</p>
              </CardContent></Card>
            ))}
          </div>

          {nette > 0 && (
            <Card className="border-orange-300 bg-orange-50 dark:bg-orange-950/20">
              <CardContent className="pt-4 pb-4 text-sm text-orange-700 dark:text-orange-300">
                <p className="font-bold mb-1">📋 À verser à la DGI : {fmtMAD(nette)}</p>
                <p className="text-xs">Régime mensuel : avant le 20 du mois suivant</p>
                <p className="text-xs">Régime trimestriel : avant le 20 du mois suivant le trimestre</p>
                <p className="text-xs mt-1">Télédéclaration : <a href="https://simpl.tax.gov.ma" target="_blank" rel="noopener" className="underline font-medium">simpl.tax.gov.ma</a></p>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader><CardTitle className="text-sm">TVA par mois</CardTitle></CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader><TableRow>
                  <TableHead>Mois</TableHead>
                  <TableHead className="text-right">Collectée</TableHead>
                  <TableHead className="text-right">Récupérable</TableHead>
                  <TableHead className="text-right">Nette</TableHead>
                  <TableHead>Statut</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {tvaMensuelle.length === 0
                    ? <TableRow><TableCell colSpan={5} className="text-center py-6 text-muted-foreground">Aucune écriture TVA</TableCell></TableRow>
                    : tvaMensuelle.map(m => (
                      <TableRow key={m.mois}>
                        <TableCell className="font-mono text-sm">{m.mois}</TableCell>
                        <TableCell className="text-right font-mono text-sm text-red-600">{fmt(m.collectee)}</TableCell>
                        <TableCell className="text-right font-mono text-sm text-green-600">{fmt(m.recuperable)}</TableCell>
                        <TableCell className={`text-right font-mono text-sm font-bold ${m.nette >= 0 ? "text-orange-600" : "text-blue-600"}`}>{fmt(Math.abs(m.nette))}</TableCell>
                        <TableCell><Badge variant={m.nette > 0 ? "destructive" : "default"} className="text-xs">{m.nette > 0 ? "À payer" : "Crédit"}</Badge></TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── IS ── */}
        <TabsContent value="is" className="mt-4 space-y-4">
          <h2 className="font-semibold">Impôt sur les Sociétés — {exercice}</h2>

          <div className="grid grid-cols-2 gap-6">
            <Card>
              <CardHeader><CardTitle className="text-sm flex items-center gap-2"><Calculator className="h-4 w-4" />Calcul IS</CardTitle></CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {[
                    { label: "Chiffre d'affaires HT", value: fmtMAD(ca) },
                    { label: "Total produits", value: fmtMAD(produits) },
                    { label: "Total charges", value: fmtMAD(charges) },
                    { label: "Résultat fiscal", value: fmtMAD(resultat), bold: true },
                    { label: `Taux IS (${tranche.label})`, value: `${(tranche.taux * 100).toFixed(0)}%` },
                    { label: "IS théorique", value: fmtMAD(isTheorique) },
                    { label: "Cotisation minimale (0.5% CA)", value: fmtMAD(cotisationMin) },
                  ].map(r => (
                    <div key={r.label} className="flex justify-between text-sm border-b pb-2">
                      <span className="text-muted-foreground">{r.label}</span>
                      <span className={`font-mono ${(r as any).bold ? "font-bold" : ""}`}>{r.value}</span>
                    </div>
                  ))}
                  <div className="flex justify-between font-bold text-base pt-2">
                    <span>IS À PAYER</span>
                    <span className="font-mono text-orange-600">{fmtMAD(isPaye)}</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-sm">Acomptes provisionnels</CardTitle></CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground mb-4">Chaque acompte = IS annuel ÷ 4 = <strong>{fmtMAD(acompte)}</strong></p>
                <div className="space-y-2">
                  {[
                    { label: "1er acompte", date: `30/04/${exercice}` },
                    { label: "2ème acompte", date: `31/07/${exercice}` },
                    { label: "3ème acompte", date: `31/10/${exercice}` },
                    { label: "4ème acompte", date: `31/12/${exercice}` },
                  ].map(a => {
                    const jours = Math.ceil((new Date(a.date.split("/").reverse().join("-")).getTime() - now.getTime()) / 86400000);
                    return (
                      <div key={a.label} className={`flex justify-between items-center p-2 rounded text-sm ${jours < 0 ? "bg-muted" : jours < 30 ? "bg-red-50 dark:bg-red-950/20" : "bg-blue-50 dark:bg-blue-950/20"}`}>
                        <div>
                          <span className="font-medium">{a.label}</span>
                          <span className="text-xs text-muted-foreground ml-2">{a.date}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm font-bold">{fmtMAD(acompte)}</span>
                          {jours < 0 ? <Badge variant="secondary" className="text-xs">Passé</Badge> :
                           jours < 30 ? <Badge variant="destructive" className="text-xs">Dans {jours}j</Badge> :
                           <Badge variant="outline" className="text-xs">Dans {jours}j</Badge>}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-4 p-3 bg-blue-50 dark:bg-blue-950/20 rounded text-xs text-blue-700 dark:text-blue-300">
                  <p className="font-medium">Barème IS Maroc {exercice} :</p>
                  <p>≤ 300 000 MAD → 20%</p>
                  <p>300 001 – 1 000 000 MAD → 26%</p>
                  <p>&gt; 1 000 000 MAD → 31%</p>
                  <p className="mt-1">CM = 0.5% CA HT (minimum obligatoire)</p>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ── CALENDRIER ── */}
        <TabsContent value="calendrier" className="mt-4">
          <h2 className="font-semibold mb-4">Calendrier fiscal {exercice}</h2>
          <div className="space-y-2">
            {echeances.map((e, i) => (
              <div key={i} className={`flex items-center justify-between p-4 rounded-xl border ${
                e.passe ? "bg-muted border-muted opacity-60" :
                e.jours < 30 ? "bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800" :
                e.jours < 90 ? "bg-yellow-50 dark:bg-yellow-950/20 border-yellow-200" :
                "bg-blue-50 dark:bg-blue-950/20 border-blue-200"
              }`}>
                <div className="flex items-center gap-3">
                  {e.passe ? <CheckCircle className="h-5 w-5 text-muted-foreground" /> :
                   e.jours < 30 ? <AlertCircle className="h-5 w-5 text-red-500" /> :
                   <Clock className="h-5 w-5 text-blue-500" />}
                  <div>
                    <p className={`font-medium text-sm ${e.passe ? "text-muted-foreground" : ""}`}>{e.label}</p>
                    <p className="text-xs text-muted-foreground">{new Date(e.date).toLocaleDateString("fr-MA", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</p>
                  </div>
                </div>
                <div className="text-right">
                  {e.passe
                    ? <Badge variant="secondary" className="text-xs">Passée</Badge>
                    : e.jours < 30
                    ? <Badge variant="destructive" className="text-xs">⚠️ Dans {e.jours} jours</Badge>
                    : <Badge variant="outline" className="text-xs">Dans {e.jours} jours</Badge>}
                  {e.type === "is" && !e.passe && (
                    <p className="text-xs font-mono font-bold text-orange-600 mt-1">{fmtMAD(acompte)}</p>
                  )}
                </div>
              </div>
            ))}

            {/* TVA mensuelle récurrente */}
            <div className="p-4 rounded-xl border bg-muted/30">
              <p className="font-medium text-sm mb-1">🔄 Déclaration TVA mensuelle</p>
              <p className="text-xs text-muted-foreground">Avant le 20 de chaque mois (régime mensuel) ou le 20 du mois suivant le trimestre (régime trimestriel)</p>
              <p className="text-xs mt-1 font-medium text-orange-600">Prochain : 20/{String(now.getMonth() + 2).padStart(2, "0")}/{now.getFullYear()} — {fmtMAD(tvaMensuelle[0]?.nette ?? 0)}</p>
            </div>

            <div className="p-4 rounded-xl border bg-muted/30">
              <p className="font-medium text-sm mb-1">🔄 CNSS / AMO mensuel</p>
              <p className="text-xs text-muted-foreground">Avant le 10 de chaque mois</p>
            </div>
          </div>
        </TabsContent>

        {/* ── TAXE PROFESSIONNELLE ── */}
        <TabsContent value="tp" className="mt-4">
          <h2 className="font-semibold mb-4">Taxe Professionnelle — {exercice}</h2>
          <Card>
            <CardContent className="pt-6 pb-6">
              <div className="grid grid-cols-3 gap-4 mb-6">
                <div className="p-4 bg-muted rounded-xl">
                  <p className="text-xs text-muted-foreground mb-1">Base imposable (CA HT)</p>
                  <p className="font-mono font-bold text-xl">{fmtMAD(ca)}</p>
                </div>
                <div className="p-4 bg-muted rounded-xl">
                  <p className="text-xs text-muted-foreground mb-1">Taux (selon commune)</p>
                  <p className="font-mono font-bold text-xl">6% à 30%</p>
                </div>
                <div className="p-4 bg-muted rounded-xl">
                  <p className="text-xs text-muted-foreground mb-1">Échéance déclaration</p>
                  <p className="font-mono font-bold text-xl">31/01/{Number(exercice) + 1}</p>
                </div>
              </div>
              <div className="p-4 bg-blue-50 dark:bg-blue-950/20 rounded-xl text-sm text-blue-700 dark:text-blue-300">
                <p className="font-medium mb-2">ℹ️ Taxe Professionnelle au Maroc</p>
                <p>La TP est calculée et notifiée par la commune sur la base de votre déclaration annuelle.</p>
                <p className="mt-1">Base = valeur locative annuelle des locaux + matériel et outillage.</p>
                <p className="mt-1">Exonération les 5 premières années pour les nouvelles entreprises.</p>
                <p className="mt-2 font-medium">Déclaration à déposer avant le <strong>31 janvier {Number(exercice) + 1}</strong> auprès de votre commune.</p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
