import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Upload, Loader2, FileText, Paperclip, X, Pencil, Trash2, Eye } from "lucide-react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { DocumentViewer, type DocumentViewerSource } from "@/components/DocumentViewer";
import { logAudit } from "@/lib/audit";
import { ocrFacture, matcherDocumentAvecTransactions, lettrerJustificatif } from "@/server/factures.functions";

export const Route = createFileRoute("/_app/dossiers/$dossierId/justificatifs")({
  component: JustificatifsPage,
});

// ─── Constantes ───────────────────────────────────────────────────────────────

const TYPE_DOCUMENT_GROUPS = [
  {
    label: "Documents commerciaux",
    items: [
      { value: "facture",       label: "Facture" },
      { value: "bon_commande",  label: "Bon de commande" },
      { value: "bon_livraison", label: "Bon de livraison" },
      { value: "devis",         label: "Devis" },
    ],
  },
  {
    label: "Justificatifs dépenses",
    items: [
      { value: "recu",             label: "Reçu" },
      { value: "addition",         label: "Addition" },
      { value: "note_frais",       label: "Note de frais" },
      { value: "ticket_carburant", label: "Ticket carburant" },
    ],
  },
  {
    label: "Documents fiscaux / Admin",
    items: [
      { value: "avis_debit",      label: "Avis de Débit" },
      { value: "dum",             label: "DUM / Import" },
      { value: "quittance_cnss",  label: "Quittance CNSS" },
      { value: "quittance_dgi",   label: "Quittance DGI" },
      { value: "quittance_eau",   label: "Quittance eau" },
      { value: "quittance_elec",  label: "Quittance électricité" },
      { value: "quittance_loyer", label: "Quittance loyer" },
      { value: "contrat",         label: "Contrat" },
      { value: "autre",           label: "Autre" },
    ],
  },
];

const TYPE_DOCUMENT = TYPE_DOCUMENT_GROUPS.flatMap(g => g.items);

// Compte PCM et TVA par défaut selon le type de document
const TYPE_PCM_DEFAULTS: Record<string, { compte: string; tva: number }> = {
  ticket_carburant: { compte: "61241", tva: 0  },
  quittance_cnss:   { compte: "6174",  tva: 0  },
  quittance_dgi:    { compte: "4456",  tva: 0  },
  quittance_eau:    { compte: "6125",  tva: 7  },
  quittance_elec:   { compte: "6125",  tva: 14 },
  quittance_loyer:  { compte: "6131",  tva: 0  },
  addition:         { compte: "6147",  tva: 0  },
  dum:              { compte: "6146",  tva: 0  },
  avis_debit:       { compte: "6347",  tva: 10 },
};

// Types autorisés dans la contrainte CHECK DB actuelle (avant migration complète).
// quittance_loyer est explicitement autorisé en base (migration 20260610120000) :
// on le persiste tel quel, sans le rabattre sur "recu".
const DB_ALLOWED_TYPES = new Set([
  "recu", "bon_commande", "bon_livraison", "note_frais", "addition", "facture", "dum",
  "quittance_loyer",
]);

// Fallback DB pour les types non encore dans la contrainte CHECK
const toDbType = (t: string): string => {
  if (DB_ALLOWED_TYPES.has(t)) return t;
  if (t === "devis" || t === "contrat") return "bon_commande";
  return "recu"; // autres quittances, ticket_carburant, avis_debit, autre → recu
};

const CATEGORIES_PCM = [
  { value: "paiement_fournisseur",  label: "Achat fournisseur",                    code: "4411"  },
  { value: "acompte_fournisseur",   label: "Acompte / Avance fournisseur (BC)",    code: "3411"  },
  { value: "encaissement_client",   label: "Encaissement client",                  code: "3421"  },
  { value: "salaires",              label: "Salaires",                             code: "6171"  },
  { value: "cnss_amo",              label: "CNSS / AMO",                           code: "6174"  },
  { value: "charges_sociales",      label: "Charges Sociales",                     code: "6174"  },
  { value: "loyers",                label: "Loyer / Location",                     code: "61311" },
  { value: "eau_electricite",       label: "Eau / Électricité",                    code: "6125"  },
  { value: "telecom",               label: "Téléphone / Internet",                 code: "6132"  },
  { value: "gasoil",                label: "Carburant (TVA non déductible)",       code: "61223" },
  { value: "assurance",             label: "Assurance",                            code: "6161"  },
  { value: "entretien",             label: "Entretien / Réparation",               code: "6141"  },
  { value: "frais_bancaires",       label: "Frais bancaires",                      code: "6347"  },
  { value: "frais_representation",  label: "Restaurant / Réception (Art. 106)",   code: "6147"  },
  { value: "transport",             label: "Transport / Déplacements",             code: "6142"  },
  { value: "tva_import",            label: "TVA récupérable sur import (DUM)",     code: "34552" },
  { value: "frais_douane",          label: "Droits de douane",                     code: "6146"  },
  { value: "taxe_professionnelle",  label: "Taxe professionnelle",                 code: "6313"  },
  { value: "droits_timbre",         label: "Droits de timbre fiscaux",             code: "61671" },
  { value: "autre",                 label: "Autre",                                code: "6141"  },
];

const PCM_CODE: Record<string, string> = Object.fromEntries(
  CATEGORIES_PCM.map(c => [c.value, c.code])
);

// ─── Matrice fiscale marocaine (Art. 106 CGI et autres) ──────────────────────

type FiscalRule = {
  tva_non_deductible: boolean; // TVA non récupérable → montant_ht aligné sur TTC
  edi_bloque:         boolean; // eligible_edi forcé à false
  tva_zero_doc:       boolean; // TVA nulle sur le document lui-même (BC, BL)
  alerte?:            string;  // Message affiché dans l'UI
};

const FISCAL_RULES: Partial<Record<string, FiscalRule>> = {
  frais_representation: {
    tva_non_deductible: true,
    edi_bloque:         true,
    tva_zero_doc:       false,
    alerte: "⚠️ Art. 106 CGI — TVA non déductible sur frais de bouche et de réception. Montant TTC intégral imputé au débit du 6147.",
  },
  gasoil: {
    tva_non_deductible: true,
    edi_bloque:         true,
    tva_zero_doc:       false,
    alerte: "⚠️ Art. 106 CGI — TVA 10% non déductible sur carburant pour véhicules de tourisme. Montant TTC imputé intégralement en 61223.",
  },
  transport: {
    tva_non_deductible: true,
    edi_bloque:         true,
    tva_zero_doc:       false,
    alerte: "⚠️ TVA non récupérable sur frais de déplacement (péage, taxi, train, avion). Montant TTC imputé en 6142.",
  },
  loyers: {
    tva_non_deductible: false,
    edi_bloque:         true,
    tva_zero_doc:       false,
    alerte: "⚠️ RAS IR (Art. 57 CGI) — Si le bailleur est un particulier, retenue à la source sur loyer obligatoire. Vérifiez le statut du propriétaire.",
  },
  acompte_fournisseur: {
    tva_non_deductible: false,
    edi_bloque:         true,
    tva_zero_doc:       true,
    alerte: "ℹ️ Bon de commande — Pas de TVA déductible sur un acompte. Compte 3411 (créance). Statut : provisoire, en attente de livraison.",
  },
  paiement_fournisseur: {
    tva_non_deductible: false,
    edi_bloque:         false,
    tva_zero_doc:       false,
  },
  tva_import: {
    tva_non_deductible: false,
    edi_bloque:         false,
    tva_zero_doc:       false,
    alerte: "✅ DUM — TVA récupérable sur importations (Art. 92 CGI). Le numéro de quittance douanière remplace le numéro de facture pour l'EDI DGI.",
  },
  droits_timbre: {
    tva_non_deductible: true,
    edi_bloque:         true,
    tva_zero_doc:       true,
    alerte: "⚠️ Droits de timbre / LCN — Hors champ TVA (taxe fiscale). Compte 61671. À exclure impérativement du relevé de déduction EDI DGI (ADC082F-15I).",
  },
  charges_sociales: {
    tva_non_deductible: false,
    edi_bloque:         true,
    tva_zero_doc:       true,
    alerte: "ℹ️ CNSS / Sécurité Sociale — Charges sociales imputées au compte 6174. Hors champ TVA, à exclure du relevé de déduction EDI DGI.",
  },
};

