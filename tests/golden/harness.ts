// ============================================================================
// tests/golden/harness.ts — la plomberie commune de la Clarify Golden Audit Suite.
//
// Trois consommateurs, une seule plomberie : le semeur du dossier étalon
// (`scripts/seed-golden-dossier.ts`), la batterie de cas invalides
// (`tests/accounting-chaos.test.ts`) et le stress de concurrence
// (`tests/concurrency-locks.test.ts`). S'ils ouvraient chacun leur client
// Supabase, ils finiraient par viser trois bases différentes sans que rien ne le
// dise.
//
// ─── Ce que ce module NE fait PAS ────────────────────────────────────────────
// Il ne bouchonne rien. La suite tourne sur la VRAIE base, parce que les
// invariants qu'elle vérifie — verrous, index uniques, sérialisation des
// transactions — n'existent que là. Un faux client Supabase rendrait tous les
// tests verts sans rien prouver : c'est exactement le mode de défaillance qu'on
// cherche à éliminer.
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** `.env` lu à la main : les scripts de ce projet ne passent pas par Vite. */
export function chargerEnv(): Record<string, string> {
  const fichier = path.join(ROOT, ".env");
  if (!fs.existsSync(fichier)) return { ...process.env } as Record<string, string>;
  const depuisFichier = Object.fromEntries(
    fs.readFileSync(fichier, "utf8")
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
      }),
  ) as Record<string, string>;
  // L'environnement PRIME sur le fichier : c'est ainsi qu'une CI injecte ses
  // propres identifiants sans réécrire le dépôt.
  return { ...depuisFichier, ...(process.env as Record<string, string>) };
}

// Le proxy TLS d'entreprise fait échouer le `fetch` global. Même repli undici
// que le reste du projet (cf. src/server/lettrage-compta.functions.ts) : sans
// lui, chaque test remonterait une panne réseau opaque qu'on prendrait pour un
// échec d'invariant.
let PROXY_DIRECT = false;
export async function proxyFetch(input: any, init?: any): Promise<any> {
  const direct = async () => {
    const { fetch: uf, Agent } = await import("undici");
    return (uf as any)(String(input), {
      ...init, dispatcher: new Agent({ connect: { rejectUnauthorized: false } }),
    });
  };
  if (PROXY_DIRECT) return direct();
  try { return await fetch(String(input), init); }
  catch { PROXY_DIRECT = true; return direct(); }
}

export interface ClientGolden {
  sb: any;
  env: Record<string, string>;
}

let cache: ClientGolden | null = null;

/**
 * Client Supabase en clé de SERVICE.
 *
 * La clé de service, et pas la publiable : la suite doit pouvoir écrire dans le
 * dossier étalon et surtout LIRE les refus des verrous sans que RLS ne les
 * masque derrière un « 0 ligne » indiscernable d'un rejet métier.
 */
export function clientGolden(): ClientGolden {
  if (cache) return cache;
  const env = chargerEnv();
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL || "";
  const key = env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont requis pour la Golden Audit Suite. "
      + "Elle s'exécute sur la vraie base : sans identifiants, il n'y a rien à vérifier.",
    );
  }
  const sb = createClient(url, key, {
    global: { fetch: proxyFetch as any },
    auth: { persistSession: false, autoRefreshToken: false },
  }) as any;
  cache = { sb, env };
  return cache;
}

// ─── Le dossier étalon ───────────────────────────────────────────────────────

export const NOM_DOSSIER_GOLDEN = "TEST-CLARIFY-GOLDEN";

export interface DossierGolden {
  id: string;
  nom_societe: string;
  cabinet_id: string;
  date_debut_activite: string | null;
  compte_caisse: string | null;
  compte_banque: string | null;
}

export async function trouverDossierGolden(sb: any): Promise<DossierGolden | null> {
  const { data, error } = await sb.from("dossiers")
    .select("id,nom_societe,cabinet_id,date_debut_activite,compte_caisse,compte_banque")
    .eq("nom_societe", NOM_DOSSIER_GOLDEN)
    .maybeSingle();
  if (error) throw new Error(`Lecture du dossier étalon impossible : ${error.message}`);
  return (data ?? null) as DossierGolden | null;
}

/** Le dossier étalon, ou une erreur qui dit quoi lancer pour l'obtenir. */
export async function exigerDossierGolden(sb: any): Promise<DossierGolden> {
  const d = await trouverDossierGolden(sb);
  if (d) return d;
  throw new Error(
    `Dossier « ${NOM_DOSSIER_GOLDEN} » absent. Semez-le d'abord :\n`
    + "    npm run seed:golden",
  );
}

