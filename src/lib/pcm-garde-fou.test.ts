// ============================================================================
// Garde-fou d'architecture PCM — une future modification ne doit pas pouvoir
// réintroduire un compte invalide, ni recopier un numéro hors du référentiel.
//
// Trois verrous, qui lisent le CODE SOURCE (et non un comportement) :
//   1. tout numéro de compte écrit en dur est recevable (validatePcmAccount) ;
//   2. CLIQUET : le nombre de numéros en dur par fichier ne peut que BAISSER —
//      un nouveau compte s'importe de src/lib/pcm-referentiel.ts ;
//   3. les imputations corrigées (6313, 6132, 61311, 7611…) ne reviennent pas,
//      et les tables de catégories des écrans restent alignées sur PCM_MAP.
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validatePcmAccount, PCM } from "@/lib/pcm-referentiel";
import { PCM_MAP } from "@/lib/comptabilite-bq";
import { COMPTE_CAISSE_DEFAUT } from "@/lib/comptes-tresorerie";

const RACINE = path.resolve(__dirname, "../..");
const REFERENTIEL = "src/lib/pcm-referentiel.ts";

/** Littéraux numériques qui NE SONT PAS des comptes (codes d'erreur, exemples de prompt…). */
const NON_COMPTES = new Set([
  "42703", "42883",        // codes d'erreur PostgreSQL
  "630238", "0630238",     // numéro de LCN cité en commentaire
  "123456",                // exemple de numéro de reçu dans le prompt OCR
  "00000000",              // gabarit de colonne d'export Sage
]);

/**
 * Plafond de numéros de comptes écrits en dur, par fichier (état au 2026-09-15).
 * Faire BAISSER un plafond est bienvenu ; le relever demande de justifier
 * pourquoi le compte ne peut pas venir de `pcm-referentiel.ts`.
 */
const PLAFONDS: Record<string, number> = {
  "src/components/DeclarationTvaPanel.tsx": 3,
  "src/components/FacturesClientsPanel.tsx": 3,
  "src/lib/categorization-engine.ts": 25,
  "src/lib/coherence-ventes.ts": 1,
  "src/lib/comptabilite-bq.ts": 3,
  "src/lib/comptes-auxiliaires.ts": 2,
  "src/lib/genererEcritures.ts": 1,
  "src/lib/import-grandlivre.ts": 4,
  "src/lib/justificatif-details.ts": 15,
  "src/lib/numero-compte.ts": 2,
  "src/routes/_app/dossiers.$dossierId.banque.tsx": 41,
  "src/routes/_app/dossiers.$dossierId.comptabilite.tsx": 1,
  "src/routes/_app/dossiers.$dossierId.fournisseurs.tsx": 4,
  "src/routes/_app/dossiers.$dossierId.justificatifs.tsx": 26,
  "src/routes/_app/dossiers.$dossierId.relevescanner.tsx": 5,
  "src/server/factures.functions.ts": 7,
  "src/server/factures.utils.ts": 19,
  "src/server/ocr.functions.ts": 16,
  "src/server/rappel-tva.batch.ts": 3,
  "src/services/lettrage.ts": 1,
};

/** Imputations corrigées : le numéro n'est toléré QUE là où il est lu pour l'historique. */
const IMPUTATIONS_RETIREES: Record<string, { motif: string; toleréDans: string[] }> = {
  "6313": { motif: "taxe professionnelle → 6161 (6313 est un compte d'intérêts)", toleréDans: ["src/lib/justificatif-details.ts"] },
  "6132": {
    motif: "télécom → 6145 (6132 = redevances de crédit-bail)",
    toleréDans: ["src/lib/justificatif-details.ts", "src/routes/_app/dossiers.$dossierId.banque.tsx"],
  },
  "61311": { motif: "loyer → 6131 (61311 = locations de terrains)", toleréDans: ["src/server/factures.utils.ts"] },
  "7611": { motif: "intérêts créditeurs → 7381 (rubrique 76 absente du CGNC)", toleréDans: [] },
};

function sources(): { rel: string; src: string }[] {
  const out: { rel: string; src: string }[] = [];
  const parcourir = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) parcourir(p);
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !/routeTree\.gen/.test(e.name)) {
        out.push({ rel: path.relative(RACINE, p).replace(/\\/g, "/"), src: fs.readFileSync(p, "utf8") });
      }
    }
  };
  parcourir(path.join(RACINE, "src"));
  return out;
}

