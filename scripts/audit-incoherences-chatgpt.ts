/**
 * audit-incoherences-chatgpt.ts — les 7 règles, tous dossiers, en une matrice.
 *
 * ─── Ce qu'il ajoute à l'existant ────────────────────────────────────────────
 * `controler-chaine-comptable.ts` suit la donnée dans l'ORDRE où elle traverse
 * l'application (facture → journal → trésorerie → … → reporting) : il répond
 * « où la chaîne casse-t-elle ? ». Celui-ci pose 7 questions FIXES à tous les
 * dossiers et rend une matrice PASS/FAIL : il répond « quelle règle tient, et
 * chez qui ? ». Les deux lectures sont utiles ; elles partagent leurs calculs.
 *
 * Rien n'est réimplémenté. Chaque règle appelle la logique qui fait déjà foi
 * ailleurs — `caHtGrandLivre`, `encoursTiersGrandLivre`, `resultatDefinitif`,
 * `controlerCoherenceMontants`, `examinerPaiements`, `collectifDeCompte`. Un
 * audit qui redéfinit la règle finit par diverger de celle qu'on applique, et
 * c'est alors l'audit qu'on croit.
 *
 * ─── Les 7 règles ────────────────────────────────────────────────────────────
 *  R1  KPI ⇄ BALANCE      CA classe 7, encours 342x, trésorerie 514x/516x :
 *                         les indicateurs et la balance doivent donner le MÊME
 *                         nombre, calculés par deux chemins différents.
 *  R2  CAISSE ≥ 0         à CHAQUE mouvement, dans l'ordre chronologique — pas
 *                         seulement à la clôture.
 *  R3  AUXILIAIRES        tout 3421xxxx / 4411xxxx dérive d'un collectif valide
 *                         et d'un code auxiliaire qui existe en fiche tiers.
 *  R4  TVA EXIGIBLE       tout mouvement 4455x / 3455x est justifié par une
 *                         déclaration, une régularisation, ou une bascule
 *                         adossée à un règlement RÉEL.
 *  R5  RÉSULTAT PROVISOIRE  si 4712 ≠ 0, le résultat doit être marqué non
 *                         définitif. La règle porte sur le FLAG, pas sur le solde.
 *  R6  HT + TVA = TTC     sur chaque facture, et Σ des lignes = HT.
 *  R7  DATES              aucun règlement antérieur à la facture qu'il règle.
 *
 * LECTURE SEULE. Aucun insert, update ni delete.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   node --import tsx scripts/audit-incoherences-chatgpt.ts
 *   node --import tsx scripts/audit-incoherences-chatgpt.ts --dossier="SOMADIR"
 *   node --import tsx scripts/audit-incoherences-chatgpt.ts --detail
 *
 * CODE DE SORTIE : 0 = tout PASS · 1 = au moins un FAIL · 2 = l'audit a échoué.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  caHtGrandLivre, encoursTiersGrandLivre, soldeTresorerieGrandLivre,
  COMPTE_CLIENTS, COMPTE_FOURNISSEURS, estLettree, relevantDe,
  type LigneGrandLivre,
} from "../src/lib/encours-grandlivre";
import { resultatDefinitif, type LigneBalance } from "../src/lib/balance-comptable";
import { controlerCoherenceMontants } from "../src/lib/tva";
import { examinerPaiements, type PaiementCandidat } from "../src/lib/reglements";
import {
  collectifDeCompte, suffixeAuxiliaire, COMPTE_COLLECTIF,
} from "../src/lib/comptes-auxiliaires";
import {
  RACINE_COLLECTEE, RACINE_DEDUCTIBLE,
  PREFIXE_DECLARATION_TVA, PREFIXE_REGULARISATION_TVA,
} from "../src/lib/liquidation-tva";
import { estJournalTresorerie } from "../src/lib/integrite-tresorerie";
import {
  rapprocherCaProduits, rapprocherEncoursClients,
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
const DETAIL = flag("detail") !== undefined;

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
const EPS = 0.005;

const REGLES = [
  { id: "R1", titre: "KPI ⇄ Balance (CA 7, encours 342x, trésorerie 514x/516x)" },
  { id: "R2", titre: "Caisse 516x ≥ 0 à chaque mouvement" },
  { id: "R3", titre: "Auxiliaires 342xxxxx / 441xxxxx ⇄ collectifs" },
  { id: "R4", titre: "TVA 4455x / 3455x justifiée par un règlement réel" },
  { id: "R5", titre: "Flag « résultat provisoire » si 4712 ≠ 0" },
  { id: "R6", titre: "HT + TVA = TTC sur toutes les factures" },
  { id: "R7", titre: "Aucun règlement antérieur à sa facture" },
] as const;

/** Verdict d'une règle. `sansObjet` distingue « conforme » de « rien à vérifier ». */
interface Verdict { ok: boolean; sansObjet: boolean; griefs: string[]; mesure: string }

