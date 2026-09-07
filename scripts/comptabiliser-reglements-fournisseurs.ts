/**
 * comptabiliser-reglements-fournisseurs.ts — Génère les écritures de RÈGLEMENT
 * manquantes pour les factures dont le paiement est enregistré mais jamais passé
 * en comptabilité.
 *
 * ─── Le défaut ───────────────────────────────────────────────────────────────
 * Trois factures fournisseurs de STE SMERT WATER portaient une ligne `paiements`
 * (posée par le lettrage d'une transaction bancaire) SANS qu'aucune écriture de
 * trésorerie n'en soit tirée. Conséquence : leur compte 4411 restait crédité,
 * alors que la facture s'affichait soldée. La balance annonçait 60 525,01 MAD de
 * dettes là où le tableau de bord en annonçait 44 729,02 — l'écart valant, au
 * centime près, la somme des trois règlements non comptabilisés.
 *
 *      D 4411x  (on solde la dette)
 *      C 5141 / 5161  (l'argent sort)
 *
 * ─── Ce qui rend l'écriture LICITE ───────────────────────────────────────────
 * La règle d'intégrité Banque ⇄ Compta interdit d'inventer un mouvement de
 * trésorerie : une écriture BQ/CAI n'est légitime que si un relevé validé ou une
 * PIÈCE FORMELLE l'atteste. C'est ici le cas — chaque écriture produite s'appuie
 * sur sa ligne de `paiements`, et `assertEcrituresTresorerie` le vérifie avant
 * l'insert. Le script ne crée jamais d'écriture sans pièce.
 *
 * ─── Passe 0 : les dates impossibles ─────────────────────────────────────────
 * Un règlement ANTÉRIEUR à sa facture ne peut pas être comptabilisé tel quel : il
 * daterait le décaissement d'un exercice où la dette n'existait pas encore. La
 * passe 0 corrige d'abord le millésime (cf. `corrigerAnneeReglement`), et le
 * script refuse ensuite toute pièce dont la date reste antérieure.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   node --import tsx scripts/comptabiliser-reglements-fournisseurs.ts
 *   node --import tsx scripts/comptabiliser-reglements-fournisseurs.ts --apply
 *   node --import tsx scripts/comptabiliser-reglements-fournisseurs.ts --dossier="SMERT" --apply
 *   node --import tsx scripts/comptabiliser-reglements-fournisseurs.ts --sens=client --apply
 *   node --import tsx scripts/comptabiliser-reglements-fournisseurs.ts --rollback=backup_reglements_XXX.json
 *
 * Sans --apply, RIEN n'est écrit.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { compteTiersAuxiliaire } from "../src/lib/comptes-auxiliaires";
import { imputationTresorerie } from "../src/lib/comptes-tresorerie";
import { assertEcrituresTresorerie, estJournalTresorerie } from "../src/lib/integrite-tresorerie";
import { corrigerAnneeReglement } from "../src/lib/coherence-ventes";
import { jourIso } from "../src/lib/exercice-comptable";
import { normaliserComptesLignes } from "../src/lib/numero-compte";

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
const DOSSIER = val("dossier");
const ROLLBACK = val("rollback");
const SENS = (val("sens") ?? "fournisseur") as "fournisseur" | "client" | "tous";

const fmt = (x: number) => Number(x).toLocaleString("fr-MA", { minimumFractionDigits: 2 });
const r2 = (x: number) => Math.round(x * 100) / 100;
const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

interface Backup {
  genere: string;
  /** Écritures CRÉÉES — le rollback les supprime. */
  ecrituresCreees: string[];
  /** Dates corrigées — le rollback les restaure. */
  dates: { table: string; id: string; date_paiement: string | null }[];
  paiements: { id: string; date_paiement: string | null }[];
}