// ─── L'état des verrous en BASE ──────────────────────────────────────────────
//
// Les migrations de ce projet s'appliquent à la main (cf. la mémoire
// migrations-manuelles-supabase). Un test qui échoue parce qu'une migration
// n'est pas passée et un test qui échoue parce que le code a régressé sont deux
// situations opposées ; les confondre ferait chercher un bug là où il n'y en a
// pas. On sonde donc, et le message le dit.

export interface EtatVerrous {
  /** `enregistrer_reglement` — l'enregistrement atomique (migration 20260908120000). */
  enregistrerReglement: boolean;
  /** `emission_facture` — la source unique de la date et du TTC d'une pièce. */
  emissionFacture: boolean;
  /** Fonctions manquantes, nommées. */
  manquants: string[];
}

let etatCache: EtatVerrous | null = null;

/**
 * Quelles fonctions de verrouillage existent RÉELLEMENT en base ?
 *
 * La spécification OpenAPI de PostgREST est la seule preuve honnête : elle liste
 * ce que le schéma expose, là où « le dashboard n'a pas affiché d'erreur » ne
 * prouve rien. Elle ne voit ni les TRIGGERS ni les INDEX — c'est pourquoi les
 * tests les sondent, eux, par une écriture réelle qui doit être refusée.
 */
export async function etatVerrous(): Promise<EtatVerrous> {
  if (etatCache) return etatCache;
  const { env } = clientGolden();
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await proxyFetch(`${url}/rest/v1/`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  const spec = await r.json();
  const chemins = new Set(Object.keys(spec.paths ?? {}));
  const a = (nom: string) => chemins.has(`/rpc/${nom}`);
  const etat: EtatVerrous = {
    enregistrerReglement: a("enregistrer_reglement"),
    emissionFacture: a("emission_facture"),
    manquants: [],
  };
  if (!etat.enregistrerReglement) etat.manquants.push("enregistrer_reglement");
  if (!etat.emissionFacture) etat.manquants.push("emission_facture");
  etatCache = etat;
  return etat;
}

export const MIGRATION_VERROUS = "supabase/migrations/20260908120000_verrous_reglements.sql";
export const MIGRATION_CONCURRENCE = "supabase/migrations/20260909120000_verrou_concurrence_reglements.sql";

/**
 * Le diagnostic à accoler à tout échec de la couche BASE.
 *
 * Un test rouge pose toujours la même question : ai-je cassé le code, ou
 * l'environnement n'est-il pas à jour ? Sans cette phrase, un développeur
 * relirait `reglements.ts` pendant une heure alors que la règle y est correcte
 * et que c'est la base qui ne la porte pas encore.
 */
export function diagnostic(etat: EtatVerrous, migration = MIGRATION_VERROUS): string {
  if (!etat.manquants.length) {
    return "\n  Les verrous SONT en base : c'est une RÉGRESSION du code, pas un défaut d'environnement.";
  }
  // `20260909120000` ne fait que REMPLACER des fonctions créées par
  // `20260908120000` : l'appliquer seule échouerait sur `emission_facture`
  // introuvable. Nommer une seule des deux enverrait droit dans le mur.
  const aAppliquer = migration === MIGRATION_CONCURRENCE
    ? [MIGRATION_VERROUS, MIGRATION_CONCURRENCE]
    : [migration];
  return [
    "",
    `  ⚠ ${etat.manquants.join(", ")} n'existe(nt) PAS en base.`,
    "    Ce n'est donc pas une régression du code — la règle EST portée côté",
    "    TypeScript (les tests « moteur » du même bloc passent), mais rien ne",
    "    l'impose aux trois autres chemins qui écrivent dans `paiements`.",
    `    Appliquez ${aAppliquer.length > 1 ? "les migrations, DANS CET ORDRE" : "la migration"} :`,
    ...aAppliquer.map((m) => `      node --import tsx scripts/appliquer-migration.ts ${m} --apply`),
  ].join("\n");
}

/** Le message qu'un test affiche quand un verrou attendu n'existe pas en base. */
export function exigerVerrous(etat: EtatVerrous, migration = MIGRATION_VERROUS): void {
  if (!etat.manquants.length) return;
  throw new Error(`Verrous absents de la base.${diagnostic(etat, migration)}`);
}

// ─── Utilitaires partagés ────────────────────────────────────────────────────

export const r2 = (x: unknown) => Math.round((Number(x) || 0) * 100) / 100;
export const nb = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
export const txt = (v: unknown) => String(v ?? "").trim();

/** Le message d'une erreur PostgREST, quelle que soit la forme qu'elle prend. */
export function messageErreur(e: any): string {
  if (!e) return "";
  return txt(e.message ?? e.error_description ?? e.details ?? e.hint ?? e);
}

/** Un refus SQL porte-t-il bien sur la règle attendue, et non sur un incident ? */
export function refusePour(e: any, motif: RegExp): boolean {
  return motif.test(messageErreur(e));
}