const PASS = (mesure = ""): Verdict => ({ ok: true, sansObjet: false, griefs: [], mesure });
const VIDE = (mesure = "—"): Verdict => ({ ok: true, sansObjet: true, griefs: [], mesure });
const FAIL = (griefs: string[], mesure = ""): Verdict => ({ ok: false, sansObjet: false, griefs, mesure });

async function auditerDossier(d: any): Promise<Record<string, Verdict>> {
  const [{ data: ecr }, { data: fc }, { data: ff }, { data: pai }, { data: tx }, { data: cli }, { data: four }] =
    await Promise.all([
      sb.from("ecritures_comptables")
        .select("journal_code,compte_numero,date_ecriture,libelle,debit,credit,reference_piece,lettrage_code,facture_id")
        .eq("dossier_id", d.id),
      // Le select doit porter montant_paye / montant_restant / statut_paiement :
      // sans eux, `rapprocherEncoursClients` lit `undefined`, retombe sur TTC − 0 et
      // compte le TTC de CHAQUE facture comme reste dû — un écart de 102 972 MAD
      // fabriqué de toutes pièces par la requête. Un select réduit affame le calcul.
      sb.from("factures").select("id,numero,statut,type,date_facture,montant_ht,montant_tva,montant_ttc,montant_paye,montant_restant,statut_paiement,lignes").eq("dossier_id", d.id),
      sb.from("factures_fournisseurs").select("id,numero,date_facture,montant_ht,montant_tva,montant_ttc,montant_paye,montant_restant,statut_paiement,lignes").eq("dossier_id", d.id),
      sb.from("paiements").select("*").eq("dossier_id", d.id),
      sb.from("transactions_bancaires").select("id,date_operation").eq("dossier_id", d.id),
      sb.from("clients").select("id,nom,code_auxiliaire").eq("dossier_id", d.id),
      sb.from("fournisseurs").select("id,nom,code_auxiliaire").eq("dossier_id", d.id),
    ]);

  // Les à-nouveaux reportent des soldes que les lignes d'origine portent déjà :
  // les garder dans une lecture CUMULÉE compterait deux fois le même montant.
  const lignes = sansANouveaux((ecr ?? []) as LigneGrandLivre[]);
  const paiements = (pai ?? []) as any[];
  const transactions = (tx ?? []) as any[];
  const factures = [
    ...((fc ?? []) as any[]).map((f) => ({ ...f, sens: "client" as const })),
    ...((ff ?? []) as any[]).map((f) => ({ ...f, sens: "fournisseur" as const })),
  ];
  const v: Record<string, Verdict> = {};

  // ── BALANCE, reconstruite une fois pour R1 et R5 ──────────────────────────
  const parCompte = new Map<string, { d: number; c: number }>();
  for (const l of lignes) {
    const c = txt(l.compte_numero);
    const a = parCompte.get(c) ?? { d: 0, c: 0 };
    a.d += nb(l.debit); a.c += nb(l.credit);
    parCompte.set(c, a);
  }
  const balance: LigneBalance[] = [...parCompte].map(([compte, x]) =>
    ({ compte, total_debit: r2(x.d), total_credit: r2(x.c) }) as LigneBalance);
  const soldeBalance = (racine: string, sens: 1 | -1 = 1) => r2(sens * balance
    .filter((l) => txt(l.compte).startsWith(racine))
    .reduce((s, l) => s + nb(l.total_debit) - nb(l.total_credit), 0));

  // ── R1 : KPI ⇄ BALANCE ───────────────────────────────────────────────────
  //
  // ⚠️ Le piège de cette règle : comparer le KPI à une balance reconstruite
  // depuis LES MÊMES écritures ne teste rien. `caHtGrandLivre` calcule
  // Σ(crédit − débit) sur la classe 7 ; une balance bâtie sur ces écritures rend
  // exactement la même somme. Un tel contrôle affiche PASS quoi qu'il arrive —
  // il ne rassure que celui qui ne l'a pas lu.
  //
  // Chaque comparaison confronte donc le grand livre à une source INDÉPENDANTE :
  //   • CA et ENCOURS  → les FACTURES, données commerciales saisies hors compta ;
  //   • ENCOURS (bis)  → la balance TOUTES lignes contre le KPI NON LETTRÉ : les
  //     deux ne coïncident que si chaque code de lettrage se solde. Non
  //     tautologique, puisque le lettrage est le seul discriminant ;
  //   • TRÉSORERIE     → la somme des JOURNAUX BQ/CAI contre le solde des comptes
  //     514x/516x. Un mouvement de trésorerie logé en OD fait diverger les deux,
  //     et c'est exactement le chemin qui produisait la « trésorerie fictive ».
  if (!lignes.length) v.R1 = VIDE();
  else {
    const griefs: string[] = [];
    const clientes = factures.filter((f) => f.sens === "client");

    // CA : comptabilité contre facturation.
    const ca = caHtGrandLivre(lignes);
    const rapproCa = rapprocherCaProduits(clientes as any, lignes as any);
    if (ca.comptabilise && !rapproCa.ok) {
      griefs.push(`CA HT : ${fmt(rapproCa.caHt)} facturés (hors acomptes et pièces rejetées) `
        + `contre ${fmt(rapproCa.credits7)} de crédits de classe 7 — écart ${fmt(rapproCa.ecart)}.`);
    }

    // Encours : comptabilité contre restes dus, à périmètre égal.
    const rapproEnc = rapprocherEncoursClients(clientes as any, lignes as any);
    if (!rapproEnc.ok) {
      griefs.push(`Encours 342x : ${fmt(rapproEnc.encoursGrandLivre)} de postes ouverts `
        + `contre ${fmt(rapproEnc.encoursFactures)} de restes dus — écart ${fmt(rapproEnc.ecart)}.`);
    }

    // Encours : équilibre du lettrage. La balance prend TOUTES les lignes, le KPI
    // seulement les NON LETTRÉES ; l'écart mesure ce qu'un lettrage bancal retire
    // à tort de l'encours.
    const encKpi = encoursTiersGrandLivre(lignes, COMPTE_CLIENTS);
    const encKpiNet = r2(encKpi.total - encKpi.avances);
    const encBal = soldeBalance(COMPTE_CLIENTS);
    if (Math.abs(encKpiNet - encBal) > EPS) {
      griefs.push(`Lettrage 342x : postes non lettrés ${fmt(encKpiNet)} ≠ solde de balance `
        + `${fmt(encBal)} — écart ${fmt(encBal - encKpiNet)}, un code de lettrage ne se solde pas.`);
    }

    // Trésorerie : les comptes contre les journaux qui devraient seuls les porter.
    const tresoKpi = soldeTresorerieGrandLivre(lignes);
    const tresoJournaux = r2(lignes
      .filter((l) => estJournalTresorerie(l.journal_code)
        && (relevantDe(l.compte_numero, "514") || relevantDe(l.compte_numero, "516")))
      .reduce((s, l) => s + nb(l.debit) - nb(l.credit), 0));
    if (Math.abs(tresoKpi.total - tresoJournaux) > EPS) {
      griefs.push(`Trésorerie : solde des comptes 514x/516x ${fmt(tresoKpi.total)} ≠ `
        + `${fmt(tresoJournaux)} porté par les journaux BQ/CAI — écart `
        + `${fmt(tresoKpi.total - tresoJournaux)}, des mouvements d'argent vivent hors journal de trésorerie.`);
    }

    const mesure = `CA ${fmt(ca.montant)} · enc ${fmt(encKpiNet)} · tréso ${fmt(tresoKpi.total)}`;
    v.R1 = griefs.length ? FAIL(griefs, mesure) : PASS(mesure);
  }

  // ── R2 : CAISSE ≥ 0 CHRONOLOGIQUEMENT ────────────────────────────────────
  // Sur le solde de CLÔTURE seul, une caisse qui plonge en cours d'année et se
  // rétablit ne laisse aucune trace. Elle a pourtant été impossible.
  const mvtCaisse = lignes
    .filter((l) => relevantDe(l.compte_numero, "516"))
    .sort((a, b) => jour(a.date_ecriture).localeCompare(jour(b.date_ecriture)));
  if (!mvtCaisse.length) v.R2 = VIDE();
  else {
    let cumul = 0, pire = { solde: 0, date: "" };
    for (const l of mvtCaisse) {
      cumul = r2(cumul + nb(l.debit) - nb(l.credit));
      if (cumul < pire.solde) pire = { solde: cumul, date: jour(l.date_ecriture) };
    }
    const mesure = `min ${fmt(pire.solde)} · clôture ${fmt(cumul)}`;
    v.R2 = pire.solde < -EPS
      ? FAIL([`Caisse créditrice : descend à ${fmt(pire.solde)} MAD au ${pire.date} `
          + `(clôture ${fmt(cumul)}). Il manque une entrée de fonds d'au moins ${fmt(-pire.solde)} MAD.`], mesure)
      : PASS(mesure);
  }

  // ── R3 : AUXILIAIRES ⇄ COLLECTIFS ────────────────────────────────────────
  // Un compte auxiliaire est un collectif SUIVI d'un code de fiche tiers
  // (4411 + « 0005 » = 44110005). Trois façons de le rompre : un collectif
  // inconnu, un suffixe malformé, ou un suffixe qui ne correspond à AUCUNE fiche
  // — ce dernier cas produit une ligne de balance qu'aucun tiers ne réclame.
  const codesTiers = new Set<string>();
  for (const t of [...((cli ?? []) as any[]), ...((four ?? []) as any[])]) {
    const code = txt(t.code_auxiliaire).replace(/\D/g, "");
    if (code) codesTiers.add(code.padStart(4, "0"));
  }
  const comptesTiers = [...parCompte.keys()].filter((c) =>
    relevantDe(c, COMPTE_COLLECTIF.client) || relevantDe(c, COMPTE_COLLECTIF.fournisseur));
  if (!comptesTiers.length) v.R3 = VIDE();
  else {
    const griefs: string[] = [];
    let auxiliaires = 0;
    for (const c of comptesTiers) {
      const collectif = collectifDeCompte(c);
      if (!collectif) { griefs.push(`Compte ${c} : aucun collectif PCM ne le porte.`); continue; }
      const suffixe = suffixeAuxiliaire(c);
      // Suffixe « 0000 » = le collectif lui-même, complété à 8 chiffres. Régulier.
      if (!suffixe || suffixe === "0000") continue;
      auxiliaires++;
      // Le contrôle ne s'arme que si le dossier code SES tiers : sur un dossier
      // qui n'en code aucun, tout suffixe serait dénoncé à tort.
      if (codesTiers.size && !codesTiers.has(suffixe)) {
        griefs.push(`Compte auxiliaire ${c} (collectif ${collectif}, code « ${suffixe} ») `
          + "ne correspond à AUCUNE fiche tiers du dossier.");
      }
    }
    const mesure = `${comptesTiers.length} compte(s), ${auxiliaires} auxiliaire(s), ${codesTiers.size} code(s) en fiche`;
    v.R3 = griefs.length ? FAIL(griefs, mesure) : PASS(mesure);
  }

  // ── R4 : TVA EXIGIBLE JUSTIFIÉE ──────────────────────────────────────────
  // Sous le régime des encaissements, 4455x/3455x ne s'atteint que par un acte
  // fiscal (déclaration, régularisation) ou par une BASCULE au règlement. Une
  // bascule sans règlement rend exigible une TVA qui n'a jamais été encaissée.
  //
  // La preuve du règlement se cherche par le CODE DE LETTRAGE d'abord — c'est
  // lui qui relie la bascule à la ligne de trésorerie — puis par la référence de
  // pièce, pour les règlements partiels qui ne sont pas lettrables.
  const lignesTva = lignes.filter((l) =>
    (relevantDe(l.compte_numero, RACINE_COLLECTEE) || relevantDe(l.compte_numero, RACINE_DEDUCTIBLE))
    && (nb(l.debit) > EPS || nb(l.credit) > EPS));
  if (!lignesTva.length) v.R4 = VIDE();
  else {
    const codesTresorerie = new Set(lignes
      .filter((l) => estJournalTresorerie(l.journal_code) && txt(l.lettrage_code))
      .map((l) => txt(l.lettrage_code)));
    const refsTresorerie = new Set(lignes
      .filter((l) => estJournalTresorerie(l.journal_code) && txt(l.reference_piece))
      .map((l) => txt(l.reference_piece)));

    const griefs: string[] = [];
    let justifiees = 0;
    for (const l of lignesTva) {
      const ref = txt(l.reference_piece);
      const acteFiscal = ref.startsWith(PREFIXE_DECLARATION_TVA) || ref.startsWith(PREFIXE_REGULARISATION_TVA);
      const parLettrage = txt(l.lettrage_code) && codesTresorerie.has(txt(l.lettrage_code));
      const parPiece = ref && refsTresorerie.has(ref);
      if (acteFiscal || parLettrage || parPiece) { justifiees++; continue; }
      griefs.push(`${jour(l.date_ecriture)} ${txt(l.journal_code)} ${txt(l.compte_numero)} `
        + `${fmt(Math.max(nb(l.debit), nb(l.credit)))} « ${ref || "sans référence"} » — `
        + "ni déclaration, ni régularisation, ni bascule adossée à un règlement.");
    }
    const mesure = `${justifiees}/${lignesTva.length} justifiée(s)`;
    v.R4 = griefs.length ? FAIL(griefs, mesure) : PASS(mesure);
  }

  // ── R5 : LE FLAG, pas le solde ───────────────────────────────────────────
  // La règle ne dit pas « 4712 doit être nul » : un compte d'attente garni est
  // une situation régulière tant qu'elle est SIGNALÉE. Ce qu'on vérifie, c'est
  // que le résultat porte alors sa réserve — sinon un chiffre non définitif se
  // présente comme définitif.
  const res = resultatDefinitif(balance);
  const solde4712 = soldeBalance("4712");
  const attente = Math.abs(solde4712) > EPS;
  const mesureR5 = attente
    ? `4712 ${fmt(solde4712)} · ${res.definitif ? "NON signalé" : "signalé"}`
    : "4712 nul";
  if (!attente) v.R5 = res.definitif ? PASS(mesureR5)
    : FAIL(["Résultat marqué non définitif alors qu'aucun compte d'attente n'est garni."], mesureR5);
  else v.R5 = res.definitif
    ? FAIL([`4712 porte ${fmt(solde4712)} MAD mais le résultat est présenté comme DÉFINITIF.`], mesureR5)
    : PASS(mesureR5);

  // ── R6 : HT + TVA = TTC ──────────────────────────────────────────────────
  // Deux contrôles distincts : la cohérence des TOTAUX (avec sa tolérance
  // d'arrondi de lignes, cf. controlerCoherenceMontants) et la somme des LIGNES,
  // qui doit redonner le HT. La seconde attrape ce que la première ne voit pas :
  // un total juste posé sur un détail faux.
  if (!factures.length) v.R6 = VIDE();
  else {
    const griefs: string[] = [];
    for (const f of factures) {
      const detail = Array.isArray(f.lignes) ? f.lignes : [];
      const c = controlerCoherenceMontants(
        { ht: f.montant_ht, tva: f.montant_tva, ttc: f.montant_ttc }, Math.max(1, detail.length));
      if (!c.ok) griefs.push(`${txt(f.numero)} : ${c.message}`);

      if (detail.length) {
        const sommeLignes = r2(detail.reduce((s: number, l: any) =>
          s + nb(l.quantite) * nb(l.prix_unitaire), 0));
        const ecart = r2(sommeLignes - nb(f.montant_ht));
        if (Math.abs(ecart) > Math.max(0.01 * detail.length, EPS)) {
          griefs.push(`${txt(f.numero)} : Σ des ${detail.length} ligne(s) = ${fmt(sommeLignes)} `
            + `mais montant_ht = ${fmt(nb(f.montant_ht))} (écart ${fmt(ecart)}).`);
        }
      }
    }
    const mesure = `${factures.length} facture(s)`;
    v.R6 = griefs.length ? FAIL(griefs, mesure) : PASS(mesure);
  }

  // ── R7 : DATES ───────────────────────────────────────────────────────────
  // L'antériorité se juge sur la date de la PIÈCE quand il y en a une : une date
  // de saisie peut avoir été recalée, la date d'opération d'un relevé non.
  if (!paiements.length) v.R7 = VIDE();
  else {
    const griefs: string[] = [];
    for (const f of factures) {
      const fk = f.sens === "client" ? "facture_id" : "facture_fournisseur_id";
      const candidats: PaiementCandidat[] = paiements
        .filter((p) => txt(p[fk]) === txt(f.id))
        .map((p) => {
          const t = transactions.find((x) => txt(x.id) === txt(p.transaction_id));
          return {
            id: p.id, montant: nb(p.montant),
            date_paiement: t ? jour(t.date_operation) : jour(p.date_paiement) || null,
            origine: p.origine, transaction_id: p.transaction_id,
            encaissement_id: p.encaissement_id, reference: p.reference,
          };
        });
      for (const e of examinerPaiements(f, candidats)) {
        if (!e.recevable && e.motifs.includes("anterieur_facture")) griefs.push(e.message!);
      }
    }
    const mesure = `${paiements.length} règlement(s)`;
    v.R7 = griefs.length ? FAIL(griefs, mesure) : PASS(mesure);
  }

  return v;
}

