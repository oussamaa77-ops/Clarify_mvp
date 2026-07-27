/**
 * Mémoire des comptes par TIERS — test d'intégration de la séquence complète :
 *   a) validation d'une facture fournisseur ICE '002345678000012' → compte '44110005'
 *   b) nouveau scan d'un 2e document portant le MÊME ICE
 *   c) le compte proposé doit être '44110005', PAS le générique
 *
 * On branche la VRAIE fonction de rappel (`rappelerMemoire`) et le VRAI moteur
 * (`suggestAccount`) sur un faux client Supabase en mémoire, qui reproduit le
 * comportement PostgREST utilisé : `.select().eq()…limit().maybeSingle()`.
 * Ce qui est testé, ce sont bien les règles de production — seul le transport
 * réseau est simulé.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { rappelerMemoire, normalizeLibelle } from "./tiers-memoire.functions";
import { suggestAccount, COMPTE_CHARGE_DEFAUT, COMPTE_PRODUIT_DEFAUT } from "@/lib/categorization-engine";
import { compteTiersAuxiliaire } from "@/lib/comptes-auxiliaires";

const DOSSIER = "11111111-1111-1111-1111-111111111111";
const ICE_FOURN = "002345678000012";
const COMPTE_AUX_FOURN = "44110005";
const ICE_CLIENT = "001987654000078";
const COMPTE_AUX_CLIENT = "34210002";

// ── Faux Supabase : une table `tiers_memoire` en mémoire ─────────────────────
type Row = Record<string, any>;
let table: Row[] = [];

const fakeSb = {
  from(_t: string) {
    const filters: [string, any][] = [];
    const chain: any = {
      select: () => chain,
      eq: (col: string, val: any) => { filters.push([col, val]); return chain; },
      limit: () => chain,
      maybeSingle: async () => ({
        data: table.find((r) => filters.every(([c, v]) => r[c] === v)) ?? null,
        error: null,
      }),
      then: (res: any) => res({ data: table.filter((r) => filters.every(([c, v]) => r[c] === v)), error: null }),
    };
    return chain;
  },
} as any;

/**
 * Écrit en mémoire ce que `memoriserTiers` écrit en base à la validation d'une
 * facture (mêmes clés : `cle_ice` normalisé + `cle_libelle` normalisé).
 */
function validerFacture(p: { sens: "fournisseur" | "client"; ice: string; nom: string; compte_pcm: string; taux_tva?: number }) {
  const cle_ice = p.ice.replace(/\s+/g, "").trim();
  const cle_libelle = normalizeLibelle(p.nom);
  const existing = table.find((r) => r.sens === p.sens && r.cle_libelle === cle_libelle && r.dossier_id === DOSSIER);
  if (existing) {
    existing.occurrences += 1;
    existing.compte_pcm = p.compte_pcm;
    existing.cle_ice = cle_ice;
    return;
  }
  table.push({
    id: `mem-${table.length + 1}`, dossier_id: DOSSIER, sens: p.sens,
    cle_ice, cle_libelle, compte_pcm: p.compte_pcm, categorie_pcm: null,
    taux_tva: p.taux_tva ?? 20, occurrences: 1, type_tiers: p.sens,
  });
}

/**
 * Rejoue le pré-remplissage d'un scan : rappel mémoire (serveur) puis moteur de
 * catégorisation (UI). `compteDefautTiers` = colonne du tiers, laissée vide ici
 * exprès — c'est tout l'enjeu : le comptable n'a PAS cliqué « définir par défaut ».
 */
async function scanner(p: {
  sens: "fournisseur" | "client"; ice?: string | null; nom: string;
  description?: string; secteur?: string | null; compteDefautTiers?: string | null;
}) {
  const hit = await rappelerMemoire(fakeSb, { dossier_id: DOSSIER, sens: p.sens, ice: p.ice, nom: p.nom });
  const sug = suggestAccount({
    sens: p.sens === "fournisseur" ? "charge" : "produit",
    compteDefautTiers: p.compteDefautTiers ?? null,
    compteMemoireTiers: hit?.compte_pcm ?? null,
    description: p.description ?? "",
    nomTiers: p.nom,
    secteurActivite: p.secteur ?? null,
  });
  return { hit, sug };
}

beforeEach(() => { table = []; });

