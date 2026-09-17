/**
 * auditer-comptes-pcm.ts — audit PCM/CGNC de TOUS les numéros de comptes en base.
 *
 * LECTURE SEULE : aucun insert, update ni delete. Aucun `--apply`, et c'est
 * délibéré : ce script CONSTATE ; corriger un compte historique relève d'un
 * arbitrage d'expert-comptable, puis d'un script de reprise dédié.
 *
 * Il répond, pour chaque dossier, à quatre questions :
 *   1. Chaque compte mouvementé est-il recevable (`validatePcmAccount`) ?
 *   2. Chaque compte est-il dans son RÔLE selon le journal (VTE : client /
 *      produit / TVA en attente ; ACH : charge / TVA / fournisseur ; BQ/CAI :
 *      une ligne de trésorerie par pièce) ?
 *   3. Débit = crédit — par dossier, par journal, par pièce ?
 *   4. Les référentiels et colonnes « compte » hors grand livre
 *      (`pcm_reference`, `comptes_comptables`, transactions, justificatifs,
 *      mémoire des tiers) portent-ils des comptes irrecevables ?
 *
 *   node --import tsx scripts/auditer-comptes-pcm.ts [--dossier=SMERT] [--json]
 *
 * Code de sortie : 0 conforme · 1 au moins une erreur · 2 audit impossible.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { validatePcmAccount, RACINES_PCM, PCM, type UsageCompte } from "../src/lib/pcm-referentiel";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (nom: string) => {
  const hit = argv.find((a) => a === `--${nom}` || a.startsWith(`--${nom}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf("=");
  return eq === -1 ? "" : hit.slice(eq + 1).replace(/^["']|["']$/g, "");
};
const CIBLE = flag("dossier") || null;
const JSON_OUT = flag("json") !== undefined;
const say = (...a: unknown[]) => { if (!JSON_OUT) console.log(...a); };

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env"), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
) as Record<string, string>;

// Proxy TLS d'entreprise : repli undici (cf. auditer-conformite-comptable.ts).
let DIRECT = false;
async function proxyFetch(input: any, init?: any): Promise<any> {
  const direct = async () => {
    const { fetch: uf, Agent } = await import("undici");
    return uf(String(input), { ...init, dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) } as any);
  };
  if (DIRECT) return direct();
  try { return await fetch(String(input), init); } catch { DIRECT = true; return direct(); }
}
const sb = createClient(env.SUPABASE_URL || env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  global: { fetch: proxyFetch as any }, auth: { persistSession: false, autoRefreshToken: false },
});

const txt = (v: unknown) => String(v ?? "").trim();
const nb = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const r2 = (x: number) => Math.round(x * 100) / 100;

async function tout(table: string, select: string, filtre?: (q: any) => any): Promise<{ rows: any[]; erreur?: string }> {
  let rows: any[] = [], de = 0;
  for (;;) {
    let q: any = sb.from(table).select(select).range(de, de + 999);
    if (filtre) q = filtre(q);
    const { data, error } = await q;
    if (error) return { rows, erreur: error.message };
    rows = rows.concat(data ?? []);
    if ((data ?? []).length < 1000) break;
    de += 1000;
  }
  return { rows };
}

type Niveau = "erreur" | "avertissement";
interface Constat { niveau: Niveau; code: string; message: string; exemples?: string[] }

/** Rôles admis par journal et par sens. `null` = pas de contrainte de rôle. */
function rolesAdmis(journal: string, sens: "D" | "C"): UsageCompte[] | null {
  switch (journal) {
    case "VTE": return sens === "D" ? ["client"] : ["produit", "tva_attente_vente", "acompte_client"];
    case "VTE-AVR": return sens === "D" ? ["produit", "tva_attente_vente", "acompte_client"] : ["client"];
    case "ACH": return sens === "D" ? ["charge", "tva_attente_achat"] : ["fournisseur"];
    case "ACH-AVR": return sens === "D" ? ["fournisseur"] : ["charge", "tva_attente_achat"];
    default: return null;
  }
}
const dansUnRole = (compte: string, roles: UsageCompte[]) =>
  roles.some((usage) => validatePcmAccount(compte, { usage }).ok);

