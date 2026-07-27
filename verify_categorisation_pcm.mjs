// verify_categorisation_pcm.mjs — vérifie que la migration du moteur de
// catégorisation PCM (20260725120000_categorization_engine.sql) est bien en base
// et que les 3 colonnes sont LISIBLES et ÉDITABLES sans erreur SQL :
//   • dossiers.secteur_activite        (Règle 3 — fallback sectoriel)
//   • fournisseurs.compte_charge_defaut (Règle 1 — défaut du tiers, achats)
//   • clients.compte_produit_defaut     (Règle 1 — défaut du tiers, ventes)
//
// Puis rejoue le chemin réel de l'UI : lire les valeurs en base → suggestAccount()
// (src/lib/categorization-engine.ts, la MÊME fonction que la saisie manuelle).
//
// Les valeurs d'origine sont sauvegardées et RESTAURÉES en fin de test.
//
// Lancement :  node --import tsx verify_categorisation_pcm.mjs   (SERVICE_ROLE_KEY)

import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { suggestAccount } from "./src/lib/categorization-engine.ts";

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
const check = (label, cond, detail = "") => { console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`); cond ? pass++ : fail++; };

// Valeurs de test, restaurées ensuite.
const T_SECTEUR = "Commerce / Négoce";   // → charge 6111 / produit 7111
const T_CHARGE  = "61455";               // télécom
const T_PRODUIT = "7124";                // prestations de services

(async () => {
  console.log(`\n🧪 verify_categorisation_pcm — migration 20260725120000\n`);

  // ── ① Colonnes présentes et LISIBLES (select nommé : échoue si colonne absente)
  console.log("① Lecture des colonnes (select nommé) :");
  const pDos = await sb.from("dossiers").select("id,nom_societe,secteur_activite").limit(1);
  const pFou = await sb.from("fournisseurs").select("id,nom,dossier_id,compte_charge_defaut").limit(1);
  const pCli = await sb.from("clients").select("id,nom,dossier_id,compte_produit_defaut").limit(1);
  const manquantes = [
    pDos.error && `dossiers.secteur_activite → ${pDos.error.message}`,
    pFou.error && `fournisseurs.compte_charge_defaut → ${pFou.error.message}`,
    pCli.error && `clients.compte_produit_defaut → ${pCli.error.message}`,
  ].filter(Boolean);
  if (manquantes.length) {
    console.error("\n❌ Migration NON appliquée (ou partielle) :");
    for (const m of manquantes) console.error("   • " + m);
    console.error("   → Exécute supabase/migrations/20260725120000_categorization_engine.sql dans Supabase, puis relance.\n");
    process.exit(3);
  }
  check("dossiers.secteur_activite lisible", true);
  check("fournisseurs.compte_charge_defaut lisible", true);
  check("clients.compte_produit_defaut lisible", true);

  // ── ② Cibles réelles : un dossier qui a au moins un fournisseur et un client.
  const { data: fournisseurs } = await sb.from("fournisseurs").select("id,nom,dossier_id").limit(200);
  const { data: clientsRows }  = await sb.from("clients").select("id,nom,dossier_id").limit(200);
  const dossiersFou = new Set((fournisseurs ?? []).map((f) => f.dossier_id));
  const cli = (clientsRows ?? []).find((c) => dossiersFou.has(c.dossier_id));
  const fou = (fournisseurs ?? []).find((f) => f.dossier_id === cli?.dossier_id);
  if (!cli || !fou) {
    console.error("\n❌ Aucun dossier ne possède à la fois un fournisseur et un client — impossible de tester l'écriture.\n");
    process.exit(4);
  }
  const dossierId = cli.dossier_id;
  const { data: dos } = await sb.from("dossiers").select("id,nom_societe,secteur_activite").eq("id", dossierId).single();
  console.log(`\n② Cibles : dossier « ${dos?.nom_societe} » | fournisseur « ${fou.nom} » | client « ${cli.nom} »`);

  // Sauvegarde pour restauration.
  const { data: fouBefore } = await sb.from("fournisseurs").select("compte_charge_defaut").eq("id", fou.id).single();
  const { data: cliBefore } = await sb.from("clients").select("compte_produit_defaut").eq("id", cli.id).single();
  const backup = {
    secteur: dos?.secteur_activite ?? null,
    charge: fouBefore?.compte_charge_defaut ?? null,
    produit: cliBefore?.compte_produit_defaut ?? null,
  };
  console.log(`   valeurs d'origine : secteur=${JSON.stringify(backup.secteur)} charge=${JSON.stringify(backup.charge)} produit=${JSON.stringify(backup.produit)}`);

  const restore = async () => {
    await sb.from("dossiers").update({ secteur_activite: backup.secteur }).eq("id", dossierId);
    await sb.from("fournisseurs").update({ compte_charge_defaut: backup.charge }).eq("id", fou.id);
    await sb.from("clients").update({ compte_produit_defaut: backup.produit }).eq("id", cli.id);
  };

  try {
    // ── ③ ÉCRITURE (update) — le chemin exact des UI (dossiers.tsx, fournisseurs.tsx,
    //    FacturesClientsPanel.tsx qui persistent le compte au moment du scan/saisie).
    console.log(`\n③ Écriture (update) :`);
    const uDos = await sb.from("dossiers").update({ secteur_activite: T_SECTEUR }).eq("id", dossierId);
    const uFou = await sb.from("fournisseurs").update({ compte_charge_defaut: T_CHARGE }).eq("id", fou.id);
    const uCli = await sb.from("clients").update({ compte_produit_defaut: T_PRODUIT }).eq("id", cli.id);
    check("update dossiers.secteur_activite", !uDos.error, uDos.error?.message ?? T_SECTEUR);
    check("update fournisseurs.compte_charge_defaut", !uFou.error, uFou.error?.message ?? T_CHARGE);
    check("update clients.compte_produit_defaut", !uCli.error, uCli.error?.message ?? T_PRODUIT);

    // ── ④ RELECTURE — la valeur a bien été persistée (pas de trigger/RLS qui l'avale).
    console.log(`\n④ Relecture après écriture :`);
    const { data: rDos } = await sb.from("dossiers").select("secteur_activite").eq("id", dossierId).single();
    const { data: rFou } = await sb.from("fournisseurs").select("compte_charge_defaut").eq("id", fou.id).single();
    const { data: rCli } = await sb.from("clients").select("compte_produit_defaut").eq("id", cli.id).single();
    check(`secteur_activite = « ${T_SECTEUR} »`, rDos?.secteur_activite === T_SECTEUR, String(rDos?.secteur_activite));
    check(`compte_charge_defaut = ${T_CHARGE}`, rFou?.compte_charge_defaut === T_CHARGE, String(rFou?.compte_charge_defaut));
    check(`compte_produit_defaut = ${T_PRODUIT}`, rCli?.compte_produit_defaut === T_PRODUIT, String(rCli?.compte_produit_defaut));

    // ── ⑤ Chaîne complète : valeurs LUES EN BASE → suggestAccount() (Règle 1).
    console.log(`\n⑤ Moteur alimenté par la base — Règle 1 (défaut du tiers) :`);
    const sFou = suggestAccount({
      sens: "charge", tiersId: fou.id, compteDefautTiers: rFou?.compte_charge_defaut,
      description: "Prestation divers", nomTiers: fou.nom, secteurActivite: rDos?.secteur_activite,
    });
    check(`achat → compte ${T_CHARGE}`, sFou.compte === T_CHARGE, `${sFou.compte} (${sFou.source})`);
    check("source = tiers", sFou.source === "tiers", sFou.source);
    const sCli = suggestAccount({
      sens: "produit", tiersId: cli.id, compteDefautTiers: rCli?.compte_produit_defaut,
      description: "Vente divers", nomTiers: cli.nom, secteurActivite: rDos?.secteur_activite,
    });
    check(`vente → compte ${T_PRODUIT}`, sCli.compte === T_PRODUIT, `${sCli.compte} (${sCli.source})`);
    check("source = tiers", sCli.source === "tiers", sCli.source);

    // ── ⑥ Règle 3 : tiers sans compte par défaut → fallback du secteur lu en base.
    console.log(`\n⑥ Moteur alimenté par la base — Règle 3 (fallback sectoriel) :`);
    await sb.from("fournisseurs").update({ compte_charge_defaut: null }).eq("id", fou.id);
    const { data: rFou2 } = await sb.from("fournisseurs").select("compte_charge_defaut").eq("id", fou.id).single();
    check("compte_charge_defaut remis à NULL (colonne nullable)", rFou2?.compte_charge_defaut === null, String(rFou2?.compte_charge_defaut));
    const sSecteur = suggestAccount({
      sens: "charge", tiersId: fou.id, compteDefautTiers: rFou2?.compte_charge_defaut,
      description: "Achat divers", nomTiers: "ZZZ SANS MOT CLE", secteurActivite: rDos?.secteur_activite,
    });
    check(`« ${T_SECTEUR} » → charge 6111`, sSecteur.compte === "6111", `${sSecteur.compte} (${sSecteur.source})`);
    check("source = secteur", sSecteur.source === "secteur", sSecteur.source);
  } finally {
    // ── ⑦ Restauration des valeurs d'origine.
    console.log(`\n⑦ Restauration des valeurs d'origine :`);
    await restore();
    const { data: aDos } = await sb.from("dossiers").select("secteur_activite").eq("id", dossierId).single();
    const { data: aFou } = await sb.from("fournisseurs").select("compte_charge_defaut").eq("id", fou.id).single();
    const { data: aCli } = await sb.from("clients").select("compte_produit_defaut").eq("id", cli.id).single();
    check("dossier restauré", (aDos?.secteur_activite ?? null) === backup.secteur, String(aDos?.secteur_activite));
    check("fournisseur restauré", (aFou?.compte_charge_defaut ?? null) === backup.charge, String(aFou?.compte_charge_defaut));
    check("client restauré", (aCli?.compte_produit_defaut ?? null) === backup.produit, String(aCli?.compte_produit_defaut));
  }

  console.log(`\n${fail === 0 ? "🎉 TOUT PASSE" : "⚠️  ÉCHECS"} — ${pass} ok / ${fail} ko\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("💥", e); process.exit(2); });
