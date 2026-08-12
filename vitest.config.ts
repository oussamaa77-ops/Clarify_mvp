import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

// Deux familles de tests cohabitent :
//   • `*.test.ts`  — logique pure et fonctions serveur, en environnement Node ;
//   • `*.test.tsx` — composants React, en jsdom.
//
// Faire tourner TOUT sous jsdom coûterait plusieurs secondes par fichier pour
// des tests qui ne touchent jamais le DOM ; `environmentMatchGlobs` garde donc
// le node par défaut et ne bascule que sur les fichiers de composants.
export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Deux fichiers `.tsx` traînent depuis le commit initial et n'ont jamais
    // tourné : la configuration ne ramassait que `*.test.ts`. Ils ne collectent
    // même pas — l'un importe un export par défaut qui n'existe pas et un paquet
    // absent, l'autre ne contient aucun test. Les exclure NOMMÉMENT plutôt que
    // de restreindre le glob : le jour où ils sont réparés ou supprimés, la
    // ligne saute et rien d'autre ne bouge.
    exclude: [
      "**/node_modules/**", "**/dist/**",
      "src/routes/_app/dossiers.$dossierId.factures.test.tsx",
      "src/routes/_app/dossiers.$dossierId.fournisseurs.test.tsx",
    ],
    environmentMatchGlobs: [["src/**/*.test.tsx", "jsdom"]],
    setupFiles: ["src/test/setup-dom.ts"],
  },
});
