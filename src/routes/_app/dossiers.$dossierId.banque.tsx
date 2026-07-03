import { createFileRoute, Outlet, useChildMatches, Link } from "@tanstack/react-router";
import { Fragment, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Landmark, Upload, Loader2, TrendingUp, TrendingDown, CheckCircle, FileText, AlertCircle, RefreshCw, Download, X, Sparkles, Eye, Pencil, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { analyserReleveIA, extraireTransactionsVision } from "@/server/factures.functions";
import { lettrerDossier } from "@/server/lettrage.functions";
import { PCM_MAP, RX_VIREMENT_INTERNE, deriveCategorie, genererLignesBQ } from "@/lib/comptabilite-bq";
// @ts-ignore
import * as pdfjsLib from 'pdfjs-dist';

export const Route = createFileRoute("/_app/dossiers/$dossierId/banque")({
  component: BanquePage,
});

const fmt = (n: number) => Number(n).toLocaleString("fr-MA", { minimumFractionDigits: 2 }) + " MAD";

// ─── Types ────────────────────────────────────────────────────────────────────
interface Compte { id: string; banque: string | null; intitule: string | null; rib: string | null; solde_actuel: number; }
interface TxBancaire { id: string; date_operation: string; libelle: string | null; reference?: string | null; type: string; montant: number; solde_apres: number | null; rapproche: boolean; statut?: string; facture_id?: string | null; justificatif_id?: string | null; document_type?: string | null; categorie?: string | null; compte_comptable?: string | null; }
interface Releve { id: string; compte_id?: string | null; fichier_nom: string | null; fichier_path?: string | null; fichier_type?: string | null; banque?: string | null; rib?: string | null; periode_debut?: string | null; periode_fin?: string | null; statut: string; nombre_transactions: number; solde_initial: number; solde_final: number; created_at: string; }
interface FactureNonPayee { id: string; type: "client" | "fournisseur"; numero: string | null; nom: string; montant_ttc: number; date_echeance: string | null; }

interface TxExtracted {
  date_operation: string; date_valeur: string; reference: string;
  libelle: string; type: "credit" | "debit"; montant: number;
  categorie: string; compte_comptable: string;
  reference_facture: string | null; confiance: number;
  facture_id: string | null; justificatif_id: string | null; alerte: string | null;
  tiers_nom: string | null; etape_rapprochement: string;
}

interface InfoReleve { banque: string; rib: string; solde_initial: number; solde_final: number; }
interface EditFormTx { date_operation: string; date_valeur: string; reference: string; libelle: string; type: "credit"|"debit"; montant: number; }

// ─── Server function : analyse IA (Mistral) → catégorisation + matching ───────


// ─── Helpers (portés exactement de bank_statement_parser_BP_ATTIJARI_PROPRE.py) ──

const AMOUNT_RE_STR = String.raw`\d{1,3}(?:[\s.]?\d{3})*[,.]\s*\d{2}|\d+[,.]\s*\d{2}`;
const AMOUNT_RE = new RegExp(AMOUNT_RE_STR, 'g');

const OCR_FIXES: Record<string,string> = {
  "C0MMISSI0N":"COMMISSION","C0MMISSION":"COMMISSION","COMMISSI0N":"COMMISSION",
  "S0CIETE":"SOCIETE","D0CUMENT":"DOCUMENT","C0MPTE":"COMPTE",
  "M0NETIQUE":"MONETIQUE","CHE0UE":"CHEQUE","CHE0UES":"CHEQUES",
};

function norm(s: string): string {
  if (!s) return "";
  s = String(s).replace(/[|\[\]{}!]/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

function cleanAmount(s: string): number | null {
  if (!s) return null;
  let v = s.replace(/\xa0/g," ").replace(/O/gi,"0").replace(/[^\d,.\s]/g,"");
  v = v.replace(/\s/g,"");
  if (!v) return null;
  if (v.endsWith(",") || v.endsWith(".")) v += "00";
  if (v.includes(",")) v = v.replace(/\./g,"").replace(",",".");
  const n = parseFloat(v);
  return isNaN(n) || n <= 0 ? null : Math.round(n * 100) / 100;
}

function cleanDateParts(d: string, m: string, y: string): string | null {
  try {
    const dd = parseInt(d.replace(/O/gi,"0"));
    const mm = parseInt(m.replace(/O/gi,"0"));
    const yy = parseInt(y.replace(/O/gi,"0"));
    if (isNaN(dd)||isNaN(mm)||isNaN(yy)) return null;
    return `${String(dd).padStart(2,"0")}/${String(mm).padStart(2,"0")}/${yy}`;
  } catch { return null; }
}

function cleanNatureText(text: string): string {
  if (!text) return "";
  let t = norm(text).toUpperCase();
  for (const [a,b] of Object.entries(OCR_FIXES)) t = t.split(a).join(b);
  t = t.replace(/(?<=[A-Z])0(?=[A-Z])/g, "O");
  return t.replace(/\s+/g," ").trim();
}

// Mots-clés qui forcent DÉBIT — priorité absolue sur looksCredit
function looksDebit(nature: string): boolean {
  const u = (nature||"").toUpperCase();
  return [
    "DROIT DE TIMBRE","TIMBRE FISCAL","REMISE LCN","LETTRE DE CHANGE","LCN",
    "PRELEVEMENT","FRAIS TENUE","FRAIS GESTION","AGIOS","COMMISSION BANCAIRE",
    "PAIEMENT IMPOT","PAIEMENT DGI","PAIEMENT CNSS","VIREMENT EMIS","VIRT EMIS",
  ].some(k => u.includes(k));
}

function looksCredit(nature: string): boolean {
  if (looksDebit(nature)) return false; // débit explicite → jamais crédit
  const u = (nature||"").toUpperCase();
  return [
    "RECU","REÇU","VIR RECU","VIRT RECU","VIREMENT RECU","VIR.WEB RECU","VIR INST RECU",
    "REMISE CHEQUE","REMISE DE CHEQUE","VERSEMENT","DEPOT","ENCAISSEMENT","AVOIR",
    "AVIS DE CREDIT","INTERETS CREDIT","INTERETS CREDITEUR","RECOUVREMENT","CREDIT VIREMENT",
  ].some(k => u.includes(k));
}

// Labels lisibles pour type_document (valeur DB → affichage)
const TYPE_DOC_LABELS: Record<string, string> = {
  recu:"Reçu", facture:"Facture", bon_commande:"Bon de commande",
  bon_livraison:"Bon de livraison", devis:"Devis", note_frais:"Note de frais",
  addition:"Addition", ticket_carburant:"Ticket carburant", avis_debit:"Avis de Débit",
  dum:"DUM / Import", quittance_cnss:"Quittance CNSS", quittance_dgi:"Quittance DGI",
  quittance_eau:"Quittance eau", quittance_elec:"Quittance électricité",
  quittance_loyer:"Quittance loyer", contrat:"Contrat", autre:"Autre",
};
const typeDocLabel = (v: string) => TYPE_DOC_LABELS[v] ?? v;

// ── awb_line_to_tx — porté EXACTEMENT de bank_statement_parser_BP_ATTIJARI_PROPRE.py ──
function awbLineToTx(line: string, year: number): any | null {
  const raw = norm(line).replace(/@/g,"0");
  let pr = raw.replace(/O/g,"0").replace(/o/g,"0");
  pr = pr.replace(/(?<=[A-Z0-9])[lI](?=\d{2}\s+\d{2})/g," ").replace(/\//g," ");

  let m = pr.match(/^(?<code>[A-Z0-9]{6,7})\s*(?<d1>\d{2})\s+(?<m1>\d{2})\s+(?<rest>.+)$/i);
  if (!m) m = pr.match(/^(?<code>[A-Z0-9]{6})(?<d1>\d{2})\s+(?<m1>\d{2})\s+(?<rest>.+)$/i);
  if (!m?.groups) return null;

  const code = m.groups.code.toUpperCase();
  const d1 = m.groups.d1, m1 = m.groups.m1;
  const rest = norm(m.groups.rest);

  const dateMatches = [...rest.matchAll(/(\d{2})\s+(\d{2})\s+(20\d{2})/g)];
  if (!dateMatches.length) return null;
  const dm = dateMatches[dateMatches.length - 1];
  const d2 = dm[1], m2 = dm[2], y2 = dm[3];

  const dmIdx = dm.index!;
  let nature = cleanNatureText(rest.slice(0, dmIdx));
  const tail = norm(rest.slice(dmIdx + dm[0].length));

  // ── Priorité 1 : marqueurs colonne PDF (<D:> / <C:>) — position X pixel ────
  // Ces marqueurs sont insérés par l'extraction PDF.js basée sur la position X
  // réelle des colonnes DÉBIT et CRÉDIT dans le document. C'est la méthode la plus fiable.
  const dTag = rest.match(/<D:([\d\s.,]+)>/);
  const cTag = rest.match(/<C:([\d\s.,]+)>/);
  if (dTag || cTag) {
    // Identifier la colonne VIDE et celle qui porte le montant : une colonne vide
    // peut apparaître comme "0,00", tiret ou absence — cleanAmount renvoie null pour ces cas
    const dAmt = dTag ? cleanAmount(dTag[1]) : null;
    const cAmt = cTag ? cleanAmount(cTag[1]) : null;
    if (dAmt !== null && cAmt !== null)
      console.warn(`[PARSER] débit ET crédit remplis sur la même ligne — débit retenu: "${rest.slice(0,50)}"`);
    const tagAmt = dAmt ?? cAmt;
    if (tagAmt) {
      return {
        ligne: null,
        date_operation: cleanDateParts(d1, m1, String(year)),
        date_valeur: cleanDateParts(d2, m2, y2),
        reference: code,
        libelle: nature || "Transaction",
        _montant: tagAmt,
        _soldeCourant: null,
        _isCr: dAmt === null,
        montant_debit: null,
        montant_credit: null,
      };
    }
    // Marqueurs présents mais colonnes vides → continuer sur la MÊME ligne (priorité 2),
    // jamais sur une autre ligne
  }

  // ── Priorité 2 : extraire montant + solde courant — UNIQUEMENT sur la ligne courante ──
  // Les "0,00" (colonne vide affichée en zéro) sont filtrés pour ne pas décaler la lecture
  let tailAmounts = [...tail.matchAll(new RegExp(AMOUNT_RE_STR,"g"))].map(a => a[0]).filter(a => cleanAmount(a) !== null);
  let amount = tailAmounts.length ? cleanAmount(tailAmounts[0]) : null;
  const soldeCourant = tailAmounts.length >= 2 ? cleanAmount(tailAmounts[tailAmounts.length - 1]) : null;

  if (amount === null) {
    const fallbackAmts = [...rest.replace(/<[DC]:[^>]+>/g,"").matchAll(new RegExp(AMOUNT_RE_STR,"g"))].map(a => a[0]).filter(a => cleanAmount(a) !== null);
    amount = fallbackAmts.length ? cleanAmount(fallbackAmts[0]) : null;
    if (fallbackAmts.length) nature = cleanNatureText(nature.replace(fallbackAmts[0],""));
  }
  if (amount === null) {
    // Montant introuvable sur la ligne courante → transaction ignorée, JAMAIS décalée
    console.warn(`[PARSER] montant introuvable — transaction ignorée: "${rest.slice(0,60)}"`);
    return null;
  }

  return {
    ligne: null,
    date_operation: cleanDateParts(d1, m1, String(year)),
    date_valeur: cleanDateParts(d2, m2, y2),
    reference: code,
    libelle: nature || "Transaction",
    _montant: amount,
    _soldeCourant: soldeCourant,
    _isCr: undefined,
    montant_debit: null,
    montant_credit: null,
  };
}

// ── bp_split_line ─────────────────────────────────────────────────────────────
// Format BP : DD MM YYYY DD MM YYYY [REF] LIBELLE  MONTANT  SOLDE
// Le relevé BP a 3 colonnes numériques : DÉBIT | CRÉDIT | SOLDE.
// Après extraction pdfjs, la colonne vide (débit ou crédit) disparaît, donc :
//   - ligne débit  → 2 montants en fin de ligne : montant_tx | solde
//   - ligne crédit → 2 montants en fin de ligne : montant_tx | solde
// L'avant-dernier montant = montant de la transaction.
// Le dernier montant      = solde courant (utilisé par l'appelant pour détecter la direction).
function bpSplitLine(line: string): any | null {
  const raw = norm(line);

  const m = raw.match(/^(\d{2})\s+(\d{2})\s+(20\d{2})\s+(\d{2})\s+(\d{2})\s+(20\d{2})\s+(.+)$/);
  if (!m) return null;

  const [, d1, m1, y1, d2, m2, y2, rest] = m;
  const date_op  = cleanDateParts(d1, m1, y1);
  const date_val = cleanDateParts(d2, m2, y2);
  if (!date_op || !date_val) return null;

  // Récupérer TOUS les montants avec leur position exacte dans `rest`
  // ── Cas 1 : marqueurs colonnes <D:xxx> ou <C:xxx> insérés par l'extraction PDF ──
  // Direction certaine : vient de la position X dans le PDF (colonne DEBIT ou CREDIT)
  const dTag = rest.match(/<D:([\d\s.,]+)>/);
  const cTag = rest.match(/<C:([\d\s.,]+)>/);
  if (dTag || cTag) {
    // Identifier la colonne VIDE (absente, "0,00", tiret → cleanAmount null) et celle du montant
    const dAmt = dTag ? cleanAmount(dTag[1]) : null;
    const cAmt = cTag ? cleanAmount(cTag[1]) : null;
    if (dAmt !== null && cAmt !== null)
      console.warn(`[PARSER] débit ET crédit remplis sur la même ligne — débit retenu: "${rest.slice(0,50)}"`);
    const montant = dAmt ?? cAmt;
    if (montant) {
      // Libellé = rest sans les tags <D:> et <C:>
      let libelle = rest.replace(/<[DC]:[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      const refM = libelle.match(/^([A-Z0-9]{4,15})\s+(.+)$/i);
      const ref = refM ? refM[1] : '';
      if (refM) libelle = refM[2].trim();
      libelle = cleanNatureText(libelle);
      return {
        ligne: null, date_operation: date_op, date_valeur: date_val,
        reference: ref, libelle: libelle || 'Transaction',
        _montant: montant, _newSolde: null,
        _isCr: dAmt === null,  // direction définitive depuis la colonne PDF non vide
        montant_debit: null, montant_credit: null,
      };
    }
    // Marqueurs présents mais colonnes vides → tenter l'extraction texte sur la MÊME ligne
  }

  // ── Cas 2 : fallback sur avant-dernier montant + delta solde — LIGNE COURANTE uniquement ──
  // Tags vides retirés ; les "0,00" (colonne vide affichée en zéro) sont filtrés
  const rest2 = rest.replace(/<[DC]:[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const amtMatches = [...rest2.matchAll(/\d{1,3}(?:[\s.]?\d{3})*,\d{2}/g)].filter(a => cleanAmount(a[0]) !== null);
  if (!amtMatches.length) {
    // Ligne datée SANS montant lisible → transaction à IGNORER par l'appelant,
    // jamais fusionnée avec la précédente ni complétée par la ligne suivante
    return { _skip: true, date_operation: date_op, date_valeur: date_val,
             montant_debit: null, montant_credit: null, libelle: cleanNatureText(rest2).slice(0, 80) };
  }

  const n = amtMatches.length;
  const txMatch    = n >= 2 ? amtMatches[n - 2] : amtMatches[0];
  const soldeMatch = n >= 2 ? amtMatches[n - 1] : null;

  const montant  = cleanAmount(txMatch[0]);
  if (!montant) return null;
  const newSolde = soldeMatch ? (cleanAmount(soldeMatch[0]) ?? null) : null;

  let libelle = rest2.slice(0, txMatch.index!).trim();
  const refMatch = libelle.match(/^([A-Z0-9]{4,15})\s+(.+)$/i);
  const ref = refMatch ? refMatch[1] : '';
  if (refMatch) libelle = refMatch[2].trim();
  libelle = cleanNatureText(libelle);

  return {
    ligne: null, date_operation: date_op, date_valeur: date_val,
    reference: ref, libelle: libelle || 'Transaction',
    _montant: montant, _newSolde: newSolde,
    _isCr: undefined,
    montant_debit: null, montant_credit: null,
  };
}

// ── awb_soldes — porté EXACTEMENT du Python ──────────────────────────────────────
function awbSoldes(text: string): { solde_initial: number; solde_final: number } {
  const t = norm(text);
  let si = 0, sf = 0;
  const mi = t.match(/SOLDE\s+DEPART\s+AU\s+\d{1,2}\s+\d{1,2}\s+\d{4}\s+(\d{1,3}(?:[\s.]?\d{3})*[,.]\s*\d{2})\s*(CREDITEUR|DEBITEUR)?/i);
  if (mi) { const a = cleanAmount(mi[1])??0; si = (mi[2]||"").toUpperCase().startsWith("DEB") ? -a : a; }
  const mf = t.match(/SOLDE\s+FINAL\s+AU\s+\d{1,2}\s+\d{1,2}\s+\d{4}\s+(\d{1,3}(?:[\s.]?\d{3})*[,.]\s*\d{2})\s*(CREDITEUR|DEBITEUR)?/i);
  if (mf) { const a = cleanAmount(mf[1])??0; sf = (mf[2]||"").toUpperCase().startsWith("DEB") ? -a : a; }
  return { solde_initial: si, solde_final: sf };
}

// ── bp_soldes — porté EXACTEMENT du Python ───────────────────────────────────────
function bpSoldes(text: string): { solde_initial: number; solde_final: number } {
  const t = norm(text);
  let si = 0, sf = 0;
  const miReport = t.match(/SOLDE\s+REPORT\s*[:.=]?\s*(\d{1,3}(?:[\s.]?\d{3})*[,.]\s*\d{2})/i);
  const miAncien = t.match(/ANCIEN\s+SOLDE\s+AU?\s*[:.=]?\s*[\d\/\- ]*?(\d{1,3}(?:[\s.]?\d{3})*[,.]\s*\d{2}|\d+[,.]\s*\d{2})/i);
  if (miReport) si = cleanAmount(miReport[1]) ?? 0;
  else if (miAncien) si = cleanAmount(miAncien[1]) ?? 0;
  const mf = t.match(/SOLDE\s+A\s+REPORTER\s*[:.=]?\s*(\d{1,3}(?:[\s.]?\d{3})*[,.]\s*\d{2}|\d+[,.]\s*\d{2})/i);
  if (mf) sf = cleanAmount(mf[1]) ?? 0;
  return { solde_initial: si, solde_final: sf };
}

// ── PRÉPROCESSEUR : reconstruit les lignes ATW fragmentées par PDF.js ────────────
// PDF.js sépare en colonnes: codes | libellés | dates | montants sur des lignes séparées
// Ce préprocesseur les regroupe AVANT de passer à awbLineToTx
const ATW_CODE_ONLY = /^([A-Z0-9]{5,7})\s+(\d{2})\s+(\d{2})\s*$/;
const ATW_CODE_FULL = /^[A-Z0-9]{5,7}\s+\d{2}\s+\d{2}\s+\S/;
const PURE_DATE_RE  = /^\d{2}\s+\d{2}\s+20\d{2}\s*$/;
const PURE_AMT_RE   = /^\d{1,3}(?:\s\d{3})*,\d{2}\s*$/;

function preprocessATW(lines: string[]): string[] {
  const result: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Ligne complète ATW (code + libellé + date + montant) → passer directement
    if (ATW_CODE_FULL.test(line) && new RegExp(AMOUNT_RE_STR).test(line) && /\d{2}\s+\d{2}\s+20\d{2}/.test(line)) {
      result.push(line); i++; continue;
    }

    // Début d'un bloc de codes fragmentés (code seul sur la ligne)
    if (ATW_CODE_ONLY.test(line)) {
      // Collecter tous les codes fragmentés consécutifs
      const fragCodes: [string,string,string][] = [];
      let j = i;
      while (j < lines.length) {
        const mc = ATW_CODE_ONLY.exec(lines[j]);
        if (mc) { fragCodes.push([mc[1], mc[2], mc[3]]); j++; }
        else break;
      }

      // Collecter libellés, dates, montants des lignes suivantes
      const libelles: string[] = [], dates: string[] = [], montants: string[] = [];
      let k = j;
      while (k < lines.length && !ATW_CODE_ONLY.test(lines[k]) && !ATW_CODE_FULL.test(lines[k])) {
        const ln = lines[k].trim();
        // Frontière de page : ne jamais l'absorber dans un bloc fragmenté
        if (/^#PAGE \d+#$/.test(ln)) break;
        if (PURE_DATE_RE.test(ln))       dates.push(ln);
        // "0,00" = colonne débit/crédit VIDE → ignorer, sinon l'association par index
        // se décale et chaque transaction prend le montant de la suivante
        else if (PURE_AMT_RE.test(ln))   { if (cleanAmount(ln) !== null) montants.push(ln); }
        else if (ln && !/^[\d\s.,:=\-\/]+$/.test(ln)) libelles.push(ln);
        k++;
      }

      // Associer dans l'ordre: code[n] → libelle[n] + date[n] + montant[n] + solde[n]
      // Si chaque tx a 2 montants (tx + solde courant), les indices sont 0,2,4... et 1,3,5...
      const hasDoubleMontants = montants.length >= fragCodes.length * 2;
      if (montants.length !== fragCodes.length && !hasDoubleMontants)
        console.warn(`[PARSER] bloc fragmenté incohérent: ${fragCodes.length} codes / ${montants.length} montants — les transactions sans montant seront ignorées (jamais décalées)`);
      fragCodes.forEach(([code,d1,m1], n) => {
        const lib = libelles[n] ?? "Transaction";
        const dat = dates[n]    ?? `${d1} ${m1} ${new Date().getFullYear()}`;
        const amt   = hasDoubleMontants ? (montants[n * 2] ?? null)     : (montants[n] ?? null);
        const solde = hasDoubleMontants ? (montants[n * 2 + 1] ?? null) : null;
        if (amt) result.push(`${code} ${d1} ${m1} ${lib} ${dat} ${amt}${solde ? ' ' + solde : ''}`);
        else console.warn(`[PARSER] transaction ${code} ${d1}/${m1} sans montant — ignorée`);
      });

      i = k; continue;
    }

    result.push(line); i++;
  }
  return result;
}

// ── Parser principal multi-banques ────────────────────────────────────────────────
const EXCL_LINES = /^(?:CODE|DATE\s+OP|LIBELLE|VALEUR|NATURE|REFERENCE|MONTANT|TOTAL\s+MOUVEMENTS|SOLDE\s+(?:DEPART|FINAL|A\s+REPORTER)|ANCIEN\s+SOLDE|NOUVEAU\s+SOLDE|ATTIJARIWAFA\s+BANK|BANQUE\s+POPULAIRE\s+DU|CIH\s+BANK\s+SA|AGENCE\s*:|PAGE\s+\d|RELEVE\s+D.IDENTITE|EXTRAIT\s+DE\s+COMPTE|NOUS\s+AVONS)/i;

// `headerText` sert UNIQUEMENT à détecter la banque / le RIB / les soldes
// (en-tête présent sur la page 1). Il permet de parser une page ou un segment
// isolé tout en conservant l'identification banque issue de la 1ère page.
function parserRelevePDF(text: string, headerText: string = text): { txs: any[]; info: InfoReleve } {
  const lower = headerText.toLowerCase();
  const mRib = headerText.match(/\b(\d{3})\s+(\d{3})\s+([\d ]{8,20})\s+(\d{2})\b(?=\D)/); const rib = mRib ? `${mRib[1]} ${mRib[2]} ${mRib[3].trim()} ${mRib[4]}` : ""; const codeRib = mRib ? mRib[1] : ""; console.log("[RIB DEBUG] code:", codeRib, "| full:", rib);



  const banque =
    ["101","102","103","104","105","110","115","120","125","130","145","150","155","160","165","170","175","180","185","190","195"].includes(codeRib) ? "Banque Populaire"
    : codeRib === "011" ? "Attijariwafa Bank"
    : codeRib === "230" ? "CIH Bank"
    : codeRib === "013" ? "BMCE Bank of Africa"
    : codeRib === "141" ? "BMCI"
    : codeRib === "022" ? "Société Générale"
    : lower.includes("attijariwafa") ? "Attijariwafa Bank"
    : (lower.includes("banque populaire") || lower.includes("banque centrale populaire")
        || lower.includes("chaabi") || /\bbcp\b/.test(lower) || /\bgbp\b/.test(lower)) ? "Banque Populaire"
    : lower.includes("cih bank") ? "CIH Bank"
    : lower.includes("bmce") || lower.includes("bank of africa") ? "BMCE Bank of Africa"
    : lower.includes("bmci") ? "BMCI"
    : lower.includes("société générale") || lower.includes("societe generale") ? "Société Générale"
    : "Banque";

  const isATW = banque === "Attijariwafa Bank";
  const isCIH = banque === "CIH Bank";

  console.log(`[PARSER] Banque: ${banque} | isATW: ${isATW} | isCIH: ${isCIH} | lignes total: ${text.split(/\r?\n/).length}`);

  // Soldes
  const soldes = isATW ? awbSoldes(headerText) : bpSoldes(headerText);


  const year = new Date().getFullYear();
  const rawLines = text.split(/\r?\n/).map(l => norm(l)).filter(l => l.length > 1 && !EXCL_LINES.test(l));

  let txs: any[] = [];
  let ligneNum = 1;

  if (isATW) {
    // Méthode delta (même logique que BP) :
    // priorité 1 → _soldeCourant extrait de la ligne
    // priorité 2 → mots-clés (fallback uniquement)
    const processedLines = preprocessATW(rawLines);
    let prevSoldeATW: number | null = soldes.solde_initial > 0 ? soldes.solde_initial : null;
    for (const line of processedLines) {
      const pgM = line.match(/^#PAGE (\d+)#/);
      if (pgM) { console.log(`[PARSER PAGE ${pgM[1]}] (ATW) transactions extraites jusqu'ici: ${txs.length}`); continue; }
      const tx = awbLineToTx(line, year);
      if (!tx) continue;
      const sc: number | null = tx._soldeCourant ?? null;
      let isCr: boolean;
      if (tx._isCr !== undefined) {
        // Priorité 1 : colonne PDF (position X pixel) — même fiabilité que BP
        isCr = tx._isCr;
        if (prevSoldeATW !== null) prevSoldeATW = Math.round((prevSoldeATW + (isCr ? tx._montant : -tx._montant)) * 100) / 100;
      } else if (sc !== null && prevSoldeATW !== null && Math.abs(sc - tx._montant) > 0.005) {
        // Priorité 2 : delta solde courant
        isCr = sc > prevSoldeATW + 0.005;
        prevSoldeATW = sc;
      } else {
        // Priorité 3 : mots-clés (fallback uniquement)
        isCr = looksCredit(tx.libelle);
        if (prevSoldeATW !== null) prevSoldeATW = Math.round((prevSoldeATW + (isCr ? tx._montant : -tx._montant)) * 100) / 100;
      }
      tx.montant_debit  = isCr ? null : tx._montant;
      tx.montant_credit = isCr ? tx._montant : null;
      delete tx._montant;
      delete tx._soldeCourant;
      delete tx._isCr;
      tx.ligne = ligneNum++;
      txs.push(tx);
    }
  } else if (isCIH) {
    // CIH: DD/MM/YYYY [REF] LIBELLE MONTANT [SOLDE]
    // Si ≥ 2 montants sur la ligne : avant-dernier = tx, dernier = solde courant
    let prevSoldeCIH: number | null = soldes.solde_initial > 0 ? soldes.solde_initial : null;
    for (const line of rawLines) {
      const pgM = line.match(/^#PAGE (\d+)#/);
      if (pgM) { console.log(`[PARSER PAGE ${pgM[1]}] (CIH) transactions extraites jusqu'ici: ${txs.length}`); continue; }
      const amounts = [...line.matchAll(new RegExp(AMOUNT_RE_STR,"g"))].map(a=>a[0]);
      if (!amounts.length) continue;
      const amount  = amounts.length >= 2 ? cleanAmount(amounts[amounts.length-2]) : cleanAmount(amounts[amounts.length-1]);
      const soldeCIH = amounts.length >= 2 ? cleanAmount(amounts[amounts.length-1]) : null;
      if (!amount) continue;
      const m1 = line.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(.+?)\s+[\d\s]+,\d{2}/);
      if (m1) {
        const [,d,mo,y,nat] = m1;
        const nature = cleanNatureText(nat);
        let isCr: boolean;
        if (soldeCIH !== null && prevSoldeCIH !== null) { isCr = soldeCIH > prevSoldeCIH + 0.005; prevSoldeCIH = soldeCIH; }
        else { isCr = looksCredit(nature); if (prevSoldeCIH !== null) prevSoldeCIH = Math.round((prevSoldeCIH + (isCr ? amount : -amount)) * 100) / 100; }
        txs.push({ ligne:ligneNum++, date_operation:`${d}/${mo}/${y}`, date_valeur:`${d}/${mo}/${y}`, reference:"", libelle:nature||"Transaction", montant_debit:isCr?null:amount, montant_credit:isCr?amount:null });
        continue;
      }
      const m2 = line.match(/^(\d{2})\/(\d{2})\s+(.+?)\s+[\d\s]+,\d{2}/);
      if (m2) {
        const [,d,mo,nat] = m2;
        if (parseInt(d)>31||parseInt(mo)>12) continue;
        const nature = cleanNatureText(nat);
        let isCr: boolean;
        if (soldeCIH !== null && prevSoldeCIH !== null) { isCr = soldeCIH > prevSoldeCIH + 0.005; prevSoldeCIH = soldeCIH; }
        else { isCr = looksCredit(nature); if (prevSoldeCIH !== null) prevSoldeCIH = Math.round((prevSoldeCIH + (isCr ? amount : -amount)) * 100) / 100; }
        txs.push({ ligne:ligneNum++, date_operation:`${d}/${mo}/${year}`, date_valeur:`${d}/${mo}/${year}`, reference:"", libelle:nature||"Transaction", montant_debit:isCr?null:amount, montant_credit:isCr?amount:null });
      }
    }
  } else {
    // BP/BMCE/BMCI: bp_split_line avec accumulation
    // La direction débit/crédit est déterminée par le DELTA DU SOLDE COURANT
    // (méthode fiable à 100% : si newSolde > prevSolde → crédit, sinon débit)
    let current: any = null;
    let prevSolde: number | null = soldes.solde_initial > 0 ? soldes.solde_initial : null;

    const flush = () => {
      if (current && (current.montant_debit != null || current.montant_credit != null)) {
        current.ligne = ligneNum++; txs.push(current);
      }
      current = null;
    };
    const allLines = text.split(/\r?\n/).map(l => norm(l)).filter(l => l.length > 1);
    for (const line of allLines) {
      const pgM = line.match(/^#PAGE (\d+)#/);
      if (pgM) { flush(); console.log(`[PARSER PAGE ${pgM[1]}] (BP) transactions extraites jusqu'ici: ${txs.length}`); continue; }
      if (/^(?:DATE|LIBELLE|NATURE|REFERENCE|MONTANT|TOTAL\s+MOUVEMENTS|ANCIEN\s+SOLDE|SOLDE\s+A\s+REPORTER|RELEVE\s+D|EXTRAIT\s+DE|NOUS\s+AVONS)/i.test(line)) {
        flush(); continue;
      }
      if (/^(?:SOLDE\s+(?:DEPART|FINAL)|ANCIEN\s+SOLDE)/i.test(line)) { flush(); continue; }

      const tx = bpSplitLine(line);
      if (tx?._skip) {
        // Ligne datée sans montant lisible → transaction ignorée, JAMAIS fusionnée
        // avec la précédente ni complétée par la ligne suivante (cause du décalage en cascade)
        flush();
        console.warn(`[PARSER] montant introuvable sur ligne datée — transaction ignorée: "${line.slice(0,60)}"`);
        continue;
      }
      if (tx) {
        flush();
        const newSolde: number | null = tx._newSolde ?? null;
        let isCr: boolean;
        if (tx._isCr !== undefined) {
          // Priorité 1 : colonne PDF détectée (<D:> ou <C:>) — fiable à 100%
          isCr = tx._isCr;
        } else if (newSolde !== null && prevSolde !== null) {
          // Priorité 2 : delta solde courant
          isCr = newSolde > prevSolde + 0.005;
        } else {
          // Priorité 3 : mots-clés (fallback)
          isCr = looksCredit(tx.libelle);
        }
        if (newSolde !== null) prevSolde = newSolde;
        tx.montant_debit  = isCr ? null : tx._montant;
        tx.montant_credit = isCr ? tx._montant : null;
        delete tx._montant;
        delete tx._newSolde;
        delete tx._isCr;
        current = tx;
        continue;
      }

      if (current) {
        // Ligne de continuation (sans dates) : compléter UNIQUEMENT le libellé.
        // Ne JAMAIS récupérer un montant ici — c'était la cause du décalage en
        // cascade sur les relevés multi-pages (montant de la ligne suivante
        // attribué à la transaction courante).
        const amounts = [...line.matchAll(new RegExp(AMOUNT_RE_STR,"g"))].map(a => a[0]);
        let cl = line;
        for (const a of amounts) cl = cl.replace(a,"");
        cl = norm(cl);
        if (cl && !/^[\d\s.,:=\-\/]+$/.test(cl)) current.libelle = (current.libelle + " " + cl).trim();
      }
    }
    flush();
  }

  console.log(`[PARSER] ${banque} | ${txs.length} transactions | SI:${soldes.solde_initial} | SF:${soldes.solde_final}`);
  return { txs, info: { banque, rib, solde_initial: soldes.solde_initial, solde_final: soldes.solde_final } };
}

// PCM_MAP, deriveCategorie, genererLignesBQ → source de vérité unique dans
// @/lib/comptabilite-bq (partagé avec le détail d'un relevé banque.$releveId.tsx).

const CATEGORIES=[
  {value:"encaissement_client",   label:"Encaissement client"},
  {value:"paiement_fournisseur",  label:"Paiement fournisseur (avec facture)"},
  {value:"salaires",              label:"Salaires"},
  {value:"cnss_amo",              label:"CNSS / AMO (hors TVA)"},
  {value:"tva_dgi",               label:"TVA / IR / IS / DGI"},
  {value:"loyers",                label:"Loyer / Location (local nu → TVA 0%)"},
  {value:"eau_electricite",       label:"Eau / Électricité (TVA déductible)"},
  {value:"telecom",               label:"Téléphone / Internet (TVA 20%)"},
  {value:"gasoil",                label:"Gasoil / Carburant (TVA non déduc.)"},
  {value:"assurance",             label:"Assurance (exonérée TVA)"},
  {value:"entretien",             label:"Entretien / Réparation (TVA 20%)"},
  {value:"frais_bancaires",       label:"Frais bancaires (TVA 10%)"},
  {value:"taxe_professionnelle",  label:"Taxe professionnelle"},
  {value:"retrait_especes",       label:"Retrait espèces / GAB (Caisse 5143)"},
  {value:"virement_interne",      label:"Virement interne / Versement (5115)"},
  {value:"interets_crediteurs",   label:"Intérêts créditeurs"},
  {value:"frais_representation",  label:"Restaurant / Réception (TVA non déduc.)"},
  {value:"frais_douane",          label:"Droits de douane / Import"},
  {value:"transport",             label:"Transport marchandises (TVA 14%)"},
  {value:"autre",                 label:"Autre opération"},
];

// ─── Composant ────────────────────────────────────────────────────────────────
function BanquePage() {
  const { dossierId } = Route.useParams();
  const analyserFn = useServerFn(analyserReleveIA);
  const lettrerFn = useServerFn(lettrerDossier);
  // Si une sous-route (détail d'un relevé /banque/$releveId) est active, on lui cède
  // entièrement l'affichage via <Outlet/> (cf. early-return avant le rendu principal).
  const childMatches = useChildMatches();

  const [tab, setTab] = useState<"comptes"|"releves"|"scanner"|"encaissements">("comptes");
  const [comptes, setComptes] = useState<Compte[]>([]);
  const [selectedId, setSelectedId] = useState<string|null>(null);
  const [transactions, setTransactions] = useState<TxBancaire[]>([]);
  const [liaisonTx, setLiaisonTx] = useState<TxBancaire|null>(null);
  const [liaisonStatut, setLiaisonStatut] = useState<"ouvert"|"ferme">("ouvert");
  const [liaisonDocType, setLiaisonDocType] = useState<""|"facture_client"|"facture_fournisseur"|"justificatif">("");
  const [liaisonDocId, setLiaisonDocId] = useState("");
  const [liaisonLibelle, setLiaisonLibelle] = useState("");
  const [liaisonMontant, setLiaisonMontant] = useState(0);
  const [rematchLoading, setRematchLoading] = useState(false);
  const [cloturerLoading, setCloturerLoading] = useState(false);
  const [selectedTxIds, setSelectedTxIds] = useState<Set<string>>(new Set());
  const [releves, setReleves] = useState<Releve[]>([]);
  // Compteurs par relevé (vue v_releves_stats) pour les briques : total / lettrées / orphelines.
  const [releveStats, setReleveStats] = useState<Record<string,{nb_total:number;nb_lettrees:number;nb_orphelines:number;nb_cloturees:number}>>({});
  const [facturesNonPayees, setFacturesNonPayees] = useState<FactureNonPayee[]>([]);
  const [facturesClient, setFacturesClient] = useState<any[]>([]);
  const [facturesFourn, setFacturesFourn] = useState<any[]>([]);
  const [justificatifs, setJustificatifs] = useState<any[]>([]);
  // Versions complètes (y compris payées/rapprochées) — utilisées uniquement pour l'affichage "Document lié"
  const [allFacturesClient, setAllFacturesClient] = useState<any[]>([]);
  const [allFacturesFourn, setAllFacturesFourn] = useState<any[]>([]);
  const [allJustificatifs, setAllJustificatifs] = useState<any[]>([]);
  const [clients, setClients] = useState<any[]>([]);
  const [fournisseurs, setFournisseurs] = useState<any[]>([]);
  const [dossier, setDossier] = useState<any>(null);

  // Scanner état
  const [scanLoading, setScanLoading] = useState(false);
  const [scanStep, setScanStep] = useState<"idle"|"review"|"done">("idle");
  const [releveEnregistre, setReleveEnregistre] = useState(false);
  const [txInsertedIds, setTxInsertedIds] = useState<string[]>([]);
  const [txExtraites, setTxExtraites] = useState<TxExtracted[]>([]);
  const [infoReleve, setInfoReleve] = useState<InfoReleve|null>(null);
  const [releveCompteId, setReleveCompteId] = useState("");
  const [pdfUrl, setPdfUrl] = useState<string|null>(null);
  // Fichier scanné conservé pour upload sécurisé (bucket privé) à l'enregistrement.
  const [releveFile, setReleveFile] = useState<File|null>(null);
  const [remarques, setRemarques] = useState("");
  const [showRemarques, setShowRemarques] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedTx, setSelectedTx] = useState<number|null>(null);
  const [editingTx, setEditingTx] = useState<number|null>(null);
  const [editForm, setEditForm] = useState<EditFormTx|null>(null);

  // Autres modals
  const [openCompte, setOpenCompte] = useState(false);
  const [openEncaissement, setOpenEncaissement] = useState(false);
  const [processing, setProcessing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [formCompte, setFormCompte] = useState({banque:"",intitule:"",rib:"",iban:"",solde_actuel:0});
  const [formEnc, setFormEnc] = useState({
    type:"especes" as "especes"|"cheque", montant:0,
    date_encaissement:new Date().toISOString().slice(0,10),
    reference:"",numero_cheque:"",banque_cheque:"",libelle:"",
    facture_id:"",facture_fournisseur_id:"",
  });

  const load = async () => {
    const [{data:c},{data:r},{data:fc},{data:ff},{data:fo},{data:cl},{data:dos},{data:jus},{data:fcAll},{data:ffAll},{data:jusAll},{data:rstats}]=await Promise.all([
      (supabase.from("comptes_bancaires") as any).select("*").eq("dossier_id",dossierId).order("created_at"),
      (supabase.from("releves_bancaires") as any).select("*").eq("dossier_id",dossierId).order("created_at",{ascending:false}),
      // Non payées → dropdown "Lier un document"
      supabase.from("factures").select("id,numero,montant_ttc,montant_ht,montant_tva,montant_paye,montant_restant,type_facture,date_facture,date_echeance,client_id,mode_reglement,clients(id,nom,ice)").eq("dossier_id",dossierId).eq("statut","conforme").neq("statut_paiement","payee"),
      (supabase.from("factures_fournisseurs") as any).select("id,numero,montant_ttc,montant_ht,montant_tva,montant_paye,montant_restant,date_facture,date_echeance,fournisseur_nom,fournisseur_id,mode_reglement").eq("dossier_id",dossierId).neq("statut_paiement","payee"),
      (supabase.from("fournisseurs") as any).select("id,nom,ice").eq("dossier_id",dossierId),
      supabase.from("clients").select("id,nom,ice").eq("dossier_id",dossierId),
      (supabase.from("dossiers") as any).select("nom_societe,ice,if_fiscal").eq("id",dossierId).single(),
      (supabase.from("justificatifs") as any).select("*").eq("dossier_id",dossierId).eq("statut","non_rapproche"),
      // Toutes (y compris payées) → affichage badge "Document lié"
      supabase.from("factures").select("id,numero,montant_ttc,montant_paye,montant_restant,date_facture,date_echeance,client_id,mode_reglement,clients(id,nom,ice)").eq("dossier_id",dossierId).eq("statut","conforme"),
      (supabase.from("factures_fournisseurs") as any).select("id,numero,montant_ht,montant_tva,montant_ttc,montant_paye,montant_restant,date_facture,date_echeance,fournisseur_nom,fournisseur_id,mode_reglement").eq("dossier_id",dossierId),
      (supabase.from("justificatifs") as any).select("*").eq("dossier_id",dossierId),
      (supabase.from("v_releves_stats") as any).select("*").eq("dossier_id",dossierId),
    ]);
    setComptes((c??[]) as Compte[]);
    setReleves((r??[]) as Releve[]);
    setReleveStats(Object.fromEntries(((rstats??[]) as any[]).map((s:any)=>[s.releve_id,{nb_total:Number(s.nb_total)||0,nb_lettrees:Number(s.nb_lettrees)||0,nb_orphelines:Number(s.nb_orphelines)||0,nb_cloturees:Number(s.nb_cloturees)||0}])));
    setFacturesClient(fc??[]);
    setFacturesFourn(ff??[]);
    // recu + droits_timbre → avis_debit (même normalisation que justificatifs.tsx)
    const normalize=(list:any[])=>list.map((j:any)=>
      j.type_document==="recu"&&j.categorie_pcm==="droits_timbre"?{...j,type_document:"avis_debit"}:j
    );
    setJustificatifs(normalize(jus??[]));
    setAllFacturesClient(fcAll??[]);
    setAllFacturesFourn(ffAll??[]);
    setAllJustificatifs(normalize(jusAll??[]));
    setFournisseurs(fo??[]);
    setClients(cl??[]);
    setDossier((dos as any)??null);
    setFacturesNonPayees([
      ...((fc??[]) as any[]).map((f:any)=>({id:f.id,type:"client" as const,numero:f.numero,nom:(f.clients as any)?.nom??"Client",montant_ttc:Number(f.montant_ttc),date_echeance:f.date_echeance})),
      ...((ff??[]) as any[]).map((f:any)=>({id:f.id,type:"fournisseur" as const,numero:f.numero,nom:f.fournisseur_nom??"Fournisseur",montant_ttc:Number(f.montant_ttc),date_echeance:f.date_echeance})),
    ]);
  };

  const loadTx=async(cid:string)=>{
    const{data}=await (supabase.from("transactions_bancaires") as any).select("*").eq("compte_id",cid).order("date_operation",{ascending:false}).limit(200);
    const rows=(data??[]) as TxBancaire[];
    setTransactions(rows);
    setSelectedTxIds(new Set(rows.map(t=>t.id)));
  };

  useEffect(()=>{load();},[dossierId]);
  useEffect(()=>{if(selectedId){loadTx(selectedId);}},[selectedId]);

  // NB : l'auto-rematch côté client (useEffect au chargement) a été SUPPRIMÉ.
  // Le lettrage est désormais 100 % serveur, déclenché par événements :
  //  • Sens A : après enregistrement d'un relevé (lettrerFn ci-dessous) ;
  //  • Sens B : après upload facture/justificatif (matcherDocumentAvecTransactions) ;
  //  • manuel : bouton « Rematcher » (handleRematcher → lettrerFn).

  const selected=comptes.find(c=>c.id===selectedId);

  // ── SCANNER RELEVÉ ────────────────────────────────────────────────────────
  // Rendu d'une page PDF en 2 MOITIÉS qui se recouvrent (haut + bas).
  // Pourquoi : le modèle vision ancre la lecture des colonnes sur le haut de l'image
  // et la colonne montants « glisse » vers le bas sur les dernières lignes (un montant
  // se retrouve décalé d'un cran, voire dans une ligne fantôme). En coupant la page en
  // deux, la moitié basse redevient le HAUT de sa propre image → le modèle réaligne.
  // Le recouvrement évite de couper une ligne en deux ; les doublons sont dédupliqués
  // côté serveur. Page courte → une seule image (pas de découpe).
  const PDF_RENDER_SCALE=3.5;   // netteté ; baisser si 413/quota
  const PDF_JPEG_QUALITY=0.95;  // ≥ 0.95 pour ne pas sur-compresser le tableau
  const HALF_OVERLAP=0.12;      // recouvrement vertical entre les 2 moitiés (12%)
  const pdfPageToHalves=async(lib:any,ab:ArrayBuffer,pageNum:number):Promise<string[]>=>{
    const pdfDoc=await lib.getDocument({data:ab.slice(0)}).promise;
    const page=await pdfDoc.getPage(pageNum);
    const viewport=page.getViewport({scale:PDF_RENDER_SCALE});
    const full=document.createElement("canvas");
    full.width=viewport.width;
    full.height=viewport.height;
    await page.render({canvasContext:full.getContext("2d")!,viewport}).promise;
    const W=full.width, H=full.height;
    const toB64=(c:HTMLCanvasElement)=>c.toDataURL("image/jpeg",PDF_JPEG_QUALITY).split(",")[1];

    // Page courte → pas de découpe
    if(H<2000) return [toB64(full)];

    const ov=Math.round(H*HALF_OVERLAP);
    const mid=Math.round(H/2);
    const crop=(y0:number,y1:number)=>{
      const c=document.createElement("canvas");
      c.width=W; c.height=y1-y0;
      c.getContext("2d")!.drawImage(full,0,y0,W,y1-y0,0,0,W,y1-y0);
      return toB64(c);
    };
    const top=crop(0,mid+ov);      // haut : 0 → milieu + recouvrement
    const bottom=crop(mid-ov,H);   // bas  : milieu - recouvrement → fin
    return [top,bottom];
  };

  const handleReleveUpload=async(file:File)=>{
    if(!releveCompteId){toast.error("Sélectionnez d'abord un compte bancaire");return;}
    setScanLoading(true);
    setPdfUrl(URL.createObjectURL(file));
    setReleveFile(file);
    try{
      const isImage=file.type.startsWith("image/");
      let txBrutes:any[]=[];
      let info:any={banque:"",rib:"",solde_initial:0,solde_final:0};

      if(isImage){
        // ── Image directe (JPEG/PNG) → Vision IA (même pipeline que PDF) ─────
        toast.info("Image détectée — Vision IA en cours…");
        const base64=await new Promise<string>((res,rej)=>{
          const reader=new FileReader();
          reader.onload=()=>res((reader.result as string).split(",")[1]);
          reader.onerror=rej;
          reader.readAsDataURL(file);
        });
        {
          const r=await extraireTransactionsVision({data:{images:[{base64,mime_type:file.type}]}});
          txBrutes=r.txs;
          if(r.info) info=r.info; // en-tête (banque/RIB/soldes) extrait par Mistral
        }
        toast.success("1 image analysée");
      } else {
        // ── PDF : extraction texte d'abord ────────────────────────────────
        const pdfjsLib=await import("pdfjs-dist");
        pdfjsLib.GlobalWorkerOptions.workerSrc="/pdf.worker.min.mjs";
        const ab=await file.arrayBuffer();
        const pdf=await pdfjsLib.getDocument({data:ab.slice(0)}).promise;
        let fullText="";
        // Texte reconstruit conservé PAR PAGE → détection de qualité individuelle
        const pageTexts:string[]=[];
        // X des colonnes DEBIT/CREDIT persisté entre les pages (en-tête souvent sur page 1 seulement)
        let gDebitX:number|null=null, gCreditX:number|null=null;
        const AMT_ITEM=/^\d[\d\s]*[.,]\d{2}$/;
        for(let i=1;i<=pdf.numPages;i++){
          const page=await pdf.getPage(i);
          const content=await page.getTextContent();
          // CRITIQUE: reconstruction par Y pour vraies lignes, avec marquage colonnes BP
          const items=content.items as any[];

          // Passe 1 : détecter X des en-têtes DEBIT et CREDIT sur cette page
          let debitX: number|null = gDebitX, creditX: number|null = gCreditX;
          for(const item of items){
            const s=item.str.trim().normalize("NFD").replace(/[̀-ͯ]/g,"").toUpperCase().replace(/\s+/g,"");
            const x:number=item.transform[4];
            if(s==="DEBIT"||s==="DEBIT("||s==="DEBITS") debitX=x;
            else if(s==="CREDIT"||s==="CREDIT("||s==="CREDITS") creditX=x;
          }
          if(debitX!==null) gDebitX=debitX;
          if(creditX!==null) gCreditX=creditX;
          console.log(`[PARSER PAGE ${i}/${pdf.numPages}] items: ${items.length} | colonne DEBIT x=${debitX===null?"—":Math.round(debitX)} | colonne CREDIT x=${creditX===null?"—":Math.round(creditX)}`);

          // Passe 2 : construire le texte de CETTE page — si colonnes détectées, marquer montants <D:> ou <C:>
          let pageStr="";

          // Étape A : grouper les items en lignes par proximité Y (tolérance ±3px — logique conservée).
          // Le découpage en lignes reste séquentiel sur l'ordre d'extraction comme avant.
          const lineGroups:any[][]=[];
          let lastY=-1;
          for(const item of items){
            const y=Math.round(item.transform[5]);
            if(lastY===-1||Math.abs(y-lastY)>3) lineGroups.push([]);
            lineGroups[lineGroups.length-1].push(item);
            lastY=y;
          }

          // Étape B : DANS chaque ligne, trier les items par x croissant (gauche → droite)
          // AVANT de concaténer. PDF.js n'extrait pas forcément les items dans l'ordre visuel
          // sur les PDF scannés (CamScanner), ce qui mélangeait colonnes/montants/libellés.
          for(const group of lineGroups){
            group.sort((a:any,b:any)=>a.transform[4]-b.transform[4]);
            let lineText="";
            for(const item of group){
              const x:number=item.transform[4];
              const str=item.str;
              if(debitX!==null&&creditX!==null&&AMT_ITEM.test(str.trim())){
                const dd=Math.abs(x-debitX), dc=Math.abs(x-creditX);
                // Colonne DÉBIT : plus proche du header DEBIT que du header CREDIT, dans un rayon de 90px
                if(dd<90&&dd<=dc)     lineText+=`<D:${str.trim()}> `;
                // Colonne CRÉDIT : plus proche du header CREDIT, dans un rayon de 90px
                else if(dc<90&&dc<dd) lineText+=`<C:${str.trim()}> `;
                else                  lineText+=str+" "; // SOLDE ou autre colonne
              } else {
                lineText+=str+" ";
              }
            }
            if(lineText.trim()) pageStr+=lineText.trimEnd()+"\n";
          }
          pageTexts.push(pageStr);
          // Sentinelle de page — permet à parserRelevePDF de tracer le décalage éventuel
          fullText+=`#PAGE ${i}#\n`+pageStr;

          // Vérification : sur les pages 2+ (souvent corrompues sur CamScanner), tracer
          // le texte reconstruit ligne par ligne APRÈS tri par X.
          if(i>=2){
            const lns=pageStr.split("\n").filter(l=>l.trim());
            console.log(`[PARSER PAGE ${i}] texte reconstruit (trié par X) — ${lns.length} lignes :`);
            lns.forEach((ln,idx)=>console.log(`[PARSER PAGE ${i}] L${String(idx+1).padStart(2,"0")}: ${ln}`));
          }
        }

        // ── PDF → 2 moitiés par page (secours Vision Groq) ───────────────────
        // Chaque page est coupée en 2 moitiés qui se recouvrent (re-ancrage du bas).
        // Toutes les moitiés partent dans un seul appel ; le serveur les traite à la
        // suite puis déduplique le recouvrement.
        // Info de repli : en-tête parsé côté client (utile si Mistral échoue).
        info=parserRelevePDF(fullText).info;

        // ── OPTION PRINCIPALE : Mistral OCR sur le PDF complet (rapide, 1 appel) ──
        const pdfB64=await new Promise<string>((res,rej)=>{
          const r=new FileReader();
          r.onload=()=>res((r.result as string).split(",")[1]);
          r.onerror=rej;
          r.readAsDataURL(file);
        });
        toast.info("OCR Mistral en cours…");
        let vision=await extraireTransactionsVision({data:{images:[],pdf_base64:pdfB64}});

        // ══════════ DEBUG : MARKDOWN OCR BRUT (à copier-coller et m'envoyer) ══════════
        if((vision as any).markdown){
          console.log("%c[MISTRAL OCR] MARKDOWN BRUT ↓↓↓ (copier tout ce bloc)","color:#e11;font-weight:bold;font-size:14px");
          console.log((vision as any).markdown);
          console.log("%c[MISTRAL OCR] FIN MARKDOWN BRUT ↑↑↑","color:#e11;font-weight:bold;font-size:14px");
        }
        // ═════════════════════════════════════════════════════════════════════════════

        // ── SECOURS : rendu page→moitiés + Vision Groq (si Mistral indispo) ──
        if(vision.txs.length===0){
          toast.info(`Conversion des ${pdf.numPages} page(s) en images…`);
          const images:{base64:string;mime_type:string}[]=[];
          for(let p=1;p<=pdf.numPages;p++){
            const halves=await pdfPageToHalves(pdfjsLib,ab,p);
            for(const h of halves) images.push({base64:h,mime_type:"image/jpeg"});
          }
          toast.info("Analyse Vision IA en cours…");
          vision=await extraireTransactionsVision({data:{images}});
        }
        // Si Mistral a tourné (markdown présent), ses soldes FONT FOI — ils sont
        // issus des seules lignes SOLDE du relevé (règle 2). On NE retombe PAS sur
        // le parser client parserRelevePDF, qui prend à tort la 1re transaction
        // comme solde initial. solde_initial = 0 est une valeur VALIDE (relevé sans
        // ligne de solde de départ) : on l'accepte telle quelle (pas de test truthy).
        if((vision as any).markdown && vision.info){
          info.banque = vision.info.banque || info.banque;
          info.rib = vision.info.rib || info.rib;
          info.solde_initial = vision.info.solde_initial; // 0 accepté
          info.solde_final = vision.info.solde_final;     // 0 accepté
        } else if(vision.info){
          if(vision.info.rib) info.rib=vision.info.rib;
          if(vision.info.banque && vision.info.banque!=="Banque (OCR)") info.banque=vision.info.banque;
          if(vision.info.solde_initial) info.solde_initial=vision.info.solde_initial;
          if(vision.info.solde_final) info.solde_final=vision.info.solde_final;
        }
        console.log("[VISION BRUT] sortie avant tout traitement:",JSON.stringify(vision.txs,null,2));
        txBrutes=vision.txs.map((t:any,i:number)=>({...t,ligne:i+1}));
        toast.success(`${pdf.numPages} page${pdf.numPages>1?"s":""} analysée${pdf.numPages>1?"s":""}`);
      } // ferme else(!isImage)

      setInfoReleve(info);

      // ── Contrôle extraction (générique) : liste lisible des transactions ──────
      console.log(`[RELEVE] ${txBrutes.length} transactions extraites (avant catégorisation)`);
      console.table(txBrutes.map((t:any)=>({
        date:t.date_operation, valeur:t.date_valeur, ref:t.reference,
        libelle:(t.libelle||"").slice(0,45),
        debit:t.montant_debit, credit:t.montant_credit,
      })));

      if(txBrutes.length===0){
        toast.error("Aucune transaction détectée — vérifiez la qualité de l'image ou du PDF.");
        setScanLoading(false);return;
      }

      // ── Affichage IMMÉDIAT du tableau (sans attendre la catégorisation IA) ────
      // La catégorisation/matching (analyserFn) prend plusieurs secondes ; on
      // affiche d'abord les transactions extraites avec une catégorie provisoire,
      // puis on enrichit en place une fois l'IA terminée.
      const txProvisoire:TxExtracted[]=txBrutes.map((tx:any)=>({
        date_operation:tx.date_operation, date_valeur:tx.date_valeur,
        reference:tx.reference??"", libelle:tx.libelle??"Transaction",
        type:(tx.montant_credit?"credit":"debit") as "credit"|"debit",
        montant:tx.montant_credit??tx.montant_debit??0,
        categorie:"autre", compte_comptable:"6141",
        reference_facture:null, confiance:0,
        facture_id:null, justificatif_id:null,
        alerte:null, tiers_nom:null, etape_rapprochement:"en_cours",
      }));
      setTxExtraites(txProvisoire);
      setScanStep("review");
      setScanLoading(false);

      toast.info(`${txBrutes.length} transactions extraites — catégorisation IA en cours…`);

      // Analyse IA: catégorisation + matching
      const result=await analyserFn({
        data:{
          transactions_brutes:txBrutes,
          factures_client:facturesClient, factures_fourn:facturesFourn,
          justificatifs,
          clients, fournisseurs,
          dossier_nom:dossier?.nom_societe??"",
          dossier_ice:dossier?.ice??"",
          remarques,
        },
      });

      // Fusionner parser + IA
      const txFinal:TxExtracted[]=txBrutes.map((tx:any,idx:number)=>{
        const a=result.analyses.find((x:any)=>x.i===idx)??result.analyses[idx]??{};
        const cat=a.categorie??"autre";
        const pcm=PCM_MAP[cat]??{code:"6141",tva:0};
        const montant=tx.montant_credit??tx.montant_debit??0;
        const ht=pcm.tva>0?Math.round(montant/(1+pcm.tva/100)*100)/100:montant;
        const tva=pcm.tva>0?Math.round((montant-ht)*100)/100:0;
        return{
          date_operation:tx.date_operation,
          date_valeur:tx.date_valeur,
          reference:tx.reference??"",
          libelle:tx.libelle??"Transaction",
          type:(tx.montant_credit?"credit":"debit") as "credit"|"debit",
          montant:tx.montant_credit??tx.montant_debit??0,
          categorie:cat,
          compte_comptable:a.code_pcm??pcm.code,
          reference_facture:a.facture_num??null,
          confiance:a.confiance??50,
          facture_id:a.facture_id??null,
          justificatif_id:a.justificatif_id??null,
          alerte:a.alerte??null,
          // Frais/intérêts bancaires : le tiers EST la banque du relevé. On force la
          // banque réellement extraite (info.banque) au lieu d'un nom deviné par l'IA
          // (qui mettait à tort « Attijariwafa »). L'EDI hérite ensuite de cette valeur.
          tiers_nom:((cat==="frais_bancaires"||cat==="interets_crediteurs")&&info.banque&&info.banque!=="Banque (OCR)"&&info.banque!=="Banque")
            ? info.banque
            : (a.tiers_nom??null),
          etape_rapprochement:a.etape_rapprochement??"direction",
        };
      });

      // Post-traitement: forcer l'unicité + montant exact pour fournisseurs uniquement
      const usedFacIds = new Set<string>();
      const txFinalUnique = txFinal.map(tx => {
        if (!tx.facture_id) return tx;
        // Vérifier unicité
        if (usedFacIds.has(tx.facture_id)) {
          return { ...tx, facture_id: null, reference_facture: null, alerte: "Facture déjà matchée avec une autre transaction" };
        }
        // Pour factures fournisseurs: vérifier montant exact
        if (tx.type === "debit") {
          const fac = (facturesFourn as any[]).find((f:any) => f.id === tx.facture_id);
          if (fac) {
            const ttc = Number(fac.montant_ttc);
            const restant = Number(fac.montant_restant || fac.montant_ttc);
            const montantOk = Math.abs(tx.montant - ttc) < 1 || Math.abs(tx.montant - restant) < 1;
            if (!montantOk) {
              return { ...tx, facture_id: null, reference_facture: null, alerte: "Montant inexact — vérifiez manuellement" };
            }
          }
        }
        usedFacIds.add(tx.facture_id);
        return tx;
      });

      // Auto-match client-side : transactions sans match → chercher justificatif par libellé + montant
      const usedJustiIds = new Set<string>(txFinalUnique.filter(t=>t.justificatif_id).map(t=>t.justificatif_id!));
      const txFinalMatched = txFinalUnique.map(tx => {
        if (tx.facture_id || tx.justificatif_id) return tx;
        const lib = (tx.libelle||"").toUpperCase();
        const isTimbre = /DROIT\s*DE\s*TIMBRE|TIMBRE\s*FISCAL|REMISE\s*LCN|LETTRE\s*DE\s*CHANGE/.test(lib);
        for (const j of (justificatifs as any[])) {
          if (usedJustiIds.has(j.id)) continue;
          const isAvisDebit = j.type_document === "avis_debit" || j.categorie_pcm === "droits_timbre";
          const amtMatch = Math.abs(Number(j.montant_ttc) - tx.montant) < 1;
          if (isTimbre && isAvisDebit && amtMatch) {
            usedJustiIds.add(j.id);
            return { ...tx, justificatif_id: j.id, categorie: j.categorie_pcm ?? tx.categorie, compte_comptable: j.compte_pcm ?? tx.compte_comptable };
          }
        }
        return tx;
      });

      setTxExtraites(txFinalMatched);
      setScanStep("review");
      const nbMatch=txFinalMatched.filter(t=>t.facture_id||t.justificatif_id).length;
      toast.success(`${txFinalMatched.length} transactions analysées${nbMatch>0?` — ${nbMatch} matchées`:""}`);

    }catch(e:any){toast.error("Erreur: "+e.message);}
    finally{setScanLoading(false);}
  };

  const updateTxExtrait=(idx:number,updates:Partial<TxExtracted & {facture_id_manuel?: string}>)=>{
    setTxExtraites(prev=>prev.map((tx,i)=>{
      if(i!==idx) return tx;
      const updated={...tx,...updates};
      if(updates.categorie){
        const pcm=PCM_MAP[updates.categorie]??{code:"6141",tva:0};
        updated.compte_comptable=pcm.code;
      }
      // Si on choisit manuellement une facture
      if(updates.facture_id !== undefined){
        const fClient=facturesClient.find((f:any)=>f.id===updates.facture_id);
        const fFourn=facturesFourn.find((f:any)=>f.id===updates.facture_id);
        if(fClient){ updated.reference_facture=fClient.numero; updated.categorie="encaissement_client"; updated.compte_comptable="3421"; }
        if(fFourn){ updated.reference_facture=fFourn.numero; updated.categorie="paiement_fournisseur"; updated.compte_comptable="4411"; }
        updated.justificatif_id=null;
      }
      // Si on choisit manuellement un justificatif
      if(updates.justificatif_id !== undefined && updates.justificatif_id !== null){
        const jus=justificatifs.find((j:any)=>j.id===updates.justificatif_id);
        if(jus){
          if(jus.categorie_pcm) updated.categorie=jus.categorie_pcm;
          if(jus.compte_pcm) updated.compte_comptable=jus.compte_pcm;
        }
        updated.facture_id=null;
        updated.reference_facture=null;
      }
      return updated;
    }));
  };

  // ── Étape 1 : enregistrer transactions + mettre à jour solde + paiements ──
  const handleEnregistrerTransactions=async()=>{
    if(!txExtraites.length||!releveCompteId) return;
    setSaving(true);
    try{
      const compte=comptes.find(c=>c.id===releveCompteId);
      let soldeCourant=compte?.solde_actuel??0;

      // Calculer fcPay/ffPay/justiPay pour mise à jour des documents
      const fcPay:string[]=[],ffPay:string[]=[],justiPay:string[]=[];
      for(const tx of txExtraites){
        const isCr=tx.type==="credit";
        let facId=tx.facture_id;
        if(!facId&&isCr){
          const libUp=tx.libelle.toUpperCase();
          const matched=(facturesClient as any[]).find((f:any)=>{
            if(fcPay.includes(f.id)) return false;
            const ttc=Number(f.montant_ttc),restant=Number(f.montant_restant||f.montant_ttc);
            if(Math.abs(tx.montant-ttc)>=1&&Math.abs(tx.montant-restant)>=1) return false;
            const clientNom=(f.clients?.nom||"").toUpperCase();
            if(!clientNom) return true;
            return clientNom.split(/\s+/).filter((w:string)=>w.length>=3).some((w:string)=>libUp.includes(w));
          });
          if(matched) facId=matched.id;
        }
        if(!facId&&!isCr){
          const libUp=tx.libelle.toUpperCase();
          // CHQ sans espace requis : "CHQ12345", "CHEQUE N°", "PAIEMENT CHQ", etc.
          const isChequeTx=libUp.includes("CHEQUE")||libUp.includes("CHQ");
          const matched=(facturesFourn as any[]).find((f:any)=>{
            if(ffPay.includes(f.id)) return false;
            const ttc=Number(f.montant_ttc),restant=Number(f.montant_restant||f.montant_ttc);
            if(Math.abs(tx.montant-ttc)>=1&&Math.abs(tx.montant-restant)>=1) return false;
            const fourn=(f.fournisseur_nom||"").toUpperCase();
            if(!fourn) return true;
            const mr=(f.mode_reglement||"").toLowerCase();
            // Seuls virement et carte sont incompatibles avec un chèque
            if(isChequeTx&&(mr==="virement"||mr==="carte")) return false;
            // Chèque : le nom du fournisseur n'est pas dans le libellé → matcher par date ±60j
            // S'applique quel que soit le mode_reglement de la facture (cheque, lcn, vide, etc.)
            if(isChequeTx){
              try{
                const p=tx.date_operation.split("/");
                const txD=p.length===3?new Date(`${p[2]}-${p[1]}-${p[0]}`):new Date(tx.date_operation);
                const ref=f.date_echeance||f.date_facture;
                if(ref&&!isNaN(txD.getTime())){const diff=Math.abs(txD.getTime()-new Date(ref).getTime())/86400000;return diff<=60;}
              }catch{}
              return true;
            }
            const modeOk=!f.mode_reglement||(libUp.includes(" CB ")&&mr==="carte")||(libUp.includes("VIR")&&mr==="virement")||(!libUp.includes("CHEQUE")&&!libUp.includes(" CB ")&&!libUp.includes("VIR"));
            const words=fourn.split(/\s+/).filter((w:string)=>w.length>=3);
            return words.some((w:string)=>libUp.includes(w))&&modeOk;
          });
          if(matched) facId=matched.id;
        }
        if(facId){
          if(facturesClient.some((f:any)=>f.id===facId)&&isCr) fcPay.push(facId);
          else if(facturesFourn.some((f:any)=>f.id===facId)&&!isCr) ffPay.push(facId);
        }
        if(tx.justificatif_id) justiPay.push(tx.justificatif_id);
      }

      const convertirDate=(d:string):string=>{
        if(!d) return d;
        const p=d.split("/");
        return p.length===3&&p[2].length===4?`${p[2]}-${p[1]}-${p[0]}`:d;
      };

      const txToInsert=txExtraites.map(tx=>{
        const pcm=PCM_MAP[tx.categorie]??{code:"6141",tva:0};
        const isClient=tx.facture_id?(facturesClient as any[]).some((f:any)=>f.id===tx.facture_id):false;
        const isFourn=tx.facture_id?(facturesFourn as any[]).some((f:any)=>f.id===tx.facture_id):false;
        const docType=isClient?"facture_client":isFourn?"facture_fournisseur":tx.justificatif_id?"justificatif":null;
        return {
          compte_id:releveCompteId,dossier_id:dossierId,
          date_operation:convertirDate(tx.date_operation),
          libelle:tx.libelle,
          reference:tx.reference||null,
          type:tx.type,montant:tx.montant,solde_apres:0,
          rapproche:!!(tx.facture_id||tx.justificatif_id),
          statut:(tx.facture_id||tx.justificatif_id)?'ferme':'ouvert',
          categorie:tx.categorie||"autre",
          compte_comptable:pcm.code||"6141",
          facture_id:tx.facture_id||null,
          justificatif_id:tx.justificatif_id||null,
          document_type:docType,
        };
      });

      for(const tx of txToInsert){
        soldeCourant=Math.round((soldeCourant+(tx.type==="credit"?tx.montant:-tx.montant))*100)/100;
        tx.solde_apres=soldeCourant;
      }

      // ── Créer le relevé PARENT d'abord, pour porter releve_id sur les transactions ──
      const periodeDates=txToInsert.map((t:any)=>t.date_operation).filter(Boolean).sort();
      let releveId:string|null=null;
      try{
        const ins=await (supabase.from("releves_bancaires") as any).insert({
          compte_id:releveCompteId, dossier_id:dossierId,
          banque:infoReleve?.banque||compte?.banque||null,
          rib:infoReleve?.rib||null,
          periode_debut:periodeDates[0]||null,
          periode_fin:periodeDates[periodeDates.length-1]||null,
          solde_initial:infoReleve?.solde_initial??compte?.solde_actuel??0,
          solde_final:infoReleve?.solde_final||soldeCourant,
          nombre_transactions:txExtraites.length,
          statut:"actif",
          fichier_nom:releveFile?.name||"relevé importé",
          fichier_type:releveFile?.type||null,
        }).select("id").single();
        if(ins.error) throw ins.error;
        releveId=ins.data?.id??null;
      }catch(e:any){
        // Fallback si les colonnes méta (banque/rib/periode/fichier_type) ne sont pas encore migrées
        console.warn("[RELEVE] création enrichie échouée, fallback minimal:",e?.message??e);
        const fb=await (supabase.from("releves_bancaires") as any).insert({
          compte_id:releveCompteId, dossier_id:dossierId,
          nombre_transactions:txExtraites.length,
          solde_initial:compte?.solde_actuel??0, solde_final:soldeCourant,
          statut:"actif", fichier_nom:releveFile?.name||"relevé importé",
        }).select("id").single();
        releveId=fb.data?.id??null;
      }

      // Upload sécurisé du document scanné (bucket PRIVÉ) + lien au relevé
      if(releveId&&releveFile){
        try{
          const ext=(releveFile.name.split(".").pop()||"pdf").toLowerCase();
          const path=`${dossierId}/${releveId}.${ext}`;
          const{error:upErr}=await supabase.storage.from("releves-bancaires").upload(path,releveFile,{upsert:true,contentType:releveFile.type||undefined});
          if(!upErr) await (supabase.from("releves_bancaires") as any).update({fichier_path:path}).eq("id",releveId);
          else console.warn("[RELEVE] upload fichier échoué:",upErr.message);
        }catch(e:any){console.warn("[RELEVE] upload exception:",e?.message??e);}
      }

      // Porter releve_id sur chaque transaction avant insertion
      if(releveId) txToInsert.forEach((t:any)=>{t.releve_id=releveId;});

      // Tentative complète ; fallback progressif si certaines colonnes ne sont pas encore migrées
      let resInsert = await (supabase.from("transactions_bancaires") as any).insert(txToInsert).select("id");
      if (resInsert.error?.message?.includes('"facture_id"') || resInsert.error?.message?.includes('"justificatif_id"') || resInsert.error?.message?.includes('"document_type"')) {
        // Colonnes document_link pas encore appliquées → retirer facture_id/justificatif_id/document_type
        const txSansDocLink = txToInsert.map(({ facture_id: _fi, justificatif_id: _ji, document_type: _dt, ...rest }: any) => rest);
        resInsert = await (supabase.from("transactions_bancaires") as any).insert(txSansDocLink).select("id");
      }
      if (resInsert.error?.message?.includes('"statut"') || resInsert.error?.message?.includes('"categorie"') || resInsert.error?.code === '42703') {
        const txSansStatut = txToInsert.map(({ statut: _s, categorie: _c, compte_comptable: _cc, facture_id: _fi, justificatif_id: _ji, document_type: _dt, releve_id: _ri, ...rest }: any) => rest);
        resInsert = await (supabase.from("transactions_bancaires") as any).insert(txSansStatut).select("id");
      }
      if (resInsert.error) throw resInsert.error;
      const insertedTx = resInsert.data;
      setTxInsertedIds((insertedTx??[]).map((t:any)=>t.id));
      await (supabase.from("comptes_bancaires") as any).update({solde_actuel:soldeCourant}).eq("id",releveCompteId);

      // Mise à jour statut factures clients
      for(const fid of fcPay){
        const fac=facturesClient.find((f:any)=>f.id===fid);
        const tx=txExtraites.find(t=>t.facture_id===fid);
        const ancienPaye=Number(fac?.montant_paye)||0;
        const txMontant=tx?.montant??0;
        const montantPaye=Math.abs(ancienPaye-txMontant)<1&&fac?.type_facture==="acompte"
          ?txMontant:Math.round((txMontant+ancienPaye)*100)/100;
        const montantTotal=Number(fac?.montant_ttc)||0;
        const estPaye=montantPaye>=montantTotal-0.01;
        await (supabase.from("factures") as any).update({
          statut_paiement:estPaye?"payee":"partielle",
          montant_paye:montantPaye,
          montant_restant:Math.max(0,Math.round((montantTotal-montantPaye)*100)/100),
          date_paiement:new Date().toISOString().slice(0,10),
        }).eq("id",fid);
      }
      for(const fid of ffPay){
        const fac=facturesFourn.find((f:any)=>f.id===fid);
        const tx=txExtraites.find(t=>t.facture_id===fid);
        const ancienPayeF=Number(fac?.montant_paye)||0;
        const txMontantF=tx?.montant??0;
        const montantPaye=Math.round((txMontantF+ancienPayeF)*100)/100;
        const montantTotal=Number(fac?.montant_ttc)||0;
        const estPaye=montantPaye>=montantTotal-0.01;
        await (supabase.from("factures_fournisseurs") as any).update({
          statut_paiement:estPaye?"payee":"partielle",
          montant_paye:montantPaye,
          montant_restant:Math.max(0,Math.round((montantTotal-montantPaye)*100)/100),
          date_paiement:new Date().toISOString().slice(0,10),
        }).eq("id",fid);
      }
      for(const jid of justiPay){
        await (supabase.from("justificatifs") as any).update({statut:"rapproche"}).eq("id",jid);
      }

      // (Le relevé parent a déjà été créé en amont avec son releve_id, ses métadonnées
      //  et le fichier scanné uploadé — plus d'insert ici.)

      const nbFerme=txToInsert.filter(t=>t.statut==='ferme').length;
      const nbOuvert=txToInsert.filter(t=>t.statut==='ouvert').length;
      const nbPay=fcPay.length+ffPay.length;
      toast.success(
        `${txExtraites.length} transactions enregistrées (${nbOuvert} ouvertes, ${nbFerme} fermées)`+
        (nbPay>0?` — ${nbPay} facture(s) payée(s)`:"")
      );

      // Sens A — lettrage continu : confronte les transactions orphelines du dossier
      // aux factures/justificatifs existants (serveur, déterministe + RPC atomique).
      try {
        const lr = await lettrerFn({ data: { dossierId, ...(releveId ? { releveId } : {}) } });
        if (lr.lies > 0) toast.success(`Lettrage automatique : ${lr.lies} transaction(s) liée(s)`);
      } catch (e:any) { console.warn("[LETTRAGE A] échec:", e?.message ?? e); }

      setReleveEnregistre(true);
      load();
      // Rafraîchir immédiatement la liste du compte pour voir les nouvelles transactions
      if (releveCompteId) { setSelectedId(releveCompteId); loadTx(releveCompteId); }
    }catch(e:any){toast.error(e.message);}
    finally{setSaving(false);}
  };

  // ── Étape 2 : clôturer — génère les écritures Sage + verrouille ──────────
  const handleCloturerReleve=async()=>{
    if(!txExtraites.length||!releveEnregistre) return;
    setSaving(true);
    try{
      const ecritures:any[]=[];
      for(const tx of txExtraites){
        const parts=tx.date_operation.split("/");
        const date=parts.length===3&&parts[2].length===4?`${parts[2]}-${parts[1]}-${parts[0]}`:tx.date_operation;
        const justif=tx.justificatif_id?justificatifs.find((j:any)=>j.id===tx.justificatif_id):null;
        for(const l of genererLignesBQ({libelle:tx.libelle,type:tx.type,montant:tx.montant,categorie:tx.categorie,compteComptable:tx.compte_comptable,factureLiee:!!tx.facture_id,justificatif:justif})){
          ecritures.push({dossier_id:dossierId,journal_code:"BQ",compte_numero:l.compte,date_ecriture:date,libelle:l.libelle,debit:l.debit,credit:l.credit,reference_piece:tx.reference_facture||tx.reference,valide:true});
        }
      }

      await supabase.from("ecritures_comptables").insert(ecritures);

      if(txInsertedIds.length){
        await (supabase.from("transactions_bancaires") as any).update({statut:"cloture"}).in("id",txInsertedIds);
      }

      toast.success(`Écritures Sage générées — ${txExtraites.length} transactions clôturées`);
      setScanStep("done");
      load();
      if(releveCompteId){setSelectedId(releveCompteId);loadTx(releveCompteId);}
      else if(selectedId){loadTx(selectedId);}
    }catch(e:any){toast.error(e.message);}
    finally{setSaving(false);}
  };

    // ── Génération EDI DGI — format Relevé de Déduction (ADC082F-15I) ──────────────
  // ── Utilitaires partagés EDI ─────────────────────────────────────────────
  // DATE_PAIE / DATE_FAC doivent être des CHAÎNES strictes « JJ/MM/AAAA » (et non des
  // numéros de série Excel comme 45474). On formate ici en texte zéro-paddé.
  const _toDateStr=(d:string):string=>{
    if(!d) return "";
    let dd:string|undefined,mm:string|undefined,yy:string|undefined;
    if(d.includes("/")){ [dd,mm,yy]=d.split("/"); }
    else if(d.includes("-")){ [yy,mm,dd]=d.split("-"); }
    else return d;
    if(!dd||!mm||!yy) return d;
    return `${dd.padStart(2,"0")}/${mm.padStart(2,"0")}/${yy}`;
  };
  const _toDisplayDate=_toDateStr;
  // ── Détection HT/TVA des frais bancaires — GÉNÉRIQUE, basée sur les COMPTES PCM ──
  // (aucune règle sur le libellé). Pour une transaction de frais (compte 6347), on
  // cherche dans le même lot une transaction de TVA distincte (compte 4456) partageant
  // la même clé de corrélation (référence d'opération) :
  //  • couple trouvé → M_HT = montant du frais, M_TVA = montant de la ligne 4456,
  //    M_TTC = M_HT + M_TVA (la banque édite deux écritures distinctes) ;
  //  • aucun couple → la TVA est incluse dans le montant → montant = TTC,
  //    M_HT = TTC/(1+taux), M_TVA = TTC − M_HT.
  const _refKey=(r?:string|null):string=>(r||"").toUpperCase().replace(/\s+/g,"");
  type FraisLot={compte_comptable?:string|null;categorie?:string|null;reference?:string|null;montant:number};
  const _detailFraisBancaires=(
    fee:{reference?:string|null;libelle?:string|null;montant:number},
    lot:FraisLot[],
    tauxPcm:number,
  ):{ht:number;tva:number;ttc:number;taux:number}=>{
    const key=_refKey(fee.reference);
    const tvaLine=key?lot.find(t=>(t.compte_comptable==="4456"||t.categorie==="tva_dgi")&&_refKey(t.reference)===key):undefined;
    if(tvaLine){
      const ht=Math.abs(Math.round(fee.montant*100)/100);
      const tva=Math.abs(Math.round(tvaLine.montant*100)/100);
      return {ht,tva,ttc:Math.round((ht+tva)*100)/100,taux:ht>0?Math.round(tva/ht*100):tauxPcm};
    }
    const ttc=Math.abs(Math.round(fee.montant*100)/100);
    // Droit de timbre : TVA NON récupérable → pas de division par (1+taux), aucune ligne
    // de TVA. Le montant reste à 100 % sur le compte 6347 (HT = montant, TVA = 0).
    if(/TIMBRE/i.test(fee.libelle||"")) return {ht:ttc,tva:0,ttc,taux:0};
    const t=(tauxPcm||0)/100;
    const ht=t>0?Math.round(ttc/(1+t)*100)/100:ttc;
    return {ht,tva:Math.round((ttc-ht)*100)/100,ttc,taux:tauxPcm};
  };
  // Compte PCM effectif d'une transaction (compte stocké prioritaire, sinon mapping catégorie).
  const _comptePcm=(t:{compte_comptable?:string|null;categorie?:string|null}):string=>
    (t.compte_comptable&&/^\d{3,}$/.test(t.compte_comptable.trim()))?t.compte_comptable.trim():(PCM_MAP[t.categorie||""]?.code??"");
  const _derivePeriode=(dates:string[]):{annee:number,mois:number}=>{
    const mc:Record<number,number>={},yc:Record<number,number>={};
    dates.forEach(d=>{
      const s=d.includes("/")?`${d.split("/")[2]}-${d.split("/")[1]}-${d.split("/")[0]}`:d;
      const dt=new Date(s);
      if(!isNaN(dt.getTime())){
        const m=dt.getMonth()+1,y=dt.getFullYear();
        mc[m]=(mc[m]||0)+1; yc[y]=(yc[y]||0)+1;
      }
    });
    const mois=Number(Object.entries(mc).sort((a,b)=>b[1]-a[1])[0]?.[0]||new Date().getMonth()+1);
    const annee=Number(Object.entries(yc).sort((a,b)=>b[1]-a[1])[0]?.[0]||new Date().getFullYear());
    return {annee,mois};
  };
  const _buildEDISheet=(XLSX:any,dossierInfo:any,annee:number,mois:number,dataRows:any[][],totalHT:number,totalTVA:number,totalTTC:number)=>{
    const ws=XLSX.utils.aoa_to_sheet([
      ["RAISON SOCIAL","",dossierInfo.nom_societe||""],
      ["ID_FISCAL","",(dossierInfo as any).if_fiscal||""],
      ["ANNEE","",annee],
      ["PERIODE(Mois)","",mois,"","","Relevé de déduction"],
      ["REGIME(Encais-1)","",1],
      [],
      ["OR","FACT_NUM","DESIGNATION","M_HT","TVA","M_TTC","IF","LIB_FRSS","ICE_FRS","TAUX","ID_PAIE","DATE_PAIE","DATE_FAC"],
      ...dataRows,
      ["Total","","",Math.round(totalHT*100)/100,Math.round(totalTVA*100)/100,Math.round(totalTTC*100)/100],
    ]);
    ws['!cols']=[{wch:6},{wch:15},{wch:45},{wch:12},{wch:10},{wch:12},{wch:12},{wch:30},{wch:18},{wch:8},{wch:8},{wch:12},{wch:12}];
    // DATE_PAIE (col L) et DATE_FAC (col M) : forcer le type TEXTE « JJ/MM/AAAA »
    // pour qu'Excel ne les réinterprète pas en numéros de série.
    const colL=XLSX.utils.encode_col(11),colM=XLSX.utils.encode_col(12);
    dataRows.forEach((_,i)=>{
      const row=i+8;
      [colL,colM].forEach(c=>{
        const cell=ws[`${c}${row}`];
        if(cell){ cell.t="s"; cell.v=String(cell.v??""); cell.z="@"; }
      });
    });
    return ws;
  };

  const genererEDI=async()=>{
    const COMPTES_TVA_DEDUCTIBLE=["4411","6122","6125","6131","6132","6141","6142","6145","6146","6347"];
    const txEligibles=txExtraites.filter(tx=>{
      if(tx.type!=="debit") return false;
      if(tx.justificatif_id){
        const jus=(allJustificatifs.length?allJustificatifs:justificatifs).find((j:any)=>j.id===tx.justificatif_id);
        if(jus&&jus.eligible_edi===false) return false;
      }
      const code=_comptePcm(tx);
      // Frais bancaires (6347) : éligibles MÊME sans facture (exception générique).
      if(code==="6347") return true;
      // Les lignes de TVA isolées (4456) ne se déclarent jamais seules : leur TVA est
      // rattachée à la ligne de frais corrélée → exclues ici (basé sur le COMPTE, pas le libellé).
      if(code==="4456") return false;
      const pcm=PCM_MAP[tx.categorie]??{code:"6141",tva:0};
      return pcm.tva>0 && COMPTES_TVA_DEDUCTIBLE.includes(code||pcm.code);
    });
    if(!txEligibles.length){ toast.warning("Aucune transaction éligible à la déduction TVA"); return; }

    const dossierInfo=dossier??{nom_societe:"",ice:"",if_fiscal:""};
    const {annee,mois}=_derivePeriode(txEligibles.map(tx=>tx.date_operation));
    const allFF=allFacturesFourn.length?allFacturesFourn:facturesFourn;
    const allFC=allFacturesClient.length?allFacturesClient:facturesClient;
    const allJus=allJustificatifs.length?allJustificatifs:justificatifs;

    const dataRows:any[][]=[];
    let totalHT=0,totalTVA=0,totalTTC=0;

    txEligibles.forEach((tx,i)=>{
      const pcm=PCM_MAP[tx.categorie]??{code:"6141",tva:20};
      const facFourn=tx.facture_id?(allFF as any[]).find((f:any)=>f.id===tx.facture_id):null;
      const facClient=tx.facture_id?(allFC as any[]).find((f:any)=>f.id===tx.facture_id):null;
      const justi=tx.justificatif_id?(allJus as any[]).find((j:any)=>j.id===tx.justificatif_id):null;
      const fourn=facFourn?.fournisseur_id?(fournisseurs as any[]).find((f:any)=>f.id===facFourn.fournisseur_id)
        :facFourn?.fournisseur_nom?(fournisseurs as any[]).find((f:any)=>f.nom===facFourn.fournisseur_nom):null;

      // Montants depuis le document OCR — JAMAIS recalculés depuis le montant bancaire
      const hasDoc = !!(facFourn||facClient||justi);
      // Sans document (frais bancaires 6347) → reconstitution HT/TVA/TTC GÉNÉRIQUE :
      // couple frais(6347)/TVA(4456) corrélé par référence, sinon TVA incluse (TTC).
      const frais = hasDoc ? null : _detailFraisBancaires(tx, txExtraites as FraisLot[], pcm.tva);
      const ht  = facFourn ? Math.round(Number(facFourn.montant_ht )*100)/100
                : facClient ? Math.round(Number(facClient.montant_ht)*100)/100
                : justi     ? Math.round(Number(justi.montant_ht    )*100)/100 : frais!.ht;
      const ttc = facFourn ? Math.round(Number(facFourn.montant_ttc)*100)/100
                : facClient ? Math.round(Number(facClient.montant_ttc)*100)/100
                : justi     ? Math.round(Number(justi.montant_ttc   )*100)/100 : frais!.ttc;
      const tva = facFourn ? Math.round(Number(facFourn.montant_tva)*100)/100
                : facClient ? Math.round(Number(facClient.montant_tva)*100)/100
                : justi     ? Math.round((ttc - ht)*100)/100 : frais!.tva;
      const taux= frais ? frais.taux : ht>0&&tva>0 ? Math.round(tva/ht*100) : justi ? (Number(justi.taux_tva)||pcm.tva) : pcm.tva;

      // FACT_NUM — n° de pièce du document, sinon référence bancaire, sinon « RELEVE »
      const factNum = facFourn?.numero || facClient?.numero || justi?.numero_piece || tx.reference || (frais ? "RELEVE" : "—");
      // LIB_FRSS — nom tiers depuis le document, sinon la banque (frais bancaires)
      const libFrss = facFourn?.fournisseur_nom || fourn?.nom || facClient?.clients?.nom || justi?.nom_tiers || tx.tiers_nom || infoReleve?.banque || "";
      // IF / ICE — depuis le profil fournisseur jointé (if_fiscal et ice existent sur fournisseurs)
      const ifFrss  = fourn?.if_fiscal || "";
      const iceFrss = fourn?.ice || "";

      // DATE_PAIE = date bancaire, DATE_FAC = date d'émission du document
      const datePaie=_toDisplayDate(tx.date_operation);
      const dateFacRaw=facFourn?.date_facture||facClient?.date_facture||justi?.date_document||"";
      const dateFac=dateFacRaw?_toDisplayDate(dateFacRaw):datePaie;

      totalHT+=ht; totalTVA+=tva; totalTTC+=ttc;
      dataRows.push([i+1,factNum,libFrss.slice(0,50)||tx.libelle.slice(0,50),ht,tva,ttc,ifFrss,libFrss,iceFrss,taux,i+1,datePaie,dateFac]);
    });

    const XLSX=await import("xlsx");
    const wb=XLSX.utils.book_new();
    const ws=_buildEDISheet(XLSX,dossierInfo,annee,mois,dataRows,totalHT,totalTVA,totalTTC);
    XLSX.utils.book_append_sheet(wb,ws,"Relevé Déduction");
    XLSX.writeFile(wb,`EDI_DGI_${(dossierInfo.nom_societe||"export").replace(/\s/g,"_")}_${annee}_${String(mois).padStart(2,"0")}.xlsx`);
    toast.success(`EDI DGI — ${txEligibles.length} lignes | HT: ${Math.round(totalHT).toLocaleString("fr-MA")} MAD | TVA: ${Math.round(totalTVA).toLocaleString("fr-MA")} MAD`);
  };


  const genererBilan=()=>{
    const rows=[["Date","Journal","Compte","Libellé","Débit","Crédit","Catégorie","Réf."]];
    for(const tx of txExtraites){
      const justif=tx.justificatif_id?justificatifs.find((j:any)=>j.id===tx.justificatif_id):null;
      for(const l of genererLignesBQ({libelle:tx.libelle,type:tx.type,montant:tx.montant,categorie:tx.categorie,compteComptable:tx.compte_comptable,factureLiee:!!tx.facture_id,justificatif:justif})){
        rows.push([tx.date_operation,"BQ",l.compte,l.libelle,l.debit?String(l.debit):"",l.credit?String(l.credit):"",l.categorie,tx.reference_facture||""]);
      }
    }
    const blob=new Blob(["\uFEFF"+rows.map(r=>r.join(";")).join("\n")],{type:"text/csv;charset=utf-8;"});
    const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=`Bilan_BQ_${new Date().toISOString().slice(0,10)}.csv`;a.click();
    toast.success("Bilan Sage généré");
  };

  const handleSauvegarderLiaison = async () => {
    if (!liaisonTx) return;
    const ferme = liaisonStatut === "ferme";
    // Une transaction déjà clôturée conserve son statut 'cloture' (écritures déjà
    // générées) : le lettrage/délettrage ne fait que swapper le compte via le trigger SQL.
    const statutFinal = liaisonTx.statut === "cloture" ? "cloture" : liaisonStatut;

    // Mise à jour transaction (libellé/montant éditables — corrections OCR)
    const txUpd: any = {
      statut: statutFinal, rapproche: ferme,
      libelle: liaisonLibelle || liaisonTx.libelle,
      montant: liaisonMontant > 0 ? liaisonMontant : liaisonTx.montant,
    };
    if (ferme && liaisonDocType && liaisonDocId) {
      if (liaisonDocType === "facture_client")     { txUpd.facture_id = liaisonDocId; txUpd.document_type = "facture_client"; txUpd.justificatif_id = null; }
      if (liaisonDocType === "facture_fournisseur"){ txUpd.facture_id = liaisonDocId; txUpd.document_type = "facture_fournisseur"; txUpd.justificatif_id = null; }
      if (liaisonDocType === "justificatif")       { txUpd.justificatif_id = liaisonDocId; txUpd.document_type = "justificatif"; txUpd.facture_id = null; }
    } else if (!ferme) {
      txUpd.facture_id = null; txUpd.justificatif_id = null; txUpd.document_type = null;
    }
    await (supabase.from("transactions_bancaires") as any)
      .update(txUpd)
      .eq("id", liaisonTx.id);

    // Détachement (fermé → ouvert) : restituer l'état du document précédemment lié,
    // sinon le justificatif reste "rapproché" en base et disparaît des listes de liaison
    if (!ferme && (liaisonTx.justificatif_id || liaisonTx.facture_id)) {
      if (liaisonTx.justificatif_id) {
        await (supabase.from("justificatifs") as any)
          .update({ statut: "non_rapproche", rapproche: false })
          .eq("id", liaisonTx.justificatif_id);
      } else if (liaisonTx.facture_id) {
        const table = liaisonTx.document_type === "facture_client" ? "factures" : "factures_fournisseurs";
        const { data: fac } = await (supabase.from(table) as any)
          .select("montant_ttc,montant_paye").eq("id", liaisonTx.facture_id).maybeSingle();
        if (fac) {
          const np = Math.max(0, Math.round((Number(fac.montant_paye || 0) - liaisonTx.montant) * 100) / 100);
          const nr = Math.max(0, Math.round((Number(fac.montant_ttc) - np) * 100) / 100);
          await (supabase.from(table) as any).update({
            montant_paye: np, montant_restant: nr,
            statut_paiement: np <= 0.01 ? "non_payee" : nr <= 0.01 ? "payee" : "partielle",
          }).eq("id", liaisonTx.facture_id);
        }
      }
      load();
    }

    // Si un document est sélectionné → mettre à jour le document
    if (ferme && liaisonDocType && liaisonDocId) {
      const mt = txUpd.montant as number;
      if (liaisonDocType === "facture_client") {
        const fac = facturesClient.find((f:any) => f.id === liaisonDocId);
        if (fac) {
          const newPaye = Math.round((Number(fac.montant_paye||0) + mt) * 100) / 100;
          const newRestant = Math.max(0, Math.round((Number(fac.montant_ttc) - newPaye) * 100) / 100);
          await (supabase.from("factures") as any).update({
            montant_paye: newPaye, montant_restant: newRestant,
            statut_paiement: newRestant <= 0.01 ? "payee" : "partielle",
          }).eq("id", liaisonDocId);
        }
      } else if (liaisonDocType === "facture_fournisseur") {
        const fac = facturesFourn.find((f:any) => f.id === liaisonDocId);
        if (fac) {
          const newPaye = Math.round((Number(fac.montant_paye||0) + mt) * 100) / 100;
          const newRestant = Math.max(0, Math.round((Number(fac.montant_ttc) - newPaye) * 100) / 100);
          await (supabase.from("factures_fournisseurs") as any).update({
            montant_paye: newPaye, montant_restant: newRestant,
            statut_paiement: newRestant <= 0.01 ? "payee" : "partielle",
          }).eq("id", liaisonDocId);
        }
      } else if (liaisonDocType === "justificatif") {
        await (supabase.from("justificatifs") as any)
          .update({ statut: "rapproche", rapproche: true })
          .eq("id", liaisonDocId);
      }
      load();
    }

    setTransactions(prev => prev.map(t =>
      t.id === liaisonTx.id ? {
        ...t, statut: statutFinal, rapproche: ferme,
        libelle: txUpd.libelle, montant: txUpd.montant,
        facture_id:      "facture_id"      in txUpd ? txUpd.facture_id      : t.facture_id,
        justificatif_id: "justificatif_id" in txUpd ? txUpd.justificatif_id : t.justificatif_id,
        document_type:   "document_type"   in txUpd ? txUpd.document_type   : t.document_type,
      } : t
    ));
    setLiaisonTx(null);
    setLiaisonDocType("");
    setLiaisonDocId("");
    toast.success(liaisonDocType && liaisonDocId
      ? `Transaction liée au document + statut "${liaisonStatut}"`
      : `Transaction passée en statut "${liaisonStatut}"`
    );
  };

  // ── Clôturer depuis DB (modèle Odoo / Grand Livre continu) ───────────────────
  // Génère une écriture pour TOUTES les transactions sélectionnées non encore
  // clôturées — lettrées (compte tiers/PCM) comme orphelines (compte d'attente
  // 4711/4712). Chaque écriture porte transaction_id → le trigger SQL pourra
  // substituer le compte d'attente lors d'un lettrage tardif.
  const handleCloturerFromDB = async () => {
    if (!selectedId) return;
    const txAcloturer = transactions.filter(t =>
      selectedTxIds.has(t.id) && (t.statut ?? (t.rapproche?"ferme":"ouvert")) !== "cloture"
    );
    if (!txAcloturer.length) { toast.info("Aucune transaction à clôturer dans la sélection"); return; }
    setCloturerLoading(true);
    try {
      const allJus = allJustificatifs.length ? allJustificatifs : justificatifs;
      const ecritures: any[] = [];
      for (const tx of txAcloturer) {
        // Utiliser la catégorie stockée en DB si dispo, sinon dériver du libellé
        const storedCat = (tx as any).categorie as string | undefined;
        const cat = storedCat && PCM_MAP[storedCat]
          ? storedCat
          : deriveCategorie(tx.libelle || "", tx.type as "credit" | "debit").categorie;

        // Normaliser date → YYYY-MM-DD
        const raw = tx.date_operation;
        const p = raw.split("/");
        const date = p.length === 3 && p[2]?.length === 4 ? `${p[2]}-${p[1]}-${p[0]}` : raw;
        const justif = tx.justificatif_id ? allJus.find((j: any) => j.id === tx.justificatif_id) : null;

        for (const l of genererLignesBQ({ libelle: tx.libelle, type: tx.type, montant: tx.montant, categorie: cat, compteComptable: (tx as any).compte_comptable, factureLiee: !!tx.facture_id, justificatif: justif })) {
          ecritures.push({ dossier_id: dossierId, journal_code: "BQ", compte_numero: l.compte, date_ecriture: date, libelle: l.libelle, debit: l.debit, credit: l.credit, valide: true, transaction_id: tx.id });
        }
      }

      await supabase.from("ecritures_comptables").insert(ecritures);
      await (supabase.from("transactions_bancaires") as any)
        .update({ statut: "cloture" })
        .in("id", txAcloturer.map(t => t.id));

      const nbOrphelines = txAcloturer.filter(t => !t.facture_id && !t.justificatif_id).length;
      toast.success(`${txAcloturer.length} transactions clôturées — ${ecritures.length} écritures générées${nbOrphelines ? ` (dont ${nbOrphelines} en compte d'attente 471)` : ""}`);
      loadTx(selectedId);
    } catch (e: any) { toast.error(e.message); }
    finally { setCloturerLoading(false); }
  };

  // ── Re-matcher les transactions sans document lié ─────────────────────────
  // Re-lettrage manuel (bouton « Rematcher ») — délègue désormais 100 % au serveur :
  // server function lettrerDossier (déterministe, batch dossier-wide) + écriture
  // atomique via la RPC lier_transaction. Toute la logique de matching a quitté le
  // client (cf. handleRematcher historique migré vers src/server/lettrage.functions.ts).
  const handleRematcher = async (silent = false) => {
    setRematchLoading(true);
    try {
      const res = await lettrerFn({ data: { dossierId } });
      if (selectedId) await loadTx(selectedId);
      await load();
      if (!silent) {
        if (res.lies > 0) toast.success(`${res.lies} transaction(s) liée(s) à leurs documents`);
        else toast.info("Aucune correspondance trouvée");
      }
    } catch (e: any) { if (!silent) toast.error(e.message); }
    finally { setRematchLoading(false); }
  };

  // ── Générer EDI/Bilan depuis la sélection en base ────────────────────────────
  const genererEDIFromDB = async () => {
    if (!transactions.length) { toast.warning("Aucune transaction chargée — sélectionnez un compte"); return; }

    // Transactions sélectionnées éligibles à la déduction TVA (débit uniquement) :
    //  • avec document lié (facture/justificatif), OU
    //  • frais bancaires (compte 6347) sans document — exception générique, HT/TVA/TTC
    //    reconstitués par corrélation de comptes PCM (6347 ↔ 4456 même référence).
    // Les lignes de TVA isolées (compte 4456) ne se déclarent jamais seules (exclues).
    const COMPTES_TVA_DEDUCTIBLE=["4411","6122","6125","6131","6132","6141","6142","6145","6146","6347"];
    const txEligibles = transactions.filter(tx => {
      if (!selectedTxIds.has(tx.id) || tx.type !== "debit") return false;
      const code=_comptePcm(tx as any);
      if (tx.facture_id || tx.justificatif_id) return code!=="4456";
      if (code==="6347") return true;
      if (code==="4456") return false;
      const pcm = PCM_MAP[(tx as any).categorie] ?? null;
      return !!pcm && pcm.tva > 0 && COMPTES_TVA_DEDUCTIBLE.includes(code||pcm.code);
    });
    if (!txEligibles.length) { toast.warning("Aucune transaction éligible (document lié ou frais bancaires)"); return; }

    // Charger les documents liés — colonnes réelles de chaque table
    const ffIds=[...new Set(txEligibles.filter(t=>t.document_type==="facture_fournisseur"&&t.facture_id).map(t=>t.facture_id as string))];
    const jIds=[...new Set(txEligibles.filter(t=>t.document_type==="justificatif"&&t.justificatif_id).map(t=>t.justificatif_id as string))];

    const [ffRes,jRes]=await Promise.all([
      // JOIN inline fournisseurs pour récupérer if_fiscal et ice (pas sur factures_fournisseurs)
      ffIds.length
        ?(supabase as any).from("factures_fournisseurs")
          .select("id,numero,montant_ht,montant_tva,montant_ttc,date_facture,fournisseur_nom,fournisseur_id,fournisseurs(id,nom,ice,if_fiscal)")
          .in("id",ffIds)
        :{data:[]},
      // justificatifs : numero_piece est le champ ref, pas de if_tiers/ice_tiers
      jIds.length
        ?(supabase as any).from("justificatifs")
          .select("id,numero_piece,montant_ht,montant_ttc,taux_tva,nom_tiers,date_document,type_document")
          .in("id",jIds)
        :{data:[]},
    ]);
    const ffMap:Record<string,any>=Object.fromEntries((ffRes.data||[]).map((f:any)=>[f.id,f]));
    const jMap:Record<string,any>=Object.fromEntries((jRes.data||[]).map((j:any)=>[j.id,j]));

    // Fournisseurs par nom pour les justificatifs sans fournisseur_id
    const foByNom:Record<string,any>={};
    (fournisseurs as any[]).forEach((f:any)=>{if(f.nom) foByNom[f.nom.toLowerCase().trim()]=f;});

    const dossierInfo=dossier??{nom_societe:"",ice:"",if_fiscal:""};
    const {annee,mois}=_derivePeriode(txEligibles.map(tx=>tx.date_operation));

    const dataRows:any[][]=[];
    let totalHT=0,totalTVA=0,totalTTC=0;

    txEligibles.forEach((tx,i)=>{
      const ff=tx.document_type==="facture_fournisseur"?ffMap[tx.facture_id as string]:null;
      const jus=tx.document_type==="justificatif"?jMap[tx.justificatif_id as string]:null;

      // Fournisseur jointé via facture_fournisseur.fournisseurs (relation FK)
      // ou recherché par nom pour les justificatifs
      const fourn:any=ff?.fournisseurs||(jus?.nom_tiers?foByNom[jus.nom_tiers.toLowerCase().trim()]:null);

      // ── M_HT / TVA / M_TTC ──
      // Document lié → montants OCR. Sans document (frais bancaires 6347) → reconstitution
      // GÉNÉRIQUE par corrélation de comptes PCM (6347 ↔ 4456 même référence), sinon TTC.
      const pcm = PCM_MAP[(tx as any).categorie] ?? {code:"6347",tva:10};
      const frais = (!ff && !jus) ? _detailFraisBancaires(tx as any, transactions as any as FraisLot[], pcm.tva) : null;
      const ht  = ff ? Math.round(Number(ff.montant_ht )*100)/100
                     : jus ? Math.round(Number(jus.montant_ht)*100)/100 : frais!.ht;
      const ttc = ff ? Math.round(Number(ff.montant_ttc)*100)/100
                     : jus ? Math.round(Number(jus.montant_ttc)*100)/100 : frais!.ttc;
      const tva = ff ? Math.round(Number(ff.montant_tva)*100)/100
                     : jus ? Math.round((ttc-ht)*100)/100 : frais!.tva;
      const taux= frais ? frais.taux
                     : ff ? (ht>0&&tva>0?Math.round(tva/ht*100):20)
                     : jus ? (Number(jus.taux_tva)||20) : pcm.tva;

      // ── FACT_NUM — n° de pièce, sinon référence bancaire, sinon « RELEVE » ──
      const factNum = ff?.numero || jus?.numero_piece || (tx as any).reference || (frais ? "RELEVE" : "—");

      // ── LIB_FRSS / IF / ICE — fournisseur jointé, sinon la banque du compte (frais) ──
      const libFrss = ff?.fournisseur_nom || fourn?.nom || jus?.nom_tiers || (frais ? (selected?.banque||"") : "");
      const ifFrss  = fourn?.if_fiscal || "";
      const iceFrss = fourn?.ice || "";

      // ── Dates ──
      const datePaie  = _toDisplayDate(tx.date_operation);
      const dateFacRaw= ff?.date_facture || jus?.date_document || "";
      const dateFac   = dateFacRaw ? _toDisplayDate(dateFacRaw) : datePaie;

      totalHT+=ht; totalTVA+=tva; totalTTC+=ttc;
      dataRows.push([i+1,factNum,libFrss.slice(0,50)||tx.libelle.slice(0,50),ht,tva,ttc,ifFrss,libFrss,iceFrss,taux,i+1,datePaie,dateFac]);
    });

    const XLSX=await import("xlsx");
    const wb=XLSX.utils.book_new();
    const ws=_buildEDISheet(XLSX,dossierInfo,annee,mois,dataRows,totalHT,totalTVA,totalTTC);
    XLSX.utils.book_append_sheet(wb,ws,"Relevé Déduction");
    XLSX.writeFile(wb,`EDI_DGI_${(dossierInfo.nom_societe||"export").replace(/\s/g,"_")}_${annee}_${String(mois).padStart(2,"0")}.xlsx`);
    toast.success(`EDI DGI — ${txEligibles.length} lignes | HT: ${Math.round(totalHT).toLocaleString("fr-MA")} | TVA: ${Math.round(totalTVA).toLocaleString("fr-MA")} MAD`);
  };

  const genererBilanFromDB = () => {
    if (!transactions.length) { toast.warning("Aucune transaction chargée — sélectionnez un compte"); return; }
    const txSel = transactions.filter(t=>selectedTxIds.has(t.id));
    const allJus = allJustificatifs.length ? allJustificatifs : justificatifs;
    const rows=[["Date","Journal","Compte","Libellé","Débit","Crédit","Catégorie"]];
    for (const tx of txSel) {
      const storedCat=(tx as any).categorie as string|undefined;
      const cat=storedCat&&PCM_MAP[storedCat]?storedCat:deriveCategorie(tx.libelle||"", tx.type as "credit"|"debit").categorie;
      const d=tx.date_operation.includes("-")?tx.date_operation.split("-").reverse().join("/"):tx.date_operation;
      const justif=tx.justificatif_id?allJus.find((j:any)=>j.id===tx.justificatif_id):null;
      for(const l of genererLignesBQ({libelle:(tx.libelle||"").slice(0,80),type:tx.type,montant:tx.montant,categorie:cat,compteComptable:(tx as any).compte_comptable,factureLiee:!!tx.facture_id,justificatif:justif})){
        rows.push([d,"BQ",l.compte,l.libelle,l.debit?String(l.debit):"",l.credit?String(l.credit):"",l.categorie]);
      }
    }
    const blob=new Blob(["﻿"+rows.map(r=>r.join(";")).join("\n")],{type:"text/csv;charset=utf-8;"});
    const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=`Bilan_BQ_${selected?.intitule?.replace(/\s/g,"_")||"compte"}_${new Date().toISOString().slice(0,10)}.csv`;a.click();
    toast.success(`Bilan Sage (DB) — ${txSel.length} transactions exportées`);
  };

  const resetScan=()=>{setScanStep("idle");setTxExtraites([]);setInfoReleve(null);setPdfUrl(null);setReleveFile(null);setSelectedTx(null);setReleveEnregistre(false);setTxInsertedIds([]);};

  // ── Encaissement (code original préservé) ─────────────────────────────────
  const handleEncaissement=async()=>{
    if(!formEnc.montant||!formEnc.date_encaissement) return toast.error("Montant et date requis");
    setProcessing(true);
    try{
      const{error}=await (supabase as any).from("encaissements").insert({
        dossier_id:dossierId,type:formEnc.type,montant:formEnc.montant,
        date_encaissement:formEnc.date_encaissement,reference:formEnc.reference||null,
        numero_cheque:formEnc.numero_cheque||null,banque_cheque:formEnc.banque_cheque||null,
        libelle:formEnc.libelle||null,facture_id:formEnc.facture_id||null,
        facture_fournisseur_id:formEnc.facture_fournisseur_id||null,valide:true,
      });
      if(error) throw error;
      const journalCode=formEnc.type==="especes"?"CAI":"BQ";
      const compteDebit=formEnc.type==="especes"?"5143":"5141";
      const compteContre=formEnc.facture_id?"3421":formEnc.facture_fournisseur_id?"4411":"7111";
      await supabase.from("ecritures_comptables").insert([
        {dossier_id:dossierId,journal_code:journalCode,compte_numero:compteDebit,date_ecriture:formEnc.date_encaissement,libelle:formEnc.libelle||`Encaissement ${formEnc.type}`,debit:formEnc.montant,credit:0,reference_piece:formEnc.reference||null,valide:true},
        {dossier_id:dossierId,journal_code:journalCode,compte_numero:compteContre,date_ecriture:formEnc.date_encaissement,libelle:formEnc.libelle||"Règlement",debit:0,credit:formEnc.montant,reference_piece:formEnc.reference||null,valide:true},
      ]);
      if(formEnc.facture_id) await (supabase.from("factures") as any).update({statut_paiement:"payee",date_paiement:formEnc.date_encaissement}).eq("id",formEnc.facture_id);
      if(formEnc.facture_fournisseur_id) await (supabase as any).from("factures_fournisseurs").update({statut_paiement:"payee",date_paiement:formEnc.date_encaissement}).eq("id",formEnc.facture_fournisseur_id);
      toast.success("Encaissement enregistré + écriture créée");
      setOpenEncaissement(false);
      setFormEnc({type:"especes",montant:0,date_encaissement:new Date().toISOString().slice(0,10),reference:"",numero_cheque:"",banque_cheque:"",libelle:"",facture_id:"",facture_fournisseur_id:""});
      load();
    }catch(e:any){toast.error(e.message);}
    finally{setProcessing(false);}
  };

  const confColor=(c:number)=>c>=90?"text-green-600":c>=70?"text-yellow-500":"text-red-500";
  const getCatLabel=(v:string)=>CATEGORIES.find(c=>c.value===v)?.label??v;
  const totalCr=txExtraites.reduce((s,t)=>s+(t.type==="credit"?t.montant:0),0);
  const totalDb=txExtraites.reduce((s,t)=>s+(t.type==="debit"?t.montant:0),0);
  const nbMatch=txExtraites.filter(t=>t.facture_id).length;
  // ── Solde final : NOTRE calcul numérique (pas le « solde à reporter » du PDF) ──
  // Le PDF Banque Populaire affiche un « SOLDE A REPORTER » EN VALEUR ABSOLUE (sans
  // signe) : le compte peut être créditeur (+) ou débiteur (−). Ce montant scanné
  // ne sert QU'À VÉRIFIER le scan via l'identité :
  //     Total Crédit − Total Débit − Solde Initial = ± Solde à reporter
  // Le champ « Solde final » affiché est reconstruit numériquement à partir des
  // transactions, en retenant la convention de signe dont la valeur absolue colle
  // au solde à reporter scanné (créditeur : SI+CR−DB ; débiteur : CR−DB−SI).
  const si=infoReleve?.solde_initial??0;
  const soldeReporterScanne=infoReleve?.solde_final??0; // « SOLDE A REPORTER » lu sur le PDF (valeur absolue) — vérification uniquement
  const flux=Math.round((totalCr-totalDb)*100)/100;     // Σ crédits − Σ débits
  const finalCrediteur=Math.round((si+flux)*100)/100;   // SI créditeur (+SI)
  const finalDebiteur=Math.round((-si+flux)*100)/100;   // SI débiteur (−SI) ⇒ CR−DB−SI
  const ecartCred=Math.abs(Math.abs(finalCrediteur)-soldeReporterScanne);
  const ecartDeb=Math.abs(Math.abs(finalDebiteur)-soldeReporterScanne);
  const estDebiteur=si>0&&soldeReporterScanne>0&&ecartDeb<ecartCred;
  const soldeFinalCalcule=estDebiteur?finalDebiteur:finalCrediteur;
  const soldeEcart=soldeReporterScanne!==0?(estDebiteur?ecartDeb:ecartCred):0;

  // Sous-route détail active (/banque/$releveId) → on rend uniquement l'Outlet.
  if (childMatches.length > 0) return <Outlet />;

  // ── Briques de relevés (vue par lots — remplace la liste plate de transactions) ──
  const STATUT_BRIQUE: Record<string,{label:string;cls:string}> = {
    brouillon:{label:"Brouillon",cls:"bg-yellow-100 text-yellow-700"},
    actif:{label:"Actif",cls:"bg-blue-100 text-blue-700"},
    cloture:{label:"Clôturé",cls:"bg-gray-200 text-gray-600"},
  };
  const renderBriques = (list: Releve[]) => (
    list.length===0
      ? <Card><CardContent className="py-12 text-center text-muted-foreground"><FileText className="h-10 w-10 mx-auto mb-2 opacity-30"/><p>Aucun relevé — importez-en un via l'onglet « Scanner relevé »</p></CardContent></Card>
      : <div className="space-y-2">
          {list.map(r=>{
            const st=releveStats[r.id]??{nb_total:r.nombre_transactions||0,nb_lettrees:0,nb_orphelines:0,nb_cloturees:0};
            const badge=STATUT_BRIQUE[r.statut]??{label:r.statut,cls:"bg-muted text-foreground"};
            return (
              <Link key={r.id} to="/dossiers/$dossierId/banque/$releveId" params={{dossierId,releveId:r.id}} className="block">
                <Card className="hover:shadow-md transition-shadow cursor-pointer">
                  <CardContent className="py-3 flex items-center gap-4">
                    <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0"><FileText className="h-5 w-5 text-primary"/></div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-semibold truncate">{r.banque||"Relevé"} — {r.fichier_nom||"document"}</p>
                        <Badge className={`text-[10px] ${badge.cls}`}>{badge.label}</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground truncate">{r.periode_debut??"?"} → {r.periode_fin??"?"} · {comptes.find(c=>c.id===r.compte_id)?.intitule??""}</p>
                    </div>
                    <div className="hidden md:flex flex-col items-end text-xs shrink-0">
                      <span className="text-muted-foreground">Solde final</span>
                      <span className="font-mono font-semibold">{fmt(Number(r.solde_final))}</span>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <Badge variant="outline" className="text-[10px]">{st.nb_total} tx</Badge>
                      <Badge className="text-[10px] bg-green-100 text-green-700">{st.nb_lettrees} lettrées</Badge>
                      {st.nb_orphelines>0&&<Badge className="text-[10px] bg-orange-100 text-orange-700">{st.nb_orphelines} ⚠</Badge>}
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0"/>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
  );

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">Banque & Trésorerie</h1>
          <p className="text-muted-foreground mt-1">Relevés bancaires · Rapprochement auto · Encaissements espèces/chèques</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={()=>setOpenEncaissement(true)}>
            <FileText className="h-4 w-4 mr-2"/>Encaissement espèces/chèque
          </Button>
          <Button onClick={()=>setOpenCompte(true)}>
            <Plus className="h-4 w-4 mr-2"/>Compte bancaire
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={v=>setTab(v as any)}>
        <TabsList>
          <TabsTrigger value="comptes">Comptes ({comptes.length})</TabsTrigger>
          <TabsTrigger value="releves">Relevés importés ({releves.length})</TabsTrigger>
          <TabsTrigger value="scanner">
            📄 Scanner relevé
            {facturesNonPayees.length>0&&<span className="ml-2 bg-orange-500 text-white text-xs px-1.5 py-0.5 rounded-full">{facturesNonPayees.length}</span>}
          </TabsTrigger>
          <TabsTrigger value="encaissements">Encaissements espèces/chèques</TabsTrigger>
        </TabsList>

        {/* ── COMPTES ── */}
        <TabsContent value="comptes" className="mt-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            {comptes.length===0?(
              <Card className="col-span-3"><CardContent className="py-12 text-center text-muted-foreground">
                <Landmark className="h-10 w-10 mx-auto mb-2 opacity-30"/>
                <p>Aucun compte bancaire — créez-en un</p>
              </CardContent></Card>
            ):comptes.map(c=>(
              <Card key={c.id} className={`cursor-pointer transition-all ${selectedId===c.id?"ring-2 ring-primary":"hover:shadow-md"}`}
                onClick={()=>setSelectedId(c.id===selectedId?null:c.id)}>
                <CardContent className="pt-5 pb-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium text-muted-foreground">{c.banque}</span>
                    <Landmark className="h-4 w-4 text-muted-foreground"/>
                  </div>
                  <p className="font-semibold">{c.intitule}</p>
                  <p className="font-mono text-xs text-muted-foreground mt-1">{c.rib}</p>
                  <p className={`text-2xl font-bold mt-3 ${c.solde_actuel>=0?"text-green-600":"text-red-600"}`}>{fmt(c.solde_actuel)}</p>
                </CardContent>
              </Card>
            ))}
          </div>
          {selectedId&&(
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-semibold">Relevés — {selected?.intitule}</h2>
              <Button size="sm" onClick={()=>{setReleveCompteId(selectedId);setTab("scanner");}}>
                <Upload className="h-3 w-3 mr-1"/>Importer relevé
              </Button>
            </div>
          )}
          {selectedId&&renderBriques(releves.filter(r=>r.compte_id===selectedId))}
          {/* Vue plate héritée désactivée — remplacée par les briques + sous-route détail (nettoyage complet à suivre). */}
          {false&&selectedId&&(
            <>
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-semibold">Transactions — {selected?.intitule}</h2>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={genererBilanFromDB} title="Exporter les transactions du compte en CSV Sage">
                    <Download className="h-3 w-3 mr-1"/>Bilan Sage
                  </Button>
                  <Button size="sm" variant="outline" onClick={genererEDIFromDB} title="Générer EDI DGI TVA depuis les transactions en base">
                    <FileText className="h-3 w-3 mr-1"/>EDI DGI
                  </Button>
                  <Button size="sm" variant="outline" onClick={handleRematcher} disabled={rematchLoading}>
                    {rematchLoading?<Loader2 className="h-3 w-3 mr-1 animate-spin"/>:<RefreshCw className="h-3 w-3 mr-1"/>}
                    Re-matcher
                  </Button>
                  <Button size="sm" onClick={handleCloturerFromDB} disabled={cloturerLoading}
                    className="bg-orange-600 hover:bg-orange-700 text-white"
                    title="Génère les écritures Sage pour les transactions sélectionnées Fermées et les verrouille">
                    {cloturerLoading?<Loader2 className="h-3 w-3 mr-1 animate-spin"/>:<CheckCircle className="h-3 w-3 mr-1"/>}
                    Clôturer la sélection
                  </Button>
                  <Button size="sm" onClick={()=>{setReleveCompteId(selectedId);setTab("scanner");}}>
                    <Upload className="h-3 w-3 mr-1"/>Importer relevé
                  </Button>
                </div>
              </div>
              {transactions.length>0&&(
                <p className="text-xs text-muted-foreground mb-1">{selectedTxIds.size}/{transactions.length} sélectionnée(s) — EDI, Bilan et Clôturer agissent sur la sélection</p>
              )}
              <Card><CardContent className="p-0">
                <Table>
                  <TableHeader><TableRow>
                    <TableHead className="w-8 px-2">
                      <input type="checkbox"
                        checked={transactions.length>0&&selectedTxIds.size===transactions.length}
                        onChange={e=>setSelectedTxIds(e.target.checked?new Set(transactions.map(t=>t.id)):new Set())}
                        className="cursor-pointer"
                      />
                    </TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Libellé</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Montant</TableHead>
                    <TableHead>Statut</TableHead>
                    <TableHead>Document lié</TableHead>
                    <TableHead></TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {transactions.length===0
                      ?<TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">Importez un relevé dans l'onglet "Scanner relevé"</TableCell></TableRow>
                      :transactions.map(t=>{
                        const st = t.statut ?? (t.rapproche ? "ferme" : "ouvert");
                        const facClient  = t.facture_id && t.document_type==="facture_client"      ? (allFacturesClient as any[]).find(f=>f.id===t.facture_id) : null;
                        const facFourn   = t.facture_id && t.document_type==="facture_fournisseur" ? (allFacturesFourn as any[]).find(f=>f.id===t.facture_id) : null;
                        const justi      = t.justificatif_id ? (allJustificatifs as any[]).find(j=>j.id===t.justificatif_id) : null;
                        const hasDoc     = !!(facClient||facFourn||justi);
                        return (
                        <TableRow key={t.id} className={selectedTxIds.has(t.id)?"":"opacity-50"}>
                          <TableCell className="px-2">
                            <input type="checkbox" checked={selectedTxIds.has(t.id)}
                              onChange={e=>{const s=new Set(selectedTxIds);e.target.checked?s.add(t.id):s.delete(t.id);setSelectedTxIds(s);}}
                              className="cursor-pointer"
                            />
                          </TableCell>
                          <TableCell className="text-sm whitespace-nowrap">{new Date(t.date_operation).toLocaleDateString("fr-MA")}</TableCell>
                          <TableCell className="text-sm max-w-[200px] truncate">{t.libelle}</TableCell>
                          <TableCell>
                            <Badge className={t.type==="credit"?"bg-green-100 text-green-700":"bg-red-100 text-red-700"}>
                              {t.type==="credit"?<TrendingUp className="h-3 w-3 mr-1"/>:<TrendingDown className="h-3 w-3 mr-1"/>}{t.type}
                            </Badge>
                          </TableCell>
                          <TableCell className={`text-right font-mono text-sm whitespace-nowrap ${t.type==="credit"?"text-green-600":"text-red-600"}`}>
                            {t.type==="credit"?"+":"-"}{fmt(t.montant)}
                          </TableCell>
                          <TableCell>
                            {st==="cloture"
                              ?<Badge className="bg-gray-100 text-gray-600 text-xs">🔒 Clôturé</Badge>
                              :st==="ferme"
                              ?<Badge className="bg-green-100 text-green-700 text-xs">🟢 Fermé</Badge>
                              :<Badge className="bg-yellow-100 text-yellow-700 text-xs">🟡 Ouvert</Badge>
                            }
                          </TableCell>
                          {/* ── Colonne Document lié ── */}
                          <TableCell className="min-w-[220px]">
                            {facClient&&(
                              <span className="text-xs font-medium text-green-700 bg-green-50 rounded px-2 py-0.5">
                                📤 {facClient.numero||facClient.id.slice(0,8)} — {facClient.clients?.nom||"Client"}
                              </span>
                            )}
                            {facFourn&&(
                              <span className="text-xs font-medium text-green-700 bg-green-50 rounded px-2 py-0.5">
                                📥 {facFourn.numero||facFourn.id.slice(0,8)} — {facFourn.fournisseur_nom||"Fournisseur"}
                              </span>
                            )}
                            {justi&&(
                              <span className="text-xs font-medium text-yellow-700 bg-yellow-50 rounded px-2 py-0.5">
                                🧾 {justi.type_document} — {justi.nom_tiers||"—"}
                              </span>
                            )}
                            {!hasDoc&&(
                              <Select onValueChange={async val=>{
                                if(!val||val==="none") return;
                                let docType:"facture_client"|"facture_fournisseur"|"justificatif";
                                let docId:string;
                                if(val.startsWith("fc:")){docType="facture_client";docId=val.slice(3);}
                                else if(val.startsWith("ff:")){docType="facture_fournisseur";docId=val.slice(3);}
                                else{docType="justificatif";docId=val.slice(4);}
                                // Mettre à jour la transaction (statut 'cloture' conservé → trigger SQL
                                // swappe le compte d'attente vers le compte final automatiquement)
                                const upd:any={statut:st==="cloture"?"cloture":"ferme",rapproche:true,document_type:docType};
                                if(docType==="justificatif"){upd.justificatif_id=docId;upd.facture_id=null;}
                                else{upd.facture_id=docId;upd.justificatif_id=null;}
                                await (supabase.from("transactions_bancaires") as any).update(upd).eq("id",t.id);
                                // Mettre à jour le document
                                if(docType==="facture_client"){
                                  const fac=(facturesClient as any[]).find(f=>f.id===docId);
                                  if(fac){const np=Math.round((Number(fac.montant_paye||0)+t.montant)*100)/100;const nr=Math.max(0,Math.round((Number(fac.montant_ttc)-np)*100)/100);await (supabase.from("factures") as any).update({montant_paye:np,montant_restant:nr,statut_paiement:nr<=0.01?"payee":"partielle"}).eq("id",docId);}
                                }else if(docType==="facture_fournisseur"){
                                  const fac=(facturesFourn as any[]).find(f=>f.id===docId);
                                  if(fac){const np=Math.round((Number(fac.montant_paye||0)+t.montant)*100)/100;const nr=Math.max(0,Math.round((Number(fac.montant_ttc)-np)*100)/100);await (supabase.from("factures_fournisseurs") as any).update({montant_paye:np,montant_restant:nr,statut_paiement:nr<=0.01?"payee":"partielle"}).eq("id",docId);}
                                }else{
                                  await (supabase.from("justificatifs") as any).update({statut:"rapproche"}).eq("id",docId);
                                }
                                toast.success("Document lié");
                                loadTx(selectedId!);load();
                              }}>
                                <SelectTrigger className="h-6 text-xs w-48 border-dashed">
                                  <SelectValue placeholder="+ Lier un document…"/>
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="none" className="text-xs text-muted-foreground">— aucun —</SelectItem>
                                  {(facturesClient as any[]).length>0&&<>
                                    <div className="px-2 py-1 text-[10px] text-muted-foreground uppercase font-semibold">Factures client</div>
                                    {(facturesClient as any[]).map(f=><SelectItem key={f.id} value={`fc:${f.id}`} className="text-xs">📤 {f.numero||f.id.slice(0,8)} — {f.clients?.nom||"Client"} — {fmt(Number(f.montant_ttc))}</SelectItem>)}
                                  </>}
                                  {(facturesFourn as any[]).length>0&&<>
                                    <div className="px-2 py-1 text-[10px] text-muted-foreground uppercase font-semibold">Factures fournisseur</div>
                                    {(facturesFourn as any[]).map(f=><SelectItem key={f.id} value={`ff:${f.id}`} className="text-xs">📥 {f.numero||f.id.slice(0,8)} — {f.fournisseur_nom||"Fournisseur"} — {fmt(Number(f.montant_ttc))}</SelectItem>)}
                                  </>}
                                  {(justificatifs as any[]).length>0&&<>
                                    <div className="px-2 py-1 text-[10px] text-muted-foreground uppercase font-semibold">Justificatifs</div>
                                    {(justificatifs as any[]).map(j=><SelectItem key={j.id} value={`jus:${j.id}`} className="text-xs">🧾 {j.type_document} — {j.nom_tiers||"—"} — {fmt(Number(j.montant_ttc))}</SelectItem>)}
                                  </>}
                                </SelectContent>
                              </Select>
                            )}
                          </TableCell>
                          <TableCell>
                            <Button size="sm" variant="ghost" className="h-6 text-xs px-2"
                              onClick={()=>{setLiaisonTx(t);setLiaisonStatut(st==="ferme"?"ferme":"ouvert");setLiaisonLibelle(t.libelle||"");setLiaisonMontant(t.montant);}}>
                              <Pencil className="h-3 w-3"/>
                            </Button>
                          </TableCell>
                        </TableRow>
                        );
                      })}
                  </TableBody>
                </Table>
              </CardContent></Card>
            </>
          )}
        {/* Dialog modifier liaison */}
        <Dialog open={!!liaisonTx} onOpenChange={o=>{if(!o){setLiaisonTx(null);setLiaisonDocType("");setLiaisonDocId("");}}}>
          <DialogContent className="max-w-md">
            <DialogHeader><DialogTitle>Modifier la transaction</DialogTitle></DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label>Libellé d'opération</Label>
                <Input value={liaisonLibelle} onChange={e=>setLiaisonLibelle(e.target.value)}
                  placeholder="Ex: COM REMISE LCN N° 630232"/>
              </div>
              <div className="space-y-2">
                <Label>Montant (MAD) — {liaisonTx?.type==="credit"?"crédit":"débit"}</Label>
                <Input type="number" step="0.01" min="0" value={liaisonMontant}
                  onChange={e=>setLiaisonMontant(parseFloat(e.target.value)||0)}/>
              </div>
              <div className="space-y-2">
                <Label>Statut</Label>
                <Select value={liaisonStatut} onValueChange={v=>{setLiaisonStatut(v as "ouvert"|"ferme");if(v==="ouvert"){setLiaisonDocType("");setLiaisonDocId("");}}}>
                  <SelectTrigger><SelectValue/></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ouvert">🟡 Ouvert — sans document lié</SelectItem>
                    <SelectItem value="ferme">🟢 Fermé — document lié / réglé</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {liaisonStatut==="ferme"&&(
                <div className="space-y-3 border rounded-md p-3 bg-muted/30">
                  <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Lier à un document (optionnel)</Label>
                  <div className="space-y-2">
                    <Label className="text-sm">Type</Label>
                    <Select value={liaisonDocType||"none"} onValueChange={v=>{setLiaisonDocType((v==="none"?"":v) as any);setLiaisonDocId("");}}>
                      <SelectTrigger><SelectValue placeholder="— aucun document —"/></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">— aucun document —</SelectItem>
                        <SelectItem value="facture_client">📤 Facture client</SelectItem>
                        <SelectItem value="facture_fournisseur">📥 Facture fournisseur</SelectItem>
                        <SelectItem value="justificatif">🧾 Justificatif</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {liaisonDocType==="facture_client"&&(
                    <div className="space-y-2">
                      <Label className="text-sm">Facture client</Label>
                      <Select value={liaisonDocId} onValueChange={setLiaisonDocId}>
                        <SelectTrigger><SelectValue placeholder="Choisir une facture…"/></SelectTrigger>
                        <SelectContent>
                          {(facturesClient as any[]).map(f=>(
                            <SelectItem key={f.id} value={f.id}>
                              {f.numero||f.id.slice(0,8)} — {f.clients?.nom||"Client"} — {fmt(Number(f.montant_ttc))}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  {liaisonDocType==="facture_fournisseur"&&(
                    <div className="space-y-2">
                      <Label className="text-sm">Facture fournisseur</Label>
                      <Select value={liaisonDocId} onValueChange={setLiaisonDocId}>
                        <SelectTrigger><SelectValue placeholder="Choisir une facture…"/></SelectTrigger>
                        <SelectContent>
                          {(facturesFourn as any[]).map(f=>(
                            <SelectItem key={f.id} value={f.id}>
                              {f.numero||f.id.slice(0,8)} — {f.fournisseur_nom||"Fournisseur"} — {fmt(Number(f.montant_ttc))}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  {liaisonDocType==="justificatif"&&(
                    <div className="space-y-2">
                      <Label className="text-sm">Justificatif</Label>
                      <Select value={liaisonDocId} onValueChange={setLiaisonDocId}>
                        <SelectTrigger><SelectValue placeholder="Choisir un justificatif…"/></SelectTrigger>
                        <SelectContent>
                          {(justificatifs as any[]).map(j=>(
                            <SelectItem key={j.id} value={j.id}>
                              {j.type_document} — {j.nom_tiers||"Sans tiers"} — {fmt(Number(j.montant_ttc))}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={()=>{setLiaisonTx(null);setLiaisonDocType("");setLiaisonDocId("");}}>Annuler</Button>
              <Button onClick={handleSauvegarderLiaison}>Enregistrer</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        </TabsContent>

        {/* ── RELEVÉS ── */}
        <TabsContent value="releves" className="mt-4">
          <p className="text-sm text-muted-foreground mb-3">Chaque relevé est une brique — cliquez pour ouvrir le détail (document scanné + transactions + lettrage).</p>
          {renderBriques(releves)}
        </TabsContent>

        {/* ── SCANNER ── */}
        <TabsContent value="scanner" className="mt-4">
          {scanStep==="idle"&&(
            <div className="space-y-4">
              {facturesNonPayees.length>0&&(
                <Card className="border-orange-200">
                  <CardContent className="pt-4 pb-4">
                    <p className="font-medium text-sm mb-2 flex items-center gap-2">
                      <AlertCircle className="h-4 w-4 text-orange-500"/>
                      {facturesNonPayees.length} facture(s) en attente de paiement — matching automatique
                    </p>
                    <div className="space-y-1">
                      {facturesNonPayees.slice(0,5).map(f=>(
                        <div key={f.id} className="flex items-center justify-between text-xs text-muted-foreground">
                          <span>{f.type==="client"?"📤":"📥"} {f.nom} — {f.numero}</span>
                          <span className="font-mono font-semibold">{fmt(f.montant_ttc)}</span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              <div className="space-y-2">
                <Label>Compte bancaire *</Label>
                <Select value={releveCompteId} onValueChange={setReleveCompteId}>
                  <SelectTrigger className="max-w-sm"><SelectValue placeholder="Sélectionner le compte…"/></SelectTrigger>
                  <SelectContent>{comptes.map(c=><SelectItem key={c.id} value={c.id}>{c.intitule} — {c.banque}</SelectItem>)}</SelectContent>
                </Select>
              </div>

              <div className="border-2 border-dashed rounded-xl p-12 text-center cursor-pointer hover:border-primary transition-colors max-w-2xl"
                onClick={()=>fileRef.current?.click()}
                onDragOver={e=>e.preventDefault()}
                onDrop={e=>{e.preventDefault();const f=e.dataTransfer.files[0];if(f)handleReleveUpload(f);}}>
                <input ref={fileRef} type="file" className="hidden" accept=".pdf,.jpg,.jpeg,.png"
                  onChange={e=>{const f=e.target.files?.[0];if(f){handleReleveUpload(f);e.target.value="";}}}/>
                {scanLoading
                  ?<><Loader2 className="h-10 w-10 animate-spin mx-auto text-primary mb-2"/><p className="font-medium">Extraction + Analyse IA en cours…</p><p className="text-xs text-muted-foreground mt-1">OCR vision (image/scan) ou parser multi-banques → matching factures + codes PCM</p></>
                  :<><Upload className="h-10 w-10 mx-auto mb-2 text-muted-foreground"/><p className="font-medium text-lg">Glissez votre relevé bancaire</p><p className="text-sm text-muted-foreground mt-1">PDF numérique · Image · PDF scanné / CamScanner</p><p className="text-xs text-muted-foreground mt-2 opacity-70">Attijariwafa · Banque Populaire · CIH · BMCE · BMCI · Société Générale</p></>
                }
              </div>
            </div>
          )}

          {scanStep==="review"&&(
            <div className="space-y-4">
              {/* Header stats */}
              <div className="flex items-center justify-between">
                <div className="flex gap-3">
                  <Badge variant="outline">{txExtraites.length} transactions</Badge>
                  <Badge className="bg-green-600">+{fmt(totalCr)}</Badge>
                  <Badge className="bg-red-600">-{fmt(totalDb)}</Badge>
                  {nbMatch>0&&<Badge className="bg-blue-600">🔗 {nbMatch} matchées</Badge>}
                  {infoReleve&&<Badge variant="outline">{infoReleve.banque}</Badge>}
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={()=>setShowRemarques(true)}><RefreshCw className="h-3.5 w-3.5 mr-1.5"/>Rescanner</Button>
                  <Button variant="outline" size="sm" onClick={genererEDI}><Download className="h-3.5 w-3.5 mr-1.5"/>EDI DGI</Button>
              <Button variant="outline" size="sm" onClick={genererBilan}><Download className="h-3.5 w-3.5 mr-1.5"/>Bilan Sage</Button>
                  {!releveEnregistre?(
                    <Button size="sm" onClick={handleEnregistrerTransactions} disabled={saving}>
                      {saving?<Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin"/>:<CheckCircle className="h-3.5 w-3.5 mr-1.5"/>}
                      Enregistrer les transactions
                    </Button>
                  ):(
                    <>
                      <Button size="sm" variant="outline" disabled className="opacity-60">
                        <CheckCircle className="h-3.5 w-3.5 mr-1.5 text-green-600"/>Enregistré
                      </Button>
                      <Button size="sm" onClick={handleCloturerReleve} disabled={saving} className="bg-orange-600 hover:bg-orange-700 text-white">
                        {saving?<Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin"/>:<CheckCircle className="h-3.5 w-3.5 mr-1.5"/>}
                        Clôturer
                      </Button>
                    </>
                  )}
                  <Button variant="ghost" size="sm" onClick={resetScan}><X className="h-3.5 w-3.5"/></Button>
                </div>
              </div>

              {/* Soldes */}
              {infoReleve&&(
                <div className="space-y-2">
                  <div className="grid grid-cols-5 gap-3">
                    {[
                      {label:"Banque",value:infoReleve.banque,color:"text-primary"},
                      {label:"RIB",value:infoReleve.rib||"—",color:"text-muted-foreground"},
                      {label:"Solde initial",value:fmt(infoReleve.solde_initial),color:"text-blue-600"},
                      {label:`Solde final (calculé${estDebiteur?" · débiteur":""})`,value:fmt(soldeFinalCalcule),color:soldeEcart<1?"text-green-600":"text-orange-600"},
                      {label:"Solde à reporter (PDF · vérif.)",value:soldeReporterScanne!==0?fmt(soldeReporterScanne):"Non extrait",color:soldeReporterScanne!==0?(soldeEcart<1?"text-blue-700":"text-orange-500"):"text-orange-500"},
                    ].map(k=>(
                      <Card key={k.label} className="border-0 bg-muted/40">
                        <CardContent className="pt-3 pb-3">
                          <p className="text-[10px] text-muted-foreground uppercase">{k.label}</p>
                          <p className={`font-semibold text-sm mt-0.5 ${k.color}`}>{k.value}</p>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                  {soldeEcart>1&&soldeReporterScanne!==0&&(
                    <div className="flex items-center gap-2 text-xs text-orange-600 bg-orange-50 border border-orange-200 rounded px-3 py-2">
                      <AlertCircle className="h-3.5 w-3.5 shrink-0"/>
                      Écart de {fmt(soldeEcart)} : le solde final calculé (Crédit − Débit {estDebiteur?"− ":"+ "}Solde initial) ne colle pas au solde à reporter du PDF — le scan a probablement raté ou mal typé une transaction. Utilisez le bouton <Pencil className="h-3 w-3 inline mx-0.5"/> pour corriger.
                    </div>
                  )}
                </div>
              )}

              {/* Tableau transactions */}
              <Card><CardContent className="p-0">
                <div className="max-h-[500px] overflow-y-auto">
                  <Table>
                    <TableHeader className="sticky top-0 bg-card z-10">
                      <TableRow>
                        <TableHead className="w-8">#</TableHead>
                        <TableHead>Date op.</TableHead>
                        <TableHead>Date valeur</TableHead>
                        <TableHead>Référence</TableHead>
                        <TableHead>Libellé d'opération</TableHead>
                        <TableHead className="text-right text-red-600">Débit</TableHead>
                        <TableHead className="text-right text-green-600">Crédit</TableHead>
                        <TableHead>Catégorie / Code PCM</TableHead>
                        <TableHead>Facture correspondante</TableHead>
                        <TableHead className="w-16"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {txExtraites.map((tx,idx)=>{
                        const fClientOptions=facturesClient.map((f:any)=>({id:f.id,label:`${f.numero??f.id.slice(0,8)} — ${f.clients?.nom??""} — ${fmt(Number(f.montant_ttc))}`}));
                        const fFournOptions=facturesFourn.map((f:any)=>({id:f.id,label:`${f.numero??f.id.slice(0,8)} — ${f.fournisseur_nom??""} — ${fmt(Number(f.montant_ttc))}`}));
                        const facOptions=tx.type==="credit"?fClientOptions:fFournOptions;
                        const facChoisie=tx.type==="credit"
                          ?facturesClient.find((f:any)=>f.id===tx.facture_id)
                          :facturesFourn.find((f:any)=>f.id===tx.facture_id);
                        const justiChoisie=tx.justificatif_id?justificatifs.find((j:any)=>j.id===tx.justificatif_id):null;
                        const selectValue=tx.justificatif_id?`jus:${tx.justificatif_id}`:tx.facture_id??"none";
                        const etapeLabel:Record<string,string>={
                          remarques:"📋 Remarques",numero_facture:"🔢 N° facture",
                          nom_tiers:"👤 Nom tiers",montant_date:"💰 Montant",
                          mots_cles:"🔑 Mots-clés",direction:"↕️ Direction",inconnu:"❓ Inconnu"
                        };
                        return(
                        <Fragment key={idx}>
                          <TableRow
                            className={`cursor-pointer ${selectedTx===idx?"bg-primary/5":""} ${tx.justificatif_id?"border-l-2 border-l-yellow-400":tx.facture_id?"border-l-2 border-l-green-500":tx.alerte?"border-l-2 border-l-orange-400":""}`}
                            onClick={()=>setSelectedTx(selectedTx===idx?null:idx)}>
                            <TableCell className="text-xs text-muted-foreground">{idx+1}</TableCell>
                            <TableCell className="text-xs font-mono">{tx.date_operation}</TableCell>
                            <TableCell className="text-xs font-mono text-muted-foreground">{tx.date_valeur||"—"}</TableCell>
                            <TableCell className="text-xs font-mono max-w-[80px] truncate">{tx.reference||"—"}</TableCell>
                            <TableCell className="text-sm max-w-[150px]">
                              <p className="truncate font-medium">{tx.libelle}</p>
                              {tx.tiers_nom&&<p className="text-[10px] text-blue-600">👤 {tx.tiers_nom}</p>}
                              {tx.alerte&&<p className="text-[10px] text-orange-600">⚠️ {tx.alerte}</p>}
                            </TableCell>
                            <TableCell onClick={e=>e.stopPropagation()}>
                              <Select value={tx.categorie} onValueChange={v=>updateTxExtrait(idx,{categorie:v})}>
                                <SelectTrigger className="h-7 text-xs w-44">
                                  <div className="flex items-center gap-1">
                                    <span className={`text-xs ${confColor(tx.confiance)}`}>●</span>
                                    <span className="truncate">{getCatLabel(tx.categorie)}</span>
                                  </div>
                                </SelectTrigger>
                                <SelectContent>
                                  {CATEGORIES.map(c=><SelectItem key={c.value} value={c.value} className="text-xs">{c.label}</SelectItem>)}
                                </SelectContent>
                              </Select>
                              <p className="text-[10px] text-muted-foreground font-mono mt-0.5">{tx.compte_comptable} · {etapeLabel[tx.etape_rapprochement]??tx.etape_rapprochement}</p>
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm font-semibold text-red-600">
                              {tx.type==="debit"?fmt(tx.montant):""}
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm font-semibold text-green-600">
                              {tx.type==="credit"?fmt(tx.montant):""}
                            </TableCell>
                            <TableCell onClick={e=>e.stopPropagation()} className="min-w-[200px]">
                              <Select
                                value={selectValue}
                                onValueChange={v=>{
                                  if(v==="none") updateTxExtrait(idx,{facture_id:null,justificatif_id:null});
                                  else if(v.startsWith("jus:")) updateTxExtrait(idx,{justificatif_id:v.slice(4),facture_id:null});
                                  else updateTxExtrait(idx,{facture_id:v,justificatif_id:null});
                                }}>
                                <SelectTrigger className={`h-7 text-xs ${tx.justificatif_id?"border-yellow-400 bg-yellow-50":tx.facture_id?"border-green-400 bg-green-50":"border-orange-300 bg-orange-50"}`}>
                                  <div className="flex items-center gap-1 overflow-hidden">
                                    {tx.justificatif_id
                                      ?<><span className="text-yellow-600">📎</span><span className="truncate text-yellow-700">{justiChoisie?.nom_tiers||"Justificatif"}</span></>
                                      :tx.facture_id
                                        ?<><span className="text-green-600">🔗</span><span className="truncate text-green-700">{tx.reference_facture||"Facture matchée"}</span></>
                                        :<><span className="text-orange-500">⚠️</span><span className="truncate text-orange-600">Aucune facture — choisir</span></>
                                    }
                                  </div>
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="none" className="text-xs text-muted-foreground">Aucune facture liée</SelectItem>
                                  {facOptions.map(f=>(
                                    <SelectItem key={f.id} value={f.id} className="text-xs">{f.label}</SelectItem>
                                  ))}
                                  {justificatifs.length>0&&(
                                    <>
                                      <div className="px-2 pt-2 pb-1 text-[10px] text-muted-foreground font-semibold uppercase tracking-wide border-t mt-1">Justificatifs disponibles</div>
                                      {justificatifs.map((j:any)=>(
                                        <SelectItem key={j.id} value={`jus:${j.id}`} className="text-xs">
                                          📎 {typeDocLabel(j.type_document)} — {j.nom_tiers} — {fmt(Number(j.montant_ttc))}
                                          {!j.eligible_edi&&<span className="ml-1 text-red-500">(non EDI)</span>}
                                        </SelectItem>
                                      ))}
                                    </>
                                  )}
                                </SelectContent>
                              </Select>
                              {tx.justificatif_id&&<p className="text-[10px] text-yellow-700 mt-0.5">📎 {typeDocLabel(justiChoisie?.type_document||"")|| "justificatif"}{!justiChoisie?.eligible_edi&&<span className="text-red-500 ml-1">— non éligible EDI</span>}</p>}
                              {tx.facture_id&&!tx.justificatif_id&&<p className="text-[10px] text-green-600 mt-0.5">Confiance: {tx.confiance}%</p>}
                            </TableCell>
                            <TableCell onClick={e=>e.stopPropagation()} className="flex gap-1 items-center">
                              <Button size="sm" variant="ghost" className="h-6 w-6 p-0"
                                onClick={()=>{setEditingTx(idx);setEditForm({date_operation:tx.date_operation,date_valeur:tx.date_valeur,reference:tx.reference,libelle:tx.libelle,type:tx.type,montant:tx.montant});}}
                                title="Modifier cette transaction">
                                <Pencil className="h-3 w-3"/>
                              </Button>
                              {tx.facture_id&&facChoisie&&(
                                <Button size="sm" variant="ghost" className="h-6 w-6 p-0"
                                  onClick={()=>window.open((facChoisie as any).fichier_original_url??"#","_blank")}
                                  title="Voir la facture">
                                  <Eye className="h-3 w-3"/>
                                </Button>
                              )}
                            </TableCell>
                          </TableRow>
                          {selectedTx===idx&&(
                            <TableRow key={`${idx}-detail`}>
                              <TableCell colSpan={10} className="bg-muted/30 p-3">
                                <div className="grid grid-cols-2 gap-3 text-xs">
                                  <div><p className="text-muted-foreground mb-1">Confiance IA</p><p className={`font-semibold ${confColor(tx.confiance)}`}>{tx.confiance}%</p></div>
                                  <div><p className="text-muted-foreground mb-1">Méthode match</p><p>{etapeLabel[tx.etape_rapprochement]??tx.etape_rapprochement}</p></div>
                                  {tx.facture_id&&<div className="col-span-2"><p className="text-green-700">✅ Facture: {tx.reference_facture} — {tx.tiers_nom}</p></div>}
                                  {tx.justificatif_id&&<div className="col-span-2"><p className="text-yellow-700">📎 Justificatif: {justiChoisie?.nom_tiers??tx.justificatif_id.slice(0,8)} — {justiChoisie?.type_document}{!justiChoisie?.eligible_edi&&<span className="text-red-500 ml-2 font-medium">⚠️ Non éligible EDI</span>}</p></div>}
                                  {!tx.facture_id&&!tx.justificatif_id&&<div className="col-span-2"><p className="text-orange-600">⚠️ {tx.alerte||"Aucune facture correspondante détectée — choisissez dans la liste déroulante"}</p></div>}
                                </div>
                              </TableCell>
                            </TableRow>
                          )}
                        </Fragment>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </CardContent></Card>
            </div>
          )}

          {scanStep==="done"&&(
            <div className="text-center py-16">
              <CheckCircle className="h-16 w-16 text-green-500 mx-auto mb-4"/>
              <h2 className="text-xl font-bold mb-2">Relevé enregistré avec succès</h2>
              <p className="text-muted-foreground mb-6">{txExtraites.length} transactions clôturées · Écritures Sage générées · Factures mises à jour</p>
              <div className="flex gap-3 justify-center">
                <Button variant="outline" onClick={genererEDI}><Download className="h-4 w-4 mr-2"/>EDI DGI</Button>
              <Button variant="outline" onClick={genererBilan}><Download className="h-4 w-4 mr-2"/>Bilan Sage</Button>
                <Button onClick={()=>{resetScan();setTab("comptes");}}>Voir les transactions</Button>
                <Button variant="outline" onClick={resetScan}>Nouveau relevé</Button>
              </div>
            </div>
          )}
        </TabsContent>

        {/* ── ENCAISSEMENTS ── */}
        <TabsContent value="encaissements" className="mt-4">
          <div className="mb-4 p-4 bg-muted rounded-lg text-sm">
            <p className="font-medium mb-1">Encaissements hors virement bancaire</p>
            <p className="text-muted-foreground">Espèces ou chèque — enregistrés dans le journal de caisse (5143) ou banque (5141).</p>
          </div>
          <Button onClick={()=>setOpenEncaissement(true)}><Plus className="h-4 w-4 mr-2"/>Saisir un encaissement</Button>
        </TabsContent>
      </Tabs>

      {/* Modal modifier transaction */}
      <Dialog open={editingTx!==null} onOpenChange={open=>{if(!open){setEditingTx(null);setEditForm(null);}}}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Modifier la transaction</DialogTitle></DialogHeader>
          {editForm&&(
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Date d'opération</Label>
                  <Input value={editForm.date_operation} onChange={e=>setEditForm({...editForm,date_operation:e.target.value})} placeholder="DD/MM/YYYY"/>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Date valeur</Label>
                  <Input value={editForm.date_valeur} onChange={e=>setEditForm({...editForm,date_valeur:e.target.value})} placeholder="DD/MM/YYYY"/>
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Référence</Label>
                <Input value={editForm.reference} onChange={e=>setEditForm({...editForm,reference:e.target.value})}/>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Libellé d'opération</Label>
                <Input value={editForm.libelle} onChange={e=>setEditForm({...editForm,libelle:e.target.value})}/>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Type</Label>
                  <Select value={editForm.type} onValueChange={v=>setEditForm({...editForm,type:v as "credit"|"debit"})}>
                    <SelectTrigger className="h-8 text-sm"><SelectValue/></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="debit">Débit — sortie d'argent</SelectItem>
                      <SelectItem value="credit">Crédit — entrée d'argent</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Montant (MAD)</Label>
                  <Input type="number" step="0.01" min="0" value={editForm.montant} onChange={e=>setEditForm({...editForm,montant:parseFloat(e.target.value)||0})}/>
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={()=>{setEditingTx(null);setEditForm(null);}}>Annuler</Button>
            <Button onClick={()=>{
              if(editingTx!==null&&editForm){
                updateTxExtrait(editingTx,{
                  date_operation:editForm.date_operation,
                  date_valeur:editForm.date_valeur,
                  reference:editForm.reference,
                  libelle:editForm.libelle,
                  type:editForm.type,
                  montant:editForm.montant,
                });
                setEditingTx(null);setEditForm(null);
                toast.success("Transaction modifiée");
              }
            }}>
              <CheckCircle className="h-4 w-4 mr-2"/>Appliquer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Modal rescanner */}
      <Dialog open={showRemarques} onOpenChange={setShowRemarques}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Rescanner avec remarques</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Précisions pour améliorer la catégorisation :</p>
            <textarea value={remarques} onChange={e=>setRemarques(e.target.value)}
              placeholder="Ex : FIRSTAUM = loyer bureau, CNSS le 10 du mois, ATLAS = fournisseur emballage…"
              rows={4} className="w-full text-sm border rounded p-2 resize-none focus:outline-none focus:ring-1 focus:ring-primary"/>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={()=>setShowRemarques(false)}>Annuler</Button>
            <Button onClick={()=>{setShowRemarques(false);fileRef.current?.click();}}>
              <Sparkles className="h-4 w-4 mr-2"/>Rescanner
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Modal encaissement (code original) */}
      <Dialog open={openEncaissement} onOpenChange={setOpenEncaissement}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Encaissement espèces / chèque</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2"><Label>Type *</Label>
              <Select value={formEnc.type} onValueChange={v=>setFormEnc({...formEnc,type:v as "especes"|"cheque"})}>
                <SelectTrigger><SelectValue/></SelectTrigger>
                <SelectContent><SelectItem value="especes">💵 Espèces</SelectItem><SelectItem value="cheque">🏦 Chèque</SelectItem></SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2"><Label>Montant (MAD) *</Label><Input type="number" step="0.01" value={formEnc.montant} onChange={e=>setFormEnc({...formEnc,montant:parseFloat(e.target.value)||0})}/></div>
              <div className="space-y-2"><Label>Date *</Label><Input type="date" value={formEnc.date_encaissement} onChange={e=>setFormEnc({...formEnc,date_encaissement:e.target.value})}/></div>
            </div>
            {formEnc.type==="cheque"&&(
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2"><Label>N° chèque</Label><Input value={formEnc.numero_cheque} onChange={e=>setFormEnc({...formEnc,numero_cheque:e.target.value})}/></div>
                <div className="space-y-2"><Label>Banque</Label><Input value={formEnc.banque_cheque} onChange={e=>setFormEnc({...formEnc,banque_cheque:e.target.value})}/></div>
              </div>
            )}
            <div className="space-y-2"><Label>Libellé</Label><Input value={formEnc.libelle} onChange={e=>setFormEnc({...formEnc,libelle:e.target.value})} placeholder="Paiement facture F2026-001…"/></div>
            <div className="space-y-2">
              <Label>Facture concernée (optionnel)</Label>
              <Select value={formEnc.facture_id||formEnc.facture_fournisseur_id||"none"}
                onValueChange={v=>{
                  if(v==="none"){setFormEnc({...formEnc,facture_id:"",facture_fournisseur_id:""});return;}
                  const f=facturesNonPayees.find(f=>f.id===v);
                  if(f?.type==="client") setFormEnc({...formEnc,facture_id:v,facture_fournisseur_id:"",montant:f.montant_ttc});
                  else if(f?.type==="fournisseur") setFormEnc({...formEnc,facture_fournisseur_id:v,facture_id:"",montant:f.montant_ttc});
                }}>
                <SelectTrigger><SelectValue placeholder="Aucune facture liée"/></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Aucune facture liée</SelectItem>
                  {facturesNonPayees.map(f=>(<SelectItem key={f.id} value={f.id}>{f.type==="client"?"📤":"📥"} {f.nom} — {f.numero} — {fmt(f.montant_ttc)}</SelectItem>))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={()=>setOpenEncaissement(false)}>Annuler</Button>
            <Button onClick={handleEncaissement} disabled={processing}>
              {processing?<Loader2 className="h-4 w-4 mr-2 animate-spin"/>:<CheckCircle className="h-4 w-4 mr-2"/>}Enregistrer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Modal compte (code original) */}
      <Dialog open={openCompte} onOpenChange={setOpenCompte}>
        <DialogContent>
          <DialogHeader><DialogTitle>Nouveau compte bancaire</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2"><Label>Banque</Label><Input value={formCompte.banque} onChange={e=>setFormCompte({...formCompte,banque:e.target.value})} placeholder="Attijariwafa, CIH, BMCE…"/></div>
            <div className="space-y-2"><Label>Intitulé</Label><Input value={formCompte.intitule} onChange={e=>setFormCompte({...formCompte,intitule:e.target.value})}/></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2"><Label>RIB</Label><Input value={formCompte.rib} onChange={e=>setFormCompte({...formCompte,rib:e.target.value})}/></div>
              <div className="space-y-2"><Label>Solde initial (MAD)</Label><Input type="number" value={formCompte.solde_actuel} onChange={e=>setFormCompte({...formCompte,solde_actuel:parseFloat(e.target.value)||0})}/></div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={()=>setOpenCompte(false)}>Annuler</Button>
            <Button onClick={async()=>{
              const{error}=await (supabase.from("comptes_bancaires") as any).insert({dossier_id:dossierId,...formCompte,iban:formCompte.iban||null});
              if(error) return toast.error(error.message);
              toast.success("Compte créé");setOpenCompte(false);
              setFormCompte({banque:"",intitule:"",rib:"",iban:"",solde_actuel:0});load();
            }}>Créer</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
