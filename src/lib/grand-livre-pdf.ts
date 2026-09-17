// ============================================================================
// grand-livre-pdf.ts — Édition PDF du Grand Livre (présentation CGNC).
//
// A4 paysage, polices standard PDF (aucun fichier de police à embarquer : le
// module tourne aussi bien dans le navigateur que dans les tests Node).
// Chaque page porte l'identification de l'entreprise (raison sociale, IF, ICE,
// RC), l'exercice, la période et la pagination « page n / N » — les mentions
// attendues d'un livre comptable présenté à l'administration fiscale.
// Chaque compte est un bloc : report, mouvements avec solde progressif, total du
// compte, solde final ventilé débiteur / créditeur. Un compte coupé par un saut
// de page reprend son en-tête avec la mention « (suite) » et le solde reporté.
//
// Polices standard = encodage WinAnsi : tout caractère hors de cet encodage (le
// séparateur de milliers U+202F de `toLocaleString("fr-MA")`, une flèche…) ferait
// échouer l'édition entière. `texteWinAnsi` les remplace AVANT de dessiner.
// ============================================================================

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { ventiler, type EnteteGrandLivre, type GrandLivre } from "@/lib/grand-livre";

const LARGEUR_PAGE = 841.89;
const HAUTEUR_PAGE = 595.28;
const MARGE = 32;

/** Caractères CP1252 hors Latin-1 que WinAnsi sait encoder. */
const WINANSI_ETENDU = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");

/** Rend un texte dessinable avec une police standard (encodage WinAnsi). */
export function texteWinAnsi(v: unknown): string {
  return String(v ?? "")
    .normalize("NFC")
    .replace(/[    ]/g, " ")
    .replace(/→/g, "->")
    .replace(/[\r\n\t]+/g, " ")
    .split("")
    .map((ch) => (ch.charCodeAt(0) <= 0xff || WINANSI_ETENDU.has(ch) ? ch : "?"))
    .join("");
}

/** 1234567.8 → « 1 234 567,80 » (espaces ordinaires, indépendant de la locale). */
export function montantPdf(n: number): string {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const [ent, dec] = Math.abs(v).toFixed(2).split(".");
  return `${v < 0 ? "-" : ""}${ent.replace(/\B(?=(\d{3})+(?!\d))/g, " ")},${dec}`;
}

/** Colonnes : [clé, largeur, alignement]. Σ largeurs = largeur utile. */
const COLONNES = [
  ["date", 58, "g"], ["journal", 38, "g"], ["piece", 92, "g"], ["libelle", 250, "g"],
  ["lettrage", 36, "g"], ["debit", 80, "d"], ["credit", 80, "d"], ["sd", 72, "d"], ["sc", 72, "d"],
] as const;
type Cle = (typeof COLONNES)[number][0];

interface Contexte {
  doc: PDFDocument;
  page: PDFPage;
  y: number;
  normale: PDFFont;
  grasse: PDFFont;
  entete: EnteteGrandLivre;
  gl: GrandLivre;
}

const TAILLE = 7.5;
const INTERLIGNE = 11;

function tronquer(t: string, police: PDFFont, taille: number, largeur: number): string {
  let s = texteWinAnsi(t);
  if (police.widthOfTextAtSize(s, taille) <= largeur) return s;
  while (s.length > 1 && police.widthOfTextAtSize(`${s}…`, taille) > largeur) s = s.slice(0, -1);
  return `${s}…`;
}

function ligne(ctx: Contexte, cellules: Partial<Record<Cle, string>>, opts: { gras?: boolean; fond?: boolean } = {}) {
  const police = opts.gras ? ctx.grasse : ctx.normale;
  if (opts.fond) {
    ctx.page.drawRectangle({
      x: MARGE, y: ctx.y - 3, width: LARGEUR_PAGE - 2 * MARGE, height: INTERLIGNE,
      color: rgb(0.93, 0.94, 0.96),
    });
  }
  let x = MARGE;
  for (const [cle, largeur, align] of COLONNES) {
    const brut = cellules[cle];
    if (brut) {
      const t = tronquer(brut, police, TAILLE, largeur - 4);
      const w = police.widthOfTextAtSize(t, TAILLE);
      ctx.page.drawText(t, { x: align === "d" ? x + largeur - 2 - w : x + 2, y: ctx.y, size: TAILLE, font: police });
    }
    x += largeur;
  }
  ctx.y -= INTERLIGNE;
}

function nouvellePage(ctx: Contexte) {
  ctx.page = ctx.doc.addPage([LARGEUR_PAGE, HAUTEUR_PAGE]);
  let y = HAUTEUR_PAGE - MARGE;
  const e = ctx.entete;
  const dessiner = (t: string, taille: number, gras = false, x = MARGE) => {
    ctx.page.drawText(texteWinAnsi(t), { x, y, size: taille, font: gras ? ctx.grasse : ctx.normale });
  };
  dessiner("GRAND LIVRE GÉNÉRAL", 13, true);
  const periode = `Exercice ${e.exercice ?? "-"}  -  du ${ctx.gl.periode.debut ?? "-"} au ${ctx.gl.periode.fin ?? "-"}`;
  const wp = ctx.normale.widthOfTextAtSize(texteWinAnsi(periode), 9);
  dessiner(periode, 9, false, LARGEUR_PAGE - MARGE - wp);
  y -= 15;
  dessiner(e.raisonSociale, 10, true);
  y -= 12;
  dessiner([e.identifiantFiscal ? `IF : ${e.identifiantFiscal}` : "", e.ice ? `ICE : ${e.ice}` : "", e.rc ? `RC : ${e.rc}` : ""]
    .filter(Boolean).join("     ") || " ", 8);
  y -= 8;
  ctx.page.drawLine({ start: { x: MARGE, y }, end: { x: LARGEUR_PAGE - MARGE, y }, thickness: 0.8 });
  y -= 13;
  ctx.y = y;
  ligne(ctx, {
    date: "Date", journal: "Jnl", piece: "N° pièce", libelle: "Libellé", lettrage: "Let.",
    debit: "Débit", credit: "Crédit", sd: "Solde D", sc: "Solde C",
  }, { gras: true, fond: true });
  ctx.y -= 2;
}