// ─── Rollback ────────────────────────────────────────────────────────────────
if (ROLLBACK) {
  const chemin = path.isAbsolute(ROLLBACK) ? ROLLBACK : path.join(RACINE, ROLLBACK);
  const b = JSON.parse(fs.readFileSync(chemin, "utf8")) as Backup;
  console.log(`\n↩️  ROLLBACK depuis ${path.basename(chemin)} (généré le ${b.genere})`);
  if (b.ecrituresCreees?.length) {
    const { error } = await sb.from("ecritures_comptables").delete().in("id", b.ecrituresCreees);
    console.log(error ? `   ❌ écritures : ${error.message}` : `   ✅ ${b.ecrituresCreees.length} écriture(s) supprimée(s)`);
  }
  for (const d of b.dates ?? []) {
    const { error } = await sb.from(d.table).update({ date_paiement: d.date_paiement }).eq("id", d.id);
    console.log(error ? `   ❌ ${d.table} ${d.id} : ${error.message}` : `   ✅ ${d.table} ${d.id} → ${d.date_paiement}`);
  }
  for (const p of b.paiements ?? []) {
    const { error } = await sb.from("paiements").update({ date_paiement: p.date_paiement }).eq("id", p.id);
    console.log(error ? `   ❌ paiement ${p.id} : ${error.message}` : `   ✅ paiement ${p.id} → ${p.date_paiement}`);
  }
  console.log("");
  process.exit(0);
}

// ─── Chargement ──────────────────────────────────────────────────────────────
let qd = sb.from("dossiers").select("*");
if (DOSSIER) qd = qd.ilike("nom_societe", `%${DOSSIER}%`);
const { data: dossiers, error: eDos } = await qd;
if (eDos) { console.error("❌ dossiers :", eDos.message); process.exit(1); }

const backup: Backup = { genere: new Date().toISOString(), ecrituresCreees: [], dates: [], paiements: [] };
let creees = 0, datesCorrigees = 0, refusees = 0;

console.log(`\n═══ COMPTABILISATION DES RÈGLEMENTS ═══  ${APPLY ? "MODE ÉCRITURE" : "DRY-RUN (aucune écriture)"}`);
console.log(`    sens : ${SENS}   ·   dossiers : ${dossiers.length}${DOSSIER ? ` (filtre « ${DOSSIER} »)` : ""}`);

const sensAFaire = SENS === "tous" ? (["fournisseur", "client"] as const) : ([SENS] as const);

