/**
 * auditer-tresorerie-fictive.ts — recense les écritures de TRÉSORERIE (journaux
 * BQ / CAI) qui ne reposent sur aucune pièce, et permet d'en supprimer un lot.
 *
 * ─── Le problème ─────────────────────────────────────────────────────────────
 * Les jeux de données de démonstration ont laissé des règlements FICTIFS : des
 * écritures de banque sans ligne de relevé derrière, parfois lettrées, parfois
 * datées de façon incohérente avec la facture qu'elles prétendent solder. Elles
 * gonflent la trésorerie, faussent le lettrage et rendent la TVA exigible sur
 * des factures qui n'ont jamais été encaissées.
 *
 * ─── Ce qui fait qu'un règlement est RÉEL ────────────────────────────────────
 * Une écriture de trésorerie est adossée à une pièce si elle porte AU MOINS une
 * de ces preuves. Le script les cherche toutes avant de conclure :
 *
 *   1. `transaction_id`  → elle vient d'une ligne de relevé bancaire ;
 *   2. `facture_id`      → règlement d'une facture client (bouton « Payer ») ;
 *   3. `reference_piece` → correspond à l'id ou au n° d'une facture existante
 *                          (règlement fournisseur, qui ne peut pas porter la FK) ;
 *   4. un `encaissements` du même dossier, même date, même montant → saisie
 *      manuelle depuis la page Banque ;
 *   5. une `transactions_bancaires` **rattachée à un relevé** (`releve_id` non
 *      nul), de même dossier, date et montant → preuve FAIBLE : la ligne existe
 *      bien au relevé, seul le lien a été perdu. Elle est à RELIER, pas à
 *      supprimer.
 *
 * Le `releve_id` non nul n'est pas un détail : les jeux de démonstration ont
 * aussi semé des `transactions_bancaires` orphelines, rattachées à aucun relevé.
 * Les accepter comme preuve laissait une écriture fictive se faire couvrir par
 * une transaction tout aussi fictive — c'est le cas rencontré sur l'écriture
 * « VIR SEPA RECU / SUPER-PAIN » : une transaction existait bien, à la même date
 * et au même montant, mais sans relevé derrière.
 *
 * Sans aucune de ces preuves, l'écriture ne correspond à aucun mouvement connu.
 *
 * ─── Signal supplémentaire : l'ANTÉRIORITÉ ───────────────────────────────────
 * Un règlement ne peut pas précéder la facture qu'il solde. Toute écriture de
 * trésorerie lettrée contre une facture POSTÉRIEURE est signalée : c'est la
 * signature d'un jeu de test dont les dates ont été tirées au hasard.
 *
 * ─── Sûreté ──────────────────────────────────────────────────────────────────
 * • Le script N'EFFACE RIEN sans `--supprimer=<ids|lettrage:CODE>`.
 * • La suppression emporte l'ÉCRITURE ENTIÈRE (toutes les lignes de même
 *   journal + date + libellé), jamais une ligne seule : retirer le seul crédit
 *   d'une écriture de banque déséquilibrerait le journal de son montant.
 * • Si l'écriture est LETTRÉE, le délettrage passe par le moteur applicatif
 *   (`executerDelettrage`) : les OD de bascule de TVA sont supprimées et les
 *   lignes de facture dé-estampillées, dans le bon ordre.
 * • Contrôle d'équilibre global avant / après, et backup rejouable.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   node --import tsx scripts/auditer-tresorerie-fictive.ts                  # audit
 *   node --import tsx scripts/auditer-tresorerie-fictive.ts --dossier="SOMADIR"
 *   node --import tsx scripts/auditer-tresorerie-fictive.ts --supprimer=lettrage:AB
 *   node --import tsx scripts/auditer-tresorerie-fictive.ts --supprimer=<uuid>,<uuid> --apply
 *   node --import tsx scripts/auditer-tresorerie-fictive.ts --rollback=backup_tresorerie_XXX.json
 *
 * `--supprimer` seul reste un DRY-RUN : il faut y ajouter `--apply` pour écrire.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { executerDelettrage } from "../src/server/lettrage-compta.functions";

// ─── Environnement (.env à la racine) ────────────────────────────────────────
const ICI = path.dirname(fileURLToPath(import.meta.url));
const RACINE = path.resolve(ICI, "..");
const env = Object.fromEntries(
  fs.readFileSync(path.join(RACINE, ".env"), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);
// Les cœurs applicatifs construisent leur propre client depuis process.env.
for (const [k, v] of Object.entries(env)) if (!process.env[k]) process.env[k] = v as string;

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
const SUPPRIMER = lire("supprimer");
const ROLLBACK = lire("rollback");

const JOURNAUX_TRESORERIE = ["BQ", "CAI"];
const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const round2 = (x: number) => Math.round(x * 100) / 100;
const fmt = (x: number) => x.toLocaleString("fr-MA", { minimumFractionDigits: 2 });
const TOL = 0.005;

interface Ligne {
  id: string; dossier_id: string; journal_code: string; compte_numero: string | null;
  date_ecriture: string | null; libelle: string | null; debit: number | null; credit: number | null;
  reference_piece: string | null; lettrage_code: string | null;
  transaction_id: string | null; facture_id: string | null;
}

/** Clé d'ÉCRITURE : journal + date + libellé. C'est l'unité indivisible. */
const cleEcriture = (l: Ligne) =>
  `${l.journal_code}|${l.date_ecriture ?? ""}|${(l.libelle ?? "").trim()}`;

