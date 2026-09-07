/**
 * fix_vte_account_postings.ts — Reprise de la chaîne Ventes ⇄ Trésorerie sur
 * TOUS les dossiers, anciens comme nouveaux.
 *
 * Le code est corrigé en amont (générateur pur + invariant dans
 * src/lib/ecritures-vente.ts, validation de date dans src/lib/date-reglement.ts,
 * bornes d'exercice dans src/lib/exercice-comptable.ts). Ce script répare ce que
 * l'ancien code a laissé en base. Il ne réimplémente AUCUNE règle : il appelle
 * les mêmes fonctions pures que l'écran et les tests, pour qu'aucun des trois ne
 * puisse dériver des deux autres.
 *
 * ─── Les trois passes ────────────────────────────────────────────────────────
 *
 *  1. VTE / 4191 → compte de PRODUIT
 *     Le 4191 « Clients — avances et acomptes reçus » est un compte de PASSIF.
 *     Crédité par une facture ordinaire, il escamote le chiffre d'affaires : le
 *     compte de résultat est amputé du montant et le bilan porte une dette qui
 *     n'existe pas. On reclasse ces crédits sur le compte de produit du client.
 *
 *     PRUDENCE : une facture qui porte AUSSI un débit du 4191 est une structure
 *     acompte/solde légitime. Reclasser une moitié de la paire déséquilibrerait
 *     le grand livre — ces factures sont RAPPORTÉES, jamais touchées.
 *
 *  2. Statuts de paiement ⇄ preuve d'encaissement
 *     Une facture ne se solde pas parce qu'une colonne le dit. Il faut une
 *     écriture de trésorerie (BQ/CAI) qui crédite son compte de tiers, à défaut
 *     un lettrage, à défaut une pièce de règlement formelle. Sans aucune des
 *     trois, la facture redevient « non payée » et son reste dû réapparaît dans
 *     l'encours clients — c'est là tout l'objet du contrôle.
 *
 *  3. Dates de règlement invraisemblables
 *     Une facture ne peut pas être réglée avant d'être émise. La date est
 *     RECALÉE sur la date de facture (correction minimale : effacer la date
 *     ferait perdre le fait qu'un règlement a eu lieu).
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   node --import tsx scripts/fix_vte_account_postings.ts                  # DRY-RUN
 *   node --import tsx scripts/fix_vte_account_postings.ts --apply
 *   node --import tsx scripts/fix_vte_account_postings.ts --dossier="SOMADIR"
 *   node --import tsx scripts/fix_vte_account_postings.ts --passe=statuts --apply
 *   node --import tsx scripts/fix_vte_account_postings.ts --rollback=backup_ventes_XXX.json
 *
 * Sans --apply, RIEN n'est écrit. Chaque exécution avec --apply produit un
 * backup JSON rejouable en --rollback.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { compteVente } from "../src/lib/compte-vente";
import {
  acomptesIndus, auditerCoherenceVentes, datesReglementIncoherentes,
  recalerDateReglement, statutsARecalibrer, type FactureVente,
} from "../src/lib/coherence-ventes";
import { COMPTE_ACOMPTES_CLIENTS } from "../src/lib/ecritures-vente";
import type { LigneGrandLivre, PieceReglement } from "../src/lib/encours-grandlivre";
import { bornesExercice, exerciceCourant } from "../src/lib/exercice-comptable";

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
}) as any;

// ─── Arguments ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const val = (n: string) => {
  const a = args.find((x) => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3).replace(/^["']|["']$/g, "") : null;
};
const DOSSIER = val("dossier");
const ROLLBACK = val("rollback");
const PASSE = (val("passe") ?? "toutes") as "toutes" | "vte" | "statuts" | "dates";
const fait = (p: string) => PASSE === "toutes" || PASSE === p;

/**
 * Ce qui vaut PREUVE d'encaissement.
 *
 *   --preuve=tresorerie  (DÉFAUT) une écriture BQ/CAI, directe ou lettrée. C'est
 *        la règle demandée : « si aucune écriture n'est enregistrée au débit du
 *        5141/5161 et au crédit du 3421, la facture reste non encaissée ».
 *   --preuve=toutes      admet en plus une ligne de `paiements` sans écriture.
 *        Comportement historique, à ne choisir qu'en connaissance de cause.
 *
 * Aucune donnée n'est supprimée dans un cas comme dans l'autre : `paiements` et
 * `transactions_bancaires` restent intacts.
 */
