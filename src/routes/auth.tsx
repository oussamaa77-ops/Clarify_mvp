// ============================================================================
// /auth — connexion et inscription.
//
// PARCOURS D'INSCRIPTION (en 2 étapes) :
//   1. l'utilisateur saisit ses informations (rien n'est encore créé) ;
//   2. il choisit un des 3 plans → SEULEMENT LÀ le compte est créé, avec le code
//      du plan rangé dans ses métadonnées ;
//   3. il est renvoyé sur l'onglet Connexion. À sa première connexion,
//      activerPlanChoisi() consomme ce code et active l'abonnement.
//
// Pourquoi ce détour : à l'inscription il n'y a ni session ni cabinet (le
// cabinet naît avec le profil) — impossible d'activer un plan à cet instant.
// ============================================================================
import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { listPlans, activerPlanChoisi } from "@/server/billing.functions";
import { logAudit } from "@/lib/audit";
import { PlansTarifaires } from "@/components/PlansTarifaires";
import type { Plan } from "@/lib/quota";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/auth")({
  component: AuthPage,
});

type EtapeInscription = "infos" | "plans";

function AuthPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [onglet, setOnglet] = useState("login");

  // Login
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPwd, setLoginPwd] = useState("");

  // Signup
  const [etape, setEtape] = useState<EtapeInscription>("infos");
  const [email, setEmail] = useState("");
  const [pwd, setPwd] = useState("");
  const [nom, setNom] = useState("");
  const [prenom, setPrenom] = useState("");
  const [cabinetNom, setCabinetNom] = useState("");
  const [plans, setPlans] = useState<Plan[]>([]);
  const [planEnCours, setPlanEnCours] = useState<string | null>(null);

  // Redirection des sessions DÉJÀ ouvertes (retour sur /auth alors qu'on est
  // connecté). Surtout PAS pendant une connexion en cours : la session arrive
  // avant qu'on ait activé le plan choisi, et cette redirection couperait
  // l'herbe sous le pied de handleLogin — qui navigue lui-même, une fois fini.
  useEffect(() => {
    if (!loading && user && !submitting) navigate({ to: "/dossiers" });
  }, [user, loading, submitting, navigate]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    const { error } = await supabase.auth.signInWithPassword({ email: loginEmail, password: loginPwd });
    if (error) {
      setSubmitting(false);
      toast.error(error.message);
      return;
    }

    // Tracé d'audit : connexion réussie.
    logAudit({ action: "connexion" });

    // Active le plan choisi à l'inscription (sans effet s'il n'y en a pas).
    // Best-effort : un abonnement non activé ne doit pas empêcher de se connecter,
    // l'utilisateur reste sur l'essai Starter et peut choisir son plan dans /abonnement.
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (token) {
      try {
        const res = await activerPlanChoisi({ data: { access_token: token } });
        if (res.applique) toast.success(`Abonnement ${res.plan_code} activé.`);
      } catch (err: any) {
        console.warn("[auth] plan non activé:", err?.message ?? err);
      }
    }

    setSubmitting(false);
    toast.success("Connecté !");
    navigate({ to: "/dossiers" });
  };

  // Étape 1 → 2 : on ne crée RIEN, on charge juste le catalogue.
  const allerAuxPlans = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await listPlans();
      setPlans(res.plans as Plan[]);
      setEtape("plans");
    } catch (err: any) {
      toast.error(err?.message ?? "Offres indisponibles");
    } finally {
      setSubmitting(false);
    }
  };

  // Étape 2 : le plan choisi déclenche la création du compte.
  const choisirPlanEtCreerCompte = async (planCode: string) => {
    setPlanEnCours(planCode);
    const { error } = await supabase.auth.signUp({
      email, password: pwd,
      options: {
        emailRedirectTo: `${window.location.origin}/auth`,
        data: { nom, prenom, cabinet_nom: cabinetNom || "Mon Cabinet", plan_code: planCode },
      },
    });
    setPlanEnCours(null);

    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Compte créé ! Confirmez votre email, puis connectez-vous : votre plan sera activé.");
    setEtape("infos");
    setLoginEmail(email);
    setPwd("");
    setOnglet("login");
  };

  const largeur = onglet === "signup" && etape === "plans" ? "max-w-5xl" : "max-w-md";

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-background to-muted px-4 py-10">
      <Card className={`w-full ${largeur} transition-all`}>
        <CardHeader className="text-center">
          <Link to="/" className="mx-auto mb-4 flex items-center gap-2 w-fit">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold">H</div>
            <span className="text-xl font-bold">HisabPro</span>
          </Link>
          <CardTitle>Bienvenue</CardTitle>
          <CardDescription>Connectez-vous ou créez votre cabinet</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs value={onglet} onValueChange={setOnglet}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="login">Connexion</TabsTrigger>
              <TabsTrigger value="signup">Inscription</TabsTrigger>
            </TabsList>

            <TabsContent value="login">
              <form onSubmit={handleLogin} className="space-y-4 mt-4">
                <div className="space-y-2">
                  <Label>Email</Label>
                  <Input type="email" required value={loginEmail} onChange={e => setLoginEmail(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>Mot de passe</Label>
                  <Input type="password" required value={loginPwd} onChange={e => setLoginPwd(e.target.value)} />
                </div>
                <Button type="submit" className="w-full" disabled={submitting}>
                  {submitting ? "Connexion..." : "Se connecter"}
                </Button>
              </form>
            </TabsContent>

            <TabsContent value="signup">
              {etape === "infos" ? (
                <form onSubmit={allerAuxPlans} className="space-y-3 mt-4">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-2"><Label>Prénom</Label><Input value={prenom} onChange={e => setPrenom(e.target.value)} /></div>
                    <div className="space-y-2"><Label>Nom</Label><Input value={nom} onChange={e => setNom(e.target.value)} /></div>
                  </div>
                  <div className="space-y-2">
                    <Label>Nom du cabinet</Label>
                    <Input value={cabinetNom} onChange={e => setCabinetNom(e.target.value)} placeholder="Mon Cabinet Comptable" />
                  </div>
                  <div className="space-y-2">
                    <Label>Email</Label>
                    <Input type="email" required value={email} onChange={e => setEmail(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label>Mot de passe</Label>
                    <Input type="password" required minLength={6} value={pwd} onChange={e => setPwd(e.target.value)} />
                  </div>
                  <Button type="submit" className="w-full" disabled={submitting}>
                    {submitting ? "Chargement..." : "Continuer — choisir mon offre"}
                  </Button>
                </form>
              ) : (
                <div className="mt-6 space-y-6">
                  <div className="text-center">
                    <h2 className="text-lg font-semibold">Choisissez votre offre</h2>
                    <p className="text-sm text-muted-foreground">
                      Votre compte sera créé avec le plan sélectionné. Le règlement se fait hors application.
                    </p>
                  </div>

                  <PlansTarifaires
                    plans={plans}
                    enCours={planEnCours}
                    onChoisir={choisirPlanEtCreerCompte}
                    libelleCta="Créer mon compte"
                  />

                  <Button variant="ghost" size="sm" onClick={() => setEtape("infos")} disabled={planEnCours !== null}>
                    <ArrowLeft className="h-4 w-4 mr-1.5" /> Modifier mes informations
                  </Button>
                </div>
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
