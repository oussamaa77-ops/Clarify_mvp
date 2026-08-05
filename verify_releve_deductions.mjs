// verify_releve_deductions.mjs — LECTURE SEULE. Génère le relevé des déductions
// SIMPL-TVA sur le dossier réel le plus fourni en achats et contrôle :
//   • les 14 colonnes DGI, dans l'ordre ;
//   • une ligne par règlement (échelonné → plusieurs lignes) ;
//   • Σ des lignes = TVA déductible calculée par l'onglet TVA (aucune fuite).
//
// Lancement :  node --import tsx verify_releve_deductions.mjs

import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  COLONNES_RELEVE_DEDUCTIONS, construireReleveDeductions, indexerComptesCharge,
  ligneVersCellules, totauxReleveDeductions,
} from "./src/lib/releve-deductions.ts";
import { indexerModesPaiement } from "./src/lib/mode-paiement.ts";
import { synthetiserTva } from "./src/lib/dashboard-fiscal.ts";

const env = Object.fromEntries(
  fs.readFileSync(new URL(".env", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);
let PROXY_DIRECT = false;
async function proxyFetch(input, init) {
  const direct = async () => {
    const { fetch: uf, Agent } = await import("undici");
    return uf(String(input), { ...init, dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) });
  };
  if (PROXY_DIRECT) return direct();
  try { return await fetch(String(input), init); }
  catch { PROXY_DIRECT = true; return direct(); }
}
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { global: { fetch: proxyFetch } });

