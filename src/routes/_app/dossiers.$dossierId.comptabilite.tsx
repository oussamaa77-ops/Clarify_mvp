import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import { compteTiersAuxiliaire, suffixeAuxiliaire } from "@/lib/comptes-auxiliaires";
import { synthetiserBalance, ventilerSolde, type LigneBalance as LigneBalanceLib } from "@/lib/balance-comptable";
import { normaliserNumeroCompte } from "@/lib/numero-compte";
import { bornesExercice, exerciceParDefaut, exercicesDisponibles } from "@/lib/exercice-comptable";
import { JOURNAL_AN, sansANouveaux } from "@/lib/a-nouveaux";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Loader2, Download, FileDown, Trash2, Plus, Save, RefreshCw, AlertTriangle, CheckCircle } from "lucide-react";
import {
  FORMATS_EXPORT, controlerExport, telechargerExport, type FormatExport,
} from "@/services/exportSage";
import { toast } from "sonner";
import ImportGrandLivre from "@/components/ImportGrandLivre";
import LettrageManuel from "@/components/compta/LettrageManuel";

export const Route = createFileRoute("/_app/dossiers/$dossierId/comptabilite")({
  component: ComptabilitePage,
});

interface Ecriture {
  id: string;
  date_ecriture: string;
  journal_code: string;
  compte_numero: string;
  libelle: string;
  debit: number;
  credit: number;
  reference_piece: string | null;
  valide: boolean;
  /** Code de lettrage GÉNÉRÉ (AA, AB…). Lecture seule ici : il n'a de sens
      qu'attaché à un groupe équilibré, posé depuis l'onglet Lettrage. */
  lettrage_code?: string | null;
  lettrage_origine?: "auto" | "manuel" | null;
  _modifie?: boolean;
  _nouveau?: boolean;
}

type LigneBalance = LigneBalanceLib;

const JOURNAUX = ["AN","BQ","VTE","ACH","CAI","OD","VTE-AVR","ACH-AVR"];

// ── 3 Grands Livres distincts (Sage) ──
// Le journal_code est déjà ventilé à l'insertion (ventes→VTE, achats→ACH,
// trésorerie→BQ/CAI). On regroupe ces codes en 3 livres + une vue « Tous ».
type LivreKey = "tous" | "ventes" | "achats" | "tresorerie" | "divers";
const LIVRES: Record<LivreKey, { label: string; court: string; journaux: string[] }> = {
  tous:       { label: "Tous les journaux",         court: "Tous",            journaux: [] },
  ventes:     { label: "Grand Livre des Ventes",    court: "Ventes",          journaux: ["VTE","VTE-AVR"] },
  achats:     { label: "Grand Livre des Achats",    court: "Achats",          journaux: ["ACH","ACH-AVR"] },
  tresorerie: { label: "Grand Livre de Trésorerie", court: "Trésorerie",      journaux: ["BQ","CAI"] },
  divers:     { label: "Opérations diverses & TVA", court: "Divers (OD/TVA)", journaux: ["OD","TVA","AN"] },
};

const fmt = (n: number) => Number(n).toLocaleString("fr-MA", { minimumFractionDigits: 2 });

// Excel refuse \ / ? * [ ] : dans un nom d'onglet, et le limite à 31 caractères.
// Sans ce nettoyage, « Divers (OD/TVA) » fait échouer book_append_sheet et l'export
// entier s'interrompt — aucun fichier, aucun message. Les libellés d'écran restent
// inchangés : seul le nom de la feuille est normalisé.
const nomOnglet = (nom: string) => nom.replace(/[\\/?*[\]:]/g, "-").slice(0, 31);