const BAS_DE_PAGE = MARGE + 26;

function assurerPlace(ctx: Contexte, hauteur: number, suite?: () => void) {
  if (ctx.y - hauteur < BAS_DE_PAGE) {
    nouvellePage(ctx);
    suite?.();
  }
}

const soldeCellules = (s: number): Partial<Record<Cle, string>> => {
  const v = ventiler(s);
  return { sd: v.debiteur ? montantPdf(v.debiteur) : "", sc: v.crediteur ? montantPdf(v.crediteur) : "" };
};

/** Le PDF du grand livre, en octets. */
export async function genererPdfGrandLivre(gl: GrandLivre, entete: EnteteGrandLivre): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(texteWinAnsi(`Grand livre - ${entete.raisonSociale} - ${entete.exercice ?? ""}`));
  doc.setCreator("Clarify");
  const ctx: Contexte = {
    doc, page: undefined as unknown as PDFPage, y: 0,
    normale: await doc.embedFont(StandardFonts.Helvetica),
    grasse: await doc.embedFont(StandardFonts.HelveticaBold),
    entete, gl,
  };
  nouvellePage(ctx);

  if (!gl.comptes.length) ligne(ctx, { libelle: "Aucun compte mouvementé sur la période." });

  for (const c of gl.comptes) {
    const titre = `${c.compte}  ${c.intitule}`.trim();
    assurerPlace(ctx, INTERLIGNE * 4);
    ligne(ctx, { date: titre }, { gras: true, fond: true });
    ligne(ctx, { libelle: "Solde initial / report", debit: c.initialDebit ? montantPdf(c.initialDebit) : "",
      credit: c.initialCredit ? montantPdf(c.initialCredit) : "", ...soldeCellules(c.soldeInitial) });
    let soldeCourant = c.soldeInitial;
    for (const m of c.mouvements) {
      assurerPlace(ctx, INTERLIGNE, () => {
        ligne(ctx, { date: `${titre} (suite)` }, { gras: true, fond: true });
        ligne(ctx, { libelle: "Report", ...soldeCellules(soldeCourant) });
      });
      ligne(ctx, {
        date: m.date_ecriture.slice(0, 10), journal: m.journal_code, piece: m.reference_piece ?? "",
        libelle: m.libelle ?? "", lettrage: m.lettrage_code ?? "",
        debit: m.debit ? montantPdf(m.debit) : "", credit: m.credit ? montantPdf(m.credit) : "",
        ...soldeCellules(m.solde),
      });
      soldeCourant = m.solde;
    }
    assurerPlace(ctx, INTERLIGNE * 2);
    ligne(ctx, { libelle: `Total compte ${c.compte}`, debit: montantPdf(c.totalDebit), credit: montantPdf(c.totalCredit) }, { gras: true });
    ligne(ctx, { libelle: "Solde final", ...soldeCellules(c.soldeFinal) }, { gras: true });
    ctx.y -= 4;
  }

  const t = gl.totaux;
  assurerPlace(ctx, INTERLIGNE * 4);
  ctx.page.drawLine({ start: { x: MARGE, y: ctx.y + 8 }, end: { x: LARGEUR_PAGE - MARGE, y: ctx.y + 8 }, thickness: 0.8 });
  ligne(ctx, { libelle: "TOTAL SOLDES INITIAUX", debit: montantPdf(t.initialDebit), credit: montantPdf(t.initialCredit) }, { gras: true });
  ligne(ctx, { libelle: "TOTAL MOUVEMENTS DE LA PÉRIODE", debit: montantPdf(t.totalDebit), credit: montantPdf(t.totalCredit) }, { gras: true });
  ligne(ctx, {
    libelle: "TOTAL GÉNÉRAL", debit: montantPdf(t.initialDebit + t.totalDebit), credit: montantPdf(t.initialCredit + t.totalCredit),
    sd: montantPdf(t.soldeDebiteur), sc: montantPdf(t.soldeCrediteur),
  }, { gras: true, fond: true });

  // Pied de page : pagination « n / N », posée une fois le nombre de pages connu.
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const pied = texteWinAnsi(`${entete.raisonSociale} - Grand livre ${entete.exercice ?? ""}`
      + `${entete.editeLe ? ` - édité le ${entete.editeLe}` : ""}`);
    p.drawText(pied, { x: MARGE, y: MARGE - 12, size: 7, font: ctx.normale, color: rgb(0.35, 0.35, 0.35) });
    const num = `Page ${i + 1} / ${pages.length}`;
    p.drawText(num, {
      x: LARGEUR_PAGE - MARGE - ctx.normale.widthOfTextAtSize(num, 7), y: MARGE - 12, size: 7, font: ctx.normale,
    });
  });

  return doc.save();
}
