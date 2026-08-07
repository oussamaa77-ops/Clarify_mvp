/**
 * referencer-reclassements-tva.ts — donne aux OD de RECLASSEMENT de TVA déjà en
 * base leur référence propre « RECLASS-TVA-<ref> ».
 *
 * ─── Pourquoi ────────────────────────────────────────────────────────────────
 * Le reclassement (passage de la TVA du régime des débits à celui des
 * encaissements) portait la référence de la FACTURE. Il devenait indiscernable
 * d'une bascule au règlement — mêmes comptes, aucun code de lettrage, même
 * référence — et seul le SENS les distinguait :
 *
 *      bascule au règlement (VENTE) : D 4458 (attente)   / C 44551 (exigible)
 *      reclassement                 : D 44551 (exigible) / C 4458  (attente)
 *
 * C'est cette confusion qui a laissé une annulation de paiement mutiler le
 * reclassement de FAC-2024-307 (1 880,00 MAD d'écart au grand livre).
 *
 * Le préfixe CONSERVE la référence d'origine : `referencesPiece()` la retrouve,
 * donc la TVA reste visible en attente et le règlement continue de basculer.
 *
 * ─── Ce qu'il reprend ────────────────────────────────────────────────────────
 * Uniquement les lignes qui réunissent TOUS ces critères — le filtre est étroit
 * à dessein, une écriture de TVA légitime ne doit pas être renommée :
 *   • journal OD ;
 *   • libellé commençant par « Reclassement TVA » (signature du script) ;
 *   • compte de TVA (reconnu par préfixe : 4458, 44551, 3458, 34552…) ;
 *   • référence pas déjà préfixée ;
 *   • et le groupe (référence + date) doit être ÉQUILIBRÉ — une demi-écriture
 *     est signalée mais PAS renommée : il faut d'abord la réparer avec
 *     scripts/reparer-od-tva-orphelines.ts, sinon on déplacerait le problème.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   node --import tsx scripts/referencer-reclassements-tva.ts              # DRY-RUN
 *   node --import tsx scripts/referencer-reclassements-tva.ts --apply
 *   node --import tsx scripts/referencer-reclassements-tva.ts --dossier="SOMADIR"
 *   node --import tsx scripts/referencer-reclassements-tva.ts --rollback=backup_ref_reclass_XXX.json
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  PREFIXE_RECLASS_TVA, estCompteTva, referenceReclassement,
} from "../src/services/lettrage";

// ─── Environnement (.env à la racine) ────────────────────────────────────────
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
});

const args = process.argv.slice(2);
const lire = (nom: string): string | null => {
  const a = args.find((x) => x.startsWith(`--${nom}=`));
  return a ? a.slice(nom.length + 3).replace(/^["']|["']$/g, "") : null;
};
const APPLY = args.includes("--apply");
const DOSSIER = lire("dossier");
const ROLLBACK = lire("rollback");

const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const round2 = (x: number) => Math.round(x * 100) / 100;
const fmt = (x: number) => x.toLocaleString("fr-MA", { minimumFractionDigits: 2 });
const TOL = 0.005;

async function rollback(fichier: string) {
  const chemin = path.isAbsolute(fichier) ? fichier : path.join(RACINE, fichier);
  const backup = JSON.parse(fs.readFileSync(chemin, "utf8"));
  console.log(`\n↩️  ROLLBACK depuis ${path.basename(chemin)}\n`);
  let n = 0;
  // Ligne à ligne : chaque ligne retrouve SA référence d'avant, telle qu'elle
  // était. Un UPDATE global rétablirait la même référence pour tout le lot.
  for (const l of backup.lignes as any[]) {
    const { error } = await sb.from("ecritures_comptables")
      .update({ reference_piece: l.avant }).eq("id", l.id);
    if (error) { console.error(`❌ ${l.id} : ${error.message}`); continue; }
    n++;
  }
  console.log(`✅ ${n} ligne(s) remise(s) sur leur référence d'origine.`);
  process.exit(0);
}

async function main() {
  if (ROLLBACK) return rollback(ROLLBACK);

  console.log("\n═══ RÉFÉRENCE PROPRE DES RECLASSEMENTS DE TVA — "
    + (APPLY ? "APPLICATION" : "DRY-RUN") + " ═══\n");

  let q = sb.from("dossiers").select("id,nom_societe");
  if (DOSSIER) q = q.ilike("nom_societe", `%${DOSSIER}%`);
  const { data: dossiers, error: eD } = await q;
  if (eD) { console.error("❌", eD.message); process.exit(1); }

  const backup: any = { date: new Date().toISOString(), lignes: [] as any[] };
  let total = 0, ignorees = 0;

  for (const d of (dossiers ?? []) as any[]) {
    const { data: brut, error } = await sb.from("ecritures_comptables")
      .select("id,compte_numero,date_ecriture,libelle,debit,credit,reference_piece,lettrage_code")
      .eq("dossier_id", d.id).eq("journal_code", "OD")
      .ilike("libelle", "Reclassement TVA%");
    if (error) { console.error(`❌ ${d.nom_societe} :`, error.message); continue; }

    const candidates = ((brut ?? []) as any[])
      .filter((l) => estCompteTva(l.compte_numero))
      .filter((l) => !String(l.reference_piece ?? "").startsWith(PREFIXE_RECLASS_TVA));
    if (!candidates.length) continue;

    // Regroupement par écriture (référence + date) pour contrôler l'équilibre :
    // renommer une demi-écriture la couperait de sa contrepartie restée sous
    // l'ancienne référence — on aggraverait exactement ce qu'on corrige.
    const groupes = new Map<string, any[]>();
    for (const l of candidates) {
      const cle = `${l.reference_piece ?? ""}|${l.date_ecriture ?? ""}`;
      const g = groupes.get(cle);
      if (g) g.push(l); else groupes.set(cle, [l]);
    }

    console.log(`\n📁 ${d.nom_societe}`);
    for (const [cle, groupe] of groupes) {
      const ecart = round2(groupe.reduce((s, l) => s + n(l.debit) - n(l.credit), 0));
      const ref = String(groupe[0].reference_piece ?? "");
      const nouvelle = referenceReclassement(ref);

      if (Math.abs(ecart) > TOL) {
        ignorees += groupe.length;
        console.log(`   ⏭️  ${cle} — DÉSÉQUILIBRÉ (${fmt(ecart)} MAD), non renommé.`);
        console.log(`        Réparez d'abord : node --import tsx scripts/reparer-od-tva-orphelines.ts --apply`);
        continue;
      }

      console.log(`   ✏️  ${ref}  →  ${nouvelle}   (${groupe.length} ligne(s), ${fmt(round2(groupe.reduce((s, l) => s + n(l.debit), 0)))} MAD)`);
      total += groupe.length;
      if (!APPLY) continue;

      for (const l of groupe) {
        const { error: eU } = await sb.from("ecritures_comptables")
          .update({ reference_piece: nouvelle }).eq("id", l.id);
        if (eU) { console.error(`      ❌ ${l.id} : ${eU.message}`); continue; }
        backup.lignes.push({ id: l.id, avant: ref, apres: nouvelle });
      }
    }
  }

  console.log("\n" + "─".repeat(70));
  if (!total && !ignorees) {
    console.log("✅ Rien à reprendre : tous les reclassements portent déjà leur référence propre.");
  } else {
    console.log(`${APPLY ? "✅ REPRIS" : "🔎 À REPRENDRE"} : ${total} ligne(s)`);
    if (ignorees) console.log(`⚠️  ${ignorees} ligne(s) ignorée(s) car déséquilibrée(s) — à réparer d'abord.`);
    if (APPLY && backup.lignes.length) {
      const nom = `backup_ref_reclass_${new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14)}.json`;
      fs.writeFileSync(path.join(RACINE, nom), JSON.stringify(backup, null, 2), "utf8");
      console.log(`💾 Backup : ${nom}`);
      console.log(`↩️  Rollback : node --import tsx scripts/referencer-reclassements-tva.ts --rollback=${nom}`);
    } else if (!APPLY) {
      console.log("\n▶ Relancez avec --apply pour appliquer.");
    }
  }
  console.log("");
}

main().catch((e) => { console.error("💥", e); process.exit(1); });
