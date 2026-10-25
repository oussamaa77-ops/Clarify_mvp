// ============================================================================
// proxy-fetch.ts — LE fetch serveur tolérant au proxy TLS d'entreprise.
//
// Sur le poste de dev, un proxy d'inspection TLS présente son propre
// certificat : le fetch global de Node échoue (`TypeError: fetch failed`), et
// on doit repasser par undici SANS vérification TLS.
//
// Ce repli ne doit JAMAIS jouer en production. Il était recopié dans une
// quinzaine de modules, dont la plupart le déclenchaient sur N'IMPORTE quelle
// erreur réseau (ECONNRESET, « fetch failed ») et le gardaient pour toute la vie
// du processus : un simple incident réseau sur Railway coupait la vérification
// des certificats pour toutes les requêtes suivantes — clé service_role et
// données de tous les cabinets comprises. Un attaquant placé sur le réseau
// n'avait qu'à provoquer une coupure pour les intercepter.
//
// Règle : repli autorisé hors production seulement (NODE_ENV, posé à
// `production` par le Dockerfile), ou si PROXY_TLS_INSECURE=true est posé
// explicitement. PROXY_TLS_INSECURE=false l'interdit partout. Meilleure
// solution sur le poste de dev : NODE_EXTRA_CA_CERTS=<CA du proxy>, qui garde
// la vérification active.
// ============================================================================

let PROXY_DIRECT = false;

/** Le repli sans vérification TLS est-il permis dans cet environnement ? */
export function repliSansVerificationAutorise(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.PROXY_TLS_INSECURE ?? "").trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return env.NODE_ENV !== "production";
}

/** Signature d'un échec dû au proxy : certificat refusé, ou le « fetch failed »
 *  générique sous lequel Node le présente souvent. */
function ressembleAuProxy(e: any): boolean {
  const cause: string = e?.cause?.code ?? e?.cause?.message ?? e?.message ?? "";
  return /SELF_SIGNED|CERT_|UNABLE_TO_VERIFY|fetch failed|ECONNRESET|EPROTO/i.test(cause)
    || /fetch failed/i.test(String(e?.message ?? ""));
}

/** fetch via undici, vérification TLS désactivée. Réservé au repli ci-dessous. */
async function fetchSansVerification(url: string, init?: any): Promise<Response> {
  const { fetch: uf, Agent } = await import("undici");
  const agent = new Agent({ connect: { rejectUnauthorized: false } });
  return (uf as any)(url, { ...init, dispatcher: agent }) as Promise<Response>;
}

export async function proxyFetch(input: any, init?: any): Promise<Response> {
  const url = String(input);
  if (PROXY_DIRECT && repliSansVerificationAutorise()) return fetchSansVerification(url, init);
  try {
    return await fetch(url, init);
  } catch (e: any) {
    if (!repliSansVerificationAutorise() || !ressembleAuProxy(e)) throw e;
    if (!PROXY_DIRECT) {
      console.warn("[proxy-fetch] proxy TLS détecté — repli undici SANS vérification TLS (hors production uniquement).");
    }
    PROXY_DIRECT = true;
    return fetchSansVerification(url, init);
  }
}
