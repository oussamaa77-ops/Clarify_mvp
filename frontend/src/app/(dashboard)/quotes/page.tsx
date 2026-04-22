"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Plus, Download, MoreVertical, FileText, CheckCircle, Clock, AlertCircle, XCircle } from "lucide-react";
import { apiFetch } from "../../../lib/api";

const getStatusBadge = (status: string) => {
  switch (status) {
    case "ACCEPTED":
      return <span className="px-2.5 py-1 bg-green-100 text-green-700 rounded-full text-xs font-medium flex items-center"><CheckCircle className="w-3 h-3 mr-1"/> Accepté</span>;
    case "SENT":
      return <span className="px-2.5 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-medium flex items-center"><Clock className="w-3 h-3 mr-1"/> Envoyé</span>;
    case "REJECTED":
      return <span className="px-2.5 py-1 bg-red-100 text-red-700 rounded-full text-xs font-medium flex items-center"><XCircle className="w-3 h-3 mr-1"/> Refusé</span>;
    default:
      return <span className="px-2.5 py-1 bg-slate-100 text-slate-700 rounded-full text-xs font-medium">Brouillon</span>;
  }
};

export default function QuotesPage() {
  const [quotes, setQuotes] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    fetchQuotes();
  }, []);

  const fetchQuotes = async () => {
    try {
      setIsLoading(true);
      const data = await apiFetch("/quotes");
      setQuotes(data || []);
      setError("");
    } catch (err: any) {
      setError("Erreur lors du chargement des devis. " + err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDownloadPdf = (quoteId: number, quoteNumber: string) => {
    // We fetch the Blob and download it to handle Auth headers correctly
    apiFetch(`/quotes/${quoteId}/pdf`)
      .then(blob => {
        if (!blob) return;
        const blobUrl = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = `${quoteNumber}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(blobUrl);
      })
      .catch(err => alert("Erreur lors du téléchargement: " + err.message));
  };

  if (!mounted) return null;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Devis</h1>
          <p className="text-sm text-slate-500 mt-1">Gérez vos propositions commerciales adressées aux clients.</p>
        </div>
        <Link href="/quotes/create" className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center">
          <Plus className="w-4 h-4 mr-2" />
          Nouveau Devis
        </Link>
      </div>

      {error && (
        <div className="p-4 bg-red-50 text-red-600 rounded-lg flex items-center shadow-sm border border-red-100">
          <AlertCircle className="w-5 h-5 mr-3" />
          {error}
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="p-4 border-b border-slate-200 flex justify-between items-center bg-slate-50/50">
          <div className="flex space-x-2">
            <input type="text" placeholder="Rechercher un devis..." className="px-3 py-1.5 border border-slate-300 rounded-md text-sm w-64 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-slate-400 text-slate-500" />
            <select className="px-3 py-1.5 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white placeholder-slate-400 text-slate-500">
              <option>Tous les statuts</option>
              <option>Accepté</option>
              <option>Envoyé</option>
              <option>Refusé</option>
            </select>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 text-sm font-medium">
                <th className="py-3 px-6 text-left">N° Devis</th>
                <th className="py-3 px-6 text-left">Client (Prospect)</th>
                <th className="py-3 px-6 text-left">Date Emission</th>
                <th className="py-3 px-6 text-right">Montant TTC</th>
                <th className="py-3 px-6 text-center">Statut</th>
                <th className="py-3 px-6 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {quotes.map((quote) => (
                <tr key={quote.id} className="hover:bg-slate-50 transition-colors">
                  <td className="py-3 px-6 text-sm font-medium text-slate-900">
                    <div className="flex items-center">
                      <FileText className="w-4 h-4 mr-2 text-slate-400" />
                      {quote.number}
                    </div>
                  </td>
                  <td className="py-3 px-6 text-sm text-slate-600 font-medium">{quote.client?.name || 'Client Inconnu'}</td>
                  <td className="py-3 px-6 text-sm text-slate-500">{quote.date}</td>
                  <td className="py-3 px-6 text-sm font-medium text-right text-slate-900">
                      {(quote.total_incl_tax || 0).toLocaleString("fr-MA", { minimumFractionDigits: 2 })} MAD
                  </td>
                  <td className="py-3 px-6 text-center flex justify-center">{getStatusBadge(quote.status)}</td>
                  <td className="py-3 px-6 text-right">
                    <div className="flex justify-end space-x-2">
                      <button 
                        onClick={() => handleDownloadPdf(quote.id, quote.number)}
                        className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors" 
                        title="Télécharger PDF"
                      >
                        <Download className="w-4 h-4" />
                      </button>
                      
                      <button className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded transition-colors" title="Plus d'actions">
                        <MoreVertical className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {isLoading ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-slate-500">
                    <div className="flex justify-center items-center">
                      <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin mr-3"></div>
                      Chargement des devis...
                    </div>
                  </td>
                </tr>
              ) : quotes.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-slate-500">
                    Aucun devis trouvé. Créez votre première offre commerciale.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