function ComptabilitePage() {
  const { dossierId } = Route.useParams();
  const [tab, setTab] = useState<"grandlivre"|"balance"|"saisie"|"lettrage"|"import">("grandlivre");
  const [livre, setLivre] = useState<LivreKey>("tous");
  const [ecritures, setEcritures] = useState<Ecriture[]>([]);
  const [pcmComptes, setPcmComptes] = useState<{ numero: string; intitule: string }[]>([]);
  // Intitulés des comptes AUXILIAIRES (44110005 → « ALPHA SARL ») : c'est ce qui
  // transforme la balance générale en balance AUXILIAIRE lisible.
  const [intitulesAux, setIntitulesAux] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Filtres
  const [filtreJournal, setFiltreJournal] = useState("TOUS");
  const [filtreCompte, setFiltreCompte] = useState("");
  const [filtreDateDeb, setFiltreDateDeb] = useState("");
  const [filtreDateFin, setFiltreDateFin] = useState("");

  // ── EXERCICE : le périmètre par défaut, et non plus « tout ce qui existe » ──
  // Le grand livre chargeait toutes les écritures du dossier, sans borne de
  // date. Sur un dossier repris, les écritures 2024 et 2025 s'affichaient donc
  // au milieu de 2026, et la balance additionnait trois exercices — un total qui
  // ne correspond à aucune liasse. On ouvre désormais sur UN exercice.
  // `null` = « tous les exercices », qui reste accessible mais n'est plus le
  // comportement par défaut.
  const [exercice, setExercice] = useState<number | null>(null);
  const [exercicesDispo, setExercicesDispo] = useState<number[]>([]);
  const [dateDebutActivite, setDateDebutActivite] = useState<string | null>(null);
  const [exerciceInitialise, setExerciceInitialise] = useState(false);

  const bornes = exercice == null ? null : bornesExercice(exercice, dateDebutActivite);

  // Nouvelle écriture
  const [newDate, setNewDate] = useState(new Date().toISOString().slice(0,10));
  const [newJournal, setNewJournal] = useState("OD");
  const [newCompte, setNewCompte] = useState("");
  const [newLibelle, setNewLibelle] = useState("");
  const [newDebit, setNewDebit] = useState(0);
  const [newCredit, setNewCredit] = useState(0);
  const [newRef, setNewRef] = useState("");

  // Suppression
  const [deleteIds, setDeleteIds] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteLot, setDeleteLot] = useState<{journal?:string;date?:string}|null>(null);

  // Exercices RÉELLEMENT portés par le dossier + date de début d'activité (qui
  // resserre l'ouverture du premier exercice). Chargé une fois : proposer une
  // liste d'années en dur ferait chercher l'utilisateur dans des exercices vides.
  useEffect(() => {
    (async () => {
      const [{ data: dates }, { data: dos }] = await Promise.all([
        supabase.from("ecritures_comptables").select("date_ecriture").eq("dossier_id", dossierId),
        (supabase.from("dossiers") as any).select("*").eq("id", dossierId).maybeSingle(),
      ]);
      const dispo = exercicesDisponibles(((dates ?? []) as any[]).map((d) => d.date_ecriture));
      setExercicesDispo(dispo);
      setDateDebutActivite((dos as any)?.date_debut_activite ?? null);
      setExercice(exerciceParDefaut(dispo));
      setExerciceInitialise(true);
    })();
  }, [dossierId]);

  const load = useCallback(async () => {
    setLoading(true);
    let query = supabase.from("ecritures_comptables")
      .select("*").eq("dossier_id", dossierId)
      .order("date_ecriture", { ascending: false })
      .order("journal_code").order("created_at", { ascending: true });

    if (filtreJournal !== "TOUS") query = query.eq("journal_code", filtreJournal);
    if (filtreCompte) query = query.eq("compte_numero", filtreCompte);
    // L'exercice est la borne EXTÉRIEURE : les filtres de date de l'utilisateur
    // ne peuvent que la resserrer, jamais la déborder. Sans cette intersection,
    // saisir une date de début en 2024 rouvrirait un exercice clos dans une vue
    // qui annonce 2026.
    const debut = [bornes?.debut, filtreDateDeb].filter(Boolean).sort().at(-1);
    const fin = [bornes?.fin, filtreDateFin].filter(Boolean).sort().at(0);
    if (debut) query = query.gte("date_ecriture", debut);
    if (fin) query = query.lte("date_ecriture", fin);

    const { data, error } = await query.limit(1000);
    if (error) { toast.error(error.message); setLoading(false); return; }
    // ── Vue MULTI-EXERCICES : les à-nouveaux doivent sortir ────────────────
    // Un solde reporté existe deux fois en base : sur sa ligne d'origine (ACH
    // 16/12/2025) et sur son report (AN 01/01/2026). Bornés à un exercice, les
    // deux ne se rencontrent jamais. Cumulés, ils doublent le solde — le 4411
    // d'ACOSOLUTIONS afficherait 49 200 au lieu de 24 600. Le journal AN est le
    // seul discriminant (cf. src/lib/a-nouveaux.ts).
    const brutes = (data ?? []) as Ecriture[];
    setEcritures(exercice == null && filtreJournal !== JOURNAL_AN ? sansANouveaux(brutes) : brutes);
    setLoading(false);
    setDeleteIds(new Set());
  }, [dossierId, filtreJournal, filtreCompte, filtreDateDeb, filtreDateFin, bornes?.debut, bornes?.fin, exercice]);

  // On attend de savoir QUEL exercice ouvrir : charger avant afficherait un
  // instant le dossier entier, tous exercices confondus.
  useEffect(() => { if (exerciceInitialise) load(); }, [load, exerciceInitialise]);

  // PCM (référentiel global) pour l'autocomplétion des comptes — chargé une fois.
  useEffect(() => {
    (async () => {
      const { data } = await (supabase as any)
        .from("pcm_reference")
        .select("numero,intitule")
        .order("numero");
      setPcmComptes((data ?? []) as { numero: string; intitule: string }[]);
    })();
  }, []);

  // Tiers du dossier → intitulé des comptes auxiliaires (balance auxiliaire).
  useEffect(() => {
    (async () => {
      const [{ data: cli }, { data: fou }] = await Promise.all([
        supabase.from("clients").select("nom,code_auxiliaire").eq("dossier_id", dossierId).is("deleted_at", null),
        supabase.from("fournisseurs").select("nom,code_auxiliaire").eq("dossier_id", dossierId),
      ]);
      const map: Record<string, string> = {};
      for (const c of cli ?? []) if (c.code_auxiliaire) map[compteTiersAuxiliaire("client", c.code_auxiliaire)] = c.nom;
      for (const f of fou ?? []) if (f.code_auxiliaire) map[compteTiersAuxiliaire("fournisseur", f.code_auxiliaire)] = f.nom;
      setIntitulesAux(map);
    })();
  }, [dossierId]);

  // Modifier une écriture
  const updateEcriture = (id: string, field: keyof Ecriture, value: any) => {
    setEcritures(prev => prev.map(e =>
      e.id === id ? { ...e, [field]: value, _modifie: true } : e
    ));
  };

  // Sauvegarder les modifications
  const sauvegarder = async () => {
    const modifiees = ecritures.filter(e => e._modifie && !e._nouveau);
    if (!modifiees.length) { toast.info("Aucune modification"); return; }
    setSaving(true);
    try {
      for (const e of modifiees) {
        const { error } = await supabase.from("ecritures_comptables").update({
          date_ecriture: e.date_ecriture,
          journal_code: e.journal_code,
          // La saisie est libre (« 5141 ») : on canonise à l'enregistrement,
          // sinon la balance affiche deux lignes pour la même banque.
          compte_numero: normaliserNumeroCompte(e.compte_numero),
          libelle: e.libelle,
          debit: Number(e.debit),
          credit: Number(e.credit),
          reference_piece: e.reference_piece,
        }).eq("id", e.id);
        if (error) throw error;
      }
      toast.success(`${modifiees.length} écriture(s) sauvegardée(s)`);
      load();
    } catch (e: any) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  // Ajouter écriture manuelle
  const ajouterEcriture = async () => {
    if (!newCompte || !newDate || (!newDebit && !newCredit)) {
      toast.error("Compte, date et montant requis"); return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.from("ecritures_comptables").insert({
        dossier_id: dossierId,
        journal_code: newJournal,
        compte_numero: normaliserNumeroCompte(newCompte),
        date_ecriture: newDate,
        libelle: newLibelle,
        debit: newDebit || 0,
        credit: newCredit || 0,
        reference_piece: newRef || null,
        valide: true,
      });
      if (error) throw error;
      toast.success("Écriture ajoutée");
      setNewDebit(0); setNewCredit(0); setNewLibelle(""); setNewRef(""); setNewCompte("");
      load();
    } catch (e: any) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  // Suppression sélective
  const supprimerSelection = async () => {
    if (!deleteIds.size) { toast.warning("Aucune écriture sélectionnée"); return; }
    setSaving(true);
    try {
      const ids = Array.from(deleteIds);
      const { error } = await supabase.from("ecritures_comptables").delete().in("id", ids);
      if (error) throw error;
      toast.success(`${ids.length} écriture(s) supprimée(s)`);
      setDeleteIds(new Set()); setConfirmDelete(false);
      load();
    } catch (e: any) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  // Suppression par lot (journal + date)
  const supprimerLot = async () => {
    if (!deleteLot) return;
    setSaving(true);
    try {
      let query = supabase.from("ecritures_comptables").delete().eq("dossier_id", dossierId);
      if (deleteLot.journal) query = query.eq("journal_code", deleteLot.journal);
      if (deleteLot.date) query = query.eq("date_ecriture", deleteLot.date);
      const { error } = await query;
      if (error) throw error;
      toast.success("Écritures supprimées");
      setDeleteLot(null); setConfirmDelete(false);
      load();
    } catch (e: any) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  // Toggle sélection
  const toggleSelect = (id: string) => {
    setDeleteIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // ── Écritures du Grand Livre sélectionné (Achats / Ventes / Trésorerie / Tous) ──
  const livreJournaux = LIVRES[livre].journaux;
  const livreEcritures = livreJournaux.length
    ? ecritures.filter(e => livreJournaux.includes(e.journal_code))
    : ecritures;
  const livreTotalDebit = livreEcritures.reduce((s, e) => s + Number(e.debit), 0);
  const livreTotalCredit = livreEcritures.reduce((s, e) => s + Number(e.credit), 0);
  const livreEquilibre = Math.abs(livreTotalDebit - livreTotalCredit) < 0.01;
  const compteCount = (k: LivreKey) =>
    LIVRES[k].journaux.length ? ecritures.filter(e => LIVRES[k].journaux.includes(e.journal_code)).length : ecritures.length;

  // « Tout sélectionner » agit sur les écritures VISIBLES (livre courant).
  const toggleAll = () => {
    const visibleIds = livreEcritures.map(e => e.id);
    const allSelected = visibleIds.length > 0 && visibleIds.every(id => deleteIds.has(id));
    setDeleteIds(allSelected ? new Set() : new Set(visibleIds));
  };

  // Calcul balance
  const balance: LigneBalance[] = Object.values(
    ecritures.reduce((acc: Record<string, LigneBalance>, e) => {
      const c = e.compte_numero;
      if (!acc[c]) acc[c] = { compte: c, total_debit: 0, total_credit: 0, solde: 0, sens: "D" };
      acc[c].total_debit += Number(e.debit);
      acc[c].total_credit += Number(e.credit);
      return acc;
    }, {})
  ).map(l => {
    const solde = Math.abs(l.total_debit - l.total_credit);
    const sens: "D" | "C" = l.total_debit >= l.total_credit ? "D" : "C";
    return { ...l, solde, sens };
  }).sort((a, b) => a.compte.localeCompare(b.compte));

  const totalDebit = ecritures.reduce((s, e) => s + Number(e.debit), 0);
  const totalCredit = ecritures.reduce((s, e) => s + Number(e.credit), 0);
  const equilibre = Math.abs(totalDebit - totalCredit) < 0.01;

  // Pied de balance : sous-totaux par classe CGNC, total général et résultat net.
  // Même calcul pour l'écran et pour l'export — un total affiché ne peut pas
  // diverger d'un total exporté.
  const { sousTotaux, total: totalBalance, resultat, suspens } = synthetiserBalance(balance);

  // Export Excel
  // Export vers un logiciel comptable tiers (Sage 100 / FEC / CSV). Le code de
  // lettrage voyage avec les écritures : c'est ce qui évite au cabinet de
  // refaire le rapprochement à la main dans l'outil de destination.
  const exporterVers = async (format: FormatExport) => {
    if (!format) return;
    if (!ecritures.length) { toast.error("Aucune écriture à exporter"); return; }
    try {
      const controle = controlerExport(ecritures as any[]);
      // Un fichier déséquilibré est rejeté à l'import : le dire ici, où l'on
      // sait encore quoi corriger, plutôt que de le découvrir dans Sage.
      if (!controle.equilibre) {
        toast.warning(`Export déséquilibré : débit ${fmt(controle.totalDebit)} ≠ crédit ${fmt(controle.totalCredit)} — le fichier sera probablement refusé à l'import.`, { duration: 9000 });
      }
      if (controle.lettragesDesequilibres.length) {
        toast.warning(`Lettrage incohérent sur ${controle.lettragesDesequilibres.join(", ")} — à corriger dans l'onglet Lettrage.`, { duration: 9000 });
      }
      // Colonne de lettrage vide sur TOUT le fichier : ce n'est pas un défaut de
      // l'export mais un dossier jamais lettré. Le dire explicitement, sinon on
      // cherche le bug dans le générateur — ce qui est exactement ce qui est arrivé.
      if (controle.nbLettrees === 0) {
        toast.info("Aucune écriture lettrée dans ce dossier : la colonne « Lettrage » sortira vide. Lettrez d'abord depuis l'onglet Lettrage.", { duration: 9000 });
      }
      const intitules = Object.fromEntries(
        (pcmComptes ?? []).map((c) => [c.numero, c.intitule]),
      );
      telechargerExport(
        format, ecritures as any[],
        dossierId,
        // Date de clôture de l'export : celle de l'EXERCICE ouvert. L'année de
        // l'horloge datait un export d'un exercice antérieur au 31/12 courant.
        filtreDateFin || bornes?.fin || `${new Date().getFullYear()}-12-31`,
        { intitules },
      );
      toast.success(`${FORMATS_EXPORT[format].label} — ${controle.lignes} écriture(s), dont ${controle.nbLettrees} lettrée(s)`);
    } catch (e: any) {
      toast.error(`Export impossible : ${e?.message ?? e}`);
    }
  };

  const exportExcel = async () => {
    if (!ecritures.length) { toast.error("Aucune écriture à exporter"); return; }
    try {
      const XLSX = await import("xlsx");
      const wb = XLSX.utils.book_new();

      // Grand livre
      const glData = [
        ["Date", "Journal", "Compte", "Libellé", "Lettrage", "Débit", "Crédit", "Réf."],
        ...ecritures.map(e => [e.date_ecriture, e.journal_code, e.compte_numero, e.libelle, e.lettrage_code||"", Number(e.debit)||"", Number(e.credit)||"", e.reference_piece||""]),
      ];
      const wsGL = XLSX.utils.aoa_to_sheet(glData);
      const glCols = [{wch:12},{wch:8},{wch:10},{wch:50},{wch:10},{wch:14},{wch:14},{wch:15}];
      wsGL["!cols"] = glCols;
      XLSX.utils.book_append_sheet(wb, wsGL, nomOnglet("Grand Livre"));

      // Un onglet par Grand Livre distinct (Ventes / Achats / Trésorerie / Divers)
      (["ventes","achats","tresorerie","divers"] as LivreKey[]).forEach(k => {
        const lignes = ecritures.filter(e => LIVRES[k].journaux.includes(e.journal_code));
        const td = lignes.reduce((s,e)=>s+Number(e.debit),0);
        const tc = lignes.reduce((s,e)=>s+Number(e.credit),0);
        const data = [
          ["Date","Journal","Compte","Libellé","Lettrage","Débit","Crédit","Réf."],
          ...lignes.map(e => [e.date_ecriture, e.journal_code, e.compte_numero, e.libelle, e.lettrage_code||"", Number(e.debit)||"", Number(e.credit)||"", e.reference_piece||""]),
          ["TOTAL","","","","", td, tc, ""],
        ];
        const ws = XLSX.utils.aoa_to_sheet(data);
        ws["!cols"] = glCols;
        XLSX.utils.book_append_sheet(wb, ws, nomOnglet(LIVRES[k].court));
      });

      // Balance : comptes groupés par classe, chaque classe suivie de son
      // sous-total, puis le total général et le résultat net.
      // Mêmes colonnes qu'à l'écran (norme Sage 100) : solde ventilé sur deux
      // colonnes, pas de colonne « sens ».
      const balData: (string | number)[][] = [["Compte", "Total Débit", "Total Crédit", "Solde Débiteur", "Solde Créditeur"]];
      for (const st of sousTotaux) {
        for (const l of balance.filter(x => (/^[0-9]/.test(x.compte) ? x.compte.charAt(0) : "?") === st.classe)) {
          const s = ventilerSolde(l);
          balData.push([l.compte, l.total_debit, l.total_credit, s.debiteur || "", s.crediteur || ""]);
        }
        balData.push([`${st.label} — ${st.intitule}`, st.total_debit, st.total_credit, st.solde_debiteur || "", st.solde_crediteur || ""]);
      }
      balData.push(
        ["TOTAL GÉNÉRAL DE LA BALANCE", totalBalance.total_debit, totalBalance.total_credit, totalBalance.total_solde_debiteur, totalBalance.total_solde_crediteur],
        [totalBalance.equilibre ? "✅ Balance équilibrée" : `⚠️ Écart ${fmt(totalBalance.ecart || totalBalance.ecart_soldes)}`],
        [],
        ["RÉSULTAT NET DE L'EXERCICE"],
        ["Produits (classe 7)", "", resultat.produits],
        ["Charges (classe 6)", resultat.charges, ""],
        [resultat.label, "", "", resultat.benefice ? "" : resultat.montant, resultat.benefice ? resultat.montant : ""],
      );
      const wsBal = XLSX.utils.aoa_to_sheet(balData);
      wsBal["!cols"] = [{wch:36},{wch:16},{wch:16},{wch:16},{wch:16}];
      XLSX.utils.book_append_sheet(wb, wsBal, nomOnglet("Balance"));

      XLSX.writeFile(wb, `Comptabilite_${dossierId.slice(0,8)}_${new Date().toISOString().slice(0,10)}.xlsx`);
      toast.success(`Export Excel généré — ${ecritures.length} écritures`);
    } catch (e: any) {
      // Un échec silencieux (rien ne se télécharge, aucun message) est le pire des cas :
      // on remonte toujours la cause à l'utilisateur.
      console.error("[EXPORT EXCEL]", e);
      toast.error(`Export Excel impossible : ${e?.message ?? e}`);
    }
  };

  const modifiees = ecritures.filter(e => e._modifie).length;

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Comptabilité</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Grand livre · Balance · Saisie manuelle</p>
        </div>
        <div className="flex gap-2">
          {modifiees > 0 && (
            <Button onClick={sauvegarder} disabled={saving} className="bg-green-600 hover:bg-green-700">
              {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin"/> : <Save className="h-4 w-4 mr-2"/>}
              Sauvegarder ({modifiees})
            </Button>
          )}
          {deleteIds.size > 0 && (
            <Button variant="destructive" onClick={()=>setConfirmDelete(true)}>
              <Trash2 className="h-4 w-4 mr-2"/>Supprimer ({deleteIds.size})
            </Button>
          )}
          <Button variant="outline" onClick={exportExcel}><Download className="h-4 w-4 mr-2"/>Export Excel</Button>
          {/* Export vers un AUTRE logiciel comptable : le lettrage part avec les
              écritures, pour que le cabinet n'ait pas à le refaire à la main. */}
          <Select value="" onValueChange={(v)=>exporterVers(v as FormatExport)}>
            <SelectTrigger className="w-[190px]">
              <FileDown className="h-4 w-4 mr-2 shrink-0"/>
              <SelectValue placeholder="Export comptable…"/>
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(FORMATS_EXPORT) as FormatExport[]).map(f => (
                <SelectItem key={f} value={f}>
                  {FORMATS_EXPORT[f].label} — {FORMATS_EXPORT[f].description}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={load}><RefreshCw className="h-4 w-4 mr-2"/>Actualiser</Button>
        </div>
      </div>

      {/* Équilibre */}
      <div className={`flex items-center gap-2 mb-4 p-3 rounded-lg ${equilibre?"bg-green-50 text-green-700":"bg-red-50 text-red-700"}`}>
        {equilibre ? <CheckCircle className="h-4 w-4"/> : <AlertTriangle className="h-4 w-4"/>}
        <span className="text-sm font-medium">
          {equilibre ? "✅ Balance équilibrée" : `⚠️ Écart: ${fmt(Math.abs(totalDebit-totalCredit))} MAD`}
          &nbsp;— Total Débit: <strong>{fmt(totalDebit)}</strong> / Total Crédit: <strong>{fmt(totalCredit)}</strong>
        </span>
      </div>

      {/* Filtres */}
      <div className="flex gap-3 mb-4 flex-wrap">
        {/* L'EXERCICE d'abord : c'est lui qui définit le périmètre, les autres
            filtres ne font que le resserrer. */}
        <Select value={exercice == null ? "TOUS" : String(exercice)}
          onValueChange={v => setExercice(v === "TOUS" ? null : Number(v))}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Exercice"/></SelectTrigger>
          <SelectContent>
            {exercicesDispo.map(a => <SelectItem key={a} value={String(a)}>Exercice {a}</SelectItem>)}
            {/* Conservé pour les reprises et les contrôles inter-exercices — mais
                il faut désormais le demander explicitement. */}
            <SelectItem value="TOUS">Tous exercices</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filtreJournal} onValueChange={setFiltreJournal}>
          <SelectTrigger className="w-32"><SelectValue placeholder="Journal"/></SelectTrigger>
          <SelectContent>
            <SelectItem value="TOUS">Tous journaux</SelectItem>
            {JOURNAUX.map(j => <SelectItem key={j} value={j}>{j}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input placeholder="Compte (ex: 3421)" value={filtreCompte} onChange={e=>setFiltreCompte(e.target.value)} className="w-36"/>
        <Input type="date" value={filtreDateDeb} onChange={e=>setFiltreDateDeb(e.target.value)} className="w-36"/>
        <Input type="date" value={filtreDateFin} onChange={e=>setFiltreDateFin(e.target.value)} className="w-36"/>
        <Button variant="outline" size="sm" onClick={()=>{setFiltreJournal("TOUS");setFiltreCompte("");setFiltreDateDeb("");setFiltreDateFin("");}}>Réinitialiser</Button>
        {(filtreJournal!=="TOUS"||filtreDateDeb) && (
          <Button variant="destructive" size="sm" onClick={()=>{setDeleteLot({journal:filtreJournal!=="TOUS"?filtreJournal:undefined,date:filtreDateDeb||undefined});setConfirmDelete(true);}}>
            <Trash2 className="h-3.5 w-3.5 mr-1"/>Supprimer filtre
          </Button>
        )}
      </div>

      {/* Les autres exercices ne sont pas cachés, ils sont AILLEURS : le dire
          évite de croire que des écritures ont disparu. */}
      {exercice != null && exercicesDispo.some(a => a !== exercice) && (
        <p className="text-xs text-muted-foreground mb-4">
          Périmètre : {bornes?.debut} → {bornes?.fin}
          {bornes?.premierExercice && " (premier exercice, ouvert à la date de début d'activité)"}.
          Ce dossier porte aussi des écritures en{" "}
          {exercicesDispo.filter(a => a !== exercice).join(", ")} — changez d'exercice pour les consulter.
        </p>
      )}

      <Tabs value={tab} onValueChange={v=>setTab(v as any)}>
        <TabsList>
          <TabsTrigger value="grandlivre">Grand Livre ({ecritures.length})</TabsTrigger>
          <TabsTrigger value="balance">Balance ({balance.length} comptes)</TabsTrigger>
          <TabsTrigger value="saisie">Saisie manuelle</TabsTrigger>
          <TabsTrigger value="lettrage">Lettrage</TabsTrigger>
          <TabsTrigger value="import">+ Import</TabsTrigger>
        </TabsList>

        {/* ── GRAND LIVRE ÉDITABLE ── */}
        <TabsContent value="grandlivre" className="mt-4">
          {/* Sélecteur des 3 Grands Livres distincts */}
          <div className="flex items-center gap-1 mb-3 p-1 bg-muted rounded-lg w-fit">
            {(Object.keys(LIVRES) as LivreKey[]).map(k => (
              <button key={k} onClick={()=>setLivre(k)}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors
                  ${livre===k ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
                {LIVRES[k].court} <span className="text-xs opacity-60">({compteCount(k)})</span>
              </button>
            ))}
          </div>
          {livre!=="tous" && (
            <div className={`flex items-center gap-2 mb-3 px-3 py-1.5 rounded-md text-xs ${livreEquilibre?"bg-green-50 text-green-700":"bg-amber-50 text-amber-700"}`}>
              <span className="font-semibold">{LIVRES[livre].label}</span>
              <span>· journaux {LIVRES[livre].journaux.join(", ")}</span>
              <span className="ml-auto">{livreEquilibre ? "Équilibré" : `Écart ${fmt(Math.abs(livreTotalDebit-livreTotalCredit))}`}</span>
            </div>
          )}
          {loading ? (
            <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin"/></div>
          ) : livreEcritures.length===0 ? (
            <div className="text-center py-12 text-muted-foreground text-sm">Aucune écriture dans ce Grand Livre.</div>
          ) : (
            <div className="rounded-lg border overflow-hidden">
              {/* En-tête */}
              <div className="grid grid-cols-12 gap-1 px-3 py-2 bg-muted text-xs font-semibold text-muted-foreground uppercase sticky top-0 z-10">
                <div className="col-span-1 flex items-center gap-1">
                  <input type="checkbox" checked={livreEcritures.length>0&&livreEcritures.every(e=>deleteIds.has(e.id))} onChange={toggleAll} className="h-3 w-3"/>
                  <span>#</span>
                </div>
                <div className="col-span-1">Date</div>
                <div className="col-span-1">Journal</div>
                <div className="col-span-1">Compte</div>
                {/* Libellé passe de 4 à 3 colonnes : la grille est en 12 et
                    Lettrage doit tenir sans déborder (1+1+1+1+3+1+2+2 = 12). */}
                <div className="col-span-3">Libellé</div>
                <div className="col-span-1 text-center">Lettrage</div>
                <div className="col-span-2 text-right">Débit</div>
                <div className="col-span-2 text-right">Crédit</div>
              </div>

              {/* Lignes éditables */}
              <div className="max-h-[60vh] overflow-y-auto">
                {livreEcritures.map((e, idx) => (
                  <div key={e.id}
                    className={`grid grid-cols-12 gap-1 px-3 py-1 border-b items-center text-xs
                      ${deleteIds.has(e.id) ? "bg-red-50 dark:bg-red-950/20" : idx%2===0 ? "bg-white dark:bg-background" : "bg-muted/20"}
                      ${e._modifie ? "border-l-2 border-l-blue-400" : ""}
                    `}>
                    <div className="col-span-1 flex items-center gap-1">
                      <input type="checkbox" checked={deleteIds.has(e.id)} onChange={()=>toggleSelect(e.id)} className="h-3 w-3"/>
                      <span className="text-muted-foreground">{idx+1}</span>
                    </div>
                    <div className="col-span-1">
                      <input type="date" value={e.date_ecriture}
                        onChange={ev=>updateEcriture(e.id,"date_ecriture",ev.target.value)}
                        className="w-full text-xs bg-transparent border-0 focus:outline-none focus:ring-1 focus:ring-primary rounded px-1"/>
                    </div>
                    <div className="col-span-1">
                      <select value={e.journal_code} onChange={ev=>updateEcriture(e.id,"journal_code",ev.target.value)}
                        className="w-full text-xs bg-transparent border-0 focus:outline-none focus:ring-1 focus:ring-primary rounded">
                        {JOURNAUX.map(j=><option key={j} value={j}>{j}</option>)}
                      </select>
                    </div>
                    <div className="col-span-1">
                      <input value={e.compte_numero}
                        onChange={ev=>updateEcriture(e.id,"compte_numero",ev.target.value)}
                        className="w-full text-xs font-mono bg-transparent border-0 focus:outline-none focus:ring-1 focus:ring-primary rounded px-1"/>
                    </div>
                    <div className="col-span-3">
                      <input value={e.libelle||""}
                        onChange={ev=>updateEcriture(e.id,"libelle",ev.target.value)}
                        className="w-full text-xs bg-transparent border-0 focus:outline-none focus:ring-1 focus:ring-primary rounded px-1"/>
                    </div>
                    {/* Lettrage : lecture seule. Le code n'est PAS éditable ici —
                        il n'a de sens qu'attaché à un groupe équilibré, et le
                        saisir à la main casserait l'appariement. On passe par
                        l'onglet Lettrage, seul endroit qui contrôle l'équilibre. */}
                    <div className="col-span-1 flex justify-center" title={e.lettrage_code ? `Lettré ${e.lettrage_code}${e.lettrage_origine ? ` (${e.lettrage_origine})` : ""}` : "Non lettré"}>
                      {e.lettrage_code
                        ? <Badge variant="secondary" className="font-mono text-[10px] px-1.5 py-0">{e.lettrage_code}</Badge>
                        : <span className="text-muted-foreground/40 text-[10px]">—</span>}
                    </div>
                    <div className="col-span-2">
                      <input type="number" step="0.01" value={e.debit||""}
                        onChange={ev=>updateEcriture(e.id,"debit",parseFloat(ev.target.value)||0)}
                        className={`w-full text-xs font-mono text-right bg-transparent border-0 focus:outline-none focus:ring-1 focus:ring-primary rounded px-1 ${e.debit>0?"text-red-600":""}`}/>
                    </div>
                    <div className="col-span-2">
                      <input type="number" step="0.01" value={e.credit||""}
                        onChange={ev=>updateEcriture(e.id,"credit",parseFloat(ev.target.value)||0)}
                        className={`w-full text-xs font-mono text-right bg-transparent border-0 focus:outline-none focus:ring-1 focus:ring-primary rounded px-1 ${e.credit>0?"text-green-600":""}`}/>
                    </div>
                  </div>
                ))}
              </div>

              {/* Totaux */}
              <div className="grid grid-cols-12 gap-1 px-3 py-2 bg-muted font-semibold text-xs border-t">
                <div className="col-span-8">TOTAUX {LIVRES[livre].court} ({livreEcritures.length} écritures)</div>
                <div className="col-span-2 text-right text-red-600">{fmt(livreTotalDebit)}</div>
                <div className="col-span-2 text-right text-green-600">{fmt(livreTotalCredit)}</div>
              </div>
            </div>
          )}
        </TabsContent>

        {/* ── BALANCE ── */}
        <TabsContent value="balance" className="mt-4">
          <div className="rounded-lg border overflow-hidden">
            {/* Présentation normalisée Sage 100 / CGNC : les mouvements de la
                période, puis le solde ventilé sur DEUX colonnes exclusives.
                Un badge « sens » n'est pas additionnable — deux colonnes le sont,
                et c'est ce qui permet le contrôle Σ SD = Σ SC en pied. */}
            <div className="grid grid-cols-12 gap-1 px-4 py-2 bg-muted text-[11px] font-semibold uppercase text-muted-foreground">
              <div className="col-span-4">Compte</div>
              <div className="col-span-2 text-right">Total Débit</div>
              <div className="col-span-2 text-right">Total Crédit</div>
              <div className="col-span-2 text-right">Solde Débiteur</div>
              <div className="col-span-2 text-right">Solde Créditeur</div>
            </div>
            <div className="max-h-[60vh] overflow-y-auto">
              {/* Les comptes d'une classe, puis SON sous-total : c'est la lecture
                  d'une balance — on ne renvoie pas les totaux de classe en pied. */}
              {sousTotaux.map(st => (
                <div key={st.classe}>
                  {balance
                    .filter(l => (/^[0-9]/.test(l.compte) ? l.compte.charAt(0) : "?") === st.classe)
                    .map((l, i) => {
                      // Un compte alimente UNE des deux colonnes de solde ;
                      // l'autre reste vide, c'est la lecture d'une balance Sage.
                      const s = ventilerSolde(l);
                      return (
                      <div key={l.compte} className={`grid grid-cols-12 gap-1 px-4 py-1.5 border-b text-sm ${i%2===0?"bg-white dark:bg-background":"bg-muted/20"}`}>
                        <div className="col-span-4 font-mono font-medium">
                          {l.compte}
                          {(intitulesAux[l.compte] || suffixeAuxiliaire(l.compte)) && (
                            <span className="ml-2 font-sans text-xs text-muted-foreground">
                              {intitulesAux[l.compte] ?? "tiers auxiliaire"}
                            </span>
                          )}
                        </div>
                        <div className="col-span-2 text-right font-mono text-red-600">{l.total_debit>0?fmt(l.total_debit):"—"}</div>
                        <div className="col-span-2 text-right font-mono text-green-600">{l.total_credit>0?fmt(l.total_credit):"—"}</div>
                        <div className="col-span-2 text-right font-mono font-semibold text-red-600">{s.debiteur>0?fmt(s.debiteur):""}</div>
                        <div className="col-span-2 text-right font-mono font-semibold text-green-600">{s.crediteur>0?fmt(s.crediteur):""}</div>
                      </div>
                      );
                    })}
                  <div className="grid grid-cols-12 gap-1 px-4 py-1.5 border-b-2 border-muted-foreground/20 bg-muted/60 text-sm font-semibold">
                    <div className="col-span-4">
                      {st.label}
                      <span className="ml-2 font-normal text-xs text-muted-foreground">{st.intitule}</span>
                    </div>
                    <div className="col-span-2 text-right font-mono text-red-600">{fmt(st.total_debit)}</div>
                    <div className="col-span-2 text-right font-mono text-green-600">{fmt(st.total_credit)}</div>
                    <div className="col-span-2 text-right font-mono text-red-600">{st.solde_debiteur>0?fmt(st.solde_debiteur):""}</div>
                    <div className="col-span-2 text-right font-mono text-green-600">{st.solde_crediteur>0?fmt(st.solde_crediteur):""}</div>
                  </div>
                </div>
              ))}
            </div>
            {/* Total général : les DEUX contrôles d'une balance Sage —
                Σ débits = Σ crédits et Σ soldes débiteurs = Σ soldes créditeurs. */}
            <div className="grid grid-cols-12 gap-1 px-4 py-2 bg-muted font-bold text-sm border-t-2">
              <div className="col-span-4 flex items-center gap-2 flex-wrap">
                <span>TOTAL GÉNÉRAL DE LA BALANCE</span>
                {totalBalance.equilibre
                  ? <span className="text-green-600 text-xs font-normal">✅ Équilibrée</span>
                  : <span className="text-red-600 text-xs font-normal">⚠️ Écart {fmt(totalBalance.ecart || totalBalance.ecart_soldes)}</span>}
              </div>
              <div className="col-span-2 text-right font-mono text-red-600">{fmt(totalBalance.total_debit)}</div>
              <div className="col-span-2 text-right font-mono text-green-600">{fmt(totalBalance.total_credit)}</div>
              <div className="col-span-2 text-right font-mono text-red-600">{fmt(totalBalance.total_solde_debiteur)}</div>
              <div className="col-span-2 text-right font-mono text-green-600">{fmt(totalBalance.total_solde_crediteur)}</div>
            </div>

            {/* Contrôle d'arrêté : comptes d'attente (47*) non apurés.
                Placé ENTRE le total et le résultat à dessein : un 4712 garni
                n'entame pas le résultat affiché juste en dessous, et c'est
                précisément ce qui le rend invisible sans ce bandeau. */}
            {!suspens.apure && (
              <div className="px-4 py-3 border-t bg-amber-50 dark:bg-amber-950/20">
                <div className="flex items-start gap-2">
                  <span className="text-amber-600 text-sm leading-5">⚠️</span>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                      Comptes d'attente non apurés — {fmt(suspens.total)} MAD
                    </div>
                    <ul className="mt-1 space-y-0.5">
                      {suspens.comptes.map((c) => (
                        <li key={c.compte} className="text-xs font-mono text-amber-900/90 dark:text-amber-200/90">
                          {c.compte} · {fmt(c.solde)} {c.sens}
                          {c.attenteBancaire && (
                            <span className="ml-2 font-sans text-amber-700 dark:text-amber-300">
                              mouvement de banque sans pièce justificative
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                    <p className="mt-1.5 text-xs text-amber-800/80 dark:text-amber-300/80">
                      À imputer avant l'arrêté : la classe 47 est reportée à l'exercice
                      suivant par l'à-nouveau, et le résultat ci-dessous est faux d'autant.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Résultat net — formation du résultat par les classes 6 et 7. */}
            <div className={`px-4 py-3 border-t ${resultat.benefice ? "bg-emerald-50 dark:bg-emerald-950/20" : "bg-red-50 dark:bg-red-950/20"}`}>
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="text-xs text-muted-foreground font-mono">
                  Produits (classe 7) <strong className="text-green-600">{fmt(resultat.produits)}</strong>
                  <span className="mx-2">−</span>
                  Charges (classe 6) <strong className="text-red-600">{fmt(resultat.charges)}</strong>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`text-sm font-bold ${resultat.benefice ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}`}>
                    {resultat.label}
                  </span>
                  <span className={`font-mono text-xl font-bold ${resultat.benefice ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}`}>
                    {fmt(resultat.montant)} MAD
                  </span>
                </div>
              </div>
            </div>
          </div>
        </TabsContent>

        {/* ── SAISIE MANUELLE ── */}
        <TabsContent value="saisie" className="mt-4">
          <Card className="max-w-2xl">
            <CardContent className="pt-6 space-y-4">
              <h3 className="font-semibold">Nouvelle écriture manuelle</h3>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="text-xs font-medium mb-1 block">Date *</label>
                  <Input type="date" value={newDate} onChange={e=>setNewDate(e.target.value)}/></div>
                <div><label className="text-xs font-medium mb-1 block">Journal *</label>
                  <Select value={newJournal} onValueChange={setNewJournal}>
                    <SelectTrigger><SelectValue/></SelectTrigger>
                    <SelectContent>{JOURNAUX.map(j=><SelectItem key={j} value={j}>{j}</SelectItem>)}</SelectContent>
                  </Select></div>
                <div><label className="text-xs font-medium mb-1 block">Compte *</label>
                  <Input value={newCompte} onChange={e=>setNewCompte(e.target.value)} placeholder="3421" list="comptes-list"/>
                  <datalist id="comptes-list">{pcmComptes.map(c=><option key={c.numero} value={c.numero}>{c.numero} — {c.intitule}</option>)}</datalist>
                </div>
                <div><label className="text-xs font-medium mb-1 block">Réf. pièce</label>
                  <Input value={newRef} onChange={e=>setNewRef(e.target.value)} placeholder="FAC-001"/></div>
              </div>
              <div><label className="text-xs font-medium mb-1 block">Libellé *</label>
                <Input value={newLibelle} onChange={e=>setNewLibelle(e.target.value)} placeholder="Description de l'écriture"/></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="text-xs font-medium mb-1 block text-red-600">Débit (MAD)</label>
                  <Input type="number" step="0.01" value={newDebit||""} onChange={e=>{setNewDebit(parseFloat(e.target.value)||0);if(e.target.value)setNewCredit(0);}}/></div>
                <div><label className="text-xs font-medium mb-1 block text-green-600">Crédit (MAD)</label>
                  <Input type="number" step="0.01" value={newCredit||""} onChange={e=>{setNewCredit(parseFloat(e.target.value)||0);if(e.target.value)setNewDebit(0);}}/></div>
              </div>
              <Button onClick={ajouterEcriture} disabled={saving} className="w-full">
                {saving?<Loader2 className="h-4 w-4 mr-2 animate-spin"/>:<Plus className="h-4 w-4 mr-2"/>}
                Ajouter l'écriture
              </Button>
            </CardContent>
          </Card>

          {/* Suppression rapide par lot pour les tests */}
          <Card className="max-w-2xl mt-4 border-red-200">
            <CardContent className="pt-4 pb-4">
              <p className="text-sm font-medium text-red-700 mb-3 flex items-center gap-2">
                <Trash2 className="h-4 w-4"/>Zone de test — Suppression par lot
              </p>
              <div className="grid grid-cols-3 gap-2">
                {JOURNAUX.map(j => (
                  <Button key={j} variant="outline" size="sm" className="border-red-200 text-red-600 hover:bg-red-50"
                    onClick={()=>{setDeleteLot({journal:j});setConfirmDelete(true);}}>
                    Supprimer tout {j}
                  </Button>
                ))}
                <Button variant="destructive" size="sm"
                  onClick={()=>{setDeleteLot({});setConfirmDelete(true);}}>
                  ⚠️ Tout supprimer
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── LETTRAGE & RAPPROCHEMENT DES COMPTES DE TIERS ── */}
        <TabsContent value="lettrage" className="mt-4">
          <LettrageManuel dossierId={dossierId} />
        </TabsContent>

        {/* ── IMPORT EXCEL (réversible) ── */}
        <TabsContent value="import" className="mt-4">
          <ImportGrandLivre dossierId={dossierId} onDone={load} />
        </TabsContent>
      </Tabs>

      {/* Confirmation suppression */}
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader><DialogTitle>Confirmer la suppression</DialogTitle></DialogHeader>
          <div className="text-sm text-muted-foreground">
            {deleteLot !== null ? (
              deleteLot.journal||deleteLot.date
                ? `Supprimer toutes les écritures ${deleteLot.journal?`du journal ${deleteLot.journal}`:""}${deleteLot.date?` du ${deleteLot.date}`:""} ?`
                : "⚠️ Supprimer TOUTES les écritures comptables de ce dossier ?"
            ) : (
              `Supprimer ${deleteIds.size} écriture(s) sélectionnée(s) ?`
            )}
            <p className="mt-2 text-red-600 font-medium">Cette action est irréversible.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={()=>{setConfirmDelete(false);setDeleteLot(null);}}>Annuler</Button>
            <Button variant="destructive" disabled={saving}
              onClick={deleteLot!==null ? supprimerLot : supprimerSelection}>
              {saving?<Loader2 className="h-4 w-4 mr-2 animate-spin"/>:<Trash2 className="h-4 w-4 mr-2"/>}
              Confirmer la suppression
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
