// ============================================================================
// efacture.service.ts — moteur de la facturation électronique.
//
// C'est la couche qui SAIT tout : elle lit la facture en base, la traduit en
// document fiscal, la scelle, la transmet, et consigne chaque échange. Les
// modules qu'elle appelle, eux, ne savent rien du reste :
//
//   ubl-invoice      → construit le XML, sans base ni réseau
//   invoice-hash     → scelle, sans base ni réseau
//   facture-qrcode   → encode, sans base ni réseau
//   facture-pdfa3    → met en page, sans base ni réseau
//   dgi.connector    → parle à la plateforme, sans base
//
// Ce cloisonnement a un but précis : tout ce qui touche à la valeur probante
// (empreinte, ventilation TVA, structure UBL) est testable à l'unité, sans
// Supabase ni DGI. Seule cette couche-ci a besoin d'une base pour être exercée.
//
// ─── Ordre des opérations, et pourquoi il est immuable ───────────────────────
//   1. valider les identités  → un rejet DGI coûte une annulation + réémission
//   2. contrôler les totaux   → motif de rejet n° 1, détectable localement
//   3. sceller (hash)         → sur les montants RECALCULÉS, pas déclarés
//   4. construire l'UBL       → avec l'empreinte dedans
//   5. transmettre            → PENDING avant l'appel, jamais après
//
// L'étape 5 mérite un mot : on passe la facture en PENDING_DGI AVANT d'appeler
// la plateforme. Si le processus meurt pendant l'appel, la facture reste « en
// attente » — état vrai et rattrapable par `consulterStatutDgi`. L'ordre
// inverse laisserait une facture en « brouillon » alors qu'elle a peut-être été
// reçue et validée par la DGI : on la retransmettrait, et elle existerait deux
// fois au fichier fiscal.
// ─── MODULE STRICTEMENT SERVEUR ─────────────────────────────────────────────
// Il tire node:fs, node:crypto et node:module (police embarquée, scellement).
// Il ne doit JAMAIS être importé statiquement depuis un module que le
// navigateur atteint : le bundle client échouerait à la compilation sur des
// modules Node externalisés. Les server functions l'importent DYNAMIQUEMENT,
// à l'intérieur de leurs handlers — c'est ce qui garde le graphe client propre.
// ============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DgiConnectorInterface, DgiSubmitRequest } from "./dgi.connector";
import {
  ajouterAuJournal,
  construireFactureUbl,
  normaliserStatutDgi,
  presenterStatutDgi,
  peutTransmettre,
  resoudreIdentites,
  type DgiStatus,
  type EntreeJournal,
  type LigneFactureStockee,
} from "@/lib/efacture-mapping";
import { normaliserIdentites, validerEmission, type AnomalieFiscale } from "@/lib/fiscal-identifiers";
import { calculerHashFacture } from "@/lib/invoice-hash";
import {
  codePaiementUbl,
  construireUblXml,
  controlerProfilUbl,
  controlerTotaux,
  lireTotauxUbl,
  totauxFacture,
} from "@/lib/ubl-invoice";
import { genererQrPng } from "@/lib/facture-qrcode";
import { construirePdfA3 } from "@/lib/facture-pdfa3";

// `select("*")` volontaire : la migration e-facturation s'applique à la main
// (pas de CLI Supabase sur ce poste). Un select NOMMÉ sur une colonne pas
// encore créée fait répondre `data: null` sans erreur explicite — panne muette
// déjà rencontrée sur ce projet. L'étoile rapporte ce qui existe, et le code
// ci-dessous traite l'absence comme une absence.
export const SELECT_FACTURE =
  "*, clients(nom,ice,if_fiscal,rc,adresse,email,telephone), dossiers(nom_societe,ice,if_fiscal,rc,patente,adresse,email_societe,telephone)";

export interface ResultatEfacture {
  succes: boolean;
  statut: DgiStatus;
  dgi_uuid: string | null;
  hash_sha256: string | null;
  xml_ubl?: string;
  erreurs: AnomalieFiscale[] | { code: string; message: string; champ?: string }[];
  avertissements: string[];
  message: string;
}

/**
 * Service de facturation électronique.
 *
 * Reçoit ses dépendances plutôt que de les fabriquer : un test peut lui passer
 * un client Supabase doublé et un `MockDgiService` déterministe, ce qui serait
 * impossible s'il appelait `getSupabaseAdmin()` en interne.
 */
export class DgiEInvoicingService {
  constructor(
    private readonly sb: SupabaseClient,
    private readonly connecteur: DgiConnectorInterface,
    private readonly clefSecrete: string,
  ) {}

  // ─── Lecture ──────────────────────────────────────────────────────────────

