import { createFileRoute, Outlet, Link, useNavigate, useLocation } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import {
  LayoutDashboard, Users, Building2, BookOpen, Landmark,
  FolderArchive, History, LogOut, Briefcase, Receipt, Users2, FileSearch,
  Paperclip, Sparkles, CreditCard,
} from "lucide-react";

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

function AppLayout() {
  const { user, loading, profile, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/auth" });
  }, [user, loading, navigate]);

  // Dernier rideau côté client pour un compte non approuvé. Le vrai refus est
  // ailleurs — bannissement au niveau du serveur d'auth (aucun jeton délivré) et
  // RLS qui ne rend aucune ligne. Mais la session ouverte d'office par signUp
  // reste valide jusqu'à expiration : sans ceci, son porteur atterrirait sur une
  // application vide au lieu d'être renvoyé vers l'écran d'attente.
  // `is_approved` non chargé (profil null/en vol) ne déclenche RIEN : verrouiller
  // sur une lecture manquée éjecterait des comptes légitimes.
  useEffect(() => {
    if (profile?.is_approved === false) {
      signOut().finally(() => navigate({ to: "/auth" }));
    }
  }, [profile, signOut, navigate]);

  if (loading || !user || profile?.is_approved === false) {
    return <div className="flex min-h-screen items-center justify-center text-muted-foreground">Chargement…</div>;
  }

  const match = location.pathname.match(/\/dossiers\/([0-9a-f-]{36})/);
  const dossierId = match?.[1];

  const navItems = dossierId ? [
    { to: "/dossiers/$dossierId/dashboard",     label: "Dashboard",       icon: LayoutDashboard },
    // Les factures clients vivent dans la section Clients (onglet Factures),
    // symétriquement aux factures fournisseurs dans la section Fournisseurs.
    { to: "/dossiers/$dossierId/clients",       label: "Clients",         icon: Users           },
    { to: "/dossiers/$dossierId/fournisseurs",  label: "Fournisseurs",    icon: Building2       },
    { to: "/dossiers/$dossierId/comptabilite",  label: "Comptabilité",    icon: BookOpen        },
    { to: "/dossiers/$dossierId/fiscalite",     label: "Fiscalité",       icon: Receipt         },
    { to: "/dossiers/$dossierId/paie",          label: "Paie & RH",       icon: Users2          },
    { to: "/dossiers/$dossierId/banque",         label: "Banque",          icon: Landmark        },
    { to: "/dossiers/$dossierId/justificatifs", label: "Justificatifs",   icon: Paperclip       },
    { to: "/dossiers/$dossierId/ged",           label: "GED",             icon: FolderArchive   },
    { to: "/dossiers/$dossierId/audit",         label: "Audit",           icon: History         },
    { to: "/dossiers/$dossierId/analytics",     label: "Usage IA",        icon: Sparkles        },
  ] : [];

  return (
    <div className="flex min-h-screen bg-muted/30">
      <aside className="w-64 border-r bg-background flex flex-col">
        <div className="p-4 border-b">
          <Link to="/dossiers" className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold text-sm">H</div>
            <span className="font-bold">HisabPro</span>
          </Link>
        </div>

        <nav className="flex-1 p-3 space-y-1">
          <Link
            to="/dossiers"
            className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium hover:bg-accent"
            activeProps={{ className: "bg-accent" }}
          >
            <Briefcase className="h-4 w-4" /> Mes dossiers
          </Link>

          <Link
            to="/abonnement"
            className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium hover:bg-accent"
            activeProps={{ className: "bg-accent" }}
          >
            <CreditCard className="h-4 w-4" /> Abonnement
          </Link>

          {dossierId && (
            <>
              <div className="mt-4 mb-2 px-3 text-xs font-semibold uppercase text-muted-foreground">Dossier actif</div>
              {navItems.map((item) => {
                const active = location.pathname.includes(item.to.replace("$dossierId", dossierId));
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    params={{ dossierId }}
                    className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-accent ${active ? "bg-accent font-medium" : ""}`}
                  >
                    <item.icon className="h-4 w-4" /> {item.label}
                  </Link>
                );
              })}
            </>
          )}
        </nav>

        <div className="border-t p-3">
          <div className="px-2 pb-2 text-xs text-muted-foreground truncate">
            {profile?.prenom} {profile?.nom}<br />
            <span className="opacity-70">{profile?.email}</span>
          </div>
          <Button
            variant="ghost" size="sm" className="w-full justify-start"
            onClick={() => { signOut(); navigate({ to: "/" }); }}
          >
            <LogOut className="h-4 w-4 mr-2" /> Déconnexion
          </Button>
        </div>
      </aside>

      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}

