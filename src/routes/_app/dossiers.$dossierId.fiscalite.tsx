import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/ui/date-picker";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Download, Calculator, AlertCircle, CheckCircle, Clock, Settings2, Info, Loader2, ShieldCheck, FileSpreadsheet } from "lucide-react";
import { toast } from "sonner";
import {
  BAREME_IS, CLASSES_TP, CLASSE_TP_DEFAUT, REGIME_TVA_LABEL, TAUX_CM_DROIT_COMMUN,
  TAUX_IS_SPECIFIQUE, calculerIS, calculerTP, formatDateFr, lireParametresFiscaux, statutTva,
  type RegimeIS,
} from "@/lib/fiscalite-ma";
import {
  synthetiserTva, tvaRecuperableEnCours, periodesTva, bornesDuMois,
} from "@/lib/dashboard-fiscal";
import {
  COLONNES_RELEVE_DEDUCTIONS, construireReleveDeductions, indexerComptesCharge,
  ligneVersCellules, totauxReleveDeductions,
} from "@/lib/releve-deductions";
import { indexerModesPaiement } from "@/lib/mode-paiement";

export const Route = createFileRoute("/_app/dossiers/$dossierId/fiscalite")({ component: FiscalitePage });

const fmt = (n: number) => Number(n).toLocaleString("fr-MA", { minimumFractionDigits: 2 });
const fmtMAD = (n: number) => fmt(n) + " MAD";
const pourcent = (t: number) => `${(t * 100).toLocaleString("fr-MA", { maximumFractionDigits: 2 })} %`;