// ─── Rendu ───────────────────────────────────────────────────────────────────

function cellule(v: Verdict | undefined): string {
  if (!v) return "  ?  ";
  if (v.sansObjet) return "  ·  ";
  return v.ok ? " PASS" : " FAIL";
}

async function main(): Promise<number> {
  const { data: dossiers, error } = await sb.from("dossiers").select("id,nom_societe").order("nom_societe");
  if (error) { console.error("Lecture des dossiers impossible :", error.message); return 2; }

  const tous = (dossiers ?? []) as any[];
  const cibles = tous.filter((d) => !CIBLE || txt(d.nom_societe).toLowerCase().includes(CIBLE.toLowerCase()));
  if (!cibles.length) { console.error(`Aucun dossier ne correspond à « ${CIBLE} ».`); return 2; }

  const resultats: { dossier: any; v: Record<string, Verdict> }[] = [];
  for (const d of cibles) {
    try { resultats.push({ dossier: d, v: await auditerDossier(d) }); }
    catch (e: any) { console.error(`✗ ${d.nom_societe} : ${e?.message ?? e}`); return 2; }
  }

  const largeur = Math.max(28, ...resultats.map((r) => txt(r.dossier.nom_societe).length));
  const barre = "─".repeat(largeur + 2 + REGLES.length * 6 + 8);

  console.log(`\n${"═".repeat(barre.length)}`);
  console.log(`  AUDIT DES INCOHÉRENCES — ${resultats.length} dossier(s) × ${REGLES.length} règles`);
  console.log("═".repeat(barre.length));
  console.log(`\n  ${"DOSSIER".padEnd(largeur)}  ${REGLES.map((r) => r.id.padStart(5)).join("")}   VERDICT`);
  console.log(`  ${"─".repeat(largeur)}  ${"─".repeat(REGLES.length * 5)}   ${"─".repeat(8)}`);

  let totalFails = 0;
  for (const { dossier, v } of resultats) {
    const fails = REGLES.filter((r) => v[r.id] && !v[r.id].sansObjet && !v[r.id].ok).length;
    totalFails += fails;
    const cells = REGLES.map((r) => cellule(v[r.id]).padStart(5)).join("");
    console.log(`  ${txt(dossier.nom_societe).padEnd(largeur)}  ${cells}   ${fails ? `${fails} FAIL` : "✓ OK"}`);
  }

  console.log(`\n  Légende : PASS = conforme · FAIL = anomalie · · = sans objet (rien à vérifier)`);
  for (const r of REGLES) {
    const concernes = resultats.filter(({ v }) => v[r.id] && !v[r.id].sansObjet);
    const ko = concernes.filter(({ v }) => !v[r.id].ok);
    console.log(`  ${r.id}  ${r.titre}`);
    console.log(`      ${concernes.length - ko.length}/${concernes.length} dossier(s) conforme(s)`
      + (ko.length ? ` — en défaut : ${ko.map((x) => txt(x.dossier.nom_societe)).join(", ")}` : ""));
  }

  // ── Détail des anomalies ────────────────────────────────────────────────
  const enDefaut = resultats.filter(({ v }) => REGLES.some((r) => v[r.id] && !v[r.id].sansObjet && !v[r.id].ok));
  if (enDefaut.length) {
    console.log(`\n${"═".repeat(barre.length)}`);
    console.log("  DÉTAIL DES ANOMALIES");
    console.log("═".repeat(barre.length));
    for (const { dossier, v } of enDefaut) {
      console.log(`\n  ▸ ${txt(dossier.nom_societe)}`);
      for (const r of REGLES) {
        const x = v[r.id];
        if (!x || x.sansObjet || x.ok) continue;
        console.log(`    ✗ ${r.id} — ${r.titre}`);
        for (const g of x.griefs) console.log(`        • ${g}`);
      }
    }
  }

  if (DETAIL) {
    console.log(`\n${"═".repeat(barre.length)}`);
    console.log("  MESURES PAR DOSSIER");
    console.log("═".repeat(barre.length));
    for (const { dossier, v } of resultats) {
      console.log(`\n  ▸ ${txt(dossier.nom_societe)}`);
      for (const r of REGLES) {
        const x = v[r.id];
        if (!x) continue;
        console.log(`    ${r.id} ${x.sansObjet ? "·   " : x.ok ? "PASS" : "FAIL"}  ${x.mesure}`);
      }
    }
  }

  console.log(`\n${"─".repeat(barre.length)}`);
  console.log(totalFails === 0
    ? "✅ AUCUNE INCOHÉRENCE — les 7 règles tiennent sur tous les dossiers audités."
    : `⚠️  ${totalFails} règle(s) en défaut, réparties sur ${enDefaut.length} dossier(s).`);
  return totalFails === 0 ? 0 : 1;
}

process.exit(await main());
