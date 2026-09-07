/**
 * requalifier-acompte-en-vente.ts — Transforme une facture d'ACOMPTE en vente
 * DÉFINITIVE : la pièce change de type ET son écriture change de compte.
 *
 * ─── Pourquoi les deux ensemble ──────────────────────────────────────────────
 * L'application porte l'information à DEUX endroits, et ils doivent bouger d'un
 * seul mouvement :
 *
 *   • `ecritures_comptables` — le crédit du 4191 « Clients, avances et acomptes
 *     reçus », compte de PASSIF, doit devenir un crédit de classe 7 ;
 *   • `factures.type` — le tableau de bord ne calcule PAS son CA depuis le grand
 *     livre. Il le calcule sur les factures, avec un filtre explicite
 *     `type !== "acompte"` (cf. dashboard, « CA HT facturé »).
 *
 * Ne corriger que l'écriture laisse le KPI inchangé et fabrique une incohérence
 * de plus : un grand livre qui constate le produit, un tableau de bord qui
 * l'ignore. Ne corriger que le type laisse 42 000 MAD de dette fictive au bilan.
 *
 * ─── Ce que cela signifie comptablement ──────────────────────────────────────
 * Un acompte n'est pas un produit : c'est une dette envers le client tant que la
 * livraison n'a pas eu lieu, soldée par la facture de solde qui impute
 * l'avance (D 4191 / C 7xxx). Requalifier revient donc à AFFIRMER que la pièce
 * est une vente définitive et qu'aucune facture de solde ne suivra.
 *
 * Le script REFUSE d'agir si cette affirmation est contredite en base :
 *   • une facture de solde pointe sur elle (`facture_parent_id`) ;
 *   • la ligne 4191 est LETTRÉE (elle a déjà été imputée) ;
 *   • le grand livre de la pièce ne se solde pas à zéro après l'opération.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   node --import tsx scripts/requalifier-acompte-en-vente.ts --facture="FA 0005"
 *   node --import tsx scripts/requalifier-acompte-en-vente.ts --facture="FA 0005" --apply
 *   node --import tsx scripts/requalifier-acompte-en-vente.ts --facture="FA 0005" --compte=7124 --apply
 *   node --import tsx scripts/requalifier-acompte-en-vente.ts --rollback=backup_requalif_XXX.json
 *
 * Sans --apply, RIEN n'est écrit.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { compteVente } from "../src/lib/compte-vente";
import { COMPTE_ACOMPTES_CLIENTS } from "../src/lib/ecritures-vente";

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
}) as any;

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const val = (n: string) => {
  const a = args.find((x) => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3).replace(/^["']|["']$/g, "") : null;
};
const NUMERO = val("facture");
const COMPTE_FORCE = val("compte");
const ROLLBACK = val("rollback");

const fmt = (x: number) => Number(x).toLocaleString("fr-MA", { minimumFractionDigits: 2 });
const r2 = (x: number) => Math.round(x * 100) / 100;
const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

interface Backup {
  genere: string;
  facture: { id: string; numero: string | null; type: string | null } | null;
  ecritures: { id: string; compte_numero: string; libelle: string }[];
}

// ─── Rollback ────────────────────────────────────────────────────────────────
if (ROLLBACK) {
  const chemin = path.isAbsolute(ROLLBACK) ? ROLLBACK : path.join(RACINE, ROLLBACK);
  const b = JSON.parse(fs.readFileSync(chemin, "utf8")) as Backup;
  console.log(`\n↩️  ROLLBACK depuis ${path.basename(chemin)} (généré le ${b.genere})`);
  for (const e of b.ecritures ?? []) {
    const { error } = await sb.from("ecritures_comptables")
      .update({ compte_numero: e.compte_numero, libelle: e.libelle }).eq("id", e.id);
    console.log(error ? `   ❌ ${e.id} : ${error.message}` : `   ✅ ${e.id} → ${e.compte_numero}`);
  }
  if (b.facture) {
    const { error } = await sb.from("factures").update({ type: b.facture.type }).eq("id", b.facture.id);
    console.log(error ? `   ❌ facture : ${error.message}` : `   ✅ ${b.facture.numero} → type « ${b.facture.type} »`);
  }
  console.log("");
  process.exit(0);
}

if (!NUMERO) {
  console.error("❌ --facture=\"<numéro>\" est obligatoire.");
  process.exit(2);
}

// ─── Chargement ──────────────────────────────────────────────────────────────
const { data: f, error: eF } = await sb.from("factures").select("*").eq("numero", NUMERO).maybeSingle();
if (eF || !f) { console.error(`❌ Facture « ${NUMERO} » introuvable : ${eF?.message ?? "aucune ligne"}`); process.exit(1); }

const [{ data: dos }, { data: cli }, { data: ecr }] = await Promise.all([
  sb.from("dossiers").select("nom_societe,secteur_activite").eq("id", f.dossier_id).maybeSingle(),
  f.client_id ? sb.from("clients").select("nom,compte_produit_defaut").eq("id", f.client_id).maybeSingle() : Promise.resolve({ data: null }),
  sb.from("ecritures_comptables").select("*").eq("dossier_id", f.dossier_id)
    .or(`facture_id.eq.${f.id},reference_piece.eq.${f.numero}`),
]);
const lignes = (ecr ?? []) as any[];

console.log(`\n═══ REQUALIFICATION ACOMPTE → VENTE ═══  ${APPLY ? "MODE ÉCRITURE" : "DRY-RUN (aucune écriture)"}`);
console.log(`    ${dos?.nom_societe} · ${f.numero} · ${f.date_facture}`);
console.log(`    type actuel « ${f.type} » · HT ${fmt(n(f.montant_ht))} · TVA ${fmt(n(f.montant_tva))} · TTC ${fmt(n(f.montant_ttc))}`);
console.log(`    client ${cli?.nom ?? "—"}`);

// ─── Garde-fous ──────────────────────────────────────────────────────────────
const refus: string[] = [];
if (String(f.type ?? "").toLowerCase() !== "acompte") {
  refus.push(`la facture n'est pas un acompte (type « ${f.type} ») — rien à requalifier.`);
}

const { data: soldes } = await sb.from("factures").select("id,numero").eq("facture_parent_id", f.id);
if ((soldes ?? []).length) {
  refus.push(`une facture de solde s'appuie sur cet acompte (${(soldes as any[]).map((x) => x.numero).join(", ")}) : `
    + "la requalifier compterait le produit DEUX FOIS.");
}

const lignes4191 = lignes.filter(
  (l) => String(l.compte_numero ?? "").startsWith(COMPTE_ACOMPTES_CLIENTS) && n(l.credit) > 0.005);
if (!lignes4191.length) refus.push(`aucun crédit du compte ${COMPTE_ACOMPTES_CLIENTS} rattaché à cette facture.`);
if (lignes4191.some((l) => String(l.lettrage_code ?? "").trim())) {
  refus.push("la ligne 4191 est LETTRÉE : l'avance a déjà été imputée, la requalifier casserait le lettrage.");
}
const debits4191 = lignes.filter(
  (l) => String(l.compte_numero ?? "").startsWith(COMPTE_ACOMPTES_CLIENTS) && n(l.debit) > 0.005);
if (debits4191.length) {
  refus.push("un DÉBIT du 4191 existe déjà sur cette pièce (imputation d'acompte) : structure à arbitrer à la main.");
}

if (refus.length) {
  console.log("\n❌ Opération refusée :");
  for (const r of refus) console.log(`   • ${r}`);
  console.log("");
  process.exit(1);
}

// ─── Compte de produit ───────────────────────────────────────────────────────
// Même ordre de décision que `generateFactureXml` : l'arbitrage explicite de
// l'utilisateur d'abord, la déduction ensuite. `--compte` passe avant tout.
const deduit = compteVente({
  nature: (f as any).nature_vente ?? null,
  designations: (((f as any).lignes ?? []) as any[]).map((l) => l?.designation ?? l?.description),
  secteur: dos?.secteur_activite ?? null,
});
const compteCible = COMPTE_FORCE
  ?? (String(cli?.compte_produit_defaut ?? "").trim() || deduit.compte);
const origineCompte = COMPTE_FORCE
  ? "imposé en ligne de commande (--compte)"
  : String(cli?.compte_produit_defaut ?? "").trim()
    ? "compte de produit par défaut de la fiche client"
    : `déduit par compteVente (règle « ${deduit.regle} »)`;

console.log(`\n    compte de produit retenu : ${compteCible}  — ${origineCompte}`);

// ─── Plan ────────────────────────────────────────────────────────────────────
const ref = String(f.numero ?? f.id);
/** Libellés d'acompte remplacés : les laisser rendrait la pièce illisible en révision. */
const nouveauLibelle = (l: any): string => {
  const s = String(l.libelle ?? "");
  if (String(l.compte_numero).startsWith(COMPTE_ACOMPTES_CLIENTS)) return `Vente ${ref}`;
  if (/^TVA acompte/i.test(s)) return s.replace(/^TVA acompte/i, "TVA collectée");
  if (/^Acompte\b/i.test(s)) return s.replace(/^Acompte\b/i, "Vente");
  return s;
};
const aModifier = lignes.filter((l) => {
  const changeCompte = String(l.compte_numero ?? "").startsWith(COMPTE_ACOMPTES_CLIENTS) && n(l.credit) > 0.005;
  return changeCompte || nouveauLibelle(l) !== String(l.libelle ?? "");
});

