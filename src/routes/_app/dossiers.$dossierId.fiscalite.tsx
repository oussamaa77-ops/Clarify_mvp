import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
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
  baremeIS, CLASSES_TP, CLASSE_TP_DEFAUT, REGIME_TVA_LABEL, TAUX_CM_DROIT_COMMUN,
  TAUX_IS_ETABLISSEMENT_CREDIT, TAUX_IS_SPECIFIQUE, agregatsFiscaux, calculerIS, calculerTP, imputerDeficits,
  formatDateFr, lireAjustementsFiscaux, lireParametresFiscaux, normaliserRegimeIS, resultatFiscal,
  statutTva, type RegimeIS,
} from "@/lib/fiscalite-ma";
import {
  synthetiserTva, tvaRecuperableEnCours, periodesTva, bornesDuMois, echeanceSimplTva, classerDeductibiliteAchats,
  calendrierTva, etatsDeclarationsTva, periodiciteTva, prochaineEcheanceTva, reglementsParCompensation,
  type PeriodiciteTva, type SituationTva,
} from "@/lib/dashboard-fiscal";

/** Taille de page PostgREST : au-delà, une requête unique est tronquée en silence. */
const PAGE_ECRITURES = 1000;

/**
 * TOUTES les écritures du dossier, page par page. Une lecture unique plafonnait
 * à 1 000 lignes : sur un dossier actif, le résultat fiscal et l'IS étaient
 * calculés sur une partie du grand livre seulement, sans aucun avertissement.
 */
async function chargerToutesEcritures(dossierId: string): Promise<any[]> {
  const toutes: any[] = [];
  for (let debut = 0; ; debut += PAGE_ECRITURES) {
    const { data, error } = await supabase.from("ecritures_comptables").select("*")
      .eq("dossier_id", dossierId).order("id", { ascending: true })
      .range(debut, debut + PAGE_ECRITURES - 1);
    if (error) throw error;
    toutes.push(...(data ?? []));
    if (!data || data.length < PAGE_ECRITURES) return toutes;
  }
}

/** Date locale → AAAA-MM-JJ (sans passer par l'UTC, qui décalerait d'un jour). */
function isoLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}


import {
  COLONNES_RELEVE_DEDUCTIONS, construireReleveDeductions, indexerComptesCharge,
  ligneVersCellules, totauxReleveDeductions,
} from "@/lib/releve-deductions";
import { indexerModesPaiement } from "@/lib/mode-paiement";
import { DeclarationTvaPanel } from "@/components/DeclarationTvaPanel";

// `?tab=declaration&periode=AAAA-MM` : le dashboard envoie ici depuis « Déclarer
// la TVA », sur la période dont il vient d'afficher l'échéance. Sans ces deux
// paramètres, l'utilisateur retomberait sur l'onglet TVA et devrait retrouver
// lui-même la période — soit exactement le pas de côté que le bouton évite.
export const Route = createFileRoute("/_app/dossiers/$dossierId/fiscalite")({
  component: FiscalitePage,
  validateSearch: (s: Record<string, unknown>): { tab?: string; periode?: string } => ({
    tab: typeof s.tab === "string" ? s.tab : undefined,
    periode: typeof s.periode === "string" ? s.periode : undefined,
  }),
});

const fmt = (n: number) => Number(n).toLocaleString("fr-MA", { minimumFractionDigits: 2 });
const fmtMAD = (n: number) => fmt(n) + " MAD";
const pourcent = (t: number) => `${(t * 100).toLocaleString("fr-MA", { maximumFractionDigits: 2 })} %`;

