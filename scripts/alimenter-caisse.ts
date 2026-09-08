/**
 * alimenter-caisse.ts — régularise une CAISSE CRÉDITRICE par un apport en compte
 * courant d'associé.
 *
 * ─── Pourquoi une caisse créditrice doit être corrigée ───────────────────────
 * Une caisse ne peut pas être négative. Ce n'est pas une convention de
 * présentation : on ne décaisse pas des espèces qu'on n'a pas. Un solde
 * créditeur au 516 est donc la preuve ARITHMÉTIQUE qu'une entrée de fonds a eu
 * lieu et n'a jamais été comptabilisée.
 *
 * C'est ce qui distingue ce cas des comptes d'attente 47 (cf. balance-comptable),
 * où l'on refuse d'imputer quoi que ce soit : là, l'argent existe mais sa NATURE
 * est inconnue ; ici, l'EXISTENCE de l'entrée est démontrée par le solde
 * lui-même, et seule sa source est présumée. Le compte courant d'associé est la
 * présomption ordinaire, et la plus prudente : c'est une DETTE de la société
 * envers l'associé, elle ne touche pas le résultat, et elle s'annule d'un
 * rollback le jour où la vraie pièce ressort.
 *
 * ─── Le cas qui l'a motivé ───────────────────────────────────────────────────
 * DIGITAL SOLUTIONS MAROC SARL AU : le 04/08/2026, la facture AZUR BUREAU
 * FR - 2026 - 88 (1 440,00 TTC) est réglée en espèces. C'est la SEULE écriture de
 * trésorerie du dossier — aucun compte bancaire mouvementé, aucun relevé, aucun
 * encaissement. La caisse part donc à −1 440,00 dès son premier mouvement.
 *
 * ─── Ce que le script REFUSE de faire ────────────────────────────────────────
 * Créditer la BANQUE (5141) au titre d'un « retrait d'espèces ». Sur un dossier
 * sans le moindre relevé ni la moindre ligne bancaire, ce serait :
 *   • inventer un mouvement de trésorerie sans pièce — exactement ce que
 *     `origineEcritureTresorerie` dénonce comme trésorerie fictive ;
 *   • et surtout DÉPLACER l'impossibilité au lieu de la résoudre : la banque
 *     passerait à −1 440,00 à la place de la caisse.
 * Le script s'y refuse et le dit. Le compte courant d'associé n'a pas ce défaut :
 * il n'est pas un compte de trésorerie, son solde créditeur est sa position
 * normale, et il n'exige aucune pièce bancaire.
 *
 * ─── Sûreté ──────────────────────────────────────────────────────────────────
 * • DRY-RUN par défaut : il faut `--apply` pour écrire.
 * • Insertion par `insererPiece`, le passage obligé de l'application : les
 *   verrous de régime s'appliquent (partie double, trésorerie hors OD, sens des
 *   règlements, cut-off d'exercice). Un `insert` direct les contournerait.
 * • Sauvegarde JSON, et `--rollback` supprime la pièce par sa RÉFÉRENCE.
 * • Refuse d'agir si la caisse n'est pas créditrice, et n'apporte JAMAIS plus
 *   que le déficit constaté.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   node --import tsx scripts/alimenter-caisse.ts --dossier="DIGITAL"
 *   node --import tsx scripts/alimenter-caisse.ts --dossier="DIGITAL" --date=2026-04-08 --apply
 *   node --import tsx scripts/alimenter-caisse.ts --rollback=backup_apport_caisse_XXX.json
 *
 * CODE DE SORTIE : 0 = caisse saine · 1 = apport nécessaire ou effectué · 2 = échec.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { insererPiece } from "../src/server/lettrage-compta.functions";
import { normaliserNumeroCompte } from "../src/lib/numero-compte";

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
const DATE = flag("date") || null;
const LIBELLE = flag("libelle") || null;

/**
 * Caisse et contrepartie, en forme canonique sur 8 chiffres.
 *
 * `4461` — « Comptes d'associés créditeurs » — est le SEUL compte d'associé
 * créditeur du référentiel PCM de ce projet ; `4462` n'y figure pas. Écrire un
 * numéro absent du plan produirait une ligne de balance sans intitulé et un
 * export Sage refusé.
 */
