/**
 * audit-full.ts — le RUNNER de la Clarify Golden Audit Suite (`npm run audit:full`).
 *
 * Sept étapes, dans l'ordre où chacune rend la suivante interprétable :
 *
 *   1. `vitest run`                  les tests unitaires — la logique pure
 *   2. `seed-golden-dossier.ts`      le dossier étalon, semé et auto-vérifié
 *   3. `golden-anomalies.test.ts`    les écrans recoupés avec le grand livre
 *   4. `accounting-chaos.test.ts`    les cas invalides, qui doivent être refusés
 *   5. `concurrency-locks.test.ts`   20 règlements simultanés sur une seule facture
 *   6. `grand-livre-concordance.test.ts` Grand Livre ≡ Journal Général, tous dossiers
 *   7. `audit-incoherences-chatgpt.ts` les 7 règles, sur TOUS les dossiers
 *
 * L'ordre n'est pas décoratif. Les cas invalides interrogent le dossier étalon :
 * les lancer avant de l'avoir semé ne prouverait rien. Et le banc d'audit passe
 * en DERNIER parce qu'il est le juge de paix — il vérifie que les étapes 3 et 4,
 * qui écrivent délibérément des horreurs, n'ont rien laissé derrière elles.
 *
 * ─── Ce que le code de sortie signifie ───────────────────────────────────────
 *   0  les cinq étapes sont vertes, ET le banc voit les 9 dossiers réels plus
 *      TEST-CLARIFY-GOLDEN sans une seule règle en défaut.
 *   1  au moins une vérification a échoué. La comptabilité produite n'est pas
 *      fiable — c'est un blocage de CI, pas un avertissement.
 *   2  le runner lui-même n'a pas pu conclure (réseau, identifiants).
 *
 * Aucune étape n'est sautée quand la précédente échoue, à une exception près :
 * si le SEMIS échoue, les étapes 3 et 4 sont annoncées non exécutées plutôt que
 * lancées à vide. Elles échoueraient toutes les deux sur « dossier étalon
 * absent » et noieraient la vraie cause sous deux échecs dérivés.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   npm run audit:full
 *   npm run audit:full -- --sans-semis     # garder le dossier étalon en l'état
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const SANS_SEMIS = argv.includes("--sans-semis");

// Vitest est lancé par son ENTRÉE Node, jamais par `npx`. Sur Windows, `npx` est
// un `.cmd` : `spawnSync` sans shell ne sait pas l'exécuter (ENOENT), et avec
// shell il faudrait citer chaque argument — un chemin contenant un espace, comme
// « C:\Users\… », suffirait à couper la ligne de commande en deux. Passer par
// `process.execPath` évite les deux problèmes et rend le runner identique sur
// les trois plateformes.
const VITEST = path.join(ROOT, "node_modules", "vitest", "vitest.mjs");

interface Etape {
  id: string;
  titre: string;
  /** Ce que l'étape prouve — affiché dans le récapitulatif, échec ou non. */
  enjeu: string;
  commande: string;
  args: string[];
  /** Sauter cette étape si le semis a échoué : elle interroge le dossier étalon. */
  exigeEtalon?: boolean;
}

const ETAPES: Etape[] = [
  {
    id: "unitaires", titre: "Tests unitaires et de logique pure",
    enjeu: "les règles comptables, isolées de toute base",
    commande: process.execPath, args: [VITEST, "run"],
  },
  {
    id: "semis", titre: "Dossier étalon TEST-CLARIFY-GOLDEN",
    enjeu: "un exercice complet, écrit par les générateurs de l'application",
    commande: process.execPath, args: ["--import", "tsx", "scripts/seed-golden-dossier.ts"],
  },
  {
    // Juste après le semis, AVANT le chaos : ces tests comparent les écrans au
    // grand livre de l'étalon tel qu'il vient d'être écrit.
    id: "anomalies", titre: "Écrans ≡ grand livre (4 anomalies de l'étalon)",
    enjeu: "encours, balance âgée, TVA hors classe 6 et base TVA encaissée concordent",
    commande: process.execPath,
    args: [VITEST, "run", "--config", "vitest.golden.config.ts", "tests/golden-anomalies.test.ts"],
    exigeEtalon: true,
  },
  {
    id: "chaos", titre: "Batterie « chaos et cas invalides »",
    enjeu: "toute opération impossible est REFUSÉE, sans corrompre le grand livre",
    commande: process.execPath,
    args: [VITEST, "run", "--config", "vitest.golden.config.ts", "tests/accounting-chaos.test.ts"],
    exigeEtalon: true,
  },
  {
    id: "concurrence", titre: "Stress de concurrence ACID",
    enjeu: "20 règlements simultanés ne produisent jamais de surpaiement",
    commande: process.execPath,
    args: [VITEST, "run", "--config", "vitest.golden.config.ts", "tests/concurrency-locks.test.ts"],
    exigeEtalon: true,
  },
  {
    // Lecture seule, sur TOUS les dossiers : ne dépend pas de l'étalon.
    id: "grandlivre", titre: "Grand Livre ≡ Journal Général (tous dossiers)",
    enjeu: "Σ débits / crédits, soldes par compte et drill-down concordent avec le journal",
    commande: process.execPath,
    args: [VITEST, "run", "--config", "vitest.golden.config.ts", "tests/grand-livre-concordance.test.ts"],
  },
  {
    id: "banc", titre: "Banc d'audit — 7 règles × tous les dossiers",
    enjeu: "les 9 dossiers réels et l'étalon, sans une règle en défaut",
    commande: process.execPath,
    args: ["--import", "tsx", "scripts/audit-incoherences-chatgpt.ts"],
  },
];

