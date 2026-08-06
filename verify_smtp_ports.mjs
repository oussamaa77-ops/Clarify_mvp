// Sonde TCP des ports SMTP depuis la machine courante. Aucun octet applicatif
// n'est envoyé : on ouvre, on referme. Un timeout = port filtré par le réseau.
// À exécuter AVANT de soupçonner le code (cf. incident réseau d'entreprise).
import { connect } from "node:net";

const CIBLES = [
  ["smtp.gmail.com", 465, "TLS implicite — celui demandé"],
  ["smtp.gmail.com", 587, "STARTTLS — celui posé dans .env"],
  ["smtp.gmail.com", 25, "témoin : bloqué à peu près partout"],
  ["smtp-relay.brevo.com", 2525, "port alternatif des relais tiers"],
];

const sonder = (host, port, timeoutMs = 8000) =>
  new Promise((resolve) => {
    const t0 = Date.now();
    const s = connect({ host, port });
    const fini = (v) => { s.removeAllListeners(); s.destroy(); resolve(`${v} (${Date.now() - t0} ms)`); };
    s.setTimeout(timeoutMs);
    s.once("connect", () => fini("✅ OUVERT"));
    s.once("timeout", () => fini("❌ FILTRÉ (timeout)"));
    s.once("error", (e) => fini(`❌ ${e?.code ?? e?.message}`));
  });

console.log("Sonde des ports SMTP sortants depuis CETTE machine\n");
for (const [host, port, note] of CIBLES) {
  console.log(`${`${host}:${port}`.padEnd(28)} ${(await sonder(host, port)).padEnd(26)} — ${note}`);
}