  private async charger(factureId: string) {
    const { data, error } = await this.sb.from("factures").select(SELECT_FACTURE).eq("id", factureId).maybeSingle();
    if (error) throw new Error(`Lecture de la facture impossible : ${error.message}`);
    if (!data) throw new Error("Facture introuvable.");

    const facture = data as unknown as LigneFactureStockee & { dossier_id: string; client_id: string | null };
    const societe = (data as any).dossiers ?? null;
    const client = (data as any).clients ?? null;
    return { facture, societe, client };
  }

  /**
   * Écrit sur la facture en tolérant que la migration ne soit pas encore
   * appliquée. Les colonnes e-facturation s'ajoutent à la main dans le SQL
   * Editor : tant qu'elles manquent, on préfère écrire ce qui EXISTE et le dire
   * clairement, plutôt que de laisser l'utilisateur devant un « erreur
   * inconnue » sans rapport apparent avec une migration oubliée.
   */
  private async ecrire(
    factureId: string,
    champs: Record<string, unknown>,
    avertissements: string[],
  ): Promise<void> {
    const { error } = await this.sb.from("factures").update(champs).eq("id", factureId);
    if (!error) return;

    const manquante = error.message.match(/column "?([a-z_]+)"? .*does not exist|Could not find the '([a-z_]+)' column/i);
    if (!manquante) throw new Error(`Écriture de la facture impossible : ${error.message}`);

    const colonne = manquante[1] ?? manquante[2];
    avertissements.push(
      `La colonne « ${colonne} » n'existe pas encore en base : appliquez la migration ` +
        "supabase/migrations/20260817120000_efacture_dgi.sql dans le SQL Editor. " +
        "Les données de facturation électronique ne sont enregistrées que partiellement.",
    );

    // Repli sur le socle qui existe depuis le schéma initial.
    const socle: Record<string, unknown> = {};
    for (const clef of ["xml_ubl", "hash_sha256", "dgi_uuid", "dgi_response", "statut_dgi", "statut"]) {
      if (clef in champs) socle[clef] = champs[clef];
    }
    if (Object.keys(socle).length === 0) return;
    const repli = await this.sb.from("factures").update(socle).eq("id", factureId);
    if (repli.error) throw new Error(`Écriture de la facture impossible : ${repli.error.message}`);
  }

  private async journaliser(
    factureId: string,
    journalActuel: unknown,
    entrees: EntreeJournal[],
    avertissements: string[],
  ): Promise<void> {
    await this.ecrire(
      factureId,
      { dgi_response_payload: ajouterAuJournal(journalActuel, entrees) },
      avertissements,
    );
  }

  private async tracer(dossierId: string, factureId: string, action: string, details: unknown): Promise<void> {
    // L'audit ne doit JAMAIS faire échouer une émission : une facture
    // valablement transmise dont la trace n'a pas pu s'écrire reste transmise.
    try {
      await this.sb.from("audit_logs").insert({
        dossier_id: dossierId,
        action,
        ressource_type: "facture",
        ressource_id: factureId,
        details: details as any,
      });
    } catch (e) {
      console.warn("[e-facture] trace d'audit non enregistrée :", String(e));
    }
  }

  // ─── 1. Génération du document scellé ─────────────────────────────────────

