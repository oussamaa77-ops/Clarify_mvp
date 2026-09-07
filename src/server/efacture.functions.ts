// ============================================================================
// efacture.functions.ts — surface appelée depuis l'interface.
//
// Coquille délibérément MINCE. Tout le métier vit dans `efacture.service.ts` ;
// ici on ne fait que valider l'entrée, appeler, rendre.
//
// ─── Pourquoi les imports sont DYNAMIQUES ────────────────────────────────────
// Ce module est importé par un composant React, donc par le navigateur. Le
// moteur, lui, tire `node:fs` (police embarquée dans le PDF), `node:crypto`
// (scellement) et `node:module` (résolution de la police). Un import STATIQUE
// les ferait entrer dans le graphe du bundle client, où Vite les externalise en
// modules vides : la compilation échoue alors sur un `createHmac is not
// exported by __vite-browser-external` — panne réelle, rencontrée sur ce
// chantier, et dont le message ne désigne pas la cause.
//
// Les `await import()` à l'intérieur des handlers résolvent cela proprement :
// le corps d'une server function n'est jamais expédié au navigateur, donc rien
// de tout cela n'atteint le client. Ne pas les remonter en tête de fichier,
// même « pour la lisibilité » : le build casserait à nouveau.
// ============================================================================

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { DgiStatus, EntreeJournal } from "@/lib/efacture-mapping";

/** Assemble le moteur avec ses dépendances de production. */
async function service() {
  const [{ DgiEInvoicingService }, { getSupabaseAdmin }, { obtenirConnecteurDgi }, { clefSecreteFacturation }] =
    await Promise.all([
      import("./efacture.service"),
      import("./supabase-admin"),
      import("./dgi.connector"),
      import("@/lib/invoice-hash"),
    ]);
  return new DgiEInvoicingService(getSupabaseAdmin(), obtenirConnecteurDgi(), clefSecreteFacturation());
}

const entree = z.object({ facture_id: z.string().uuid() });

export const genererUblFacture = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => entree.parse(input))
  .handler(async ({ data }) => (await service()).genererUbl(data.facture_id));

export const transmettreFactureDgi = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => entree.parse(input))
  .handler(async ({ data }) => (await service()).transmettre(data.facture_id));

export const consulterStatutDgi = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => entree.parse(input))
  .handler(async ({ data }) => (await service()).consulterStatut(data.facture_id));

export const annulerFactureDgi = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    entree
      .extend({
        // Motif exigé dès la frontière : la DGI le réclame, et un motif vide
        // ferait faire l'aller-retour réseau pour rien.
        motif: z.string().trim().min(5, "Motif d'annulation trop court (5 caractères minimum)."),
      })
      .parse(input),
  )
  .handler(async ({ data }) => (await service()).annuler(data.facture_id, data.motif));

/**
 * Document UBL à TÉLÉCHARGER.
 *
 * L'écran lisait auparavant la colonne `xml_ubl` renvoyée par
 * `journalDgiFacture` et la versait directement dans un blob. Le fichier obtenu
 * était donc l'archive telle quelle — y compris pour les factures scellées par
 * un constructeur antérieur aux règles DGI, sur lesquelles aucune correction du
 * code ne pouvait avoir d'effet. Le passage par le moteur remet le document au
 * profil courant quand c'est possible, sans jamais toucher au scellement
 * (cf. `DgiEInvoicingService.documentUbl`).
 */
export const telechargerUblFacture = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => entree.parse(input))
  .handler(async ({ data }) => (await service()).documentUbl(data.facture_id));

export const genererPdfA3Facture = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => entree.parse(input))
  .handler(async ({ data }) => (await service()).pdfA3(data.facture_id));

