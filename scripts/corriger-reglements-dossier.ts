/**
 * corriger-reglements-dossier.ts — réaligne les règlements d'un dossier sur ce
 * que la comptabilité atteste, et retire ce qui ne peut pas être vrai.
 *
 * ─── Ce qu'il corrige, et pourquoi ce n'est pas une migration ────────────────
 * La migration 20260908120000 pose les verrous : elle empêche qu'un règlement
 * impossible entre en base. Elle ne défait rien de ce qui y est déjà — le faire
 * en DDL supposerait de délier des écritures et de toucher à une bascule de TVA,
 * sans sauvegarde ni retour arrière possible.
 *
 * Ce script s'en charge, en trois gestes et dans cet ordre :
 *
 *   1. les PIÈCES irrecevables sont retirées de `paiements` — antérieures à
 *      l'émission, doublons, montants nuls (cf. src/lib/reglements.ts) ;
 *   2. les LIENS BANCAIRES impossibles sont défaits sur
 *      `transactions_bancaires` — sans quoi le geste 1 serait vain : la RPC
 *      `synchroniser_paiements_dossier` RECONSTRUIT les paiements depuis ces
 *      liens, et le règlement fautif réapparaîtrait au rapprochement suivant.
 *      La ligne de relevé n'est JAMAIS supprimée : c'est un fait bancaire, elle
 *      retourne simplement dans la file « à lettrer » ;
 *   3. les COLONNES de la facture sont recalculées depuis ce qui reste.
 *
 * ─── Le cas particulier du règlement COMPTABILISÉ sur une pièce fausse ───────
 * REPERAL (FAC002_2026, 14 785 MAD) : le grand livre porte bien le règlement au
 * 16/07/2026 — écriture BQ équilibrée, lettrage AD, bascule de TVA déductible —
 * mais le paiement s'adosse à un chèque du 16/07/**2024**. La comptabilité est
 * cohérente ; sa justification ne l'est pas.
 *
 * Supprimer le paiement démarquerait une facture que le grand livre dit réglée,
 * et laisserait la bascule de TVA sans cause. On DÉTACHE donc le paiement de la
 * fausse pièce — il devient un règlement manuel, daté comme l'écriture qui le
 * porte — et on délie la ligne de 2024. La facture reste réglée, conformément au
 * grand livre ; ce qui disparaît, c'est l'affirmation fausse sur son origine.
 * L'écriture de trésorerie du 16/07/2026 se retrouve alors sans ligne de relevé :
 * c'est une anomalie RÉELLE, et le rapport la signale pour arbitrage plutôt que
 * de la maquiller.
 *
 * ─── Sûreté ──────────────────────────────────────────────────────────────────
 * • DRY-RUN par défaut : il faut `--apply` pour écrire.
 * • Sauvegarde JSON complète de l'état AVANT, et `--rollback` la rejoue.
 * • Aucune écriture comptable n'est créée ni supprimée. Le script touche
 *   `paiements`, le lien de `transactions_bancaires` et les colonnes dérivées
 *   des factures — rien du grand livre.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   node --import tsx scripts/corriger-reglements-dossier.ts --dossier="SMERT"
 *   node --import tsx scripts/corriger-reglements-dossier.ts --dossier="SMERT" --apply
 *   node --import tsx scripts/corriger-reglements-dossier.ts --rollback=backup_reglements_XXX.json
 *
 * CODE DE SORTIE : 0 = rien à corriger · 1 = corrections trouvées ou appliquées
 * · 2 = échec.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  examinerPaiements, projeterEtatReglement, reglementDivergent,
  MARQUEUR_PIECE_A_RETROUVER, type PaiementCandidat,
} from "../src/lib/reglements";
import {
  situationFactureGrandLivre, type LigneGrandLivre,
} from "../src/lib/encours-grandlivre";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const flag = (nom: string) => {
  const hit = argv.find((a) => a === `--${nom}` || a.startsWith(`--${nom}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf("=");
  return eq === -1 ? "" : hit.slice(eq + 1).replace(/^["']|["']$/g, "");
};
const CIBLE = flag("dossier") || null;
const APPLY = flag("apply") !== undefined;
const ROLLBACK = flag("rollback");

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env"), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
) as Record<string, string>;

// Le proxy TLS de l'entreprise casse le `fetch` global ; undici en direct passe.
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
const sb = createClient(env.SUPABASE_URL || env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  global: { fetch: proxyFetch as any }, auth: { persistSession: false, autoRefreshToken: false },
}) as any;

const nb = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const txt = (v: unknown) => String(v ?? "").trim();
const jour = (v: unknown) => txt(v).slice(0, 10);
const fmt = (x: number) => nb(x).toLocaleString("fr-MA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const COLS_GL = "id,journal_code,compte_numero,date_ecriture,debit,credit,reference_piece,lettrage_code,facture_id";

interface Sauvegarde {
  genere_le: string;
  dossier: { id: string; nom: string };
  paiements_supprimes: any[];
  paiements_detaches: { id: string; avant: any }[];
  transactions_deliees: { id: string; avant: any }[];
  factures_recalculees: { table: string; id: string; avant: any }[];
}

// ─── Rollback ────────────────────────────────────────────────────────────────

async function rejouer(fichier: string): Promise<number> {
  const s = JSON.parse(fs.readFileSync(path.resolve(ROOT, fichier), "utf8")) as Sauvegarde;
  console.log(`↩️  Rollback de ${fichier} — dossier ${s.dossier.nom}\n`);
  let n = 0;

  // Ordre inverse de l'application : on remet d'abord les liens et les pièces,
  // puis les colonnes — le trigger `paiements_resync` réécrirait sinon les
  // colonnes qu'on vient de restaurer.
  for (const t of s.transactions_deliees) {
    const { error } = await sb.from("transactions_bancaires").update(t.avant).eq("id", t.id);
    if (error) console.error(`   ✗ transaction ${t.id} : ${error.message}`); else n++;
  }
  for (const p of s.paiements_detaches) {
    const { error } = await sb.from("paiements").update(p.avant).eq("id", p.id);
    if (error) console.error(`   ✗ paiement ${p.id} : ${error.message}`); else n++;
  }
  for (const p of s.paiements_supprimes) {
    const { error } = await sb.from("paiements").insert(p);
    if (error) console.error(`   ✗ réinsertion paiement ${p.id} : ${error.message}`); else n++;
  }
  for (const f of s.factures_recalculees) {
    const { error } = await sb.from(f.table).update(f.avant).eq("id", f.id);
    if (error) console.error(`   ✗ facture ${f.id} : ${error.message}`); else n++;
  }

  console.log(`\n↩️  ${n} restauration(s).`);
  return 0;
}

// ─── Correction ──────────────────────────────────────────────────────────────

async function corriger(): Promise<number> {
  const { data: dossiers, error: eDos } = await sb.from("dossiers").select("id,nom_societe").order("nom_societe");
  if (eDos) { console.error("Lecture des dossiers impossible :", eDos.message); return 2; }

  const cibles = (dossiers ?? []).filter((d: any) =>
    !CIBLE || txt(d.nom_societe).toLowerCase().includes(CIBLE.toLowerCase()));
  if (!cibles.length) { console.error(`Aucun dossier ne correspond à « ${CIBLE} ».`); return 2; }

  let anomalies = 0;

  for (const d of cibles) {
    const [{ data: ecr }, { data: fc }, { data: ff }, { data: pai }, { data: tx }] = await Promise.all([
      sb.from("ecritures_comptables").select(COLS_GL).eq("dossier_id", d.id),
      sb.from("factures").select("id,numero,date_facture,montant_ttc,montant_paye,montant_restant,statut_paiement,date_paiement").eq("dossier_id", d.id),
      sb.from("factures_fournisseurs").select("id,numero,date_facture,montant_ttc,montant_paye,montant_restant,statut_paiement,date_paiement").eq("dossier_id", d.id),
      sb.from("paiements").select("*").eq("dossier_id", d.id),
      sb.from("transactions_bancaires").select("id,date_operation,montant,libelle,facture_id,document_type,statut,rapproche,releve_id").eq("dossier_id", d.id).not("facture_id", "is", null),
    ]);

    const lignes = (ecr ?? []) as LigneGrandLivre[];
    const paiements = (pai ?? []) as any[];
    const transactions = (tx ?? []) as any[];
    const factures = [
      ...((fc ?? []) as any[]).map((f) => ({ ...f, table: "factures" as const, sens: "client" as const })),
      ...((ff ?? []) as any[]).map((f) => ({ ...f, table: "factures_fournisseurs" as const, sens: "fournisseur" as const })),
    ];
    if (!factures.length) continue;

    const sauvegarde: Sauvegarde = {
      genere_le: new Date().toISOString(),
      dossier: { id: d.id, nom: d.nom_societe },
      paiements_supprimes: [], paiements_detaches: [],
      transactions_deliees: [], factures_recalculees: [],
    };
    const rapport: string[] = [];
    const arbitrages: string[] = [];

    for (const f of factures) {
      const fk = f.sens === "client" ? "facture_id" : "facture_fournisseur_id";
      const siennes = paiements.filter((p) => txt(p[fk]) === txt(f.id));
      const txSiennes = transactions.filter((t) => txt(t.facture_id) === txt(f.id)
        && (f.sens === "fournisseur") === (txt(t.document_type) === "facture_fournisseur"));

      // ── Ce que le GRAND LIVRE atteste ────────────────────────────────────
      const gl = situationFactureGrandLivre(lignes, {
        references: [f.numero, f.id], id: f.sens === "client" ? f.id : null,
        montant_ttc: nb(f.montant_ttc), sens: f.sens,
      });

      // ── Recevabilité, jugée sur la date de la PIÈCE quand il y en a une ──
      // La date de saisie peut avoir été recalée ; celle du relevé, non.
      const dateDePiece = (p: any): string | null => {
        const t = transactions.find((x) => txt(x.id) === txt(p.transaction_id));
        return t ? jour(t.date_operation) : jour(p.date_paiement) || null;
      };
      const candidats: PaiementCandidat[] = siennes.map((p) => ({
        id: p.id, montant: nb(p.montant), date_paiement: dateDePiece(p),
        origine: p.origine, transaction_id: p.transaction_id,
        encaissement_id: p.encaissement_id, reference: p.reference,
      }));
      const examens = examinerPaiements(f, candidats);
      const rejets = examens.filter((e) => !e.recevable);

      for (const r of rejets) {
        const brut = siennes.find((p) => txt(p.id) === txt(r.paiement.id));
        if (!brut) continue;
        // Le grand livre porte-t-il DÉJÀ ce règlement ? Si oui, la comptabilité
        // est cohérente et seule la pièce est fausse : on détache au lieu de
        // supprimer (cas REPERAL). Sinon, rien ne l'atteste : on supprime.
        const porteParLeGl = gl.montant_paye >= nb(brut.montant) - 0.005 && gl.trouvee;
        if (porteParLeGl && brut.transaction_id) {
          sauvegarde.paiements_detaches.push({
            id: brut.id,
            avant: { transaction_id: brut.transaction_id, origine: brut.origine,
                     date_paiement: brut.date_paiement, reference: brut.reference },
          });
          rapport.push(
            `   ⚠ ${txt(f.numero)} — règlement de ${fmt(brut.montant)} DÉTACHÉ de sa pièce : `
            + `${r.message}\n     Le grand livre porte bien ce règlement (${fmt(gl.montant_paye)} au ${gl.date_paiement}) : `
            + "la facture reste réglée, seule l'origine fausse disparaît.");
          arbitrages.push(
            `${txt(f.numero)} : l'écriture de trésorerie du ${gl.date_paiement} n'a plus de ligne de relevé. `
            + "Retrouver la pièce réelle, ou annuler l'écriture et sa bascule de TVA.");
        } else {
          sauvegarde.paiements_supprimes.push({ ...brut });
          rapport.push(`   ✗ ${txt(f.numero)} — règlement SUPPRIMÉ : ${r.message}`);
        }
        anomalies++;
      }

      // ── Liens bancaires impossibles ──────────────────────────────────────
      const emission = jour(f.date_facture);
      for (const t of txSiennes) {
        const op = jour(t.date_operation);
        if (!emission || !op || op >= emission) continue;
        sauvegarde.transactions_deliees.push({
          id: t.id,
          avant: { facture_id: t.facture_id, document_type: t.document_type,
                   statut: t.statut, rapproche: t.rapproche },
        });
        const jours = Math.round((Date.parse(emission) - Date.parse(op)) / 86400000);
        rapport.push(
          `   ✗ ${txt(f.numero)} — ligne de relevé du ${op} DÉLIÉE (${fmt(t.montant)} MAD, `
          + `${jours} j avant l'émission du ${emission}) : « ${txt(t.libelle).slice(0, 44)} ». `
          + "La ligne reste en base et retourne à la file « à lettrer ».");
        anomalies++;
      }

      // ── Colonnes de la facture, recalculées sur ce qui RESTE ─────────────
      const retenus = examens.filter((e) => e.recevable).map((e) => e.paiement);
      const etat = projeterEtatReglement(f, gl.montant_paye, gl.date_paiement, retenus);
      if (reglementDivergent(f, etat)) {
        sauvegarde.factures_recalculees.push({
          table: f.table, id: f.id,
          avant: { montant_paye: nb(f.montant_paye), montant_restant: nb(f.montant_restant),
                   statut_paiement: f.statut_paiement, date_paiement: f.date_paiement },
        });
        rapport.push(
          `   → ${txt(f.numero)} : ${f.statut_paiement} ${fmt(f.montant_paye)}/${fmt(f.montant_ttc)} `
          + `⇒ ${etat.statut_paiement} ${fmt(etat.montant_paye)}/${fmt(f.montant_ttc)} `
          + `(reste ${fmt(etat.montant_restant)}, ${etat.preuve})`);
        anomalies++;
        (f as any).__etat = etat;
      }
    }

    const rien = !rapport.length;
    console.log(`\n${"═".repeat(78)}\n${d.nom_societe}\n${"═".repeat(78)}`);
    if (rien) { console.log("   ✓ Règlements cohérents — rien à corriger."); continue; }
    for (const l of rapport) console.log(l);

    if (arbitrages.length) {
      console.log("\n   ── À ARBITRER (le script ne tranche pas) ──");
      for (const a of arbitrages) console.log(`   • ${a}`);
    }

    if (!APPLY) {
      console.log("\n🔍 DRY-RUN — rien n'a été écrit. Ajoutez --apply.");
      continue;
    }

    // ── Écriture ───────────────────────────────────────────────────────────
    const nomBackup = `backup_reglements_${txt(d.nom_societe).replace(/[^\w]+/g, "_").toLowerCase()}_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    fs.writeFileSync(path.join(ROOT, nomBackup), JSON.stringify(sauvegarde, null, 2), "utf8");
    console.log(`\n💾 Sauvegarde : ${nomBackup}`);

    // 1. Délier les transactions AVANT de toucher aux paiements : tant que le
    //    lien existe, une resynchronisation concurrente recréerait le paiement.
    for (const t of sauvegarde.transactions_deliees) {
      const { error } = await sb.from("transactions_bancaires").update({
        facture_id: null, document_type: null, rapproche: false,
        statut: t.avant.statut === "cloture" ? "cloture" : "ouvert",
      }).eq("id", t.id);
      if (error) console.error(`   ✗ déliaison ${t.id} : ${error.message}`);
    }

    // 2. Détacher les paiements portés par le grand livre mais adossés à une
    //    fausse pièce. `origine: 'manuel'` est indispensable : le rebuild efface
    //    les origines DÉRIVÉES, et le règlement disparaîtrait au prochain
    //    rapprochement alors que le grand livre le porte.
    for (const p of sauvegarde.paiements_detaches) {
      const { error } = await sb.from("paiements").update({
        transaction_id: null, origine: "manuel",
        reference: `${MARQUEUR_PIECE_A_RETROUVER} (ex-tx ${String(p.avant.transaction_id).slice(0, 8)})`,
      }).eq("id", p.id);
      if (error) console.error(`   ✗ détachement ${p.id} : ${error.message}`);
    }

    // 3. Supprimer les paiements irrecevables non portés par la comptabilité.
    for (const p of sauvegarde.paiements_supprimes) {
      const { error } = await sb.from("paiements").delete().eq("id", p.id);
      if (error) console.error(`   ✗ suppression ${p.id} : ${error.message}`);
    }

    // 4. Recaler les colonnes EN DERNIER : les suppressions ci-dessus
    //    déclenchent `paiements_resync`, qui les réécrit. Les poser avant
    //    reviendrait à se faire écraser par le trigger.
    for (const f of factures) {
      const etat = (f as any).__etat;
      if (!etat) continue;
      const { error } = await sb.from(f.table).update({
        montant_paye: etat.montant_paye,
        montant_restant: etat.montant_restant,
        statut_paiement: etat.statut_paiement,
        date_paiement: etat.date_reglement,
      }).eq("id", f.id);
      if (error) console.error(`   ✗ facture ${txt(f.numero)} : ${error.message}`);
    }

    console.log(`\n✅ Appliqué. Rollback : --rollback=${nomBackup}`);
  }

  console.log(`\n${"─".repeat(78)}`);
  console.log(anomalies ? `${anomalies} correction(s) ${APPLY ? "appliquée(s)" : "à appliquer"}.` : "Aucune anomalie.");
  return anomalies ? 1 : 0;
}

const code = ROLLBACK !== undefined && ROLLBACK
  ? await rejouer(ROLLBACK)
  : await corriger();
process.exit(code);
