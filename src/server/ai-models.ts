// ============================================================================
// ai-models.ts — Le seul endroit où vivent les NOMS de modèles d'IA.
//
// ─── Pourquoi ce fichier ─────────────────────────────────────────────────────
// Les identifiants de modèles étaient écrits en dur, éparpillés dans
// factures.functions.ts et ocr.functions.ts. Les fournisseurs les retirent sans
// relâche : en 2026, pixtral-large (31/05), llama-4-scout sur Groq (17/07),
// llama-3.1-8b-instant (16/08) et mistral-ocr-4-0 (30/09) ont disparu, et avec
// eux l'OCR principal ET ses secours — l'import de relevé tombait en panne
// sans qu'aucune ligne de code n'ait changé.
//
// Désormais chaque modèle a un défaut à jour ET une variable d'environnement
// qui le remplace. Le prochain retrait se corrige dans Railway, sans déploiement.
//
// Les valeurs sont lues À L'APPEL (pas au chargement du module) : un changement
// de variable prend effet au redémarrage du service, et les tests peuvent
// surcharger process.env sans recharger le module.
// ============================================================================

const env = (name: string, defaut: string): string => {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : defaut;
};

/** Défauts — vérifiés contre les pages de dépréciation Mistral et Groq (oct. 2026). */
export const MODELES_PAR_DEFAUT = {
  /** OCR document Mistral. L'alias « latest » suit la version courante (OCR 4.1). */
  mistralOcr: "mistral-ocr-latest",
  /** Raisonnement texte → JSON : extraction de facture, rapprochement bancaire. */
  mistralChat: "mistral-large-latest",
  /** Vision Mistral (écriture manuscrite). Remplace pixtral-large, retiré le 31/05/2026. */
  mistralVision: "mistral-medium-latest",
  /** Texte Groq (secours). gpt-oss-120b n'est pas déprécié. */
  groqTexte: "openai/gpt-oss-120b",
  /** Texte Groq léger. Remplace llama-3.1-8b-instant, retiré le 16/08/2026. */
  groqTexteLeger: "openai/gpt-oss-20b",
  /** Vision Groq (secours OCR). Remplace llama-4-scout, retiré le 17/07/2026. */
  groqVision: "qwen/qwen3.8-27b",
} as const;

export type RoleModele = keyof typeof MODELES_PAR_DEFAUT;

/** Variable d'environnement qui surcharge chaque rôle. */
export const VARIABLES_MODELES: Record<RoleModele, string> = {
  mistralOcr: "MISTRAL_OCR_MODEL",
  mistralChat: "MISTRAL_CHAT_MODEL",
  mistralVision: "MISTRAL_VISION_MODEL",
  groqTexte: "GROQ_TEXT_MODEL",
  groqTexteLeger: "GROQ_TEXT_LIGHT_MODEL",
  groqVision: "GROQ_VISION_MODEL",
};

/** Le modèle à utiliser pour un rôle : la variable d'environnement, sinon le défaut. */
export function modele(role: RoleModele): string {
  return env(VARIABLES_MODELES[role], MODELES_PAR_DEFAUT[role]);
}
