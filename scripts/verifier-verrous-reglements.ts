/**
 * verifier-verrous-reglements.ts — les verrous de règlement sont-ils ACTIFS en base ?
 *
 * ─── Pourquoi une sonde par le COMPORTEMENT ──────────────────────────────────
 * La spécification OpenAPI de PostgREST liste les fonctions et les vues. Elle ne
 * voit NI LES TRIGGERS NI LES INDEX — c'est-à-dire précisément ce qui refuse un
 * règlement impossible. Une migration peut donc y paraître « présente » alors que
 * ses verrous ne mordent pas.
 *
 * Chaque contrôle tente donc une écriture réellement fautive et exige un refus,
 * puis nettoie derrière lui. C'est la seule preuve qui vaille.
 *
 * ─── Le piège que cette sonde a elle-même connu ──────────────────────────────
 * Une première version comptait TOUT refus comme un succès. Elle a affiché
 * « antériorité refusée par le trigger » sur une base où le trigger était cassé :
 * l'insert échouait bien, mais en 42883 (fonction `emission_facture` absente),
 * pas sur la règle d'antériorité. Un contrôle qui ne regarde pas POURQUOI il a
 * été refusé finit par certifier la panne qu'il devait détecter.
 *
 * On exige donc le CODE SQLSTATE attendu :
 *   23514 check_violation  → une règle métier a parlé (RAISE du trigger) ;
 *   23505 unique_violation → un index d'unicité a parlé.
 * Tout autre code est un échec, y compris un refus.
 *
 * LECTURE SEULE en net : chaque ligne écrite est supprimée avant de rendre la main.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   node --import tsx scripts/verifier-verrous-reglements.ts
 *
 * CODE DE SORTIE : 0 = tous les verrous mordent · 1 = au moins un manque.
 */

import {
  clientGolden, exigerDossierGolden, messageErreur, txt,
} from "../tests/golden/harness";

const { sb, env } = clientGolden();

const URL_BASE = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
const CLE = env.SUPABASE_SERVICE_ROLE_KEY;

let echecs = 0;
const ok = (m: string) => console.log(`  ✓ ${m}`);
const ko = (m: string) => { echecs++; console.log(`  ✗ ${m}`); };
const titre = (m: string) => console.log(`\n── ${m} ──`);

/** Le SQLSTATE d'un refus PostgREST, ou "" sur un succès. */
const code = (e: any) => txt(e?.code);

interface Tentative { refuse: boolean; code: string; message: string; id: string | null }

async function tenter(ligne: Record<string, any>): Promise<Tentative> {
  const { data, error } = await sb.from("paiements").insert(ligne).select("id");
  if (error) return { refuse: true, code: code(error), message: messageErreur(error), id: null };
  return { refuse: false, code: "", message: "", id: txt((data ?? [])[0]?.id) || null };
}

const retirer = async (id: string | null) => { if (id) await sb.from("paiements").delete().eq("id", id); };

/**
 * Exige un refus PORTANT LE BON CODE.
 *
 * Le message distingue les trois issues, qui appellent trois gestes différents :
 * accepté (le verrou manque), refusé pour la bonne raison (conforme), refusé pour
 * une autre (la base est en panne, et le verrou reste inconnu).
 */
function exigerRefus(t: Tentative, attendu: string, quoi: string): void {
  if (!t.refuse) { ko(`${quoi} — ACCEPTÉ. Le verrou ne mord pas.`); return; }
  if (t.code !== attendu) {
    ko(`${quoi} — refusé en ${t.code || "?"} au lieu de ${attendu} : ${t.message.slice(0, 120)}`);
    return;
  }
  ok(`${quoi} — refusé (${attendu})`);
}