function FiscalitePage() {
  const { dossierId } = Route.useParams();
  const [ecritures, setEcritures] = useState<any[]>([]);
  const [ventes, setVentes] = useState<any[]>([]);
  const [achats, setAchats] = useState<any[]>([]);
  const [paiements, setPaiements] = useState<any[]>([]);
  const [dossier, setDossier] = useState<any>(null);
  const [tab, setTab] = useState("tva");
  const [periodeTVA, setPeriodeTVA] = useState("all");
  const [exercice, setExercice] = useState(new Date().getFullYear().toString());

  // Paramètres fiscaux du dossier (édition sur place — ils commandent toutes les
  // exonérations du module, on ne veut pas obliger à ressortir vers /dossiers).
  const [openParams, setOpenParams] = useState(false);
  const [savingParams, setSavingParams] = useState(false);
  const [formParams, setFormParams] = useState<{ date_debut_activite: string | null; valeur_locative_tp: string; classe_tp: string; regime_is: RegimeIS }>(
    { date_debut_activite: null, valeur_locative_tp: "", classe_tp: String(CLASSE_TP_DEFAUT), regime_is: "droit_commun" },
  );

  const chargerDossier = async () => {
    // select("*") : les colonnes fiscales peuvent ne pas encore exister en base
    // (migration 20260804120000 non appliquée) — la lecture doit rester tolérante.
    const { data } = await supabase.from("dossiers").select("*").eq("id", dossierId).maybeSingle();
    setDossier(data ?? null);
  };

  useEffect(() => {
    (async () => {
      const [{ data: ecr }, { data: v }, { data: a }, { data: p }] = await Promise.all([
        // Écritures : base du résultat fiscal et de l'IS (les factures ne portent
        // ni compte ni charge — seul le grand livre le fait).
        supabase.from("ecritures_comptables").select("*").eq("dossier_id", dossierId),
        // TVA : régime de l'encaissement → factures + leurs règlements, jamais
        // les comptes 44551/34552 qui suivent le fait générateur comptable.
        supabase.from("factures")
          .select("id,numero,statut,statut_paiement,montant_ht,montant_tva,montant_ttc,montant_paye,montant_restant,type,date_facture,date_echeance")
          .eq("dossier_id", dossierId),
        supabase.from("factures_fournisseurs")
          .select("id,numero,statut_paiement,montant_ht,montant_tva,montant_ttc,montant_paye,montant_restant,date_facture,date_echeance")
          .eq("dossier_id", dossierId),
        // Règlements datés : donnent au mois d'EXIGIBILITÉ sa vraie date. La table
        // peut ne pas exister (migration du moteur de paiement non appliquée) —
        // `synthetiserTva` retombe alors sur la date de facture.
        supabase.from("paiements")
          .select("facture_id,facture_fournisseur_id,montant,date_paiement")
          .eq("dossier_id", dossierId),
      ]);
      setEcritures(ecr ?? []);
      // Les factures non conformes (rejetées / en analyse) n'ouvrent aucun droit
      // à déduction ni aucune exigibilité : elles ne sont pas des pièces fiscales.
      setVentes((v ?? []).filter((f: any) => f.statut !== "rejetee"));
      setAchats(a ?? []);
      setPaiements(p ?? []);
    })();
    chargerDossier();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dossierId]);

  const parametres = useMemo(() => lireParametresFiscaux(dossier), [dossier]);

  const ouvrirParams = () => {
    setFormParams({
      date_debut_activite: parametres.dateDebutActivite,
      valeur_locative_tp: parametres.valeurLocative != null ? String(parametres.valeurLocative) : "",
      classe_tp: String(parametres.classeTP ?? CLASSE_TP_DEFAUT),
      regime_is: parametres.regimeIS,
    });
    setOpenParams(true);
  };

  const enregistrerParams = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingParams(true);
    try {
      const vl = formParams.valeur_locative_tp.trim().replace(",", ".");
      const { error } = await (supabase.from("dossiers") as any).update({
        date_debut_activite: formParams.date_debut_activite || null,
        valeur_locative_tp: vl === "" ? null : Number(vl),
        classe_tp: Number(formParams.classe_tp),
        regime_is: formParams.regime_is,
      }).eq("id", dossierId);
      if (error) {
        // Cause la plus probable : migration des paramètres fiscaux non appliquée.
        toast.error(`Enregistrement impossible : ${error.message}`);
        return;
      }
      toast.success("Paramètres fiscaux enregistrés ✓");
      setOpenParams(false);
      chargerDossier();
    } finally { setSavingParams(false); }
  };

  // ── Calculs TVA — RÉGIME DE L'ENCAISSEMENT ───────────────────────────────────
  // La TVA n'est exigible qu'une fois la facture ENCAISSÉE (déductible qu'une fois
  // l'achat DÉCAISSÉ) : on part donc des factures et de leurs règlements datés,
  // et non des écritures 44551/34552 qui suivent le fait générateur comptable.
  const bornesPeriode = periodeTVA !== "all"
    ? bornesDuMois(periodeTVA)
    : { debut: `${exercice}-01-01`, fin: `${exercice}-12-31` };

  const synthese = synthetiserTva(ventes, achats, { ...bornesPeriode, paiements });
  const collectee = synthese.collectee;
  const recuperable = synthese.deductible;
  const statutNet = statutTva(synthese.nette);
  // TVA des achats reçus mais NON réglés : pas encore déductible, elle le deviendra
  // au décaissement. Distincte de la déductible du mois, jamais confondue avec elle.
  const tvaEnCours = tvaRecuperableEnCours(achats);

  // Périodes = mois d'exigibilité (encaissement daté, ou facture à défaut).
  const moisDisponibles = periodesTva(ventes, achats, paiements);
  const tvaMensuelle = moisDisponibles.map(m => {
    const bornes = bornesDuMois(m)!;
    const s = synthetiserTva(ventes, achats, { ...bornes, paiements });
    return { mois: m, collectee: s.collectee, recuperable: s.deductible, statut: statutTva(s.nette) };
  });

  // ── Agrégats comptables par exercice ─────────────────────────────────────────
  const anneeN = Number(exercice);
  const agregats = (annee: number) => {
    const e = ecritures.filter(x => x.date_ecriture?.startsWith(String(annee)));
    const solde = (predicat: (c: string) => boolean, sens: "debit" | "credit") =>
      e.filter(x => predicat(String(x.compte_numero ?? ""))).reduce(
        (s, x) => s + (sens === "credit" ? Number(x.credit) - Number(x.debit) : Number(x.debit) - Number(x.credit)), 0);
    const produits = solde(c => c.startsWith("7"), "credit");
    const charges = solde(c => c.startsWith("6"), "debit");
    return {
      produits, charges, resultat: produits - charges,
      // CA au sens strict : ventes de l'exercice (71x). La base de la cotisation
      // minimale est plus large (produits d'exploitation, financiers et non courants).
      ca: solde(c => c.startsWith("71"), "credit"),
      nbEcritures: e.length,
    };
  };
  const agrN = agregats(anneeN);
  const agrN1 = agregats(anneeN - 1);

  // ── Calculs IS ───────────────────────────────────────────────────────────────
  // Les acomptes versés en N s'assoient sur l'IS DÛ DE N-1 : on liquide donc
  // d'abord l'exercice précédent (sans acompte, seule sa dette d'impôt compte).
  const donneesN1 = agrN1.nbEcritures > 0;
  const isN1 = calculerIS({
    exercice: anneeN - 1,
    resultatFiscal: agrN1.resultat,
    baseCotisationMinimale: agrN1.produits,
    dateDebutActivite: parametres.dateDebutActivite,
    tauxCotisationMinimale: parametres.tauxCM ?? undefined,
    regime: parametres.regimeIS,
  });
  const is = calculerIS({
    exercice: anneeN,
    resultatFiscal: agrN.resultat,
    baseCotisationMinimale: agrN.produits,
    dateDebutActivite: parametres.dateDebutActivite,
    isDuExercicePrecedent: donneesN1 ? isN1.isDu : 0,
    tauxCotisationMinimale: parametres.tauxCM ?? undefined,
    regime: parametres.regimeIS,
  });

  // ── Taxe professionnelle ─────────────────────────────────────────────────────
  const tp = calculerTP({
    exercice: anneeN,
    valeurLocative: parametres.valeurLocative,
    classe: parametres.classeTP,
    dateDebutActivite: parametres.dateDebutActivite,
  });

  // ── Export TVA ───────────────────────────────────────────────────────────────
  const exportTVA = () => {
    const rows = [
      ["DÉCLARATION TVA — " + (periodeTVA !== "all" ? periodeTVA : exercice)],
      [REGIME_TVA_LABEL],
      [""],
      ["Rubrique", "Montant MAD"],
      ["TVA collectée sur encaissements", fmt(collectee)],
      ["TVA déductible sur décaissements", fmt(recuperable)],
      [`TVA nette — ${statutNet.label}`, fmt(statutNet.montant)],
      ["TVA récupérable en cours (achats non réglés)", fmt(tvaEnCours)],
    ];
    const csv = rows.map(r => r.join(";")).join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = `tva_${dossierId}_${periodeTVA !== "all" ? periodeTVA : exercice}.csv`; a.click();
  };

  // ── Relevé des déductions (SIMPL-TVA) ────────────────────────────────────────
  // Pièce jointe de la déclaration : 14 colonnes DGI, UNE LIGNE PAR RÈGLEMENT.
  // L'identité fiscale des fournisseurs (IF/ICE) et l'instrument de paiement ne
  // sont pas dans les états déjà chargés : on les lit au moment de l'export.
  const [exportEnCours, setExportEnCours] = useState(false);
  const exportReleveDeductions = async () => {
    setExportEnCours(true);
    try {
      const [{ data: detailAchats }, { data: fournisseurs }, { data: tx }, { data: enc }, { data: pcm }] = await Promise.all([
        // RATTACHEMENT AU FOURNISSEUR : `achats` est chargé pour le calcul de la
        // TVA, qui n'a besoin que des montants — il ne porte donc ni
        // `fournisseur_id` ni `fournisseur_nom`. Sans cette clé, la jointure sur
        // l'annuaire n'a rien à chercher et les colonnes IF / Nom / ICE partent
        // vides alors que les fiches sont renseignées. On complète ici, à
        // l'export, plutôt qu'au chargement de la page : `lignes` est un jsonb
        // volumineux qui n'a d'utilité que pour la désignation DGI.
        supabase.from("factures_fournisseurs")
          .select("id,numero,fournisseur_id,fournisseur_nom,mode_reglement,date_paiement,lignes")
          .eq("dossier_id", dossierId),
        // Annuaire COMPLET : la jointure consolide les fiches en double, il ne
        // faut donc pas le restreindre au seul fournisseur pointé par la facture.
        supabase.from("fournisseurs").select("id,nom,ice,if_fiscal").eq("dossier_id", dossierId),
        (supabase.from("transactions_bancaires") as any)
          .select("facture_id,document_type,libelle,reference")
          .eq("dossier_id", dossierId).not("facture_id", "is", null),
        (supabase.from("encaissements") as any)
          .select("facture_fournisseur_id,type")
          .eq("dossier_id", dossierId).not("facture_fournisseur_id", "is", null),
        // Intitulés PCM du cabinet : nomment la catégorie de charge quand la
        // facture n'a pas de ligne détaillée.
        supabase.from("pcm_reference").select("numero,intitule").like("numero", "6%"),
      ]);

      // Montants (déjà chargés) + identité du fournisseur et détail de la pièce.
      const detail = new Map(((detailAchats ?? []) as any[]).map(d => [d.id, d]));
      const achatsComplets = achats.map(f => ({ ...f, ...(detail.get(f.id) ?? {}) }));

      const lignes = construireReleveDeductions({
        achats: achatsComplets,
        paiements,
        fournisseurs: (fournisseurs ?? []) as any[],
        modes: indexerModesPaiement("fournisseur", { transactions: tx ?? [], encaissements: enc ?? [] }),
        // `ecritures_comptables.reference_piece` porte l'id de la facture : c'est
        // ce lien qui donne le compte de charge, donc la nature de la dépense.
        comptesCharge: indexerComptesCharge(ecritures),
        intitulesPcm: Object.fromEntries(((pcm ?? []) as any[]).map(c => [c.numero, c.intitule])),
        ...bornesPeriode,
      });

      if (!lignes.length) {
        toast.error("Aucun règlement d'achat soumis à TVA sur la période — relevé vide");
        return;
      }

      const totaux = totauxReleveDeductions(lignes);
      const XLSX = await import("xlsx");
      const data = [
        [...COLONNES_RELEVE_DEDUCTIONS],
        ...lignes.map(ligneVersCellules),
        // Ligne de contrôle : ne fait pas partie du format DGI, elle sert au
        // pointage avant dépôt (à supprimer si le portail refuse un pied).
        ["TOTAUX", "", "", totaux.totalHt, totaux.totalTva, totaux.totalTtc, "", "", "", "", "", "", "", ""],
      ];
      const ws = XLSX.utils.aoa_to_sheet(data);
      ws["!cols"] = [
        { wch: 8 }, { wch: 16 }, { wch: 38 }, { wch: 14 }, { wch: 13 }, { wch: 14 },
        { wch: 14 }, { wch: 32 }, { wch: 18 }, { wch: 10 }, { wch: 9 }, { wch: 16 },
        { wch: 13 }, { wch: 13 },
      ];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Releve des deductions");
      const periode = periodeTVA !== "all" ? periodeTVA : exercice;
      XLSX.writeFile(wb, `Releve_deductions_TVA_${periode}_${dossierId.slice(0, 8)}.xlsx`);

      toast.success(`Relevé généré — ${totaux.lignes} ligne(s), TVA ${fmtMAD(totaux.totalTva)}`);
      // Contrôles avant dépôt : mieux vaut les voir ici que dans un rejet SIMPL.
      if (totaux.sansIdentiteFiscale > 0) {
        toast.error(`${totaux.sansIdentiteFiscale} ligne(s) sans IF ni ICE fournisseur — la DGI rejette le dépôt sur ce motif. Complétez l'annuaire Fournisseurs.`, { duration: 10000 });
      }
      if (totaux.sansReglementDate > 0) {
        toast.warning(`${totaux.sansReglementDate} ligne(s) datée(s) d'après la facture faute de règlement lettré — à vérifier avant dépôt`);
      }
      if (totaux.paiementAvantFacture > 0) {
        toast.warning(`${totaux.paiementAvantFacture} ligne(s) avec un règlement antérieur à la facture — anomalie de saisie à corriger`);
      }
    } catch (e: any) {
      // Un échec silencieux sur un dépôt fiscal est le pire des cas.
      console.error("[RELEVÉ DÉDUCTIONS]", e);
      toast.error(`Export impossible : ${e?.message ?? e}`);
    } finally { setExportEnCours(false); }
  };

  // ── Calendrier échéances ─────────────────────────────────────────────────────
  const now = new Date();
  const echeances = [
    { date: `${exercice}-01-31`, label: "Taxe Professionnelle — déclaration des éléments imposables", type: "tp" },
    { date: `${exercice}-03-31`, label: "DAS — Déclaration Annuelle des Salaires", type: "das" },
    { date: `${exercice}-03-31`, label: `Liasse fiscale + solde IS (clôture 31/12/${anneeN - 1})`, type: "liasse" },
    // Acomptes provisionnels : ABSENTS du calendrier du 1er exercice — une société
    // nouvellement créée n'a rien à verser, les afficher « passés / dûs » ferait
    // croire à un retard inexistant (art. 170 CGI).
    ...(is.acomptes.dus
      ? is.acomptes.echeances.map(a => ({ date: a.date, label: `${a.label} IS`, type: "is" as const }))
      : []),
  ].map(e => {
    const d = new Date(e.date);
    const jours = Math.ceil((d.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    return { ...e, jours, passe: jours < 0 };
  }).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  const paramsIncomplets = !parametres.dateDebutActivite;

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">Fiscalité</h1>
          <p className="text-muted-foreground mt-1">TVA · IS · Taxe Professionnelle · Calendrier fiscal</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={ouvrirParams}>
            <Settings2 className="h-4 w-4 mr-2" />Paramètres fiscaux
          </Button>
          <Select value={exercice} onValueChange={setExercice}>
            <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              {[2024, 2025, 2026].map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Sans date de début d'activité, aucune exonération ne peut être établie :
          on applique le droit commun et on le dit, plutôt que d'exonérer à tort. */}
      {paramsIncomplets && (
        <Card className="mb-4 border-amber-300 bg-amber-50 dark:bg-amber-950/20">
          <CardContent className="pt-4 pb-4 flex items-start gap-3 text-sm text-amber-800 dark:text-amber-300">
            <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Date de début d'activité non renseignée — régime de droit commun appliqué.</p>
              <p className="text-xs mt-1">
                Sans elle, les exonérations liées à l'ancienneté (dispense d'acomptes du 1er exercice,
                cotisation minimale des 36 premiers mois, exonération quinquennale de TP) ne peuvent pas être établies.
              </p>
              <Button variant="link" size="sm" className="h-auto p-0 mt-1 text-amber-900 dark:text-amber-200" onClick={ouvrirParams}>
                Renseigner maintenant
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="tva">TVA</TabsTrigger>
          <TabsTrigger value="is">IS</TabsTrigger>
          <TabsTrigger value="calendrier">Calendrier fiscal</TabsTrigger>
          <TabsTrigger value="tp">Taxe Professionnelle</TabsTrigger>
        </TabsList>

        {/* ── TVA ── */}
        <TabsContent value="tva" className="mt-4 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-semibold">Déclaration TVA — {exercice}</h2>
              <Badge variant="outline" className="mt-1 text-xs font-normal">{REGIME_TVA_LABEL}</Badge>
            </div>
            <div className="flex gap-2">
              <Select value={periodeTVA} onValueChange={setPeriodeTVA}>
                <SelectTrigger className="w-40">
                  <SelectValue placeholder="Toute l'année" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Toute l'année {exercice}</SelectItem>
                  {moisDisponibles.map(m => (
                    <SelectItem key={m} value={m}>{m}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button size="sm" variant="outline" onClick={exportTVA}><Download className="h-4 w-4 mr-2" />Synthèse CSV</Button>
              <Button size="sm" onClick={exportReleveDeductions} disabled={exportEnCours}>
                {exportEnCours ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <FileSpreadsheet className="h-4 w-4 mr-2" />}
                Relevé des déductions
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-4 gap-4">
            {[
              { label: "TVA collectée sur encaissements", value: collectee, note: "ventes réellement encaissées", color: "text-red-600", bg: "bg-red-50 dark:bg-red-950/20" },
              { label: "TVA déductible sur décaissements", value: recuperable, note: "achats réellement réglés", color: "text-green-600", bg: "bg-green-50 dark:bg-green-950/20" },
              {
                label: statutNet.cle === "a_payer" ? "TVA nette à PAYER" : statutNet.cle === "credit" ? "Crédit TVA" : "TVA nette — Néant",
                value: statutNet.montant, note: "collectée − déductible",
                color: statutNet.cle === "a_payer" ? "text-orange-600" : statutNet.cle === "credit" ? "text-blue-600" : "text-muted-foreground",
                bg: statutNet.cle === "a_payer" ? "bg-orange-50 dark:bg-orange-950/20" : statutNet.cle === "credit" ? "bg-blue-50 dark:bg-blue-950/20" : "bg-muted/40",
              },
              {
                label: "TVA récupérable en cours", value: tvaEnCours,
                note: "achats reçus non encore réglés — déductible au décaissement",
                color: "text-slate-600 dark:text-slate-300", bg: "bg-muted/40",
              },
            ].map(k => (
              <Card key={k.label} className={k.bg}><CardContent className="pt-4 pb-4">
                <p className="text-xs text-muted-foreground mb-1">{k.label}</p>
                <p className={`text-2xl font-bold font-mono ${k.color}`}>{fmtMAD(k.value)}</p>
                <p className="text-[11px] text-muted-foreground mt-1">{k.note}</p>
              </CardContent></Card>
            ))}
          </div>

          {/* Honnêteté sur la source : sans règlement daté, la période d'exigibilité
              est approchée par la date de facture. On chiffre l'approximation. */}
          {synthese.couverture < 0.999 && (
            <Card className="border-amber-300 bg-amber-50 dark:bg-amber-950/20">
              <CardContent className="pt-3 pb-3 text-xs text-amber-800 dark:text-amber-300">
                <span>
                  ⚠️ <strong>Rapprochement partiel</strong> : Certaines lignes de TVA sont ventilées à la
                  date de facture faute de règlement lettré dans le bancaire.
                </span>
              </CardContent>
            </Card>
          )}

          {statutNet.cle === "a_payer" && (
            <Card className="border-orange-300 bg-orange-50 dark:bg-orange-950/20">
              <CardContent className="pt-4 pb-4 text-sm text-orange-700 dark:text-orange-300">
                <p className="font-bold mb-1">📋 À verser à la DGI : {fmtMAD(statutNet.montant)}</p>
                <p className="text-xs">Régime mensuel : avant le 20 du mois suivant</p>
                <p className="text-xs">Régime trimestriel : avant le 20 du mois suivant le trimestre</p>
                <p className="text-xs mt-1">Télédéclaration : <a href="https://simpl.tax.gov.ma" target="_blank" rel="noopener" className="underline font-medium">simpl.tax.gov.ma</a></p>
              </CardContent>
            </Card>
          )}

          {statutNet.cle === "neant" && (
            <Card className="border-muted">
              <CardContent className="pt-4 pb-4 text-sm text-muted-foreground flex items-start gap-2">
                <Info className="h-4 w-4 shrink-0 mt-0.5" />
                <span>
                  Net de TVA nul : la déclaration reste <strong>obligatoire</strong> et se dépose « <strong>néant</strong> »
                  sur simpl.tax.gov.ma. Un net à zéro n'est pas un crédit de TVA.
                </span>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">TVA par mois d'exigibilité</CardTitle>
              <p className="text-xs text-muted-foreground font-normal">
                {REGIME_TVA_LABEL} · chaque règlement porte sa TVA au mois où il a été encaissé / décaissé,
                et non au mois de la facture.
              </p>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader><TableRow>
                  <TableHead>Mois</TableHead>
                  <TableHead className="text-right">Collectée (encaissée)</TableHead>
                  <TableHead className="text-right">Déductible (décaissée)</TableHead>
                  <TableHead className="text-right">Nette</TableHead>
                  <TableHead>Statut</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {tvaMensuelle.length === 0
                    ? <TableRow><TableCell colSpan={5} className="text-center py-6 text-muted-foreground">Aucun encaissement ni décaissement soumis à TVA</TableCell></TableRow>
                    : tvaMensuelle.map(m => (
                      <TableRow key={m.mois}>
                        <TableCell className="font-mono text-sm">{m.mois}</TableCell>
                        <TableCell className="text-right font-mono text-sm text-red-600">{fmt(m.collectee)}</TableCell>
                        <TableCell className="text-right font-mono text-sm text-green-600">{fmt(m.recuperable)}</TableCell>
                        <TableCell className={`text-right font-mono text-sm font-bold ${
                          m.statut.cle === "a_payer" ? "text-orange-600" : m.statut.cle === "credit" ? "text-blue-600" : "text-muted-foreground"
                        }`}>{fmt(m.statut.montant)}</TableCell>
                        <TableCell>
                          <Badge
                            variant={m.statut.cle === "a_payer" ? "destructive" : m.statut.cle === "credit" ? "default" : "secondary"}
                            className="text-xs"
                          >{m.statut.label}</Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── IS ── */}
        <TabsContent value="is" className="mt-4 space-y-4">
          <div>
            <div className="flex items-center gap-3">
              <h2 className="font-semibold">Impôt sur les Sociétés — {exercice}</h2>
              {is.situation.premierExercice && (
                <Badge variant="outline" className="text-sky-700 border-sky-300">1er exercice</Badge>
              )}
              {is.regime === "taux_specifique" && (
                <Badge variant="outline" className="text-violet-700 border-violet-300">Statut spécifique — 20 % plafonné</Badge>
              )}
            </div>
            {/* Le résultat comptable n'est pas le résultat fiscal : réintégrations,
                déductions et reports déficitaires n'arrivent qu'à la liasse. */}
            <Badge variant="secondary" className="mt-2 font-normal text-muted-foreground">
              Calcul indicatif au fil de l'eau (avant retraitements extra-comptables de fin d'exercice).
            </Badge>
          </div>

          <div className="grid grid-cols-2 gap-6">
            <Card>
              <CardHeader><CardTitle className="text-sm flex items-center gap-2"><Calculator className="h-4 w-4" />Calcul IS</CardTitle></CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {[
                    { label: "Chiffre d'affaires HT (71)", value: fmtMAD(agrN.ca) },
                    { label: "Total produits (classe 7)", value: fmtMAD(agrN.produits) },
                    { label: "Total charges (classe 6)", value: fmtMAD(agrN.charges) },
                    { label: "Résultat fiscal", value: fmtMAD(is.resultatFiscal), bold: true },
                    { label: `Taux IS (${is.tranche.label})`, value: pourcent(is.tranche.taux) },
                    { label: "IS théorique", value: fmtMAD(is.isTheorique) },
                    {
                      label: is.cotisationMinimale.applicable
                        ? `Cotisation minimale (${pourcent(is.cotisationMinimale.taux)} des produits)`
                        : "Cotisation minimale — exonérée",
                      value: fmtMAD(is.cotisationMinimale.montant),
                    },
                  ].map(r => (
                    <div key={r.label} className="flex justify-between text-sm border-b pb-2">
                      <span className="text-muted-foreground">{r.label}</span>
                      <span className={`font-mono ${(r as any).bold ? "font-bold" : ""}`}>{r.value}</span>
                    </div>
                  ))}

                  {!is.cotisationMinimale.applicable && is.cotisationMinimale.motif && (
                    <p className="text-xs text-emerald-700 dark:text-emerald-400 flex items-start gap-1.5">
                      <ShieldCheck className="h-3.5 w-3.5 shrink-0 mt-0.5" />{is.cotisationMinimale.motif}
                    </p>
                  )}
                  {is.cotisationMinimale.plancherApplique && (
                    <p className="text-xs text-muted-foreground">
                      Plancher légal de 3 000 MAD appliqué (art. 144 CGI).
                    </p>
                  )}

                  <div className="flex justify-between text-sm border-b pb-2">
                    <span className="text-muted-foreground">IS dû = max(IS théorique ; CM)</span>
                    <span className="font-mono font-bold">{fmtMAD(is.isDu)}</span>
                  </div>
                  <div className="flex justify-between text-sm border-b pb-2">
                    <span className="text-muted-foreground">− Acomptes versés en {exercice}</span>
                    <span className="font-mono">{fmtMAD(is.acomptes.total)}</span>
                  </div>

                  <div className="flex justify-between font-bold text-base pt-2">
                    <span>{is.excedent > 0 ? "EXCÉDENT D'ACOMPTES" : "IS À PAYER (reliquat)"}</span>
                    <span className={`font-mono ${is.excedent > 0 ? "text-blue-600" : "text-orange-600"}`}>
                      {fmtMAD(is.excedent > 0 ? is.excedent : is.isAPayer)}
                    </span>
                  </div>
                  {is.excedent > 0 && (
                    <p className="text-xs text-blue-700 dark:text-blue-300">
                      Excédent imputable d'office sur les acomptes de l'exercice suivant (art. 170 CGI).
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Reliquat à verser avant le 31/03/{anneeN + 1}, avec le dépôt de la liasse fiscale.
                  </p>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-sm">Acomptes provisionnels {exercice}</CardTitle></CardHeader>
              <CardContent>
                {!is.acomptes.dus ? (
                  // 1er exercice : aucun acompte n'est dû, faute d'exercice de référence.
                  <div className="rounded-xl border border-emerald-300 bg-emerald-50 dark:bg-emerald-950/20 p-4">
                    <div className="flex items-start gap-2 text-emerald-800 dark:text-emerald-300">
                      <ShieldCheck className="h-5 w-5 shrink-0 mt-0.5" />
                      <div>
                        <p className="font-medium text-sm">{is.acomptes.motif}</p>
                        <p className="text-xs mt-1">
                          Les acomptes sont assis sur l'IS dû de l'exercice précédent : une société
                          nouvellement créée n'en a aucun, elle est donc dispensée de versement.
                          Le premier acompte interviendra en {anneeN + 1}, sur la base de l'IS {exercice}.
                        </p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="mb-4 rounded-lg bg-muted/50 p-3 text-xs">
                      <p className="font-medium">
                        Base légale : IS dû de {anneeN - 1} = <strong>{fmtMAD(is.acomptes.base)}</strong>
                      </p>
                      <p className="text-muted-foreground mt-1">
                        Chaque acompte = IS {anneeN - 1} ÷ 4 = <strong>{fmtMAD(is.acomptes.montantUnitaire)}</strong>.
                        Le résultat de {exercice}, inconnu au moment des versements, n'entre pas dans ce calcul.
                      </p>
                      {!donneesN1 && (
                        <p className="text-amber-700 dark:text-amber-400 mt-1">
                          Aucune écriture sur l'exercice {anneeN - 1} : base d'acomptes calculée à 0.
                        </p>
                      )}
                    </div>
                    <div className="space-y-2">
                      {is.acomptes.echeances.map(a => {
                        const jours = Math.ceil((new Date(a.date).getTime() - now.getTime()) / 86400000);
                        return (
                          <div key={a.label} className={`flex justify-between items-center p-2 rounded text-sm ${jours < 0 ? "bg-muted" : jours < 30 ? "bg-red-50 dark:bg-red-950/20" : "bg-blue-50 dark:bg-blue-950/20"}`}>
                            <div>
                              <span className="font-medium">{a.label}</span>
                              <span className="text-xs text-muted-foreground ml-2">{formatDateFr(a.date)}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-sm font-bold">{fmtMAD(a.montant)}</span>
                              {jours < 0 ? <Badge variant="secondary" className="text-xs">Passé</Badge> :
                               jours < 30 ? <Badge variant="destructive" className="text-xs">Dans {jours}j</Badge> :
                               <Badge variant="outline" className="text-xs">Dans {jours}j</Badge>}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}

                <div className="mt-4 p-3 bg-blue-50 dark:bg-blue-950/20 rounded text-xs text-blue-700 dark:text-blue-300">
                  <p className="font-medium">Barème IS Maroc {exercice} (LF 2026) :</p>
                  {BAREME_IS.map(t => (
                    <p key={t.label}>{t.label} → {pourcent(t.taux)}</p>
                  ))}
                  <p>Statut spécifique (export, ZAI, CFC…) → {pourcent(TAUX_IS_SPECIFIQUE)} plafonné</p>
                  <p className="mt-1">CM = {pourcent(TAUX_CM_DROIT_COMMUN)} des produits (art. 144 CGI), minimum 3 000 MAD.</p>
                  <p>Exonération de CM pendant les 36 premiers mois d'activité.</p>
                  <p>Acomptes : fin des 3e, 6e, 9e et 12e mois de l'exercice, sur l'IS de N-1 (art. 170 CGI).</p>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ── CALENDRIER ── */}
        <TabsContent value="calendrier" className="mt-4">
          <h2 className="font-semibold mb-4">Calendrier fiscal {exercice}</h2>
          <div className="space-y-2">
            {!is.acomptes.dus && (
              <div className="p-4 rounded-xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/20">
                <div className="flex items-center gap-3">
                  <ShieldCheck className="h-5 w-5 text-emerald-600" />
                  <div>
                    <p className="font-medium text-sm text-emerald-800 dark:text-emerald-300">Acomptes IS — aucun versement dû en {exercice}</p>
                    <p className="text-xs text-emerald-700 dark:text-emerald-400">{is.acomptes.motif}</p>
                  </div>
                </div>
              </div>
            )}

            {echeances.map((e, i) => (
              <div key={i} className={`flex items-center justify-between p-4 rounded-xl border ${
                e.passe ? "bg-muted border-muted opacity-60" :
                e.jours < 30 ? "bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800" :
                e.jours < 90 ? "bg-yellow-50 dark:bg-yellow-950/20 border-yellow-200" :
                "bg-blue-50 dark:bg-blue-950/20 border-blue-200"
              }`}>
                <div className="flex items-center gap-3">
                  {e.passe ? <CheckCircle className="h-5 w-5 text-muted-foreground" /> :
                   e.jours < 30 ? <AlertCircle className="h-5 w-5 text-red-500" /> :
                   <Clock className="h-5 w-5 text-blue-500" />}
                  <div>
                    <p className={`font-medium text-sm ${e.passe ? "text-muted-foreground" : ""}`}>{e.label}</p>
                    <p className="text-xs text-muted-foreground">{new Date(e.date).toLocaleDateString("fr-MA", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</p>
                  </div>
                </div>
                <div className="text-right">
                  {e.passe
                    ? <Badge variant="secondary" className="text-xs">Passée</Badge>
                    : e.jours < 30
                    ? <Badge variant="destructive" className="text-xs">⚠️ Dans {e.jours} jours</Badge>
                    : <Badge variant="outline" className="text-xs">Dans {e.jours} jours</Badge>}
                  {e.type === "is" && !e.passe && (
                    <p className="text-xs font-mono font-bold text-orange-600 mt-1">{fmtMAD(is.acomptes.montantUnitaire)}</p>
                  )}
                </div>
              </div>
            ))}

            {/* TVA mensuelle récurrente */}
            <div className="p-4 rounded-xl border bg-muted/30">
              <p className="font-medium text-sm mb-1">🔄 Déclaration TVA mensuelle</p>
              <p className="text-xs text-muted-foreground">Avant le 20 de chaque mois (régime mensuel) ou le 20 du mois suivant le trimestre (régime trimestriel)</p>
              <p className="text-xs mt-1 font-medium text-orange-600">
                Prochain : 20/{String(now.getMonth() + 2).padStart(2, "0")}/{now.getFullYear()} — {
                  tvaMensuelle[0] ? `${fmtMAD(tvaMensuelle[0].statut.montant)} (${tvaMensuelle[0].statut.label})` : fmtMAD(0)
                }
              </p>
            </div>

            <div className="p-4 rounded-xl border bg-muted/30">
              <p className="font-medium text-sm mb-1">🔄 CNSS / AMO mensuel</p>
              <p className="text-xs text-muted-foreground">Avant le 10 de chaque mois</p>
            </div>
          </div>
        </TabsContent>

        {/* ── TAXE PROFESSIONNELLE ── */}
        <TabsContent value="tp" className="mt-4 space-y-4">
          <h2 className="font-semibold">Taxe Professionnelle — {exercice}</h2>

          {tp.exonere && (
            <Card className="border-emerald-300 bg-emerald-50 dark:bg-emerald-950/20">
              <CardContent className="pt-4 pb-4 flex items-start gap-3">
                <ShieldCheck className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
                <div className="text-emerald-800 dark:text-emerald-300">
                  <p className="font-bold text-sm">{tp.motif}</p>
                  <p className="font-mono text-2xl font-bold mt-1">{fmtMAD(0)}</p>
                  {tp.premiereAnneeImposable != null && (
                    <p className="text-xs mt-1">
                      Première année d'imposition : <strong>{tp.premiereAnneeImposable}</strong>.
                      La déclaration annuelle des éléments imposables reste due chaque 31 janvier.
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="pt-6 pb-6">
              <div className="grid grid-cols-4 gap-4 mb-6">
                <div className="p-4 bg-muted rounded-xl">
                  <p className="text-xs text-muted-foreground mb-1">Base imposable — valeur locative annuelle</p>
                  {tp.baseManquante ? (
                    // Afficher « 0,00 MAD » ferait passer une donnée MANQUANTE pour une
                    // base réelle, et donc une TP à 0 pour un calcul abouti.
                    <>
                      <p className="font-mono font-bold text-xl text-muted-foreground">Non renseignée</p>
                      <Button variant="outline" size="sm" className="mt-2 h-7 text-xs" onClick={ouvrirParams}>
                        <Settings2 className="h-3.5 w-3.5 mr-1.5" />
                        Renseigner le bail / loyer annuel
                      </Button>
                    </>
                  ) : (
                    <p className="font-mono font-bold text-xl">{fmtMAD(tp.base)}</p>
                  )}
                </div>
                <div className="p-4 bg-muted rounded-xl">
                  <p className="text-xs text-muted-foreground mb-1">Taux (classe {tp.classe})</p>
                  <p className="font-mono font-bold text-xl">{pourcent(tp.taux)}</p>
                </div>
                <div className="p-4 bg-muted rounded-xl">
                  <p className="text-xs text-muted-foreground mb-1">TP {exercice}</p>
                  {/* Hors exonération, une base absente ne donne pas une TP nulle :
                      elle donne une TP non calculable. */}
                  {tp.baseManquante && !tp.exonere ? (
                    <p className="font-mono font-bold text-xl text-muted-foreground">—</p>
                  ) : (
                    <p className={`font-mono font-bold text-xl ${tp.exonere ? "text-emerald-600" : "text-orange-600"}`}>{fmtMAD(tp.montant)}</p>
                  )}
                </div>
                <div className="p-4 bg-muted rounded-xl">
                  <p className="text-xs text-muted-foreground mb-1">Échéance déclaration</p>
                  <p className="font-mono font-bold text-xl">31/01/{anneeN + 1}</p>
                </div>
              </div>

              <div className="p-4 bg-blue-50 dark:bg-blue-950/20 rounded-xl text-sm text-blue-700 dark:text-blue-300">
                <p className="font-medium mb-2">ℹ️ Taxe Professionnelle au Maroc</p>
                <p>
                  Base = <strong>valeur locative annuelle</strong> des locaux (bail / loyer), du matériel et de
                  l'outillage. Le <strong>chiffre d'affaires n'entre jamais</strong> dans le calcul de la TP.
                </p>
                <p className="mt-1">Taux selon la classe de la nomenclature des professions : classe 3 → 10 %, classe 2 → 20 %, classe 1 → 30 %.</p>
                <p className="mt-1">Exonération totale les 5 premières années d'activité (art. 6).</p>
                <p className="mt-1">Le montant définitif est établi et notifié par la commune sur la base de la déclaration annuelle — ce calcul est une estimation.</p>
                <p className="mt-2 font-medium">Déclaration à déposer avant le <strong>31 janvier {anneeN + 1}</strong> auprès de votre commune.</p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* ── Paramètres fiscaux du dossier ── */}
      <Dialog open={openParams} onOpenChange={setOpenParams}>
        <DialogContent>
          <DialogHeader><DialogTitle>Paramètres fiscaux du dossier</DialogTitle></DialogHeader>
          <form onSubmit={enregistrerParams} className="space-y-4">
            <div className="space-y-2">
              <Label>Date de début d'activité</Label>
              <DatePicker value={formParams.date_debut_activite} onChange={(iso) => setFormParams({ ...formParams, date_debut_activite: iso })} />
              <p className="text-xs text-muted-foreground">
                Commande la dispense d'acomptes du 1er exercice (art. 170), l'exonération de cotisation
                minimale des 36 premiers mois (art. 144) et l'exonération quinquennale de TP (art. 6).
              </p>
            </div>
            <div className="space-y-2">
              <Label>Régime d'imposition IS</Label>
              <Select value={formParams.regime_is} onValueChange={(v) => setFormParams({ ...formParams, regime_is: v as RegimeIS })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="droit_commun">Droit commun — 20 % (&lt; 100 MDH) puis 35 %</SelectItem>
                  <SelectItem value="taux_specifique">Statut spécifique — 20 % plafonné (export, ZAI, CFC)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Les PME relèvent du droit commun : tout bénéfice inférieur à 100 MDH y est imposé à 20 %.
                Le statut spécifique maintient ce taux au-delà de 100 MDH.
              </p>
            </div>
            <div className="space-y-2">
              <Label>Valeur locative annuelle (base TP)</Label>
              <Input inputMode="decimal" placeholder="ex. 120000" value={formParams.valeur_locative_tp}
                onChange={(e) => setFormParams({ ...formParams, valeur_locative_tp: e.target.value })} />
              <p className="text-xs text-muted-foreground">
                Loyer annuel du local (bail) + valeur locative du matériel et de l'outillage. Jamais le chiffre d'affaires.
              </p>
            </div>
            <div className="space-y-2">
              <Label>Classe de la nomenclature (taux TP)</Label>
              <Select value={formParams.classe_tp} onValueChange={(v) => setFormParams({ ...formParams, classe_tp: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CLASSES_TP.map(c => <SelectItem key={c.classe} value={String(c.classe)}>{c.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpenParams(false)}>Annuler</Button>
              <Button type="submit" disabled={savingParams}>
                {savingParams && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Enregistrer
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
