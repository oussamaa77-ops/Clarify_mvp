/**
 * seed-golden-dossier.ts — le DOSSIER ÉTALON de la Clarify Golden Audit Suite.
 *
 * ─── À quoi sert un dossier étalon ───────────────────────────────────────────
 * Le banc `audit-incoherences-chatgpt.ts` pose 7 questions aux dossiers RÉELS.
 * Il est excellent pour trouver ce qui cloche, et muet sur ce qui manque : un
 * dossier qui n'a ni avoir, ni règlement groupé, ni déclaration de TVA rend
 * « · sans objet » sur la moitié des règles, et l'audit passe au vert sans avoir
 * rien éprouvé. Les 9 dossiers de la base, à eux tous, ne couvrent pas un
 * exercice complet.
 *
 * D'où celui-ci : un exercice ENTIER, écrit exprès, où chaque règle a de quoi
 * mordre. Il transforme le banc d'un détecteur d'anomalies en une suite de
 * RÉGRESSION — le jour où un générateur d'écritures dérive, c'est ce dossier qui
 * vire au rouge, sans attendre qu'un client réel en fasse les frais.
 *
 * ─── Le scénario ─────────────────────────────────────────────────────────────
 * Décrit une fois pour toutes dans `tests/golden/scenario.ts` : vente comptant,
 * vente à crédit, règlement partiel, avoir VTE-AVR, règlement groupé
 * multi-factures, achat fournisseur, décaissements banque et caisse, deux
 * déclarations de TVA (une en dette, une en crédit reportable) et la clôture.
 *
 * ─── Rien n'est écrit à la main ──────────────────────────────────────────────
 * Chaque pièce est produite par le GÉNÉRATEUR de l'application —
 * `lignesEcrituresVente`, `genererEcrituresAchat`, `genererOdBasculeTva`,
 * `construireOdDeclaration`, `lignesANouveaux` — et insérée par `insererPiece`,
 * le passage obligé qui arme les sept verrous. Un étalon qui contournerait les
 * verrous ne prouverait que l'exactitude de sa propre copie : il resterait vert
 * pendant que l'application, elle, écrit faux.
 *
 * ISOLATION : toutes les écritures portent le `dossier_id` de TEST-CLARIFY-GOLDEN
 * et ce script ne touche JAMAIS un autre dossier. La purge est bornée à cet id.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   node --import tsx scripts/seed-golden-dossier.ts            # semer (idempotent)
 *   node --import tsx scripts/seed-golden-dossier.ts --clean    # effacer et sortir
 *   node --import tsx scripts/seed-golden-dossier.ts --garder   # ne pas purger d'abord
 *
 * CODE DE SORTIE : 0 = semé ET conforme aux attendus · 1 = écart · 2 = échec.
 */

import {
  clientGolden, exigerDossierGolden, trouverDossierGolden,
  NOM_DOSSIER_GOLDEN, nb, r2, txt,
} from "../tests/golden/harness";
import {
  ACHAT_GOLDEN, ATTENDUS, AVOIR_IMPUTE, CLIENT_GOLDEN, CLOTURE, COMPTE_BANQUE,
  COMPTE_CAISSE, COMPTE_CHARGE_ACHAT, COMPTE_PRODUIT, DECAISSEMENT_CAISSE,
  DECLARATIONS, EXERCICE, FOURNISSEUR_GOLDEN, REGLEMENTS, VENTES,
  type FactureGolden, type ReglementGolden,
} from "../tests/golden/scenario";

import { insererPiece } from "../src/server/lettrage-compta.functions";
import { lignesEcrituresVente } from "../src/lib/ecritures-vente";
import { genererEcrituresAchat, genererOdBasculeTva } from "../src/lib/genererEcritures";
import {
  construireOdDeclaration, construireOdPaiementDgi, liquiderTva, type LigneTva,
} from "../src/lib/liquidation-tva";
import { assertANouveaux, lignesANouveaux, soldesCloture, type LigneSolde } from "../src/lib/a-nouveaux";
import { creuxCaisse } from "../src/lib/integrite-tresorerie";
import { journalDeTresorerie } from "../src/lib/comptes-tresorerie";
import { statutDepuisMontants, statutStocke } from "../src/lib/statut-paiement";
import { normaliserComptesLignes } from "../src/lib/numero-compte";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const CLEAN_ONLY = flag("clean");
const GARDER = flag("garder");

const { sb } = clientGolden();

