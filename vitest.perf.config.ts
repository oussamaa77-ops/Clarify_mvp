import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// Config DÉDIÉE au banc de perf du pipeline IA (Mistral + Groq).
// Séparée de la suite unitaire (vitest.config.ts) car ce test fait de VRAIS
// appels réseau facturés (Mistral OCR + Groq) → on ne veut PAS qu'il tourne
// dans le `vitest` standard ni en CI.
//   Lancement : npx vitest run --config vitest.perf.config.ts
export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: { "@": path.resolve(here, "src") },
  },
  test: {
    environment: "node",
    include: ["e2e/perf/**/*.perf.ts"],
    // Les appels IA peuvent prendre 10–40 s ; warm-up + itérations compris.
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
