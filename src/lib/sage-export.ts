// ── Comptabilité auxiliaire / export Sage des tiers ──────────────────────────
// Génère un fichier d'import Sage (CSV paramétrable, séparateur ";", BOM UTF-8)
// listant les tiers avec leur code auxiliaire et leur compte collectif PCM.
//
// Compte collectif (général) côté Maroc : clients = 3421, fournisseurs = 4411.

export type TiersType = "client" | "fournisseur";

export interface TiersSage {
  nom: string;
  code_auxiliaire?: string | null;
  ice?: string | null;
  if_fiscal?: string | null;
  rc?: string | null;
  adresse?: string | null;
  email?: string | null;
  telephone?: string | null;
}

const COMPTE_COLLECTIF: Record<TiersType, string> = { client: "3421", fournisseur: "4411" };
const PREFIXE: Record<TiersType, string> = { client: "C", fournisseur: "F" };

/**
 * Prochain code auxiliaire séquentiel pour un type de tiers.
 * Scanne les codes existants au format <PREFIXE><chiffres> (ex. C0007) et
 * renvoie le suivant, zéro-paddé sur la largeur observée (min. 4).
 */
export function nextCodeAuxiliaire(type: TiersType, existing: (string | null | undefined)[]): string {
  const prefix = PREFIXE[type];
  const re = new RegExp(`^${prefix}(\\d+)$`, "i");
  let max = 0, width = 4;
  for (const code of existing) {
    const m = code?.trim().match(re);
    if (m) {
      max = Math.max(max, parseInt(m[1], 10));
      width = Math.max(width, m[1].length);
    }
  }
  return `${prefix}${String(max + 1).padStart(width, "0")}`;
}

// Échappe une valeur pour un CSV séparé par ";" (Sage / Excel FR).
const esc = (v: unknown): string => {
  const s = (v ?? "").toString().trim();
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Construit le contenu CSV d'import Sage pour une liste de tiers.
 * Les tiers sans code auxiliaire reçoivent un code auto (séquence continue)
 * afin que chaque ligne ait un n° de compte tiers (obligatoire dans Sage).
 */
export function buildSageTiersCSV(tiers: TiersSage[], type: TiersType): string {
  const collectif = COMPTE_COLLECTIF[type];
  const typeLabel = type === "client" ? "Client" : "Fournisseur";

  // Pré-affecte un code auto aux tiers sans code, sans collisionner l'existant.
  const dejaUtilises = tiers.map(t => t.code_auxiliaire);
  let prochain = nextCodeAuxiliaire(type, dejaUtilises);
  const bumpCode = (c: string) => {
    const m = c.match(/^([A-Za-z]+)(\d+)$/)!;
    return `${m[1]}${String(parseInt(m[2], 10) + 1).padStart(m[2].length, "0")}`;
  };

  const header = ["Compte", "Intitule", "Type", "Compte_collectif", "ICE", "Identifiant_fiscal", "RC", "Adresse", "Email", "Telephone"];
  const lignes = tiers.map(t => {
    let code = t.code_auxiliaire?.trim();
    if (!code) { code = prochain; prochain = bumpCode(prochain); }
    return [code, t.nom, typeLabel, collectif, t.ice, t.if_fiscal, t.rc, t.adresse, t.email, t.telephone]
      .map(esc).join(";");
  });
  return [header.join(";"), ...lignes].join("\r\n");
}

/** Déclenche le téléchargement du CSV Sage des tiers. */
export function downloadSageTiers(tiers: TiersSage[], type: TiersType, dossierId: string) {
  const csv = buildSageTiersCSV(tiers, type);
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `sage_${type}s_${dossierId.slice(0, 8)}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}
