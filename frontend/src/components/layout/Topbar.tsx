// frontend/src/components/layout/Topbar.tsx — VERSION CORRIGÉE
// L'étiquette du dossier actif se met à jour automatiquement lors du switch

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Briefcase, ChevronDown, LogOut, ArrowLeftRight } from "lucide-react";
import { getActiveDossierName, getActiveDossierRole, clearActiveDossierId } from "../../lib/dossier";

const DOSSIER_CHANGE_EVENT = "dossier-changed";

export default function Topbar() {
  const router = useRouter();
  const [dossierName, setDossierName] = useState("");
  const [dossierRole, setDossierRole] = useState("");

  // ← FIX : lire depuis localStorage ET écouter les changements
  const refresh = () => {
    setDossierName(getActiveDossierName());
    setDossierRole(getActiveDossierRole());
  };

  useEffect(() => {
    refresh();
    window.addEventListener(DOSSIER_CHANGE_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(DOSSIER_CHANGE_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  const handleSwitchDossier = () => {
    // Ne pas effacer le dossier, juste naviguer vers la liste
    router.push("/dashboard/dossiers");
  };

  const roleColor: Record<string, string> = {
    CABINET: "bg-blue-100 text-blue-700",
    CE: "bg-purple-100 text-purple-700",
    COLLABORATEUR_CABINET: "bg-slate-100 text-slate-600",
    ASSISTANT_CABINET: "bg-slate-100 text-slate-500",
    COLLABORATEUR_CE: "bg-green-100 text-green-700",
  };

  return (
    <div className="h-14 bg-white border-b border-slate-200 flex items-center justify-between px-6">
      {/* Dossier actif — mis à jour dynamiquement */}
      <div className="flex items-center gap-3">
        <Briefcase className="w-4 h-4 text-blue-500" />
        <div>
          <p className="text-sm font-semibold text-slate-800 leading-none">
            {dossierName || "Aucun dossier sélectionné"}
          </p>
          {dossierRole && (
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${roleColor[dossierRole] || "bg-slate-100 text-slate-600"}`}>
              {dossierRole}
            </span>
          )}
        </div>
        <button
          onClick={handleSwitchDossier}
          className="ml-2 flex items-center gap-1 text-xs text-slate-400 hover:text-blue-600 transition-colors"
          title="Changer de dossier"
        >
          <ArrowLeftRight className="w-3.5 h-3.5" />
          <span>Changer</span>
        </button>
      </div>

      {/* Bouton retour dossiers */}
      <button
        onClick={handleSwitchDossier}
        className="text-sm text-slate-500 hover:text-blue-600 transition-colors flex items-center gap-1"
      >
        Tous les dossiers <ChevronDown className="w-3.5 h-3.5 rotate-90" />
      </button>
    </div>
  );
}
