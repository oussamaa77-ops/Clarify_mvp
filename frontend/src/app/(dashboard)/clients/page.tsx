"use client";

import { useState, useEffect } from "react";
import { Plus, Search, MoreVertical, Edit, Trash2, Eye, Building2, AlertCircle } from "lucide-react";
import { apiFetch } from "../../../lib/api";

type Client = {
  id: number;
  name: string;
  ice: string;
  tax_id: string;
  address: string;
  city: string;
  phone: string;
  email: string;
};

export default function ClientsPage() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<"create" | "edit" | "view">("create");
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [formData, setFormData] = useState<Partial<Client>>({});
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    fetchClients();
  }, []);

  const fetchClients = async (search?: string) => {
    try {
      setIsLoading(true);
      const url = search ? `/clients?search=${encodeURIComponent(search)}` : "/clients";
      const data = await apiFetch(url);
      setClients(data || []);
      setError("");
    } catch (err: any) {
      setError("Erreur lors du chargement des clients. " + err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleOpenModal = (mode: "create" | "edit" | "view", client?: Client) => {
    setModalMode(mode);
    setSelectedClient(client || null);
    setFormData(client ? { ...client } : {});
    setIsModalOpen(true);
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setSelectedClient(null);
    setFormData({});
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (modalMode === "create") {
        await apiFetch("/clients", {
          method: "POST",
          body: formData,
        });
      } else if (modalMode === "edit" && selectedClient) {
        await apiFetch(`/clients/${selectedClient.id}`, {
          method: "PUT",
          body: formData,
        });
      }
      fetchClients();
      handleCloseModal();
    } catch (err: any) {
      alert("Erreur: " + err.message);
    }
  };

  const handleDelete = async (id: number) => {
    if (confirm("Êtes-vous sûr de vouloir supprimer ce client ?")) {
      try {
        await apiFetch(`/clients/${id}`, { method: "DELETE" });
        fetchClients();
      } catch (err: any) {
        alert("Erreur lors de la suppression: " + err.message);
      }
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Clients</h1>
          <p className="text-sm text-slate-500 mt-1">Gérez votre portefeuille clients et leurs coordonnées.</p>
        </div>
        <button 
          onClick={() => handleOpenModal("create")}
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center"
        >
          <Plus className="w-4 h-4 mr-2" />
          Ajouter un client
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
        <div className="p-4 border-b border-slate-200 flex justify-between items-center bg-slate-50/50">
          <div className="flex space-x-2">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400" />
              <input type="text" placeholder="Rechercher un client (Nom, ICE, Email)..." className="pl-9 pr-3 py-1.5 border border-slate-300 rounded-lg text-sm w-72 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-slate-500 text-slate-900"
                value={searchQuery}
                onChange={e => { setSearchQuery(e.target.value); fetchClients(e.target.value); }}
              />
            </div>
          </div>
          <select className="px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white placeholder-slate-500 text-slate-900">
            <option>Trier par : Plus récent</option>
            <option>Nom (A-Z)</option>
            <option>Ville</option>
          </select>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 text-sm font-medium">
                <th className="py-3 px-6 text-left">Entreprise</th>
                <th className="py-3 px-6 text-left">ICE / IF</th>
                <th className="py-3 px-6 text-left">Coordonnées</th>
                <th className="py-3 px-6 text-left">Ville</th>
                <th className="py-3 px-6 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {clients.map((client) => (
                <tr key={client.id} className="hover:bg-slate-50 transition-colors">
                  <td className="py-3 px-6 text-sm font-medium text-slate-900">
                    <div className="flex items-center">
                      <div className="w-8 h-8 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center mr-3 hidden sm:flex">
                        <Building2 className="w-4 h-4" />
                      </div>
                      {client.name}
                    </div>
                  </td>
                  <td className="py-3 px-6 text-sm">
                    <p className="text-slate-800 font-medium">ICE: <span className="text-slate-500 font-normal">{client.ice}</span></p>
                    <p className="text-slate-800 font-medium text-xs mt-0.5">IF/Tax ID: <span className="text-slate-500 font-normal">{client.tax_id}</span></p>
                  </td>
                  <td className="py-3 px-6 text-sm text-slate-600">
                    <p>{client.email}</p>
                    <p className="text-xs text-slate-400 mt-0.5">{client.phone}</p>
                  </td>
                  <td className="py-3 px-6 text-sm text-slate-600">{client.city}</td>
                  <td className="py-3 px-6 text-right">
                    <div className="flex justify-end space-x-1">
                      <button 
                        onClick={() => handleOpenModal("view", client)}
                        className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors" 
                        title="Voir les détails"
                      >
                        <Eye className="w-4 h-4" />
                      </button>
                      <button 
                        onClick={() => handleOpenModal("edit", client)}
                        className="p-1.5 text-slate-400 hover:text-orange-600 hover:bg-orange-50 rounded transition-colors" 
                        title="Modifier"
                      >
                        <Edit className="w-4 h-4" />
                      </button>
                      <button 
                        onClick={() => handleDelete(client.id)}
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
                  <td colSpan={5} className="py-8 text-center text-slate-500">
                    <div className="flex justify-center items-center">
                      <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin mr-3"></div>
                      Chargement des clients...
                    </div>
                  </td>
                </tr>
              ) : clients.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-slate-500">
                    Aucun client trouvé. Ajoutez votre premier client !
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="p-4 border-t border-slate-200 flex justify-between items-center bg-slate-50/50">
          <span className="text-sm text-slate-500">Affichage de {clients.length} clients</span>
          <div className="flex space-x-1">
            <button className="px-3 py-1 border border-slate-300 rounded-md text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-50">Précédent</button>
            <button className="px-3 py-1 border border-slate-300 rounded-md text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-50">Suivant</button>
          </div>
        </div>
      </div>

      {/* Modal / Slide-over alternative (simplistic popup for MVP) */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-auto bg-slate-900/50 backdrop-blur-sm p-4">

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

          <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-full">
            <div className="px-6 py-4 border-b border-slate-200 flex justify-between items-center bg-slate-50">
              <h2 className="text-xl font-bold text-slate-800">
                {modalMode === "create" ? "Ajouter un client" : modalMode === "edit" ? "Modifier le client" : "Détails du client"}
              </h2>
              <button onClick={handleCloseModal} className="text-slate-400 hover:text-slate-600 text-2xl leading-none">&times;</button>
            </div>
            
            <form onSubmit={handleSave} className="overflow-y-auto p-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="col-span-1 md:col-span-2">
                  <label className="block text-sm font-medium text-slate-700 mb-1">Nom / Raison Sociale *</label>
                  <input 
                    type="text" 
                    required 
                    readOnly={modalMode === "view"}
                    className={`w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-black placeholder-gray-600 ${modalMode === "view" ? "bg-slate-50" : "bg-white"}`}
                    style={{ color: "black" }}
                    value={formData.name || ""}
                    onChange={e => setFormData({...formData, name: e.target.value})}
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">ICE (15 chiffres) *</label>
                  <input 
                    type="text" 
                    required 
                    readOnly={modalMode === "view"}
                    minLength={15}
                    maxLength={15}
                    className={`w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-black placeholder-gray-600 ${modalMode === "view" ? "bg-slate-50" : "bg-white"}`}
                    style={{ color: "black" }}
                    value={formData.ice || ""}
                    onChange={e => setFormData({...formData, ice: e.target.value})}
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Identifiant Fiscal (IF) *</label>
                  <input 
                    type="text" 
                    required 
                    readOnly={modalMode === "view"}
                    className={`w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-black placeholder-gray-600 ${modalMode === "view" ? "bg-slate-50" : "bg-white"}`}
                    style={{ color: "black" }}
                    value={formData.tax_id || ""}
                    onChange={e => setFormData({...formData, tax_id: e.target.value})}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
                  <input 
                    type="email" 
                    readOnly={modalMode === "view"}
                    className={`w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-black placeholder-gray-600 ${modalMode === "view" ? "bg-slate-50" : "bg-white"}`}
                    style={{ color: "black" }}
                    value={formData.email || ""}
                    onChange={e => setFormData({...formData, email: e.target.value})}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Téléphone</label>
                  <input 
                    type="tel" 
                    readOnly={modalMode === "view"}
                    className={`w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-black placeholder-gray-600 ${modalMode === "view" ? "bg-slate-50" : "bg-white"}`}
                    style={{ color: "black" }}
                    value={formData.phone || ""}
                    onChange={e => setFormData({...formData, phone: e.target.value})}
                  />
                </div>

                <div className="col-span-1 md:col-span-2">
                  <label className="block text-sm font-medium text-slate-700 mb-1">Adresse</label>
                  <input 
                    type="text" 
                    readOnly={modalMode === "view"}
                    className={`w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-black placeholder-gray-600 ${modalMode === "view" ? "bg-slate-50" : "bg-white"}`}
                    style={{ color: "black" }}
                    value={formData.address || ""}
                    onChange={e => setFormData({...formData, address: e.target.value})}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Ville</label>
                  <input
                    type="text"
                    readOnly={modalMode === "view"}
                    className={`w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-black ${modalMode === "view" ? "bg-slate-50" : "bg-white"}`}
                    value={formData.city || ""}
                    onChange={e => setFormData({...formData, city: e.target.value})}
                  />
                </div>


              </div>

              <div className="mt-8 flex justify-end space-x-3 pt-4 border-t border-slate-200">
                <button 
                  type="button" 
                  onClick={handleCloseModal}
                  className="px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
                >
                  {modalMode === "view" ? "Fermer" : "Annuler"}
                </button>
                {modalMode !== "view" && (
                  <button 
                    type="submit"
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
                  >
                    Enregistrer
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
}