function auditerDossier(lignes: any[]): Constat[] {
  const out: Constat[] = [];

  // 1. Recevabilité
  const irrecevables = new Map<string, { n: number; erreur: string }>();
  const aValider = new Map<string, { n: number; note: string }>();
  for (const l of lignes) {
    const c = txt(l.compte_numero);
    const v = validatePcmAccount(c);
    if (!v.ok) {
      const cell = irrecevables.get(c) ?? { n: 0, erreur: v.erreurs.join(" ") };
      cell.n++; irrecevables.set(c, cell);
    } else if (v.avertissements.length) {
      const cell = aValider.get(c) ?? { n: 0, note: v.avertissements[0] };
      cell.n++; aValider.set(c, cell);
    }
  }
  if (irrecevables.size) out.push({
    niveau: "erreur", code: "COMPTE_IRRECEVABLE",
    message: `${irrecevables.size} compte(s) hors référentiel PCM mouvementé(s).`,
    exemples: [...irrecevables].map(([c, v]) => `${c || "(vide)"} ×${v.n} — ${v.erreur}`),
  });
  if (aValider.size) out.push({
    niveau: "avertissement", code: "COMPTE_A_VALIDER",
    message: `${aValider.size} compte(s) dont la conformité CGNC est à valider.`,
    exemples: [...aValider].map(([c, v]) => `${c} ×${v.n} — ${v.note.slice(0, 160)}`),
  });

  // 2. Rôle selon le journal
  const horsRole: string[] = [];
  for (const l of lignes) {
    const j = txt(l.journal_code).toUpperCase();
    const sens = nb(l.debit) > 0.005 ? "D" : nb(l.credit) > 0.005 ? "C" : null;
    if (!sens) continue;
    const roles = rolesAdmis(j, sens);
    if (roles && !dansUnRole(txt(l.compte_numero), roles)) {
      horsRole.push(`${txt(l.date_ecriture).slice(0, 10)} ${j} ${sens} ${txt(l.compte_numero)} `
        + `${r2(nb(l.debit) + nb(l.credit))} « ${txt(l.libelle).slice(0, 50)} » (attendu : ${roles.join(" / ")})`);
    }
  }
  if (horsRole.length) out.push({
    niveau: "avertissement", code: "COMPTE_HORS_ROLE",
    message: `${horsRole.length} ligne(s) dont le compte ne correspond pas au rôle attendu dans son journal.`,
    exemples: horsRole.slice(0, 12),
  });

  // Pièces de trésorerie sans compte de trésorerie
  const pieces = new Map<string, any[]>();
  for (const l of lignes) {
    const k = `${txt(l.journal_code)}|${txt(l.reference_piece)}|${txt(l.date_ecriture).slice(0, 10)}`;
    if (!pieces.has(k)) pieces.set(k, []);
    pieces.get(k)!.push(l);
  }
  const tresoSansCompte: string[] = [];
  for (const [k, p] of pieces) {
    const j = k.split("|")[0].toUpperCase();
    if (j !== "BQ" && j !== "CAI") continue;
    const racine = j === "CAI" ? RACINES_PCM.CAISSE : RACINES_PCM.BANQUE;
    if (!p.some((l) => txt(l.compte_numero).startsWith(racine))) tresoSansCompte.push(k);
  }
  if (tresoSansCompte.length) out.push({
    niveau: "avertissement", code: "TRESORERIE_SANS_COMPTE",
    message: `${tresoSansCompte.length} pièce(s) BQ/CAI sans ligne sur ${RACINES_PCM.BANQUE}x/${RACINES_PCM.CAISSE}x (ou journal/compte croisés).`,
    exemples: tresoSansCompte.slice(0, 8),
  });

  // 3. Débit = crédit
  const d = r2(lignes.reduce((s, l) => s + nb(l.debit), 0));
  const c = r2(lignes.reduce((s, l) => s + nb(l.credit), 0));
  if (Math.abs(d - c) > 0.005) out.push({
    niveau: "erreur", code: "DOSSIER_DESEQUILIBRE", message: `Σ débits ${d} ≠ Σ crédits ${c} (écart ${r2(d - c)}).`,
  });
  const parJournal = new Map<string, number>();
  for (const l of lignes) parJournal.set(txt(l.journal_code), (parJournal.get(txt(l.journal_code)) ?? 0) + nb(l.debit) - nb(l.credit));
  const journauxKo = [...parJournal].filter(([, e]) => Math.abs(e) > 0.005);
  if (journauxKo.length) out.push({
    niveau: "erreur", code: "JOURNAL_DESEQUILIBRE", message: `${journauxKo.length} journal(aux) déséquilibré(s).`,
    exemples: journauxKo.map(([j, e]) => `${j} : ${r2(e)}`),
  });
  const piecesKo = [...pieces].map(([k, p]) => [k, r2(p.reduce((s, l) => s + nb(l.debit) - nb(l.credit), 0))] as const)
    .filter(([, e]) => Math.abs(e) > 0.005);
  if (piecesKo.length) out.push({
    niveau: "erreur", code: "PIECE_DESEQUILIBREE", message: `${piecesKo.length} pièce(s) déséquilibrée(s).`,
    exemples: piecesKo.slice(0, 8).map(([k, e]) => `${k} : ${e}`),
  });

  return out;
}

