"use client";

import { useState, useEffect } from "react";
import { useRouter, useParams } from "next/navigation";
import { Calculator, CheckCircle, AlertCircle, Loader2 } from "lucide-react";
import { apiFetch } from "../../../../../lib/api";
import { getToken } from "../../../../../lib/auth";

export default function AcceptInvitationPage() {
  const router = useRouter();
  const params = useParams();
  const token = params?.token as string;

  const [status, setStatus] = useState<"loading" | "form" | "success" | "error">("loading");
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const t = getToken();
    if (t) {
      acceptDirectly();
    } else {
      setStatus("form");
    }
  }, []);

  const acceptDirectly = async () => {
    setStatus("loading");
    try {
      await apiFetch(`/dossiers/accept/${token}`, { method: "POST", body: {} });
      setStatus("success");
      setTimeout(() => router.push("/dossiers"), 2000);
    } catch (e: any) {
      setError(e.message);
      setStatus("error");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      await apiFetch(`/dossiers/accept/${token}`, {
        method: "POST",
        requireAuth: false,
        body: { password: password || undefined, full_name: fullName || undefined },
      });
      setStatus("success");
      setTimeout(() => router.push("/login"), 2500);
    } catch (e: any) {
      setError(e.message);
      setStatus("error");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-lg p-8 w-full max-w-md space-y-6">
        <div className="text-center">
          <div className="flex justify-center items-center gap-2 mb-2">
            <Calculator className="h-7 w-7 text-blue-600" />
            <span className="text-xl font-bold text-slate-900">Compta<span className="text-blue-600">SaaS</span></span>
          </div>
          <h1 className="text-2xl font-bold text-slate-800 mt-4">Invitation au dossier</h1>
        </div>

        {status === "loading" && (
          <div className="text-center py-8">
            <Loader2 className="w-10 h-10 text-blue-600 mx-auto animate-spin mb-3" />
            <p className="text-slate-500">Vérification de l'invitation...</p>
          </div>
        )}

        {status === "success" && (
          <div className="text-center py-8">
            <CheckCircle className="w-16 h-16 text-emerald-500 mx-auto mb-4" />
            <h2 className="text-xl font-bold text-slate-800 mb-2">Invitation acceptée !</h2>
            <p className="text-slate-500">Redirection en cours...</p>
          </div>
        )}

        {status === "error" && (
          <div className="text-center py-8">
            <AlertCircle className="w-16 h-16 text-rose-500 mx-auto mb-4" />
            <h2 className="text-xl font-bold text-slate-800 mb-2">Invitation invalide</h2>
            <p className="text-rose-600 text-sm">{error}</p>
            <button onClick={() => router.push("/login")}
              className="mt-4 px-6 py-2 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700">
              Retour à la connexion
            </button>
          </div>
        )}

        {status === "form" && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <p className="text-slate-600 text-sm text-center">
              Vous avez été invité à rejoindre un dossier comptable.
            </p>
            <div>
              <label className="text-xs font-bold text-slate-500 uppercase">Nom complet (optionnel)</label>
              <input
                className="mt-1 w-full p-3 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Votre nom"
                value={fullName}
                onChange={e => setFullName(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs font-bold text-slate-500 uppercase">
                Mot de passe <span className="text-slate-400">(si nouveau compte)</span>
              </label>
              <input
                type="password"
                className="mt-1 w-full p-3 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Laissez vide si vous avez déjà un compte"
                value={password}
                onChange={e => setPassword(e.target.value)}
              />
            </div>
            {error && (
              <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-700 text-sm">{error}</div>
            )}
            <button type="submit" disabled={isSubmitting}
              className="w-full py-3 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 disabled:opacity-50">
              {isSubmitting
                ? <span className="flex items-center justify-center gap-2"><Loader2 className="animate-spin w-4 h-4" />Traitement...</span>
                : "Accepter l'invitation"}
            </button>
            <p className="text-center text-sm text-slate-400">
              Déjà un compte ? <a href="/login" className="text-blue-600 font-medium hover:underline">Se connecter</a>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
