/**
 * controler-chaine-comptable.ts — le contrôle COMPLET, de la facture au reporting.
 *
 * ─── Pourquoi une passe unique ───────────────────────────────────────────────
 * Les contrôles existants sont bons et chacun voit son étage :
 * `auditer-conformite-comptable.ts` juge la conformité des écritures,
 * `verify_lettrage.mjs` le lettrage, `verify_integrite_tresorerie.mjs` les
 * mouvements d'argent. Aucun ne répond à la question qui compte après une
 * correction : « la chaîne tient-elle DE BOUT EN BOUT ? »
 *
 * Or les défauts corrigés sur SMERT WATER ne vivaient dans aucun étage — ils
 * vivaient dans les JOINTURES. Une facture soldée par une pièce dont le journal
 * ne savait rien ; un encours de 81 972 MAD au grand livre pendant que le
 * reporting annonçait tout encaissé. Chaque étage, pris seul, était cohérent.
 *
 * Ce script rejoue donc les sept stations dans l'ORDRE où la donnée les traverse,
 * et rapporte à chacune ce qui ne se raccorde pas à la suivante :
 *
 *   1. FACTURES    — montants internes (HT × taux = TVA, HT + TVA = TTC) et
 *                    recevabilité des pièces de règlement.
 *   2. JOURNAUX    — partie double par écriture, et régime des pièces.
 *   3. TRÉSORERIE  — tout mouvement d'argent s'appuie sur un relevé ou une pièce.
 *   4. LETTRAGE    — un code lettré se solde ; sinon il sort de l'encours une
 *                    créance qui n'a pas été réglée.
 *   5. OD / TVA    — les mouvements du 4456 restent explicables par un acte
 *                    fiscal, et aucune TVA n'est rendue exigible sans règlement.
 *   6. BALANCE     — partie double globale, comptes d'attente, et résultat
 *                    déclaré DÉFINITIF ou sous réserve.
 *   7. REPORTING   — les trois chiffres affichés (CA HT, encaissements, encours)
 *                    se retrouvent-ils dans les comptes ?
 *
 * LECTURE SEULE. Aucun insert, update ni delete — et pas de `--apply`, ce qui est
 * délibéré : corriger relève de scripts dédiés, qui sauvegardent et savent
 * revenir en arrière.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   node --import tsx scripts/controler-chaine-comptable.ts
 *   node --import tsx scripts/controler-chaine-comptable.ts --dossier="SMERT"
 *   node --import tsx scripts/controler-chaine-comptable.ts --quiet
 *
 * CODE DE SORTIE : 0 = aucune divergence · 1 = au moins une · 2 = échec du contrôle.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  examinerPaiements, estPieceARetrouver, type PaiementCandidat,
} from "../src/lib/reglements";
import {
  caHtGrandLivre, controlerEquilibreLettrage, encaissementsTiersGrandLivre,
  encoursTiersGrandLivre, situationFactureGrandLivre, COMPTE_CLIENTS,
  type LigneGrandLivre,
} from "../src/lib/encours-grandlivre";
import { controlerCoherenceMontants } from "../src/lib/tva";
import {
  clePiece, grouperEnEcritures, ecartPartieDouble, origineEcritureTresorerie,
  type LigneTresorerie,
} from "../src/lib/integrite-tresorerie";
import {
  controlerMouvementsTvaDue, controlerPreuveBascule, controlerSensReglement,
  type LigneEcriture,
} from "../src/lib/genererEcritures";
import { resultatDefinitif, type LigneBalance } from "../src/lib/balance-comptable";
import {
  estAcompte, estComptabilisable, STATUTS_NON_COMPTABILISABLES,
} from "../src/lib/coherence-ventes";
import { sansANouveaux } from "../src/lib/a-nouveaux";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const flag = (nom: string) => {
  const hit = argv.find((a) => a === `--${nom}` || a.startsWith(`--${nom}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf("=");
  return eq === -1 ? "" : hit.slice(eq + 1).replace(/^["']|["']$/g, "");
};
const CIBLE = flag("dossier") || null;
const QUIET = flag("quiet") !== undefined;

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

const COLS_GL = "id,journal_code,compte_numero,date_ecriture,libelle,debit,credit,"
  + "reference_piece,lettrage_code,facture_id,transaction_id";

/**
 * `info` porte ce qui doit être VU sans être un grief : un fait exact qui
 * explique pourquoi un montant ne se rapproche pas, plutôt qu'une anomalie.
 * Sans lui, écarter une facture rejetée du rapprochement la ferait disparaître
 * des écrans — et une créance de 16 200 MAD ne doit pas disparaître.
 */
