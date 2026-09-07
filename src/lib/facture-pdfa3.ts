// ============================================================================
// facture-pdfa3.ts — facture hybride PDF/A-3 (lisible ET machine).
//
// Le principe Factur-X, transposé à la DGI : UN SEUL fichier porte les deux
// visages du même document. Un humain l'ouvre et voit une facture ; un système
// l'ouvre et extrait le XML UBL qui y est attaché, sans OCR ni ressaisie. Les
// deux ne peuvent pas diverger puisqu'ils voyagent ensemble.
//
// PDF/A-3 (ISO 19005-3) est le seul niveau de PDF/A qui autorise d'embarquer un
// fichier de données arbitraire : PDF/A-1 et A-2 l'interdisent. D'où le choix
// du niveau, qui n'est pas une préférence mais une nécessité.
//
// ─── Les quatre exigences que ce module tient, et ce qui casse sans elles ────
//
//   1. POLICES EMBARQUÉES. PDF/A interdit de s'appuyer sur les 14 polices
//      « standard » supposées présentes chez le lecteur : dans dix ans, rien ne
//      garantit qu'un Helvetica soit installé, ni qu'il ait les mêmes chasses.
//      On embarque donc une police réelle, en sous-ensemble.
//
//   2. OUTPUTINTENT + PROFIL ICC. Sans lui, le fichier n'est pas conforme du
//      tout (cf. icc-srgb.ts).
//
//   3. MÉTADONNÉES XMP. C'est là, et NULLE PART ailleurs, que le fichier
//      déclare « je suis un PDF/A-3B ». Un fichier structurellement parfait
//      mais sans `pdfaid:part` n'est pas un PDF/A : c'est un PDF ordinaire.
//      On y ajoute le schéma d'extension qui annonce la pièce jointe fiscale,
//      sur le modèle de Factur-X — c'est ce qui rend l'hybride DÉCOUVRABLE par
//      un logiciel tiers plutôt que devinable.
//
//   4. FICHIER ASSOCIÉ (/AF) avec la relation `Data`. Attacher le XML sans le
//      déclarer dans le tableau /AF du catalogue en fait une pièce jointe
//      ordinaire, que les extracteurs Factur-X ignorent.
//
// ─── Ce que ce module ne prétend PAS ─────────────────────────────────────────
// Le niveau visé est PDF/A-3**B** (« Basic » : rendu visuel garanti), pas 3**A**
// (« Accessible »), qui exigerait un arbre de structure sémantique complet.
// C'est le niveau retenu par Factur-X lui-même, et celui qu'attendent les
// plateformes de dématérialisation.
// ============================================================================

import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import fontkit from "@pdf-lib/fontkit";
import {
  AFRelationship,
  PDFArray,
  PDFDocument,
  PDFFont,
  PDFHexString,
  PDFName,
  PDFPage,
  PDFString,
  rgb,
  StandardFonts,
  type PDFImage,
} from "pdf-lib";
import { construireProfilSrgb, ICC_COMPOSANTES, ICC_IDENTIFIANT } from "./icc-srgb";
import { encoderXmlUtf8, totauxFacture, type FactureUbl } from "./ubl-invoice";

export interface OptionsPdfA3 {
  /** Document UBL 2.1 à embarquer. C'est la raison d'être du format hybride. */
  xmlUbl: string;
  /** QR code fiscal en PNG. Absent → la facture s'imprime sans, sans échouer. */
  qrPng?: Uint8Array | null;
  /** UUID attribué par la DGI, imprimé sous le QR une fois la facture validée. */
  dgiUuid?: string | null;
  /** Empreinte d'inaltérabilité, imprimée en pied de page. */
  hashSha256?: string | null;
  /** Libellé du statut DGI affiché en filigrane d'en-tête. */
  statutDgi?: string | null;
  /** Nom du fichier XML embarqué. */
  nomFichierXml?: string;
  /** Profil ICC de remplacement, si un profil canonique est exigé un jour. */
  profilIcc?: Uint8Array;
  /** Date de création portée par les métadonnées (défaut : maintenant). */
  dateCreation?: Date;
}

