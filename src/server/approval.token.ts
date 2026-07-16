// ============================================================================
// approval.token.ts — Jeton d'approbation d'inscription (HMAC-SHA256).
//
// Le lien envoyé à l'admin (/api/approve-user?userId=…&token=…) doit être
// infalsifiable : sans signature, n'importe qui pourrait approuver n'importe
// quel compte en devinant un UUID. Le jeton est donc un HMAC de l'userId avec
// un secret serveur.
//
// Sans état : rien à stocker en base, et le lien reste valable tant que le
// secret ne change pas — ce qui convient à une approbation (l'admin peut
// cliquer des jours plus tard). Changer APPROVAL_TOKEN_SECRET invalide d'un
// coup tous les liens en circulation.
// ============================================================================
import { createHmac, timingSafeEqual } from "node:crypto";

function getSecret(): string {
  const secret = (process.env.APPROVAL_TOKEN_SECRET ?? "").trim();
  // Échec FERMÉ : pas de secret par défaut. Un fallback codé en dur serait
  // public (le dépôt l'est), donc tout le monde pourrait forger un jeton.
  // Mieux vaut une erreur bruyante qu'une approbation ouverte à tous.
  if (secret.length < 16) {
    throw new Error(
      "APPROVAL_TOKEN_SECRET manquant ou trop court (min. 16 caractères). " +
        "Générez-le avec : node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\" " +
        "puis posez-le dans les variables d'environnement du serveur."
    );
  }
  return secret;
}

export function signApprovalToken(userId: string): string {
  return createHmac("sha256", getSecret()).update(userId).digest("hex");
}

/** Comparaison à temps constant : une comparaison `===` fuit la position du
 *  premier octet faux et permet de reconstruire le jeton octet par octet. */
export function verifyApprovalToken(userId: string, token: string): boolean {
  if (!userId || !token) return false;
  const attendu = Buffer.from(signApprovalToken(userId), "hex");
  // Un `token` non hexadécimal produit un Buffer plus court — d'où le test de
  // longueur, obligatoire avant timingSafeEqual qui lève si les tailles diffèrent.
  const fourni = Buffer.from(token, "hex");
  if (attendu.length !== fourni.length) return false;
  return timingSafeEqual(attendu, fourni);
}