interface Station { nom: string; griefs: string[]; note: string | null; info: string[] }

const station = (nom: string): Station => ({ nom, griefs: [], note: null, info: [] });

async function controlerDossier(d: any): Promise<Station[]> {
  const [{ data: ecr }, { data: fc }, { data: ff }, { data: pai }, { data: tx }, { data: enc }] =
    await Promise.all([
      sb.from("ecritures_comptables").select(COLS_GL).eq("dossier_id", d.id),
      sb.from("factures").select("id,numero,statut,type,date_facture,montant_ht,montant_tva,montant_ttc,montant_paye,montant_restant,statut_paiement,lignes").eq("dossier_id", d.id),
      sb.from("factures_fournisseurs").select("id,numero,date_facture,montant_ht,montant_tva,montant_ttc,montant_paye,montant_restant,statut_paiement,lignes").eq("dossier_id", d.id),
      sb.from("paiements").select("*").eq("dossier_id", d.id),
      sb.from("transactions_bancaires").select("id,date_operation,montant,libelle,facture_id,document_type,releve_id").eq("dossier_id", d.id),
      sb.from("encaissements").select("id,montant,date_encaissement").eq("dossier_id", d.id),
    ]);

  const toutes = (ecr ?? []) as LigneGrandLivre[];
  // Les à-nouveaux reportent des soldes que les lignes d'origine portent déjà :
  // les garder dans une lecture CUMULÉE compterait deux fois le même montant.
  const lignes = sansANouveaux(toutes);
  const paiements = (pai ?? []) as any[];
  const transactions = (tx ?? []) as any[];
  const factures = [
    ...((fc ?? []) as any[]).map((f) => ({ ...f, sens: "client" as const })),
    ...((ff ?? []) as any[]).map((f) => ({ ...f, sens: "fournisseur" as const })),
  ];

  const stations: Station[] = [];

  // ── 1. FACTURES ────────────────────────────────────────────────────────────
  const s1 = station("1. FACTURES — montants internes et pièces de règlement");
  for (const f of factures) {
    const nbLignes = Array.isArray(f.lignes) ? Math.max(1, f.lignes.length) : 1;
    const c = controlerCoherenceMontants(
      { ht: f.montant_ht, tva: f.montant_tva, ttc: f.montant_ttc }, nbLignes);
    if (!c.ok) s1.griefs.push(`${txt(f.numero)} : ${c.message}`);

    const fk = f.sens === "client" ? "facture_id" : "facture_fournisseur_id";
    const dateDePiece = (p: any): string | null => {
      const t = transactions.find((x) => txt(x.id) === txt(p.transaction_id));
      return t ? jour(t.date_operation) : jour(p.date_paiement) || null;
    };
    const candidats: PaiementCandidat[] = paiements
      .filter((p) => txt(p[fk]) === txt(f.id))
      .map((p) => ({
        id: p.id, montant: nb(p.montant), date_paiement: dateDePiece(p),
        origine: p.origine, transaction_id: p.transaction_id,
        encaissement_id: p.encaissement_id, reference: p.reference,
      }));
    for (const e of examinerPaiements(f, candidats)) {
      if (!e.recevable) s1.griefs.push(`${e.message}`);
    }
  }
  // Règlements dont la pièce reste à retrouver : la comptabilité les porte, mais
  // leur justification est en attente. Ce n'est pas une désynchronisation, c'est
  // un arbitrage ouvert — et il doit le rester tant qu'il n'est pas tranché.
  for (const p of paiements.filter((x) => estPieceARetrouver(x.reference))) {
    const f = factures.find((x) =>
      txt(x.id) === txt(p.facture_id) || txt(x.id) === txt(p.facture_fournisseur_id));
    s1.griefs.push(
      `${txt(f?.numero ?? p.id)} : règlement de ${fmt(p.montant)} MAD du ${jour(p.date_paiement)} `
      + "SANS pièce justificative — sa pièce d'origine s'est révélée antérieure à la facture. "
      + "Retrouver la pièce réelle, ou annuler l'écriture de trésorerie et sa bascule de TVA.");
  }
  s1.note = `${factures.length} facture(s) examinée(s), ${paiements.length} pièce(s) de règlement.`;
  stations.push(s1);

  // ── 2. JOURNAUX ────────────────────────────────────────────────────────────
  // La partie double se vérifie ÉCRITURE PAR ÉCRITURE, pas seulement en total :
  // deux écritures fausses en sens inverse s'annulent dans un total global.
  const s2 = station("2. JOURNAUX — partie double par écriture, sens des règlements");
  for (const [cle, groupe] of grouperEnEcritures(toutes as LigneTresorerie[])) {
    const ecart = ecartPartieDouble(groupe);
    if (Math.abs(ecart) > 0.005) {
      s2.griefs.push(`Écriture « ${cle} » déséquilibrée de ${fmt(ecart)} MAD (${groupe.length} ligne(s)).`);
    }
  }
  const sens = controlerSensReglement(toutes as LigneEcriture[]);
  if (!sens.ok) for (const g of sens.griefs) s2.griefs.push(g);
  s2.note = `${toutes.length} ligne(s) au grand livre.`;
  stations.push(s2);

  // ── 3. TRÉSORERIE ──────────────────────────────────────────────────────────
  // Une écriture de banque ou de caisse doit s'appuyer sur un fait : une ligne de
  // relevé VALIDÉ, ou une pièce saisie. Sinon c'est de la trésorerie fictive.
  const s3 = station("3. TRÉSORERIE — chaque mouvement s'appuie sur une pièce");
  const contexte = {
    // `releve_id` non nul, impérativement : une transaction orpheline ne prouve
    // rien, et l'accepter laisserait une donnée fictive en couvrir une autre.
    transactionsValidees: transactions.filter((t) => txt(t.releve_id)).map((t) => txt(t.id)),
    // Un règlement MARQUÉ « pièce à retrouver » ne justifie rien : sa pièce
    // d'origine s'est révélée fausse, et c'est précisément ce qu'il faut
    // continuer de voir. L'admettre ici ferait disparaître l'anomalie que la
    // correction a mise au jour — la trésorerie redeviendrait « justifiée » par
    // une pièce dont on sait qu'elle n'existe pas.
    piecesManuelles: [
      ...paiements.filter((p) => !estPieceARetrouver(p.reference))
        .map((p) => clePiece(p.date_paiement, nb(p.montant))),
      ...((enc ?? []) as any[]).map((e) => clePiece(e.date_encaissement, nb(e.montant))),
    ],
  };
  for (const l of lignes as LigneTresorerie[]) {
    const v = origineEcritureTresorerie(l, contexte);
    if (!v.ok) {
      s3.griefs.push(
        `${jour(l.date_ecriture)} ${txt(l.journal_code)} ${txt(l.compte_numero)} `
        + `${fmt(Math.max(nb(l.debit), nb(l.credit)))} — ${v.raison}`);
    }
  }
  // Liens bancaires impossibles : une ligne de relevé rattachée à une facture
  // qu'elle PRÉCÈDE. C'est ce que la vue v_liens_bancaires_impossibles expose.
  const parFacture = new Map(factures.map((f) => [txt(f.id), f]));
  for (const t of transactions) {
    const f = parFacture.get(txt(t.facture_id));
    if (!f || !jour(f.date_facture) || !jour(t.date_operation)) continue;
    if (jour(t.date_operation) >= jour(f.date_facture)) continue;
    const j = Math.round((Date.parse(jour(f.date_facture)) - Date.parse(jour(t.date_operation))) / 86400000);
    s3.griefs.push(
      `Ligne de relevé du ${jour(t.date_operation)} rattachée à ${txt(f.numero)} `
      + `émise le ${jour(f.date_facture)} — ${j} jours d'antériorité.`);
  }
  s3.note = `${transactions.length} transaction(s), dont ${contexte.transactionsValidees.length} sur relevé.`;
  stations.push(s3);

  // ── 4. LETTRAGE ────────────────────────────────────────────────────────────
  const s4 = station("4. LETTRAGE — un code lettré se solde");
  for (const a of controlerEquilibreLettrage(lignes)) s4.griefs.push(a.message);
  const codes = new Set(lignes.map((l) => txt(l.lettrage_code)).filter(Boolean));
  s4.note = `${codes.size} code(s) de lettrage.`;
  stations.push(s4);

  // ── 5. OD / TVA ────────────────────────────────────────────────────────────
  const s5 = station("5. OD / TVA — mouvements du 4456 et bascules justifiées");
  const tvaDue = controlerMouvementsTvaDue(toutes as LigneEcriture[]);
  if (!tvaDue.ok) for (const g of tvaDue.griefs) s5.griefs.push(g);
  const bascule = controlerPreuveBascule(toutes as any, toutes as any);
  if (!bascule.ok) for (const g of bascule.griefs) s5.griefs.push(g);
  stations.push(s5);

  // ── 6. BALANCE ─────────────────────────────────────────────────────────────
  const s6 = station("6. BALANCE — partie double globale, attentes, résultat");
  const parCompte = new Map<string, { d: number; c: number }>();
  for (const l of lignes) {
    const c = txt(l.compte_numero);
    const acc = parCompte.get(c) ?? { d: 0, c: 0 };
    acc.d += nb(l.debit); acc.c += nb(l.credit);
    parCompte.set(c, acc);
  }
  const balance: LigneBalance[] = [...parCompte].map(([compte, v]) =>
    ({ compte, total_debit: r2(v.d), total_credit: r2(v.c) }) as LigneBalance);
  const ecartGlobal = r2(balance.reduce((s, l) => s + nb(l.total_debit) - nb(l.total_credit), 0));
  if (Math.abs(ecartGlobal) > 0.005) {
    s6.griefs.push(`Partie double GLOBALE rompue : ${fmt(ecartGlobal)} MAD d'écart débit/crédit.`);
  }
  const res = resultatDefinitif(balance);
  if (!res.definitif) s6.griefs.push(res.reserve!);
  s6.note = `${balance.length} compte(s) · résultat ${fmt(res.provisoire.resultat)} MAD `
    + (res.definitif ? "(définitif)" : `(sous réserve de ${fmt(res.enAttente)} en attente)`);
  stations.push(s6);

  // ── 7. REPORTING ───────────────────────────────────────────────────────────
  // Les trois chiffres du bandeau, comparés à ce que les comptes disent. Ils ne
  // sont plus CALCULÉS depuis les factures — c'est le rapprochement qui reste.
  const s7 = station("7. REPORTING — les chiffres affichés se retrouvent-ils aux comptes ?");
  const ca = caHtGrandLivre(lignes);
  const encaisse = encaissementsTiersGrandLivre(lignes, COMPTE_CLIENTS);
  const encours = encoursTiersGrandLivre(lignes, COMPTE_CLIENTS);

  // ── LE PÉRIMÈTRE, avant tout rapprochement ────────────────────────────────
  // Une facture REJETÉE, annulée ou en brouillon n'a, à juste titre, AUCUNE
  // écriture : `generateFactureXml` ne comptabilise que les pièces conformes.
  // La comparer au grand livre fabrique un écart permanent qui n'est pas une
  // anomalie — c'est exactement ce qui s'est produit ici : SOMADIR ressortait à
  // 16 200 MAD d'« écart d'encours » qui n'étaient que F2024-001, rejetée par la
  // DGI, jamais encaissée et jamais comptabilisée. Les DEUX chiffres étaient
  // justes ; c'est le rapprochement qui comparait des périmètres différents.
  //
  // `estComptabilisable` et `estAcompte` viennent de `coherence-ventes.ts`, qui
  // porte cette règle depuis le début. La première version de cette station en
  // avait recopié la liste des statuts pour le CA… et l'avait oubliée pour
  // l'encours. Une règle recopiée est une règle qui finit par diverger d'elle-même.
  const clientes = factures.filter((f) => f.sens === "client");
  const retenues = clientes.filter(estComptabilisable);
  const horsPerimetre = clientes.filter((f) => !estComptabilisable(f));

  const caFactures = r2(retenues.filter((f) => !estAcompte(f))
    .reduce((s, f) => s + nb(f.montant_ht), 0));
  if (ca.comptabilise && Math.abs(r2(caFactures - ca.montant)) > 0.005) {
    s7.griefs.push(
      `CA HT : ${fmt(caFactures)} facturés contre ${fmt(ca.montant)} de crédits de classe 7 `
      + `— ${fmt(Math.abs(caFactures - ca.montant))} MAD non comptabilisés.`);
  }

  // Encours : le grand livre contre la somme des restes dus. C'est le contrôle
  // qui a fait apparaître SMERT — 0 annoncé, 81 972 ouverts au 3421.
  const encoursFactures = r2(retenues
    .filter((f) => txt(f.statut_paiement) !== "payee")
    .reduce((s, f) => {
      const reste = nb(f.montant_restant);
      return s + (reste > 0.005 ? reste : Math.max(0, r2(nb(f.montant_ttc) - nb(f.montant_paye))));
    }, 0));
  const aDesTiers = lignes.some((l) => txt(l.compte_numero).startsWith(COMPTE_CLIENTS));
  if (aDesTiers && Math.abs(r2(encours.total - encoursFactures)) > 0.005) {
    s7.griefs.push(
      `Encours clients : ${fmt(encours.total)} de postes 342x ouverts contre ${fmt(encoursFactures)} `
      + "de restes dus portés par les factures — les deux ne peuvent pas être vrais.");
  }

  // Encaissements : les colonnes contre les crédits de trésorerie.
  const payeFactures = r2(retenues.reduce((s, f) => s + nb(f.montant_paye), 0));
  if (encaisse.comptabilise && Math.abs(r2(payeFactures - encaisse.montant)) > 0.005) {
    s7.griefs.push(
      `Encaissements clients : ${fmt(payeFactures)} portés par les factures contre `
      + `${fmt(encaisse.montant)} crédités au ${COMPTE_CLIENTS} en journal de trésorerie.`);
  }

  s7.note = `CA HT ${fmt(ca.montant)} · encaissé ${fmt(encaisse.montant)} · encours ${fmt(encours.total)}`;
  // Le hors-périmètre est une INFORMATION, pas un grief : du chiffre d'affaires
  // facturé qui n'entrera jamais en comptabilité tant que la pièce n'est pas
  // corrigée et retransmise. L'écarter du rapprochement sans le dire le ferait
  // disparaître des écrans — et 16 200 MAD de créance ne doivent pas disparaître.
  if (horsPerimetre.length) {
    const du = r2(horsPerimetre.reduce((s, f) =>
      s + Math.max(0, r2(nb(f.montant_ttc) - nb(f.montant_paye))), 0));
    const liste = horsPerimetre.map((f) => `${txt(f.numero)} [${txt(f.statut)}]`).join(", ");
    s7.info = [
      `${horsPerimetre.length} facture(s) hors périmètre comptable `
      + `(${STATUTS_NON_COMPTABILISABLES.join(" / ")}) pour ${fmt(du)} MAD encore dus : ${liste}.`,
      "Sans écriture — c'est correct — donc hors du rapprochement, mais la créance existe.",
    ];
  }
  stations.push(s7);

  return stations;
}