let pass = 0, fail = 0, warn = 0;
const check = (label, cond, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  cond ? pass++ : fail++;
};
// Qualité des DONNÉES saisies : signalé sans faire échouer la sonde, dont l'objet
// est de valider le GÉNÉRATEUR. Aucun code ne peut inventer un IF absent en base.
const donnees = (label, cond, detail = "") => {
  console.log(`  ${cond ? "✅" : "⚠️ "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (cond) pass++; else warn++;
};

(async () => {
  const { data: tous } = await sb.from("factures_fournisseurs").select("dossier_id").limit(5000);
  const compte = new Map();
  for (const f of tous ?? []) compte.set(f.dossier_id, (compte.get(f.dossier_id) ?? 0) + 1);
  const [dossierId, nb] = [...compte.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (!dossierId) { console.log("⛔ Aucune facture fournisseur en base."); process.exit(4); }
  const { data: dos } = await sb.from("dossiers").select("nom_societe").eq("id", dossierId).single();
  console.log(`Dossier : « ${dos?.nom_societe} » — ${nb} facture(s) d'achat\n`);

  const [achats, paiements, fournisseurs, tx, enc, ecr, pcm] = await Promise.all([
    sb.from("factures_fournisseurs")
      .select("id,numero,fournisseur_id,fournisseur_nom,montant_ht,montant_tva,montant_ttc,montant_paye,montant_restant,statut_paiement,date_facture,date_paiement,mode_reglement,lignes")
      .eq("dossier_id", dossierId),
    sb.from("paiements").select("facture_id,facture_fournisseur_id,montant,date_paiement").eq("dossier_id", dossierId),
    sb.from("fournisseurs").select("id,nom,ice,if_fiscal").eq("dossier_id", dossierId),
    sb.from("transactions_bancaires").select("facture_id,document_type,libelle,reference").eq("dossier_id", dossierId).not("facture_id", "is", null),
    sb.from("encaissements").select("facture_fournisseur_id,type").eq("dossier_id", dossierId).not("facture_fournisseur_id", "is", null),
    sb.from("ecritures_comptables").select("compte_numero,reference_piece,debit").eq("dossier_id", dossierId).like("compte_numero", "6%"),
    sb.from("pcm_reference").select("numero,intitule").like("numero", "6%"),
  ]);
  for (const [nom, r] of [["factures_fournisseurs", achats], ["paiements", paiements], ["fournisseurs", fournisseurs], ["transactions_bancaires", tx], ["encaissements", enc], ["ecritures_comptables", ecr], ["pcm_reference", pcm]]) {
    check(`lecture ${nom}`, !r.error, r.error?.message ?? `${r.data?.length ?? 0} ligne(s)`);
  }

  const lignes = construireReleveDeductions({
    achats: achats.data ?? [],
    paiements: paiements.data ?? [],
    fournisseurs: fournisseurs.data ?? [],
    modes: indexerModesPaiement("fournisseur", { transactions: tx.data ?? [], encaissements: enc.data ?? [] }),
    comptesCharge: indexerComptesCharge(ecr.data ?? []),
    intitulesPcm: Object.fromEntries((pcm.data ?? []).map((c) => [c.numero, c.intitule])),
  });
  const totaux = totauxReleveDeductions(lignes);

  console.log(`\nRelevé généré : ${totaux.lignes} ligne(s)`);
  if (!lignes.length) {
    console.log("  (aucun achat réglé soumis à TVA — rien à déclarer)");
  } else {
    console.log(`\n  ${COLONNES_RELEVE_DEDUCTIONS.join(" | ")}`);
    for (const l of lignes.slice(0, 10)) console.log(`  ${ligneVersCellules(l).join(" | ")}`);
    if (lignes.length > 10) console.log(`  … et ${lignes.length - 10} ligne(s) de plus`);
    console.log(`\n  TOTAUX  HT ${totaux.totalHt.toFixed(2)} · TVA ${totaux.totalTva.toFixed(2)} · TTC ${totaux.totalTtc.toFixed(2)}`);
    check("chaque ligne porte 14 cellules", lignes.every((l) => ligneVersCellules(l).length === 14));
    check("n° d'ordre continus de 1 à n", lignes.every((l, i) => l.ordre === i + 1));
    check("prorata à 100 sur toutes les lignes", lignes.every((l) => l.prorata === 100));
    check("mode de paiement dans la nomenclature DGI (1..7)",
      lignes.every((l) => Number.isInteger(l.idModePaiement) && l.idModePaiement >= 1 && l.idModePaiement <= 7));
    check("dates au format AAAA-MM-JJ", lignes.every((l) => /^\d{4}-\d{2}-\d{2}$/.test(l.datePaiement)));
    check("aucun montant négatif", lignes.every((l) => l.montantHt >= 0 && l.montantTva >= 0 && l.montantTtc >= 0));
    // Les 3 colonnes que la DGI refuse vides sur une ligne payée.
    check("désignation renseignée sur TOUTES les lignes", lignes.every((l) => l.designation.trim().length > 0),
      `${lignes.filter((l) => !l.designation.trim()).length} vide(s)`);
    const sansIce = lignes.filter((l) => !l.iceFournisseur);
    const sansIf = lignes.filter((l) => !l.ifFournisseur);
    donnees("ICE renseigné sur toutes les lignes", sansIce.length === 0,
      sansIce.length ? sansIce.map((l) => l.nomFournisseur).join(", ") : "OK");
    donnees("IF renseigné sur toutes les lignes", sansIf.length === 0,
      sansIf.length ? `à compléter dans l'annuaire : ${sansIf.map((l) => l.nomFournisseur).join(", ")}` : "OK");

    // ── L'identité portée au relevé est bien CELLE DE L'ANNUAIRE ───────────────
    // Non-vide ne suffit pas : la colonne doit reprendre la valeur saisie sur la
    // fiche. On rejoue la résolution à l'envers, depuis les fiches, et on exige
    // que toute valeur présente dans l'annuaire ressorte dans le fichier.
    const fiches = fournisseurs.data ?? [];
    const norm = (v) => String(v ?? "").trim().toUpperCase().replace(/\s+/g, " ");
    const perdus = [];
    for (const l of lignes) {
      const fiche = fiches.find((t) => norm(t.nom) === norm(l.nomFournisseur));
      if (!fiche) continue;
      if (String(fiche.ice ?? "").trim() && !l.iceFournisseur) perdus.push(`${l.nomFournisseur} : ICE`);
      if (String(fiche.if_fiscal ?? "").trim() && !l.ifFournisseur) perdus.push(`${l.nomFournisseur} : IF`);
    }
    check("aucune valeur de l'annuaire perdue en route (ICE/IF)", perdus.length === 0,
      perdus.join(", ") || `${fiches.length} fiche(s) confrontée(s)`);

    // ── RÉGRESSION : le générateur n'invente pas la clé de rattachement ────────
    // La panne constatée en production ne venait pas d'ici mais de l'APPELANT :
    // l'onglet Fiscalité chargeait les achats pour le seul calcul de la TVA, avec
    // un select réduit aux montants — donc sans `fournisseur_id` ni
    // `fournisseur_nom`. Privée de clé, la jointure ne trouvait rien et les trois
    // colonnes partaient vides malgré un annuaire complet. On fige le constat :
    // toute lecture d'achats qui omet ces deux colonnes vide le relevé.
    const achatsSansLien = (achats.data ?? []).map(({ fournisseur_id, fournisseur_nom, ...reste }) => reste);
    const degrade = construireReleveDeductions({
      achats: achatsSansLien,
      paiements: paiements.data ?? [],
      fournisseurs: fiches,
    });
    const encoreIdentifiees = degrade.filter((l) => l.iceFournisseur || l.ifFournisseur || l.nomFournisseur);
    check("témoin : sans fournisseur_id/nom, l'identité est bien perdue",
      degrade.length > 0 && encoreIdentifiees.length === 0,
      `${encoreIdentifiees.length}/${degrade.length} ligne(s) encore identifiée(s)`);
    if (sansIf.length) {
      const manquants = [...new Set(sansIf.map((l) => l.nomFournisseur))];
      console.log(`\n  ⚠️  ACTION REQUISE avant dépôt SIMPL : renseigner l'IF de ${manquants.length} fournisseur(s)`);
      console.log(`      dans Fournisseurs → fiche → « IF ». Le générateur reprendra la valeur automatiquement.`);
    }
    if (totaux.sansReglementDate) {
      console.log(`  ⚠️  ${totaux.sansReglementDate} ligne(s) datée(s) d'après la facture (règlement non lettré)`);
    }
  }

  // Cohérence avec l'onglet TVA : le relevé détaille EXACTEMENT la TVA déductible.
  const s = synthetiserTva([], achats.data ?? [], { paiements: paiements.data ?? [] });
  check("Σ TVA du relevé = TVA déductible de l'onglet TVA",
    Math.abs(totaux.totalTva - s.deductible) < 0.05,
    `relevé ${totaux.totalTva.toFixed(2)} vs onglet ${s.deductible.toFixed(2)}`);

  console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} succès, ${fail} échec(s)${warn ? `, ${warn} donnée(s) à compléter` : ""}`);
  process.exit(fail === 0 ? 0 : 1);
})();
