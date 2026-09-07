import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useServerFn } from "@tanstack/react-start";
import { generateFactureXml, ocrFacture, ajouterEmailClient, matcherDocumentAvecTransactions } from "@/server/factures.functions";
import { genererPdfA3Facture } from "@/server/efacture.functions";
import { PaiementEspecesDialog } from "@/components/PaiementEspecesDialog";
import { DateReglementCell } from "@/components/DateReglementCell";
import { PREFIXE_RECLASS_TVA, referencesPiece } from "@/services/lettrage";
import { annulerPaiementFacture } from "@/server/paiements.functions";
import { memoriserTiers } from "@/server/tiers-memoire.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, FileCode, FileCheck2, Eye, CheckCircle, Upload, Loader2, Download, X, AlertCircle, CheckCircle2, UserPlus, Clock, Mail, FileText, Trash2, Undo2, Banknote } from "lucide-react";
import { EcheancesInput, buildEcheancesPayload, type Echeance } from "@/components/EcheancesInput";
import { DocumentViewer, type DocumentViewerSource } from "@/components/DocumentViewer";
import { logAudit } from "@/lib/audit";
import { puHtToTtc } from "@/lib/tva";
import { preparerImagePourOcr, journaliserPayload } from "@/lib/image-optimize";
import { PuTtcInput } from "@/components/PuTtcInput";
import { FacturesFiltres } from "@/components/FacturesFiltres";
import { BadgeStatutDgi, FactureElectroniquePanel } from "@/components/FactureElectroniquePanel";
import { filtrerFactures, joursRetard, trancheRetard, type CriteresFiltre } from "@/lib/factures-filtres";
import { suggestAccount, type SuggestionCompte } from "@/lib/categorization-engine";
import {
  indexerModesPaiement, modePaiementFacture,
  MODE_PAIEMENT_LABEL, MODE_PAIEMENT_CLS, type ModePaiement,
} from "@/lib/mode-paiement";
import {
  dateReglementFacture, formaterDateReglement, indexerDatesReglement,
  infobulleDateReglement, type DateReglement,
} from "@/lib/date-reglement";
import { toast } from "sonner";

interface Ligne { designation: string; quantite: number; prix_unitaire: number; taux_tva: number }
interface Client { id: string; nom: string; ice: string | null; email: string | null; compte_produit_defaut?: string | null }
interface Facture {
  id: string; numero: string | null; date_facture: string; date_echeance: string | null;
  client_id: string | null; statut: string; statut_paiement: string; statut_dgi: string | null; dgi_status?: string | null;
  montant_ht: number; montant_ttc: number; montant_tva: number;
  type: string; montant_paye: number; montant_restant: number; mode_reglement: string | null;
  xml_ubl: string | null; hash_sha256: string | null; dgi_uuid: string | null; dgi_response: any;
  fichier_original_url: string | null; fichier_original_nom: string | null; fichier_original_type: string | null;
  lignes?: Ligne[] | null;
}

interface OcrData {
  client_nom_extrait: string; ice_client: string | null; numero_facture: string | null;
  date_facture: string | null; date_echeance: string | null; delai_paiement_jours: number | null;
  mode_reglement: string | null; montant_ht: number; montant_tva: number; montant_ttc: number;
  type_facture: string; numero_commande: string | null; numero_acompte: number | null;
  taux_tva: number | null;
  montant_commande_total_ht: number | null; montant_commande_total_ttc: number | null;
  montant_restant_du: number | null; lignes: Ligne[]; confidence: string; method: string;
  client_id: string | null; client_action: "found"|"created"|"not_found"; client_trouve: any;
  sens_facture: string; emetteur_nom: string | null;
}

const fmt = (n: number) => Number(n).toLocaleString("fr-MA", { minimumFractionDigits: 2 }) + " MAD";

// Promise-based cache — prevents double-init race when two files uploaded simultaneously
let _pdfjsLib: any = null;
let _pdfjsInitPromise: Promise<any> | null = null;

async function getPdfjsLib(): Promise<any> {
  if (_pdfjsLib) return _pdfjsLib;
  if (!_pdfjsInitPromise) {
    _pdfjsInitPromise = (async () => {
      const lib = await import("pdfjs-dist");
      lib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
      _pdfjsLib = lib;
      return lib;
    })();
  }
  return _pdfjsInitPromise;
}

// Types de facture valides attendus par l'OCR
const VALID_FACTURE_TYPES = ["standard", "acompte", "solde", "avoir"] as const;

/**
 * Statut de la facture. Le retard prime sur « en attente » / « acompte » : dès que
 * l'échéance est dépassée et qu'il reste à encaisser, le badge porte le nombre de
 * jours, recalculé à chaque rendu (rien n'est stocké, rien ne se périme).
 */
function StatutPaiementBadge({ f }: { f: Facture }) {
  if (f.statut_paiement === "payee")
    return <Badge className="bg-green-100 text-green-700 text-xs">✅ Payée</Badge>;

  const jours = joursRetard(f);
  if (jours != null) {
    const tranche = trancheRetard(jours);
    return (
      <Badge className={`${tranche?.cls ?? "bg-red-100 text-red-700"} text-xs`}
        title={`Échéance dépassée de ${jours} jour${jours > 1 ? "s" : ""}`}>
        ⚠️ En retard ({jours} j)
      </Badge>
    );
  }

  if (f.statut_paiement === "partielle")
    return <Badge className="bg-blue-100 text-blue-700 text-xs">🔵 Acompte partiel</Badge>;
  if (f.type === "acompte")
    return <Badge className="bg-orange-100 text-orange-700 text-xs">🟠 Acompte</Badge>;
  return <Badge variant="secondary" className="text-xs">En attente</Badge>;
}

/**
 * Mode de règlement constaté. Une facture non réglée n'en a pas : la cellule
 * reste vide plutôt que d'afficher le mode simplement prévu à la création.
 */
function ModePaiementCell({ mode }: { mode: ModePaiement | null }) {
  if (!mode) return <span className="text-muted-foreground text-xs">—</span>;
  return (
    <span className={`text-[11px] px-2 py-0.5 rounded-full border font-medium ${MODE_PAIEMENT_CLS[mode]}`}>
      {MODE_PAIEMENT_LABEL[mode]}
    </span>
  );
}

/**
 * Statut DGI de la ligne. Le libellé et le ton viennent désormais d'une source
 * unique (`presenterStatutDgi`), partagée avec le panneau « Facture
 * Électronique » : deux barèmes de couleurs pour le même état finiraient par
 * diverger, et l'utilisateur ne saurait plus lequel croire.
 *
 * `dgi_status` est l'état normalisé ; `statut_dgi` reste lu en repli pour les
 * factures antérieures à la migration, et `statut` en dernier recours pour
 * celles qui n'ont jamais eu de statut fiscal du tout.
 */
function DGIBadge({ statut, statut_dgi, dgi_status }: { statut: string; statut_dgi: string | null; dgi_status?: string | null }) {
  return <BadgeStatutDgi statut={dgi_status ?? statut_dgi ?? statut} />;
}

/**
 * Échéance d'une facture : la date seule ne suffit pas à décider, l'utilisateur
 * doit voir d'un coup d'œil ce qui est en retard. On ne signale le retard que
 * s'il reste effectivement quelque chose à encaisser.
 */
function EcheanceCell({ f }: { f: Facture }) {
  if (!f.date_echeance) return <span className="text-muted-foreground text-sm">—</span>;
  const restant = Number(f.montant_restant ?? f.montant_ttc);
  const enRetard =
    f.statut_paiement !== "payee" && restant > 0 && new Date(f.date_echeance) < new Date();
  return (
    <span className={`text-sm ${enRetard ? "text-red-600 font-semibold" : ""}`}
      title={enRetard ? "Échéance dépassée" : undefined}>
      {new Date(f.date_echeance).toLocaleDateString("fr-MA")}
    </span>
  );
}

/**
 * Panneau « Factures clients » — liste, KPIs, création (OCR ou saisie) et
 * cycle de vie DGI/paiement. Extrait de l'ancienne route /factures pour être
 * monté comme onglet de la section Clients, à l'image des Fournisseurs.
 */