async function equilibre(label: string) {
  const { data: dos } = await sb.from("dossiers").select("id,nom_societe");
  console.log(`\n═══ ÉQUILIBRE DU GRAND LIVRE (${label}) ═══\n`);
  for (const d of (dos ?? []) as any[]) {
    const { data } = await sb.from("ecritures_comptables").select("debit,credit").eq("dossier_id", d.id);
    const l = (data ?? []) as any[];
    if (!l.length) continue;
    const deb = round2(l.reduce((s, x) => s + n(x.debit), 0));
    const cre = round2(l.reduce((s, x) => s + n(x.credit), 0));
    const e = round2(deb - cre);
    console.log(`${Math.abs(e) <= TOL ? "✅" : "❌"} ${String(d.nom_societe).padEnd(30)} écart ${fmt(e)}`);
  }
}

async function rollback(fichier: string) {
  const chemin = path.isAbsolute(fichier) ? fichier : path.join(RACINE, fichier);
  const backup = JSON.parse(fs.readFileSync(chemin, "utf8"));
  console.log(`\n↩️  ROLLBACK depuis ${path.basename(chemin)} — ${backup.lignes.length} ligne(s)\n`);
  const { error } = await sb.from("ecritures_comptables").insert(backup.lignes);
  if (error) { console.error("❌", error.message); process.exit(1); }
  console.log(`✅ ${backup.lignes.length} ligne(s) restaurée(s).`);
  await equilibre("après rollback");
  process.exit(0);
}

