/**
 * audit-ecritures-parasites.ts — diagnostic GLOBAL, en LECTURE SEULE : traque les
 * écritures parasites laissées par les anciens tests OCR / imports de relevés.
 *
 *   node --import tsx scripts/audit-ecritures-parasites.ts
 *
 * N'ÉCRIT RIEN. Il propose les commandes de nettoyage, il ne les exécute pas.
 *
 * Quatre détecteurs :
 *   A. Compte de CLASSE 6 (charge) à solde CRÉDITEUR   → charge négative, impossible.
 *   B. Compte de CLASSE 7 (produit) à solde DÉBITEUR   → produit négatif, impossible.
 *   C. Écriture BQ dont le libellé est un EN-TÊTE ou un SOUS-TOTAL de relevé
 *      (mots-clés récap + le garde `isNonTransactional` du parser ATW, qui est la
 *      référence : c'est lui qui manque au parser générique).
 *   D. Compte 5141 (banque) dont le solde est disproportionné vs l'activité.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { isNonTransactional } from "../src/lib/releve-attijari";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env"), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
) as Record<string, string>;

let PROXY_DIRECT = false;
async function proxyFetch(input: any, init?: any): Promise<any> {
  const direct = async () => {
    const { fetch: uf, Agent } = await import("undici");
    return uf(String(input), { ...init, dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) } as any);
  };
  if (PROXY_DIRECT) return direct();
  try { return await fetch(String(input), init); } catch { PROXY_DIRECT = true; return direct(); }
}
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  global: { fetch: proxyFetch as any }, auth: { persistSession: false },
});

const n = (v: any) => Number(v ?? 0);
const fmt = (v: number) => v.toLocaleString("fr-MA", { minimumFractionDigits: 2 });
const pad = (s: string, w: number) => (s.length > w ? s.slice(0, w - 1) + "…" : s.padEnd(w));

/** Mots-clés de synthèse/récapitulatif : jamais une vraie opération bancaire. */
const RX_RECAP = /\b(total\s+(d[eé]bit|cr[eé]dit|des\s+mouvements?|g[eé]n[eé]ral|op[eé]rations?)|sous[-\s]?total|totaux|solde\s+interm[eé]diaire|solde\s+(initial|final|de\s+d[eé]part|de\s+cl[oô]ture|[àa]\s+reporter|[àa]\s+nouveau|pr[eé]c[eé]dent)|ancien\s+solde|nouveau\s+solde|report\s+[àa]\s+nouveau|r[eé]capitulatif|releve\s+de\s+compte|relev[eé]\s+d[eu]\s+compte|extrait\s+de\s+compte)\b/i;
/** En-tête d'établissement bancaire (nom de banque + mention d'agence/adresse). */
const RX_ENTETE_BANQUE = /\b(cih\s*bank|attijariwafa|banque\s+populaire|bmce|bmci|societe\s+generale|credit\s+agricole|cr[eé]dit\s+du\s+maroc|al\s*barid|saham|wafabank)\b/i;
/** Métadonnées de relevé (période, devise, en-tête de colonnes) — jamais une opération. */
const RX_META = /\b(p[eé]riode\s*:|devise\s*:|dirham\s+marocain|date\s+oper|date\s+valeur|code\s+banque|n°?\s*compte|num[eé]ro\s+de\s+compte)\b/i;
/**
 * Verbe d'opération bancaire. INDISPENSABLE comme garde-fou : `isNonTransactional`
 * liste « maroc », « agence », « rib », « montant »… des mots qui apparaissent dans
 * de VRAIS libellés (« VIREMENT RECU - DISTRI-FOOD MAROC »). Ce garde a été écrit
 * pour trancher une ligne BRUTE d'OCR, pas un libellé déjà extrait : appliqué tel
 * quel à un libellé, il supprimerait des transactions légitimes.
 */
const RX_OPERATION = /\b(vir(ement|t)?\b|sepa|pr[eé]l[eè]v|prlv|ch[eè]que|chq|remise|encaissement|paiement|paimt|versement|retrait|gab|dab|commission|agios|frais|effet|traite|lcn|domiciliation)\b/i;

