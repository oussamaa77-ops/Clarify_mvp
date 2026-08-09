// verify_integrite_tresorerie.mjs — LECTURE SEULE. Contrôle sur la base RÉELLE :
//   1. aucune écriture de trésorerie (BQ/CAI) fantôme — ni relevé validé, ni pièce ;
//   2. équilibre de la partie double, dossier par dossier ;
//   3. l'encours clients du dashboard = postes ouverts du 3421 au grand livre ;
//   4. le solde bancaire affiché = solde des comptes de classe 5 dès que la
//      comptabilité porte des mouvements ;
//   5. `factures.montant_paye / restant / statut` en accord avec la comptabilité.
//
// Lancement :  node --import tsx verify_integrite_tresorerie.mjs
//              node --import tsx verify_integrite_tresorerie.mjs --dossier="DIGITAL"
//
// Code de sortie : 0 tout vert, 1 au moins un contrôle rouge.

import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  JOURNAUX_TRESORERIE, clePiece, grouperEnEcritures, origineEcritureTresorerie,
} from "./src/lib/integrite-tresorerie.ts";
import {
  COMPTE_CLIENTS, encoursTiersGrandLivre, projeterSituationFacture, situationDivergente,
  situationFactureGrandLivre, soldeBancaireAffiche,
} from "./src/lib/encours-grandlivre.ts";

const env = Object.fromEntries(
  fs.readFileSync(new URL(".env", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);
let DIRECT = false;
async function pf(input, init) {
  const direct = async () => {
    const { fetch: uf, Agent } = await import("undici");
    return uf(String(input), { ...init, dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) });
  };
  if (DIRECT) return direct();
  try { return await fetch(String(input), init); } catch { DIRECT = true; return direct(); }
}
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { global: { fetch: pf } });

