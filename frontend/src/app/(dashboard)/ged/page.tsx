"use client";

import { useState, useEffect, useRef } from "react";
// Ajout de l'icône Eye pour la consultation
import { FolderOpen, Upload, Search, Shield, CheckCircle, AlertCircle, Loader2, FileText, File, X, Eye } from "lucide-react";
import { apiFetch, API_BASE_URL } from "../../../lib/api";

const DOC_TYPES = [
  { value: "", label: "Tous les types" },
  { value: "facture_client", label: "Facture client" },
  { value: "facture_fournisseur", label: "Facture fournisseur" },
  { value: "devis", label: "Devis" },
  { value: "contrat", label: "Contrat" },
  { value: "releve_bancaire", label: "Relevé bancaire" },
  { value: "declaration_tva", label: "Déclaration TVA" },
  { value: "bilan", label: "Bilan" },
  { value: "autre", label: "Autre" },
];

const URGENCY_COLORS: Record<string, string> = {
  facture_client: "bg-blue-100 text-blue-700",
  facture_fournisseur: "bg-purple-100 text-purple-700",
  devis: "bg-amber-100 text-amber-700",
  contrat: "bg-green-100 text-green-700",
  releve_bancaire: "bg-slate-100 text-slate-700",
  declaration_tva: "bg-red-100 text-red-700",
  bilan: "bg-indigo-100 text-indigo-700",
  autre: "bg-slate-100 text-slate-600",
};