export function FacturesClientsPanel({ dossierId }: { dossierId: string }) {
  const genXml   = useServerFn(generateFactureXml);
  const ocrFn    = useServerFn(ocrFacture);
  const addEmailFn = useServerFn(ajouterEmailClient);
  const matchFn  = useServerFn(matcherDocumentAvecTransactions);
  const annulerPaiementFn = useServerFn(annulerPaiementFacture);
  const memoriserFn = useServerFn(memoriserTiers);
  const pdfA3Fn  = useServerFn(genererPdfA3Facture);

  const [factures, setFactures] = useState<Facture[]>([]);
  const [clients, setClients]   = useState<Client[]>([]);
  // Filtres du tableau (recherche, statut, client, période).
  const [criteres, setCriteres] = useState<CriteresFiltre>({
    texte:"", statut:"toutes", tiersId:"", debut:"", fin:"", champDate:"date_facture",
  });
  const [modes, setModes]       = useState<Map<string, ModePaiement>>(new Map());
  // Date de règlement constatée, déduite des pièces (cf. src/lib/date-reglement.ts).
  const [datesReglement, setDatesReglement] = useState<Map<string, DateReglement>>(new Map());
  const [loading, setLoading]   = useState(true);
  const [openCreate, setOpenCreate] = useState(false);
  // Détail de la facture telle qu'enregistrée (en-tête, montants, lignes) : c'est
  // la lecture métier, là où le XML UBL n'est qu'un livrable technique pour la DGI.
  const [factureDetail, setFactureDetail] = useState<Facture | null>(null);
  const [docView, setDocView]   = useState<DocumentViewerSource | null>(null);
  const [dgiResult, setDgiResult] = useState<any>(null);
  const [processing, setProcessing] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [annulConfirm, setAnnulConfirm] = useState<Facture | null>(null);
  // Facture dont on saisit le règlement au comptant (montant exact + date).
  const [payModal, setPayModal] = useState<Facture | null>(null);

  const [emailModal, setEmailModal] = useState<{clientId:string;factureId:string}|null>(null);
  const [emailInput, setEmailInput] = useState("");

  // Formulaire
  const [clientId, setClientId]   = useState("");
  // Compte de produit PCM suggéré par le moteur de catégorisation (ventes).
  const [secteurActivite, setSecteurActivite] = useState<string | null>(null);
  const [compteProduit, setCompteProduit] = useState("7111");
  const [compteProduitTouche, setCompteProduitTouche] = useState(false);
  const [compteProduitSug, setCompteProduitSug] = useState<SuggestionCompte | null>(null);
  const [savingDefautClient, setSavingDefautClient] = useState(false);
  const [numero, setNumero]       = useState("");
  const [dateF, setDateF]         = useState(new Date().toISOString().slice(0,10));
  const [dateE, setDateE]         = useState("");
  const [modeReglement, setModeReglement] = useState("virement");
  const [typeFacture, setTypeFacture]     = useState("standard");
  const [montantPaye, setMontantPaye]     = useState(0);
  const [montantRestant, setMontantRestant] = useState(0);
  const [lignes, setLignes] = useState<Ligne[]>([{designation:"",quantite:1,prix_unitaire:0,taux_tva:20}]);
  const [echeances, setEcheances] = useState<Echeance[]>([]);
  // Annotations manuscrites lues par l'OCR vision (Payé, visa, n° chèque…).
  const [notesManuscrites, setNotesManuscrites] = useState<string|null>(null);

  // OCR
  const [ocrLoading, setOcrLoading] = useState(false);
  // Compte de produit rappelé par la mémoire tiers (clé ICE client) au dernier scan.
  const [compteMemoireIce, setCompteMemoireIce] = useState<string | null>(null);
  const [ocrData, setOcrData]       = useState<OcrData|null>(null);
  const [originalFile, setOriginalFile] = useState<File|null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    setLoading(true);
    // Les deux dernières requêtes portent les PIÈCES de règlement (ligne de relevé
    // lettrée, encaissement saisi) : c'est d'elles que se déduit le mode de
    // paiement réellement constaté — cf. src/lib/mode-paiement.ts.
    const [{data:f},{data:c},{data:tx},{data:enc},{data:pai},{data:dos}] = await Promise.all([
      supabase.from("factures").select("*").eq("dossier_id",dossierId).order("date_facture",{ascending:false}),
      supabase.from("clients").select("id,nom,ice,email,compte_produit_defaut")
        .eq("dossier_id",dossierId).is("deleted_at",null).order("nom"),
      (supabase.from("transactions_bancaires") as any)
        // date_operation : la banque DATE l'opération, c'est la date de règlement
        // la plus fiable qui existe pour une facture rapprochée d'un relevé.
        .select("facture_id,document_type,libelle,reference,date_operation")
        .eq("dossier_id",dossierId).not("facture_id","is",null),
      (supabase.from("encaissements") as any)
        .select("facture_id,type,date_encaissement").eq("dossier_id",dossierId).not("facture_id","is",null),
      // Règlements datés (source de vérité) — portent la date saisie au modal.
      (supabase.from("paiements") as any)
        .select("facture_id,date_paiement,montant").eq("dossier_id",dossierId).not("facture_id","is",null),
      // Secteur d'activité du dossier — alimente le fallback sectoriel du moteur.
      supabase.from("dossiers").select("secteur_activite").eq("id",dossierId).single(),
    ]);
    setFactures((f??[]) as unknown as Facture[]);
    setClients(c??[]);
    setSecteurActivite(dos?.secteur_activite ?? null);
    setModes(indexerModesPaiement("client",{ transactions: tx ?? [], encaissements: enc ?? [] }));
    // `paiements` peut manquer tant que la migration n'est pas appliquée : le
    // `?? []` suffit, `dateReglementFacture` retombe alors sur factures.date_paiement.
    setDatesReglement(indexerDatesReglement("client",{
      paiements: pai ?? [], transactions: tx ?? [], encaissements: enc ?? [],
    }));
    setLoading(false);
  };
  useEffect(()=>{load();},[dossierId]);

  const ht  = lignes.reduce((s,l)=>s+l.quantite*l.prix_unitaire,0);
  const tva = lignes.reduce((s,l)=>s+l.quantite*l.prix_unitaire*l.taux_tva/100,0);
  const ttc = ht+tva;

  const setLigne=(i:number,f:keyof Ligne,v:any)=>
    setLignes(ls=>ls.map((l,j)=>j===i?{...l,[f]:v}:l));

  // Mise à jour automatique montant_restant quand ttc change
  useEffect(()=>{
    if(typeFacture==="standard") { setMontantPaye(0); setMontantRestant(ttc); }
    else if(typeFacture==="acompte") { setMontantRestant(Math.max(0,ttc-montantPaye)); }
  },[ttc,typeFacture]);

  // Suggestion du compte de produit PCM (moteur centralisé, sens « produit »).
  // Recalcul tant que l'utilisateur ne l'a pas corrigé à la main.
  const clientSelectionne = clients.find(c=>c.id===clientId);
  useEffect(()=>{
    if(compteProduitTouche) return;
    const sug = suggestAccount({
      sens: "produit",
      tiersId: clientId || null,
      compteDefautTiers: clientSelectionne?.compte_produit_defaut ?? null,
      compteMemoireTiers: compteMemoireIce,
      description: lignes[0]?.designation ?? "",
      nomTiers: clientSelectionne?.nom ?? "",
      secteurActivite,
    });
    setCompteProduitSug(sug);
    setCompteProduit(sug.compte);
  },[clientId, lignes, secteurActivite, clientSelectionne?.compte_produit_defaut, compteMemoireIce, compteProduitTouche]);

  // Mémorise le compte comme défaut du client (Règle 1 pour les prochaines ventes).
  const enregistrerCompteDefautClient = async () => {
    if(!clientId) return;
    setSavingDefautClient(true);
    try {
      const { error } = await supabase.from("clients")
        .update({ compte_produit_defaut: compteProduit }).eq("id", clientId);
      if (error) throw error;
      setClients(cs=>cs.map(c=>c.id===clientId?{...c,compte_produit_defaut:compteProduit}:c));
      toast.success(`Compte ${compteProduit} enregistré comme défaut du client`);
    } catch(e:any){
      toast.error("Échec de l'enregistrement : " + (e?.message ?? e));
    } finally { setSavingDefautClient(false); }
  };

  const handleOcr = async (file: File) => {
    setOcrLoading(true);
    setOcrData(null);
    setOriginalFile(file);
    try {
      let extractedText = "";
      let image_base64: string | undefined;
      let mime_type = file.type || "application/octet-stream";
      const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
      const isImage = file.type.startsWith("image/");

      if (isPdf) {
        try {
          const pdfjsLib = await getPdfjsLib();
          const ab = await file.arrayBuffer();
          const pdf = await pdfjsLib.getDocument({ data: ab }).promise;

          let fullText = "";
          for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();
            const items = content.items as any[];
            let lastY = -1, lineText = "";
            for (const item of items) {
              const y = Math.round(item.transform[5]);
              if (lastY !== -1 && Math.abs(y - lastY) > 3) {
                fullText += lineText.trimEnd() + "\n";
                lineText = "";
              }
              lineText += item.str + " ";
              lastY = y;
            }
            if (lineText.trim()) fullText += lineText.trimEnd() + "\n";
          }
          extractedText = fullText.trim();

          // PDF scanné : texte insuffisant OU watermark CamScanner détecté
          const _nonWs = extractedText.replace(/\s/g, "").length;
          if (_nonWs < 300 || /camscanner/i.test(extractedText)) {
            // OCR vision sur image → rendu Canvas page 1 → JPEG 0.8
            const page1 = await pdf.getPage(1);
            const vp = page1.getViewport({ scale: 2.0 });
            const cvs = document.createElement("canvas");
            cvs.width = vp.width;
            cvs.height = vp.height;
            await page1.render({ canvasContext: cvs.getContext("2d")!, viewport: vp }).promise;
            image_base64 = cvs.toDataURL("image/jpeg", 0.85).split(",")[1];
            mime_type = "image/jpeg";
            extractedText = "";
            toast.info("PDF scanné détecté — OCR en cours…");
          }
        } catch (err) {
          console.error("Erreur extraction PDF:", err);
          throw err; // le catch externe affiche le toast unique
        }
      } else if (isImage) {
        // Allègement du payload avant l'envoi (1800 px max, JPEG 85 %) : c'est le
        // transfert de l'image brute qui dominait la latence de scan en prod.
        const payload = await preparerImagePourOcr(file);
        journaliserPayload("facture client", payload);
        image_base64 = payload.base64;
        mime_type = payload.mimeType;
      } else {
        extractedText = await file.text();
      }

      const result = await ocrFn({ data: { extracted_text: extractedText, image_base64, mime_type, dossier_id: dossierId } });
      const r = result.result as OcrData;
      setOcrData(r);
      logAudit({ dossierId, action: "scan_facture", ressourceType: "facture", details: { numero: r.numero_facture ?? null, sens: r.sens_facture } });

      // Compte appris pour cet ICE client lors d'une validation précédente : il
      // passe devant le repli sectoriel/générique (Règle 1b du moteur).
      setCompteMemoireIce((r as any).memoire_client?.compte_pcm ?? null);

      // Pré-remplir formulaire
      if (r.client_id) setClientId(r.client_id);
      if (r.numero_facture) setNumero(r.numero_facture);
      if (r.date_facture) setDateF(r.date_facture);
      if (r.date_echeance) setDateE(r.date_echeance);
      else {
        const d = new Date(r.date_facture || dateF);
        if (!isNaN(d.getTime())) {
          d.setDate(d.getDate() + 30);
          setDateE(d.toISOString().slice(0, 10));
        }
      }
      if (r.mode_reglement) setModeReglement(r.mode_reglement);
      // Validation stricte du type de facture extrait
      if (VALID_FACTURE_TYPES.includes(r.type_facture as any)) {
        setTypeFacture(r.type_facture);
      } else {
        toast.error(`Type de facture inattendu "${r.type_facture}" détecté. Valeur par défaut appliquée.`);
        setTypeFacture("standard");
      }

      // Montants selon type (logique ERP standard)
      // Acompte: montant_paye=0 (rien reçu), montant_restant=montant_ttc (ce que le client doit)
      // montant_commande_total et montant_restant_du sont informatifs uniquement
      if(r.type_facture==="acompte") {
        setMontantPaye(0);
        setMontantRestant(r.montant_ttc??0); // = montant de cet acompte
      } else {
        setMontantPaye(0);
        setMontantRestant(r.montant_ttc??0);
      }

      setNotesManuscrites((r as any).notes_manuscrites ?? null);

      if(r.lignes?.length) {
        if(r.type_facture==="acompte") {
          // Pour acompte: remplacer les lignes par une ligne unique avec le montant de l'acompte
          const acompteHT = r.montant_ht ?? (r.montant_ttc ? r.montant_ttc/1.2 : 0);
          const tauxTva = r.taux_tva ?? 20;
          setLignes([{
            designation: `Acompte sur commande ${r.numero_commande||r.numero_acompte||""}`.trim(),
            quantite: 1,
            prix_unitaire: Math.round(acompteHT*100)/100,
            taux_tva: tauxTva,
          }]);
        } else {
          setLignes(r.lignes);
        }
      }

      if(r.client_action==="created"){await load();toast.success(`Client "${r.client_nom_extrait}" créé`);}
      else if(r.client_action==="found") toast.success(`Client "${r.client_trouve?.nom}" identifié`);
      else toast.warning("Client non identifié — sélectionnez manuellement");

    } catch(e:any){toast.error("Erreur OCR: "+e.message);}
    finally{setOcrLoading(false);}
  };

  const handleCreate = async () => {
    if(!clientId) return toast.error("Sélectionnez un client");
    if(!lignes[0].designation) return toast.error("Ajoutez au moins une ligne");
    const {data:authData}=await supabase.auth.getUser();
    // Pour facture acompte: montant_paye initial = montant de l'acompte (montant_ttc)
    // statut initial = "acompte" (pas encore encaissé)
    // Pour facture standard: montant_paye=0, statut="non_payee"
    // Statut initial: non_payee pour tous (acompte et standard)
    // L'encours est toujours = montant_ttc au départ (montant_restant = montant dû)
    const montantPayeInitial = 0;
    const montantRestantInitial = ttc;
    const statut_paiement = "non_payee";
    // Échéances de paiement partiel (format backend /api/reconciliation/partial-payments).
    // Vide = paiement non fractionné (montant total TTC dû en une fois).
    const echeancesPayload = buildEcheancesPayload(echeances);
    const totalEcheances = echeancesPayload.reduce((s,e)=>s+e.montant_attendu,0);
    if(totalEcheances-ttc>0.01) return toast.error("La somme des tranches dépasse le montant TTC de la facture");
    const {data:newFact,error}=await (supabase.from("factures") as any).insert({
      dossier_id:dossierId,client_id:clientId,numero:numero||null,
      date_facture:dateF,date_echeance:dateE||null,
      lignes:lignes as any,montant_ht:ht,montant_tva:tva,montant_ttc:ttc,
      // Colonne `type` consolidée (enum) : le rôle « standard » du formulaire correspond
      // à la nature « facture » ; acompte/solde/avoir sont repris tels quels.
      type: typeFacture==="standard" ? "facture" : typeFacture,
      montant_paye:montantPayeInitial,
      montant_restant:montantRestantInitial,
      mode_reglement:modeReglement||null,
      echeances:echeancesPayload as any,
      statut:"brouillon",statut_paiement,
      created_by:authData?.user?.id??null,
    }).select().single();
    if(error) return toast.error(error.message);

    if(originalFile&&newFact){
      const ext=originalFile.name.split(".").pop();
      const path=`${dossierId}/${newFact.id}.${ext}`;
      const{data:uploadData}=await supabase.storage.from("factures-originales").upload(path,originalFile,{upsert:true});
      if(uploadData){
        const{data:urlData}=supabase.storage.from("factures-originales").getPublicUrl(path);
        await (supabase.from("factures") as any).update({
          fichier_original_url:urlData?.publicUrl??null,
          fichier_original_nom:originalFile.name,
          fichier_original_type:originalFile.type,
        }).eq("id",newFact.id);
      }
    }

    toast.success("Facture créée");
    if (newFact) logAudit({ dossierId, action: "creation_facture", ressourceType: "facture", ressourceId: newFact.id, details: { numero: numero || null } });

    // ── MÉMOIRE DES COMPTES PAR TIERS (ventes) ────────────────────────────────
    // Symétrique des achats : on apprend {ICE client → compte de produit saisi}.
    // Sans ça, le compte auxiliaire retenu sur une facture client (34210002…)
    // n'était mémorisé NULLE PART — seul le bouton « définir par défaut »
    // (clients.compte_produit_defaut) le conservait, et uniquement sur clic.
    if (clientId && compteProduit) {
      memoriserFn({ data: {
        dossier_id: dossierId, sens: "client",
        ice: clientSelectionne?.ice || null,
        nom: clientSelectionne?.nom ?? "",
        compte_pcm: compteProduit,
        categorie_pcm: null,
        taux_tva: Number(lignes[0]?.taux_tva ?? 20),
        type_tiers: "client",
      }}).catch(() => {});   // best-effort : la facture est déjà enregistrée
    }
    setOpenCreate(false);
    resetForm();
    load();
    // Matcher automatique avec une transaction bancaire ouverte
    if (newFact) {
      const clientNom = clients.find(c => c.id === clientId)?.nom ?? "";
      matchFn({ data: {
        dossier_id: dossierId, document_id: newFact.id, document_type: "facture_client",
        montant_ttc: ttc, nom_tiers: clientNom, date_document: dateF, mode_reglement: modeReglement ?? "",
        numero_piece: numero || "",
      }}).then(res => {
        if (res.match) toast.success(`✅ Lié automatiquement à la transaction du ${res.tx_date} — ${res.tx_montant} MAD`);
      }).catch(() => {});
    }
  };

  const resetForm=()=>{
    setOcrData(null);setOriginalFile(null);setNotesManuscrites(null);
    setLignes([{designation:"",quantite:1,prix_unitaire:0,taux_tva:20}]);
    setClientId("");setNumero("");setDateE("");setTypeFacture("standard");
    setMontantPaye(0);setMontantRestant(0);setModeReglement("virement");
    setEcheances([]);
    setCompteProduit("7111");setCompteProduitTouche(false);setCompteProduitSug(null);setCompteMemoireIce(null);
  };

  // Une facture payée ne se supprime pas : il faut d'abord annuler son paiement,
  // sinon on détruirait les traces comptables (et, avant, la ligne de relevé bancaire).
  const estPayee = (f: Facture) => f.statut_paiement !== "non_payee";

  const handleDelete = async (factureId: string) => {
    const f = factures.find(x => x.id === factureId);
    if (f && estPayee(f)) { toast.error("Annulez d'abord le paiement de cette facture"); return; }
    try {
      // Supprimer dans l'ordre des dépendances (clés étrangères)
      await supabase.from("ged_documents" as any).delete().eq("facture_id", factureId);
      await supabase.from("ecritures_comptables").delete().eq("facture_id", factureId);
      // L'OD de reclassement de TVA ne porte PAS de facture_id : elle n'était
      // donc pas emportée et survivait à la facture. Elle se retrouve par sa
      // référence propre « RECLASS-TVA-<numéro|id> » (cf. src/services/lettrage.ts).
      await supabase.from("ecritures_comptables").delete()
        .eq("dossier_id", dossierId)
        .in("reference_piece", referencesPiece(f?.numero, factureId)
          .filter(r => r.startsWith(PREFIXE_RECLASS_TVA)));
      // Filet de sécurité : une transaction de relevé est un fait bancaire. Si une
      // subsistait liée à cette facture, on la DÉLIE — on ne la supprime jamais.
      await supabase.from("transactions_bancaires" as any)
        .update({ facture_id: null, document_type: null, rapproche: false })
        .eq("facture_id", factureId);
      const { error } = await supabase.from("factures").delete().eq("id", factureId);
      if (error) throw error;
      toast.success("Facture supprimée");
      setDeleteConfirm(null);
      load();
    } catch(e:any) { toast.error(e.message); }
  };

  const handleAnnulerPaiement = async (f: Facture) => {
    setProcessing(f.id);
    try {
      const r = await annulerPaiementFn({ data: { facture_id: f.id, type: "client" } });
      if (r.dejaImpayee) toast.info("Cette facture est déjà impayée");
      else {
        const parts = [
          r.txDeliees && `${r.txDeliees} ligne${r.txDeliees > 1 ? "s" : ""} de relevé remise${r.txDeliees > 1 ? "s" : ""} « à lettrer »`,
          r.encaissementsSupprimes && `${r.encaissementsSupprimes} encaissement${r.encaissementsSupprimes > 1 ? "s" : ""} supprimé${r.encaissementsSupprimes > 1 ? "s" : ""}`,
          r.ecrituresSupprimees && `${r.ecrituresSupprimees} écriture${r.ecrituresSupprimees > 1 ? "s" : ""} de règlement supprimée${r.ecrituresSupprimees > 1 ? "s" : ""}`,
        ].filter(Boolean);
        toast.success(`Paiement annulé — facture impayée${parts.length ? ` (${parts.join(", ")})` : ""}`);
      }
      setAnnulConfirm(null);
      load();
    } catch(e:any) { toast.error(e.message); }
    finally { setProcessing(null); }
  };

  /**
   * Report du statut DGI remonté par le panneau e-facture.
   *
   * Rend `prev` INCHANGÉ quand rien ne diffère : sans cette garde, chaque
   * remontée fabriquait un nouveau tableau et un nouvel objet de détail, donc un
   * rendu, donc une nouvelle lambda passée au panneau — de quoi entretenir une
   * boucle avec un enfant qui se recharge sur l'identité de son rappel.
   */
  const majStatutDgi = useCallback((factureId: string, statut: string) => {
    setFactures((prev) =>
      prev.some((f) => f.id === factureId && f.dgi_status !== statut)
        ? prev.map((f) => (f.id === factureId ? { ...f, dgi_status: statut } : f))
        : prev,
    );
    setFactureDetail((prev) =>
      prev && prev.id === factureId && prev.dgi_status !== statut ? { ...prev, dgi_status: statut } : prev,
    );
  }, []);

  /**
   * Une facture est SCELLÉE dès qu'elle porte son empreinte et son document
   * UBL : c'est à partir de là que le PDF/A-3 officiel existe et fait foi. Le
   * statut DGI ne suffit pas comme critère — une facture scellée mais pas encore
   * transmise a elle aussi son PDF, et c'est bien celui-là qu'il faut montrer.
   */
  const estScellee = (f: Facture) =>
    !!f.hash_sha256 && !!f.xml_ubl;

  /**
   * Ouverture du document de la facture.
   *
   * Priorité au PDF/A-3 scellé : montrer le PNG du scan OCR alors que le
   * document officiel existe reviendrait à présenter le brouillon d'entrée à la
   * place de la pièce qui a valeur probante — celle qui porte le QR de contrôle,
   * l'empreinte, le récépissé, et le XML UBL en pièce jointe.
   * Le scan reste le repli quand rien n'est scellé.
   */
  const handleVoirDocument = async (f: Facture) => {
    if (!estScellee(f)) {
      setDocView({
        title: `Facture ${f.numero ?? ""}`.trim(),
        url: f.fichier_original_url,
        fileName: f.fichier_original_nom,
        mimeType: f.fichier_original_type,
      });
      return;
    }

    setProcessing(f.id);
    try {
      const r = await pdfA3Fn({ data: { facture_id: f.id } });
      setDocView({
        title: `Facture ${f.numero ?? ""} — PDF/A-3`.trim(),
        fileName: r.nom_fichier,
        mimeType: "application/pdf",
        base64: r.pdf_base64,
      });
      (r.avertissements ?? []).forEach((a: string) => toast.warning(a));
    } catch (e: any) {
      // Le PDF officiel n'a pas pu être produit : plutôt que de ne rien montrer,
      // on retombe sur le scan en DISANT que ce n'est pas le document scellé.
      toast.error(`PDF/A-3 indisponible : ${e.message}`);
      if (f.fichier_original_url) {
        toast.info("Affichage du scan d'origine, qui n'a pas valeur de facture scellée.");
        setDocView({
          title: `Facture ${f.numero ?? ""} — scan d'origine`.trim(),
          url: f.fichier_original_url,
          fileName: f.fichier_original_nom,
          mimeType: f.fichier_original_type,
        });
      }
    } finally {
      setProcessing(null);
    }
  };

  const handleGenXml = async (f: Facture) => {
    const client=clients.find(c=>c.id===f.client_id);
    if(!client?.email){setEmailModal({clientId:f.client_id!,factureId:f.id});toast.warning("Email client manquant");return;}
    setProcessing(f.id);
    try{
      const res=await genXml({data:{facture_id:f.id}});
      setDgiResult(res);
      // Le verdict vient désormais de la plateforme DGI (ou du bac à sable) et
      // porte son propre message : « rejetée » en dur mentait sur les cas où
      // l'envoi est simplement REFUSÉ — facture déjà validée, plateforme
      // injoignable —, ce qui n'est pas du tout la même chose qu'un rejet.
      if(res.conforme) toast.success(res.message ?? "✅ Facture conforme DGI");
      else toast.error(res.message ?? "❌ Facture rejetée");
      (res.avertissements ?? []).forEach((a:string)=>toast.warning(a));
      load();
    }catch(e:any){toast.error(e.message);}
    finally{setProcessing(null);}
  };

  const handleGenXmlSansEmail = async (fid: string) => {
    setProcessing(fid);setEmailModal(null);
    try{
      const res=await genXml({data:{facture_id:fid}});
      setDgiResult(res);
      if(res.conforme) toast.success(res.message ?? "✅ Facture conforme DGI (sans email)");
      else toast.error(res.message ?? "❌ Facture rejetée");
      (res.avertissements ?? []).forEach((a:string)=>toast.warning(a));
      load();
    }catch(e:any){toast.error(e.message);}
    finally{setProcessing(null);}
  };

  const handleAddEmail = async () => {
    if(!emailModal||!emailInput) return;
    try{
      await addEmailFn({data:{client_id:emailModal.clientId,email:emailInput}});
      toast.success("Email ajouté");
      await load();
      const f=factures.find(f=>f.id===emailModal.factureId);
      if(f){setEmailModal(null);setEmailInput("");handleGenXmlSansEmail(f.id);}
    }catch(e:any){toast.error(e.message);}
  };


  // Tableau filtré. Les KPIs ci-dessous restent calculés sur TOUTES les factures :
  // ils décrivent le dossier, pas la sélection à l'écran.
  const facturesFiltrees = useMemo(
    () => filtrerFactures(factures, criteres, {
      nomTiers: f => clients.find(c=>c.id===f.client_id)?.nom,
      idTiers:  f => f.client_id,
    }),
    [factures, criteres, clients],
  );

  // KPIs
  const conformes  = factures.filter(f=>f.statut==="conforme");
  // CA HT = factures standard conformes (les acomptes vont en 4191, pas en CA)
  const caHT       = conformes.filter(f=>f.type!=="acompte").reduce((s,f)=>s+Number(f.montant_ht),0);
  // CA encaissé = factures standard partielles ou payées
  const caEncaisse = conformes.filter(f=>f.type!=="acompte"&&f.statut_paiement!=="non_payee").reduce((s,f)=>s+Number(f.montant_paye??0),0);
  // Encours = montant_restant de toutes les factures non soldées (acomptes + standard)
  const encours    = conformes.filter(f=>f.statut_paiement!=="payee").reduce((s,f)=>s+Number(f.montant_restant??f.montant_ttc),0);
  const enAnalyse  = factures.filter(f=>f.statut==="envoyee"||f.statut_dgi==="en_analyse").length;
  // Échéances dépassées avec un reste à encaisser — le chiffre qui déclenche la relance.
  const enRetard   = factures.filter(f =>
    f.statut_paiement!=="payee" && f.date_echeance &&
    new Date(f.date_echeance) < new Date() &&
    Number(f.montant_restant??f.montant_ttc) > 0
  ).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">E-facture DGI · XML UBL 2.1 · SHA-256</p>
        <Dialog open={openCreate} onOpenChange={v=>{setOpenCreate(v);if(!v) resetForm();}}>
          <DialogTrigger asChild><Button><Plus className="h-4 w-4 mr-2"/>Nouvelle facture</Button></DialogTrigger>
          <DialogContent className="max-w-5xl max-h-[92vh] overflow-y-auto">
            <DialogHeader><DialogTitle>Créer une facture</DialogTitle></DialogHeader>

            <div className="grid grid-cols-2 gap-6">
              {/* Gauche: Upload OCR */}
              <div className="space-y-4">
                <h3 className="font-semibold text-sm">📄 Scan OCR (optionnel)</h3>
                <div className="border-2 border-dashed rounded-xl p-6 text-center cursor-pointer hover:border-primary transition-colors"
                  onClick={()=>fileRef.current?.click()}
                  onDragOver={e=>e.preventDefault()}
                  onDrop={e=>{e.preventDefault();const f=e.dataTransfer.files[0];if(f)handleOcr(f);}}>
                  <input ref={fileRef} type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg"
                    onChange={e=>{const f=e.target.files?.[0];if(f)handleOcr(f);}}/>
                  {ocrLoading
                    ?<><Loader2 className="h-8 w-8 animate-spin mx-auto text-primary mb-2"/><p className="text-sm">Extraction IA en cours…</p></>
                    :<><Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground opacity-50"/><p className="text-sm font-medium">Glissez une facture PDF / image</p><p className="text-xs text-muted-foreground mt-1">Extraction automatique des données</p></>
                  }
                </div>

                {ocrData && (
                  <div className="space-y-2 text-sm">
                    <div className="flex items-center gap-2">
                      <Badge variant={ocrData.confidence==="high"?"default":"secondary"}>Confiance: {ocrData.confidence}</Badge>
                      {ocrData.client_action==="created"&&<Badge className="bg-blue-100 text-blue-700"><UserPlus className="h-3 w-3 mr-1"/>Client créé</Badge>}
                      {ocrData.client_action==="found"&&<Badge className="bg-green-100 text-green-700"><CheckCircle2 className="h-3 w-3 mr-1"/>Client identifié</Badge>}
                      {ocrData.client_action==="not_found"&&<Badge className="bg-yellow-100 text-yellow-700"><AlertCircle className="h-3 w-3 mr-1"/>Client non trouvé</Badge>}
                    </div>
                    <div className="p-3 bg-muted/50 rounded-lg space-y-1 text-xs">
                      <p><span className="text-muted-foreground">Émetteur:</span> {ocrData.emetteur_nom||"—"}</p>
                      <p><span className="text-muted-foreground">Client détecté:</span> <strong>{ocrData.client_nom_extrait||"Non détecté"}</strong></p>
                      <p><span className="text-muted-foreground">ICE client:</span> {ocrData.ice_client||"—"}</p>
                      <p><span className="text-muted-foreground">Sens:</span> {ocrData.sens_facture}</p>
                      {ocrData.type_facture!=="standard"&&(
                        <p><span className="text-muted-foreground">Type:</span> <Badge className="text-xs bg-blue-100 text-blue-700">{ocrData.type_facture}</Badge></p>
                      )}
                    </div>

                    {/* Lignes détectées */}
                    {ocrData.lignes?.length>0&&(
                      <div className="rounded border overflow-hidden">
                        <Table>
                          <TableHeader><TableRow><TableHead className="text-xs">Désignation</TableHead><TableHead className="text-xs">Qté</TableHead><TableHead className="text-xs">PU HT</TableHead><TableHead className="text-xs">PU TTC</TableHead><TableHead className="text-xs">TVA</TableHead></TableRow></TableHeader>
                          <TableBody>
                            {ocrData.lignes.map((l,i)=>(
                              <TableRow key={i}><TableCell className="text-xs">{l.designation}</TableCell><TableCell className="text-xs">{l.quantite}</TableCell><TableCell className="text-xs">{fmt(l.prix_unitaire)}</TableCell><TableCell className="text-xs text-muted-foreground">{fmt(puHtToTtc(l.prix_unitaire, l.taux_tva))}</TableCell><TableCell className="text-xs">{l.taux_tva}%</TableCell></TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Droite: Formulaire éditable */}
              <div className="space-y-4">
                <h3 className="font-semibold text-sm">✏️ Données de la facture</h3>

                <div className="space-y-2">
                  <Label>Client *</Label>
                  <Select value={clientId} onValueChange={setClientId}>
                    <SelectTrigger><SelectValue placeholder="Sélectionner…"/></SelectTrigger>
                    <SelectContent>{clients.map(c=><SelectItem key={c.id} value={c.id}>{c.nom}</SelectItem>)}</SelectContent>
                  </Select>
                </div>

                {/* Compte comptable (produit) — proposé par le moteur de catégorisation PCM. */}
                <div className="space-y-1.5">
                  <Label className="flex items-center gap-2">
                    Compte comptable (produit)
                    {compteProduitSug && !compteProduitTouche && (
                      <Badge variant="secondary" className="text-[10px] font-normal">
                        {compteProduitSug.source === "tiers" ? "défaut client"
                          : compteProduitSug.source === "mots_cles" ? `mot-clé « ${compteProduitSug.motCle} »`
                          : compteProduitSug.source === "secteur" ? "secteur"
                          : "défaut"}
                      </Badge>
                    )}
                  </Label>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input className="font-mono w-32" value={compteProduit} placeholder="7111"
                      onChange={e=>{setCompteProduit(e.target.value);setCompteProduitTouche(true);}}/>
                    {compteProduitTouche && (
                      <Button type="button" size="sm" variant="ghost" className="h-8 text-xs"
                        onClick={()=>setCompteProduitTouche(false)} title="Reprendre la suggestion automatique">
                        Suggérer
                      </Button>
                    )}
                    {clientId && compteProduit && compteProduit !== (clientSelectionne?.compte_produit_defaut ?? "") && (
                      <Button type="button" size="sm" variant="outline" className="h-8 text-xs"
                        onClick={enregistrerCompteDefautClient} disabled={savingDefautClient}
                        title="Mémoriser ce compte pour les prochaines factures de ce client">
                        {savingDefautClient ? <Loader2 className="h-3 w-3 mr-1 animate-spin"/> : null}
                        Définir par défaut pour ce client
                      </Button>
                    )}
                  </div>
                  {compteProduitSug && (
                    <p className="text-[10px] text-muted-foreground">
                      {compteProduitSug.motif}{compteProduitSug.label ? ` — ${compteProduitSug.label}` : ""}
                    </p>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2"><Label>N° Facture</Label><Input value={numero} onChange={e=>setNumero(e.target.value)} placeholder="FA-001"/></div>
                  <div className="space-y-2">
                    <Label>Type</Label>
                    <Select value={typeFacture} onValueChange={v=>{setTypeFacture(v);if(v==="standard"){setMontantPaye(0);setMontantRestant(ttc);}}}>
                      <SelectTrigger><SelectValue/></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="standard">Standard</SelectItem>
                        <SelectItem value="acompte">Acompte</SelectItem>
                        <SelectItem value="solde">Solde</SelectItem>
                        <SelectItem value="avoir">Avoir</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2"><Label>Date facture</Label><Input type="date" value={dateF} onChange={e=>setDateF(e.target.value)}/></div>
                  <div className="space-y-2"><Label>Date échéance (défaut +30j)</Label><Input type="date" value={dateE} onChange={e=>setDateE(e.target.value)}/></div>
                </div>

                <div className="space-y-2">
                  <Label>Mode de règlement</Label>
                  <Select value={modeReglement} onValueChange={setModeReglement}>
                    <SelectTrigger><SelectValue/></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="virement">Virement bancaire</SelectItem>
                      <SelectItem value="cheque">Chèque</SelectItem>
                      <SelectItem value="especes">Espèces</SelectItem>
                      <SelectItem value="traite">Traite</SelectItem>
                      <SelectItem value="autre">Autre</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Annotations manuscrites relevées par l'OCR vision — affichées au
                    moment de la saisie pour aider à corriger les champs ci-dessous. */}
                {notesManuscrites && (
                  <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/20 p-2.5">
                    <p className="text-xs font-semibold text-amber-800 dark:text-amber-400">
                      Notes manuscrites détectées sur le document
                    </p>
                    <p className="text-sm mt-0.5 whitespace-pre-line">{notesManuscrites}</p>
                    <p className="text-[10px] text-muted-foreground mt-1">
                      À titre indicatif — elles ne modifient aucun montant automatiquement.
                    </p>
                  </div>
                )}

                {/* Lignes */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <Label>Lignes</Label>
                    <Button type="button" variant="outline" size="sm" onClick={()=>setLignes(ls=>[...ls,{designation:"",quantite:1,prix_unitaire:0,taux_tva:20}])}>
                      <Plus className="h-3 w-3 mr-1"/>Ligne
                    </Button>
                  </div>
                  <div className="grid grid-cols-12 gap-1 px-1 pb-1 text-[10px] font-medium text-muted-foreground">
                    <span className="col-span-4">Désignation</span>
                    <span className="col-span-1">Qté</span>
                    <span className="col-span-2">P.U. HT</span>
                    <span className="col-span-2">P.U. TTC</span>
                    <span className="col-span-2">TVA</span>
                  </div>
                  {lignes.map((l,i)=>(
                    <div key={i} className="grid grid-cols-12 gap-1 items-center mb-1">
                      <Input className="col-span-4 text-xs" placeholder="Désignation" value={l.designation} onChange={e=>setLigne(i,"designation",e.target.value)}/>
                      <Input className="col-span-1 text-xs" type="number" placeholder="Qté" value={l.quantite} onChange={e=>setLigne(i,"quantite",+e.target.value)}/>
                      <Input className="col-span-2 text-xs" type="number" placeholder="PU HT" value={l.prix_unitaire} onChange={e=>setLigne(i,"prix_unitaire",+e.target.value)}/>
                      {/* PU TTC éditable : saisir l'un recalcule l'autre (le HT reste stocké). */}
                      <PuTtcInput className="col-span-2 text-xs" prixHt={l.prix_unitaire} tauxTva={l.taux_tva}
                        onChangeHt={ht=>setLigne(i,"prix_unitaire",ht)}/>
                      <Select value={String(l.taux_tva)} onValueChange={v=>setLigne(i,"taux_tva",+v)}>
                        <SelectTrigger className="col-span-2 text-xs"><SelectValue/></SelectTrigger>
                        <SelectContent>{[0,7,10,14,20].map(r=><SelectItem key={r} value={String(r)}>{r}%</SelectItem>)}</SelectContent>
                      </Select>
                      <Button type="button" variant="ghost" size="icon" className="col-span-1" onClick={()=>setLignes(ls=>ls.filter((_,j)=>j!==i))} disabled={lignes.length===1}><X className="h-3 w-3"/></Button>
                      {/* Les deux PU sont saisissables ci-dessus ; rappel des totaux ligne. */}
                      <div className="col-span-12 text-[10px] text-muted-foreground pl-1">
                        Total HT {fmt((l.quantite||0)*(l.prix_unitaire||0))} · Total TTC {fmt((l.quantite||0)*puHtToTtc(l.prix_unitaire||0, l.taux_tva))}
                      </div>
                    </div>
                  ))}
                  <div className="p-2 bg-muted rounded text-xs text-right mt-1">
                    HT: {fmt(ht)} · TVA: {fmt(tva)} · <strong>TTC: {fmt(ttc)}</strong>
                  </div>
                </div>

                {/* Montants payé / restant */}
                <div className="p-3 bg-blue-50 dark:bg-blue-950/20 rounded-lg border border-blue-200 space-y-3">
                  <p className="text-xs font-semibold text-blue-700">Suivi du paiement</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label className="text-xs">Montant payé (MAD)</Label>
                      <Input type="number" step="0.01" value={montantPaye}
                        onChange={e=>{const p=parseFloat(e.target.value)||0;setMontantPaye(p);setMontantRestant(Math.max(0,ttc-p));}}
                        className="text-sm font-mono"/>
                      <p className="text-[10px] text-muted-foreground">0 si non encore payée</p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Montant restant dû (MAD)</Label>
                      <Input type="number" step="0.01" value={montantRestant}
                        onChange={e=>setMontantRestant(parseFloat(e.target.value)||0)}
                        className="text-sm font-mono"/>
                      <p className="text-[10px] text-muted-foreground">Calculé automatiquement</p>
                    </div>
                  </div>
                  <div className="text-xs text-blue-700">
                    Statut: <strong>{montantPaye>=ttc?"✅ Payée":montantPaye>0?"🔵 Paiement partiel":"⏳ En attente"}</strong>
                  </div>
                </div>

                {/* Échéances de paiement partiel */}
                <EcheancesInput echeances={echeances} onChange={setEcheances} montantTtc={ttc} />
              </div>
            </div>

            <DialogFooter className="mt-4">
              <Button variant="outline" onClick={()=>{setOpenCreate(false);resetForm();}}>Annuler</Button>
              <Button onClick={handleCreate}>Créer la facture</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-3 xl:grid-cols-6 gap-3">
        {[
          {label:"CA HT facturé",value:fmt(caHT),color:"text-green-600"},
          {label:"CA HT encaissé",value:fmt(caEncaisse),color:"text-emerald-600"},
          {label:"Encours clients",value:fmt(encours),color:"text-blue-600"},
          {label:"Échéances dépassées",value:String(enRetard),color:enRetard>0?"text-red-600":"text-muted-foreground"},
          {label:"En analyse DGI",value:String(enAnalyse),color:"text-yellow-600"},
          {label:"Conformes",value:String(conformes.length),color:"text-green-600"},
        ].map(k=>(
          <Card key={k.label}><CardContent className="pt-4 pb-4">
            <p className="text-xs text-muted-foreground">{k.label}</p>
            <p className={`text-lg font-bold mt-1 ${k.color}`}>{k.value}</p>
          </CardContent></Card>
        ))}
      </div>

      {/* Filtres du tableau */}
      <FacturesFiltres
        criteres={criteres}
        onChange={setCriteres}
        tiers={clients.map(c=>({id:c.id,nom:c.nom}))}
        labelTiers="Client"
        nbFiltrees={facturesFiltrees.length}
        nbTotal={factures.length}
      />

      {/* Table */}
      <Card><CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>N°</TableHead><TableHead>Client</TableHead><TableHead>Date</TableHead>
              <TableHead>Échéance</TableHead>
              <TableHead>HT</TableHead><TableHead>TTC</TableHead><TableHead>Payé</TableHead><TableHead>Restant</TableHead>
              <TableHead>DGI</TableHead><TableHead>Statut</TableHead>
              <TableHead>Date de règlement</TableHead>
              <TableHead>Mode de paiement</TableHead><TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading
              ?<TableRow><TableCell colSpan={13} className="text-center py-8"><Loader2 className="h-5 w-5 animate-spin mx-auto"/></TableCell></TableRow>
              :facturesFiltrees.length===0
              ?<TableRow><TableCell colSpan={13} className="text-center py-10 text-muted-foreground">
                {factures.length===0?"Aucune facture":"Aucune facture ne correspond aux filtres"}
              </TableCell></TableRow>
              :facturesFiltrees.map(f=>(
                <TableRow key={f.id}>
                  <TableCell className="font-mono text-xs">{f.numero??f.id.slice(0,8)}</TableCell>
                  <TableCell className="text-sm">
                    <div>
                      {clients.find(c=>c.id===f.client_id)?.nom??"—"}
                      {!clients.find(c=>c.id===f.client_id)?.email&&f.client_id&&(
                        <span className="ml-2 text-xs text-orange-500 flex items-center gap-1"><Mail className="h-3 w-3"/>Email manquant</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">{new Date(f.date_facture).toLocaleDateString("fr-MA")}</TableCell>
                  <TableCell><EcheanceCell f={f}/></TableCell>
                  <TableCell className="font-mono text-sm">{fmt(Number(f.montant_ht))}</TableCell>
                  <TableCell className="font-medium text-sm">{fmt(Number(f.montant_ttc))}</TableCell>
                  <TableCell className="font-mono text-sm text-green-600">{fmt(Number(f.montant_paye??0))}</TableCell>
                  <TableCell className="font-mono text-sm text-orange-600">{fmt(Number(f.montant_restant??f.montant_ttc))}</TableCell>
                  <TableCell><DGIBadge statut={f.statut} statut_dgi={f.statut_dgi} dgi_status={f.dgi_status}/></TableCell>
                  <TableCell><StatutPaiementBadge f={f}/></TableCell>
                  <TableCell><DateReglementCell facture={f} index={datesReglement}/></TableCell>
                  <TableCell><ModePaiementCell mode={modePaiementFacture(f, modes)}/></TableCell>
                  <TableCell>
                    <div className="flex gap-1 flex-wrap">
                      {f.statut==="brouillon"&&(
                        <Button size="sm" variant="outline" disabled={processing===f.id} onClick={()=>handleGenXml(f)}>
                          {processing===f.id?<Loader2 className="h-3 w-3 animate-spin mr-1"/>:<FileCode className="h-3 w-3 mr-1"/>}e-Facture
                        </Button>
                      )}
                      {/* Le bouton porte l'état du règlement. Tant que la facture est due
                          il propose l'encaissement au comptant ; une fois réglée — au
                          comptant OU par lettrage d'une ligne de relevé — il devient un
                          témoin vert « Payée ». L'instrument exact ne s'écrit pas ici mais
                          dans la colonne « Mode de paiement » : le bouton dirait sinon
                          « espèces » sur une facture soldée par virement. */}
                      {f.statut_paiement==="payee"
                        ?(
                          <Button size="sm" variant="outline" disabled title="Facture réglée"
                            className="border-green-200 bg-green-50 text-green-700 disabled:opacity-100">
                            <CheckCircle className="h-3 w-3 mr-1"/>Payée
                          </Button>
                        )
                        :f.statut==="conforme"&&(
                          <Button size="sm" variant="outline" disabled={processing===f.id} onClick={()=>setPayModal(f)}
                            title="Saisir un encaissement au comptant (montant et date)">
                            <Banknote className="h-3 w-3 mr-1"/>Payer en espèces
                          </Button>
                        )}
                      {/* Détail de la facture — TOUJOURS proposé, y compris sur un
                          brouillon sans XML ni scan. Le XML UBL reste téléchargeable
                          depuis ce détail : c'est un livrable pour la DGI, pas une
                          lecture. */}
                      <Button size="sm" variant="ghost" title="Voir le détail de la facture"
                        onClick={()=>setFactureDetail(f)}>
                        <Eye className="h-3 w-3"/>
                      </Button>
                      {/* TOUJOURS rendu, désactivé quand il n'y a NI facture scellée
                          NI scan : un bouton conditionnel se contente de disparaître,
                          et l'utilisateur ne peut pas distinguer « rien à voir » de
                          « pas implémenté ». Dès que la facture est scellée, c'est le
                          PDF/A-3 officiel qui s'ouvre, pas le scan d'entrée. */}
                      <Button size="sm" variant="ghost"
                        disabled={(!estScellee(f)&&!f.fichier_original_url)||processing===f.id}
                        title={estScellee(f)
                          ? "Voir la facture officielle PDF/A-3 (QR DGI, empreinte, XML UBL embarqué)"
                          : f.fichier_original_url
                            ? "Voir / télécharger le document original — cette facture n'est pas encore scellée"
                            : "Aucun document à afficher : facture ni scellée ni scannée"}
                        onClick={()=>handleVoirDocument(f)}>
                        {processing===f.id
                          ?<Loader2 className="h-3 w-3 animate-spin"/>
                          :estScellee(f)
                            ?<FileCheck2 className="h-3 w-3 text-emerald-600"/>
                            :<FileText className="h-3 w-3"/>}
                      </Button>
                      {/* Annuler le paiement : actif seulement si la facture est payée
                          (ou partiellement). Débloque ensuite la suppression. */}
                      <Button size="sm" variant="ghost" disabled={!estPayee(f)||processing===f.id}
                        className="text-amber-600 hover:text-amber-700"
                        title={estPayee(f)?"Annuler le paiement":"Déjà impayée"}
                        onClick={()=>setAnnulConfirm(f)}>
                        {processing===f.id?<Loader2 className="h-3 w-3 animate-spin"/>:<Undo2 className="h-3 w-3"/>}
                      </Button>
                      {/* Supprimer : bloqué tant que la facture est payée. */}
                      <Button size="sm" variant="ghost" disabled={estPayee(f)}
                        className="text-red-500 hover:text-red-700"
                        title={estPayee(f)?"Annulez d'abord le paiement":"Supprimer la facture"}
                        onClick={()=>setDeleteConfirm(f.id)}>
                        <Trash2 className="h-3 w-3"/>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </CardContent></Card>

      {/* Règlement au comptant : montant exact + date, puis rechargement du
          tableau — « Payé » et « Restant » sont recalculés côté serveur. */}
      <PaiementEspecesDialog facture={payModal} type="client"
        onClose={()=>setPayModal(null)} onDone={load}/>

      {/* Modal email manquant */}
      <Dialog open={!!emailModal} onOpenChange={()=>{setEmailModal(null);setEmailInput("");}}>
        <DialogContent>
          <DialogHeader><DialogTitle>Email client manquant</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">Ajoutez l'email ou continuez sans envoi.</p>
            <div className="space-y-2"><Label>Email du client</Label>
              <Input type="email" placeholder="client@exemple.ma" value={emailInput} onChange={e=>setEmailInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")handleAddEmail();}}/>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={()=>emailModal&&handleGenXmlSansEmail(emailModal.factureId)}>Continuer sans email</Button>
            <Button onClick={handleAddEmail} disabled={!emailInput}><Mail className="h-4 w-4 mr-2"/>Ajouter et envoyer</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Modal confirmation annulation de paiement */}
      <Dialog open={!!annulConfirm} onOpenChange={()=>setAnnulConfirm(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Annuler le paiement ?</DialogTitle></DialogHeader>
          <div className="text-sm text-muted-foreground space-y-2">
            <p>
              La facture <span className="font-mono">{annulConfirm?.numero ?? annulConfirm?.id.slice(0,8)}</span> repassera en
              « impayée », ce qui débloquera sa suppression.
            </p>
            <ul className="list-disc pl-5 space-y-1">
              <li>Un encaissement <b>espèces ou chèque</b> est supprimé, avec ses écritures.</li>
              <li>Une ligne de <b>relevé bancaire</b> n'est <b>jamais supprimée</b> : elle est simplement délettrée et redevient « à lettrer ».</li>
              <li>L'écriture de <b>vente</b> (journal VTE) est conservée.</li>
            </ul>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={()=>setAnnulConfirm(null)}>Retour</Button>
            <Button onClick={()=>annulConfirm&&handleAnnulerPaiement(annulConfirm)} disabled={!!processing}>
              {processing?<Loader2 className="h-4 w-4 mr-2 animate-spin"/>:<Undo2 className="h-4 w-4 mr-2"/>}Annuler le paiement
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Modal confirmation suppression */}
      <Dialog open={!!deleteConfirm} onOpenChange={()=>setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Supprimer la facture ?</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">Cette action supprimera la facture et ses écritures comptables associées. Cette action est irréversible.</p>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={()=>setDeleteConfirm(null)}>Annuler</Button>
            <Button variant="destructive" onClick={()=>deleteConfirm&&handleDelete(deleteConfirm)}>
              <Trash2 className="h-4 w-4 mr-2"/>Supprimer définitivement
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* DGI Result */}
      <Dialog open={!!dgiResult} onOpenChange={()=>setDgiResult(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{dgiResult?.conforme?"✅ Facture conforme DGI":"❌ Facture rejetée"}</DialogTitle></DialogHeader>
          {dgiResult&&(
            <div className={`p-4 rounded-lg text-sm space-y-2 ${dgiResult.conforme?"bg-green-50":"bg-red-50"}`}>
              <p>{dgiResult.dgi_response?.message}</p>
              {dgiResult.dgi_uuid&&<p className="font-mono text-xs break-all">UUID DGI: {dgiResult.dgi_uuid}</p>}
              {dgiResult.hash&&<p className="font-mono text-xs break-all">SHA-256: {dgiResult.hash.slice(0,32)}…</p>}
              {dgiResult.email_sent&&<p className="text-xs text-green-600">📧 Email envoyé au client</p>}
              {dgiResult.dgi_response?.erreurs?.length>0&&(
                <ul>{dgiResult.dgi_response.erreurs.map((e:string,i:number)=><li key={i} className="text-red-600 text-xs">• {e}</li>)}</ul>
              )}
              {dgiResult.conforme&&<p className="text-xs text-muted-foreground border-t pt-2">✅ Écritures comptables créées · Document archivé en GED</p>}
            </div>
          )}
          <DialogFooter><Button onClick={()=>setDgiResult(null)}>Fermer</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Détail d'une facture client ────────────────────────────────────────
          Restitue la facture telle qu'enregistrée (en-tête, montants, lignes),
          au lieu du dump XML UBL qui n'était lisible que par la DGI. Le XML
          reste téléchargeable ici quand l'e-Facture a été générée. */}
      <Dialog open={!!factureDetail} onOpenChange={(o)=>{ if(!o) setFactureDetail(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              Facture {factureDetail?.numero ?? "—"} · {clients.find(c=>c.id===factureDetail?.client_id)?.nom ?? "—"}
            </DialogTitle>
          </DialogHeader>
          {factureDetail && (
            <div className="space-y-4">
              {/* Ne se déclenche que si la facture n'a NI document officiel NI
                  scan : dès qu'elle est scellée, le PDF/A-3 existe et le bouton
                  de la ligne l'ouvre — dire « aucun document » serait faux. */}
              {!estScellee(factureDetail) && !factureDetail.fichier_original_url && (
                <div className="flex items-start gap-2 rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">
                  <AlertCircle className="h-4 w-4 shrink-0 mt-px"/>
                  <span>
                    Aucun document original n'est archivé pour cette facture — voici son
                    contenu enregistré. Une fois la facture scellée, sa version officielle
                    PDF/A-3 (QR de contrôle, empreinte, XML UBL embarqué) devient
                    consultable depuis le bouton de la ligne.
                  </span>
                </div>
              )}

              <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                {[
                  ["Date facture", new Date(factureDetail.date_facture).toLocaleDateString("fr-MA")],
                  ["Échéance", factureDetail.date_echeance ? new Date(factureDetail.date_echeance).toLocaleDateString("fr-MA") : "—"],
                  ["Mode de paiement", (()=>{ const m=modePaiementFacture(factureDetail, modes); return m ? MODE_PAIEMENT_LABEL[m] : "—"; })()],
                  ["Montant HT", fmt(Number(factureDetail.montant_ht))],
                  ["TVA", fmt(Number(factureDetail.montant_tva))],
                  ["Montant TTC", fmt(Number(factureDetail.montant_ttc))],
                  ["Payé", fmt(Number(factureDetail.montant_paye ?? 0))],
                  ["Restant dû", fmt(Number(factureDetail.montant_restant ?? factureDetail.montant_ttc))],
                ].map(([label, value]) => (
                  <div key={label as string}>
                    <p className="text-xs text-muted-foreground">{label}</p>
                    <p className="font-medium">{value}</p>
                  </div>
                ))}
                {/* Le statut DGI porte une couleur et une infobulle explicative :
                    le rendre en texte brut comme les montants gommait justement
                    ce qui le distingue — un état à surveiller, pas une donnée. */}
                <div>
                  <p className="text-xs text-muted-foreground">Statut DGI</p>
                  <div className="mt-0.5">
                    <BadgeStatutDgi statut={factureDetail.dgi_status ?? factureDetail.statut_dgi ?? factureDetail.statut} />
                  </div>
                </div>
              </div>

              {Array.isArray(factureDetail.lignes) && factureDetail.lignes.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Désignation</TableHead>
                      <TableHead className="text-right">Qté</TableHead>
                      <TableHead className="text-right">P.U. HT</TableHead>
                      <TableHead className="text-right">P.U. TTC</TableHead>
                      <TableHead className="text-right">TVA</TableHead>
                      <TableHead className="text-right">Total HT</TableHead>
                      <TableHead className="text-right">Total TTC</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {factureDetail.lignes.map((l, i) => (
                      <TableRow key={i}>
                        <TableCell className="text-sm">{l.designation || "—"}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{l.quantite ?? "—"}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{fmt(Number(l.prix_unitaire ?? 0))}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{fmt(puHtToTtc(Number(l.prix_unitaire ?? 0), l.taux_tva))}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{l.taux_tva ?? 0} %</TableCell>
                        <TableCell className="text-right font-mono text-xs font-medium">
                          {fmt(Number(l.quantite ?? 0) * Number(l.prix_unitaire ?? 0))}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs font-medium">
                          {fmt(Number(l.quantite ?? 0) * puHtToTtc(Number(l.prix_unitaire ?? 0), l.taux_tva))}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}

              {/* Tout le cycle fiscal (UBL, transmission, récépissé, PDF/A-3,
                  journal) vit dans ce panneau. Il remplace l'ancien bouton isolé
                  de téléchargement du XML, qui n'exposait qu'une des étapes et
                  laissait croire que le reste n'existait pas. */}
              <FactureElectroniquePanel
                factureId={factureDetail.id}
                numero={factureDetail.numero}
                onStatutChange={(statut) => majStatutDgi(factureDetail.id, statut)}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Aperçu du document original (panneau latéral droit) */}
      <DocumentViewer open={!!docView} onOpenChange={(o)=>{ if(!o) setDocView(null); }} source={docView} />
    </div>
  );
}
