"use client";

import { useState, useEffect } from "react";
import { Plus, X, Search, CheckCircle, Clock, AlertCircle, FileText, Calendar, DollarSign } from "lucide-react";
import { apiFetch } from "../../../lib/api";

type PaymentMethod = "BANK_TRANSFER" | "CASH" | "CHECK" | "CREDIT_CARD";

export default function PaymentsPage() {
  const [payments, setPayments] = useState<any[]>([]);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [mounted, setMounted] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  const [formData, setFormData] = useState({
    invoice_id: "",
    amount: "",
    date: new Date().toISOString().split('T')[0],
    method: "BANK_TRANSFER" as PaymentMethod
  });

  useEffect(() => {
    setMounted(true);
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      setIsLoading(true);
      const [paymentsData, invoicesData] = await Promise.all([
        apiFetch("/payments"),
        apiFetch("/invoices")
      ]);
      setPayments(paymentsData || []);
      // Filter unpaid invoices if needed, or just show all
      setInvoices(invoicesData || []);
      setError("");
    } catch (err: any) {
      setError("Erreur lors du chargement des données. " + err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreatePayment = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError("");

    try {
      const selectedInvoice = invoices.find(i => i.id.toString() === formData.invoice_id);
      if (!selectedInvoice) throw new Error("Veuillez sélectionner une facture.");

      await apiFetch("/payments", {
        method: "POST",
        body: {
          invoice_id: parseInt(formData.invoice_id),
          amount: parseFloat(formData.amount),
          date: formData.date,
          method: formData.method
        }
      });
      
      await fetchData(); // Refresh data
      setIsModalOpen(false);
      
      // Reset form
      setFormData({
        invoice_id: "",
        amount: "",
        date: new Date().toISOString().split('T')[0],
        method: "BANK_TRANSFER"
      });
    } catch (err: any) {
      setError(err.message || "Erreur lors de l'ajout du paiement");
    } finally {
      setIsSubmitting(false);
    }
  };

  const formatMethod = (method: string) => {
    switch (method) {
      case "BANK_TRANSFER": return "Virement Bancaire";
      case "CASH": return "Espèces";
      case "CHECK": return "Chèque";
      case "CREDIT_CARD": return "Carte Bancaire";
      default: return method;
    }
  };

  if (!mounted) return null;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Paiements</h1>
          <p className="text-sm text-slate-500 mt-1">Gérez les encaissements et paiements de vos factures.</p>
        </div>
        <button 
          onClick={() => setIsModalOpen(true)}
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center"
        >
          <Plus className="w-4 h-4 mr-2" />
          Nouveau Paiement
        </button>
      </div>

      {error && !isModalOpen && (
        <div className="p-4 bg-red-50 text-red-600 rounded-lg flex items-center shadow-sm border border-red-100">
          <AlertCircle className="w-5 h-5 mr-3" />
          {error}
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="p-4 border-b border-slate-200 flex justify-between items-center bg-slate-50/50">
          <div className="flex space-x-2">
            <input type="text" placeholder="Rechercher un paiement..." className="px-3 py-1.5 border border-slate-300 rounded-md text-sm w-64 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-slate-500 text-slate-900" />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 text-xs uppercase tracking-wider">
                <th className="p-4 font-medium">Facture ID</th>
                <th className="p-4 font-medium">Date</th>
                <th className="p-4 font-medium">Montant</th>
                <th className="p-4 font-medium">Méthode</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {!isLoading && payments.length === 0 && (
                <tr>
                  <td colSpan={4} className="p-8 text-center text-slate-500">
                    Aucun paiement trouvé.
                  </td>
                </tr>
              )}
              {!isLoading && payments.map((payment) => (
                <tr key={payment.id} className="hover:bg-slate-50/70 transition-colors">
                  <td className="p-4 text-sm font-medium text-slate-900 flex items-center">
                    <FileText className="w-4 h-4 mr-2 text-slate-400" />
                    #{payment.invoice_id}
                  </td>
                  <td className="p-4 text-sm tracking-tight text-slate-600">
                    {payment.date}
                  </td>
                  <td className="p-4 text-sm font-bold text-slate-700">
                    {payment.amount.toLocaleString("fr-MA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MAD
                  </td>
                  <td className="p-4 text-sm text-slate-600">
                    <span className="px-2.5 py-1 bg-slate-100 text-slate-700 rounded-full text-xs font-medium">
                      {formatMethod(payment.method)}
                    </span>
                  </td>
                </tr>
              ))}
              {isLoading && (
                <tr>
                  <td colSpan={4} className="py-8 text-center text-slate-500">
                    <div className="flex justify-center items-center">
                       <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600 mr-2"></div>
                       Chargement...
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal Nouveau Paiement */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">

        <style>{`
          input::placeholder, textarea::placeholder, select::placeholder {
            color: #1e293b !important; /* Dark but not pitch black */
            opacity: 1 !important;
            font-weight: normal !important;
          }
          input, select, textarea {
            color: #0f172a !important;
            font-weight: normal !important;
          }
        `}</style>

          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
            <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
              <h2 className="text-lg font-bold text-slate-800">Enregistrer un paiement</h2>
              <button 
                onClick={() => setIsModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 transition-colors bg-slate-100 hover:bg-slate-200 p-1 rounded-full"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="p-6 overflow-y-auto">
              {error && isModalOpen && (
                <div className="mb-4 p-3 bg-red-50 text-red-600 rounded-lg text-sm flex items-start border border-red-100">
                  <AlertCircle className="w-4 h-4 mr-2 mt-0.5 flex-shrink-0" />
                  <p>{error}</p>
                </div>
              )}

              <form id="paymentForm" onSubmit={handleCreatePayment} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    Facture concernée
                  </label>
                  <select 
                    required
                    value={formData.invoice_id}
                    onChange={(e) => {
                      const invId = e.target.value;
                      const inv = invoices.find(i => i.id.toString() === invId);
                      setFormData({ 
                        ...formData, 
                        invoice_id: invId,
                        amount: inv ? (inv.total_incl_tax || 0).toString() : ""
                      });
                    }}
                    className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition-colors text-slate-950 font-medium"
                  >
                    <option value="">Sélectionner une facture</option>
                    {invoices.map((invoice) => (
                      <option key={invoice.id} value={invoice.id}>
                        {invoice.number} - {invoice.total_incl_tax?.toLocaleString("fr-MA")} MAD ({(invoice.status === "PAID" ? "Payée" : "À payer")})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    Montant (MAD)
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <DollarSign className="h-4 w-4 text-slate-400" />
                    </div>
                    <input 
                      type="number"
                      step="0.01"
                      required
                      value={formData.amount}
                      onChange={(e) => setFormData({ ...formData, amount: e.target.value })}
                      placeholder="0.00"
                      className="w-full pl-10 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition-colors text-slate-950 font-medium"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    Date du paiement
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <Calendar className="h-4 w-4 text-slate-400" />
                    </div>
                    <input 
                      type="date"
                      required
                      value={formData.date}
                      onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                      className="w-full pl-10 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition-colors text-slate-950 font-medium"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    Méthode de paiement
                  </label>
                  <select 
                    required
                    value={formData.method}
                    onChange={(e) => setFormData({ ...formData, method: e.target.value as PaymentMethod })}
                    className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition-colors text-slate-950 font-medium"
                  >
                    <option value="BANK_TRANSFER">Virement Bancaire (Par défaut)</option>
                    <option value="CASH">Espèces</option>
                    <option value="CHECK">Chèque</option>
                    <option value="CREDIT_CARD">Carte Bancaire</option>
                  </select>
                </div>
              </form>
            </div>
            
            <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex justify-end space-x-3 mt-auto">
              <button 
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="px-4 py-2 text-slate-600 hover:text-slate-800 font-medium transition-colors"
              >
                Annuler
              </button>
              <button 
                type="submit"
                form="paymentForm"
                disabled={isSubmitting}
                className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg font-medium transition-colors flex items-center shadow-sm disabled:opacity-70"
              >
                {isSubmitting ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                    Enregistrement...
                  </>
                ) : (
                  "Ajouter le paiement"
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
