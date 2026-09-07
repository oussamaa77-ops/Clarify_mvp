/**
 * redater-bascules-tva.mjs — remet chaque OD de bascule à la date de SON règlement.
 *
 * ─── Ce qu'on répare ─────────────────────────────────────────────────────────
 * `executerLettrageAuto` appelait `executerLettrage` sans `dateReglement` : la
 * bascule retombait donc sur le jour même. Toutes celles posées par la reprise
 * du 2026-08-28 portent cette date, au lieu du jour où l'argent a bougé. Sous le
 * régime des encaissements, c'est la date d'exigibilité de la TVA : elle décide
 * de la PÉRIODE DE DÉCLARATION. Une bascule mal datée sort la TVA d'une
 * déclaration pour l'inscrire dans une autre.
 *
 * Le code est corrigé (`dateDuReglement`), mais un correctif de code ne redate
 * pas l'existant : ce script s'occupe des pièces déjà en base.
 *
 * ─── Pourquoi une mise à jour, et non un délettrage/relettrage ───────────────
 * Repasser par le lettrage régénérerait les bascules avec la bonne date, et
 * c'était tentant : cela exercerait le correctif. Mais cela supprime puis recrée
 * des écritures, redistribue les codes, et laisse une fenêtre où la TVA n'est
 * exigible NULLE PART si la seconde moitié échoue. Or une seule colonne est
 * fausse — `date_ecriture`. Les montants, les comptes, le sens, les codes et le
 * rattachement sont tous justes. On corrige donc ce qui est faux, et rien d'autre.
 *
 * ─── La règle de datation est UNIQUE ────────────────────────────────────────
 * La date cible vient de `dateDuReglement`, importée du serveur — la fonction
 * même qu'emploie désormais le lettrage. Une copie de la règle ici finirait par
 * diverger, et la reprise ne produirait plus ce que produit l'application.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   node --import tsx scripts/redater-bascules-tva.mjs                 # DRY-RUN
 *   node --import tsx scripts/redater-bascules-tva.mjs --apply
 *   node --import tsx scripts/redater-bascules-tva.mjs --rollback=backup_....json
 *
 * Réversible : chaque ligne touchée est sauvegardée avec sa date d'ORIGINE.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { dateDuReglement } from "../src/server/lettrage-compta.functions.ts";
import { bornesExerciceActif } from "../src/lib/genererEcritures.ts";
import { dansExercice } from "../src/lib/exercice-comptable.ts";
import {
  RACINE_COLLECTEE, RACINE_DEDUCTIBLE, PREFIXE_DECLARATION_TVA,
} from "../src/lib/liquidation-tva.ts";
import { COMPTE_TVA_ATTENTE } from "../src/lib/genererEcritures.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const flag = (nom) => {
  const hit = argv.find((a) => a === `--${nom}` || a.startsWith(`--${nom}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf("=");
  return eq === -1 ? "" : hit.slice(eq + 1).replace(/^["']|["']$/g, "");
};
const APPLY = flag("apply") !== undefined;
const ROLLBACK = flag("rollback") || null;

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env"), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);

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
const sb = createClient(env.SUPABASE_URL || env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  global: { fetch: proxyFetch }, auth: { persistSession: false, autoRefreshToken: false },
});

const nb = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const txt = (v) => String(v ?? "").trim();
const jour = (l) => txt(l.date_ecriture).slice(0, 10);
const r2 = (x) => Math.round(x * 100) / 100;
const fmt = (x) => x.toLocaleString("fr-MA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

// ─── Rollback ───────────────────────────────────────────────────────────────
if (ROLLBACK) {
  const sauv = JSON.parse(fs.readFileSync(path.join(ROOT, ROLLBACK), "utf8"));
  console.log(`\n⏪ ROLLBACK depuis ${ROLLBACK} — ${sauv.redatees.length} ligne(s) à remettre à leur date d'origine\n`);
  let ok = 0;
  for (const l of sauv.redatees) {
    const { error } = await sb.from("ecritures_comptables")
      .update({ date_ecriture: l.date_avant }).eq("id", l.id);
    if (error) console.log(`  ❌ ${l.id} : ${error.message}`);
    else { ok += 1; console.log(`  ↩ ${l.reference_piece} ${l.compte_numero} ${l.date_apres} → ${l.date_avant}`); }
  }
  console.log(`\n${ok}/${sauv.redatees.length} ligne(s) restaurée(s).\n`);
  process.exit(0);
}

console.log(`\n${APPLY ? "🔧 APPLICATION" : "🔍 SIMULATION (dry-run)"} — redatation des OD de bascule de TVA\n`);

/** Une ligne de bascule : compte de TVA, en OD, portant un code de lettrage. */
const estLigneBascule = (l) => {
  const c = txt(l.compte_numero);
  const estCompteTva = c.startsWith(RACINE_COLLECTEE) || c.startsWith(RACINE_DEDUCTIBLE)
    || c.startsWith(COMPTE_TVA_ATTENTE.vente) || c.startsWith(COMPTE_TVA_ATTENTE.achat);
  return estCompteTva
    && txt(l.journal_code).toUpperCase() === "OD"
    && Boolean(txt(l.lettrage_code))
    // Une déclaration périodique n'est pas une bascule : elle est datée du
    // dernier jour de sa période, et ce n'est pas une erreur.
    && !txt(l.reference_piece).startsWith(PREFIXE_DECLARATION_TVA);
};

