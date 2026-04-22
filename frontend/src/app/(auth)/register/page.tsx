"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Calculator, ArrowRight, CheckCircle2, AlertCircle } from "lucide-react";
import Link from "next/link";
import { apiFetch } from "../../../lib/api";

export default function RegisterPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [dossierRole, setDossierRole] = useState("CABINET");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (password !== confirmPassword) {
      setError("Les mots de passe ne correspondent pas.");
      return;
    }
    if (password.length < 8) {
      setError("Le mot de passe doit contenir au moins 8 caracteres.");
      return;
    }
    setIsLoading(true);
    try {
      await apiFetch("/auth/register", {
        method: "POST",
        body: { email, password, company_name: companyName },
        requireAuth: false,
      });
      router.push("/login");
    } catch (err: any) {
      setError(err.message || "Echec de l'inscription.");
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen grid grid-cols-1 md:grid-cols-2">
      <div className="flex flex-col justify-center items-center p-8 bg-white">
        <div className="w-full max-w-md space-y-8">
          <div className="text-center">
            <div className="flex justify-center flex-row items-center space-x-2">
              <Calculator className="h-8 w-8 text-blue-600" />
              <span className="text-2xl font-bold tracking-wide text-slate-900">
                Compta<span className="text-blue-600">SaaS</span>
              </span>
            </div>
            <h2 className="mt-8 text-3xl font-bold tracking-tight text-slate-900">Creer un compte</h2>
            <p className="mt-2 text-sm text-slate-500">Commencez gratuitement</p>
          </div>
          <form className="mt-8 space-y-6" onSubmit={handleRegister}>
            {error && (
              <div className="p-3 bg-red-50 text-red-600 border border-red-200 rounded-lg flex items-start text-sm">
                <AlertCircle className="w-5 h-5 mr-2 shrink-0" />
                <span>{error}</span>
              </div>
            )}
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
                <input type="email" required
                  className="block w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 sm:text-sm text-slate-500"
                  placeholder="admin@entreprise.ma"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Nom de l'entreprise</label>
                <input type="text" required
                  className="block w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 sm:text-sm text-slate-500"
                  placeholder="Mon Entreprise SARL"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                />
              </div>
              <div>
  <label className="block text-sm font-medium text-slate-700 mb-1">Votre rôle</label>
  <div className="grid grid-cols-2 gap-3">
    <button
      type="button"
      onClick={() => setDossierRole("CABINET")}
      className={`p-3 rounded-lg border-2 text-sm font-medium transition-all ${
        dossierRole === "CABINET"
          ? "border-blue-500 bg-blue-50 text-blue-700"
          : "border-slate-200 text-slate-500 hover:border-slate-300"
      }`}
    >
      🏢 Expert Comptable
      <p className="text-xs font-normal mt-1 opacity-70">Gère plusieurs dossiers clients</p>
    </button>
    <button
      type="button"
      onClick={() => setDossierRole("CE")}
      className={`p-3 rounded-lg border-2 text-sm font-medium transition-all ${
        dossierRole === "CE"
          ? "border-purple-500 bg-purple-50 text-purple-700"
          : "border-slate-200 text-slate-500 hover:border-slate-300"
      }`}
    >
      👔 Chef d'Entreprise
      <p className="text-xs font-normal mt-1 opacity-70">Gère mon entreprise</p>
    </button>
  </div>
</div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Mot de passe</label>
                <input type="password" required
                  className="block w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 sm:text-sm text-slate-500"
                  placeholder="8 caracteres minimum"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Confirmer le mot de passe</label>
                <input type="password" required
                  className="block w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 sm:text-sm text-slate-500"
                  placeholder="••••••••"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
              </div>
            </div>
            <button type="submit" disabled={isLoading}
              className="flex w-full justify-center rounded-lg bg-blue-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 transition-all disabled:opacity-70"
            >
              {isLoading ? (
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
              ) : (
                <>Creer mon compte <ArrowRight className="ml-2 h-4 w-4" /></>
              )}
            </button>
            <p className="text-center text-sm text-slate-500">
              Deja un compte ?{" "}
              <Link href="/login" className="font-semibold text-blue-600 hover:text-blue-500">Se connecter</Link>
            </p>
          </form>
        </div>
      </div>
      <div className="hidden md:flex flex-col justify-center bg-slate-900 px-12 py-12 relative overflow-hidden">
        <div className="absolute top-0 right-0 -mr-20 -mt-20 w-96 h-96 rounded-full bg-blue-600/20 blur-3xl"></div>
        <div className="absolute bottom-0 left-0 -ml-20 -mb-20 w-80 h-80 rounded-full bg-indigo-600/20 blur-3xl"></div>
        <div className="relative z-10 text-white space-y-8">
          <h2 className="text-4xl font-bold tracking-tight">
            La comptabilite marocaine,<br/>
            <span className="text-blue-400">simplifiee et automatisee.</span>
          </h2>
          <div className="space-y-4 pt-4">
            <div className="flex items-center space-x-3 text-slate-200">
              <CheckCircle2 className="h-5 w-5 text-blue-400" />
              <span>Factures conformes ICE, IF, RC</span>
            </div>
            <div className="flex items-center space-x-3 text-slate-200">
              <CheckCircle2 className="h-5 w-5 text-blue-400" />
              <span>Multi-taux TVA (20%, 14%, 10%, 7%)</span>
            </div>
            <div className="flex items-center space-x-3 text-slate-200">
              <CheckCircle2 className="h-5 w-5 text-blue-400" />
              <span>Generation de PDF professionnels</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