/** Aperçu du QR fiscal, en data URL — pour l'afficher sans télécharger le PDF. */
export const apercuQrFacture = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => entree.parse(input))
  .handler(async ({ data }) => {
    const [{ SELECT_FACTURE }, { getSupabaseAdmin }, mapping, { totauxFacture }, qrcode, hash] = await Promise.all([
      import("./efacture.service"),
      import("./supabase-admin"),
      import("@/lib/efacture-mapping"),
      import("@/lib/ubl-invoice"),
      import("@/lib/facture-qrcode"),
      import("@/lib/invoice-hash"),
    ]);

    const sb = getSupabaseAdmin();
    const { data: row } = await sb.from("factures").select(SELECT_FACTURE).eq("id", data.facture_id).maybeSingle();
    if (!row) throw new Error("Facture introuvable.");

    const facture = row as any;
    const factureUbl = mapping.construireFactureUbl(facture, facture.dossiers, facture.clients);
    const totaux = totauxFacture(factureUbl.lignes);
    const identites = mapping.resoudreIdentites(facture, facture.dossiers, facture.clients);

    const champs = {
      numero: factureUbl.numero,
      date_facture: factureUbl.date_facture,
      ice_vendeur: identites.ice_vendeur,
      ice_acheteur: identites.ice_acheteur,
      montant_ttc: totaux.total_ttc,
    };

    return {
      data_url: await qrcode.genererQrDataUrl({
        ...champs,
        montant_tva: totaux.total_tva,
        dgi_uuid: facture.dgi_uuid ?? null,
        // Une facture pas encore scellée n'a pas d'empreinte stockée : on la
        // calcule pour l'aperçu sans rien écrire, afin que le QR montré soit
        // exactement celui qui sera imprimé après émission.
        hash_sha256: facture.hash_sha256 ?? hash.calculerHashFacture(champs, hash.clefSecreteFacturation()),
      }),
    };
  });

export interface EtatDgiFacture {
  journal: EntreeJournal[];
  dgi_uuid: string | null;
  dgi_submission_at: string | null;
  dgi_validated_at: string | null;
  statut: DgiStatus;
  hash_sha256: string | null;
  xml_ubl: string | null;
  /** Nom du connecteur : sans lui, un récépissé simulé passe pour un vrai. */
  connecteur: string;
  production: boolean;
}

/** État fiscal complet d'une facture, journal des échanges compris. */
export const journalDgiFacture = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => entree.parse(input))
  .handler(async ({ data }): Promise<EtatDgiFacture> => {
    const [{ getSupabaseAdmin }, { obtenirConnecteurDgi }, { normaliserStatutDgi, reconstituerJournal }] = await Promise.all([
      import("./supabase-admin"),
      import("./dgi.connector"),
      import("@/lib/efacture-mapping"),
    ]);

    const sb = getSupabaseAdmin();
    // `select("*")` : les colonnes e-facturation s'ajoutent à la main. Un select
    // NOMMÉ répondrait `data: null` sans erreur explicite tant que la migration
    // n'est pas passée, et l'écran resterait sur son voile de chargement sans
    // que rien n'indique pourquoi.
    const { data: row, error } = await sb.from("factures").select("*").eq("id", data.facture_id).maybeSingle();
    if (error) throw new Error(`Lecture du journal impossible : ${error.message}`);
    if (!row) throw new Error("Facture introuvable.");

    const facture = row as any;
    const brut = facture.dgi_response_payload;
    const connecteur = obtenirConnecteurDgi();

    let journal: EntreeJournal[] = Array.isArray(brut) ? (brut as EntreeJournal[]) : [];

    // Journal absent : soit la facture est antérieure à sa mise en place, soit
    // la colonne n'existe pas encore. On le reconstitue depuis les traces
    // d'audit plutôt que d'afficher un vide qui ferait croire à une facture
    // jamais transmise (cf. reconstituerJournal).
    if (journal.length === 0) {
      const { data: traces } = await sb
        .from("audit_logs")
        .select("action,details,created_at")
        .eq("ressource_id", data.facture_id)
        .like("action", "efacture%")
        .order("created_at", { ascending: true });

      journal = reconstituerJournal(facture, (traces ?? []) as any[]);
    }

    return {
      journal,
      dgi_uuid: facture.dgi_uuid ?? null,
      dgi_submission_at: facture.dgi_submission_at ?? null,
      dgi_validated_at: facture.dgi_validated_at ?? null,
      statut: normaliserStatutDgi(facture.dgi_status ?? facture.statut_dgi),
      hash_sha256: facture.hash_sha256 ?? null,
      xml_ubl: facture.xml_ubl ?? null,
      connecteur: connecteur.nom,
      production: connecteur.production,
    };
  });