console.log("\n    Écritures :");
for (const l of lignes) {
  const cible = String(l.compte_numero ?? "").startsWith(COMPTE_ACOMPTES_CLIENTS) && n(l.credit) > 0.005
    ? compteCible : String(l.compte_numero);
  const chg = cible !== String(l.compte_numero) || nouveauLibelle(l) !== String(l.libelle ?? "");
  console.log(`      ${chg ? "→" : " "} ${l.journal_code} ${String(l.compte_numero).padEnd(10)}`
    + ` D=${fmt(n(l.debit))} C=${fmt(n(l.credit))} | ${l.libelle}`
    + (chg ? `\n           devient  ${String(cible).padEnd(10)} | ${nouveauLibelle(l)}` : ""));
}

// Partie double : la reclassification ne touche NI les montants NI les sens,
// l'équilibre est donc conservé par construction — on le vérifie tout de même,
// c'est le genre d'évidence qui cesse d'en être une un jour.
const ecart = r2(lignes.reduce((s, l) => s + n(l.debit) - n(l.credit), 0));
console.log(`\n    Partie double de la pièce : écart ${fmt(ecart)} MAD ${Math.abs(ecart) <= 0.005 ? "✅" : "❌"}`);
if (Math.abs(ecart) > 0.005) { console.log("    ❌ pièce déséquilibrée — on ne touche à rien.\n"); process.exit(1); }