async function main() {
  if (ROLLBACK) return rollback(ROLLBACK);

  let q = sb.from("dossiers").select("id,nom_societe");
  if (DOSSIER) q = q.ilike("nom_societe", `%${DOSSIER}%`);
  const { data: dossiers, error: eD } = await q;
  if (eD) { console.error("❌", eD.message); process.exit(1); }

  // ─── Suppression ciblée ────────────────────────────────────────────────────
  if (SUPPRIMER) return supprimer(SUPPRIMER, (dossiers ?? []) as any[]);

  // ─── Audit ─────────────────────────────────────────────────────────────────
  console.log("\n═══ AUDIT DES ÉCRITURES DE TRÉSORERIE (BQ / CAI) ═══\n");
  let totalSuspectes = 0, totalFaibles = 0, totalOk = 0;

  for (const d of (dossiers ?? []) as any[]) {
    const [{ data: ecr }, { data: fc }, { data: ff }, { data: enc }, { data: tx }] = await Promise.all([
      sb.from("ecritures_comptables")
        .select("id,dossier_id,journal_code,compte_numero,date_ecriture,libelle,debit,credit,reference_piece,lettrage_code,transaction_id,facture_id")
        .eq("dossier_id", d.id).in("journal_code", JOURNAUX_TRESORERIE),
      sb.from("factures").select("id,numero,date_facture").eq("dossier_id", d.id),
      sb.from("factures_fournisseurs").select("id,numero,date_facture").eq("dossier_id", d.id),
      sb.from("encaissements").select("date_encaissement,montant").eq("dossier_id", d.id),
      // `releve_id` non nul EXIGÉ : une transaction rattachée à aucun relevé est
      // elle-même une donnée orpheline, elle ne prouve rien.
      sb.from("transactions_bancaires").select("date_operation,montant,releve_id")
        .eq("dossier_id", d.id).not("releve_id", "is", null),
    ]);
    const lignes = (ecr ?? []) as Ligne[];
    if (!lignes.length) continue;

    // Index des preuves.
    const refsFactures = new Set<string>();
    // Date de facture par code de lettrage → contrôle d'antériorité.
    const dateParFacture = new Map<string, string>();
    for (const f of [...((fc ?? []) as any[]), ...((ff ?? []) as any[])]) {
      refsFactures.add(String(f.id));
      if (f.numero) refsFactures.add(String(f.numero).trim());
      if (f.date_facture) {
        dateParFacture.set(String(f.id), String(f.date_facture).slice(0, 10));
        if (f.numero) dateParFacture.set(String(f.numero).trim(), String(f.date_facture).slice(0, 10));
      }
    }
    // Facture lettrée sous chaque code — pour dater ce que le règlement solde.
    const { data: lettrees } = await sb.from("ecritures_comptables")
      .select("lettrage_code,reference_piece,journal_code")
      .eq("dossier_id", d.id).not("lettrage_code", "is", null)
      .in("journal_code", ["VTE", "ACH"]);
    const factureDuCode = new Map<string, string>();
    for (const l of ((lettrees ?? []) as any[])) {
      const ref = String(l.reference_piece ?? "").trim();
      if (l.lettrage_code && ref) factureDuCode.set(String(l.lettrage_code), ref);
    }
    const cleMontantDate = (date: string, montant: number) => `${String(date).slice(0, 10)}|${round2(Math.abs(montant)).toFixed(2)}`;
    const encSet = new Set(((enc ?? []) as any[]).map((e) => cleMontantDate(e.date_encaissement, n(e.montant))));
    const txSet = new Set(((tx ?? []) as any[]).map((t) => cleMontantDate(t.date_operation, n(t.montant))));

    // Regroupement par ÉCRITURE — c'est elle qu'on juge, pas la ligne.
    const groupes = new Map<string, Ligne[]>();
    for (const l of lignes) {
      const c = cleEcriture(l);
      const g = groupes.get(c);
      if (g) g.push(l); else groupes.set(c, [l]);
    }

    const suspectes: { cle: string; lignes: Ligne[]; montant: number; faible: boolean; antidate: string | null }[] = [];
    for (const [cle, groupe] of groupes) {
      const preuve = groupe.some((l) =>
        l.transaction_id
        || l.facture_id
        || (l.reference_piece && refsFactures.has(String(l.reference_piece).trim())));
      const montant = round2(groupe.reduce((s, l) => s + Math.max(n(l.debit), n(l.credit)), 0) / groupe.length);
      const date = String(groupe[0].date_ecriture ?? "").slice(0, 10);
      const k = cleMontantDate(date, montant);

      // Antériorité : un règlement ne peut pas précéder la facture qu'il solde.
      let antidate: string | null = null;
      const code = groupe.map((l) => l.lettrage_code).find(Boolean);
      if (code) {
        const refFacture = factureDuCode.get(String(code));
        const dateFacture = refFacture ? dateParFacture.get(refFacture) : undefined;
        if (dateFacture && date && date < dateFacture) {
          antidate = `règlement du ${date} pour une facture du ${dateFacture} (${refFacture})`;
        }
      }

      // Une écriture ADOSSÉE reste suspecte si elle est antidatée : la preuve
      // dit « ce mouvement existe », pas « il est cohérent ».
      if ((preuve || encSet.has(k)) && !antidate) { totalOk++; continue; }
      const faible = txSet.has(k) && !antidate;
      suspectes.push({ cle, lignes: groupe, montant, faible, antidate });
      if (faible) totalFaibles++; else totalSuspectes++;
    }

    if (!suspectes.length) continue;
    console.log(`\n📁 ${d.nom_societe}`);
    for (const s of suspectes.sort((a, b) => Number(a.faible) - Number(b.faible))) {
      const [j, date, lib] = s.cle.split("|");
      const ecart = round2(s.lignes.reduce((acc, l) => acc + n(l.debit) - n(l.credit), 0));
      console.log(`   ${s.faible ? "🟡 lien perdu " : "🔴 FICTIVE   "} ${j} ${date}  ${fmt(s.montant)} MAD  « ${lib.slice(0, 52)} »`);
      if (s.antidate) console.log(`        ⛔ INCOHÉRENT : ${s.antidate}`);
      for (const l of s.lignes) {
        console.log(`        ${l.id}  ${String(l.compte_numero).padEnd(10)} D ${fmt(n(l.debit)).padStart(11)} C ${fmt(n(l.credit)).padStart(11)}` +
          `${l.lettrage_code ? `  lettrée ${l.lettrage_code}` : ""}`);
      }
      if (Math.abs(ecart) > TOL) {
        console.log(`        ⚠️  écriture DÉSÉQUILIBRÉE (${fmt(ecart)}) — la supprimer telle quelle laisserait un écart`);
      }
      const codes = [...new Set(s.lignes.map((l) => l.lettrage_code).filter(Boolean))];
      if (codes.length) console.log(`        ▶ node --import tsx scripts/auditer-tresorerie-fictive.ts --supprimer=lettrage:${codes[0]} --apply`);
      else console.log(`        ▶ node --import tsx scripts/auditer-tresorerie-fictive.ts --supprimer=${s.lignes.map((l) => l.id).join(",")} --apply`);
    }
  }

  console.log("\n" + "─".repeat(72));
  console.log(`🔴 ${totalSuspectes} écriture(s) SANS aucune pièce (fictives)`);
  console.log(`🟡 ${totalFaibles} écriture(s) au lien perdu (une ligne de relevé existe : à RELIER, pas à supprimer)`);
  console.log(`✅ ${totalOk} écriture(s) adossée(s) à une pièce`);
  console.log("");
}

