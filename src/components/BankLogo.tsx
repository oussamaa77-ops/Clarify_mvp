// ─── Logo bancaire (conteneur premium) ─────────────────────────────────────────
// Affiche le logo officiel de la banque identifiée dans un conteneur épuré.
// Repli sur une icône neutre si le logo n'est pas disponible (banque non reconnue).
// Partagé par la page Banque (comptes, briques de relevés) et le Dashboard, pour
// que la même banque soit toujours représentée par le même visuel.
import { Landmark } from "lucide-react";
import type { BankIdentity } from "@/lib/bank-identity";

export function BankLogo({ ident, size = "md" }: { ident: BankIdentity; size?: "sm" | "md" | "lg" }) {
  const box = size === "lg" ? "h-11 w-11 p-1.5 rounded-xl"
            : size === "sm" ? "h-7 w-7 p-1 rounded-md"
            : "h-8 w-8 p-1 rounded-lg";
  return (
    <div className={`flex ${box} items-center justify-center bg-white shadow-sm border border-slate-100 shrink-0`}>
      {ident.logo
        ? <img src={ident.logo} alt={ident.nom} className="max-h-full max-w-full object-contain" loading="lazy" />
        : <Landmark className="h-4 w-4 text-slate-400" />}
    </div>
  );
}

export default BankLogo;
