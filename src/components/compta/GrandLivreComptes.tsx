// ============================================================================
// GrandLivreComptes — le GRAND LIVRE par dossier de compte (présentation Sage 100).
//
// Là où le Journal Général déroule les écritures dans l'ordre chronologique, cet
// écran les regroupe par compte du PCM : une ligne de synthèse par compte (solde
// initial, totaux, solde final ventilé), qui se déplie sur ses mouvements avec
// solde progressif. Chaque mouvement ouvre sa pièce d'origine en un clic.
//
// Tous les calculs vivent dans src/lib/grand-livre.ts : l'écran, l'export Excel
// et l'édition PDF lisent le MÊME objet, si bien qu'un total affiché ne peut pas
// différer d'un total exporté.
// ============================================================================

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertTriangle, CheckCircle, ChevronRight, ChevronsDownUp, ChevronsUpDown,
  FileSpreadsheet, FileText, Loader2, Paperclip, RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { DocumentViewer, type DocumentViewerSource } from "@/components/DocumentViewer";
import { genererPdfA3Facture } from "@/server/efacture.functions";
import { sansANouveaux } from "@/lib/a-nouveaux";
import { intitulePcm } from "@/lib/dashboard-fiscal";
import { CLASSES_PCM, PCM } from "@/lib/pcm-referentiel";
import {
  concordanceJournal, construireGrandLivre, grandLivreEnTableau, lignesDeLaPiece, planPieceSource, ventiler,
  type CompteGrandLivre, type EnteteGrandLivre, type LigneGrandLivre, type MouvementGrandLivre, type PieceSource,
} from "@/lib/grand-livre";

const fmt = (n: number) => Number(n).toLocaleString("fr-MA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const soldeTexte = (s: number) => {
  const v = ventiler(s);
  return v.debiteur ? `${fmt(v.debiteur)} D` : v.crediteur ? `${fmt(v.crediteur)} C` : "—";
};

const COLONNES_SELECT =
  "id,date_ecriture,journal_code,compte_numero,libelle,debit,credit,reference_piece,lettrage_code,facture_id,transaction_id";

/** Grilles partagées par l'en-tête et les lignes : un alignement, pas deux. */
const GRILLE_COMPTE = "grid grid-cols-[1.5rem_6.5rem_minmax(0,1fr)_repeat(5,7.5rem)] gap-2 items-center";
const GRILLE_MOUVEMENT = "grid grid-cols-[5.5rem_3rem_8rem_minmax(0,1fr)_2.5rem_repeat(3,7rem)_2rem] gap-2 items-center";

interface PieceAffichee { titre: string; lignes: LigneGrandLivre[] }

