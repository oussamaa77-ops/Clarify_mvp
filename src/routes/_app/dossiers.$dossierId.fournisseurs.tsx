import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Plus, Upload, Loader2, CheckCircle, Building2, Inbox, AlertCircle,
  TrendingDown, Wallet, Sparkles, FileText, X, Trash2, BarChart2, Pencil, Undo2,
  Download, Wand2, Eye,
} from "lucide-react";
import { toast } from "sonner";
import { downloadSageTiers, nextCodeAuxiliaire } from "@/lib/sage-export";
import { useServerFn } from "@tanstack/react-start";
import { ocrFacture, matcherDocumentAvecTransactions } from "@/server/factures.functions";
import { memoriserTiers } from "@/server/tiers-memoire.functions";
import { annulerPaiementFacture } from "@/server/paiements.functions";
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart,
  Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { TiersReporting } from "@/components/TiersReporting";
import { BalanceAgee } from "@/components/BalanceAgee";
import { EcheancesInput, buildEcheancesPayload, type Echeance } from "@/components/EcheancesInput";
import { DocumentViewer, type DocumentViewerSource } from "@/components/DocumentViewer";
import { DocumentsAssocies } from "@/components/DocumentsAssocies";
import { logAudit } from "@/lib/audit";
import { puHtToTtc } from "@/lib/tva";
import {
  indexerModesPaiement, modePaiementFacture,
  MODE_PAIEMENT_LABEL, MODE_PAIEMENT_CLS, type ModePaiement,
} from "@/lib/mode-paiement";
import { Scale } from "lucide-react";

export const Route = createFileRoute("/_app/dossiers/$dossierId/fournisseurs")({
  component: FournisseursPage,
});

// ─── Types ────────────────────────────────────────────────────────────────────

interface FactureF {
  id: string;
  fournisseur_nom: string | null;
  fournisseur_id: string | null;
  numero: string | null;
  date_facture: string | null;
  date_echeance: string | null;
  date_paiement: string | null;
  montant_ht: number;
  montant_tva: number;
  montant_ttc: number;
  montant_paye: number;
  montant_restant: number;
  statut: string;
  statut_paiement: string;
  mode_reglement: string | null;
  fichier_original_url: string | null;
  fichier_original_nom: string | null;
  fichier_original_type: string | null;
  lignes?: any[] | null;
}

interface Fournisseur {
  id: string;
  nom: string;
  ice: string | null;
  if_fiscal: string | null;
  rc: string | null;
  email: string | null;
  telephone: string | null;
  adresse: string | null;
  code_auxiliaire: string | null;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const fmt = (n: number) =>
  Number(n).toLocaleString("fr-MA", { minimumFractionDigits: 2 }) + " MAD";
const MODES = ["virement", "cheque", "especes", "carte", "prelevement"];
const MONTHS_FR = ["Jan", "Fév", "Mar", "Avr", "Mai", "Jun", "Jul", "Aoû", "Sep", "Oct", "Nov", "Déc"];
const PIE_COLORS = ["#22c55e", "#f59e0b", "#ef4444"];

const TYPE_DOC_LBL: Record<string, string> = {
  recu: "Reçu", bon_commande: "Bon de commande", bon_livraison: "Bon de livraison",
  note_frais: "Note de frais", addition: "Addition", dum: "DUM / Import",
};
const CATEG_PCM_LBL: Record<string, string> = {
  paiement_fournisseur: "Achat fourn.", acompte_fournisseur: "Acompte BC",
  encaissement_client: "Encaiss. client", loyers: "Loyer", gasoil: "Carburant",
  frais_representation: "Restaurant", transport: "Transport", tva_import: "TVA import",
  charges_sociales: "Charges Sociales",
};

/**
 * Échéance d'une facture fournisseur. Le retard n'est signalé que s'il reste
 * effectivement quelque chose à régler — une facture soldée en retard de
 * paiement n'a plus à alerter.
 */
function EcheanceCell({ f }: { f: FactureF }) {
  if (!f.date_echeance) return <span className="text-muted-foreground text-sm">—</span>;
  const restant = Number(f.montant_restant ?? f.montant_ttc);
  const enRetard =
    f.statut_paiement !== "payee" && restant > 0 && new Date(f.date_echeance) < new Date();
  return (
    <span className={`text-sm ${enRetard ? "text-red-600 font-semibold" : ""}`}
      title={enRetard ? "Échéance dépassée" : undefined}>
      {new Date(f.date_echeance).toLocaleDateString("fr-MA")}
    </span>
  );
}

/**
 * Mode de règlement constaté d'une facture d'achat. Une facture non réglée n'en
 * a pas : la cellule reste vide plutôt que d'afficher le mode simplement PRÉVU
 * à la saisie (`mode_reglement`, pré-rempli à « virement »), qui laisserait
 * croire que le décaissement a eu lieu.
 */
function ModePaiementCell({ mode }: { mode: ModePaiement | null }) {
  if (!mode) return <span className="text-muted-foreground text-xs">—</span>;
  return (
    <span className={`text-[11px] px-2 py-0.5 rounded-full border font-medium ${MODE_PAIEMENT_CLS[mode]}`}>
      {MODE_PAIEMENT_LABEL[mode]}
    </span>
  );
}

function statutBadge(f: FactureF) {
  const restant = Number(f.montant_restant ?? f.montant_ttc);
  if (restant <= 0 || f.statut_paiement === "payee")
    return { label: "✅ Payée", cls: "bg-green-100 text-green-700" };
  if (f.date_echeance && new Date(f.date_echeance) < new Date())
    return { label: "⚠️ En retard", cls: "bg-red-100 text-red-700" };
  return { label: "⏳ En attente", cls: "bg-yellow-100 text-yellow-700" };
}

// ─── Component ───────────────────────────────────────────────────────────────

function FournisseursPage() {
  const { dossierId } = Route.useParams();
  const ocrFn   = useServerFn(ocrFacture);
  const matchFn = useServerFn(matcherDocumentAvecTransactions);
  const memoriserFn = useServerFn(memoriserTiers);
  const annulerPaiementFn = useServerFn(annulerPaiementFacture);

  const [tab, setTab] = useState<"factures" | "saisie" | "tiers" | "balance" | "reporting">("factures");
  const [justificatifsAchat, setJustificatifsAchat] = useState<any[]>([]);
  const [factures, setFactures] = useState<FactureF[]>([]);
  const [modes, setModes] = useState<Map<string, ModePaiement>>(new Map());
  const [fournisseurs, setFournisseurs] = useState<Fournisseur[]>([]);
  const [dossier, setDossier] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState<string | null>(null);

  // OCR
  const [ocrLoading, setOcrLoading] = useState(false);
  const [pdfPreviewUrl, setPdfPreviewUrl] = useState<string | null>(null);
  const [previewFileType, setPreviewFileType] = useState<string | null>(null);
  // Fichier scanné en cours — conservé pour être archivé (bucket) à l'enregistrement,
  // afin de pouvoir le RE-consulter ensuite (aperçu GED / bouton Voir).
  const [scanFile, setScanFile] = useState<File | null>(null);
  const [docView, setDocView] = useState<DocumentViewerSource | null>(null);
  // Facture affichée en détail quand aucun fichier original n'est archivé.
  const [factureDetail, setFactureDetail] = useState<FactureF | null>(null);
  const [pdfPages, setPdfPages] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  // Form fields
  const [fournisseurId, setFournisseurId] = useState("");
  const [fournisseurNom, setFournisseurNom] = useState("");
  const [fournisseurIce, setFournisseurIce] = useState("");
  const [numero, setNumero] = useState("");
  const [dateFacture, setDateFacture] = useState(new Date().toISOString().slice(0, 10));
  const [dateEcheance, setDateEcheance] = useState("");
  const [montantHt, setMontantHt] = useState(0);
  const [montantTva, setMontantTva] = useState(0);
  const [montantTtc, setMontantTtc] = useState(0);
  const [modeReglement, setModeReglement] = useState("virement");
  const [lignes, setLignes] = useState<any[]>([
    { designation: "", quantite: 1, prix_unitaire: 0, taux_tva: 20 },
  ]);
  const [echeances, setEcheances] = useState<Echeance[]>([]);
  // Annotations manuscrites lues par l'OCR vision (Payé, visa, n° chèque…).
  const [notesManuscrites, setNotesManuscrites] = useState<string | null>(null);

  // New supplier pending creation (deferred until save)
  const [newFournPending, setNewFournPending] = useState<{ nom: string; ice: string } | null>(null);

  // Delete confirmation
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [annulConfirm, setAnnulConfirm] = useState<FactureF | null>(null);
  const [annulLoading, setAnnulLoading] = useState(false);

  // Supplier stats panel
  const [selectedFourn, setSelectedFourn] = useState<Fournisseur | null>(null);
  const [fournDetailTab, setFournDetailTab] = useState<"kpis" | "factures" | "justificatifs">("kpis");
  const [facturesFourn, setFacturesFourn] = useState<FactureF[]>([]);
  const [facturesFournLoading, setFacturesFournLoading] = useState(false);

  // New supplier modal (manual)
  const [openFourn, setOpenFourn] = useState(false);
  const [formFourn, setFormFourn] = useState({ nom: "", ice: "", if_fiscal: "", rc: "", email: "", telephone: "", adresse: "", code_auxiliaire: "" });

  // Edit supplier modal
  const [editFourn, setEditFourn] = useState<Fournisseur | null>(null);
  const [formEdit, setFormEdit] = useState({ nom: "", ice: "", if_fiscal: "", rc: "", email: "", telephone: "", adresse: "", code_auxiliaire: "" });
  const openEditDialog = (f: Fournisseur, e: React.MouseEvent) => {
    e.stopPropagation();
    setFormEdit({ nom: f.nom, ice: f.ice??"", if_fiscal: f.if_fiscal??"", rc: f.rc??"", email: f.email??"", telephone: f.telephone??"", adresse: f.adresse??"", code_auxiliaire: f.code_auxiliaire??"" });
    setEditFourn(f);
  };

  // ── Data loading ────────────────────────────────────────────────────────────

  const load = async () => {
    setLoading(true);
    // Les deux dernières requêtes portent les PIÈCES de règlement (ligne de relevé
    // lettrée, décaissement saisi) : c'est d'elles que se déduit le mode de paiement
    // réellement constaté — cf. src/lib/mode-paiement.ts.
    const [{ data: ff }, { data: fs }, { data: dos }, { data: jj }, { data: tx }, { data: enc }] =
      await Promise.all([
      (supabase.from("factures_fournisseurs") as any)
        .select("*")
        .eq("dossier_id", dossierId)
        .order("created_at", { ascending: false }),
      supabase.from("fournisseurs").select("*").eq("dossier_id", dossierId).order("nom"),
      (supabase.from("dossiers") as any).select("nom_societe,ice").eq("id", dossierId).single(),
      (supabase.from("justificatifs") as any)
        .select("*")
        .eq("dossier_id", dossierId)
        .eq("flux_type", "achat")
        .order("created_at", { ascending: false }),
      (supabase.from("transactions_bancaires") as any)
        .select("facture_id,document_type,libelle,reference")
        .eq("dossier_id", dossierId).not("facture_id", "is", null),
      (supabase.from("encaissements") as any)
        .select("facture_fournisseur_id,type")
        .eq("dossier_id", dossierId).not("facture_fournisseur_id", "is", null),
    ]);
    setFactures((ff ?? []) as FactureF[]);
    setFournisseurs((fs ?? []) as Fournisseur[]);
    setDossier(dos);
    setJustificatifsAchat(jj ?? []);
    setModes(indexerModesPaiement("fournisseur", { transactions: tx ?? [], encaissements: enc ?? [] }));
    setLoading(false);
  };

  const loadFacturesFourn = async (fId: string) => {
    setFacturesFournLoading(true);
    const { data } = await (supabase.from("factures_fournisseurs") as any)
      .select("*")
      .eq("dossier_id", dossierId)
      .eq("fournisseur_id", fId)
      .order("date_facture", { ascending: false });
    setFacturesFourn((data ?? []) as FactureF[]);
    setFacturesFournLoading(false);
  };

  useEffect(() => { load(); }, [dossierId]);

  useEffect(() => {
    if (selectedFourn) loadFacturesFourn(selectedFourn.id);
    else setFacturesFourn([]);
  }, [selectedFourn?.id]);

  // Recalculate totals when lines change
  useEffect(() => {
    const ht = lignes.reduce((s, l) => s + l.quantite * l.prix_unitaire, 0);
    const tva = lignes.reduce((s, l) => s + (l.quantite * l.prix_unitaire * l.taux_tva) / 100, 0);
    setMontantHt(Math.round(ht * 100) / 100);
    setMontantTva(Math.round(tva * 100) / 100);
    setMontantTtc(Math.round((ht + tva) * 100) / 100);
  }, [lignes]);

  // ── Supplier stats KPIs ─────────────────────────────────────────────────────

  const kpisFourn = useMemo(() => {
    const today = new Date();
    const total_ttc = facturesFourn.reduce((s, f) => s + Number(f.montant_ttc), 0);
    const dettes = facturesFourn
      .filter((f) => f.statut_paiement !== "payee")
      .reduce((s, f) => s + Number(f.montant_restant ?? f.montant_ttc), 0);
    const total = facturesFourn.length;
    const payees = facturesFourn.filter((f) => f.statut_paiement === "payee").length;
    const en_retard = facturesFourn.filter(
      (f) =>
        f.statut_paiement !== "payee" &&
        f.date_echeance &&
        new Date(f.date_echeance) < today &&
        Number(f.montant_restant ?? f.montant_ttc) > 0,
    ).length;
    const en_attente = total - payees - en_retard;

    const paidFacs = facturesFourn.filter((f) => f.statut_paiement === "payee" && f.date_facture);
    const delaiMoyen: number | null =
      paidFacs.length > 0
        ? Math.round(
            paidFacs.reduce((s, f) => {
              const debut = new Date(f.date_facture!);
              const fin = f.date_paiement
                ? new Date(f.date_paiement)
                : f.date_echeance
                  ? new Date(f.date_echeance)
                  : debut;
              return s + Math.max(0, (fin.getTime() - debut.getTime()) / 86400000);
            }, 0) / paidFacs.length,
          )
        : null;

    return { total_ttc, dettes, total, payees, en_attente, en_retard, delaiMoyen };
  }, [facturesFourn]);

  const barDataFourn = useMemo(() => {
    const now = new Date();
    const months: Record<string, number> = {};
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months[`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`] = 0;
    }
    for (const f of facturesFourn) {
      if (!f.date_facture) continue;
      const k = f.date_facture.slice(0, 7);
      if (k in months) months[k] += Number(f.montant_ttc);
    }
    return Object.entries(months).map(([k, v]) => ({
      mois: MONTHS_FR[parseInt(k.split("-")[1]) - 1],
      achats: Math.round(v),
    }));
  }, [facturesFourn]);

