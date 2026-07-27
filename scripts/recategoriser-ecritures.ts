/**
 * recategoriser-ecritures.ts — script ONE-SHOT de réalignement des comptes PCM
 * des écritures comptables DÉJÀ enregistrées, avec le moteur de catégorisation
 * centralisé (`src/lib/categorization-engine.ts`).
 *
 * Contexte : les factures saisies AVANT l'arrivée du moteur ont été imputées sur
 * les comptes génériques codés en dur à l'époque (achats → 6141, ventes → 7111).
 * Ce script rejoue le moteur sur ces écritures pour leur donner le compte précis
 * (61455 télécom, 61254 fournitures de bureau, 6136 honoraires, 7124 prestations…).
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   node --import tsx scripts/recategoriser-ecritures.ts                  # DRY-RUN
 *   node --import tsx scripts/recategoriser-ecritures.ts --apply          # écrit
 *   node --import tsx scripts/recategoriser-ecritures.ts --dossier="XXX"
 *   node --import tsx scripts/recategoriser-ecritures.ts --secteur="Services IT"
 *   node --import tsx scripts/recategoriser-ecritures.ts --rollback=backup.json
 *
 * Options :
 *   --dossier="<nom>"   Raison sociale ciblée (défaut : DIGITAL SOLUTIONS MAROC SARL).
 *   --apply             Écrit en base. SANS ce drapeau : simulation seule.
 *   --secteur="<x>"     Force le secteur d'activité pour la simulation (le dossier
 *                       n'est PAS modifié) — utile quand `dossiers.secteur_activite`
 *                       est vide et qu'on veut voir ce que donnerait la Règle 3.
 *   --persist-secteur   Avec --secteur ET --apply : écrit AUSSI le secteur sur le
 *                       dossier (équivalent du Select des Réglages du dossier), pour
 *                       que les prochaines saisies bénéficient du même repli.
 *   --rollback=<file>   Restaure les comptes depuis un fichier de sauvegarde.
 *
 * ─── Sûreté ──────────────────────────────────────────────────────────────────
 * PostgREST n'expose pas de transaction multi-requêtes : la réversibilité est
 * assurée par un fichier de sauvegarde `backup_recateg_<dossier>_<date>.json`
 * (écrit AVANT la première mise à jour) rejouable via `--rollback`.
 *
 * Le script ne DÉGRADE jamais une imputation : une suggestion issue du repli
 * générique (`source === "defaut"`) est ignorée, et le repli sectoriel n'est
 * accepté que sur un compte encore générique (6141 / 7111). Sans cette garde,
 * relancer le script sur un compte déjà affiné (61455) le ramènerait à 6141.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  suggestAccount,
  COMPTE_CHARGE_DEFAUT,
  COMPTE_PRODUIT_DEFAUT,
  type SuggestionCompte,
} from "../src/lib/categorization-engine";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ─── Arguments ───────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (nom: string): string | undefined => {
  const hit = argv.find((a) => a === `--${nom}` || a.startsWith(`--${nom}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf("=");
  return eq === -1 ? "" : hit.slice(eq + 1).replace(/^["']|["']$/g, "");
};
const NOM_DOSSIER = flag("dossier") || "DIGITAL SOLUTIONS MAROC SARL";
const APPLY = flag("apply") !== undefined;
const SECTEUR_FORCE = flag("secteur") || null;
const PERSIST_SECTEUR = flag("persist-secteur") !== undefined;
const ROLLBACK = flag("rollback") || null;

// ─── Connexion Supabase (service_role : le script contourne la RLS) ──────────

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env"), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
) as Record<string, string>;

// Le proxy TLS d'entreprise casse le `fetch` global de Node → repli undici
// (cf. mémoire « proxy-supabase-server »).
let PROXY_DIRECT = false;
async function proxyFetch(input: any, init?: any): Promise<any> {
  const direct = async () => {
    const { fetch: uf, Agent } = await import("undici");
    return uf(String(input), { ...init, dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) } as any);
  };
  if (PROXY_DIRECT) return direct();
  try { return await fetch(String(input), init); }
  catch { PROXY_DIRECT = true; return direct(); }
}
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  global: { fetch: proxyFetch as any },
  auth: { persistSession: false },
});

// ─── Utilitaires ─────────────────────────────────────────────────────────────

const normNom = (v: string | null | undefined) =>
  (v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();

/** Désignations des lignes d'une facture, concaténées : la MATIÈRE de la Règle 2. */
function designations(lignes: unknown): string {
  if (!Array.isArray(lignes)) return "";
  return lignes
    .map((l: any) => String(l?.designation ?? l?.libelle ?? "").trim())
    .filter(Boolean)
    .join(" ; ");
}

