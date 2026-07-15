// ============================================================================
// cron-rappel-tva.ts — Point d'entrée PLANIFIABLE du rappel TVA J-3.
//
// Lancer une fois par jour. Il scanne tous les dossiers actifs et envoie le
// rappel d'échéance TVA au gérant quand l'échéance tombe à J-3 (idempotent).
//
//   npm run cron:tva              → envoi réel
//   npm run cron:tva -- --dry-run → simulation (n'envoie rien, journalise)
//   npm run cron:tva -- --days=5  → change la fenêtre (défaut 3)
//
// Planification (une exécution / jour) :
//   • Windows (Task Scheduler) :
//       Program : powershell
//       Args    : -NoProfile -Command "cd 'C:\chemin\projet'; npm run cron:tva"
//       Déclencheur : quotidien à 08:00
//   • Linux/macOS (crontab -e) :
//       0 8 * * * cd /chemin/projet && npm run cron:tva >> /var/log/tva.log 2>&1
//   • Cron hébergé (Render/Railway/GitHub Actions) : exécuter `npm run cron:tva`.
// ============================================================================

import "dotenv/config";
import { executerRappelsTVAJ3 } from "../src/server/rappel-tva.batch";

function parseArgs(argv: string[]) {
  const dryRun = argv.includes("--dry-run") || argv.includes("-n");
  const daysArg = argv.find((a) => a.startsWith("--days="));
  const fenetreJours = daysArg ? Number(daysArg.split("=")[1]) : undefined;
  return { dryRun, fenetreJours };
}

async function main() {
  const { dryRun, fenetreJours } = parseArgs(process.argv.slice(2));
  const started = new Date().toISOString();
  console.log(`[cron:tva] Démarrage ${started} — dryRun=${dryRun} fenetreJours=${fenetreJours ?? 3}`);

  const r = await executerRappelsTVAJ3({ dryRun, fenetreJours });

  console.log(`[cron:tva] Terminé — dossiers scannés: ${r.scanned}, envoyés: ${r.envoyes}, ignorés: ${r.ignores}`);
  for (const d of r.details) {
    console.log(`  · ${d.dossier} | période ${d.periode ?? "—"} | ${d.montant} MAD | éch. ${d.echeance ?? "—"} | J-${d.jours ?? "?"} | ${d.statut}${d.to ? " → " + d.to : ""}`);
  }
  // Code de sortie non-zéro s'il y a eu au moins un échec d'envoi (visible par le scheduler).
  const echecs = r.details.filter((d) => d.statut.startsWith("échec")).length;
  process.exit(echecs > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("[cron:tva] Erreur fatale:", e?.message ?? e);
  process.exit(1);
});
