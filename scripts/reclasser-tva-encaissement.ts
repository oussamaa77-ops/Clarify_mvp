/**
 * reclasser-tva-encaissement.ts — script ONE-SHOT de passage de la TVA du
 * régime des DÉBITS au régime des ENCAISSEMENTS sur l'historique.
 *
 * Contexte : jusqu'au 2026-08-05, la TVA était portée dès la FACTURATION sur
 * 44551 (ventes) et 34552 (achats) — donc réputée exigible avant tout
 * encaissement. Le module de lettrage la fait désormais transiter par un compte
 * d'ATTENTE (4458 / 3458), d'où elle ne bascule qu'au règlement.
 *
 * Ce script reclasse l'historique des pièces ENCORE NON RÉGLÉES :
 *
 *      VENTE non encaissée   :  D 44551  →  C 4458
 *      ACHAT non décaissé    :  C 34552  →  D 3458
 *
 * Les pièces DÉJÀ réglées ne sont pas touchées : leur TVA est effectivement
 * exigible, elle est donc au bon endroit. Les reclasser puis les rebasculer ne
 * ferait qu'ajouter du bruit dans les journaux pour un solde identique.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   node --import tsx scripts/reclasser-tva-encaissement.ts                # DRY-RUN
 *   node --import tsx scripts/reclasser-tva-encaissement.ts --apply        # écrit
 *   node --import tsx scripts/reclasser-tva-encaissement.ts --dossier="ACME"
 *   node --import tsx scripts/reclasser-tva-encaissement.ts --rollback=backup.json
 *
 * ─── Sûreté ──────────────────────────────────────────────────────────────────
 * On ne SUPPRIME ni ne MODIFIE aucune écriture d'origine : le reclassement se
 * fait par une OD de virement compte à compte, qui laisse la piste d'audit
 * intacte et se relit dans le grand livre. Le rollback supprime ces OD, repérées
 * par leur référence `RECLASS-TVA-<horodatage>`.
 *
 * Idempotence : une pièce dont la TVA est déjà en attente (solde du compte
 * d'attente ≥ TVA de la pièce) est ignorée. Relancer le script ne double donc
 * jamais le virement.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { COMPTES_TVA, referenceReclassement, referenceSansPrefixe } from "../src/services/lettrage";
import { normaliserComptesLignes } from "../src/lib/numero-compte";

// ─── Environnement (.env à la racine) ────────────────────────────────────────
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
});

// ─── Arguments ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const lire = (nom: string): string | null => {
  const a = args.find((x) => x.startsWith(`--${nom}=`));
  return a ? a.slice(nom.length + 3).replace(/^["']|["']$/g, "") : null;
};
const APPLY = args.includes("--apply");
const DOSSIER = lire("dossier");
const ROLLBACK = lire("rollback");

const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const round2 = (x: number) => Math.round(x * 100) / 100;
const fmt = (x: number) => x.toLocaleString("fr-MA", { minimumFractionDigits: 2 });

// Comptes historiques du régime des débits → comptes d'attente correspondants.
const RECLASSEMENTS = [
  {
    sens: "client" as const, libelle: "Ventes",
    source: "44551", cible: COMPTES_TVA.client.attente,
    table: "factures", colonneRef: "facture_id",
  },
  {
    sens: "fournisseur" as const, libelle: "Achats",
    source: "34552", cible: COMPTES_TVA.fournisseur.attente,
    table: "factures_fournisseurs", colonneRef: "reference_piece",
  },
];

async function rollback(fichier: string) {
  const sauvegarde = JSON.parse(fs.readFileSync(fichier, "utf8")) as { reference: string; ids: string[] };
  console.log(`↩️  Rollback de ${sauvegarde.ids.length} écriture(s) — référence ${sauvegarde.reference}`);
  if (!APPLY) { console.log("   (DRY-RUN : ajoutez --apply pour exécuter)"); return; }
  const { error } = await (sb as any).from("ecritures_comptables").delete().in("id", sauvegarde.ids);
  if (error) { console.error("❌", error.message); process.exit(1); }
  console.log("✅ Écritures de reclassement supprimées.");
}

async function principal() {
  if (ROLLBACK) return rollback(ROLLBACK);

  console.log(`\n${APPLY ? "⚙️  APPLICATION" : "🔍 DRY-RUN"} — reclassement TVA vers le régime des encaissements\n`);

  // Dossiers ciblés.
  let qDossiers = (sb as any).from("dossiers").select("id,nom_societe");
  if (DOSSIER) qDossiers = qDossiers.ilike("nom_societe", `%${DOSSIER}%`);
  const { data: dossiers, error: eDos } = await qDossiers;
  if (eDos) { console.error("❌ Lecture des dossiers :", eDos.message); process.exit(1); }
  if (!dossiers?.length) { console.log("Aucun dossier correspondant."); return; }

  const reference = `RECLASS-TVA-${new Date().toISOString().slice(0, 19).replace(/[:T-]/g, "")}`;
  const aInserer: any[] = [];
  let totalPieces = 0;

  for (const d of dossiers as any[]) {
    for (const regle of RECLASSEMENTS) {
      // 1) Pièces NON RÉGLÉES du dossier : seules elles doivent repasser en attente.
      const { data: factures } = await (sb as any).from(regle.table)
        .select("id,numero,montant_tva,statut_paiement,montant_paye,montant_ttc")
        .eq("dossier_id", d.id).neq("statut_paiement", "payee");
      if (!factures?.length) continue;

      // Référence utilisée par les écritures : le numéro si présent, sinon l'id
      // (c'est la convention des insertions de factures.functions.ts).
      const refsPiece = new Map<string, any>();
      for (const f of factures as any[]) {
        refsPiece.set(String(f.numero ?? f.id), f);
        refsPiece.set(String(f.id), f);
      }

      // 2) Écritures de TVA encore sur le compte du régime des débits.
      const { data: ecr } = await (sb as any).from("ecritures_comptables")
        .select("id,compte_numero,debit,credit,date_ecriture,reference_piece,libelle")
        .eq("dossier_id", d.id).eq("compte_numero", regle.source);
      if (!ecr?.length) continue;

      // 3) Solde déjà présent en attente, par pièce → idempotence.
      const { data: dejaAttente } = await (sb as any).from("ecritures_comptables")
        .select("reference_piece,debit,credit")
        .eq("dossier_id", d.id).eq("compte_numero", regle.cible);
      const attenteParRef = new Map<string, number>();
      for (const a of (dejaAttente ?? []) as any[]) {
        // Clé NORMALISÉE : le reclassement porte « RECLASS-TVA-<ref> » alors que
        // la recherche se fait sous « <ref> ». Sans retirer le préfixe, aucune
        // ligne d'attente ne serait retrouvée et le script reclasserait une
        // seconde fois ce qui l'est déjà — il perdrait son idempotence.
        const k = referenceSansPrefixe(a.reference_piece);
        const v = regle.sens === "client" ? n(a.credit) - n(a.debit) : n(a.debit) - n(a.credit);
        attenteParRef.set(k, (attenteParRef.get(k) ?? 0) + v);
      }

      for (const e of ecr as any[]) {
        const ref = String(e.reference_piece ?? "");
        const piece = refsPiece.get(ref);
        if (!piece) continue;                       // pièce réglée ou hors périmètre

        // Montant encore sur le compte source pour cette pièce.
        const montant = regle.sens === "client" ? n(e.credit) - n(e.debit) : n(e.debit) - n(e.credit);
        if (montant <= 0.005) continue;

        // Déjà (partiellement) en attente → ne virer que le complément.
        const dejaLa = attenteParRef.get(ref) ?? 0;
        const aVirer = round2(montant - Math.max(0, dejaLa));
        if (aVirer <= 0.005) continue;

        totalPieces++;
        const commun = {
          dossier_id: d.id,
          journal_code: "OD",
          date_ecriture: e.date_ecriture,
          libelle: `Reclassement TVA régime encaissements ${piece.numero ?? ref}`.slice(0, 200),
          // Référence PROPRE (RECLASS-TVA-<ref>), pas celle de la facture. Avec
          // la référence de la pièce, cette OD était indiscernable d'une bascule
          // au règlement — mêmes comptes, pas de code, même référence — et une
          // annulation de paiement l'a mutilée (FAC-2024-307). Le préfixe
          // conserve la référence d'origine : `referencesPiece` la retrouve,
          // donc la TVA reste visible en attente. Cf. src/services/lettrage.ts.
          reference_piece: referenceReclassement(ref),
          valide: true,
        };
        // Vente : on DÉBITE 44551 (annule la collecte) et on CRÉDITE 4458.
        // Achat : on CRÉDITE 34552 (annule la déduction) et on DÉBITE 3458.
        aInserer.push(
          regle.sens === "client"
            ? { ...commun, compte_numero: regle.source, debit: aVirer, credit: 0 }
            : { ...commun, compte_numero: regle.source, debit: 0, credit: aVirer },
          regle.sens === "client"
            ? { ...commun, compte_numero: regle.cible, debit: 0, credit: aVirer }
            : { ...commun, compte_numero: regle.cible, debit: aVirer, credit: 0 },
        );

        console.log(
          `  ${d.nom_societe} · ${regle.libelle} · ${piece.numero ?? ref} : ` +
          `${regle.source} → ${regle.cible}  ${fmt(aVirer)} MAD`,
        );
      }
    }
  }

  const totalMontant = round2(aInserer.reduce((s, l) => s + n(l.debit), 0));
  console.log(`\n── Récapitulatif ──`);
  console.log(`  ${totalPieces} pièce(s) non réglée(s) à reclasser`);
  console.log(`  ${aInserer.length} écriture(s) d'OD à créer — ${fmt(totalMontant)} MAD virés en attente`);

  if (!aInserer.length) { console.log("\n✅ Rien à reclasser : l'historique est déjà au régime des encaissements."); return; }
  if (!APPLY) {
    console.log(`\n🔍 DRY-RUN — aucune écriture créée. Relancez avec --apply pour exécuter.`);
    return;
  }

  const { data: inserees, error } = await (sb as any)
    .from("ecritures_comptables").insert(normaliserComptesLignes(aInserer)).select("id");
  if (error) { console.error("\n❌ Insertion impossible :", error.message); process.exit(1); }

  // Sauvegarde ÉCRITE APRÈS l'insertion : elle porte les ids réellement créés,
  // seule information dont le rollback a besoin.
  const fichier = path.join(RACINE, `backup_reclass_tva_${reference}.json`);
  fs.writeFileSync(fichier, JSON.stringify({
    reference, date: new Date().toISOString(),
    ids: ((inserees ?? []) as any[]).map((r) => r.id),
  }, null, 2));

  console.log(`\n✅ ${inserees?.length ?? 0} écriture(s) créée(s).`);
  console.log(`   Sauvegarde : ${path.basename(fichier)}`);
  console.log(`   Rollback   : node --import tsx scripts/reclasser-tva-encaissement.ts --rollback=${path.basename(fichier)} --apply`);
}

principal().catch((e) => { console.error("❌", e); process.exit(1); });