/** Comptes génériques : les seuls qu'un repli sectoriel a le droit d'écraser. */
const GENERIQUES = new Set([COMPTE_CHARGE_DEFAUT, COMPTE_PRODUIT_DEFAUT]);

/**
 * Une suggestion ne remplace l'imputation existante que si elle est PLUS PRÉCISE :
 *   • règle tiers / mots-clés → déterministe, toujours acceptée ;
 *   • repli sectoriel → seulement sur un compte encore générique ;
 *   • repli générique → jamais (sinon on dégraderait un compte déjà affiné).
 */
function estPlusPrecis(sug: SuggestionCompte, compteActuel: string): { ok: boolean; raison: string } {
  if (sug.compte === compteActuel) return { ok: false, raison: "déjà à jour" };
  if (sug.source === "tiers" || sug.source === "mots_cles") return { ok: true, raison: sug.source };
  if (sug.source === "secteur") {
    return GENERIQUES.has(compteActuel)
      ? { ok: true, raison: "secteur" }
      : { ok: false, raison: `repli sectoriel refusé sur un compte déjà spécifique (${compteActuel})` };
  }
  return { ok: false, raison: "repli générique — aucune précision apportée" };
}

interface Modif {
  id: string;
  journal: string;
  libelle: string;
  ancien: string;
  nouveau: string;
  motif: string;
}

// ─── Rollback ────────────────────────────────────────────────────────────────

if (ROLLBACK) {
  const f = path.isAbsolute(ROLLBACK) ? ROLLBACK : path.join(ROOT, ROLLBACK);
  const sauvegarde = JSON.parse(fs.readFileSync(f, "utf8")) as { modifications: Modif[] };
  console.log(`\n↩️  ROLLBACK depuis ${path.basename(f)} — ${sauvegarde.modifications.length} écriture(s)\n`);
  for (const m of sauvegarde.modifications) {
    const { error } = await sb.from("ecritures_comptables").update({ compte_numero: m.ancien }).eq("id", m.id);
    console.log(`  ${error ? "❌" : "✅"} ${m.id.slice(0, 8)} ${m.nouveau} → ${m.ancien}${error ? ` (${error.message})` : ""}`);
  }
  console.log("");
  process.exit(0);
}

// ─── 1. Ciblage du dossier ───────────────────────────────────────────────────

console.log(`\n🔧 Recatégorisation PCM — ${APPLY ? "MODE ÉCRITURE (--apply)" : "SIMULATION (dry-run)"}\n`);

const { data: dossiers, error: errDos } = await sb
  .from("dossiers").select("id,nom_societe,secteur_activite");
if (errDos) { console.error(`❌ Lecture des dossiers impossible : ${errDos.message}`); process.exit(1); }