async function main(): Promise<number> {
  let q: any = sb.from("dossiers").select("id,nom_societe,compte_caisse,compte_banque");
  if (CIBLE) q = /^[0-9a-f-]{36}$/i.test(CIBLE) ? q.eq("id", CIBLE) : q.ilike("nom_societe", `%${CIBLE}%`);
  const { data: dossiers, error } = await q.order("nom_societe");
  if (error) { console.error(`❌ dossiers : ${error.message}`); return 2; }

  const rapport: any = { date: new Date().toISOString(), dossiers: [], referentiels: [] };
  let erreurs = 0;

  say(`\n🔎 AUDIT PCM DES COMPTES — ${(dossiers ?? []).length} dossier(s) — lecture seule\n`);
  for (const dos of dossiers ?? []) {
    const { rows, erreur } = await tout("ecritures_comptables",
      "journal_code,compte_numero,date_ecriture,debit,credit,reference_piece,libelle", (x) => x.eq("dossier_id", dos.id));
    if (erreur) { console.error(`❌ ${dos.nom_societe} : ${erreur}`); return 2; }
    const constats = auditerDossier(rows);
    for (const col of ["compte_caisse", "compte_banque"] as const) {
      const val = txt(dos[col]);
      if (!val) continue;
      const usage: UsageCompte = col === "compte_caisse" ? "caisse" : "banque";
      const v = validatePcmAccount(val, { usage });
      if (!v.ok) constats.push({ niveau: "erreur", code: "PARAMETRE_TRESORERIE", message: `dossiers.${col} = ${val} : ${v.erreurs.join(" ")}` });
    }
    erreurs += constats.filter((k) => k.niveau === "erreur").length;
    rapport.dossiers.push({ dossier: dos.nom_societe, nbEcritures: rows.length, constats });

    const nbE = constats.filter((k) => k.niveau === "erreur").length;
    const nbA = constats.length - nbE;
    say(`${nbE ? "❌" : nbA ? "⚠️ " : "✅"} ${dos.nom_societe} — ${rows.length} écriture(s)${constats.length ? ` · ${nbE} erreur(s), ${nbA} avertissement(s)` : ""}`);
    for (const k of constats) {
      say(`     ${k.niveau === "erreur" ? "❌" : "⚠️ "} [${k.code}] ${k.message}`);
      for (const e of k.exemples ?? []) say(`          · ${e}`);
    }
  }

  // 4. Référentiels et colonnes « compte » hors grand livre
  const sources: [string, string, string][] = [
    ["pcm_reference", "numero", "numero,intitule"],
    ["comptes_comptables", "numero", "numero,intitule"],
    ["transactions_bancaires", "compte_comptable", "compte_comptable,categorie"],
    ["justificatifs", "compte_pcm", "compte_pcm,categorie_pcm"],
    ["tiers_memoire", "compte_pcm", "compte_pcm"],
    ["fournisseurs", "compte_charge_defaut", "compte_charge_defaut"],
    ["clients", "compte_produit_defaut", "compte_produit_defaut"],
  ];
  say(`\n── Référentiels et colonnes « compte » hors grand livre ──`);
  for (const [table, col, select] of sources) {
    const { rows, erreur } = await tout(table, select);
    if (erreur) { say(`   ·  ${table}.${col} : non lu (${erreur})`); rapport.referentiels.push({ table, col, erreur }); continue; }
    const distincts = new Map<string, { n: number; info: string }>();
    for (const r of rows) {
      const v = txt(r[col]);
      if (!v) continue;
      const cell = distincts.get(v) ?? { n: 0, info: txt(r.intitule ?? r.categorie ?? r.categorie_pcm) };
      cell.n++; distincts.set(v, cell);
    }
    const ko = [...distincts].filter(([v]) => !validatePcmAccount(v).ok);
    const av = [...distincts].filter(([v]) => { const x = validatePcmAccount(v); return x.ok && x.avertissements.length; });
    erreurs += ko.length ? 1 : 0;
    rapport.referentiels.push({ table, col, distincts: distincts.size, irrecevables: ko.map(([v, x]) => ({ compte: v, ...x })), aValider: av.map(([v]) => v) });
    say(`   ${ko.length ? "❌" : "✅"} ${table}.${col} — ${distincts.size} valeur(s) distincte(s)`
      + `${ko.length ? `, ${ko.length} irrecevable(s) : ${ko.map(([v, x]) => `${v}${x.info ? ` (${x.info})` : ""}`).join(", ")}` : ""}`
      + `${av.length ? ` · à valider : ${av.map(([v]) => v).join(", ")}` : ""}`);
  }

  // Imputations du code confrontées à l'intitulé du référentiel en base
  const { rows: ref } = await tout("pcm_reference", "numero,intitule");
  const intitule = new Map(ref.map((r) => [txt(r.numero), txt(r.intitule)]));
  say(`\n── Comptes nommés par le code, lus dans pcm_reference ──`);
  for (const [nom, compte] of Object.entries(PCM)) {
    const court = compte.replace(/0+$/, "").padEnd(4, "0");
    say(`   ${intitule.has(court) || intitule.has(compte) ? "·" : "?"} ${nom.padEnd(34)} ${compte.padEnd(9)} ${intitule.get(court) ?? intitule.get(compte) ?? "(absent de pcm_reference)"}`);
  }

  if (JSON_OUT) console.log(JSON.stringify(rapport, null, 2));
  say(`\n${erreurs ? `❌ ${erreurs} erreur(s)` : "✅ aucune erreur"} — lecture seule, rien n'a été modifié.`);
  return erreurs ? 1 : 0;
}

try {
  process.exit(await main());
} catch (e: any) {
  console.error(`❌ L'audit a échoué : ${e?.message ?? e}`);
  process.exit(2);
}