const COMPTE_CAISSE = normaliserNumeroCompte("5161");
const COMPTE_ASSOCIE = normaliserNumeroCompte("4461");
const JOURNAL_CAISSE = "CAI";
const PREFIXE_PIECE = "APPORT-CAISSE-";

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env"), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
) as Record<string, string>;

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
const r2 = (x: number) => Math.round(x * 100) / 100;
const fmt = (x: number) => nb(x).toLocaleString("fr-MA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface Sauvegarde {
  genere_le: string;
  dossier: { id: string; nom: string };
  reference_piece: string;
  lignes: { compte: string; debit: number; credit: number; date: string; libelle: string }[];
}

async function rejouer(fichier: string): Promise<number> {
  const s = JSON.parse(fs.readFileSync(path.resolve(ROOT, fichier), "utf8")) as Sauvegarde;
  console.log(`↩️  Rollback de ${fichier} — ${s.dossier.nom}, pièce ${s.reference_piece}`);
  const { error, count } = await sb.from("ecritures_comptables")
    .delete({ count: "exact" })
    .eq("dossier_id", s.dossier.id)
    .eq("reference_piece", s.reference_piece);
  if (error) { console.error(`   ✗ ${error.message}`); return 2; }
  console.log(`   ✓ ${count ?? 0} ligne(s) supprimée(s).`);
  return 0;
}