const cible = normNom(NOM_DOSSIER);
let candidats = (dossiers ?? []).filter((d) => normNom(d.nom_societe) === cible);
if (candidats.length === 0) {
  // Tolérance sur les suffixes de forme juridique (« … SARL AU » vs « … SARL »).
  candidats = (dossiers ?? []).filter((d) => {
    const n = normNom(d.nom_societe);
    return n.startsWith(cible) || cible.startsWith(n);
  });
  if (candidats.length === 1) {
    console.log(`ℹ️  Aucune correspondance EXACTE pour « ${NOM_DOSSIER} » ; un seul dossier proche retenu :`);
    console.log(`   → « ${candidats[0].nom_societe} »\n`);
  }
}
if (candidats.length === 0) {
  console.error(`❌ ARRÊT : aucun dossier nommé « ${NOM_DOSSIER} ».`);
  console.error(`   Dossiers existants : ${(dossiers ?? []).map((d) => `« ${d.nom_societe} »`).join(", ") || "(aucun)"}`);
  process.exit(1);
}
if (candidats.length > 1) {
  console.error(`❌ ARRÊT : « ${NOM_DOSSIER} » est ambigu — ${candidats.length} dossiers correspondent :`);
  for (const d of candidats) console.error(`   • ${d.id}  « ${d.nom_societe} »`);
  console.error(`   Relance avec --dossier="<raison sociale exacte>".`);
  process.exit(1);
}

const dossier = candidats[0];
const dossierId = dossier.id;
const secteurBase = dossier.secteur_activite ?? null;
const secteur = SECTEUR_FORCE ?? secteurBase;

console.log(`📁 Dossier  : ${dossier.nom_societe}`);
console.log(`   id       : ${dossierId}`);
const suffixeSecteur = !SECTEUR_FORCE ? ""
  : PERSIST_SECTEUR && APPLY ? " (FORCÉ et PERSISTÉ sur le dossier)"
  : PERSIST_SECTEUR ? " (FORCÉ ; sera persisté avec --apply)"
  : " (FORCÉ pour la simulation, dossier non modifié)";
console.log(`   secteur  : ${secteur ? `« ${secteur} »${suffixeSecteur}` : "NON RENSEIGNÉ → la Règle 3 (repli sectoriel) ne pourra pas s'appliquer"}`);

// Le secteur est écrit AVANT les écritures : s'il échoue, on s'arrête sans avoir
// touché la comptabilité (et le repli sectoriel n'aurait de toute façon rien donné).
if (SECTEUR_FORCE && PERSIST_SECTEUR && APPLY) {
  const { error } = await sb.from("dossiers").update({ secteur_activite: SECTEUR_FORCE }).eq("id", dossierId);
  if (error) { console.error(`\n❌ ARRÊT : écriture du secteur impossible — ${error.message}`); process.exit(1); }
  console.log(`   ✅ dossiers.secteur_activite : ${JSON.stringify(secteurBase)} → « ${SECTEUR_FORCE} »`);
}

// ─── 2. Chargement des données ───────────────────────────────────────────────

const [{ data: ecritures, error: errEcr }, { data: ffs }, { data: fournisseurs }, { data: fcs }, { data: clients }] =
  await Promise.all([
    sb.from("ecritures_comptables")
      .select("id,journal_code,compte_numero,libelle,debit,credit,date_ecriture,reference_piece,facture_id")
      .eq("dossier_id", dossierId).order("date_ecriture"),
    sb.from("factures_fournisseurs").select("id,numero,fournisseur_id,fournisseur_nom,lignes").eq("dossier_id", dossierId),
    sb.from("fournisseurs").select("id,nom,compte_charge_defaut").eq("dossier_id", dossierId),
    sb.from("factures").select("id,numero,client_id,lignes").eq("dossier_id", dossierId),
    sb.from("clients").select("id,nom,compte_produit_defaut").eq("dossier_id", dossierId),
  ]);
if (errEcr) { console.error(`❌ Lecture des écritures impossible : ${errEcr.message}`); process.exit(1); }

