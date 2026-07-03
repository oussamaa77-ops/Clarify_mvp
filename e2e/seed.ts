// ════════════════════════════════════════════════════════════════════════════
// SEEDING & TEARDOWN — lot massif de transactions de test, 100 % isolées.
// Toutes les lignes injectées portent le préfixe CONFIG.TEST_PREFIX ("TEST_PERF")
// → teardown() les supprime intégralement (base locale laissée propre).
// ════════════════════════════════════════════════════════════════════════════
import crypto from "node:crypto";
import { admin, resolveDossier, resolveDossierId } from "./helpers/supabase";
import { CONFIG } from "./helpers/config";

export interface SeedResult {
  dossierId: string;
  dossierNom: string;
  compteId: string;
  /** tx orpheline UNIQUE (débit, clôturée) ≈6000 MAD → cible déterministe du Test UI */
  uiTargetTxId: string;
  /** montant exact de la cible UI (≈6000, garanti unique dans le dossier) */
  uiTargetAmount: number;
  /** tx orpheline dédiée au bombardement RPC (Test 2) — montant volontairement ≠ 6000 */
  rpcTxId: string;
  /** justificatif de test (p_doc_id du Test 2) */
  justificatifId: string;
  inserted: number;
}

const P = CONFIG.TEST_PREFIX;
const rndCents = () => Math.round((100 + Math.random() * 49900) * 100) / 100;
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const isoDate = (daysAgo: number) =>
  new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);

async function ensureTestCompte(dossierId: string): Promise<string> {
  const sb = admin();
  const { data: existing } = await sb
    .from("comptes_bancaires")
    .select("id")
    .eq("dossier_id", dossierId)
    .eq("intitule", CONFIG.TEST_COMPTE_INTITULE)
    .maybeSingle();
  if (existing) return (existing as any).id;

  const { data, error } = await sb
    .from("comptes_bancaires")
    .insert({
      dossier_id: dossierId,
      banque: "BANQUE_TEST",
      intitule: CONFIG.TEST_COMPTE_INTITULE,
      rib: "000000000000000000000000",
      solde_actuel: 0,
    })
    .select("id")
    .single();
  if (error) throw error;
  return (data as any).id;
}

// Choisit un montant ≈6000 garanti UNIQUE parmi les débits orphelins du dossier
// (évite toute collision avec la vraie donnée 6000.00 → lettrage déterministe).
async function uniqueOrphanDebitAmount(dossierId: string): Promise<number> {
  const sb = admin();
  const candidates = [6000.07, 6000.13, 6000.17, 6000.23, 6000.29, 6000.31, 6000.37, 6000.41, 6000.43, 6000.47];
  for (const amt of candidates) {
    const { count } = await sb
      .from("transactions_bancaires")
      .select("id", { count: "exact", head: true })
      .eq("dossier_id", dossierId)
      .eq("type", "debit")
      .eq("montant", amt)
      .is("facture_id", null)
      .is("justificatif_id", null);
    if ((count ?? 0) === 0) return amt;
  }
  return 6000.07;
}