console.log(`\n    Facture : type « ${f.type} » → « facture »`);

if (!APPLY) {
  console.log("\n  Rien n'a été écrit. Relancer avec --apply pour appliquer.\n");
  process.exit(0);
}

// ─── Application ─────────────────────────────────────────────────────────────
// PostgREST valide (COMMIT) chaque requête indépendamment : il n'y a pas de
// transaction couvrant les deux tables. On applique donc les écritures d'abord,
// la facture ensuite, et on RESTAURE les écritures si la facture échoue — la
// seule façon honnête d'approcher l'atomicité sans fonction SQL dédiée.
const backup: Backup = {
  genere: new Date().toISOString(),
  facture: { id: f.id, numero: f.numero, type: f.type },
  ecritures: aModifier.map((l) => ({
    id: String(l.id), compte_numero: String(l.compte_numero), libelle: String(l.libelle ?? ""),
  })),
};
const nomBackup = `backup_requalif_${String(f.numero).replace(/[^\w-]/g, "_")}_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
fs.writeFileSync(path.join(RACINE, nomBackup), JSON.stringify(backup, null, 2), "utf8");
console.log(`\n💾 Backup écrit AVANT toute modification : ${nomBackup}`);

const restaurerEcritures = async () => {
  for (const e of backup.ecritures) {
    await sb.from("ecritures_comptables")
      .update({ compte_numero: e.compte_numero, libelle: e.libelle }).eq("id", e.id);
  }
};

console.log("\n▶ Écritures…");
for (const l of aModifier) {
  const cible = String(l.compte_numero ?? "").startsWith(COMPTE_ACOMPTES_CLIENTS) && n(l.credit) > 0.005
    ? compteCible : String(l.compte_numero);
  const { error } = await sb.from("ecritures_comptables")
    .update({ compte_numero: cible, libelle: nouveauLibelle(l) }).eq("id", l.id);
  if (error) {
    console.log(`   ❌ ${l.id} : ${error.message} — restauration…`);
    await restaurerEcritures();
    console.log("   ↩️  écritures restaurées, facture non modifiée.\n");
    process.exit(1);
  }
  console.log(`   ✅ ${l.id} → ${cible}`);
}

console.log("▶ Facture…");
const { error: eMaj } = await sb.from("factures").update({ type: "facture" }).eq("id", f.id);
if (eMaj) {
  console.log(`   ❌ ${eMaj.message} — restauration des écritures…`);
  await restaurerEcritures();
  console.log("   ↩️  état initial rétabli.\n");
  process.exit(1);
}
console.log("   ✅ type = « facture »");

// ─── Vérification : on RELIT la base, on ne se fie pas au code retour ────────
console.log("\n═══ VÉRIFICATION (relecture depuis la base) ═══");
const [{ data: fApres }, { data: ecrApres }] = await Promise.all([
  sb.from("factures").select("numero,type,statut,montant_ht,date_facture").eq("id", f.id).maybeSingle(),
  sb.from("ecritures_comptables").select("journal_code,compte_numero,debit,credit,libelle")
    .eq("dossier_id", f.dossier_id).or(`facture_id.eq.${f.id},reference_piece.eq.${f.numero}`),
]);
console.log(`  facture : ${fApres?.numero} · type « ${fApres?.type} » · statut ${fApres?.statut}`);
for (const l of (ecrApres ?? []) as any[]) {
  console.log(`  ${l.journal_code} ${String(l.compte_numero).padEnd(10)} D=${fmt(n(l.debit))} C=${fmt(n(l.credit))} | ${l.libelle}`);
}
const reste4191 = ((ecrApres ?? []) as any[]).some((l) => String(l.compte_numero).startsWith(COMPTE_ACOMPTES_CLIENTS));
const aProduit = ((ecrApres ?? []) as any[]).some((l) => String(l.compte_numero).startsWith("7") && n(l.credit) > 0.005);
console.log(`\n  ${reste4191 ? "❌" : "✅"} plus aucune ligne ${COMPTE_ACOMPTES_CLIENTS} sur la pièce`);
console.log(`  ${aProduit ? "✅" : "❌"} le produit de classe 7 est crédité`);
console.log(`  ${fApres?.type === "facture" ? "✅" : "❌"} la facture n'est plus un acompte`);