const ffParId = new Map((ffs ?? []).map((f) => [f.id, f]));
const ffParNumero = new Map((ffs ?? []).map((f) => [normNom(f.numero), f]));
const fournParId = new Map((fournisseurs ?? []).map((f) => [f.id, f]));
const fournParNom = new Map((fournisseurs ?? []).map((f) => [normNom(f.nom), f]));
const fcParId = new Map((fcs ?? []).map((f) => [f.id, f]));
const fcParNumero = new Map((fcs ?? []).map((f) => [normNom(f.numero), f]));
const cliParId = new Map((clients ?? []).map((c) => [c.id, c]));

console.log(`\n📊 ${(ecritures ?? []).length} écriture(s) sur le dossier.\n`);

// ─── 3. Passes de recatégorisation ───────────────────────────────────────────

const modifications: Modif[] = [];
const ignorees: { journal: string; libelle: string; compte: string; raison: string }[] = [];

/** Passe générique : un journal, une classe de compte, un sens comptable. */
function analyser(
  etiquette: "ACHAT" | "VENTE",
  journaux: string[],
  classe: "6" | "7",
  sens: "charge" | "produit",
  resoudre: (e: any) => { nomTiers: string; description: string; compteDefautTiers: string | null; tiersId: string | null },
) {
  const lignes = (ecritures ?? []).filter(
    (e) => journaux.includes((e.journal_code ?? "").toUpperCase()) && (e.compte_numero ?? "").startsWith(classe),
  );
  console.log(`── ${etiquette} — journal ${journaux.join("/")}, comptes de classe ${classe} : ${lignes.length} ligne(s)`);

  for (const e of lignes) {
    const compteActuel = (e.compte_numero ?? "").trim();
    const ctx = resoudre(e);
    const sug = suggestAccount({
      sens,
      tiersId: ctx.tiersId,
      compteDefautTiers: ctx.compteDefautTiers,
      description: ctx.description || e.libelle,
      nomTiers: ctx.nomTiers,
      secteurActivite: secteur,
    });
    const verdict = estPlusPrecis(sug, compteActuel);
    if (!verdict.ok) {
      ignorees.push({ journal: e.journal_code ?? "", libelle: e.libelle ?? "", compte: compteActuel, raison: verdict.raison });
      console.log(`   ·  INCHANGÉ  Libellé: '${e.libelle}' | Compte: ${compteActuel} — ${verdict.raison}`);
      continue;
    }
    modifications.push({
      id: e.id, journal: e.journal_code ?? "", libelle: e.libelle ?? "",
      ancien: compteActuel, nouveau: sug.compte, motif: sug.motif,
    });
    console.log(`   →  [${etiquette}] Libellé: '${e.libelle}' | Ancien compte: ${compteActuel} -> Nouveau compte: ${sug.compte}`);
    console.log(`      motif : ${sug.motif} (règle « ${sug.source} »)`);
    if (ctx.description) console.log(`      matière analysée : « ${ctx.description} » | tiers « ${ctx.nomTiers} »`);
  }
  console.log("");
}

// ── Journal des ACHATS ──
// Les écritures ACH portent `reference_piece = factures_fournisseurs.id` (cf.
// dossiers.$dossierId.fournisseurs.tsx). On remonte à la facture pour obtenir le
// fournisseur ET les désignations de lignes : le libellé de l'écriture (« Achat
// <fourn> <ref> ») est trop pauvre pour la Règle 2, la désignation ne l'est pas.
analyser("ACHAT", ["ACH"], "6", "charge", (e) => {
  const ff = ffParId.get(e.reference_piece ?? "")
    ?? (e.facture_id ? ffParId.get(e.facture_id) : undefined)
    ?? ffParNumero.get(normNom(String(e.libelle ?? "").replace(/^Achat\s+/i, "")));
  const fourn = ff?.fournisseur_id ? fournParId.get(ff.fournisseur_id) : undefined;
  const nomTiers = ff?.fournisseur_nom ?? fourn?.nom ?? String(e.libelle ?? "").replace(/^Achat\s+/i, "");
  const parNom = fourn ?? fournParNom.get(normNom(nomTiers));
  return {
    nomTiers,
    description: designations(ff?.lignes),
    compteDefautTiers: parNom?.compte_charge_defaut ?? null,
    tiersId: parNom?.id ?? null,
  };
});