describe("mémoire des comptes par tiers — achats (ICE fournisseur)", () => {
  it("séquence a→b→c : le 2e scan du même ICE rend '44110005', pas le générique", async () => {
    // — a) 1re facture validée avec le compte auxiliaire saisi à la main
    validerFacture({ sens: "fournisseur", ice: ICE_FOURN, nom: "SOCIETE ALPHA SARL", compte_pcm: COMPTE_AUX_FOURN });

    // — b) 2e document scanné, même ICE (libellé OCR légèrement différent)
    const { hit, sug } = await scanner({ sens: "fournisseur", ice: ICE_FOURN, nom: "Sté ALPHA S.A.R.L." });

    // — c) assertions
    expect(hit).not.toBeNull();
    expect(hit!.match_kind).toBe("ice");     // rappel par la clé FORTE
    expect(hit!.par_ice).toBe(true);
    expect(sug.compte).toBe(COMPTE_AUX_FOURN);
    expect(sug.compte).not.toBe("4411");
    expect(sug.compte).not.toBe(COMPTE_CHARGE_DEFAUT);
    expect(sug.source).toBe("memoire_tiers");
  });

  it("sans mémoire, le même scan retombe bien sur le générique (preuve que le test a du mordant)", async () => {
    const { hit, sug } = await scanner({ sens: "fournisseur", ice: ICE_FOURN, nom: "SOCIETE ALPHA SARL" });
    expect(hit).toBeNull();
    expect(sug.compte).toBe(COMPTE_CHARGE_DEFAUT);
    expect(sug.source).toBe("defaut");
  });

  it("le compte mémorisé passe DEVANT les mots-clés et le secteur", async () => {
    validerFacture({ sens: "fournisseur", ice: ICE_FOURN, nom: "ALPHA TELECOM", compte_pcm: COMPTE_AUX_FOURN });
    // « telecom » (mots-clés → 61455) ET secteur Services IT sont présents : la
    // mémoire du tiers doit malgré tout l'emporter.
    const { sug } = await scanner({
      sens: "fournisseur", ice: ICE_FOURN, nom: "ALPHA TELECOM",
      description: "Abonnement internet fibre", secteur: "Services IT",
    });
    expect(sug.compte).toBe(COMPTE_AUX_FOURN);
    expect(sug.source).toBe("memoire_tiers");
  });

  it("le compte CONFIGURÉ sur le tiers reste prioritaire sur la mémoire", async () => {
    validerFacture({ sens: "fournisseur", ice: ICE_FOURN, nom: "SOCIETE ALPHA SARL", compte_pcm: COMPTE_AUX_FOURN });
    const { sug } = await scanner({
      sens: "fournisseur", ice: ICE_FOURN, nom: "SOCIETE ALPHA SARL",
      compteDefautTiers: "61455",       // choix explicite du comptable sur la fiche
    });
    expect(sug.compte).toBe("61455");
    expect(sug.source).toBe("tiers");
  });

  it("un ICE DIFFÉRENT ne récupère pas le compte du voisin", async () => {
    validerFacture({ sens: "fournisseur", ice: ICE_FOURN, nom: "SOCIETE ALPHA SARL", compte_pcm: COMPTE_AUX_FOURN });
    const { hit, sug } = await scanner({ sens: "fournisseur", ice: "009999999000099", nom: "AUTRE FOURNISSEUR" });
    expect(hit).toBeNull();
    expect(sug.compte).toBe(COMPTE_CHARGE_DEFAUT);
  });

  it("ICE saisi avec des espaces : la clé est normalisée avant lookup", async () => {
    validerFacture({ sens: "fournisseur", ice: ICE_FOURN, nom: "SOCIETE ALPHA SARL", compte_pcm: COMPTE_AUX_FOURN });
    const { hit } = await scanner({ sens: "fournisseur", ice: "0023 4567 8000 012", nom: "PEU IMPORTE" });
    expect(hit?.compte_pcm).toBe(COMPTE_AUX_FOURN);
  });

  it("sans ICE, le repli par LIBELLÉ normalisé retrouve le compte", async () => {
    validerFacture({ sens: "fournisseur", ice: ICE_FOURN, nom: "SOCIETE ALPHA SARL", compte_pcm: COMPTE_AUX_FOURN });
    const { hit, sug } = await scanner({ sens: "fournisseur", ice: null, nom: "Société  Alpha, SARL" });
    expect(hit?.match_kind).toBe("libelle");
    expect(hit?.par_ice).toBe(false);
    expect(sug.compte).toBe(COMPTE_AUX_FOURN);
  });

  it("une 2e validation avec un AUTRE compte écrase la mémoire (dernière décision du comptable)", async () => {
    validerFacture({ sens: "fournisseur", ice: ICE_FOURN, nom: "SOCIETE ALPHA SARL", compte_pcm: COMPTE_AUX_FOURN });
    validerFacture({ sens: "fournisseur", ice: ICE_FOURN, nom: "SOCIETE ALPHA SARL", compte_pcm: "44110009" });
    const { hit, sug } = await scanner({ sens: "fournisseur", ice: ICE_FOURN, nom: "SOCIETE ALPHA SARL" });
    expect(hit?.occurrences).toBe(2);
    expect(sug.compte).toBe("44110009");
  });
});

