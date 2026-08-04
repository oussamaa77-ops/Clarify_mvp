// verify_fiscalite.mjs — vérifie que la migration 20260804120000
// (paramètres fiscaux du dossier) est bien en base ET que le module Fiscalité
// s'appuie dessus correctement :
//
//   ① les 5 colonnes existent et sont LISIBLES (select nommé → échoue si absente)
//   ② elles sont ÉDITABLES (update réel, comme le dialogue « Paramètres fiscaux »)
//   ③ les contraintes CHECK rejettent bien les valeurs illégales
//   ④ lireParametresFiscaux() lit la vraie ligne, puis calculerIS/calculerTP
//      produisent les exonérations attendues (1er exercice, CM 36 mois, TP 5 ans)
//   ⑤ l'onglet TVA lit factures + factures_fournisseurs + paiements et
//      synthetiserTva rattache la TVA au mois d'encaissement
//
// Les valeurs d'origine du dossier sont sauvegardées et RESTAURÉES en fin de test.
//
// Lancement :  node --import tsx verify_fiscalite.mjs   (SERVICE_ROLE_KEY)

import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  lireParametresFiscaux, calculerIS, calculerTP, statutTva,
} from "./src/lib/fiscalite-ma.ts";
import { synthetiserTva, periodesTva } from "./src/lib/dashboard-fiscal.ts";