  /**
   * Valide, scelle et construit le XML UBL — sans rien transmettre.
   *
   * Utilisable en aperçu : le comptable voit ce qui PARTIRA avant de décider.
   *
   * `journaliser: false` pour les usages de PURE LECTURE (afficher la facture
   * hybride à l'écran). Le journal doit raconter les échanges avec la DGI ; y
   * ajouter une ligne chaque fois qu'un utilisateur ouvre l'aperçu le rendrait
   * illisible au moment précis où il sert — expliquer un rejet.
   */
  async genererUbl(
    factureId: string,
    options: { journaliser?: boolean } = {},
  ): Promise<ResultatEfacture & { xml_ubl: string; totaux: ReturnType<typeof totauxFacture> }> {
    const avertissements: string[] = [];
    const { facture, societe, client } = await this.charger(factureId);

    // ─ Étape 1 : identités fiscales ─
    const identites = normaliserIdentites(resoudreIdentites(facture, societe, client));
    // Sans client rattaché, la vente est réputée faite à un particulier : c'est
    // le seul cas où l'absence d'ICE acheteur est légale.
    const b2c = !client;
    const verdict = validerEmission(identites, { b2c });
    avertissements.push(...verdict.avertissements.map((a) => a.message));

    if (!verdict.ok) {
      return {
        succes: false,
        statut: normaliserStatutDgi(facture.dgi_status ?? (facture as any).statut_dgi),
        dgi_uuid: facture.dgi_uuid ?? null,
        hash_sha256: facture.hash_sha256 ?? null,
        xml_ubl: "",
        totaux: totauxFacture([]),
        erreurs: verdict.erreurs,
        avertissements,
        message: "Identités fiscales incomplètes : la facture ne peut pas être émise en l'état.",
      };
    }

    // ─ Étape 2 : cohérence des totaux ─
    const factureUbl = construireFactureUbl({ ...facture, ...identites }, societe, client);
    const controle = controlerTotaux(factureUbl.lignes, {
      total_ht: Number(facture.montant_ht) || 0,
      total_tva: Number(facture.montant_tva) || 0,
      total_ttc: Number(facture.montant_ttc) || 0,
    });

    if (!controle.coherent) {
      return {
        succes: false,
        statut: normaliserStatutDgi(facture.dgi_status ?? (facture as any).statut_dgi),
        dgi_uuid: facture.dgi_uuid ?? null,
        hash_sha256: null,
        xml_ubl: "",
        totaux: controle.calcules,
        erreurs: controle.ecarts.map((e) => ({
          code: `ECART-${e.champ.toUpperCase()}`,
          champ: e.champ,
          message:
            e.champ === "identite"
              ? `HT + TVA = ${e.calcule} alors que le TTC enregistré vaut ${e.declare}. La DGI rejette systématiquement cette incohérence.`
              : `${e.champ} : ${e.declare} enregistré, ${e.calcule} recalculé depuis les lignes (écart ${e.ecart}).`,
        })),
        avertissements,
        message: "Les montants de la facture ne se recoupent pas — corrigez avant transmission.",
      };
    }

    // Le mode de règlement est DÉCLARÉ dans le document (`cac:PaymentMeans`).
    // Quand la facture n'en porte pas, ou en porte un que le vocabulaire ne
    // reconnaît pas (« autre »), le document annonce un virement : c'est une
    // affirmation que personne n'a faite, et elle doit être dite.
    const paiement = codePaiementUbl(factureUbl.mode_reglement);
    if (paiement.parDefaut) {
      const saisi = String((facture as any).mode_reglement ?? "").trim();
      avertissements.push(
        saisi
          ? `Mode de règlement « ${saisi} » non reconnu : le document déclare « ${paiement.libelle} » ` +
            `(code ${paiement.code}) par défaut. Corrigez le mode sur la facture si ce n'est pas l'instrument réel.`
          : `Aucun mode de règlement sur la facture : le document déclare « ${paiement.libelle} » ` +
            `(code ${paiement.code}) par défaut.`,
      );
    }

    // ─ Étape 3 : scellement ─
    // Sur les totaux RECALCULÉS : sceller un TTC déclaré qui diverge des lignes
    // figerait l'incohérence au lieu de la révéler.
    const hash = calculerHashFacture(
      {
        numero: factureUbl.numero,
        date_facture: factureUbl.date_facture,
        ice_vendeur: identites.ice_vendeur,
        ice_acheteur: identites.ice_acheteur,
        montant_ttc: controle.calcules.total_ttc,
      },
      this.clefSecrete,
    );

    // ─ Étape 4 : document UBL, empreinte comprise ─
    const xml = construireUblXml({ ...factureUbl, hash_sha256: hash });

    const statutActuel = normaliserStatutDgi(facture.dgi_status ?? (facture as any).statut_dgi);
    await this.ecrire(
      factureId,
      {
        ...identites,
        xml_ubl: xml,
        hash_sha256: hash,
        // Regénérer l'UBL d'une facture DÉJÀ validée ne la fait pas retomber en
        // brouillon : elle reste scellée côté DGI, seul son rendu est refait.
        ...(statutActuel === "DRAFT" ? { dgi_status: "DRAFT" } : {}),
      },
      avertissements,
    );

    if (options.journaliser !== false) {
      await this.journaliser(
        factureId,
        (facture as any).dgi_response_payload,
        [
          {
            sens: "requete",
            operation: "generateUbl",
            at: new Date().toISOString(),
            connecteur: this.connecteur.nom,
            payload: { numero: factureUbl.numero, empreinte: hash, taille_xml: xml.length },
          },
        ],
        avertissements,
      );
    }

    return {
      succes: true,
      statut: statutActuel,
      dgi_uuid: facture.dgi_uuid ?? null,
      hash_sha256: hash,
      xml_ubl: xml,
      totaux: controle.calcules,
      erreurs: [],
      avertissements,
      message: "Document UBL 2.1 généré et scellé.",
    };
  }

