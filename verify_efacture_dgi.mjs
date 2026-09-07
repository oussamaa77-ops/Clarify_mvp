// verify_efacture_dgi.mjs — vérifie que la migration 20260817120000
// (facturation électronique DGI) est bien en base ET que la chaîne complète
// tient debout sur une VRAIE facture du dossier :
//
//   ① les colonnes existent et sont LISIBLES (select NOMMÉ → échoue si absente)
//   ② `dgi_status` est contraint : une valeur hors domaine doit être REFUSÉE
//   ③ le trigger de miroir tient `statut_dgi` aligné sur `dgi_status`
//   ④ l'index unique interdit deux factures portant le même récépissé DGI
//   ⑤ le cycle complet sur une facture réelle : UBL → scellement → transmission
//      → consultation → annulation, avec journal des échanges renseigné
//   ⑥ la facture hybride PDF/A-3 se construit et porte bien le XML embarqué
//
// L'état d'origine de la facture d'essai est SAUVEGARDÉ et RESTAURÉ en fin de
// test : ce script ne doit rien laisser derrière lui.
//
// Sortie : 0 si tout passe, 1 si un test échoue, 3 si la migration n'est pas
// encore appliquée (colonnes absentes) — code distinct pour qu'un pipeline
// puisse dire « pas encore migré » et « migré mais cassé ».
//
// Lancement :  node --import tsx verify_efacture_dgi.mjs

import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { MockDgiService } from "./src/server/dgi.connector.ts";
import { DgiEInvoicingService } from "./src/server/efacture.service.ts";

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

let pass = 0, fail = 0;
const check = (label, cond, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  cond ? pass++ : fail++;
};

const COLONNES_FACTURE = [
  "ice_vendeur", "if_vendeur", "rc_vendeur", "patente_vendeur",
  "ice_acheteur", "if_acheteur",
  "dgi_status", "dgi_submission_at", "dgi_validated_at", "dgi_response_payload",
];

