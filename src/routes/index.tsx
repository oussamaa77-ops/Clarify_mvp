import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { FileText, Sparkles, ShieldCheck, BarChart3 } from "lucide-react";

export const Route = createFileRoute("/")({
  component: Landing,
});

function Landing() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && user) navigate({ to: "/dossiers" });
  }, [user, loading, navigate]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted">
      <header className="border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold">H</div>
            <span className="text-xl font-bold">HisabPro</span>
          </div>
          <Link to="/auth">
            <Button>Connexion</Button>
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-20">
        <div className="text-center">
          <span className="inline-block rounded-full bg-primary/10 px-4 py-1.5 text-sm font-medium text-primary">
            🇲🇦 Conforme DGI 2026 • UBL 2.1
          </span>
          <h1 className="mt-6 text-5xl font-bold tracking-tight md:text-6xl">
            Comptabilité & <span className="text-primary">e-Facture</span><br />pour le Maroc
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">
            Gérez vos dossiers clients, générez vos factures électroniques DGI, automatisez la saisie OCR et tenez votre comptabilité PCM en un seul endroit.
          </p>
          <div className="mt-8 flex justify-center gap-3">
            <Link to="/auth">
              <Button size="lg">Commencer gratuitement</Button>
            </Link>
          </div>
        </div>

        <div className="mt-20 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
          {[
            { icon: FileText, title: "e-Facture DGI", desc: "XML UBL 2.1, scellage SHA-256, envoi AJAL." },
            { icon: Sparkles, title: "OCR intelligent", desc: "Extraction automatique des factures fournisseurs par IA." },
            { icon: ShieldCheck, title: "Audit immuable", desc: "Piste d'audit chaînée SHA-256, conforme DGI." },
            { icon: BarChart3, title: "Dashboard KPIs", desc: "CA, TVA, encours, dettes en temps réel." },
          ].map((f) => (
            <div key={f.title} className="rounded-xl border bg-card p-6 shadow-sm">
              <f.icon className="h-8 w-8 text-primary" />
              <h3 className="mt-4 font-semibold">{f.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{f.desc}</p>
            </div>
          ))}
        </div>
      </main>

      <footer className="border-t py-6 text-center text-sm text-muted-foreground">
        © 2026 HisabPro — MVP démo
      </footer>
    </div>
  );
}
