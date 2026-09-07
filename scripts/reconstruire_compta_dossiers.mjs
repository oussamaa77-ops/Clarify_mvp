/**
 * reconstruire_compta_dossiers.mjs — remise à niveau du GRAND LIVRE de TOUS les
 * dossiers sous le régime des ENCAISSEMENTS.
 *
 * Purge les écritures AUTOMATIQUES des journaux VTE, ACH et les OD de bascule de
 * TVA, puis les régénère avec le générateur corrigé (src/lib/genererEcritures.ts) :
 *
 *   VENTE   D 3421x TTC / C 7xxx HT / C 4458 TVA        (jamais 44551)
 *   ACHAT   D 6xxx HT   / D 3458 TVA / C 4411x TTC      (jamais 34552)
 *   OD_TVA  bascule au RÈGLEMENT seulement, au prorata encaissé/décaissé
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   node --import tsx scripts/reconstruire_compta_dossiers.mjs            # DRY-RUN
 *   node --import tsx scripts/reconstruire_compta_dossiers.mjs --apply    # écrit
 *   node --import tsx scripts/reconstruire_compta_dossiers.mjs --dossier="<nom|uuid>"
 *   node --import tsx scripts/reconstruire_compta_dossiers.mjs --sans-tva  # garde les OD
 *   node --import tsx scripts/reconstruire_compta_dossiers.mjs --rollback=backup.json
 *
 * `--import tsx` est OBLIGATOIRE : ce script importe le générateur TypeScript
 * plutôt que d'en recopier les règles. Une seconde implémentation en JS pur
 * divergerait au premier correctif — et c'est précisément la divergence entre le
 * code et les scripts de reprise que ce chantier corrige.
 *
 * ─── Sûreté ──────────────────────────────────────────────────────────────────
 * SANS `--apply`, RIEN n'est écrit : le script compte, compare et rapporte.
 *
 * PostgREST n'expose pas de transaction multi-requêtes. La réversibilité est
 * donc assurée par un fichier `backup_reconstruction_<date>.json` écrit AVANT la
 * première suppression, contenant les lignes supprimées EN ENTIER et rejouable
 * par `--rollback`. On écrit la sauvegarde avant de toucher à quoi que ce soit :
 * un script de reprise qui perd les données qu'il devait réparer est pire que
 * pas de script du tout.
 *
 * ─── Repasse trésorerie (OD → BQ/CAI) ────────────────────────────────────────
 * Le script DÉPLACE aussi, par pièce entière, les OD qui portent de la trésorerie
 * 5141/5161 — typiquement les paiements de TVA écrits avant la correction de
 * `construireOdPaiementDgi`. Un décaissement rangé en OD échappe au rapprochement
 * bancaire. Ces pièces n'étant régénérables depuis aucune facture, seul leur
 * `journal_code` change : comptes et montants restent intacts.
 *
 * ─── Ce que le script NE touche PAS ──────────────────────────────────────────
 * Les journaux BQ, CAI, AN, et les OD qui ne sont pas des bascules de TVA (paie,
 * déclaration périodique, imputation d'acompte, reclassement). Ils ne sont pas
 * régénérables depuis une facture : les supprimer détruirait de l'information
 * que rien ne sait reconstruire.
 *
 * Les écritures MANUELLES non plus. Une écriture est réputée AUTOMATIQUE quand
 * sa `reference_piece` désigne une facture connue du dossier — c'est le seul
 * lien qui permette de la régénérer. Une écriture de journal VTE sans facture en
 * face est laissée telle quelle, et signalée : elle est soit une saisie manuelle
 * légitime, soit une orpheline, et seul un humain peut trancher.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  genererEcrituresVente, genererEcrituresAchat, normaliserTypeVente,
  controlerLignesVente, controlerLignesAchat, controlerUniciteReference,
  controlerCutoffExercice, estTvaExigible, estTresorerieHorsOd,
} from "../src/lib/genererEcritures.ts";
import { journalDeTresorerie } from "../src/lib/comptes-tresorerie.ts";
import { compteVente } from "../src/lib/compte-vente.ts";
import { bornesExercice } from "../src/lib/exercice-comptable.ts";
import {
  grouperOdBascule, PREFIXE_RECLASS_TVA, referenceSansPrefixe,
} from "../src/services/lettrage.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ─── Arguments ───────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (nom) => {
  const hit = argv.find((a) => a === `--${nom}` || a.startsWith(`--${nom}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf("=");
  return eq === -1 ? "" : hit.slice(eq + 1).replace(/^["']|["']$/g, "");
};
const APPLY = flag("apply") !== undefined;
const CIBLE = flag("dossier") || null;
const SANS_TVA = flag("sans-tva") !== undefined;
const ROLLBACK = flag("rollback") || null;

// ─── Connexion Supabase (service_role : le script contourne la RLS) ──────────

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env"), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);

// Le proxy TLS d'entreprise casse le `fetch` global de Node → repli undici
// (cf. mémoire « proxy-supabase-server »).
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
const SUPABASE_URL = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY requis dans .env");
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  global: { fetch: proxyFetch },
  auth: { persistSession: false, autoRefreshToken: false },
});

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const txt = (v) => String(v ?? "").trim();
const mouvementee = (l) => Math.abs(r2(l.debit)) > 0.005 || Math.abs(r2(l.credit)) > 0.005;
const COLS = "id,dossier_id,journal_code,compte_numero,date_ecriture,libelle,debit,credit,reference_piece,lettrage_code,lettrage_date,lettrage_origine,facture_id,valide";

/** Lit une table en entier, par pages : PostgREST plafonne à 1000 lignes. */
async function lireTout(table, select, filtres = (q) => q) {
  const PAGE = 1000;
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await filtres(sb.from(table).select(select)).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table} : ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

