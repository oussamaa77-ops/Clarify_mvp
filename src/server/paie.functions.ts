import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { normaliserComptesLignes } from "@/lib/numero-compte";
import { assertLignesPaie, lignesEcrituresPaie } from "@/lib/ecritures-paie";

function getSupabase() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";
  return createClient(url, key);
}

// ── Taux officiels Maroc 2026 ─────────────────────────────────────────────────
// CNSS : prestations sociales 4,48 % / 8,98 % plafonnées à 6 000 MAD par mois ;
// allocations familiales 6,40 % patronales, AMO 2,26 % / 4,11 % et TFP 1,60 %,
// sans plafond. Frais professionnels (art. 59 CGI, LF 2023) : 35 % si le brut
// imposable annuel n'excède pas 78 000 MAD, 25 % au-delà, plafonnés à 35 000 MAD
// par an. Charges de famille (art. 74 CGI, LF 2026) : 600 MAD par personne à
// charge et par an, 6 personnes au plus.
export const TAUX_PAIE = {
  cnss_salarie: 0.0448,
  cnss_patronal: 0.0898,
  cnss_plafond: 6000,
  allocations_familiales: 0.064,
  amo_salarie: 0.0226,
  amo_patronal: 0.0411,
  tfp: 0.016,
  frais_pro_taux: 0.35,
  frais_pro_taux_au_dela: 0.25,
  frais_pro_seuil_annuel: 78000,
  frais_pro_plafond_annuel: 35000,
  deduction_famille_annuelle: 600,
  personnes_a_charge_max: 6,
};

// Barème annuel de l'IR sur salaires (art. 73-I CGI, LF 2025).
export const BAREME_IR = [
  { min: 0,      max: 40000,   taux: 0,    deduction: 0 },
  { min: 40001,  max: 60000,   taux: 0.10, deduction: 4000 },
  { min: 60001,  max: 80000,   taux: 0.20, deduction: 10000 },
  { min: 80001,  max: 100000,  taux: 0.30, deduction: 18000 },
  { min: 100001, max: 180000,  taux: 0.34, deduction: 22000 },
  { min: 180001, max: Infinity, taux: 0.37, deduction: 27400 },
];

/** Frais professionnels MENSUELS déductibles d'un brut imposable mensuel. */
export function fraisProfessionnels(brutImposableMensuel: number): number {
  const annuel = Math.max(0, brutImposableMensuel) * 12;
  const taux = annuel <= TAUX_PAIE.frais_pro_seuil_annuel
    ? TAUX_PAIE.frais_pro_taux : TAUX_PAIE.frais_pro_taux_au_dela;
  return Math.min(annuel * taux, TAUX_PAIE.frais_pro_plafond_annuel) / 12;
}

