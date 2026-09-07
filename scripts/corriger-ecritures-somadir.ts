/**
 * corriger-ecritures-somadir.ts — reprise ciblée du dossier SOMADIR S.A.
 *
 * Trois écritures fausses, saisies à la main (aucun script de seed ne les
 * produit : leurs libellés n'existent nulle part dans le code). Elles ne se
 * voyaient pas parce que la partie double restait équilibrée — une écriture
 * inversée reste équilibrée, elle est juste fausse dans les deux sens.
 *
 * ─── C1 · Le règlement ATLAS PACKAGING était inversé ─────────────────────────
 *     2026-05-04  CAI  51610000  D 20 160,00      la caisse AUGMENTE en payant
 *     2026-05-04  CAI  44110000  C 20 160,00      et la dette AUGMENTE aussi
 *
 * Payer un fournisseur, c'est D 4411x (la dette s'éteint) / C 5161 (l'argent
 * sort). Ici les deux sens sont retournés. Et le compte est le COLLECTIF alors
 * que l'achat avait été imputé sur l'auxiliaire 44110001 : le fournisseur
 * affichait donc 40 320,00 de dette — deux fois la facture — au lieu de zéro.
 * Le collectif portait le règlement, l'auxiliaire portait la dette, et les deux
 * ne se rencontraient jamais.
 *
 * ─── C2 · La TVA déductible ATLAS n'a jamais été basculée ────────────────────
 * Sous le régime des encaissements, la déduction naît du DÉCAISSEMENT. Le
 * 34580000 a bien été débité à la facture (2024-11-15) mais aucune OD ne l'a
 * jamais soldé : la bascule 3458 → 34552 manque.
 *
 * Deux pièces ont pourtant bougé la TVA déductible, et aucune n'était le bon
 * geste :
 *   • DECL-TVA-2024-11 (2024-11-30) a DÉCLARÉ 3 360,00 de déduction que rien
 *     n'avait rendue déductible — l'anticipation ;
 *   • REGUL-TVA-2024-11 (2026-08-28) l'a reprise hors flux.
 *
 * Les deux se neutralisent exactement sur 34552 et sur 4456. Les retirer est
 * donc NEUTRE sur le solde de TVA due, et laisse la place au seul geste juste :
 * la bascule, à la date du décaissement réel (2026-05-04, celui de C1).
 *
 * ─── C3 · La TVA collectée FA-2024-0892 était déclarée deux ans trop tôt ─────
 * Contrairement à C2, la bascule EXISTE et elle est bien datée :
 *     2026-05-06  OD  44580000 D 578,00 / 44551000 C 578,00
 * — exactement l'encaissement en caisse du même jour. Rien à déplacer.
 *
 * Ce qui est prématuré, c'est DECL-TVA-2024-05 (2024-05-31), qui déclare ces
 * 578,00 deux ans avant que l'argent n'arrive. On la retire, par symétrie avec
 * C2 : l'exigibilité ne repose plus que sur la bascule, à déclarer en 2026-05.
 *
 * ─── Ce que le script NE fait pas, et pourquoi ───────────────────────────────
 * Après C1, la caisse 51610000 tombe à −5 412,00 : créditrice, donc impossible.
 * Le script le DIT et n'y touche pas. Le négatif révèle un manque en amont —
 * solde d'ouverture jamais saisi, ou encaissements absents. Poser une écriture
 * d'ouverture pour le masquer fabriquerait exactement la « trésorerie fictive »
 * que le projet traque : un mouvement d'argent sans pièce justificative.
 *
 * Supprimer une pièce `DECL-TVA-` va par ailleurs à l'encontre de la doctrine
 * ordinaire (« une déclaration déposée ne se réécrit pas, elle se régularise »,
 * cf. mémoire regularisation-tva-hors-flux). C'est un choix ASSUMÉ, pris parce
 * que ces déclarations relèvent de données de reprise et non d'un dépôt réel.
 * Sur un dossier réellement télédéclaré, employer `regulariser-tva-anticipee`.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   node --import tsx scripts/corriger-ecritures-somadir.ts
 *   node --import tsx scripts/corriger-ecritures-somadir.ts --apply
 *   node --import tsx scripts/corriger-ecritures-somadir.ts --rollback=backup_....json
 *
 * DRY-RUN par défaut. Chaque correction est IDEMPOTENTE : relancer un script
 * déjà passé ne fait rien et le dit.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { insererPiece } from "../src/server/lettrage-compta.functions";
import { normaliserNumeroCompte } from "../src/lib/numero-compte";
import { synthetiserBalance, type LigneBalance } from "../src/lib/balance-comptable";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const flag = (nom: string) => {
  const hit = argv.find((a) => a === `--${nom}` || a.startsWith(`--${nom}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf("=");
  return eq === -1 ? "" : hit.slice(eq + 1).replace(/^["']|["']$/g, "");
};
const APPLY = flag("apply") !== undefined;
const ROLLBACK = flag("rollback") || null;

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
  try { return await fetch(String(input), init); }
  catch { PROXY_DIRECT = true; return direct(); }
}
const sb = createClient(env.SUPABASE_URL || env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  global: { fetch: proxyFetch as any }, auth: { persistSession: false, autoRefreshToken: false },
});

const nb = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const txt = (v: unknown) => String(v ?? "").trim();
const jour = (l: any) => txt(l.date_ecriture).slice(0, 10);
const r2 = (x: number) => Math.round(x * 100) / 100;
const fmt = (x: number) => x.toLocaleString("fr-MA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const COLONNES = "id,compte_numero,journal_code,date_ecriture,debit,credit,reference_piece,libelle,lettrage_code,facture_id,valide,dossier_id";

async function lireGrandLivre(dossierId: string): Promise<any[]> {
  let tout: any[] = [], de = 0;
  for (;;) {
    const { data, error } = await sb.from("ecritures_comptables")
      .select(COLONNES).eq("dossier_id", dossierId).range(de, de + 999);
    if (error) throw new Error(error.message);
    tout = tout.concat(data ?? []);
    if ((data ?? []).length < 1000) break;
    de += 1000;
  }
  return tout;
}

// ─── Rollback ───────────────────────────────────────────────────────────────
if (ROLLBACK) {
  const sauv = JSON.parse(fs.readFileSync(path.join(ROOT, ROLLBACK), "utf8"));
  console.log(`\n⏪ ROLLBACK depuis ${ROLLBACK}\n`);

  if (sauv.creees?.length) {
    const { error, count } = await sb.from("ecritures_comptables")
      .delete({ count: "exact" }).in("id", sauv.creees);
    console.log(error ? `   ❌ ${error.message}` : `   ✅ ${count ?? 0} ligne(s) créée(s) retirée(s)`);
  }
  if (sauv.supprimees?.length) {
    // Réinsertion AVEC leur id d'origine : tout ce qui les référençait ailleurs
    // (lettrage, rapprochement) retrouve la même ligne, pas une copie.
    const { error } = await sb.from("ecritures_comptables").insert(sauv.supprimees);
    console.log(error ? `   ❌ restauration : ${error.message}` : `   ✅ ${sauv.supprimees.length} ligne(s) restaurée(s)`);
    if (error) process.exit(1);
  }
  console.log("");
  process.exit(0);
}

console.log(`\n${APPLY ? "🔧 APPLICATION" : "🔍 SIMULATION (dry-run)"} — reprise des écritures SOMADIR\n`);

const { data: dossiers, error: eDos } = await sb.from("dossiers")
  .select("id,nom_societe").ilike("nom_societe", "%SOMADIR%");
if (eDos) { console.error(`❌ ${eDos.message}`); process.exit(1); }
if ((dossiers ?? []).length !== 1) {
  console.error(`❌ ${(dossiers ?? []).length} dossier(s) SOMADIR — il en faut exactement un.`);
  process.exit(1);
}
const dossier = (dossiers as any[])[0];
const avant = await lireGrandLivre(dossier.id);
console.log(`  Dossier : ${dossier.nom_societe}  ·  ${avant.length} écriture(s)\n`);

type LigneNeuve = {
  journal_code: string; compte_numero: string; date_ecriture: string;
  libelle: string; debit: number; credit: number; reference_piece: string | null;
};
interface Correction {
  code: string;
  titre: string;
  supprimer: any[];
  creer: LigneNeuve[];
  dejaFaite: boolean;
  raisonDejaFaite?: string;
  grief?: string;
}

const corrections: Correction[] = [];

// ─── C1 · Règlement ATLAS PACKAGING : sens inversé + collectif au lieu de l'auxiliaire ──
{
  const DATE = "2026-05-04";
  const MONTANT = 20160;
  const caisse = normaliserNumeroCompte("5161");
  const collectif = normaliserNumeroCompte("4411");
  const auxiliaire = "44110001";

  const fautives = avant.filter((l) => jour(l) === DATE
    && txt(l.journal_code).toUpperCase() === "CAI"
    && Math.abs(nb(l.debit) + nb(l.credit) - MONTANT) < 0.005
    && (txt(l.compte_numero) === caisse || txt(l.compte_numero) === collectif));

  const dejaBonne = avant.some((l) => jour(l) === DATE
    && txt(l.journal_code).toUpperCase() === "CAI"
    && txt(l.compte_numero) === auxiliaire && nb(l.debit) === MONTANT);

  const libelle = txt(fautives[0]?.libelle) || "Paiement fac fournisseur";
  corrections.push({
    code: "C1",
    titre: "Règlement ATLAS PACKAGING — sens inversé et compte collectif",
    dejaFaite: dejaBonne || fautives.length !== 2,
    raisonDejaFaite: dejaBonne
      ? `le règlement est déjà au débit de ${auxiliaire}`
      : fautives.length !== 2 ? `${fautives.length} ligne(s) trouvée(s) au lieu de 2 — refus d'agir à l'aveugle` : undefined,
    grief: `caisse débitée en payant, dette créditée, et imputation sur le collectif ${collectif} `
      + `alors que l'achat était sur ${auxiliaire} : le fournisseur affichait ${fmt(MONTANT * 2)} de dette.`,
    supprimer: fautives,
    creer: [
      { journal_code: "CAI", compte_numero: auxiliaire, date_ecriture: DATE,
        libelle, debit: MONTANT, credit: 0, reference_piece: fautives[0]?.reference_piece ?? null },
      { journal_code: "CAI", compte_numero: caisse, date_ecriture: DATE,
        libelle, debit: 0, credit: MONTANT, reference_piece: fautives[0]?.reference_piece ?? null },
    ],
  });
}

// ─── C2 · TVA déductible ATLAS : bascule manquante, déclaration + régularisation à retirer ──
{
  const DATE_BASCULE = "2026-05-04";
  const MONTANT = 3360;
  const attente = normaliserNumeroCompte("3458");
  const exigible = normaliserNumeroCompte("34552");

  const aRetirer = avant.filter((l) =>
    txt(l.reference_piece) === "DECL-TVA-2024-11" || txt(l.reference_piece) === "REGUL-TVA-2024-11");

  // La référence de la pièce d'achat : c'est elle qui rattache la bascule à sa
  // facture, et sans quoi `tvaEnAttenteDeLaPiece` ne la retrouverait jamais.
  const ligneAchat = avant.find((l) => txt(l.journal_code).toUpperCase() === "ACH"
    && txt(l.compte_numero) === attente && Math.abs(nb(l.debit) - MONTANT) < 0.005);
  const refAchat = txt(ligneAchat?.reference_piece) || null;

  const dejaBasculee = avant.some((l) => jour(l) === DATE_BASCULE
    && txt(l.journal_code).toUpperCase() === "OD"
    && txt(l.compte_numero) === exigible && Math.abs(nb(l.debit) - MONTANT) < 0.005);

  corrections.push({
    code: "C2",
    titre: "TVA déductible ATLAS — bascule au décaissement réel",
    dejaFaite: dejaBasculee,
    raisonDejaFaite: dejaBasculee ? `la bascule du ${DATE_BASCULE} existe déjà` : undefined,
    grief: `le ${attente} n'a jamais été soldé : la déduction a été DÉCLARÉE (2024-11-30) `
      + `puis REPRISE (2026-08-28) sans qu'aucune bascule ne la rende déductible. `
      + `Les deux pièces se neutralisent sur ${exigible} et sur 44560000 — les retirer est neutre.`,
    supprimer: aRetirer,
    creer: [
      { journal_code: "OD", compte_numero: exigible, date_ecriture: DATE_BASCULE,
        libelle: `TVA déductible au décaissement — ATLAS PACKAGING`,
        debit: MONTANT, credit: 0, reference_piece: refAchat },
      { journal_code: "OD", compte_numero: attente, date_ecriture: DATE_BASCULE,
        libelle: `TVA déductible au décaissement — ATLAS PACKAGING`,
        debit: 0, credit: MONTANT, reference_piece: refAchat },
    ],
  });
}

// ─── C3 · FA-2024-0892 : la bascule est bonne, la déclaration est prématurée ──
{
  const aRetirer = avant.filter((l) => txt(l.reference_piece) === "DECL-TVA-2024-05");
  const bascule = avant.filter((l) => txt(l.reference_piece) === "FA-2024-0892"
    && txt(l.journal_code).toUpperCase() === "OD");

  corrections.push({
    code: "C3",
    titre: "TVA collectée FA-2024-0892 — déclaration prématurée",
    dejaFaite: aRetirer.length === 0,
    raisonDejaFaite: aRetirer.length === 0 ? "DECL-TVA-2024-05 n'existe plus" : undefined,
    grief: `la bascule ${bascule.length ? `existe et est bien datée du ${jour(bascule[0])}` : "est absente"} `
      + `— rien à déplacer. C'est la déclaration du 2024-05-31 qui déclare les 578,00 `
      + `deux ans avant l'encaissement.`,
    supprimer: aRetirer,
    creer: [],
  });
}

// ─── Rapport ────────────────────────────────────────────────────────────────
let aFaire = 0;
for (const c of corrections) {
  console.log(`  ${c.dejaFaite ? "✅" : "🔧"} ${c.code} — ${c.titre}`);
  if (c.dejaFaite) { console.log(`       déjà fait : ${c.raisonDejaFaite}\n`); continue; }
  aFaire++;
  console.log(`       ${c.grief}`);
  for (const l of c.supprimer) {
    console.log(`       − ${jour(l)} ${txt(l.journal_code).padEnd(4)} ${txt(l.compte_numero).padEnd(9)}`
      + ` D${fmt(nb(l.debit)).padStart(11)} C${fmt(nb(l.credit)).padStart(11)}  ${txt(l.reference_piece)}`);
  }
  for (const l of c.creer) {
    console.log(`       + ${l.date_ecriture} ${l.journal_code.padEnd(4)} ${l.compte_numero.padEnd(9)}`
      + ` D${fmt(l.debit).padStart(11)} C${fmt(l.credit).padStart(11)}  ${l.reference_piece ?? ""}`);
  }
  const ecart = r2(
    c.creer.reduce((s, l) => s + l.debit - l.credit, 0)
    - c.supprimer.reduce((s, l) => s + nb(l.debit) - nb(l.credit), 0));
  console.log(`       effet net sur la partie double : ${fmt(ecart)} ${Math.abs(ecart) < 0.005 ? "✅" : "❌"}\n`);
  if (Math.abs(ecart) > 0.005) {
    console.error(`⛔ ${c.code} déséquilibrerait le grand livre. Refus d'écrire.\n`);
    process.exit(1);
  }
}

if (!aFaire) { console.log("Rien à corriger — le dossier est déjà repris.\n"); process.exit(0); }

// ─── Projection : le grand livre tel qu'il sera ─────────────────────────────
const idsSupprimes = new Set(corrections.flatMap((c) => c.dejaFaite ? [] : c.supprimer.map((l) => l.id)));
const apres = [
  ...avant.filter((l) => !idsSupprimes.has(l.id)),
  ...corrections.flatMap((c) => c.dejaFaite ? [] : c.creer),
];

function balance(lignes: any[]): LigneBalance[] {
  const parCompte = new Map<string, { d: number; c: number }>();
  for (const l of lignes) {
    const cpt = txt(l.compte_numero);
    const cell = parCompte.get(cpt) ?? { d: 0, c: 0 };
    cell.d += nb(l.debit); cell.c += nb(l.credit);
    parCompte.set(cpt, cell);
  }
  return [...parCompte.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([compte, v]) => ({
    compte, total_debit: r2(v.d), total_credit: r2(v.c),
    solde: Math.abs(r2(v.d - v.c)), sens: v.d >= v.c ? "D" : "C",
  }));
}

const bAvant = balance(avant), bApres = balance(apres);
const soldeDe = (b: LigneBalance[], compte: string) => {
  const l = b.find((x) => x.compte === compte);
  return l ? r2(l.total_debit - l.total_credit) : 0;
};

console.log("  ─── Comptes touchés, avant → après (signé : + débiteur, − créditeur) ───");
const suivis = ["44110000", "44110001", "51610000", "34580000", "34552000", "44551000", "44560000"];
for (const cpt of suivis) {
  const a = soldeDe(bAvant, cpt), b = soldeDe(bApres, cpt);
  const marque = Math.abs(a - b) < 0.005 ? " " : "→";
  console.log(`    ${marque} ${cpt}  ${fmt(a).padStart(13)}  →  ${fmt(b).padStart(13)}`);
}

const synAvant = synthetiserBalance(bAvant), synApres = synthetiserBalance(bApres);
console.log(`\n  ─── Balance ───`);
console.log(`    partie double  avant : écart ${fmt(synAvant.total.ecart)} ${synAvant.total.equilibre ? "✅" : "❌"}`);
console.log(`    partie double  après : écart ${fmt(synApres.total.ecart)} ${synApres.total.equilibre ? "✅" : "❌"}`);
console.log(`    résultat       avant : ${synAvant.resultat.label} ${fmt(synAvant.resultat.montant)}`);
console.log(`    résultat       après : ${synApres.resultat.label} ${fmt(synApres.resultat.montant)}`);
console.log(`    comptes d'attente 47* : ${synApres.suspens.apure ? "apurés ✅" : synApres.suspens.alerte}`);

if (!synApres.total.equilibre) {
  console.error(`\n⛔ La balance projetée n'est pas équilibrée. Refus d'écrire.\n`);
  process.exit(1);
}

// Le contrôle que le script ne corrige PAS, et qu'il refuse de taire.
const caisse = soldeDe(bApres, "51610000");
if (caisse < -0.005) {
  console.log(`\n  ⚠️  CAISSE CRÉDITRICE de ${fmt(-caisse)} après reprise — impossible dans les faits.`);
  console.log(`      Le règlement corrigé sort l'argent ; il n'entre jamais assez pour le couvrir.`);
  console.log(`      Cause en amont : solde d'ouverture de caisse jamais saisi, ou encaissements`);
  console.log(`      absents. Poser une écriture d'ouverture pour combler fabriquerait une`);
  console.log(`      trésorerie fictive — c'est signalé, délibérément pas corrigé.`);
}

if (!APPLY) {
  console.log(`\n🔍 Dry-run — rien n'a été écrit. Ajoutez --apply pour appliquer.\n`);
  process.exit(0);
}

// ─── Application ────────────────────────────────────────────────────────────
const horodatage = new Date().toISOString().replace(/[:.]/g, "-");
const chemin = `backup_somadir_${horodatage}.json`;
const supprimees = corrections.flatMap((c) => c.dejaFaite ? [] : c.supprimer);

fs.writeFileSync(path.join(ROOT, chemin), JSON.stringify({
  date: new Date().toISOString(), dossierId: dossier.id, dossier: dossier.nom_societe,
  corrections: corrections.filter((c) => !c.dejaFaite).map((c) => c.code),
  supprimees, creees: [] as string[],
}, null, 2), "utf8");
console.log(`\n💾 Sauvegarde : ${chemin}`);

const idsAvant = new Set(avant.map((l) => l.id));

for (const c of corrections) {
  if (c.dejaFaite) continue;
  if (c.supprimer.length) {
    const { error, count } = await sb.from("ecritures_comptables")
      .delete({ count: "exact" }).in("id", c.supprimer.map((l) => l.id));
    if (error) { console.error(`\n❌ ${c.code} suppression : ${error.message}\n`); process.exit(1); }
    console.log(`   ${c.code} — ${count ?? 0} ligne(s) supprimée(s)`);
  }
  if (c.creer.length) {
    // Par `insererPiece` : même chemin que l'application, verrous de régime et
    // normalisation des numéros compris. Un insert direct les contournerait.
    const { error } = await insererPiece(sb, dossier.id, c.creer as any, { origine: "manuel" });
    if (error) { console.error(`\n❌ ${c.code} insertion refusée : ${error}\n`); process.exit(1); }
    console.log(`   ${c.code} — ${c.creer.length} ligne(s) créée(s)`);
  }
}

// Les ids réellement créés, pour que le rollback sache quoi retirer.
const finales = await lireGrandLivre(dossier.id);
const creees = finales.filter((l) => !idsAvant.has(l.id)).map((l) => l.id);
const sauv = JSON.parse(fs.readFileSync(path.join(ROOT, chemin), "utf8"));
sauv.creees = creees;
fs.writeFileSync(path.join(ROOT, chemin), JSON.stringify(sauv, null, 2), "utf8");

const bFinale = balance(finales);
const synFinale = synthetiserBalance(bFinale);
console.log(`\n✅ Reprise appliquée — ${supprimees.length} supprimée(s), ${creees.length} créée(s).`);
console.log(`   Balance relue en base : écart ${fmt(synFinale.total.ecart)} ${synFinale.total.equilibre ? "✅" : "❌"}`);
console.log(`\nRollback : node --import tsx scripts/corriger-ecritures-somadir.ts --rollback=${chemin}`);
console.log(`Contrôle : node --import tsx scripts/auditer-conformite-comptable.ts --dossier="SOMADIR"\n`);
process.exit(synFinale.total.equilibre ? 0 : 1);
