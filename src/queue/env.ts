// env.ts — charge .env dans process.env pour le PROCESS WORKER autonome.
// (Le serveur TanStack charge déjà l'env via `dotenv -e .env` dans le script dev ;
//  ce module ne sert qu'au worker lancé par `tsx src/queue/document-worker.ts`.)
// Importer ce fichier EN PREMIER dans le worker.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

try {
  // Racine projet = deux niveaux au-dessus de src/queue/.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const envPath = path.join(root, ".env");
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (!(k in process.env)) process.env[k] = v;
  }
} catch {
  // .env absent (prod : variables déjà injectées) → on continue.
}
