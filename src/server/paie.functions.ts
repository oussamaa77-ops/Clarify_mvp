import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

function getSupabase() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";
  return createClient(url, key);
}

// ── Taux officiels Maroc 2024 ─────────────────────────────────────────────────
export const TAUX_PAIE = {
  cnss_salarie: 0.0448,
  cnss_patronal: 0.0898,
  cnss_plafond: 9000,
  amo_salarie: 0.0226,
  amo_patronal: 0.0411,
  tfp: 0.016,
  frais_pro_taux: 0.20,
  frais_pro_max: 2500,
};

export const BAREME_IR = [
  { min: 0,      max: 30000,   taux: 0,    deduction: 0 },
  { min: 30001,  max: 50000,   taux: 0.10, deduction: 3000 },
  { min: 50001,  max: 60000,   taux: 0.15, deduction: 5500 },
  { min: 60001,  max: 80000,   taux: 0.20, deduction: 8500 },
  { min: 80001,  max: 180000,  taux: 0.30, deduction: 16500 },
  { min: 180001, max: Infinity, taux: 0.34, deduction: 23700 },
];

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
  const brut_global = salaire_base + montant_hs + primes + avantages_nature;
  const brut_imposable = brut_global - indemnites_exo;

  const base_cnss = Math.min(brut_global, TAUX_PAIE.cnss_plafond);
  const cnss_salarie = cnss_assujetti ? Math.round(base_cnss * TAUX_PAIE.cnss_salarie * 100) / 100 : 0;
  const cnss_patronal = cnss_assujetti ? Math.round(base_cnss * TAUX_PAIE.cnss_patronal * 100) / 100 : 0;
  const amo_salarie = amo_assujetti ? Math.round(brut_global * TAUX_PAIE.amo_salarie * 100) / 100 : 0;
  const amo_patronal = amo_assujetti ? Math.round(brut_global * TAUX_PAIE.amo_patronal * 100) / 100 : 0;
  const cimr_salarie = Math.round(brut_global * (cimr_taux / 100) * 100) / 100;
  const cimr_patronal = cimr_salarie;

  const frais_pro = Math.min(brut_imposable * TAUX_PAIE.frais_pro_taux, TAUX_PAIE.frais_pro_max);
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

  const nb_enfants_ded = Math.min(nombre_enfants, 6);
  const ded_annuelle = (situation_familiale !== "celibataire" ? 360 : 0) + nb_enfants_ded * 360;
  const deduction_familiale = ded_annuelle / 12;
  const ir_net = Math.max(0, Math.round((ir_brut - deduction_familiale) * 100) / 100);

  const total_retenues = Math.round((cnss_salarie + amo_salarie + cimr_salarie + ir_net) * 100) / 100;
  const net_a_payer = Math.round((brut_global - total_retenues) * 100) / 100;
  const tfp = Math.round(brut_global * TAUX_PAIE.tfp * 100) / 100;
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
    const ref = `PAIE-${b.periode}`;

    await supabase.from("ecritures_comptables").insert([
      // Charge salariale brute
      { dossier_id: b.dossier_id, journal_code: "OD", compte_numero: "6171", date_ecriture: b.date_paiement ?? b.periode + "-01", libelle: `Salaire ${nom} ${b.periode}`, debit: Number(b.net_a_payer) + Number(b.total_retenues), credit: 0, reference_piece: ref, valide: true },
      // CNSS + AMO salarial (retenu sur salaire)
      { dossier_id: b.dossier_id, journal_code: "OD", compte_numero: "4441", date_ecriture: b.date_paiement ?? b.periode + "-01", libelle: `CNSS salarial ${nom}`, debit: 0, credit: Number(b.cnss_salarie) + Number(b.amo_salarie), reference_piece: ref, valide: true },
      // IR retenu à la source
      { dossier_id: b.dossier_id, journal_code: "OD", compte_numero: "4443", date_ecriture: b.date_paiement ?? b.periode + "-01", libelle: `IR/salaire ${nom}`, debit: 0, credit: Number(b.ir_net), reference_piece: ref, valide: true },
      // Net à payer
      { dossier_id: b.dossier_id, journal_code: "OD", compte_numero: "4441", date_ecriture: b.date_paiement ?? b.periode + "-01", libelle: `Net à payer ${nom}`, debit: 0, credit: Number(b.net_a_payer), reference_piece: ref, valide: true },
      // Charges patronales CNSS/AMO
      { dossier_id: b.dossier_id, journal_code: "OD", compte_numero: "6174", date_ecriture: b.date_paiement ?? b.periode + "-01", libelle: `Charges sociales patronales ${nom}`, debit: Number(b.cnss_patronal) + Number(b.amo_patronal) + Number(b.taxe_formation_pro), credit: 0, reference_piece: ref, valide: true },
      { dossier_id: b.dossier_id, journal_code: "OD", compte_numero: "4441", date_ecriture: b.date_paiement ?? b.periode + "-01", libelle: `CNSS/AMO patronal ${nom}`, debit: 0, credit: Number(b.cnss_patronal) + Number(b.amo_patronal) + Number(b.taxe_formation_pro), reference_piece: ref, valide: true },
    ]);

    await (supabase as any).from("bulletins_paie").update({ statut: "valide", ecriture_creee: true }).eq("id", data.bulletin_id);

    return { ok: true };
  });