export default function GedPage() {
  const [documents, setDocuments] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [docTypeFilter, setDocTypeFilter] = useState("");
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadSuccess, setUploadSuccess] = useState("");
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Formulaire upload
  const [uploadForm, setUploadForm] = useState({
    doc_type: "autre",
    fournisseur_client: "",
    montant: "",
    doc_date: new Date().toISOString().split("T")[0],
    tags: "",
  });

  useEffect(() => {
    fetchDocuments();
  }, []);

  const fetchDocuments = async () => {
    try {
      setIsLoading(true);
      const params = new URLSearchParams();
      if (search) params.append("search", search);
      if (docTypeFilter) params.append("doc_type", docTypeFilter);
      const data = await apiFetch(`/ged/documents?${params.toString()}`);
      setDocuments(data || []);
    } catch (err: any) {
      setError("Erreur chargement: " + err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpload = async (file: File) => {
    setIsUploading(true);
    setError("");
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("doc_type", uploadForm.doc_type);
      formData.append("fournisseur_client", uploadForm.fournisseur_client);
      formData.append("montant", uploadForm.montant);
      formData.append("doc_date", uploadForm.doc_date);
      formData.append("tags", uploadForm.tags);

      const token = localStorage.getItem("access_token");

      const res = await fetch(`${API_BASE_URL}/ged/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      if (!res.ok) throw new Error(`Erreur ${res.status}`);
      const data = await res.json();
      setUploadSuccess(`✓ Document archivé — SHA-256: ${data.sha256?.substring(0, 16)}...`);
      setIsUploadOpen(false);
      fetchDocuments();
    } catch (err: any) {
      setError(err.message || "Erreur upload");
    } finally {
      setIsUploading(false);
    }
  };

  // Fonction pour consulter le document (Lecture seule)
  const handleViewDocument = (docId: number) => {
    const token = localStorage.getItem("access_token");
    // On ouvre dans un nouvel onglet en passant le token si nécessaire ou via une URL sécurisée
    window.open(`${API_BASE_URL}/ged/download/${docId}?token=${token}`, "_blank");
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center">
            <FolderOpen className="w-6 h-6 mr-2 text-blue-600" />
            GED — Gestion Électronique de Documents
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Archivage sécurisé avec certification SHA-256 et consultation en lecture seule
          </p>
        </div>
        <button onClick={() => setIsUploadOpen(true)}
          className="flex items-center px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors">
          <Upload className="w-4 h-4 mr-2" /> Archiver un document
        </button>
      </div>

      {uploadSuccess && (
        <div className="p-4 bg-green-50 border border-green-200 rounded-xl flex items-center text-green-700">
          <CheckCircle className="w-5 h-5 mr-3 shrink-0" /> {uploadSuccess}
        </div>
      )}
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-xl flex items-center text-red-700">
          <AlertCircle className="w-5 h-5 mr-3 shrink-0" /> {error}
        </div>
      )}

      {/* Filtres */}
      <div className="flex space-x-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input type="text" placeholder="Rechercher par nom, fournisseur, tag..."
            className="w-full pl-9 pr-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && fetchDocuments()} />
        </div>
        <select className="px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          value={docTypeFilter}
          onChange={(e) => { setDocTypeFilter(e.target.value); setTimeout(fetchDocuments, 100); }}>
          {DOC_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <button onClick={fetchDocuments}
          className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-sm font-medium transition-colors">
          Rechercher
        </button>
      </div>

      {/* Liste documents */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 text-xs uppercase">
              <th className="py-3 px-4 text-left">Document</th>
              <th className="py-3 px-4 text-left">Type</th>
              <th className="py-3 px-4 text-left">Fournisseur/Client</th>
              <th className="py-3 px-4 text-left">Date</th>
              <th className="py-3 px-4 text-center">Intégrité</th>
              <th className="py-3 px-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {isLoading ? (
              <tr><td colSpan={6} className="py-12 text-center text-slate-500">
                <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2 text-blue-600" />
                Chargement...
              </td></tr>
            ) : documents.length === 0 ? (
              <tr><td colSpan={6} className="py-12 text-center text-slate-500">
                Aucun document archivé.
              </td></tr>
            ) : documents.map((doc) => (
              <tr key={doc.id} className="hover:bg-slate-50 transition-colors">
                <td className="py-3 px-4">
                  <div className="flex items-center">
                    <FileText className="w-4 h-4 mr-2 text-slate-400 shrink-0" />
                    <div>
                      <p className="text-sm font-medium text-slate-800">{doc.name}</p>
                      {doc.sha256 && (
                        <p className="text-[10px] text-slate-400 font-mono leading-none">{doc.sha256.substring(0, 24)}...</p>
                      )}
                    </div>
                  </div>
                </td>
                <td className="py-3 px-4">
                  <span className={`text-xs font-medium px-2 py-1 rounded-full ${URGENCY_COLORS[doc.doc_type] || URGENCY_COLORS.autre}`}>
                    {doc.doc_type_label || doc.doc_type}
                  </span>
                </td>
                <td className="py-3 px-4 text-sm text-slate-600">{doc.fournisseur_client || "—"}</td>
                <td className="py-3 px-4 text-sm text-slate-500">{doc.doc_date || "—"}</td>
                <td className="py-3 px-4 text-center">
                  {doc.verified || doc.sha256 ? (
                    <div className="flex flex-col items-center">
                      <Shield className="w-4 h-4 text-green-500" />
                      <span className="text-[9px] text-green-600 font-bold uppercase">Scellé</span>
                    </div>
                  ) : (
                    <AlertCircle className="w-4 h-4 text-amber-400 mx-auto" />
                  )}
                </td>
                <td className="py-3 px-4 text-right">
                  <button 
                    onClick={() => handleViewDocument(doc.id)}
                    className="inline-flex items-center px-3 py-1.5 bg-slate-100 hover:bg-blue-600 hover:text-white text-slate-700 rounded-md text-xs font-bold transition-all"
                  >
                    <Eye className="w-3.5 h-3.5 mr-1" /> Consulter
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Modal upload (identique à l'original) */}
      {isUploadOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
              <h2 className="text-lg font-bold text-slate-800">Archiver un document</h2>
              <button onClick={() => setIsUploadOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div
                className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${isDragging ? "border-blue-500 bg-blue-50" : "border-slate-300 hover:border-blue-400"}`}
                onDrop={(e) => { e.preventDefault(); setIsDragging(false); e.dataTransfer.files[0] && handleUpload(e.dataTransfer.files[0]); }}
                onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="w-8 h-8 text-slate-400 mx-auto mb-2" />
                <p className="text-sm text-slate-600 font-medium">Glissez ou cliquez pour sélectionner</p>
                <input ref={fileInputRef} type="file" className="hidden"
                  onChange={(e) => e.target.files?.[0] && handleUpload(e.target.files[0])} />
              </div>
              
              {/* Formulaire simplifié pour l'exemple */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Type</label>
                  <select className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
                    value={uploadForm.doc_type}
                    onChange={(e) => setUploadForm({ ...uploadForm, doc_type: e.target.value })}>
                    {DOC_TYPES.slice(1).map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Date</label>
                  <input type="date" className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                    value={uploadForm.doc_date}
                    onChange={(e) => setUploadForm({ ...uploadForm, doc_date: e.target.value })} />
                </div>
              </div>
              <button 
                 disabled={isUploading}
                 className="w-full py-3 bg-blue-600 text-white rounded-lg font-bold hover:bg-blue-700 transition-colors flex items-center justify-center"
              >
                {isUploading ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : <Shield className="w-5 h-5 mr-2" />}
                Certifier et Archiver
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