interface Resultat {
  etape: Etape;
  /** `null` = non exécutée. */
  code: number | null;
  ms: number;
}

function lancer(e: Etape): Resultat {
  const debut = Date.now();
  console.log(`\n${"━".repeat(78)}`);
  console.log(`  ▶ ${e.titre}`);
  console.log(`    ${e.enjeu}`);
  console.log("━".repeat(78));

  // `stdio: inherit` : la sortie de chaque étape s'affiche telle quelle. La
  // capturer pour la reformater ferait perdre le détail — nom du test en échec,
  // ligne du grand livre fautive — qui est précisément ce qu'on vient chercher.
  const r = spawnSync(e.commande, e.args, { cwd: ROOT, stdio: "inherit", shell: false });
  const ms = Date.now() - debut;

  if (r.error) {
    console.error(`\n    ✗ ${e.titre} n'a pas pu démarrer : ${r.error.message}`);
    return { etape: e, code: 2, ms };
  }
  // Un processus tué par un signal n'a pas de code de sortie : le compter pour 0
  // ferait passer une étape interrompue pour une étape réussie.
  return { etape: e, code: r.status ?? 2, ms };
}

const duree = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function main(): number {
  console.log(`\n${"═".repeat(78)}`);
  console.log("  CLARIFY GOLDEN AUDIT SUITE");
  console.log(`  ${ETAPES.length} étapes · sortie 0 uniquement si TOUT passe`);
  console.log("═".repeat(78));

  const resultats: Resultat[] = [];
  let etalonSeme = true;

  for (const e of ETAPES) {
    if (SANS_SEMIS && e.id === "semis") {
      console.log(`\n  ⤼ ${e.titre} — sautée (--sans-semis)`);
      resultats.push({ etape: e, code: 0, ms: 0 });
      continue;
    }
    if (e.exigeEtalon && !etalonSeme) {
      console.log(`\n${"━".repeat(78)}`);
      console.log(`  ⤼ ${e.titre} — NON EXÉCUTÉE`);
      console.log("    Le dossier étalon n'a pas pu être semé : cette étape l'interroge,");
      console.log("    elle échouerait sur une cause dérivée et masquerait la vraie.");
      resultats.push({ etape: e, code: null, ms: 0 });
      continue;
    }
    const r = lancer(e);
    resultats.push(r);
    if (e.id === "semis" && r.code !== 0) etalonSeme = false;
  }

  // ── Récapitulatif ─────────────────────────────────────────────────────────
  const largeur = Math.max(...ETAPES.map((e) => e.titre.length));
  console.log(`\n${"═".repeat(78)}`);
  console.log("  RÉCAPITULATIF");
  console.log("═".repeat(78));
  for (const { etape, code, ms } of resultats) {
    const verdict = code === null ? "NON EXÉC." : code === 0 ? "  PASS   " : "  FAIL   ";
    console.log(`  ${verdict} ${etape.titre.padEnd(largeur)}  ${duree(ms).padStart(8)}`);
  }

  const echecs = resultats.filter((r) => r.code !== 0);
  console.log(`\n${"─".repeat(78)}`);
  if (!echecs.length) {
    console.log("✅ CLARIFY GOLDEN AUDIT SUITE — 100 % des vérifications passent.");
    console.log("   Tous les dossiers, TEST-CLARIFY-GOLDEN compris, respectent les 7 règles.");
    return 0;
  }

  console.log(`⛔ ${echecs.length} étape(s) en échec — la chaîne comptable n'est PAS fiable.`);
  for (const { etape, code } of echecs) {
    console.log(`\n   ✗ ${etape.titre}${code === null ? " (non exécutée)" : ` (code ${code})`}`);
    console.log(`     ce qui n'est plus garanti : ${etape.enjeu}`);
  }
  console.log("\n   Le détail de chaque échec est remonté au-dessus, dans la sortie de");
  console.log("   l'étape concernée. Un échec de la couche BASE nomme la migration à");
  console.log("   appliquer — ce n'est alors pas le code qui a régressé.");
  // Code 2 réservé à « le runner n'a pas pu conclure » : un échec de
  // vérification, lui, est un résultat, pas une panne.
  return echecs.some((r) => r.code === 2) && echecs.every((r) => r.code !== 1) ? 2 : 1;
}

process.exit(main());
