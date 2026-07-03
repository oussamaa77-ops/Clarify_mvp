import { test, expect } from "@playwright/test";
import crypto from "node:crypto";
import { seed, teardown, type SeedResult } from "../seed";
import { admin } from "../helpers/supabase";
import { CONFIG } from "../helpers/config";

// Banc de test du flux de lettrage sur STE SMART WATER.
// Mode SÉRIEL : les 2 tests partagent le lot seedé ; teardown global en afterAll.
test.describe.configure({ mode: "serial" });

let data: SeedResult;

test.beforeAll(async () => {
  data = await seed();
  console.log(
    `[seed] ${data.dossierNom} (${data.dossierId}) | ${data.inserted} tx injectées | ` +
    `cible UI=${data.uiTargetAmount} (${data.uiTargetTxId}) | rpcTx=${data.rpcTxId}`,
  );
});

test.afterAll(async () => {
  if (data?.dossierId) {
    await teardown(data.dossierId);
    console.log("[teardown] toutes les lignes TEST_PERF supprimées.");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 1 — UI-Driven Matching : création d'un justificatif → lettrage auto → UI
// ─────────────────────────────────────────────────────────────────────────────
test("Test 1 — UI : enregistrement justificatif → ligne lettrée (≈6000 MAD)", async ({ page }) => {
  test.skip(!CONFIG.E2E_EMAIL, "E2E_EMAIL/E2E_PASSWORD non fournis → test UI ignoré.");

  // 1) Accès authentifié + sélection du dossier (clic) — nom résolu dynamiquement.
  await page.goto("/");
  await expect(page).not.toHaveURL(/\/auth/, { timeout: 15_000 });
  const carte = page.getByText(data.dossierNom, { exact: false }).first();
  if (await carte.count()) await carte.click().catch(() => {});

  // 2) Onglet Justificatifs (navigation directe, robuste).
  await page.goto(`/dossiers/${data.dossierId}/justificatifs`);
  await expect(page.getByRole("heading", { name: /Justificatifs/i })).toBeVisible();

  // 3) Ouvre le dialog « Nouveau justificatif ».
  await page.getByRole("button", { name: /Ajouter manuellement/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/Nouveau justificatif/i)).toBeVisible();

  // 4) Renseigne tiers (marqué TEST_PERF → nettoyé) + montant exact de la cible.
  await dialog.getByPlaceholder("Fournisseur, client, prestataire…").fill(`${CONFIG.TEST_PREFIX}_UI_TENANT`);
  await dialog.getByRole("spinbutton").first().fill(String(data.uiTargetAmount)); // Montant TTC

  // 5) Enregistre → handleSave → lettrerJustificatif (candidat unique) → RPC + trigger.
  await dialog.getByRole("button", { name: /^Enregistrer$/ }).click();

  // 6a) Validation UI : toast de lettrage automatique.
  await expect(page.getByText(/Lettr[ée] automatiquement/i)).toBeVisible({ timeout: 25_000 });

  // 6b) Validation DB : la transaction cible porte désormais le justificatif (lettrée).
  await expect.poll(async () => {
    const { data: tx } = await admin()
      .from("transactions_bancaires")
      .select("justificatif_id, rapproche, statut")
      .eq("id", data.uiTargetTxId)
      .maybeSingle();
    return (tx as any)?.justificatif_id ? "lettree" : "orpheline";
  }, { timeout: 15_000, message: "La tx cible doit être lettrée après enregistrement" }).toBe("lettree");
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 2 — Stress / Concurrence RPC : idempotence + latence (objectif < 50ms)
// ─────────────────────────────────────────────────────────────────────────────
test("Test 2 — RPC lier_transaction : 1 seul gagnant sous bombardement parallèle", async () => {
  const K = CONFIG.STRESS_CONCURRENCY;
  const sb = admin();

  // Warm-up (établit la connexion TLS, exclut le cold-start des mesures).
  await sb.rpc("lier_transaction", {
    p_tx_id: crypto.randomUUID(),
    p_doc_id: crypto.randomUUID(),
    p_doc_kind: "justificatif",
  });

  // Bombardement : K appels SIMULTANÉS sur le MÊME p_tx_id.
  const fire = async () => {
    const t0 = performance.now();
    const { data: ok, error } = await sb.rpc("lier_transaction", {
      p_tx_id: data.rpcTxId,
      p_doc_id: data.justificatifId,
      p_doc_kind: "justificatif",
    });
    const ms = performance.now() - t0;
    if (error) throw error;
    return { ok: ok === true, ms };
  };

  const results = await Promise.all(Array.from({ length: K }, fire));

  // ── Idempotence : exactement UN gagnant ────────────────────────────────────
  const winners = results.filter((r) => r.ok).length;
  expect(winners, `${winners} succès sur ${K} appels concurrents (attendu : 1)`).toBe(1);

  // ── Latence : statistiques pour Allure ─────────────────────────────────────
  const lat = results.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (p: number) => lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))];
  const metrics = {
    concurrence: K,
    gagnants: winners,
    objectif_ms: CONFIG.PERF_MAX_MS,
    min_ms: +lat[0].toFixed(1),
    p50_ms: +pct(50).toFixed(1),
    p95_ms: +pct(95).toFixed(1),
    max_ms: +lat[lat.length - 1].toFixed(1),
    avg_ms: +(lat.reduce((s, x) => s + x, 0) / lat.length).toFixed(1),
    note: "Mesure bout-en-bout (réseau + RPC). L'objectif 50ms vise le temps serveur ; ajouter la latence cloud.",
  };

  await test.info().attach("rpc-perf-metrics.json", {
    body: JSON.stringify(metrics, null, 2),
    contentType: "application/json",
  });
  test.info().annotations.push(
    { type: "perf:idempotence", description: `${winners}/${K} gagnant` },
    { type: "perf:p50", description: `${metrics.p50_ms} ms` },
    { type: "perf:p95", description: `${metrics.p95_ms} ms (objectif ${CONFIG.PERF_MAX_MS} ms)` },
  );
  console.log("[perf]", JSON.stringify(metrics));

  // Objectif de latence : hard-fail uniquement si PERF_STRICT=1 (sinon reporté).
  if (CONFIG.PERF_STRICT) {
    expect(metrics.p50_ms, `p50 ${metrics.p50_ms}ms > objectif ${CONFIG.PERF_MAX_MS}ms`)
      .toBeLessThan(CONFIG.PERF_MAX_MS);
  }
});