interface Anomalie {
  dossier: string; dossierId: string; detecteur: "A" | "B" | "C" | "D";
  compte: string; sens: string; montant: number; origine: string;
  detail: string; ids: string[]; batchIds: string[]; certain?: boolean;
}

// ── Chargement ───────────────────────────────────────────────────────────────
const { data: dossiers, error: e1 } = await sb.from("dossiers").select("id,nom_societe").order("nom_societe");
if (e1) { console.error("❌", e1.message); process.exit(1); }
const { data: batches } = await sb.from("import_batches").select("id,filename,type,source_rows,inserted_ecritures,created_at");
const batchParId = new Map((batches ?? []).map((b) => [b.id, b]));

const anomalies: Anomalie[] = [];
const resume: { nom: string; ecr: number; ko: number }[] = [];

console.log(`\n${"═".repeat(100)}\n🔎 AUDIT DES ÉCRITURES PARASITES — ${dossiers?.length} dossier(s) — LECTURE SEULE\n${"═".repeat(100)}`);

for (const d of dossiers ?? []) {
  const { data: ecr, error } = await sb.from("ecritures_comptables")
    .select("id,journal_code,compte_numero,libelle,debit,credit,date_ecriture,reference_piece,batch_id,transaction_id")
    .eq("dossier_id", d.id);
  if (error) { console.log(`\n❌ ${d.nom_societe} : ${error.message}`); continue; }
  const avant = anomalies.length;

  // Origine présumée d'une écriture : lot d'import, sinon indices OCR relevé.
  const origine = (e: any): string => {
    const b = e.batch_id ? batchParId.get(e.batch_id) : null;
    if (b) return `Import ${b.type ?? "?"} « ${b.filename ?? "?"} » (${b.inserted_ecritures} écr., ${String(b.created_at).slice(0, 10)})`;
    if (e.batch_id) return `Lot d'import ${String(e.batch_id).slice(0, 8)} (introuvable)`;
    const m = String(e.libelle ?? "").match(RX_ENTETE_BANQUE);
    if (m) return `Test OCR relevé — en-tête ${m[0].toUpperCase()}`;
    if (e.journal_code === "BQ") return "Scan de relevé bancaire (journal BQ, hors lot)";
    return "à qualifier";
  };

  // ── A & B : soldes de sens impossible, agrégés PAR COMPTE ──────────────────
  const parCompte = new Map<string, { debit: number; credit: number; lignes: any[] }>();
  for (const e of ecr ?? []) {
    const c = (e.compte_numero ?? "").trim();
    if (!c) continue;
    const acc = parCompte.get(c) ?? { debit: 0, credit: 0, lignes: [] };
    acc.debit += n(e.debit); acc.credit += n(e.credit); acc.lignes.push(e);
    parCompte.set(c, acc);
  }
  for (const [compte, v] of parCompte) {
    const solde = v.debit - v.credit;                       // > 0 = débiteur
    if (compte.startsWith("6") && solde < -0.01) {
      const coupables = v.lignes.filter((l) => n(l.credit) > 0);
      anomalies.push({
        dossier: d.nom_societe, dossierId: d.id, detecteur: "A", compte, sens: "CRÉDIT",
        montant: Math.abs(solde), origine: origine(coupables[0] ?? v.lignes[0]),
        detail: `charge à solde créditeur (D ${fmt(v.debit)} / C ${fmt(v.credit)}) — ${coupables.length} ligne(s) au crédit`,
        ids: coupables.map((l) => l.id), batchIds: [...new Set(coupables.map((l) => l.batch_id).filter(Boolean))] as string[],
      });
    }
    if (compte.startsWith("7") && solde > 0.01) {
      const coupables = v.lignes.filter((l) => n(l.debit) > 0);
      anomalies.push({
        dossier: d.nom_societe, dossierId: d.id, detecteur: "B", compte, sens: "DÉBIT",
        montant: solde, origine: origine(coupables[0] ?? v.lignes[0]),
        detail: `produit à solde débiteur (D ${fmt(v.debit)} / C ${fmt(v.credit)}) — ${coupables.length} ligne(s) au débit`,
        ids: coupables.map((l) => l.id), batchIds: [...new Set(coupables.map((l) => l.batch_id).filter(Boolean))] as string[],
      });
    }
  }

  // ── C : libellés d'en-tête / sous-total dans le journal de banque ──────────
  for (const e of ecr ?? []) {
    if ((e.journal_code ?? "").toUpperCase() !== "BQ") continue;
    const lib = String(e.libelle ?? "");
    const recap = RX_RECAP.test(lib), entete = RX_ENTETE_BANQUE.test(lib), meta = RX_META.test(lib);
    const garde = isNonTransactional(lib), operation = RX_OPERATION.test(lib);
    // Un verbe d'opération l'emporte : c'est une vraie ligne, même si un mot-clé
    // d'en-tête traîne dans le nom du tiers (« … MAROC », « … AGENCE »).
    if (operation) continue;
    const motifs = [recap && "récap/solde", entete && "en-tête banque", meta && "métadonnée relevé", garde && "isNonTransactional"].filter(Boolean) as string[];
    if (!motifs.length) continue;
    // Certitude = un marqueur explicite ; le seul `isNonTransactional` reste À VÉRIFIER.
    const certain = recap || entete || meta;
    anomalies.push({
      dossier: d.nom_societe, dossierId: d.id, detecteur: "C", compte: e.compte_numero ?? "?",
      sens: n(e.debit) > 0 ? "DÉBIT" : "CRÉDIT", montant: Math.max(n(e.debit), n(e.credit)),
      origine: origine(e), certain,
      detail: `libellé non transactionnel [${motifs.join(", ")}]${certain ? "" : " — À VÉRIFIER"} : « ${lib.slice(0, 62)} »`,
      ids: [e.id], batchIds: e.batch_id ? [e.batch_id] : [],
    });
  }

  // ── D : trésorerie 5141 disproportionnée vs l'activité ─────────────────────
  const solde5141 = (ecr ?? []).filter((e) => (e.compte_numero ?? "").startsWith("5141")).reduce((s, e) => s + n(e.debit) - n(e.credit), 0);
  // Référence d'activité en flux BRUTS (débits de charges, crédits de produits) :
  // un solde NET serait gonflé par l'anomalie elle-même (le crédit parasite de
  // 1 084 033 sur 6171 faisait passer « activité » à 1,06 M et masquait le ratio).
  const produits = (ecr ?? []).filter((e) => (e.compte_numero ?? "").startsWith("7")).reduce((s, e) => s + n(e.credit), 0);
  const charges = (ecr ?? []).filter((e) => (e.compte_numero ?? "").startsWith("6")).reduce((s, e) => s + n(e.debit), 0);
  const activite = Math.max(produits, charges);
  if (solde5141 > 100_000 && (activite === 0 || solde5141 > 3 * activite)) {
    const gros = (ecr ?? []).filter((e) => (e.compte_numero ?? "").startsWith("5141"))
      .sort((a, b) => Math.max(n(b.debit), n(b.credit)) - Math.max(n(a.debit), n(a.credit))).slice(0, 3);
    anomalies.push({
      dossier: d.nom_societe, dossierId: d.id, detecteur: "D", compte: "5141", sens: "DÉBIT",
      montant: solde5141, origine: origine(gros[0] ?? {}),
      detail: `solde banque ${fmt(solde5141)} pour une activité de ${fmt(activite)} (ratio ${activite ? (solde5141 / activite).toFixed(1) : "∞"}×) — plus gros mouvements : ${gros.map((g) => fmt(Math.max(n(g.debit), n(g.credit)))).join(", ")}`,
      ids: gros.map((g) => g.id), batchIds: [],
    });
  }

  resume.push({ nom: d.nom_societe, ecr: (ecr ?? []).length, ko: anomalies.length - avant });
}