  /**
   * Document UBL À SERVIR — téléchargement, pièce jointe du PDF/A-3, archivage.
   *
   * ─── Le problème que cette méthode résout ─────────────────────────────────
   * Le XML d'une facture est ARCHIVÉ en base au scellement. Les factures
   * scellées avant l'entrée en vigueur des trois règles DGI portent donc
   * définitivement un document d'un constructeur précédent : ni
   * `ext:UBLExtensions`, ni identifiants légaux de l'émetteur, ni ventilation
   * de TVA à la racine. Servir `xml_ubl` tel quel — ce que faisait le bouton de
   * téléchargement — rend ces corrections invisibles pour toutes les factures
   * déjà émises, quel que soit l'état du constructeur.
   *
   * ─── Pourquoi refaire le document ne rompt PAS le scellement ──────────────
   * L'empreinte ne porte pas sur les octets du XML : elle porte sur la chaîne
   * canonique `numéro|date|ICE vendeur|ICE acheteur|TTC` (cf. invoice-hash.ts).
   * Reconstruire le rendu à partir des MÊMES faits scellés donne donc la même
   * empreinte, et le récépissé DGI reste vérifiable. C'est ce qui autorise la
   * mise à niveau ; l'inverse — un hash calculé sur le document — l'interdirait.
   *
   * ─── La limite, et elle est stricte ───────────────────────────────────────
   * Si la facture a BOUGÉ depuis son envoi, le document refait ne dirait plus
   * ce qui a été transmis. On compare donc le TTC du document archivé à celui
   * qu'on vient de reconstruire : au moindre écart, on rend l'ARCHIVE — c'est
   * elle qui fait foi — et on le dit en avertissement. Un document non conforme
   * mais authentique vaut mieux qu'un document conforme et faux.
   */
  async documentUbl(
    factureId: string,
    options: {
      /**
       * `false` pour SIMULER : le document est refait et rendu, mais rien n'est
       * réécrit en base. C'est ce que consomme le script de reprise en lot, qui
       * doit pouvoir montrer ce qu'il changerait — et sauvegarder l'existant —
       * avant d'y toucher. Sans cette option, un dry-run devrait redécider
       * ailleurs ce que cette méthode décide ici, et les deux divergeraient.
       */
      persister?: boolean;
    } = {},
  ): Promise<{
    xml_ubl: string;
    nom_fichier: string;
    /**
     * Sort de la facture, en un mot — les appelants n'ont pas à déduire d'un
     * booléen et d'un message ce qui s'est passé :
     *
     *   `genere`             brouillon : document construit à neuf ;
     *   `conforme`           l'archive suit déjà le profil courant ;
     *   `remis-a-niveau`     document refait et réécrit, scellement conservé ;
     *   `mentions-absentes`  le document est DÉJÀ celui que produit le
     *                        constructeur courant, mais des mentions légales
     *                        manquent parce que la FICHE (dossier ou client) ne
     *                        les porte pas. Rien à refaire ici : c'est la donnée
     *                        qu'il faut compléter, puis rééditer la facture ;
     *   `archive-figee`      la facture a bougé depuis sa transmission : on rend
     *                        le document TRANSMIS, seul à faire foi.
     *
     * Sans ce quatrième cas, une reprise en lot boucle : elle réécrit à chaque
     * passage un document qu'elle rejugera non conforme au suivant.
     */
    etat: "genere" | "conforme" | "remis-a-niveau" | "mentions-absentes" | "archive-figee";
    /** Vrai si le document a été refait au profil courant. */
    regenere: boolean;
    /** Ce qui manque au document — vide s'il est pleinement conforme. */
    motifs: string[];
    hash_sha256: string | null;
    dgi_uuid: string | null;
    statut: DgiStatus;
    avertissements: string[];
  }> {
    const { facture, societe, client } = await this.charger(factureId);
    const statut = normaliserStatutDgi(facture.dgi_status ?? (facture as any).statut_dgi);
    const factureUbl = construireFactureUbl(facture, societe, client);
    const nomFichier = `${factureUbl.numero.replace(/[^\w.-]+/g, "_")}-ubl.xml`;
    const archive = facture.xml_ubl ?? "";

    // Brouillon, ou jamais scellée : le document se construit à neuf, comme
    // avant toute émission. `genererUbl` fait foi ici — validation comprise.
    if (!archive || !facture.hash_sha256 || statut === "DRAFT") {
      if (options.persister === false) {
        // `genererUbl` SCELLE et écrit : il n'a pas de mode simulation, et lui en
        // ajouter un ferait exister une empreinte que rien ne conserve. Un appelant
        // qui simule s'intéresse aux factures DÉJÀ scellées ; sur un brouillon, il
        // n'y a rien à remettre à niveau.
        throw new Error(
          "Simulation impossible sur une facture non scellée : générer son document reviendrait à la sceller.",
        );
      }
      const prep = await this.genererUbl(factureId, { journaliser: false });
      if (!prep.succes) {
        const detail = (prep.erreurs as { message: string }[]).map((e) => e.message).join(" ");
        throw new Error(`Document UBL indisponible : ${detail}`);
      }
      return {
        xml_ubl: prep.xml_ubl,
        nom_fichier: nomFichier,
        etat: "genere",
        regenere: false,
        motifs: [],
        hash_sha256: prep.hash_sha256,
        dgi_uuid: prep.dgi_uuid,
        statut: prep.statut,
        avertissements: prep.avertissements,
      };
    }

    const controle = controlerProfilUbl(archive, { attendScellement: true });
    if (controle.conforme) {
      return {
        xml_ubl: archive,
        nom_fichier: nomFichier,
        etat: "conforme",
        regenere: false,
        motifs: [],
        hash_sha256: facture.hash_sha256 ?? null,
        dgi_uuid: facture.dgi_uuid ?? null,
        statut,
        avertissements: [],
      };
    }

    // Le rendu est refait sur les faits SCELLÉS : l'empreinte et le récépissé
    // déjà en base sont repris tels quels, jamais recalculés.
    const refait = construireUblXml({
      ...factureUbl,
      hash_sha256: facture.hash_sha256 ?? null,
      dgi_uuid: facture.dgi_uuid ?? null,
    });

    const totauxArchive = lireTotauxUbl(archive);
    const totauxRefait = lireTotauxUbl(refait);
    const derive =
      totauxArchive !== null &&
      totauxRefait !== null &&
      Math.abs(totauxArchive.total_ttc - totauxRefait.total_ttc) > 0.01;

    if (derive) {
      return {
        xml_ubl: archive,
        nom_fichier: nomFichier,
        etat: "archive-figee",
        regenere: false,
        motifs: controle.manquants,
        hash_sha256: facture.hash_sha256 ?? null,
        dgi_uuid: facture.dgi_uuid ?? null,
        statut,
        avertissements: [
          `Le document archivé ne suit pas le profil DGI courant (${controle.manquants.join(", ")}), ` +
            `mais la facture a été modifiée depuis sa transmission (TTC transmis ${totauxArchive!.total_ttc}, ` +
            `TTC actuel ${totauxRefait!.total_ttc}). C'est le document TRANSMIS qui est rendu : lui seul fait foi. ` +
            "Pour régulariser, annulez la facture et émettez un avoir.",
        ],
      };
    }

    // Le document refait est IDENTIQUE à l'archive : ce qui manque encore ne
    // vient pas d'un constructeur périmé mais d'une DONNÉE absente — un dossier
    // sans RC, un client sans ICE. UBL préfère l'absence au vide, donc la mention
    // n'est pas émise, et le contrôle de profil continue de la réclamer.
    //
    // Réécrire ici serait un travail sans fin : la reprise en lot rejugerait le
    // même document non conforme au passage suivant, écrirait la même chose, et
    // laisserait une trace d'audit à chaque tour. On dit plutôt CE QU'IL FAUT
    // FAIRE — compléter la fiche, puis rééditer la facture.
    if (refait === archive) {
      return {
        xml_ubl: archive,
        nom_fichier: nomFichier,
        etat: "mentions-absentes",
        regenere: false,
        motifs: controle.manquants,
        hash_sha256: facture.hash_sha256 ?? null,
        dgi_uuid: facture.dgi_uuid ?? null,
        statut,
        avertissements: [
          `Ce document est déjà celui que produit le constructeur courant, mais il lui manque : ` +
            `${controle.manquants.join(", ")}. Ces mentions sont absentes de la FICHE (dossier ou client), ` +
            "pas du document : complétez-les, puis rééditez la facture pour qu'elles y figurent.",
        ],
      };
    }

    const avertissements: string[] = [];
    // Réécrit en base : le PDF hybride, le QR et la GED doivent tous montrer le
    // même document. Le laisser en mémoire ferait diverger le téléchargement du
    // fichier embarqué dans le PDF.
    if (options.persister !== false) {
      await this.ecrire(factureId, { xml_ubl: refait }, avertissements);
      await this.tracer(facture.dossier_id, factureId, "efacture_ubl_remis_a_niveau", {
        manquants: controle.manquants,
        empreinte_conservee: facture.hash_sha256,
      });
    }

    return {
      xml_ubl: refait,
      nom_fichier: nomFichier,
      etat: "remis-a-niveau",
      regenere: true,
      motifs: controle.manquants,
      hash_sha256: facture.hash_sha256 ?? null,
      dgi_uuid: facture.dgi_uuid ?? null,
      statut,
      avertissements: [
        `Document remis au profil DGI courant (manquait : ${controle.manquants.join(", ")}). ` +
          "L'empreinte et le récépissé d'origine sont conservés : le scellement reste vérifiable.",
        ...avertissements,
      ],
    };
  }