// ─── CA HT recalculé exactement comme le tableau de bord ─────────────────────
const { data: toutes } = await sb.from("factures")
  .select("numero,type,statut,montant_ht,date_facture").eq("dossier_id", f.dossier_id);
const annee = String(f.date_facture ?? "").slice(0, 4);
const caHt = ((toutes ?? []) as any[])
  .filter((x) => x.statut === "conforme" && x.type !== "acompte"
    && String(x.date_facture ?? "").slice(0, 4) === annee)
  .reduce((s, x) => s + n(x.montant_ht), 0);
const credits7 = ((await sb.from("ecritures_comptables")
  .select("compte_numero,debit,credit,date_ecriture").eq("dossier_id", f.dossier_id)
  .like("compte_numero", "7%")
  .gte("date_ecriture", `${annee}-01-01`).lte("date_ecriture", `${annee}-12-31`)).data ?? [])
  .reduce((s: number, l: any) => s + n(l.credit) - n(l.debit), 0);

console.log(`\n  CA HT facturé ${annee} (règle du tableau de bord) : ${fmt(caHt)} MAD`);
console.log(`  Crédits de classe 7 ${annee} au grand livre      : ${fmt(r2(credits7))} MAD`);
console.log(`  ${Math.abs(r2(caHt - credits7)) <= 0.005 ? "✅ les deux concordent" : `❌ écart ${fmt(r2(caHt - credits7))}`}`);
console.log(`\n  Rollback si besoin : --rollback=${nomBackup}\n`);
