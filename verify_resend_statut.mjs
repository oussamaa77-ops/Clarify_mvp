// Statut de LIVRAISON d'un message Resend déjà accepté (HTTP 200 ≠ délivré).
// Usage : node verify_resend_statut.mjs <id-du-message>
import { readFileSync } from "node:fs";
import { fetch as uf, Agent } from "undici";

const ID = process.argv[2];
if (!ID) { console.error("Usage : node verify_resend_statut.mjs <id>"); process.exit(2); }

const env = {};
for (const l of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const KEY = (env.RESEND_API_KEY ?? "").trim();
const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });

const res = await uf(`https://api.resend.com/emails/${ID}`, {
  headers: { authorization: `Bearer ${KEY}` },
  dispatcher,
});
const brut = await res.text();
console.log(`HTTP ${res.status}`);
try {
  const j = JSON.parse(brut);
  console.log(JSON.stringify(j, null, 2));
  if (j.last_event) console.log(`\n→ DERNIER ÉVÉNEMENT : ${j.last_event}`);
} catch {
  console.log(brut.slice(0, 2000));
}
