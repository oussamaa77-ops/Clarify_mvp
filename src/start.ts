import { createStart } from "@tanstack/react-start";
import { accesMiddleware } from "@/server/acces.middleware";

// Middleware appliqué à TOUTES les server functions : authentification et
// cloisonnement par dossier. Voir src/server/acces.ts.
export const startInstance = createStart(() => ({
  functionMiddleware: [accesMiddleware],
}));