  // ─── 2. Transmission ──────────────────────────────────────────────────────

  async transmettre(factureId: string): Promise<ResultatEfacture> {
    const { facture: avant } = await this.charger(factureId);
    const statutAvant = normaliserStatutDgi(avant.dgi_status ?? (avant as any).statut_dgi);

    // Une facture validée ou en cours de traitement ne se retransmet pas : la
    // renvoyer créerait un doublon au fichier fiscal, ou piétinerait un
    // traitement en cours.
    if (!peutTransmettre(statutAvant)) {
      return {
        succes: false,
        statut: statutAvant,
        dgi_uuid: avant.dgi_uuid ?? null,
        hash_sha256: avant.hash_sha256 ?? null,
        erreurs: [
          {
            code: "ETAT-INTERDIT",
            message:
              statutAvant === "VALIDATED_BY_DGI"
                ? "Cette facture est déjà validée par la DGI. Pour la corriger, annulez-la puis émettez un avoir."
                : statutAvant === "PENDING_DGI"
                  ? "Transmission déjà en cours. Utilisez « Actualiser le statut » pour connaître l'issue."
                  : "Cette facture a été annulée auprès de la DGI et ne peut plus être transmise.",
          },
        ],
        avertissements: [],
        message: "Transmission refusée dans cet état.",
      };
    }

    // Le document est TOUJOURS régénéré à la transmission : transmettre un XML
    // stocké il y a trois jours enverrait un document qui ne correspond plus
    // aux lignes si la facture a bougé entre-temps.
    const preparation = await this.genererUbl(factureId);
    if (!preparation.succes) return preparation;

    const { facture, societe, client } = await this.charger(factureId);
    const avertissements = [...preparation.avertissements];
    const factureUbl = construireFactureUbl(facture, societe, client);

    const requete: DgiSubmitRequest = {
      invoice_id: factureId,
      numero: factureUbl.numero,
      date_facture: factureUbl.date_facture,
      ice_vendeur: facture.ice_vendeur ?? null,
      ice_acheteur: facture.ice_acheteur ?? null,
      montant_ht: preparation.totaux.total_ht,
      montant_tva: preparation.totaux.total_tva,
      montant_ttc: preparation.totaux.total_ttc,
      xml_ubl: preparation.xml_ubl,
      hash_sha256: preparation.hash_sha256!,
    };

    // PENDING AVANT l'appel — cf. en-tête du fichier.
    await this.ecrire(
      factureId,
      { dgi_status: "PENDING_DGI", dgi_submission_at: new Date().toISOString() },
      avertissements,
    );

    const entrees: EntreeJournal[] = [
      {
        sens: "requete",
        operation: "submitInvoice",
        at: new Date().toISOString(),
        connecteur: this.connecteur.nom,
        // Le XML n'est pas recopié dans le journal : il pèse plusieurs kilo-
        // octets et vit déjà dans `xml_ubl`. On en garde l'empreinte et la
        // taille, de quoi prouver que c'est bien LUI qui est parti.
        payload: { ...requete, xml_ubl: `[${requete.xml_ubl.length} octets]` },
      },
    ];

    let reponse;
    try {
      reponse = await this.connecteur.submitInvoice(requete);
    } catch (e) {
      // Panne TECHNIQUE : on ne conclut pas au rejet. La DGI a peut-être reçu
      // et accepté la facture avant que la connexion ne tombe ; conclure au
      // rejet ici pousserait à retransmettre et à créer un doublon. On reste en
      // PENDING, état que `consulterStatutDgi` sait trancher.
      const message = e instanceof Error ? e.message : String(e);
      entrees.push({
        sens: "reponse",
        operation: "submitInvoice",
        at: new Date().toISOString(),
        connecteur: this.connecteur.nom,
        payload: { erreur_technique: message },
      });
      await this.journaliser(factureId, (facture as any).dgi_response_payload, entrees, avertissements);
      await this.tracer(facture.dossier_id, factureId, "efacture_erreur_technique", { message });

      return {
        succes: false,
        statut: "PENDING_DGI",
        dgi_uuid: null,
        hash_sha256: preparation.hash_sha256,
        erreurs: [
          {
            code: "DGI-INJOIGNABLE",
            message: `Plateforme DGI injoignable : ${message}. La facture reste « en attente » — actualisez son statut plus tard plutôt que de la retransmettre.`,
          },
        ],
        avertissements,
        message: "Transmission interrompue par un incident technique.",
      };
    }

    entrees.push({
      sens: "reponse",
      operation: "submitInvoice",
      at: reponse.horodatage,
      connecteur: this.connecteur.nom,
      payload: reponse.brut,
    });

    await this.ecrire(
      factureId,
      {
        dgi_status: reponse.statut,
        dgi_uuid: reponse.dgi_uuid,
        dgi_validated_at: reponse.statut === "VALIDATED_BY_DGI" ? reponse.horodatage : null,
        dgi_response: reponse.brut as any,
        ...(reponse.accepte ? { statut: "conforme" } : { statut: "rejetee" }),
      },
      avertissements,
    );
    await this.journaliser(factureId, (facture as any).dgi_response_payload, entrees, avertissements);
    await this.tracer(
      facture.dossier_id,
      factureId,
      reponse.accepte ? "efacture_transmise" : "efacture_rejetee",
      {
        connecteur: this.connecteur.nom,
        production: this.connecteur.production,
        dgi_uuid: reponse.dgi_uuid,
        erreurs: reponse.erreurs,
      },
    );

    if (!this.connecteur.production) {
      avertissements.push(
        "Récépissé émis par le BAC À SABLE (aucun accès DGI configuré) : il n'a aucune valeur fiscale.",
      );
    }

    return {
      succes: reponse.accepte,
      statut: reponse.statut,
      dgi_uuid: reponse.dgi_uuid,
      hash_sha256: preparation.hash_sha256,
      erreurs: reponse.erreurs,
      avertissements,
      message: reponse.accepte
        ? `Facture transmise et validée — récépissé ${reponse.dgi_uuid}.`
        : "La DGI a rejeté la facture.",
    };
  }

