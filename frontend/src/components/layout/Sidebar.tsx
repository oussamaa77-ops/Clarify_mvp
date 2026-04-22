"use client";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import {
  Home, Users, Package, FileText, CreditCard, Settings,
  BarChart2, Calculator, LogOut, FolderOpen, ShoppingCart,
  Bot, Bell, Scan, Archive, Briefcase, ChevronRight,
} from "lucide-react";
import { removeToken, getToken } from "../../lib/auth";
import { clearActiveDossierId, getActiveDossierName, getActiveDossierRole } from "../../lib/dossier";
import { useEffect, useState } from "react";

export default function Sidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const [dossierName, setDossierName] = useState("");
  const [dossierRole, setDossierRole] = useState("");

  useEffect(() => {
    setDossierName(getActiveDossierName());
    setDossierRole(getActiveDossierRole());
  }, []);

  const handleLogout = () => {
    removeToken();
    clearActiveDossierId();
    router.push("/login");
  };

  const roleColor = (role: string) => {
    if (role === "CABINET") return "bg-blue-500";
    if (role === "CE") return "bg-purple-500";
    if (role === "COLLABORATEUR_CABINET") return "bg-indigo-500";
    if (role === "ASSISTANT_CABINET") return "bg-cyan-500";
    return "bg-slate-500";
  };

  const routes = [
    { name: "Tableau de bord", icon: Home,        path: "/dashboard" },
    { name: "Clients",         icon: Users,        path: "/clients" },
    { name: "Produits",        icon: Package,      path: "/products" },
    { name: "Devis",           icon: FileText,     path: "/quotes" },
    { name: "Factures",        icon: FileText,     path: "/invoices" },
    { name: "Paiements",       icon: CreditCard,   path: "/payments" },
    { name: "Achats",          icon: ShoppingCart, path: "/expenses" },
    { name: "Comptabilité",    icon: Calculator,   path: "/accounting" },
    { name: "Fiscalité",       icon: BarChart2,    path: "/taxes" },
    { name: "Rapports",        icon: BarChart2,    path: "/reports" },
    { name: "OCR Factures",    icon: Scan,         path: "/ocr" },
    { name: "GED Documents",   icon: Archive,      path: "/ged" },
    { name: "Alertes Fiscales",icon: Bell,         path: "/alertes" },
    { name: "Assistant IA",    icon: Bot,          path: "/assistant" },
    { name: "Documents",       icon: FolderOpen,   path: "/documents" },
    { name: "Paramètres",      icon: Settings,     path: "/settings" },
  ];

  return (
    <div className="w-64 bg-slate-900 border-r h-screen text-slate-300 flex flex-col">
      {/* Logo */}
      <div className="p-5 border-b border-slate-800">
        <h1 className="text-xl font-bold text-white flex items-center gap-2">
          <Calculator className="h-6 w-6 text-blue-500" />
          <span>Compta<span className="text-blue-500">SaaS</span></span>
        </h1>
      </div>

      {/* Dossier actif */}
      <div className="px-4 py-3 border-b border-slate-800">
        {dossierName ? (
          <button
            onClick={() => router.push("/dossiers")}
            className="w-full flex items-center gap-2 p-2 rounded-lg bg-slate-800 hover:bg-slate-700 transition-colors text-left"
          >
            <Briefcase className="h-4 w-4 text-blue-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs text-slate-400">Dossier actif</p>
              <p className="text-sm font-semibold text-white truncate">{dossierName}</p>
            </div>
            {dossierRole && (
              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded text-white ${roleColor(dossierRole)}`}>
                {dossierRole === "CABINET" ? "CAB" :
                 dossierRole === "CE" ? "CE" :
                 dossierRole === "COLLABORATEUR_CABINET" ? "COL" : "ASS"}
              </span>
            )}
          </button>
        ) : (
          <button
            onClick={() => router.push("/dossiers")}
            className="w-full flex items-center gap-2 p-2 rounded-lg border border-dashed border-slate-700 hover:border-blue-500 transition-colors text-slate-400 hover:text-blue-400"
          >
            <Briefcase className="h-4 w-4" />
            <span className="text-xs">Sélectionner un dossier</span>
            <ChevronRight className="h-3 w-3 ml-auto" />
          </button>
        )}
      </div>

      {/* Navigation */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden py-3">
        <ul className="space-y-0.5 px-3">
          {routes.map((route, idx) => {
            const isActive = pathname === route.path;
            return (
              <li key={idx}>
                <Link href={route.path}>
                  <div className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-colors cursor-pointer group ${
                    isActive
                      ? "bg-blue-600 text-white"
                      : "hover:bg-slate-800 hover:text-white text-slate-400"
                  }`}>
                    <route.icon className={`h-4 w-4 shrink-0 ${isActive ? "text-white" : "text-slate-400 group-hover:text-blue-400"}`} />
                    <span className="font-medium text-sm">{route.name}</span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Séparateur Dossiers */}
      <div className="px-3 pb-2">
        <Link href="/dossiers">
          <div className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-colors cursor-pointer group ${
            pathname === "/dossiers"
              ? "bg-blue-600 text-white"
              : "hover:bg-slate-800 hover:text-white text-slate-400"
          }`}>
            <Briefcase className={`h-4 w-4 shrink-0 ${pathname === "/dossiers" ? "text-white" : "text-slate-400 group-hover:text-blue-400"}`} />
            <span className="font-medium text-sm">Mes Dossiers</span>
          </div>
        </Link>
      </div>

      {/* Logout */}
      <div className="p-3 border-t border-slate-800">
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-slate-400 hover:bg-red-900/30 hover:text-red-400 transition-colors"
        >
          <LogOut className="h-4 w-4" />
          <span className="text-sm font-medium">Déconnexion</span>
        </button>
      </div>
    </div>
  );
}