function FiscalitePage() {
  const { dossierId } = Route.useParams();
  const recherche = Route.useSearch();
  const [ecritures, setEcritures] = useState<any[]>([]);
  const [ventes, setVentes] = useState<any[]>([]);
  const [achats, setAchats] = useState<any[]>([]);
  const [paiements, setPaiements] = useState<any[]>([]);
  // Récépissés SIMPL-TVA (bucket quittances-tva) : la preuve de DÉPÔT d'une déclaration.
  const [recepisses, setRecepisses] = useState<string[]>([]);
  // Conventions de compensation : n° de pièce → date réelle de signature.
  const [signaturesCompensation, setSignaturesCompensation] = useState<Map<string, string>>(new Map());
  const [dossier, setDossier] = useState<any>(null);
  const [tab, setTab] = useState(recherche.tab ?? "tva");
  const [periodeTVA, setPeriodeTVA] = useState("all");
  const [exercice, setExercice] = useState(new Date().getFullYear().toString());

  // Paramètres fiscaux du dossier (édition sur place — ils commandent toutes les
  // exonérations du module, on ne veut pas obliger à ressortir vers /dossiers).
  const [openParams, setOpenParams] = useState(false);
  const [savingParams, setSavingParams] = useState(false);
  const [formParams, setFormParams] = useState<{
    date_debut_activite: string | null; valeur_locative_tp: string; classe_tp: string; regime_is: RegimeIS;
    // Ajustements de l'EXERCICE affiché (tableau de passage + base des acomptes).
    reintegrations: string; deductions: string; is_du_precedent: string; deficits_anterieurs: string;
    /** Situation déclarative (art. 108 CGI) — "" = droit commun. */
    situation_tva: "" | SituationTva;
    /** Périodicité RETENUE pour l'exercice affiché — "" = déterminée par les règles. */
    periodicite_exercice: "" | PeriodiciteTva;
  }>({
    date_debut_activite: null, valeur_locative_tp: "", classe_tp: String(CLASSE_TP_DEFAUT), regime_is: "droit_commun",
    reintegrations: "", deductions: "", is_du_precedent: "", deficits_anterieurs: "", situation_tva: "", periodicite_exercice: "",
  });

  const chargerDossier = async () => {
    // select("*") : les colonnes fiscales peuvent ne pas encore exister en base
    // (migration 20260804120000 non appliquée) — la lecture doit rester tolérante.
    const { data } = await supabase.from("dossiers").select("*").eq("id", dossierId).maybeSingle();
    setDossier(data ?? null);
  };

  // Rappelable : le panneau de déclaration TVA écrit dans le grand livre, et
  // c'est le MÊME grand livre qui nourrit le résultat fiscal et l'IS de cette
  // page. Sans relecture, l'onglet voisin resterait sur l'état d'avant l'OD.
  const chargerDonnees = useCallback(async () => {
    {
      const [ecr, { data: v }, { data: a }, { data: p }] = await Promise.all([
        // Écritures : base du résultat fiscal et de l'IS (les factures ne portent
        // ni compte ni charge — seul le grand livre le fait). Paginé : cf.
        // chargerToutesEcritures.
        chargerToutesEcritures(dossierId).catch((e) => {
          toast.error(`Lecture du grand livre incomplète : ${e?.message ?? e}`);
          return [] as any[];
        }),
        // TVA : régime de l'encaissement → factures + leurs règlements, jamais
        // les comptes 44551/34552 qui suivent le fait générateur comptable.
        supabase.from("factures")
          .select("id,numero,statut,statut_paiement,montant_ht,montant_tva,montant_ttc,montant_paye,montant_restant,type,date_facture,date_echeance")
          .eq("dossier_id", dossierId),
        supabase.from("factures_fournisseurs")
          // `*` : la colonne `type` (avoir fournisseur) n'existe qu'après la migration 20261103130000.
          .select("*")
          .eq("dossier_id", dossierId),
        // Règlements datés : donnent au mois d'EXIGIBILITÉ sa vraie date. La table
        // peut ne pas exister (migration du moteur de paiement non appliquée) —
        // `synthetiserTva` retombe alors sur la date de facture.
        supabase.from("paiements")
          // `origine` + `reference` : une imputation d'AVOIR n'est pas un encaissement,
          // et c'est par sa référence qu'elle désigne l'avoir imputé.
          .select("facture_id,facture_fournisseur_id,montant,date_paiement,origine,reference")
          .eq("dossier_id", dossierId),
      ]);
      setEcritures(ecr ?? []);
      // Les factures non conformes (rejetées / en analyse) n'ouvrent aucun droit
      // à déduction ni aucune exigibilité : elles ne sont pas des pièces fiscales.
      setVentes((v ?? []).filter((f: any) => f.statut !== "rejetee"));
      setAchats(a ?? []);
      setPaiements(p ?? []);
      // Lectures tolérantes : sans bucket ou sans colonne (migration), rien n'est
      // présumé — aucune déclaration n'est réputée déposée, aucune compensation admise.
      try {
        const { data: fichiers } = await supabase.storage.from("quittances-tva").list(dossierId, { limit: 1000 });
        setRecepisses(((fichiers ?? []) as any[]).map((x) => x.name));
      } catch { setRecepisses([]); }
      try {
        const { data: conv, error: eConv } = await (supabase.from("justificatifs") as any)
          .select("numero_piece,date_signature,signature_parties").eq("dossier_id", dossierId).eq("categorie_pcm", "convention_compensation");
        setSignaturesCompensation(new Map(eConv ? [] : ((conv ?? []) as any[])
          .filter((c) => c.date_signature && c.signature_parties === true)
          .map((c) => [String(c.numero_piece ?? "").trim(), String(c.date_signature).slice(0, 10)])));
      } catch { setSignaturesCompensation(new Map()); }
    }
  }, [dossierId]);

  useEffect(() => {
    chargerDonnees();
    chargerDossier();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dossierId]);

  const parametres = useMemo(() => lireParametresFiscaux(dossier), [dossier]);
  const ajustements = useMemo(() => lireAjustementsFiscaux(dossier, Number(exercice)), [dossier, exercice]);

  const ouvrirParams = () => {
    const brut = (dossier?.ajustements_fiscaux ?? {})[exercice] ?? {};
    const champ = (v: unknown) => (v == null || v === "" ? "" : String(v));
    setFormParams({
      date_debut_activite: parametres.dateDebutActivite,
      valeur_locative_tp: parametres.valeurLocative != null ? String(parametres.valeurLocative) : "",
      classe_tp: String(parametres.classeTP ?? CLASSE_TP_DEFAUT),
      regime_is: parametres.regimeIS,
      reintegrations: champ(brut.reintegrations),
      deductions: champ(brut.deductions),
      is_du_precedent: champ(brut.is_du_precedent),
      deficits_anterieurs: champ(brut.deficits_anterieurs),
      situation_tva: ["option_mensuelle", "saisonniere", "non_resident"].includes(dossier?.periodicite_tva) ? dossier.periodicite_tva : "",
      periodicite_exercice: brut.periodicite_tva === "mensuel" || brut.periodicite_tva === "trimestriel" ? brut.periodicite_tva : "",
    });
    setOpenParams(true);
  };

  const enregistrerParams = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingParams(true);
    try {
      const nombre = (s: string) => {
        const t = s.trim().replace(/\s/g, "").replace(",", ".");
        return t === "" ? null : Number(t);
      };
      const saisis = [formParams.valeur_locative_tp, formParams.reintegrations, formParams.deductions, formParams.is_du_precedent, formParams.deficits_anterieurs];
      if (saisis.some((s) => { const x = nombre(s); return x !== null && (!isFinite(x) || x < 0); })) {
        toast.error("Les montants doivent être des nombres positifs.");
        return;
      }
      const base = {
        date_debut_activite: formParams.date_debut_activite || null,
        valeur_locative_tp: nombre(formParams.valeur_locative_tp),
        classe_tp: Number(formParams.classe_tp),
        regime_is: formParams.regime_is,
      };
      // Ajustements rangés par millésime : modifier 2026 ne touche pas 2025.
      const ajustementsFiscaux = {
        ...(dossier?.ajustements_fiscaux ?? {}),
        [exercice]: {
          reintegrations: nombre(formParams.reintegrations),
          deductions: nombre(formParams.deductions),
          is_du_precedent: nombre(formParams.is_du_precedent),
          deficits_anterieurs: nombre(formParams.deficits_anterieurs),
          // Figée pour CETTE année : un changement ultérieur de CA ou de situation
          // ne réécrit pas l'historique déclaratif.
          periodicite_tva: formParams.periodicite_exercice || null,
        },
      };
      let { error } = await (supabase.from("dossiers") as any)
        .update({ ...base, ajustements_fiscaux: ajustementsFiscaux, periodicite_tva: formParams.situation_tva || null }).eq("id", dossierId);
      if (error && /ajustements_fiscaux|periodicite_tva/i.test(error.message ?? "")) {
        // Migrations 20261103120000 / 20261103130000 non appliquées : on enregistre le reste.
        ({ error } = await (supabase.from("dossiers") as any).update(base).eq("id", dossierId));
        if (!error) toast.warning("Ajustements fiscaux ou périodicité TVA non enregistrés : appliquez les migrations 20261103120000 et 20261103130000.");
      }
      if (error) {
        // Cause la plus probable : migration des paramètres fiscaux non appliquée.
        toast.error(/regime_is_check/i.test(error.message ?? "")
          ? "Régime « établissement de crédit » refusé par la base : appliquez la migration 20261103120000."
          : `Enregistrement impossible : ${error.message}`);
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

  // `ecritures` : ajoute la TVA née en trésorerie sans facture (frais bancaires,
  // justificatifs) — elle figure dans l'OD de liquidation, elle doit figurer ici.
  // Achats dont la TVA n'est pas déductible, lus au grand livre : la synthèse, le
  // relevé des déductions et l'OD de liquidation s'appuient sur la même source.
  const deductibilite = classerDeductibiliteAchats(achats, ecritures);
  const achatsExclus = deductibilite.exclus;
  const achatsNonClasses = achats.filter((f: any) => deductibilite.nonClasses.has(String(f.id)));
  // Règlements par COMPENSATION (OD COMP- lettrées avec la facture), datés de la
  // signature de la convention : la table paiements ne les porte pas.
  const paiementsComplets = [
    ...paiements,
    ...reglementsParCompensation(ecritures, ventes, "client", signaturesCompensation),
    ...reglementsParCompensation(ecritures, achats, "fournisseur", signaturesCompensation),
  ];
  const synthese = synthetiserTva(ventes, achats, { ...bornesPeriode, paiements: paiementsComplets, ecritures, achatsExclus });
  const collectee = synthese.collectee;
  const recuperable = synthese.deductible;
  const statutNet = statutTva(synthese.nette);
  // TVA des achats reçus mais NON réglés : pas encore déductible, elle le deviendra
  // au décaissement. Distincte de la déductible du mois, jamais confondue avec elle.
  const tvaEnCours = tvaRecuperableEnCours(achats.filter((f: any) => !achatsExclus.has(String(f.id))));

  // Périodes = mois d'exigibilité (encaissement daté, ou facture à défaut).
  const moisDisponibles = periodesTva(ventes, achats, paiements, ecritures);
  const tvaMensuelle = moisDisponibles.map(m => {
    const bornes = bornesDuMois(m)!;
    const s = synthetiserTva(ventes, achats, { ...bornes, paiements: paiementsComplets, ecritures, achatsExclus });
    return { mois: m, collectee: s.collectee, recuperable: s.deductible, statut: statutTva(s.nette) };
  });

  // ── Agrégats comptables par exercice ─────────────────────────────────────────
  const anneeN = Number(exercice);
  // Résultat AVANT impôt (l'IS comptabilisé en 67 n'ampute pas sa propre base),
  // base de CM limitée aux produits visés par l'art. 144-I-B — cf. agregatsFiscaux.
  const agrN = agregatsFiscaux(ecritures, anneeN);
  const agrN1 = agregatsFiscaux(ecritures, anneeN - 1);

  // ── Calendrier déclaratif TVA ────────────────────────────────────────────────
  // Échéances lues sur la PÉRIODICITÉ du dossier (paramètre, sinon CA N-1, art.
  // 108 CGI), les dates et l'état de déclaration au grand livre — jamais sur
  // l'existence de factures : une période sans opération se déclare aussi.
  // Périodicité de CHAQUE année (art. 108) : CA taxable de l'année précédente lu
  // au grand livre (711 + 712), situation du dossier, périodicité figée par année.
  const caTaxable = (annee: number) => { const a = agregatsFiscaux(ecritures, annee); return a.nbEcritures > 0 ? a.ca : null; };
  const periodiciteDe = (annee: number) => periodiciteTva(dossier, annee, caTaxable(annee - 1));
  const periodicite = periodiciteDe(anneeN);
  const etatsTva = etatsDeclarationsTva(ecritures, recepisses);
  const calendrier = calendrierTva({
    periodicite: (annee) => periodiciteDe(annee).periodicite,
    etats: etatsTva,
    dateDebutActivite: parametres.dateDebutActivite,
  });
  const echeanceDue = prochaineEcheanceTva(calendrier);
  const LIBELLE_STATUT_TVA = { en_cours: "En cours", a_declarer: "À déclarer", en_retard: "Non déposée — en retard", a_payer: "Déposée — à payer", reglee: "Déposée et réglée" } as const;
  const ajustementsN1 = lireAjustementsFiscaux(dossier, anneeN - 1);
  const imputationN = imputerDeficits(agrN, ajustements);
  const resultatFiscalN = imputationN.resultatFiscal;

  // ── Calculs IS ───────────────────────────────────────────────────────────────
  // Les acomptes versés en N s'assoient sur l'IS DÛ DE N-1. Ordre de priorité de
  // cette base : le montant SAISI (IS réellement liquidé sur la liasse N-1, seul
  // à faire foi), à défaut le recalcul sur le grand livre N-1 s'il existe, à
  // défaut rien — et l'écran le signale au lieu d'afficher des acomptes à zéro.
  const donneesN1 = agrN1.nbEcritures > 0;
  const isN1 = calculerIS({
    exercice: anneeN - 1,
    resultatFiscal: resultatFiscal(agrN1, ajustementsN1),
    baseCotisationMinimale: agrN1.baseCotisationMinimale,
    dateDebutActivite: parametres.dateDebutActivite,
    tauxCotisationMinimale: parametres.tauxCM ?? undefined,
    regime: parametres.regimeIS,
  });
  const baseAcomptesSaisie = ajustements.isDuPrecedent != null;
  const baseAcomptesInconnue = !baseAcomptesSaisie && !donneesN1;
  const is = calculerIS({
    exercice: anneeN,
    resultatFiscal: resultatFiscalN,
    baseCotisationMinimale: agrN.baseCotisationMinimale,
    dateDebutActivite: parametres.dateDebutActivite,
    isDuExercicePrecedent: baseAcomptesSaisie ? ajustements.isDuPrecedent! : donneesN1 ? isN1.isDu : 0,
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
          .select("*")
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

      const rejets: string[] = [];
      const lignes = construireReleveDeductions({
        achats: achatsComplets,
        // Compensations comprises : un règlement codé 6, daté de la signature.
        paiements: paiementsComplets,
        fournisseurs: (fournisseurs ?? []) as any[],
        modes: indexerModesPaiement("fournisseur", { transactions: tx ?? [], encaissements: enc ?? [] }),
        // `ecritures_comptables.reference_piece` porte l'id de la facture : c'est
        // ce lien qui donne le compte de charge, donc la nature de la dépense.
        comptesCharge: indexerComptesCharge(ecritures),
        intitulesPcm: Object.fromEntries(((pcm ?? []) as any[]).map(c => [c.numero, c.intitule])),
        ...bornesPeriode,
        achatsExclus,
        rejets,
      });
      if (rejets.length) {
        toast.warning(`${rejets.length} achat(s) écarté(s) du relevé — champs SIMPL-TVA obligatoires manquants : ${rejets.slice(0, 3).join(" · ")}${rejets.length > 3 ? " …" : ""}`);
      }

      if (achatsNonClasses.length) {
        toast.warning(`${achatsNonClasses.length} achat(s) non comptabilisé(s) exclu(s) du relevé : leur TVA reste à valider.`);
      }
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
          {/* La TVA se lit dans deux onglets parce que ce sont deux gestes
              différents : « TVA » MESURE la position fiscale à partir des
              factures ; « Déclaration » la COMPTABILISE (OD de liquidation,
              prélèvement DGI, quittance). Les fondre en un seul écran mélangeait
              un tableau de bord et un journal d'écritures. */}
          <TabsTrigger value="declaration">Déclaration &amp; paiement</TabsTrigger>
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

          {/* Achats portant de la TVA sans AUCUNE écriture d'achat : leur droit à
              déduction n'a jamais été établi. Ils ne sont pas présumés déductibles. */}
          {achatsNonClasses.length > 0 && (
            <Card className="border-amber-300 bg-amber-50 dark:bg-amber-950/20">
              <CardContent className="pt-3 pb-3 text-xs text-amber-800 dark:text-amber-300 space-y-1">
                <p className="font-medium">
                  ⚠️ {achatsNonClasses.length} facture(s) d'achat non comptabilisée(s) — TVA de {fmtMAD(achatsNonClasses.reduce((t: number, f: any) => t + (Number(f.montant_tva) || 0), 0))} écartée de la déduction, à valider.
                </p>
                <p>{achatsNonClasses.slice(0, 8).map((f: any) => f.numero || f.fournisseur_nom || String(f.id).slice(0, 8)).join(" · ")}{achatsNonClasses.length > 8 ? " …" : ""}</p>
                <p>Sans écriture au journal des achats, rien n'établit que leur TVA est récupérable : comptabilisez-les depuis l'écran Fournisseurs pour qu'elles entrent dans la déclaration.</p>
              </CardContent>
            </Card>
          )}

          {statutNet.cle === "a_payer" && (
            <Card className="border-orange-300 bg-orange-50 dark:bg-orange-950/20">
              <CardContent className="pt-4 pb-4 text-sm text-orange-700 dark:text-orange-300">
                <p className="font-bold mb-1">📋 À verser à la DGI : {fmtMAD(statutNet.montant)}</p>
                {periodeTVA !== "all" && echeanceSimplTva(periodeTVA) && (
                  <p className="text-xs font-medium">
                    Échéance de la période {periodeTVA} : {formatDateFr(isoLocal(echeanceSimplTva(periodeTVA)!))}
                  </p>
                )}
                <p className="text-xs">Régime {periodicite.periodicite} : avant la fin du mois suivant la période (télédéclaration, art. 110 CGI)</p>
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

        {/* ── Déclaration & paiement SIMPL-TVA ── */}
        <TabsContent value="declaration" className="mt-4">
          <DeclarationTvaPanel
            dossierId={dossierId} exercice={exercice} periodeInitiale={recherche.periode}
            onEcriture={chargerDonnees}
          />
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
              {is.regime === "etablissement_credit" && (
                <Badge variant="outline" className="text-violet-700 border-violet-300">Établissement de crédit / assurance — 40 %</Badge>
              )}
            </div>
            {/* Le résultat comptable n'est pas le résultat fiscal : sans ajustements
                saisis, le calcul reste celui du résultat comptable avant impôt. */}
            <Badge variant="secondary" className="mt-2 font-normal text-muted-foreground">
              {ajustements.reintegrations > 0 || ajustements.deductions > 0 || ajustements.deficitsAnterieurs > 0
                ? "Résultat fiscal = résultat avant impôt + réintégrations − déductions − déficits imputés."
                : "Aucun retraitement saisi : résultat fiscal = résultat comptable avant impôt."}
            </Badge>
          </div>

          <div className="grid grid-cols-2 gap-6">
            <Card>
              <CardHeader><CardTitle className="text-sm flex items-center gap-2"><Calculator className="h-4 w-4" />Calcul IS</CardTitle></CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {[
                    { label: "Chiffre d'affaires HT (711 + 712)", value: fmtMAD(agrN.ca) },
                    { label: "Total produits (classe 7)", value: fmtMAD(agrN.produits) },
                    { label: "Total charges (classe 6, hors IS)", value: fmtMAD(agrN.charges) },
                    ...(agrN.impotsResultats !== 0
                      ? [{ label: "IS comptabilisé en charge (67) — exclu de la base", value: fmtMAD(agrN.impotsResultats) }]
                      : []),
                    { label: "Résultat avant impôt", value: fmtMAD(agrN.resultatAvantImpot) },
                    { label: "+ Réintégrations", value: fmtMAD(ajustements.reintegrations) },
                    { label: "− Déductions", value: fmtMAD(ajustements.deductions) },
                    ...(ajustements.deficitsAnterieurs > 0
                      ? [{ label: "− Déficits antérieurs imputés (art. 12 CGI)", value: fmtMAD(imputationN.deficitImpute) }]
                      : []),
                    { label: "Résultat fiscal", value: fmtMAD(is.resultatFiscal), bold: true },
                    { label: `Taux IS (${is.tranche.label})`, value: pourcent(is.tranche.taux) },
                    { label: "IS théorique", value: fmtMAD(is.isTheorique) },
                    { label: "Base de la cotisation minimale (art. 144-I-B)", value: fmtMAD(agrN.baseCotisationMinimale) },
                    {
                      label: is.cotisationMinimale.applicable
                        ? `Cotisation minimale (${pourcent(is.cotisationMinimale.taux)} de la base)`
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
                  {imputationN.deficitReportable > 0 && (
                    <p className="text-xs text-muted-foreground">
                      Déficit reportable à l'ouverture de {anneeN + 1} : <strong>{fmtMAD(imputationN.deficitReportable)}</strong> (4 exercices, sans limite pour la part liée aux amortissements).
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
                      {baseAcomptesSaisie ? (
                        <p className="text-muted-foreground mt-1">Base saisie dans les paramètres fiscaux (IS liquidé sur la liasse {anneeN - 1}).</p>
                      ) : baseAcomptesInconnue ? (
                        <p className="text-amber-700 dark:text-amber-400 mt-1">
                          Aucune écriture sur l'exercice {anneeN - 1} : les acomptes ne peuvent pas être calculés.{" "}
                          <Button variant="link" size="sm" className="h-auto p-0 text-xs text-amber-800 dark:text-amber-300" onClick={ouvrirParams}>
                            Saisir l'IS dû de {anneeN - 1}
                          </Button>
                        </p>
                      ) : (
                        <p className="text-muted-foreground mt-1">
                          Base recalculée sur le grand livre {anneeN - 1}. Si l'IS liquidé sur la liasse diffère, saisissez-le dans les paramètres fiscaux.
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
                  <p className="font-medium">Barème IS Maroc {exercice}{anneeN < 2026 ? " (barème transitoire LF 2023)" : ""} :</p>
                  {baremeIS(anneeN).map(t => (
                    <p key={t.label}>{t.label} → {pourcent(t.taux)}</p>
                  ))}
                  <p>Statut spécifique (export, ZAI, CFC…) → {pourcent(TAUX_IS_SPECIFIQUE)} plafonné</p>
                  <p>Établissements de crédit, BAM, CDG, assurances → {pourcent(TAUX_IS_ETABLISSEMENT_CREDIT)}</p>
                  <p className="mt-1">
                    CM = {pourcent(TAUX_CM_DROIT_COMMUN)} du chiffre d'affaires, des autres produits d'exploitation,
                    des produits financiers et des subventions (art. 144 CGI), minimum 3 000 MAD. Reprises et
                    cessions d'immobilisations exclues.
                  </p>
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
              <p className="font-medium text-sm mb-1">
                🔄 Déclaration TVA {periodicite.periodicite === "mensuel" ? "mensuelle" : "trimestrielle"} — {exercice}
                <span className={`ml-2 text-xs font-normal ${periodicite.source === "defaut" ? "text-amber-700" : "text-muted-foreground"}`}>
                  ({periodicite.motif})
                </span>
              </p>
              <p className="text-xs text-muted-foreground">
                Télédéclaration avant la fin du mois suivant la période (art. 110 CGI). Une période sans
                opération ou en crédit se déclare aussi.
              </p>
              {echeanceDue ? (
                <p className={`text-xs mt-1 font-medium ${echeanceDue.statut === "en_retard" ? "text-red-600" : "text-orange-600"}`}>
                  {echeanceDue.statut === "en_retard" ? "En retard" : echeanceDue.statut === "a_payer" ? "À payer" : "Prochaine échéance"} : {formatDateFr(echeanceDue.echeance)} (période {echeanceDue.periode})
                  {echeanceDue.liquidee && !echeanceDue.deposee ? " — liquidée en comptabilité, mais aucun récépissé de dépôt enregistré" : ""}
                </p>
              ) : (
                <p className="text-xs mt-1 font-medium text-emerald-600">Toutes les périodes closes sont déposées et réglées.</p>
              )}
              <div className="mt-2 flex flex-wrap gap-1">
                {calendrier.slice(-6).map((e) => (
                  <Badge key={e.periode} variant="outline" className={`text-[11px] ${
                    e.statut === "en_retard" ? "border-red-300 text-red-700"
                    : e.statut === "reglee" ? "border-emerald-300 text-emerald-700"
                    : e.statut === "a_declarer" || e.statut === "a_payer" ? "border-orange-300 text-orange-700" : "text-muted-foreground"}`}
                    title={e.recepisse ? `Récépissé : ${e.recepisse}` : e.liquidee ? "Liquidée, non déposée" : undefined}>
                    {e.periode} · {LIBELLE_STATUT_TVA[e.statut]}{e.liquidee && !e.deposee ? " (liquidée)" : ""}
                  </Badge>
                ))}
              </div>
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
              <Label>Situation déclarative TVA (art. 108 CGI)</Label>
              <Select value={formParams.situation_tva || "droit_commun"} onValueChange={(v) => setFormParams({ ...formParams, situation_tva: v === "droit_commun" ? "" : v as SituationTva })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="droit_commun">Droit commun — nouvelle entreprise : trimestrielle ; puis CA N-1 ≥ 1 MDH : mensuelle</SelectItem>
                  <SelectItem value="option_mensuelle">Option pour la déclaration mensuelle</SelectItem>
                  <SelectItem value="saisonniere">Activité saisonnière, périodique ou occasionnelle — trimestrielle</SelectItem>
                  <SelectItem value="non_resident">Non-résident sans établissement au Maroc — mensuelle</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Périodicité {exercice} : {periodicite.periodicite} — {periodicite.motif}.</p>
              <Label className="text-xs">Périodicité retenue pour {exercice} (fige l'historique)</Label>
              <Select value={formParams.periodicite_exercice || "auto"} onValueChange={(v) => setFormParams({ ...formParams, periodicite_exercice: v === "auto" ? "" : v as PeriodiciteTva })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Selon les règles ci-dessus</SelectItem>
                  <SelectItem value="mensuel">Mensuelle</SelectItem>
                  <SelectItem value="trimestriel">Trimestrielle</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Régime d'imposition IS</Label>
              <Select value={formParams.regime_is} onValueChange={(v) => setFormParams({ ...formParams, regime_is: normaliserRegimeIS(v) })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="droit_commun">Droit commun — 20 % (&lt; 100 MDH) puis 35 %</SelectItem>
                  <SelectItem value="taux_specifique">Statut spécifique — 20 % plafonné (export, ZAI, CFC)</SelectItem>
                  <SelectItem value="etablissement_credit">Établissement de crédit / assurance — 40 %</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Les PME relèvent du droit commun : tout bénéfice inférieur à 100 MDH y est imposé à 20 %.
                Le statut spécifique maintient ce taux au-delà de 100 MDH.
              </p>
            </div>
            <div className="space-y-2 rounded-lg border p-3">
              <Label>Ajustements fiscaux de l'exercice {exercice}</Label>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Réintégrations</p>
                  <Input inputMode="decimal" placeholder="0" value={formParams.reintegrations}
                    onChange={(e) => setFormParams({ ...formParams, reintegrations: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Déductions</p>
                  <Input inputMode="decimal" placeholder="0" value={formParams.deductions}
                    onChange={(e) => setFormParams({ ...formParams, deductions: e.target.value })} />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Réintégrations : charges non déductibles (amendes, pénalités, dons au-delà du plafond…).
                Déductions : produits non imposables (dividendes exonérés…). Les déficits se saisissent à part.
              </p>
              <div className="space-y-1 pt-1">
                <p className="text-xs text-muted-foreground">Déficits antérieurs encore reportables à l'ouverture de {exercice}</p>
                <Input inputMode="decimal" placeholder="0" value={formParams.deficits_anterieurs}
                  onChange={(e) => setFormParams({ ...formParams, deficits_anterieurs: e.target.value })} />
              </div>
              <div className="space-y-1 pt-1">
                <p className="text-xs text-muted-foreground">IS dû au titre de {Number(exercice) - 1} (base des acomptes)</p>
                <Input inputMode="decimal" placeholder="Laisser vide pour le recalculer" value={formParams.is_du_precedent}
                  onChange={(e) => setFormParams({ ...formParams, is_du_precedent: e.target.value })} />
              </div>
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
