import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { ArrowLeft, Loader2, RefreshCw, TrendingUp, TrendingDown, FileText, ExternalLink, Download, X, CheckCircle2, Clock, Eye, EyeOff, Lock } from "lucide-react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { lettrerDossier } from "@/server/lettrage.functions";
import { deriveCategorie, genererLignesBQ, PCM_MAP } from "@/lib/comptabilite-bq";

export const Route = createFileRoute("/_app/dossiers/$dossierId/banque/$releveId")({
  component: ReleveDetailPage,
});

const fmt = (n: number) => Number(n).toLocaleString("fr-MA", { minimumFractionDigits: 2 }) + " MAD";

// Type MIME déduit de l'extension — sert de repli quand le relevé n'a pas de
// fichier_type stocké, pour forcer un affichage inline correct (PDF / image).
const mimeFromName = (name?: string | null): string | null => {
  const ext = (name || "").toLowerCase().split(".").pop() || "";
  if (ext === "pdf") return "application/pdf";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png" || ext === "gif" || ext === "webp" || ext === "bmp") return `image/${ext}`;
  if (ext === "svg") return "image/svg+xml";
  return null;
};

// Taux de TVA marocains standards — on « aimante » le taux reconstitué vers le plus
// proche quand l'écart est minime (< 1 pt), pour gommer les écarts de centimes.
const TAUX_TVA_STANDARD = [0, 7, 10, 14, 20];
const snapTauxTva = (taux: number | null): number | null => {
  if (taux == null || !isFinite(taux)) return null;
  const proche = TAUX_TVA_STANDARD.reduce((best, t) => (Math.abs(t - taux) < Math.abs(best - taux) ? t : best), TAUX_TVA_STANDARD[0]);
  if (Math.abs(proche - taux) <= 1) return proche;        // taux standard le plus proche
  return Math.round(taux * 10) / 10;                       // sinon arrondi à 1 décimale
};

interface Releve {
  id: string; compte_id: string | null; fichier_nom: string | null; fichier_path: string | null;
  fichier_type: string | null; banque: string | null; rib: string | null;
  periode_debut: string | null; periode_fin: string | null;
  solde_initial: number; solde_final: number; nombre_transactions: number; statut: string;
}
interface Tx {
  id: string; date_operation: string; libelle: string | null; type: string; montant: number;
  statut: string | null; rapproche: boolean; facture_id: string | null; justificatif_id: string | null;
  document_type: string | null; categorie: string | null; compte_comptable: string | null;
}

const STATUT_BADGE: Record<string, { label: string; cls: string }> = {
  brouillon: { label: "Brouillon", cls: "bg-yellow-100 text-yellow-700" },
  actif:     { label: "Actif",     cls: "bg-blue-100 text-blue-700" },
  cloture:   { label: "Clôturé",   cls: "bg-gray-200 text-gray-600" },
};

const TYPE_DOC_LBL: Record<string, string> = {
  facture: "Facture", bon_commande: "Bon de commande", bon_livraison: "Bon de livraison", devis: "Devis",
  recu: "Reçu", addition: "Addition", note_frais: "Note de frais", ticket_carburant: "Ticket carburant",
  avis_debit: "Avis de débit", dum: "DUM / Import", quittance_cnss: "Quittance CNSS", quittance_dgi: "Quittance DGI",
  quittance_eau: "Quittance eau", quittance_elec: "Quittance électricité", quittance_loyer: "Quittance loyer",
  contrat: "Contrat", autre: "Autre",
};

