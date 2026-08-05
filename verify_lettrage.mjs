// verify_lettrage.mjs — LECTURE SEULE (sauf --apply). Contrôle sur la base RÉELLE :
//   • présence des colonnes de lettrage (migration appliquée ?) ;
//   • cohérence des lettrages existants (chaque code se solde) ;
//   • état de la TVA au régime des encaissements (comptes d'attente / exigible) ;
//   • génération d'un export Sage 100 et vérification que le code AA y figure.
//
// Lancement :  node --import tsx verify_lettrage.mjs
//              node --import tsx verify_lettrage.mjs --apply   (lettre pour de vrai)

import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  COMPTES_TVA, apparierAutomatiquement, codeLettrageDepuisRang, controlerEquilibre,
  prochainCodeLettrage, regrouperParCompte, sensDuCompte,
} from "./src/services/lettrage.ts";
import { buildSage100CSV, controlerExport } from "./src/services/exportSage.ts";

const APPLY = process.argv.includes("--apply");

const env = Object.fromEntries(
  fs.readFileSync(new URL(".env", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);
// Les server functions (--apply) construisent LEUR PROPRE client depuis
// process.env : parser .env dans un objet local ne leur sert à rien. On propage
// donc les clés, sans écraser une variable déjà posée par l'environnement.
for (const [k, v] of Object.entries(env)) {
  if (process.env[k] === undefined) process.env[k] = v;
}

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

let pass = 0, fail = 0, warn = 0;
const check = (label, cond, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  cond ? pass++ : fail++;
};
// État des DONNÉES : signalé sans faire échouer la sonde, dont l'objet est de
// valider le MOTEUR. Un dossier sans poste à lettrer n'est pas un bug.
const donnees = (label, cond, detail = "") => {
  console.log(`  ${cond ? "✅" : "⚠️ "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (cond) pass++; else warn++;
};

const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const fmt = (x) => Number(x).toLocaleString("fr-MA", { minimumFractionDigits: 2 });

(async () => {
  // ── 0. La migration est-elle appliquée ? ───────────────────────────────────
  console.log("── Schéma ──");
  const sonde = await sb.from("ecritures_comptables")
    .select("id,lettrage_code,lettrage_date,lettrage_origine").limit(1);
  // Migration pas encore appliquée : on NE s'arrête PAS. Le moteur et l'export
  // sont indépendants du schéma, et c'est précisément avant la migration qu'on
  // veut savoir s'ils tiennent sur les données réelles. Seuls les contrôles qui
  // lisent la colonne sont neutralisés.
  const SCHEMA_OK = !sonde.error;
  donnees("colonnes lettrage_code / lettrage_date / lettrage_origine présentes", SCHEMA_OK,
    SCHEMA_OK ? "migration appliquée" :
      "migration 20260805120000 NON appliquée → contrôles de lettrage en base ignorés");

  // ── 1. Dossier de test : celui qui a le plus d'écritures sur comptes de tiers ─
  const COLS = "id,dossier_id,compte_numero,libelle,debit,credit,date_ecriture,reference_piece,journal_code"
    + (SCHEMA_OK ? ",lettrage_code,lettrage_date" : "");
  const { data: toutes, error: eEcr } = await sb.from("ecritures_comptables")
    .select(COLS)
    .limit(20000);
  check("lecture ecritures_comptables", !eEcr, eEcr?.message ?? `${toutes?.length ?? 0} ligne(s)`);
  if (eEcr) process.exit(1);

  const parDossier = new Map();
  for (const e of toutes ?? []) {
    if (!sensDuCompte(e.compte_numero)) continue;
    parDossier.set(e.dossier_id, (parDossier.get(e.dossier_id) ?? 0) + 1);
  }
  const [dossierId, nbTiers] = [...parDossier.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (!dossierId) {
    console.log("\n⛔ Aucune écriture sur un compte de tiers (342x / 441x) en base.");
    process.exit(4);
  }
  const { data: dos } = await sb.from("dossiers").select("nom_societe").eq("id", dossierId).single();
  const lignesDossier = (toutes ?? []).filter((e) => e.dossier_id === dossierId);
  const lignesTiers = lignesDossier.filter((e) => sensDuCompte(e.compte_numero));
  console.log(`\nDossier : « ${dos?.nom_societe} » — ${nbTiers} écriture(s) sur comptes de tiers\n`);

  // ── 2. Cohérence des lettrages DÉJÀ posés ──────────────────────────────────
  console.log("── Lettrages existants ──");
  const parCode = new Map();
  for (const e of lignesDossier) {
    const c = String(e.lettrage_code ?? "").trim();
    if (!c) continue;
    if (!parCode.has(c)) parCode.set(c, []);
    parCode.get(c).push(e);
  }
  console.log(`  ${parCode.size} code(s) de lettrage en base`);

  const desequilibres = [];
  for (const [code, lignes] of parCode) {
    const d = lignes.reduce((s, l) => s + n(l.debit), 0);
    const c = lignes.reduce((s, l) => s + n(l.credit), 0);
    if (Math.abs(d - c) > 0.005) desequilibres.push(`${code} (écart ${(d - c).toFixed(2)})`);
  }
  check("chaque code de lettrage se solde exactement", desequilibres.length === 0,
    desequilibres.join(", ") || `${parCode.size} code(s) contrôlé(s)`);

  // Le prochain code ne doit JAMAIS être un code déjà attribué.
  const prochain = prochainCodeLettrage([...parCode.keys()]);
  check("le prochain code est libre", !parCode.has(prochain), `prochain = ${prochain}`);
  check("le format du code est bien AA/AB/… (2 lettres minimum)", /^[A-Z]{2,}$/.test(prochain), prochain);

  // ── 3. TVA au régime des encaissements ─────────────────────────────────────
  console.log("\n── TVA (régime des encaissements) ──");
  const soldeCompte = (numero, sens) => lignesDossier
    .filter((e) => String(e.compte_numero ?? "").trim() === numero)
    .reduce((s, e) => s + (sens === "credit" ? n(e.credit) - n(e.debit) : n(e.debit) - n(e.credit)), 0);

  const attenteVente = soldeCompte(COMPTES_TVA.client.attente, "credit");
  const exigibleVente = soldeCompte(COMPTES_TVA.client.exigible, "credit");
  const attenteAchat = soldeCompte(COMPTES_TVA.fournisseur.attente, "debit");
  const exigibleAchat = soldeCompte(COMPTES_TVA.fournisseur.exigible, "debit");
  console.log(`  Ventes  : ${COMPTES_TVA.client.attente} attente ${fmt(attenteVente)} → ${COMPTES_TVA.client.exigible} exigible ${fmt(exigibleVente)}`);
  console.log(`  Achats  : ${COMPTES_TVA.fournisseur.attente} attente ${fmt(attenteAchat)} → ${COMPTES_TVA.fournisseur.exigible} exigible ${fmt(exigibleAchat)}`);

  // Un compte d'attente NÉGATIF veut dire qu'on a basculé plus de TVA qu'il n'en
  // était en attente : c'est l'anomalie que la bascule doit rendre impossible.
  check("aucun compte de TVA en attente n'est négatif",
    attenteVente >= -0.005 && attenteAchat >= -0.005,
    `vente ${fmt(attenteVente)} · achat ${fmt(attenteAchat)}`);

  // Résidu sur les comptes du régime des DÉBITS. Un solde non nul n'est PAS une
  // anomalie en soi : la TVA des factures déjà réglées avant la bascule y reste
  // légitimement (elle est réellement exigible). Seul le résidu appartenant à
  // une facture NON RÉGLÉE reste à reclasser — sans cette distinction, la sonde
  // réclamerait le script indéfiniment.
  const residuTotal = soldeCompte("44551", "credit") + soldeCompte("34552", "debit");
  const [{ data: fVentes }, { data: fAchats }] = await Promise.all([
    sb.from("factures").select("id,numero,statut_paiement").eq("dossier_id", dossierId),
    sb.from("factures_fournisseurs").select("id,numero,statut_paiement").eq("dossier_id", dossierId),
  ]);
  // Index SÉPARÉS par table : un même numéro peut désigner une facture client ET
  // une facture fournisseur (constaté en base) — un index commun se tromperait
  // de pièce, donc de statut de paiement.
  const idx = { "44551": new Map(), "34552": new Map() };
  for (const f of fVentes ?? []) { idx["44551"].set(String(f.id), f); if (f.numero) idx["44551"].set(String(f.numero), f); }
  for (const f of fAchats ?? []) { idx["34552"].set(String(f.id), f); if (f.numero) idx["34552"].set(String(f.numero), f); }

  // Soldes NETS par pièce : les OD de reclassement contre-passent la ligne
  // d'origine, il faut donc les compter, pas les ignorer.
  const resteParPiece = new Map();
  for (const e of lignesDossier) {
    const cpt = String(e.compte_numero ?? "").trim();
    if (cpt !== "44551" && cpt !== "34552") continue;
    const m = cpt === "44551" ? n(e.credit) - n(e.debit) : n(e.debit) - n(e.credit);
    const cle = `${cpt}|${e.reference_piece ?? ""}`;
    resteParPiece.set(cle, (resteParPiece.get(cle) ?? 0) + m);
  }
  let residuImpaye = 0;
  const piecesImpayees = [];
  for (const [cle, montant] of resteParPiece) {
    if (montant <= 0.005) continue;
    const [cpt, ref] = cle.split("|");
    const f = idx[cpt].get(ref);
    if (f && f.statut_paiement !== "payee") {
      residuImpaye += montant;
      piecesImpayees.push(`${f.numero ?? ref} (${montant.toFixed(2)})`);
    }
  }
  console.log(`  Anciens comptes 44551/34552 : ${fmt(residuTotal)} — dont ${fmt(residuImpaye)} sur factures non réglées`);
  donnees("plus aucune TVA de facture NON RÉGLÉE sur les anciens comptes", residuImpaye < 0.005,
    residuImpaye >= 0.005
      ? `${piecesImpayees.join(", ")} → node --import tsx scripts/reclasser-tva-encaissement.ts --apply`
      : `${fmt(residuTotal)} restant = factures déjà réglées, à laisser en place`);

  // ── 4. Appariements que le moteur saurait lettrer ──────────────────────────
  console.log("\n── Appariement automatique ──");
  const postes = regrouperParCompte(lignesTiers);
  let groupesTotal = 0;
  let premierGroupe = null;      // sert de jeu d'essai réaliste à l'export
  const apercu = [];
  for (const poste of postes) {
    const groupes = apparierAutomatiquement(poste.lignes);
    groupesTotal += groupes.length;
    if (!premierGroupe && groupes.length) premierGroupe = groupes[0];
    for (const g of groupes.slice(0, 2)) {
      apercu.push(`${poste.compte} : ${g.length} lignes · ${fmt(controlerEquilibre(g).totalDebit)} MAD`);
    }
  }
  console.log(`  ${postes.length} compte(s) de tiers · ${groupesTotal} appariement(s) certain(s) détecté(s)`);
  for (const a of apercu.slice(0, 6)) console.log(`    ${a}`);

  // Tout groupe proposé DOIT passer le contrôle d'équilibre : c'est l'invariant
  // qui empêche le moteur de faire disparaître un résidu de créance.
  let tousEquilibres = true;
  for (const poste of postes) {
    for (const g of apparierAutomatiquement(poste.lignes)) {
      if (!controlerEquilibre(g).ok) tousEquilibres = false;
    }
  }
  check("tout appariement proposé est équilibré", tousEquilibres, `${groupesTotal} groupe(s)`);
  donnees("des postes restent à lettrer", groupesTotal > 0,
    groupesTotal > 0 ? `${groupesTotal} à traiter` : "aucun appariement certain (à lettrer à la main)");

  // ── 5. Export Sage 100 : le code de lettrage doit y figurer ────────────────
  console.log("\n── Export Sage 100 ──");
  // Jeu exporté : les lignes déjà lettrées si elles existent, sinon un
  // appariement RÉELLEMENT détecté ci-dessus, estampillé du prochain code. Le
  // groupe doit être un vrai rapprochement équilibré — agrafer un code sur deux
  // lignes prises au hasard produirait un lettrage incohérent et ne prouverait rien.
  const horodatage = new Date().toISOString();
  const lignesExport = parCode.size
    ? lignesDossier.filter((e) => String(e.lettrage_code ?? "").trim())
    : (premierGroupe ?? []).map((l) => ({ ...l, lettrage_code: "AA", lettrage_date: horodatage }));

  if (!lignesExport.length) {
    console.log("  ⚠️  aucun lettrage en base ni appariement détecté — export non contrôlé");
  }

  const csv = buildSage100CSV(lignesExport);
  const entete = csv.split("\r\n")[0];
  check("l'en-tête Sage porte une colonne Lettrage", entete.includes("Lettrage"), entete);

  const codesDansFichier = [...new Set(
    csv.split("\r\n").slice(1).map((l) => l.split(";")[7]).filter(Boolean),
  )];
  check("le fichier Sage contient au moins un code de lettrage",
    codesDansFichier.length > 0, codesDansFichier.join(", ") || "aucun");
  check("le code AA figure dans l'export Sage",
    codesDansFichier.includes("AA") || parCode.has("AA"),
    parCode.has("AA") ? "AA déjà attribué en base" : `codes présents : ${codesDansFichier.join(", ")}`);
  check("codeLettrageDepuisRang(1) vaut bien AA", codeLettrageDepuisRang(1) === "AA");

  const ctrl = controlerExport(lignesExport);
  console.log(`  export : ${ctrl.lignes} ligne(s) · ${ctrl.nbLettrees} lettrée(s) · débit ${fmt(ctrl.totalDebit)} / crédit ${fmt(ctrl.totalCredit)}`);
  check("aucun code de lettrage déséquilibré dans l'export",
    ctrl.lettragesDesequilibres.length === 0, ctrl.lettragesDesequilibres.join(", ") || "OK");

  console.log("\n  Extrait du fichier Sage 100 :");
  for (const l of csv.split("\r\n").slice(0, 4)) console.log(`    ${l}`);

  // ── 6. Lettrage réel (option --apply) ──────────────────────────────────────
  if (APPLY && !SCHEMA_OK) {
    console.log("\n⛔ --apply demandé mais la migration n'est pas appliquée : rien n'a été écrit.");
  } else if (APPLY) {
    // Exécuté même sans appariement en attente : relancer sur un dossier déjà
    // lettré est le test d'IDEMPOTENCE, et il doit passer sans rien redoubler.
    console.log("\n── Lettrage RÉEL (--apply) ──");
    // On appelle le CŒUR, pas la server function : celle-ci ne rendrait rien
    // hors runtime TanStack et la sonde conclurait à tort à un échec.
    const { executerLettrageAuto } = await import("./src/server/lettrage-compta.functions.ts");
    const r = await executerLettrageAuto(sb, { dossierId });
    check("executerLettrageAuto s'exécute", r?.ok === true, r?.reason ?? `${r?.lettres ?? 0} code(s) posé(s)`);
    if (r?.codes?.length) console.log(`  codes posés : ${r.codes.join(", ")}`);

    // CONTRÔLE EN BASE : le retour ne prouve rien, l'état écrit si. On relit et
    // on vérifie que chaque code posé se solde — l'invariant du lettrage.
    const { data: apres } = await sb.from("ecritures_comptables")
      .select("lettrage_code,lettrage_origine,debit,credit,compte_numero")
      .eq("dossier_id", dossierId).not("lettrage_code", "is", null);
    const codesEnBase = new Map();
    for (const l of apres ?? []) {
      const c = String(l.lettrage_code).trim();
      if (!codesEnBase.has(c)) codesEnBase.set(c, { d: 0, c: 0, n: 0 });
      const g = codesEnBase.get(c);
      g.d += n(l.debit); g.c += n(l.credit); g.n++;
    }
    check("le lettrage est bien PERSISTÉ en base", codesEnBase.size > 0,
      `${apres?.length ?? 0} ligne(s), codes ${[...codesEnBase.keys()].join(", ") || "aucun"}`);
    const bancals = [...codesEnBase.entries()]
      .filter(([, g]) => Math.abs(g.d - g.c) > 0.005)
      .map(([c, g]) => `${c} (écart ${(g.d - g.c).toFixed(2)})`);
    check("chaque code écrit en base se solde", bancals.length === 0, bancals.join(", ") || "OK");
    for (const [c, g] of codesEnBase) console.log(`    ${c} : ${g.n} ligne(s) · ${fmt(g.d)} / ${fmt(g.c)}`);
  } else if (groupesTotal > 0) {
    console.log(`\n  ℹ️  ${groupesTotal} appariement(s) prêt(s) — relancez avec --apply pour lettrer réellement.`);
  }

  console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} succès, ${fail} échec(s)${warn ? `, ${warn} point(s) à surveiller` : ""}`);
  process.exit(fail === 0 ? 0 : 1);
})();