const { data: dossiers, error: eDos } = await sb.from("dossiers")
  .select("id,nom_societe,date_debut_activite").order("nom_societe");
if (eDos) { console.error(`❌ ${eDos.message}`); process.exit(1); }

const aRedater = [];
const refusees = [];

for (const d of dossiers ?? []) {
  const { data, error } = await sb.from("ecritures_comptables")
    .select("id,compte_numero,journal_code,date_ecriture,debit,credit,reference_piece,libelle,lettrage_code")
    .eq("dossier_id", d.id);
  if (error) { console.error(`❌ ${d.nom_societe} : ${error.message}`); process.exit(1); }
  const lignes = data ?? [];

  // Une bascule par code de lettrage. Les DEUX lignes de la pièce portent le
  // code : on les redate ensemble, sinon la pièce se retrouverait à cheval sur
  // deux périodes — un déséquilibre qui n'apparaîtrait qu'à la balance.
  const parCode = new Map();
  for (const l of lignes.filter(estLigneBascule)) {
    const code = txt(l.lettrage_code);
    if (!parCode.has(code)) parCode.set(code, []);
    parCode.get(code).push(l);
  }
  if (!parCode.size) continue;

  const bornes = bornesExerciceActif(d);

  for (const [code, piece] of parCode) {
    // Le groupe apparié : les lignes de tiers qui portent le même code. C'est
    // exactement ce que voit `executerLettrageAuto`, et on lui applique la même
    // fonction — pas une réimplémentation de la règle.
    const groupe = lignes.filter((l) => txt(l.lettrage_code) === code && !estLigneBascule(l));
    const cible = dateDuReglement(groupe);

    const ref = txt(piece[0]?.reference_piece);
    const actuelle = jour(piece[0]);
    const montant = r2(piece.reduce((s, l) => s + nb(l.debit), 0));

    if (!cible) {
      refusees.push({ dossier: d.nom_societe, code, ref, raison: "aucune ligne datée dans le groupe lettré" });
      continue;
    }
    // Garde de trésorerie : sans ligne BQ/CAI, `dateDuReglement` retombe sur la
    // date la plus tardive du groupe — acceptable pour un calcul, pas pour une
    // écriture. On refuse plutôt que d'inscrire une date qu'on ne sait pas justifier.
    const aTresorerie = groupe.some((l) => ["BQ", "CAI"].includes(txt(l.journal_code).toUpperCase()));
    if (!aTresorerie) {
      refusees.push({ dossier: d.nom_societe, code, ref, raison: "aucune ligne de trésorerie (BQ/CAI) dans le groupe" });
      continue;
    }
    // Même verrou que le générateur : on ne redate pas une pièce HORS exercice
    // ouvert. Le script ne passe pas par `insererPiece`, donc le contrôle qui s'y
    // trouve ne le protège pas — il faut le refaire ici, explicitement.
    if (!dansExercice(cible, bornes)) {
      refusees.push({ dossier: d.nom_societe, code, ref,
        raison: `date de règlement ${cible} hors exercice ouvert (${bornes.debut} → ${bornes.fin})` });
      continue;
    }
    // La pièce doit être équilibrée avant qu'on y touche : redater une pièce
    // déjà boiteuse déplacerait le déséquilibre sans le montrer.
    const dD = r2(piece.reduce((s, l) => s + nb(l.debit), 0));
    const dC = r2(piece.reduce((s, l) => s + nb(l.credit), 0));
    if (Math.abs(dD - dC) > 0.005) {
      refusees.push({ dossier: d.nom_societe, code, ref, raison: `pièce déséquilibrée (D ${fmt(dD)} / C ${fmt(dC)})` });
      continue;
    }
    if (cible === actuelle) continue;   // déjà juste

    aRedater.push({ dossier: d.nom_societe, dossierId: d.id, code, ref, montant,
      avant: actuelle, apres: cible, lignes: piece });
  }
}