describe("mémoire des comptes par tiers — ventes (ICE client)", () => {
  it("le compte auxiliaire client '34210002' est rappelé par ICE", async () => {
    validerFacture({ sens: "client", ice: ICE_CLIENT, nom: "NEXUS RETAIL MAGHREB SARL", compte_pcm: COMPTE_AUX_CLIENT });
    const { hit, sug } = await scanner({ sens: "client", ice: ICE_CLIENT, nom: "Nexus Retail Maghreb" });
    expect(hit?.match_kind).toBe("ice");
    expect(sug.compte).toBe(COMPTE_AUX_CLIENT);
    expect(sug.compte).not.toBe(COMPTE_PRODUIT_DEFAUT);
    expect(sug.source).toBe("memoire_tiers");
  });

  it("les mémoires client et fournisseur ne se mélangent pas (même ICE, sens différent)", async () => {
    validerFacture({ sens: "fournisseur", ice: ICE_FOURN, nom: "MIXTE SARL", compte_pcm: COMPTE_AUX_FOURN });
    const { hit } = await scanner({ sens: "client", ice: ICE_FOURN, nom: "MIXTE SARL" });
    expect(hit).toBeNull();          // cloisonnement par `sens`
  });
});

// ─── Relecture VENTES : le scan client applique le compte mémorisé ────────────
// Miroir de ce que fait désormais ocrFacture (rappel sens="client" sur ice_client)
// + FacturesClientsPanel (application via compteMemoireTiers).
describe("relecture ventes — scan d'une facture client", () => {
  it("2e facture pour le même ICE client : compte '34210002' rappelé, pas 7111", async () => {
    validerFacture({ sens: "client", ice: ICE_CLIENT, nom: "NEXUS RETAIL MAGHREB SARL", compte_pcm: COMPTE_AUX_CLIENT });
    const { hit, sug } = await scanner({
      sens: "client", ice: ICE_CLIENT, nom: "NEXUS RETAIL",
      description: "Prestation de maintenance", secteur: "Services IT",
    });
    expect(hit?.par_ice).toBe(true);
    expect(sug.compte).toBe(COMPTE_AUX_CLIENT);
    expect(sug.compte).not.toBe(COMPTE_PRODUIT_DEFAUT);   // 7111
    expect(sug.compte).not.toBe("7124");                  // ni le repli sectoriel
  });

  it("client inconnu : le repli sectoriel garde la main", async () => {
    const { sug } = await scanner({ sens: "client", ice: "000000000000000", nom: "NOUVEAU CLIENT", secteur: "Services IT" });
    expect(sug.compte).toBe("7124");
    expect(sug.source).toBe("secteur");
  });
});

// ─── Imputation de l'AUXILIAIRE sur la ligne de tiers ─────────────────────────
describe("pièce complète : compte mémorisé + auxiliaire du tiers", () => {
  it("achat : ligne charge mémorisée + TVA + tiers auxiliaire", async () => {
    validerFacture({ sens: "fournisseur", ice: ICE_FOURN, nom: "ALPHA SARL", compte_pcm: "6133" });
    const { sug } = await scanner({ sens: "fournisseur", ice: ICE_FOURN, nom: "ALPHA SARL" });
    const piece = [
      { compte: sug.compte, debit: 1000 },
      { compte: "34552", debit: 200 },
      { compte: compteTiersAuxiliaire("fournisseur", "F0005"), credit: 1200 },
    ];
    expect(piece.map((l) => l.compte)).toEqual(["6133", "34552", "44110005"]);
    expect(piece.reduce((s, l) => s + (l.debit ?? 0), 0)).toBe(piece.reduce((s, l) => s + (l.credit ?? 0), 0));
  });

  it("vente : tiers auxiliaire + produit mémorisé + TVA collectée", async () => {
    validerFacture({ sens: "client", ice: ICE_CLIENT, nom: "NEXUS", compte_pcm: "7124" });
    const { sug } = await scanner({ sens: "client", ice: ICE_CLIENT, nom: "NEXUS" });
    const piece = [
      { compte: compteTiersAuxiliaire("client", "C0002"), debit: 1200 },
      { compte: sug.compte, credit: 1000 },
      { compte: "44551", credit: 200 },
    ];
    expect(piece.map((l) => l.compte)).toEqual(["34210002", "7124", "44551"]);
    expect(piece.reduce((s, l) => s + (l.debit ?? 0), 0)).toBe(piece.reduce((s, l) => s + (l.credit ?? 0), 0));
  });
});
