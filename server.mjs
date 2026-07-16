// ============================================================================
// server.mjs — point d'entrée de PRODUCTION (hôte Node : Railway / Render / Fly).
//
// TanStack Start (cette version) ne produit PAS de serveur qui écoute : `vite build`
// génère `dist/client/` (assets statiques) + `dist/server/server.js` qui EXPORTE un
// handler « fetch » Web (server.fetch(request) → Response) sans l'exposer sur un port.
// Ce fichier fournit ce chaînon manquant : un serveur HTTP Node qui
//   1. sert les fichiers statiques de dist/client (assets, worker PDF, logos…),
//   2. délègue tout le reste (SSR + fonctions serveur) au handler fetch.
//
// Lancement : `node server.mjs` (le script `npm start`). Écoute sur $PORT (Railway
// l'injecte) ou 3000 par défaut, sur 0.0.0.0.
// ============================================================================
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import serverEntry from "./dist/server/server.js";

const CLIENT_DIR = join(process.cwd(), "dist", "client");
const PORT = Number(process.env.PORT) || 3000;

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".map": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon", ".avif": "image/avif",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".wasm": "application/wasm",
  ".txt": "text/plain", ".pdf": "application/pdf",
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);

    // 1) Fichier statique de dist/client (jamais pour "/", qui est rendu par le SSR).
    if ((req.method === "GET" || req.method === "HEAD") && pathname !== "/") {
      const filePath = normalize(join(CLIENT_DIR, pathname));
      if (filePath.startsWith(CLIENT_DIR)) {
        try {
          const s = await stat(filePath);
          if (s.isFile()) {
            const body = await readFile(filePath);
            res.writeHead(200, {
              "content-type": MIME[extname(filePath).toLowerCase()] || "application/octet-stream",
              "cache-control": "public, max-age=31536000, immutable",
            });
            res.end(req.method === "HEAD" ? undefined : body);
            return;
          }
        } catch { /* pas un fichier → on tombe sur le SSR */ }
      }
    }

    // 2) SSR + fonctions serveur via le handler fetch de TanStack Start.
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    const request = new Request(`http://${req.headers.host || "localhost"}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body,
    });

    const response = await serverEntry.fetch(request);

    // Recopie des en-têtes (set-cookie inclus).
    const headers = {};
    for (const [k, v] of response.headers) headers[k] = v;
    res.writeHead(response.status, headers);

    if (response.body) Readable.fromWeb(response.body).pipe(res);
    else res.end();
  } catch (err) {
    console.error("[server] erreur:", err);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("Internal Server Error");
  }
});

// IMPORTANT (Railway/Fly…) : on n'impose PAS l'hôte. Node bind alors sur `::`
// (IPv6 dual-stack) qui accepte AUSSI l'IPv4. Un bind explicite "0.0.0.0" est
// IPv4-only : comme Railway route son trafic interne en IPv6, le conteneur
// devient injoignable → « Application failed to respond » alors que le serveur
// tourne. Écouter sans hôte règle ce cas tout en restant compatible IPv4.
server.listen(PORT, () => {
  console.log(`▶ HisabPro en écoute sur le port ${PORT}`);
});