if (refusees.length) {
  console.log(`⛔ ${refusees.length} bascule(s) REFUSÉE(S) — laissées telles quelles :`);
  for (const r of refusees) console.log(`   ${pad(r.dossier.slice(0, 28), 29)} ${pad(r.code, 4)} ${pad(r.ref.slice(0, 24), 25)} ${r.raison}`);
  console.log();
}

if (!aRedater.length) {
  console.log(`✅ Aucune bascule à redater — toutes portent déjà la date de leur règlement.\n`);
  process.exit(0);
}

console.log(`${aRedater.length} bascule(s) à redater (${aRedater.reduce((s, x) => s + x.lignes.length, 0)} lignes) :\n`);
console.log(`  ${pad("Dossier", 29)} ${pad("Code", 5)} ${pad("Pièce", 25)} ${padL("Montant", 12)}   ${pad("actuelle", 12)} → règlement`);
for (const x of aRedater) {
  console.log(`  ${pad(x.dossier.slice(0, 28), 29)} ${pad(x.code, 5)} ${pad(x.ref.slice(0, 24), 25)} `
    + `${padL(fmt(x.montant), 12)}   ${pad(x.avant, 12)} → ${x.apres}`);
}

if (!APPLY) {
  console.log(`\n🔍 Dry-run — rien n'a été écrit. Ajoutez --apply pour redater.\n`);
  process.exit(0);
}

// ─── Application ────────────────────────────────────────────────────────────
// Sauvegarde AVANT toute écriture : PostgREST n'a pas de transaction multi-
// instructions, la réversibilité passe donc par le fichier (cf. les autres scripts).
const horodatage = new Date().toISOString().replace(/[:.]/g, "-");
const chemin = `backup_redatage_tva_${horodatage}.json`;
const sauvegarde = { date: new Date().toISOString(), redatees: [] };
for (const x of aRedater) {
  for (const l of x.lignes) {
    sauvegarde.redatees.push({ id: l.id, dossier: x.dossier, reference_piece: x.ref,
      compte_numero: l.compte_numero, date_avant: jour(l), date_apres: x.apres });
  }
}
fs.writeFileSync(path.join(ROOT, chemin), JSON.stringify(sauvegarde, null, 2), "utf8");
console.log(`\n💾 Sauvegarde : ${chemin} (${sauvegarde.redatees.length} lignes)`);

let ok = 0, ko = 0;
for (const x of aRedater) {
  // Les deux lignes de la pièce en UN appel : elles ne doivent jamais se
  // retrouver à des dates différentes, même transitoirement.
  const { error } = await sb.from("ecritures_comptables")
    .update({ date_ecriture: x.apres })
    .in("id", x.lignes.map((l) => l.id));
  if (error) { ko += 1; console.log(`  ❌ ${x.dossier} ${x.ref} : ${error.message}`); }
  else { ok += 1; console.log(`  ✅ ${pad(x.dossier.slice(0, 28), 29)} ${pad(x.ref.slice(0, 24), 25)} ${x.avant} → ${x.apres}`); }
}

console.log(`\n${"─".repeat(70)}`);
console.log(`${ok} bascule(s) redatée(s)${ko ? `, ${ko} en échec` : ""}.`);
console.log(`Rollback : node --import tsx scripts/redater-bascules-tva.mjs --rollback=${chemin}`);
console.log(`Contrôle : node --import tsx scripts/ecart-tva-par-periode.mjs --dates-base`);
console.log(`           (doit annoncer 0 bascule mal datée et les mêmes écarts qu'avant)\n`);