(async () => {
  console.log("\n① Colonnes de facturation électronique\n");

  // Un select NOMMÉ est le seul moyen de détecter une colonne absente : avec
  // `*`, PostgREST rend simplement ce qui existe et on ne voit rien.
  const { error: errCol } = await sb
    .from("factures")
    .select(["id", ...COLONNES_FACTURE].join(","))
    .limit(1);

  if (errCol) {
    console.log(`  ⚠️  Migration NON appliquée : ${errCol.message}`);
    console.log("\n  → Ouvrez le SQL Editor de Supabase et exécutez :");
    console.log("     supabase/migrations/20260817120000_efacture_dgi.sql\n");
    process.exit(3);
  }
  check("les 10 colonnes de `factures` sont lisibles", true);

  const { error: errPatente } = await sb.from("dossiers").select("id,patente").limit(1);
  check("`dossiers.patente` existe", !errPatente, errPatente?.message ?? "");

  const { error: errFrs } = await sb
    .from("factures_fournisseurs")
    .select("id,ice_vendeur,if_vendeur,ice_acheteur,if_acheteur,dgi_status")
    .limit(1);
  check("les colonnes d'achat existent", !errFrs, errFrs?.message ?? "");

  // ─── Facture d'essai ──────────────────────────────────────────────────────
  const { data: candidates } = await sb
    .from("factures")
    .select("*, clients(nom,ice,if_fiscal), dossiers(nom_societe,ice,if_fiscal,rc,patente)")
    .not("client_id", "is", null)
    .gt("montant_ttc", 0)
    .order("date_facture", { ascending: false })
    .limit(20);

  const facture = (candidates ?? []).find(
    (f) => Array.isArray(f.lignes) && f.lignes.length > 0 && f.dossiers?.ice && f.clients?.ice,
  );

  if (!facture) {
    console.log("\n  ⚠️  Aucune facture ne réunit lignes + ICE vendeur + ICE acheteur :");
    console.log("      les tests ② à ⑥ sont ignorés (rien à éprouver, pas un échec).\n");
    console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} réussi(s), ${fail} échec(s)\n`);
    process.exit(fail === 0 ? 0 : 1);
  }

  console.log(`\n  Facture d'essai : ${facture.numero ?? facture.id} (${facture.montant_ttc} MAD)`);
  const sauvegarde = Object.fromEntries(
    ["statut", "statut_dgi", "dgi_status", "dgi_uuid", "dgi_response", "dgi_response_payload",
     "dgi_submission_at", "dgi_validated_at", "xml_ubl", "hash_sha256",
     ...COLONNES_FACTURE.slice(0, 6)].map((c) => [c, facture[c] ?? null]),
  );
  const restaurer = async () => {
    await sb.from("factures").update(sauvegarde).eq("id", facture.id);
  };

  try {
    console.log("\n② Contrainte de domaine sur `dgi_status`\n");
    const { error: errCheck } = await sb
      .from("factures").update({ dgi_status: "N_IMPORTE_QUOI" }).eq("id", facture.id);
    check("une valeur hors domaine est REFUSÉE", !!errCheck, errCheck ? "rejet attendu" : "ACCEPTÉE — contrainte absente !");

    console.log("\n③ Miroir `statut_dgi` ← `dgi_status`\n");
    for (const [statut, attendu] of [
      ["VALIDATED_BY_DGI", "conforme"],
      ["REJECTED_BY_DGI", "rejetee"],
      ["PENDING_DGI", "en_analyse"],
      ["DRAFT", "brouillon"],
    ]) {
      await sb.from("factures").update({ dgi_status: statut }).eq("id", facture.id);
      const { data } = await sb.from("factures").select("statut_dgi").eq("id", facture.id).single();
      check(`${statut} → statut_dgi = « ${attendu} »`, data?.statut_dgi === attendu, `lu : ${data?.statut_dgi}`);
    }

    console.log("\n④ Unicité du récépissé DGI\n");
    const uuidTest = `verif-${Date.now()}`;
    await sb.from("factures").update({ dgi_uuid: uuidTest }).eq("id", facture.id);
    const { data: autre } = await sb
      .from("factures").select("id").neq("id", facture.id).limit(1).maybeSingle();
    if (autre) {
      const { error: errDoublon } = await sb.from("factures").update({ dgi_uuid: uuidTest }).eq("id", autre.id);
      check("deux factures ne peuvent pas partager un récépissé", !!errDoublon,
        errDoublon ? "rejet attendu" : "ACCEPTÉ — index unique absent !");
      if (!errDoublon) await sb.from("factures").update({ dgi_uuid: null }).eq("id", autre.id);
    } else {
      console.log("  ⏭️  une seule facture en base — unicité non éprouvée");
    }
    await sb.from("factures").update({ dgi_uuid: null, dgi_status: "DRAFT" }).eq("id", facture.id);

    console.log("\n⑤ Cycle complet sur la facture réelle\n");
    const dgi = new MockDgiService({ latenceMs: 0 });
    const service = new DgiEInvoicingService(sb, dgi, env.EFACTURE_SECRET_KEY ?? "");

    const ubl = await service.genererUbl(facture.id);
    check("génération UBL", ubl.succes, ubl.succes ? `${ubl.xml_ubl.length} octets` : JSON.stringify(ubl.erreurs));
    check("empreinte SHA-256 en 64 hexadécimaux", /^[0-9a-f]{64}$/.test(ubl.hash_sha256 ?? ""));
    check("ventilation TVA par taux", ubl.totaux.ventilation.length > 0,
      ubl.totaux.ventilation.map((v) => `${v.taux}%`).join(" "));

    const envoi = await service.transmettre(facture.id);
    check("transmission acceptée", envoi.succes, envoi.succes ? envoi.dgi_uuid : JSON.stringify(envoi.erreurs));

    const { data: apres } = await sb
      .from("factures")
      .select("dgi_status,dgi_uuid,dgi_submission_at,dgi_validated_at,dgi_response_payload,ice_vendeur,ice_acheteur")
      .eq("id", facture.id).single();
    check("statut persisté", apres?.dgi_status === "VALIDATED_BY_DGI", apres?.dgi_status);
    check("date de transmission persistée", !!apres?.dgi_submission_at);
    check("identités fiscales figées sur la facture", !!apres?.ice_vendeur && !!apres?.ice_acheteur);
    const journal = Array.isArray(apres?.dgi_response_payload) ? apres.dgi_response_payload : [];
    check("journal des échanges renseigné", journal.length >= 2, `${journal.length} entrée(s)`);
    check("requête ET réponse consignées",
      journal.some((e) => e.sens === "requete") && journal.some((e) => e.sens === "reponse"));

    const statut = await service.consulterStatut(facture.id);
    check("consultation du statut", statut.succes, statut.statut);

    const annulation = await service.annuler(facture.id, "Vérification automatisée — à ignorer");
    check("annulation acceptée", annulation.succes, annulation.statut);

    console.log("\n⑥ Facture hybride PDF/A-3\n");
    await sb.from("factures").update({ dgi_status: "DRAFT", statut: sauvegarde.statut }).eq("id", facture.id);
    const pdf = await service.pdfA3(facture.id);
    const octets = Buffer.from(pdf.pdf_base64, "base64");
    check("PDF produit", octets.subarray(0, 5).toString() === "%PDF-", `${octets.length} octets`);
    check("conformité PDF/A complète", pdf.conformite === "complete", pdf.conformite);
    const brut = octets.toString("latin1");
    check("déclaré PDF/A-3B", brut.includes("<pdfaid:part>3</pdfaid:part>") && brut.includes("<pdfaid:conformance>B"));
    check("XML UBL embarqué en fichier associé", brut.includes("/AFRelationship /Data"));
    if (pdf.avertissements.length) console.log("  ℹ️ ", pdf.avertissements.join(" | "));
  } finally {
    await restaurer();
    console.log("\n  ↩️  Facture d'essai restaurée dans son état d'origine.");
  }

  console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} réussi(s), ${fail} échec(s)\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("\n💥", e);
  process.exit(1);
});
