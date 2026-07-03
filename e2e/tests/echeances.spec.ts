import { test, expect, type Locator } from "@playwright/test";
import { resolveDossier } from "../helpers/supabase";
import { CONFIG } from "../helpers/config";

// ─────────────────────────────────────────────────────────────────────────────
// Banc UI du composant <EcheancesInput> (tranches de paiement partiel).
// Test PUREMENT client-side : on exerce le widget dans le dialog « Nouvelle
// facture » sans jamais soumettre → aucune écriture en base, aucun teardown.
// Le dossier est seulement résolu (lecture) pour construire l'URL de la page.
// ─────────────────────────────────────────────────────────────────────────────

let dossierId: string;
let dossierNom: string;

test.beforeAll(async () => {
  const d = await resolveDossier();
  dossierId = d.id;
  dossierNom = d.nom;
});

// Ouvre la page Factures clients + le dialog de création, renseigne une ligne
// pour obtenir un TTC connu (1000 HT × 20% = 1200 TTC), puis renvoie le dialog.
async function openFactureDialog(page: import("@playwright/test").Page): Promise<Locator> {
  await page.goto("/");
  await expect(page).not.toHaveURL(/\/auth/, { timeout: 15_000 });
  const carte = page.getByText(dossierNom, { exact: false }).first();
  if (await carte.count()) await carte.click().catch(() => {});

  await page.goto(`/dossiers/${dossierId}/factures`);
  await expect(page.getByRole("heading", { name: /Factures clients/i })).toBeVisible();

  await page.getByRole("button", { name: /Nouvelle facture/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/Créer une facture/i)).toBeVisible();

  // Ligne → TTC = 1200,00 MAD (1000 HT + 20% TVA)
  await dialog.getByPlaceholder("PU HT").first().fill("1000");
  await expect(dialog.getByText(/TTC:.*200,00 MAD/)).toBeVisible();
  return dialog;
}

test("EcheancesInput — ajout/pré-remplissage/suppression d'une tranche", async ({ page }) => {
  test.skip(!CONFIG.E2E_EMAIL, "E2E_EMAIL/E2E_PASSWORD non fournis → test UI ignoré.");

  const dialog = await openFactureDialog(page);
  const section = dialog.getByTestId("echeances-input");
  await expect(section).toBeVisible();

  // État initial : aucune tranche, message « non fractionné », pas de récap.
  await expect(section.getByTestId("echeance-row")).toHaveCount(0);
  await expect(section.getByText(/non fractionné/i)).toBeVisible();
  await expect(section.getByTestId("echeances-recap")).toHaveCount(0);

  // Ajout d'une tranche → 1 ligne, montant pré-rempli = reste dû (= TTC 1200),
  // donc « Réparti intégralement » et pas de dépassement.
  await section.getByRole("button", { name: /Ajouter une tranche de paiement/i }).click();
  await expect(section.getByTestId("echeance-row")).toHaveCount(1);
  await expect(section.getByTestId("echeance-montant").first()).toHaveValue("1200");
  const recap = section.getByTestId("echeances-recap");
  await expect(recap).toHaveAttribute("data-overflow", "false");
  await expect(section.getByTestId("echeances-status")).toContainText(/Réparti intégralement/i);

  // La date d'échéance est pré-remplie (défaut +30j) → format YYYY-MM-DD non vide.
  await expect(section.getByTestId("echeance-date").first()).not.toHaveValue("");

  // Suppression → retour à l'état vide.
  await section.getByTestId("echeance-remove").first().click();
  await expect(section.getByTestId("echeance-row")).toHaveCount(0);
  await expect(section.getByText(/non fractionné/i)).toBeVisible();
});

test("EcheancesInput — alerte visuelle quand la somme dépasse le TTC", async ({ page }) => {
  test.skip(!CONFIG.E2E_EMAIL, "E2E_EMAIL/E2E_PASSWORD non fournis → test UI ignoré.");

  const dialog = await openFactureDialog(page);
  const section = dialog.getByTestId("echeances-input");

  // Une tranche, montant forcé au-delà du TTC (2000 > 1200) → alerte rouge.
  await section.getByRole("button", { name: /Ajouter une tranche de paiement/i }).click();
  await section.getByTestId("echeance-montant").first().fill("2000");

  const recap = section.getByTestId("echeances-recap");
  await expect(recap).toHaveAttribute("data-overflow", "true");
  await expect(section.getByTestId("echeances-status")).toContainText(/Dépassement/i);

  // Correction sous le TTC (500) → l'alerte disparaît, reste à répartir affiché.
  await section.getByTestId("echeance-montant").first().fill("500");
  await expect(recap).toHaveAttribute("data-overflow", "false");
  await expect(section.getByTestId("echeances-status")).toContainText(/Reste à répartir/i);

  // Multi-tranches : ajout d'une 2ᵉ tranche → 2 lignes.
  await section.getByRole("button", { name: /Ajouter une tranche de paiement/i }).click();
  await expect(section.getByTestId("echeance-row")).toHaveCount(2);
});
