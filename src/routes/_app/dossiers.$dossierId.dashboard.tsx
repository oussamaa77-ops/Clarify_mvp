import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TrendingUp, Wallet, FileText, ShoppingCart, AlertCircle, CheckCircle, Clock, AlertTriangle, Users, Building2, Receipt, Mail, Loader2, Landmark, ArrowLeftRight, ExternalLink, FileCheck2 } from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, BarChart, Bar } from "recharts";
import {
  synthetiserTva, tvaRecuperableEnCours, echeanceSimplTva, joursAvant,
  ventilerChargesParCompte, ventilerVentesParCompte, balanceAgeeDashboard, calculerCashFlow,
} from "@/lib/dashboard-fiscal";
import { RepartitionDepensesPcm } from "@/components/RepartitionDepensesPcm";
import { RepartitionVentesPcm } from "@/components/RepartitionVentesPcm";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { envoyerRappelTVA } from "@/server/fiscalite.functions";
import { identifierBanque, identifierBanqueParNom, maskRib } from "@/lib/bank-identity";
import { BankLogo } from "@/components/BankLogo";
import { logAudit } from "@/lib/audit";
import {
  COMPTE_CLIENTS, caHtGrandLivre, encaissementsTiersGrandLivre, encoursTiersGrandLivre,
  soldeBancaireAffiche, type LigneGrandLivre,
} from "@/lib/encours-grandlivre";
import {
  bornesExercice, dansExercice, exerciceCourant, exercicesDisponibles,
} from "@/lib/exercice-comptable";
import { sansANouveaux } from "@/lib/a-nouveaux";
import { joursRetard } from "@/lib/factures-filtres";

export const Route = createFileRoute("/_app/dossiers/$dossierId/dashboard")({ component: DashboardPage });

const fmt = (n: number) => Number(n).toLocaleString("fr-MA", { minimumFractionDigits: 2 }) + " MAD";

// ── Transactions bancaires NON LETTRÉES du dossier, ventilées par relevé ────────
// « non lettrée » = ni facture ni justificatif lié (même définition que la colonne
// nb_orphelines de v_releves_stats, donc mêmes chiffres que la page Banque).
//
// Seules les transactions PORTÉES PAR UN RELEVÉ sont comptées : le total affiché est la
// somme des relevés listés, et rien d'autre. Les transactions à `releve_id` NULL (import
// antérieur aux relevés parents) sont volontairement ignorées — elles n'apparaissent dans
// aucun écran, les compter donnerait un total que l'utilisateur ne peut rapprocher de rien.
//
// On lit les transactions plutôt que v_releves_stats pour ne pas dépendre d'une vue dont
// les colonnes varient selon les bases. `ok: false` en cas d'échec : on n'annonce JAMAIS
// « rapproché » sur une requête qui n'a pas abouti.
interface FluxNonLettres { parReleve: Record<string, number>; ok: boolean }
const PAGE_TX = 1000; // limite de lignes par requête PostgREST

async function chargerFluxNonLettres(dossierId: string): Promise<FluxNonLettres> {
  const parReleve: Record<string, number> = {};
  for (let from = 0; ; from += PAGE_TX) {
    const { data, error } = await (supabase.from("transactions_bancaires") as any)
      .select("id,releve_id")
      .eq("dossier_id", dossierId)
      .is("facture_id", null)
      .is("justificatif_id", null)
      .not("releve_id", "is", null)
      .order("id")
      .range(from, from + PAGE_TX - 1);
    if (error) {
      console.error("[DASHBOARD] flux non lettrés illisibles:", error.message);
      return { parReleve: {}, ok: false };
    }
    const rows = (data ?? []) as { id: string; releve_id: string }[];
    for (const t of rows) parReleve[t.releve_id] = (parReleve[t.releve_id] ?? 0) + 1;
    if (rows.length < PAGE_TX) break;
  }
  return { parReleve, ok: true };
}

