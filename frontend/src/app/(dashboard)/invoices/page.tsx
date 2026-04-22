"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
// Ajout de CreditCard ici
import { Plus, Download, MoreVertical, FileText, CheckCircle, Clock, AlertCircle, XCircle, CreditCard } from "lucide-react";
import { apiFetch } from "../../../lib/api";

const getStatusBadge = (status: string) => {
  switch (status) {
    case "PAID":
      return <span className="px-2.5 py-1 bg-green-100 text-green-700 rounded-full text-xs font-medium flex items-center"><CheckCircle className="w-3 h-3 mr-1"/> Payée</span>;
    case "SENT":
      return <span className="px-2.5 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-medium flex items-center"><Clock className="w-3 h-3 mr-1"/> Envoyée</span>;
    case "OVERDUE":
      return <span className="px-2.5 py-1 bg-red-100 text-red-700 rounded-full text-xs font-medium">En retard</span>;
    case "CANCELLED":
      return <span className="px-2.5 py-1 bg-slate-100 text-slate-500 rounded-full text-xs font-medium">Annulée</span>;
    default:
      return <span className="px-2.5 py-1 bg-slate-100 text-slate-700 rounded-full text-xs font-medium">Brouillon</span>;
  }
};

export default function InvoicesPage() {
  const [invoices, setInvoices] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [mounted, setMounted] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  useEffect(() => {
    setMounted(true);
    fetchInvoices();
  }, []);

  const fetchInvoices = async (search?: string, status?: string) => {
    try {
      setIsLoading(true);
      const params = new URLSearchParams();
      if (search) params.append("search", search);
      if (status) params.append("status", status);
      const url = params.toString() ? `/invoices?${params.toString()}` : "/invoices";
      const data = await apiFetch(url);
      setInvoices(data || []);
      setError("");
    } catch (err: any) {
      setError("Erreur lors du chargement des factures. " + err.message);
    } finally {
      setIsLoading(false);
    }
  };

  // --- NOUVELLE FONCTION DE PAIEMENT ---
  const handlePayInvoice = async (invoiceId: number) => {
    if (!confirm("Confirmer l'encaissement de cette facture ? Une écriture comptable sera générée.")) return;
    try {
      setIsLoading(true);
      await apiFetch(`/invoices/${invoiceId}/pay`, { method: "POST" });
      await fetchInvoices(); // Rafraîchir la liste
    } catch (err: any) {
      setError("Erreur lors du paiement: " + err.message);
      setIsLoading(false);
    }
  };

  const handleDownloadPdf = (invoiceId: number, invoiceNumber: string) => {
    apiFetch(`/invoices/${invoiceId}/pdf`)
      .then(blob => {
        if (!blob) return;
        const blobUrl = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = `${invoiceNumber}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(blobUrl);
      })
      .catch(err => alert("Erreur lors du téléchargement: " + err.message));
  };

  const handleCancelInvoice = async (invoiceId: number) => {
    if (!confirm("Voulez-vous vraiment annuler cette facture ? Cela va générer une facture d'avoir officielle et révoquer les écritures comptables associées.")) return;
    try {
      setIsLoading(true);
      await apiFetch(`/invoices/${invoiceId}/credit-note`, { method: "POST" });
      await fetchInvoices();
    } catch (err: any) {
      setError("Erreur lors de l'annulation: " + err.message);
      setIsLoading(false);
    }
  };

  if (!mounted) return null;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Factures</h1>
          <p className="text-sm text-slate-500 mt-1">Gérez vos factures et suivez les paiements.</p>
        </div>
        <Link href="/invoices/create" className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center">
          <Plus className="w-4 h-4 mr-2" />
          Nouvelle Facture
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
            <input type="text" placeholder="N° facture ou nom client..." className="px-3 py-1.5 border border-slate-300 rounded-md text-sm w-64 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-slate-400 text-slate-500" value={searchQuery} onChange={e => { setSearchQuery(e.target.value); fetchInvoices(e.target.value, statusFilter); }} />
            <select className="px-3 py-1.5 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white text-slate-500" value={statusFilter} onChange={e => { setStatusFilter(e.target.value); fetchInvoices(searchQuery, e.target.value); }}>
              <option value="">Tous les statuts</option>
              <option value="SENT">Envoyée</option>
              <option value="PAID">Payée</option>
              <option value="CANCELLED">Annulée</option>
            </select>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 text-sm font-medium">
                <th className="py-3 px-6 text-left">N° Facture</th>
                <th className="py-3 px-6 text-left">Client</th>
                <th className="py-3 px-6 text-left">Date</th>
                <th className="py-3 px-6 text-right">Montant TTC</th>
                <th className="py-3 px-6 text-center">Statut</th>
                <th className="py-3 px-6 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {invoices.filter(invoice => invoice.type !== "CREDIT_NOTE").map((invoice) => (
                <tr key={invoice.id} className="hover:bg-slate-50 transition-colors">
                  <td className="py-3 px-6 text-sm font-medium text-slate-900">
                    <div className="flex items-center">
                      <FileText className="w-4 h-4 mr-2 text-slate-400" />
                      {invoice.number}
                    </div>
                  </td>
                  <td className="py-3 px-6 text-sm text-slate-600 font-medium">{invoice.client?.name || 'Client Inconnu'}</td>
                  <td className="py-3 px-6 text-sm text-slate-500">{invoice.issue_date || invoice.date}</td>
                  <td className="py-3 px-6 text-sm font-medium text-right">
                    <span className="text-slate-900">
                      {(invoice.total_incl_tax || invoice.total_amount || invoice.amount || 0).toLocaleString("fr-MA", { minimumFractionDigits: 2 })} MAD
                    </span>
                  </td>
                  <td className="py-3 px-6 text-center flex justify-center">{getStatusBadge(invoice.status)}</td>
                  <td className="py-3 px-6 text-right">
                    <div className="flex justify-end space-x-1">
                      {/* BOUTON PAYER (S'affiche si non payé et non annulé) */}
                      {invoice.status !== "PAID" && invoice.status !== "CANCELLED" && (
                        <button 
                          onClick={() => handlePayInvoice(invoice.id)}
                          className="p-1.5 text-green-600 hover:bg-green-50 rounded transition-colors flex items-center gap-1 border border-green-100"
                          title="Marquer comme payé"
                        >
                          <CreditCard className="w-4 h-4" />
                          <span className="text-[10px] font-bold">PAYER</span>
                        </button>
                      )}

                      {invoice.status !== "CANCELLED" && (
                        <button 
                          onClick={() => handleDownloadPdf(invoice.id, invoice.number)}
                          className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors" 
                          title="Télécharger PDF"
                        >
                          <Download className="w-4 h-4" />
                        </button>
                      )}
                      
                      {invoice.status !== "CANCELLED" && ["SENT", "PAID", "OVERDUE"].includes(invoice.status) && (
                        <button 
                          onClick={() => handleCancelInvoice(invoice.id)}
                          className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded transition-colors" 
                          title="Annuler (Avoir)"
                        >
                          <XCircle className="w-4 h-4" />
                        </button>
                      )}
                      
                      <button className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded transition-colors">
                        <MoreVertical className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {/* ... reste du chargement ... */}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
