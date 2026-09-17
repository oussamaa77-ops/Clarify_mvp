import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Configuration SÉPARÉE pour la Clarify Golden Audit Suite.
//
// Pourquoi ne pas simplement élargir le `include` de vitest.config.ts : parce que
// `npm test` doit rester ce qu'il est — une suite unitaire pure, hors ligne, qui
// tourne en quelques secondes et qu'on peut lancer cent fois par jour. Les tests
// de ce dossier, eux, écrivent dans une VRAIE base Supabase et éprouvent des
// verrous concurrents ; les mêler ferait dépendre le moindre `npm test` du réseau
// et du dossier étalon, et le runner `audit:full` les exécuterait deux fois.
//
// `fileParallelism: false` est essentiel : la batterie de cas invalides et le
// stress de concurrence visent le MÊME dossier étalon. En parallèle, le
// nettoyage de l'un effacerait les lignes que l'autre vient d'écrire, et les
// deux échoueraient pour une raison qui ne concerne ni l'un ni l'autre.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    fileParallelism: false,
    // Un aller-retour Supabase derrière le proxy d'entreprise dépasse largement
    // les 5 s par défaut : le délai porte sur le réseau, pas sur la logique.
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