function DashboardPage() {
  const { dossierId } = Route.useParams();
  const [dossier, setDossier] = useState<any>(null);
  const [factures, setFactures] = useState<any[]>([]);
  const [ff, setFf] = useState<any[]>([]);
  const [alertes, setAlertes] = useState<any[]>([]);
  // Écritures d'exploitation : charges (classe 6) ET produits (classe 7), pour
  // les deux donuts de répartition par compte PCM.
  const [ecrExploitation, setEcrExploitation] = useState<any[]>([]);
  // Intitulés du référentiel PCM (numéro → intitulé), pour nommer chaque poste.
  const [intitulesPcm, setIntitulesPcm] = useState<Record<string, string>>({});
  // Écritures des comptes de tiers et de trésorerie — la source des deux
  // indicateurs qui doivent s'accorder avec la comptabilité : l'encours clients
  // et le solde bancaire.
  const [ecrTiers, setEcrTiers] = useState<LigneGrandLivre[]>([]);
  const [comptesBancaires, setComptesBancaires] = useState<CompteBancaire[]>([]);
  const [releves, setReleves] = useState<ReleveResume[]>([]);
  const [flux, setFlux] = useState<FluxNonLettres>({ parReleve: {}, ok: true });
  const [loading, setLoading] = useState(true);
  const [sendingTva, setSendingTva] = useState(false);
  const { user, profile } = useAuth();

  // ── EXERCICE ──────────────────────────────────────────────────────────────
  // Les KPI lisaient TOUT le dossier, sans borne de date : sur un dossier repris,
  // le CA « de l'exercice » cumulait 2024, 2025 et 2026. Un chiffre d'affaires
  // qui agrège trois exercices ne correspond à aucune liasse.
  //
  // Deux régimes, parce que flux et stock ne se bornent pas pareil :
  //   • FLUX (CA, achats, charges, produits) — strictement DANS l'exercice. Le
  //     compte de résultat n'est rien d'autre que cela ;
  //   • STOCK (encours clients, dettes, trésorerie) — CUMULÉ jusqu'à la clôture.
  //     Les borner par le bas ferait disparaître une créance de 2024 restée
  //     ouverte : faute d'écritures d'À-NOUVEAUX dans cette base, son solde n'est
  //     porté que par sa ligne d'origine.
  const [exercice, setExercice] = useState<number>(() => exerciceCourant());
  const [exercicesDispo, setExercicesDispo] = useState<number[]>([]);
  const bornes = bornesExercice(exercice);

  // Tracé d'audit : ouverture / changement de dossier (une fois par dossierId).
  useEffect(() => { logAudit({ dossierId, action: "ouverture_dossier", ressourceType: "dossier", ressourceId: dossierId }); }, [dossierId]);

  useEffect(() => {
    (async () => {
      const [{ data: d }, { data: f }, { data: ffData }, { data: al }, { data: cb }, { data: rel }, fluxNonLettres, { data: charges }, { data: pcm }, { data: glTiers }, { data: millesimes }] = await Promise.all([
        supabase.from("dossiers").select("nom_societe,ice,statut").eq("id", dossierId).single(),
        // Ajouter montant_paye et montant_restant pour calculs corrects + tiers pour les alertes
        supabase.from("factures").select("numero,statut,statut_paiement,montant_ht,montant_ttc,montant_tva,montant_paye,montant_restant,type,date_facture,date_echeance,clients(nom)").eq("dossier_id", dossierId),
        // montant_ht / montant_tva servent au suivi TVA (régime de l'encaissement)
        // et au cash-flow, qui raisonnent tous deux hors taxes.
        supabase.from("factures_fournisseurs").select("numero,fournisseur_nom,statut_paiement,montant_ht,montant_tva,montant_ttc,montant_paye,montant_restant,date_echeance,date_facture").eq("dossier_id", dossierId),
        supabase.from("alertes").select("*").eq("dossier_id", dossierId).eq("lue", false).order("created_at", { ascending: false }).limit(5),
        // Comptes & flux bancaires : TOUS les comptes du dossier + relevés + transactions
        // non lettrées comptées par relevé (cf. chargerFluxNonLettres).
        supabase.from("comptes_bancaires").select("id,banque,intitule,rib,solde_actuel").eq("dossier_id", dossierId).order("created_at"),
        // `select("*")` volontaire (comme la page Banque) : les colonnes méta banque/rib/
        // periode_* n'existent pas sur toutes les bases (migration « briques » appliquée
        // manuellement). Un select nommé y échoue et renvoie data=null pour TOUTE la
        // requête — la carte croirait alors qu'il n'y a aucun relevé.
        (supabase.from("releves_bancaires") as any).select("*").eq("dossier_id", dossierId).order("created_at", { ascending: false }),
        chargerFluxNonLettres(dossierId),
        // Charges (classe 6) ET produits (classe 7) pour les deux ventilations
        // par compte PCM. Les écritures sont la seule source portant un compte :
        // ni `factures` ni `factures_fournisseurs` n'en ont.
        // FLUX : bornés des deux côtés par l'exercice ouvert.
        supabase.from("ecritures_comptables").select("compte_numero,debit,credit,date_ecriture")
          .eq("dossier_id", dossierId).or("compte_numero.like.6%,compte_numero.like.7%")
          .gte("date_ecriture", bornes.debut).lte("date_ecriture", bornes.fin),
        // Référentiel PCM (global, sans dossier_id) : donne son INTITULÉ à chaque
        // compte. Limité aux classes 6 et 7 — le reste ne sert pas ici.
        supabase.from("pcm_reference").select("numero,intitule")
          .or("numero.like.6%,numero.like.7%"),
        // Comptes de TIERS (34/44) et de TRÉSORERIE (51) : ce sont eux qui portent
        // l'encours clients et le solde bancaire, désormais lus dans le grand livre
        // et non plus dans les colonnes dérivées (cf. src/lib/encours-grandlivre.ts).
        // `lettrage_code` est indispensable : c'est lui qui distingue un poste
        // ouvert d'une facture soldée.
        //
        // STOCK : borné à la seule CLÔTURE. Un poste ouvert de 2024 fait bien
        // partie de l'encours au 31/12/2026 tant qu'il n'est pas lettré.
        supabase.from("ecritures_comptables")
          .select("journal_code,compte_numero,date_ecriture,debit,credit,reference_piece,lettrage_code,facture_id")
          .eq("dossier_id", dossierId)
          .or("compte_numero.like.34%,compte_numero.like.44%,compte_numero.like.51%")
          .lte("date_ecriture", bornes.fin),
        // Millésimes réellement portés par le dossier, pour le sélecteur.
        supabase.from("ecritures_comptables").select("date_ecriture").eq("dossier_id", dossierId),
      ]);
      setDossier(d);
      setFactures(f ?? []);
      setFf(ffData ?? []);
      setAlertes(al ?? []);
      setComptesBancaires((cb ?? []) as CompteBancaire[]);
      setReleves((rel ?? []) as ReleveResume[]);
      setFlux(fluxNonLettres);
      setEcrExploitation(charges ?? []);
      setIntitulesPcm(Object.fromEntries(((pcm ?? []) as any[]).map(c => [c.numero, c.intitule])));
      // Le stock est lu en CUMULÉ depuis l'origine (aucune borne basse) : les
      // à-nouveaux y feraient doublon avec les lignes qu'ils reportent. Ils ne
      // valent que dans une vue bornée à UN exercice, où l'origine est absente.
      setEcrTiers(sansANouveaux((glTiers ?? []) as LigneGrandLivre[]));
      setExercicesDispo(exercicesDisponibles(((millesimes ?? []) as any[]).map((x) => x.date_ecriture)));
      setLoading(false);
    })();
  }, [dossierId, bornes.debut, bornes.fin]);

  // ── KPIs ──────────────────────────────────────────────────────────────────
  // Le chiffre d'affaires est un FLUX : il appartient à l'exercice où la facture
  // a été ÉMISE. Une facture de 2024 n'entre pas dans le CA 2026, quel que soit
  // le moment où elle est réglée.
  const facturesExercice = factures.filter(f => dansExercice(f.date_facture, bornes));
  const conformes = facturesExercice.filter(f => f.statut === "conforme");

  // ── CA HT : les CRÉDITS DE CLASSE 7, pas la somme des colonnes ─────────────
  // Σ `montant_ht` est un agrégat de la projection commerciale ; les crédits nets
  // de la classe 7 sont le chiffre d'affaires comptable, celui de la liasse. Ils
  // ne coïncident que si toute facture conforme est comptabilisée — et c'est
  // précisément ce que le rapprochement (a) de `coherence-ventes.ts` contrôle.
  //
  // Repli sur les factures tant qu'aucune écriture de produit n'existe : un
  // dossier non comptabilisé afficherait sinon 0 de CA en ayant facturé.
  const caFactures = conformes
    .filter(f => f.type !== "acompte")
    .reduce((s, f) => s + Number(f.montant_ht), 0);
  const caGL = caHtGrandLivre(ecrExploitation as LigneGrandLivre[]);
  const caHT = caGL.comptabilise ? caGL.montant : caFactures;

  // CA TTC facturé (hors acomptes) — reste une donnée de FACTURATION, pas de
  // comptabilité : aucun compte ne porte le TTC, qui mêle produit et TVA.
  const caTTC = conformes
    .filter(f => f.type !== "acompte")
    .reduce((s, f) => s + Number(f.montant_ttc), 0);

  // ── Encaissements clients : ce que les journaux de trésorerie ont crédité ──
  // Auparavant : Σ des `montant_paye` des factures non « non_payee ». Ce chiffre
  // ne venait d'aucun journal — sur SMERT WATER il annonçait 102 972 MAD, soit
  // le TTC de trois factures dont DEUX n'ont jamais été encaissées, quand la
  // comptabilité n'en portait que 21 000.
  //
  // On lit maintenant le CRÉDIT du 342x en journal BQ/CAI : la contrepartie du
  // débit de banque ou de caisse, c'est-à-dire l'argent réellement entré.
  // FLUX, donc borné à l'exercice, comme le CA auquel on le compare.
  const encaissementsGL = encaissementsTiersGrandLivre(
    ecrTiers.filter(l => dansExercice(l.date_ecriture, bornes)), COMPTE_CLIENTS);
  const caEncaisse = encaissementsGL.comptabilise
    ? encaissementsGL.montant
    : conformes
        .filter(f => f.type !== "acompte" && f.statut_paiement !== "non_payee")
        .reduce((s, f) => s + Number(f.montant_paye ?? 0), 0);

  // ── Encours clients : les postes OUVERTS du compte 3421 au grand livre ──────
  // Auparavant : Σ des `montant_restant` des factures non soldées. Ce chiffre ne
  // pouvait pas être justifié devant la comptabilité — il restait faux tant que
  // les colonnes n'avaient pas été resynchronisées, et il ignorait tout règlement
  // saisi directement en écriture. On lit maintenant ce que dit le grand livre :
  // les lignes NON LETTRÉES du 3421 (auxiliaires compris), sans jamais compenser
  // l'avance d'un client par la dette d'un autre.
  //
  // Repli : tant qu'aucune écriture de tiers n'existe (dossier non comptabilisé),
  // l'ancien calcul reste le seul disponible.
  const encoursGL = encoursTiersGrandLivre(ecrTiers, COMPTE_CLIENTS);
  // STOCK : toutes les factures ÉMISES jusqu'à la clôture, pas seulement celles
  // de l'exercice. Une créance de 2024 encore ouverte est due au 31/12/2026.
  const encoursFactures = factures
    .filter(f => f.statut === "conforme" && f.statut_paiement !== "payee"
      && String(f.date_facture ?? "").slice(0, 10) <= bornes.fin)
    .reduce((s, f) => s + Number(f.montant_restant ?? f.montant_ttc), 0);
  const comptabilise = ecrTiers.some(l => String(l.compte_numero ?? "").startsWith(COMPTE_CLIENTS));
  const encours = comptabilise ? encoursGL.total : encoursFactures;

  // Achats facturés (toutes factures fournisseurs reçues, réglées ou non) —
  // pendant du « CA HT facturé » côté ventes, donc borné au même exercice.
  const ffExercice = ff.filter(f => dansExercice(f.date_facture, bornes));
  const achatsHT = ffExercice.reduce((s, f) => s + Number(f.montant_ht ?? 0), 0);
  const achatsTTC = ffExercice.reduce((s, f) => s + Number(f.montant_ttc ?? 0), 0);

  // Dettes fournisseurs = montant_restant (ou montant_ttc si pas encore renseigné).
  // STOCK, donc cumulé jusqu'à la clôture — comme l'encours clients.
  const dettes = ff
    .filter(f => f.statut_paiement !== "payee"
      && String(f.date_facture ?? "").slice(0, 10) <= bornes.fin)
    .reduce((s, f) => s + Number(f.montant_restant ?? f.montant_ttc), 0);

  const enAnalyse = facturesExercice.filter(f => f.statut === "envoyee").length;

  // ── CENTRE D'ALERTES : retards clients / fournisseurs / échéance TVA ─────────
  const today = new Date(); today.setHours(0, 0, 0, 0);
  // Montant réellement dû, robuste à un montant_restant périmé (0 par défaut alors que
  // la facture est non payée) : on retombe sur TTC − payé si le restant stocké est nul.
  const duFacture = (f: any) => {
    const r = Number(f.montant_restant ?? 0);
    return r > 0.005 ? r : Math.max(0, Number(f.montant_ttc ?? 0) - Number(f.montant_paye ?? 0));
  };

  // Retard = jours depuis la date d'EXIGIBILITÉ (échéance, à défaut émission),
  // par `joursRetard` — la règle de la vue `v_balance_agee`. Filtrer sur la seule
  // `date_echeance` affichait « Aucun retard » pour une facture sans échéance que
  // le module Fournisseurs classait « Urgent (+60 j) ».
  const retardDe = (f: any) => joursRetard({ ...f, montant_restant: duFacture(f) }, today);

  // Retards clients : factures conformes non soldées, exigibles depuis au moins un jour.
  const retardsClients = factures
    .filter(f => f.statut === "conforme" && f.statut_paiement !== "payee"
      && duFacture(f) > 0.005 && retardDe(f) != null)
    .map(f => ({
      id: f.numero ?? "—",
      tiers: (f as any).clients?.nom ?? "Client",
      restant: duFacture(f),
      jours: retardDe(f)!,
    }))
    .sort((a, b) => b.jours - a.jours);
  const totalRetardsClients = retardsClients.reduce((s, r) => s + r.restant, 0);
  const maxJoursClients = retardsClients[0]?.jours ?? 0;

  // Retards fournisseurs : même règle, côté dettes.
  const retardsFourn = ff
    .filter(f => f.statut_paiement !== "payee" && duFacture(f) > 0.005 && retardDe(f) != null)
    .map(f => ({
      id: f.numero ?? "—",
      tiers: f.fournisseur_nom ?? "Fournisseur",
      restant: duFacture(f),
      jours: retardDe(f)!,
    }))
    .sort((a, b) => b.jours - a.jours);
  const totalRetardsFourn = retardsFourn.reduce((s, r) => s + r.restant, 0);
  const maxJoursFourn = retardsFourn[0]?.jours ?? 0;

  // ── SUIVI TVA & FISCALITÉ DGI (régime de l'encaissement) ────────────────────
  // Calculé sur les FACTURES et leur règlement effectif, et non sur les écritures
  // 44551/34552 : celles-ci suivent le fait générateur comptable, alors que
  // l'exigibilité, sous ce régime, naît de l'encaissement.
  const syntheseTva = synthetiserTva(factures, ff);
  const tvaEnCours = tvaRecuperableEnCours(ff);

  // Période déclarée = dernier mois clos ayant des factures ; l'échéance de
  // télédéclaration SIMPL-TVA tombe le dernier jour du mois suivant.
  const moisFactures = [...new Set(
    [...factures, ...ff].map(x => (x.date_facture ?? "").slice(0, 7)).filter(Boolean),
  )].sort() as string[];
  const periodeSimpl = moisFactures[moisFactures.length - 1] ?? null;
  const echeanceSimpl = periodeSimpl ? echeanceSimplTva(periodeSimpl) : null;
  const joursSimpl = echeanceSimpl ? joursAvant(echeanceSimpl, today) : null;

  // ── Graphiques : ventilation PCM + balance âgée ─────────────────────────────
  // Les intitulés viennent du référentiel `pcm_reference` — la même source que le
  // datalist des comptes de la page Comptabilité, pour qu'un compte porte le même
  // nom partout dans l'application.
  const partsCharges = ventilerChargesParCompte(ecrExploitation, { intitules: intitulesPcm });
  const totalCharges = partsCharges.reduce((s, p) => s + p.montant, 0);
  const partsVentes = ventilerVentesParCompte(ecrExploitation, { intitules: intitulesPcm });
  const totalVentes = partsVentes.reduce((s, p) => s + p.montant, 0);
  const tranchesAgees = balanceAgeeDashboard(factures, ff, today);

  // ── Trésorerie : marge brute réelle sur flux encaissés/décaissés ────────────
  const cashFlow = calculerCashFlow(factures, ff);

  // Rappel INTERNE : envoie au gérant/utilisateur courant (jamais un tiers) un
  // récap de l'échéance TVA (montant net, période, date limite) via SMTP.
  const envoyerRappelTvaMail = async () => {
    const to = user?.email ?? profile?.email ?? "";
    if (!to) { toast.error("Aucune adresse e-mail pour l'utilisateur courant."); return; }
    if (!periodeSimpl || !echeanceSimpl) { toast.error("Aucune échéance TVA à rappeler."); return; }
    setSendingTva(true);
    try {
      const gerantNom = [profile?.prenom, profile?.nom].filter(Boolean).join(" ").trim();
      await envoyerRappelTVA({
        data: {
          to,
          gerantNom: gerantNom || undefined,
          societeNom: dossier?.nom_societe ?? "HisabPro",
          // Montant et échéance du suivi SIMPL-TVA affiché à l'écran : le rappel
          // doit annoncer exactement ce que l'utilisateur voit.
          montantTVA: Number(syntheseTva.nette.toFixed(2)),
          periode: periodeSimpl,
          dateEcheance: echeanceSimpl.toLocaleDateString("fr-MA"),
          joursRestants: joursSimpl ?? undefined,
        },
      });
      toast.success(`Rappel d'échéance TVA envoyé à ${to}`);
    } catch (e: any) {
      toast.error("Échec de l'envoi : " + (e?.message ?? e));
    } finally {
      setSendingTva(false);
    }
  };

  // ── Graphe 6 mois ─────────────────────────────────────────────────────────
  const now = new Date();
  const chartData = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - 5 + i, 1);
    const mois = d.toLocaleDateString("fr-MA", { month: "short", year: "2-digit" });
    const m = d.getMonth();
    const y = d.getFullYear();

    // CA HT facturé ce mois
    const caHtMois = factures
      .filter(f => {
        const fd = new Date(f.date_facture);
        return fd.getMonth() === m && fd.getFullYear() === y && f.statut === "conforme";
      })
      .reduce((s, f) => s + Number(f.montant_ht), 0);

    // Encaissé ce mois = montant_paye des factures de ce mois (payee + partielle)
    const encaisseMois = factures
      .filter(f => {
        const fd = new Date(f.date_facture);
        return fd.getMonth() === m && fd.getFullYear() === y && f.statut === "conforme";
      })
      .reduce((s, f) => s + Number(f.montant_paye ?? 0), 0);

    return { mois, caHT: Math.round(caHtMois), encaisse: Math.round(encaisseMois) };
  });

  const kpis = [
    { icon: TrendingUp, label: "CA HT facturé (conformes DGI)", value: fmt(caHT),
      sub: caGL.comptabilise
        ? `Crédits de classe 7 · TTC facturé : ${fmt(caTTC)}`
          + (Math.abs(caGL.montant - caFactures) > 0.005 ? ` · ${fmt(Math.abs(caGL.montant - caFactures))} non comptabilisés` : "")
        : `Non comptabilisé · TTC: ${fmt(caTTC)}`,
      color: "text-green-600" },
    { icon: Wallet, label: "Encaissements clients", value: fmt(caEncaisse),
      sub: encaissementsGL.comptabilise
        ? `Crédits du ${COMPTE_CLIENTS} en journal de trésorerie`
        : "Aucune écriture de trésorerie — montants portés par les factures",
      color: "text-emerald-600" },
    {
      icon: FileText, label: "Encours clients (restant à encaisser)", value: fmt(encours),
      // On dit d'où vient le chiffre : « 3421 non lettré » est vérifiable au
      // grand livre, ce que « somme des restants dus » n'était pas.
      sub: comptabilise
        ? `Compte 3421 non lettré · ${encoursGL.postes.length} poste${encoursGL.postes.length > 1 ? "s" : ""} ouvert${encoursGL.postes.length > 1 ? "s" : ""}`
          + (encoursGL.avances > 0.005 ? ` · ${fmt(encoursGL.avances)} d'avances` : "")
        : "Restant dû des factures (dossier non comptabilisé)",
      color: "text-blue-600",
    },
    // La TVA n'est plus ici : elle est détaillée dans le bloc « Suivi TVA &
    // Fiscalité DGI » ci-dessous, au régime de l'encaissement.
    { icon: ShoppingCart, label: "Achats HT facturés", value: fmt(achatsHT), sub: `TTC: ${fmt(achatsTTC)}`, color: "text-purple-600" },
    { icon: Wallet, label: "Dettes fournisseurs", value: fmt(dettes), color: "text-orange-600" },
    { icon: AlertCircle, label: "En analyse DGI", value: String(enAnalyse), color: "text-yellow-600" },
  ];

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="mb-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="text-3xl font-bold">{dossier?.nom_societe ?? "Dashboard"}</h1>
          {/* Le périmètre des chiffres, RENDU VISIBLE. Sans lui, l'utilisateur
              n'a aucun moyen de savoir de quel exercice parle un KPI — et c'est
              précisément ce qui laissait passer un CA cumulant 2024 et 2026. */}
          <select
            className="h-9 rounded-md border bg-background px-3 text-sm"
            value={exercice}
            onChange={(e) => setExercice(Number(e.target.value))}
            aria-label="Exercice comptable"
          >
            {[...new Set([exerciceCourant(), exercice, ...exercicesDispo])]
              .sort((a, b) => b - a)
              .map((a) => <option key={a} value={a}>Exercice {a}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-3 mt-1">
          {dossier?.ice && <span className="font-mono text-xs text-muted-foreground">ICE: {dossier.ice}</span>}
          <Badge variant="outline" className="text-green-600">{dossier?.statut}</Badge>
          {/* Flux et stock ne se bornent pas pareil : le dire évite de croire à
              une incohérence entre le CA (dans l'exercice) et l'encours (cumulé). */}
          <span className="text-xs text-muted-foreground">
            Flux du {bornes.debut} au {bornes.fin} · encours et trésorerie cumulés à la clôture
          </span>
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          {Array(6).fill(0).map((_, i) => <div key={i} className="h-24 bg-muted rounded-xl animate-pulse" />)}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
            {kpis.map(k => (
              <Card key={k.label}><CardContent className="pt-5 pb-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">{k.label}</p>
                    <p className={`text-2xl font-bold ${k.color}`}>{k.value}</p>
                    {(k as any).sub && <p className="text-xs text-muted-foreground mt-0.5">{(k as any).sub}</p>}
                  </div>
                  <k.icon className={`h-8 w-8 ${k.color} opacity-40`} />
                </div>
              </CardContent></Card>
            ))}
          </div>

          {/* ── CENTRE D'ALERTES ─────────────────────────────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-8">
            {/* Retards clients */}
            <AlerteCard
              icon={Users}
              titre="Retards de paiement clients"
              count={retardsClients.length}
              maxJours={maxJoursClients}
              montant={totalRetardsClients}
              montantLabel="à encaisser en retard"
              to="/dossiers/$dossierId/relances"
              dossierId={dossierId}
              items={retardsClients.slice(0, 4)}
              sens="recevoir"
            />
            {/* Retards fournisseurs */}
            <AlerteCard
              icon={Building2}
              titre="Retards de paiement fournisseurs"
              count={retardsFourn.length}
              maxJours={maxJoursFourn}
              montant={totalRetardsFourn}
              montantLabel="à régler en retard"
              to="/dossiers/$dossierId/fournisseurs"
              dossierId={dossierId}
              items={retardsFourn.slice(0, 4)}
              sens="payer"
            />
          </div>

          {/* ── SUIVI TVA & FISCALITÉ DGI ────────────────────────────────────── */}
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Receipt className="h-4 w-4" />Suivi TVA &amp; Fiscalité DGI
                  <Badge variant="secondary" className="text-[10px] font-normal">Régime de l'encaissement</Badge>
                </CardTitle>
                {/* Ce bloc MESURE la TVA ; la liquidation l'ÉCRIT. Le bouton passe
                    à l'onglet qui la comptabilise, en emportant la période de
                    l'échéance affichée — sans quoi l'utilisateur atterrit sur le
                    mois courant et doit retrouver la bonne période à la main. */}
                <Button asChild size="sm" className="h-8 text-xs">
                  <Link
                    to="/dossiers/$dossierId/fiscalite"
                    params={{ dossierId } as any}
                    search={{ tab: "declaration", ...(periodeSimpl ? { periode: periodeSimpl } : {}) } as any}
                    title="Générer l'OD de liquidation de la TVA et enregistrer le paiement DGI"
                  >
                    <FileCheck2 className="h-3.5 w-3.5 mr-1.5" />
                    Déclarer la TVA
                  </Link>
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">TVA collectée</p>
                  <p className="text-xl font-bold text-purple-600 mt-1">{fmt(syntheseTva.collectee)}</p>
                  <p className="text-[10px] text-muted-foreground mt-1">Sur ventes réellement encaissées</p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">TVA déductible</p>
                  <p className="text-xl font-bold text-blue-600 mt-1">{fmt(syntheseTva.deductible)}</p>
                  <p className="text-[10px] text-muted-foreground mt-1">Sur achats réellement décaissés</p>
                </div>
                {/* Le signe porte le sens : dette envers l'État ou créance sur lui. */}
                <div className={`rounded-lg border p-3 ${syntheseTva.estCredit ? "border-green-300 bg-green-50 dark:bg-green-950/20" : "border-orange-300 bg-orange-50 dark:bg-orange-950/20"}`}>
                  <p className="text-xs text-muted-foreground">
                    {syntheseTva.estCredit ? "Crédit de TVA" : "TVA nette à payer"}
                  </p>
                  <p className={`text-xl font-bold mt-1 ${syntheseTva.estCredit ? "text-green-600" : "text-orange-600"}`}>
                    {fmt(Math.abs(syntheseTva.nette))}
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    {syntheseTva.estCredit ? "Reportable sur la période suivante" : "Collectée − déductible"}
                  </p>
                </div>
              </div>

              {/* Alerte échéance SIMPL-TVA */}
              {echeanceSimpl && periodeSimpl && (
                <div className={`rounded-lg border p-3 flex flex-wrap items-center justify-between gap-3 ${
                  joursSimpl !== null && joursSimpl < 0 ? "border-red-300 bg-red-50 dark:bg-red-950/20"
                  : joursSimpl !== null && joursSimpl <= 7 ? "border-orange-300 bg-orange-50 dark:bg-orange-950/20"
                  : "border-border bg-muted/30"}`}>
                  <div>
                    <p className="text-sm font-medium flex items-center gap-1.5">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      Échéance SIMPL-TVA — période {periodeSimpl}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Télédéclaration et paiement au plus tard le{" "}
                      <span className="font-medium text-foreground">
                        {echeanceSimpl.toLocaleDateString("fr-MA", { day: "2-digit", month: "long", year: "numeric" })}
                      </span>
                      {" "}(dernier jour du mois suivant la période)
                    </p>
                    {/* Déclaration à néant : au Maroc, l'obligation de dépôt subsiste
                        même quand la TVA nette est nulle. L'omettre expose à la pénalité
                        pour dépôt hors délai (Art. 229 du CGI). */}
                    {Math.abs(syntheseTva.nette) < 0.005 && (
                      <p
                        className="text-[11px] mt-1.5 flex items-start gap-1 text-amber-700 dark:text-amber-400"
                        title="Même à 0 MAD, la déclaration reste obligatoire : le défaut ou le retard de dépôt est sanctionné (Art. 229 du Code général des impôts)."
                      >
                        <AlertTriangle className="h-3 w-3 mt-[1px] shrink-0" />
                        <span>
                          Déclaration du néant requise (TVA = 0 MAD) pour éviter la pénalité
                          pour retard de dépôt (Art. 229 du CGI).
                        </span>
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-3 flex-wrap">
                    <Badge className={
                      joursSimpl !== null && joursSimpl < 0 ? "bg-red-100 text-red-700"
                      : joursSimpl !== null && joursSimpl <= 7 ? "bg-orange-100 text-orange-700"
                      : "bg-green-100 text-green-700"}>
                      {joursSimpl === null ? "—"
                        : joursSimpl < 0 ? `En retard de ${Math.abs(joursSimpl)} j`
                        : joursSimpl === 0 ? "Dernier jour !"
                        : `Dans ${joursSimpl} j`}
                    </Badge>
                    {joursSimpl !== null && joursSimpl < 0 ? (
                      <>
                        {/* En retard : action principale = accéder au téléservice DGI pour
                            régulariser sans délai. Le rappel e-mail devient secondaire. */}
                        <Button asChild size="sm" className="h-7 text-xs bg-red-600 hover:bg-red-700 text-white">
                          <a href="https://simpl.tax.gov.ma" target="_blank" rel="noopener noreferrer"
                            title="Ouvrir le portail SIMPL-TVA de la DGI pour déposer la déclaration en retard">
                            <ExternalLink className="h-3 w-3 mr-1.5" />
                            Accéder à SIMPL-TVA
                          </a>
                        </Button>
                        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={envoyerRappelTvaMail} disabled={sendingTva}
                          title="M'envoyer par e-mail un rappel de cette échéance TVA">
                          {sendingTva ? <Loader2 className="h-3 w-3 mr-1.5 animate-spin" /> : <Mail className="h-3 w-3 mr-1.5" />}
                          Rappel
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={envoyerRappelTvaMail} disabled={sendingTva}
                        title="M'envoyer par e-mail un rappel de cette échéance TVA">
                        {sendingTva ? <Loader2 className="h-3 w-3 mr-1.5 animate-spin" /> : <Mail className="h-3 w-3 mr-1.5" />}
                        M'envoyer un rappel
                      </Button>
                    )}
                    <Link to="/dossiers/$dossierId/fiscalite" params={{ dossierId }} className="text-xs text-primary hover:underline">
                      Voir la déclaration →
                    </Link>
                  </div>
                </div>
              )}

              {/* Trésorerie & cash-flow — la TVA récupérable en cours rejoint cette grille
                  sous forme de carte dédiée, à côté de la marge, pour la cohérence visuelle. */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 pt-1 border-t">
                <div className="pt-3">
                  <p className="text-xs text-muted-foreground">Encaissements HT réels</p>
                  <p className="text-lg font-bold text-emerald-600 mt-1">{fmt(cashFlow.encaissementsHt)}</p>
                </div>
                <div className="pt-3">
                  <p className="text-xs text-muted-foreground">Décaissements HT réels</p>
                  <p className="text-lg font-bold text-rose-600 mt-1">{fmt(cashFlow.decaissementsHt)}</p>
                </div>
                <div className="pt-3">
                  <p className="text-xs text-muted-foreground">Marge brute réelle / cash-flow</p>
                  <p className={`text-lg font-bold mt-1 ${cashFlow.marge >= 0 ? "text-green-600" : "text-red-600"}`}>
                    {fmt(cashFlow.marge)}
                  </p>
                </div>
                {/* TVA récupérable en cours : achats reçus, pas encore payés → pas encore
                    déductible au régime de l'encaissement. Carte discrète pour la distinguer. */}
                <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50/60 dark:border-blue-900/40 dark:bg-blue-950/20 p-3"
                  title="TVA sur achats validés non encore payés : pas encore déductible au régime de l'encaissement.">
                  <p className="text-xs text-muted-foreground">TVA récupérable en cours</p>
                  <p className="text-lg font-bold text-blue-600 mt-1">{fmt(tvaEnCours)}</p>
                  <p className="text-[10px] text-muted-foreground mt-1">Sur achats validés non encore payés</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* ── GRAPHIQUES : les deux ventilations PCM, côte à côte ───────────── */}
          {/* Dépenses et ventes partagent la même échelle de lecture (donut,
              5 postes + reliquat, mêmes couleurs) : les mettre l'un à côté de
              l'autre permet de comparer d'où vient l'argent et où il part. */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card>
              <CardHeader><CardTitle className="text-base">Répartition des dépenses par compte PCM</CardTitle></CardHeader>
              <CardContent>
                <RepartitionDepensesPcm parts={partsCharges} total={totalCharges} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-base">Répartition du chiffre d'affaires par compte PCM</CardTitle></CardHeader>
              <CardContent>
                <RepartitionVentesPcm parts={partsVentes} total={totalVentes} />
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-6">
            <Card>
              <CardHeader><CardTitle className="text-base">Balance âgée — créances &amp; dettes</CardTitle></CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={tranchesAgees}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={0} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
                    <Tooltip formatter={(v: any, n: string) => [fmt(Number(v)), n === "creances" ? "Créances clients" : "Dettes fournisseurs"]} />
                    <Legend formatter={(v: string) => v === "creances" ? "Créances clients" : "Dettes fournisseurs"} />
                    <Bar dataKey="creances" fill="#2563eb" name="creances" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="dettes"   fill="#f59e0b" name="dettes"   radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <Card className="lg:col-span-2">
              <CardHeader><CardTitle className="text-base">Chiffre d'affaires — 6 mois</CardTitle></CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart data={chartData}>
                    <defs>
                      <linearGradient id="colorRev" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#2563eb" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#2563eb" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="colorEnc" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="mois" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
                    <Tooltip formatter={(v: any, name: string) => [fmt(v), name === "caHT" ? "CA HT facturé" : "Encaissé"]} />
                    <Legend formatter={(v: string) => v === "caHT" ? "CA HT facturé" : "Encaissé"} />
                    <Area type="monotone" dataKey="caHT" stroke="#2563eb" strokeWidth={2} fill="url(#colorRev)" name="caHT" />
                    <Area type="monotone" dataKey="encaisse" stroke="#10b981" strokeWidth={2} fill="url(#colorEnc)" name="encaisse" />
                  </AreaChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <ComptesFluxBancairesCard dossierId={dossierId} comptes={comptesBancaires} releves={releves} flux={flux} grandLivre={ecrTiers} />
          </div>
        </>
      )}
    </div>
  );
}

// ── Carte d'alerte de retard (clients ou fournisseurs) avec compteurs de jours ──
interface AlerteItem { id: string; tiers: string; restant: number; jours: number; }
function AlerteCard({
  icon: Icon, titre, count, maxJours, montant, montantLabel, to, dossierId, items, sens,
}: {
  icon: typeof Users; titre: string; count: number; maxJours: number; montant: number;
  montantLabel: string; to: string; dossierId: string; items: AlerteItem[]; sens: "recevoir" | "payer";
}) {
  const severite = count === 0 ? "ok" : maxJours > 60 ? "danger" : maxJours > 30 ? "warning" : "mild";
  const cardCls =
    severite === "danger" ? "border-red-300 bg-red-50 dark:bg-red-950/20" :
    severite === "warning" ? "border-orange-300 bg-orange-50 dark:bg-orange-950/20" :
    severite === "mild" ? "border-yellow-200 bg-yellow-50/60 dark:bg-yellow-950/10" : "";
  const joursBadge = (j: number) =>
    j > 60 ? "bg-red-100 text-red-700" : j > 30 ? "bg-orange-100 text-orange-700" : "bg-yellow-100 text-yellow-700";

  return (
    <Card className={cardCls}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2"><Icon className="h-4 w-4" />{titre}</CardTitle>
      </CardHeader>
      <CardContent>
        {count === 0 ? (
          <div className="flex items-center gap-2 text-sm text-green-600">
            <CheckCircle className="h-4 w-4" />Aucun retard
          </div>
        ) : (
          <>
            <div className="flex items-baseline justify-between">
              <div>
                <span className="text-2xl font-bold text-red-600">{count}</span>
                <span className="text-xs text-muted-foreground ml-1">facture{count > 1 ? "s" : ""} en retard</span>
              </div>
              <Badge variant="destructive" className="text-xs flex items-center gap-1">
                <Clock className="h-3 w-3" />jusqu'à {maxJours} j
              </Badge>
            </div>
            <p className="text-sm font-semibold mt-1">{fmt(montant)}</p>
            <p className="text-[11px] text-muted-foreground">{montantLabel}</p>
            <div className="mt-2 space-y-1">
              {items.map((it, i) => {
                const contenu = (
                  <>
                    <span className="truncate max-w-[60%]" title={it.tiers}>{it.tiers} <span className="text-muted-foreground">· {it.id}</span></span>
                    <span className={`px-1.5 py-0.5 rounded font-medium ${joursBadge(it.jours)}`}>{it.jours} j</span>
                  </>
                );
                // Clients (recevoir) : ligne cliquable → module de relance pré-filtré sur le tiers.
                return sens === "recevoir" ? (
                  <Link key={i} to={to as any} params={{ dossierId } as any} search={{ client: it.tiers } as any}
                    className="flex items-center justify-between text-xs rounded px-1 -mx-1 hover:bg-white/70 dark:hover:bg-white/10 cursor-pointer transition-colors">
                    {contenu}
                  </Link>
                ) : (
                  <div key={i} className="flex items-center justify-between text-xs">{contenu}</div>
                );
              })}
            </div>
            <Link to={to as any} params={{ dossierId } as any} className="text-xs text-primary hover:underline mt-2 inline-block font-medium">
              {sens === "recevoir" ? "Relancer les clients" : "Voir les fournisseurs"} →
            </Link>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Comptes & Flux Bancaires — suivi de synchronisation + rapprochement (style Pennylane) ──
// Données RÉELLES du dossier : TOUS les comptes bancaires (logo/RIB/solde), les relevés
// importés, et les transactions NON LETTRÉES ventilées par relevé (cf. chargerFluxNonLettres).
// Le total « en attente » est, par construction, la somme des lignes affichées.
// Chaque relevé est cliquable et mène directement à son détail dans la section Banque.
interface CompteBancaire { id: string; banque: string | null; intitule: string | null; rib: string | null; solde_actuel: number | null; }
// Champs méta optionnels : absents des bases où la migration « briques » n'est pas appliquée.
interface ReleveResume {
  id: string; compte_id: string | null; statut: string; fichier_nom: string | null;
  banque?: string | null; rib?: string | null;
  periode_debut?: string | null; periode_fin?: string | null;
  date_debut?: string | null; date_fin?: string | null;
}
function ComptesFluxBancairesCard({
  dossierId, comptes, releves, flux, grandLivre,
}: {
  dossierId: string; comptes: CompteBancaire[]; releves: ReleveResume[]; flux: FluxNonLettres;
  /** Écritures de tiers et de trésorerie du dossier — la source du solde affiché. */
  grandLivre: LigneGrandLivre[];
}) {
  // ── Solde consolidé : LA COMPTABILITÉ D'ABORD ──────────────────────────────
  // `comptes_bancaires.solde_actuel` n'est renseigné que par l'import d'un
  // relevé : sur un dossier tenu à la main, il reste à 0 et la carte annonçait
  // « 0,00 MAD » alors que le compte 5141 portait des mouvements. Le grand livre
  // (514x + 516x) prime donc dès qu'il en connaît, et l'ancienne valeur ne sert
  // plus que de repli.
  const soldeComptes = comptes.reduce((s, c) => s + Number(c?.solde_actuel ?? 0), 0);
  const { montant: soldeTotal, source: sourceSolde } = soldeBancaireAffiche(grandLivre, soldeComptes);
  const nbReleves = releves.length;

  // Identité bancaire — même règle que les cartes de comptes de la page Banque : RIB
  // autoritaire, repli sur le libellé. Un relevé sans méta (base non migrée) hérite de
  // celles de son compte porteur, pour ne jamais afficher de logo générique à tort.
  const identifier = (rib?: string | null, nom?: string | null) =>
    rib ? identifierBanque({ rib, texte: nom ?? "" }) : identifierBanqueParNom(nom);
  const identReleve = (r: ReleveResume) => {
    const cpt = comptes.find((c) => c.id === r.compte_id);
    return identifier(r.rib || cpt?.rib, r.banque || cpt?.banque);
  };

  // Relevés (actifs ou clôturés) portant encore des transactions non lettrées.
  const relevesEnAttente = releves
    .map((r) => ({ releve: r, nb: flux.parReleve[r.id] ?? 0 }))
    .filter((x) => x.nb > 0)
    .sort((a, b) => b.nb - a.nb);
  // Total = somme exacte des relevés listés ⇒ l'addition est vérifiable à l'œil.
  const nbNonLettrees = relevesEnAttente.reduce((s, x) => s + x.nb, 0);
  const MAX_LIGNES = 4;
  const visibles = relevesEnAttente.slice(0, MAX_LIGNES);
  const masques = relevesEnAttente.slice(MAX_LIGNES);
  const nbMasquees = masques.reduce((s, x) => s + x.nb, 0);
  const periodeReleve = (r: ReleveResume) => r.periode_fin ?? r.date_fin ?? null;

  // Aucun compte enregistré → état vide harmonisé (invite à configurer).
  if (comptes.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Landmark className="h-4 w-4" />Comptes &amp; Flux Bancaires
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-6 text-muted-foreground text-sm">
            <Landmark className="h-8 w-8 mx-auto mb-2 opacity-30" />
            Aucun compte bancaire synchronisé
          </div>
          <div className="flex justify-end">
            <Link to="/dossiers/$dossierId/banque" params={{ dossierId }} className="text-xs text-primary hover:underline font-medium">
              Ajouter un compte →
            </Link>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Landmark className="h-4 w-4" />Comptes &amp; Flux Bancaires
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Solde consolidé — puis le détail de CHAQUE compte, pour que le total affiché
            corresponde visiblement aux comptes listés en dessous. */}
        <div>
          <p className="text-2xl font-bold">{fmt(soldeTotal)}</p>
          <p className="text-[11px] text-muted-foreground">
            {sourceSolde === "grand_livre"
              ? "Solde comptable · trésorerie 514/516"
              : comptes.length > 1 ? `Solde total · ${comptes.length} comptes` : "Solde bancaire courant"}
            {` · ${nbReleves} relevé${nbReleves > 1 ? "s" : ""} importé${nbReleves > 1 ? "s" : ""}`}
          </p>
        </div>

        <div className="space-y-1">
          {comptes.map((c) => {
            const ident = identifier(c.rib, c.banque);
            const ribMasque = maskRib(c.rib);
            return (
              <div key={c.id} className="flex items-center gap-2 py-1">
                <BankLogo ident={ident} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium truncate">{c.intitule || c.banque || ident.nom}</p>
                  <p className="text-[10px] text-muted-foreground font-mono truncate">
                    {ribMasque || "RIB non renseigné"}
                  </p>
                </div>
                <span className={`text-xs font-mono font-semibold shrink-0 ${Number(c.solde_actuel ?? 0) < 0 ? "text-red-600" : ""}`}>
                  {fmt(Number(c.solde_actuel ?? 0))}
                </span>
              </div>
            );
          })}
        </div>

        {/* Section Rapprochement — total + détail par relevé (chaque ligne mène au relevé) */}
        {!flux.ok ? (
          // Requête en échec : ne jamais annoncer « rapproché » sur une donnée qu'on n'a pas.
          <div className="rounded-lg border border-muted bg-muted/40 p-3">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <AlertTriangle className="h-4 w-4" />Flux non lettrés indisponibles
            </div>
          </div>
        ) : nbNonLettrees > 0 ? (
          <div className="rounded-lg border border-orange-200 bg-orange-50/70 dark:border-orange-900/50 dark:bg-orange-950/20 p-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-orange-700 dark:text-orange-400">
              <ArrowLeftRight className="h-4 w-4" />{nbNonLettrees} transaction{nbNonLettrees > 1 ? "s" : ""} en attente
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">
              Transactions bancaires non rapprochées de leurs factures (PCM/CGNC)
              {relevesEnAttente.length > 0 && `, réparties sur ${relevesEnAttente.length} relevé${relevesEnAttente.length > 1 ? "s" : ""}`}.
            </p>

            <div className="mt-3 space-y-1">
              {visibles.map(({ releve: r, nb }) => {
                const ident = identReleve(r);
                const compte = comptes.find((c) => c.id === r.compte_id);
                const titre = r.banque || compte?.banque || ident.nom;
                const sousTitre = [r.fichier_nom, periodeReleve(r)].filter(Boolean).join(" · ");
                return (
                  <Link
                    key={r.id}
                    to="/dossiers/$dossierId/banque/$releveId"
                    params={{ dossierId, releveId: r.id }}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 -mx-1 hover:bg-orange-100/60 dark:hover:bg-orange-900/20 transition-colors"
                  >
                    <BankLogo ident={ident} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium truncate">
                        {titre}
                        {r.statut === "cloture" && <span className="ml-1 text-[10px] text-muted-foreground font-normal">(clôturé)</span>}
                      </p>
                      {sousTitre && <p className="text-[10px] text-muted-foreground truncate">{sousTitre}</p>}
                    </div>
                    <Badge className="text-[10px] shrink-0 bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300">
                      {nb} en attente
                    </Badge>
                  </Link>
                );
              })}
            </div>

            {masques.length > 0 && (
              <p className="text-[11px] text-muted-foreground mt-2">
                + {masques.length} autre{masques.length > 1 ? "s" : ""} relevé{masques.length > 1 ? "s" : ""} ({nbMasquees} transaction{nbMasquees > 1 ? "s" : ""})
              </p>
            )}
          </div>
        ) : nbReleves === 0 ? (
          // Aucun relevé importé : ne PAS annoncer « rapproché » (il n'y a rien à
          // rapprocher). État neutre invitant à importer un relevé.
          <div className="rounded-lg border border-muted bg-muted/40 p-3">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Landmark className="h-4 w-4" />Aucun relevé enregistré
            </div>
          </div>
        ) : (
          // Il y a des relevés ET toutes leurs transactions sont rapprochées.
          <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 dark:border-emerald-900/50 dark:bg-emerald-950/20 p-3">
            <div className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-400">
              <CheckCircle className="h-4 w-4" />Tous les flux sont rapprochés
            </div>
          </div>
        )}

        <div className="flex justify-end">
          <Link to="/dossiers/$dossierId/banque" params={{ dossierId }} className="text-xs text-primary hover:underline font-medium inline-flex items-center gap-1">
            {nbNonLettrees > 0 ? "Rapprocher mes flux →" : "Voir mes comptes →"}
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

