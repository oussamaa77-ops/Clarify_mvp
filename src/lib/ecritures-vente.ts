// ============================================================================
// ecritures-vente.ts — Le journal des VENTES, en logique pure.
//
// ─── Pourquoi extraire ce générateur ─────────────────────────────────────────
// Les trois jeux d'écritures de vente (facture ordinaire, facture d'ACOMPTE,
// facture de SOLDE) vivaient en clair dans `generateFactureXml`, au milieu de la
// transmission DGI, de l'archivage GED et de l'envoi d'e-mail. Rien n'y était
// testable : pour vérifier qu'une facture ordinaire ne crédite pas le 4191, il
// fallait transmettre une facture à la DGI.
//
// Le voici seul, sans base ni réseau. La règle qui suit devient dès lors un
// INVARIANT vérifiable, et non plus une intention portée par un commentaire.
//
// ─── L'invariant ─────────────────────────────────────────────────────────────
//   4191 « Clients — avances et acomptes reçus » est un compte de PASSIF. Il
//   constate une dette : l'argent est encaissé, la prestation ne l'est pas.
//   Il n'est licite QUE sur une facture d'acompte, et il doit être SOLDÉ par la
//   facture de solde qui l'impute en produit.
//
//   Toute autre facture crédite un compte de PRODUIT de classe 7 (cf.
//   src/lib/compte-vente.ts). Une facture ordinaire qui crédite le 4191 ne fait
//   pas apparaître son chiffre d'affaires : le compte de résultat est amputé du
//   montant, le bilan porte une dette qui n'existe pas, et le rapprochement CA
//   HT ⇄ crédits classe 7 échoue de la même somme.
//
// `assertLignesVente` rend l'invariant OPPOSABLE : le générateur s'auto-contrôle
// avant l'insert, exactement comme `assertEcrituresTresorerie` le fait côté
// banque. Une régression ne franchit pas la couche serveur.
// ============================================================================

import { COMPTES_TVA } from "@/services/lettrage";
import { PCM, controlerComptesPcm, validatePcmAccount } from "@/lib/pcm-referentiel";

/**
 * Compte d'avances et acomptes reçus — passif, jamais un produit.
 * ⚠️ À VALIDER : numérotation française (419) ; le CGNC emploie 4421.
 */
export const COMPTE_ACOMPTES_CLIENTS = PCM.CLIENTS_AVANCES_RECUES;

/** Nature de la pièce de vente. Tout ce qui n'est pas connu est ORDINAIRE. */
export type TypeFactureVente = "facture" | "acompte" | "solde";

/** Une ligne d'écriture prête à insérer — le sous-ensemble qui nous concerne. */
export interface LigneVente {
  dossier_id: string;
  journal_code: "VTE" | "OD";
  compte_numero: string;
  date_ecriture: string;
  libelle: string;
  debit: number;
  credit: number;
  reference_piece: string;
  facture_id: string;
  valide: true;
}

export interface ContexteEcrituresVente {
  dossier_id: string;
  facture_id: string;
  /** Référence portée par les écritures : le NUMÉRO côté vente. */
  reference: string;
  date_facture: string;
  montant_ht: number;
  montant_tva: number;
  montant_ttc: number;
  /** Compte de tiers, collectif 3421 ou auxiliaire 34210002. */
  compte_client: string;
  /** Compte de produit retenu par `compteVente` — 7111 / 7121 / 7124. */
  compte_produit: string;
  type: TypeFactureVente;
}

/** Un type de facture inconnu n'est pas un acompte : il est ORDINAIRE. */
export function normaliserTypeVente(v: string | null | undefined): TypeFactureVente {
  const t = String(v ?? "").trim().toLowerCase();
  if (t === "acompte") return "acompte";
  if (t === "solde") return "solde";
  return "facture";
}

const r2 = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Les écritures du journal des ventes pour une facture.
 *
 *   ORDINAIRE   D 3421 TTC  /  C 7xxx HT  +  C 4458 TVA
 *   ACOMPTE     D 3421 TTC  /  C 4191 HT  +  C 4458 TVA
 *                 — aucun produit : l'acompte n'est pas du chiffre d'affaires.
 *   SOLDE       les trois lignes ordinaires, PLUS l'OD d'imputation qui solde le
 *               4191 ouvert par l'acompte :  D 4191 HT / C 7xxx HT.
 *
 * La TVA transite systématiquement par le 4458 : le régime des encaissements ne
 * la rend exigible (44551) qu'au règlement, via l'OD de bascule du lettrage.
 */