// ─── Rollback ────────────────────────────────────────────────────────────────

if (ROLLBACK) {
  const chemin = path.isAbsolute(ROLLBACK) ? ROLLBACK : path.join(ROOT, ROLLBACK);
  const sauvegarde = JSON.parse(fs.readFileSync(chemin, "utf8"));
  const lignes = sauvegarde.supprimees ?? [];
  console.log(`↩️  Restauration de ${lignes.length} écriture(s) depuis ${path.basename(chemin)}`);
  if (!APPLY) {
    console.log("   (DRY-RUN — ajoutez --apply pour écrire)");
    process.exit(0);
  }
  // On restaure d'abord, on retire ensuite ce que la reconstruction avait posé :
  // en cas d'interruption, mieux vaut un doublon visible qu'un trou silencieux.
  for (let i = 0; i < lignes.length; i += 500) {
    const { error } = await sb.from("ecritures_comptables").insert(lignes.slice(i, i + 500));
    if (error) { console.error(`❌ ${error.message}`); process.exit(1); }
  }
  const posees = (sauvegarde.inserees ?? []).map((l) => l.id).filter(Boolean);
  for (let i = 0; i < posees.length; i += 500) {
    await sb.from("ecritures_comptables").delete().in("id", posees.slice(i, i + 500));
  }
  // Les lignes DÉPLACÉES ne sont ni supprimées ni recréées : elles ont gardé leur
  // id et n'ont changé que de journal. Les oublier ici rendrait le rollback
  // trompeur — il annoncerait une restauration complète en laissant la repasse
  // appliquée.
  const deplacees = sauvegarde.deplacees ?? [];
  for (const d of deplacees) {
    const { error } = await sb.from("ecritures_comptables")
      .update({ journal_code: d.avant }).eq("id", d.id);
    if (error) { console.error(`❌ ${error.message}`); process.exit(1); }
  }
  // Idem pour les règlements délettrés : leur code redevient valide dès que les
  // lignes de facture d'origine sont réinsérées, ce que la restauration vient de
  // faire. Les laisser libres casserait le rapprochement qu'on prétend rétablir.
  const delettrees = sauvegarde.delettrees ?? [];
  for (const d of delettrees) {
    const { error } = await sb.from("ecritures_comptables").update({
      lettrage_code: d.lettrage_code,
      lettrage_date: d.lettrage_date ?? null,
      lettrage_origine: d.lettrage_origine ?? null,
    }).eq("id", d.id);
    if (error) { console.error(`❌ ${error.message}`); process.exit(1); }
  }
  console.log(`✅ ${lignes.length} écriture(s) restaurée(s), ${posees.length} régénérée(s) retirée(s),`
    + ` ${deplacees.length} ligne(s) remise(s) dans leur journal d'origine,`
    + ` ${delettrees.length} lettrage(s) rétabli(s).`);
  process.exit(0);
}

