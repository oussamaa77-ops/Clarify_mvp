"use client";

import { useState, useEffect } from "react";
import { Building, Save, AlertCircle, CheckCircle } from "lucide-react";
import { apiFetch } from "../../../lib/api";

type CompanySettings = {
  name: string;
  ice: string;
  tax_id: string; // IF
  rc: string; // Registre de commerce
  address: string;
};

export default function SettingsPage() {
  const [formData, setFormData] = useState<CompanySettings>({
    name: "", ice: "", tax_id: "", rc: "", address: ""
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState({ type: "", text: "" });

  useEffect(() => {
    // Load initial settings
    apiFetch("/settings/company")
      .then((data) => {
        if (data) {
          setFormData({
            name: data.name || "",
            ice: data.ice || "",
            tax_id: data.tax_id || "",
            rc: data.rc || "",
            address: data.address || ""
          });
        }
      })
      .catch((err) => setMessage({ type: "error", text: "Erreur de chargement des paramètres." }))
      .finally(() => setIsLoading(false));
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSave = async () => {
    setIsSaving(true);
    setMessage({ type: "", text: "" });
    try {
      await apiFetch("/settings/company", {
        method: "PUT",
        body: formData
      });
      setMessage({ type: "success", text: "Paramètres sauvegardés avec succès ! Ces informations apparaîtront sur vos prochains devis et factures." });
    } catch (err: any) {
      setMessage({ type: "error", text: err.message || "Erreur de sauvegarde." });
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return <div className="flex h-full items-center justify-center p-10"><div className="w-8 h-8 border-4 border-slate-200 border-t-blue-600 rounded-full animate-spin"></div></div>;
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center space-x-3 mb-6">
        <div className="bg-slate-100 p-3 rounded-xl border border-slate-200">
          <Building className="w-6 h-6 text-slate-700" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Paramètres de l'Entreprise</h1>
          <p className="text-sm text-slate-500">Gérez les informations légales qui apparaîtront sur vos documents officiels.</p>
        </div>
      </div>

      {message.text && (
        <div className={`p-4 rounded-xl flex items-center shadow-sm border ${message.type === 'error' ? 'bg-red-50 text-red-700 border-red-100' : 'bg-green-50 text-green-700 border-green-100'}`}>
          {message.type === 'error' ? <AlertCircle className="w-5 h-5 mr-3" /> : <CheckCircle className="w-5 h-5 mr-3" />}
          {message.text}
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="p-6 border-b border-slate-100">
          <h2 className="text-lg font-semibold text-slate-800">Identité Légale</h2>
          <p className="text-sm text-slate-500 mt-1">Ces informations sont obligatoires selon la loi marocaine pour l'édition de factures.</p>
        </div>

        <div className="p-6 space-y-6">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Raison Sociale (Nom de l'entreprise) *</label>
            <input 
              type="text" 
              name="name" 
              value={formData.name} 
              onChange={handleChange}
              placeholder="Ex: Hissabi Pro SARL" 
              className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-slate-400 text-slate-700"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">ICE</label>
              <input 
                type="text" 
                name="ice" 
                value={formData.ice} 
                onChange={handleChange}
                placeholder="15 chiffres" 
                className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-slate-400 text-slate-700"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Identifiant Fiscal (IF)</label>
              <input 
                type="text" 
                name="tax_id" 
                value={formData.tax_id} 
                onChange={handleChange}
                placeholder="Ex: 12345678" 
                className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-slate-400 text-slate-700"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Registre de Commerce (RC)</label>
              <input 
                type="text" 
                name="rc" 
                value={formData.rc} 
                onChange={handleChange}
                placeholder="Ex: Casablanca 123" 
                className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-slate-400 text-slate-700"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Adresse Complète</label>
            <textarea 
              name="address" 
              rows={3}
              value={formData.address} 
              onChange={handleChange}
              placeholder="Ex: 123 Boulevard d'Anfa, Casablanca, Maroc" 
              className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none placeholder-slate-400 text-slate-700"
            />
          </div>
        </div>

        <div className="bg-slate-50 p-6 flex justify-end border-t border-slate-100">
          <button 
            onClick={handleSave} 
            disabled={isSaving}
            className="flex items-center bg-blue-600 hover:bg-blue-700 text-white px-6 py-2.5 rounded-lg font-medium transition-colors shadow-sm disabled:bg-blue-400"
          >
            <Save className="w-4 h-4 mr-2" />
            {isSaving ? "Sauvegarde..." : "Enregistrer les modifications"}
          </button>
        </div>
      </div>
    </div>
  );
}