  // ─── 3. Consultation ──────────────────────────────────────────────────────

  async consulterStatut(factureId: string): Promise<ResultatEfacture> {
    const avertissements: string[] = [];
    const { facture } = await this.charger(factureId);

    if (!facture.dgi_uuid) {
      return {
        succes: false,
        statut: normaliserStatutDgi(facture.dgi_status ?? (facture as any).statut_dgi),
        dgi_uuid: null,
        hash_sha256: facture.hash_sha256 ?? null,
        erreurs: [{ code: "SANS-RECEPISSE", message: "Cette facture n'a pas encore de récépissé DGI à consulter." }],
        avertissements,
        message: "Aucun récépissé à consulter.",
      };
    }

    const reponse = await this.connecteur.checkStatus(facture.dgi_uuid);
    await this.ecrire(
      factureId,
      {
        dgi_status: reponse.statut,
        ...(reponse.valide_le ? { dgi_validated_at: reponse.valide_le } : {}),
      },
      avertissements,
    );
    await this.journaliser(
      factureId,
      (facture as any).dgi_response_payload,
      [
        {
          sens: "requete",
          operation: "checkStatus",
          at: new Date().toISOString(),
          connecteur: this.connecteur.nom,
          payload: { dgi_uuid: facture.dgi_uuid },
        },
        {
          sens: "reponse",
          operation: "checkStatus",
          at: reponse.horodatage,
          connecteur: this.connecteur.nom,
          payload: reponse.brut,
        },
      ],
      avertissements,
    );

    return {
      succes: reponse.erreurs.length === 0,
      statut: reponse.statut,
      dgi_uuid: facture.dgi_uuid,
      hash_sha256: facture.hash_sha256 ?? null,
      erreurs: reponse.erreurs,
      avertissements,
      message: reponse.erreurs.length === 0 ? "Statut actualisé auprès de la DGI." : "La DGI n'a pas reconnu ce récépissé.",
    };
  }

