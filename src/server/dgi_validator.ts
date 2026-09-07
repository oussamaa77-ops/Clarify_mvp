// ============================================================================
// dgi_validator.ts — validation UBL par le validateur public PEPPOL.
//
// HORS DU CHEMIN D'ÉMISSION depuis la mise en place du chantier e-Invoicing.
// Il servait à `generateFactureXml`, qui décidait « conforme / rejetée » à
// partir de son verdict ; c'est désormais le connecteur DGI qui arbitre
// (cf. dgi.connector.ts), et lui seul — un validateur tiers ne peut pas
// prononcer une conformité que seule l'administration attribue.
//
// Le module est CONSERVÉ parce qu'il reste utile en diagnostic : confronter
// un XML rejeté par la DGI au validateur PEPPOL dit souvent, en une ligne, si
// le tort vient de notre structure ou de nos données. Il n'est appelé par
// aucun chemin automatique, et sa latence (jusqu'à 15 s) est la raison pour
// laquelle il ne doit pas le redevenir sans être rendu explicite à l'écran.
// ============================================================================
// ─── Validation UBL 2.1 réelle via PEPPOL BIS Validator (gratuit, public) ────
// API : https://peppol.helger.com/public/menuitem-validation-ws2
// C'est le validateur officiel utilisé par tous les pays PEPPOL.
//
// ATTENTION — « conforme PEPPOL » n'est plus synonyme de « conforme DGI ». Le
// profil marocain porte `cac:TaxScheme/cbc:ID = TVA` là où UNCL5153, donc
// PEPPOL, exige « VAT » : un document d'émission part TOUJOURS en « TVA » et se
// fera refuser ici sur ce seul point. Pour un diagnostic de STRUCTURE, rebâtir
// le document avec `construireUblXml(facture, { taxSchemeId: PEPPOL_TAX_SCHEME_ID })`
// avant de l'envoyer, sinon le vrai défaut se noie dans un faux positif.

import { DGI_CUSTOMIZATION_ID } from "../lib/ubl-invoice";

export interface ValidationResult {
  conforme: boolean;
  erreurs: string[];
  avertissements: string[];
  source: "peppol" | "simulation";
  details: any;
}

export async function validerXmlUBL(xml: string): Promise<ValidationResult> {
  try {
    // Endpoint public PEPPOL Helger — validateur UBL 2.1 officiel
    const response = await fetch(
      "https://peppol.helger.com/api/validate",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/xml",
          "Accept": "application/json",
        },
        body: xml,
        signal: AbortSignal.timeout(15000), // 15s timeout
      }
    );

    if (!response.ok) {
      throw new Error(`Validateur PEPPOL: ${response.status}`);
    }

    const result = await response.json();

    // Parser la réponse PEPPOL
    const erreurs: string[] = [];
    const avertissements: string[] = [];

    if (result.results) {
      for (const r of result.results) {
        if (r.items) {
          for (const item of r.items) {
            if (item.errorLevel === "ERROR") {
              erreurs.push(`[${item.id ?? "ERR"}] ${item.text}`);
            } else if (item.errorLevel === "WARN") {
              avertissements.push(`[${item.id ?? "WARN"}] ${item.text}`);
            }
          }
        }
      }
    }

    const conforme = erreurs.length === 0;
    console.log("[DGI] PEPPOL validation:", { conforme, erreurs: erreurs.length, avertissements: avertissements.length });

    return {
      conforme,
      erreurs,
      avertissements,
      source: "peppol",
      details: result,
    };

  } catch (e) {
    console.log("[DGI] PEPPOL unavailable, fallback simulation:", String(e));
    // Fallback : validation locale basique si PEPPOL est indisponible
    return validerXmlLocal(xml);
  }
}

