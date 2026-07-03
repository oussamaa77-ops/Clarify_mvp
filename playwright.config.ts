import { defineConfig, devices } from "@playwright/test";
import { CONFIG } from "./e2e/helpers/config";

// Contournement du proxy TLS d'entreprise (cert auto-signé → SELF_SIGNED_CERT_IN_CHAIN)
// pour TOUT le banc e2e : ce module est évalué par le runner principal ET ré-importé
// dans chaque worker, donc la variable est posée partout où du code Node appelle
// Supabase. Réservé aux tests (équivalent `curl -k`) ; un override explicite est gardé.
process.env.NODE_TLS_REJECT_UNAUTHORIZED ??= "0";

// Banc E2E + perf connecté à l'app locale (Vite, http://localhost:3000).
// Exécution SÉRIELLE (workers=1) : les tests partagent un état DB seedé/teardown.
export default defineConfig({
  testDir: "./e2e/tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },

  reporter: [
    ["line"],
    ["allure-playwright", { resultsDir: "allure-results", detail: true }],
  ],

  use: {
    baseURL: CONFIG.BASE_URL,
    storageState: CONFIG.AUTH_STATE, // produit par global-setup
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },

  globalSetup: "./e2e/global-setup.ts",

  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],

  // Réutilise l'app si elle tourne déjà ; sinon la démarre.
  // PW_NO_SERVER=1 → désactive (utile pour un run RPC-only sans l'UI).
  webServer: process.env.PW_NO_SERVER
    ? undefined
    : {
        command: "npm run dev",
        url: CONFIG.BASE_URL,
        reuseExistingServer: true,
        timeout: 180_000,
        stdout: "ignore",
        stderr: "pipe",
        // Le serveur dev exécute les server functions (appels Supabase côté Node) :
        // il démarre avant globalSetup, donc on lui transmet explicitement le bypass TLS.
        env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? "0" },
      },
});