  // ─── 4. Annulation ────────────────────────────────────────────────────────

  async annuler(factureId: string, motif: string): Promise<ResultatEfacture> {
    const avertissements: string[] = [];
    const { facture } = await this.charger(factureId);

    if (!facture.dgi_uuid) {
      return {
        succes: false,
        statut: normaliserStatutDgi(facture.dgi_status ?? (facture as any).statut_dgi),
        dgi_uuid: null,
        hash_sha256: facture.hash_sha256 ?? null,
        erreurs: [
          {
            code: "SANS-RECEPISSE",
            message: "Cette facture n'a jamais été transmise : il n'y a rien à annuler côté DGI.",
          },
        ],
        avertissements,
        message: "Rien à annuler.",
      };
    }

    const reponse = await this.connecteur.cancelInvoice(facture.dgi_uuid, motif);
    if (reponse.annule) {
      await this.ecrire(factureId, { dgi_status: "CANCELLED_BY_DGI", statut: "annulee" }, avertissements);
    }
    await this.journaliser(
      factureId,
      (facture as any).dgi_response_payload,
      [
        {
          sens: "requete",
          operation: "cancelInvoice",
          at: new Date().toISOString(),
          connecteur: this.connecteur.nom,
          payload: { dgi_uuid: facture.dgi_uuid, motif },
        },
        {
          sens: "reponse",
          operation: "cancelInvoice",
          at: reponse.horodatage,
          connecteur: this.connecteur.nom,
          payload: reponse.brut,
        },
      ],
      avertissements,
    );
    await this.tracer(facture.dossier_id, factureId, "efacture_annulee", {
      dgi_uuid: facture.dgi_uuid,
      motif,
      annule: reponse.annule,
    });

    return {
      succes: reponse.annule,
      statut: reponse.statut,
      dgi_uuid: facture.dgi_uuid,
      hash_sha256: facture.hash_sha256 ?? null,
      erreurs: reponse.erreurs,
      avertissements,
      message: reponse.annule ? "Facture annulée auprès de la DGI." : "L'annulation a été refusée.",
    };
  }

  // ─── 5. Facture hybride PDF/A-3 ───────────────────────────────────────────