const PREUVE = (val("preuve") ?? "tresorerie") as "tresorerie" | "toutes";
const OPT_PREUVE = { accepterPieces: PREUVE === "toutes" };

const fmt = (x: number) => Number(x).toLocaleString("fr-MA", { minimumFractionDigits: 2 });
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Ce qu'on doit pouvoir remettre en l'état — une ligne par écriture / facture. */
interface Backup {
  genere: string;
  ecritures: { id: string; compte_numero: string; libelle: string }[];
  factures: {
    id: string; statut_paiement: string | null; montant_paye: number | null;
    montant_restant: number | null; date_paiement: string | null;
  }[];
}

// ─── Rollback ────────────────────────────────────────────────────────────────
if (ROLLBACK) {
  const chemin = path.isAbsolute(ROLLBACK) ? ROLLBACK : path.join(RACINE, ROLLBACK);
  const b = JSON.parse(fs.readFileSync(chemin, "utf8")) as Backup;
  console.log(`\n↩️  ROLLBACK depuis ${path.basename(chemin)} (généré le ${b.genere})`);
  let n = 0;
  for (const e of b.ecritures ?? []) {
    const { error } = await sb.from("ecritures_comptables")
      .update({ compte_numero: e.compte_numero, libelle: e.libelle }).eq("id", e.id);
    if (error) console.log(`   ❌ écriture ${e.id} : ${error.message}`); else n++;
  }
  for (const f of b.factures ?? []) {
    const { error } = await sb.from("factures").update({
      statut_paiement: f.statut_paiement, montant_paye: f.montant_paye,
      montant_restant: f.montant_restant, date_paiement: f.date_paiement,
    }).eq("id", f.id);
    if (error) console.log(`   ❌ facture ${f.id} : ${error.message}`); else n++;
  }
  console.log(`   ✅ ${n} ligne(s) restaurée(s)\n`);
  process.exit(0);
}

// ─── Chargement ──────────────────────────────────────────────────────────────
let qd = sb.from("dossiers").select("id,nom_societe,secteur_activite,date_debut_activite");
if (DOSSIER) qd = qd.ilike("nom_societe", `%${DOSSIER}%`);
const { data: dossiers, error: eDos } = await qd;
if (eDos) { console.error("❌ dossiers :", eDos.message); process.exit(1); }

// La table `paiements` est livrée par migration manuelle : absente, la requête
// échoue et on continue sur le seul grand livre. Le taire ferait croire que
// l'absence de pièces est un fait métier alors que c'est un schéma incomplet.
const { data: paiements, error: ePai } = await sb.from("paiements")
  .select("facture_id,montant,date_paiement");
if (ePai) console.log(`\nℹ️  table \`paiements\` indisponible (${ePai.message.split(".")[0]}) — preuve limitée au grand livre.`);

// Index global : les identifiants de facture sont uniques, un seul index suffit
// pour tous les dossiers — et le contrôle final le relit tel quel.
const pieces = new Map<string, PieceReglement[]>();
for (const p of ((paiements ?? []) as any[])) {
  const k = String(p.facture_id ?? "");
  if (!k) continue;
  pieces.set(k, [...(pieces.get(k) ?? []), { montant: Number(p.montant ?? 0), date: p.date_paiement }]);
}

const backup: Backup = { genere: new Date().toISOString(), ecritures: [], factures: [] };
let totalEcritures = 0, totalFactures = 0, totalArbitrages = 0;