// ── Rapport ──────────────────────────────────────────────────────────────────
console.log(`\n📋 COUVERTURE\n`);
console.log(`  ${pad("Dossier", 34)} ${"écritures".padStart(9)} ${"anomalies".padStart(9)}`);
for (const r of resume) console.log(`  ${pad(r.nom, 34)} ${String(r.ecr).padStart(9)} ${String(r.ko).padStart(9)}${r.ko ? "  ⚠️" : ""}`);

const LBL: Record<string, string> = { A: "Charge (cl.6) créditrice", B: "Produit (cl.7) débiteur", C: "Libellé en-tête/sous-total", D: "Trésorerie disproportionnée" };
if (!anomalies.length) {
  console.log(`\n🎉 Aucune écriture parasite détectée.\n`);
} else {
  console.log(`\n${"═".repeat(100)}\n📊 TABLEAU RÉCAPITULATIF — ${anomalies.length} anomalie(s)\n${"═".repeat(100)}\n`);
  console.log(`  ${pad("Dossier", 26)} ${pad("Compte", 7)} ${pad("Sens", 7)} ${"Montant".padStart(16)}  Origine supposée`);
  console.log(`  ${"─".repeat(96)}`);
  for (const a of anomalies)
    console.log(`  ${pad(a.dossier, 26)} ${pad(a.compte, 7)} ${pad(a.sens, 7)} ${fmt(a.montant).padStart(16)}  [${a.detecteur}] ${a.origine}`);

  console.log(`\n${"═".repeat(100)}\n🔬 DÉTAIL PAR ANOMALIE\n${"═".repeat(100)}`);
  for (const a of anomalies) {
    console.log(`\n  ▸ ${a.dossier} — ${a.compte} ${a.sens} ${fmt(a.montant)} MAD   [${a.detecteur} : ${LBL[a.detecteur]}]`);
    console.log(`    ${a.detail}`);
    console.log(`    origine : ${a.origine}`);
    console.log(`    écriture(s) : ${a.ids.map((i) => i.slice(0, 8)).join(", ")}${a.batchIds.length ? `   lot(s) : ${a.batchIds.map((b) => b.slice(0, 8)).join(", ")}` : ""}`);
  }

  // ── Propositions de nettoyage, groupées par dossier ────────────────────────
  console.log(`\n${"═".repeat(100)}\n🧹 PROPOSITIONS DE NETTOYAGE (aucune n'a été exécutée)\n${"═".repeat(100)}`);
  const parDossier = new Map<string, Anomalie[]>();
  for (const a of anomalies) parDossier.set(a.dossierId, [...(parDossier.get(a.dossierId) ?? []), a]);
  for (const [did, list] of parDossier) {
    console.log(`\n  ▸ ${list[0].dossier}  (${did})`);
    let etape = 0;                                   // numérotation continue des étapes
    const lots = [...new Set(list.flatMap((a) => a.batchIds))];
    const ids = [...new Set(list.filter((a) => a.detecteur !== "D").flatMap((a) => a.ids))];
    if (lots.length) {
      console.log(`    ${++etape}) PURGE DU LOT D'IMPORT (réversible par conception, cf. annulerImport) :`);
      for (const l of lots) {
        const b = batchParId.get(l);
        console.log(`       lot ${l} — ${b?.filename ?? "?"} (${b?.inserted_ecritures ?? "?"} écritures)`);
        console.log(`       → UI : Comptabilité ▸ onglet « + Import » ▸ Annuler ce lot`);
        console.log(`       → SQL : delete from ecritures_comptables where batch_id = '${l}';`);
      }
    }
    if (ids.length) {
      console.log(`    ${++etape}) SUPPRESSION DES ÉCRITURES FANTÔMES (${ids.length}) — vérifier la CONTREPARTIE avant, sinon le journal se déséquilibre :`);
      console.log(`       select id, journal_code, compte_numero, debit, credit, libelle from ecritures_comptables`);
      console.log(`        where reference_piece in (select reference_piece from ecritures_comptables where id in (${ids.map((i) => `'${i}'`).join(", ")}));`);
      console.log(`       delete from ecritures_comptables where id in (${ids.map((i) => `'${i}'`).join(", ")});`);
    }
    if (list.some((a) => a.detecteur === "D"))
      console.log(`    ${++etape}) TRÉSORERIE : recontrôler le solde 5141 APRÈS purge (le montant fantôme y est en double emploi).`);
  }
  console.log(`\n  ⚠️  Racine encore ACTIVE : parseReleveMarkdown (src/server/factures.utils.ts) ne filtre pas les`);
  console.log(`      en-têtes de relevé. Sans y brancher isNonTransactional, un prochain scan recréera ces parasites.\n`);
}
