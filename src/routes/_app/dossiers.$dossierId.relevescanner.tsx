import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Loader2, CheckCircle, X, RefreshCw, Download, AlertCircle, FileText, Sparkles, Image } from "lucide-react";
import { toast } from "sonner";
import { ocrReleve } from "@/server/factures.functions";
import { memoriserTiers } from "@/server/tiers-memoire.functions";
import { runDocumentJob } from "@/hooks/useDocumentJob";
import { parseAttijariReleve, extractRibMarocain } from "@/lib/releve-attijari";
import { enregistrerPaiement } from "@/lib/paiements";

export const Route = createFileRoute("/_app/dossiers/$dossierId/relevescanner")({
  component: RelEveScanner,
});

interface Transaction {
  id: string; ligne: number;
  date_operation: string; date_valeur: string;
  reference: string; nature_operation: string;
  montant_debit: number | null; montant_credit: number | null;
  nature_confirmee: string; document_reference: string;
  debiteur_crediteur: string; code_comptable: string;
  montant_ht: number | null; montant_tva: number | null;
  taux_tva: number; confiance: number; valide: boolean;
  remarque: string; alerte: string | null;
  necessite_remarque: boolean; message_pour_comptable: string | null;
  etape_rapprochement: string; facture_id: string | null;
  justificatif_id: string | null;
  source: "memoire" | "ia";   // 'memoire' = classé sans appel IA (skipLLM)
  suggestions: Array<{ nature: string; code_pcm: string; tiers: string | null; facture: string | null; confiance: number }>;
}

interface InfoReleve {
  banque: string; rib: string;
  solde_initial: number; solde_final: number;
}

const NATURES_OPERATION = [
  { value: "encaissement_client",  label: "Encaissement client",    code: "3421", tva: false },
  { value: "paiement_fournisseur", label: "Paiement fournisseur",   code: "4411", tva: true  },
  { value: "salaires",             label: "Paiement salaires",      code: "6171", tva: false },
  { value: "cnss_amo",             label: "CNSS / AMO",             code: "6174", tva: false },
  { value: "tva_dgi",              label: "TVA / Impôts DGI",       code: "4456", tva: false },
  { value: "loyers",               label: "Loyer / Location",       code: "6131", tva: true  },
  { value: "eau_electricite",      label: "Eau / Électricité ONEE", code: "6125", tva: true  },
  { value: "telecom",              label: "Téléphone / Internet",   code: "6132", tva: true  },
  { value: "gasoil",               label: "Gasoil / Carburant",     code: "6122", tva: true  },
  { value: "assurance",            label: "Assurance",              code: "6161", tva: false },
  { value: "entretien",            label: "Entretien / Réparation", code: "6141", tva: true  },
  { value: "frais_bancaires",      label: "Frais bancaires",        code: "6347", tva: false },
  { value: "taxe_professionnelle", label: "Taxe Professionnelle",   code: "6313", tva: false },
  { value: "retrait_especes",      label: "Retrait espèces / GAB",  code: "5161", tva: false },
  { value: "interets_crediteurs",  label: "Intérêts créditeurs",    code: "7611", tva: false },
  { value: "frais_representation", label: "Frais de représentation",code: "6147", tva: false },
  { value: "frais_douane",         label: "Frais douane / import",  code: "6146", tva: false },
  { value: "autre",                label: "Autre opération",        code: "6141", tva: false },
];


