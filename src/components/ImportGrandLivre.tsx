// ============================================================================
// ImportGrandLivre.tsx — UI d'import Excel du Grand Livre (onglet Comptabilité).
//
// Flux : fichier .xlsx → mapping colonnes auto (corrigeable) → aperçu + contrôle
// d'équilibre → import taggé par lot → RÉVERSIBLE (bouton « Annuler cet import »).
// Le parsing/mapping est délégué à src/lib/import-grandlivre.ts (pur, testé).
// ============================================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Upload, Loader2, CheckCircle, AlertTriangle, Undo2, FileSpreadsheet, X } from "lucide-react";
import { toast } from "sonner";
import {
  detectHeaderRow, guessMapping, normalizeRows, deriveTiers, summarize,
  type Mapping, type TargetField,
} from "@/lib/import-grandlivre";
import { importerGrandLivre, annulerImport, listerImports } from "@/server/import.functions";

const FIELDS: { key: TargetField; label: string }[] = [
  { key: "date", label: "Date *" },
  { key: "compte", label: "Compte" },
  { key: "libelle", label: "Libellé" },
  { key: "debit", label: "Débit" },
  { key: "credit", label: "Crédit" },
  { key: "journal", label: "Journal" },
  { key: "reference", label: "Référence" },
  { key: "lettrage", label: "Lettrage (A, B…)" },
  { key: "montant", label: "Montant (si pas Débit/Crédit)" },
  { key: "sens", label: "Sens (D/C)" },
];

const NONE = "__none__";
const fmt = (n: number) => Number(n).toLocaleString("fr-MA", { minimumFractionDigits: 2 });

interface BatchRow {
  id: string; filename: string | null; source_rows: number;
  inserted_ecritures: number; inserted_tiers: number; created_at: string;
}

