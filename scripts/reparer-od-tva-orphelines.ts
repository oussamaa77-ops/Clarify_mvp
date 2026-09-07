/**
 * reparer-od-tva-orphelines.ts — détecte et corrige les DEMI-ÉCRITURES d'OD de
 * TVA laissées par une annulation de paiement.
 *
 * ─── Le défaut ───────────────────────────────────────────────────────────────
 * La bascule de TVA au règlement est une OD à deux lignes :
 *
 *      VENTE   D 4458 (attente)  /  C 4455 ou 44551 (exigible)
 *      ACHAT   D 3455 ou 34552   /  C 3458 (attente)
 *
 * À l'annulation du paiement, le délettrage supprimait ces lignes une à une,
 * après un filtre qui testait l'ÉGALITÉ STRICTE du compte avec 4458/4455/3458/
 * 3455. Le plan comptable réel employant des SOUS-COMPTES (44551, 34552…), la
 * contrepartie n'était pas reconnue : la ligne 4458 partait, la ligne 44551
 * restait. Résultat : une demi-écriture orpheline et un grand livre déséquilibré
 * du montant de la TVA (constaté sur FAC-2024-307 : 1 880,00 MAD).
 *
 * Le code est corrigé (l'unité de suppression est désormais l'ÉCRITURE, cf.
 * `grouperOdBascule` dans src/services/lettrage.ts). Ce script répare l'existant.
 *
 * ─── Ce qu'il fait ───────────────────────────────────────────────────────────
 * 1. Recense les OD de TVA par écriture (même code de lettrage, ou même
 *    référence + date à défaut de code).
 * 2. Signale les groupes DÉSÉQUILIBRÉS — la signature de l'orpheline.
 * 3. Corrige, au choix :
 *      --mode=restauration  (DÉFAUT) RECRÉE la contrepartie manquante, sur le
 *                       compte de TVA opposé (attente ↔ exigible) et dans le
 *                       sens qui solde le groupe. C'est la réparation JUSTE :
 *                       elle remet l'écriture dans sa forme d'origine au lieu
 *                       d'empiler une correction par-dessus une mutilation.
 *                       Vérifié sur FAC-2024-307 : la ligne détruite était le
 *                       « C 4458 » du reclassement ; la restaurer rééquilibre le
 *                       grand livre ET remet la TVA en attente, ce qu'exige le
 *                       régime des encaissements pour une facture impayée.
 *      --mode=suppression  supprime la ligne orpheline restante. Rééquilibre
 *                       aussi, mais fait DISPARAÎTRE la TVA de la pièce : à ne
 *                       choisir que si l'écriture d'origine était elle-même
 *                       indue. Jamais sur un exercice déjà déclaré.
 * 4. Contrôle l'équilibre GLOBAL du dossier avant / après.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   node --import tsx scripts/reparer-od-tva-orphelines.ts                 # DRY-RUN
 *   node --import tsx scripts/reparer-od-tva-orphelines.ts --apply
 *   node --import tsx scripts/reparer-od-tva-orphelines.ts --dossier="SOMADIR"
 *   node --import tsx scripts/reparer-od-tva-orphelines.ts --apply --mode=suppression
 *   node --import tsx scripts/reparer-od-tva-orphelines.ts --rollback=backup_od_tva_XXX.json
 *
 * Sans --apply, RIEN n'est écrit : le script se contente d'afficher le rapport.
 * Chaque exécution avec --apply produit un backup JSON rejouable en --rollback.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { COMPTES_TVA, estCompteTva } from "../src/services/lettrage";
import { normaliserComptesLignes } from "../src/lib/numero-compte";

// ─── Environnement (.env à la racine) ────────────────────────────────────────
const ICI = path.dirname(fileURLToPath(import.meta.url));
const RACINE = path.resolve(ICI, "..");
const env = Object.fromEntries(
  fs.readFileSync(path.join(RACINE, ".env"), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);

// Le proxy TLS d'entreprise fait échouer le fetch global : repli undici.
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
});

// ─── Arguments ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const lire = (nom: string): string | null => {
  const a = args.find((x) => x.startsWith(`--${nom}=`));
  return a ? a.slice(nom.length + 3).replace(/^["']|["']$/g, "") : null;
};
const APPLY = args.includes("--apply");
const DOSSIER = lire("dossier");
const ROLLBACK = lire("rollback");
const MODE = (lire("mode") ?? "restauration") as "restauration" | "suppression";

const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const round2 = (x: number) => Math.round(x * 100) / 100;
const fmt = (x: number) => x.toLocaleString("fr-MA", { minimumFractionDigits: 2 });
const TOL = 0.005;

interface Ligne {
  id: string; dossier_id: string; journal_code: string | null; compte_numero: string | null;
  date_ecriture: string | null; libelle: string | null; debit: number | null; credit: number | null;
  reference_piece: string | null; lettrage_code: string | null;
}

// ─── Rollback ────────────────────────────────────────────────────────────────
async function rollback(fichier: string) {
  const chemin = path.isAbsolute(fichier) ? fichier : path.join(RACINE, fichier);
  const backup = JSON.parse(fs.readFileSync(chemin, "utf8"));
  console.log(`\n↩️  ROLLBACK depuis ${path.basename(chemin)} (mode ${backup.mode})\n`);

  if (backup.mode === "restauration") {
    // On supprime les lignes restaurées, par leur ID exact — jamais par
    // référence : la référence est celle de la pièce d'origine, et on
    // emporterait les écritures légitimes qui la partagent.
    const ids = (backup.lignes as any[]).map((l) => l.id).filter(Boolean);
    if (!ids.length) { console.log("Rien à annuler (aucun ID mémorisé)."); process.exit(0); }
    const { data, error } = await sb.from("ecritures_comptables")
      .delete().in("id", ids).select("id");
    if (error) { console.error("❌", error.message); process.exit(1); }
    console.log(`✅ ${(data ?? []).length} ligne(s) restaurée(s) retirée(s).`);
  } else {
    // On réinsère les lignes supprimées, à l'identique.
    // Une sauvegarde antérieure à la normalisation porte des comptes en forme
    // COURTE : on les recanonise, sinon la restauration réintroduirait les
    // longueurs mêlées. Le trigger en base le fait aussi — c'est la ceinture,
    // ceci est la bretelle (cf. src/lib/numero-compte.ts).
    const { error } = await sb.from("ecritures_comptables").insert(normaliserComptesLignes(backup.lignes));
    if (error) { console.error("❌", error.message); process.exit(1); }
    console.log(`✅ ${backup.lignes.length} ligne(s) restaurée(s).`);
  }
  process.exit(0);
}

// ─── Analyse ─────────────────────────────────────────────────────────────────
async function main() {
  if (ROLLBACK) return rollback(ROLLBACK);

  console.log("\n═══ OD DE TVA ORPHELINES — " + (APPLY ? `CORRECTION (${MODE})` : "DRY-RUN") + " ═══\n");

  let q = sb.from("dossiers").select("id,nom_societe");
  if (DOSSIER) q = q.ilike("nom_societe", `%${DOSSIER}%`);
  const { data: dossiers, error: eD } = await q;
  if (eD) { console.error("❌ Lecture des dossiers :", eD.message); process.exit(1); }
  if (!dossiers?.length) { console.log("Aucun dossier."); process.exit(0); }

  const horodatage = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
  const REFERENCE = `FIX-OD-TVA-${horodatage}`;
  const backup: any = { mode: MODE, reference: REFERENCE, date: new Date().toISOString(), lignes: [] as Ligne[] };

  let totalOrphelines = 0;
  let totalEcart = 0;

  for (const d of dossiers as any[]) {
    // Toutes les lignes d'OD du dossier — on ne peut pas filtrer sur le compte
    // côté SQL sans réintroduire l'erreur d'origine (liste de comptes figée).
    const { data: odBrut, error } = await sb.from("ecritures_comptables")
      .select("id,dossier_id,journal_code,compte_numero,date_ecriture,libelle,debit,credit,reference_piece,lettrage_code")
      .eq("dossier_id", d.id).eq("journal_code", "OD");
    if (error) { console.error(`❌ ${d.nom_societe} :`, error.message); continue; }

    const od = (odBrut ?? []) as Ligne[];
    if (!od.length) continue;

    // Regroupement par ÉCRITURE : code de lettrage, ou référence + date à défaut.
    const groupes = new Map<string, Ligne[]>();
    for (const l of od) {
      const code = String(l.lettrage_code ?? "").trim();
      const cle = code ? `C:${code}` : `R:${l.reference_piece ?? ""}|${l.date_ecriture ?? ""}`;
      const g = groupes.get(cle);
      if (g) g.push(l); else groupes.set(cle, [l]);
    }

    const casseees = [...groupes.entries()]
      // On ne s'intéresse qu'aux groupes qui contiennent de la TVA…
      .filter(([, g]) => g.some((l) => estCompteTva(l.compte_numero)))
      // …et qui ne se soldent pas : c'est la signature de l'orpheline.
      .map(([cle, g]) => ({
        cle, lignes: g,
        ecart: round2(g.reduce((s, l) => s + n(l.debit) - n(l.credit), 0)),
      }))
      .filter((x) => Math.abs(x.ecart) > TOL);

    if (!casseees.length) continue;

    console.log(`\n📁 ${d.nom_societe}`);
    for (const c of casseees) {
      totalOrphelines += c.lignes.length;
      totalEcart += c.ecart;
      console.log(`   ⚠️  ${c.cle}  écart ${fmt(c.ecart)} MAD`);
      for (const l of c.lignes) {
        console.log(`        ${l.date_ecriture}  ${String(l.compte_numero).padEnd(10)} ` +
          `D ${fmt(n(l.debit)).padStart(12)}  C ${fmt(n(l.credit)).padStart(12)}  ${l.reference_piece ?? ""}`);
      }

      if (!APPLY) continue;

      if (MODE === "suppression") {
        backup.lignes.push(...c.lignes);
        const { error: eDel } = await sb.from("ecritures_comptables")
          .delete().in("id", c.lignes.map((l) => l.id));
        if (eDel) { console.error(`   ❌ suppression : ${eDel.message}`); continue; }
        console.log(`        → ${c.lignes.length} ligne(s) supprimée(s)`);
      } else {
        // RESTAURATION : on recrée la ligne détruite. Elle vit sur le compte de
        // TVA OPPOSÉ (attente ↔ exigible) au sein du même sens, dans la direction
        // qui solde le groupe, à la date et sous la référence de l'écriture.
        const orpheline = c.lignes.find((l) => estCompteTva(l.compte_numero)) ?? c.lignes[0];
        const compte = String(orpheline.compte_numero ?? "").trim();
        const sens: "client" | "fournisseur" = compte.startsWith("3") ? "fournisseur" : "client";
        const { attente, exigible } = COMPTES_TVA[sens];
        // Si la survivante est sur l'attente, la manquante est sur l'exigible —
        // et réciproquement. On ne devine jamais : on lit le compte survivant.
        const compteManquant = compte.startsWith(attente) ? exigible : attente;
        const montant = Math.abs(c.ecart);

        const ligne = {
          dossier_id: d.id,
          journal_code: "OD",
          compte_numero: compteManquant,
          // Date de l'écriture d'origine, pas celle du jour : la restauration
          // doit rendre l'écriture telle qu'elle était, sinon elle tomberait
          // dans un autre exercice que la ligne qu'elle équilibre.
          date_ecriture: orpheline.date_ecriture,
          libelle: `${orpheline.libelle ?? "OD TVA"} (contrepartie restaurée)`.slice(0, 200),
          // Écart positif = un DÉBIT en trop → la ligne manquante est au CRÉDIT.
          debit: c.ecart > 0 ? 0 : montant,
          credit: c.ecart > 0 ? montant : 0,
          reference_piece: orpheline.reference_piece,
          lettrage_code: orpheline.lettrage_code,
          valide: true,
        };
        // Ligne unique : `normaliserComptesLignes` travaille par lot, on
        // l'emballe plutot que d'ouvrir un second chemin de normalisation.
        const { data: ins, error: eIns } = await sb.from("ecritures_comptables")
          .insert(normaliserComptesLignes([ligne])[0]).select("id");
        if (eIns) { console.error(`   ❌ restauration : ${eIns.message}`); continue; }
        // Le backup mémorise l'ID INSÉRÉ : le rollback n'a qu'à le supprimer.
        backup.lignes.push({ ...(ins?.[0] ?? {}), ...ligne } as any);
        console.log(`        → restaurée : ${compteManquant} ` +
          `${c.ecart > 0 ? "C" : "D"} ${fmt(montant)} MAD au ${orpheline.date_ecriture}`);
      }
    }
  }

  console.log("\n" + "─".repeat(70));
  if (!totalOrphelines) {
    console.log("✅ Aucune OD de TVA déséquilibrée. Grand livre équilibré de ce côté.");
  } else {
    console.log(`${APPLY ? "✅ CORRIGÉ" : "🔎 DÉTECTÉ"} : ${totalOrphelines} ligne(s) concernée(s), ` +
      `écart cumulé ${fmt(totalEcart)} MAD`);
    if (APPLY) {
      const nomBackup = `backup_od_tva_${horodatage}.json`;
      fs.writeFileSync(path.join(RACINE, nomBackup), JSON.stringify(backup, null, 2), "utf8");
      console.log(`💾 Backup : ${nomBackup}`);
      console.log(`↩️  Rollback : node --import tsx scripts/reparer-od-tva-orphelines.ts --rollback=${nomBackup}`);
    } else {
      console.log("\n▶ Relancez avec --apply pour corriger.");
    }
  }

  // ─── Contrôle d'équilibre GLOBAL, dossier par dossier ──────────────────────
  console.log("\n═══ ÉQUILIBRE DU GRAND LIVRE ═══\n");
  for (const d of dossiers as any[]) {
    const { data: tout } = await sb.from("ecritures_comptables")
      .select("debit,credit").eq("dossier_id", d.id);
    const lignes = (tout ?? []) as any[];
    if (!lignes.length) continue;
    const debit = round2(lignes.reduce((s, l) => s + n(l.debit), 0));
    const credit = round2(lignes.reduce((s, l) => s + n(l.credit), 0));
    const ecart = round2(debit - credit);
    const ok = Math.abs(ecart) <= TOL;
    console.log(`${ok ? "✅" : "❌"} ${String(d.nom_societe).padEnd(28)} ` +
      `D ${fmt(debit).padStart(15)}  C ${fmt(credit).padStart(15)}  écart ${fmt(ecart)}`);
  }
  console.log("");
}

main().catch((e) => { console.error("💥", e); process.exit(1); });
