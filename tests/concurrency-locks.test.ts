// ============================================================================
// tests/concurrency-locks.test.ts — STRESS ACID (niveau 5).
//
// ─── La question posée ───────────────────────────────────────────────────────
// Une facture de 10 000 MAD, entièrement due. Vingt appels SIMULTANÉS enregistrent
// chacun un règlement de 10 000. Combien passent ?
//
// La réponse doit être UN. Pas dix-neuf refus polis suivis d'un vingtième qui se
// glisse : un seul règlement enregistré, 10 000 encaissés, et dix-neuf erreurs.
//
// ─── Pourquoi ce test ne peut pas être un test unitaire ──────────────────────
// La règle « la somme des règlements ne dépasse pas le TTC » est déjà vérifiée
// par `examinerPaiements` (moteur) et par le trigger `paiements_valider` (base),
// et la batterie de cas invalides les éprouve tous les deux. Elle passe. Elle
// passe pourtant TOUJOURS en séquentiel, parce que chaque appel voit ce que le
// précédent a écrit.
//
// En PARALLÈLE, ce n'est plus vrai. Sous l'isolation READ COMMITTED — celle de
// PostgreSQL par défaut, celle de Supabase — vingt transactions ouvertes en même
// temps lisent chacune un instantané où AUCUNE des dix-neuf autres n'a encore
// commité. Le `SELECT SUM(montant)` du trigger rend 0 pour toutes. Le contrôle
// de non-dépassement ne s'arme même pas (il ne mord qu'à partir du deuxième
// règlement), et les vingt lignes s'insèrent. La facture affiche 200 000 MAD
// encaissés pour 10 000 dus.
//
// Aucune relecture du code ne montre ce défaut : chaque ligne est correcte prise
// isolément. Seule une exécution concurrente le révèle — d'où ce fichier.
//
// ─── Ce qui doit tenir, et où ───────────────────────────────────────────────
// Le verrou ne peut pas vivre dans l'application : quatre chemins écrivent dans
// `paiements`. Il vit dans le TRIGGER, qui pose un `FOR UPDATE` sur la ligne de
// la facture avant de compter. Les vingt transactions se mettent alors en file
// derrière la même ligne, la première commite, les dix-neuf suivantes lisent son
// écriture et se voient refusées.
//
// ISOLATION : une facture dédiée, créée et détruite par ce fichier. Elle ne
// participe à aucune écriture comptable — le stress porte sur le verrou, pas sur
// le grand livre, et polluer l'étalon fausserait le banc d'audit.
// ============================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  clientGolden, diagnostic, etatVerrous, exigerDossierGolden, exigerVerrous,
  messageErreur, MIGRATION_CONCURRENCE, nb, r2, txt,
  type DossierGolden, type EtatVerrous,
} from "./golden/harness";
import { CLIENT_GOLDEN } from "./golden/scenario";

const { sb } = clientGolden();

/** Nombre d'appels lancés d'un coup. Vingt : assez pour perdre la course, pas pour noyer la base. */
const CONCURRENCE = 20;
const MONTANT = 10000;
const TTC = 10000;
const NUMERO = "FA-GOLD-CONCURRENCE";
const DATE_FACTURE = "2026-02-02";
const DATE_REGLEMENT = "2026-02-10";

let dossier: DossierGolden;
let verrous: EtatVerrous;
let clientId = "";
let factureId = "";