  async pdfA3(factureId: string): Promise<{
    pdf_base64: string;
    nom_fichier: string;
    conformite: "complete" | "degradee";
    avertissements: string[];
    /** Statut fiscal au moment du rendu — l'écran s'en sert pour son cartouche. */
    statut: DgiStatus;
    dgi_uuid: string | null;
    hash_sha256: string | null;
  }> {
    const { facture: avant } = await this.charger(factureId);
    const statutAvant = normaliserStatutDgi(avant.dgi_status ?? (avant as any).statut_dgi);

    // ─── Facture DÉJÀ SCELLÉE : on rend ce qui a été TRANSMIS ────────────────
    // Régénérer ici serait une faute. Si la facture a été modifiée après son
    // envoi, un nouveau scellement produirait un PDF portant une empreinte que
    // la DGI ne détient pas — et, pire, il ÉCRASERAIT en base l'empreinte
    // d'origine, rendant la facture transmise invérifiable. Le document
    // archivé fait foi ; l'afficher ne doit rien recalculer ni rien écrire.
    const dejaScellee = !!avant.xml_ubl && !!avant.hash_sha256 && statutAvant !== "DRAFT";

    const preparation = dejaScellee
      ? await (async () => {
          // Le XML embarqué passe par `documentUbl` et non par la colonne brute :
          // c'est ce qui fait que la pièce jointe du PDF hybride porte les mêmes
          // trois blocs DGI que le XML téléchargé. Ni l'empreinte ni le récépissé
          // n'y sont recalculés (cf. documentUbl) — le scellement est intact.
          const document = await this.documentUbl(factureId);
          return {
            succes: true as const,
            xml_ubl: document.xml_ubl,
            hash_sha256: avant.hash_sha256!,
            // Montants relus dans le document SERVI. Reprendre ceux de la ligne
            // en base ferait porter au QR un TTC que l'empreinte ne scelle pas —
            // ce qui ressemble, au contrôle, à une falsification.
            totaux: {
              ...totauxFacture(construireFactureUbl(avant, null, null).lignes),
              ...(lireTotauxUbl(document.xml_ubl) ?? {}),
            },
            avertissements: document.avertissements,
            erreurs: [] as { message: string }[],
          };
        })()
      : // Brouillon : le PDF est un APERÇU de ce qui partira. On scelle donc
        // pour de bon (l'empreinte doit être celle de l'envoi à venir), mais
        // sans journaliser — c'est un affichage, pas un échange (cf. genererUbl).
        await this.genererUbl(factureId, { journaliser: false });

    if (!preparation.succes) {
      const detail = (preparation.erreurs as { message: string }[]).map((e) => e.message).join(" ");
      throw new Error(`Facture non émettable : ${detail}`);
    }

    const { facture, societe, client } = await this.charger(factureId);
    const factureUbl = construireFactureUbl(facture, societe, client);
    const statut = normaliserStatutDgi(facture.dgi_status ?? (facture as any).statut_dgi);

    let qrPng: Uint8Array | null = null;
    try {
      qrPng = await genererQrPng({
        numero: factureUbl.numero,
        date_facture: factureUbl.date_facture,
        ice_vendeur: facture.ice_vendeur,
        ice_acheteur: facture.ice_acheteur,
        montant_ttc: preparation.totaux.total_ttc,
        montant_tva: preparation.totaux.total_tva,
        dgi_uuid: facture.dgi_uuid,
        hash_sha256: preparation.hash_sha256!,
      });
    } catch (e) {
      // Le QR est un confort de contrôle ; l'empreinte reste imprimée en clair.
      preparation.avertissements.push(`QR code non généré : ${e instanceof Error ? e.message : String(e)}`);
    }

    const nomFichier = `${factureUbl.numero.replace(/[^\w.-]+/g, "_")}.pdf`;
    const { pdf, conformite, avertissements } = await construirePdfA3(
      { ...factureUbl, hash_sha256: preparation.hash_sha256 },
      {
        xmlUbl: preparation.xml_ubl,
        qrPng,
        dgiUuid: facture.dgi_uuid,
        hashSha256: preparation.hash_sha256,
        // Le bandeau de statut est imprimé pour TOUS les états, pas seulement
        // « conforme » : un PDF sorti d'un brouillon doit dire qu'il en est un,
        // sans quoi il circule comme s'il avait été déclaré.
        statutDgi: presenterStatutDgi(statut).libelle,
        nomFichierXml: nomFichier.replace(/\.pdf$/, "-ubl.xml"),
      },
    );

    return {
      pdf_base64: Buffer.from(pdf).toString("base64"),
      nom_fichier: nomFichier,
      conformite,
      avertissements: [...preparation.avertissements, ...avertissements],
      statut,
      dgi_uuid: facture.dgi_uuid ?? null,
      hash_sha256: preparation.hash_sha256,
    };
  }
}