// ─── Suppression d'une écriture de trésorerie ────────────────────────────────
async function supprimer(cible: string, dossiers: any[]) {
  console.log(`\n═══ SUPPRESSION ${APPLY ? "" : "(DRY-RUN)"} — cible : ${cible} ═══\n`);
  await equilibre("avant");

  let lignes: Ligne[] = [];
  let codeLettrage: string | null = null;

  if (cible.startsWith("lettrage:")) {
    codeLettrage = cible.slice("lettrage:".length).trim();
    const { data } = await sb.from("ecritures_comptables")
      .select("id,dossier_id,journal_code,compte_numero,date_ecriture,libelle,debit,credit,reference_piece,lettrage_code,transaction_id,facture_id")
      .eq("lettrage_code", codeLettrage).in("journal_code", JOURNAUX_TRESORERIE);
    lignes = (data ?? []) as Ligne[];
  } else {
    const ids = cible.split(",").map((s) => s.trim()).filter(Boolean);
    const { data } = await sb.from("ecritures_comptables")
      .select("id,dossier_id,journal_code,compte_numero,date_ecriture,libelle,debit,credit,reference_piece,lettrage_code,transaction_id,facture_id")
      .in("id", ids);
    lignes = (data ?? []) as Ligne[];
  }
  if (!lignes.length) { console.log("Aucune ligne ne correspond à la cible."); process.exit(0); }

  // ÉLARGISSEMENT à l'écriture entière : supprimer le seul crédit d'une écriture
  // de banque déséquilibrerait le journal de son montant. C'est la garde
  // principale de ce script.
  const dossierId = lignes[0].dossier_id;
  const { data: toutes } = await sb.from("ecritures_comptables")
    .select("id,dossier_id,journal_code,compte_numero,date_ecriture,libelle,debit,credit,reference_piece,lettrage_code,transaction_id,facture_id")
    .eq("dossier_id", dossierId).in("journal_code", JOURNAUX_TRESORERIE);
  const cles = new Set(lignes.map(cleEcriture));
  const completes = ((toutes ?? []) as Ligne[]).filter((l) => cles.has(cleEcriture(l)));

  const ajoutees = completes.length - lignes.length;
  if (ajoutees > 0) {
    console.log(`ℹ️  ${ajoutees} ligne(s) ajoutée(s) pour compléter l'écriture (partie double).\n`);
  }
  console.log("Lignes à supprimer :");
  for (const l of completes) {
    console.log(`   ${l.journal_code} ${l.date_ecriture} ${String(l.compte_numero).padEnd(10)} ` +
      `D ${fmt(n(l.debit)).padStart(11)} C ${fmt(n(l.credit)).padStart(11)}` +
      `${l.lettrage_code ? ` [${l.lettrage_code}]` : ""}  « ${String(l.libelle).slice(0, 45)} »`);
  }
  const ecart = round2(completes.reduce((s, l) => s + n(l.debit) - n(l.credit), 0));
  console.log(`\nÉquilibre du lot : ${fmt(ecart)} MAD`);
  if (Math.abs(ecart) > TOL) {
    console.error("❌ Le lot n'est PAS équilibré — suppression refusée, elle créerait un écart.");
    process.exit(1);
  }

  const codes = [...new Set(completes.map((l) => l.lettrage_code).filter(Boolean))] as string[];
  if (codes.length) {
    console.log(`\n🔗 Lettrage à défaire d'abord : ${codes.join(", ")}`);
    console.log("   (supprime les OD de bascule TVA et dé-estampille les lignes de facture)");
  }

  if (!APPLY) { console.log("\n🔍 DRY-RUN — rien n'a été écrit. Ajoutez --apply."); process.exit(0); }

  // 1) Délettrage par le MOTEUR APPLICATIF : c'est lui qui sait supprimer les OD
  //    de TVA en écritures complètes et dé-estampiller le reste.
  if (codes.length) {
    const r = await executerDelettrage(sb, { dossierId, codes });
    if (!r.ok) { console.error(`❌ Délettrage impossible : ${r.reason}`); process.exit(1); }
    console.log(`✅ Délettré : ${r.codes.join(", ")} — ${r.lignesDelettrees} ligne(s), ${r.odSupprimees} OD de TVA supprimée(s)`);
  }

  // 2) Suppression des lignes de trésorerie.
  const backup = { date: new Date().toISOString(), cible, lignes: completes };
  const { error } = await sb.from("ecritures_comptables").delete().in("id", completes.map((l) => l.id));
  if (error) { console.error("❌", error.message); process.exit(1); }
  console.log(`✅ ${completes.length} ligne(s) de trésorerie supprimée(s).`);

  const nom = `backup_tresorerie_${new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14)}.json`;
  fs.writeFileSync(path.join(RACINE, nom), JSON.stringify(backup, null, 2), "utf8");
  console.log(`💾 Backup : ${nom}`);
  console.log(`↩️  Rollback : node --import tsx scripts/auditer-tresorerie-fictive.ts --rollback=${nom}`);
  console.log("   (le rollback restaure les lignes de trésorerie ; le lettrage, lui, est à refaire depuis l'écran)");

  await equilibre("après");
}

main().catch((e) => { console.error("💥", e); process.exit(1); });