beforeAll(async () => {
  dossier = await exigerDossierGolden(sb);
  verrous = await etatVerrous();

  const { data: cli } = await sb.from("clients").select("id")
    .eq("dossier_id", dossier.id).eq("nom", CLIENT_GOLDEN.nom).maybeSingle();
  clientId = txt(cli?.id) || "";

  // Repartir d'un état propre même après une exécution interrompue : la facture
  // de stress est identifiée par son numéro, jamais par un id mémorisé.
  await purgerFactureDeStress();

  const { data, error } = await sb.from("factures").insert({
    dossier_id: dossier.id, client_id: clientId || null, numero: NUMERO,
    type: "facture", statut: "brouillon", date_facture: DATE_FACTURE,
    montant_ht: 8333.33, montant_tva: 1666.67, montant_ttc: TTC,
    montant_paye: 0, montant_restant: TTC,
    // `brouillon` : elle ne doit PAS entrer dans le rapprochement CA ⇄ classe 7
    // du banc d'audit, puisqu'elle n'a délibérément aucune écriture
    // (cf. STATUTS_NON_COMPTABILISABLES dans coherence-ventes.ts). Une facture
    // de stress qui fausserait l'audit serait un comble.
    notes: "Facture de stress ACID — créée et détruite par tests/concurrency-locks.test.ts",
  }).select("id").single();
  if (error) throw new Error(`Création de la facture de stress : ${messageErreur(error)}`);
  factureId = txt(data.id);
}, 120_000);

async function purgerFactureDeStress(): Promise<void> {
  const { data } = await sb.from("factures").select("id")
    .eq("dossier_id", dossier.id).eq("numero", NUMERO);
  for (const f of (data ?? []) as any[]) {
    await sb.from("paiements").delete().eq("facture_id", f.id);
    await sb.from("ecritures_comptables").delete().eq("facture_id", f.id);
    await sb.from("factures").delete().eq("id", f.id);
  }
}

/** L'état de la facture tel que la BASE le voit, après la bagarre. */
async function etatFacture(): Promise<{ paye: number; restant: number; statut: string; nbPaiements: number; cumul: number }> {
  const { data: f } = await sb.from("factures")
    .select("montant_paye,montant_restant,statut_paiement").eq("id", factureId).single();
  const { data: p } = await sb.from("paiements").select("montant").eq("facture_id", factureId);
  const lignes = (p ?? []) as any[];
  return {
    paye: r2(nb(f?.montant_paye)),
    restant: r2(nb(f?.montant_restant)),
    statut: txt(f?.statut_paiement),
    nbPaiements: lignes.length,
    // Le cumul RÉEL des lignes, indépendamment de ce que les colonnes affichent :
    // c'est lui qui dit si la base a laissé passer un double encaissement, une
    // colonne pouvant très bien être juste au-dessus de lignes fausses.
    cumul: r2(lignes.reduce((s, x) => s + nb(x.montant), 0)),
  };
}