const fmt = (x: number) => nb(x).toLocaleString("fr-MA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const etape = (n: number, titre: string) => console.log(`\n  ${String(n).padStart(2)}. ${titre}`);
const ok = (m: string) => console.log(`      ✓ ${m}`);
const info = (m: string) => console.log(`      · ${m}`);

/** Toute erreur d'écriture arrête le semis : un étalon à moitié semé ment. */
function exiger(erreur: any, quoi: string): void {
  const m = erreur && (erreur.message ?? erreur.error ?? erreur);
  if (m) throw new Error(`${quoi} — ${txt(m)}`);
}

// ─── 1. Le dossier, et lui seul ──────────────────────────────────────────────

async function resoudreDossier(): Promise<any> {
  const existant = await trouverDossierGolden(sb);
  if (existant) return existant;

  // Le cabinet n'est PAS créé : le dossier étalon se range dans un cabinet qui
  // existe déjà, comme n'importe quel dossier. En fabriquer un ajouterait un
  // locataire fantôme au SaaS pour les besoins d'un test.
  const { data: cab, error: eCab } = await sb.from("cabinets").select("id,nom").limit(1).maybeSingle();
  exiger(eCab, "Lecture des cabinets");
  if (!cab) throw new Error("Aucun cabinet en base : impossible d'y rattacher le dossier étalon.");

  const { data, error } = await sb.from("dossiers").insert({
    cabinet_id: cab.id,
    nom_societe: NOM_DOSSIER_GOLDEN,
    statut: "actif",
    ice: "000000000000099",
    if_fiscal: "99999999",
    date_debut_activite: `${EXERCICE}-01-01`,
    compte_caisse: COMPTE_CAISSE,
    compte_banque: COMPTE_BANQUE,
    secteur_activite: "negoce",
  }).select("id,nom_societe,cabinet_id,date_debut_activite,compte_caisse,compte_banque").single();
  exiger(error, "Création du dossier étalon");
  info(`rattaché au cabinet « ${cab.nom} »`);
  return data;
}

/**
 * Efface TOUT ce que ce script a pu écrire, et rien d'autre.
 *
 * L'ordre suit les dépendances : les paiements avant les factures, les écritures
 * avant les pièces qu'elles désignent. Chaque `delete` est borné par
 * `dossier_id` — c'est la seule garantie d'isolation qui tienne, et elle doit
 * rester visible ligne à ligne plutôt que déduite d'un commentaire.
 */
async function purger(dossierId: string): Promise<void> {
  for (const table of ["paiements", "ecritures_comptables", "factures", "factures_fournisseurs",
    "transactions_bancaires", "encaissements", "clients", "fournisseurs"]) {
    const { error } = await sb.from(table).delete().eq("dossier_id", dossierId);
    // Une table absente du schéma n'est pas un échec de purge : le dossier
    // étalon n'y a rien écrit non plus.
    if (error && !/does not exist|schema cache/i.test(txt(error.message))) {
      exiger(error, `Purge de ${table}`);
    }
  }
}

// ─── 2. Les tiers ────────────────────────────────────────────────────────────

async function semerTiers(dossierId: string): Promise<{ clientId: string; fournisseurId: string }> {
  const { data: cli, error: eCli } = await sb.from("clients").insert({
    dossier_id: dossierId, nom: CLIENT_GOLDEN.nom, ice: CLIENT_GOLDEN.ice,
    if_fiscal: CLIENT_GOLDEN.if_fiscal, code_auxiliaire: CLIENT_GOLDEN.code_auxiliaire,
    compte_produit_defaut: COMPTE_PRODUIT,
  }).select("id").single();
  exiger(eCli, "Création du client étalon");

  const { data: four, error: eFour } = await sb.from("fournisseurs").insert({
    dossier_id: dossierId, nom: FOURNISSEUR_GOLDEN.nom, ice: FOURNISSEUR_GOLDEN.ice,
    if_fiscal: FOURNISSEUR_GOLDEN.if_fiscal, code_auxiliaire: FOURNISSEUR_GOLDEN.code_auxiliaire,
    compte_charge_defaut: COMPTE_CHARGE_ACHAT,
  }).select("id").single();
  exiger(eFour, "Création du fournisseur étalon");

  return { clientId: cli.id, fournisseurId: four.id };
}

// ─── 3. Les ventes ───────────────────────────────────────────────────────────

async function semerVente(dossierId: string, clientId: string, f: FactureGolden): Promise<string> {
  const { data, error } = await sb.from("factures").insert({
    dossier_id: dossierId, client_id: clientId, numero: f.numero,
    type: f.type, statut: "conforme", date_facture: f.date,
    montant_ht: f.ht, montant_tva: f.tva, montant_ttc: f.ttc,
    montant_paye: 0, montant_restant: f.ttc,
    lignes: f.lignes, mode_reglement: "virement",
  }).select("id").single();
  exiger(error, `Création de ${f.numero}`);
  const factureId = data.id as string;

  // Le générateur travaille en valeur ABSOLUE : il ne connaît que des ventes.
  // L'avoir est sa contrepartie exacte — mêmes comptes, sens inversés, journal
  // VTE-AVR. Le construire par retournement plutôt que d'écrire un second
  // générateur garantit qu'il vise toujours les mêmes comptes que la facture
  // qu'il annule ; deux générateurs finiraient par diverger sur le compte de
  // produit ou sur celui de TVA en attente.
  const droites = lignesEcrituresVente({
    dossier_id: dossierId, facture_id: factureId, reference: f.numero,
    date_facture: f.date,
    montant_ht: Math.abs(f.ht), montant_tva: Math.abs(f.tva), montant_ttc: Math.abs(f.ttc),
    compte_client: CLIENT_GOLDEN.compte, compte_produit: COMPTE_PRODUIT, type: "facture",
  });
  const lignes = f.type === "avoir"
    ? droites.map((l) => ({
      ...l, journal_code: "VTE-AVR",
      libelle: l.libelle.replace(/^Vente/, "Avoir").slice(0, 200),
      debit: l.credit, credit: l.debit,
    }))
    : droites;

  const { error: ePiece } = await insererPiece(sb, dossierId, lignes as any);
  exiger(ePiece, `Écritures de ${f.numero}`);
  return factureId;
}

async function semerAchat(dossierId: string, fournisseurId: string): Promise<string> {
  const { data, error } = await sb.from("factures_fournisseurs").insert({
    dossier_id: dossierId, fournisseur_id: fournisseurId,
    fournisseur_nom: FOURNISSEUR_GOLDEN.nom, numero: ACHAT_GOLDEN.numero,
    statut: "recue", date_facture: ACHAT_GOLDEN.date,
    montant_ht: ACHAT_GOLDEN.ht, montant_tva: ACHAT_GOLDEN.tva, montant_ttc: ACHAT_GOLDEN.ttc,
    montant_paye: 0, montant_restant: ACHAT_GOLDEN.ttc,
    lignes: ACHAT_GOLDEN.lignes, mode_reglement: "virement",
  }).select("id").single();
  exiger(error, `Création de ${ACHAT_GOLDEN.numero}`);
  const factureId = data.id as string;

  // Côté achat, la RÉFÉRENCE des écritures est le NUMÉRO de la pièce et non son
  // id : c'est lui que la bascule de TVA opposera à la ligne de banque, et lui
  // que le banc d'audit lit. Un uuid en référence rendrait le grand livre
  // illisible pour un humain sans rien apporter à la machine.
  const lignes = genererEcrituresAchat({
    dossier_id: dossierId, facture_id: factureId, reference: ACHAT_GOLDEN.numero,
    date_facture: ACHAT_GOLDEN.date,
    montant_ht: ACHAT_GOLDEN.ht, montant_tva: ACHAT_GOLDEN.tva, montant_ttc: ACHAT_GOLDEN.ttc,
    compte_charge: COMPTE_CHARGE_ACHAT, fournisseur_nom: FOURNISSEUR_GOLDEN.nom,
    compte_tiers: FOURNISSEUR_GOLDEN.compte,
  });
  // `ecritures_comptables.facture_id` référence `factures` — les pièces
  // FOURNISSEURS vivent dans une autre table et ne peuvent pas y être estampées.
  // C'est la RÉFÉRENCE qui les relie à leur grand livre, de bout en bout : de la
  // dette au décaissement, puis à la bascule de TVA déductible.

  const { error: ePiece } = await insererPiece(sb, dossierId, lignes as any);
  exiger(ePiece, `Écritures de ${ACHAT_GOLDEN.numero}`);
  return factureId;
}

// ─── 4. Les règlements, et la bascule qu'ils déclenchent ─────────────────────

interface PieceConnue { id: string; numero: string; ttc: number; tva: number; date: string }

/**
 * Un règlement, dans l'ordre exact où l'application le pose.
 *
 *   1. la pièce de TRÉSORERIE (BQ ou CAI) — le mouvement d'argent ;
 *   2. la ligne `paiements` — le reste dû, dont elle est la source de vérité ;
 *   3. l'OD de BASCULE, une par facture réglée, au prorata de l'encaissement.
 *
 * L'ordre n'est pas cosmétique : le verrou 7 (`controlerPreuveBascule`) EXIGE
 * qu'une écriture BQ/CAI rattachée à la pièce existe DÉJÀ en base, et datée au
 * plus tard du même jour. Basculer avant d'encaisser serait refusé — et doit
 * l'être, puisque c'est ainsi qu'on rend exigible une TVA jamais encaissée.
 */
async function semerReglement(
  dossierId: string, r: ReglementGolden, pieces: Map<string, PieceConnue>,
): Promise<void> {
  const journal = journalDeTresorerie(r.compte);
  const tiers = r.sens === "client" ? CLIENT_GOLDEN.compte : FOURNISSEUR_GOLDEN.compte;
  const reglees = r.factures.map((n) => {
    const p = pieces.get(n);
    if (!p) throw new Error(`Règlement ${r.reference} : pièce ${n} inconnue.`);
    return p;
  });

  // Répartition du versement entre les factures qu'il couvre. Un virement groupé
  // n'est pas un règlement de 9 600 : c'est deux règlements, de 6 000 et 3 600,
  // arrivés dans la même opération bancaire. Les garder confondus interdirait de
  // dire laquelle des deux est soldée.
  const parFacture = reglees.map((p) => ({ piece: p, montant: r2(Math.min(p.ttc, r.montant)) }));
  const totalReparti = r2(parFacture.reduce((s, x) => s + x.montant, 0));
  if (Math.abs(totalReparti - r.montant) > 0.005) {
    // Cas d'un règlement partiel sur une seule facture : la répartition vaut le
    // versement entier, il n'y a rien à corriger.
    if (parFacture.length === 1) parFacture[0].montant = r2(r.montant);
    else throw new Error(`Règlement ${r.reference} : ${fmt(r.montant)} ne se répartit pas sur ${r.factures.join(", ")}.`);
  }

  const commun = {
    dossier_id: dossierId, journal_code: journal, date_ecriture: r.date,
    reference_piece: r.reference, valide: true as const,
  };
  const sensClient = r.sens === "client";
  const lignesTreso = [
    // L'argent : il ENTRE au débit de la trésorerie chez le client, il en SORT
    // au crédit chez le fournisseur.
    {
      ...commun, compte_numero: r.compte,
      libelle: `${sensClient ? "Encaissement" : "Décaissement"} ${r.reference}`,
      debit: sensClient ? r2(r.montant) : 0,
      credit: sensClient ? 0 : r2(r.montant),
      facture_id: null as string | null,
    },
    // Le tiers : un encaissement CRÉDITE la créance, un décaissement DÉBITE la
    // dette (cf. `controlerSensReglement`, verrou 5).
    ...parFacture.map((x) => ({
      ...commun, compte_numero: tiers,
      libelle: `${sensClient ? "Règlement client" : "Règlement fournisseur"} ${x.piece.numero}`,
      debit: sensClient ? 0 : x.montant,
      credit: sensClient ? x.montant : 0,
      // Voir `semerAchat` : seule une pièce CLIENT peut porter `facture_id`.
      facture_id: sensClient ? (x.piece.id as string | null) : null,
    })),
  ];
  const { error: eTreso } = await insererPiece(sb, dossierId, lignesTreso as any,
    { lettrageCode: r.lettrage || null, origine: "manuel" });
  exiger(eTreso, `Pièce de trésorerie ${r.reference}`);

  // ── Le lettrage marque un GROUPE, pas une pièce ──────────────────────────
  // `insererPiece` n'estampille que les lignes qu'elle écrit : la contrepartie —
  // la créance née en VTE, la dette née en ACH, l'avoir passé en VTE-AVR — est
  // déjà en base et resterait NON LETTRÉE. L'encours du grand livre compterait
  // alors la facture entière comme ouverte tout en voyant son règlement lettré,
  // et le solde du compte de tiers cesserait d'égaler la somme des postes
  // ouverts. C'est précisément l'écart que la troisième vérification de R1
  // détecte : « un code de lettrage ne se solde pas ».
  if (r.lettrage) {
    const aLettrer = [...r.factures, ...(r.avoirs ?? [])];
    const { error } = await sb.from("ecritures_comptables")
      .update({
        lettrage_code: r.lettrage,
        lettrage_date: new Date().toISOString(),
        lettrage_origine: "manuel",
      })
      .eq("dossier_id", dossierId)
      .eq("compte_numero", tiers)
      .in("reference_piece", aLettrer);
    exiger(error, `Lettrage ${r.lettrage} des contreparties ${aLettrer.join(", ")}`);
  }

  for (const x of parFacture) {
    const fk = sensClient ? "facture_id" : "facture_fournisseur_id";
    const { error: ePai } = await sb.from("paiements").insert({
      dossier_id: dossierId, [fk]: x.piece.id, montant: x.montant,
      date_paiement: r.date, origine: "manuel",
      reference: parFacture.length > 1 ? `${r.reference}-${x.piece.numero}` : r.reference,
    });
    exiger(ePai, `Règlement ${r.reference} sur ${x.piece.numero}`);

    // La bascule se calcule sur la TVA D'ORIGINE de la pièce (jamais sur le
    // reste à basculer) et se plafonne à ce qui reste en attente : c'est ce qui
    // rend un échelonnement exact au lieu de sous-évaluer chaque versement
    // après le premier.
    const bascule = genererOdBasculeTva({
      sens: sensClient ? "client" : "fournisseur",
      montantTva: x.piece.tva, montantTtc: x.piece.ttc, montantRegle: x.montant,
      date: r.date, journalReglement: journal, reference: r.reference,
      libelle: `Bascule TVA ${x.piece.numero}`,
      lettrageCode: r.lettrage || "", factureId: sensClient ? x.piece.id : null,
    });
    if (!bascule.length) continue;
    const { error: eOd } = await insererPiece(
      sb, dossierId, bascule.map((l) => ({ ...l, dossier_id: dossierId })) as any,
      { lettrageCode: r.lettrage || null, origine: "manuel" });
    exiger(eOd, `Bascule de TVA ${r.reference} / ${x.piece.numero}`);
  }
}

// ─── 5. Le décaissement de caisse ────────────────────────────────────────────

async function semerDecaissementCaisse(dossierId: string): Promise<void> {
  const d = DECAISSEMENT_CAISSE;
  const commun = {
    dossier_id: dossierId, journal_code: "CAI", date_ecriture: d.date,
    libelle: d.libelle, reference_piece: d.reference, valide: true as const,
  };
  const { error } = await insererPiece(sb, dossierId, [
    { ...commun, compte_numero: d.compte_charge, debit: d.montant, credit: 0 },
    { ...commun, compte_numero: COMPTE_CAISSE, debit: 0, credit: d.montant },
  ] as any);
  exiger(error, "Décaissement de caisse");
}

// ─── 6. Les déclarations de TVA ──────────────────────────────────────────────

/** Le grand livre du dossier, relu à chaque étape qui en dépend. */
async function grandLivre(dossierId: string): Promise<any[]> {
  const { data, error } = await sb.from("ecritures_comptables")
    .select("journal_code,compte_numero,date_ecriture,libelle,debit,credit,reference_piece,lettrage_code,facture_id")
    .eq("dossier_id", dossierId);
  exiger(error, "Lecture du grand livre");
  return (data ?? []) as any[];
}

async function semerDeclaration(dossierId: string, d: typeof DECLARATIONS[number]): Promise<void> {
  // La liquidation LIT le grand livre : elle ne se fie pas au scénario. C'est ce
  // qui fait de la déclaration un contrôle et non une répétition — si une
  // bascule a manqué, le net déclaré ne tombera pas sur l'attendu et le semis
  // s'arrêtera là.
  const liq = liquiderTva(await grandLivre(dossierId) as LigneTva[], d.periode);
  if (!liq) throw new Error(`Période « ${d.periode} » illisible.`);
  if (Math.abs(liq.net - d.net) > 0.005) {
    throw new Error(
      `Déclaration ${d.periode} : net liquidé ${fmt(liq.net)} MAD, attendu ${fmt(d.net)} MAD `
      + `(collectée ${fmt(liq.collectee)}, déductible ${fmt(liq.deductible)}). `
      + "Une bascule de TVA manque ou tombe hors période.",
    );
  }

  const od = construireOdDeclaration(liq);
  if (!od.length) throw new Error(`Déclaration ${d.periode} : aucune écriture produite.`);
  const { error } = await insererPiece(sb, dossierId,
    od.map((l) => ({ ...l, dossier_id: dossierId, facture_id: null })) as any);
  exiger(error, `OD de déclaration ${d.periode}`);
  info(`${d.periode} : collectée ${fmt(liq.collectee)} − déductible ${fmt(liq.deductible)} = `
    + `${liq.dette ? "dette" : "crédit reportable"} ${fmt(liq.montant)}`);

  if (!d.paiement) {
    info(`${d.periode} : période en crédit — paiement SANS OBJET, la dette n'existe pas`);
    return;
  }
  // Le paiement à la DGI passe en BQ ou CAI, jamais en OD : c'est un mouvement
  // d'argent, et le journal OD n'a pas le droit d'en porter (verrou 2).
  const paiement = construireOdPaiementDgi({
    montant: liq.montant, date: d.paiement.date, periode: d.periode,
    compteBanque: d.paiement.compte,
  });
  const { error: ePai } = await insererPiece(sb, dossierId,
    paiement.map((l) => ({ ...l, dossier_id: dossierId, facture_id: null })) as any);
  exiger(ePai, `Paiement DGI ${d.periode}`);
  info(`${d.periode} : ${fmt(liq.montant)} MAD versés à la DGI le ${d.paiement.date}`);
}

// ─── 7. La clôture ───────────────────────────────────────────────────────────

async function semerCloture(dossierId: string): Promise<void> {
  const lignes = await grandLivre(dossierId);
  const soldes = soldesCloture(lignes as LigneSolde[], CLOTURE.date);
  const plan = lignesANouveaux(soldes, {
    dossier_id: dossierId, date: CLOTURE.date, reference: CLOTURE.reference,
  });
  assertANouveaux(plan);
  for (const a of plan.avertissements) info(`⚑ ${a}`);

  // Insertion DIRECTE, et non par `insererPiece` — comme le fait déjà
  // `scripts/generer-a-nouveaux.ts`. Un à-nouveau reporte des SOLDES : il touche
  // légitimement des comptes dont les verrous encadrent les MOUVEMENTS (le 4456
  // en particulier, quand l'exercice se clôt sur un crédit de TVA reportable).
  // Le faire passer par la porte des pièces d'exploitation le ferait refuser
  // pour une raison qui ne le concerne pas.
  // `normaliserComptesLignes` est OBLIGATOIRE sur tout chemin qui n'emprunte pas
  // `insererPiece` — c'est elle qui pose la forme canonique sur 8 chiffres à la
  // frontière. Le garde-fou d'architecture de
  // `src/server/conformite-nouveau-dossier.test.ts` refuse tout nouvel `insert`
  // qui l'oublierait, et il a raison : un numéro non normalisé rendrait ce
  // dossier introuvable des écrans qui interrogent la forme longue.
  const { error } = await sb.from("ecritures_comptables")
    .insert(normaliserComptesLignes(plan.lignes));
  exiger(error, "Écriture d'à-nouveau");
  info(`${plan.lignes.length} ligne(s) reportées, résultat antérieur ${fmt(-plan.resultatReporte)} MAD `
    + `au ${plan.compteReport}`);
}

// ─── 8. Le contrôle de ce qui a été semé ─────────────────────────────────────
//
// Un semeur qui se contente d'écrire ne prouve rien : il faut RELIRE. Les
// attendus viennent du scénario, posés à la main ; les mesures viennent de la
// base, calculées par les fonctions de l'application. Les faire coïncider est le
// seul moment où l'on sait que l'étalon est un étalon.

async function controler(dossierId: string): Promise<string[]> {
  const griefs: string[] = [];
  const lignes = (await grandLivre(dossierId)).filter((l) => txt(l.journal_code).toUpperCase() !== "AN");

  const somme = (predicat: (l: any) => boolean) =>
    r2(lignes.filter(predicat).reduce((s, l) => s + nb(l.debit) - nb(l.credit), 0));
  const compare = (quoi: string, mesure: number, attendu: number) => {
    if (Math.abs(mesure - attendu) > 0.005) {
      griefs.push(`${quoi} : ${fmt(mesure)} MAD en base, ${fmt(attendu)} MAD attendus (écart ${fmt(mesure - attendu)}).`);
    }
  };
  const commence = (racine: string) => (l: any) => txt(l.compte_numero).startsWith(racine);

  compare("CA HT (classe 7)", -somme(commence("7")), ATTENDUS.caHt);
  compare("Caisse à la clôture", somme(commence("516")), ATTENDUS.caisseCloture);
  compare("Banque à la clôture", somme(commence("514")), ATTENDUS.banqueCloture);
  compare("TVA en attente sur ventes (4458)", -somme(commence("4458")), ATTENDUS.tvaAttenteVente);
  compare("TVA en attente sur achats (3458)", somme(commence("3458")), ATTENDUS.tvaAttenteAchat);
  compare("TVA due (4456)", -somme(commence("4456")), ATTENDUS.tvaDue);

  const creux = creuxCaisse(lignes as any);
  if (!creux.ok) {
    griefs.push(`Caisse créditrice : ${fmt(creux.creux)} MAD au ${creux.date} — l'invariant C_t ≥ 0 est rompu.`);
  }

  const ecart = r2(lignes.reduce((s, l) => s + nb(l.debit) - nb(l.credit), 0));
  if (Math.abs(ecart) > 0.005) griefs.push(`Grand livre déséquilibré de ${fmt(ecart)} MAD.`);

  const { data: fc } = await sb.from("factures")
    .select("numero,montant_ttc,montant_paye,montant_restant,statut_paiement").eq("dossier_id", dossierId);
  if ((fc ?? []).length !== ATTENDUS.nbVentes) {
    griefs.push(`${(fc ?? []).length} pièce(s) de vente, ${ATTENDUS.nbVentes} attendues.`);
  }
  const encours = r2((fc ?? [])
    .filter((f: any) => statutStocke(f.statut_paiement) !== "payee")
    .reduce((s: number, f: any) => {
      const reste = nb(f.montant_restant);
      return s + (reste > 0.005 ? reste : Math.max(0, r2(nb(f.montant_ttc) - nb(f.montant_paye))));
    }, 0));
  compare("Encours clients (restes dus)", encours, ATTENDUS.encoursClients);

  const { data: pai } = await sb.from("paiements").select("id").eq("dossier_id", dossierId);
  if ((pai ?? []).length !== ATTENDUS.nbPaiements) {
    griefs.push(`${(pai ?? []).length} règlement(s) enregistré(s), ${ATTENDUS.nbPaiements} attendus.`);
  }
  return griefs;
}

/**
 * Recale les colonnes de reste dû sur les lignes `paiements`.
 *
 * Le trigger `paiements_resync` fait ce calcul en base quand la migration
 * 20260710130000 est appliquée — et alors cette fonction ne change rien, elle
 * réécrit les mêmes valeurs. Elle existe pour le cas contraire : sans elle, un
 * étalon semé sur une base sans trigger porterait des factures « non payées »
 * dont le compte de tiers est soldé, et le banc d'audit dénoncerait un écart
 * d'encours qui ne viendrait que du semis.
 */
async function recalerRestesDus(
  dossierId: string, table: "factures" | "factures_fournisseurs", fk: string,
): Promise<void> {
  const { data: pieces } = await sb.from(table).select("id,montant_ttc").eq("dossier_id", dossierId);
  const { data: paiements } = await sb.from("paiements").select(`${fk},montant,date_paiement`)
    .eq("dossier_id", dossierId);

  for (const p of (pieces ?? []) as any[]) {
    const siennes = ((paiements ?? []) as any[]).filter((x) => txt(x[fk]) === txt(p.id));
    const paye = r2(siennes.reduce((s, x) => s + nb(x.montant), 0));
    const ttc = r2(nb(p.montant_ttc));
    // Une pièce à TTC négatif est un avoir : il n'a pas de reste dû, et le
    // présenter comme impayé le ferait figurer à l'encours pour un montant
    // négatif. On le déclare soldé, ce qu'il est.
    const soldee = ttc <= 0.005 || Math.abs(ttc - paye) <= 1;
    const dates = siennes.map((x) => txt(x.date_paiement)).filter(Boolean).sort();
    const { error } = await sb.from(table).update({
      montant_paye: paye,
      montant_restant: ttc <= 0.005 ? 0 : r2(Math.max(0, ttc - paye)),
      statut_paiement: soldee ? "payee" : statutStocke(statutDepuisMontants(ttc, paye)),
      date_paiement: dates.length ? dates[dates.length - 1] : null,
    }).eq("id", p.id);
    exiger(error, `Recalage du reste dû de ${table}`);
  }
}

// ─── Orchestration ───────────────────────────────────────────────────────────

async function main(): Promise<number> {
  console.log(`\n${"═".repeat(78)}`);
  console.log(`  DOSSIER ÉTALON — ${NOM_DOSSIER_GOLDEN} · exercice ${EXERCICE}`);
  console.log("═".repeat(78));

  const dossier = await resoudreDossier();
  info(`dossier ${dossier.id}`);

  if (CLEAN_ONLY) {
    etape(1, "Purge du dossier étalon");
    await purger(dossier.id);
    ok("dossier vidé (la fiche dossier est conservée)");
    return 0;
  }

  if (!GARDER) {
    etape(1, "Purge — le semis est REJOUABLE, donc il repart d'une table rase");
    await purger(dossier.id);
    ok("données antérieures effacées");
  }

  etape(2, "Tiers — un client et un fournisseur, tous deux codés en auxiliaire");
  const { clientId, fournisseurId } = await semerTiers(dossier.id);
  ok(`${CLIENT_GOLDEN.nom} → ${CLIENT_GOLDEN.compte}`);
  ok(`${FOURNISSEUR_GOLDEN.nom} → ${FOURNISSEUR_GOLDEN.compte}`);

  etape(3, "Ventes — comptant, crédit, avoir");
  const pieces = new Map<string, PieceConnue>();
  for (const f of VENTES) {
    const id = await semerVente(dossier.id, clientId, f);
    pieces.set(f.numero, { id, numero: f.numero, ttc: Math.abs(f.ttc), tva: Math.abs(f.tva), date: f.date });
    ok(`${f.numero} ${String(fmt(f.ttc)).padStart(12)} TTC — ${f.role}`);
  }

  etape(4, "Achat fournisseur");
  const achatId = await semerAchat(dossier.id, fournisseurId);
  pieces.set(ACHAT_GOLDEN.numero, {
    id: achatId, numero: ACHAT_GOLDEN.numero,
    ttc: ACHAT_GOLDEN.ttc, tva: ACHAT_GOLDEN.tva, date: ACHAT_GOLDEN.date,
  });
  ok(`${ACHAT_GOLDEN.numero} ${String(fmt(ACHAT_GOLDEN.ttc)).padStart(12)} TTC — ${ACHAT_GOLDEN.role}`);

  etape(5, "Règlements — trésorerie, reste dû, puis bascule de TVA");
  for (const r of REGLEMENTS) {
    await semerReglement(dossier.id, r, pieces);
    ok(`${r.date} ${String(fmt(r.montant)).padStart(12)} — ${r.role}`);
  }

  etape(6, "Avoir imputé — il éteint la créance sans mouvement d'argent");
  const cible = pieces.get(AVOIR_IMPUTE.facture)!;
  const { error: eAvoir } = await sb.from("paiements").insert({
    dossier_id: dossier.id, facture_id: cible.id, montant: AVOIR_IMPUTE.montant,
    // `origine: "avoir"` — et non 'manuel', qui déclarerait « versement saisi à
    // la main », c'est-à-dire de l'argent entré. Ici rien n'est entré : la
    // créance a été ANNULÉE. Les ranger sous la même étiquette faisait compter
    // l'avoir comme une recette par tout état qui somme les règlements.
    // La valeur est ouverte par la migration 20260909130000.
    date_paiement: AVOIR_IMPUTE.date, origine: "avoir", reference: AVOIR_IMPUTE.avoir,
  });
  exiger(eAvoir, "Imputation de l'avoir");
  ok(`${fmt(AVOIR_IMPUTE.montant)} MAD portés de ${AVOIR_IMPUTE.avoir} sur ${AVOIR_IMPUTE.facture}`);

  etape(7, "Décaissement de caisse");
  await semerDecaissementCaisse(dossier.id);
  ok(`${DECAISSEMENT_CAISSE.date} ${fmt(DECAISSEMENT_CAISSE.montant)} MAD — ${DECAISSEMENT_CAISSE.role}`);

  etape(8, "Restes dus — recalage sur les lignes `paiements`");
  await recalerRestesDus(dossier.id, "factures", "facture_id");
  await recalerRestesDus(dossier.id, "factures_fournisseurs", "facture_fournisseur_id");
  ok("montant_paye / montant_restant / statut alignés sur la source de vérité");

  etape(9, "Déclarations de TVA");
  for (const d of DECLARATIONS) await semerDeclaration(dossier.id, d);
  ok(`${DECLARATIONS.length} période(s) déclarées`);

  etape(10, "Clôture de l'exercice");
  await semerCloture(dossier.id);
  ok(`à-nouveaux posés au ${CLOTURE.date}`);

  etape(11, "Contrôle — la base contre les attendus du scénario");
  const griefs = await controler(dossier.id);
  if (griefs.length) {
    console.log("");
    for (const g of griefs) console.log(`      ✗ ${g}`);
    console.log(`\n${"─".repeat(78)}`);
    console.log(`⚠️  Dossier étalon semé mais NON CONFORME : ${griefs.length} écart(s).`);
    console.log("   Le scénario et le moteur ne disent pas la même chose — corrigez avant d'auditer.");
    return 1;
  }
  ok("toutes les mesures coïncident avec le scénario");

  console.log(`\n${"─".repeat(78)}`);
  console.log(`✅ ${NOM_DOSSIER_GOLDEN} semé et conforme. Passez-le au banc :`);
  console.log(`   node --import tsx scripts/audit-incoherences-chatgpt.ts --dossier="${NOM_DOSSIER_GOLDEN}" --detail`);
  return 0;
}

try {
  process.exit(await main());
} catch (e: any) {
  console.error(`\n✗ Semis interrompu : ${e?.message ?? e}`);
  process.exit(2);
}