export function calculBulletin(params: {
  salaire_base: number;
  heures_sup?: number;
  taux_hs?: number;
  primes?: number;
  indemnites_exo?: number;
  avantages_nature?: number;
  cimr_taux?: number;
  situation_familiale?: string;
  nombre_enfants?: number;
  cnss_assujetti?: boolean;
  amo_assujetti?: boolean;
}) {
  const {
    salaire_base,
    heures_sup = 0,
    taux_hs = 1.25,
    primes = 0,
    indemnites_exo = 0,
    avantages_nature = 0,
    cimr_taux = 0,
    situation_familiale = "celibataire",
    nombre_enfants = 0,
    cnss_assujetti = true,
    amo_assujetti = true,
  } = params;

  const taux_horaire = salaire_base / 191;
  const montant_hs = Math.round(heures_sup * taux_horaire * taux_hs * 100) / 100;
  // Les indemnités exonérées (transport, panier… dans les limites légales) sont
  // VERSÉES au salarié mais n'entrent ni dans la base IR ni dans l'assiette des
  // cotisations. Elles étaient retranchées d'un brut qui ne les contenait pas :
  // le salarié perdait l'indemnité et son IR était minoré d'autant.
  const brut_global = salaire_base + montant_hs + primes + avantages_nature + indemnites_exo;
  const brut_imposable = brut_global - indemnites_exo;

  // Assiette des cotisations sociales : le brut imposable (avantages en nature compris).
  const base_cnss = Math.min(brut_imposable, TAUX_PAIE.cnss_plafond);
  const cnss_salarie = cnss_assujetti ? Math.round(base_cnss * TAUX_PAIE.cnss_salarie * 100) / 100 : 0;
  // Part patronale CNSS : prestations sociales (plafonnées) + allocations familiales (déplafonnées).
  const cnss_patronal = cnss_assujetti
    ? Math.round((base_cnss * TAUX_PAIE.cnss_patronal + brut_imposable * TAUX_PAIE.allocations_familiales) * 100) / 100
    : 0;
  const amo_salarie = amo_assujetti ? Math.round(brut_imposable * TAUX_PAIE.amo_salarie * 100) / 100 : 0;
  const amo_patronal = amo_assujetti ? Math.round(brut_imposable * TAUX_PAIE.amo_patronal * 100) / 100 : 0;
  const cimr_salarie = Math.round(brut_imposable * (cimr_taux / 100) * 100) / 100;
  const cimr_patronal = cimr_salarie;

  const frais_pro = fraisProfessionnels(brut_imposable);
  const base_ir = Math.max(0, brut_imposable - frais_pro - cnss_salarie - amo_salarie - cimr_salarie);
  const base_ir_annuelle = base_ir * 12;

  let ir_annuel = 0;
  for (const t of BAREME_IR) {
    if (base_ir_annuelle > t.min) {
      ir_annuel = Math.max(0, base_ir_annuelle * t.taux - t.deduction);
      if (base_ir_annuelle <= t.max) break;
    }
  }
  const ir_brut = ir_annuel / 12;

  // Le conjoint et les enfants à charge comptent ensemble dans la limite de 6.
  const personnes = Math.min(
    (situation_familiale !== "celibataire" ? 1 : 0) + Math.max(0, nombre_enfants),
    TAUX_PAIE.personnes_a_charge_max,
  );
  const ded_annuelle = personnes * TAUX_PAIE.deduction_famille_annuelle;
  const deduction_familiale = ded_annuelle / 12;
  const ir_net = Math.max(0, Math.round((ir_brut - deduction_familiale) * 100) / 100);

  const total_retenues = Math.round((cnss_salarie + amo_salarie + cimr_salarie + ir_net) * 100) / 100;
  // L'avantage en nature est imposable et cotisable, mais déjà fourni en nature
  // (logement, véhicule…) : il ne se paie pas une seconde fois en espèces.
  const net_a_payer = Math.round((brut_global - total_retenues - avantages_nature) * 100) / 100;
  const tfp = Math.round(brut_imposable * TAUX_PAIE.tfp * 100) / 100;
  const cout_employeur = Math.round((brut_global + cnss_patronal + amo_patronal + cimr_patronal + tfp) * 100) / 100;

  return {
    montant_hs, brut_global, brut_imposable,
    cnss_salarie, amo_salarie, cimr_salarie,
    cnss_patronal, amo_patronal, cimr_patronal,
    base_ir, ir_brut, deduction_familiale, ir_net,
    total_retenues, net_a_payer, tfp, cout_employeur,
  };
}

