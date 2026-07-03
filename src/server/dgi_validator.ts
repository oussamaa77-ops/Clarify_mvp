// ─── Validation UBL 2.1 réelle via PEPPOL BIS Validator (gratuit, public) ────
// API : https://peppol.helger.com/public/menuitem-validation-ws2
// C'est le validateur officiel utilisé par tous les pays PEPPOL
// Conforme PEPPOL = conforme UBL 2.1 = conforme DGI Maroc à 99%

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
  if (!xml.includes("DGI-MA:2026:1.0")) erreurs.push("Namespace DGI-MA manquant");
  if (!xml.includes("<cbc:InvoiceTypeCode>380")) erreurs.push("Type de facture invalide (380 requis)");
  if (!xml.includes("currencyID=\"MAD\"")) erreurs.push("Devise MAD manquante");
  if (!xml.includes("<cac:AccountingSupplierParty>")) erreurs.push("Informations fournisseur manquantes");
  if (!xml.includes("<cac:AccountingCustomerParty>")) erreurs.push("Informations client manquantes");
  if (!xml.includes("<cbc:PayableAmount")) erreurs.push("Montant à payer manquant");
  if (!xml.includes("<cac:InvoiceLine>")) erreurs.push("Aucune ligne de facture");

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