export default function GrandLivreComptes({
  dossierId, exercice, bornes, pcmComptes, intitulesAux,
}: {
  dossierId: string;
  exercice: number | null;
  bornes: { debut: string; fin: string } | null;
  /** Référentiel PCM (`pcm_reference`). */
  pcmComptes: { numero: string; intitule: string }[];
  /** Comptes auxiliaires de tiers : 44110005 → « ATLAS SARL ». */
  intitulesAux: Record<string, string>;
}) {
  const pdfA3Fn = useServerFn(genererPdfA3Facture);
  // Mémoïsé : un catalogue recréé à chaque rendu relancerait tout le calcul du grand livre.
  const catalogue = useMemo(
    () => Object.fromEntries(pcmComptes.map((c) => [c.numero, c.intitule])) as Record<string, string>,
    [pcmComptes],
  );

  const [lignes, setLignes] = useState<LigneGrandLivre[]>([]);
  const [chargement, setChargement] = useState(true);
  const [dossier, setDossier] = useState<{ nom_societe?: string; ice?: string; if_fiscal?: string; rc?: string } | null>(null);

  // Filtres
  const [dateDeb, setDateDeb] = useState("");
  const [dateFin, setDateFin] = useState("");
  const [classe, setClasse] = useState("TOUTES");
  const [compteDe, setCompteDe] = useState("");
  const [compteA, setCompteA] = useState("");
  const [masquerSoldes, setMasquerSoldes] = useState(false);

  const [ouverts, setOuverts] = useState<Set<string>>(new Set());
  const [docView, setDocView] = useState<DocumentViewerSource | null>(null);
  const [piece, setPiece] = useState<PieceAffichee | null>(null);
  const [ouverture, setOuverture] = useState<string | null>(null);
  const [export_, setExport] = useState<"xlsx" | "pdf" | null>(null);

  // Un changement d'exercice réinitialise la période : des dates de 2025 n'ont
  // aucun sens dans une vue qui annonce 2026.
  useEffect(() => { setDateDeb(""); setDateFin(""); }, [exercice]);

  const charger = useCallback(async () => {
    setChargement(true);
    try {
      // Pagination : PostgREST plafonne à 1000 lignes, et un grand livre tronqué
      // en silence afficherait des soldes faux sans le dire.
      let tout: LigneGrandLivre[] = [];
      for (let de = 0; ; de += 1000) {
        let q = (supabase as any).from("ecritures_comptables").select(COLONNES_SELECT)
          .eq("dossier_id", dossierId).order("date_ecriture").order("id").range(de, de + 999);
        if (bornes) q = q.gte("date_ecriture", bornes.debut).lte("date_ecriture", bornes.fin);
        const { data, error } = await q;
        if (error) throw error;
        tout = tout.concat((data ?? []) as LigneGrandLivre[]);
        if ((data ?? []).length < 1000) break;
      }
      // Vue « tous exercices » : les à-nouveaux doublent les soldes qu'ils
      // reportent ; ils sortent (cf. src/lib/a-nouveaux.ts).
      setLignes(exercice == null ? sansANouveaux(tout) : tout);
    } catch (e: any) {
      toast.error(`Grand livre illisible : ${e?.message ?? e}`);
    } finally {
      setChargement(false);
    }
  }, [dossierId, bornes?.debut, bornes?.fin, exercice]);

  useEffect(() => { charger(); }, [charger]);

  useEffect(() => {
    (async () => {
      const { data } = await (supabase.from("dossiers") as any)
        .select("nom_societe,ice,if_fiscal,rc").eq("id", dossierId).maybeSingle();
      setDossier(data ?? null);
    })();
  }, [dossierId]);

  // La période saisie ne peut que RESSERRER l'exercice, jamais le déborder.
  const debut = [bornes?.debut, dateDeb].filter(Boolean).sort().at(-1) ?? null;
  const fin = [bornes?.fin, dateFin].filter(Boolean).sort().at(0) ?? null;

  const intitule = useCallback(
    (compte: string) => intitulesAux[compte] ?? intitulePcm(compte, catalogue),
    [intitulesAux, catalogue],
  );

  const gl = useMemo(() => construireGrandLivre(lignes, {
    debut, fin,
    classes: classe === "TOUTES" ? [] : [classe],
    compteDe, compteA, masquerSoldes, intitule,
  }), [lignes, debut, fin, classe, compteDe, compteA, masquerSoldes, intitule]);

  const concordance = useMemo(() => concordanceJournal(lignes, gl), [lignes, gl]);

  const basculer = (compte: string) => setOuverts((prev) => {
    const next = new Set(prev);
    next.has(compte) ? next.delete(compte) : next.add(compte);
    return next;
  });
  const toutOuvert = gl.comptes.length > 0 && gl.comptes.every((c) => ouverts.has(c.compte));

  // ── Pièce source ─────────────────────────────────────────────────────────
  const depuisFichier = (titre: string, r: any): DocumentViewerSource | null =>
    r?.fichier_original_url
      ? { title: titre, url: r.fichier_original_url, fileName: r.fichier_original_nom, mimeType: r.fichier_original_type }
      : null;

  const factureClient = async (id: string): Promise<DocumentViewerSource | null> => {
    const { data: f } = await (supabase as any).from("factures")
      .select("id,numero,hash_sha256,fichier_original_url,fichier_original_nom,fichier_original_type")
      .eq("id", id).maybeSingle();
    if (!f) return null;
    // Une facture scellée a valeur probante sous sa forme PDF/A-3 ; le scan n'est
    // que le repli quand l'édition officielle échoue.
    if (f.hash_sha256) {
      try {
        const r = await pdfA3Fn({ data: { facture_id: f.id } });
        return { title: `Facture ${f.numero ?? ""} — PDF/A-3`.trim(), fileName: r.nom_fichier, mimeType: "application/pdf", base64: r.pdf_base64 };
      } catch { /* repli sur le fichier d'origine */ }
    }
    return depuisFichier(`Facture ${f.numero ?? ""}`.trim(), f);
  };

  const factureFournisseur = async (id: string): Promise<DocumentViewerSource | null> => {
    const { data: f } = await (supabase as any).from("factures_fournisseurs")
      .select("numero,fournisseur_nom,fichier_original_url,fichier_original_nom,fichier_original_type")
      .eq("id", id).maybeSingle();
    return depuisFichier(`Facture fournisseur ${f?.numero ?? ""} ${f?.fournisseur_nom ?? ""}`.trim(), f);
  };

  const chercherDocument = async (etape: PieceSource): Promise<DocumentViewerSource | null> => {
    switch (etape.type) {
      case "facture_client": return factureClient(etape.id);
      case "facture_fournisseur": return factureFournisseur(etape.id);
      case "transaction": {
        const { data: tx } = await (supabase as any).from("transactions_bancaires")
          .select("libelle,facture_id,justificatif_id,releve_id,quittance_path,quittance_nom")
          .eq("id", etape.id).maybeSingle();
        if (!tx) return null;
        if (tx.justificatif_id) {
          const { data: j } = await (supabase as any).from("justificatifs")
            .select("numero_piece,fichier_original_url,fichier_original_nom,fichier_original_type,url_fichier")
            .eq("id", tx.justificatif_id).maybeSingle();
          const doc = depuisFichier(`Justificatif ${j?.numero_piece ?? ""}`.trim(), j)
            ?? (j?.url_fichier ? { title: `Justificatif ${j.numero_piece ?? ""}`.trim(), url: j.url_fichier } : null);
          if (doc) return doc;
        }
        if (tx.facture_id) {
          const doc = (await factureClient(tx.facture_id)) ?? (await factureFournisseur(tx.facture_id));
          if (doc) return doc;
        }
        if (tx.quittance_path) {
          return { title: `Quittance — ${tx.libelle ?? ""}`.trim(), bucket: "quittances-tva", path: tx.quittance_path, fileName: tx.quittance_nom };
        }
        if (tx.releve_id) {
          const { data: rl } = await (supabase as any).from("releves_bancaires")
            .select("date_debut,date_fin,fichier_path,fichier_url,fichier_nom,fichier_type")
            .eq("id", tx.releve_id).maybeSingle();
          const titre = `Relevé bancaire ${rl?.date_debut ?? ""} → ${rl?.date_fin ?? ""}`.trim();
          if (rl?.fichier_path) return { title: titre, bucket: "releves-bancaires", path: rl.fichier_path, fileName: rl.fichier_nom, mimeType: rl.fichier_type };
          if (rl?.fichier_url) return { title: titre, url: rl.fichier_url, fileName: rl.fichier_nom, mimeType: rl.fichier_type };
        }
        return null;
      }
      case "numero": {
        const [{ data: f }, { data: ff }, { data: j }] = await Promise.all([
          (supabase as any).from("factures").select("id").eq("dossier_id", dossierId).eq("numero", etape.numero).limit(1),
          (supabase as any).from("factures_fournisseurs").select("id").eq("dossier_id", dossierId).eq("numero", etape.numero).limit(1),
          (supabase as any).from("justificatifs")
            .select("numero_piece,fichier_original_url,fichier_original_nom,fichier_original_type")
            .eq("dossier_id", dossierId).eq("numero_piece", etape.numero).limit(1),
        ]);
        if (f?.[0]) { const d = await factureClient(f[0].id); if (d) return d; }
        if (ff?.[0]) { const d = await factureFournisseur(ff[0].id); if (d) return d; }
        return depuisFichier(`Justificatif ${etape.numero}`, j?.[0]);
      }
      default: return null;
    }
  };

  const ouvrirPiece = async (m: MouvementGrandLivre) => {
    const cle = m.id ?? `${m.date_ecriture}-${m.reference_piece}`;
    setOuverture(cle);
    try {
      const plan = planPieceSource(m);
      for (const etape of plan) {
        if (etape.type === "piece_comptable") {
          if (plan.length > 1) toast.info("Aucun document archivé pour cette écriture : affichage de la pièce comptable.");
          setPiece({
            titre: `Pièce ${etape.journal} ${etape.reference ?? "(sans référence)"} du ${etape.date}`,
            lignes: lignesDeLaPiece(lignes, etape),
          });
          return;
        }
        const doc = await chercherDocument(etape);
        if (doc) { setDocView(doc); return; }
      }
    } catch (e: any) {
      toast.error(`Pièce introuvable : ${e?.message ?? e}`);
    } finally {
      setOuverture(null);
    }
  };

  // ── Exports ──────────────────────────────────────────────────────────────
  const entete: EnteteGrandLivre = {
    raisonSociale: dossier?.nom_societe ?? "",
    ice: dossier?.ice ?? null,
    identifiantFiscal: dossier?.if_fiscal ?? null,
    rc: dossier?.rc ?? null,
    exercice: exercice ?? "tous exercices",
    editeLe: new Date().toLocaleDateString("fr-FR"),
  };
  const nomFichier = (ext: string) =>
    `GrandLivre_${(dossier?.nom_societe ?? dossierId.slice(0, 8)).replace(/[^\w-]+/g, "_")}_${exercice ?? "tous"}.${ext}`;

  const telecharger = (blob: Blob, nom: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = nom;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const exporterExcel = async () => {
    if (!gl.comptes.length) { toast.error("Aucun compte à exporter"); return; }
    setExport("xlsx");
    try {
      const XLSX = await import("xlsx");
      const wb = XLSX.utils.book_new();
      const synthese: (string | number)[][] = [
        ["N° compte", "Intitulé", "Solde initial débiteur", "Solde initial créditeur", "Total débit", "Total crédit", "Solde final débiteur", "Solde final créditeur"],
        ...gl.comptes.map((c) => {
          const si = ventiler(c.soldeInitial);
          return [c.compte, c.intitule, si.debiteur || "", si.crediteur || "", c.totalDebit, c.totalCredit, c.soldeDebiteur || "", c.soldeCrediteur || ""];
        }),
        ["TOTAL", "", gl.totaux.initialDebit, gl.totaux.initialCredit, gl.totaux.totalDebit, gl.totaux.totalCredit, gl.totaux.soldeDebiteur, gl.totaux.soldeCrediteur],
      ];
      const wsS = XLSX.utils.aoa_to_sheet(synthese);
      wsS["!cols"] = [{ wch: 11 }, { wch: 42 }, ...Array(6).fill({ wch: 16 })];
      XLSX.utils.book_append_sheet(wb, wsS, "Synthese");
      const wsD = XLSX.utils.aoa_to_sheet(grandLivreEnTableau(gl, entete));
      wsD["!cols"] = [{ wch: 11 }, { wch: 30 }, { wch: 11 }, { wch: 8 }, { wch: 20 }, { wch: 46 }, { wch: 8 }, ...Array(4).fill({ wch: 15 })];
      XLSX.utils.book_append_sheet(wb, wsD, "Grand livre");
      XLSX.writeFile(wb, nomFichier("xlsx"));
      toast.success(`Grand livre Excel — ${gl.comptes.length} compte(s)`);
    } catch (e: any) {
      toast.error(`Export Excel impossible : ${e?.message ?? e}`);
    } finally {
      setExport(null);
    }
  };

  const exporterPdf = async () => {
    if (!gl.comptes.length) { toast.error("Aucun compte à exporter"); return; }
    setExport("pdf");
    try {
      const { genererPdfGrandLivre } = await import("@/lib/grand-livre-pdf");
      const octets = await genererPdfGrandLivre(gl, entete);
      telecharger(new Blob([octets as BlobPart], { type: "application/pdf" }), nomFichier("pdf"));
      toast.success(`Grand livre PDF — ${gl.comptes.length} compte(s)`);
    } catch (e: any) {
      toast.error(`Édition PDF impossible : ${e?.message ?? e}`);
    } finally {
      setExport(null);
    }
  };

  // Comptes regroupés par classe, pour l'intercalaire « Classe n ».
  const parClasse = useMemo(() => {
    const groupes: { classe: string; comptes: CompteGrandLivre[] }[] = [];
    for (const c of gl.comptes) {
      const dernier = groupes.at(-1);
      if (dernier?.classe === c.classe) dernier.comptes.push(c);
      else groupes.push({ classe: c.classe, comptes: [c] });
    }
    return groupes;
  }, [gl.comptes]);

  return (
    <div className="space-y-3">
      {/* ── Filtres ── */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-muted/30 p-3">
        <div>
          <label className="mb-1 block text-[11px] font-medium text-muted-foreground">Du</label>
          <Input type="date" value={dateDeb} min={bornes?.debut} max={bornes?.fin} onChange={(e) => setDateDeb(e.target.value)} className="h-8 w-36" />
        </div>
        <div>
          <label className="mb-1 block text-[11px] font-medium text-muted-foreground">Au</label>
          <Input type="date" value={dateFin} min={bornes?.debut} max={bornes?.fin} onChange={(e) => setDateFin(e.target.value)} className="h-8 w-36" />
        </div>
        <div>
          <label className="mb-1 block text-[11px] font-medium text-muted-foreground">Classe PCM</label>
          <Select value={classe} onValueChange={setClasse}>
            <SelectTrigger className="h-8 w-52"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="TOUTES">Toutes les classes</SelectItem>
              {Object.entries(CLASSES_PCM).filter(([k]) => k !== "8").map(([k, v]) => (
                <SelectItem key={k} value={k}>Classe {k} — {v.replace(/^Comptes (de |d')/, "")}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="mb-1 block text-[11px] font-medium text-muted-foreground">Comptes de … à …</label>
          <div className="flex items-center gap-1">
            <Input value={compteDe} onChange={(e) => setCompteDe(e.target.value.replace(/\D/g, ""))} placeholder={PCM.CLIENTS} className="h-8 w-24 font-mono" />
            <span className="text-muted-foreground">→</span>
            <Input value={compteA} onChange={(e) => setCompteA(e.target.value.replace(/\D/g, ""))} placeholder={PCM.FOURNISSEURS} className="h-8 w-24 font-mono" />
          </div>
        </div>
        <label className="flex h-8 items-center gap-2 text-sm">
          <Switch checked={masquerSoldes} onCheckedChange={setMasquerSoldes} />
          Masquer les comptes soldés
        </label>
        <Button variant="ghost" size="sm" className="h-8"
          onClick={() => { setDateDeb(""); setDateFin(""); setClasse("TOUTES"); setCompteDe(""); setCompteA(""); setMasquerSoldes(false); }}>
          Réinitialiser
        </Button>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" className="h-8" onClick={charger}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />Actualiser</Button>
          <Button variant="outline" size="sm" className="h-8" onClick={exporterExcel} disabled={!!export_}>
            {export_ === "xlsx" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <FileSpreadsheet className="mr-1.5 h-3.5 w-3.5" />}Excel
          </Button>
          <Button variant="outline" size="sm" className="h-8" onClick={exporterPdf} disabled={!!export_}>
            {export_ === "pdf" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <FileText className="mr-1.5 h-3.5 w-3.5" />}PDF
          </Button>
        </div>
      </div>

      {/* ── Contrôles : périmètre, équilibre, concordance avec le journal ── */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">
          Période {debut ?? "origine"} → {fin ?? "ce jour"} · {gl.comptes.length} compte(s)
          {gl.nbComptesMasques > 0 && ` · ${gl.nbComptesMasques} soldé(s) masqué(s)`}
        </span>
        {concordance.ok ? (
          <Badge variant="outline" className="gap-1 border-green-300 bg-green-50 text-green-700">
            <CheckCircle className="h-3 w-3" />Concorde avec le Journal Général ({fmt(concordance.journalDebit)})
          </Badge>
        ) : (
          <Badge variant="outline" className="gap-1 border-red-300 bg-red-50 text-red-700">
            <AlertTriangle className="h-3 w-3" />Écart avec le Journal Général : D {fmt(concordance.ecartDebit)} / C {fmt(concordance.ecartCredit)}
          </Badge>
        )}
        {!gl.equilibre && (
          <Badge variant="outline" className="gap-1 border-amber-300 bg-amber-50 text-amber-700">
            <AlertTriangle className="h-3 w-3" />Grand livre déséquilibré
          </Badge>
        )}
        <Button variant="ghost" size="sm" className="ml-auto h-7 text-xs"
          onClick={() => setOuverts(toutOuvert ? new Set() : new Set(gl.comptes.map((c) => c.compte)))}>
          {toutOuvert ? <ChevronsDownUp className="mr-1 h-3.5 w-3.5" /> : <ChevronsUpDown className="mr-1 h-3.5 w-3.5" />}
          {toutOuvert ? "Tout replier" : "Tout déplier"}
        </Button>
      </div>

      {/* ── Table des comptes ── */}
      <div className="overflow-x-auto rounded-lg border">
        <div className="min-w-[960px]">
          <div className={`${GRILLE_COMPTE} sticky top-0 z-10 bg-muted px-3 py-2 text-[11px] font-semibold uppercase text-muted-foreground`}>
            <span />
            <span>N° compte</span>
            <span>Intitulé</span>
            <span className="text-right">Solde initial</span>
            <span className="text-right">Total débit</span>
            <span className="text-right">Total crédit</span>
            <span className="text-right">Solde débiteur</span>
            <span className="text-right">Solde créditeur</span>
          </div>

          {chargement ? (
            <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin" /></div>
          ) : !gl.comptes.length ? (
            <div className="py-12 text-center text-sm text-muted-foreground">Aucun compte mouvementé pour ces critères.</div>
          ) : (
            <div className="max-h-[65vh] overflow-y-auto">
              {parClasse.map((g) => (
                <Fragment key={g.classe}>
                  <div className="border-b bg-muted/50 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Classe {g.classe} — {CLASSES_PCM[g.classe] ?? ""}
                  </div>
                  {g.comptes.map((c) => {
                    const ouvert = ouverts.has(c.compte);
                    return (
                      <div key={c.compte} className="border-b">
                        <button type="button" onClick={() => basculer(c.compte)} aria-expanded={ouvert}
                          className={`${GRILLE_COMPTE} w-full px-3 py-1.5 text-left text-sm transition-colors hover:bg-muted/40 ${ouvert ? "bg-primary/5" : ""}`}>
                          <ChevronRight className={`h-4 w-4 text-muted-foreground transition-transform ${ouvert ? "rotate-90" : ""}`} />
                          <span className="font-mono font-medium">{c.compte}</span>
                          <span className="truncate" title={c.intitule}>
                            {c.intitule || <span className="text-muted-foreground">—</span>}
                            <span className="ml-2 text-[11px] text-muted-foreground">{c.mouvements.length} mvt</span>
                          </span>
                          <span className="text-right font-mono text-xs text-muted-foreground">{soldeTexte(c.soldeInitial)}</span>
                          <span className="text-right font-mono text-red-600">{c.totalDebit ? fmt(c.totalDebit) : "—"}</span>
                          <span className="text-right font-mono text-green-600">{c.totalCredit ? fmt(c.totalCredit) : "—"}</span>
                          <span className="text-right font-mono font-semibold text-red-600">{c.soldeDebiteur ? fmt(c.soldeDebiteur) : ""}</span>
                          <span className="text-right font-mono font-semibold text-green-600">{c.soldeCrediteur ? fmt(c.soldeCrediteur) : ""}</span>
                        </button>

                        {ouvert && (
                          <div className="border-t bg-background px-3 pb-2 pl-10 pt-1">
                            <div className={`${GRILLE_MOUVEMENT} py-1 text-[10px] font-semibold uppercase text-muted-foreground`}>
                              <span>Date</span><span>Jnl</span><span>N° pièce</span><span>Libellé</span><span>Let.</span>
                              <span className="text-right">Débit</span><span className="text-right">Crédit</span>
                              <span className="text-right">Solde</span><span />
                            </div>
                            <div className={`${GRILLE_MOUVEMENT} border-b border-dashed py-1 text-xs text-muted-foreground`}>
                              <span>{debut ?? ""}</span><span /><span /><span className="italic">Solde initial / report</span><span />
                              <span className="text-right font-mono">{c.initialDebit ? fmt(c.initialDebit) : ""}</span>
                              <span className="text-right font-mono">{c.initialCredit ? fmt(c.initialCredit) : ""}</span>
                              <span className="text-right font-mono">{soldeTexte(c.soldeInitial)}</span><span />
                            </div>
                            {c.mouvements.map((m, i) => {
                              const cle = m.id ?? `${m.date_ecriture}-${m.reference_piece}`;
                              return (
                                <div key={m.id ?? i} className={`${GRILLE_MOUVEMENT} py-0.5 text-xs ${i % 2 ? "bg-muted/20" : ""}`}>
                                  <span className="font-mono">{m.date_ecriture.slice(0, 10)}</span>
                                  <span><Badge variant="outline" className="px-1 py-0 font-mono text-[10px]">{m.journal_code}</Badge></span>
                                  <span className="truncate font-mono text-[11px]" title={m.reference_piece ?? ""}>{m.reference_piece ?? "—"}</span>
                                  <span className="truncate" title={m.libelle ?? ""}>{m.libelle}</span>
                                  <span className="font-mono text-[10px]">{m.lettrage_code ?? ""}</span>
                                  <span className="text-right font-mono text-red-600">{m.debit ? fmt(m.debit) : ""}</span>
                                  <span className="text-right font-mono text-green-600">{m.credit ? fmt(m.credit) : ""}</span>
                                  <span className="text-right font-mono">{soldeTexte(m.solde)}</span>
                                  <Button variant="ghost" size="icon" className="h-6 w-6" title="Ouvrir la pièce source"
                                    disabled={ouverture === cle} onClick={() => ouvrirPiece(m)}>
                                    {ouverture === cle ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Paperclip className="h-3.5 w-3.5" />}
                                  </Button>
                                </div>
                              );
                            })}
                            <div className={`${GRILLE_MOUVEMENT} border-t py-1 text-xs font-semibold`}>
                              <span /><span /><span /><span>Total du compte · solde final</span><span />
                              <span className="text-right font-mono text-red-600">{fmt(c.totalDebit)}</span>
                              <span className="text-right font-mono text-green-600">{fmt(c.totalCredit)}</span>
                              <span className="text-right font-mono">{soldeTexte(c.soldeFinal)}</span><span />
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </Fragment>
              ))}
            </div>
          )}

          {/* Totaux des comptes affichés */}
          <div className={`${GRILLE_COMPTE} border-t-2 bg-muted px-3 py-2 text-sm font-bold`}>
            <span /><span>TOTAL</span><span className="text-xs font-normal text-muted-foreground">comptes affichés</span>
            <span className="text-right font-mono text-xs font-normal">{soldeTexte(gl.totaux.initialDebit - gl.totaux.initialCredit)}</span>
            <span className="text-right font-mono text-red-600">{fmt(gl.totaux.totalDebit)}</span>
            <span className="text-right font-mono text-green-600">{fmt(gl.totaux.totalCredit)}</span>
            <span className="text-right font-mono text-red-600">{fmt(gl.totaux.soldeDebiteur)}</span>
            <span className="text-right font-mono text-green-600">{fmt(gl.totaux.soldeCrediteur)}</span>
          </div>
        </div>
      </div>

      {/* Pièce comptable (repli quand aucun document n'est archivé) */}
      <Dialog open={!!piece} onOpenChange={(o) => { if (!o) setPiece(null); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader><DialogTitle>{piece?.titre}</DialogTitle></DialogHeader>
          <div className="overflow-x-auto rounded border">
            <table className="w-full text-xs">
              <thead className="bg-muted text-muted-foreground">
                <tr><th className="p-2 text-left">Compte</th><th className="p-2 text-left">Intitulé</th><th className="p-2 text-left">Libellé</th>
                  <th className="p-2 text-right">Débit</th><th className="p-2 text-right">Crédit</th></tr>
              </thead>
              <tbody>
                {(piece?.lignes ?? []).map((l, i) => (
                  <tr key={l.id ?? i} className="border-t">
                    <td className="p-2 font-mono">{l.compte_numero}</td>
                    <td className="p-2">{intitule(l.compte_numero)}</td>
                    <td className="p-2">{l.libelle}</td>
                    <td className="p-2 text-right font-mono text-red-600">{Number(l.debit) ? fmt(Number(l.debit)) : ""}</td>
                    <td className="p-2 text-right font-mono text-green-600">{Number(l.credit) ? fmt(Number(l.credit)) : ""}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-muted font-semibold">
                <tr>
                  <td className="p-2" colSpan={3}>Total de la pièce</td>
                  <td className="p-2 text-right font-mono">{fmt((piece?.lignes ?? []).reduce((s, l) => s + Number(l.debit || 0), 0))}</td>
                  <td className="p-2 text-right font-mono">{fmt((piece?.lignes ?? []).reduce((s, l) => s + Number(l.credit || 0), 0))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </DialogContent>
      </Dialog>

      <DocumentViewer open={!!docView} onOpenChange={(o) => { if (!o) setDocView(null); }} source={docView} />
    </div>
  );
}
