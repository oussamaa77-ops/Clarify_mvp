/**
 * remettre-ubl-profil-dgi.ts — reprise EN LOT des documents UBL archivés, pour
 * les remettre au profil DGI courant.
 *
 * ─── Le problème ─────────────────────────────────────────────────────────────
 * Le XML d'une facture est ARCHIVÉ en base (`factures.xml_ubl`) au moment du
 * scellement. Les factures scellées avant l'entrée en vigueur des trois règles
 * DGI portent donc définitivement un document d'un constructeur antérieur :
 *
 *   1. pas de `ext:UBLExtensions` en premier enfant (récépissé + empreinte) ;
 *   2. pas d'identifiants légaux de l'émetteur (IF, RC) en `PartyIdentification` ;
 *   3. pas de `cac:TaxSubtotal` dans le `cac:TaxTotal` RACINE.
 *
 * Aucune correction du constructeur ne les atteint : ce sont des DONNÉES, pas du
 * code. `documentUbl` les remet à niveau à la demande — au téléchargement ou à la
 * fabrication du PDF/A-3 — mais une facture que personne ne rouvre reste en
 * l'état. Ce script fait le tour de toutes les factures scellées.
 *
 * ─── Pourquoi refaire le document ne rompt PAS le scellement ─────────────────
 * L'empreinte ne porte pas sur les octets du XML : elle porte sur la chaîne
 * canonique `numéro|date|ICE vendeur|ICE acheteur|TTC` (cf. invoice-hash.ts).
 * Refaire le rendu à partir des MÊMES faits scellés donne la même empreinte, et
 * le récépissé DGI reste vérifiable. Le script ne recalcule ni l'un ni l'autre :
 * il les recopie.
 *
 * ─── Ce que le script REFUSE de faire ────────────────────────────────────────
 *   • toucher un BROUILLON — il n'a rien de scellé à conserver, et son document
 *     se refait tout seul à la prochaine génération ;
 *   • refaire le document d'une facture qui a BOUGÉ depuis sa transmission (TTC
 *     divergent) : le document refait ne dirait plus ce qui a été déclaré. C'est
 *     l'archive qui fait foi, et elle est laissée intacte. Ces factures sont
 *     listées à part — elles se régularisent par annulation puis avoir, pas par
 *     réécriture ;
 *   • réécrire un document auquel il manque une mention parce que la FICHE ne la
 *     porte pas (un dossier sans RC, un client sans ICE). UBL préfère l'absence
 *     au vide : le document est déjà celui que produit le constructeur courant,
 *     et le refaire ne changerait rien — le script bouclerait, réécrivant à
 *     chaque passage la même chose. Ces factures sont listées comme un travail
 *     de SAISIE : compléter la fiche, puis rééditer la facture.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   node --import tsx scripts/remettre-ubl-profil-dgi.ts                 # DRY-RUN
 *   node --import tsx scripts/remettre-ubl-profil-dgi.ts --apply         # écrit
 *   node --import tsx scripts/remettre-ubl-profil-dgi.ts --dossier="DIGITAL"
 *   node --import tsx scripts/remettre-ubl-profil-dgi.ts --rollback=backup.json
 *
 * Options :
 *   --apply             Écrit en base. SANS ce drapeau : simulation seule.
 *   --dossier="<nom>"   Restreint à une raison sociale (correspondance partielle).
 *   --rollback=<file>   Restaure les `xml_ubl` depuis un fichier de sauvegarde.
 *
 * ─── Sûreté ──────────────────────────────────────────────────────────────────
 * PostgREST n'expose pas de transaction multi-requêtes : la réversibilité est
 * assurée par un fichier `backup_ubl_dgi_<date>.json` contenant l'ANCIEN document
 * de chaque facture touchée, écrit AVANT la première mise à jour et rejouable
 * via `--rollback`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { MockDgiService } from "../src/server/dgi.connector";
import { DgiEInvoicingService } from "../src/server/efacture.service";
import { controlerProfilUbl } from "../src/lib/ubl-invoice";
import { normaliserStatutDgi } from "../src/lib/efacture-mapping";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ─── Arguments ───────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (nom: string): string | undefined => {
  const hit = argv.find((a) => a === `--${nom}` || a.startsWith(`--${nom}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf("=");
  return eq === -1 ? "" : hit.slice(eq + 1).replace(/^["']|["']$/g, "");
};
const APPLY = flag("apply") !== undefined;
const DOSSIER = flag("dossier") || null;
const ROLLBACK = flag("rollback") || null;

// ─── Connexion Supabase (service_role : le script contourne la RLS) ──────────

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env"), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
) as Record<string, string>;

// Le moteur lit la clef via `process.env` : le .env du poste n'y est pas chargé
// tout seul dans un script tsx.
for (const clef of ["EFACTURE_SECRET_KEY", "APPROVAL_TOKEN_SECRET"]) {
  if (env[clef] && !process.env[clef]) process.env[clef] = env[clef];
}

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

interface Sauvegarde {
  id: string;
  numero: string | null;
  ancien_xml: string;
}

// ─── Rollback ────────────────────────────────────────────────────────────────

if (ROLLBACK) {
  const f = path.isAbsolute(ROLLBACK) ? ROLLBACK : path.join(ROOT, ROLLBACK);
  const sauvegarde = JSON.parse(fs.readFileSync(f, "utf8")) as { documents: Sauvegarde[] };
  console.log(`\n↩️  ROLLBACK depuis ${path.basename(f)} — ${sauvegarde.documents.length} document(s)\n`);
  let ok = 0;
  for (const d of sauvegarde.documents) {
    const { error } = await sb.from("factures").update({ xml_ubl: d.ancien_xml }).eq("id", d.id);
    if (error) console.log(`  ❌ ${d.numero ?? d.id} — ${error.message}`);
    else { ok++; console.log(`  ↩️  ${d.numero ?? d.id}`); }
  }
  console.log(`\n${ok}/${sauvegarde.documents.length} document(s) restauré(s).\n`);
  process.exit(0);
}

// ─── Inventaire ──────────────────────────────────────────────────────────────

// `select("*")` volontaire : les colonnes e-facturation s'ajoutent à la main, et
// un select NOMMÉ sur une colonne absente répond `data: null` sans erreur
// explicite — panne muette déjà rencontrée sur ce projet.
const { data: toutes, error } = await sb
  .from("factures")
  .select("*, dossiers(nom_societe)")
  .order("date_facture", { ascending: true });
if (error) { console.error(`Lecture des factures impossible : ${error.message}`); process.exit(1); }

const normNom = (v: string | null | undefined) =>
  (v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();

const candidates = (toutes ?? []).filter((f: any) => {
  if (DOSSIER && !normNom(f.dossiers?.nom_societe).includes(normNom(DOSSIER))) return false;
  // SCELLÉE = archive + empreinte + sortie de l'état brouillon. Les trois
  // ensemble : une facture qui n'a pas les trois n'a rien à conserver, et son
  // document se refait tout seul à la prochaine génération.
  const statut = normaliserStatutDgi(f.dgi_status ?? f.statut_dgi);
  return !!f.xml_ubl && !!f.hash_sha256 && statut !== "DRAFT";
});

console.log(`\n${APPLY ? "✍️  APPLICATION" : "🔍 SIMULATION (dry-run)"} — remise au profil DGI courant`);
console.log(`   ${toutes?.length ?? 0} facture(s) en base, ${candidates.length} scellée(s)${DOSSIER ? ` pour « ${DOSSIER} »` : ""}\n`);

// ─── Plan ────────────────────────────────────────────────────────────────────

const moteur = new DgiEInvoicingService(sb as any, new MockDgiService({ latenceMs: 0 }), env.EFACTURE_SECRET_KEY);

interface Plan {
  id: string;
  numero: string | null;
  societe: string;
  ancien_xml: string;
  nouveau_xml: string;
  manquants: string[];
}

const aRefaire: Plan[] = [];
const dejaConformes: string[] = [];
const figees: { numero: string; raison: string }[] = [];
const aCompleter: { numero: string; societe: string; manquants: string[] }[] = [];
const enErreur: { numero: string; message: string }[] = [];

for (const f of candidates as any[]) {
  const etiquette = f.numero ?? f.id;
  const avant = controlerProfilUbl(f.xml_ubl, { attendScellement: true });
  if (avant.conforme) { dejaConformes.push(etiquette); continue; }

  try {
    // Simulation : c'est `documentUbl` qui décide, y compris du refus de refaire
    // une facture qui a bougé. Redécider ici ferait diverger les deux chemins.
    const doc = await moteur.documentUbl(f.id, { persister: false });
    if (doc.etat === "mentions-absentes") {
      aCompleter.push({ numero: etiquette, societe: f.dossiers?.nom_societe ?? "—", manquants: doc.motifs });
      continue;
    }
    if (doc.etat !== "remis-a-niveau") {
      figees.push({ numero: etiquette, raison: doc.avertissements.join(" ") || "document conservé" });
      continue;
    }
    aRefaire.push({
      id: f.id,
      numero: f.numero ?? null,
      societe: f.dossiers?.nom_societe ?? "—",
      ancien_xml: f.xml_ubl,
      nouveau_xml: doc.xml_ubl,
      manquants: doc.motifs,
    });
  } catch (e) {
    enErreur.push({ numero: etiquette, message: e instanceof Error ? e.message : String(e) });
  }
}

console.log(`① À REMETTRE À NIVEAU : ${aRefaire.length}\n`);
for (const p of aRefaire) {
  console.log(`  • ${p.numero ?? p.id}  [${p.societe}]`);
  console.log(`      manque : ${p.manquants.join(", ")}`);
}

if (dejaConformes.length > 0) {
  console.log(`\n② DÉJÀ AU PROFIL COURANT : ${dejaConformes.length}`);
  console.log(`   ${dejaConformes.join(", ")}`);
}

if (aCompleter.length > 0) {
  console.log(`
③ MENTIONS ABSENTES DE LA FICHE — à compléter, puis rééditer : ${aCompleter.length}
`);
  for (const c of aCompleter) {
    console.log(`  • ${c.numero}  [${c.societe}]`);
    console.log(`      ${c.manquants.join(", ")}`);
  }
  console.log("      → le document est déjà celui que produit le constructeur courant ;");
  console.log("        la mention manque en BASE, pas dans le XML. Rien à réécrire ici.");
}

if (figees.length > 0) {
  console.log(`\n③ ARCHIVE CONSERVÉE (la facture a bougé depuis sa transmission) : ${figees.length}\n`);
  for (const g of figees) console.log(`  • ${g.numero}\n      ${g.raison}`);
}

if (enErreur.length > 0) {
  console.log(`\n④ EN ERREUR : ${enErreur.length}\n`);
  for (const e of enErreur) console.log(`  • ${e.numero} — ${e.message}`);
}

if (aRefaire.length === 0) {
  console.log("\n✅ Rien à reprendre.\n");
  process.exit(0);
}

if (!APPLY) {
  console.log(`\n🔍 Simulation seule — relancez avec --apply pour écrire les ${aRefaire.length} document(s).\n`);
  process.exit(0);
}

// ─── Application ─────────────────────────────────────────────────────────────

const horodatage = new Date().toISOString().replace(/[:.]/g, "-");
const nomFichier = `backup_ubl_dgi_${horodatage}.json`;
fs.writeFileSync(
  path.join(ROOT, nomFichier),
  JSON.stringify(
    { genere_le: new Date().toISOString(), documents: aRefaire.map(({ id, numero, ancien_xml }) => ({ id, numero, ancien_xml })) },
    null,
    2,
  ),
  "utf8",
);
console.log(`\n💾 Sauvegarde : ${nomFichier} (rejouable via --rollback=${nomFichier})\n`);

let ecrits = 0;
for (const p of aRefaire) {
  try {
    // Deuxième passage, celui qui écrit ET trace l'audit. Le document est
    // reconstruit à l'identique (le constructeur est déterministe), donc ce que
    // la sauvegarde protège est bien ce qui est remplacé.
    const doc = await moteur.documentUbl(p.id);
    if (doc.xml_ubl !== p.nouveau_xml) {
      console.log(`  ⚠️  ${p.numero ?? p.id} — le document a changé entre la simulation et l'écriture`);
    }
    ecrits++;
    console.log(`  ✅ ${p.numero ?? p.id}  [empreinte ${String(doc.hash_sha256).slice(0, 12)}… conservée]`);
  } catch (e) {
    console.log(`  ❌ ${p.numero ?? p.id} — ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log(`\n✅ ${ecrits}/${aRefaire.length} document(s) remis au profil DGI courant.`);
console.log(`   Empreintes et récépissés inchangés — le scellement reste vérifiable.\n`);