// ─── 1. Dossiers ─────────────────────────────────────────────────────────────

console.log(`\n${APPLY ? "🔧 APPLICATION" : "🔍 SIMULATION (dry-run)"} — reconstruction VTE / ACH / OD_TVA\n`);

const dossiers = await lireTout("dossiers", "id,nom_societe,secteur_activite,date_debut_activite", (q) =>
  CIBLE ? (/^[0-9a-f-]{36}$/i.test(CIBLE) ? q.eq("id", CIBLE) : q.ilike("nom_societe", `%${CIBLE}%`)) : q);
if (!dossiers.length) {
  console.error(`❌ Aucun dossier${CIBLE ? ` correspondant à « ${CIBLE} »` : ""}.`);
  process.exit(1);
}
console.log(`${dossiers.length} dossier(s) à traiter.\n`);

const horodatage = new Date().toISOString().replace(/[:.]/g, "-");
const FICHIER_BACKUP = path.join(ROOT, `backup_reconstruction_${horodatage}.json`);
const sauvegarde = { date: new Date().toISOString(), dossiers: [], supprimees: [], inserees: [], deplacees: [], delettrees: [] };

let totalSupprimees = 0, totalInserees = 0, totalRefusees = 0, totalDeplacees = 0, totalDelettrees = 0;
const anomalies = [];