export function lignesEcrituresVente(ctx: ContexteEcrituresVente): LigneVente[] {
  const base = {
    dossier_id: ctx.dossier_id,
    date_ecriture: ctx.date_facture,
    reference_piece: ctx.reference,
    facture_id: ctx.facture_id,
    valide: true as const,
  };
  const ht = r2(ctx.montant_ht);
  const tva = r2(ctx.montant_tva);
  const ttc = r2(ctx.montant_ttc);
  const ref = ctx.reference;

  const debitClient = (libelle: string): LigneVente => ({
    ...base, journal_code: "VTE", compte_numero: ctx.compte_client,
    libelle, debit: ttc, credit: 0,
  });
  const creditTva = (libelle: string): LigneVente => ({
    ...base, journal_code: "VTE", compte_numero: COMPTES_TVA.client.attente,
    libelle, debit: 0, credit: tva,
  });

  if (ctx.type === "acompte") {
    return [
      debitClient(`Acompte ${ref}`),
      { ...base, journal_code: "VTE", compte_numero: COMPTE_ACOMPTES_CLIENTS,
        libelle: `Avance reçue ${ref}`, debit: 0, credit: ht },
      creditTva(`TVA acompte en attente ${ref}`),
    ];
  }

  const venteOrdinaire: LigneVente[] = [
    debitClient(`Vente ${ref}`),
    { ...base, journal_code: "VTE", compte_numero: ctx.compte_produit,
      libelle: `Vente ${ref}`, debit: 0, credit: ht },
    creditTva(`TVA en attente ${ref}`),
  ];

  if (ctx.type !== "solde") return venteOrdinaire;

  // Facture de SOLDE : la vente est constatée en totalité au produit, puis
  // l'acompte antérieurement porté au 4191 est imputé sur ce même produit. Le
  // 4191 revient à zéro ; le produit n'est pas compté deux fois, car le débit et
  // le crédit de l'OD se neutralisent sur le résultat.
  venteOrdinaire[0] = { ...venteOrdinaire[0], libelle: `Solde ${ref}` };
  return [
    ...venteOrdinaire,
    { ...base, journal_code: "OD", compte_numero: COMPTE_ACOMPTES_CLIENTS,
      libelle: `Imputation acompte ${ref}`, debit: ht, credit: 0 },
    { ...base, journal_code: "OD", compte_numero: ctx.compte_produit,
      libelle: `Imputation acompte ${ref}`, debit: 0, credit: ht },
  ];
}

export interface ControleLignesVente {
  ok: boolean;
  /** Ce qui empêche l'insertion, en clair. Vide quand tout est conforme. */
  violations: string[];
  /** Écart de la partie double, en MAD (0 quand l'écriture est équilibrée). */
  ecart: number;
}

/**
 * Contrôle des écritures de vente AVANT insertion.
 *
 * Trois griefs, dans l'ordre de gravité :
 *   1. un CRÉDIT du 4191 sur une facture qui n'est pas un acompte — l'anomalie
 *      que cette chaîne existe pour empêcher ;
 *   2. l'absence de tout crédit de classe 7 sur une facture ordinaire ou de
 *      solde — le chiffre d'affaires n'apparaîtrait nulle part ;
 *   3. une partie double déséquilibrée.
 */
export function controlerLignesVente(
  lignes: LigneVente[], type: TypeFactureVente,
): ControleLignesVente {
  const violations: string[] = [];
  const estAcompte = type === "acompte";

  const creditAcompte = lignes.filter(
    (l) => String(l.compte_numero).startsWith(COMPTE_ACOMPTES_CLIENTS) && Number(l.credit) > 0.005,
  );
  if (!estAcompte && creditAcompte.length) {
    violations.push(
      `${creditAcompte.length} crédit(s) du compte ${COMPTE_ACOMPTES_CLIENTS} sur une facture de type « ${type} » : `
      + "seule une facture d'acompte constate une avance reçue.",
    );
  }

  const creditProduit = lignes.reduce(
    (s, l) => String(l.compte_numero).startsWith("7") ? s + Number(l.credit || 0) - Number(l.debit || 0) : s, 0);
  if (!estAcompte && r2(creditProduit) <= 0.005) {
    violations.push("Aucun produit de classe 7 crédité : le chiffre d'affaires de cette facture serait invisible.");
  }
  if (estAcompte && lignes.some((l) => String(l.compte_numero).startsWith("7"))) {
    violations.push("Une facture d'acompte ne constate aucun produit : le 4191 tient l'avance jusqu'à la facture de solde.");
  }

  const ecart = r2(lignes.reduce((s, l) => s + Number(l.debit || 0) - Number(l.credit || 0), 0));
  if (Math.abs(ecart) > 0.005) {
    violations.push(`Partie double déséquilibrée de ${ecart.toFixed(2)} MAD.`);
  }

  // Référentiel PCM, puis cohérence de chaque compte avec son RÔLE dans la pièce.
  violations.push(...controlerComptesPcm(lignes).violations);
  for (const l of lignes) {
    if (l.journal_code !== "VTE") continue;
    const c = String(l.compte_numero ?? "");
    if (Number(l.debit) > 0.005 && !validatePcmAccount(c, { usage: "client" }).ok) {
      violations.push(`Compte ${c} débité sur une vente : la créance se porte sur un compte client (342x).`);
    }
    const creditAutorise = c.startsWith(COMPTES_TVA.client.attente)
      || c.startsWith(COMPTE_ACOMPTES_CLIENTS)
      || validatePcmAccount(c, { usage: "produit" }).ok;
    if (Number(l.credit) > 0.005 && !creditAutorise) {
      violations.push(`Compte ${c} crédité sur une vente : ni produit de classe 7, ni TVA en attente `
        + `(${COMPTES_TVA.client.attente}), ni acompte (${COMPTE_ACOMPTES_CLIENTS}).`);
    }
  }

  return { ok: violations.length === 0, violations, ecart };
}

/**
 * Même contrôle, mais BLOQUANT. C'est la porte qu'emprunte le serveur : une
 * écriture de vente non conforme ne doit jamais atteindre la base, où elle
 * coûterait un script de reprise à défaire.
 */
export function assertLignesVente(lignes: LigneVente[], type: TypeFactureVente): void {
  const c = controlerLignesVente(lignes, type);
  if (!c.ok) throw new Error(`Écriture de vente non conforme — ${c.violations.join(" ")}`);
}
