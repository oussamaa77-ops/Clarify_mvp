"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Save, AlertCircle, Plus, Trash2 } from "lucide-react";
import { apiFetch } from "../../../../lib/api";

export default function NewExpensePage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  
  // Actually, we need suppliers. For MVP we'll pick first client or mock it.
  const [supplierId, setSupplierId] = useState<number>(1);
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  
  const [items, setItems] = useState([
    { product_name: "", quantity: 1, unit_price: 0, vat_rate: 20 }
  ]);

  const handleAddItem = () => {
    setItems([...items, { product_name: "", quantity: 1, unit_price: 0, vat_rate: 20 }]);
  };

  const handleRemoveItem = (index: number) => {
    if (items.length > 1) {
      setItems(items.filter((_, i) => i !== index));
    }
  };

  const updateItem = (index: number, field: string, value: any) => {
    const newItems = [...items];
    newItems[index] = { ...newItems[index], [field]: value };
    setItems(newItems);
  };

  const totalExclTax = items.reduce((sum, item) => sum + (item.quantity * item.unit_price), 0);
  const totalVat = items.reduce((sum, item) => sum + (item.quantity * item.unit_price * (item.vat_rate / 100)), 0);
  const totalInclTax = totalExclTax + totalVat;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      if (items.some(i => i.product_name.trim() === "" || i.unit_price <= 0)) {
         throw new Error("Veuillez remplir correctement toutes les lignes.");
      }

      await apiFetch("/supplier-bills", {
        method: "POST",
        body: JSON.stringify({
          supplier_id: supplierId,
          date,
          items
        })
      });

      router.push("/expenses");
    } catch (err: any) {
      setError(err.message || "Erreur lors de la création de la dépense.");
      setLoading(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">Nouvelle Dépense</h1>
        <p className="text-sm text-slate-500 mt-1">Créez une facture fournisseur ou une charge.</p>
      </div>

      {error && (
        <div className="p-4 bg-red-50 text-red-600 rounded-lg flex items-center shadow-sm border border-red-100">
          <AlertCircle className="w-5 h-5 mr-3" />
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="p-6 space-y-6">
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Fournisseur (ID)*</label>
              <input 
                type="number"
                required
                value={supplierId}
                onChange={(e) => setSupplierId(Number(e.target.value))}
                className="w-full px-4 py-2 border border-slate-300 rounded-lg text-sm placeholder-slate-400 text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="text-xs text-slate-400 mt-1">Pour la démo MVP, entrez 1 si un client/fournisseur existe.</p>
            </div>
            
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Date Facture*</label>
              <input 
                type="date"
                required
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full px-4 py-2 border border-slate-300 rounded-lg text-sm placeholder-slate-400 text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <div className="border-t border-slate-200 pt-6">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-sm font-semibold text-slate-800 uppercase tracking-wider">Lignes de dépense</h3>
            </div>
            
            <div className="space-y-3">
              <div className="grid grid-cols-12 gap-3 text-xs font-semibold text-slate-500 uppercase px-1">
                <div className="col-span-12 md:col-span-5">Description</div>
                <div className="col-span-4 md:col-span-2">Qté</div>
                <div className="col-span-4 md:col-span-2">Prix Unitaire</div>
                <div className="col-span-3 md:col-span-2">TVA (%)</div>
                <div className="col-span-1 text-center"></div>
              </div>

              {items.map((item, index) => (
                <div key={index} className="grid grid-cols-12 gap-3 items-center">
                  <div className="col-span-12 md:col-span-5">
                    <input 
                      type="text"
                      placeholder="Service, article..."
                      required
                      value={item.product_name}
                      onChange={(e) => updateItem(index, 'product_name', e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm placeholder-slate-400 text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div className="col-span-4 md:col-span-2">
                    <input 
                      type="number"
                      min="0.01" step="0.01"
                      required
                      value={item.quantity}
                      onChange={(e) => updateItem(index, 'quantity', Number(e.target.value))}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm placeholder-slate-400 text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div className="col-span-4 md:col-span-2">
                    <input 
                      type="number"
                      min="0" step="0.01"
                      required
                      placeholder="MAD"
                      value={item.unit_price}
                      onChange={(e) => updateItem(index, 'unit_price', Number(e.target.value))}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm placeholder-slate-400 text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div className="col-span-3 md:col-span-2">
                    <select 
                      value={item.vat_rate}
                      onChange={(e) => updateItem(index, 'vat_rate', Number(e.target.value))}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="20">20%</option>
                      <option value="14">14%</option>
                      <option value="10">10%</option>
                      <option value="7">7%</option>
                      <option value="0">Exonéré (0%)</option>
                    </select>
                  </div>
                  <div className="col-span-1 text-center">
                    <button 
                      type="button"
                      onClick={() => handleRemoveItem(index)}
                      className={`p-2 rounded-lg text-slate-400 hover:text-red-600 transition-colors ${items.length === 1 ? 'opacity-50 cursor-not-allowed' : ''}`}
                      disabled={items.length === 1}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <button 
              type="button"
              onClick={handleAddItem}
              className="mt-4 text-sm font-medium text-blue-600 hover:text-blue-700 flex items-center transition-colors px-2 py-1 hover:bg-blue-50 rounded-lg"
            >
              <Plus className="w-4 h-4 mr-1" /> Ajouter une ligne
            </button>
          </div>

        </div>

        <div className="bg-slate-50 p-6 border-t border-slate-200">
           <div className="w-full md:w-1/2 ml-auto space-y-2">
              <div className="flex justify-between text-sm text-slate-600 py-1">
                <span>Total HT</span>
                <span className="font-medium">{totalExclTax.toLocaleString("fr-MA")} MAD</span>
              </div>
              <div className="flex justify-between text-sm text-slate-600 py-1 border-b border-slate-200 pb-3">
                <span>Total TVA</span>
                <span className="font-medium">{totalVat.toLocaleString("fr-MA")} MAD</span>
              </div>
              <div className="flex justify-between text-lg font-bold text-slate-800 pt-2">
                <span>Total TTC</span>
                <span>{totalInclTax.toLocaleString("fr-MA")} MAD</span>
              </div>
           </div>

           <div className="flex justify-end mt-8">
              <button 
                type="submit"
                disabled={loading}
                className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2.5 rounded-lg text-sm font-medium transition-colors flex items-center shadow-sm disabled:opacity-70"
              >
                {loading ? (
                  <span className="flex items-center">
                     <span className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full mr-2"></span>
                     Enregistrement...
                  </span>
                ) : (
                  <span className="flex items-center">
                     <Save className="w-4 h-4 mr-2" />
                     Enregistrer Dépense
                  </span>
                )}
              </button>
           </div>
        </div>
      </form>
    </div>
  );
}
