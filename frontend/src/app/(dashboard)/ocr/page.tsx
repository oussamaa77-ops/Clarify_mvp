"use client";

import { useState, useRef } from "react";
import { Upload, FileText, CheckCircle, AlertCircle, Loader2, Info, TrendingUp, TrendingDown, CreditCard } from "lucide-react";
import { apiFetch, API_BASE_URL } from "../../../lib/api";

type OcrResult = {
  fournisseur: string;
  ice: string;
  date: string;
  date_echeance: string;
  methode_paiement: string;
  est_paye: boolean;
  numero: string;
  montant_ht: number;
  tva: number;
  montant_ttc: number;
  taux_tva: number;
  description: string;
  compte_charge: string;
  compte_charge_nom: string;
  sha256: string;
  confiance: string;
  est_conforme?: boolean;
  manques_conformite?: string[];
  type_document?: string;
  classification?: string;
  raisonnement?: string;
  emetteur?: any;
  destinataire?: any;
  compte_comptable?: string;
  compliance_level?: string;
  is_blocking?: boolean;
  missing_critical?: string[];
  missing_important?: string[];
  completion_suggestions?: any;
  warnings?: string[];
};

const PAYMENT_METHODS = [
  { value: "", label: "Non spécifié" },
  { value: "virement", label: "Virement bancaire" },
  { value: "cheque", label: "Chèque" },
  { value: "especes", label: "Espèces" },
  { value: "carte", label: "Carte bancaire" },
  { value: "effet", label: "Effet de commerce" },
];

// Date J+30 par défaut
const defaultDueDate = () => {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d.toISOString().split("T")[0];
};

