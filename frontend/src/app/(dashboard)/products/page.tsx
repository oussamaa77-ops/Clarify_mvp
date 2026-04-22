"use client";
import { useState, useEffect } from "react";
import { Plus, Search, MoreVertical, Edit, Trash2, Package, Tag, Filter, AlertCircle } from "lucide-react";
import { apiFetch } from "../../../lib/api";

type Product = {
  id: number;
  name: string;
  description: string;
  price: number;
  vat_rate: number;
  sku: string;
  type: "PRODUCT" | "SERVICE";
};

export default function ProductsPage() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<"create" | "edit">("create");
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [formData, setFormData] = useState<Partial<Product>>({ type: "PRODUCT", vat_rate: 20 });

  useEffect(() => {
    fetchProducts();
  }, []);

  const fetchProducts = async () => {
    try {
      setIsLoading(true);
      const data = await apiFetch("/products");
      setProducts(data || []);
      setError("");
    } catch (err: any) {
      setError("Erreur lors du chargement des produits. " + err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleOpenModal = (mode: "create" | "edit", product?: Product) => {
    setModalMode(mode);
    setSelectedProduct(product || null);
    setFormData(product ? { ...product } : { type: "PRODUCT", vat_rate: 20 });
    setIsModalOpen(true);
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setSelectedProduct(null);
    setFormData({ type: "PRODUCT", vat_rate: 20 });
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (modalMode === "create") {
        await apiFetch("/products", {
          method: "POST",
          body: formData,
        });
      } else if (modalMode === "edit" && selectedProduct) {
        await apiFetch(`/products/${selectedProduct.id}`, {
          method: "PUT",
          body: formData,
        });
      }
      fetchProducts();
      handleCloseModal();
    } catch (err: any) {
      alert("Erreur: " + err.message);
    }
  };

  const handleDelete = async (id: number) => {
    if (confirm("Êtes-vous sûr de vouloir supprimer ce produit/service ?")) {
      try {
        await apiFetch(`/products/${id}`, { method: "DELETE" });
        fetchProducts();
      } catch (err: any) {
        alert("Erreur lors de la suppression: " + err.message);
      }
    }
  };

  const vatRates = [20, 14, 10, 7];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Catalogue</h1>
          <p className="text-sm text-slate-500 mt-1">Gérez vos produits, services et tarifications.</p>
        </div>
        <button 
          onClick={() => handleOpenModal("create")}
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center"
        >
          <Plus className="w-4 h-4 mr-2" />
          Ajouter au catalogue
        </button>
      </div>

      {/* Error & Loading States */}
      {error && (
        <div className="p-4 bg-red-50 text-red-600 rounded-lg flex items-center shadow-sm border border-red-100">
          <AlertCircle className="w-5 h-5 mr-3" />
          {error}
        </div>
      )}

      {/* Table Container */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        {/* Table Toolbar */}
        <div className="p-4 border-b border-slate-200 flex justify-between items-center bg-slate-50/50 flex-wrap gap-4">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400" />
            <input type="text" placeholder="Rechercher (Nom, SKU)..." className="pl-9 pr-3 py-2 border border-slate-300 rounded-lg text-sm w-72 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-slate-500 text-slate-950 font-medium" 
            />
          </div>
          <div className="flex space-x-2">
            <button className="flex items-center px-3 py-2 text-sm text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50">
              <Filter className="w-4 h-4 mr-2" />
              TVA
            </button>
            <select className="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white placeholder-slate-500 text-slate-950 font-medium">
              <option>Tous les types</option>
              <option>Produit</option>
              <option>Service</option>
            </select>
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 text-sm font-medium">
                <th className="py-3 px-6 text-left">Article</th>
                <th className="py-3 px-6 text-left">SKU & Type</th>
                <th className="py-3 px-6 text-right">Prix HT</th>
                <th className="py-3 px-6 text-center">TVA</th>
                <th className="py-3 px-6 text-right">Prix TTC</th>
                <th className="py-3 px-6 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {products.map((product) => (
                <tr key={product.id} className="hover:bg-slate-50 transition-colors">
                  <td className="py-3 px-6 text-sm">
                    <div className="flex items-center">
                      <div className="w-10 h-10 rounded-lg bg-slate-100 border border-slate-200 flex items-center justify-center mr-3 hidden sm:flex text-slate-500">
                        {product.type === "SERVICE" ? <Tag className="w-5 h-5" /> : <Package className="w-5 h-5" />}
                      </div>
                      <div>
                        <p className="font-medium text-slate-900">{product.name}</p>
                        <p className="text-xs text-slate-500 mt-0.5 max-w-[200px] truncate">{product.description}</p>
                      </div>
                    </div>
                  </td>
                  <td className="py-3 px-6 text-sm">
                    <p className="text-slate-900 font-mono text-xs mb-1">{product.sku}</p>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-wider ${product.type === "SERVICE" ? "bg-purple-100 text-purple-700" : "bg-blue-100 text-blue-700"}`}>
                      {product.type}
                    </span>
                  </td>
                  <td className="py-3 px-6 text-sm text-slate-900 font-medium text-right">
                    {product.price.toLocaleString("fr-MA")} <span className="text-xs text-slate-500 font-normal">MAD</span>
                  </td>
                  <td className="py-3 px-6 text-sm text-slate-600 text-center">
                    <span className="bg-slate-100 px-2 py-1 rounded text-xs">{product.vat_rate}%</span>
                  </td>
                  <td className="py-3 px-6 text-sm text-slate-900 font-bold text-right text-blue-900">
                    {(product.price * (1 + product.vat_rate / 100)).toLocaleString("fr-MA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span className="text-xs text-slate-500 font-normal">MAD</span>
                  </td>
                  <td className="py-3 px-6 text-right">
                    <div className="flex justify-end space-x-2">
                      <button 
                        onClick={() => handleOpenModal("edit", product)}
                        className="p-1.5 text-slate-400 hover:text-orange-600 hover:bg-orange-50 rounded transition-colors" 
                        title="Modifier"
                      >
                        <Edit className="w-4 h-4" />
                      </button>
                      <button 
                        onClick={() => handleDelete(product.id)}
                        className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors" 
                        title="Supprimer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                      <button className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded transition-colors lg:hidden" title="Plus d'actions">
                        <MoreVertical className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {isLoading ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center">
                    <div className="flex flex-col items-center justify-center text-slate-500">
                      <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin mb-3"></div>
                      <p>Chargement du catalogue...</p>
                    </div>
                  </td>
                </tr>
              ) : products.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center">
                    <div className="flex flex-col items-center justify-center text-slate-500">
                      <Package className="w-12 h-12 mb-3 text-slate-300" />
                      <p>Votre catalogue est vide.</p>
                      <button onClick={() => handleOpenModal("create")} className="mt-3 text-blue-600 font-medium hover:underline">
                        Créez votre premier article
                      </button>
                    </div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="p-4 border-t border-slate-200 flex justify-between items-center bg-slate-50/50">
          <span className="text-sm text-slate-500">Affichage de {products.length} articles</span>
          <div className="flex space-x-1">
            <button className="px-3 py-1 border border-slate-300 rounded-md text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-50">Précédent</button>
            <button className="px-3 py-1 border border-slate-300 rounded-md text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-50">Suivant</button>
          </div>
        </div>
      </div>

      {/* Slide-over/Popup Form Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4">

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

          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
            <div className="px-6 py-4 border-b border-slate-200 flex justify-between items-center bg-slate-50">
              <h2 className="text-xl font-bold text-slate-800">
                {modalMode === "create" ? "Nouvel Article" : "Modifier l'article"}
              </h2>
              <button type="button" onClick={handleCloseModal} className="text-slate-400 hover:text-slate-600 text-2xl leading-none">&times;</button>
            </div>
            
            <form onSubmit={handleSave} className="overflow-y-auto p-6 space-y-5">
              
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-slate-700 mb-1">Nom / Titre *</label>
                  <input type="text" required className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-600 text-black bg-white"
                    style={{ color: "black" }}
                    value={formData.name || ""}
                    onChange={e => setFormData({...formData, name: e.target.value})}
                  />
                </div>

                <div className="col-span-2">
                  <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
                  <textarea 
                    rows={2}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none text-black bg-white"
                    style={{ color: "black" }}
                    value={formData.description || ""}
                    onChange={e => setFormData({...formData, description: e.target.value})}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Type *</label>
                  <select required className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white placeholder-gray-600 text-black"
                    style={{ color: "black" }}
                    value={formData.type || "PRODUCT"}
                    onChange={e => setFormData({...formData, type: e.target.value as "PRODUCT" | "SERVICE"})}
                  >
                    <option value="PRODUCT">Produit (Matériel)</option>
                    <option value="SERVICE">Service (Prestation)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Réf / SKU *</label>
                  <input type="text" required className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm uppercase placeholder-gray-600 text-black bg-white"
                    style={{ color: "black" }}
                    value={formData.sku || ""}
                    onChange={e => setFormData({...formData, sku: e.target.value})}
                  />
                </div>
              </div>

              <div className="p-4 bg-slate-50 border border-slate-100 rounded-lg space-y-4">
                <h3 className="text-sm text-slate-800 mb-2">Tarification</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Prix Unitaire HT *</label>
                    <div className="relative">
                      <input type="number" required min="0" step="0.01" className="w-full pl-3 pr-12 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-600 text-black bg-white"
                        style={{ color: "black" }}
                        value={formData.price || ""}
                        onChange={e => setFormData({...formData, price: parseFloat(e.target.value)})}
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">MAD</span>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Taux de TVA *</label>
                    <select required className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white placeholder-gray-600 text-black"
                      style={{ color: "black" }}
                      value={formData.vat_rate || 20}
                      onChange={e => setFormData({...formData, vat_rate: parseInt(e.target.value)})}
                    >
                      {vatRates.map(rate => (
                        <option key={rate} value={rate}>{rate}%</option>
                      ))}
                    </select>
                  </div>

                  <div className="col-span-2 pt-2 border-t border-slate-200 mt-2">
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-slate-600">Prix total estimé (TTC) :</span>
                      <span className="font-bold text-lg text-blue-800">
                        {formData.price && formData.vat_rate 
                          ? (formData.price * (1 + formData.vat_rate / 100)).toLocaleString("fr-MA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) 
                          : "0,00"} MAD
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex justify-end space-x-3 pt-2">
                <button 
                  type="button" 
                  onClick={handleCloseModal}
                  className="px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
                >
                  Annuler
                </button>
                <button 
                  type="submit"
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
                >
                  Enregistrer l'article
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
}