describe(`${CONCURRENCE} règlements simultanés sur une facture de ${MONTANT} MAD`, () => {
  it("la RPC atomique `enregistrer_reglement` existe en base", async () => {
    // Sans elle, il n'y a pas de transaction unique à mettre en concurrence :
    // l'application retomberait sur la séquence insert-puis-relecture, qui n'est
    // atomique à aucun moment. Le message distingue « migration non appliquée »
    // de « régression du code » — les confondre fait chercher un bug inexistant.
    exigerVerrous(verrous, MIGRATION_CONCURRENCE);
    expect(verrous.enregistrerReglement).toBe(true);
  });

  it("un seul appel est retenu, et le cumul ne dépasse jamais le TTC", async () => {
    const tirs = Array.from({ length: CONCURRENCE }, (_, i) =>
      sb.rpc("enregistrer_reglement", {
        p_dossier: dossier.id,
        p_facture: factureId,
        p_kind: "client",
        p_montant: MONTANT,
        p_date: DATE_REGLEMENT,
        p_origine: "manuel",
        p_transaction: null,
        p_encaissement: null,
        // Références DISTINCTES : avec la même, l'index unique de la saisie
        // manuelle suffirait à départager et le test ne prouverait rien du
        // verrou de non-dépassement. On veut vingt règlements que rien ne
        // distingue SAUF leur montant cumulé.
        p_reference: `CONCURRENCE-${String(i).padStart(2, "0")}`,
      }).then((r: any) => ({ ok: !r.error, message: messageErreur(r.error) })),
    );

    const issues = await Promise.all(tirs);
    const acceptes = issues.filter((x) => x.ok);
    const refuses = issues.filter((x) => !x.ok);
    const etat = await etatFacture();

    const rapport =
      `\n  acceptés : ${acceptes.length} · refusés : ${refuses.length}`
      + `\n  lignes en base : ${etat.nbPaiements} · cumul : ${etat.cumul} MAD pour ${TTC} dus`
      + `\n  facture : payé ${etat.paye} · restant ${etat.restant} · statut ${etat.statut}`
      + (refuses.length ? `\n  premier refus : ${refuses[0].message}` : "")
      + diagnostic(verrous, MIGRATION_CONCURRENCE);

    // L'invariant CENTRAL. Il porte sur les lignes réellement en base, et non
    // sur le nombre d'appels réussis : c'est le cumul qui fait la comptabilité.
    expect(etat.cumul, `Surpaiement concurrentiel : la base a accepté ${etat.cumul} MAD `
      + `de règlements pour ${TTC} MAD dus.${rapport}`).toBeLessThanOrEqual(TTC + 1);

    expect(etat.nbPaiements, `Un seul des ${CONCURRENCE} appels doit produire une ligne.${rapport}`)
      .toBe(1);
    expect(acceptes.length, `Un seul appel doit réussir.${rapport}`).toBe(1);
    expect(refuses.length).toBe(CONCURRENCE - 1);
  }, 180_000);

  it("la facture reste cohérente : payé + restant = TTC", async () => {
    const etat = await etatFacture();
    const d = diagnostic(verrous, MIGRATION_CONCURRENCE);
    expect(r2(etat.paye + etat.restant), `payé ${etat.paye} + restant ${etat.restant}${d}`)
      .toBeCloseTo(TTC, 2);
    expect(etat.paye, `un règlement, et un seul, doit avoir été retenu${d}`).toBeCloseTo(MONTANT, 2);
    expect(etat.statut, `statut « ${etat.statut} »${d}`).toBe("payee");
  });

  it("rejouer la MÊME pièce est idempotent, et ne double pas le règlement", async () => {
    // L'idempotence est l'autre moitié de l'atomicité : un réessai après une
    // coupure réseau doit rendre l'état existant, pas créer un second règlement.
    // Elle se prouve sur la PIÈCE — transaction ou encaissement —, seul
    // identifiant qu'un réessai conserve.
    const avant = await etatFacture();
    const rejeu = await Promise.all(Array.from({ length: 5 }, () =>
      sb.rpc("enregistrer_reglement", {
        p_dossier: dossier.id, p_facture: factureId, p_kind: "client",
        p_montant: MONTANT, p_date: DATE_REGLEMENT, p_origine: "manuel",
        p_transaction: null, p_encaissement: null, p_reference: "CONCURRENCE-REJEU",
      }).then((r: any) => ({ ok: !r.error, message: messageErreur(r.error) })),
    ));
    const apres = await etatFacture();

    expect(apres.nbPaiements, `Le rejeu a créé ${apres.nbPaiements - avant.nbPaiements} `
      + `ligne(s) de plus. Réponses : ${JSON.stringify(rejeu)}`
      + diagnostic(verrous, MIGRATION_CONCURRENCE)).toBe(avant.nbPaiements);
    expect(apres.cumul).toBeCloseTo(avant.cumul, 2);
  }, 120_000);
});

afterAll(async () => {
  await purgerFactureDeStress();
  // Contre-épreuve : la facture de stress ne doit laisser AUCUNE trace, sans
  // quoi le banc d'audit trouverait une pièce sans écritures et un règlement
  // sans contrepartie — deux anomalies fabriquées par le test lui-même.
  const { data } = await sb.from("factures").select("id")
    .eq("dossier_id", dossier.id).eq("numero", NUMERO);
  if ((data ?? []).length) {
    throw new Error("La facture de stress n'a pas pu être supprimée : le dossier étalon est pollué.");
  }
}, 120_000);