async function corriger(): Promise<number> {
  const { data: dossiers, error } = await sb.from("dossiers").select("id,nom_societe").order("nom_societe");
  if (error) { console.error("Lecture des dossiers impossible :", error.message); return 2; }

  const cibles = (dossiers ?? []).filter((d: any) =>
    !CIBLE || txt(d.nom_societe).toLowerCase().includes(CIBLE.toLowerCase()));
  if (!cibles.length) { console.error(`Aucun dossier ne correspond à « ${CIBLE} ».`); return 2; }

  let aCorriger = 0;

  for (const d of cibles) {
    const { data: ecr } = await sb.from("ecritures_comptables")
      .select("date_ecriture,journal_code,compte_numero,debit,credit,libelle,reference_piece")
      .eq("dossier_id", d.id).like("compte_numero", "516%").order("date_ecriture");

    const lignesCaisse = (ecr ?? []) as any[];
    if (!lignesCaisse.length) continue;

    const solde = r2(lignesCaisse.reduce((s, l) => s + nb(l.debit) - nb(l.credit), 0));
    console.log(`\n${"═".repeat(78)}\n${d.nom_societe}\n${"═".repeat(78)}`);
    console.log(`   Caisse ${COMPTE_CAISSE} : ${fmt(solde)} MAD sur ${lignesCaisse.length} mouvement(s).`);
    for (const l of lignesCaisse) {
      console.log(`     ${jour(l.date_ecriture)} ${txt(l.journal_code).padEnd(4)} `
        + `D=${fmt(nb(l.debit))} C=${fmt(nb(l.credit))}  ${txt(l.libelle).slice(0, 46)}`);
    }

    if (solde >= -0.005) { console.log("   ✓ Caisse non créditrice — rien à faire."); continue; }

    // L'apport couvre EXACTEMENT le déficit, jamais davantage : un apport plus
    // large créerait une encaisse dont rien ne prouve l'existence.
    const montant = r2(-solde);
    // Date : par défaut le jour du premier mouvement qui rend la caisse
    // créditrice — l'assertion MINIMALE, celle que le solde démontre. Une date
    // antérieure reste admissible et se passe en `--date`.
    const premierDecaissement = lignesCaisse.find((l) => nb(l.credit) > 0.005);
    const dateApport = DATE || jour(premierDecaissement?.date_ecriture) || jour(lignesCaisse[0].date_ecriture);
    const reference = `${PREFIXE_PIECE}${dateApport}`;

    // Le libellé nomme le règlement que l'apport a permis, quand on peut
    // l'identifier : un apport sans motif est un apport qu'on ne saura pas
    // justifier dans six mois.
    const motif = txt(premierDecaissement?.libelle).replace(/^Décaissement espèces\s*/i, "");
    const libelle = LIBELLE || (motif
      ? `Alimentation caisse pour règlement ${motif}`
      : "Alimentation caisse — apport en compte courant d'associé");

    const lignes = [
      { journal_code: JOURNAL_CAISSE, compte_numero: COMPTE_CAISSE, date_ecriture: dateApport,
        libelle, debit: montant, credit: 0, reference_piece: reference },
      { journal_code: JOURNAL_CAISSE, compte_numero: COMPTE_ASSOCIE, date_ecriture: dateApport,
        libelle, debit: 0, credit: montant, reference_piece: reference },
    ];

    console.log(`\n   → APPORT PROPOSÉ  (pièce ${reference})`);
    console.log(`     ${dateApport} ${JOURNAL_CAISSE}  D ${COMPTE_CAISSE} ${fmt(montant)}`);
    console.log(`     ${dateApport} ${JOURNAL_CAISSE}  C ${COMPTE_ASSOCIE} ${fmt(montant)}`);
    console.log(`     « ${libelle} »`);
    console.log(`     Caisse après apport : ${fmt(r2(solde + montant))} MAD`);
    aCorriger++;

    // Pièce déjà posée : on ne la repose pas. Sans cette garde, deux exécutions
    // successives créditeraient l'associé deux fois pour un seul apport.
    const { data: deja } = await sb.from("ecritures_comptables").select("id")
      .eq("dossier_id", d.id).eq("reference_piece", reference).limit(1);
    if ((deja ?? []).length) {
      console.log(`   ⚠ La pièce ${reference} existe déjà — apport NON reposé.`);
      continue;
    }

    if (!APPLY) { console.log("\n🔍 DRY-RUN — rien n'a été écrit. Ajoutez --apply."); continue; }

    const sauvegarde: Sauvegarde = {
      genere_le: new Date().toISOString(),
      dossier: { id: d.id, nom: d.nom_societe },
      reference_piece: reference,
      lignes: lignes.map((l) => ({ compte: l.compte_numero, debit: l.debit, credit: l.credit,
        date: l.date_ecriture, libelle: l.libelle })),
    };
    const nomBackup = `backup_apport_caisse_${txt(d.nom_societe).replace(/[^\w]+/g, "_").toLowerCase()}_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    fs.writeFileSync(path.join(ROOT, nomBackup), JSON.stringify(sauvegarde, null, 2), "utf8");

    // `insererPiece` — le MÊME chemin que l'application, verrous compris.
    const { error: eIns } = await insererPiece(sb, d.id, lignes);
    if (eIns) { console.error(`\n   ✗ Insertion REFUSÉE par les verrous : ${eIns}`); return 2; }

    console.log(`\n💾 Sauvegarde : ${nomBackup}`);
    console.log(`✅ Apport comptabilisé. Rollback : --rollback=${nomBackup}`);
  }

  console.log(`\n${"─".repeat(78)}`);
  console.log(aCorriger
    ? `${aCorriger} caisse(s) créditrice(s) ${APPLY ? "régularisée(s)" : "à régulariser"}.`
    : "Aucune caisse créditrice.");
  return aCorriger ? 1 : 0;
}

const code = ROLLBACK !== undefined && ROLLBACK ? await rejouer(ROLLBACK) : await corriger();
process.exit(code);
