// verify_ubl_dgi_document.mjs — contrôle, sur une VRAIE facture, que le document
// UBL SERVI (téléchargement + pièce jointe du PDF/A-3) porte les trois règles du
// profil DGI et que ses accents sont propres.
//
// Pourquoi ce script existe : le XML d'une facture est ARCHIVÉ en base au
// scellement. Les factures scellées avant l'entrée en vigueur des trois règles
// portent définitivement un document d'un constructeur antérieur — et le bouton
// de téléchargement servait cette colonne telle quelle. Aucun test unitaire ne
// pouvait le voir : c'est une donnée, pas du code. Ce script interroge la base.
//
// Il n'écrit RIEN : `documentUbl` est appelé en SIMULATION (`persister: false`).
// Un script de vérification qui corrige ce qu'il inspecte ne peut rien prouver —
// il rendrait vert un défaut qu'il vient lui-même de réparer.
//
// Lancement :  node --import tsx verify_ubl_dgi_document.mjs "FAC - 2026 - 001"

import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { MockDgiService } from "./src/server/dgi.connector.ts";
import { DgiEInvoicingService } from "./src/server/efacture.service.ts";
import { controlerProfilUbl, encoderXmlUtf8 } from "./src/lib/ubl-invoice.ts";

const env = Object.fromEntries(
  fs.readFileSync(new URL(".env", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);

// fetch tolérant au proxy TLS d'entreprise (cf. proxy-supabase-server) : repli undici.
let PROXY_DIRECT = false;
async function proxyFetch(input, init) {
  const direct = async () => {
    const { fetch: uf, Agent } = await import("undici");
    return uf(String(input), { ...init, dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) });
  };
  if (PROXY_DIRECT) return direct();
  try { return await fetch(String(input), init); }
  catch { PROXY_DIRECT = true; return direct(); }
}

const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { global: { fetch: proxyFetch } });
const NUMERO = process.argv[2] ?? "FAC - 2026 - 001";

let pass = 0, fail = 0;
const check = (label, cond, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  cond ? pass++ : fail++;
};

const { data: facture, error } = await sb
  .from("factures").select("id,numero,hash_sha256,dgi_uuid,xml_ubl").eq("numero", NUMERO).maybeSingle();
if (error) { console.error(`Lecture impossible : ${error.message}`); process.exit(1); }
if (!facture) { console.error(`Facture « ${NUMERO} » introuvable.`); process.exit(1); }

console.log(`\n① Document ARCHIVÉ en base — facture « ${facture.numero} »\n`);
const avant = controlerProfilUbl(facture.xml_ubl, { attendScellement: true });
console.log(`  profil : ${avant.conforme ? "courant" : "ANTÉRIEUR"}`);
for (const m of avant.manquants) console.log(`    · manque : ${m}`);

console.log("\n② Document SERVI (téléchargement + pièce jointe du PDF/A-3)\n");
const moteur = new DgiEInvoicingService(sb, new MockDgiService({ latenceMs: 0 }), env.EFACTURE_SECRET_KEY ?? "clef-de-secours-verification-locale");
const doc = await moteur.documentUbl(facture.id, { persister: false });

const apres = controlerProfilUbl(doc.xml_ubl, { attendScellement: true });
const debut = doc.xml_ubl.indexOf("<Invoice");
const ext = doc.xml_ubl.indexOf("<ext:UBLExtensions>");
const vendeur = doc.xml_ubl.match(/<cac:AccountingSupplierParty>[\s\S]*?<\/cac:AccountingSupplierParty>/)?.[0] ?? "";
const racine = doc.xml_ubl.replace(/<cac:InvoiceLine>[\s\S]*?<\/cac:InvoiceLine>/g, "").match(/<cac:TaxTotal>[\s\S]*?<\/cac:TaxTotal>/)?.[0] ?? "";

check("règle 1 — <ext:UBLExtensions> est le PREMIER enfant de <Invoice>",
  ext > debut && !doc.xml_ubl.slice(debut, ext).includes("<cbc:"));
check("règle 1 — le scellement porte récépissé ET empreinte",
  doc.xml_ubl.includes("<dgi:Recepisse>") && doc.xml_ubl.includes("<dgi:Empreinte"));
check('règle 2 — émetteur : PartyIdentification schemeID="IF"', /<cbc:ID[^>]*schemeID="IF"/.test(vendeur));
check('règle 2 — émetteur : PartyIdentification schemeID="RC"', /<cbc:ID[^>]*schemeID="RC"/.test(vendeur));
check("règle 3 — <cac:TaxSubtotal> dans le <cac:TaxTotal> RACINE", racine.includes("<cac:TaxSubtotal>"));
check("règle 3 — la ventilation porte taux, base HT et TVA",
  /<cbc:TaxableAmount/.test(racine) && /<cbc:TaxAmount/.test(racine) && /<cbc:Percent>/.test(racine));
const means = doc.xml_ubl.indexOf("<cac:PaymentMeans>");
check("règle 4 — <cac:PaymentMeans> entre l'acheteur et le <cac:TaxTotal> racine",
  means > doc.xml_ubl.indexOf("</cac:AccountingCustomerParty>") && means < doc.xml_ubl.indexOf(racine),
  doc.xml_ubl.match(/<cbc:PaymentMeansCode[^>]*>(\d+)<\/cbc:PaymentMeansCode>/)?.[0] ?? "absent");
check("encodage — aucun caractère doublement encodé",
  !apres.manquants.some((m) => m.startsWith("caractères doublement")));
check("encodage — les octets UTF-8 se relisent sans perte",
  new TextDecoder("utf-8", { fatal: true }).decode(encoderXmlUtf8(doc.xml_ubl)) === doc.xml_ubl);
check("scellement — l'empreinte d'origine est CONSERVÉE", doc.hash_sha256 === facture.hash_sha256,
  `${facture.hash_sha256?.slice(0, 16)}…`);
check("scellement — le récépissé d'origine est CONSERVÉ", doc.dgi_uuid === facture.dgi_uuid, String(doc.dgi_uuid));
check("profil global reconnu comme courant", apres.conforme, apres.manquants.join(", "));

for (const a of doc.avertissements) console.log(`  ⚠️  ${a}`);

console.log(`\n③ Document UBL 2.1 servi pour « ${facture.numero} » (état : ${doc.etat})\n`);
console.log(doc.xml_ubl);

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} contrôle(s) réussi(s), ${fail} en échec.\n`);
process.exit(fail === 0 ? 0 : 1);
