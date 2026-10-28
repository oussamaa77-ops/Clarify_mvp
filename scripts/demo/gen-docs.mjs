// Génère les PDF de démo (factures de vente + relevés) dans demo-video/.
import fs from "node:fs";
import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";
import { SOCIETE, CLIENTS, FACTURES, BANQUE, RELEVES, totaux, r2 } from "./scenario.mjs";

const OUT = new URL("../../demo-video/", import.meta.url);
fs.mkdirSync(new URL("factures/", OUT), { recursive: true });
fs.mkdirSync(new URL("releves/", OUT), { recursive: true });
const fmt = (n) => n.toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const dfr = (d) => d.split("-").reverse().join("/");
const bleu = rgb(0.09, 0.24, 0.48), gris = rgb(0.45, 0.45, 0.45), blanc = rgb(1, 1, 1);

async function base() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const f = await pdf.embedFont(StandardFonts.Helvetica), b = await pdf.embedFont(StandardFonts.HelveticaBold);
  const T = (s, x, y, o = {}) => page.drawText(String(s), { x, y, size: o.size ?? 9, font: o.bold ? b : f, color: o.color ?? rgb(0, 0, 0) });
  const R = (s, xr, y, o = {}) => T(s, xr - (o.bold ? b : f).widthOfTextAtSize(String(s), o.size ?? 9), y, o);
  const L = (x1, y1, x2, y2, c = gris) => page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.6, color: c });
  page.drawText("SPECIMEN - DEMONSTRATION", { x: 150, y: 330, size: 28, font: b, color: rgb(0.88, 0.88, 0.88), rotate: degrees(35), opacity: 0.45 });
  return { pdf, page, T, R, L };
}

for (const fa of FACTURES) {
  const { pdf, page, T, R, L } = await base();
  const c = CLIENTS[fa.cli], t = totaux(fa);
  T(SOCIETE.nom, 40, 790, { size: 16, bold: true, color: bleu });
  T("Negoce de materiaux de construction et fournitures", 40, 774, { color: gris });
  T(SOCIETE.adresse + "  -  Tel : " + SOCIETE.tel, 40, 762, { color: gris });
  T(`ICE : ${SOCIETE.ice}  -  IF : ${SOCIETE.if_fiscal}  -  RC : ${SOCIETE.rc}`, 40, 750, { color: gris });
  T("FACTURE", 430, 790, { size: 20, bold: true, color: bleu });
  T("N° " + fa.num, 430, 770, { bold: true, size: 11 });
  T("Date : " + dfr(fa.date), 430, 756);
  T("Echeance : " + dfr(fa.ech), 430, 744);
  page.drawRectangle({ x: 320, y: 640, width: 235, height: 80, borderColor: gris, borderWidth: 0.6 });
  T("CLIENT", 330, 706, { bold: true, color: bleu });
  T(c.nom, 330, 692, { bold: true, size: 10 });
  T(c.adresse, 330, 679);
  T("ICE : " + c.ice, 330, 666);
  T("IF : " + c.if_fiscal, 330, 653);
  let y = 610;
  page.drawRectangle({ x: 40, y: y - 4, width: 515, height: 18, color: bleu });
  T("Designation", 46, y + 1, { bold: true, color: blanc }); R("Qte", 330, y + 1, { bold: true, color: blanc });
  R("PU HT", 400, y + 1, { bold: true, color: blanc }); R("TVA", 445, y + 1, { bold: true, color: blanc });
  R("Total HT", 549, y + 1, { bold: true, color: blanc });
  y -= 22;
  for (const [d, q, pu, tx] of fa.l) {
    T(d, 46, y); R(String(q), 330, y); R(fmt(pu), 400, y); R(tx + " %", 445, y); R(fmt(r2(q * pu)), 549, y);
    y -= 6; L(40, y, 555, y); y -= 14;
  }
  y -= 10;
  T("Total HT", 380, y); R(fmt(t.ht), 549, y); y -= 15;
  for (const tx of [...new Set(fa.l.map((l) => l[3]))]) {
    const b = r2(fa.l.filter((l) => l[3] === tx).reduce((s, [, q, pu]) => s + q * pu, 0));
    T(`TVA ${tx} % (base ${fmt(b)})`, 380, y); R(fmt(r2(b * tx / 100)), 549, y); y -= 15;
  }
  L(375, y + 10, 555, y + 10, rgb(0, 0, 0));
  T("Total TTC (MAD)", 380, y - 4, { bold: true, size: 11 }); R(fmt(t.ttc), 549, y - 4, { bold: true, size: 11 });
  y -= 40;
  T("Mode de reglement : " + fa.mode, 40, y, { bold: true }); y -= 14;
  if (fa.tranches) {
    T("Echeancier de paiement :", 40, y); y -= 13;
    fa.tranches.forEach(([d, m], i) => { T(`  Tranche ${i + 1} : ${fmt(m)} MAD au ${dfr(d)}`, 40, y); y -= 13; });
  }
  T("RIB : " + BANQUE.rib + " - " + BANQUE.nom, 40, y); y -= 13;
  T("Arretee la presente facture a la somme TTC de " + fmt(t.ttc) + " dirhams.", 40, y - 6, { color: gris });
  L(40, 70, 555, 70);
  T(`${SOCIETE.nom} - SARL au capital de 100 000 MAD - RC Casablanca ${SOCIETE.rc} - IF ${SOCIETE.if_fiscal} - ICE ${SOCIETE.ice} - Patente ${SOCIETE.patente}`, 40, 58, { size: 7, color: gris });
  fs.writeFileSync(new URL(`factures/${fa.num}_${c.nom.split(" ")[0]}.pdf`, OUT), await pdf.save());
  console.log(fa.num, c.nom, t);
}