async function main(): Promise<number> {
  const dossier = await exigerDossierGolden(sb);
  console.log(`\n${"═".repeat(74)}`);
  console.log("  VERROUS DE RÈGLEMENT — sonde par le comportement");
  console.log("═".repeat(74));

  // ── 1. Ce que la spec sait montrer : fonctions et vue ────────────────────
  titre("1. Fonctions et vue (spec OpenAPI)");
  const spec = await (await (await import("../tests/golden/harness")).proxyFetch(
    `${URL_BASE}/rest/v1/`, { headers: { apikey: CLE, Authorization: `Bearer ${CLE}` } })).json();
  const rpc = new Set(Object.keys(spec.paths ?? {})
    .filter((p: string) => p.startsWith("/rpc/")).map((p: string) => p.slice(5)));
  // Chaque migration apporte un symbole qui n'existe QUE chez elle : c'est lui
  // qui prouve son passage. `enregistrer_reglement` ne prouve rien à lui seul —
  // les deux migrations le créent.
  for (const [fn, mig] of [
    ["emission_facture", "20260908120000"],
    ["enregistrer_reglement", "20260908120000 ou 20260909120000"],
    ["verrouiller_facture", "20260909120000"],
  ] as const) {
    rpc.has(fn) ? ok(`${fn} (${mig})`) : ko(`${fn} ABSENTE — ${mig} n'est pas passée`);
  }
  const { error: eVue } = await sb.from("v_liens_bancaires_impossibles").select("transaction_id").limit(1);
  eVue ? ko(`vue v_liens_bancaires_impossibles : ${messageErreur(eVue)}`)
    : ok("vue v_liens_bancaires_impossibles");

  // ── Les pièces du dossier étalon qui servent de cible ────────────────────
  const { data: fcs } = await sb.from("factures")
    .select("id,numero,date_facture,montant_ttc,montant_paye")
    .eq("dossier_id", dossier.id).in("numero", ["FA-GOLD-002"]);
  const cible = ((fcs ?? []) as any[])[0];
  if (!cible) { console.log("\n✗ FA-GOLD-002 introuvable : semez le dossier étalon d'abord."); return 1; }
  // FA-GOLD-002 : 24 000 TTC dont 9 000 déjà réglés. Une cible partiellement
  // réglée est indispensable — sur une facture soldée, c'est le verrou de
  // surpaiement qui répondrait à la place de celui qu'on interroge.
  console.log(`\n  cible : ${cible.numero} — ${cible.montant_ttc} TTC, ${cible.montant_paye} réglés, émise le ${cible.date_facture}`);

  const base = { dossier_id: dossier.id, facture_id: cible.id, origine: "manuel" };

  // ── 2. Le trigger accepte ce qui est RÉGULIER ────────────────────────────
  // Contre-épreuve d'abord : un verrou qui refuse tout passerait les contrôles
  // suivants sans rien protéger, et masquerait une base en panne.
  titre("2. Écriture régulière — le trigger ne bloque pas tout");
  for (const origine of ["manuel", "avoir"] as const) {
    const t = await tenter({ ...base, origine, montant: 0.01, date_paiement: "2026-09-10", reference: `SONDE-OK-${origine}` });
    await retirer(t.id);
    t.refuse ? ko(`origine='${origine}' REFUSÉE (${t.code}) : ${t.message.slice(0, 110)}`)
      : ok(`origine='${origine}' acceptée`);
  }

  // ── 3. Antériorité (20260908120000, invariant 1a) ────────────────────────
  titre("3. Antériorité — un règlement ne précède pas sa facture");
  const ant = await tenter({ ...base, montant: 1, date_paiement: "2026-01-01", reference: "SONDE-ANT" });
  await retirer(ant.id);
  exigerRefus(ant, "23514", `règlement du 01/01/2026 sur une facture du ${txt(cible.date_facture)}`);

  // ── 4. Unicité de la saisie manuelle (index partiel) ─────────────────────
  titre("4. Unicité — deux saisies manuelles identiques");
  const ligne = { ...base, montant: 1, date_paiement: "2026-09-11", reference: "SONDE-UQ" };
  const premier = await tenter(ligne);
  const second = await tenter(ligne);
  await retirer(premier.id); await retirer(second.id);
  if (!premier.refuse) exigerRefus(second, "23505", "second enregistrement à l'identique");
  else ko(`la PREMIÈRE saisie a été refusée (${premier.code}) : ${premier.message.slice(0, 110)}`);

  // ── 5. Non-dépassement cumulatif (invariant 3) ───────────────────────────
  titre("5. Non-dépassement — le cumul ne franchit pas le TTC");
  const sur = await tenter({ ...base, montant: 20000, date_paiement: "2026-09-12", reference: "SONDE-SUR" });
  await retirer(sur.id);
  exigerRefus(sur, "23514", `9 000 déjà réglés + 20 000 sur ${cible.montant_ttc} TTC`);

  // ── 6. lier_transaction v4 (contrôle d'antériorité AVANT le lien) ────────
  // La v3 liait d'abord et laissait le trigger échouer ensuite : la ligne de
  // relevé se retrouvait marquée rapprochée SANS règlement derrière, donc perdue
  // pour le lettrage. La v4 refuse en amont, et rien ne bouge. On le vérifie sur
  // une transaction jetable, supprimée dans tous les cas.
  titre("6. lier_transaction v4 — refus AVANT de marquer la ligne");
  let compteId: string | null = null;
  let txId: string | null = null;
  try {
    const { data: cpt, error: eCpt } = await sb.from("comptes_bancaires").insert({
      dossier_id: dossier.id, banque: "SONDE", intitule: "SONDE VERROUS", rib: "000000000000000000000000",
    }).select("id").single();
    if (eCpt) throw new Error(messageErreur(eCpt));
    compteId = txt(cpt.id);

    const { data: tr, error: eTr } = await sb.from("transactions_bancaires").insert({
      dossier_id: dossier.id, compte_id: compteId, date_operation: "2026-01-01",
      libelle: "SONDE — antérieure à la facture", type: "credit", montant: 1,
    }).select("id").single();
    if (eTr) throw new Error(messageErreur(eTr));
    txId = txt(tr.id);

    const { error: eLien } = await sb.rpc("lier_transaction", {
      p_tx_id: txId, p_doc_id: cible.id, p_doc_kind: "facture_client",
    });
    if (!eLien) {
      ko("ligne de relevé du 01/01/2026 LIÉE à une facture du " + txt(cible.date_facture)
        + " — c'est la v3, elle lie d'abord et casse ensuite");
    } else if (code(eLien) !== "23514") {
      ko(`lier_transaction refusée en ${code(eLien)} au lieu de 23514 : ${messageErreur(eLien).slice(0, 110)}`);
    } else {
      // Le refus ne suffit pas : il faut que la transaction soit restée INTACTE.
      const { data: apres } = await sb.from("transactions_bancaires")
        .select("facture_id,rapproche,statut").eq("id", txId).single();
      (apres?.facture_id || apres?.rapproche)
        ? ko("refusée, mais la transaction a quand même été marquée rapprochée")
        : ok("refusée AVANT le lien — la ligne de relevé reste disponible");
    }
  } catch (e: any) {
    ko(`contrôle lier_transaction impossible : ${e?.message ?? e}`);
  } finally {
    if (txId) await sb.from("transactions_bancaires").delete().eq("id", txId);
    if (compteId) await sb.from("comptes_bancaires").delete().eq("id", compteId);
  }

  // ── Verdict ──────────────────────────────────────────────────────────────
  const { data: reste } = await sb.from("paiements").select("id,reference")
    .eq("dossier_id", dossier.id).like("reference", "SONDE-%");
  if ((reste ?? []).length) {
    await sb.from("paiements").delete().in("id", ((reste ?? []) as any[]).map((r) => r.id));
    console.log(`\n  (${(reste ?? []).length} ligne(s) de sonde nettoyée(s) en dernier recours)`);
  }

  console.log(`\n${"─".repeat(74)}`);
  if (echecs) {
    console.log(`⛔ ${echecs} verrou(s) absent(s) ou inopérant(s) — NE PAS semer le dossier étalon.`);
    console.log("   Ordre d'application : 20260908120000, puis 20260909120000, puis 20260909130000.");
    return 1;
  }
  console.log("✅ Tous les verrous mordent. Le dossier étalon peut être semé.");
  return 0;
}

process.exit(await main());
