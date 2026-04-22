"use client";

import { useState, useEffect } from "react";
import { Bell, AlertTriangle, CheckCircle, Clock, TrendingUp, Loader2, RefreshCw } from "lucide-react";
import { apiFetch } from "../../../lib/api";

type Alerte = {
  id: string;
  type: string;
  titre: string;
  description: string;
  echeance: string;
  jours_restants: number;
  urgence: "critique" | "urgent" | "attention" | "info";
  montant: number | null;
  action: string;
  loi: string;
};

const URGENCE_CONFIG: Record<string, { color: string; bg: string; border: string; icon: any; label: string }> = {
  critique: { color: "text-red-700", bg: "bg-red-50", border: "border-red-300", icon: AlertTriangle, label: "Critique" },
  urgent: { color: "text-orange-700", bg: "bg-orange-50", border: "border-orange-300", icon: Clock, label: "Urgent" },
  attention: { color: "text-amber-700", bg: "bg-amber-50", border: "border-amber-200", icon: Bell, label: "Attention" },
  info: { color: "text-blue-700", bg: "bg-blue-50", border: "border-blue-200", icon: TrendingUp, label: "Info" },
};

const TYPE_ICONS: Record<string, string> = {
  fiscal: "🏛️",
  tresorerie: "💰",
  social: "👥",
  anomalie: "⚠️",
};

export default function AlertesPage() {
  const [data, setData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchAlertes();
  }, []);

  const fetchAlertes = async () => {
    setIsLoading(true);
    setError("");
    try {
      const result = await apiFetch("/alertes/");
      setData(result);
    } catch (err: any) {
      setError("Erreur: " + err.message);
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) return (
    <div className="flex items-center justify-center h-64">
      <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
    </div>
  );

  const alertes: Alerte[] = data?.alertes || [];

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center">
            <Bell className="w-6 h-6 mr-2 text-blue-600" />
            Alertes Fiscales & Comptables
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Détection proactive des obligations fiscales marocaines (TVA, IS, CNSS, anomalies)
          </p>
        </div>
        <button onClick={fetchAlertes}
          className="flex items-center px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-sm font-medium transition-colors">
          <RefreshCw className="w-4 h-4 mr-2" /> Actualiser
        </button>
      </div>

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-red-700">{error}</div>
      )}

      {/* Résumé */}
      {data && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: "Total alertes", value: data.total, color: "bg-slate-50 border-slate-200 text-slate-700" },
            { label: "Critiques", value: data.critiques, color: "bg-red-50 border-red-200 text-red-700" },
            { label: "Urgents", value: data.urgents, color: "bg-orange-50 border-orange-200 text-orange-700" },
            { label: "Attention", value: alertes.filter(a => a.urgence === "attention").length, color: "bg-amber-50 border-amber-200 text-amber-700" },
          ].map((stat, i) => (
            <div key={i} className={`p-4 rounded-xl border ${stat.color}`}>
              <p className="text-sm font-medium opacity-80">{stat.label}</p>
              <p className="text-3xl font-bold mt-1">{stat.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Liste alertes */}
      {alertes.length === 0 ? (
        <div className="bg-green-50 border border-green-200 rounded-xl p-12 text-center">
          <CheckCircle className="w-12 h-12 text-green-500 mx-auto mb-3" />
          <p className="text-green-700 font-semibold text-lg">Aucune alerte active</p>
          <p className="text-green-600 text-sm mt-1">Toutes vos obligations fiscales sont à jour.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {alertes.map((alerte) => {
            const config = URGENCE_CONFIG[alerte.urgence] || URGENCE_CONFIG.info;
            const Icon = config.icon;
            return (
              <div key={alerte.id} className={`p-5 rounded-xl border-2 ${config.bg} ${config.border}`}>
                <div className="flex items-start justify-between">
                  <div className="flex items-start space-x-3 flex-1">
                    <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${config.bg} border ${config.border}`}>
                      <Icon className={`w-5 h-5 ${config.color}`} />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center space-x-2 mb-1">
                        <span>{TYPE_ICONS[alerte.type] || "📋"}</span>
                        <h3 className={`font-bold ${config.color}`}>{alerte.titre}</h3>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium border ${config.bg} ${config.border} ${config.color}`}>
                          {config.label}
                        </span>
                      </div>
                      <p className="text-sm text-slate-600 mb-2">{alerte.description}</p>
                      <div className="flex flex-wrap gap-3 text-xs text-slate-500">
                        <span className="flex items-center">
                          <Clock className="w-3 h-3 mr-1" />
                          Échéance: {new Date(alerte.echeance).toLocaleDateString("fr-MA")}
                          {alerte.jours_restants > 0 ? ` (dans ${alerte.jours_restants} jours)` : " (aujourd'hui)"}
                        </span>
                        {alerte.montant != null && (
                          <span className="font-medium text-slate-700">
                            Montant: {alerte.montant.toLocaleString("fr-MA", { minimumFractionDigits: 2 })} MAD
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-3 ml-12 space-y-2">
                  <div className="flex items-start space-x-2 text-sm">
                    <span className="text-slate-400 font-medium shrink-0">Action:</span>
                    <span className="text-slate-700">{alerte.action}</span>
                  </div>
                  <div className="flex items-start space-x-2 text-xs">
                    <span className="text-slate-400 shrink-0">Référence:</span>
                    <span className="text-slate-500 italic">{alerte.loi}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="text-xs text-center text-slate-400 mt-4">
        Généré le {data?.generated_at ? new Date(data.generated_at).toLocaleString("fr-MA") : "—"} • 
        Basé sur la législation fiscale marocaine (CGI, Dahir CNSS)
      </p>
    </div>
  );
}