async function main(): Promise<number> {
  const { data: dossiers, error } = await sb.from("dossiers").select("id,nom_societe").order("nom_societe");
  if (error) { console.error("Lecture des dossiers impossible :", error.message); return 2; }

  const cibles = (dossiers ?? []).filter((d: any) =>
    !CIBLE || txt(d.nom_societe).toLowerCase().includes(CIBLE.toLowerCase()));
  if (!cibles.length) { console.error(`Aucun dossier ne correspond à « ${CIBLE} ».`); return 2; }

  let total = 0;
  for (const d of cibles) {
    let stations: Station[];
    try { stations = await controlerDossier(d); }
    catch (e: any) { console.error(`\n✗ ${d.nom_societe} : contrôle impossible — ${e?.message ?? e}`); return 2; }

    const griefs = stations.reduce((s, x) => s + x.griefs.length, 0);
    total += griefs;

    console.log(`\n${"═".repeat(78)}`);
    console.log(`${d.nom_societe}${griefs ? `  —  ${griefs} divergence(s)` : "  —  ✓ chaîne cohérente"}`);
    console.log("═".repeat(78));

    for (const s of stations) {
      const etat = s.griefs.length ? `✗ ${s.griefs.length}` : "✓";
      if (QUIET && !s.griefs.length) continue;
      console.log(`\n  ${etat}  ${s.nom}`);
      if (s.note) console.log(`      ${s.note}`);
      for (const i of s.info) console.log(`      ℹ ${i}`);
      for (const g of s.griefs) console.log(`      • ${g}`);
    }
  }

  console.log(`\n${"─".repeat(78)}`);
  console.log(total === 0
    ? "✅ AUCUNE DIVERGENCE — la chaîne Factures → Journaux → Trésorerie → Lettrage → OD/TVA → Balance → Reporting est cohérente."
    : `⚠️  ${total} divergence(s) sur l'ensemble de la chaîne.`);
  return total === 0 ? 0 : 1;
}

process.exit(await main());