export async function seed(): Promise<SeedResult> {
  const sb = admin();
  const { id: dossierId, nom: dossierNom } = await resolveDossier();
  const compteId = await ensureTestCompte(dossierId);
  const uiTargetAmount = await uniqueOrphanDebitAmount(dossierId);

  const base = (over: Record<string, any>) => ({
    dossier_id: dossierId,
    compte_id: compteId,
    date_operation: isoDate(Math.floor(Math.random() * 700)),
    type: "debit",
    rapproche: false,
    statut: "ouvert",
    facture_id: null,
    justificatif_id: null,
    ...over,
  });

  // ── Lignes pilotes (ids récupérés) ────────────────────────────────────────
  // (a) Cible UI : SEULE tx orpheline à `uiTargetAmount` (≈6000) → lettrage déterministe.
  const { data: uiRow, error: e1 } = await sb.from("transactions_bancaires")
    .insert(base({ libelle: `${P}_TARGET_${uiTargetAmount}`, montant: uiTargetAmount, statut: "cloture" }))
    .select("id").single();
  if (e1) throw e1;

  // (b) Cible RPC : orpheline, montant unique (le Test 2 cible par tx_id, pas par montant).
  const { data: rpcRow, error: e2 } = await sb.from("transactions_bancaires")
    .insert(base({ libelle: `${P}_RPC_7000`, montant: 7000, statut: "ferme" }))
    .select("id").single();
  if (e2) throw e2;

  // ── Lot massif (noise) ─────────────────────────────────────────────────────
  const bulk: any[] = [];

  // Doublons à 6000.00 — DÉJÀ lettrés (justificatif_id factice) → exclus des candidats,
  // prouvent que le filtre d'orphelinage isole bien la cible UI unique.
  for (let i = 0; i < 12; i++) {
    bulk.push(base({
      libelle: `${P}_DUP_6000_${i}`,
      montant: 6000,
      statut: pick(["ferme", "cloture"]),
      justificatif_id: crypto.randomUUID(), // marqué « déjà lettré »
      rapproche: true,
    }));
  }

  // Erreurs de centimes — orphelines, ne doivent JAMAIS matcher 6000.00 exact.
  for (const m of [6000.01, 5999.99, 6000.5, 5999.5, 6000.99]) {
    bulk.push(base({ libelle: `${P}_CENT_${m}`, montant: m, statut: pick(["ouvert", "cloture"]) }));
  }

  // Volume aléatoire (statuts actifs/clôturés, débit/crédit), en évitant 6000.00 pile.
  const remaining = Math.max(0, CONFIG.SEED_COUNT - bulk.length - 2);
  for (let i = 0; i < remaining; i++) {
    let m = rndCents();
    if (m === 6000) m = 6001;
    bulk.push(base({
      libelle: `${P}_NOISE_${i}`,
      montant: m,
      type: pick(["debit", "debit", "credit"]),
      statut: pick(["ouvert", "ferme", "cloture"]),
    }));
  }

  // Insertion par paquets de 500.
  for (let i = 0; i < bulk.length; i += 500) {
    const { error } = await sb.from("transactions_bancaires").insert(bulk.slice(i, i + 500));
    if (error) throw error;
  }

  // ── Justificatif de test (p_doc_id du Test 2) ──────────────────────────────
  const { data: jRow, error: e3 } = await sb.from("justificatifs")
    .insert({
      dossier_id: dossierId,
      type_document: "recu",
      flux_type: "achat",
      nom_tiers: `${P}_TENANT`,
      montant_ttc: 6000,
      montant_ht: 6000,
      montant_tva: 0,
      taux_tva: 0,
      compte_pcm: "61312",
      date_document: isoDate(1),
      numero_piece: `${P}_QUIT`,
      statut: "non_rapproche",
    })
    .select("id").single();
  if (e3) throw e3;

  return {
    dossierId,
    dossierNom,
    compteId,
    uiTargetTxId: (uiRow as any).id,
    uiTargetAmount,
    rpcTxId: (rpcRow as any).id,
    justificatifId: (jRow as any).id,
    inserted: bulk.length + 2,
  };
}

export async function teardown(dossierId: string): Promise<void> {
  const sb = admin();
  const like = `${P}%`;
  // Transactions de test
  await sb.from("transactions_bancaires").delete().eq("dossier_id", dossierId).like("libelle", like);
  // Justificatifs de test (par tiers OU n° pièce marqués)
  await sb.from("justificatifs").delete().eq("dossier_id", dossierId).like("nom_tiers", like);
  await sb.from("justificatifs").delete().eq("dossier_id", dossierId).like("numero_piece", like);
  // Écritures éventuelles marquées (défensif)
  await sb.from("ecritures_comptables").delete().eq("dossier_id", dossierId).like("reference_piece", like);
  // Compte bancaire de test (cascade sur ses transactions résiduelles)
  await sb.from("comptes_bancaires").delete().eq("dossier_id", dossierId).eq("intitule", CONFIG.TEST_COMPTE_INTITULE);
}

// Permet `node e2e/seed.ts --clean` pour un nettoyage manuel d'urgence.
if (process.argv[2] === "--clean") {
  resolveDossierId().then(teardown).then(() => {
    console.log("✅ Données de test supprimées.");
    process.exit(0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