/** Les numéros de comptes écrits en dur d'un fichier. */
function litteraux(src: string): string[] {
  return [...src.matchAll(/["'`](\d{4,8})["'`]/g)].map((m) => m[1]).filter((x) => !NON_COMPTES.has(x));
}

describe("garde-fou PCM — numéros de comptes dans le code source", () => {
  const fichiers = sources();

  it("scanne réellement le code (sinon le garde-fou ne garde rien)", () => {
    expect(fichiers.length).toBeGreaterThan(50);
    expect(litteraux(fichiers.find((f) => f.rel === REFERENTIEL)!.src).length).toBeGreaterThan(30);
  });

  it("tout numéro de compte écrit en dur est recevable au référentiel PCM", () => {
    const fautifs: string[] = [];
    for (const { rel, src } of fichiers) {
      for (const c of new Set(litteraux(src))) {
        const v = validatePcmAccount(c);
        if (!v.ok) fautifs.push(`${rel} : « ${c} » — ${v.erreurs.join(" ")}`);
      }
    }
    expect(fautifs, "Compte invalide introduit dans le code. Corrigez-le, ou déclarez le littéral dans "
      + "NON_COMPTES s'il ne désigne pas un compte.").toEqual([]);
  });

  it("CLIQUET : aucun fichier ne gagne de numéro de compte en dur", () => {
    const depassements: string[] = [];
    for (const { rel, src } of fichiers) {
      if (rel === REFERENTIEL) continue;
      const n = litteraux(src).length;
      const plafond = PLAFONDS[rel] ?? 0;
      if (n > plafond) depassements.push(`${rel} : ${n} numéro(s) en dur (plafond ${plafond})`);
    }
    expect(depassements, "Importez le compte depuis src/lib/pcm-referentiel.ts (PCM / RACINES_PCM) "
      + "au lieu de le recopier.").toEqual([]);
  });

  it("aucun plafond ne survit à la disparition de son fichier", () => {
    for (const rel of Object.keys(PLAFONDS)) {
      expect(fs.existsSync(path.join(RACINE, rel)), `plafond orphelin : ${rel}`).toBe(true);
    }
  });

  it("les imputations corrigées ne reviennent pas", () => {
    const retours: string[] = [];
    for (const { rel, src } of fichiers) {
      const presents = new Set(litteraux(src));
      for (const [compte, { motif, toleréDans }] of Object.entries(IMPUTATIONS_RETIREES)) {
        if (presents.has(compte) && !toleréDans.includes(rel)) retours.push(`${rel} : ${compte} — ${motif}`);
      }
    }
    expect(retours).toEqual([]);
  });

  it("le prompt OCR n'impose plus 6147 au restaurant ni 6313 à la taxe professionnelle", () => {
    const prompt = fichiers.find((f) => f.rel === "src/server/factures.utils.ts")!.src;
    expect(prompt).not.toMatch(/restaurant[^\n]*"6147"/);
    expect(prompt).not.toMatch(/taxe professionnelle[^\n]*"6313"/i);
    expect(prompt).toMatch(/"6143"/);
  });
});

describe("garde-fou PCM — tables de catégories des écrans alignées sur PCM_MAP", () => {
  /** Divergences VOULUES et documentées dans chaque écran. */
  const DIVERGENCES: Record<string, string[]> = {
    "src/routes/_app/dossiers.$dossierId.justificatifs.tsx": ["gasoil", "cnss_amo"],
    "src/routes/_app/dossiers.$dossierId.relevescanner.tsx": ["gasoil", "cnss_amo"],
  };

  /** Résout l'expression `code:` d'une entrée de catégorie en numéro de compte. */
  function resoudre(expr: string): string | null {
    const lit = /^"(\d+)"$/.exec(expr);
    if (lit) return lit[1];
    const map = /^PCM_MAP\.(\w+)\.code$/.exec(expr);
    if (map) return PCM_MAP[map[1]]?.code ?? null;
    const pcm = /^PCM\.(\w+)$/.exec(expr);
    if (pcm) return (PCM as Record<string, string>)[pcm[1]] ?? null;
    if (expr === "COMPTE_CAISSE_DEFAUT") return COMPTE_CAISSE_DEFAUT;
    return null;
  }

  for (const [rel, divergences] of Object.entries(DIVERGENCES)) {
    it(`${path.basename(rel)} : chaque nature commune porte le compte de PCM_MAP`, () => {
      const src = fs.readFileSync(path.join(RACINE, rel), "utf8");
      const entrees = [...src.matchAll(/value:\s*"(\w+)"[^\n]*?code:\s*([^,}\s]+)/g)];
      expect(entrees.length).toBeGreaterThan(10);
      const ecarts: string[] = [];
      for (const [, categorie, expr] of entrees) {
        if (!PCM_MAP[categorie] || divergences.includes(categorie)) continue;
        const compte = resoudre(expr);
        if (compte !== PCM_MAP[categorie].code) {
          ecarts.push(`${categorie} : ${expr} (${compte}) ≠ PCM_MAP ${PCM_MAP[categorie].code}`);
        }
      }
      expect(ecarts).toEqual([]);
    });
  }
});