for (const d of dossiers ?? []) {
  const { data: ecrRows } = await sb.from("ecritures_comptables")
    .select("id,journal_code,compte_numero,date_ecriture,debit,credit,reference_piece,facture_id,libelle")
    .eq("dossier_id", d.id);
  const lignes = (ecrRows ?? []) as any[];

  let entete = false;
  const titre = () => {
    if (entete) return;
    console.log(`\n─── ${d.nom_societe}`);
    entete = true;
  };

  for (const sens of sensAFaire) {
    const estClient = sens === "client";
    const table = estClient ? "factures" : "factures_fournisseurs";
    const colPaiement = estClient ? "facture_id" : "facture_fournisseur_id";
    const tableTiers = estClient ? "clients" : "fournisseurs";
    const colTiers = estClient ? "client_id" : "fournisseur_id";

    const [{ data: fRows }, { data: pRows }, { data: tRows }] = await Promise.all([
      sb.from(table).select("*").eq("dossier_id", d.id),
      sb.from("paiements").select("*").eq("dossier_id", d.id).not(colPaiement, "is", null),
      sb.from(tableTiers).select("id,nom,code_auxiliaire").eq("dossier_id", d.id),
    ]);
    const factures = (fRows ?? []) as any[];
    const paiements = (pRows ?? []) as any[];
    const tiers = new Map(((tRows ?? []) as any[]).map((t) => [String(t.id), t]));

    for (const f of factures) {
      const pieces = paiements.filter((p) => String(p[colPaiement]) === String(f.id));
      if (!pieces.length) continue;

      // Écritures de trésorerie DÉJÀ passées pour cette facture : côté client
      // l'ancre est `facture_id`, côté fournisseur `reference_piece` = id (la FK
      // ecritures_comptables.facture_id pointe sur `factures` et refuserait un id
      // de facture fournisseur).
      const dejaPassees = lignes.filter((l) =>
        estJournalTresorerie(l.journal_code)
        && (estClient
          ? String(l.facture_id ?? "") === String(f.id)
          : String(l.reference_piece ?? "") === String(f.id)));
      const dejaRegle = r2(dejaPassees.reduce(
        (s, l) => s + (estClient ? n(l.debit) : n(l.credit)), 0));
      const totalPieces = r2(pieces.reduce((s, p) => s + n(p.montant), 0));
      const aPasser = r2(totalPieces - dejaRegle);
      if (aPasser <= 0.005) continue;

      titre();
      const nom = f.fournisseur_nom ?? tiers.get(String(f[colTiers]))?.nom ?? "—";
      const ref = String(f.numero ?? f.id);

      // ── Passe 0 : date impossible ─────────────────────────────────────────
      const datePiece = jourIso(pieces.map((p) => p.date_paiement).filter(Boolean).sort().at(-1) ?? null);
      const dateCorrigee = corrigerAnneeReglement(f.date_facture, datePiece);
      const dateBouge = dateCorrigee !== null && dateCorrigee !== datePiece;
      if (dateBouge) {
        console.log(`   [0] ${nom} ${ref} : règlement au ${datePiece} pour une facture du `
          + `${jourIso(f.date_facture)} → millésime corrigé en ${dateCorrigee}`);
      }
      const dateEcriture = dateCorrigee ?? datePiece;

      if (!dateEcriture) {
        refusees++;
        console.log(`   ⛔ ${nom} ${ref} : aucune date de règlement exploitable — non comptabilisé.`);
        continue;
      }
      if (jourIso(f.date_facture) && dateEcriture < jourIso(f.date_facture)) {
        refusees++;
        console.log(`   ⛔ ${nom} ${ref} : règlement (${dateEcriture}) toujours antérieur à la facture `
          + `(${jourIso(f.date_facture)}) — non comptabilisé, à arbitrer.`);
        continue;
      }

      // ── Imputation ────────────────────────────────────────────────────────
      const compteTiers = compteTiersAuxiliaire(
        sens, tiers.get(String(f[colTiers]))?.code_auxiliaire ?? null);
      const { compte: compteTresorerie, journal, especes } =
        imputationTresorerie(f.mode_reglement ?? "virement", d);

      const commun = {
        dossier_id: d.id, journal_code: journal, date_ecriture: dateEcriture,
        reference_piece: estClient ? ref : String(f.id),
        facture_id: estClient ? f.id : null,
        valide: true,
      };
      const ecritures = estClient
        ? [
            { ...commun, compte_numero: compteTresorerie, libelle: `Encaissement ${especes ? "espèces " : ""}${ref}`, debit: aPasser, credit: 0 },
            { ...commun, compte_numero: compteTiers, libelle: `Règlement client ${ref}`, debit: 0, credit: aPasser },
          ]
        : [
            { ...commun, compte_numero: compteTiers, libelle: `Règlement fournisseur ${ref}`, debit: aPasser, credit: 0 },
            { ...commun, compte_numero: compteTresorerie, libelle: `Décaissement ${especes ? "espèces " : ""}${ref}`, debit: 0, credit: aPasser },
          ];

      console.log(`   [1] ${nom} ${ref} : ${fmt(aPasser)} MAD au ${dateEcriture} — `
        + `${journal} · D ${estClient ? compteTresorerie : compteTiers} / C ${estClient ? compteTiers : compteTresorerie}`);

      if (!APPLY) continue;

      // La pièce EXISTE : c'est elle qui rend l'écriture licite. Sans elle, ces
      // deux lignes seraient l'écriture fantôme que la règle d'intégrité interdit.
      try {
        assertEcrituresTresorerie(ecritures as any, {
          origine: "saisie_manuelle",
          // L'identifiant RÉEL de la ligne `paiements` : c'est la pièce, et elle
          // doit pouvoir être retrouvée en base depuis le rapport.
          piece: String(pieces[0].id),
        });
      } catch (e: any) {
        refusees++;
        console.log(`       ⛔ contrôle d'intégrité : ${e?.message ?? e}`);
        continue;
      }

      if (dateBouge) {
        backup.dates.push({ table, id: String(f.id), date_paiement: f.date_paiement ?? null });
        await sb.from(table).update({ date_paiement: dateEcriture }).eq("id", f.id);
        for (const p of pieces) {
          backup.paiements.push({ id: String(p.id), date_paiement: p.date_paiement ?? null });
          await sb.from("paiements").update({ date_paiement: dateEcriture }).eq("id", p.id);
        }
        datesCorrigees++;
      }

      const { data: inserees, error } = await sb.from("ecritures_comptables")
        .insert(normaliserComptesLignes(ecritures)).select("id");
      if (error) { console.log(`       ❌ ${error.message}`); continue; }
      for (const x of (inserees ?? []) as any[]) backup.ecrituresCreees.push(String(x.id));
      lignes.push(...(ecritures as any[]));
      creees += (inserees ?? []).length;
      console.log(`       ✅ ${(inserees ?? []).length} écriture(s) insérée(s)`);
    }
  }
}

