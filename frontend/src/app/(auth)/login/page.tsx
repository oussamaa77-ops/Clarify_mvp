"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Calculator, ArrowRight, CheckCircle2, AlertCircle } from "lucide-react";
import Link from "next/link";
import { apiFetch } from "../../../lib/api";
import { setToken } from "../../../lib/auth";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError("");
    
    try {
      // Backend expects x-www-form-urlencoded
      const formData = new URLSearchParams();
      formData.append("username", email);
      formData.append("password", password);

      const data = await apiFetch("/auth/login", {
        method: "POST",
        body: formData,
        requireAuth: false
      });

      if (data && data.access_token) {
        setToken(data.access_token);
        router.push("/dossiers");;
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Échec de connexion. Vérifiez vos identifiants.");
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen grid grid-cols-1 md:grid-cols-2">
      {/* Left side - Login Form */}
      <div className="flex flex-col justify-center items-center p-8 bg-white">
        <div className="w-full max-w-md space-y-8">
          <div className="text-center">
            <div className="flex justify-center flex-row items-center space-x-2 cursor-pointer transition-transform hover:scale-105">
              <Calculator className="h-8 w-8 text-blue-600" />
              <span className="text-2xl font-bold font-sans tracking-wide text-slate-900">
                Compta<span className="text-blue-600">SaaS</span>
              </span>
            </div>
            <h2 className="mt-8 text-3xl font-bold tracking-tight text-slate-900">Bienvenue</h2>
            <p className="mt-2 text-sm text-slate-500">Connectez-vous pour gérer votre comptabilité</p>
          </div>

          <form className="mt-8 space-y-6" onSubmit={handleLogin}>
            
            {error && (
              <div className="p-3 bg-red-50 text-red-600 border border-red-200 rounded-lg flex items-start text-sm">
                <AlertCircle className="w-5 h-5 mr-2 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div className="space-y-4 rounded-md shadow-sm">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Email professionnel</label>
                <input type="email" required className="relative block w-full rounded-lg border-slate-300 px-3 py-2 border focus:z-10 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 sm:text-sm transition-colors placeholder-slate-400 placeholder-slate-400 text-slate-500"
                  placeholder="admin@entreprise.ma"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Mot de passe</label>
                <input type="password" required className="relative block w-full rounded-lg border-slate-300 px-3 py-2 border focus:z-10 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 sm:text-sm transition-colors placeholder-slate-400 placeholder-slate-400 text-slate-500"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center">
                <input id="remember-me" name="remember-me" type="checkbox" className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 placeholder-slate-400 placeholder-slate-400 text-slate-500"
                />
                <label htmlFor="remember-me" className="ml-2 block text-sm text-slate-900">
                  Se souvenir de moi
                </label>
              </div>

              <div className="text-sm">
                <a href="#" className="font-medium text-blue-600 hover:text-blue-500">
                  Mot de passe oublié ?
                </a>
              </div>
            </div>

            <div>
              <button
                type="submit"
                disabled={isLoading}
                className="group relative flex w-full justify-center rounded-lg bg-blue-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 transition-all disabled:opacity-70 disabled:cursor-not-allowed"
              >
                {isLoading ? (
                  <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                ) : (
                  <>
                    Se connecter <ArrowRight className="ml-2 h-4 w-4" />
                  </>
                )}
              </button>
            </div>
            
            <p className="text-center text-sm text-slate-500 mt-4">
              Nouveau sur ComptaSaaS? <Link href="/register" className="font-semibold text-blue-600 hover:text-blue-500">Créer un compte</Link>
            </p>
          </form>
        </div>
      </div>

      {/* Right side - Marketing/Info */}
      <div className="hidden md:flex flex-col justify-center bg-slate-900 px-12 lg:px-24 py-12 relative overflow-hidden">
        {/* Abstract shapes */}
        <div className="absolute top-0 right-0 -mr-20 -mt-20 w-96 h-96 rounded-full bg-blue-600/20 blur-3xl"></div>
        <div className="absolute bottom-0 left-0 -ml-20 -mb-20 w-80 h-80 rounded-full bg-indigo-600/20 blur-3xl"></div>
        
        <div className="relative z-10 text-white space-y-8">
          <h2 className="text-4xl font-bold tracking-tight">
            La comptabilité marocaine,<br/>
            <span className="text-blue-400">simplifiée et automatisée.</span>
          </h2>
          <p className="text-lg text-slate-300 max-w-md">
            Générez des factures conformes (ICE, IF, RC), suivez la TVA, et pilotez votre activité avec un tableau de bord en temps réel.
          </p>
          
          <div className="space-y-4 pt-4">
            <div className="flex items-center space-x-3 text-slate-200">
              <CheckCircle2 className="h-5 w-5 text-blue-400" />
              <span>Génération de N° de facture FAC-YYYY-XXXX</span>
            </div>
            <div className="flex items-center space-x-3 text-slate-200">
              <CheckCircle2 className="h-5 w-5 text-blue-400" />
              <span>Gestion multi-taux de TVA (20%, 14%, 10%, 7%)</span>
            </div>
            <div className="flex items-center space-x-3 text-slate-200">
              <CheckCircle2 className="h-5 w-5 text-blue-400" />
              <span>Génération de PDF professionnels</span>
            </div>
            <div className="flex items-center space-x-3 text-slate-200">
              <CheckCircle2 className="h-5 w-5 text-blue-400" />
              <span>Multi-utilisateur avec gestion des rôles</span>
            </div>
          </div>
          
          <div className="mt-12 bg-slate-800/50 border border-slate-700 p-6 rounded-xl backdrop-blur-sm">
            <p className="italic text-slate-300 text-sm">
              "ComptaSaaS a complètement transformé la façon dont nous gérons la facturation de notre agence à Casablanca. C'est moderne, rapide et 100% conforme."
            </p>
            <div className="mt-4 flex items-center space-x-3">
              <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-blue-500 to-indigo-500"></div>
              <div>
                <p className="text-sm font-semibold text-white">Karim B.</p>
                <p className="text-xs text-slate-400">Directeur Général - Digital Atlas</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