// ─── Validation locale basique (fallback si PEPPOL indisponible) ──────────────
function validerXmlLocal(xml: string): ValidationResult {
  const erreurs: string[] = [];
  const avertissements: string[] = [];

  // Vérifications obligatoires UBL 2.1 / DGI-MA
  if (!xml.includes("<cbc:ID>")) erreurs.push("Numéro de facture manquant (cbc:ID)");
  if (!xml.includes("<cbc:IssueDate>")) erreurs.push("Date de facture manquante (cbc:IssueDate)");
  // L'ancienne version cherchait « DGI-MA:2026:1.0 », qui n'a jamais été émis
  // par le générateur : le contrôle échouait donc sur TOUS les documents, y
  // compris les bons, et son verdict ne voulait plus rien dire.
  if (!xml.includes(DGI_CUSTOMIZATION_ID)) erreurs.push("Profil DGI manquant (cbc:CustomizationID)");
  if (!xml.includes("<cbc:InvoiceTypeCode>380")) erreurs.push("Type de facture invalide (380 requis)");
  if (!xml.includes("currencyID=\"MAD\"")) erreurs.push("Devise MAD manquante");
  if (!xml.includes("<cac:AccountingSupplierParty>")) erreurs.push("Informations fournisseur manquantes");
  if (!xml.includes("<cac:AccountingCustomerParty>")) erreurs.push("Informations client manquantes");
  if (!xml.includes("<cbc:PayableAmount")) erreurs.push("Montant à payer manquant");
  if (!xml.includes("<cac:InvoiceLine>")) erreurs.push("Aucune ligne de facture");

  // ─ Ventilation TVA au niveau DOCUMENT ─
  // Le contrôle DGI recalcule la taxe taux par taux sur le `cac:TaxTotal`
  // racine. Les sous-totaux des lignes ne le remplacent pas : on isole donc le
  // bloc racine par son voisinage plutôt que de compter les `TaxSubtotal`.
  const taxTotalRacine = xml
    .slice(xml.indexOf("</cac:AccountingCustomerParty>"), xml.indexOf("<cac:LegalMonetaryTotal>"))
    .match(/<cac:TaxTotal>[\s\S]*?<\/cac:TaxTotal>/)?.[0];
  if (!taxTotalRacine) {
    erreurs.push("Ventilation TVA du document manquante (cac:TaxTotal racine)");
  } else {
    const sousTotaux = taxTotalRacine.match(/<cac:TaxSubtotal>[\s\S]*?<\/cac:TaxSubtotal>/g) ?? [];
    if (sousTotaux.length === 0) {
      erreurs.push("Aucun cac:TaxSubtotal dans la ventilation TVA du document");
    }
    for (const [i, st] of sousTotaux.entries()) {
      const manquants = [
        st.includes("<cbc:TaxableAmount") ? "" : "cbc:TaxableAmount",
        st.includes("<cbc:TaxAmount") ? "" : "cbc:TaxAmount",
        st.includes("<cbc:Percent>") ? "" : "cbc:Percent",
        st.includes("<cac:TaxScheme>") ? "" : "cac:TaxScheme",
      ].filter(Boolean);
      if (manquants.length) {
        erreurs.push(`TaxSubtotal ${i + 1} incomplet : ${manquants.join(", ")} absent(s)`);
      }
    }
  }

  // ─ Mentions légales de l'émetteur (CGI art. 145) ─
  const vendeur = xml.match(/<cac:AccountingSupplierParty>[\s\S]*?<\/cac:AccountingSupplierParty>/)?.[0] ?? "";
  if (!vendeur.includes('schemeID="IF"')) avertissements.push("IF de l'émetteur absent des PartyIdentification (CGI art. 145)");
  if (!vendeur.includes('schemeID="RC"')) avertissements.push("RC de l'émetteur absent des PartyIdentification (CGI art. 145)");

  // ─ Scellement ─
  // Avertissement et non erreur : un brouillon non encore scellé est légitime,
  // c'est sa TRANSMISSION qui ne l'est pas.
  if (!xml.includes("<ext:UBLExtensions>")) {
    avertissements.push("Aucun bloc de scellement (ext:UBLExtensions) : document non scellé");
  } else if (!/<dgi:Empreinte[^>]*>[0-9a-f]{64}</.test(xml)) {
    erreurs.push("Bloc de scellement présent mais empreinte SHA-256 absente ou malformée");
  }

  // Vérifications ICE (15 chiffres)
  const iceMatch = xml.match(/<cbc:CompanyID>(\d+)<\/cbc:CompanyID>/g);
  if (iceMatch) {
    for (const ice of iceMatch) {
      const digits = ice.replace(/<[^>]+>/g, "");
      if (digits.length !== 15) {
        avertissements.push(`ICE invalide (doit être 15 chiffres): ${digits}`);
      }
    }
  }

  // Vérification montants cohérents
  const htMatch = xml.match(/cbc:LineExtensionAmount[^>]*>([0-9.]+)</);
  const ttcMatch = xml.match(/cbc:PayableAmount[^>]*>([0-9.]+)</);
  if (htMatch && ttcMatch) {
    const ht = parseFloat(htMatch[1]);
    const ttc = parseFloat(ttcMatch[1]);
    if (ttc < ht) erreurs.push("Montant TTC inférieur au HT — incohérence fiscale");
  }

  const conforme = erreurs.length === 0;
  console.log("[DGI] Validation locale:", { conforme, erreurs: erreurs.length });

  return {
    conforme,
    erreurs,
    avertissements,
    source: "simulation",
    details: { mode: "local_validation" },
  };
}
