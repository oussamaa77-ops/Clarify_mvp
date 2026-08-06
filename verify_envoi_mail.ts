// ============================================================================
// Test d'envoi de bout en bout par le VRAI point d'entrée `sendMail`.
//
// Pourquoi passer par sendMail et non par nodemailer directement : c'est le
// chemin qu'emprunte le mail d'approbation. Réimplémenter l'envoi dans un script
// validerait un code que la production n'exécute pas.
//
//   npx tsx verify_envoi_mail.ts                      → destinataire = admin
//   npx tsx verify_envoi_mail.ts autre@exemple.com
//
// ⚠ À exécuter DEPUIS LE RÉSEAU QUI COMPTE. Le filaire d'entreprise et Railway
//   filtrent les ports SMTP : un échec ici ne dit rien de l'autre environnement.
//   Pour tester la production, utiliser /api/diag-mail depuis le serveur.
// ============================================================================
import { readFileSync } from "node:fs";

// .env chargé à la main (pas de dotenv dans ce projet), sans écraser ce qui est
// déjà dans l'environnement : Railway doit rester prioritaire sur le fichier.
for (const ligne of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = ligne.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && process.env[m[1]] === undefined) {
    process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const { sendMail, ordreTransports } = await import("./src/server/mailer");
const { getAdminEmail } = await import("./src/server/approval.functions");

const DEST = process.argv[2]?.trim() || getAdminEmail();

console.log("=== TRANSPORTS ===");
console.log(`MAIL_TRANSPORT   : ${process.env.MAIL_TRANSPORT ?? "(auto)"}`);
console.log(`ordre effectif   : ${ordreTransports().join(" → ")}`);
console.log(`SMTP             : ${process.env.SMTP_HOST}:${process.env.SMTP_PORT ?? 587} (user ${process.env.SMTP_USER})`);
console.log(`FROM_EMAIL       : ${process.env.FROM_EMAIL ?? process.env.EMAIL_FROM ?? "(repli SMTP_USER)"}`);
console.log(`destinataire     : ${DEST}\n`);

const t0 = Date.now();
try {
  const r = await sendMail({
    to: DEST,
    subject: `Test HisabPro — ${new Date().toLocaleString("fr-FR")}`,
    html:
      "<p>Test du transport e-mail.</p>" +
      "<p>Le mail d'approbation d'inscription emprunte exactement ce chemin.</p>",
  });
  console.log(`\n✅ ENVOI ACCEPTÉ en ${Date.now() - t0} ms | messageId: ${r.messageId}`);
  console.log("Les lignes [SMTP]/[Resend] ci-dessus indiquent quel transport a servi.");
  console.log(`Si rien n'arrive sur ${DEST}, regardez les SPAMS : le problème serait alors la délivrabilité, pas l'envoi.`);
} catch (e: any) {
  console.error(`\n❌ ENVOI ÉCHOUÉ après ${Date.now() - t0} ms\n${e?.message ?? e}`);
  process.exit(1);
}
