"use client";

import { useState, useEffect } from "react";
import { ArrowLeft, Plus, PlusCircle, Trash2, Save, Send, AlertCircle } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiFetch } from "../../../../lib/api";

type QuoteItem = {
  id: number;
  description: string;
  quantity: number;
  unitPrice: number;
  vatRate: number;
};

export default function CreateQuotePage() {
  const router = useRouter();
  const [items, setItems] = useState<QuoteItem[]>([
    { id: 1, description: "", quantity: 1, unitPrice: 0, vatRate: 20 }
  ]);

  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [validUntil, setValidUntil] = useState("");
  const [clientId, setClientId] = useState("");
  
  const [clients, setClients] = useState<any[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    // Fetch clients for the dropdown
    apiFetch("/clients").then(data => {
      setClients(data || []);
    }).catch(err => console.error(err));
  }, []);

  const handleSubmit = async (status: string) => {
    if (!clientId) {
      setError("Veuillez sélectionner un client/prospect.");
      return;
    }
    
    // Validate items
    const validItems = items.filter(i => i.description.trim() !== "" && i.quantity > 0 && i.unitPrice >= 0);
    if (validItems.length === 0) {
      setError("Veuillez ajouter au moins un article valide.");
      return;
    }

    try {
      setIsSubmitting(true);
      setError("");

      const payload = {
        client_id: parseInt(clientId),
        date: date,
        valid_until: validUntil || null,
        status: status,
        items: validItems.map(item => ({
          description: item.description,
          quantity: item.quantity,
          unit_price: item.unitPrice,
          vat_rate: item.vatRate
        }))
      };

      await apiFetch("/quotes", {
        method: "POST",
        body: payload
      });

      router.push("/quotes");
    } catch (err: any) {
      setError(err.message || "Erreur lors de la création du devis");
    } finally {
      setIsSubmitting(false);
    }
  };

  const updateItem = (id: number, field: keyof QuoteItem, value: any) => {
    setItems(items.map(item => item.id === id ? { ...item, [field]: value } : item));
  };

  const addItem = () => {
    const newId = items.length > 0 ? Math.max(...items.map(i => i.id)) + 1 : 1;
    setItems([...items, { id: newId, description: "", quantity: 1, unitPrice: 0, vatRate: 20 }]);
  };

  const removeItem = (id: number) => {
    if (items.length > 1) {
      setItems(items.filter(item => item.id !== id));
    }
  };

  // Calculations
  const subtotal = items.reduce((acc, item) => acc + (item.quantity * item.unitPrice), 0);
  
  const vatTotalsByRate = items.reduce((acc, item) => {
    const vatAmount = (item.quantity * item.unitPrice) * (item.vatRate / 100);
    if (!acc[item.vatRate]) acc[item.vatRate] = 0;
    acc[item.vatRate] += vatAmount;
    return acc;
  }, {} as Record<number, number>);

  const totalVat = Object.values(vatTotalsByRate).reduce((acc, val) => acc + val, 0);
  const total = subtotal + totalVat;

  const vatRates = [20, 14, 10, 7];

  return (
    <div className="space-y-6 pb-20">
      {/* Header */}
      <div className="flex items-center space-x-4">
        <Link href="/quotes" className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-full transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div>
          <div className="flex items-center space-x-3">
            <h1 className="text-2xl font-bold text-slate-800">Nouveau Devis</h1>
            <span className="bg-slate-100 text-slate-600 px-2.5 py-1 rounded text-xs font-semibold tracking-wide">BROUILLON</span>
          </div>
          <p className="text-sm text-slate-500 mt-1">Éditez une proposition commerciale professionnelle en un clic.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Editor */}
        <div className="lg:col-span-2 space-y-6">
          {error && (
            <div className="p-4 bg-red-50 text-red-600 rounded-lg flex items-center shadow-sm border border-red-100">
              <AlertCircle className="w-5 h-5 mr-3" />
              {error}
            </div>
          )}

          {/* Document Details */}
          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
            <h2 className="text-lg font-semibold text-slate-800 border-b border-slate-100 pb-3">Détails de l'offre</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1">Prospect / Client *</label>
                <select className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white placeholder-slate-400 text-slate-500"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                >
                  <option value="" disabled>Sélectionner un client...</option>
                  {clients.map(c => (
                    <option key={c.id} value={c.id}>{c.name} {c.ice ? `(ICE: ${c.ice})` : ''}</option>
                  ))}
                </select>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Date d'émission *</label>
                <input type="date" className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-slate-400 text-slate-500"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Valable jusqu'au</label>
                <input type="date" className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-slate-400 text-slate-500"
                  value={validUntil}
                  onChange={(e) => setValidUntil(e.target.value)}
                />
              </div>
            </div>
          </div>

          {/* Items Line Editor */}
          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
            <div className="flex justify-between items-center border-b border-slate-100 pb-3 mb-4">
              <h2 className="text-lg font-semibold text-slate-800">Articles</h2>
              <button className="text-sm text-blue-600 font-medium hover:underline flex items-center">
                <PlusCircle className="w-4 h-4 mr-1" /> Sélectionner depuis le catalogue
              </button>
            </div>

            <div className="space-y-4">
              {/* Header Row (Hidden on small screens) */}
              <div className="hidden md:grid grid-cols-12 gap-4 text-sm font-medium text-slate-500 px-2">
                <div className="col-span-4">Description</div>
                <div className="col-span-2 text-right">Qté</div>
                <div className="col-span-2 text-right">Prix U. HT</div>
                <div className="col-span-2 text-right">TVA</div>
                <div className="col-span-2 text-right">Total HT</div>
              </div>

              {/* Items List */}
              {items.map((item, index) => (
                <div key={item.id} className="group relative flex flex-col md:grid md:grid-cols-12 gap-4 items-start md:items-center bg-slate-50 md:bg-transparent p-4 md:p-2 rounded-lg border border-slate-100 md:border-none">
                  
                  {/* Delete Button (Absolute on md screens) */}
                  <div className="absolute -left-10 top-1/2 -translate-y-1/2 hidden md:flex opacity-0 group-hover:opacity-100 transition-opacity">
                    <button 
                      onClick={() => removeItem(item.id)}
                      className="p-1.5 text-red-500 hover:bg-red-50 rounded-full"
                      disabled={items.length === 1}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>

                  {/* Description */}
                  <div className="col-span-4 w-full">
                    <label className="md:hidden text-xs text-slate-500 mb-1 block">Description</label>
                    <input type="text" placeholder="Description de l'offre" className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm placeholder-slate-400 text-slate-500"
                      value={item.description}
                      onChange={(e) => updateItem(item.id, 'description', e.target.value)}
                    />
                  </div>

                  {/* Quantity */}
                  <div className="col-span-2 w-full">
                    <label className="md:hidden text-xs text-slate-500 mb-1 block">Qté</label>
                    <input type="number" min="1" className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm md:text-right placeholder-slate-400 text-slate-500"
                      value={item.quantity}
                      onChange={(e) => updateItem(item.id, 'quantity', parseFloat(e.target.value) || 0)}
                    />
                  </div>

                  {/* Unit Price */}
                  <div className="col-span-2 w-full">
                    <label className="md:hidden text-xs text-slate-500 mb-1 block">Prix U. HT</label>
                    <input type="number" min="0" step="0.01" className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm md:text-right placeholder-slate-400 text-slate-500"
                      value={item.unitPrice}
                      onChange={(e) => updateItem(item.id, 'unitPrice', parseFloat(e.target.value) || 0)}
                    />
                  </div>

                  {/* VAT Rate */}
                  <div className="col-span-2 w-full">
                    <label className="md:hidden text-xs text-slate-500 mb-1 block">TVA</label>
                    <select className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm bg-white md:text-right placeholder-slate-400 text-slate-500"
                      value={item.vatRate}
                      onChange={(e) => updateItem(item.id, 'vatRate', parseInt(e.target.value))}
                    >
                      {vatRates.map(rate => (
                        <option key={rate} value={rate}>{rate}%</option>
                      ))}
                    </select>
                  </div>

                  {/* Line Total */}
                  <div className="col-span-2 w-full text-right font-medium text-slate-700">
                    <label className="md:hidden text-xs text-slate-500 mb-1 block text-left">Total HT</label>
                    {(item.quantity * item.unitPrice).toLocaleString("fr-MA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </div>

                  {/* Mobile delete */}
                  <button 
                    onClick={() => removeItem(item.id)}
                    className="md:hidden w-full py-2 mt-2 text-sm text-red-600 border border-red-200 rounded-lg bg-red-50 flex items-center justify-center"
                    disabled={items.length === 1}
                  >
                    <Trash2 className="w-4 h-4 mr-2" /> Supprimer la ligne
                  </button>
                </div>
              ))}
            </div>

            <button 
              onClick={addItem}
              className="mt-6 flex items-center px-4 py-2 border border-dashed border-slate-300 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-50 hover:border-slate-400 transition-colors w-full justify-center"
            >
              <Plus className="w-4 h-4 mr-2" />
              Ajouter une ligne
            </button>
            
          </div>
        </div>

        {/* Sidebar Summary */}
        <div className="space-y-6">
          <div className="bg-slate-50 p-6 rounded-xl border border-slate-200">
            <h3 className="text-lg font-bold text-slate-800 mb-4">Résumé</h3>
            
            <div className="space-y-3 text-sm">
              <div className="flex justify-between text-slate-600">
                <span>Sous-total HT</span>
                <span className="font-medium text-slate-800">{subtotal.toLocaleString("fr-MA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MAD</span>
              </div>
              
              {/* Dynamic VAT Breakdown */}
              {Object.entries(vatTotalsByRate).map(([rate, amount]) => {
                if (amount > 0) {
                  return (
                    <div key={rate} className="flex justify-between text-slate-500">
                      <span>TVA ({rate}%)</span>
                      <span>{amount.toLocaleString("fr-MA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MAD</span>
                    </div>
                  );
                }
                return null;
              })}

              <div className="border-t border-slate-200 my-3 pt-3 flex justify-between items-center">
                <span className="font-bold text-slate-800">Total TTC</span>
                <span className="text-xl font-bold text-blue-700">{total.toLocaleString("fr-MA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MAD</span>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <button 
              onClick={() => handleSubmit('DRAFT')}
              disabled={isSubmitting}
              className="w-full flex items-center justify-center px-4 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white rounded-xl text-sm font-bold transition-colors shadow-sm"
            >
              <Save className="w-4 h-4 mr-2" />
              {isSubmitting ? "Enregistrement..." : "Enregistrer brouillon"}
            </button>
            
            <button 
              onClick={() => handleSubmit('SENT')}
              disabled={isSubmitting}
              className="w-full flex items-center justify-center px-4 py-3 bg-slate-800 hover:bg-slate-900 disabled:bg-slate-500 text-white rounded-xl text-sm font-bold transition-colors shadow-sm"
            >
              <Send className="w-4 h-4 mr-2" />
              Finaliser et Envoyer au Client
            </button>
            
            <p className="text-xs text-center text-slate-500 mt-4">
              En finalisant, un numéro de devis professionnel (DEV-YYYY-XXXX) sera attribué. Les devis ne génèrent aucune ligne comptable jusqu'à leur validation en facture.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
