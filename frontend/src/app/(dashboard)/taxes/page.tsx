"use client";

import { useState, useEffect } from "react";
import { Calculator, TrendingUp, ArrowDownRight, ArrowUpRight, DollarSign, AlertCircle } from "lucide-react";
import { apiFetch } from "../../../lib/api";

interface VatReport {
  period: string;
  collected_vat: number;
  deductible_vat: number;
  net_vat_due: number;
}

export default function TaxesPage() {
  const [report, setReport] = useState<VatReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchVatReport();
  }, []);

  const fetchVatReport = async () => {
    try {
      const data = await apiFetch("/reports/taxes");
      setReport(data);
    } catch (err: any) {
      setError(err.message || "Erreur lors de la récupération du rapport de TVA");
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <div className="p-8 text-center text-slate-500">Calcul en cours...</div>;

  if (error) {
    return (
      <div className="p-4 bg-red-50 text-red-600 rounded-lg flex items-center shadow-sm">
        <AlertCircle className="w-5 h-5 mr-3" />
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center">
            <Calculator className="w-6 h-6 mr-2 text-indigo-600" />
            Fiscalité & TVA
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Déclaration de TVA pour la période : <span className="font-semibold text-slate-700">{report?.period}</span>
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-8">
        
        {/* TVA Collectée */}
        <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm relative overflow-hidden group hover:shadow-md transition-all">
          <div className="flex justify-between items-start mb-4">
            <div>
              <p className="text-sm font-medium text-slate-500">TVA Facturée (Collectée)</p>
              <h3 className="text-2xl font-bold text-slate-800 mt-2">
                {report?.collected_vat.toLocaleString("fr-MA", { minimumFractionDigits: 2 })} <span className="text-sm font-normal text-slate-500">MAD</span>
              </h3>
            </div>
            <div className="p-3 bg-emerald-50 text-emerald-600 rounded-lg">
              <ArrowUpRight className="w-6 h-6" />
            </div>
          </div>
          <p className="text-xs text-slate-500 font-medium">Issue de vos factures clients payées</p>
        </div>

        {/* TVA Déductible */}
        <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm relative overflow-hidden group hover:shadow-md transition-all">
          <div className="flex justify-between items-start mb-4">
            <div>
              <p className="text-sm font-medium text-slate-500">TVA Récupérable (Déductible)</p>
              <h3 className="text-2xl font-bold text-slate-800 mt-2">
                {report?.deductible_vat.toLocaleString("fr-MA", { minimumFractionDigits: 2 })} <span className="text-sm font-normal text-slate-500">MAD</span>
              </h3>
            </div>
            <div className="p-3 bg-amber-50 text-amber-600 rounded-lg">
              <ArrowDownRight className="w-6 h-6" />
            </div>
          </div>
          <p className="text-xs text-slate-500 font-medium">Issue de vos achats et charges</p>
        </div>

        {/* TVA Nette à payer */}
        <div className="bg-indigo-600 p-6 rounded-xl border border-indigo-700 shadow-lg relative overflow-hidden text-white transform transition-transform hover:-translate-y-1">
          <div className="absolute top-0 right-0 p-4 opacity-10">
            <TrendingUp className="w-24 h-24 text-white" />
          </div>
          <div className="relative z-10">
            <p className="text-indigo-100 text-sm font-medium">TVA Nette à Payer au Trésor</p>
            <p className="text-3xl font-bold text-white mt-2">
              {report?.net_vat_due.toLocaleString("fr-MA", { minimumFractionDigits: 2 })} <span className="text-base font-normal text-indigo-200">MAD</span>
            </p>
            
            <div className="mt-6 flex items-center justify-between">
               <div className="bg-indigo-500/50 px-3 py-1 rounded-full text-xs font-medium border border-indigo-400 backdrop-blur-sm">
                 À déclarer avant le 20 du mois
               </div>
            </div>
          </div>
        </div>
      </div>
      
      <div className="bg-blue-50 border border-blue-100 p-4 rounded-xl flex items-start text-blue-800 mt-8">
         <AlertCircle className="w-5 h-5 mr-3 mt-0.5 flex-shrink-0" />
         <div>
            <h4 className="font-semibold text-sm">Précision de calcul</h4>
            <p className="text-sm mt-1 opacity-90">
              Le calcul de la TVA est désormais basé sur les données réelles de vos factures encaissées et de vos factures d'achats. Assurez-vous d'avoir saisi tous vos achats fournisseurs pour maximiser votre récupération de TVA.
            </p>
         </div>
      </div>

    </div>
  );
}
