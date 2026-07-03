import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Shield, ChevronLeft, ChevronRight } from "lucide-react";

export const Route = createFileRoute("/_app/dossiers/$dossierId/audit")({ component: AuditPage });

interface Log { id: string; action: string; user_email: string | null; ressource_type: string | null; ressource_id: string | null; details: any; hash: string | null; hash_precedent: string | null; created_at: string; }

const ACTION_COLORS: Record<string, string> = {
  efacture_conforme: "default", efacture_rejetee: "destructive", facture_payee: "default",
  "create": "secondary", "update": "secondary", "delete": "destructive",
};

function AuditPage() {
  const { dossierId } = Route.useParams();
  const [logs, setLogs] = useState<Log[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const PAGE = 30;

  useEffect(() => {
    supabase.from("audit_logs").select("*", { count: "exact" })
      .eq("dossier_id", dossierId)
      .order("created_at", { ascending: false })
      .range((page - 1) * PAGE, page * PAGE - 1)
      .then(({ data, count }) => { setLogs((data ?? []) as Log[]); setTotal(count ?? 0); });
  }, [dossierId, page]);

  const totalPages = Math.ceil(total / PAGE);

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-3xl font-bold flex items-center gap-3"><Shield className="h-7 w-7" />Piste d'audit</h1>
        <p className="text-muted-foreground mt-1">Journal immuable · SHA-256 chaîné · Genesis block</p>
      </div>

      <Card className="mb-4 border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/20">
        <CardContent className="pt-4 pb-3 text-sm text-blue-700 dark:text-blue-300">
          <strong>Intégrité cryptographique :</strong> chaque entrée contient le hash SHA-256 de l'entrée précédente.
          Toute modification de l'historique est détectable. Conforme aux exigences DGI Maroc 2026.
        </CardContent>
      </Card>

      <Card><CardContent className="p-0">
        <Table>
          <TableHeader><TableRow>
            <TableHead>Date/Heure</TableHead><TableHead>Utilisateur</TableHead><TableHead>Action</TableHead>
            <TableHead>Ressource</TableHead><TableHead>Détails</TableHead><TableHead>Hash SHA-256</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {logs.length === 0
              ? <TableRow><TableCell colSpan={6} className="text-center py-10 text-muted-foreground">Aucune entrée d'audit pour le moment. Les actions (e-factures, paiements, OCR…) apparaissent ici automatiquement.</TableCell></TableRow>
              : logs.map(l => (
                <TableRow key={l.id}>
                  <TableCell className="text-xs whitespace-nowrap">{new Date(l.created_at).toLocaleString("fr-MA")}</TableCell>
                  <TableCell className="text-xs max-w-[120px] truncate">{l.user_email ?? "—"}</TableCell>
                  <TableCell><Badge variant={(ACTION_COLORS[l.action] ?? "secondary") as any} className="text-xs">{l.action}</Badge></TableCell>
                  <TableCell className="text-xs">{l.ressource_type} {l.ressource_id ? `#${l.ressource_id.slice(0, 8)}` : ""}</TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-[150px] truncate">
                    {l.details ? Object.entries(l.details).map(([k, v]) => `${k}: ${v}`).join(", ") : "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{l.hash?.slice(0, 16)}…</TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </CardContent></Card>

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <p className="text-sm text-muted-foreground">{total} entrées · Page {page}/{totalPages}</p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage(p => p - 1)}><ChevronLeft className="h-4 w-4" /></Button>
            <Button variant="outline" size="sm" disabled={page === totalPages} onClick={() => setPage(p => p + 1)}><ChevronRight className="h-4 w-4" /></Button>
          </div>
        </div>
      )}
    </div>
  );
}
