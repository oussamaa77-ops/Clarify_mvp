import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Shield, FileText, Eye, Search } from "lucide-react";
import { DocumentViewer, type DocumentViewerSource } from "@/components/DocumentViewer";

export const Route = createFileRoute("/_app/dossiers/$dossierId/ged")({ component: GEDPage });

// Une ligne GED normalisée, agrégée depuis toutes les tables porteuses de documents.
interface GedDoc {
  id: string;
  nom: string;
  typeKey: "facture" | "facture_fourn" | "justificatif" | "releve";
  typeLabel: string;
  date: string | null;               // ISO — pour tri / affichage
  source: DocumentViewerSource | null; // null = pas de fichier consultable (ex. e-facture XML)
}

const TYPE_META: Record<GedDoc["typeKey"], { label: string; cls: string }> = {
  facture:       { label: "Facture client",      cls: "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300" },
  facture_fourn: { label: "Facture fournisseur",  cls: "bg-purple-100 text-purple-700 dark:bg-purple-950/40 dark:text-purple-300" },
  justificatif:  { label: "Justificatif",         cls: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300" },
  releve:        { label: "Relevé bancaire",      cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300" },
};

const fmtDate = (d: string | null) => (d ? new Date(d).toLocaleDateString("fr-MA") : "—");

function GEDPage() {
  const { dossierId } = Route.useParams();
  const [docs, setDocs] = useState<GedDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | GedDoc["typeKey"]>("all");
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");
  const [docView, setDocView] = useState<DocumentViewerSource | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [{ data: fc }, { data: ff }, { data: jj }, { data: rb }] = await Promise.all([
        (supabase.from("factures") as any)
          .select("id,numero,date_facture,created_at,fichier_original_url,fichier_original_nom,fichier_original_type,xml_ubl")
          .eq("dossier_id", dossierId),
        (supabase.from("factures_fournisseurs") as any)
          .select("id,numero,fournisseur_nom,date_facture,created_at,fichier_original_url,fichier_original_nom,fichier_original_type")
          .eq("dossier_id", dossierId),
        (supabase.from("justificatifs") as any)
          .select("id,type_document,numero_piece,nom_tiers,date_document,created_at,fichier_original_url,fichier_original_nom,fichier_original_type")
          .eq("dossier_id", dossierId),
        (supabase.from("releves_bancaires") as any)
          .select("id,banque,fichier_nom,fichier_path,fichier_type,periode_fin,created_at")
          .eq("dossier_id", dossierId),
      ]);

      const out: GedDoc[] = [];

      for (const f of fc ?? []) {
        const hasFile = !!f.fichier_original_url;
        out.push({
          id: `fc_${f.id}`,
          nom: f.fichier_original_nom ?? `Facture ${f.numero ?? ""}`.trim() + (f.xml_ubl && !hasFile ? " (e-facture XML)" : ""),
          typeKey: "facture",
          typeLabel: TYPE_META.facture.label,
          date: f.date_facture ?? f.created_at ?? null,
          source: hasFile ? { title: `Facture ${f.numero ?? ""}`.trim(), url: f.fichier_original_url, fileName: f.fichier_original_nom, mimeType: f.fichier_original_type } : null,
        });
      }
      for (const f of ff ?? []) {
        const hasFile = !!f.fichier_original_url;
        out.push({
          id: `ff_${f.id}`,
          nom: f.fichier_original_nom ?? `Facture ${f.numero ?? ""} ${f.fournisseur_nom ?? ""}`.trim(),
          typeKey: "facture_fourn",
          typeLabel: TYPE_META.facture_fourn.label,
          date: f.date_facture ?? f.created_at ?? null,
          source: hasFile ? { title: `Facture ${f.numero ?? ""}`.trim(), url: f.fichier_original_url, fileName: f.fichier_original_nom, mimeType: f.fichier_original_type } : null,
        });
      }
      for (const j of jj ?? []) {
        const hasFile = !!j.fichier_original_url;
        out.push({
          id: `j_${j.id}`,
          nom: j.fichier_original_nom ?? `${j.type_document ?? "Justificatif"} ${j.numero_piece ?? j.nom_tiers ?? ""}`.trim(),
          typeKey: "justificatif",
          typeLabel: TYPE_META.justificatif.label,
          date: j.date_document ?? j.created_at ?? null,
          source: hasFile ? { title: `Justificatif ${j.numero_piece ?? ""}`.trim(), url: j.fichier_original_url, fileName: j.fichier_original_nom, mimeType: j.fichier_original_type } : null,
        });
      }
      for (const r of rb ?? []) {
        const hasFile = !!r.fichier_path;
        out.push({
          id: `r_${r.id}`,
          nom: r.fichier_nom ?? `Relevé ${r.banque ?? ""}`.trim(),
          typeKey: "releve",
          typeLabel: TYPE_META.releve.label,
          date: r.periode_fin ?? r.created_at ?? null,
          source: hasFile ? { title: `Relevé — ${r.banque ?? "document"}`, bucket: "releves-bancaires", path: r.fichier_path, fileName: r.fichier_nom, mimeType: r.fichier_type } : null,
        });
      }

      setDocs(out);
      setLoading(false);
    })();
  }, [dossierId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return docs
      .filter((d) => (typeFilter === "all" || d.typeKey === typeFilter))
      .filter((d) => !q || d.nom.toLowerCase().includes(q) || d.typeLabel.toLowerCase().includes(q))
      .sort((a, b) => {
        const ta = a.date ? new Date(a.date).getTime() : 0;
        const tb = b.date ? new Date(b.date).getTime() : 0;
        return sortDir === "desc" ? tb - ta : ta - tb;
      });
  }, [docs, search, typeFilter, sortDir]);

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-3xl font-bold flex items-center gap-3"><Shield className="h-7 w-7 text-blue-600" />GED — Documents</h1>
        <p className="text-muted-foreground mt-1">Tous les documents du dossier · factures, achats, justificatifs et relevés</p>
      </div>

      {/* Barre recherche + filtres */}
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input className="pl-9" placeholder="Rechercher par nom / type…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as any)}>
          <SelectTrigger className="w-full sm:w-56"><SelectValue placeholder="Type" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tous les types</SelectItem>
            <SelectItem value="facture">Factures clients</SelectItem>
            <SelectItem value="facture_fourn">Factures fournisseurs</SelectItem>
            <SelectItem value="justificatif">Justificatifs</SelectItem>
            <SelectItem value="releve">Relevés bancaires</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sortDir} onValueChange={(v) => setSortDir(v as any)}>
          <SelectTrigger className="w-full sm:w-44"><SelectValue placeholder="Date" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="desc">Plus récent d'abord</SelectItem>
            <SelectItem value="asc">Plus ancien d'abord</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card><CardContent className="p-0">
        <Table>
          <TableHeader><TableRow>
            <TableHead>Fichier</TableHead><TableHead>Type</TableHead><TableHead>Date</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={4} className="text-center py-12 text-muted-foreground">Chargement…</TableCell></TableRow>
            ) : filtered.length === 0 ? (
              <TableRow><TableCell colSpan={4} className="text-center py-12 text-muted-foreground">
                <Shield className="h-10 w-10 mx-auto mb-3 opacity-30" />
                {docs.length === 0 ? "Aucun document dans ce dossier." : "Aucun document correspondant à la recherche."}
              </TableCell></TableRow>
            ) : filtered.map((d) => (
              <TableRow key={d.id}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="text-sm font-medium truncate max-w-[420px]">{d.nom}</span>
                  </div>
                </TableCell>
                <TableCell><Badge className={`text-xs ${TYPE_META[d.typeKey].cls}`}>{d.typeLabel}</Badge></TableCell>
                <TableCell className="text-sm">{fmtDate(d.date)}</TableCell>
                <TableCell className="text-right">
                  {d.source ? (
                    <Button size="sm" variant="ghost" onClick={() => setDocView(d.source)} title="Voir le document">
                      <Eye className="h-3.5 w-3.5 mr-1" />Voir
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">Aucun fichier</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent></Card>

      <p className="text-xs text-muted-foreground mt-3">{filtered.length} document{filtered.length > 1 ? "s" : ""}</p>

      {/* Aperçu (panneau latéral droit) */}
      <DocumentViewer open={!!docView} onOpenChange={(o) => { if (!o) setDocView(null); }} source={docView} />
    </div>
  );
}
