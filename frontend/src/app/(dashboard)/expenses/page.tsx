"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Plus, Search, Eye, Edit, Trash2 } from "lucide-react";
import { apiFetch } from "../../../lib/api";

interface SupplierBill {
  id: number;
  number: string;
  date: string;
  total_incl_tax: number;
  status: string;
}

export default function ExpensesPage() {
  const [bills, setBills] = useState<SupplierBill[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchBills();
  }, []);

  const fetchBills = async () => {
    try {
      const data = await apiFetch("/supplier-bills");
      setBills(data);
    } catch (error) {
      console.error("Failed to fetch supplier bills:", error);
    } finally {
      setLoading(false);
    }
  };

  const statusColors: Record<string, string> = {
    DRAFT: "bg-slate-100 text-slate-800",
    PAID: "bg-green-100 text-green-800",
    CANCELLED: "bg-red-100 text-red-800",
  };

  const statusLabels: Record<string, string> = {
    DRAFT: "Brouillon",
    PAID: "Payée",
    CANCELLED: "Annulée",
  };

  if (loading) return <div className="p-8 text-center text-slate-500">Chargement des achats...</div>;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Achats & Dépenses</h1>
          <p className="text-sm text-slate-500 mt-1">Gérez vos factures fournisseurs et vos achats.</p>
        </div>
        <Link 
          href="/expenses/new"
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center shadow-sm"
        >
          <Plus className="w-4 h-4 mr-2" />
          Nouvelle Dépense
        </Link>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="p-4 border-b border-slate-200 flex justify-between items-center bg-slate-50">
          <div className="relative w-64">
            <input type="text" placeholder="Rechercher une facture..." className="w-full pl-9 pr-4 py-2 border border-slate-300 rounded-lg text-sm placeholder-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-slate-400 placeholder-slate-400 text-slate-500"
            />
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-white border-b border-slate-200 text-xs uppercase text-slate-500 font-semibold tracking-wider">
                <th className="p-4">Numéro</th>
                <th className="p-4">Date</th>
                <th className="p-4 text-right">Montant TTC</th>
                <th className="p-4 text-center">Statut</th>
                <th className="p-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {bills.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-8 text-center text-slate-500">
                    Aucune dépense trouvée. Cliquez sur "Nouvelle Dépense" pour commencer.
                  </td>
                </tr>
              ) : (
                bills.map((bill) => (
                  <tr key={bill.id} className="hover:bg-slate-50 transition-colors group">
                    <td className="p-4 text-sm font-medium text-slate-800">{bill.number}</td>
                    <td className="p-4 text-sm text-slate-600">{new Date(bill.date).toLocaleDateString("fr-MA")}</td>
                    <td className="p-4 text-sm font-bold text-slate-800 text-right">
                      {bill.total_incl_tax.toLocaleString("fr-MA")} MAD
                    </td>
                    <td className="p-4 text-center">
                      <span className={`px-2.5 py-1 text-xs font-semibold rounded-full ${statusColors[bill.status] || "bg-slate-100 text-slate-800"}`}>
                        {statusLabels[bill.status] || bill.status}
                      </span>
                    </td>
                    <td className="p-4 text-right space-x-2">
                       <button className="text-slate-400 hover:text-blue-600 transition-colors p-1" title="Voir détails">
                         <Eye className="w-4 h-4" />
                       </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