if (APPLY && (backup.ecrituresCreees.length || backup.dates.length)) {
  const nom = `backup_reglements_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(path.join(RACINE, nom), JSON.stringify(backup, null, 2), "utf8");
  console.log(`\n💾 Backup : ${nom}  (rejouable via --rollback=${nom})`);
}

// ─── Contrôle : soldes 4411 / 342x relus depuis la base ──────────────────────
console.log("\n═══ CONTRÔLE (relecture depuis la base) ═══");
for (const d of dossiers ?? []) {
  const [{ data: ecr }, { data: ff }, { data: fc }] = await Promise.all([
    sb.from("ecritures_comptables").select("compte_numero,debit,credit,journal_code").eq("dossier_id", d.id),
    sb.from("factures_fournisseurs").select("statut_paiement,montant_ttc,montant_paye,montant_restant").eq("dossier_id", d.id),
    sb.from("factures").select("statut_paiement,montant_ttc,montant_paye,montant_restant").eq("dossier_id", d.id),
  ]);
  const lignes = (ecr ?? []) as any[];
  if (!lignes.length) continue;
  const solde = (racine: string) => r2(lignes
    .filter((l) => String(l.compte_numero ?? "").startsWith(racine))
    .reduce((s, l) => s + n(l.credit) - n(l.debit), 0));
  const du = (rows: any[]) => r2((rows ?? [])
    .filter((f) => f.statut_paiement !== "payee")
    .reduce((s, f) => {
      const reste = n(f.montant_restant);
      return s + (reste > 0.005 ? reste : Math.max(0, r2(n(f.montant_ttc) - n(f.montant_paye))));
    }, 0));

  const s4411 = solde("4411");
  const dettes = du(ff as any[]);
  const marque = (ok: boolean) => (ok ? "✅" : "❌");
  console.log(`\n${d.nom_societe}`);
  console.log(`  ${marque(Math.abs(s4411 - dettes) <= 0.005)} 4411 créditeur ${fmt(s4411)} ⇄ dettes fournisseurs ${fmt(dettes)}`
    + (Math.abs(s4411 - dettes) > 0.005 ? ` — écart ${fmt(r2(s4411 - dettes))}` : ""));
  const s342 = r2(-solde("342"));
  const creances = du(fc as any[]);
  console.log(`  ${marque(Math.abs(s342 - creances) <= 0.005)} 342x débiteur ${fmt(s342)} ⇄ créances clients ${fmt(creances)}`
    + (Math.abs(s342 - creances) > 0.005 ? ` — écart ${fmt(r2(s342 - creances))}` : ""));
  const ecart = r2(lignes.reduce((s, l) => s + n(l.debit) - n(l.credit), 0));
  console.log(`  ${marque(Math.abs(ecart) <= 0.005)} partie double du dossier : écart ${fmt(ecart)} MAD`);
}

console.log(`\n═══ BILAN ═══`);
console.log(`  écritures ${APPLY ? "créées" : "à créer"} : ${APPLY ? creees : "—"}`);
console.log(`  dates de règlement ${APPLY ? "corrigées" : "à corriger"} : ${datesCorrigees || "—"}`);
if (refusees) console.log(`  ⛔ ${refusees} règlement(s) refusé(s) — voir le détail ci-dessus.`);
if (!APPLY) console.log("\n  Rien n'a été écrit. Relancer avec --apply pour appliquer.");
console.log("");
