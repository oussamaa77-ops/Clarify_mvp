/**
 * realigner-comptes-auxiliaires.ts — script ONE-SHOT qui réimpute les écritures
 * DÉJÀ comptabilisées sur le compte COLLECTIF (4411 / 3421) vers le compte
 * AUXILIAIRE du tiers concerné (44110005 / 34210002…).
 *
 * Contexte : `scripts/attribuer-codes-auxiliaires.ts` a donné un code à chaque
 * fiche tiers, mais seules les pièces enregistrées APRÈS portent l'auxiliaire.
 * Tant que l'historique reste sur le collectif, le solde d'un tiers est éclaté
 * entre 4411 (ancien) et 44110005 (récent), et le lettrage d'une facture avec son
 * règlement traverse deux comptes. Ce script rapatrie l'historique.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   node --import tsx scripts/realigner-comptes-auxiliaires.ts                 # DRY-RUN
 *   node --import tsx scripts/realigner-comptes-auxiliaires.ts --apply         # écrit
 *   node --import tsx scripts/realigner-comptes-auxiliaires.ts --dossier="XXX"
 *   node --import tsx scripts/realigner-comptes-auxiliaires.ts --sans-regle3    # liens seuls
 *   node --import tsx scripts/realigner-comptes-auxiliaires.ts --rollback=backup.json
 *
 * ─── Rattachement d'une ligne à un tiers, par certitude DÉCROISSANTE ─────────
 *   R1 « lien »    : `reference_piece` = id d'une facture fournisseur (journal ACH)
 *                    ou `facture_id` = facture de vente → le tiers de la pièce.
 *                    Déterministe : c'est le lien posé à l'enregistrement.
 *   R2 « pièce »   : le n° de pièce d'UNE SEULE facture du dossier se retrouve dans
 *                    `reference_piece`/`libelle`. Sur un rapprochement PARTIEL de
 *                    numéro (« Paiement 24-0892 » ↔ « FA-2024-0892 »), le montant de
 *                    la ligne doit en plus égaler le TTC de la facture.
 *   R3 « nom »     : le nom d'UN SEUL tiers du dossier (≥ 6 caractères, du bon type)
 *                    est contenu dans le libellé — c'est le cas des lignes issues du
 *                    relevé bancaire (« VIREMENT RECU - BOULANGERIE DU SUD SARL »).
 *   Sinon la ligne RESTE sur le collectif et figure dans la liste « non rattachées ».
 *
 * ─── Sûreté ──────────────────────────────────────────────────────────────────
 * • Ne touche QUE les comptes exactement égaux à « 4411 » / « 3421 » : une ligne déjà
 *   auxiliaire est ignorée (script relançable), et 4417/3423 (effets) sont hors champ.
 * • Un tiers AMBIGU (deux fiches homonymes) ne déclenche jamais R2/R3 : on préfère
 *   laisser sur le collectif plutôt que d'imputer le mauvais compte.
 * • Le compte auxiliaire commençant par son collectif, le lettrage (préfixe « 441 »/
 *   « 342 »), la balance âgée et les postes ouverts continuent de fonctionner. Les
 *   colonnes `lettree`/`code_lettrage` ne sont pas modifiées.
 * • PostgREST n'expose pas de transaction multi-requêtes : réversibilité par
 *   `backup_realign_aux_<date>.json` (écrit AVANT la première mise à jour).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { compteTiersAuxiliaire, COMPTE_COLLECTIF, type TypeTiers } from "../src/lib/comptes-auxiliaires";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ─── Arguments ───────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (nom: string): string | undefined => {
  const hit = argv.find((a) => a === `--${nom}` || a.startsWith(`--${nom}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf("=");
  return eq === -1 ? "" : hit.slice(eq + 1).replace(/^["']|["']$/g, "");
};
const NOM_DOSSIER = flag("dossier") || null;
const APPLY = flag("apply") !== undefined;
const SANS_REGLE3 = flag("sans-regle3") !== undefined;
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

/** Majuscules sans accent ni ponctuation — pour comparer noms et libellés. */
const norm = (v: unknown) =>
  String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase().replace(/[^A-Z0-9]+/g, " ").replace(/\s+/g, " ").trim();

