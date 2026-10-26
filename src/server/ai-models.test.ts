import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { MODELES_PAR_DEFAUT, VARIABLES_MODELES, modele, type RoleModele } from "./ai-models";

// Modèles RETIRÉS par leur fournisseur — leur seule présence dans le code
// suffisait à casser l'OCR et le rapprochement en production.
const MODELES_RETIRES = [
  "pixtral-large",
  "llama-4-scout",
  "llama-3.2-90b-vision",
  "llama-3.2-11b-vision",
  "llama-3.1-8b-instant",
  "llama-3.3-70b-versatile",
  "mistral-ocr-4-0",
  "mistral-ocr-2505",
];

describe("ai-models", () => {
  const sauvegarde = { ...process.env };
  afterEach(() => { process.env = { ...sauvegarde }; });

  it("rend le défaut quand la variable d'environnement est absente ou vide", () => {
    for (const role of Object.keys(MODELES_PAR_DEFAUT) as RoleModele[]) {
      delete process.env[VARIABLES_MODELES[role]];
      expect(modele(role)).toBe(MODELES_PAR_DEFAUT[role]);
      process.env[VARIABLES_MODELES[role]] = "   ";
      expect(modele(role)).toBe(MODELES_PAR_DEFAUT[role]);
    }
  });

  it("la variable d'environnement remplace le défaut, lue à l'appel", () => {
    process.env.MISTRAL_VISION_MODEL = " mistral-large-latest ";
    expect(modele("mistralVision")).toBe("mistral-large-latest");
    process.env.GROQ_VISION_MODEL = "autre/modele";
    expect(modele("groqVision")).toBe("autre/modele");
  });

  it("aucun défaut n'est un modèle retiré", () => {
    for (const id of Object.values(MODELES_PAR_DEFAUT)) {
      for (const retire of MODELES_RETIRES) expect(id).not.toContain(retire);
    }
  });

  it("cliquet : aucun appel d'IA ne code en dur un modèle retiré", () => {
    for (const f of ["factures.functions.ts", "ocr.functions.ts"]) {
      const code = readFileSync(join(__dirname, f), "utf-8")
        .split("\n")
        .filter((l) => !l.trim().startsWith("//"))
        .join("\n");
      for (const retire of MODELES_RETIRES) {
        expect(code, `${f} cite encore ${retire}`).not.toMatch(new RegExp(`["'\`][^"'\`]*${retire}`));
      }
    }
  });
});
