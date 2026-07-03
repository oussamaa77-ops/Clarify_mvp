import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import path from "path"; // Ajoute cet import si nécessaire

export default defineConfig({
  plugins: [
    tsconfigPaths(),
    tailwindcss(),
    tanstackStart({
      target: "node",
    }),
    react(),
  ],
  optimizeDeps: {
    exclude: ["pdfjs-dist"],
  },
  resolve: {
    alias: {
      // Force l'import à pointer vers le fichier ESM packagé
      "pdfjs-dist": "pdfjs-dist/build/pdf.mjs", 
    },
  },
  server: {
    host: "0.0.0.0",
    port: 3000,
  },
});