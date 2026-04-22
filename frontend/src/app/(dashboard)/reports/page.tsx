"use client";

import { useState, useEffect } from "react";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title as ChartTitle,
  Tooltip as ChartTooltip,
  Legend as ChartLegend,
} from 'chart.js';
import { Bar } from 'react-chartjs-2';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ChartTitle,
  ChartTooltip,
  ChartLegend
);
import { 
  FileText, 
  TrendingUp, 
  AlertCircle, 
  Download,
  Calculator,
  PieChart
} from "lucide-react";
import { apiFetch } from "../../../lib/api";

export default function ReportsPage() {
  const [dashboardData, setDashboardData] = useState<any>(null);
  const [taxData, setTaxData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    fetchReportsData();
  }, []);

  const fetchReportsData = async () => {
    try {
      setIsLoading(true);
      const [dashData, taxesData] = await Promise.all([
        apiFetch("/reports/dashboard"),
        apiFetch("/reports/taxes")
      ]);
      setDashboardData(dashData);
      setTaxData(taxesData);
      setError("");
    } catch (err: any) {
      setError("Erreur lors du chargement des rapports. " + err.message);
    } finally {
      setIsLoading(false);
    }
  };

  if (!mounted) return null;

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="flex flex-col items-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mb-4"></div>
          <p className="text-slate-500 font-medium">Chargement des rapports...</p>
        </div>
      </div>
    );
  }

  // Formatting chart data for Recharts
  const revenueChartData = dashboardData?.revenue_chart || [];
  const expensesChartData = dashboardData?.expense_chart || [];
  
  const barChartData = {
    labels: revenueChartData.map((d: any) => d.label),
    datasets: [
      {
        label: 'Revenus (MAD)',
        data: revenueChartData.map((d: any) => d.value),
        backgroundColor: '#3b82f6',
        borderRadius: 4,
      },
      {
        label: 'Dépenses (MAD)',
        data: expensesChartData.map((d: any) => d.value),
        backgroundColor: '#f43f5e',
        borderRadius: 4,
      }
    ],
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'top' as const },
      tooltip: {
        callbacks: {
          label: function(context: any) {
            let label = context.dataset.label || '';
            if (label) {
              label += ': ';
            }
            if (context.parsed.y !== null) {
              label += context.parsed.y.toLocaleString("fr-MA") + ' MAD';
            }
            return label;
          }
        }
      }
    },
    scales: {
      y: {
        beginAtZero: true,
        ticks: {
          callback: function(value: any) {
            return (value / 1000) + 'k';
          }
        }
      }
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Rapports & Analyses</h1>
          <p className="text-sm text-slate-500 mt-1">Consultez vos performances financières et vos obligations fiscales.</p>
        </div>
        <button className="bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center shadow-sm">
          <Download className="w-4 h-4 mr-2" />
          Exporter PDF
        </button>
      </div>

      {error && (
        <div className="p-4 bg-red-50 text-red-600 rounded-lg flex items-center shadow-sm border border-red-100">
          <AlertCircle className="w-5 h-5 mr-3" />
          {error}
        </div>
      )}

      {/* Vue d'ensemble Financière */}
      <h2 className="text-lg font-semibold text-slate-800 flex items-center mt-8 mb-4">
        <TrendingUp className="w-5 h-5 mr-2 text-blue-600" />
        Vue d'ensemble Financière
      </h2>
      
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
          <h3 className="text-base font-medium text-slate-800 mb-6">Évolution des Revenus vs Dépenses</h3>
          <div className="h-72 w-full">
              <Bar options={chartOptions} data={barChartData} />
          </div>
        </div>

        <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex flex-col justify-center items-center text-center">
           <div className="w-20 h-20 bg-blue-50 rounded-full flex items-center justify-center mb-4">
               <PieChart className="w-10 h-10 text-blue-600" />
           </div>
           <h3 className="text-xl font-bold text-slate-800">Chiffre d'Affaires du Mois</h3>
           <p className="text-4xl font-black text-blue-600 mt-4">
             {dashboardData?.kpis.monthly_revenue.toLocaleString("fr-MA")} <span className="text-xl text-slate-500 font-medium tracking-normal">MAD</span>
           </p>
           <p className="text-sm text-slate-500 mt-2">
             Basé sur les paiements enregistrés ce mois-ci.
           </p>
        </div>
      </div>

      {/* Rapport Fiscal (TVA) */}
      <h2 className="text-lg font-semibold text-slate-800 flex items-center mt-10 mb-4">
        <Calculator className="w-5 h-5 mr-2 text-indigo-600" />
        Déclaration de TVA (Période : {taxData?.period})
      </h2>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm relative overflow-hidden">
          <div className="absolute top-0 right-0 p-4 opacity-5">
            <Calculator className="w-16 h-16" />
          </div>
          <p className="text-sm font-medium text-slate-500">TVA Facturée (Collectée)</p>
          <p className="text-2xl font-bold text-slate-800 mt-2">
            {taxData?.collected_vat.toLocaleString("fr-MA", { minimumFractionDigits: 2 })} <span className="text-sm font-normal text-slate-500">MAD</span>
          </p>
          <p className="text-xs text-slate-400 mt-2 border-t border-slate-100 pt-2">Sur les encaissements du mois</p>
        </div>

        <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm relative overflow-hidden">
          <div className="absolute top-0 right-0 p-4 opacity-5">
            <FileText className="w-16 h-16" />
          </div>
          <p className="text-sm font-medium text-slate-500">TVA Récupérable (Déductible)</p>
          <p className="text-2xl font-bold text-slate-800 mt-2">
            {taxData?.deductible_vat.toLocaleString("fr-MA", { minimumFractionDigits: 2 })} <span className="text-sm font-normal text-slate-500">MAD</span>
          </p>
          <p className="text-xs text-slate-400 mt-2 border-t border-slate-100 pt-2">Sur les achats et charges</p>
        </div>

        <div className="bg-indigo-600 p-6 rounded-xl border border-indigo-700 shadow-md relative overflow-hidden text-white">
          <div className="absolute top-0 right-0 p-4 opacity-10">
            <TrendingUp className="w-16 h-16 text-white" />
          </div>
          <p className="text-indigo-100 text-sm font-medium">TVA Nette à Payer</p>
          <p className="text-3xl font-bold text-white mt-1">
            {taxData?.net_vat_due.toLocaleString("fr-MA", { minimumFractionDigits: 2 })} <span className="text-sm font-normal text-indigo-200">MAD</span>
          </p>
          <div className="mt-3 inline-block bg-indigo-500/50 px-3 py-1 rounded-full text-xs font-medium border border-indigo-400">
            À déclarer avant le 20 du mois prochain
          </div>
        </div>
      </div>
    </div>
  );
}
