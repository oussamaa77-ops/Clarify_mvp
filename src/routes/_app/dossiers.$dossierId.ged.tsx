import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Shield, FileText, Download } from "lucide-react";

export const Route = createFileRoute("/_app/dossiers/$dossierId/ged")({ component: GEDPage });

interface Doc { id: string; nom_fichier: string; type_document: string | null; hash_sha256: string | null; dgi_uuid: string | null; horodatage: string; taille_bytes: number | null; }

function GEDPage() {
  const { dossierId } = Route.useParams();
  const [docs, setDocs] = useState<Doc[]>([]);

  useEffect(() => {
    supabase.from("ged_documents").select("*").eq("dossier_id", dossierId).order("horodatage", { ascending: false })
      .then(({ data }) => setDocs((data ?? []) as Doc[]));
  }, [dossierId]);

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-3xl font-bold flex items-center gap-3"><Shield className="h-7 w-7 text-blue-600" />GED — Documents</h1>
        <p className="text-muted-foreground mt-1">Archive immuable · SHA-256 · UUID DGI · Horodatage</p>
      </div>

      <Card className="mb-4 border-blue-200 bg-blue-50/50 dark:bg-blue-950/20 dark:border-blue-800">
        <CardContent className="pt-3 pb-3 text-sm text-blue-700 dark:text-blue-300">
          Chaque document est scellé par empreinte SHA-256 et associé à un UUID DGI. Cette archive est immuable et conforme aux exigences DGI Maroc 2026.
        </CardContent>
      </Card>

      <Card><CardContent className="p-0">
        <Table>
          <TableHeader><TableRow>
            <TableHead>Fichier</TableHead><TableHead>Type</TableHead><TableHead>UUID DGI</TableHead>
            <TableHead>SHA-256</TableHead><TableHead>Horodatage</TableHead><TableHead>Taille</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {docs.length === 0
              ? <TableRow><TableCell colSpan={6} className="text-center py-12 text-muted-foreground">
                  <Shield className="h-10 w-10 mx-auto mb-3 opacity-30" />
                  Aucun document archivé. Les factures conformes DGI sont archivées automatiquement.
                </TableCell></TableRow>
              : docs.map(d => (
                <TableRow key={d.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <FileText className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm font-medium">{d.nom_fichier}</span>
                    </div>
                  </TableCell>
                  <TableCell><Badge variant="secondary" className="text-xs">{d.type_document}</Badge></TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground max-w-[150px] truncate">{d.dgi_uuid ?? "—"}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{d.hash_sha256?.slice(0, 16)}…</TableCell>
                  <TableCell className="text-xs">{new Date(d.horodatage).toLocaleString("fr-MA")}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{d.taille_bytes ? `${(d.taille_bytes / 1024).toFixed(1)} KB` : "—"}</TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </CardContent></Card>
    </div>
  );
}