// ── Journal des VENTES ──
// Les écritures VTE portent `facture_id` (et `reference_piece = numero`).
analyser("VENTE", ["VTE", "VT"], "7", "produit", (e) => {
  const fc = (e.facture_id ? fcParId.get(e.facture_id) : undefined)
    ?? fcParNumero.get(normNom(e.reference_piece));
  const cli = fc?.client_id ? cliParId.get(fc.client_id) : undefined;
  return {
    nomTiers: cli?.nom ?? "",
    description: designations(fc?.lignes),
    compteDefautTiers: cli?.compte_produit_defaut ?? null,
    tiersId: cli?.id ?? null,
  };
});

// ─── 4. Application ──────────────────────────────────────────────────────────

const bilan = (etiquette: string, journaux: string[]) =>
  modifications.filter((m) => journaux.includes(m.journal.toUpperCase())).length;

if (modifications.length === 0) {
  console.log("Aucune écriture à réaligner.\n");
} else if (!APPLY) {
  console.log(`🔍 SIMULATION : ${modifications.length} écriture(s) SERAIENT modifiée(s). Relance avec --apply pour écrire.\n`);
} else {
  // Sauvegarde AVANT la première écriture — c'est elle qui rend l'opération réversible.
  // Horodatage à la SECONDE : deux passages le même jour (p. ex. achats puis ventes
  // après avoir renseigné le secteur) ne doivent PAS écraser la même sauvegarde,
  // sinon le rollback du premier passage est perdu.
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const nomFichier = `backup_recateg_${normNom(dossier.nom_societe).toLowerCase().replace(/\s+/g, "_")}_${stamp}.json`;
  fs.writeFileSync(
    path.join(ROOT, nomFichier),
    JSON.stringify({ dossier_id: dossierId, dossier: dossier.nom_societe, date: new Date().toISOString(), secteur, modifications }, null, 2),
    "utf8",
  );
  console.log(`💾 Sauvegarde : ${nomFichier} (rejouable via --rollback=${nomFichier})\n`);

  let ok = 0;
  for (const m of modifications) {
    const { error } = await sb.from("ecritures_comptables").update({ compte_numero: m.nouveau }).eq("id", m.id);
    if (error) console.error(`   ❌ ${m.id.slice(0, 8)} ${m.ancien} → ${m.nouveau} : ${error.message}`);
    else { ok++; console.log(`   ✅ ${m.id.slice(0, 8)} ${m.ancien} → ${m.nouveau}`); }
  }
  console.log(`\n${ok}/${modifications.length} écriture(s) mise(s) à jour en base.`);
  if (ok !== modifications.length) { console.error("⚠️  Mises à jour partielles — voir les erreurs ci-dessus.\n"); process.exit(1); }
}

// ─── 5. Bilan ────────────────────────────────────────────────────────────────

console.log("─".repeat(72));
console.log(`BILAN — ${dossier.nom_societe}${APPLY ? "" : "  (simulation)"}`);
console.log(`  Journal ACH (achats, classe 6)  : ${bilan("ACHAT", ["ACH"])} écriture(s) réalignée(s)`);
console.log(`  Journal VTE/VT (ventes, cl. 7)  : ${bilan("VENTE", ["VTE", "VT"])} écriture(s) réalignée(s)`);
console.log(`  Laissées en place               : ${ignorees.length}`);
if (ignorees.length) {
  const parRaison = new Map<string, number>();
  for (const i of ignorees) parRaison.set(i.raison, (parRaison.get(i.raison) ?? 0) + 1);
  for (const [r, n] of parRaison) console.log(`      • ${n} × ${r}`);
}
console.log("─".repeat(72) + "\n");