for (const rl of RELEVES) {
  const { pdf, page, T, R, L } = await base();
  const orange = rgb(0.8, 0.45, 0.05);
  T(BANQUE.nom, 40, 790, { size: 16, bold: true, color: orange });
  T(BANQUE.agence, 40, 775, { color: gris });
  T("RELEVE DE COMPTE", 380, 790, { size: 14, bold: true });
  T(`Periode du ${dfr(rl.du)} au ${dfr(rl.au)}`, 380, 774);
  T("Titulaire : " + SOCIETE.nom, 40, 745, { bold: true });
  T("RIB : " + BANQUE.rib, 40, 731); T("Devise : MAD", 40, 717);
  let y = 685;
  page.drawRectangle({ x: 40, y: y - 4, width: 515, height: 18, color: orange });
  T("Date", 46, y + 1, { bold: true, color: blanc }); T("Valeur", 100, y + 1, { bold: true, color: blanc });
  T("Libelle", 155, y + 1, { bold: true, color: blanc });
  R("Debit", 480, y + 1, { bold: true, color: blanc }); R("Credit", 549, y + 1, { bold: true, color: blanc });
  y -= 22;
  T("SOLDE AU " + dfr(rl.du), 155, y, { bold: true }); R(fmt(rl.soldeInitial), 549, y, { bold: true });
  y -= 6; L(40, y, 555, y); y -= 14;
  let td = 0, tc = 0;
  for (const [d, lib, de, cr] of rl.ops) {
    T(dfr(d), 46, y); T(dfr(d), 100, y); T(lib, 155, y, { size: 8 });
    if (de) R(fmt(de), 480, y);
    if (cr) R(fmt(cr), 549, y);
    td += de; tc += cr; y -= 6; L(40, y, 555, y); y -= 14;
  }
  T("TOTAL DES MOUVEMENTS", 155, y, { bold: true }); R(fmt(td), 480, y, { bold: true }); R(fmt(tc), 549, y, { bold: true });
  y -= 18;
  const sf = r2(rl.soldeInitial - td + tc);
  T("SOLDE CREDITEUR AU " + dfr(rl.au), 155, y, { bold: true }); R(fmt(sf), 549, y, { bold: true });
  fs.writeFileSync(new URL(`releves/${rl.fichier}`, OUT), await pdf.save());
  console.log(rl.fichier, "solde final", sf);
}