export interface ResultatPdfA3 {
  pdf: Uint8Array;
  /**
   * `complete` — police réelle embarquée, conformité PDF/A-3B visée.
   * `degradee` — la police n'a pas pu être chargée et le document retombe sur
   * une police standard NON embarquée : le PDF reste lisible et le XML reste
   * attaché, mais il n'est plus conforme PDF/A. On le SIGNALE plutôt que de
   * livrer en silence un fichier qui échouerait à la validation.
   */
  conformite: "complete" | "degradee";
  avertissements: string[];
}

const A4 = { largeur: 595.28, hauteur: 841.89 };
const MARGE = 42;
const NOIR = rgb(0.11, 0.12, 0.14);
const GRIS = rgb(0.45, 0.47, 0.51);
const GRIS_CLAIR = rgb(0.88, 0.89, 0.91);
const ACCENT = rgb(0.13, 0.34, 0.56);

// ─── Chargement des polices ─────────────────────────────────────────────────
// Lecture unique, mémorisée : la police fait ~750 Ko et une facturation en lot
// relirait le disque à chaque document.
let cachePolices: { normale: Uint8Array; grasse: Uint8Array } | null | undefined;

async function chargerPolices(): Promise<{ normale: Uint8Array; grasse: Uint8Array } | null> {
  if (cachePolices !== undefined) return cachePolices;
  try {
    const require = createRequire(import.meta.url);
    const [normale, grasse] = await Promise.all([
      readFile(require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans.ttf")),
      readFile(require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf")),
    ]);
    cachePolices = { normale: new Uint8Array(normale), grasse: new Uint8Array(grasse) };
  } catch {
    cachePolices = null;
  }
  return cachePolices;
}

/** Montant en forme marocaine : « 19 070,00 MAD ». */
function fmt(montant: number): string {
  const n = Math.round((Number(montant) + Number.EPSILON) * 100) / 100;
  const [entier, decimales] = Math.abs(n).toFixed(2).split(".");
  const groupe = entier.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${n < 0 ? "-" : ""}${groupe},${decimales}`;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso);
}

/**
 * Tronque un texte à une largeur donnée, en ajoutant une ellipse.
 * Les désignations d'articles sont saisies librement : sans cette coupe, un
 * libellé de 200 caractères déborderait sur la colonne des montants et rendrait
 * la facture illisible — exactement là où elle doit être la plus claire.
 */
function tronquer(texte: string, police: PDFFont, taille: number, largeurMax: number): string {
  const t = String(texte ?? "");
  if (police.widthOfTextAtSize(t, taille) <= largeurMax) return t;
  let court = t;
  while (court.length > 1 && police.widthOfTextAtSize(`${court}…`, taille) > largeurMax) {
    court = court.slice(0, -1);
  }
  return `${court}…`;
}

interface Contexte {
  page: PDFPage;
  normale: PDFFont;
  grasse: PDFFont;
}

function texte(
  ctx: Contexte,
  contenu: string,
  x: number,
  y: number,
  options: { taille?: number; gras?: boolean; couleur?: ReturnType<typeof rgb>; droite?: number } = {},
): void {
  const taille = options.taille ?? 9;
  const police = options.gras ? ctx.grasse : ctx.normale;
  const largeur = police.widthOfTextAtSize(contenu, taille);
  ctx.page.drawText(contenu, {
    x: options.droite !== undefined ? options.droite - largeur : x,
    y,
    size: taille,
    font: police,
    color: options.couleur ?? NOIR,
  });
}

/** Bloc d'identité d'une partie : raison sociale puis mentions fiscales. */
function blocPartie(
  ctx: Contexte,
  titre: string,
  partie: FactureUbl["vendeur"],
  x: number,
  yDepart: number,
  largeur: number,
): number {
  let y = yDepart;
  texte(ctx, titre.toUpperCase(), x, y, { taille: 7, gras: true, couleur: GRIS });
  y -= 13;
  texte(ctx, tronquer(partie.nom ?? "—", ctx.grasse, 10, largeur), x, y, { taille: 10, gras: true });
  y -= 12;

  for (const ligne of [partie.adresse, [partie.code_postal, partie.ville].filter(Boolean).join(" ")]) {
    if (!ligne) continue;
    texte(ctx, tronquer(ligne, ctx.normale, 8, largeur), x, y, { taille: 8, couleur: GRIS });
    y -= 10;
  }

  // Mentions fiscales obligatoires. Elles ne sont PAS décoratives : une facture
  // qui ne porte pas l'ICE et l'IF de son émetteur est irrégulière au regard du
  // CGI, et la TVA qu'elle porte devient indéductible pour le destinataire.
  const mentions = [
    partie.ice ? `ICE : ${partie.ice}` : null,
    partie.if_fiscal ? `IF : ${partie.if_fiscal}` : null,
    partie.rc ? `RC : ${partie.rc}` : null,
    partie.patente ? `Patente : ${partie.patente}` : null,
  ].filter(Boolean) as string[];

  y -= 2;
  for (const mention of mentions) {
    texte(ctx, mention, x, y, { taille: 7.5, couleur: NOIR });
    y -= 9.5;
  }
  return y;
}

/** Métadonnées XMP, avec le schéma d'extension qui annonce l'hybride. */
function construireXmp(facture: FactureUbl, options: OptionsPdfA3, date: Date): string {
  const iso = date.toISOString().replace(/\.\d{3}Z$/, "Z");
  const titre = `Facture ${facture.numero}`;
  const nomXml = options.nomFichierXml ?? "facture-ubl.xml";
  const esc = (s: string) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
      <pdfaid:part>3</pdfaid:part>
      <pdfaid:conformance>B</pdfaid:conformance>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${esc(titre)}</rdf:li></rdf:Alt></dc:title>
      <dc:creator><rdf:Seq><rdf:li>${esc(facture.vendeur?.nom ?? "")}</rdf:li></rdf:Seq></dc:creator>
      <dc:description><rdf:Alt><rdf:li xml:lang="x-default">Facture électronique hybride PDF/A-3 avec UBL 2.1 embarqué</rdf:li></rdf:Alt></dc:description>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
      <xmp:CreatorTool>HisabPro</xmp:CreatorTool>
      <xmp:CreateDate>${iso}</xmp:CreateDate>
      <xmp:ModifyDate>${iso}</xmp:ModifyDate>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
      <pdf:Producer>HisabPro e-Invoicing</pdf:Producer>
    </rdf:Description>
    <!-- Schéma d'extension : sans lui, un lecteur tiers ne peut pas SAVOIR que
         ce PDF porte une facture structurée, et l'hybride reste lettre morte.
         Structure calquée sur celle de Factur-X, espace de noms DGI Maroc. -->
    <rdf:Description rdf:about="" xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#" xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">
      <pdfaExtension:schemas>
        <rdf:Bag>
          <rdf:li rdf:parseType="Resource">
            <pdfaSchema:schema>Facture électronique DGI Maroc</pdfaSchema:schema>
            <pdfaSchema:namespaceURI>urn:dgi:ma:einvoice:1p0#</pdfaSchema:namespaceURI>
            <pdfaSchema:prefix>dgima</pdfaSchema:prefix>
            <pdfaSchema:property>
              <rdf:Seq>
                <rdf:li rdf:parseType="Resource">
                  <pdfaProperty:name>DocumentFileName</pdfaProperty:name>
                  <pdfaProperty:valueType>Text</pdfaProperty:valueType>
                  <pdfaProperty:category>external</pdfaProperty:category>
                  <pdfaProperty:description>Nom du fichier XML embarqué</pdfaProperty:description>
                </rdf:li>
                <rdf:li rdf:parseType="Resource">
                  <pdfaProperty:name>DocumentType</pdfaProperty:name>
                  <pdfaProperty:valueType>Text</pdfaProperty:valueType>
                  <pdfaProperty:category>external</pdfaProperty:category>
                  <pdfaProperty:description>Type de document (INVOICE)</pdfaProperty:description>
                </rdf:li>
                <rdf:li rdf:parseType="Resource">
                  <pdfaProperty:name>Version</pdfaProperty:name>
                  <pdfaProperty:valueType>Text</pdfaProperty:valueType>
                  <pdfaProperty:category>external</pdfaProperty:category>
                  <pdfaProperty:description>Version de la syntaxe XML</pdfaProperty:description>
                </rdf:li>
                <rdf:li rdf:parseType="Resource">
                  <pdfaProperty:name>ConformanceLevel</pdfaProperty:name>
                  <pdfaProperty:valueType>Text</pdfaProperty:valueType>
                  <pdfaProperty:category>external</pdfaProperty:category>
                  <pdfaProperty:description>Niveau de conformité du profil</pdfaProperty:description>
                </rdf:li>
              </rdf:Seq>
            </pdfaSchema:property>
          </rdf:li>
        </rdf:Bag>
      </pdfaExtension:schemas>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:dgima="urn:dgi:ma:einvoice:1p0#">
      <dgima:DocumentFileName>${esc(nomXml)}</dgima:DocumentFileName>
      <dgima:DocumentType>INVOICE</dgima:DocumentType>
      <dgima:Version>UBL-2.1</dgima:Version>
      <dgima:ConformanceLevel>DGI-MA-B2B</dgima:ConformanceLevel>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/**
 * Produit la facture hybride.
 *
 * L'appelant fournit le XML DÉJÀ construit plutôt que de le laisser générer
 * ici : le XML transmis à la DGI et celui embarqué dans le PDF doivent être le
 * même octet. Les régénérer séparément ouvrirait la porte à deux documents
 * légèrement différents portant le même numéro de facture.
 */
export async function construirePdfA3(facture: FactureUbl, options: OptionsPdfA3): Promise<ResultatPdfA3> {
  const avertissements: string[] = [];
  const dateCreation = options.dateCreation ?? new Date();
  const devise = facture.devise || "MAD";
  const totaux = totauxFacture(facture.lignes);

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);

  // ─── Polices ──────────────────────────────────────────────────────────────
  const polices = await chargerPolices();
  let normale: PDFFont;
  let grasse: PDFFont;
  let conformite: ResultatPdfA3["conformite"] = "complete";
  if (polices) {
    normale = await doc.embedFont(polices.normale, { subset: true });
    grasse = await doc.embedFont(polices.grasse, { subset: true });
  } else {
    normale = await doc.embedFont(StandardFonts.Helvetica);
    grasse = await doc.embedFont(StandardFonts.HelveticaBold);
    conformite = "degradee";
    avertissements.push(
      "Police embarquable introuvable (paquet dejavu-fonts-ttf) : le PDF utilise une police standard " +
        "NON embarquée et n'est donc pas conforme PDF/A-3. Le XML UBL reste attaché et exploitable.",
    );
  }

  const page = doc.addPage([A4.largeur, A4.hauteur]);
  const ctx: Contexte = { page, normale, grasse };
  const droite = A4.largeur - MARGE;
  let y = A4.hauteur - MARGE;

  // ─── En-tête ──────────────────────────────────────────────────────────────
  const typeLibelle =
    facture.type === "avoir" ? "AVOIR" : facture.type === "acompte" ? "FACTURE D'ACOMPTE" : "FACTURE";
  texte(ctx, typeLibelle, 0, y - 4, { taille: 20, gras: true, couleur: ACCENT, droite });
  texte(ctx, `N° ${facture.numero}`, 0, y - 22, { taille: 11, gras: true, droite });
  texte(ctx, `Date : ${fmtDate(facture.date_facture)}`, 0, y - 36, { taille: 8.5, couleur: GRIS, droite });
  if (facture.date_echeance) {
    texte(ctx, `Échéance : ${fmtDate(facture.date_echeance)}`, 0, y - 47, { taille: 8.5, couleur: GRIS, droite });
  }
  if (options.statutDgi) {
    texte(ctx, options.statutDgi, 0, y - 60, { taille: 8, gras: true, couleur: ACCENT, droite });
  }

  const basVendeur = blocPartie(ctx, "Émetteur", facture.vendeur, MARGE, y, 250);
  y = Math.min(basVendeur, y - 72) - 18;

  // ─── Destinataire ─────────────────────────────────────────────────────────
  page.drawLine({ start: { x: MARGE, y }, end: { x: droite, y }, thickness: 0.5, color: GRIS_CLAIR });
  y -= 18;
  const basAcheteur = blocPartie(ctx, "Facturé à", facture.acheteur, MARGE, y, 250);
  y = basAcheteur - 20;

  // ─── Tableau des lignes ───────────────────────────────────────────────────
  const colonnes = {
    designation: MARGE,
    quantite: MARGE + 268,
    prixUnitaire: MARGE + 340,
    taux: MARGE + 400,
    total: droite,
  };

  page.drawRectangle({
    x: MARGE - 4,
    y: y - 4,
    width: droite - MARGE + 8,
    height: 17,
    color: rgb(0.95, 0.96, 0.97),
  });
  texte(ctx, "Désignation", colonnes.designation, y, { taille: 7.5, gras: true, couleur: GRIS });
  texte(ctx, "Qté", 0, y, { taille: 7.5, gras: true, couleur: GRIS, droite: colonnes.quantite + 32 });
  texte(ctx, "P.U. HT", 0, y, { taille: 7.5, gras: true, couleur: GRIS, droite: colonnes.prixUnitaire + 52 });
  texte(ctx, "TVA", 0, y, { taille: 7.5, gras: true, couleur: GRIS, droite: colonnes.taux + 38 });
  texte(ctx, "Total HT", 0, y, { taille: 7.5, gras: true, couleur: GRIS, droite: colonnes.total });
  y -= 17;

  // Une facture longue déborderait de la page ; on coupe et on le DIT, plutôt
  // que d'imprimer par-dessus le pied de page ou de perdre des lignes en
  // silence — le XML embarqué, lui, les porte toutes.
  const hauteurLigne = 14;
  const yPlancher = 300;
  const maxLignes = Math.max(1, Math.floor((y - yPlancher) / hauteurLigne));
  const lignesImprimees = facture.lignes.slice(0, maxLignes);
  if (facture.lignes.length > maxLignes) {
    avertissements.push(
      `${facture.lignes.length - maxLignes} ligne(s) non imprimée(s) faute de place sur la page ; ` +
        "le XML UBL embarqué contient l'intégralité du détail.",
    );
  }

  for (const ligne of lignesImprimees) {
    const base = (Number(ligne.quantite) || 0) * (Number(ligne.prix_unitaire) || 0);
    texte(ctx, tronquer(ligne.designation || "—", normale, 8.5, 255), colonnes.designation, y, { taille: 8.5 });
    texte(ctx, String(ligne.quantite ?? 0), 0, y, { taille: 8.5, droite: colonnes.quantite + 32 });
    texte(ctx, fmt(Number(ligne.prix_unitaire) || 0), 0, y, { taille: 8.5, droite: colonnes.prixUnitaire + 52 });
    texte(ctx, `${Number(ligne.taux_tva) || 0} %`, 0, y, { taille: 8.5, droite: colonnes.taux + 38 });
    texte(ctx, fmt(base), 0, y, { taille: 8.5, gras: true, droite: colonnes.total });
    y -= hauteurLigne;
  }

  y -= 6;
  page.drawLine({ start: { x: MARGE, y }, end: { x: droite, y }, thickness: 0.5, color: GRIS_CLAIR });
  y -= 18;

  // ─── Ventilation par taux ─────────────────────────────────────────────────
  // C'est le bloc que lit un contrôleur en premier : il doit retrouver, taux par
  // taux, la base et la taxe exactement telles qu'elles ont été transmises.
  const xVent = MARGE;
  texte(ctx, "VENTILATION DE LA TVA", xVent, y, { taille: 7, gras: true, couleur: GRIS });
  let yVent = y - 13;
  texte(ctx, "Taux", xVent, yVent, { taille: 7, couleur: GRIS });
  texte(ctx, "Base HT", 0, yVent, { taille: 7, couleur: GRIS, droite: xVent + 130 });
  texte(ctx, "TVA", 0, yVent, { taille: 7, couleur: GRIS, droite: xVent + 210 });
  yVent -= 12;
  for (const v of totaux.ventilation) {
    texte(ctx, `${v.taux} %`, xVent, yVent, { taille: 8 });
    texte(ctx, fmt(v.base_ht), 0, yVent, { taille: 8, droite: xVent + 130 });
    texte(ctx, fmt(v.montant_tva), 0, yVent, { taille: 8, droite: xVent + 210 });
    yVent -= 11;
  }

  // ─── Totaux ───────────────────────────────────────────────────────────────
  let yTot = y;
  const xTotLibelle = droite - 210;
  for (const [libelle, valeur, gras] of [
    ["Total HT", totaux.total_ht, false],
    ["Total TVA", totaux.total_tva, false],
  ] as const) {
    texte(ctx, libelle, xTotLibelle, yTot, { taille: 9, couleur: GRIS });
    texte(ctx, `${fmt(valeur)} ${devise}`, 0, yTot, { taille: 9, gras, droite });
    yTot -= 15;
  }
  page.drawRectangle({
    x: xTotLibelle - 10,
    y: yTot - 6,
    width: droite - xTotLibelle + 14,
    height: 22,
    color: rgb(0.94, 0.96, 0.98),
  });
  texte(ctx, "TOTAL TTC", xTotLibelle, yTot, { taille: 10, gras: true, couleur: ACCENT });
  texte(ctx, `${fmt(totaux.total_ttc)} ${devise}`, 0, yTot, { taille: 11, gras: true, couleur: ACCENT, droite });

  // ─── QR code et récépissé DGI ─────────────────────────────────────────────
  let yBas = Math.min(yVent, yTot - 6) - 30;
  if (options.qrPng && options.qrPng.length > 0) {
    let image: PDFImage | null = null;
    try {
      image = await doc.embedPng(options.qrPng);
    } catch {
      // Un QR illisible ne doit pas empêcher d'émettre la facture : l'empreinte
      // est de toute façon imprimée en clair juste en dessous.
      avertissements.push("QR code illisible — non inséré dans le PDF.");
    }
    if (image) {
      const cote = 92;
      page.drawImage(image, { x: MARGE, y: yBas - cote, width: cote, height: cote });
      texte(ctx, "Contrôle fiscal — scanner le code", MARGE, yBas - cote - 11, { taille: 6.5, couleur: GRIS });

      const xInfo = MARGE + cote + 16;
      let yInfo = yBas - 8;
      if (options.dgiUuid) {
        texte(ctx, "RÉCÉPISSÉ DGI", xInfo, yInfo, { taille: 7, gras: true, couleur: GRIS });
        yInfo -= 12;
        texte(ctx, options.dgiUuid, xInfo, yInfo, { taille: 8.5, gras: true });
        yInfo -= 14;
      }
      if (options.hashSha256) {
        texte(ctx, "EMPREINTE SHA-256", xInfo, yInfo, { taille: 7, gras: true, couleur: GRIS });
        yInfo -= 11;
        // Coupée en deux : 64 caractères d'une traite ne tiennent pas dans la
        // largeur restante à une taille encore lisible à l'œil.
        texte(ctx, options.hashSha256.slice(0, 32), xInfo, yInfo, { taille: 7, couleur: NOIR });
        yInfo -= 9;
        texte(ctx, options.hashSha256.slice(32), xInfo, yInfo, { taille: 7, couleur: NOIR });
      }
      yBas -= cote + 24;
    }
  }

  // ─── Pied de page ─────────────────────────────────────────────────────────
  const yPied = MARGE + 4;
  page.drawLine({
    start: { x: MARGE, y: yPied + 26 },
    end: { x: droite, y: yPied + 26 },
    thickness: 0.5,
    color: GRIS_CLAIR,
  });
  texte(
    ctx,
    "Facture électronique — PDF/A-3 avec facture structurée UBL 2.1 embarquée (fichier associé).",
    MARGE,
    yPied + 14,
    { taille: 6.5, couleur: GRIS },
  );
  texte(ctx, `Document généré par HisabPro le ${fmtDate(dateCreation.toISOString())}`, MARGE, yPied + 5, {
    taille: 6.5,
    couleur: GRIS,
  });

  // ─── Pièce jointe UBL — le cœur de l'hybride ──────────────────────────────
  const nomXml = options.nomFichierXml ?? "facture-ubl.xml";
  await doc.attach(encoderXmlUtf8(options.xmlUbl), nomXml, {
    mimeType: "application/xml",
    description: `Facture structurée UBL 2.1 — ${facture.numero}`,
    creationDate: dateCreation,
    modificationDate: dateCreation,
    // `Data` = le fichier joint EST la donnée dont le PDF est le rendu visuel.
    // C'est la relation que cherchent les extracteurs Factur-X ; `Unspecified`
    // les ferait passer à côté.
    afRelationship: AFRelationship.Data,
  });

  // ─── Métadonnées du document ──────────────────────────────────────────────
  doc.setTitle(`Facture ${facture.numero}`);
  doc.setAuthor(facture.vendeur?.nom ?? "");
  doc.setSubject("Facture électronique");
  doc.setProducer("HisabPro e-Invoicing");
  doc.setCreator("HisabPro");
  doc.setCreationDate(dateCreation);
  doc.setModificationDate(dateCreation);

  appliquerConformitePdfA(doc, construireXmp(facture, options, dateCreation), options.profilIcc);

  // `useObjectStreams: false` : les flux d'objets compressent le fichier mais
  // rendent sa structure opaque aux validateurs anciens. Sur un document
  // d'archive d'une page, le gain de taille ne vaut pas le risque.
  const pdf = await doc.save({ useObjectStreams: false });
  return { pdf, conformite, avertissements };
}

/**
 * Pose les trois éléments qui font d'un PDF un PDF/A : les métadonnées XMP, le
 * profil de sortie ICC, et l'identifiant de fichier.
 */
function appliquerConformitePdfA(doc: PDFDocument, xmp: string, profilIcc?: Uint8Array): void {
  const contexte = doc.context;

  // 1. Métadonnées XMP, NON compressées : un validateur doit pouvoir les lire
  //    sans décodeur, et plusieurs refusent un flux /Metadata filtré.
  //
  //    Le flux est fourni en OCTETS, jamais en chaîne : `pdf-lib` sérialise une
  //    chaîne avec `charCodeAt`, qui tronque tout caractère au-delà de U+00FF et
  //    écrit du Latin-1. Le paquet XMP se déclare pourtant en UTF-8 et contient
  //    des accents (« Facture électronique », « conformité ») : passer la chaîne
  //    telle quelle produisait des métadonnées à l'encodage MENTEUR, illisibles
  //    pour un extracteur et invalides au regard de PDF/A.
  const fluxXmp = contexte.stream(encoderXmlUtf8(xmp), { Type: "Metadata", Subtype: "XML" });
  doc.catalog.set(PDFName.of("Metadata"), contexte.register(fluxXmp));

  // 2. OutputIntent + profil ICC embarqué.
  const icc = profilIcc ?? construireProfilSrgb();
  const fluxIcc = contexte.stream(icc, { N: ICC_COMPOSANTES });
  const refIcc = contexte.register(fluxIcc);
  const outputIntent = contexte.obj({
    Type: "OutputIntent",
    // `GTS_PDFA1` reste la sous-catégorie normative pour TOUTES les parties de
    // PDF/A, y compris la 3 : le « 1 » désigne la série, pas la partie. Écrire
    // `GTS_PDFA3` est une erreur fréquente qui invalide le fichier.
    S: "GTS_PDFA1",
    OutputConditionIdentifier: PDFString.of(ICC_IDENTIFIANT),
    Info: PDFString.of("sRGB IEC61966-2.1"),
    RegistryName: PDFString.of("http://www.color.org"),
    DestOutputProfile: refIcc,
  });
  doc.catalog.set(PDFName.of("OutputIntents"), contexte.obj([contexte.register(outputIntent)]));

  // 3. Identifiant de fichier dans la remorque. PDF/A l'exige ; son absence est
  //    un manquement à part entière, indépendant du reste.
  const identifiant = PDFHexString.of(empreinteDocument(xmp));
  const tableau = PDFArray.withContext(contexte);
  tableau.push(identifiant);
  tableau.push(identifiant);
  contexte.trailerInfo.ID = tableau;
}

/** Identifiant de 32 hexadécimaux dérivé des métadonnées — stable pour un même
 *  document, distinct d'un document à l'autre. */
function empreinteDocument(source: string): string {
  return createHash("md5").update(source, "utf8").digest("hex").toUpperCase();
}