const env = Object.fromEntries(
  fs.readFileSync(new URL(".env", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);
// fetch tolérant au proxy TLS d'entreprise (cf. proxy-supabase-server) : repli undici.
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

let pass = 0, fail = 0;
const check = (label, cond, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  cond ? pass++ : fail++;
};

const COLONNES = "id,nom_societe,date_debut_activite,valeur_locative_tp,classe_tp,taux_cm,regime_is";

(async () => {
  // ── ① Colonnes présentes et lisibles ──────────────────────────────────────
  console.log("① Lecture des colonnes (select nommé — échoue si une colonne manque) :");
  const probe = await sb.from("dossiers").select(COLONNES).limit(1);
  if (probe.error) {
    console.log(`  ❌ ${probe.error.message}`);
    console.log("\n⛔ La migration 20260804120000 n'est PAS appliquée (ou partiellement).");
    process.exit(3);
  }
  check("les 5 colonnes fiscales sont lisibles", true, COLONNES);

  const { data: dossiers } = await sb.from("dossiers").select(COLONNES).order("created_at").limit(50);
  if (!dossiers?.length) { console.log("\n⛔ Aucun dossier en base."); process.exit(4); }
  const cible = dossiers[0];
  console.log(`\n② Dossier de test : « ${cible.nom_societe} » (${cible.id})`);

  const backup = {
    date_debut_activite: cible.date_debut_activite ?? null,
    valeur_locative_tp: cible.valeur_locative_tp ?? null,
    classe_tp: cible.classe_tp ?? null,
    taux_cm: cible.taux_cm ?? null,
    regime_is: cible.regime_is ?? null,
  };
  console.log(`   valeurs d'origine : ${JSON.stringify(backup)}`);
  const restore = () => sb.from("dossiers").update(backup).eq("id", cible.id);

  try {
    // ── ③ Écriture — le chemin exact du dialogue « Paramètres fiscaux » ─────
    console.log("\n③ Écriture (update), comme le dialogue de la page Fiscalité :");
    const T = {
      date_debut_activite: "2026-03-01",   // 1er exercice = 2026
      valeur_locative_tp: 120000,
      classe_tp: 2,                        // 20 %
      regime_is: "droit_commun",
    };
    const u = await sb.from("dossiers").update(T).eq("id", cible.id);
    check("update des 4 paramètres", !u.error, u.error?.message ?? JSON.stringify(T));

    // ── ④ Relecture — la valeur a bien été persistée ────────────────────────
    console.log("\n④ Relecture après écriture :");
    const { data: relu } = await sb.from("dossiers").select(COLONNES).eq("id", cible.id).single();
    check("date_debut_activite", String(relu.date_debut_activite).slice(0, 10) === T.date_debut_activite, String(relu.date_debut_activite));
    check("valeur_locative_tp", Number(relu.valeur_locative_tp) === T.valeur_locative_tp, String(relu.valeur_locative_tp));
    check("classe_tp", Number(relu.classe_tp) === T.classe_tp, String(relu.classe_tp));
    check("regime_is", relu.regime_is === T.regime_is, String(relu.regime_is));

    // ── ⑤ Contraintes CHECK ────────────────────────────────────────────────
    console.log("\n⑤ Contraintes CHECK (les valeurs illégales doivent être REJETÉES) :");
    const bad1 = await sb.from("dossiers").update({ classe_tp: 9 }).eq("id", cible.id);
    check("classe_tp = 9 rejetée", !!bad1.error, bad1.error?.message ?? "ACCEPTÉE (contrainte absente !)");
    const bad2 = await sb.from("dossiers").update({ regime_is: "n_importe_quoi" }).eq("id", cible.id);
    check("regime_is invalide rejeté", !!bad2.error, bad2.error?.message ?? "ACCEPTÉ (contrainte absente !)");

    // ── ⑥ Le module lit la vraie ligne et applique les bonnes règles ────────
    console.log("\n⑥ Règles fiscales appliquées à la ligne réelle (lireParametresFiscaux) :");
    const p = lireParametresFiscaux(relu);
    check("paramètres décodés", p.dateDebutActivite === "2026-03-01" && p.valeurLocative === 120000 && p.classeTP === 2, JSON.stringify(p));

    // Exercice 2026 = 1er exercice → dispense d'acomptes + exonération de CM.
    const is2026 = calculerIS({
      exercice: 2026, resultatFiscal: 800000, baseCotisationMinimale: 4000000,
      dateDebutActivite: p.dateDebutActivite, isDuExercicePrecedent: 999999,
      tauxCotisationMinimale: p.tauxCM ?? undefined, regime: p.regimeIS,
    });
    check("1er exercice → acomptes dispensés", is2026.acomptes.dus === false && is2026.acomptes.total === 0, is2026.acomptes.motif);
    check("1er exercice → CM exonérée", is2026.cotisationMinimale.applicable === false, is2026.cotisationMinimale.motif);
    check("IS 2026 = 800 000 × 20 % (LF 2026)", is2026.isDu === 160000, `${is2026.isDu} MAD`);

    // Exercice 2027 : acomptes dus, assis sur l'IS 2026.
    const is2027 = calculerIS({
      exercice: 2027, resultatFiscal: 1000000, baseCotisationMinimale: 5000000,
      dateDebutActivite: p.dateDebutActivite, isDuExercicePrecedent: is2026.isDu,
      tauxCotisationMinimale: p.tauxCM ?? undefined, regime: p.regimeIS,
    });
    check("2027 → acomptes dus sur l'IS 2026", is2027.acomptes.dus && is2027.acomptes.base === 160000, `4 × ${is2027.acomptes.montantUnitaire} MAD`);
    check("2027 → reliquat = 200 000 − 160 000", is2027.isAPayer === 40000, `${is2027.isAPayer} MAD`);

    // TP : exonérée jusqu'en 2030, due en 2031 sur la valeur locative (jamais le CA).
    const tp2026 = calculerTP({ exercice: 2026, valeurLocative: p.valeurLocative, classe: p.classeTP, dateDebutActivite: p.dateDebutActivite });
    const tp2031 = calculerTP({ exercice: 2031, valeurLocative: p.valeurLocative, classe: p.classeTP, dateDebutActivite: p.dateDebutActivite });
    check("TP 2026 exonérée (5 premières années)", tp2026.exonere && tp2026.montant === 0, tp2026.motif);
    check("TP 2031 = 120 000 × 20 %", !tp2031.exonere && tp2031.montant === 24000, `${tp2031.montant} MAD`);

    // Statut spécifique : 20 % maintenu au-delà de 100 MDH.
    const uSpec = await sb.from("dossiers").update({ regime_is: "taux_specifique" }).eq("id", cible.id);
    check("bascule en régime taux_specifique", !uSpec.error, uSpec.error?.message ?? "ok");
    const { data: reluSpec } = await sb.from("dossiers").select(COLONNES).eq("id", cible.id).single();
    const pSpec = lireParametresFiscaux(reluSpec);
    const isGrand = calculerIS({
      exercice: 2031, resultatFiscal: 120000000, baseCotisationMinimale: 400000000,
      dateDebutActivite: pSpec.dateDebutActivite, regime: pSpec.regimeIS,
    });
    check("statut spécifique → 20 % au-delà de 100 MDH", isGrand.tranche.taux === 0.20, `${isGrand.isTheorique} MAD`);

    // ── ⑦ Onglet TVA : les 3 tables réelles + régime de l'encaissement ──────
    console.log("\n⑦ Onglet TVA — lecture réelle des 3 tables :");
    const [v, a, pay] = await Promise.all([
      sb.from("factures").select("id,statut,statut_paiement,montant_ht,montant_tva,montant_ttc,montant_paye,montant_restant,type,date_facture,date_echeance").eq("dossier_id", cible.id),
      sb.from("factures_fournisseurs").select("id,statut_paiement,montant_ht,montant_tva,montant_ttc,montant_paye,montant_restant,date_facture,date_echeance").eq("dossier_id", cible.id),
      sb.from("paiements").select("facture_id,facture_fournisseur_id,montant,date_paiement").eq("dossier_id", cible.id),
    ]);
    check("select factures", !v.error, v.error?.message ?? `${v.data?.length ?? 0} ligne(s)`);
    check("select factures_fournisseurs", !a.error, a.error?.message ?? `${a.data?.length ?? 0} ligne(s)`);
    // La table `paiements` peut ne pas exister : le module doit alors se replier.
    if (pay.error) console.log(`  ⚠️  paiements indisponible (${pay.error.message}) → repli sur la date de facture`);
    else check("select paiements", true, `${pay.data?.length ?? 0} règlement(s) daté(s)`);

    const ventes = (v.data ?? []).filter((f) => f.statut !== "rejetee");
    const achats = a.data ?? [];
    const paiements = pay.data ?? [];
    const s = synthetiserTva(ventes, achats, { paiements });
    check("synthetiserTva s'exécute sur les données réelles", Number.isFinite(s.nette),
      `collectée ${s.collectee} / déductible ${s.deductible} / nette ${s.nette} (${statutTva(s.nette).label})`);
    console.log(`     couverture par règlements datés : ${Math.round(s.couverture * 100)} %`);
    const mois = periodesTva(ventes, achats, paiements);
    console.log(`     mois d'exigibilité détectés : ${mois.length ? mois.join(", ") : "aucun"}`);

    // Cohérence : la somme des mois doit égaler le total toutes périodes.
    if (mois.length) {
      const somme = mois.reduce((acc, m) => {
        const bornes = { debut: `${m}-01`, fin: `${m}-31` };
        return acc + synthetiserTva(ventes, achats, { ...bornes, paiements }).collectee;
      }, 0);
      check("Σ des mois = total collecté (aucune TVA perdue)", Math.abs(somme - s.collectee) < 0.05,
        `Σ ${somme.toFixed(2)} vs total ${s.collectee.toFixed(2)}`);
    }
  } finally {
    // ── ⑧ Restauration ─────────────────────────────────────────────────────
    console.log("\n⑧ Restauration des valeurs d'origine :");
    const r = await restore();
    const { data: apres } = await sb.from("dossiers").select(COLONNES).eq("id", cible.id).single();
    const identique = ["date_debut_activite", "valeur_locative_tp", "classe_tp", "taux_cm", "regime_is"]
      .every((c) => String(apres?.[c] ?? null) === String(backup[c] ?? null));
    check("dossier restauré", !r.error && identique, JSON.stringify(backup));
  }

  console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} succès, ${fail} échec(s)`);
  process.exit(fail === 0 ? 0 : 1);
})();
