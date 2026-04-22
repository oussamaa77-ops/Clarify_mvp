"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Briefcase, Plus, Archive, Users, ArrowRight,
  Calculator, LogOut, Copy, Check
} from "lucide-react";
import { apiFetch } from "../../../lib/api";
import { setActiveDossierId } from "../../../lib/dossier";
import { removeToken } from "../../../lib/auth";

type Dossier = {
  id: number;
  name: string;
  ice?: string;
  my_role: string; // rôle de l'utilisateur DANS ce dossier
  is_archived: boolean;
  member_count?: number;
  fiscal_year_start_month?: number;
  can_validate_journal?: boolean;
};

type Me = {
  id: number;
  email: string;
  full_name?: string;
};

export default function DossiersPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [dossiers, setDossiers] = useState<Dossier[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newIce, setNewIce] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [inviteTokens, setInviteTokens] = useState<Record<number, string>>({});
  const [copied, setCopied] = useState<number | null>(null);
  const [showInvite, setShowInvite] = useState<number | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("CE");

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const user = await apiFetch("/auth/me");
      setMe(user);
      const data = await apiFetch("/dossiers");
      setDossiers(data);
    } catch {
      router.push("/login");
    } finally {
      setIsLoading(false);
    }
  };

  // ← FIX PRINCIPAL : setActiveDossierId envoie l'événement,
  //   la Topbar et tous les composants se mettent à jour automatiquement
  const handleOpenDossier = (dossier: Dossier) => {
    setActiveDossierId(dossier.id, dossier.name, dossier.my_role);
    router.push("/dashboard");
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setIsCreating(true);
    try {
      const created = await apiFetch("/dossiers", {
        method: "POST",
        body: { name: newName, ice: newIce || undefined, fiscal_year_start_month: 1 },
      });
      setDossiers([...dossiers, created]);
      setShowCreate(false);
      setNewName(""); setNewIce("");
    } catch (e: any) {
      alert(e.message);
    } finally {
      setIsCreating(false);
    }
  };

  const handleInvite = async (dossierId: number) => {
    if (!inviteEmail.trim()) return;
    try {
      const res = await apiFetch(`/dossiers/${dossierId}/invite`, {
        method: "POST",
        body: {
          email: inviteEmail,
          dossier_role: inviteRole,
          can_validate_journal: false,
          can_view_bank: true,
          can_invite_members: false,
        },
      });
      const baseUrl = typeof window !== "undefined" ? window.location.origin : "";
      const link = `${baseUrl}/dossiers/accept/${res.token}`;
      setInviteTokens({ ...inviteTokens, [dossierId]: link });
      setInviteEmail(""); setShowInvite(null);
    } catch (e: any) {
      alert(e.message);
    }
  };

  const copyLink = (dossierId: number) => {
    navigator.clipboard.writeText(inviteTokens[dossierId]);
    setCopied(dossierId);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleLogout = () => {
    removeToken();
    router.push("/login");
  };

  const roleColor = (role: string) => {
    if (role === "CABINET") return "bg-blue-100 text-blue-700";
    if (role === "CE") return "bg-purple-100 text-purple-700";
    if (role === "COLLABORATEUR_CABINET") return "bg-slate-100 text-slate-600";
    if (role === "ASSISTANT_CABINET") return "bg-slate-100 text-slate-500";
    if (role === "COLLABORATEUR_CE") return "bg-green-100 text-green-700";
    return "bg-slate-100 text-slate-600";
  };

  // ← FIX : vérifier si l'user est CABINET dans AU MOINS UN dossier
  const isCabinetSomewhere = dossiers.some(d => d.my_role === "CABINET");

  if (isLoading) return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="text-center">
        <Calculator className="w-10 h-10 text-blue-600 mx-auto mb-3 animate-pulse" />
        <p className="text-slate-500">Chargement des dossiers...</p>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-white border-b px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-2">
          <Calculator className="h-7 w-7 text-blue-600" />
          <span className="text-xl font-bold text-slate-900">
            Compta<span className="text-blue-600">SaaS</span>
          </span>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <p className="text-sm font-semibold text-slate-700">
              {me?.full_name || me?.email?.split("@")[0]}
            </p>
            {/* ← FIX : pas de me?.dossier_role, on montre le contexte global */}
            <p className="text-xs text-slate-400">{me?.email}</p>
          </div>
          <button onClick={handleLogout} className="p-2 text-slate-400 hover:text-red-500 transition-colors">
            <LogOut className="w-5 h-5" />
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto p-6 space-y-6">
        {/* Titre */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Mes Dossiers</h1>
            <p className="text-slate-500 text-sm mt-1">
              {dossiers.length} dossier{dossiers.length > 1 ? "s" : ""} —
              sélectionnez un dossier pour accéder à sa comptabilité
            </p>
          </div>
          {/* ← FIX : bouton visible si CABINET dans au moins un dossier */}
          {isCabinetSomewhere && (
            <button
              onClick={() => setShowCreate(!showCreate)}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 transition-colors shadow"
            >
              <Plus className="w-4 h-4" /> Nouveau dossier
            </button>
          )}
        </div>

        {/* Formulaire création */}
        {showCreate && (
          <div className="bg-white p-5 rounded-2xl border border-blue-200 shadow-sm space-y-4">
            <h2 className="font-bold text-slate-800">Nouveau dossier client</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-bold text-slate-500 uppercase">Raison sociale *</label>
                <input
                  className="mt-1 w-full p-2.5 border border-slate-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Ex: SARL Exemple"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs font-bold text-slate-500 uppercase">ICE (optionnel)</label>
                <input
                  className="mt-1 w-full p-2.5 border border-slate-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="15 chiffres"
                  value={newIce}
                  onChange={e => setNewIce(e.target.value)}
                />
              </div>
            </div>
            <div className="flex gap-3">
              <button
                onClick={handleCreate}
                disabled={isCreating || !newName.trim()}
                className="px-5 py-2 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 disabled:opacity-50"
              >
                {isCreating ? "Création..." : "Créer le dossier"}
              </button>
              <button
                onClick={() => setShowCreate(false)}
                className="px-5 py-2 bg-slate-100 text-slate-600 rounded-xl font-semibold hover:bg-slate-200"
              >
                Annuler
              </button>
            </div>
          </div>
        )}

        {/* Grille dossiers */}
        {dossiers.length === 0 ? (
          <div className="text-center py-20 text-slate-400">
            <Briefcase className="w-16 h-16 mx-auto mb-4 opacity-30" />
            <p className="text-lg font-medium">Aucun dossier pour le moment</p>
            {isCabinetSomewhere && (
              <p className="text-sm mt-2">Créez votre premier dossier client ci-dessus</p>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {dossiers.map(dossier => (
              <div
                key={dossier.id}
                className={`bg-white rounded-2xl border shadow-sm hover:shadow-md transition-all ${dossier.is_archived ? "opacity-60" : ""}`}
              >
                <div className="p-5">
                  <div className="flex items-start justify-between mb-3">
                    <div className="p-2 bg-blue-50 rounded-xl">
                      {dossier.is_archived
                        ? <Archive className="w-5 h-5 text-slate-400" />
                        : <Briefcase className="w-5 h-5 text-blue-600" />}
                    </div>
                    {/* ← FIX : rôle lu depuis dossier.my_role (correct par dossier) */}
                    <span className={`text-xs font-bold px-2 py-1 rounded-full ${roleColor(dossier.my_role)}`}>
                      {dossier.my_role}
                    </span>
                  </div>
                  <h3 className="font-bold text-slate-800 text-lg leading-tight">{dossier.name}</h3>
                  {dossier.ice && <p className="text-xs text-slate-400 mt-1">ICE: {dossier.ice}</p>}
                  {dossier.member_count != null && (
                    <div className="flex items-center gap-1 mt-2 text-xs text-slate-400">
                      <Users className="w-3.5 h-3.5" />
                      {dossier.member_count} membre{dossier.member_count > 1 ? "s" : ""}
                    </div>
                  )}
                </div>

                <div className="px-5 pb-5 space-y-2">
                  <button
                    onClick={() => handleOpenDossier(dossier)}
                    disabled={dossier.is_archived}
                    className="w-full flex items-center justify-center gap-2 py-2.5 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    Ouvrir le dossier <ArrowRight className="w-4 h-4" />
                  </button>

                  {/* ← FIX : permissions d'invitation lues depuis dossier.my_role */}
                  {dossier.my_role === "CABINET" && (
                    <div className="space-y-2">
                      <button
                        onClick={() => { setShowInvite(dossier.id); setInviteRole("CE"); }}
                        className="w-full flex items-center justify-center gap-2 py-2 bg-purple-50 text-purple-700 rounded-xl text-sm font-medium hover:bg-purple-100 border border-purple-200"
                      >
                        👔 Inviter le CE
                      </button>
                      <button
                        onClick={() => { setShowInvite(dossier.id); setInviteRole("COLLABORATEUR_CABINET"); }}
                        className="w-full flex items-center justify-center gap-2 py-2 bg-slate-100 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-200"
                      >
                        👥 Inviter un collaborateur cabinet
                      </button>
                      <button
                        onClick={() => { setShowInvite(dossier.id); setInviteRole("ASSISTANT_CABINET"); }}
                        className="w-full flex items-center justify-center gap-2 py-2 bg-slate-100 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-200"
                      >
                        📋 Inviter un assistant
                      </button>
                    </div>
                  )}

                  {dossier.my_role === "CE" && (
                    <button
                      onClick={() => { setShowInvite(dossier.id); setInviteRole("COLLABORATEUR_CE"); }}
                      className="w-full flex items-center justify-center gap-2 py-2 bg-slate-100 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-200"
                    >
                      👥 Inviter un collaborateur
                    </button>
                  )}
                </div>

                {/* Formulaire invitation */}
                {showInvite === dossier.id && (
                  <div className="px-5 pb-5 space-y-3 border-t pt-4">
                    <input
                      className="w-full p-2 border border-slate-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-400"
                      placeholder="email@exemple.com"
                      value={inviteEmail}
                      onChange={e => setInviteEmail(e.target.value)}
                    />
                    <div className="p-2 bg-slate-50 rounded-lg text-sm text-slate-600 font-medium">
                      Rôle : <span className="font-bold">{inviteRole}</span>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleInvite(dossier.id)}
                        className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700"
                      >
                        Envoyer l'invitation
                      </button>
                      <button
                        onClick={() => setShowInvite(null)}
                        className="py-2 px-3 bg-slate-100 text-slate-600 rounded-lg text-sm hover:bg-slate-200"
                      >
                        Annuler
                      </button>
                    </div>
                  </div>
                )}

                {/* Lien invitation pour test */}
                {inviteTokens[dossier.id] && (
                  <div className="px-5 pb-5 border-t pt-4">
                    <p className="text-xs text-slate-500 mb-2 font-medium">🔗 Lien d'invitation :</p>
                    <div className="flex gap-2">
                      <input
                        readOnly
                        value={inviteTokens[dossier.id]}
                        className="flex-1 text-xs p-2 bg-slate-50 border border-slate-200 rounded-lg text-slate-600 truncate"
                      />
                      <button
                        onClick={() => copyLink(dossier.id)}
                        className="p-2 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors"
                      >
                        {copied === dossier.id
                          ? <Check className="w-4 h-4 text-green-500" />
                          : <Copy className="w-4 h-4 text-slate-500" />}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}