export default function ImportGrandLivre({ dossierId, onDone }: { dossierId: string; onDone?: () => void }) {
  const [filename, setFilename] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [dataRows, setDataRows] = useState<unknown[][]>([]);
  const [mapping, setMapping] = useState<Mapping>({});
  const [parsing, setParsing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [history, setHistory] = useState<BatchRow[]>([]);
  const [undoing, setUndoing] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      const res = await listerImports({ data: { dossier_id: dossierId } });
      if (res.ok) setHistory(res.batches as BatchRow[]);
    } catch { /* table absente → historique vide */ }
  }, [dossierId]);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  // ── Parsing du fichier ──────────────────────────────────────────────────────
  const onFile = async (file: File) => {
    setParsing(true);
    try {
      const XLSX = await import("xlsx");
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array", cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: "" });
      if (!aoa.length) { toast.error("Feuille vide"); return; }
      const hRow = detectHeaderRow(aoa as unknown[][]);
      const hdrs = (aoa[hRow] as unknown[]).map((c) => String(c ?? "").trim());
      setHeaders(hdrs);
      setDataRows((aoa as unknown[][]).slice(hRow + 1));
      setMapping(guessMapping(hdrs));
      setFilename(file.name);
      toast.success(`Fichier lu — en-tête ligne ${hRow + 1}, ${aoa.length - hRow - 1} lignes`);
    } catch (e: any) {
      toast.error("Lecture impossible : " + (e?.message ?? e));
    } finally {
      setParsing(false);
    }
  };

  // ── Normalisation live (recalculée au changement de mapping) ─────────────────
  const { rows, skipped } = useMemo(
    () => (headers.length ? normalizeRows(dataRows, mapping) : { rows: [], skipped: 0 }),
    [dataRows, mapping, headers.length],
  );
  const tiers = useMemo(() => deriveTiers(rows), [rows]);
  const stats = useMemo(() => summarize(rows), [rows]);
  const nbSansDate = useMemo(() => rows.filter((r) => !r.date).length, [rows]);
  const clients = tiers.filter((t) => t.type === "client").length;
  const fournisseurs = tiers.filter((t) => t.type === "fournisseur").length;

  const setField = (key: TargetField, v: string) =>
    setMapping((m) => {
      const next = { ...m };
      if (v === NONE) delete next[key];
      else next[key] = Number(v);
      return next;
    });

  const reset = () => { setHeaders([]); setDataRows([]); setMapping({}); setFilename(""); };

  // ── Import ────────────────────────────────────────────────────────────────
  const doImport = async () => {
    if (!rows.length) { toast.error("Aucune ligne à importer"); return; }
    setImporting(true);
    try {
      const res = await importerGrandLivre({
        data: {
          dossier_id: dossierId,
          filename,
          mapping: mapping as Record<string, number>,
          rows: rows.map((r) => ({
            date: r.date, journal_code: r.journal_code, compte_numero: r.compte_numero,
            libelle: r.libelle, debit: r.debit, credit: r.credit, reference_piece: r.reference_piece,
            code_lettrage: r.code_lettrage,
          })),
          tiers: tiers.map((t) => ({ type: t.type, nom: t.nom, compte_numero: t.compte_numero })),
        },
      });
      if (!res.ok) { toast.error(res.reason ?? "Échec de l'import"); return; }
      toast.success(
        `Import réussi — ${res.inserted_ecritures} écritures, ${res.inserted_tiers} tiers créés`
        + (res.skipped_no_date ? ` (${res.skipped_no_date} ignorées : date manquante)` : ""),
      );
      reset();
      await loadHistory();
      onDone?.();
    } catch (e: any) {
      toast.error("Erreur : " + (e?.message ?? e));
    } finally {
      setImporting(false);
    }
  };

  // ── Annulation d'un lot ─────────────────────────────────────────────────────
  const undoBatch = async (batchId: string) => {
    setUndoing(batchId);
    try {
      const res = await annulerImport({ data: { dossier_id: dossierId, batch_id: batchId } });
      if (!res.ok) { toast.error(res.reason ?? "Annulation impossible"); return; }
      toast.success(`Import annulé — ${res.deleted_ecritures} écritures et ${res.deleted_tiers} tiers supprimés`);
      await loadHistory();
      onDone?.();
    } catch (e: any) {
      toast.error("Erreur : " + (e?.message ?? e));
    } finally {
      setUndoing(null);
    }
  };

  const hasFile = headers.length > 0;

  return (
    <div className="space-y-4">
      {/* ── Zone de dépôt ── */}
      {!hasFile && (
        <label className="flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-lg py-12 cursor-pointer hover:bg-muted/50 transition-colors">
          {parsing ? <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            : <Upload className="h-8 w-8 text-muted-foreground" />}
          <span className="text-sm font-medium">Déposer un fichier Excel du Grand Livre</span>
          <span className="text-xs text-muted-foreground">.xlsx / .xls — structure libre, colonnes auto-détectées</span>
          <input type="file" accept=".xlsx,.xls" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
        </label>
      )}

      {/* ── Mapping + aperçu ── */}
      {hasFile && (
        <>
          <div className="flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">{filename}</span>
            <Badge variant="secondary">{rows.length} lignes</Badge>
            <Button variant="ghost" size="sm" className="ml-auto" onClick={reset}>
              <X className="h-4 w-4 mr-1" />Changer de fichier
            </Button>
          </div>

          {/* Mapping colonnes */}
          <Card>
            <CardContent className="pt-4">
              <p className="text-sm font-medium mb-3">Correspondance des colonnes
                <span className="text-xs text-muted-foreground font-normal"> — corrigez si Débit/Crédit sont inversés</span>
              </p>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {FIELDS.map((f) => (
                  <div key={f.key} className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">{f.label}</label>
                    <Select value={mapping[f.key] != null ? String(mapping[f.key]) : NONE}
                      onValueChange={(v) => setField(f.key, v)}>
                      <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>—</SelectItem>
                        {headers.map((h, i) => (
                          <SelectItem key={i} value={String(i)}>{h || `Colonne ${i + 1}`}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Récap */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatTile label="Écritures" value={String(rows.length)} />
            <StatTile label="Tiers à créer" value={`${clients} cli · ${fournisseurs} four`} />
            <StatTile label="Total Débit / Crédit" value={`${fmt(stats.totalDebit)} / ${fmt(stats.totalCredit)}`} />
            <div className={`rounded-lg p-3 flex flex-col justify-center ${stats.equilibre ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700"}`}>
              <div className="flex items-center gap-1 text-sm font-semibold">
                {stats.equilibre ? <CheckCircle className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
                {stats.equilibre ? "Équilibré" : `Écart ${fmt(Math.abs(stats.totalDebit - stats.totalCredit))}`}
              </div>
              <span className="text-xs opacity-80">
                {stats.nbWarnings > 0 ? `${stats.nbWarnings} ligne(s) à vérifier` : "aucune anomalie"}
              </span>
            </div>
          </div>

          {(skipped > 0 || nbSansDate > 0) && (
            <p className="text-xs text-muted-foreground">
              {skipped > 0 && `${skipped} ligne(s) vides/totaux ignorées. `}
              {nbSansDate > 0 && `${nbSansDate} ligne(s) sans date lisible ne seront pas importées.`}
            </p>
          )}

          {/* Aperçu */}
          <div className="border rounded-lg overflow-x-auto max-h-80 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted sticky top-0">
                <tr className="text-left">
                  {["Date", "Journal", "Compte", "Libellé", "Débit", "Crédit", "Réf.", "Let.", ""].map((h) => (
                    <th key={h} className="px-2 py-1.5 font-medium whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 50).map((r, i) => (
                  <tr key={i} className={`border-t ${r.warnings.length ? "bg-amber-50/60" : ""}`}>
                    <td className={`px-2 py-1 whitespace-nowrap ${!r.date ? "text-red-600" : ""}`}>{r.date ?? "⚠ ?"}</td>
                    <td className="px-2 py-1">{r.journal_code}</td>
                    <td className="px-2 py-1 whitespace-nowrap">{r.compte_numero || "—"}</td>
                    <td className="px-2 py-1 max-w-xs truncate" title={r.libelle}>{r.libelle}</td>
                    <td className="px-2 py-1 text-right whitespace-nowrap">{r.debit ? fmt(r.debit) : ""}</td>
                    <td className="px-2 py-1 text-right whitespace-nowrap">{r.credit ? fmt(r.credit) : ""}</td>
                    <td className="px-2 py-1">{r.reference_piece ?? ""}</td>
                    <td className="px-2 py-1 font-mono text-xs">{r.code_lettrage ?? ""}</td>
                    <td className="px-2 py-1 text-amber-600" title={r.warnings.join(", ")}>{r.warnings.length ? "⚠" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > 50 && <p className="text-xs text-muted-foreground px-2 py-1.5">… et {rows.length - 50} autres lignes</p>}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={reset}>Annuler</Button>
            <Button onClick={doImport} disabled={importing || !rows.length}>
              {importing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Upload className="h-4 w-4 mr-2" />}
              Importer {rows.length} écritures
            </Button>
          </div>
        </>
      )}

      {/* ── Historique des imports (undo persistant) ── */}
      {history.length > 0 && (
        <Card>
          <CardContent className="pt-4">
            <p className="text-sm font-medium mb-2">Imports récents</p>
            <div className="space-y-1">
              {history.map((b) => (
                <div key={b.id} className="flex items-center gap-2 text-sm py-1 border-t first:border-t-0">
                  <FileSpreadsheet className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="truncate">{b.filename || "import.xlsx"}</span>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {b.inserted_ecritures} écr. · {b.inserted_tiers} tiers · {new Date(b.created_at).toLocaleDateString("fr-MA")}
                  </span>
                  <Button variant="ghost" size="sm" className="ml-auto text-red-600 hover:text-red-700"
                    disabled={undoing === b.id} onClick={() => undoBatch(b.id)}>
                    {undoing === b.id ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Undo2 className="h-4 w-4 mr-1" />}
                    Annuler cet import
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3 flex flex-col justify-center">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-semibold">{value}</span>
    </div>
  );
}