console.log(`\n═══ REPRISE VENTES / TRÉSORERIE ═══  ${APPLY ? "MODE ÉCRITURE" : "DRY-RUN (aucune écriture)"}`);
console.log(`    passes : ${PASSE}   ·   dossiers : ${dossiers.length}${DOSSIER ? ` (filtre « ${DOSSIER} »)` : ""}`);
console.log(`    preuve d'encaissement : ${PREUVE === "tresorerie"
  ? "écriture BQ/CAI exigée (règle stricte)"
  : "écriture OU pièce de règlement (permissif)"}`);

for (const d of dossiers ?? []) {
  const [{ data: fRows }, { data: eRows }, { data: cRows }] = await Promise.all([
    sb.from("factures").select(
      "id,numero,type,statut,statut_paiement,date_facture,date_paiement,"
      + "montant_ht,montant_ttc,montant_paye,montant_restant,lignes,client_id",
    ).eq("dossier_id", d.id),
    sb.from("ecritures_comptables").select(
      "id,journal_code,compte_numero,date_ecriture,libelle,debit,credit,reference_piece,lettrage_code,facture_id",
    ).eq("dossier_id", d.id),
    sb.from("clients").select("id,compte_produit_defaut").eq("dossier_id", d.id),
  ]);

  const factures = (fRows ?? []) as (FactureVente & { lignes?: any; client_id?: string | null })[];
  const lignes = (eRows ?? []) as LigneGrandLivre[];
  if (!factures.length && !lignes.length) continue;

  const produitClient = new Map<string, string>(
    ((cRows ?? []) as any[])
      .filter((c) => String(c.compte_produit_defaut ?? "").trim())
      .map((c) => [String(c.id), String(c.compte_produit_defaut).trim()]),
  );

  /**
   * Compte de produit d'une facture, dans l'ordre où l'utilisateur l'attend :
   * son arbitrage explicite (fiche client) d'abord, la déduction ensuite. C'est
   * exactement l'ordre que suit désormais `generateFactureXml`.
   */
  const compteProduit = (f: FactureVente): string => {
    const cid = String((f as any).client_id ?? "");
    const choisi = cid ? produitClient.get(cid) : null;
    if (choisi) return choisi;
    const designations = (((f as any).lignes ?? []) as any[]).map((l) => l?.designation ?? l?.description);
    return compteVente({ designations, secteur: d.secteur_activite }).compte;
  };

  console.log(`\n─── ${d.nom_societe} — ${factures.length} facture(s), ${lignes.length} écriture(s)`);

  // ── Passe 1 : crédits du 4191 sur des factures ordinaires ─────────────────
  if (fait("vte")) {
    const indus = acomptesIndus(factures, lignes, compteProduit);
    if (!indus.length) {
      console.log("   [1] 4191 → produit : rien à reclasser.");
    }
    for (const ind of indus) {
      // Une facture qui porte AUSSI un débit du 4191 est une paire acompte/solde
      // équilibrée : la défaire par moitié créerait l'écart qu'on veut éviter.
      const aDebit = lignes.some(
        (l) => String(l.compte_numero ?? "").startsWith(COMPTE_ACOMPTES_CLIENTS)
          && Number(l.debit ?? 0) > 0.005
          && (String(l.facture_id ?? "") === ind.facture.id
            || String(l.reference_piece ?? "") === String(ind.facture.numero ?? " ")),
      );
      if (aDebit) {
        totalArbitrages++;
        console.log(`   [1] ⚠️  ${ind.facture.numero} : ${fmt(ind.montant)} au 4191 MAIS un débit du 4191 existe `
          + "(structure acompte/solde) — NON TOUCHÉE, à arbitrer à la main.");
        continue;
      }
      console.log(`   [1] ${ind.facture.numero} : ${ind.lignes.length} ligne(s), ${fmt(ind.montant)} `
        + `— 4191 → ${ind.compteCible}`);
      if (!APPLY) { totalEcritures += ind.lignes.length; continue; }
      for (const l of ind.lignes) {
        backup.ecritures.push({
          id: String(l.id), compte_numero: String(l.compte_numero), libelle: String((l as any).libelle ?? ""),
        });
        const { error } = await sb.from("ecritures_comptables").update({
          compte_numero: ind.compteCible,
          // Le libellé « Avance reçue » désignait la nature du 4191 : le laisser
          // sur un compte de produit rendrait l'écriture illisible en révision.
          libelle: String((l as any).libelle ?? "").replace(/^Avance re[çc]ue/i, "Vente"),
        }).eq("id", l.id);
        if (error) console.log(`       ❌ ${l.id} : ${error.message}`);
        else totalEcritures++;
      }
    }
  }

  // ── Passe 2 : statuts de paiement ─────────────────────────────────────────
  const patchees = new Set<string>();
  if (fait("statuts")) {
    const corrections = statutsARecalibrer(factures, lignes, pieces, OPT_PREUVE);
    if (!corrections.length) console.log("   [2] statuts : tous conformes à la comptabilité.");
    for (const c of corrections) {
      console.log(`   [2] ${c.facture.numero} : ${c.avant.statut_paiement} → ${c.apres.statut_paiement}`
        + ` · payé ${fmt(c.avant.montant_paye)} → ${fmt(c.apres.montant_paye)}`
        + ` · reste ${fmt(c.avant.montant_restant)} → ${fmt(c.apres.montant_restant)}`);
      console.log(`       ↳ ${c.motif}`);
      patchees.add(c.facture.id);
      if (!APPLY) { totalFactures++; continue; }
      backup.factures.push({
        id: c.facture.id, statut_paiement: c.avant.statut_paiement,
        montant_paye: c.avant.montant_paye, montant_restant: c.avant.montant_restant,
        date_paiement: c.avant.date_paiement,
      });
      const { error } = await sb.from("factures").update({
        statut_paiement: c.apres.statut_paiement,
        montant_paye: c.apres.montant_paye,
        montant_restant: c.apres.montant_restant,
        date_paiement: c.apres.date_paiement,
      }).eq("id", c.facture.id);
      if (error) console.log(`       ❌ ${error.message}`);
      else totalFactures++;
    }
  }

  // ── Passe 3 : dates de règlement antérieures à l'émission ─────────────────
  if (fait("dates")) {
    const anomalies = datesReglementIncoherentes(factures);
    if (!anomalies.length) console.log("   [3] dates de règlement : aucune antériorité.");
    for (const a of anomalies) {
      if (patchees.has(a.facture.id)) {
        console.log(`   [3] ${a.facture.numero} : date ${a.dateReglement} déjà traitée par la passe 2.`);
        continue;
      }
      console.log(`   [3] ${a.facture.numero} : réglée le ${a.dateReglement}, émise le ${a.dateFacture} `
        + `(${a.joursAvant} j avant) → recalée sur ${a.dateCorrigee}`);
      if (!APPLY) { totalFactures++; continue; }
      backup.factures.push({
        id: a.facture.id, statut_paiement: a.facture.statut_paiement ?? null,
        montant_paye: a.facture.montant_paye ?? null, montant_restant: a.facture.montant_restant ?? null,
        date_paiement: a.dateReglement,
      });
      const { error } = await sb.from("factures")
        .update({ date_paiement: recalerDateReglement(a.dateFacture, a.dateReglement) })
        .eq("id", a.facture.id);
      if (error) console.log(`       ❌ ${error.message}`);
      else totalFactures++;
    }
  }
}