for (const dossier of dossiers) {
  const nom = txt(dossier.nom_societe) || dossier.id;

  const [ecritures, ventes, achats, clients, fournisseurs] = await Promise.all([
    lireTout("ecritures_comptables", COLS, (q) => q.eq("dossier_id", dossier.id)),
    // Colonnes NOMMÉES, et vérifiées contre le schéma réel : un select nommé sur
    // une colonne absente rend `data = null` sans erreur lisible, et le script
    // conclurait « aucune facture » sur un dossier qui en porte cent.
    // `type` (et non `type_facture`) porte acompte / solde ; il n'existe pas de
    // colonne `nature_vente` — le compte de produit se déduit des désignations.
    lireTout("factures",
      "id,numero,date_facture,montant_ht,montant_tva,montant_ttc,statut,type,lignes,client_id",
      (q) => q.eq("dossier_id", dossier.id)),
    lireTout("factures_fournisseurs",
      "id,numero,date_facture,montant_ht,montant_tva,montant_ttc,statut,fournisseur_id,fournisseur_nom",
      (q) => q.eq("dossier_id", dossier.id)),
    lireTout("clients", "id,nom,code_auxiliaire,compte_produit_defaut", (q) => q.eq("dossier_id", dossier.id)),
    lireTout("fournisseurs", "id,nom,code_auxiliaire,compte_charge_defaut", (q) => q.eq("dossier_id", dossier.id)),
  ]);

  const parId = (rows) => new Map(rows.map((r) => [String(r.id), r]));
  const clientsParId = parId(clients);
  const fournisseursParId = parId(fournisseurs);

  // ── Quelles écritures sont AUTOMATIQUES, donc régénérables ? ────────────────
  // Le lien est la `reference_piece` : les ventes estampillent le NUMÉRO, les
  // achats l'ID. Une écriture VTE/ACH dont la référence ne désigne aucune facture
  // du dossier est laissée en place — on ne saurait pas la reconstruire.
  const refsVente = new Map();
  for (const f of ventes) for (const r of [f.numero, f.id]) if (txt(r)) refsVente.set(txt(r), f);
  const refsAchat = new Map();
  for (const f of achats) for (const r of [f.id, f.numero]) if (txt(r)) refsAchat.set(txt(r), f);

  const journal = (l) => txt(l.journal_code).toUpperCase();
  const aPurger = [];
  const orphelines = [];

  for (const l of ecritures) {
    const j = journal(l);
    const ref = txt(l.reference_piece);
    if (j === "VTE" || j === "ACH") {
      const connue = j === "VTE" ? refsVente.has(ref) : refsAchat.has(ref);
      if (connue) aPurger.push(l); else orphelines.push(l);
    }
  }

  // ── OD_TVA : les bascules, et elles seules ─────────────────────────────────
  // `grouperOdBascule` raisonne par ÉCRITURE et distingue une bascule d'un
  // reclassement par le SENS — sans quoi on emporterait le reclassement, la paie
  // et l'OD de déclaration, qui vivent dans le même journal. Le filtre
  // `seulementBascules` est ce qui rend la purge sûre.
  //
  // Les bascules sont régénérées par le RÈGLEMENT, pas par la facture : ce script
  // les supprime, et c'est `comptabiliserReglement` qui les repose au prochain
  // lettrage. On ne les recrée donc pas ici — les recréer sans relire les
  // règlements produirait de la TVA exigible sans encaissement en face.
  const odBascule = SANS_TVA
    ? []
    : grouperOdBascule(ecritures.filter((l) => journal(l) === "OD"), undefined, { seulementBascules: true });

  // ── Les OD de RECLASSEMENT deviennent redondantes ──────────────────────────
  //
  // `RECLASS-TVA-<ref>` a été posée par une migration antérieure pour rattraper
  // les factures qui imputaient la TVA sur 44551/34552 : elle vide le compte
  // exigible et remplit le compte d'attente.
  //
  // La reconstruction fait désormais cela À LA SOURCE — la facture régénérée
  // crédite 4458 directement. Garder le reclassement applique donc la correction
  // DEUX FOIS : 4458 reçoit la TVA de la facture PLUS celle du reclassement, et
  // la bascule, qui lit l'attente, rend exigible le double du dû. Constaté sur
  // ATLAS FAC-2026-088 : 30 800,00 basculés pour 15 400,00 de TVA réelle.
  //
  // On ne les supprime que pour les pièces effectivement RÉGÉNÉRÉES : sur une
  // pièce laissée en place (facture inconnue, saisie manuelle), le reclassement
  // reste la seule chose qui mette sa TVA en attente, et l'ôter la rendrait
  // invisible au règlement.
  const refsRegenerees = new Set([...refsVente.keys(), ...refsAchat.keys()]);
  const odReclassement = SANS_TVA ? [] : ecritures.filter((l) => {
    if (journal(l) !== "OD") return false;
    const ref = txt(l.reference_piece);
    if (!ref.startsWith(PREFIXE_RECLASS_TVA)) return false;
    return refsRegenerees.has(referenceSansPrefixe(ref));
  });

  const odAPurger = ecritures.filter(
    (l) => odBascule.includes(l.id) || odReclassement.includes(l));

  // ── Contrôles de cohérence, AVANT toute écriture ───────────────────────────
  //
  // Le cut-off s'applique ici pièce par pièce, dans l'exercice de LA PIÈCE — et
  // non dans un exercice unique imposé au dossier. Un dossier repris porte
  // légitimement plusieurs exercices (SOMADIR : 2024, 2025 et 2026) ; leur
  // opposer un seul millésime refuserait en bloc tout ce qui n'est pas de cette
  // année-là, et la reconstruction ne régénérerait qu'un exercice sur trois.
  //
  // Ainsi borné, le contrôle garde tout son mordant : il attrape une pièce dont
  // les lignes ne tombent pas dans l'exercice de sa propre date (dates
  // incohérentes) et une pièce antérieure au début d'activité du dossier.
  const bornesDe = (date) => {
    const annee = Number(String(txt(date)).slice(0, 4));
    return Number.isFinite(annee) && annee > 1900
      ? bornesExercice(annee, dossier.date_debut_activite)
      : null;
  };
  const collisions = controlerUniciteReference(ecritures).collisions;
  for (const c of collisions) {
    anomalies.push(`${nom} — référence ${c.reference} présente en ${c.journaux.join(" ET ")}`);
  }
  const tvaExigibleFacturee = ecritures.filter(
    (l) => ["VTE", "ACH"].includes(journal(l)) && estTvaExigible(l.compte_numero)
      && (r2(l.debit) > 0.005 || r2(l.credit) > 0.005));
  if (tvaExigibleFacturee.length) {
    anomalies.push(`${nom} — ${tvaExigibleFacturee.length} ligne(s) de TVA exigible en VTE/ACH (corrigées par la reconstruction)`);
  }

  // ── Régénération ───────────────────────────────────────────────────────────
  const nouvelles = [];
  const refusees = [];

  for (const f of ventes) {
    // Une facture rejetée ou annulée n'a jamais dû produire d'écriture : la purge
    // la retire, et on s'abstient de la recréer.
    if (["rejetee", "annulee", "brouillon"].includes(txt(f.statut).toLowerCase())) continue;

    const client = clientsParId.get(String(f.client_id ?? ""));
    const ref = txt(f.numero) || txt(f.id);
    // Même cascade que la comptabilisation en ligne : le choix EXPLICITE porté
    // sur la fiche client prime, le moteur ne tranche qu'à défaut. L'inverse
    // écraserait l'arbitrage de l'utilisateur à chaque reconstruction.
    const designations = Array.isArray(f.lignes)
      ? f.lignes.map((l) => txt(l?.designation)).filter(Boolean)
      : [];
    const compteProduit = txt(client?.compte_produit_defaut) || compteVente({
      nature: null,
      designations,
      secteur: dossier.secteur_activite ?? null,
    }).compte;
    // Compte de tiers : auxiliaire du client quand il est codé, collectif sinon.
    const compteClient = txt(client?.code_auxiliaire)
      ? `3421${txt(client.code_auxiliaire).replace(/\D/g, "").padStart(4, "0").slice(-4)}`
      : "3421";

    const type = normaliserTypeVente(f.type);
    const lignes = genererEcrituresVente({
      dossier_id: dossier.id, facture_id: f.id, reference: ref,
      date_facture: txt(f.date_facture),
      montant_ht: Number(f.montant_ht), montant_tva: Number(f.montant_tva),
      montant_ttc: Number(f.montant_ttc),
      compte_client: compteClient, compte_produit: compteProduit, type,
    });

    const ctrl = controlerLignesVente(lignes, type);
    const cut = controlerCutoffExercice(lignes, bornesDe(f.date_facture));
    if (!ctrl.ok || !cut.ok) {
      refusees.push({ ref, griefs: [...ctrl.violations, ...cut.violations] });
      continue;
    }
    nouvelles.push(...lignes);
  }

  for (const f of achats) {
    if (["rejetee", "annulee", "brouillon"].includes(txt(f.statut).toLowerCase())) continue;

    const fournisseur = fournisseursParId.get(String(f.fournisseur_id ?? ""));
    // Compte de charge : celui déjà employé par l'écriture purgée, s'il existe.
    // Le relire de la base plutôt que de le redéduire préserve l'arbitrage de
    // l'utilisateur et la recatégorisation PCM déjà appliquée.
    const ancienne = aPurger.find(
      (l) => txt(l.reference_piece) === txt(f.id) && txt(l.compte_numero).startsWith("6"));

    const lignes = genererEcrituresAchat({
      dossier_id: dossier.id, facture_id: f.id, reference: txt(f.id),
      date_facture: txt(f.date_facture),
      montant_ht: Number(f.montant_ht), montant_tva: Number(f.montant_tva),
      montant_ttc: Number(f.montant_ttc),
      compte_charge: txt(ancienne?.compte_numero) || txt(fournisseur?.compte_charge_defaut) || null,
      fournisseur_nom: txt(f.fournisseur_nom) || txt(fournisseur?.nom),
      code_auxiliaire: fournisseur?.code_auxiliaire ?? null,
    });

    const ctrl = controlerLignesAchat(lignes);
    const cut = controlerCutoffExercice(lignes, bornesDe(f.date_facture));
    if (!ctrl.ok || !cut.ok) {
      refusees.push({ ref: txt(f.numero) || txt(f.id), griefs: [...ctrl.violations, ...cut.violations] });
      continue;
    }
    nouvelles.push(...lignes);
  }

  // ── REPASSE : trésorerie logée en journal OD → BQ / CAI ────────────────────
  //
  // Les OD de paiement de TVA écrites AVANT la correction de
  // `construireOdPaiementDgi` créditent 5141 depuis le journal OD. C'est un vrai
  // décaissement rangé là où le rapprochement bancaire ne regarde pas : le grand
  // livre diverge du relevé du montant du prélèvement, sans qu'aucun écran le dise.
  //
  // On les DÉPLACE au lieu de les supprimer : ces pièces ne sont pas régénérables
  // (elles ne dérivent d'aucune facture), et leur montant est juste — seul leur
  // journal est faux. Un simple `journal_code` suffit donc, sans toucher aux
  // comptes ni aux montants.
  //
  // Le déplacement se fait par PIÈCE ENTIÈRE, jamais par ligne : ne bouger que la
  // ligne 5141 laisserait sa contrepartie 4456 en OD, et la pièce serait scindée
  // entre deux journaux — un état pire que celui qu'on corrige. La pièce est
  // regroupée par (référence, date) puis vérifiée équilibrée avant tout mouvement.
  const deplacables = [];
  const groupesOd = new Map();
  for (const l of ecritures.filter((l) => journal(l) === "OD")) {
    const cle = `${txt(l.reference_piece)}|${txt(l.date_ecriture)}`;
    (groupesOd.get(cle) ?? groupesOd.set(cle, []).get(cle)).push(l);
  }
  for (const [cle, groupe] of groupesOd) {
    const tresorerie = groupe.filter((l) => estTresorerieHorsOd(l.compte_numero) && mouvementee(l));
    if (!tresorerie.length) continue;

    // Une pièce déséquilibrée n'est pas déplacée : on la signale. La déplacer
    // transporterait l'écart d'un journal à l'autre au lieu de le résoudre.
    const ecart = r2(groupe.reduce((s, l) => s + r2(l.debit) - r2(l.credit), 0));
    if (Math.abs(ecart) > 0.005) {
      anomalies.push(`${nom} — pièce OD ${cle} porte de la trésorerie MAIS est déséquilibrée de ${ecart.toFixed(2)} MAD : déplacement refusé`);
      continue;
    }
    // Le journal cible se lit sur le compte de trésorerie de la pièce : 516x → CAI,
    // sinon BQ (règle partagée avec l'OD de paiement DGI).
    const cible = journalDeTresorerie(tresorerie[0].compte_numero);
    for (const l of groupe) deplacables.push({ id: l.id, avant: txt(l.journal_code), apres: cible });
  }

  // ── DÉLETTRAGE des codes que la purge rend ORPHELINS ───────────────────────
  //
  // Une facture lettrée avec son règlement partage un code (AA, AB…). La purge
  // emporte la ligne de facture ; la ligne de règlement, elle, vit en CAI/BQ et
  // n'est jamais purgée — elle survit donc avec un code qui ne désigne plus rien.
  //
  // C'est un état franchement mauvais, et silencieux : le règlement se croit
  // lettré, la facture régénérée est ouverte, et `apparierAutomatiquement` ne
  // considère QUE les lignes non lettrées — le règlement lui est donc invisible.
  // Le lettrage automatique ne les rapprocherait jamais, et la bascule de TVA de
  // ces pièces ne serait jamais reposée.
  //
  // On libère donc les survivantes. Le code est repris par le prochain lettrage,
  // qui reposera la bascule du même mouvement.
  //
  // La détection porte sur l'ÉTAT RÉSULTANT, et non sur les codes que cette passe
  // s'apprête à casser : un dossier déjà reconstruit une fois porte des codes
  // orphelins que plus aucune ligne purgée ne désigne. Regarder ce qui RESTE rend
  // la réparation idempotente — elle rattrape les passes précédentes.
  //
  // Est orpheline toute famille de code qui, une fois la purge faite, ne tient
  // plus debout : une seule ligne, ou un déséquilibre. Une famille encore
  // complète et soldée est un lettrage valide, on n'y touche pas.
  const aSupprimer = new Set([...aPurger, ...odAPurger].map((l) => l.id));
  const familles = new Map();
  for (const l of ecritures) {
    if (aSupprimer.has(l.id)) continue;
    const code = txt(l.lettrage_code);
    if (!code) continue;
    (familles.get(code) ?? familles.set(code, []).get(code)).push(l);
  }
  const survivantesLettrees = [];
  const codesOrphelins = [];
  for (const [code, groupe] of familles) {
    const ecart = r2(groupe.reduce((s, l) => s + r2(l.debit) - r2(l.credit), 0));
    if (groupe.length > 1 && Math.abs(ecart) <= 0.005) continue;   // lettrage intact
    codesOrphelins.push(code);
    survivantesLettrees.push(...groupe);
  }

  const supprimables = [...aPurger, ...odAPurger];
  totalSupprimees += supprimables.length;
  totalDelettrees += survivantesLettrees.length;
  totalInserees += nouvelles.length;
  totalRefusees += refusees.length;
  totalDeplacees += deplacables.length;

  console.log(`── ${nom}`);
  console.log(`   purge      : ${aPurger.length} VTE/ACH + ${odAPurger.length} OD_TVA`
    + (odReclassement.length ? ` (dont ${odReclassement.length} reclassement(s) devenu(s) redondant(s))` : ""));
  console.log(`   régénère   : ${nouvelles.length} ligne(s) pour ${ventes.length} vente(s) et ${achats.length} achat(s)`);
  if (survivantesLettrees.length) {
    console.log(`   délettre   : ${survivantesLettrees.length} règlement(s) survivant(s) (codes ${codesOrphelins.join(", ")}) — rendus ré-appariables`);
  }
  if (deplacables.length) {
    const vers = [...new Set(deplacables.map((d) => d.apres))].join("/");
    console.log(`   déplace    : ${deplacables.length} ligne(s) de trésorerie OD → ${vers}`);
  }
  if (orphelines.length) console.log(`   ⚠ ignorées : ${orphelines.length} écriture(s) VTE/ACH sans facture en face (saisie manuelle ?)`);
  if (refusees.length) {
    console.log(`   ⚠ refusées : ${refusees.length} pièce(s) non conforme(s)`);
    for (const r of refusees.slice(0, 5)) console.log(`      • ${r.ref} — ${r.griefs.join(" ")}`);
    if (refusees.length > 5) console.log(`      … et ${refusees.length - 5} autre(s)`);
  }

  sauvegarde.dossiers.push({
    id: dossier.id, nom,
    supprimees: supprimables.length, inserees: nouvelles.length, deplacees: deplacables.length,
  });
  sauvegarde.supprimees.push(...supprimables);
  sauvegarde.deplacees.push(...deplacables);
  sauvegarde.delettrees.push(...survivantesLettrees.map((l) => ({
    id: l.id, lettrage_code: l.lettrage_code,
    lettrage_date: l.lettrage_date ?? null, lettrage_origine: l.lettrage_origine ?? null,
  })));

  if (!APPLY) continue;

  // ── Écriture : sauvegarde D'ABORD, puis purge, insertion, déplacement ──────
  fs.writeFileSync(FICHIER_BACKUP, JSON.stringify(sauvegarde, null, 2), "utf8");

  // Délettrage AVANT la purge : interrompu ici, on laisse des lignes LIBRES,
  // état parfaitement valide. L'ordre inverse laisserait des codes orphelins.
  for (const l of survivantesLettrees) {
    const { error } = await sb.from("ecritures_comptables")
      .update({ lettrage_code: null, lettrage_date: null, lettrage_origine: null })
      .eq("id", l.id);
    if (error) { console.error(`   ❌ délettrage : ${error.message}`); process.exit(1); }
  }

  const ids = supprimables.map((l) => l.id);
  for (let i = 0; i < ids.length; i += 500) {
    const { error } = await sb.from("ecritures_comptables").delete().in("id", ids.slice(i, i + 500));
    if (error) { console.error(`   ❌ purge : ${error.message}`); process.exit(1); }
  }
  for (let i = 0; i < nouvelles.length; i += 500) {
    const lot = nouvelles.slice(i, i + 500);
    const { data, error } = await sb.from("ecritures_comptables").insert(lot).select("id");
    if (error) {
      console.error(`   ❌ insertion : ${error.message}`);
      console.error(`   ↩ restaurez avec --rollback=${path.basename(FICHIER_BACKUP)}`);
      process.exit(1);
    }
    sauvegarde.inserees.push(...(data ?? []));
  }
  // Déplacement en DERNIER : c'est la seule opération réversible d'un simple
  // UPDATE, donc celle qu'on peut se permettre d'interrompre sans perte.
  for (const d of deplacables) {
    const { error } = await sb.from("ecritures_comptables")
      .update({ journal_code: d.apres }).eq("id", d.id);
    if (error) {
      console.error(`   ❌ déplacement : ${error.message}`);
      console.error(`   ↩ restaurez avec --rollback=${path.basename(FICHIER_BACKUP)}`);
      process.exit(1);
    }
  }
  fs.writeFileSync(FICHIER_BACKUP, JSON.stringify(sauvegarde, null, 2), "utf8");
  console.log(`   ✅ appliqué`);
}

