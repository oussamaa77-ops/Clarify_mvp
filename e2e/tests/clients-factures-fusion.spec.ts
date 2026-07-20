import { test, expect } from "@playwright/test";
import { resolveDossier } from "../helpers/supabase";
import { CONFIG } from "../helpers/config";

// ─────────────────────────────────────────────────────────────────────────────
// Banc UI de la fusion « Factures » → section « Clients » (calquée sur la
// section Fournisseurs) + colonne Échéance sur les lignes de facture.
// Tests PUREMENT en lecture : navigation et vérification d'affichage, aucune
// écriture en base, donc aucun teardown.
// ─────────────────────────────────────────────────────────────────────────────

let dossierId: string;

test.beforeAll(async () => {
  dossierId = (await resolveDossier()).id;
});

test("l'ancienne route /factures redirige vers l'onglet Factures des Clients", async ({ page }) => {
  test.skip(!CONFIG.E2E_EMAIL, "E2E_EMAIL/E2E_PASSWORD non fournis → test UI ignoré.");

  await page.goto(`/dossiers/${dossierId}/factures`);
  await expect(page).toHaveURL(/\/clients\?vue=factures$/);
  await expect(page.getByRole("heading", { name: /^Clients$/i })).toBeVisible();

  // L'onglet Factures est bien celui qui est actif à l'arrivée.
  await expect(page.getByRole("tab", { name: /Factures/i })).toHaveAttribute("data-state", "active");
  await expect(page.getByRole("button", { name: /Nouvelle facture/i })).toBeVisible();
});

test("la section Clients expose les mêmes onglets que Fournisseurs", async ({ page }) => {
  test.skip(!CONFIG.E2E_EMAIL, "E2E_EMAIL/E2E_PASSWORD non fournis → test UI ignoré.");

  await page.goto(`/dossiers/${dossierId}/clients`);
  for (const onglet of [/Factures/i, /Annuaire/i, /Documents associés/i, /Balance âgée/i, /Reporting/i]) {
    await expect(page.getByRole("tab", { name: onglet })).toBeVisible();
  }

  // L'onglet Documents associés affiche la colonne des détails propres au type.
  await page.getByRole("tab", { name: /Documents associés/i }).click();
  await expect(page.getByRole("columnheader", { name: /Détails essentiels/i })).toBeVisible();
});

test("la colonne Échéance est présente sur les factures clients et fournisseurs", async ({ page }) => {
  test.skip(!CONFIG.E2E_EMAIL, "E2E_EMAIL/E2E_PASSWORD non fournis → test UI ignoré.");

  await page.goto(`/dossiers/${dossierId}/clients?vue=factures`);
  await expect(page.getByRole("columnheader", { name: /^Échéance$/ })).toBeVisible();

  await page.goto(`/dossiers/${dossierId}/fournisseurs`);
  await expect(page.getByRole("tab", { name: /Factures/i })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: /^Échéance$/ })).toBeVisible();
});