function RelEveScanner() {
  const { dossierId } = Route.useParams();

  const [step, setStep] = useState<"upload" | "scan" | "review" | "done">("upload");
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [infoReleve, setInfoReleve] = useState<InfoReleve | null>(null);
  const [saving, setSaving] = useState(false);
  const [remarques, setRemarques] = useState("");
  const [showRemarques, setShowRemarques] = useState(false);
  const [selectedTx, setSelectedTx] = useState<number | null>(null);
  const [factures, setFactures] = useState<any[]>([]);
  const [facturesFourn, setFacturesFourn] = useState<any[]>([]);
  const [fournisseurs, setFournisseurs] = useState<any[]>([]);
  const [clients, setClients] = useState<any[]>([]);
  const [justificatifs, setJustificatifs] = useState<any[]>([]);
  const [dossier, setDossier] = useState<{ nom_societe: string; ice: string | null } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    Promise.all([
      supabase.from("factures").select("id,numero,montant_ht,montant_ttc,montant_tva,date_facture,date_echeance,clients(id,nom,ice)").eq("dossier_id", dossierId).eq("statut", "conforme").neq("statut_paiement", "payee"),
      (supabase as any).from("factures_fournisseurs").select("id,numero,montant_ht,montant_ttc,montant_tva,date_facture,date_echeance,fournisseur_nom,fournisseur_id").eq("dossier_id", dossierId).neq("statut_paiement", "payee"),
      (supabase as any).from("fournisseurs").select("id,nom,ice").eq("dossier_id", dossierId),
      supabase.from("clients").select("id,nom,ice").eq("dossier_id", dossierId),
      supabase.from("dossiers" as any).select("nom_societe,ice").eq("id", dossierId).single(),
      (supabase as any).from("justificatifs").select("id,type_document,nom_tiers,montant_ttc,numero_piece,date_document,bon_commande_id,devis_id,created_at,statut,eligible_edi").eq("dossier_id", dossierId).order("created_at", { ascending: false }),
    ]).then(([{data:f},{data:ff},{data:fo},{data:cl},{data:dos},{data:jj}]) => {
      setFactures(f ?? []);
      setFacturesFourn(ff ?? []);
      setFournisseurs(fo ?? []);
      setClients(cl ?? []);
      setDossier((dos as any) ?? null);
      setJustificatifs(jj ?? []);
    });
  }, [dossierId]);

  // ── PARSER UNIVERSEL — testé 19/19 sur relevé Attijariwafa réel ──────────
  const parserTransactions = (text: string): { txs: any[]; info: InfoReleve } => {
    const txs: any[] = [];
    const year = new Date().getFullYear();

    // ══ DEBUG ══ Copier-coller ce bloc dans la console du navigateur ══
    const rawLines = text.split(/\n/).map(l => l.trim()).filter(l => l.length > 3);
    console.log("=== RAW LINES (20 premières) ===");
    rawLines.slice(0, 20).forEach((l, i) => console.log(`[${i}] ${JSON.stringify(l)}`));
    // ══ FIN DEBUG ══

    const lower = text.toLowerCase();
    const banque = lower.includes("attijariwafa") ? "Attijariwafa Bank"
      : lower.includes("banque populaire") ? "Banque Populaire"
      : lower.includes("cih") ? "CIH Bank" : "Banque";

    // ── Soldes — pattern précis (saute la date DD MM YYYY avant le montant) ──
    const mInit = text.match(/(?:SOLDE\s+DEPART|ANCIEN\s+SOLDE)\s+AU\s+\d{1,2}\s+\d{1,2}\s+\d{4}\s+([\d\s]+,\d{2})\s*(?:CREDITEUR|DEBITEUR)?/i)
                ?? text.match(/(?:SOLDE\s+DEPART|ANCIEN\s+SOLDE)[^\n]*([\d\s]+,\d{2})/i);
    const mFin  = text.match(/(?:SOLDE\s+FINAL|SOLDE\s+A\s+REPORTER|NOUVEAU\s+SOLDE)\s+AU\s+\d{1,2}\s+\d{1,2}\s+\d{4}\s+([\d\s]+,\d{2})\s*(?:CREDITEUR|DEBITEUR)?/i)
                ?? text.match(/(?:SOLDE\s+FINAL|SOLDE\s+A\s+REPORTER|NOUVEAU\s+SOLDE)[^\n]*([\d\s]+,\d{2})/i);
    // Repli « SOLDE AU <date>  12 500,00 » nu (Crédit Agricole, Saham, CIH…) : le solde
    // de fin est la DERNIÈRE occurrence dans le document (l'ouverture serait la 1re).
    const soldeAuAll = [...text.matchAll(/\bSOLDE\s+AU\s+\d{1,2}[\s\/.\-]\d{1,2}[\s\/.\-]\d{2,4}\s+([\d\s]+,\d{2})/ig)];
    const mFinBare = soldeAuAll.length ? soldeAuAll[soldeAuAll.length - 1][1] : undefined;

    const parseMontant = (s?: string) => s ? parseFloat(s.replace(/\s/g, "").replace(",", ".")) : 0;

    // RIB : extraction robuste (ancrée sur le label « RELEVE D'IDENTITE BANCAIRE »,
    // tolérante aux séparateurs -/|/gras et au bruit OCR) — même logique que le serveur.
    const rib = extractRibMarocain(text);

    const info: InfoReleve = {
      banque, rib,
      solde_initial: parseMontant(mInit?.[1]),
      solde_final:   parseMontant(mFin?.[1] ?? mFinBare),
    };

    // ── ATTIJARIWAFA : preprocessing HEURISTIQUE multi-étapes (tolérant OCR) ────
    // Remplace l'ancien regex mono-ligne fragile. Reconstruit les transactions
    // multi-lignes, tolère le bruit OCR/CamScanner, et logue chaque bloc.
    if (banque === "Attijariwafa Bank") {
      const { txs: atwTxs } = parseAttijariReleve(text, { year, soldeInitial: info.solde_initial });
      if (atwTxs.length > 0) {
        return { txs: atwTxs.map((t, i) => ({ ...t, ligne: i + 1 })), info };
      }
      console.warn("[ATW] heuristique : 0 transaction → repli sur le parseur générique");
    }

    // ── Mots-clés exclusion ───────────────────────────────────────────────────
    // NB: ne pas mettre "debit"/"credit" ici — ils peuvent apparaître dans les libellés de transactions
    const EXCL = [
      "solde depart","solde final","solde a reporter","solde au ","ancien solde","nouveau solde",
      "total mouvements","total des","banque populaire","attijariwafa","cih bank",
      "agence","adresse","extrait de compte","releve de compte","code banque",
      "date oper","date valeur","libelle","montant","page n",
      "www.","sa au capital","ice :","rc :","if :","titulaire","morocco",
    ];
    const CREDIT_KW = [
      "VIRT RECU","VIR RECU","VIREMENT RECU","VIR REC",
      "VERSEMENT ESPECE","VERSEMENT ESP","VERSEMENT","DEPOT","DEPOT ESPECE","DEPOT CHQ",
      "REMISE CHEQUE","REMISE CHQ","REM CHQ","REMISE CB","REMISE ESP",
      "RECU DE","ENCAISSEMENT","RECOUVREMENT","AVIS DE CREDIT",
      "INTERETS CREDIT","INTERETS CREDITEUR","INTERET CREDIT",
      "AVOIR","CREDIT VIREMENT","CREDIT COMPTE",
    ];

    // Pattern montant marocain — gère les deux formats :
    //   avec séparateur espace : "1 500,00"  (Alt 1)
    //   sans séparateur       : "1500,00"    (Alt 2 — \d+ s'arrête au premier espace)
    const MTN_RE = String.raw`\d{1,3}(?:\s\d{3})*,\d{2}|\d+,\d{2}`;
    const parseMtn = (s: string) => parseFloat(s.replace(/\s/g, "").replace(",", "."));
    // BP avec deux montants (transaction + solde courant) — cas le plus fréquent
    const BP2 = new RegExp(
      `^(\\d{2})\\s+(\\d{2})\\s+(\\d{4})\\s+(\\d{2})\\s+(\\d{2})\\s+(\\d{4})\\s+(.+?)\\s+(${MTN_RE})\\s+(${MTN_RE})$`
    );
    // BP avec un seul montant (sans colonne solde)
    const BP1 = new RegExp(
      `^(\\d{2})\\s+(\\d{2})\\s+(\\d{4})\\s+(\\d{2})\\s+(\\d{2})\\s+(\\d{4})\\s+(.+?)\\s+(${MTN_RE})$`
    );
    // Extrait la référence (code alphanum avec chiffres) du champ texte après les dates
    const extractRL = (natRef: string): { reference: string; libelle: string } => {
      const words = natRef.trim().split(/\s+/);
      if (words.length > 1 && /^[A-Z0-9]{4,20}$/.test(words[0]) && /\d/.test(words[0])) {
        return { reference: words[0], libelle: words.slice(1).join(" ") };
      }
      return { reference: "", libelle: natRef.trim() };
    };

    const lines = text.split(/\n/).map(l => l.trim()).filter(l => l.length > 5);
    let ligneNum = 1;
    // Solde courant pour détection débit/crédit par delta (méthode fiable pour BP)
    let prevSolde: number | null = info.solde_initial > 0 ? info.solde_initial : null;

    for (const line of lines) {
      const low = line.toLowerCase();
      if (EXCL.some(e => low.includes(e))) continue;
      if (/^[\u0600-\u06FF\s,\.]+$/.test(line)) continue;
      if (/^\*+$/.test(line) || /^-{3,}$/.test(line)) continue;

      let date_op = "";
      let date_val = "";
      let reference = "";
      let libelle = "";
      let montant = 0;

      // ── Pattern 1 : Attijariwafa — CODE DD MM LIBELLE DD MM YYYY MONTANT ──
      // Testé et validé : 19/19 transactions
      const mATW = line.match(/^([A-Z0-9]{5,7})\s+(\d{2})\s+(\d{2})\s+(.+?)(\d{2})\s+(\d{2})\s+(20\d{2})\s+([\d\s]+,\d{2})$/);
      if (mATW) {
        const [, code, d1, m1, nat, d2, m2, y2, amt] = mATW;
        date_op   = `${d1}/${m1}/${year}`;
        date_val  = `${d2}/${m2}/${y2}`;
        reference = code;
        libelle   = nat.trim().replace(/-$/, "").trim();
        montant   = parseFloat(amt.replace(/\s/g, "").replace(",", "."));
        const up  = line.toUpperCase();
        const isCr = CREDIT_KW.some(k => up.includes(k));
        txs.push({
          ligne: ligneNum++, date_operation: date_op, date_valeur: date_val,
          reference, nature_operation: libelle || "Transaction",
          montant_debit: isCr ? null : montant,
          montant_credit: isCr ? montant : null,
        });
        continue;
      }

      // ── Pattern 2a : Banque Populaire avec colonne solde ─────────────────
      // Format : DD MM YYYY DD MM YYYY [REF] LIBELLE  MONTANT  SOLDE
      // Direction débit/crédit détectée par delta du solde courant (fiable à 100%)
      const mBP2 = line.match(BP2);
      if (mBP2) {
        const [, d1, m1, y1, d2, m2, y2, natRef, amtStr, soldeStr] = mBP2;
        date_op  = `${d1}/${m1}/${y1}`;
        date_val = `${d2}/${m2}/${y2}`;
        montant  = parseMtn(amtStr);
        const newSolde = parseMtn(soldeStr);
        ({ reference, libelle } = extractRL(natRef));

        const prevForLog = prevSolde;
        let isCr: boolean;
        if (prevSolde !== null) {
          isCr = newSolde > prevSolde + 0.005; // tolérance arrondi bancaire
        } else {
          isCr = CREDIT_KW.some(k => line.toUpperCase().includes(k));
        }
        prevSolde = newSolde;

        console.log("[BP2]", libelle, "| montant:", montant, "| solde:", prevForLog, "→", newSolde, "| isCr:", isCr);
        txs.push({
          ligne: ligneNum++, date_operation: date_op, date_valeur: date_val,
          reference, nature_operation: libelle || "Transaction",
          montant_debit: isCr ? null : montant,
          montant_credit: isCr ? montant : null,
        });
        continue;
      }

      // ── Pattern 2b : Banque Populaire sans colonne solde ─────────────────
      const mBP1 = line.match(BP1);
      if (mBP1) {
        const [, d1, m1, y1, d2, m2, y2, natRef, amtStr] = mBP1;
        date_op  = `${d1}/${m1}/${y1}`;
        date_val = `${d2}/${m2}/${y2}`;
        montant  = parseMtn(amtStr);
        ({ reference, libelle } = extractRL(natRef));
        const isCr = CREDIT_KW.some(k => line.toUpperCase().includes(k));
        console.log("[BP1-fallback]", libelle, "| montant:", montant, "| isCr:", isCr, "(keywords only)");
        txs.push({
          ligne: ligneNum++, date_operation: date_op, date_valeur: date_val,
          reference, nature_operation: libelle || "Transaction",
          montant_debit: isCr ? null : montant,
          montant_credit: isCr ? montant : null,
        });
        continue;
      }

      // ── Pattern 3 : CIH — DD/MM LIBELLE MONTANT ──────────────────────────
      const mCIH = line.match(/^(\d{2})[\/\-](\d{2})\s+(.+?)\s+([\d\s]+,\d{2})$/);
      if (mCIH) {
        const [, d, m, nat, amt] = mCIH;
        if (Number(d) <= 31 && Number(m) <= 12) {
          date_op  = `${d}/${m}/${year}`;
          date_val = date_op;
          libelle  = nat.trim();
          montant  = parseFloat(amt.replace(/\s/g, "").replace(",", "."));
          const up  = line.toUpperCase();
          const isCr = CREDIT_KW.some(k => up.includes(k));
          txs.push({
            ligne: ligneNum++, date_operation: date_op, date_valeur: date_val,
            reference: "", nature_operation: libelle || "Transaction",
            montant_debit: isCr ? null : montant,
            montant_credit: isCr ? montant : null,
          });
        }
      }
    }

    return { txs, info };
  };

  // Rendu d'une page PDF en base64 JPEG via canvas (pour CamScanned PDFs)
  const pdfPageToBase64 = async (pdfjsLib: any, ab: ArrayBuffer, pageNum: number): Promise<string> => {
    const pdf = await pdfjsLib.getDocument({ data: ab.slice(0) }).promise;
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 2.0 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d")!;
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas.toDataURL("image/jpeg", 0.92).split(",")[1];
  };

  const lancerScan = async (file: File, remarquesExtra = "") => {
    setStep("scan");
    try {
      // Recharger tout en frais — l'utilisateur peut avoir créé de nouveaux docs
      // depuis l'ouverture de la page
      const [{ data: freshF }, { data: freshFF }, { data: freshFo }, { data: freshCl }, { data: freshJJ }] =
        await Promise.all([
          supabase.from("factures").select("id,numero,montant_ht,montant_ttc,montant_tva,date_facture,date_echeance,clients(id,nom,ice)").eq("dossier_id", dossierId).eq("statut", "conforme").neq("statut_paiement", "payee"),
          (supabase as any).from("factures_fournisseurs").select("id,numero,montant_ht,montant_ttc,montant_tva,date_facture,date_echeance,fournisseur_nom,fournisseur_id,montant_restant,mode_reglement").eq("dossier_id", dossierId).neq("statut_paiement", "payee"),
          (supabase as any).from("fournisseurs").select("id,nom,ice").eq("dossier_id", dossierId),
          supabase.from("clients").select("id,nom,ice").eq("dossier_id", dossierId),
          (supabase as any).from("justificatifs").select("id,type_document,nom_tiers,montant_ttc,numero_piece,date_document,bon_commande_id,devis_id,created_at,statut,eligible_edi").eq("dossier_id", dossierId).order("created_at", { ascending: false }),
        ]);
      if (freshF)  setFactures(freshF);
      if (freshFF) setFacturesFourn(freshFF);
      if (freshFo) setFournisseurs(freshFo);
      if (freshCl) setClients(freshCl);
      if (freshJJ) setJustificatifs(freshJJ);

      const isImage = file.type.startsWith("image/");
      let txBrutes: any[] = [];
      let info: InfoReleve = { banque: "", rib: "", solde_initial: 0, solde_final: 0 };

      // Identité du DOCUMENT : les N pages d'un relevé scanné ne doivent
      // consommer qu'un seul scan de quota (cf. ocrReleve.scan_key).
      const scanKey = `${file.name}:${file.size}:${file.lastModified}`;

      if (isImage) {
        // ── Chemin image directe (JPEG/PNG) ─────────────────────────────────
        const base64 = await new Promise<string>((res, rej) => {
          const reader = new FileReader();
          reader.onload = () => res((reader.result as string).split(",")[1]);
          reader.onerror = rej;
          reader.readAsDataURL(file);
        });
        const result = await ocrReleve({ data: { image_base64: base64, mime_type: file.type, dossier_id: dossierId, scan_key: scanKey } });
        txBrutes = result.txs;
        info = result.info;
      } else {
        // ── Chemin PDF ───────────────────────────────────────────────────────
        const pdfjsLib = await import("pdfjs-dist");
        pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
        const ab = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: ab.slice(0) }).promise;
        let fullText = "";

        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          // ── CORRECTION CRITIQUE : reconstruction par coordonnée Y ──────────
          const items = content.items as any[];
          let lastY = -1;
          let lineText = "";
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

        console.log("[SCANNER] Texte extrait (500 premiers chars):", fullText.slice(0, 500));

        const textNonWs = fullText.replace(/\s/g, "").length;
        const likelyScan = textNonWs < 300 || /camscanner/i.test(fullText);

        if (likelyScan) {
          // ── PDF scanné / CamScanner → rendu canvas page par page ────────────
          toast.info("PDF scanné détecté — OCR vision en cours…");
          const allTxs: any[] = [];
          let lastSoldeFinal: number | undefined;
          for (let p = 1; p <= pdf.numPages; p++) {
            const base64 = await pdfPageToBase64(pdfjsLib, ab, p);
            const result = await ocrReleve({ data: { image_base64: base64, mime_type: "image/jpeg", solde_initial_override: lastSoldeFinal, dossier_id: dossierId, scan_key: scanKey } });
            // Le solde_final de cette page = solde_initial de la page suivante
            if (result.info.solde_final > 0) lastSoldeFinal = result.info.solde_final;
            allTxs.push(...result.txs.map((t: any, i: number) => ({ ...t, ligne: allTxs.length + i + 1 })));
            if (p === 1) info = result.info;
          }
          txBrutes = allTxs;
        } else {
          // ── PDF numérique texte → parser multi-banques ───────────────────────
          const parsed = parserTransactions(fullText);
          txBrutes = parsed.txs;
          info = parsed.info;
        }
      }

      setInfoReleve(info);
      console.log("[SCANNER] Transactions extraites:", txBrutes.length);

      if (txBrutes.length === 0) {
        toast.error("Aucune transaction détectée — vérifiez la qualité de l'image");
        setStep("upload");
        return;
      }

      // ── Traitement DÉCOUPLÉ (queue BullMQ) : l'OCR (txBrutes) est fait ici, le
      // LLM + mémoire + rapprochement partent dans un job. Le worker récupère
      // lui-même le contexte (factures/clients…) côté serveur. En l'absence de
      // Redis, enqueueDocumentJob traite en INLINE et renvoie déjà le résultat.
      // Le résultat conserve la forme { analyses } de analyserReleveIA.
      toast.info("Traitement en cours…");
      const job = await runDocumentJob(
        {
          dossier_id: dossierId,
          type: "releve",
          payload: { transactions_brutes: txBrutes, remarques: remarquesExtra || remarques },
        },
        (s) => { if (s === "processing") toast.loading("Analyse IA en cours…", { id: "job-releve" }); },
      );
      toast.dismiss("job-releve");
      if (job.status === "failed") { toast.error("Échec du traitement : " + (job.error ?? "inconnu")); setStep("upload"); return; }
      const result = job.result ?? { analyses: [] };

      const txFinal: Transaction[] = txBrutes.map((tx: any, idx: number) => {
        // analyserReleveIA retourne analyses[idx] = analyse de txBrutes[idx]
        const a = result.analyses[idx] ?? {};
        // categorie (analyserReleveIA) ou nature_principale (ancienne API) — rétro-compat
        const natureVal: string = a.categorie ?? a.nature_principale ?? "autre";
        const nature = NATURES_OPERATION.find(n => n.value === natureVal);
        return {
          id: `tx_${idx}`, ligne: tx.ligne,
          date_operation: tx.date_operation, date_valeur: tx.date_valeur,
          reference: tx.reference ?? "", nature_operation: tx.nature_operation,
          montant_debit: tx.montant_debit, montant_credit: tx.montant_credit,
          nature_confirmee: natureVal,
          document_reference: a.facture_num ?? "",
          debiteur_crediteur: a.tiers_nom ?? "",
          code_comptable: a.code_pcm ?? nature?.code ?? "6141",
          montant_ht: a.montant_ht ?? null, montant_tva: a.montant_tva ?? null,
          taux_tva: a.taux_tva ?? 0, confiance: a.confiance ?? 50,
          valide: (a.confiance ?? 0) >= 90,
          remarque: "", alerte: a.alerte ?? null,
          necessite_remarque: a.necessite_remarque ?? false,
          message_pour_comptable: a.message_pour_comptable ?? null,
          etape_rapprochement: a.etape_rapprochement ?? "inconnu",
          facture_id:      a.facture_id ?? null,
          justificatif_id: a.justificatif_id ?? null,
          source: a.source === "memoire" ? "memoire" : "ia",
          suggestions: a.suggestions ?? [],
        };
      });

      setTransactions(txFinal);
      setStep("review");
      toast.success(`${txFinal.length} transactions extraites et analysées`);
    } catch (e: any) {
      toast.error("Erreur scan : " + e.message);
      setStep("upload");
    }
  };

  const handleUpload = async (file: File) => {
    setPdfFile(file);
    setPdfUrl(URL.createObjectURL(file));
    await lancerScan(file);
  };

  const updateTx = (idx: number, updates: Partial<Transaction>) => {
    setTransactions(prev => prev.map((tx, i) => {
      if (i !== idx) return tx;
      const updated = { ...tx, ...updates };
      if (updates.nature_confirmee) {
        const nature = NATURES_OPERATION.find(n => n.value === updates.nature_confirmee);
        if (nature) {
          updated.code_comptable = nature.code;
          const montant = tx.montant_debit ?? tx.montant_credit ?? 0;
          if (nature.tva && montant > 0) {
            const taux = updated.taux_tva || 20;
            updated.montant_ht  = Math.round(montant / (1 + taux / 100) * 100) / 100;
            updated.montant_tva = Math.round((montant - updated.montant_ht) * 100) / 100;
          } else {
            updated.montant_ht = montant; updated.montant_tva = null;
          }
        }
      }
      return updated;
    }));
  };

  const handleValider = async () => {
    const nonValidees = transactions.filter(tx => !tx.valide);
    if (nonValidees.length > 0) {
      const ok = window.confirm(`${nonValidees.length} transaction(s) non validées. Continuer ?`);
      if (!ok) return;
    }
    setSaving(true);
    try {
      const ecritures: any[] = [];
      const facturesClientPayees: string[] = [];
      const facturesFournPayees: string[] = [];

      for (const tx of transactions.filter(t => t.valide)) {
        const parts = tx.date_operation.split("/");
        const date = parts.length === 3 && parts[2].length === 4
          ? `${parts[2]}-${parts[1]}-${parts[0]}`
          : tx.date_operation;
        const montant = tx.montant_credit ?? tx.montant_debit ?? 0;
        const libelle = (tx.debiteur_crediteur ? `${tx.nature_operation} - ${tx.debiteur_crediteur}` : tx.nature_operation).slice(0, 100);
        const ht  = tx.montant_ht  ?? montant;
        const tva = tx.montant_tva ?? 0;

        ecritures.push({ dossier_id: dossierId, journal_code: "BQ", compte_numero: "5141", date_ecriture: date, libelle, debit: tx.montant_credit ? montant : 0, credit: tx.montant_debit ? montant : 0, reference_piece: tx.document_reference || tx.reference, valide: true });

        if (tva > 0 && tx.montant_debit) {
          ecritures.push({ dossier_id: dossierId, journal_code: "BQ", compte_numero: tx.code_comptable, date_ecriture: date, libelle, debit: ht, credit: 0, reference_piece: tx.document_reference, valide: true });
          ecritures.push({ dossier_id: dossierId, journal_code: "BQ", compte_numero: "34552", date_ecriture: date, libelle: `TVA ${libelle.slice(0,50)}`, debit: tva, credit: 0, reference_piece: tx.document_reference, valide: true });
        } else {
          ecritures.push({ dossier_id: dossierId, journal_code: "BQ", compte_numero: tx.code_comptable, date_ecriture: date, libelle, debit: tx.montant_debit ? 0 : ht, credit: tx.montant_credit ? 0 : ht, reference_piece: tx.document_reference, valide: true });
        }

        if (tx.facture_id) {
          // Vérifier dans quelle liste appartient la facture — plus fiable que
          // nature_confirmee qui peut être "telecom" même pour une facture IAM
          const isClientFac = factures.some((f: any) => f.id === tx.facture_id);
          const isFournFac  = facturesFourn.some((f: any) => f.id === tx.facture_id);
          if (isClientFac && tx.montant_credit)  facturesClientPayees.push(tx.facture_id);
          if (isFournFac  && tx.montant_debit)   facturesFournPayees.push(tx.facture_id);
        }
      }

      await supabase.from("ecritures_comptables").insert(ecritures);

      // Solder les factures rapprochées via un PAIEMENT (source de vérité) couvrant le
      // reste dû ; le trigger recalcule montant_paye/restant/statut. Ces transactions
      // scannées ne sont pas persistées dans transactions_bancaires : le paiement est donc
      // 'manuel', avec une référence d'idempotence (rejouer le scan ne double pas). Repli
      // avant migration : la mise à jour directe des colonnes, gérée par enregistrerPaiement.
      const datePaiement = new Date().toISOString().slice(0, 10);
      const solder = async (table: "factures" | "factures_fournisseurs", ids: string[], source: any[]) => {
        for (const id of ids) {
          const f = source.find((x: any) => x.id === id);
          const reste = Math.round((Number(f?.montant_ttc ?? 0) - Number(f?.montant_paye ?? 0)) * 100) / 100;
          if (reste <= 0) continue;
          await enregistrerPaiement(supabase, {
            dossierId, table, factureId: id, montant: reste, date: datePaiement,
            origine: "manuel", reference: "solde-releve-scan",
          });
        }
      };
      await solder("factures", facturesClientPayees, factures);
      await solder("factures_fournisseurs", facturesFournPayees, facturesFourn);

      // ── MÉMOIRE BANQUE (point 1) : write-back après validation utilisateur ──
      // Chaque transaction validée enrichit tiers_memoire (sens='banque') : le
      // pattern du libellé → classif (compte/catégorie/TVA) + type_tiers. Au 2e
      // passage du même tiers (occurrences ≥ 2), le scan court-circuitera le LLM.
      // Dégradation gracieuse : un échec mémoire ne bloque jamais la compta.
      const AUTRE_CATS = new Set([
        "frais_bancaires", "retrait_especes", "virement_interne", "salaires",
        "cnss_amo", "tva_dgi", "interets_crediteurs", "taxe_professionnelle", "frais_douane",
      ]);
      try {
        await Promise.all(
          transactions.filter(t => t.valide).map((tx) => {
            const libelle = tx.nature_operation ?? "";
            if (!libelle.trim()) return Promise.resolve();
            const type_tiers = AUTRE_CATS.has(tx.nature_confirmee)
              ? "autre" as const
              : (tx.montant_credit ? "client" as const : "fournisseur" as const);
            return memoriserTiers({
              data: {
                dossier_id: dossierId,
                sens: "banque",
                nom: libelle,
                compte_pcm: tx.code_comptable ?? null,
                categorie_pcm: tx.nature_confirmee ?? null,
                taux_tva: tx.taux_tva ?? null,
                type_tiers,
              },
            }).catch(() => undefined);
          }),
        );
      } catch { /* mémoire best-effort — jamais bloquant */ }

      const nbPayees = facturesClientPayees.length + facturesFournPayees.length;
      toast.success(`${transactions.filter(t => t.valide).length} transactions comptabilisées` + (nbPayees > 0 ? ` — ${nbPayees} facture(s) marquée(s) payée(s)` : ""));
      setStep("done");
    } catch (e: any) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  const genererEDI = () => {
    const txFourn = transactions.filter(tx => tx.valide && tx.nature_confirmee === "paiement_fournisseur" && tx.montant_debit);
    if (!txFourn.length) { toast.warning("Aucune transaction fournisseur validée"); return; }
    const rows = [["OR","FACT_NUM","DESIGNATION","M_HT","TVA","M_TTC","IF","LIB_FRSS","ICE_FRS","TAUX","ID_PAIE","DATE_PAIE","DATE_FAC"]];
    txFourn.forEach((tx, i) => {
      const fourn = (fournisseurs as any[]).find(f => f.nom === tx.debiteur_crediteur);
      rows.push([String(i+1),tx.document_reference||"—",tx.nature_operation.slice(0,50),String(tx.montant_ht??tx.montant_debit??0),String(tx.montant_tva??0),String(tx.montant_debit??0),fourn?.if||"",tx.debiteur_crediteur||"FOURNISSEUR",fourn?.ice||"",String(tx.taux_tva||20),String(i+1),tx.date_operation,tx.date_valeur]);
    });
    const blob = new Blob(["\uFEFF" + rows.map(r => r.join(";")).join("\n")], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `EDI_DGI_${new Date().toISOString().slice(0,7)}.csv`; a.click();
    toast.success("EDI DGI généré");
  };

  const genererBilan = () => {
    const rows = [["Date","Journal","Compte","Libellé","Débit","Crédit","Réf."]];
    for (const tx of transactions.filter(t => t.valide)) {
      const montant = tx.montant_credit ?? tx.montant_debit ?? 0;
      const libelle = `${tx.nature_operation} - ${tx.debiteur_crediteur}`;
      const ht = tx.montant_ht ?? montant;
      const tva = tx.montant_tva ?? 0;
      rows.push([tx.date_operation,"BQ","5141",libelle,tx.montant_credit?String(montant):"",tx.montant_debit?String(montant):"",tx.document_reference]);
      if (tva > 0 && tx.montant_debit) {
        rows.push([tx.date_operation,"BQ",tx.code_comptable,libelle,String(ht),"",tx.document_reference]);
        rows.push([tx.date_operation,"BQ","34552",`TVA ${libelle}`,String(tva),"",tx.document_reference]);
      } else {
        rows.push([tx.date_operation,"BQ",tx.code_comptable,libelle,tx.montant_debit?"":String(ht),tx.montant_credit?"":String(ht),tx.document_reference]);
      }
    }
    const blob = new Blob(["\uFEFF" + rows.map(r => r.join(";")).join("\n")], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `Bilan_Sage_${new Date().toISOString().slice(0,10)}.csv`; a.click();
    toast.success("Bilan Sage généré");
  };

  const resetAll = () => { setStep("upload"); setPdfUrl(null); setPdfFile(null); setTransactions([]); setInfoReleve(null); setSelectedTx(null); };
  const getNatureLabel = (v: string) => NATURES_OPERATION.find(n => n.value === v)?.label ?? v;
  const confColor = (c: number) => c >= 90 ? "text-green-600" : c >= 70 ? "text-yellow-500" : "text-red-500";
  const nbValides = transactions.filter(t => t.valide).length;
  const nbAlertes = transactions.filter(t => !!t.alerte).length;

  return (
    <div className="flex flex-col h-screen bg-background">
      <div className="border-b px-6 py-3 flex items-center justify-between bg-card shrink-0">
        <div className="flex items-center gap-3">
          <FileText className="h-5 w-5 text-primary" />
          <div>
            <h1 className="font-bold text-base">Scanner de relevé bancaire</h1>
            {infoReleve && <p className="text-xs text-muted-foreground">{infoReleve.banque} {infoReleve.rib ? `— ${infoReleve.rib}` : ""}</p>}
          </div>
          {step === "review" && (
            <div className="flex gap-2 ml-4">
              <Badge variant="outline" className="text-xs">{transactions.length} transactions</Badge>
              <Badge className="text-xs bg-green-600">{nbValides} validées</Badge>
              {nbAlertes > 0 && <Badge variant="destructive" className="text-xs">{nbAlertes} alertes</Badge>}
            </div>
          )}
        </div>
        {step === "review" && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setShowRemarques(true)}><RefreshCw className="h-3.5 w-3.5 mr-1.5" />Rescanner</Button>
            <Button variant="outline" size="sm" onClick={genererBilan}><Download className="h-3.5 w-3.5 mr-1.5" />Bilan Sage</Button>
            <Button variant="outline" size="sm" onClick={genererEDI}><Download className="h-3.5 w-3.5 mr-1.5" />EDI DGI</Button>
            <Button variant="outline" size="sm" onClick={() => setTransactions(prev => prev.map(tx => ({...tx, valide: true})))}><CheckCircle className="h-3.5 w-3.5 mr-1.5" />Valider tout</Button>
            <Button size="sm" onClick={handleValider} disabled={saving}>
              {saving ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <CheckCircle className="h-3.5 w-3.5 mr-1.5" />}Valider écriture
            </Button>
            <Button variant="ghost" size="sm" onClick={resetAll}><X className="h-3.5 w-3.5 mr-1.5" />Annuler</Button>
          </div>
        )}
      </div>

      {step === "upload" && (
        <div className="flex-1 flex items-center justify-center">
          <div className="border-2 border-dashed rounded-2xl p-16 text-center cursor-pointer hover:border-primary transition-all max-w-lg w-full mx-4"
            onClick={() => fileRef.current?.click()}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleUpload(f); }}>
            <input ref={fileRef} type="file" className="hidden" accept=".pdf,.jpg,.jpeg,.png" onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f); }} />
            <div className="flex justify-center gap-4 mb-4">
              <FileText className="h-10 w-10 text-muted-foreground opacity-50" />
              <Image className="h-10 w-10 text-muted-foreground opacity-50" />
            </div>
            <p className="font-semibold text-lg mb-1">Importez votre relevé bancaire</p>
            <p className="text-sm text-muted-foreground mb-1">PDF numérique — Attijariwafa, Banque Populaire, CIH</p>
            <p className="text-sm text-muted-foreground mb-2">Image ou PDF scanné / CamScanner — OCR automatique</p>
            <p className="text-xs text-muted-foreground mb-4 opacity-70">Soldes, transactions et matching factures automatiques</p>
            <Button>Sélectionner (PDF ou image)</Button>
          </div>
        </div>
      )}

      {step === "scan" && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <Loader2 className="h-12 w-12 animate-spin mx-auto text-primary mb-4" />
            <p className="font-semibold text-lg">Analyse en cours…</p>
            <p className="text-sm text-muted-foreground mt-1">Extraction + OCR vision + Matching factures + Groq PCM</p>
          </div>
        </div>
      )}

      {step === "review" && (
        <div className="flex-1 flex overflow-hidden">
          <div className="flex-1 overflow-y-auto border-r flex flex-col">
            <div className="sticky top-0 bg-muted/90 backdrop-blur border-b px-4 py-2 grid grid-cols-12 gap-1 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide z-10 shrink-0">
              <div className="col-span-1">#</div>
              <div className="col-span-1">Date</div>
              <div className="col-span-2">Nature</div>
              <div className="col-span-2">Doc. référence</div>
              <div className="col-span-2">Débiteur / Créditeur</div>
              <div className="col-span-1">Code PCM</div>
              <div className="col-span-1 text-right">HT</div>
              <div className="col-span-1 text-right">TVA</div>
              <div className="col-span-1 text-right">TTC</div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {transactions.map((tx, idx) => (
                <div key={tx.id}
                  className={`border-b px-4 py-2 cursor-pointer transition-colors ${selectedTx === idx ? "bg-primary/5 border-l-2 border-l-primary" : "hover:bg-muted/30"}`}
                  onClick={() => setSelectedTx(selectedTx === idx ? null : idx)}>
                  <div className="grid grid-cols-12 gap-1 items-center">
                    <div className="col-span-1 flex items-center gap-1">
                      <span className="text-xs font-mono text-muted-foreground">{tx.ligne}</span>
                      {tx.valide ? <CheckCircle className="h-3 w-3 text-green-500 shrink-0" /> : <AlertCircle className="h-3 w-3 text-yellow-500 shrink-0" />}
                    </div>
                    <div className="col-span-1 text-xs font-mono text-muted-foreground">{tx.date_operation}</div>
                    <div className="col-span-2" onClick={e => e.stopPropagation()}>
                      <Select value={tx.nature_confirmee} onValueChange={v => updateTx(idx, { nature_confirmee: v, valide: false })}>
                        <SelectTrigger className="h-7 text-xs border-0 bg-transparent p-0 focus:ring-0 shadow-none">
                          <div className="flex items-center gap-1 overflow-hidden">
                            <span className={`text-xs ${confColor(tx.confiance)}`}>●</span>
                            <span className="truncate">{getNatureLabel(tx.nature_confirmee)}</span>
                          </div>
                        </SelectTrigger>
                        <SelectContent>
                          {tx.suggestions.length > 0 && (
                            <><div className="px-2 py-1 text-xs text-muted-foreground font-semibold">Suggestions IA</div>
                            {tx.suggestions.map((s, si) => (
                              <SelectItem key={si} value={s.nature} className="text-xs">
                                <span className="text-primary mr-1">{s.confiance}%</span> {getNatureLabel(s.nature)}
                              </SelectItem>
                            ))}
                            <div className="border-t my-1" /></>
                          )}
                          {NATURES_OPERATION.map(n => <SelectItem key={n.value} value={n.value} className="text-xs">{n.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      {tx.alerte && <p className="text-[10px] text-orange-600 truncate">⚠️ {tx.alerte}</p>}
                      {tx.necessite_remarque && <p className="text-[10px] text-blue-600 truncate">💬 {tx.message_pour_comptable}</p>}
                    </div>
                    <div className="col-span-2" onClick={e => e.stopPropagation()}>
                      <Input value={tx.document_reference} onChange={e => updateTx(idx, { document_reference: e.target.value })} placeholder="N° facture / contrat…" className="h-7 text-xs border-0 bg-transparent focus-visible:ring-0 p-0 shadow-none" />
                    </div>
                    <div className="col-span-2" onClick={e => e.stopPropagation()}>
                      <Input value={tx.debiteur_crediteur} onChange={e => updateTx(idx, { debiteur_crediteur: e.target.value })} placeholder="Client / Fournisseur…" className="h-7 text-xs border-0 bg-transparent focus-visible:ring-0 p-0 shadow-none" />
                    </div>
                    <div className="col-span-1" onClick={e => e.stopPropagation()}>
                      <Input value={tx.code_comptable} onChange={e => updateTx(idx, { code_comptable: e.target.value })} className="h-7 text-xs font-mono border-0 bg-transparent focus-visible:ring-0 p-0 shadow-none" />
                    </div>
                    <div className="col-span-1 text-right text-xs font-mono">{tx.montant_ht != null ? tx.montant_ht.toLocaleString("fr-MA",{minimumFractionDigits:2}) : "—"}</div>
                    <div className="col-span-1 text-right text-xs font-mono text-muted-foreground">{tx.montant_tva != null ? tx.montant_tva.toLocaleString("fr-MA",{minimumFractionDigits:2}) : "—"}</div>
                    <div className={`col-span-1 text-right text-xs font-mono font-semibold ${tx.montant_credit ? "text-green-600" : "text-red-600"}`}>
                      {tx.montant_credit ? `+${tx.montant_credit.toLocaleString("fr-MA",{minimumFractionDigits:2})}` : tx.montant_debit ? `-${tx.montant_debit.toLocaleString("fr-MA",{minimumFractionDigits:2})}` : "—"}
                    </div>
                  </div>
                  <div className="mt-0.5 pl-6 flex items-center gap-1.5 min-w-0">
                    <span className="text-[10px] text-muted-foreground truncate">{tx.nature_operation}</span>
                    {tx.source === "memoire" ? (
                      <span className="shrink-0 inline-flex items-center gap-0.5 rounded bg-green-100 text-green-700 px-1 py-px text-[9px] font-medium" title="Classé instantanément par la mémoire — appel IA évité">
                        ⚡ Mémoire · IA évitée
                      </span>
                    ) : (
                      <span className="shrink-0 inline-flex items-center gap-0.5 rounded bg-muted text-muted-foreground px-1 py-px text-[9px] font-medium" title="Analysé par l'IA">
                        🤖 IA
                      </span>
                    )}
                  </div>
                  {selectedTx === idx && (
                    <div className="mt-3 ml-6 p-3 rounded-lg bg-muted/50 border space-y-3" onClick={e => e.stopPropagation()}>
                      <div className="grid grid-cols-3 gap-3">
                        <div>
                          <p className="text-[10px] font-semibold uppercase text-muted-foreground mb-1">Taux TVA</p>
                          <Select value={String(tx.taux_tva)} onValueChange={v => updateTx(idx, { taux_tva: Number(v) })}>
                            <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>{[0,7,10,14,20].map(t => <SelectItem key={t} value={String(t)}>{t}%</SelectItem>)}</SelectContent>
                          </Select>
                        </div>
                        <div>
                          <p className="text-[10px] font-semibold uppercase text-muted-foreground mb-1">Montant HT</p>
                          <Input type="number" value={tx.montant_ht ?? ""} onChange={e => { const ht = parseFloat(e.target.value)||0; updateTx(idx, { montant_ht: ht, montant_tva: Math.round(((tx.montant_debit??tx.montant_credit??0)-ht)*100)/100 }); }} className="h-7 text-xs font-mono" />
                        </div>
                        <div>
                          <p className="text-[10px] font-semibold uppercase text-muted-foreground mb-1">TVA</p>
                          <Input type="number" value={tx.montant_tva ?? ""} onChange={e => updateTx(idx, { montant_tva: parseFloat(e.target.value)||0 })} className="h-7 text-xs font-mono" />
                        </div>
                      </div>
                      <div>
                        <p className="text-[10px] font-semibold uppercase text-muted-foreground mb-1">Remarque</p>
                        <Input value={tx.remarque} onChange={e => updateTx(idx, { remarque: e.target.value })} placeholder="Précision sur cette transaction…" className="h-7 text-xs" />
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" className="h-7 text-xs" onClick={() => updateTx(idx, { valide: true })}><CheckCircle className="h-3 w-3 mr-1" />Valider</Button>
                        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => updateTx(idx, { valide: false })}>Invalider</Button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="sticky bottom-0 bg-card border-t px-4 py-2 grid grid-cols-12 gap-1 text-xs font-semibold shrink-0">
              <div className="col-span-9">TOTAUX</div>
              <div className="col-span-1 text-right">{transactions.reduce((s,t)=>s+(t.montant_ht??(t.montant_debit??t.montant_credit??0)),0).toLocaleString("fr-MA",{minimumFractionDigits:2})}</div>
              <div className="col-span-1 text-right text-muted-foreground">{transactions.reduce((s,t)=>s+(t.montant_tva??0),0).toLocaleString("fr-MA",{minimumFractionDigits:2})}</div>
              <div className="col-span-1 text-right">
                <span className="text-green-600">+{transactions.reduce((s,t)=>s+(t.montant_credit??0),0).toLocaleString("fr-MA",{minimumFractionDigits:0})}</span>
                {" / "}
                <span className="text-red-600">-{transactions.reduce((s,t)=>s+(t.montant_debit??0),0).toLocaleString("fr-MA",{minimumFractionDigits:0})}</span>
              </div>
            </div>
          </div>
          <div className="w-96 bg-muted/20 flex flex-col shrink-0">
            <div className="p-3 border-b bg-card shrink-0">
              <p className="text-xs font-semibold">Relevé bancaire original</p>
              {infoReleve && (
                <div className="mt-1 space-y-0.5 text-[10px] text-muted-foreground">
                  <p>{infoReleve.banque}</p>
                  {infoReleve.rib && <p>RIB : {infoReleve.rib}</p>}
                  <p>Solde initial : <span className="font-mono font-semibold">{infoReleve.solde_initial.toLocaleString("fr-MA",{minimumFractionDigits:2})} MAD</span></p>
                  <p>Solde final : <span className="font-mono font-semibold">{infoReleve.solde_final.toLocaleString("fr-MA",{minimumFractionDigits:2})} MAD</span></p>
                </div>
              )}
            </div>
            <div className="flex-1 overflow-hidden">
              {pdfUrl && <iframe src={pdfUrl} className="w-full h-full border-0" title="Relevé bancaire" />}
            </div>
          </div>
        </div>
      )}

      {step === "done" && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <CheckCircle className="h-16 w-16 text-green-500 mx-auto mb-4" />
            <h2 className="text-xl font-bold mb-2">Écriture comptable validée</h2>
            <p className="text-muted-foreground mb-6">{transactions.filter(t=>t.valide).length} transactions enregistrées</p>
            <div className="flex gap-3 justify-center">
              <Button variant="outline" onClick={genererBilan}><Download className="h-4 w-4 mr-2" />Bilan Sage</Button>
              <Button variant="outline" onClick={genererEDI}><Download className="h-4 w-4 mr-2" />EDI DGI</Button>
              <Button onClick={resetAll}>Nouveau relevé</Button>
            </div>
          </div>
        </div>
      )}

      <Dialog open={showRemarques} onOpenChange={setShowRemarques}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Rescanner avec remarques</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Précisions pour améliorer la détection :</p>
            <Textarea value={remarques} onChange={e => setRemarques(e.target.value)}
              placeholder="Ex : FIRSTAUM = loyer bureau, CNSS le 10 du mois, ATLAS = fournisseur emballage…"
              rows={4} className="text-sm" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRemarques(false)}>Annuler</Button>
            <Button onClick={() => { setShowRemarques(false); if (pdfFile) lancerScan(pdfFile, remarques); }}>
              <Sparkles className="h-4 w-4 mr-2" />Rescanner avec IA
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}