// ─── Bilan ───────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(70)}`);
console.log(`Écritures purgées    : ${totalSupprimees}`);
console.log(`Écritures régénérées : ${totalInserees}`);
if (totalDeplacees) console.log(`Trésorerie déplacée  : ${totalDeplacees} ligne(s) sorties du journal OD vers BQ/CAI`);
if (totalDelettrees) console.log(`Règlements délettrés : ${totalDelettrees} ligne(s) libérée(s) — relancez le lettrage automatique`);
if (totalRefusees) console.log(`Pièces refusées      : ${totalRefusees} (non conformes — inchangées en base)`);
if (anomalies.length) {
  console.log(`\n⚠ Anomalies relevées (${anomalies.length}) :`);
  for (const a of anomalies) console.log(`   • ${a}`);
}
if (APPLY) {
  console.log(`\n💾 Sauvegarde : ${path.basename(FICHIER_BACKUP)}`);
  console.log(`   Rollback   : node --import tsx scripts/reconstruire_compta_dossiers.mjs --rollback=${path.basename(FICHIER_BACKUP)} --apply`);
  console.log(`\nℹ️  Les OD de bascule de TVA ne sont PAS recréées ici : elles naissent du`);
  console.log(`   RÈGLEMENT. Relancez le lettrage automatique pour les reposer.`);
} else {
  console.log(`\nAucune écriture modifiée. Ajoutez --apply pour appliquer.`);
}
