// Régénère src/integrations/supabase/types.ts SANS le CLI Supabase.
//
// Contexte : le CLI officiel `supabase gen types` est inaccessible derrière le
// proxy TLS d'entreprise (SELF_SIGNED_CERT_IN_CHAIN). Ce script contourne le
// problème en introspectant directement l'endpoint PostgREST `/rest/v1/`, qui
// expose un schéma OpenAPI décrivant toutes les tables/colonnes (même source de
// vérité que le CLI), puis le convertit au format `Database` de Supabase.
//
// Usage :  node scripts/gen-supabase-types.mjs
// Requiert dans .env : SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
// (la service_role est nécessaire pour introspecter le schéma complet).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Le proxy TLS d'entreprise présente un certificat auto-signé (SELF_SIGNED_CERT_IN_CHAIN)
// que undici/fetch refuse par défaut. On désactive la vérification UNIQUEMENT pour ce
// script de tooling local (équivalent de `curl -k`), jamais dans le code applicatif.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "src/integrations/supabase/types.ts");

// ─── Lecture .env (sans dépendance) ──────────────────────────────────────────
function readEnv() {
  const envPath = path.join(ROOT, ".env");
  const env = {};
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
    }
  }
  return { ...env, ...process.env };
}

const env = readEnv();
const URL = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error("❌ SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY requis dans .env");
  process.exit(1);
}

// ─── format PostgREST → type TS ──────────────────────────────────────────────
function tsType(prop) {
  if (prop.enum && Array.isArray(prop.enum))
    return prop.enum.map((v) => JSON.stringify(v)).join(" | ");
  const fmt = prop.format || "";
  const type = prop.type || "";
  if (type === "array") return `(${tsType(prop.items || {})})[]`;
  if (/^(bigint|integer|smallint|numeric|double precision|real|money|decimal)/.test(fmt)) return "number";
  if (type === "integer" || type === "number") return "number";
  if (type === "boolean" || fmt === "boolean") return "boolean";
  if (/^(json|jsonb)/.test(fmt)) return "Json";
  return "string";
}

function parseFk(desc) {
  const m = desc && desc.match(/<fk table='([^']+)' column='([^']+)'\/>/);
  return m ? { table: m[1], column: m[2] } : null;
}

const indent = (str, n) =>
  str.split("\n").map((l) => (l ? "  ".repeat(n) + l : l)).join("\n");

function build(defs) {
  const tables = Object.keys(defs).sort();
  const blocks = [];
  for (const table of tables) {
    const props = defs[table].properties || {};
    const required = new Set(defs[table].required || []);
    const row = [], ins = [], upd = [], rels = [];
    for (const col of Object.keys(props)) {
      const p = props[col];
      const t = tsType(p);
      const notNull = required.has(col);
      const rowT = notNull ? t : `${t} | null`;
      row.push(`${col}: ${rowT}`);
      ins.push(`${col}${!notNull || p.default !== undefined ? "?" : ""}: ${rowT}`);
      upd.push(`${col}?: ${rowT}`);
      const fk = parseFk(p.description);
      if (fk)
        rels.push(
          `{\n  foreignKeyName: ${JSON.stringify(`${table}_${col}_fkey`)}\n  columns: [${JSON.stringify(col)}]\n  isOneToOne: false\n  referencedRelation: ${JSON.stringify(fk.table)}\n  referencedColumns: [${JSON.stringify(fk.column)}]\n}`,
        );
    }
    const relBlock = rels.length ? `[\n${indent(rels.join(",\n"), 1)},\n]` : "[]";
    blocks.push(`${JSON.stringify(table)}: {
  Row: {
${indent(row.join("\n"), 2)}
  }
  Insert: {
${indent(ins.join("\n"), 2)}
  }
  Update: {
${indent(upd.join("\n"), 2)}
  }
  Relationships: ${relBlock}
}`);
  }
  return blocks;
}

const HEADER = `// ─────────────────────────────────────────────────────────────────────────────
// Types Supabase — GÉNÉRÉS depuis le schéma live PostgREST (OpenAPI) du projet.
//
// Le CLI officiel \`supabase gen types\` est inaccessible ici (proxy TLS d'entreprise
// → SELF_SIGNED_CERT_IN_CHAIN). Ces types sont régénérés à partir de l'endpoint REST
// introspectable \`/rest/v1/\` (même source de vérité que PostgREST).
//
// Régénérer :  node scripts/gen-supabase-types.mjs
// Ne pas éditer à la main.
// ─────────────────────────────────────────────────────────────────────────────

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  public: {
    Tables: {
`;

const FOOTER = `
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type PublicSchema = Database["public"];
export type Tables<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T]["Row"];
export type TablesInsert<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T]["Insert"];
export type TablesUpdate<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T]["Update"];
`;

// ─── Introspection + écriture ────────────────────────────────────────────────
const res = await fetch(`${URL.replace(/\/$/, "")}/rest/v1/`, {
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
});
if (!res.ok) {
  console.error(`❌ Introspection échouée : HTTP ${res.status}`);
  process.exit(1);
}
const spec = await res.json();
const defs = spec.definitions || {};
const blocks = build(defs);
fs.writeFileSync(OUT, HEADER + indent(blocks.join("\n"), 3) + FOOTER + "\n", "utf8");
console.log(`✅ ${blocks.length} tables → ${path.relative(ROOT, OUT)}`);