// ─── Backup ──────────────────────────────────────────────────────────────────
if (APPLY && (backup.ecritures.length || backup.factures.length)) {
  const nom = `backup_ventes_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(path.join(RACINE, nom), JSON.stringify(backup, null, 2), "utf8");
  console.log(`\n💾 Backup : ${nom}  (rejouable via --rollback=${nom})`);
}

// ─── Contrôle FINAL : on relit la base, on ne se fie pas au compte des patchs ─
console.log("\n═══ CONTRÔLE APRÈS REPRISE ═══");
const exercice = exerciceCourant();
let rouge = 0;
for (const d of dossiers ?? []) {
  const [{ data: fRows }, { data: eRows }] = await Promise.all([
    sb.from("factures").select(
      "id,numero,type,statut,statut_paiement,date_facture,date_paiement,montant_ht,montant_ttc,montant_paye,montant_restant",
    ).eq("dossier_id", d.id),
    sb.from("ecritures_comptables").select(
      "id,journal_code,compte_numero,date_ecriture,debit,credit,reference_piece,lettrage_code,facture_id",
    ).eq("dossier_id", d.id),
  ]);
  const factures = (fRows ?? []) as FactureVente[];
  const lignes = (eRows ?? []) as LigneGrandLivre[];
  if (!factures.length && !lignes.length) continue;

  const rapport = auditerCoherenceVentes(factures, lignes, {
    bornes: bornesExercice(exercice, d.date_debut_activite),
    piecesParFacture: pieces, ...OPT_PREUVE,
  });
  const marque = (ok: boolean) => (ok ? "✅" : "❌");
  if (!rapport.ok) rouge++;
  console.log(`\n${d.nom_societe} — exercice ${exercice}`);
  console.log(`  ${marque(rapport.ca.ok)} (a) CA HT ${fmt(rapport.ca.caHt)} ⇄ crédits classe 7 ${fmt(rapport.ca.credits7)}`
    + (rapport.ca.ok ? "" : ` — écart ${fmt(rapport.ca.ecart)}`)
    + (rapport.ca.nonComptabilisees.length
      ? ` · ${rapport.ca.nonComptabilisees.length} facture(s) CONFORME(S) mais non comptabilisée(s) : `
        + rapport.ca.nonComptabilisees.map((f) => f.numero).join(", ")
      : ""));
  // Le CA facturé qui n'entrera jamais en comptabilité tant que la pièce n'est
  // pas corrigée : ce n'est pas un écart, mais ce n'est pas rien non plus.
  if (rapport.ca.horsPerimetre.length) {
    console.log(`      ℹ️  hors périmètre comptable : ${fmt(rapport.ca.htHorsPerimetre)} HT — `
      + rapport.ca.horsPerimetre.map((f) => `${f.numero} (${f.statut})`).join(", ")
      + " · à corriger et retransmettre pour entrer en comptabilité.");
  }
  console.log(`  ${marque(rapport.encours.ok)} (b) encours 342x non lettré ${fmt(rapport.encours.encoursGrandLivre)}`
    + ` ⇄ restes dus ${fmt(rapport.encours.encoursFactures)}`
    + (rapport.encours.ok ? "" : ` — écart ${fmt(rapport.encours.ecart)}`));
  console.log(`  ${marque(rapport.acomptes.length === 0)} (c) crédits 4191 sur factures ordinaires : ${rapport.acomptes.length}`);
  console.log(`  ${marque(rapport.statuts.length === 0)} (d) statuts contredisant la comptabilité : ${rapport.statuts.length}`);
  console.log(`  ${marque(rapport.dates.length === 0)} (e) dates de règlement antérieures à l'émission : ${rapport.dates.length}`);
  if (rapport.horsExercice) {
    console.log(`  ℹ️  ${rapport.horsExercice} écriture(s) hors exercice ${exercice} — désormais invisibles depuis la vue ${exercice}.`);
  }
}

console.log(`\n═══ BILAN ═══`);
console.log(`  écritures ${APPLY ? "reclassées" : "à reclasser"} : ${totalEcritures}`);
console.log(`  factures  ${APPLY ? "corrigées" : "à corriger"}  : ${totalFactures}`);
if (totalArbitrages) console.log(`  ⚠️  ${totalArbitrages} facture(s) laissée(s) à l'arbitrage manuel (paire 4191 équilibrée)`);
if (!APPLY) console.log("\n  Rien n'a été écrit. Relancer avec --apply pour appliquer.");
console.log(`\n  ${rouge === 0 ? "✅ tous les contrôles sont verts." : `❌ ${rouge} dossier(s) encore en écart.`}\n`);
process.exit(rouge === 0 ? 0 : 1);