export default function OcrPage() {
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<OcrResult | null>(null);
  const [editedResult, setEditedResult] = useState<OcrResult | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isClient = editedResult?.type_document === "facture_client";

  const Field = ({ label, value, onChange, type = "text", className = "" }: any) => (
    <div className={`flex flex-col gap-1 ${className}`}>
      <label className="text-[10px] font-extrabold text-slate-500 uppercase ml-1 tracking-wider">{label}</label>
      <input
        type={type}
        className="w-full p-2.5 border border-slate-200 rounded-lg text-slate-700 focus:ring-2 focus:ring-blue-500 outline-none bg-white transition-all shadow-sm"
        value={value ?? ""}
        onChange={onChange}
      />
    </div>
  );

  const handleFile = (f: File) => {
    setFile(f); setResult(null); setEditedResult(null); setSaved(false); setError("");
  };

  const handleExtract = async () => {
  if (!file) return;
  setIsLoading(true);
  setError("");

  try {
    const formData = new FormData();
    formData.append("file", file);

    const token = localStorage.getItem("access_token");
    const baseUrl = ("https://fantastic-zebra-qvqqg5xprrrw2xwv-8000.app.github.dev").replace(/\/$/, "");

    // ← FIX PRINCIPAL : lire le dossier actif et l'envoyer en header
    const activeDossierId = localStorage.getItem("active_dossier_id");
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (activeDossierId) {
      headers["X-Active-Dossier"] = activeDossierId;
    }

    const res = await fetch(`${baseUrl}/api/ocr/extract`, {
      method: "POST",
      headers,
      body: formData,
    });


    const data = await res.json();
    setResult(data);
    setEditedResult({ ...data });
  } catch (err: any) {
    setError(err.message || "Erreur réseau");
  } finally {
    setIsLoading(false);
  }
};

  const handleSave = async () => {
  if (!editedResult) return;
  setIsSaving(true);
  setError("");

  try {
    // ← FIX : envoyer X-Active-Dossier aussi lors de l'enregistrement
    const activeDossierId = localStorage.getItem("active_dossier_id");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (activeDossierId) {
      headers["X-Active-Dossier"] = activeDossierId;
    }

    const token = localStorage.getItem("access_token");
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const baseUrl = ("https://fantastic-zebra-qvqqg5xprrrw2xwv-8000.app.github.dev").replace(/\/$/, "");
    const res = await fetch(`${baseUrl}/api/ocr/validate-and-record`, {
      method: "POST",
      headers,
      body: JSON.stringify(editedResult),
    });


    const saveRes = await res.json();
    setSaved(true);
  } catch (err: any) {
    setError(err.message || "Erreur enregistrement");
  } finally {
    setIsSaving(false);
  }
};


  const compteDebit = isClient ? "3421 (Client)" : editedResult?.compte_charge ?? "6111";
  const compteCredit = isClient ? "7111 (Ventes)" : "4411 (Fournisseur)";

  return (
    <div className="max-w-6xl mx-auto space-y-6 p-6">

      {/* Header */}
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-slate-800 flex items-center">
          <FileText className="w-8 h-8 mr-3 text-blue-600" />
          Audit Facture — Intelligence Artificielle
        </h1>
        {editedResult && (
          <div className={`px-4 py-1.5 rounded-full text-xs font-bold border flex items-center gap-1.5 ${
            isClient ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-orange-50 border-orange-200 text-orange-700'
          }`}>
            {isClient ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
            {isClient ? "Facture Client (Vente)" : "Facture Fournisseur (Achat)"}
          </div>
        )}
      </div>

      {/* Raisonnement IA */}
      {editedResult?.raisonnement && (
        <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-600 flex items-start gap-2">
          <Info className="w-4 h-4 mt-0.5 text-slate-400 shrink-0" />
          <span><strong>Raisonnement IA :</strong> {editedResult.raisonnement}</span>
        </div>
      )}

      {/* Zone Upload */}
      <div
        className={`border-2 border-dashed rounded-2xl p-10 text-center cursor-pointer transition-all ${
          isDragging ? "border-blue-500 bg-blue-50" : "border-slate-300 bg-white hover:border-blue-400"
        }`}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => { e.preventDefault(); setIsDragging(false); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); }}
        onClick={() => fileInputRef.current?.click()}
      >
        <Upload className="w-12 h-12 text-slate-400 mx-auto mb-4" />
        <p className="text-slate-600 font-medium">
          {file ? <span className="text-blue-600 font-bold">{file.name}</span> : "Glissez votre document ici ou cliquez pour parcourir"}
        </p>
        <input ref={fileInputRef} type="file" className="hidden" onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} />
      </div>

      {file && !result && (
        <button onClick={handleExtract} disabled={isLoading} className="w-full py-4 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl shadow-lg transition-all disabled:opacity-50">
          {isLoading
            ? <div className="flex items-center justify-center gap-2"><Loader2 className="animate-spin" /> Analyse IA en cours...</div>
            : "Extraire les données avec l'IA"}
        </button>
      )}

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-red-700 flex items-center shadow-sm">
          <AlertCircle className="w-5 h-5 mr-3" /> {error}
        </div>
      )}

      {editedResult && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">

            {/* Émetteur */}
            <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-4">
              <h2 className="text-lg font-bold text-slate-800 border-b pb-3 flex items-center gap-2">
                <Info className="w-5 h-5 text-blue-500" /> Émetteur (vendeur)
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label="Raison Sociale" value={editedResult.emetteur?.nom ?? editedResult.fournisseur}
                  onChange={(e:any) => setEditedResult({...editedResult, emetteur: {...editedResult.emetteur, nom: e.target.value}})} />
                <Field label="ICE" value={editedResult.emetteur?.ice ?? editedResult.ice}
                  onChange={(e:any) => setEditedResult({...editedResult, emetteur: {...editedResult.emetteur, ice: e.target.value}})} />
                <Field label="IF (Identifiant Fiscal)" value={editedResult.emetteur?.if_fiscal ?? ""}
                  onChange={(e:any) => setEditedResult({...editedResult, emetteur: {...editedResult.emetteur, if_fiscal: e.target.value}})} />
                <Field label="RC" value={editedResult.emetteur?.rc ?? ""}
                  onChange={(e:any) => setEditedResult({...editedResult, emetteur: {...editedResult.emetteur, rc: e.target.value}})} />
                <Field label="Adresse" value={editedResult.emetteur?.adresse ?? ""} className="md:col-span-2"
                  onChange={(e:any) => setEditedResult({...editedResult, emetteur: {...editedResult.emetteur, adresse: e.target.value}})} />
              </div>
            </div>

            {/* Destinataire */}
            <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-4">
              <h2 className="text-lg font-bold text-slate-800 border-b pb-3 flex items-center gap-2">
                <Info className="w-5 h-5 text-green-500" /> Destinataire (acheteur)
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label="Raison Sociale" value={editedResult.destinataire?.nom ?? ""}
                  onChange={(e:any) => setEditedResult({...editedResult, destinataire: {...editedResult.destinataire, nom: e.target.value}})} />
                <Field label="ICE" value={editedResult.destinataire?.ice ?? ""}
                  onChange={(e:any) => setEditedResult({...editedResult, destinataire: {...editedResult.destinataire, ice: e.target.value}})} />
                <Field label="Adresse" value={editedResult.destinataire?.adresse ?? ""} className="md:col-span-2"
                  onChange={(e:any) => setEditedResult({...editedResult, destinataire: {...editedResult.destinataire, adresse: e.target.value}})} />
              </div>
              {/* Warnings ICE client */}
              {editedResult.warnings && editedResult.warnings.filter(w => w.includes("ICE client") || w.includes("IF client")).map((w, i) => (
                <div key={i} className="p-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" /> {w}
                </div>
              ))}
            </div>

            {/* Détails facture */}
            <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-4">
              <h2 className="text-lg font-bold text-slate-800 border-b pb-3">Détails de la facture</h2>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <Field label="Date Facture" type="date" value={editedResult.date}
                  onChange={(e:any) => setEditedResult({...editedResult, date: e.target.value})} />
                <Field label="Date Échéance" type="date" value={editedResult.date_echeance}
                  onChange={(e:any) => setEditedResult({...editedResult, date_echeance: e.target.value})} />
                <Field label="N° Facture" value={editedResult.numero}
                  onChange={(e:any) => setEditedResult({...editedResult, numero: e.target.value})} />
                <Field label="Taux TVA (%)" type="number" value={editedResult.taux_tva}
                  onChange={(e:any) => setEditedResult({...editedResult, taux_tva: parseFloat(e.target.value) || 0})} />

                {/* Méthode de paiement */}
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-extrabold text-slate-500 uppercase ml-1 tracking-wider flex items-center gap-1">
                    <CreditCard className="w-3 h-3" /> Méthode de paiement
                  </label>
                  <select
                    className="w-full p-2.5 border border-slate-200 rounded-lg text-slate-700 focus:ring-2 focus:ring-blue-500 outline-none bg-white shadow-sm"
                    value={editedResult.methode_paiement ?? ""}
                    onChange={(e) => setEditedResult({...editedResult, methode_paiement: e.target.value})}
                  >
                    {PAYMENT_METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                </div>

                {/* Statut payé */}
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-extrabold text-slate-500 uppercase ml-1 tracking-wider">Statut paiement</label>
                  <div className="flex items-center gap-3 p-2.5 border border-slate-200 rounded-lg bg-white shadow-sm">
                    <input type="checkbox" id="est_paye" checked={editedResult.est_paye ?? false}
                      onChange={(e) => setEditedResult({...editedResult, est_paye: e.target.checked})}
                      className="w-4 h-4 accent-emerald-600" />
                    <label htmlFor="est_paye" className="text-sm text-slate-700 cursor-pointer">
                      {editedResult.est_paye ? "✅ Payée" : "⏳ En attente"}
                    </label>
                  </div>
                </div>
              </div>
            </div>

            {/* Montants */}
            <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
              <h2 className="text-lg font-bold text-slate-800 border-b pb-3 mb-5">Montants financiers (MAD)</h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <Field label="Total HT" type="number" value={editedResult.montant_ht}
                  onChange={(e:any) => setEditedResult({...editedResult, montant_ht: parseFloat(e.target.value) || 0})} />
                <Field label="Total TVA" type="number" value={editedResult.tva}
                  onChange={(e:any) => setEditedResult({...editedResult, tva: parseFloat(e.target.value) || 0})} />
                <Field label="Total TTC" type="number" value={editedResult.montant_ttc}
                  onChange={(e:any) => setEditedResult({...editedResult, montant_ttc: parseFloat(e.target.value) || 0})} />
              </div>
            </div>
          </div>

          {/* Colonne droite */}
          <div className="space-y-6">

            {/* Widget Conformité */}
            <div className={`p-6 rounded-2xl border shadow-sm ${
              editedResult.compliance_level === 'HIGH' ? 'bg-emerald-50 border-emerald-200' :
              editedResult.compliance_level === 'MEDIUM' ? 'bg-amber-50 border-amber-200' :
              'bg-rose-50 border-rose-200'
            }`}>
              <div className="flex items-center gap-2 mb-4">
                {editedResult.compliance_level === 'HIGH'
                  ? <CheckCircle className="text-emerald-600 w-6 h-6" />
                  : <AlertCircle className={`w-6 h-6 ${editedResult.compliance_level === 'MEDIUM' ? 'text-amber-600' : 'text-rose-600'}`} />
                }
                <h2 className={`font-bold text-lg ${
                  editedResult.compliance_level === 'HIGH' ? 'text-emerald-800' :
                  editedResult.compliance_level === 'MEDIUM' ? 'text-amber-800' : 'text-rose-800'
                }`}>
                  {editedResult.compliance_level === 'HIGH' ? '✅ Conforme' :
                   editedResult.compliance_level === 'MEDIUM' ? '⚠️ Conformité Moyenne' : '❌ Non Conforme — Bloqué'}
                </h2>
              </div>

              {editedResult.missing_critical && editedResult.missing_critical.length > 0 && (
                <div className="mb-3">
                  <p className="text-xs font-bold text-rose-700 mb-2">🔴 Critiques :</p>
                  {editedResult.missing_critical.map((m, i) => (
                    <p key={i} className="text-xs text-rose-700 mb-1">• {m}</p>
                  ))}
                </div>
              )}

              {editedResult.missing_important && editedResult.missing_important.length > 0 && (
                <div className="mb-3">
                  <p className="text-xs font-bold text-amber-700 mb-2">🟡 Importants :</p>
                  {editedResult.missing_important.map((m, i) => (
                    <p key={i} className="text-xs text-amber-700 mb-1">• {m}</p>
                  ))}
                </div>
              )}

              {editedResult.warnings && editedResult.warnings.filter(w => !w.includes("ICE client") && !w.includes("IF client")).length > 0 && (
                <div>
                  <p className="text-xs font-bold text-slate-600 mb-2">⚠️ Avertissements :</p>
                  {editedResult.warnings.filter(w => !w.includes("ICE client") && !w.includes("IF client")).map((w, i) => (
                    <p key={i} className="text-xs text-slate-600 mb-1">• {w}</p>
                  ))}
                </div>
              )}

              {/* Score */}
              <div className="mt-4 pt-3 border-t border-current border-opacity-20">
                <div className="flex justify-between text-xs font-bold mb-1">
                  <span>Score conformité</span>
                  <span>{(editedResult as any).score_conformite ?? 0}%</span>
                </div>
                <div className="w-full bg-white bg-opacity-50 rounded-full h-2">
                  <div
                    className={`h-2 rounded-full transition-all ${
                      editedResult.compliance_level === 'HIGH' ? 'bg-emerald-500' :
                      editedResult.compliance_level === 'MEDIUM' ? 'bg-amber-500' : 'bg-rose-500'
                    }`}
                    style={{ width: `${(editedResult as any).score_conformite ?? 0}%` }}
                  />
                </div>
              </div>
            </div>

            {/* Écriture comptable */}
            <div className="bg-slate-900 p-6 rounded-2xl text-white shadow-xl relative overflow-hidden">
              <div className="absolute top-0 right-0 p-4 opacity-10">
                <FileText className="w-20 h-20 text-white" />
              </div>
              <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-2 border-b border-slate-700 pb-2">
                Journal Comptable
              </h2>
              <p className="text-xs text-slate-500 mb-4 italic">
                {isClient ? "Vente → Produit" : "Achat → Charge"}
              </p>
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-slate-400 text-sm font-mono">{compteDebit}</span>
                  <span className="font-bold text-slate-200">{editedResult.montant_ht.toLocaleString("fr-MA")} <small>HT</small></span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-slate-400 text-sm font-mono">3455 (TVA)</span>
                  <span className="font-bold text-slate-300">{editedResult.tva.toLocaleString("fr-MA")} <small>TVA</small></span>
                </div>
                <div className={`flex justify-between items-center ${isClient ? 'text-blue-400' : 'text-emerald-400'}`}>
                  <span className="text-slate-400 text-sm">{compteCredit}</span>
                  <span className="font-bold text-xl">{editedResult.montant_ttc.toLocaleString("fr-MA")} <small>TTC</small></span>
                </div>
              </div>

              {/* Info GED */}
              <div className="mt-4 p-2 bg-slate-800 rounded-lg text-xs text-slate-400 flex items-center gap-2">
                <Info className="w-3.5 h-3.5 shrink-0" />
                Document archivé automatiquement dans la GED
              </div>

              <button
                onClick={handleSave}
                disabled={isSaving || editedResult?.is_blocking}
                title={editedResult?.is_blocking ? "Corrigez les champs critiques avant de valider" : ""}
                className={`w-full mt-4 py-3.5 text-white rounded-xl font-bold shadow-lg transition-all disabled:cursor-not-allowed ${
                  editedResult?.is_blocking
                    ? 'bg-rose-500 opacity-60'
                    : 'bg-emerald-600 hover:bg-emerald-500'
                }`}
              >
                {isSaving ? "Traitement..." : editedResult?.is_blocking ? "🔒 Bloqué — Conformité insuffisante" : "Valider l'écriture"}
              </button>
              {saved && (
                <p className="text-emerald-400 mt-3 text-center text-sm font-medium">
                  ✓ Écriture enregistrée + archivée dans la GED !
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}