const arg = process.argv.slice(2).find((a) => a.startsWith("--dossier="));
const DOSSIER = arg ? arg.slice(10).replace(/^["']|["']$/g, "") : null;

const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const r2 = (x) => Math.round(x * 100) / 100;
const fmt = (x) => Number(x).toLocaleString("fr-MA", { minimumFractionDigits: 2 });

let rouge = 0;
const ok = (m) => console.log(`   ✅ ${m}`);
const ko = (m) => { rouge++; console.log(`   ❌ ${m}`); };

let q = sb.from("dossiers").select("id,nom_societe");
if (DOSSIER) q = q.ilike("nom_societe", `%${DOSSIER}%`);
const { data: dossiers, error } = await q;
if (error) { console.error("❌", error.message); process.exit(1); }

console.log("\n═══ INTÉGRITÉ BANQUE ⇄ GRAND LIVRE ═══");

for (const d of dossiers ?? []) {
  const [{ data: ecr }, { data: fc }, { data: ff }, { data: pai }, { data: enc }, { data: tx }, { data: cb }] =
    await Promise.all([
      sb.from("ecritures_comptables")
        .select("id,journal_code,compte_numero,date_ecriture,libelle,debit,credit,reference_piece,lettrage_code,transaction_id,facture_id")
        .eq("dossier_id", d.id),
      sb.from("factures").select("id,numero,montant_ttc,montant_paye,montant_restant,statut_paiement").eq("dossier_id", d.id),
      sb.from("factures_fournisseurs").select("id,numero,montant_ttc,montant_paye,montant_restant,statut_paiement").eq("dossier_id", d.id),
      sb.from("paiements").select("facture_id,facture_fournisseur_id,montant,date_paiement").eq("dossier_id", d.id),
      sb.from("encaissements").select("date_encaissement,montant").eq("dossier_id", d.id),
      sb.from("transactions_bancaires").select("id,date_operation,montant,releve_id").eq("dossier_id", d.id).not("releve_id", "is", null),
      sb.from("comptes_bancaires").select("solde_actuel").eq("dossier_id", d.id),
    ]);

  const lignes = ecr ?? [];
  if (!lignes.length) continue;
  console.log(`\n📁 ${d.nom_societe}`);

  // ── 1. Écritures de trésorerie fantômes ────────────────────────────────────
  const transactionsValidees = (tx ?? []).map((t) => String(t.id));
  const piecesManuelles = [
    ...(enc ?? []).map((e) => clePiece(e.date_encaissement, n(e.montant))),
    ...(pai ?? []).map((p) => clePiece(p.date_paiement, n(p.montant))),
  ];
  const tresorerie = lignes.filter((l) => JOURNAUX_TRESORERIE.includes(String(l.journal_code ?? "").toUpperCase()));
  const fantomes = [];
  for (const [cle, groupe] of grouperEnEcritures(tresorerie)) {
    const adossee = groupe.some((l) => origineEcritureTresorerie(l, { transactionsValidees, piecesManuelles }).ok);
    if (!adossee) fantomes.push({ cle, groupe });
  }
  if (fantomes.length) {
    ko(`${fantomes.length} écriture(s) de trésorerie sans relevé ni pièce`);
    for (const f of fantomes) console.log(`        ${f.cle} — ${fmt(Math.max(...f.groupe.map((l) => Math.max(n(l.debit), n(l.credit)))))} MAD`);
  } else {
    ok(`${tresorerie.length} ligne(s) de trésorerie, toutes adossées à un relevé ou à une pièce`);
  }

  // ── 2. Partie double ───────────────────────────────────────────────────────
  const ecart = r2(lignes.reduce((s, l) => s + n(l.debit) - n(l.credit), 0));
  if (Math.abs(ecart) > 0.005) ko(`grand livre DÉSÉQUILIBRÉ — écart ${fmt(ecart)} MAD`);
  else ok(`partie double équilibrée sur ${lignes.length} ligne(s)`);

  // ── 3. Encours clients (KPI dashboard) ─────────────────────────────────────
  const encours = encoursTiersGrandLivre(lignes, COMPTE_CLIENTS);
  ok(`encours clients (3421 non lettré) = ${fmt(encours.total)} MAD sur ${encours.postes.length} poste(s)`
    + (encours.avances > 0.005 ? ` · ${fmt(encours.avances)} d'avances` : ""));

  // ── 4. Solde bancaire (widget dashboard) ───────────────────────────────────
  const soldeComptes = (cb ?? []).reduce((s, c) => s + n(c.solde_actuel), 0);
  const solde = soldeBancaireAffiche(lignes, soldeComptes);
  if (solde.source === "grand_livre") ok(`solde bancaire = ${fmt(solde.montant)} MAD (classe 5 du grand livre)`);
  else ok(`solde bancaire = ${fmt(solde.montant)} MAD (comptes bancaires — aucun mouvement de trésorerie en compta)`);

  // ── 5. Projection des factures ─────────────────────────────────────────────
  const pieces = new Map();
  for (const p of pai ?? []) {
    const cle = String(p.facture_id ?? p.facture_fournisseur_id ?? "");
    if (!cle) continue;
    pieces.set(cle, [...(pieces.get(cle) ?? []), { montant: n(p.montant), date: p.date_paiement }]);
  }
  let divergentes = 0, examinees = 0;
  for (const [rows, sens] of [[fc ?? [], "client"], [ff ?? [], "fournisseur"]]) {
    for (const f of rows) {
      const ttc = n(f.montant_ttc);
      const gl = situationFactureGrandLivre(lignes, {
        references: [f.numero, f.id], id: sens === "client" ? f.id : null, montant_ttc: ttc, sens,
      });
      if (!gl.trouvee) continue;
      examinees++;
      const attendu = projeterSituationFacture(gl, pieces.get(String(f.id)) ?? [], ttc);
      if (situationDivergente(
        { montant_paye: n(f.montant_paye), montant_restant: n(f.montant_restant), statut_paiement: f.statut_paiement },
        attendu,
      )) {
        divergentes++;
        console.log(`        ${f.numero ?? f.id} : stocké ${fmt(n(f.montant_paye))}/${f.statut_paiement}`
          + ` ≠ compta ${fmt(attendu.montant_paye)}/${attendu.statut_paiement}`);
      }
    }
  }
  if (divergentes) ko(`${divergentes}/${examinees} facture(s) divergent(es) du grand livre`);
  else ok(`${examinees} facture(s) comptabilisée(s), toutes en accord avec la comptabilité`);
}

console.log("\n" + "─".repeat(72));
console.log(rouge === 0 ? "✅ TOUS LES CONTRÔLES SONT VERTS\n" : `❌ ${rouge} contrôle(s) en échec\n`);
process.exit(rouge === 0 ? 0 : 1);