// Applique les règles fiscales sur un snapshot du formulaire
const applyFiscalRules = (
  cat: string,
  docType: string,
  ttc: number,
  currentForm: typeof EMPTY_FORM,
): Partial<typeof EMPTY_FORM> => {
  const rule = FISCAL_RULES[cat];
  const isBL = docType === "bon_livraison";

  const overrides: Partial<typeof EMPTY_FORM> = {
    eligible_edi: rule ? !rule.edi_bloque : currentForm.eligible_edi,
  };
  if (rule?.tva_non_deductible) overrides.montant_ht = ttc;
  if (rule?.tva_zero_doc || isBL) overrides.taux_tva = 0;
  return overrides;
};

const fmt = (n: number) =>
  Number(n).toLocaleString("fr-MA", { minimumFractionDigits: 2 }) + " MAD";

const normDateToISO = (d: string | null | undefined): string => {
  if (!d) return "";
  const s = d.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return "";
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface LigneJustif {
  designation: string;
  quantite: number;
  prix_unitaire: number;
  taux_tva: number | null;
}

const EMPTY_LIGNE: LigneJustif = { designation: "", quantite: 1, prix_unitaire: 0, taux_tva: null };

interface Justificatif {
  id: string;
  type_document: string;
  flux_type: string;
  nom_tiers: string | null;
  montant_ttc: number;
  montant_ht: number;
  taux_tva: number;
  date_document: string | null;
  date_commande: string | null;
  numero_piece: string | null;
  numero_commande: string | null;
  bon_commande_id: string | null;
  devis_id: string | null;
  categorie_pcm: string | null;
  compte_pcm: string | null;
  eligible_edi: boolean;
  statut: string;
  created_at: string;
  lignes: LigneJustif[] | null;
  fichier_original_url: string | null;
  fichier_original_nom: string | null;
  fichier_original_type: string | null;
}

const EMPTY_FORM = {
  type_document:   "recu",
  flux_type:       "achat",
  nom_tiers:       "",
  montant_ttc:     0,
  montant_ht:      0,
  taux_tva:        20,
  date_document:   new Date().toISOString().slice(0, 10),
  date_commande:   "",
  numero_piece:    "",
  numero_commande: "",
  bon_commande_id: "",
  devis_id:        "",
  categorie_pcm:   "paiement_fournisseur",
  compte_pcm:      "4411",
  eligible_edi:    false,
};

// ─── Détection catégorie PCM par mots-clés (fallback local) ──────────────────

const inferCatFromContent = (nomTiers: string, lignes: { designation?: string }[], docType: string): string | null => {
  const haystack = [
    nomTiers,
    ...lignes.map(l => l.designation ?? ""),
  ].join(" ").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

  // Droits de timbre / LCN — priorité absolue (hors TVA, hors EDI DGI)
  if (/droit.?de.?timbre|remise.?lcn|lettre.?de.?change|timbre.?fiscal/.test(haystack)) return "droits_timbre";

  if (/restaurant|cafe|brasserie|pizz|snack|fast.food|resto|traiteur|patisserie|salon.de.the|grillad|barbecue|burger|sandwi|pizza|sushi|wok|tagine|couscous|addition|repas|dejeuner|diner|menu|plat.du.jour|boisson|cocktail|chez\b|grill|roti|kebab|loubia|tajine|harira|msemen|baghrir/.test(haystack)) return "frais_representation";
  if (docType === "addition") return "frais_representation";
  // Reçu dont les articles sont alimentaires (plats, boissons)
  if (docType === "recu" && /plat|salade|entree|dessert|pain|eau.mineral|jus\b|the\b|cafe\b|menthe|limonade|biere|verre|bouteille|coca|fanta|sprite|citronnade/.test(haystack)) return "frais_representation";
  if (/gasoil|carburant|essence|diesel|station.service|station-service|shell|total\b|afriquia|ziz|winxo|petrom|lubrifiant|petrole/.test(haystack)) return "gasoil";
  if (/taxi|transport|livraison|messagerie|amana|dhl|fedex|courrier|fret|supratours|ctm|oncf|bus\b|avion|billet/.test(haystack)) return "transport";
  if (/telephone|internet|maroc.telecom|orange\b|inwi|adsl|mobile|forfait|recharge|4g|fibre/.test(haystack)) return "telecom";
  if (/onee|lydec|radeef|radem|electricite|energie|eau\b|facture.eau|consommation.eau/.test(haystack)) return "eau_electricite";
  if (/loyer|location\b|bail|gerance|loyer.commercial/.test(haystack)) return "loyers";
  if (/assurance|wafa|axa\b|rma\b|allianz|saham|prime|police.assurance/.test(haystack)) return "assurance";
  if (/maintenance|reparation|pieces.detachees|atelier|garage|depannage|revision|entretien/.test(haystack)) return "entretien";
  if (/banque|commission.bancaire|frais.de.tenue|cih\b|attijariwafa|bmce|bmci|banque.populaire|cfg\b/.test(haystack)) return "frais_bancaires";
  return null;
};

// ─── Génération template HTML ─────────────────────────────────────────────────

const generateJustifHTML = (j: Justificatif): string => {
  const typeLabel = TYPE_DOCUMENT.find(t => t.value === j.type_document)?.label ?? j.type_document;
  const catLabel  = CATEGORIES_PCM.find(c => c.value === j.categorie_pcm)?.label ?? j.categorie_pcm ?? "";
  const lignes    = j.lignes ?? [];
  const tva       = Number(j.montant_ttc) - Number(j.montant_ht || 0);

  const rowsHtml = lignes.map(l => `
    <tr>
      <td>${l.designation}</td>
      <td style="text-align:center">${l.quantite}</td>
      <td style="text-align:right">${l.prix_unitaire.toFixed(2)}</td>
      <td style="text-align:center">${l.taux_tva != null ? l.taux_tva + "%" : "—"}</td>
      <td style="text-align:right">${(l.quantite * l.prix_unitaire).toFixed(2)}</td>
    </tr>`).join("");

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <title>${typeLabel}${j.numero_piece ? " — " + j.numero_piece : ""}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Arial,Helvetica,sans-serif;max-width:820px;margin:40px auto;padding:24px;color:#1a1a1a;font-size:13px}
    .header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #1d4ed8;padding-bottom:16px;margin-bottom:20px}
    .brand{font-size:20px;font-weight:800;color:#1d4ed8;letter-spacing:-0.5px}
    .brand-sub{font-size:10px;color:#888;margin-top:3px}
    .doc-type{font-size:18px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#1d4ed8;text-align:right}
    .doc-ref{font-size:12px;color:#666;margin-top:4px;text-align:right;font-family:monospace}
    .grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px}
    .meta-box{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px}
    .meta-box .lbl{font-size:9px;text-transform:uppercase;color:#94a3b8;font-weight:700;letter-spacing:.5px;margin-bottom:4px}
    .meta-box .val{font-weight:600;font-size:14px}
    .meta-box .sub{font-size:11px;color:#64748b;margin-top:2px}
    .refs-bar{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;align-items:center}
    .ref-chip{background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;border-radius:20px;padding:2px 10px;font-size:11px;font-weight:500}
    table.lines{width:100%;border-collapse:collapse;margin:0 0 12px}
    table.lines th{background:#1d4ed8;color:white;padding:8px 10px;font-size:10px;text-transform:uppercase;letter-spacing:.5px;text-align:left}
    table.lines td{padding:7px 10px;border-bottom:1px solid #f1f5f9}
    table.lines tr:nth-child(even) td{background:#f8fafc}
    .totals{margin-top:8px;margin-left:auto;width:260px}
    .tot-row{display:flex;justify-content:space-between;padding:4px 0;font-size:12px}
    .tot-sep{border-top:2px solid #1d4ed8;margin:6px 0}
    .tot-main{font-size:15px;font-weight:700;color:#1d4ed8;padding:4px 0;display:flex;justify-content:space-between}
    .pcm-bar{margin-top:16px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:8px 12px;font-size:11px;color:#3b82f6}
    .footer{margin-top:24px;border-top:1px solid #e2e8f0;padding-top:10px;display:flex;justify-content:space-between;font-size:10px;color:#94a3b8}
    @media print{body{margin:0}}
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="brand">DeploieApp</div>
      <div class="brand-sub">Gestion comptable — Maroc</div>
    </div>
    <div>
      <div class="doc-type">${typeLabel}</div>
      ${j.numero_piece ? `<div class="doc-ref">Réf. ${j.numero_piece}</div>` : ""}
    </div>
  </div>
  <div class="grid2">
    <div class="meta-box">
      <div class="lbl">Tiers</div>
      <div class="val">${j.nom_tiers ?? "—"}</div>
    </div>
    <div class="meta-box">
      <div class="lbl">Date du document</div>
      <div class="val">${j.date_document ?? "—"}</div>
      ${j.date_commande ? `<div class="sub">Date commande : ${j.date_commande}</div>` : ""}
    </div>
    <div class="meta-box">
      <div class="lbl">Flux / Catégorie</div>
      <div class="val">${j.flux_type === "vente" ? "Vente" : "Achat"}</div>
      <div class="sub">${catLabel}</div>
    </div>
    <div class="meta-box">
      <div class="lbl">Statut</div>
      <div class="val">${j.statut === "rapproche" ? "✅ Rapproché" : "⏳ En attente"}</div>
      ${j.eligible_edi ? '<div class="sub">Éligible EDI ✓</div>' : ""}
    </div>
  </div>
  ${(j.bon_commande_id || j.devis_id || j.numero_commande) ? `
  <div class="refs-bar">
    <span style="font-size:11px;color:#64748b">Documents liés :</span>
    ${j.numero_commande ? `<span class="ref-chip">N° Cde : ${j.numero_commande}</span>` : ""}
    ${j.bon_commande_id ? `<span class="ref-chip">BC lié</span>` : ""}
    ${j.devis_id ? `<span class="ref-chip">Devis lié</span>` : ""}
  </div>` : ""}
  ${lignes.length > 0 ? `
  <table class="lines">
    <thead><tr>
      <th>Désignation</th>
      <th style="text-align:center;width:60px">Qté</th>
      <th style="text-align:right;width:100px">P.U. HT</th>
      <th style="text-align:center;width:70px">TVA</th>
      <th style="text-align:right;width:110px">Total HT</th>
    </tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>` : ""}
  <div class="totals">
    ${j.montant_ht ? `<div class="tot-row"><span>Montant HT</span><span>${Number(j.montant_ht).toFixed(2)} MAD</span></div>` : ""}
    ${j.taux_tva ? `<div class="tot-row"><span>TVA (${j.taux_tva}%)</span><span>${tva.toFixed(2)} MAD</span></div>` : ""}
    <div class="tot-sep"></div>
    <div class="tot-main"><span>TOTAL TTC</span><span>${Number(j.montant_ttc).toFixed(2)} MAD</span></div>
  </div>
  <div class="pcm-bar">Compte PCM : <strong>${j.compte_pcm ?? "—"}</strong> &nbsp;|&nbsp; ${catLabel}</div>
  <div class="footer">
    <span>Document généré par DeploieApp — Gestion comptable Maroc</span>
    <span>${new Date().toLocaleDateString("fr-MA", { day: "2-digit", month: "long", year: "numeric" })}</span>
  </div>
  <script>window.onload = () => window.print();</script>
</body>
</html>`;
};

// ─── Composant ────────────────────────────────────────────────────────────────

function JustificatifsPage() {
  const { dossierId } = Route.useParams();
  const ocrFn     = useServerFn(ocrFacture);
  const matchFn   = useServerFn(matcherDocumentAvecTransactions);
  const lettrerFn = useServerFn(lettrerJustificatif);
  const fileRef = useRef<HTMLInputElement>(null);

  const [justificatifs, setJustificatifs] = useState<Justificatif[]>([]);
  const [open, setOpen]           = useState(false);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [saving, setSaving]       = useState(false);
  const [form, setForm]           = useState({ ...EMPTY_FORM });
  const [datesRef, setDatesRef]   = useState<{ valeur: string; libelle: string }[]>([]);
  const [lignes, setLignes]       = useState<LigneJustif[]>([]);
  const [editId, setEditId]       = useState<string | null>(null);
  // Fichier scanné en cours — archivé (bucket) à l'enregistrement pour re-consultation.
  const [scanFile, setScanFile]   = useState<File | null>(null);
  const [docView, setDocView]     = useState<DocumentViewerSource | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Justificatif | null>(null);
  const [deleting, setDeleting]   = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const rowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map());

  const load = async () => {
    const { data } = await (supabase.from("justificatifs") as any)
      .select("*")
      .eq("dossier_id", dossierId)
      .order("created_at", { ascending: false });
    // recu + droits_timbre → avis_debit en UI (contrainte DB ne permet pas encore avis_debit)
    const normalized = (data ?? []).map((j: Justificatif) =>
      j.type_document === "recu" && j.categorie_pcm === "droits_timbre"
        ? { ...j, type_document: "avis_debit" }
        : j
    );
    setJustificatifs(normalized);
  };

  useEffect(() => { load(); }, [dossierId]);

  const bcsDisponibles   = justificatifs.filter(j => j.type_document === "bon_commande");
  const devisDisponibles = justificatifs.filter(j => j.type_document === "devis");

  // Map numero_piece / numero_commande → id pour vérification locale instantanée
  const refMap = useMemo(() => {
    const m = new Map<string, string>();
    justificatifs.forEach(j => {
      if (j.numero_piece)    m.set(j.numero_piece.trim().toLowerCase(), j.id);
      if (j.numero_commande) m.set(j.numero_commande.trim().toLowerCase(), j.id);
    });
    return m;
  }, [justificatifs]);

  const scrollToJustif = (id: string) => {
    const el = rowRefs.current.get(id);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      setHighlightId(id);
      setTimeout(() => setHighlightId(null), 2000);
    }
  };

  const handleNumeroCommandeChange = (val: string) => {
    setForm(prev => {
      const updated = { ...prev, numero_commande: val };
      // Auto-liaison BC : cherche parmi toutes les références saisies
      const refs = val.split(",").map(r => r.trim()).filter(Boolean);
      if (refs.length > 0 && !prev.bon_commande_id) {
        const found = bcsDisponibles.find(bc =>
          refs.some(ref => bc.numero_commande === ref || bc.numero_piece === ref)
        );
        if (found) {
          updated.bon_commande_id = found.id;
          toast.info(`Liaison BC automatique : ${found.numero_piece ?? found.nom_tiers ?? found.id.slice(0, 8)}`);
        }
      }
      return updated;
    });
  };

  // ── KPIs ──────────────────────────────────────────────────────────────────
  const nonRapp      = justificatifs.filter(j => j.statut === "non_rapproche");
  const totalNonRapp = nonRapp.reduce((s, j) => s + Number(j.montant_ttc), 0);
  const byType       = TYPE_DOCUMENT.map(t => ({
    ...t,
    count: nonRapp.filter(j => j.type_document === t.value).length,
  }));

  const detectDocumentType = (text: string): string => {
    const t = text.toUpperCase();
    if (/DROIT\s+DE\s+TIMBRE|REMISE\s+LCN|LETTRE\s+DE\s+CHANGE|TIMBRE\s+FISCAL/.test(t)) return "avis_debit";
    if (/D[ÉE]CLARATION\s+UNIQUE\s+DES?\s+MARCHANDISES|\bDUM\b|QUITTANCE\s+DOUAN|BUREAU\s+DE\s+DOUANE|D[ÉE]DOUANEMENT/.test(t)) return "dum";
    if (/FACTURE\s+[ÉE]LECTRICIT[ÉE]|CONSOMMATION\s+[ÉE]LECTRIQUE/.test(t)) return "quittance_elec";
    if (/\bONEE\b|\bLYDEC\b|\bREDAL\b|\bAMENDIS\b|\bRADEEMA\b|FACTURE\s+(D['’]\s*)?EAU\b|CONSOMMATION\s+(D['’]\s*)?EAU\b/.test(t)) return "quittance_eau";
    if (/BON\s+D[EE]?\s+LIVRAISON|BORDEREAU\s+DE?\s+LIVRAISON|\bB\.?\s*L\.?\b/.test(t)) return "bon_livraison";
    if (/BON\s+D[EE]?\s+COMMANDE|\bB\.?\s*C\.?\b|PURCHASE\s+ORDER/.test(t)) return "bon_commande";
    if (/NOTE\s+DE\s+FRAIS|\bN\.?\s*D\.?\s*F\.?\b/.test(t)) return "note_frais";
    if (/\bADDITION\b|TICKET\s+DE?\s+CAISSE|TICKET\s+RESTO/.test(t)) return "addition";
    if (/\bAVIS\s+DE\s+D[ÉE]BIT\b/.test(t)) return "avis_debit";
    if (/\bQUITTANCE\b|RE[ÇC]U\s+DE\s+PAIEMENT|RE[ÇC]U\s+N[°O]|\bREÇU\b|\bRECU\b|\bRECEIPT\b/.test(t)) return "recu";
    return "recu";
  };

  const JUSTIF_TYPE_MAP: Record<string, string> = {
    bon_livraison: "bon_livraison",
    bon_commande:  "bon_commande",
    note_frais:    "note_frais",
    addition:      "addition",
    recu:          "recu",
    facture:       "recu",
    dum:            "dum",
    avis_debit:     "avis_debit",
    quittance_eau:  "quittance_eau",
    quittance_elec: "quittance_elec",
  };

  // ── OCR upload ─────────────────────────────────────────────────────────────
  const handleUpload = async (file: File) => {
    setForm({ ...EMPTY_FORM });
    setLignes([]);
    setDatesRef([]);
    setEditId(null);
    setScanFile(file);
    setOcrLoading(true);
    try {
      let extractedText = "";
      let imageBase64: string | undefined;
      let ocrMime = file.type;
      const isImage = file.type.startsWith("image/");

      if (isImage) {
        imageBase64 = await new Promise<string>((res, rej) => {
          const reader = new FileReader();
          reader.onload = () => res((reader.result as string).split(",")[1]);
          reader.onerror = rej;
          reader.readAsDataURL(file);
        });
      } else {
        const pdfjsLib = await import("pdfjs-dist");
        pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
        const ab = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: ab.slice(0) }).promise;
        for (let i = 1; i <= pdf.numPages; i++) {
          const page    = await pdf.getPage(i);
          const content = await page.getTextContent();
          extractedText += (content.items as any[]).map((it: any) => it.str).join(" ") + "\n";
        }
        const textNonWs = extractedText.replace(/\s/g, "").length;
        if (textNonWs < 300) {
          toast.info("Peu de texte détecté — passage en mode vision…");
          const pdfjsLib2 = await import("pdfjs-dist");
          pdfjsLib2.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
          const ab2  = await file.arrayBuffer();
          const pdf2 = await pdfjsLib2.getDocument({ data: ab2.slice(0) }).promise;
          const page = await pdf2.getPage(1);
          const viewport = page.getViewport({ scale: 2.0 });
          const canvas   = document.createElement("canvas");
          canvas.width = viewport.width; canvas.height = viewport.height;
          await page.render({ canvasContext: canvas.getContext("2d")!, viewport }).promise;
          imageBase64   = canvas.toDataURL("image/jpeg", 0.92).split(",")[1];
          ocrMime       = "image/jpeg";
          extractedText = "";
        }
      }

      const detectedType = detectDocumentType(extractedText);
      const { result }   = await ocrFn({
        data: {
          extracted_text: extractedText,
          image_base64:   imageBase64,
          mime_type:      ocrMime,
          dossier_id:     dossierId,
        },
      });

      console.log("[DEBUG OCR]", JSON.stringify(result, null, 2));
      logAudit({ dossierId, action: "scan_facture", ressourceType: "justificatif", details: { type: (result as any).type_document_justificatif ?? null } });

      const aiType    = (result as any).type_document_justificatif;
      let finalType = (aiType && aiType !== "facture")
        ? (JUSTIF_TYPE_MAP[aiType] ?? detectedType)
        : detectedType;
      const validCats = new Set(CATEGORIES_PCM.map(c => c.value));
      const aiCat    = (result as any).categorie_pcm;
      const nomTiers = result.emetteur_nom || result.client_nom_extrait || "";
      const localCat = inferCatFromContent(nomTiers, result.lignes ?? [], finalType);

      // Catégorie brute depuis contenu / IA / sens
      const rawCat =
        localCat ??
        (aiCat && validCats.has(aiCat) ? aiCat : null) ??
        (result.sens_facture === "client" ? "encaissement_client" : "paiement_fournisseur");

      // Override selon le type de document (matrice fiscale)
      const cat =
        finalType === "dum"           ? "tva_import"          :
        finalType === "bon_commande"  ? "acompte_fournisseur" :
        finalType === "quittance_eau" || finalType === "quittance_elec" ? "eau_electricite" :
        rawCat;

      const ttc = result.montant_ttc > 0 ? result.montant_ttc : 0;
      const fiscalOverrides = applyFiscalRules(cat, finalType, ttc, EMPTY_FORM);

      // N° pièce des avis de débit (droits de timbre, frais sur effets/chèques) :
      // priorité au N° de LCN ou de chèque mentionné dans le libellé — c'est lui qui
      // figure sur le relevé bancaire du client et sert au rapprochement. Le n° d'avis
      // interne de la banque n'est utilisé qu'en dernier recours.
      let numeroPiece = result.numero_facture || (result as any).numero_compteur || "";
      if (finalType === "avis_debit" && extractedText) {
        const mLcn = extractedText.match(/LCN\s*(?:N[°ºO])?\s*[:.\-]?\s*(\d[\dA-Z\-\/]*)/i)
                  ?? extractedText.match(/N[°ºO]\s*LCN\s*[:.\-]?\s*(\d[\dA-Z\-\/]*)/i);
        const mChq = extractedText.match(/CH(?:[ÈE]QUE|Q)\s*(?:N[°ºO])?\s*[:.\-]?\s*(\d[\d\-\/]*)/i);
        const mOp  = extractedText.match(/N[°ºO]\s*(?:D['’]\s*)?(?:OP[ÉE]RATION|AVIS)\s*[:.\-]?\s*([A-Z0-9][\w\-\/]*)/i);
        if (mLcn?.[1]) numeroPiece = mLcn[1];
        else if (mChq?.[1]) numeroPiece = mChq[1];
        else if (mOp?.[1]) numeroPiece = mOp[1];
      }

      // Mapping automatique compte PCM / taux TVA : IA > défaut du type de document > catégorie
      const aiCompte  = (result as any).compte_pcm;
      const pcmDef    = TYPE_PCM_DEFAULTS[finalType];
      const comptePcm =
        (typeof aiCompte === "string" && /^\d{4,6}$/.test(aiCompte.trim()) ? aiCompte.trim() : null) ??
        pcmDef?.compte ??
        PCM_CODE[cat] ??
        "6141";
      const tauxTva = result.taux_tva != null ? result.taux_tva : (pcmDef?.tva ?? 0);

      // Override "dur" : un compte 61312 (Locations de constructions) ⇒ Quittance de loyer.
      // Garantit que le type affiché suit le PCM même si l'OCR a typé "recu".
      if (comptePcm === "61312") finalType = "quittance_loyer";

      setForm({
        ...EMPTY_FORM,
        type_document:   finalType,
        nom_tiers:       nomTiers,
        montant_ttc:     ttc,
        montant_ht:      result.montant_ht > 0 ? result.montant_ht : 0,
        taux_tva:        tauxTva,
        date_document:   normDateToISO(result.date_facture) || new Date().toISOString().slice(0, 10),
        date_commande:   normDateToISO((result as any).date_commande),
        numero_piece:    numeroPiece,
        numero_commande: (result as any).numero_commande || "",
        flux_type:       result.sens_facture === "client" ? "vente" : "achat",
        categorie_pcm:   cat,
        compte_pcm:      comptePcm,
        ...fiscalOverrides, // applique tva_zero_doc, tva_non_deductible, edi_bloque
      });

      const periode = (result as any).periode;
      const isQuittanceEnergie = finalType === "quittance_eau" || finalType === "quittance_elec";
      setLignes((result.lignes ?? []).map((l: any) => ({
        designation:
          isQuittanceEnergie && periode && (!l.designation || l.designation === "Prestation (à préciser)")
            ? `Consommation ${finalType === "quittance_eau" ? "eau" : "électricité"} — période ${periode}`
            : (l.designation || ""),
        quantite:      l.quantite      || 1,
        prix_unitaire: l.prix_unitaire || 0,
        taux_tva:      l.taux_tva,
      })));
      setDatesRef((result as any).dates_reference ?? []);
      setOpen(true);
      toast.success(`OCR terminé — type détecté : ${TYPE_DOCUMENT.find(t => t.value === finalType)?.label ?? finalType}`);
    } catch (e: any) {
      toast.error("Erreur OCR : " + e.message);
      setOpen(true);
    } finally {
      setOcrLoading(false);
    }
  };

  // ── Ouvrir en mode édition ──────────────────────────────────────────────────
  const handleEdit = (j: Justificatif) => {
    setEditId(j.id);
    setForm({
      type_document:   j.type_document,
      flux_type:       j.flux_type,
      nom_tiers:       j.nom_tiers       ?? "",
      montant_ttc:     Number(j.montant_ttc),
      montant_ht:      Number(j.montant_ht),
      taux_tva:        Number(j.taux_tva),
      date_document:   j.date_document   ?? new Date().toISOString().slice(0, 10),
      date_commande:   j.date_commande   ?? "",
      numero_piece:    j.numero_piece    ?? "",
      numero_commande: j.numero_commande ?? "",
      bon_commande_id: j.bon_commande_id ?? "",
      devis_id:        j.devis_id        ?? "",
      categorie_pcm:   j.categorie_pcm   ?? "paiement_fournisseur",
      compte_pcm:      j.compte_pcm      ?? "4411",
      eligible_edi:    j.eligible_edi,
    });
    setLignes(j.lignes ?? []);
    setDatesRef([]);
    setOpen(true);
  };

  // ── Sauvegarde (insert ou update) ──────────────────────────────────────────
  const handleSave = async () => {
    if (!form.nom_tiers) { toast.error("Le nom du tiers est requis"); return; }
    const montantOptional = form.type_document === "bon_livraison" || form.type_document === "bon_commande";
    if (!form.montant_ttc && !montantOptional) { toast.error("Tiers et montant TTC requis"); return; }
    if (!form.montant_ttc && (form.type_document === "facture" || form.type_document === "recu")) {
      toast.warning("Montant TTC à 0 — vérifiez avant d'enregistrer");
    }
    setSaving(true);
    try {
      const dbTypeDocument = toDbType(form.type_document);
      const payload = {
        type_document:   dbTypeDocument,
        flux_type:       form.flux_type,
        nom_tiers:       form.nom_tiers,
        montant_ttc:     form.montant_ttc,
        montant_ht:      form.montant_ht,
        taux_tva:        form.taux_tva,
        date_document:   form.date_document  || null,
        date_commande:   form.date_commande  || null,
        numero_piece:    form.numero_piece    || null,
        numero_commande: form.numero_commande || null,
        bon_commande_id: form.bon_commande_id || null,
        devis_id:        form.devis_id        || null,
        categorie_pcm:   form.categorie_pcm,
        compte_pcm:      form.compte_pcm,
        eligible_edi:    FISCAL_RULES[form.categorie_pcm]?.edi_bloque ? false : form.eligible_edi,
        lignes:          lignes.length > 0 ? lignes : null,
      };

      if (editId) {
        const { error } = await (supabase.from("justificatifs") as any)
          .update(payload).eq("id", editId);
        if (error) throw error;
        toast.success("Justificatif modifié");
      } else {
        const { data: newJusti, error } = await (supabase.from("justificatifs") as any).insert({
          ...payload,
          dossier_id: dossierId,
          statut:     "non_rapproche",
        }).select("id").single();
        if (error) throw error;
        toast.success("Justificatif enregistré");
        // Archive le document scanné (pour re-consultation : bouton Voir + GED).
        if (newJusti && scanFile) {
          try {
            const ext = scanFile.name.split(".").pop() || "bin";
            const path = `${dossierId}/justif_${newJusti.id}.${ext}`;
            const { error: upErr } = await supabase.storage.from("factures-originales").upload(path, scanFile, { upsert: true });
            if (!upErr) {
              const { data: urlData } = supabase.storage.from("factures-originales").getPublicUrl(path);
              await (supabase.from("justificatifs") as any).update({
                fichier_original_url: urlData?.publicUrl ?? null,
                fichier_original_nom: scanFile.name,
                fichier_original_type: scanFile.type,
              }).eq("id", newJusti.id);
            }
          } catch { /* archivage best-effort */ }
        }
        // Lettrage précis à l'enregistrement : montant EXACT + date (paiement/échéance,
        // marge ±2 j), sur tous les comptes du dossier (même tx clôturées non lettrées).
        // Génère l'écriture comptable (compte PCM → Grand Livre). Repli sur le matcher
        // de scoring existant si aucune correspondance exacte (aucune régression).
        if (newJusti && form.montant_ttc > 0) {
          lettrerFn({ data: {
            dossier_id:      dossierId,
            justificatif_id: newJusti.id,
            montant_ttc:     form.montant_ttc,
            date_paiement:   form.date_document || "", // quittance/reçu : date doc = date de paiement
            date_echeance:   "",                        // pas d'échéance saisie au formulaire
          }}).then(res => {
            if (res.match) {
              toast.success(`✅ Lettré automatiquement à la transaction du ${res.tx_date} (${res.tx_montant} MAD) — Grand Livre mis à jour`);
              load();
              return;
            }
            // Repli : moteur de scoring existant (lien sans génération d'écriture)
            return matchFn({ data: {
              dossier_id: dossierId, document_id: newJusti.id, document_type: "justificatif",
              montant_ttc: form.montant_ttc, nom_tiers: form.nom_tiers,
              date_document: form.date_document, mode_reglement: "",
              numero_piece: form.numero_piece || "",
            }}).then(r2 => {
              if (r2.match) { toast.success(`✅ Lié automatiquement à la transaction du ${r2.tx_date} — ${r2.tx_montant} MAD`); load(); }
              else toast.info("Aucune transaction bancaire à lettrer (montant exact + date, ni score ≥ 80).");
            });
          }).catch((e) => { console.error("[LETTRAGE] erreur:", e); toast.warning("Lettrage automatique non exécuté : " + (e?.message ?? e)); });
        }
      }

      setOpen(false);
      setEditId(null);
      setForm({ ...EMPTY_FORM });
      setScanFile(null);
      load();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  // ── Suppression ────────────────────────────────────────────────────────────
  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      // Nullifier les références pointant vers ce document
      await (supabase.from("justificatifs") as any)
        .update({ bon_commande_id: null }).eq("bon_commande_id", deleteTarget.id);
      await (supabase.from("justificatifs") as any)
        .update({ devis_id: null }).eq("devis_id", deleteTarget.id);
      const { error } = await (supabase.from("justificatifs") as any)
        .delete().eq("id", deleteTarget.id);
      if (error) throw error;
      toast.success("Justificatif supprimé");
      setDeleteTarget(null);
      load();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setDeleting(false);
    }
  };

  // ── Vue / Impression ────────────────────────────────────────────────────────
  const handleView = (j: Justificatif) => {
    const win = window.open("", "_blank");
    if (win) { win.document.write(generateJustifHTML(j)); win.document.close(); }
    else toast.error("Popup bloquée — autorisez les popups pour ce site.");
  };

  // ── Helpers ─────────────────────────────────────────────────────────────────
  const typeLabelOf = (v: string) => TYPE_DOCUMENT.find(t => t.value === v)?.label ?? v;

  const getDocRefs = (j: Justificatif): string[] => {
    const refs: string[] = [];
    if (j.numero_commande) refs.push(`Cde: ${j.numero_commande}`);
    if (j.bon_commande_id) {
      const bc = justificatifs.find(x => x.id === j.bon_commande_id);
      refs.push(bc?.numero_piece ? `BC: ${bc.numero_piece}` : "BC lié");
    }
    if (j.devis_id) {
      const dv = justificatifs.find(x => x.id === j.devis_id);
      refs.push(dv?.numero_piece ? `Devis: ${dv.numero_piece}` : "Devis lié");
    }
    return refs;
  };

  // ── Rendu ──────────────────────────────────────────────────────────────────
  return (
    <div className="p-8 max-w-7xl mx-auto">
      {/* En-tête */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Paperclip className="h-7 w-7" /> Justificatifs
          </h1>
          <p className="text-muted-foreground mt-1">
            Reçus · Bons de commande · Bons de livraison · Notes de frais
          </p>
        </div>
        <div className="flex gap-2">
          <input
            ref={fileRef} type="file" className="hidden"
            accept=".pdf,.jpg,.jpeg,.png"
            onChange={e => {
              const f = e.target.files?.[0];
              if (f) { handleUpload(f); e.target.value = ""; }
            }}
          />
          <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={ocrLoading}>
            {ocrLoading
              ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              : <Upload className="h-4 w-4 mr-2" />}
            Scanner (OCR)
          </Button>
          <Button onClick={() => {
            setEditId(null);
            setForm({ ...EMPTY_FORM });
            setDatesRef([]);
            setLignes([]);
            setScanFile(null);   // saisie manuelle → pas de fichier scanné à rattacher
            setOpen(true);
          }}>
            <Plus className="h-4 w-4 mr-2" />Ajouter manuellement
          </Button>
        </div>
      </div>

      {/* ── KPIs ── */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-3 mb-6">
        <Card className="col-span-2 md:col-span-1">
          <CardContent className="pt-4 pb-4">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Non rapprochés</p>
            <p className="text-3xl font-bold mt-1">{nonRapp.length}</p>
          </CardContent>
        </Card>
        <Card className="col-span-2 md:col-span-2">
          <CardContent className="pt-4 pb-4">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Montant total non rapproché</p>
            <p className="text-xl font-bold mt-1 text-orange-600">{fmt(totalNonRapp)}</p>
          </CardContent>
        </Card>
        {byType.map(t => (
          <Card key={t.value}>
            <CardContent className="pt-4 pb-4">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide truncate">{t.label}</p>
              <p className="text-2xl font-bold mt-1">{t.count}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── Table ── */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead className="font-mono text-xs">Cpte PCM</TableHead>
                <TableHead>Tiers</TableHead>
                <TableHead>N° pièce</TableHead>
                <TableHead className="text-right">Montant TTC</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Doc. Réf</TableHead>
                <TableHead>Statut</TableHead>
                <TableHead className="text-right w-[100px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {justificatifs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-14 text-muted-foreground">
                    <FileText className="h-9 w-9 mx-auto mb-2 opacity-25" />
                    <p>Aucun justificatif — scannez un document ou ajoutez manuellement</p>
                  </TableCell>
                </TableRow>
              ) : justificatifs.map(j => {
                const refs = getDocRefs(j);
                const isHighlighted = highlightId === j.id;
                return (
                  <TableRow
                    key={j.id}
                    ref={el => { if (el) rowRefs.current.set(j.id, el); else rowRefs.current.delete(j.id); }}
                    className={`transition-colors duration-300 ${isHighlighted ? "bg-yellow-100 dark:bg-yellow-900/30" : ""}`}
                  >
                    <TableCell>
                      <Badge variant="outline" className="text-xs whitespace-nowrap">
                        {typeLabelOf(j.type_document)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs font-mono text-muted-foreground">
                      {j.compte_pcm ?? "—"}
                    </TableCell>
                    <TableCell className="text-sm font-medium max-w-[140px] truncate">
                      {j.nom_tiers ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground font-mono">
                      {j.numero_piece ?? "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm font-semibold">
                      {fmt(Number(j.montant_ttc))}
                    </TableCell>
                    <TableCell className="text-sm tabular-nums">
                      {j.date_document ?? "—"}
                    </TableCell>
                    <TableCell className="max-w-[160px]">
                      {refs.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {refs.map((r, i) => {
                            // Extraire le numero brut pour trouver l'id lié
                            const rawNum = r.replace(/^(?:Cde|BC|Devis):\s*/i, "");
                            const linkedId = refMap.get(rawNum.toLowerCase());
                            const clickable = linkedId && linkedId !== j.id;
                            return clickable ? (
                              <button
                                key={i}
                                type="button"
                                onClick={() => scrollToJustif(linkedId)}
                                className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0 rounded-full border bg-green-50 text-green-700 border-green-300 hover:bg-green-100 font-medium cursor-pointer"
                              >
                                ✅ {r}
                              </button>
                            ) : (
                              <Badge key={i} variant="secondary" className="text-[10px] px-1.5 py-0 font-normal">
                                {r}
                              </Badge>
                            );
                          })}
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {j.statut === "rapproche"
                        ? <Badge className="bg-green-100 text-green-700 text-xs">✅ Rapproché</Badge>
                        : <Badge className="bg-orange-100 text-orange-700 text-xs">⏳ En attente</Badge>}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-0.5">
                        {j.fichier_original_url && (
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0"
                            title="Voir le document scanné"
                            onClick={() => setDocView({ title: `Justificatif ${j.numero_piece ?? ""}`.trim(), url: j.fichier_original_url, fileName: j.fichier_original_nom, mimeType: j.fichier_original_type })}>
                            <FileText className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0"
                          title="Voir / Imprimer" onClick={() => handleView(j)}>
                          <Eye className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0"
                          title="Modifier" onClick={() => handleEdit(j)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost"
                          className="h-7 w-7 p-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                          title="Supprimer" onClick={() => setDeleteTarget(j)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* ── Dialog ajout / modification / OCR ── */}
      <Dialog open={open} onOpenChange={v => {
        if (!saving) { setOpen(v); if (!v) { setDatesRef([]); setLignes([]); setEditId(null); } }
      }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editId ? "Modifier le justificatif" : "Nouveau justificatif"}</DialogTitle>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-4 py-2">
            {/* Type document */}
            <div className="space-y-2">
              <Label>Type de document *</Label>
              <Select
                value={form.type_document}
                onValueChange={v => {
                  const pcmDef = TYPE_PCM_DEFAULTS[v];
                  setForm(prev => ({
                    ...prev,
                    type_document: v,
                    ...(pcmDef ? { compte_pcm: pcmDef.compte, taux_tva: pcmDef.tva } : {}),
                  }));
                }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TYPE_DOCUMENT_GROUPS.map(g => (
                    <SelectGroup key={g.label}>
                      <SelectLabel className="text-xs font-semibold text-muted-foreground uppercase tracking-wide px-2 py-1">
                        {g.label}
                      </SelectLabel>
                      {g.items.map(t => (
                        <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Flux */}
            <div className="space-y-2">
              <Label>Flux *</Label>
              <Select value={form.flux_type} onValueChange={v => setForm({ ...form, flux_type: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="achat">Achat (débit)</SelectItem>
                  <SelectItem value="vente">Vente (crédit)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Tiers */}
            <div className="space-y-2 col-span-2">
              <Label>Nom du tiers *</Label>
              <Input value={form.nom_tiers}
                onChange={e => setForm({ ...form, nom_tiers: e.target.value })}
                placeholder="Fournisseur, client, prestataire…" />
            </div>

            {/* Montant TTC */}
            <div className="space-y-2">
              <Label>
                Montant TTC (MAD)
                {(form.type_document === "bon_livraison" || form.type_document === "bon_commande") ? " (optionnel)" : " *"}
              </Label>
              <Input type="number" step="0.01" value={form.montant_ttc || ""}
                onChange={e => {
                  const ttc = parseFloat(e.target.value) || 0;
                  const ht  = form.taux_tva > 0 ? Math.round(ttc / (1 + form.taux_tva / 100) * 100) / 100 : ttc;
                  setForm({ ...form, montant_ttc: ttc, montant_ht: ht });
                }} />
            </div>

            {/* Montant HT */}
            <div className="space-y-2">
              <Label>Montant HT (MAD)</Label>
              <Input type="number" step="0.01" value={form.montant_ht || ""}
                onChange={e => setForm({ ...form, montant_ht: parseFloat(e.target.value) || 0 })} />
            </div>

            {/* TVA */}
            <div className="space-y-2">
              <Label>Taux TVA (%)</Label>
              <Input type="number" step="1" value={form.taux_tva}
                onChange={e => {
                  const tva = parseFloat(e.target.value) || 0;
                  const ht  = tva > 0 ? Math.round(form.montant_ttc / (1 + tva / 100) * 100) / 100 : form.montant_ttc;
                  setForm({ ...form, taux_tva: tva, montant_ht: ht });
                }} />
            </div>

            {/* Date document */}
            <div className="space-y-2">
              <Label>Date du document</Label>
              <Input type="date" value={form.date_document}
                onChange={e => setForm({ ...form, date_document: e.target.value })} />
            </div>

            {/* Dates OCR */}
            {datesRef.length > 0 && (
              <div className="col-span-2 space-y-1.5">
                <Label className="text-xs text-muted-foreground">Autres dates détectées (lecture seule)</Label>
                <div className="flex flex-wrap gap-1.5">
                  {datesRef.map((d, i) => (
                    <Badge key={i} variant="secondary" className="text-xs font-normal py-0.5 px-2">
                      <span className="text-muted-foreground mr-1.5">{d.libelle} :</span>
                      <span className="font-mono">{d.valeur}</span>
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Date commande */}
            <div className="space-y-2">
              <Label>Date de commande <span className="text-[10px] text-muted-foreground">(optionnel)</span></Label>
              <Input type="date" value={form.date_commande}
                onChange={e => setForm({ ...form, date_commande: e.target.value })} />
            </div>

            {/* N° pièce */}
            <div className="space-y-2">
              <Label>N° pièce / référence</Label>
              <Input value={form.numero_piece}
                onChange={e => setForm({ ...form, numero_piece: e.target.value })}
                placeholder="BL-186/2022, BC-042…" />
            </div>

            {/* ── Section Documents Réf. ── */}
            <div className="col-span-2 border-t pt-3">
              <p className="text-sm font-semibold mb-3">
                Documents Réf.
                <span className="text-[11px] text-muted-foreground font-normal ml-2">
                  Liens vers BC, devis, numéro de commande — peut en avoir 0, 1 ou plusieurs
                </span>
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">
                    N° commande référencé
                    <span className="font-normal ml-1 opacity-60">(plusieurs : séparés par virgule)</span>
                  </Label>
                  <Input value={form.numero_commande}
                    onChange={e => handleNumeroCommandeChange(e.target.value)}
                    placeholder="BC-042, PO-2024-001…" />
                  {/* Chips de vérification en temps réel */}
                  {form.numero_commande && (
                    <div className="flex flex-wrap gap-1 pt-0.5">
                      {form.numero_commande.split(",").map(r => r.trim()).filter(Boolean).map((ref, i) => {
                        const matchId = refMap.get(ref.toLowerCase());
                        const found   = !!matchId && matchId !== editId;
                        return found ? (
                          <button
                            key={i}
                            type="button"
                            onClick={() => { setOpen(false); setEditId(null); setTimeout(() => scrollToJustif(matchId!), 150); }}
                            className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border bg-green-50 text-green-700 border-green-300 hover:bg-green-100 font-medium cursor-pointer"
                            title="Cliquer pour localiser dans la liste"
                          >
                            ✅ {ref}
                          </button>
                        ) : (
                          <span
                            key={i}
                            className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border bg-gray-50 text-gray-400 border-gray-200 font-medium"
                            title="Aucun justificatif correspondant trouvé"
                          >
                            ○ {ref}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">Lier à un BC existant</Label>
                  <Select value={form.bon_commande_id || "__none__"}
                    onValueChange={v => setForm({ ...form, bon_commande_id: v === "__none__" ? "" : v })}>
                    <SelectTrigger><SelectValue placeholder="— aucun —" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">— aucun —</SelectItem>
                      {bcsDisponibles.map(bc => (
                        <SelectItem key={bc.id} value={bc.id}>
                          {bc.numero_piece ?? bc.nom_tiers ?? bc.id.slice(0, 8)}
                          {bc.date_document ? ` — ${bc.date_document}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">Lier à un devis existant</Label>
                  <Select value={form.devis_id || "__none__"}
                    onValueChange={v => setForm({ ...form, devis_id: v === "__none__" ? "" : v })}>
                    <SelectTrigger><SelectValue placeholder="— aucun —" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">— aucun —</SelectItem>
                      {devisDisponibles.map(d => (
                        <SelectItem key={d.id} value={d.id}>
                          {d.numero_piece ?? d.nom_tiers ?? d.id.slice(0, 8)}
                          {d.date_document ? ` — ${d.date_document}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Résumé chips des refs actives */}
                {(form.bon_commande_id || form.devis_id || form.numero_commande) && (
                  <div className="flex flex-wrap gap-1.5 items-start col-span-2">
                    {form.numero_commande && (
                      <Badge variant="secondary" className="text-xs gap-1 pr-1">
                        Cde : {form.numero_commande}
                        <button onClick={() => setForm(f => ({ ...f, numero_commande: "" }))}
                          className="opacity-50 hover:opacity-100 ml-0.5">
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </Badge>
                    )}
                    {form.bon_commande_id && (
                      <Badge variant="secondary" className="text-xs gap-1 pr-1">
                        {(() => { const bc = bcsDisponibles.find(x => x.id === form.bon_commande_id); return `BC: ${bc?.numero_piece ?? bc?.nom_tiers ?? form.bon_commande_id.slice(0, 6)}`; })()}
                        <button onClick={() => setForm(f => ({ ...f, bon_commande_id: "" }))}
                          className="opacity-50 hover:opacity-100 ml-0.5">
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </Badge>
                    )}
                    {form.devis_id && (
                      <Badge variant="secondary" className="text-xs gap-1 pr-1">
                        {(() => { const dv = devisDisponibles.find(x => x.id === form.devis_id); return `Devis: ${dv?.numero_piece ?? dv?.nom_tiers ?? form.devis_id.slice(0, 6)}`; })()}
                        <button onClick={() => setForm(f => ({ ...f, devis_id: "" }))}
                          className="opacity-50 hover:opacity-100 ml-0.5">
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </Badge>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Lignes / Articles */}
            <div className="col-span-2 space-y-2 pt-1 border-t">
              <div className="flex items-center justify-between">
                <Label>Articles / Désignations</Label>
                <Button type="button" size="sm" variant="outline"
                  onClick={() => setLignes(prev => [...prev, { ...EMPTY_LIGNE }])}>
                  <Plus className="h-3 w-3 mr-1" />Ajouter ligne
                </Button>
              </div>
              {lignes.length === 0 ? (
                <p className="text-xs text-muted-foreground py-1">
                  Aucune ligne — scannez le document ou ajoutez manuellement
                </p>
              ) : (
                <div className="border rounded-md overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/40">
                        <TableHead className="text-xs">Désignation</TableHead>
                        <TableHead className="text-xs w-16">Qté</TableHead>
                        <TableHead className="text-xs w-28">P.U. HT</TableHead>
                        <TableHead className="text-xs w-20">TVA %</TableHead>
                        <TableHead className="text-xs w-24 text-right">Total HT</TableHead>
                        <TableHead className="w-8"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {lignes.map((l, i) => (
                        <TableRow key={i}>
                          <TableCell className="py-1">
                            <Input className="h-7 text-xs" value={l.designation}
                              onChange={e => setLignes(prev => prev.map((x, j) => j === i ? { ...x, designation: e.target.value } : x))}
                              placeholder="Désignation…" />
                          </TableCell>
                          <TableCell className="py-1">
                            <Input className="h-7 text-xs" type="number" min="0" step="1" value={l.quantite}
                              onChange={e => setLignes(prev => prev.map((x, j) => j === i ? { ...x, quantite: parseFloat(e.target.value) || 0 } : x))} />
                          </TableCell>
                          <TableCell className="py-1">
                            <Input className="h-7 text-xs" type="number" min="0" step="0.01" value={l.prix_unitaire || ""}
                              onChange={e => setLignes(prev => prev.map((x, j) => j === i ? { ...x, prix_unitaire: parseFloat(e.target.value) || 0 } : x))} />
                          </TableCell>
                          <TableCell className="py-1">
                            <Input className="h-7 text-xs" type="number" min="0" step="1" value={l.taux_tva ?? ""} placeholder="—"
                              onChange={e => setLignes(prev => prev.map((x, j) => j === i ? { ...x, taux_tva: e.target.value === "" ? null : parseFloat(e.target.value) } : x))} />
                          </TableCell>
                          <TableCell className="py-1 text-right font-mono text-xs">
                            {fmt(l.quantite * l.prix_unitaire)}
                          </TableCell>
                          <TableCell className="py-1">
                            <Button type="button" size="sm" variant="ghost" className="h-6 w-6 p-0"
                              onClick={() => setLignes(prev => prev.filter((_, j) => j !== i))}>
                              <X className="h-3 w-3" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <div className="px-4 py-1.5 bg-muted/20 flex justify-end text-xs">
                    <span className="text-muted-foreground">Total HT :</span>
                    <span className="font-semibold ml-2">
                      {fmt(lignes.reduce((s, l) => s + l.quantite * l.prix_unitaire, 0))}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Catégorie PCM */}
            <div className="space-y-2">
              <Label>Catégorie PCM</Label>
              <Select value={form.categorie_pcm}
                onValueChange={v => setForm({
                  ...form,
                  categorie_pcm: v,
                  compte_pcm:    PCM_CODE[v] ?? "6141",
                  ...applyFiscalRules(v, form.type_document, form.montant_ttc, form),
                })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CATEGORIES_PCM.map(c => (
                    <SelectItem key={c.value} value={c.value} className="text-sm">{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Compte PCM / Auxiliaire — modifiable manuellement (comptes auxiliaires client/fournisseur, correction IA) */}
            <div className="space-y-2">
              <Label>Compte PCM / Auxiliaire</Label>
              <Input
                value={form.compte_pcm}
                onChange={e => setForm({ ...form, compte_pcm: e.target.value })}
                placeholder="Ex : 61312, 3421C0001, 4411F0002…"
                className="font-mono text-sm"
              />
              <p className="text-[10px] text-muted-foreground">
                Calculé automatiquement par l'IA — modifiable (compte auxiliaire ou correction). La valeur saisie est conservée à l'enregistrement.
              </p>
            </div>

            {/* EDI + alertes fiscales */}
            {(() => {
              const rule   = FISCAL_RULES[form.categorie_pcm];
              const locked = rule?.edi_bloque === true;
              const alerte = rule?.alerte;
              const alerteIsWarning = alerte?.startsWith("⚠️");
              const alerteIsInfo    = alerte?.startsWith("ℹ️");
              const alerteIsOk      = alerte?.startsWith("✅");
              return (
                <div className={`col-span-2 space-y-2 pt-1 border-t ${locked ? "opacity-80" : ""}`}>
                  <div className="flex items-start gap-3">
                    <Checkbox
                      id="edi"
                      checked={!locked && form.eligible_edi}
                      disabled={locked}
                      onCheckedChange={v => !locked && setForm({ ...form, eligible_edi: !!v })}
                      className="mt-0.5"
                    />
                    <div className="flex-1">
                      <Label htmlFor="edi" className={`font-medium ${locked ? "text-muted-foreground cursor-not-allowed" : "cursor-pointer"}`}>
                        Éligible EDI DGI
                      </Label>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Inclure dans le relevé de déduction TVA (ADC082F-15I). Cochez uniquement si la TVA est récupérable.
                      </p>
                    </div>
                  </div>
                  {alerte && (
                    <p className={`text-xs rounded px-3 py-2 border ${
                      alerteIsWarning ? "text-amber-800 bg-amber-50 border-amber-200" :
                      alerteIsOk      ? "text-green-800 bg-green-50 border-green-200" :
                      alerteIsInfo    ? "text-blue-800 bg-blue-50 border-blue-200" :
                                        "text-muted-foreground bg-muted border-muted"
                    }`}>
                      {alerte}
                    </p>
                  )}
                </div>
              );
            })()}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>Annuler</Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {editId ? "Enregistrer les modifications" : "Enregistrer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Confirmation suppression ── */}
      <Dialog open={!!deleteTarget} onOpenChange={v => { if (!deleting && !v) setDeleteTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-destructive">Supprimer le justificatif ?</DialogTitle>
          </DialogHeader>
          <div className="py-3 space-y-3 text-sm">
            <p>Vous êtes sur le point de supprimer définitivement :</p>
            {deleteTarget && (
              <div className="bg-muted rounded-md p-3 space-y-1">
                <p className="font-semibold">{deleteTarget.nom_tiers ?? "—"}</p>
                <p className="text-muted-foreground text-xs">
                  {typeLabelOf(deleteTarget.type_document)} · {deleteTarget.date_document ?? "—"} · {fmt(Number(deleteTarget.montant_ttc))}
                </p>
                {deleteTarget.numero_piece && (
                  <p className="text-xs font-mono text-muted-foreground">Réf. {deleteTarget.numero_piece}</p>
                )}
              </div>
            )}
            <p className="text-muted-foreground text-xs">
              Cette action est irréversible. Les liaisons BC / devis pointant vers ce document seront également nullifiées.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>Annuler</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Supprimer définitivement
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Aperçu du document scanné (panneau latéral droit) */}
      <DocumentViewer open={!!docView} onOpenChange={(o) => { if (!o) setDocView(null); }} source={docView} />
    </div>
  );
}