/** Clé de comparaison de n° de pièce : alphanumérique nu (« FA - 2026-90 » → « FA202690 »). */
const cleNumero = (v: unknown) => norm(v).replace(/\s+/g, "");
const chiffres = (v: unknown) => String(v ?? "").replace(/\D+/g, "");

/** Longueur minimale d'un nom de tiers pour autoriser la reconnaissance R3. */
const LONGUEUR_MIN_NOM = 6;

const TABLE_TIERS: Record<TypeTiers, "clients" | "fournisseurs"> = { client: "clients", fournisseur: "fournisseurs" };

interface Modif {
  id: string;
  dossier: string;
  journal: string;
  libelle: string;
  date: string;
  montant: number;
  ancien: string;
  nouveau: string;
  tiers: string;
  regle: "lien" | "piece" | "nom";
  detail: string;
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

// ─── 1. Dossiers ciblés ──────────────────────────────────────────────────────

console.log(`\n🔧 Réalignement des écritures sur les comptes auxiliaires — ${APPLY ? "MODE ÉCRITURE (--apply)" : "SIMULATION (dry-run)"}\n`);

const { data: dossiers, error: errDos } = await sb.from("dossiers").select("id,nom_societe").order("nom_societe");
if (errDos) { console.error(`❌ Lecture des dossiers impossible : ${errDos.message}`); process.exit(1); }

let cibles = dossiers ?? [];
if (NOM_DOSSIER) {
  const cible = norm(NOM_DOSSIER);
  cibles = cibles.filter((d: any) => {
    const n = norm(d.nom_societe);
    return n === cible || n.startsWith(cible) || cible.startsWith(n);
  });
  if (cibles.length === 0) {
    console.error(`❌ ARRÊT : aucun dossier nommé « ${NOM_DOSSIER} ».`);
    process.exit(1);
  }
}

// ─── 2. Analyse, dossier par dossier ─────────────────────────────────────────

const modifications: Modif[] = [];
const nonRattachees: { dossier: string; journal: string; compte: string; libelle: string; montant: number; date: string; raison: string }[] = [];

for (const dossier of cibles as any[]) {
  const [{ data: ecritures, error: errEcr }, { data: clients }, { data: fournisseurs }, { data: fcs }, { data: ffs }] =
    await Promise.all([
      sb.from("ecritures_comptables")
        .select("id,journal_code,compte_numero,libelle,debit,credit,date_ecriture,reference_piece,facture_id")
        .eq("dossier_id", dossier.id).order("date_ecriture"),
      sb.from("clients").select("id,nom,code_auxiliaire").eq("dossier_id", dossier.id),
      sb.from("fournisseurs").select("id,nom,code_auxiliaire").eq("dossier_id", dossier.id),
      sb.from("factures").select("id,numero,client_id,montant_ttc").eq("dossier_id", dossier.id),
      sb.from("factures_fournisseurs").select("id,numero,fournisseur_id,fournisseur_nom,montant_ttc").eq("dossier_id", dossier.id),
    ]);
  if (errEcr) { console.error(`❌ Lecture des écritures de ${dossier.nom_societe} : ${errEcr.message}`); process.exit(1); }

  // Lignes de tiers restées sur le COLLECTIF NU — les seules concernées.
  const lignes = (ecritures ?? []).filter((e: any) =>
    Object.values(COMPTE_COLLECTIF).includes(String(e.compte_numero ?? "").trim()));
  if (lignes.length === 0) continue;

  console.log(`── ${dossier.nom_societe} : ${lignes.length} ligne(s) encore sur un compte collectif`);

  const cliParId = new Map((clients ?? []).map((c: any) => [c.id, c]));
  const fouParId = new Map((fournisseurs ?? []).map((f: any) => [f.id, f]));
  const fcParId = new Map((fcs ?? []).map((f: any) => [f.id, f]));
  const ffParId = new Map((ffs ?? []).map((f: any) => [f.id, f]));

  /** Index nom normalisé → fiches. Plusieurs fiches ⇒ homonymes ⇒ non décidable. */
  const parNom = (liste: any[]) => {
    const m = new Map<string, any[]>();
    for (const t of liste) m.set(norm(t.nom), [...(m.get(norm(t.nom)) ?? []), t]);
    return m;
  };
  const index: Record<TypeTiers, Map<string, any[]>> = {
    client: parNom(clients ?? []),
    fournisseur: parNom(fournisseurs ?? []),
  };
  const facturesDuType: Record<TypeTiers, any[]> = { client: fcs ?? [], fournisseur: ffs ?? [] };

  for (const e of lignes as any[]) {
    const collectif = String(e.compte_numero).trim();
    const type: TypeTiers = collectif === COMPTE_COLLECTIF.client ? "client" : "fournisseur";
    const montant = Number(e.debit ?? 0) + Number(e.credit ?? 0);
    const texte = `${e.reference_piece ?? ""} ${e.libelle ?? ""}`;
    const refuser = (raison: string) => {
      nonRattachees.push({
        dossier: dossier.nom_societe, journal: e.journal_code ?? "", compte: collectif,
        libelle: String(e.libelle ?? ""), montant, date: e.date_ecriture, raison,
      });
    };

    let tiers: any = null;
    let regle: Modif["regle"] | null = null;
    let detail = "";

    // ── R1 : lien de pièce posé à l'enregistrement ──────────────────────────
    if (type === "fournisseur") {
      const ff = ffParId.get(String(e.reference_piece ?? ""));
      if (ff) {
        tiers = ff.fournisseur_id ? fouParId.get(ff.fournisseur_id) : null;
        // Facture saisie sans fiche fournisseur liée : repli sur le nom porté par la pièce.
        if (!tiers && ff.fournisseur_nom) {
          const homonymes = index.fournisseur.get(norm(ff.fournisseur_nom)) ?? [];
          if (homonymes.length === 1) tiers = homonymes[0];
        }
        if (tiers) { regle = "lien"; detail = `facture fournisseur ${ff.numero ?? ff.id.slice(0, 8)}`; }
      }
    } else if (e.facture_id) {
      const fc = fcParId.get(e.facture_id);
      if (fc?.client_id) {
        tiers = cliParId.get(fc.client_id);
        if (tiers) { regle = "lien"; detail = `facture ${fc.numero ?? fc.id.slice(0, 8)}`; }
      }
    }

    // ── R2 : n° de pièce retrouvé dans la référence ou le libellé ───────────
    if (!tiers) {
      const cleLigne = cleNumero(texte);
      const chiffresLigne = chiffres(texte);
      const exacts: any[] = [];
      const partiels: any[] = [];
      for (const f of facturesDuType[type]) {
        const cleF = cleNumero(f.numero);
        if (cleF.length >= 5 && cleLigne.includes(cleF)) { exacts.push(f); continue; }
        // Rapprochement PARTIEL (« 24-0892 » ↔ « FA-2024-0892 ») : le montant doit suivre.
        const chF = chiffres(f.numero);
        if (chF.length >= 6 && chiffresLigne.length >= 5 && chF.endsWith(chiffresLigne)
            && Math.abs(Number(f.montant_ttc ?? 0) - montant) < 0.01) partiels.push(f);
      }
      const retenus = exacts.length ? exacts : partiels;
      if (retenus.length === 1) {
        const f = retenus[0];
        tiers = type === "client"
          ? (f.client_id ? cliParId.get(f.client_id) : null)
          : (f.fournisseur_id ? fouParId.get(f.fournisseur_id) : null);
        if (tiers) {
          regle = "piece";
          detail = `n° de pièce ${f.numero}${exacts.length ? "" : " (rapprochement partiel + montant identique)"}`;
        }
      } else if (retenus.length > 1) {
        refuser(`plusieurs factures correspondent au n° de pièce`);
        continue;
      }
    }

    // ── R3 : nom du tiers contenu dans le libellé (lignes de relevé bancaire) ──
    if (!tiers && !SANS_REGLE3) {
      const libelleNorm = norm(texte);
      const candidats: any[] = [];
      let ambigu = false;
      for (const [nom, fiches] of index[type]) {
        if (nom.length < LONGUEUR_MIN_NOM || !libelleNorm.includes(nom)) continue;
        if (fiches.length > 1) { ambigu = true; break; }   // homonymes : non décidable
        candidats.push(fiches[0]);
      }
      if (ambigu) { refuser("plusieurs fiches homonymes portent ce nom"); continue; }
      if (candidats.length === 1) {
        tiers = candidats[0];
        regle = "nom";
        detail = `nom « ${tiers.nom} » reconnu dans le libellé`;
      } else if (candidats.length > 1) {
        refuser("plusieurs tiers reconnus dans le libellé");
        continue;
      }
    }

    if (!tiers || !regle) { refuser("aucun tiers identifiable (ni lien, ni n° de pièce, ni nom)"); continue; }

    const nouveau = compteTiersAuxiliaire(type, tiers.code_auxiliaire);
    if (nouveau === collectif) { refuser(`le tiers « ${tiers.nom} » n'a pas de code auxiliaire`); continue; }

    modifications.push({
      id: e.id, dossier: dossier.nom_societe, journal: e.journal_code ?? "",
      libelle: String(e.libelle ?? ""), date: e.date_ecriture, montant,
      ancien: collectif, nouveau, tiers: tiers.nom, regle, detail,
    });
  }

  for (const m of modifications.filter((m) => m.dossier === dossier.nom_societe)) {
    console.log(`   → [${m.regle.toUpperCase().padEnd(5)}] ${m.journal.padEnd(4)} ${m.ancien} → ${m.nouveau}  ${m.tiers}`);
    console.log(`      « ${m.libelle} »  ${m.montant.toFixed(2)}  (${m.detail})`);
  }
  for (const r of nonRattachees.filter((r) => r.dossier === dossier.nom_societe)) {
    console.log(`   ·  INCHANGÉ ${r.journal.padEnd(4)} ${r.compte}  « ${r.libelle} »  ${r.montant.toFixed(2)} — ${r.raison}`);
  }
  console.log("");
}

// ─── 3. Application ──────────────────────────────────────────────────────────

if (modifications.length === 0) {
  console.log("Aucune écriture à réaligner.\n");
} else if (!APPLY) {
  console.log(`🔍 SIMULATION : ${modifications.length} écriture(s) SERAIENT réimputée(s). Relance avec --apply pour écrire.\n`);
} else {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const nomFichier = `backup_realign_aux_${stamp}.json`;
  fs.writeFileSync(
    path.join(ROOT, nomFichier),
    JSON.stringify({ date: new Date().toISOString(), dossiers: cibles, modifications }, null, 2),
    "utf8",
  );
  console.log(`💾 Sauvegarde : ${nomFichier} (rejouable via --rollback=${nomFichier})\n`);

  let ok = 0;
  for (const m of modifications) {
    const { error } = await sb.from("ecritures_comptables").update({ compte_numero: m.nouveau }).eq("id", m.id);
    if (error) console.error(`   ❌ ${m.id.slice(0, 8)} ${m.ancien} → ${m.nouveau} : ${error.message}`);
    else { ok++; console.log(`   ✅ ${m.id.slice(0, 8)} ${m.ancien} → ${m.nouveau}  ${m.tiers}`); }
  }
  console.log(`\n${ok}/${modifications.length} écriture(s) mise(s) à jour en base.`);
  if (ok !== modifications.length) { console.error("⚠️  Mises à jour partielles — voir les erreurs ci-dessus.\n"); process.exit(1); }
}

// ─── 4. Bilan ────────────────────────────────────────────────────────────────

const parRegle = (r: Modif["regle"]) => modifications.filter((m) => m.regle === r).length;
console.log("─".repeat(72));
console.log(`BILAN${APPLY ? "" : "  (simulation)"}`);
console.log(`  R1 lien de pièce (déterministe) : ${parRegle("lien")}`);
console.log(`  R2 n° de pièce                  : ${parRegle("piece")}`);
console.log(`  R3 nom du tiers dans le libellé : ${parRegle("nom")}${SANS_REGLE3 ? "  (désactivée)" : ""}`);
console.log(`  Laissées sur le collectif       : ${nonRattachees.length}`);
if (nonRattachees.length) {
  const parRaison = new Map<string, number>();
  for (const r of nonRattachees) parRaison.set(r.raison, (parRaison.get(r.raison) ?? 0) + 1);
  for (const [r, n] of parRaison) console.log(`      • ${n} × ${r}`);
}
console.log("─".repeat(72) + "\n");
