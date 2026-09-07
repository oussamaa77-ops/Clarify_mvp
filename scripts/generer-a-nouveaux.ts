/**
 * generer-a-nouveaux.ts — Écriture d'À-NOUVEAU à l'ouverture d'un exercice.
 *
 * ─── Pourquoi ────────────────────────────────────────────────────────────────
 * Les vues comptables sont désormais bornées par exercice. Un solde de BILAN né
 * avant l'ouverture disparaît donc de la vue courante : la dette de 24 600 MAD
 * envers ACOSOLUTIONS, comptabilisée le 16/12/2025, sortait de la balance 2026
 * alors qu'elle est toujours due. L'à-nouveau est la pièce qui la reporte.
 *
 * ─── Ce que le script REFUSE de faire ────────────────────────────────────────
 * Reporter UN SEUL compte, comme on serait tenté de le faire pour « rattraper »
 * un chiffre. Une écriture à une seule jambe ne s'équilibre pas, et la balance
 * du dossier devient fausse d'autant. L'à-nouveau est produit ENTIER :
 *
 *   • tous les comptes de bilan (classes 1 à 5) au solde non nul ;
 *   • le résultat des exercices antérieurs, reporté au 1161 (bénéfice) ou au
 *     1169 (perte) — c'est lui qui équilibre l'écriture, sans qu'on ait à forcer
 *     quoi que ce soit (cf. src/lib/a-nouveaux.ts).
 *
 * Il refuse aussi d'écrire deux fois : un à-nouveau déjà présent à cette date est
 * détecté et l'opération s'arrête, sauf `--remplacer`.
 *
 * ─── Le double comptage ──────────────────────────────────────────────────────
 * Une fois posé, chaque solde existe deux fois en base : sur sa ligne d'origine
 * et sur son report. C'est normal — ils vivent dans deux exercices distincts.
 * Toute lecture MULTI-EXERCICES doit exclure le journal AN, ce que fait
 * `sansANouveaux` et ce que la page Comptabilité applique en vue « tous ».
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   node --import tsx scripts/generer-a-nouveaux.ts --dossier="SMERT" --exercice=2026
 *   node --import tsx scripts/generer-a-nouveaux.ts --dossier="SMERT" --exercice=2026 --apply
 *   node --import tsx scripts/generer-a-nouveaux.ts --rollback=backup_an_XXX.json
 *
 * Sans --apply, RIEN n'est écrit.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  JOURNAL_AN, assertANouveaux, lignesANouveaux, soldesCloture,
} from "../src/lib/a-nouveaux";
import { bornesExercice, exerciceCourant } from "../src/lib/exercice-comptable";

const ICI = path.dirname(fileURLToPath(import.meta.url));
const RACINE = path.resolve(ICI, "..");
const env = Object.fromEntries(
  fs.readFileSync(path.join(RACINE, ".env"), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);
let PROXY_DIRECT = false;
async function proxyFetch(input: any, init?: any): Promise<any> {
  const direct = async () => {
    const { fetch: uf, Agent } = await import("undici");
    return (uf as any)(String(input), { ...init, dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) });
  };
  if (PROXY_DIRECT) return direct();
  try { return await fetch(String(input), init); }
  catch { PROXY_DIRECT = true; return direct(); }
}
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  global: { fetch: (i: any, init?: any) => proxyFetch(i, init) },
}) as any;

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const REMPLACER = args.includes("--remplacer");
const val = (n: string) => {
  const a = args.find((x) => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3).replace(/^["']|["']$/g, "") : null;
};
const DOSSIER = val("dossier");
const ROLLBACK = val("rollback");
const EXERCICE = Number(val("exercice") ?? exerciceCourant());

const fmt = (x: number) => Number(x).toLocaleString("fr-MA", { minimumFractionDigits: 2 });
const r2 = (x: number) => Math.round(x * 100) / 100;
const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

interface Backup { genere: string; ecrituresCreees: string[]; ecrituresSupprimees: any[] }

// ─── Rollback ────────────────────────────────────────────────────────────────
if (ROLLBACK) {
  const chemin = path.isAbsolute(ROLLBACK) ? ROLLBACK : path.join(RACINE, ROLLBACK);
  const b = JSON.parse(fs.readFileSync(chemin, "utf8")) as Backup;
  console.log(`\n↩️  ROLLBACK depuis ${path.basename(chemin)} (généré le ${b.genere})`);
  if (b.ecrituresCreees?.length) {
    const { error } = await sb.from("ecritures_comptables").delete().in("id", b.ecrituresCreees);
    console.log(error ? `   ❌ ${error.message}` : `   ✅ ${b.ecrituresCreees.length} à-nouveau supprimé(s)`);
  }
  if (b.ecrituresSupprimees?.length) {
    const { error } = await sb.from("ecritures_comptables").insert(b.ecrituresSupprimees);
    console.log(error ? `   ❌ restauration : ${error.message}` : `   ✅ ${b.ecrituresSupprimees.length} ligne(s) restaurée(s)`);
  }
  console.log("");
  process.exit(0);
}

if (!Number.isFinite(EXERCICE) || EXERCICE < 1900) {
  console.error("❌ --exercice=<année> invalide."); process.exit(2);
}

let qd = sb.from("dossiers").select("id,nom_societe,date_debut_activite");
if (DOSSIER) qd = qd.ilike("nom_societe", `%${DOSSIER}%`);
const { data: dossiers, error: eDos } = await qd;
if (eDos) { console.error("❌ dossiers :", eDos.message); process.exit(1); }

const bornes = bornesExercice(EXERCICE);
const backup: Backup = { genere: new Date().toISOString(), ecrituresCreees: [], ecrituresSupprimees: [] };
let total = 0;

console.log(`\n═══ À-NOUVEAUX ${EXERCICE} ═══  ${APPLY ? "MODE ÉCRITURE" : "DRY-RUN (aucune écriture)"}`);
console.log(`    ouverture au ${bornes.debut} · reprise de TOUT ce qui précède`);

for (const d of dossiers ?? []) {
  const { data: ecrRows } = await sb.from("ecritures_comptables")
    .select("id,journal_code,compte_numero,date_ecriture,debit,credit,libelle,reference_piece,valide,dossier_id")
    .eq("dossier_id", d.id);
  const lignes = (ecrRows ?? []) as any[];
  const anterieures = lignes.filter((l) => String(l.date_ecriture ?? "").slice(0, 10) < bornes.debut);
  if (!anterieures.length) continue;

  console.log(`\n─── ${d.nom_societe} — ${anterieures.length} écriture(s) antérieure(s) au ${bornes.debut}`);

  // Idempotence : un à-nouveau déjà posé à cette date ne se rejoue pas.
  const dejaLa = lignes.filter(
    (l) => String(l.journal_code ?? "").toUpperCase() === JOURNAL_AN
      && String(l.date_ecriture ?? "").slice(0, 10) === bornes.debut);
  if (dejaLa.length && !REMPLACER) {
    console.log(`   ℹ️  ${dejaLa.length} ligne(s) d'à-nouveau existent déjà au ${bornes.debut} — ignoré.`);
    console.log("       (relancer avec --remplacer pour les recalculer)");
    continue;
  }

  // Les à-nouveaux ANTÉRIEURS font partie des soldes à reprendre ; ceux de LA
  // date qu'on recalcule doivent en sortir, sinon on les compterait deux fois.
  const source = anterieures.filter((l) => !dejaLa.some((x) => x.id === l.id));
  const soldes = soldesCloture(source, bornes.debut);
  const plan = lignesANouveaux(soldes, {
    dossier_id: d.id, date: bornes.debut, reference: `AN-${EXERCICE}`,
  });

  console.log(`   soldes repris : ${plan.lignes.length - (Math.abs(plan.resultatReporte) >= 0.005 ? 1 : 0)} compte(s) de bilan`);
  for (const l of plan.lignes) {
    console.log(`      ${String(l.compte_numero).padEnd(10)} D=${fmt(l.debit).padStart(12)} C=${fmt(l.credit).padStart(12)} | ${l.libelle}`);
  }
  console.log(`   résultat antérieur reporté : ${fmt(Math.abs(plan.resultatReporte))} MAD `
    + `(${plan.resultatReporte > 0 ? "PERTE" : "bénéfice"}) au compte ${plan.compteReport}`);
  console.log(`   partie double de l'écriture : écart ${fmt(plan.ecart)} MAD ${Math.abs(plan.ecart) <= 0.005 ? "✅" : "❌"}`);

  // Contrôle d'audit : un compte d'attente (47*) encore garni traverse
  // l'exercice par ce report même. On l'affiche AVANT d'écrire, et sans
  // bloquer — l'arrêté reste la décision du comptable.
  if (plan.avertissements.length) {
    console.log("   ⚠️  CONTRÔLE D'ARRÊTÉ — comptes d'attente non apurés :");
    for (const c of plan.suspens.comptes) {
      console.log(`      • ${String(c.compte).padEnd(10)} ${fmt(c.solde).padStart(12)} MAD ${c.sens}`
        + `${c.attenteBancaire ? "   (attente bancaire, pièce justificative manquante)" : ""}`);
    }
    console.log(`      → ${fmt(plan.suspens.total)} MAD à imputer ; reportés tels quels sur ${EXERCICE}.`);
  }

  if (plan.violations.length) {
    console.log("   ❌ refusé :");
    for (const v of plan.violations) console.log(`      • ${v}`);
    continue;
  }
  if (!plan.lignes.length) { console.log("   ℹ️  aucun solde à reporter."); continue; }
  if (!APPLY) continue;

  assertANouveaux(plan);

  if (dejaLa.length) {
    backup.ecrituresSupprimees.push(...dejaLa.map(({ id, ...reste }) => ({ id, ...reste })));
    const { error } = await sb.from("ecritures_comptables").delete().in("id", dejaLa.map((x) => x.id));
    if (error) { console.log(`   ❌ suppression de l'ancien à-nouveau : ${error.message}`); continue; }
    console.log(`   ♻️  ${dejaLa.length} ancienne(s) ligne(s) remplacée(s)`);
  }

  const { data: inserees, error } = await sb.from("ecritures_comptables")
    .insert(plan.lignes).select("id");
  if (error) { console.log(`   ❌ ${error.message}`); continue; }
  for (const x of (inserees ?? []) as any[]) backup.ecrituresCreees.push(String(x.id));
  total += (inserees ?? []).length;
  console.log(`   ✅ ${(inserees ?? []).length} ligne(s) d'à-nouveau insérée(s)`);
}

if (APPLY && backup.ecrituresCreees.length) {
  const nom = `backup_an_${EXERCICE}_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(path.join(RACINE, nom), JSON.stringify(backup, null, 2), "utf8");
  console.log(`\n💾 Backup : ${nom}  (rejouable via --rollback=${nom})`);
}

// ─── Contrôle : la balance de l'exercice, relue depuis la base ───────────────
console.log(`\n═══ BALANCE ${EXERCICE} APRÈS À-NOUVEAUX (relecture) ═══`);
for (const d of dossiers ?? []) {
  const [{ data: ecr }, { data: ff }] = await Promise.all([
    sb.from("ecritures_comptables").select("compte_numero,debit,credit,journal_code,date_ecriture")
      .eq("dossier_id", d.id).gte("date_ecriture", bornes.debut).lte("date_ecriture", bornes.fin),
    sb.from("factures_fournisseurs").select("statut_paiement,montant_ttc,montant_paye,montant_restant").eq("dossier_id", d.id),
  ]);
  const lignes = (ecr ?? []) as any[];
  if (!lignes.length) continue;
  const solde = (racine: string) => r2(lignes
    .filter((l) => String(l.compte_numero ?? "").startsWith(racine))
    .reduce((s, l) => s + n(l.credit) - n(l.debit), 0));
  const dettes = r2(((ff ?? []) as any[])
    .filter((f) => f.statut_paiement !== "payee")
    .reduce((s, f) => {
      const reste = n(f.montant_restant);
      return s + (reste > 0.005 ? reste : Math.max(0, r2(n(f.montant_ttc) - n(f.montant_paye))));
    }, 0));
  const s4411 = solde("4411");
  const ecart = r2(lignes.reduce((s, l) => s + n(l.debit) - n(l.credit), 0));
  console.log(`\n${d.nom_societe} — exercice ${EXERCICE}`);
  console.log(`  ${Math.abs(s4411 - dettes) <= 0.005 ? "✅" : "❌"} 4411 créditeur ${fmt(s4411)} ⇄ dettes fournisseurs ${fmt(dettes)}`
    + (Math.abs(s4411 - dettes) > 0.005 ? ` — écart ${fmt(r2(s4411 - dettes))}` : ""));
  console.log(`  ${Math.abs(ecart) <= 0.005 ? "✅" : "❌"} partie double de l'exercice : écart ${fmt(ecart)} MAD`);
}

console.log(`\n═══ BILAN ═══\n  lignes d'à-nouveau ${APPLY ? "créées" : "à créer"} : ${APPLY ? total : "—"}`);
if (!APPLY) console.log("\n  Rien n'a été écrit. Relancer avec --apply pour appliquer.");
console.log("");