  const pieDataFourn = useMemo(
    () =>
      [
        { name: "Payées", value: kpisFourn.payees },
        { name: "En attente", value: kpisFourn.en_attente },
        { name: "En retard", value: kpisFourn.en_retard },
      ].filter((d) => d.value > 0),
    [kpisFourn],
  );

  const lineDataFourn = useMemo(() => {
    const now = new Date();
    const months: Record<string, number> = {};
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months[`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`] = 0;
    }
    for (const f of facturesFourn) {
      if (!f.date_facture || f.statut_paiement === "payee") continue;
      const k = f.date_facture.slice(0, 7);
      if (k in months) months[k] += Number(f.montant_restant ?? f.montant_ttc);
    }
    return Object.entries(months).map(([k, v]) => ({
      mois: MONTHS_FR[parseInt(k.split("-")[1]) - 1],
      dettes: Math.round(v),
    }));
  }, [facturesFourn]);

  // Justificatifs du fournisseur sélectionné (filtre local sur nom_tiers)
  const justifsFourn = useMemo(() => {
    if (!selectedFourn) return [];
    const nameKey = selectedFourn.nom.toLowerCase().trim().slice(0, 10);
    return justificatifsAchat.filter(j => {
      const tiers = (j.nom_tiers ?? "").toLowerCase().trim();
      return tiers.includes(nameKey) || (tiers.length >= 5 && nameKey.includes(tiers.slice(0, 10)));
    });
  }, [justificatifsAchat, selectedFourn?.nom]);

  const kpisJustifsFourn = useMemo(() => {
    const total = justifsFourn.length;
    const totalTtc = justifsFourn.reduce((s, j) => s + Number(j.montant_ttc || 0), 0);
    const byType: Record<string, number> = {};
    const byCateg: Record<string, number> = {};
    let ediCount = 0;
    for (const j of justifsFourn) {
      if (j.type_document) byType[j.type_document] = (byType[j.type_document] ?? 0) + 1;
      if (j.categorie_pcm) byCateg[j.categorie_pcm] = (byCateg[j.categorie_pcm] ?? 0) + 1;
      if (j.eligible_edi) ediCount++;
    }
    return { total, totalTtc, byType, byCateg, ediCount };
  }, [justifsFourn]);

  // ── OCR ────────────────────────────────────────────────────────────────────

  const handleOcr = async (file: File) => {
    resetForm(true);
    setScanFile(file);
    setPdfPreviewUrl(URL.createObjectURL(file));
    setPreviewFileType(file.type);
    setTab("saisie");
    setOcrLoading(true);
    try {
      let extracted_text = "";
      let image_base64: string | undefined;
      let mime_type = file.type;

      if (file.type === "application/pdf") {
        // PDF → extraire texte ET rendre chaque page en canvas (évite l'iframe/download)
        const pdfjsLib = await import("pdfjs-dist");
        pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
        const ab = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: ab }).promise;
        let text = "";
        const pages: string[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          // Extraction texte
          const content = await page.getTextContent();
          const items = content.items as any[];
          let lastY = -1, line = "";
          for (const item of items) {
            const y = Math.round(item.transform[5]);
            if (lastY !== -1 && Math.abs(y - lastY) > 3) {
              text += line.trimEnd() + "\n";
              line = "";
            }
            line += item.str + " ";
            lastY = y;
          }
          if (line.trim()) text += line.trimEnd() + "\n";
          // Rendu visuel de la page en canvas → image
          const viewport = page.getViewport({ scale: 2.0 });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const ctx = canvas.getContext("2d")!;
          await page.render({ canvasContext: ctx, viewport }).promise;
          pages.push(canvas.toDataURL("image/jpeg", 0.85));
        }
        extracted_text = text;
        setPdfPages(pages);
        // PDF scanné : texte insuffisant → image JPEG page 1 (OCR vision)
        if (extracted_text.replace(/\s/g, "").length < 300 || /camscanner/i.test(extracted_text)) {
          const dataUrl = pages[0] ?? "";
          image_base64 = dataUrl.split(",")[1] || "";
          mime_type = "image/jpeg";
          extracted_text = "";
        }
      } else {
        // Image (JPG/PNG) → envoyer en base64 au modèle vision du backend
        const ab = await file.arrayBuffer();
        const bytes = new Uint8Array(ab);
        let bin = "";
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        image_base64 = btoa(bin);
      }

      const { result: r } = await ocrFn({
        data: { extracted_text, image_base64, mime_type, dossier_id: dossierId, sens_hint: "fournisseur" },
      });
      logAudit({ dossierId, action: "scan_facture", ressourceType: "facture_fournisseur", details: { numero: r.numero_facture ?? null, fournisseur: r.emetteur_nom ?? null } });

      // emNom = émetteur UNIQUEMENT (jamais fallback sur client_nom_extrait
      // qui est le nom du destinataire, pas du fournisseur)
      const emNom = (r.emetteur_nom || "").trim();
      const emIce = (r.emetteur_ice || "").trim();

      if (r.numero_facture) setNumero(r.numero_facture);
      if (r.date_facture) setDateFacture(r.date_facture);
      if (r.date_echeance) setDateEcheance(r.date_echeance);
      if (r.montant_ht) setMontantHt(r.montant_ht);
      if (r.montant_tva) setMontantTva(r.montant_tva);
      if (r.montant_ttc) setMontantTtc(r.montant_ttc);
      if (r.mode_reglement) setModeReglement(r.mode_reglement);
      setNotesManuscrites(r.notes_manuscrites ?? null);
      if (r.lignes?.length) {
        setLignes(
          r.lignes.map((l: any) => ({
            designation: l.designation,
            quantite: l.quantite,
            prix_unitaire: l.prix_unitaire,
            // POC mémoire : le taux TVA appris du fournisseur fait autorité.
            taux_tva: r.memoire?.taux_tva != null ? Number(r.memoire.taux_tva) : l.taux_tva,
          })),
        );
      }

      // POC mémoire : rappel du fournisseur connu (classification réutilisée).
      if (r.memoire) {
        toast.success(
          r.memoire.llm_court_circuite
            ? `Fournisseur reconnu en mémoire (${r.memoire.occurrences} usage(s)) — classification rappelée, IA non appelée`
            : `Fournisseur déjà vu (${r.memoire.occurrences} usage(s)) — TVA/compte rappelés depuis la mémoire`,
        );
      }

      // Résolution fournisseur — le backend fait autorité
      if (r.fournisseur_id) {
        // Backend a trouvé un fournisseur existant (par ICE exact ou nom ilike)
        // → utiliser les données DB (fournisseur_trouve), pas les données OCR
        const ft = r.fournisseur_trouve as { nom: string; ice?: string | null } | null;
        setFournisseurId(r.fournisseur_id);
        setFournisseurNom(ft?.nom ?? emNom);
        setFournisseurIce(ft?.ice ?? emIce);
        setNewFournPending(null);
      } else if (r.sens_facture === "fournisseur" && emNom) {
        // Backend a cherché en DB (ICE + ilike 20 chars) et n'a rien trouvé
        // → nouveau fournisseur confirmé, pas de recherche locale supplémentaire
        setFournisseurId("");
        setFournisseurNom(emNom);
        setFournisseurIce(emIce);
        setNewFournPending({ nom: emNom, ice: emIce });
      } else if ((emNom || emIce) && r.sens_facture !== "client") {
        // sens_facture inconnu → seul match ICE exact acceptable (pas de fuzzy name)
        const found = emIce ? fournisseurs.find((f) => f.ice === emIce) : undefined;
        if (found) {
          setFournisseurId(found.id);
          setFournisseurNom(found.nom);
          setFournisseurIce(found.ice ?? "");
          setNewFournPending(null);
        } else {
          setFournisseurId("");
          if (emNom) setFournisseurNom(emNom);
          if (emIce) setFournisseurIce(emIce);
          if (emNom) setNewFournPending({ nom: emNom, ice: emIce });
        }
      }

      const methodLabel =
        r.method === "ai" ? "IA Groq"
        : r.method === "cache" ? "cache document (LLM évité)"
        : r.method === "memoire" ? "mémoire tiers (LLM évité)"
        : "regex";
      const confLabel = r.confidence === "high" ? "haute" : r.confidence === "medium" ? "moyenne" : "faible";
      toast.success(`OCR terminé (${methodLabel} · confiance ${confLabel}) — vérifiez les données`);
    } catch (e: any) {
      toast.error("Erreur OCR: " + e.message);
    } finally {
      setOcrLoading(false);
    }
  };

  // ── Save invoice ───────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!fournisseurNom && !fournisseurId && !newFournPending) {
      return toast.error("Sélectionnez ou saisissez un fournisseur");
    }
    if (!montantTtc) return toast.error("Montant TTC requis");
    // Échéances de paiement partiel (format backend /api/reconciliation/partial-payments).
    // Vide = paiement non fractionné (montant total TTC dû en une fois).
    const echeancesPayload = buildEcheancesPayload(echeances);
    const totalEcheances = echeancesPayload.reduce((s, e) => s + e.montant_attendu, 0);
    if (totalEcheances - montantTtc > 0.01)
      return toast.error("La somme des tranches dépasse le montant TTC de la facture");
    setProcessing("save");
    try {
      // Create supplier if pending (new one detected by OCR or typed manually)
      let fId = fournisseurId;
      let nomFourn = fournisseurNom;

      if (!fId && (newFournPending || fournisseurNom)) {
        const nomToCreate = newFournPending?.nom ?? fournisseurNom;
        const iceToCreate = newFournPending?.ice ?? fournisseurIce ?? null;
        const { data: nouveau, error: errF } = await supabase
          .from("fournisseurs")
          .insert({ dossier_id: dossierId, nom: nomToCreate, ice: iceToCreate || null })
          .select("id,nom")
          .single();
        if (errF) throw errF;
        if (nouveau) {
          fId = (nouveau as any).id;
          nomFourn = (nouveau as any).nom;
          setNewFournPending(null);
        }
      } else if (fId) {
        nomFourn = fournisseurs.find((f) => f.id === fId)?.nom ?? fournisseurNom;
      }

      // Insert invoice and get its ID for accounting reference
      const { data: newFacture, error: errFact } = await (
        supabase.from("factures_fournisseurs") as any
      )
        .insert({
          dossier_id: dossierId,
          fournisseur_id: fId || null,
          fournisseur_nom: nomFourn,
          numero: numero || null,
          date_facture: dateFacture,
          date_echeance: dateEcheance || null,
          montant_ht: montantHt,
          montant_tva: montantTva,
          montant_ttc: montantTtc,
          montant_paye: 0,
          montant_restant: montantTtc,
          statut: "recue",
          statut_paiement: "non_payee",
          mode_reglement: modeReglement,
          lignes: lignes,
          echeances: echeancesPayload,
          // Métadonnées OCR conservées pour le détail (annotations manuscrites lues
          // sur le document : « Payé », visa, n° de chèque…). Colonne JSONB existante.
          ocr_data: notesManuscrites ? { notes_manuscrites: notesManuscrites } : null,
        })
        .select("id")
        .single();
      if (errFact) throw errFact;

      const factureId = (newFacture as any).id;
      const ref = numero || nomFourn;

      // Archive le document scanné (pour re-consultation ultérieure : bouton Voir + GED).
      if (scanFile) {
        try {
          const ext = scanFile.name.split(".").pop() || "bin";
          const path = `${dossierId}/ff_${factureId}.${ext}`;
          const { error: upErr } = await supabase.storage.from("factures-originales").upload(path, scanFile, { upsert: true });
          if (upErr) throw upErr;
          const { data: urlData } = supabase.storage.from("factures-originales").getPublicUrl(path);
          await (supabase.from("factures_fournisseurs") as any).update({
            fichier_original_url: urlData?.publicUrl ?? null,
            fichier_original_nom: scanFile.name,
            fichier_original_type: scanFile.type,
          }).eq("id", factureId);
        } catch (e: any) {
          // Archivage best-effort : la facture reste enregistrée. Mais on le DIT,
          // sinon le bouton « Voir » n'ouvrira jamais l'original sans qu'on sache
          // pourquoi (c'est ce silence qui a masqué l'absence de tout scan archivé).
          console.error("Archivage du scan échoué", e);
          toast.warning("Facture enregistrée, mais le scan n'a pas pu être archivé — le bouton « Voir » affichera le détail saisi.");
        }
      }

      // Accounting entries ACH — reference_piece = factureId for clean cascade delete
      await supabase.from("ecritures_comptables").insert([
        {
          dossier_id: dossierId,
          journal_code: "ACH",
          compte_numero: "6141",
          date_ecriture: dateFacture,
          libelle: `Achat ${nomFourn} ${ref}`,
          debit: montantHt,
          credit: 0,
          valide: true,
          reference_piece: factureId,
        },
        {
          dossier_id: dossierId,
          journal_code: "ACH",
          compte_numero: "34552",
          date_ecriture: dateFacture,
          libelle: `TVA ${nomFourn} ${ref}`,
          debit: montantTva,
          credit: 0,
          valide: true,
          reference_piece: factureId,
        },
        {
          dossier_id: dossierId,
          journal_code: "ACH",
          compte_numero: "4411",
          date_ecriture: dateFacture,
          libelle: `Dette ${nomFourn} ${ref}`,
          debit: 0,
          credit: montantTtc,
          valide: true,
          reference_piece: factureId,
        },
      ]);

      toast.success("Facture fournisseur enregistrée ✅");

      // ── POC MÉMOIRE (point 1) : apprendre la classification de ce fournisseur ──
      // À CHAQUE validation, on mémorise {ICE/libellé → compte 6141 + taux TVA},
      // occurrences++. Prochain scan du même fournisseur → rappel avant le LLM.
      const tauxDominant = Number(lignes[0]?.taux_tva ?? 20);
      memoriserFn({ data: {
        dossier_id: dossierId, sens: "fournisseur",
        ice: fournisseurIce || null, nom: nomFourn,
        fournisseur_id: fId || null, compte_pcm: "6141",
        categorie_pcm: null, taux_tva: tauxDominant,
      }}).then((res) => {
        if (res.ok) console.log(`[mémoire] ${nomFourn} → ${res.occurrences} usage(s)`);
      }).catch(() => {});

      resetForm();
      load();
      setTab("factures");
      // Matcher automatique avec une transaction bancaire ouverte
      matchFn({ data: {
        dossier_id: dossierId, document_id: factureId, document_type: "facture_fournisseur",
        montant_ttc: montantTtc, nom_tiers: nomFourn, date_document: dateFacture, mode_reglement: modeReglement ?? "",
        numero_piece: numero || "",
      }}).then(res => {
        if (res.match) toast.success(`✅ Lié automatiquement à la transaction du ${res.tx_date} — ${res.tx_montant} MAD`);
      }).catch(() => {});
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setProcessing(null);
    }
  };

  // ── Delete invoice ─────────────────────────────────────────────────────────

  // Une facture payée ne se supprime pas : il faut d'abord annuler son paiement,
  // sinon on laisserait des écritures de règlement et une transaction bancaire
  // lettrée pointant sur une facture disparue.
  const estPayee = (f: FactureF) => f.statut_paiement !== "non_payee";

  const handleDelete = async () => {
    if (!deleteId) return;
    // La facture peut venir du tableau global ou du détail d'un fournisseur.
    const f = factures.find((x) => x.id === deleteId) ?? facturesFourn.find((x) => x.id === deleteId);
    if (f && estPayee(f)) { toast.error("Annulez d'abord le paiement de cette facture"); return; }
    setDeleteLoading(true);
    try {
      // 1. Écritures rattachées par reference_piece (achat ACH + règlements estampillés).
      await supabase
        .from("ecritures_comptables")
        .delete()
        .eq("dossier_id", dossierId)
        .eq("reference_piece", deleteId);

      // 2. Écritures ACH HISTORIQUES : créées avant que reference_piece ne soit posé,
      //    elles resteraient orphelines après la suppression de la facture. On les
      //    retrouve par date + nom du fournisseur (présent dans le libellé) + montant,
      //    et on n'en supprime une que si le rapprochement est SANS AMBIGUÏTÉ.
      const restantes = f ? await supprimerAchHistoriques(f) : 0;

      // 3. Filet de sécurité : une transaction de relevé est un fait bancaire. Si une
      //    subsistait liée à cette facture, on la DÉLIE — on ne la supprime jamais.
      await (supabase.from("transactions_bancaires") as any)
        .update({ facture_id: null, document_type: null, rapproche: false })
        .eq("facture_id", deleteId);

      // 4. Remove the invoice itself
      const { error } = await (supabase.from("factures_fournisseurs") as any)
        .delete()
        .eq("id", deleteId);
      if (error) throw error;

      toast.success("Facture supprimée — écritures comptables effacées");
      if (restantes > 0)
        toast.warning(`${restantes} écriture(s) ACH ambiguë(s) conservée(s) — à vérifier en Comptabilité`);
      setDeleteId(null);
      load();
      if (selectedFourn) loadFacturesFourn(selectedFourn.id);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setDeleteLoading(false);
    }
  };

  // Supprime les écritures ACH d'une facture qui ne portent pas encore reference_piece
  // (lignes créées avant l'estampillage). Le rapprochement se fait sur (date du document,
  // nom du fournisseur repris dans le libellé) — pas sur les montants, qui échouent dès
  // que la TVA vaut 0 (la ligne de TVA a alors un débit nul, comme la ligne de dette).
  //
  // Si une AUTRE facture du même fournisseur porte la même date, le rapprochement est
  // ambigu : on ne supprime rien et on le signale. Mieux vaut une écriture à vérifier
  // qu'une écriture d'une autre facture détruite par erreur. La migration de rattrapage
  // (20260709120000) supprime ce cas à la racine en posant reference_piece.
  const supprimerAchHistoriques = async (f: FactureF): Promise<number> => {
    if (!f.date_facture || !f.fournisseur_nom) return 0;
    const { data: cand } = await supabase
      .from("ecritures_comptables")
      .select("id,libelle")
      .eq("dossier_id", dossierId)
      .eq("journal_code", "ACH")
      .eq("date_ecriture", f.date_facture)
      .is("reference_piece", null);

    const nom = f.fournisseur_nom.toUpperCase();
    const cibles = (cand ?? []).filter((e: any) => String(e.libelle ?? "").toUpperCase().includes(nom));
    if (!cibles.length) return 0;

    const homonymes = factures.filter(
      (x) => x.id !== f.id && x.date_facture === f.date_facture && x.fournisseur_nom === f.fournisseur_nom,
    );
    if (homonymes.length) return cibles.length;   // ambigu → on ne touche à rien

    await supabase.from("ecritures_comptables").delete().in("id", cibles.map((e: any) => e.id));
    return 0;
  };

  const handleAnnulerPaiement = async (f: FactureF) => {
    setAnnulLoading(true);
    try {
      const r = await annulerPaiementFn({ data: { facture_id: f.id, type: "fournisseur" } });
      if (r.dejaImpayee) toast.info("Cette facture est déjà impayée");
      else {
        const parts = [
          r.txDeliees && `${r.txDeliees} ligne${r.txDeliees > 1 ? "s" : ""} de relevé remise${r.txDeliees > 1 ? "s" : ""} « à lettrer »`,
          r.encaissementsSupprimes && `${r.encaissementsSupprimes} décaissement${r.encaissementsSupprimes > 1 ? "s" : ""} supprimé${r.encaissementsSupprimes > 1 ? "s" : ""}`,
          r.ecrituresSupprimees && `${r.ecrituresSupprimees} écriture${r.ecrituresSupprimees > 1 ? "s" : ""} de règlement supprimée${r.ecrituresSupprimees > 1 ? "s" : ""}`,
        ].filter(Boolean);
        toast.success(`Paiement annulé — facture impayée${parts.length ? ` (${parts.join(", ")})` : ""}`);
      }
      setAnnulConfirm(null);
      load();
      if (selectedFourn) loadFacturesFourn(selectedFourn.id);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setAnnulLoading(false);
    }
  };

  const resetForm = (keepPreview = false) => {
    setFournisseurId("");
    setFournisseurNom("");
    setFournisseurIce("");
    setNumero("");
    setDateFacture(new Date().toISOString().slice(0, 10));
    setDateEcheance("");
    setMontantHt(0);
    setMontantTva(0);
    setMontantTtc(0);
    setModeReglement("virement");
    if (!keepPreview) { setPdfPreviewUrl(null); setPreviewFileType(null); setPdfPages([]); }
    // Le fichier scanné meurt avec le formulaire. Sans cette ligne il survivait à
    // l'enregistrement : une saisie MANUELLE enchaînée après un scan archivait le
    // PDF de la facture précédente sur la nouvelle — un document faux, attaché
    // silencieusement. handleOcr rappelle setScanFile juste après son resetForm(true).
    setScanFile(null);
    setNewFournPending(null);
    setLignes([{ designation: "", quantite: 1, prix_unitaire: 0, taux_tva: 20 }]);
    setEcheances([]);
    setNotesManuscrites(null);
  };

  // ── Global KPIs ────────────────────────────────────────────────────────────

  const dettes = factures
    .filter((f) => f.statut_paiement !== "payee")
    .reduce((s, f) => s + Number(f.montant_restant ?? f.montant_ttc), 0);
  const depenses = factures
    .filter((f) => f.statut_paiement !== "payee")
    .reduce((s, f) => s + Number(f.montant_ht), 0);
  const enAttente = factures.filter((f) => f.statut_paiement !== "payee").length;

  const isPanelOpen = !!selectedFourn;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">Factures fournisseurs</h1>
          <p className="text-muted-foreground mt-1">
            Import OCR · Saisie manuelle · Comptabilisation automatique
          </p>
        </div>
        <div className="flex gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.jpg,.jpeg,.png"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleOcr(f); }}
          />
          <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={ocrLoading}>
            {ocrLoading
              ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              : <Sparkles className="h-4 w-4 mr-2" />}
            Scanner facture (OCR)
          </Button>
          <Button onClick={() => { resetForm(); setTab("saisie"); }}>
            <Plus className="h-4 w-4 mr-2" />Saisie manuelle
          </Button>
          <Button variant="ghost" onClick={() => setOpenFourn(true)}>
            <Building2 className="h-4 w-4 mr-1" />Fournisseur
          </Button>
          <Button variant="outline" onClick={() => {
            if (!fournisseurs.length) return toast.info("Aucun fournisseur à exporter");
            downloadSageTiers(fournisseurs, "fournisseur", dossierId);
            toast.success("Export Sage fournisseurs généré");
          }}>
            <Download className="h-4 w-4 mr-1" />Export Sage
          </Button>
        </div>
      </div>

      {/* Global KPIs */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {[
          { label: "Dettes fournisseurs", value: fmt(dettes), icon: Wallet, color: "text-red-600" },
          { label: "Achats HT en attente", value: fmt(depenses), icon: TrendingDown, color: "text-orange-600" },
          { label: "Factures non payées", value: String(enAttente), icon: AlertCircle, color: "text-yellow-600" },
        ].map((k) => (
          <Card key={k.label}>
            <CardContent className="pt-4 pb-4 flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">{k.label}</p>
                <p className={`text-xl font-bold mt-1 ${k.color}`}>{k.value}</p>
              </div>
              <k.icon className={`h-8 w-8 ${k.color} opacity-30`} />
            </CardContent>
          </Card>
        ))}
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
        <TabsList>
          <TabsTrigger value="factures">Factures ({factures.length})</TabsTrigger>
          <TabsTrigger value="saisie">
            {ocrLoading
              ? <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              : <FileText className="h-3 w-3 mr-1" />}
            Saisie / OCR
          </TabsTrigger>
          <TabsTrigger value="tiers">
            <Building2 className="h-3 w-3 mr-1" />
            Fournisseurs ({fournisseurs.length})
          </TabsTrigger>
          <TabsTrigger value="balance">
            <Scale className="h-3 w-3 mr-1" />
            Balance âgée
          </TabsTrigger>
          <TabsTrigger value="reporting">
            <BarChart2 className="h-3 w-3 mr-1" />
            Reporting
          </TabsTrigger>
        </TabsList>

        {/* ── Liste factures ── */}
        <TabsContent value="factures" className="mt-4">
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Fournisseur</TableHead>
                    <TableHead>N°</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Échéance</TableHead>
                    <TableHead className="text-right">HT</TableHead>
                    <TableHead className="text-right">TTC</TableHead>
                    <TableHead className="text-right">Restant</TableHead>
                    <TableHead>Statut</TableHead>
                    <TableHead>Mode de paiement</TableHead>
                    <TableHead className="w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    <TableRow>
                      <TableCell colSpan={10} className="text-center py-8">
                        <Loader2 className="h-5 w-5 animate-spin mx-auto" />
                      </TableCell>
                    </TableRow>
                  ) : factures.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={10} className="text-center py-12 text-muted-foreground">
                        <Inbox className="h-8 w-8 mx-auto mb-2 opacity-30" />
                        Aucune facture — scannez un PDF ou faites une saisie manuelle
                      </TableCell>
                    </TableRow>
                  ) : (
                    factures.map((f) => {
                      const s = statutBadge(f);
                      return (
                        <TableRow key={f.id}>
                          <TableCell className="font-medium">{f.fournisseur_nom}</TableCell>
                          <TableCell className="font-mono text-xs">{f.numero ?? "—"}</TableCell>
                          <TableCell className="text-sm">
                            {f.date_facture
                              ? new Date(f.date_facture).toLocaleDateString("fr-MA")
                              : "—"}
                          </TableCell>
                          <TableCell><EcheanceCell f={f} /></TableCell>
                          <TableCell className="font-mono text-sm text-right">
                            {fmt(Number(f.montant_ht))}
                          </TableCell>
                          <TableCell className="font-mono text-sm text-right font-medium">
                            {fmt(Number(f.montant_ttc))}
                          </TableCell>
                          <TableCell className="font-mono text-sm text-right text-red-600">
                            {f.statut_paiement !== "payee"
                              ? fmt(Number(f.montant_restant ?? f.montant_ttc))
                              : "—"}
                          </TableCell>
                          <TableCell>
                            <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${s.cls}`}>
                              {s.label}
                            </span>
                          </TableCell>
                          <TableCell><ModePaiementCell mode={modePaiementFacture(f, modes)} /></TableCell>
                          <TableCell>
                            <div className="flex gap-1">
                              {/* Deux lectures distinctes, comme côté clients :
                                  • le DÉTAIL de la facture telle qu'enregistrée — toujours
                                    disponible, y compris sur une saisie manuelle ;
                                  • le DOCUMENT ORIGINAL — seulement si un scan est archivé
                                    (les factures antérieures à l'archivage n'en ont pas). */}
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-7 w-7"
                                onClick={() => setFactureDetail(f)}
                                title="Voir le détail de la facture"
                              >
                                <Eye className="h-3.5 w-3.5" />
                              </Button>
                              {/* TOUJOURS rendu, désactivé quand rien n'est archivé : un
                                  bouton conditionnel disparaîtrait ici pour TOUTES les
                                  factures antérieures à l'archivage du scan, et passerait
                                  pour une fonction absente. Le panneau d'aperçu offre le
                                  téléchargement et l'ouverture dans un onglet. */}
                              <Button
                                size="icon"
                                variant="ghost"
                                disabled={!f.fichier_original_url}
                                className="h-7 w-7"
                                onClick={() => setDocView({ title: `Facture ${f.numero ?? ""}`.trim(), url: f.fichier_original_url, fileName: f.fichier_original_nom, mimeType: f.fichier_original_type })}
                                title={f.fichier_original_url
                                  ? "Voir / télécharger le document original"
                                  : "Aucun document original archivé — rescannez la facture pour l'attacher"}
                              >
                                <FileText className="h-3.5 w-3.5" />
                              </Button>
                              {/* Annuler le paiement : actif seulement si la facture est payée. */}
                              <Button
                                size="icon"
                                variant="ghost"
                                disabled={!estPayee(f)}
                                className="h-7 w-7 text-amber-600 hover:bg-amber-500/10"
                                onClick={() => setAnnulConfirm(f)}
                                title={estPayee(f) ? "Annuler le paiement" : "Déjà impayée"}
                              >
                                <Undo2 className="h-3.5 w-3.5" />
                              </Button>
                              {/* Supprimer : bloqué tant que la facture est payée. */}
                              <Button
                                size="icon"
                                variant="ghost"
                                disabled={estPayee(f)}
                                className="h-7 w-7 text-destructive hover:bg-destructive/10"
                                onClick={() => setDeleteId(f.id)}
                                title={estPayee(f) ? "Annulez d'abord le paiement" : "Supprimer la facture"}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Saisie / OCR ── */}
        <TabsContent value="saisie" className="mt-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Aperçu facture */}
            {(pdfPages.length > 0 || (pdfPreviewUrl && previewFileType?.startsWith("image/"))) && (
              <div className="relative sticky top-4">
                <Button
                  size="sm"
                  variant="ghost"
                  className="absolute top-2 right-2 z-10 bg-white/80 hover:bg-white"
                  onClick={() => { setPdfPreviewUrl(null); setPreviewFileType(null); setPdfPages([]); }}
                >
                  <X className="h-4 w-4" />
                </Button>
                {previewFileType?.startsWith("image/") ? (
                  <img
                    src={pdfPreviewUrl!}
                    alt="Aperçu facture"
                    className="w-full rounded border bg-gray-50 object-contain"
                  />
                ) : (
                  <div className="overflow-y-auto max-h-[780px] space-y-1 rounded border bg-gray-100 p-1">
                    {ocrLoading && pdfPages.length === 0 ? (
                      <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
                        <Loader2 className="h-5 w-5 animate-spin mr-2" />Rendu en cours…
                      </div>
                    ) : (
                      pdfPages.map((url, i) => (
                        <img key={i} src={url} alt={`Page ${i + 1}`} className="w-full rounded" />
                      ))
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Form */}
            <div className="space-y-4">
              {/* Drop zone */}
              {!pdfPreviewUrl && (
                <Card
                  className="border-dashed cursor-pointer hover:border-primary transition-colors"
                  onClick={() => fileRef.current?.click()}
                >
                  <CardContent className="py-8 text-center">
                    {ocrLoading ? (
                      <>
                        <Loader2 className="h-8 w-8 animate-spin mx-auto mb-2 text-primary" />
                        <p>OCR en cours…</p>
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                        <p className="font-medium">Scanner une facture PDF</p>
                        <p className="text-sm text-muted-foreground mt-1">
                          Cliquez ou glissez le PDF ici
                        </p>
                      </>
                    )}
                  </CardContent>
                </Card>
              )}

              {/* New supplier pending banner */}
              {newFournPending && (
                <div className="flex items-start gap-3 p-3 rounded-lg bg-amber-50 border border-amber-200">
                  <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-amber-800">
                      Nouveau fournisseur détecté
                    </p>
                    <p className="text-xs text-amber-700 mt-0.5">
                      <span className="font-semibold">{newFournPending.nom}</span>
                      {newFournPending.ice && ` · ICE ${newFournPending.ice}`}
                      {" "}— sera créé automatiquement à la validation
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 w-6 p-0 text-amber-600"
                    onClick={() => setNewFournPending(null)}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              )}

              {/* Supplier selection */}
              <div className="space-y-2">
                <Label>Fournisseur *</Label>
                <Select
                  value={fournisseurId}
                  onValueChange={(v) => {
                    setFournisseurId(v);
                    const f = fournisseurs.find((f) => f.id === v);
                    if (f) {
                      setFournisseurNom(f.nom);
                      setFournisseurIce(f.ice || "");
                      setNewFournPending(null);
                    }
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Sélectionner un fournisseur…" />
                  </SelectTrigger>
                  <SelectContent>
                    {fournisseurs.map((f) => (
                      <SelectItem key={f.id} value={f.id}>{f.nom}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!fournisseurId && (
                  <>
                    <Input
                      placeholder="Ou saisir le nom du fournisseur"
                      value={newFournPending?.nom ?? fournisseurNom}
                      onChange={(e) => {
                        setFournisseurNom(e.target.value);
                        setNewFournPending(null);
                        setFournisseurId("");
                      }}
                    />
                    <Input
                      placeholder="ICE fournisseur (15 chiffres)"
                      value={newFournPending?.ice ?? fournisseurIce}
                      onChange={(e) => {
                        setFournisseurIce(e.target.value);
                        if (newFournPending)
                          setNewFournPending({ ...newFournPending, ice: e.target.value });
                      }}
                    />
                  </>
                )}
              </div>

              {/* Invoice info */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>N° facture</Label>
                  <Input
                    value={numero}
                    onChange={(e) => setNumero(e.target.value)}
                    placeholder="FAC-2026-001"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Mode règlement</Label>
                  <Select value={modeReglement} onValueChange={setModeReglement}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {MODES.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Date facture *</Label>
                  <Input
                    type="date"
                    value={dateFacture}
                    onChange={(e) => setDateFacture(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Date échéance</Label>
                  <Input
                    type="date"
                    value={dateEcheance}
                    onChange={(e) => setDateEcheance(e.target.value)}
                  />
                </div>
              </div>

              {/* Lines */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <Label>Lignes de la facture</Label>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setLignes([...lignes, { designation: "", quantite: 1, prix_unitaire: 0, taux_tva: 20 }])
                    }
                  >
                    <Plus className="h-3 w-3 mr-1" />Ligne
                  </Button>
                </div>
                <div className="space-y-2">
                  {lignes.map((l, i) => (
                    <div key={i} className="grid grid-cols-12 gap-1 items-center">
                      <Input
                        className="col-span-5 text-xs"
                        placeholder="Désignation"
                        value={l.designation}
                        onChange={(e) =>
                          setLignes((ls) =>
                            ls.map((x, j) => j === i ? { ...x, designation: e.target.value } : x)
                          )
                        }
                      />
                      <Input
                        className="col-span-2 text-xs"
                        type="number"
                        placeholder="Qté"
                        value={l.quantite}
                        onChange={(e) =>
                          setLignes((ls) =>
                            ls.map((x, j) => j === i ? { ...x, quantite: parseFloat(e.target.value) || 1 } : x)
                          )
                        }
                      />
                      <Input
                        className="col-span-2 text-xs"
                        type="number"
                        placeholder="PU HT"
                        value={l.prix_unitaire}
                        onChange={(e) =>
                          setLignes((ls) =>
                            ls.map((x, j) => j === i ? { ...x, prix_unitaire: parseFloat(e.target.value) || 0 } : x)
                          )
                        }
                      />
                      <Select
                        value={String(l.taux_tva)}
                        onValueChange={(v) =>
                          setLignes((ls) =>
                            ls.map((x, j) => j === i ? { ...x, taux_tva: parseInt(v) } : x)
                          )
                        }
                      >
                        <SelectTrigger className="col-span-2 text-xs h-9">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {[0, 7, 10, 14, 20].map((t) => (
                            <SelectItem key={t} value={String(t)}>{t}%</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="col-span-1 h-9 px-1"
                        onClick={() => setLignes((ls) => ls.filter((_, j) => j !== i))}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                      {/* Rappel HT/TTC : le PU saisi est HT, on affiche le TTC dérivé du taux. */}
                      <div className="col-span-12 text-xs pl-1 pb-1 flex flex-wrap gap-x-3">
                        <span className="text-muted-foreground">P.U. HT <span className="font-medium text-foreground">{fmt(l.prix_unitaire || 0)}</span></span>
                        <span className="text-muted-foreground">P.U. TTC <span className="font-medium text-foreground">{fmt(puHtToTtc(l.prix_unitaire || 0, l.taux_tva))}</span></span>
                        <span className="text-muted-foreground">Total HT <span className="font-medium text-foreground">{fmt((l.quantite || 0) * (l.prix_unitaire || 0))}</span></span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Totals */}
              <Card className="bg-muted/40">
                <CardContent className="pt-3 pb-3">
                  <div className="grid grid-cols-3 gap-3 text-center">
                    <div>
                      <p className="text-xs text-muted-foreground">HT</p>
                      <p className="font-bold">{fmt(montantHt)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">TVA</p>
                      <p className="font-bold">{fmt(montantTva)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">TTC</p>
                      <p className="font-bold text-primary">{fmt(montantTtc)}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Échéances de paiement partiel */}
              <EcheancesInput echeances={echeances} onChange={setEcheances} montantTtc={montantTtc} />

              <div className="flex gap-2">
                <Button
                  className="flex-1"
                  onClick={handleSave}
                  disabled={processing === "save"}
                >
                  {processing === "save"
                    ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    : <CheckCircle className="h-4 w-4 mr-2" />}
                  {newFournPending
                    ? `Enregistrer + créer "${newFournPending.nom}"`
                    : "Enregistrer la facture"}
                </Button>
                <Button variant="outline" onClick={() => resetForm()}>Réinitialiser</Button>
              </div>
            </div>
          </div>
        </TabsContent>

        {/* ── Fournisseurs tiers + stats ── */}
        <TabsContent value="tiers" className="mt-4">
          <div className="flex gap-6 items-start">
            {/* Supplier list */}
            <div className={isPanelOpen ? "w-72 flex-shrink-0" : "flex-1"}>
              <Card>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Nom</TableHead>
                        {!isPanelOpen && (
                          <>
                            <TableHead>Code aux.</TableHead>
                            <TableHead>ICE</TableHead>
                            <TableHead>IF</TableHead>
                            <TableHead>RC</TableHead>
                            <TableHead>Email</TableHead>
                            <TableHead>Téléphone</TableHead>
                          </>
                        )}
                        <TableHead className="w-16"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {fournisseurs.length === 0 ? (
                        <TableRow>
                          <TableCell
                            colSpan={isPanelOpen ? 3 : 8}
                            className="text-center py-10 text-muted-foreground"
                          >
                            <Building2 className="h-8 w-8 mx-auto mb-2 opacity-30" />
                            Aucun fournisseur
                          </TableCell>
                        </TableRow>
                      ) : (
                        fournisseurs.map((f) => (
                          <TableRow
                            key={f.id}
                            className={`cursor-pointer hover:bg-muted/50 transition-colors ${
                              selectedFourn?.id === f.id
                                ? "bg-primary/5 border-l-2 border-l-primary"
                                : ""
                            }`}
                            onClick={() =>
                              setSelectedFourn(selectedFourn?.id === f.id ? null : f)
                            }
                          >
                            <TableCell className="font-medium text-sm">{f.nom}</TableCell>
                            {!isPanelOpen && (
                              <>
                                <TableCell className="font-mono text-xs">{f.code_auxiliaire ?? <span className="text-muted-foreground">—</span>}</TableCell>
                                <TableCell className="font-mono text-xs">{f.ice ?? <span className="text-muted-foreground">—</span>}</TableCell>
                                <TableCell className="font-mono text-xs">{f.if_fiscal ?? <span className="text-muted-foreground">—</span>}</TableCell>
                                <TableCell className="font-mono text-xs">{f.rc ?? <span className="text-muted-foreground">—</span>}</TableCell>
                                <TableCell className="text-sm">{f.email ?? <span className="text-muted-foreground">—</span>}</TableCell>
                                <TableCell className="text-sm">{f.telephone ?? <span className="text-muted-foreground">—</span>}</TableCell>
                              </>
                            )}
                            <TableCell className="text-right">
                              <div className="flex items-center justify-end gap-1">
                                <Button
                                  size="icon" variant="ghost"
                                  className="h-7 w-7"
                                  title="Modifier"
                                  onClick={(e) => openEditDialog(f, e)}
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </Button>
                                <BarChart2 className="h-3.5 w-3.5 text-muted-foreground" />
                              </div>
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </div>

            {/* Stats panel */}
            {isPanelOpen && selectedFourn && (
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h2 className="text-xl font-bold">{selectedFourn.nom}</h2>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {[
                        selectedFourn.ice && `ICE: ${selectedFourn.ice}`,
                        selectedFourn.email,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => setSelectedFourn(null)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>

                {facturesFournLoading ? (
                  <div className="text-center py-12 text-muted-foreground text-sm">
                    Chargement des données…
                  </div>
                ) : (
                  <Tabs value={fournDetailTab} onValueChange={(v) => setFournDetailTab(v as "kpis" | "factures" | "justificatifs")}>
                    <TabsList className="mb-4">
                      <TabsTrigger value="kpis">KPIs &amp; Charts</TabsTrigger>
                      <TabsTrigger value="factures">
                        Factures ({kpisFourn.total})
                      </TabsTrigger>
                      <TabsTrigger value="justificatifs">
                        Justificatifs ({kpisJustifsFourn.total})
                      </TabsTrigger>
                    </TabsList>

                    {/* KPIs */}
                    <TabsContent value="kpis" className="space-y-4">
                      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
                        <Card>
                          <CardContent className="pt-4 pb-3">
                            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                              Dettes en cours
                            </p>
                            <p className="text-lg font-bold text-red-600 mt-1">
                              {fmt(kpisFourn.dettes)}
                            </p>
                          </CardContent>
                        </Card>
                        <Card>
                          <CardContent className="pt-4 pb-3">
                            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                              Total achats TTC
                            </p>
                            <p className="text-lg font-bold text-blue-600 mt-1">
                              {fmt(kpisFourn.total_ttc)}
                            </p>
                          </CardContent>
                        </Card>
                        <Card>
                          <CardContent className="pt-4 pb-3">
                            <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1.5">
                              Factures
                            </p>
                            <div className="flex flex-wrap gap-1">
                              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-100 text-green-700">
                                {kpisFourn.payees} payées
                              </span>
                              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-yellow-100 text-yellow-700">
                                {kpisFourn.en_attente} attente
                              </span>
                              {kpisFourn.en_retard > 0 && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-700">
                                  {kpisFourn.en_retard} retard
                                </span>
                              )}
                            </div>
                          </CardContent>
                        </Card>
                        <Card>
                          <CardContent className="pt-4 pb-3">
                            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                              Délai moyen paiement
                            </p>
                            {kpisFourn.delaiMoyen !== null ? (
                              <p className="text-lg font-bold mt-1">
                                {kpisFourn.delaiMoyen}{" "}
                                <span className="text-sm font-normal text-muted-foreground">
                                  jours
                                </span>
                              </p>
                            ) : (
                              <p className="text-lg font-bold mt-1 text-muted-foreground">N/A</p>
                            )}
                          </CardContent>
                        </Card>
                      </div>

                      {/* Charts row */}
                      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                        {/* Bar chart — monthly purchases */}
                        <Card className="xl:col-span-2">
                          <CardContent className="pt-4">
                            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-3">
                              Achats mensuels — 12 derniers mois
                            </p>
                            <ResponsiveContainer width="100%" height={190}>
                              <BarChart
                                data={barDataFourn}
                                margin={{ top: 0, right: 4, bottom: 0, left: 0 }}
                              >
                                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
                                <XAxis dataKey="mois" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                                <YAxis
                                  tick={{ fontSize: 10 }}
                                  axisLine={false}
                                  tickLine={false}
                                  tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)}
                                />
                                <Tooltip formatter={(v: any) => [fmt(Number(v)), "Achats TTC"]} />
                                <Bar dataKey="achats" fill="#f97316" radius={[3, 3, 0, 0]} maxBarSize={32} />
                              </BarChart>
                            </ResponsiveContainer>
                          </CardContent>
                        </Card>

                        {/* Pie chart — payment status */}
                        <Card>
                          <CardContent className="pt-4">
                            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-3">
                              Répartition statuts
                            </p>
                            {pieDataFourn.length > 0 ? (
                              <ResponsiveContainer width="100%" height={190}>
                                <PieChart>
                                  <Pie
                                    data={pieDataFourn}
                                    dataKey="value"
                                    nameKey="name"
                                    cx="50%"
                                    cy="45%"
                                    outerRadius={62}
                                    innerRadius={32}
                                  >
                                    {pieDataFourn.map((_, i) => (
                                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                                    ))}
                                  </Pie>
                                  <Tooltip formatter={(v: any) => [v, ""]} />
                                  <Legend iconSize={8} iconType="circle" wrapperStyle={{ fontSize: 10 }} />
                                </PieChart>
                              </ResponsiveContainer>
                            ) : (
                              <p className="text-center text-muted-foreground text-xs py-10">
                                Aucune facture
                              </p>
                            )}
                          </CardContent>
                        </Card>
                      </div>

                      {/* Line chart — debt evolution */}
                      <Card>
                        <CardContent className="pt-4">
                          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-3">
                            Évolution des dettes — 6 derniers mois
                          </p>
                          <ResponsiveContainer width="100%" height={150}>
                            <LineChart
                              data={lineDataFourn}
                              margin={{ top: 0, right: 10, bottom: 0, left: 0 }}
                            >
                              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                              <XAxis dataKey="mois" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                              <YAxis
                                tick={{ fontSize: 10 }}
                                axisLine={false}
                                tickLine={false}
                                tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)}
                              />
                              <Tooltip formatter={(v: any) => [fmt(Number(v)), "Dettes"]} />
                              <Line
                                type="monotone"
                                dataKey="dettes"
                                stroke="#ef4444"
                                strokeWidth={2}
                                dot={{ r: 3, fill: "#ef4444" }}
                                activeDot={{ r: 5 }}
                              />
                            </LineChart>
                          </ResponsiveContainer>
                        </CardContent>
                      </Card>
                    </TabsContent>

                    {/* Justificatifs du fournisseur sélectionné */}
                    <TabsContent value="justificatifs" className="space-y-4">
                      <div className="grid grid-cols-3 gap-3">
                        <Card>
                          <CardContent className="pt-4 pb-3">
                            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Documents</p>
                            <p className="text-lg font-bold mt-1">{kpisJustifsFourn.total}</p>
                          </CardContent>
                        </Card>
                        <Card>
                          <CardContent className="pt-4 pb-3">
                            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Total TTC</p>
                            <p className="text-lg font-bold text-orange-600 mt-1">{fmt(kpisJustifsFourn.totalTtc)}</p>
                          </CardContent>
                        </Card>
                        <Card>
                          <CardContent className="pt-4 pb-3">
                            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">EDI éligible</p>
                            <p className="text-lg font-bold text-green-600 mt-1">{kpisJustifsFourn.ediCount}</p>
                          </CardContent>
                        </Card>
                      </div>

                      {kpisJustifsFourn.total > 0 && (
                        <div className="grid grid-cols-2 gap-3">
                          <Card>
                            <CardContent className="pt-3 pb-3">
                              <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-2">Par type</p>
                              <div className="flex flex-wrap gap-1">
                                {Object.entries(kpisJustifsFourn.byType).map(([t, n]) => (
                                  <span key={t} className="text-[10px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">
                                    {TYPE_DOC_LBL[t] ?? t}: {n}
                                  </span>
                                ))}
                              </div>
                            </CardContent>
                          </Card>
                          <Card>
                            <CardContent className="pt-3 pb-3">
                              <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-2">Par catégorie PCM</p>
                              <div className="flex flex-wrap gap-1">
                                {Object.entries(kpisJustifsFourn.byCateg).map(([c, n]) => (
                                  <span key={c} className="text-[10px] px-2 py-0.5 rounded-full bg-violet-50 text-violet-700">
                                    {CATEG_PCM_LBL[c] ?? c}: {n}
                                  </span>
                                ))}
                              </div>
                            </CardContent>
                          </Card>
                        </div>
                      )}

                      <DocumentsAssocies justificatifs={justifsFourn} flux="achat" onVoir={setDocView} />
                    </TabsContent>

                    {/* Factures list for selected supplier */}
                    <TabsContent value="factures">
                      <Card>
                        <CardContent className="p-0">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>N° Facture</TableHead>
                                <TableHead>Date</TableHead>
                                <TableHead>Échéance</TableHead>
                                <TableHead className="text-right">TTC</TableHead>
                                <TableHead className="text-right">Restant</TableHead>
                                <TableHead>Statut</TableHead>
                                <TableHead>Mode de paiement</TableHead>
                                <TableHead className="w-10"></TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {facturesFourn.length === 0 ? (
                                <TableRow>
                                  <TableCell
                                    colSpan={8}
                                    className="text-center py-10 text-muted-foreground"
                                  >
                                    <FileText className="h-6 w-6 mx-auto mb-1 opacity-30" />
                                    Aucune facture
                                  </TableCell>
                                </TableRow>
                              ) : (
                                facturesFourn.map((f) => {
                                  const s = statutBadge(f);
                                  return (
                                    <TableRow key={f.id}>
                                      <TableCell className="font-mono text-xs font-medium">
                                        {f.numero ?? f.id.slice(0, 8)}
                                      </TableCell>
                                      <TableCell className="text-xs">
                                        {f.date_facture
                                          ? new Date(f.date_facture).toLocaleDateString("fr-MA")
                                          : "—"}
                                      </TableCell>
                                      <TableCell className="text-xs">
                                        {f.date_echeance
                                          ? new Date(f.date_echeance).toLocaleDateString("fr-MA")
                                          : "—"}
                                      </TableCell>
                                      <TableCell className="text-right font-mono text-xs font-semibold">
                                        {fmt(Number(f.montant_ttc))}
                                      </TableCell>
                                      <TableCell
                                        className={`text-right font-mono text-xs ${
                                          Number(f.montant_restant ?? 0) > 0
                                            ? "text-red-600 font-semibold"
                                            : "text-muted-foreground"
                                        }`}
                                      >
                                        {fmt(Number(f.montant_restant ?? 0))}
                                      </TableCell>
                                      <TableCell>
                                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${s.cls}`}>
                                          {s.label}
                                        </span>
                                      </TableCell>
                                      <TableCell><ModePaiementCell mode={modePaiementFacture(f, modes)} /></TableCell>
                                      <TableCell>
                                        <div className="flex gap-1">
                                          {/* Même visualisation que la liste générale. */}
                                          <Button
                                            size="icon"
                                            variant="ghost"
                                            className="h-7 w-7"
                                            onClick={() => setFactureDetail(f)}
                                            title="Voir le détail de la facture"
                                          >
                                            <Eye className="h-3.5 w-3.5" />
                                          </Button>
                                          <Button
                                            size="icon"
                                            variant="ghost"
                                            disabled={!f.fichier_original_url}
                                            className="h-7 w-7"
                                            onClick={() => setDocView({ title: `Facture ${f.numero ?? ""}`.trim(), url: f.fichier_original_url, fileName: f.fichier_original_nom, mimeType: f.fichier_original_type })}
                                            title={f.fichier_original_url
                                              ? "Voir / télécharger le document original"
                                              : "Aucun document original archivé — rescannez la facture pour l'attacher"}
                                          >
                                            <FileText className="h-3.5 w-3.5" />
                                          </Button>
                                          <Button
                                            size="icon"
                                            variant="ghost"
                                            disabled={!estPayee(f)}
                                            className="h-7 w-7 text-amber-600 hover:bg-amber-500/10"
                                            onClick={() => setAnnulConfirm(f)}
                                            title={estPayee(f) ? "Annuler le paiement" : "Déjà impayée"}
                                          >
                                            <Undo2 className="h-3.5 w-3.5" />
                                          </Button>
                                          <Button
                                            size="icon"
                                            variant="ghost"
                                            disabled={estPayee(f)}
                                            className="h-7 w-7 text-destructive hover:bg-destructive/10"
                                            onClick={() => setDeleteId(f.id)}
                                            title={estPayee(f) ? "Annulez d'abord le paiement" : "Supprimer la facture"}
                                          >
                                            <Trash2 className="h-3.5 w-3.5" />
                                          </Button>
                                        </div>
                                      </TableCell>
                                    </TableRow>
                                  );
                                })
                              )}
                            </TableBody>
                          </Table>
                        </CardContent>
                      </Card>
                    </TabsContent>
                  </Tabs>
                )}
              </div>
            )}
          </div>
        </TabsContent>

        {/* ── Balance âgée : reste à payer des dettes, ventilé par ancienneté ── */}
        <TabsContent value="balance" className="mt-4">
          <BalanceAgee
            dossierId={dossierId}
            sens="fournisseur"
            onVoirFactures={(l) => {
              const f = (l.tiers_id ? fournisseurs.find((x) => x.id === l.tiers_id) : null)
                ?? fournisseurs.find((x) => x.nom === l.tiers_nom);
              if (!f) { toast.info("Fiche fournisseur introuvable"); return; }
              setSelectedFourn(f);
              setFournDetailTab("factures");
              setTab("tiers");
            }}
          />
        </TabsContent>

        {/* ── Reporting & évolution (fournisseurs uniquement) ── */}
        <TabsContent value="reporting" className="mt-4">
          <TiersReporting dossierId={dossierId} kind="fournisseurs" />
        </TabsContent>
      </Tabs>

      {/* ── Annulation de paiement ── */}
      <Dialog open={!!annulConfirm} onOpenChange={(o) => { if (!o) setAnnulConfirm(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Annuler le paiement ?</DialogTitle>
          </DialogHeader>
          <div className="text-sm text-muted-foreground space-y-2">
            <p>
              La facture <span className="font-mono">{annulConfirm?.numero ?? annulConfirm?.id.slice(0, 8)}</span> repassera
              en « impayée », ce qui débloquera sa suppression.
            </p>
            <ul className="list-disc pl-5 space-y-1">
              <li>Un décaissement <b>espèces ou chèque</b> est supprimé, avec ses écritures.</li>
              <li>Une ligne de <b>relevé bancaire</b> n'est <b>jamais supprimée</b> : elle est simplement délettrée et redevient « à lettrer ».</li>
              <li>L'écriture d'<b>achat</b> (journal ACH) est conservée.</li>
            </ul>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAnnulConfirm(null)} disabled={annulLoading}>Retour</Button>
            <Button onClick={() => annulConfirm && handleAnnulerPaiement(annulConfirm)} disabled={annulLoading}>
              {annulLoading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Undo2 className="h-4 w-4 mr-2" />}
              Annuler le paiement
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete confirmation dialog ── */}
      <Dialog open={!!deleteId} onOpenChange={(o) => { if (!o) setDeleteId(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Supprimer la facture ?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Cette action supprime définitivement la facture <strong>et ses écritures
            comptables associées</strong> (journal ACH). Cette opération est irréversible.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteId(null)} disabled={deleteLoading}>
              Annuler
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteLoading}
            >
              {deleteLoading
                ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                : <Trash2 className="h-4 w-4 mr-2" />}
              Supprimer définitivement
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── New supplier modal (manual) ── */}
      {/* ── Dialog nouveau fournisseur ── */}
      <Dialog open={openFourn} onOpenChange={setOpenFourn}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nouveau fournisseur</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label>Nom *</Label>
              <Input value={formFourn.nom} onChange={(e) => setFormFourn({ ...formFourn, nom: e.target.value })} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-2">
                <Label>ICE</Label>
                <Input value={formFourn.ice} onChange={(e) => setFormFourn({ ...formFourn, ice: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>IF (Identifiant Fiscal)</Label>
                <Input value={formFourn.if_fiscal} onChange={(e) => setFormFourn({ ...formFourn, if_fiscal: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>RC</Label>
                <Input value={formFourn.rc} onChange={(e) => setFormFourn({ ...formFourn, rc: e.target.value })} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Email</Label>
                <Input type="email" value={formFourn.email} onChange={(e) => setFormFourn({ ...formFourn, email: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>Téléphone</Label>
                <Input value={formFourn.telephone} onChange={(e) => setFormFourn({ ...formFourn, telephone: e.target.value })} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Adresse</Label>
              <Input value={formFourn.adresse} onChange={(e) => setFormFourn({ ...formFourn, adresse: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Code auxiliaire <span className="text-xs text-muted-foreground font-normal">(comptabilité auxiliaire / Sage)</span></Label>
              <div className="flex gap-2">
                <Input value={formFourn.code_auxiliaire} onChange={(e) => setFormFourn({ ...formFourn, code_auxiliaire: e.target.value })} placeholder="F0001" className="font-mono" />
                <Button type="button" variant="outline" size="icon" title="Générer le prochain code"
                  onClick={() => setFormFourn({ ...formFourn, code_auxiliaire: nextCodeAuxiliaire("fournisseur", fournisseurs.map(f => f.code_auxiliaire)) })}>
                  <Wand2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenFourn(false)}>Annuler</Button>
            <Button onClick={async () => {
              if (!formFourn.nom) return;
              const { error } = await supabase.from("fournisseurs").insert({
                dossier_id: dossierId,
                nom: formFourn.nom,
                ice: formFourn.ice || null,
                if_fiscal: formFourn.if_fiscal || null,
                rc: formFourn.rc || null,
                email: formFourn.email || null,
                telephone: formFourn.telephone || null,
                adresse: formFourn.adresse || null,
                code_auxiliaire: formFourn.code_auxiliaire || null,
              });
              if (error) return toast.error(error.message);
              setOpenFourn(false);
              setFormFourn({ nom: "", ice: "", if_fiscal: "", rc: "", email: "", telephone: "", adresse: "", code_auxiliaire: "" });
              load();
              toast.success("Fournisseur créé");
            }}>Créer</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Dialog modifier fournisseur ── */}
      <Dialog open={!!editFourn} onOpenChange={(o) => { if (!o) setEditFourn(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Modifier le fournisseur</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label>Nom *</Label>
              <Input value={formEdit.nom} onChange={(e) => setFormEdit({ ...formEdit, nom: e.target.value })} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-2">
                <Label>ICE</Label>
                <Input value={formEdit.ice} onChange={(e) => setFormEdit({ ...formEdit, ice: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>IF (Identifiant Fiscal)</Label>
                <Input value={formEdit.if_fiscal} onChange={(e) => setFormEdit({ ...formEdit, if_fiscal: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>RC</Label>
                <Input value={formEdit.rc} onChange={(e) => setFormEdit({ ...formEdit, rc: e.target.value })} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Email</Label>
                <Input type="email" value={formEdit.email} onChange={(e) => setFormEdit({ ...formEdit, email: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>Téléphone</Label>
                <Input value={formEdit.telephone} onChange={(e) => setFormEdit({ ...formEdit, telephone: e.target.value })} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Adresse</Label>
              <Input value={formEdit.adresse} onChange={(e) => setFormEdit({ ...formEdit, adresse: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Code auxiliaire <span className="text-xs text-muted-foreground font-normal">(comptabilité auxiliaire / Sage)</span></Label>
              <div className="flex gap-2">
                <Input value={formEdit.code_auxiliaire} onChange={(e) => setFormEdit({ ...formEdit, code_auxiliaire: e.target.value })} placeholder="F0001" className="font-mono" />
                <Button type="button" variant="outline" size="icon" title="Générer le prochain code"
                  onClick={() => setFormEdit({ ...formEdit, code_auxiliaire: nextCodeAuxiliaire("fournisseur", fournisseurs.map(f => f.code_auxiliaire)) })}>
                  <Wand2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditFourn(null)}>Annuler</Button>
            <Button onClick={async () => {
              if (!editFourn || !formEdit.nom) return;
              const { error } = await supabase.from("fournisseurs").update({
                nom: formEdit.nom,
                ice: formEdit.ice || null,
                if_fiscal: formEdit.if_fiscal || null,
                rc: formEdit.rc || null,
                email: formEdit.email || null,
                telephone: formEdit.telephone || null,
                adresse: formEdit.adresse || null,
                code_auxiliaire: formEdit.code_auxiliaire || null,
              }).eq("id", editFourn.id);
              if (error) return toast.error(error.message);
              logAudit({ dossierId, action: "modification_fournisseur", ressourceType: "fournisseur", ressourceId: editFourn.id, details: { nom: formEdit.nom } });
              setEditFourn(null);
              load();
              toast.success("Fournisseur mis à jour");
            }}>Enregistrer</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Aperçu du document original (panneau latéral droit) */}
      <DocumentViewer open={!!docView} onOpenChange={(o) => { if (!o) setDocView(null); }} source={docView} />

      {/* ── Détail d'une facture ───────────────────────────────────────────────
          Restitue la facture telle qu'enregistrée (en-tête, montants, lignes).
          Toujours accessible : le document original, lui, ouvre le scan archivé
          quand il existe — les factures saisies avant l'archivage n'en ont pas. */}
      <Dialog open={!!factureDetail} onOpenChange={(o) => { if (!o) setFactureDetail(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              Facture {factureDetail?.numero ?? "—"} · {factureDetail?.fournisseur_nom ?? "—"}
            </DialogTitle>
          </DialogHeader>
          {factureDetail && (
            <div className="space-y-4">
              {/* Signalé seulement quand rien n'est archivé : sinon le bouton
                  « document original » de la ligne ouvre déjà le scan. */}
              {!factureDetail.fichier_original_url && (
                <div className="flex items-start gap-2 rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">
                  <AlertCircle className="h-4 w-4 shrink-0 mt-px" />
                  <span>
                    Aucun document scanné n'est archivé pour cette facture — voici son
                    contenu enregistré. Les factures scannées depuis la mise en place de
                    l'archivage ouvrent directement l'original.
                  </span>
                </div>
              )}

              <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                {[
                  ["Date facture", factureDetail.date_facture ? new Date(factureDetail.date_facture).toLocaleDateString("fr-MA") : "—"],
                  ["Échéance", factureDetail.date_echeance ? new Date(factureDetail.date_echeance).toLocaleDateString("fr-MA") : "—"],
                  // Le mode CONSTATÉ (pièce de règlement), pas le mode prévu à la
                  // saisie — même lecture que la colonne « Mode de paiement ».
                  ["Mode de paiement", (() => { const m = modePaiementFacture(factureDetail, modes); return m ? MODE_PAIEMENT_LABEL[m] : "—"; })()],
                  ["Montant HT", fmt(Number(factureDetail.montant_ht))],
                  ["TVA", fmt(Number(factureDetail.montant_tva))],
                  ["Montant TTC", fmt(Number(factureDetail.montant_ttc))],
                  ["Payé", fmt(Number(factureDetail.montant_paye ?? 0))],
                  ["Restant dû", fmt(Number(factureDetail.montant_restant ?? factureDetail.montant_ttc))],
                  ["Statut", statutBadge(factureDetail).label],
                ].map(([label, value]) => (
                  <div key={label as string}>
                    <p className="text-xs text-muted-foreground">{label}</p>
                    <p className="font-medium">{value}</p>
                  </div>
                ))}
              </div>

              {/* Notes manuscrites relevées par l'OCR vision sur le document scanné. */}
              {(factureDetail as any).ocr_data?.notes_manuscrites && (
                <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800 px-3 py-2">
                  <p className="text-xs font-semibold text-amber-700 dark:text-amber-400 flex items-center gap-1">
                    <Pencil className="h-3 w-3" /> Note manuscrite sur le document
                  </p>
                  <p className="text-sm mt-0.5 whitespace-pre-line">{(factureDetail as any).ocr_data.notes_manuscrites}</p>
                </div>
              )}

              {Array.isArray(factureDetail.lignes) && factureDetail.lignes.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Désignation</TableHead>
                      <TableHead className="text-right">Qté</TableHead>
                      <TableHead className="text-right">P.U.</TableHead>
                      <TableHead className="text-right">TVA</TableHead>
                      <TableHead className="text-right">Total HT</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {factureDetail.lignes.map((l: any, i: number) => (
                      <TableRow key={i}>
                        <TableCell className="text-sm">{l.designation || "—"}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{l.quantite ?? "—"}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{fmt(Number(l.prix_unitaire ?? 0))}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{l.taux_tva ?? 0} %</TableCell>
                        <TableCell className="text-right font-mono text-xs font-medium">
                          {fmt(Number(l.quantite ?? 0) * Number(l.prix_unitaire ?? 0))}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
