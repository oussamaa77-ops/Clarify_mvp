// SPEC JETABLE — capture le rendu du panneau de liquidation TVA.
//
// Capture SEULEMENT : sur ce poste, le serveur de dev sert le HTML rendu côté
// serveur sans le script client (aucune balise <script src>), donc aucune page
// n'est hydratée et aucun clic n'a d'effet — y compris sur les pages existantes.
// Les interactions (modale, dépôt de quittance, pointage) sont couvertes par
// src/components/DeclarationTvaPanel.test.tsx, en jsdom.
import { test, expect } from "@playwright/test";

test("apercu liquidation tva", async ({ page }) => {
  await page.goto("/previewtva");
  await expect(page.getByText("Liquidation & paiement SIMPL-TVA").first()).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: "previewtva.png", fullPage: true });
});
