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
import { notifierInscriptionEnAttente } from "@/server/approval.functions";
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

  // Retour de /api/approve-user : l'admin vient de cliquer le lien d'approbation
  // et atterrit ici. On le lit une seule fois puis on nettoie l'URL, sinon le
  // message ressurgit à chaque rechargement.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const resultat = params.get("approbation");
    if (!resultat) return;

    if (resultat === "ok") toast.success("Compte approuvé. L'utilisateur peut désormais se connecter.");
    else if (resultat === "invalide") toast.error("Lien d'approbation invalide ou expiré.");
    else if (resultat === "introuvable") toast.error("Compte introuvable : il a peut-être été supprimé.");

    window.history.replaceState({}, "", window.location.pathname);
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    const { data: auth, error } = await supabase.auth.signInWithPassword({ email: loginEmail, password: loginPwd });
    if (error) {
      setSubmitting(false);
      // Un compte en attente d'approbation est banni côté serveur d'auth : le
      // refus arrive donc ici, et Supabase le formule « User is banned », ce qui
      // ne veut rien dire pour l'intéressé. On le traduit.
      const banni = /banned|ban_duration/i.test(error.message);
      toast.error(
        banni
          ? "Compte en attente d'approbation par l'administrateur. Vous recevrez l'accès une fois votre inscription validée."
          : error.message
      );
      return;
    }

    // ── Barrage des comptes non approuvés ────────────────────────────────────
    // ⚠️ Ce contrôle est du CONFORT, pas de la sécurité : à ce stade le JWT est
    // déjà émis et resterait valide même si on n'affichait rien. Le vrai verrou
    // est en base — get_user_cabinet() ne renvoie pas de cabinet à un compte non
    // approuvé, donc la RLS ne lui laisse voir aucune ligne, y compris en
    // appelant l'API directement. Ici on se contente de le déconnecter et de lui
    // expliquer la situation, au lieu de le laisser sur une application vide.
    // La lecture ci-dessous passe grâce à la branche `id = auth.uid()` de la
    // policy view_own_profile.
    const uid = auth.user?.id;
    if (uid) {
      // `as any` sur la table : les types Supabase générés ignorent encore
      // is_approved (régénération bloquée par le proxy TLS, cf. types.ts).
      const { data: prof } = await (supabase as any)
        .from("profiles")
        .select("is_approved")
        .eq("id", uid)
        .maybeSingle();

      // `prof === null` (profil illisible/absent) ne bloque pas : ce serait
      // verrouiller un compte sur une erreur transitoire, alors que la RLS
      // protège déjà les données de toute façon.
      if (prof && prof.is_approved === false) {
        await supabase.auth.signOut();
        setSubmitting(false);
        toast.error("Compte en attente d'approbation par l'administrateur. Vous recevrez l'accès une fois votre inscription validée.");
        return;
      }
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
    const { data: inscrit, error } = await supabase.auth.signUp({
      email, password: pwd,
      options: {
        emailRedirectTo: `${window.location.origin}/auth`,
        data: { nom, prenom, cabinet_nom: cabinetNom || "Mon Cabinet", plan_code: planCode },
      },
    });

    if (error) {
      setPlanEnCours(null);
      toast.error(error.message);
      return;
    }

    // Prévient l'administrateur qu'un compte attend son approbation. On ne passe
    // que l'userId : le serveur relit lui-même l'e-mail et le cabinet avec la clé
    // de service, pour qu'on ne puisse pas lui dicter le contenu du message.
    // Best-effort : le compte EST créé (en attente) même si le mail échoue —
    // l'admin peut toujours approuver à la main en base. Bloquer ici laisserait
    // l'utilisateur croire que son inscription a échoué alors qu'elle a réussi.
    if (inscrit.user?.id) {
      try {
        await notifierInscriptionEnAttente({ data: { userId: inscrit.user.id } });
      } catch (err: any) {
        console.warn("[auth] notification d'approbation non envoyée:", err?.message ?? err);
      }
    }
    // La confirmation d'e-mail étant désactivée côté Supabase, signUp ouvre
    // directement une session. Sans ce signOut, le nouvel inscrit est connecté
    // alors qu'il n'est pas approuvé : _app ne garde que sur `user`, il verrait
    // donc une application vide (la RLS lui refuse tout) au lieu du message
    // ci-dessous. On le déconnecte pour qu'il repasse par handleLogin, seul
    // endroit qui sait expliquer l'attente d'approbation.
    await supabase.auth.signOut();
    setPlanEnCours(null);

    toast.success("Compte créé ! Votre inscription doit être approuvée par l'administrateur. Vous pourrez vous connecter une fois validée.");
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
