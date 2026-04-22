"use client";

import { useState, useEffect, useRef } from "react";
import { FolderOpen, Upload, FileText, Trash2, Download, Search, HardDrive } from "lucide-react";
import { apiFetch } from "../../../lib/api";

export default function DocumentsPage() {
  const [documents, setDocuments] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [search, setSearch] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchDocuments();
  }, []);

  const fetchDocuments = async () => {
    setIsLoading(true);
    try {
      const data = await apiFetch("/documents/");
      setDocuments(data || []);
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoading(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) { // 5MB limit
      alert("Le fichier est trop volumineux (Maximum 5MB)");
      return;
    }

    setIsUploading(true);
    const reader = new FileReader();
    reader.onload = async (event) => {
      const base64String = event.target?.result as string;
      const fileType = file.name.split('.').pop()?.toLowerCase();
      
      try {
        await apiFetch("/documents/", {
          method: "POST",
          body: {
            name: file.name,
            file_type: fileType || "unknown",
            file_url: base64String // Store content safely as b64 directly 
          }
        });
        await fetchDocuments();
      } catch (err: any) {
        alert("Erreur lors de l'upload : " + err.message);
      } finally {
        setIsUploading(false);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Supprimer ce document de façon permanente ?")) return;
    try {
      await apiFetch(`/documents/${id}`, { method: "DELETE" });
      setDocuments(documents.filter(d => d.id !== id));
    } catch (e) {
      alert("Erreur de suppression");
    }
  };

  const handleDownload = (doc: any) => {
    // If we persisted dataURL inside file_url
    if (doc.file_url && doc.file_url.startsWith("data:")) {
      const a = document.createElement("a");
      a.href = doc.file_url;
      a.download = doc.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } else {
      alert("Fichier corrompu ou illisible.");
    }
  };

  const filteredDocs = documents.filter(d => d.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div className="flex items-center space-x-3">
          <div className="bg-orange-100 p-2.5 rounded-xl border border-orange-200">
            <FolderOpen className="w-6 h-6 text-orange-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-800">Coffre-fort Électronique (GED)</h1>
            <p className="text-sm text-slate-500">Stockez et organisez vos pièces comptables et justificatifs.</p>
          </div>
        </div>
        
        <input 
          type="file" 
          ref={fileInputRef} 
          className="hidden" 
          onChange={handleFileUpload}
        />
        <button 
          onClick={() => fileInputRef.current?.click()}
          disabled={isUploading}
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors flex items-center disabled:bg-blue-400 shadow-sm"
        >
          {isUploading ? (
            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2"></div>
          ) : (
            <Upload className="w-4 h-4 mr-2" />
          )}
          Importer un document
        </button>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden min-h-[500px]">
        <div className="p-4 border-b border-slate-200 bg-slate-50 flex justify-between items-center">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input 
              type="text" 
              placeholder="Rechercher un fichier..." 
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 pr-4 py-2 border border-slate-300 rounded-lg text-sm w-64 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-slate-400 text-slate-700" 
            />
          </div>
          <div className="text-sm text-slate-500 flex items-center">
            <HardDrive className="w-4 h-4 mr-2" />
            Espace virtuel sécurisé
          </div>
        </div>

        {isLoading ? (
          <div className="flex justify-center items-center h-64">
             <div className="w-8 h-8 border-4 border-slate-200 border-t-orange-500 rounded-full animate-spin"></div>
          </div>
        ) : filteredDocs.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-20 text-slate-500 border-dashed border-2 border-slate-200 rounded-xl m-8 bg-slate-50">
            <FileText className="w-12 h-12 text-slate-300 mb-3" />
            <p className="font-medium text-slate-700">Aucun document trouvé</p>
            <p className="text-sm">Cliquez sur "Importer" pour ajouter des factures fournisseurs ou justificatifs.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 bg-white lg:grid-cols-4 gap-6 p-6">
            {filteredDocs.map((doc) => (
              <div key={doc.id} className="group border border-slate-200 rounded-xl p-4 hover:border-blue-300 hover:shadow-md transition-all bg-white relative">
                
                <div className="flex justify-between items-start mb-3">
                  <div className="p-3 bg-blue-50 text-blue-600 rounded-lg">
                    <FileText className="w-8 h-8" />
                  </div>
                  <button 
                    onClick={() => handleDelete(doc.id)}
                    className="p-1.5 text-slate-300 hover:text-red-600 hover:bg-red-50 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Supprimer"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
                
                <h3 className="text-sm font-semibold text-slate-800 truncate" title={doc.name}>
                  {doc.name}
                </h3>
                
                <div className="flex justify-between items-center mt-4">
                  <span className="text-xs text-slate-400 font-medium">
                    {new Date(doc.created_at).toLocaleDateString()}
                  </span>
                  <button 
                    onClick={() => handleDownload(doc)}
                    className="text-xs font-semibold text-blue-600 border border-blue-100 rounded-md px-2 py-1 bg-blue-50 hover:bg-blue-100 transition-colors"
                  >
                    Ouvrir
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