// ── Server function : calculer + sauvegarder bulletin ─────────────────────────
export const genererBulletin = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({
    dossier_id: z.string().uuid(),
    employe_id: z.string().uuid(),
    periode: z.string(), // YYYY-MM
    heures_sup: z.number().default(0),
    primes: z.number().default(0),
    indemnites_exo: z.number().default(0),
    avantages_nature: z.number().default(0),
    date_paiement: z.string().optional(),
    lignes_extra: z.array(z.object({
      type: z.enum(["prime", "retenue", "indemnite", "avantage"]),
      libelle: z.string(),
      montant: z.number(),
      imposable: z.boolean().default(true),
    })).default([]),
  }).parse(input))
  .handler(async ({ data }) => {
    const supabase = getSupabase();

    const { data: emp } = await supabase.from("employes" as any).select("*").eq("id", data.employe_id).single();
    if (!emp) throw new Error("Employé introuvable");

    // Calculer les primes des lignes extra imposables
    const primesExtra = data.lignes_extra.filter(l => l.type === "prime" && l.imposable).reduce((s, l) => s + l.montant, 0);
    const retenuesExtra = data.lignes_extra.filter(l => l.type === "retenue").reduce((s, l) => s + l.montant, 0);

    const calcul = calculBulletin({
      salaire_base: Number(emp.salaire_base),
      heures_sup: data.heures_sup,
      primes: data.primes + primesExtra,
      indemnites_exo: data.indemnites_exo,
      avantages_nature: data.avantages_nature,
      cimr_taux: Number(emp.cimr_taux || 0),
      situation_familiale: emp.situation_familiale,
      nombre_enfants: Number(emp.nombre_enfants || 0),
      cnss_assujetti: emp.cnss_assujetti,
      amo_assujetti: emp.amo_assujetti,
    });

    const net_final = calcul.net_a_payer - retenuesExtra;

    const { data: bulletin, error } = await (supabase as any).from("bulletins_paie").insert({
      dossier_id: data.dossier_id,
      employe_id: data.employe_id,
      periode: data.periode,
      date_paiement: data.date_paiement ?? null,
      salaire_base: Number(emp.salaire_base),
      heures_sup: data.heures_sup,
      montant_heures_sup: calcul.montant_hs,
      primes: data.primes + primesExtra,
      indemnites: data.indemnites_exo,
      avantages_nature: data.avantages_nature,
      brut_imposable: calcul.brut_imposable,
      cnss_salarie: calcul.cnss_salarie,
      amo_salarie: calcul.amo_salarie,
      cimr_salarie: calcul.cimr_salarie,
      base_ir: calcul.base_ir,
      ir_brut: calcul.ir_brut,
      deduction_familiale: calcul.deduction_familiale,
      ir_net: calcul.ir_net,
      cnss_patronal: calcul.cnss_patronal,
      amo_patronal: calcul.amo_patronal,
      cimr_patronal: calcul.cimr_patronal,
      taxe_formation_pro: calcul.tfp,
      total_retenues: calcul.total_retenues + retenuesExtra,
      net_a_payer: net_final,
      cout_employeur: calcul.cout_employeur,
      statut: "brouillon",
    }).select().single();

    if (error) throw new Error(error.message);

    // Lignes extra
    if (data.lignes_extra.length > 0) {
      await (supabase as any).from("lignes_paie").insert(
        data.lignes_extra.map(l => ({ bulletin_id: bulletin.id, ...l }))
      );
    }

    return { bulletin, calcul };
  });

// ── Valider bulletin + créer écritures comptables ─────────────────────────────
export const validerBulletin = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ bulletin_id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const supabase = getSupabase();

    const { data: b } = await (supabase as any).from("bulletins_paie").select("*, employes(nom,prenom)").eq("id", data.bulletin_id).single();
    if (!b) throw new Error("Bulletin introuvable");
    if (b.ecriture_creee) throw new Error("Bulletin déjà validé");

    const nom = `${b.employes?.prenom} ${b.employes?.nom}`;

    // Lignes construites et contrôlées par la lib pure (net à payer en 4432,
    // partie double et référentiel PCM vérifiés AVANT l'insert).
    const lignes = lignesEcrituresPaie(b, nom);
    assertLignesPaie(lignes, b);
    // Erreur RENDUE par Supabase, pas levée : sans ce contrôle, le bulletin
    // passait « validé, écriture créée » sans écriture — et ne pouvait plus
    // jamais être revalidé (garde `ecriture_creee` ci-dessus).
    const { error: ePaie } = await supabase.from("ecritures_comptables").insert(normaliserComptesLignes(lignes));
    if (ePaie) throw new Error(`Écritures de paie refusées : ${ePaie.message}`);

    await (supabase as any).from("bulletins_paie").update({ statut: "valide", ecriture_creee: true }).eq("id", data.bulletin_id);

    return { ok: true };
  });