function ReleveDetailPage() {
  const { dossierId, releveId } = Route.useParams();
  const lettrerFn = useServerFn(lettrerDossier);

  const [releve, setReleve] = useState<Releve | null>(null);
  const [txs, setTxs] = useState<Tx[]>([]);
  const [facturesClient, setFacturesClient] = useState<any[]>([]);
  const [facturesFourn, setFacturesFourn] = useState<any[]>([]);
  const [justificatifs, setJustificatifs] = useState<any[]>([]);
  const [docUrl, setDocUrl] = useState<string | null>(null);
  // Object URL du blob téléchargé — conservé pour révocation (anti fuite mémoire).
  const objectUrlRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [rematchLoading, setRematchLoading] = useState(false);
  const [cloturerLoading, setCloturerLoading] = useState(false);
  const [selectedTxId, setSelectedTxId] = useState<string | null>(null);
  const [rightMode, setRightMode] = useState<"piece" | "scan">("scan");
  // Inbox Zero (style Odoo) : par défaut on masque les lignes déjà lettrées,
  // pour ne laisser que les transactions « À traiter ».
  const [showLettrees, setShowLettrees] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const { data: r } = await (supabase.from("releves_bancaires") as any).select("*").eq("id", releveId).single();
      setReleve(r ?? null);

      const { data: t } = await (supabase.from("transactions_bancaires") as any)
        .select("id,date_operation,libelle,type,montant,statut,rapproche,facture_id,justificatif_id,document_type,categorie,compte_comptable")
        .eq("releve_id", releveId).order("date_operation", { ascending: true });
      setTxs(t ?? []);

      const [{ data: fc }, { data: ff }, { data: j }] = await Promise.all([
        (supabase as any).from("factures").select("id,numero,date_facture,montant_ht,montant_tva,montant_ttc,statut_paiement,fichier_original_url,clients(nom)").eq("dossier_id", dossierId),
        (supabase as any).from("factures_fournisseurs").select("id,numero,date_facture,montant_ht,montant_tva,montant_ttc,statut_paiement,fournisseur_nom").eq("dossier_id", dossierId),
        (supabase as any).from("justificatifs").select("id,numero_piece,numero_commande,date_document,date_commande,type_document,nom_tiers,montant_ht,montant_ttc,taux_tva,eligible_edi,categorie_pcm,compte_pcm,statut,lignes,bon_commande_id,devis_id").eq("dossier_id", dossierId),
      ]);
      setFacturesClient(fc ?? []); setFacturesFourn(ff ?? []); setJustificatifs(j ?? []);

      // Aperçu du document original (bucket privé releves-bancaires).
      // On TÉLÉCHARGE le binaire puis on le réexpose en blob avec le bon type MIME :
      // l'affichage est ainsi garanti INLINE dans l'iframe/img, même si le stockage
      // renvoie un Content-Type générique (octet-stream) qui forcerait sinon le
      // navigateur à télécharger le fichier au lieu de l'afficher. La même URL blob
      // sert au bouton « Télécharger » (attribut download).
      if (objectUrlRef.current) { URL.revokeObjectURL(objectUrlRef.current); objectUrlRef.current = null; }
      if (r?.fichier_path) {
        const { data: blob } = await supabase.storage.from("releves-bancaires").download(r.fichier_path);
        if (blob) {
          const mime = r.fichier_type || mimeFromName(r.fichier_nom) || blob.type || "application/octet-stream";
          const typed = blob.type === mime ? blob : new Blob([blob], { type: mime });
          const url = URL.createObjectURL(typed);
          objectUrlRef.current = url;
          setDocUrl(url);
        } else setDocUrl(null);
      } else setDocUrl(null);
    } catch (e: any) { toast.error(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [releveId]);

  // Libère l'object URL du blob au démontage du composant.
  useEffect(() => () => { if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current); }, []);

  // Relevé clôturé : le lettrage RESTE possible (modèle Odoo). Le verrou ne
  // s'applique plus à l'association de pièces — seul le re-matching global est figé.
  const isLocked = releve?.statut === "cloture";

  // Tant que le relevé est EN COURS DE TRAITEMENT (non clôturé), on affiche toutes
  // les lignes pour garder les contrôles d'action/modification visibles sur chacune.
  // Une fois clôturé, on bascule en « Inbox Zero » (lettrées masquées par défaut).
  useEffect(() => {
    if (releve) setShowLettrees(releve.statut !== "cloture");
  }, [releve?.statut]);

  // Valeur du Select de liaison pour une transaction
  const selValue = (t: Tx) => t.justificatif_id ? `jus:${t.justificatif_id}` : t.facture_id ? `fac:${t.facture_id}` : "none";

  const assignerDoc = async (t: Tx, value: string) => {
    // Une transaction déjà clôturée conserve son statut 'cloture' (écritures déjà
    // générées) : l'association/désassociation ne fait que basculer le compte de
    // contrepartie (compte d'attente 471 ↔ compte final) via le trigger SQL.
    const keepCloture = t.statut === "cloture";
    let upd: any;
    if (value === "none") {
      upd = { facture_id: null, justificatif_id: null, document_type: null, statut: keepCloture ? "cloture" : "ouvert", rapproche: false };
    } else if (value.startsWith("jus:")) {
      upd = { justificatif_id: value.slice(4), facture_id: null, document_type: "justificatif", statut: keepCloture ? "cloture" : "ferme", rapproche: true };
    } else {
      const id = value.slice(4);
      const isClient = facturesClient.some((f) => f.id === id);
      upd = { facture_id: id, justificatif_id: null, document_type: isClient ? "facture_client" : "facture_fournisseur", statut: keepCloture ? "cloture" : "ferme", rapproche: true };
    }
    const { error } = await (supabase.from("transactions_bancaires") as any).update(upd).eq("id", t.id);
    if (error) { toast.error(error.message); return; }
    setTxs((prev) => prev.map((x) => x.id === t.id ? { ...x, ...upd } : x));
    // Lettrage → affiche la pièce ; délettrage → la ligne réapparaît dans « À traiter »
    if (value !== "none") { setSelectedTxId(t.id); setRightMode("piece"); }
    else if (selectedTxId === t.id) setRightMode("scan");
  };

  const reMatcher = async () => {
    setRematchLoading(true);
    try {
      const res = await lettrerFn({ data: { dossierId, releveId } });
      if (res.lies > 0) { toast.success(`${res.lies} transaction(s) liée(s)`); await load(); }
      else toast.info("Aucune nouvelle correspondance");
    } catch (e: any) { toast.error(e.message); }
    finally { setRematchLoading(false); }
  };

  // ── Clôturer le relevé (modèle Odoo / Grand Livre continu) ───────────────────
  // Génère une écriture BQ pour TOUTES les transactions du relevé non encore
  // clôturées — lettrées (compte tiers/PCM) comme orphelines (compte d'attente
  // 4711/4712). Chaque écriture porte transaction_id → le trigger SQL substitue
  // dynamiquement le compte d'attente lors d'un lettrage tardif.
  const cloturerReleve = async () => {
    const txAcloturer = txs.filter((t) => (t.statut ?? (t.rapproche ? "ferme" : "ouvert")) !== "cloture");
    if (!txAcloturer.length) { toast.info("Aucune transaction à clôturer — tout est déjà comptabilisé"); return; }
    if (!window.confirm(`Clôturer ce relevé ?\n\n${txAcloturer.length} transaction(s) seront comptabilisées au Journal BQ. Les lignes sans pièce seront parquées sur le compte d'attente 4711/4712 (lettrage tardif resté possible).`)) return;
    setCloturerLoading(true);
    try {
      const ecritures: any[] = [];
      for (const tx of txAcloturer) {
        // Catégorie : valeur stockée si valide, sinon dérivée du libellé.
        const storedCat = tx.categorie ?? undefined;
        const cat = storedCat && PCM_MAP[storedCat]
          ? storedCat
          : deriveCategorie(tx.libelle || "", tx.type === "credit" ? "credit" : "debit").categorie;

        // Normaliser la date → YYYY-MM-DD (le relevé peut stocker JJ/MM/AAAA).
        const raw = tx.date_operation;
        const p = raw.split("/");
        const date = p.length === 3 && p[2]?.length === 4 ? `${p[2]}-${p[1]}-${p[0]}` : raw;
        const justif = tx.justificatif_id ? justificatifs.find((j: any) => j.id === tx.justificatif_id) : null;

        for (const l of genererLignesBQ({ libelle: tx.libelle, type: tx.type, montant: tx.montant, categorie: cat, compteComptable: tx.compte_comptable, factureLiee: !!tx.facture_id, justificatif: justif })) {
          ecritures.push({ dossier_id: dossierId, journal_code: "BQ", compte_numero: l.compte, date_ecriture: date, libelle: l.libelle, debit: l.debit, credit: l.credit, valide: true, transaction_id: tx.id });
        }
      }

      const { error: ecrErr } = await supabase.from("ecritures_comptables").insert(ecritures);
      if (ecrErr) throw ecrErr;
      const { error: txErr } = await (supabase.from("transactions_bancaires") as any)
        .update({ statut: "cloture" }).in("id", txAcloturer.map((t) => t.id));
      if (txErr) throw txErr;
      // Marquer le relevé clôturé si toutes ses transactions le sont désormais.
      await (supabase.from("releves_bancaires") as any).update({ statut: "cloture" }).eq("id", releveId);

      const nbOrphelines = txAcloturer.filter((t) => !t.facture_id && !t.justificatif_id).length;
      toast.success(`${txAcloturer.length} transaction(s) clôturée(s) — ${ecritures.length} écriture(s) générée(s)${nbOrphelines ? ` (dont ${nbOrphelines} en compte d'attente 471)` : ""}`);
      await load();
    } catch (e: any) { toast.error(e.message); }
    finally { setCloturerLoading(false); }
  };

  const docLabel = (t: Tx) => {
    if (t.justificatif_id) { const j = justificatifs.find((x) => x.id === t.justificatif_id); return j ? `📎 ${j.nom_tiers || j.numero_piece || "Justificatif"}` : "📎 Justificatif"; }
    if (t.facture_id) {
      const f = facturesClient.find((x) => x.id === t.facture_id) || facturesFourn.find((x) => x.id === t.facture_id);
      return f ? `🔗 ${f.numero || (f as any).clients?.nom || (f as any).fournisseur_nom || "Facture"}` : "🔗 Facture";
    }
    return null;
  };

  const totaux = useMemo(() => {
    const cr = txs.filter((t) => t.type === "credit").reduce((s, t) => s + Number(t.montant), 0);
    const db = txs.filter((t) => t.type !== "credit").reduce((s, t) => s + Number(t.montant), 0);
    const lettrees = txs.filter((t) => t.facture_id || t.justificatif_id).length;
    return { cr, db, lettrees };
  }, [txs]);

  const isImage = (releve?.fichier_type || mimeFromName(releve?.fichier_nom) || "").startsWith("image/");

  // ── Pièce liée à la transaction sélectionnée (lettrage enrichi) ──
  const selectedTx = txs.find((t) => t.id === selectedTxId) ?? null;
  const pieceForTx = (t: Tx | null): { kind: "facture_client" | "facture_fourn" | "justificatif"; data: any } | null => {
    if (!t) return null;
    if (t.justificatif_id) { const j = justificatifs.find((x) => x.id === t.justificatif_id); return j ? { kind: "justificatif", data: j } : null; }
    if (t.facture_id) {
      const fc = facturesClient.find((x) => x.id === t.facture_id); if (fc) return { kind: "facture_client", data: fc };
      const ff = facturesFourn.find((x) => x.id === t.facture_id); if (ff) return { kind: "facture_fourn", data: ff };
    }
    return null;
  };
  const piece = pieceForTx(selectedTx);
  const resoudreRef = (id: string | null) => id ? (justificatifs.find((x) => x.id === id)?.numero_piece ?? null) : null;
  const selectTx = (t: Tx) => { setSelectedTxId(t.id); setRightMode("piece"); };

  // Inbox Zero : une transaction est « lettrée » dès qu'une pièce y est liée.
  const estLettree = (t: Tx) => !!(t.facture_id || t.justificatif_id);
  const nbLettrees = txs.filter(estLettree).length;
  const visibleTxs = showLettrees ? txs : txs.filter((t) => !estLettree(t));

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      {/* En-tête */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="sm">
            <Link to="/dossiers/$dossierId/banque" params={{ dossierId }}><ArrowLeft className="h-4 w-4 mr-1" />Relevés</Link>
          </Button>
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              {releve?.banque || "Relevé"}
              {releve && <Badge className={STATUT_BADGE[releve.statut]?.cls ?? ""}>{STATUT_BADGE[releve.statut]?.label ?? releve.statut}</Badge>}
            </h1>
            <p className="text-sm text-muted-foreground">
              {releve?.fichier_nom} · {releve?.periode_debut ?? "?"} → {releve?.periode_fin ?? "?"} · {releve?.nombre_transactions ?? txs.length} transactions
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={reMatcher} disabled={rematchLoading}>
            {rematchLoading ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
            Re-matcher ce relevé
          </Button>
          {isLocked ? (
            <Badge className="bg-gray-100 text-gray-600 gap-1 border-0 h-8 px-3"><Lock className="h-3.5 w-3.5" />Clôturé</Badge>
          ) : (
            <Button size="sm" onClick={cloturerReleve} disabled={cloturerLoading || loading}
              className="bg-green-600 hover:bg-green-700 text-white">
              {cloturerLoading ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />}
              Clôturer le relevé
            </Button>
          )}
        </div>
      </div>

      {/* Bandeau soldes */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        {[
          { label: "Solde initial", value: fmt(releve?.solde_initial ?? 0) },
          { label: "Solde final", value: fmt(releve?.solde_final ?? 0) },
          { label: "Total crédits", value: fmt(totaux.cr) },
          { label: "Total débits", value: fmt(totaux.db) },
          { label: "Lettrées", value: `${totaux.lettrees}/${txs.length}` },
        ].map((k) => (
          <Card key={k.label} className="border-0 bg-muted/40"><CardContent className="pt-3 pb-3">
            <p className="text-[10px] text-muted-foreground uppercase">{k.label}</p>
            <p className="font-semibold text-sm mt-0.5">{k.value}</p>
          </CardContent></Card>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin mr-2" />Chargement…</div>
      ) : (
        /* SPLIT-SCREEN : transactions à gauche, document à droite */
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* GAUCHE — transactions + lettrage */}
          <Card><CardContent className="p-0">
            {/* Barre Inbox Zero : à traiter vs lettrées masquées */}
            <div className="flex items-center justify-between gap-2 px-3 py-2 border-b">
              <p className="text-xs font-medium">
                {showLettrees
                  ? <>Toutes les lignes · <span className="text-muted-foreground">{nbLettrees} lettrée(s)</span></>
                  : <><span className="text-orange-600 font-semibold">{txs.length - nbLettrees}</span> à traiter
                      {nbLettrees > 0 && <span className="text-muted-foreground"> · {nbLettrees} lettrée(s) masquée(s)</span>}</>}
              </p>
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setShowLettrees((v) => !v)}>
                {showLettrees ? <><EyeOff className="h-3.5 w-3.5 mr-1" />Masquer les lettrées</> : <><Eye className="h-3.5 w-3.5 mr-1" />Afficher les lignes lettrées</>}
              </Button>
            </div>
            <div className="max-h-[68vh] overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 bg-card z-10"><TableRow>
                  <TableHead>Date</TableHead><TableHead>Libellé</TableHead>
                  <TableHead className="text-right">Montant</TableHead><TableHead>Document lié</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {txs.length === 0
                    ? <TableRow><TableCell colSpan={4} className="text-center py-10 text-muted-foreground">Aucune transaction</TableCell></TableRow>
                    : visibleTxs.length === 0
                    ? <TableRow><TableCell colSpan={4} className="text-center py-10 text-muted-foreground">
                        ✅ Tout est lettré — rien à traiter. <button className="underline" onClick={() => setShowLettrees(true)}>Afficher les lignes lettrées</button>
                      </TableCell></TableRow>
                    : visibleTxs.map((t) => (
                      <TableRow key={t.id}
                        onClick={() => selectTx(t)}
                        className={`cursor-pointer ${t.statut === "cloture" ? "opacity-70" : ""} ${selectedTxId === t.id ? "bg-primary/5 border-l-2 border-l-primary" : "hover:bg-muted/40"}`}>
                        <TableCell className="text-xs font-mono whitespace-nowrap">{new Date(t.date_operation).toLocaleDateString("fr-MA")}</TableCell>
                        <TableCell className="text-sm max-w-[180px] truncate" title={t.libelle ?? ""}>{t.libelle}</TableCell>
                        <TableCell className={`text-right font-mono text-sm whitespace-nowrap ${t.type === "credit" ? "text-green-600" : "text-red-600"}`}>
                          {t.type === "credit" ? <TrendingUp className="h-3 w-3 inline mr-0.5" /> : <TrendingDown className="h-3 w-3 inline mr-0.5" />}
                          {fmt(t.montant)}
                        </TableCell>
                        <TableCell className="min-w-[210px]" onClick={(e) => e.stopPropagation()}>
                          <Select value={selValue(t)} onValueChange={(v) => assignerDoc(t, v)}>
                            <SelectTrigger className={`h-7 text-xs ${t.facture_id || t.justificatif_id ? "border-green-400 bg-green-50" : "border-orange-300 bg-orange-50"}`}>
                              <span className="truncate">{docLabel(t) ?? "⚠️ Aucun — choisir"}</span>
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none" className="text-xs text-muted-foreground">Aucun document</SelectItem>
                              {facturesFourn.map((f) => <SelectItem key={f.id} value={`fac:${f.id}`} className="text-xs">📥 {f.numero || f.fournisseur_nom} — {fmt(Number(f.montant_ttc))}</SelectItem>)}
                              {facturesClient.map((f) => <SelectItem key={f.id} value={`fac:${f.id}`} className="text-xs">📤 {f.numero || f.clients?.nom} — {fmt(Number(f.montant_ttc))}</SelectItem>)}
                              {justificatifs.map((j) => <SelectItem key={j.id} value={`jus:${j.id}`} className="text-xs">📎 {j.nom_tiers || j.numero_piece} — {fmt(Number(j.montant_ttc))}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </div>
          </CardContent></Card>

          {/* DROITE — Pièce liée (lettrage enrichi) OU document scanné */}
          <Card><CardContent className="p-0 h-[72vh] flex flex-col">
            {/* Sélecteur de vue */}
            <div className="flex items-center gap-1 p-2 border-b">
              <button onClick={() => setRightMode("piece")}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${rightMode === "piece" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}>
                Pièce liée
              </button>
              <button onClick={() => setRightMode("scan")}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${rightMode === "scan" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}>
                Relevé scanné
              </button>
              {rightMode === "piece" && selectedTx && (
                <span className="ml-auto text-[11px] text-muted-foreground truncate max-w-[45%]">
                  {new Date(selectedTx.date_operation).toLocaleDateString("fr-MA")} · {fmt(selectedTx.montant)}
                </span>
              )}
            </div>

            {rightMode === "scan" ? (
              <>
                {!docUrl ? (
                  <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-2">
                    <FileText className="h-10 w-10 opacity-30" />
                    <p className="text-sm">Aucun document scanné associé à ce relevé</p>
                  </div>
                ) : isImage ? (
                  <div className="flex-1 overflow-auto p-2"><img src={docUrl} alt="Relevé scanné" className="w-full h-auto" /></div>
                ) : (
                  <iframe src={docUrl} title="Document du relevé" className="flex-1 w-full" />
                )}
                {docUrl && (
                  <div className="border-t p-2 flex items-center justify-between gap-2">
                    <span className="text-[11px] text-muted-foreground truncate max-w-[55%]">{releve?.fichier_nom}</span>
                    <div className="flex items-center gap-1">
                      <Button asChild variant="ghost" size="sm">
                        <a href={docUrl} download={releve?.fichier_nom ?? true}><Download className="h-3.5 w-3.5 mr-1" />Télécharger</a>
                      </Button>
                      <Button asChild variant="ghost" size="sm">
                        <a href={docUrl} target="_blank" rel="noreferrer"><ExternalLink className="h-3.5 w-3.5 mr-1" />Plein écran</a>
                      </Button>
                    </div>
                  </div>
                )}
              </>
            ) : !selectedTx ? (
              <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-2 p-6 text-center">
                <FileText className="h-10 w-10 opacity-30" />
                <p className="text-sm">Cliquez une transaction à gauche pour afficher la pièce justificative associée.</p>
              </div>
            ) : !piece ? (
              <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-2 p-6 text-center">
                <X className="h-10 w-10 opacity-30" />
                <p className="text-sm">Transaction non lettrée — associez une facture ou un justificatif via la liste déroulante.</p>
              </div>
            ) : (() => {
              const f = piece.data;
              const isJustif = piece.kind === "justificatif";
              const titre = piece.kind === "facture_client" ? "Facture client"
                : piece.kind === "facture_fourn" ? "Facture fournisseur"
                : (TYPE_DOC_LBL[f.type_document] ?? f.type_document ?? "Justificatif");
              const tiers = piece.kind === "facture_client" ? (f.clients?.nom ?? "—")
                : piece.kind === "facture_fourn" ? (f.fournisseur_nom ?? "—")
                : (f.nom_tiers ?? "—");
              const numero = isJustif ? (f.numero_piece ?? "—") : (f.numero ?? "—");
              const dateP = isJustif ? f.date_document : f.date_facture;
              const ht = Number(f.montant_ht ?? 0);
              const ttc = Number(f.montant_ttc ?? 0);
              const tva = isJustif ? (ttc - ht) : Number(f.montant_tva ?? 0);
              // Taux de TVA : stocké pour les justificatifs, sinon reconstitué depuis HT/TVA,
              // puis aimanté vers le taux marocain standard le plus proche.
              const tauxStocke = isJustif && f.taux_tva != null && f.taux_tva !== "" ? Number(f.taux_tva) : null;
              const tauxTva = snapTauxTva(tauxStocke ?? (ht > 0 ? (tva / ht) * 100 : null));
              // Lettrée = transaction rapprochée (validée) ; sinon en attente de validation
              const estLettree = !!selectedTx?.rapproche;
              const bcRef = isJustif ? resoudreRef(f.bon_commande_id) : null;
              const devisRef = isJustif ? resoudreRef(f.devis_id) : null;
              const lignes: any[] = isJustif && Array.isArray(f.lignes) ? f.lignes : [];
              return (
                <div className="flex-1 overflow-auto p-4 space-y-4">
                  {/* En-tête pièce + statut de lettrage visuel */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge className="bg-indigo-100 text-indigo-700">{titre}</Badge>
                    {estLettree
                      ? <Badge className="bg-green-100 text-green-700 gap-1 border-0"><CheckCircle2 className="h-3 w-3" />Lettrée</Badge>
                      : <Badge className="bg-amber-100 text-amber-700 gap-1 border-0"><Clock className="h-3 w-3" />En attente de validation</Badge>}
                    {f.statut_paiement && <Badge variant="outline" className="text-xs">{f.statut_paiement}</Badge>}
                    {isJustif && f.statut && <Badge variant="outline" className="text-xs">{f.statut}</Badge>}
                  </div>

                  {/* Bloc métadonnées propre — détails contextuels extraits par OCR */}
                  <div className="rounded-lg border overflow-hidden">
                    <div className="px-3 py-1.5 bg-muted/50 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Détails de la facture
                    </div>
                    <dl className="divide-y text-xs">
                      {[
                        { l: "Émetteur / Tiers", v: tiers },
                        { l: "N° de facture", v: numero, mono: true },
                        { l: "Date de la facture", v: dateP ? new Date(dateP).toLocaleDateString("fr-MA") : "—" },
                        { l: "Montant HT", v: fmt(ht), mono: true },
                        { l: "Taux de TVA", v: tauxTva != null ? `${tauxTva} %` : "—", mono: true },
                        { l: "Montant TVA", v: fmt(tva), mono: true },
                        { l: "Montant TTC", v: fmt(ttc), mono: true, strong: true },
                      ].map((m) => (
                        <div key={m.l} className="flex items-center justify-between gap-3 px-3 py-1.5">
                          <dt className="text-muted-foreground shrink-0">{m.l}</dt>
                          <dd className={`text-right truncate ${m.mono ? "font-mono" : ""} ${m.strong ? "font-semibold text-sm" : ""}`}>{m.v}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>

                  {/* Imputation + chaîne documentaire (justificatif) */}
                  {isJustif && (
                    <div className="space-y-1 text-xs">
                      {f.compte_pcm && <div className="flex justify-between"><span className="text-muted-foreground">Compte PCM</span><span className="font-mono">{f.compte_pcm}</span></div>}
                      {f.categorie_pcm && <div className="flex justify-between"><span className="text-muted-foreground">Catégorie</span><span>{f.categorie_pcm}</span></div>}
                      {f.numero_commande && <div className="flex justify-between"><span className="text-muted-foreground">N° commande</span><span className="font-mono">{f.numero_commande}</span></div>}
                      {bcRef && <div className="flex justify-between"><span className="text-muted-foreground">Bon de commande lié</span><span className="font-mono">{bcRef}</span></div>}
                      {devisRef && <div className="flex justify-between"><span className="text-muted-foreground">Devis lié</span><span className="font-mono">{devisRef}</span></div>}
                    </div>
                  )}

                  {/* Lignes du justificatif */}
                  {lignes.length > 0 && (
                    <div className="rounded-lg border overflow-hidden">
                      <div className="grid grid-cols-12 gap-1 px-2 py-1.5 bg-muted text-[10px] font-semibold uppercase text-muted-foreground">
                        <div className="col-span-6">Désignation</div>
                        <div className="col-span-2 text-right">Qté</div>
                        <div className="col-span-4 text-right">PU</div>
                      </div>
                      {lignes.map((l, i) => (
                        <div key={i} className="grid grid-cols-12 gap-1 px-2 py-1 border-t text-xs">
                          <div className="col-span-6 truncate" title={l.designation}>{l.designation || "—"}</div>
                          <div className="col-span-2 text-right font-mono">{l.quantite}</div>
                          <div className="col-span-4 text-right font-mono">{fmt(Number(l.prix_unitaire ?? 0))}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Aperçu du document (facture client avec PDF) */}
                  {piece.kind === "facture_client" && f.fichier_original_url && (
                    <div className="rounded-lg border overflow-hidden">
                      <iframe src={f.fichier_original_url} title="Facture" className="w-full h-[40vh]" />
                      <div className="border-t p-2 flex justify-end">
                        <Button asChild variant="ghost" size="sm"><a href={f.fichier_original_url} target="_blank" rel="noreferrer"><ExternalLink className="h-3.5 w-3.5 mr-1" />Ouvrir la facture</a></Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </CardContent></Card>
        </div>
      )}

      {isLocked && (
        <p className="mt-3 text-xs text-muted-foreground flex items-center gap-1"><CheckCircle2 className="h-3 w-3" />Relevé clôturé — écritures générées. Le lettrage tardif reste possible : le compte d'attente 471 est automatiquement remplacé par le compte final.</p>
      )}
    </div>
  );
}
