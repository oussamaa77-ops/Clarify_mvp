// ============================================================================
// rappel-tva.batch.ts — Envoi AUTOMATIQUE (J-3) des rappels d'échéance TVA.
//
// Logique métier réutilisable, SANS runtime TanStack : appelable depuis une
// server fn (déclenchement manuel) OU depuis un script planifié (cron / Task
// Scheduler / cron hébergé) — cf. scripts/cron-rappel-tva.ts.
//
// Pour CHAQUE dossier actif :
//   1. calcule la TVA nette du dernier mois clos + la date d'échéance (20 du
//      mois suivant, régime mensuel) — même règle que la carte du Dashboard ;
//   2. si l'échéance tombe dans la fenêtre J-<fenetreJours> (défaut 3) et qu'il
//      reste de la TVA à verser, envoie le rappel au GÉRANT (created_by →
//      profils ; repli dossier_access ; repli email_societe) ;
//   3. IDEMPOTENCE : une entrée `alertes` (type=rappel_tva, marqueur période)
//      empêche tout doublon si le cron tourne plusieurs fois / rattrape un jour
//      manqué. Le rappel apparaît aussi dans le centre d'alertes de l'app.
// ============================================================================

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { sendMail } from "./mailer";
import { rappelEcheanceTVA } from "./email.templates";

// fetch tolérant au proxy TLS d'entreprise (repli undici sans vérif TLS).
let PROXY_DIRECT = false;
async function proxyFetch(input: any, init?: any): Promise<Response> {
  if (PROXY_DIRECT) {
    const { fetch: uf, Agent } = await import("undici");
    return (uf as any)(String(input), { ...init, dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) });
  }
  try { return await fetch(String(input), init); }
  catch {
    PROXY_DIRECT = true;
    const { fetch: uf, Agent } = await import("undici");
    return (uf as any)(String(input), { ...init, dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) });
  }
}
function getSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (i: any, init?: any) => proxyFetch(i, init) } });
}

const ddmmyyyy = (d: Date) =>
  `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;

export interface RappelTVADetail {
  dossier: string;
  periode: string | null;
  montant: number;
  echeance: string | null;
  jours: number | null;
  statut: string;   // "envoyé" | "déjà envoyé" | "hors fenêtre" | "pas de TVA due" | ...
  to?: string;
}
export interface RappelTVAResult {
  scanned: number;
  envoyes: number;
  ignores: number;
  details: RappelTVADetail[];
}

export async function executerRappelsTVAJ3(
  opts?: { fenetreJours?: number; dryRun?: boolean }
): Promise<RappelTVAResult> {
  const fenetreJours = opts?.fenetreJours ?? 3;
  const dryRun = opts?.dryRun ?? false;
  const sb = getSupabase();

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const res: RappelTVAResult = { scanned: 0, envoyes: 0, ignores: 0, details: [] };

  // 1) Dossiers actifs + comptes de TVA + accès + profils (résolution du gérant).
  const [{ data: dossiers }, { data: acces }] = await Promise.all([
    (sb as any).from("dossiers").select("id,nom_societe,created_by,email_societe").eq("statut", "actif"),
    (sb as any).from("dossier_access").select("dossier_id,user_id,role"),
  ]);

  const userIds = new Set<string>();
  for (const d of dossiers ?? []) if (d.created_by) userIds.add(d.created_by);
  for (const a of acces ?? []) if (a.user_id) userIds.add(a.user_id);
  const { data: profils } = userIds.size
    ? await (sb as any).from("profiles").select("id,email,nom,prenom").in("id", Array.from(userIds))
    : { data: [] as any[] };
  const profilById = new Map<string, { email: string; nom: string | null; prenom: string | null }>();
  for (const p of profils ?? []) profilById.set(p.id, { email: p.email, nom: p.nom, prenom: p.prenom });

  const accesParDossier = new Map<string, { user_id: string; role: string }[]>();
  for (const a of acces ?? []) {
    const arr = accesParDossier.get(a.dossier_id) ?? [];
    arr.push({ user_id: a.user_id, role: a.role });
    accesParDossier.set(a.dossier_id, arr);
  }

  // Résout l'e-mail + nom du gérant d'un dossier (jamais un tiers externe).
  const resoudreGerant = (d: any): { to: string; nom?: string } | null => {
    const fromProfil = (uid?: string | null) => {
      const p = uid ? profilById.get(uid) : undefined;
      if (p?.email) return { to: p.email, nom: [p.prenom, p.nom].filter(Boolean).join(" ").trim() || undefined };
      return null;
    };
    // a) créateur du dossier = gérant/propriétaire
    const owner = fromProfil(d.created_by);
    if (owner) return owner;
    // b) un utilisateur ayant accès (priorité chef_entreprise/gérant)
    const list = accesParDossier.get(d.id) ?? [];
    const ordered = [...list].sort((x, y) => rolePoids(y.role) - rolePoids(x.role));
    for (const a of ordered) { const p = fromProfil(a.user_id); if (p) return p; }
    // c) repli : e-mail générique de la société
    if (d.email_societe) return { to: d.email_societe };
    return null;
  };

  for (const d of dossiers ?? []) {
    res.scanned++;
    const nomSociete = d.nom_societe ?? "Dossier";

    // Écritures TVA du dossier (mêmes comptes que la carte Dashboard / Fiscalité).
    const { data: ecr } = await (sb as any).from("ecritures_comptables")
      .select("compte_numero,debit,credit,date_ecriture")
      .eq("dossier_id", d.id).in("compte_numero", ["44551", "34552"]);

    const mois = [...new Set((ecr ?? []).map((e: any) => e.date_ecriture?.slice(0, 7)).filter(Boolean))].sort() as string[];
    const periode = mois[mois.length - 1] ?? null;
    if (!periode) { res.details.push({ dossier: nomSociete, periode: null, montant: 0, echeance: null, jours: null, statut: "aucune écriture TVA" }); res.ignores++; continue; }

    const ecrMois = (ecr ?? []).filter((e: any) => e.date_ecriture?.startsWith(periode));
    const collectee = ecrMois.filter((e: any) => e.compte_numero === "44551").reduce((s: number, e: any) => s + Number(e.credit) - Number(e.debit), 0);
    const recup = ecrMois.filter((e: any) => e.compte_numero === "34552").reduce((s: number, e: any) => s + Number(e.debit) - Number(e.credit), 0);
    const nette = Number((collectee - recup).toFixed(2));
    // Échéance = 20 du mois SUIVANT le mois déclaré (JS month index = Number(MM)).
    const echeance = new Date(Number(periode.slice(0, 4)), Number(periode.slice(5, 7)), 20);
    const jours = Math.ceil((echeance.getTime() - today.getTime()) / 86400000);
    const echStr = ddmmyyyy(echeance);

    if (nette <= 0) { res.details.push({ dossier: nomSociete, periode, montant: nette, echeance: echStr, jours, statut: "crédit / pas de TVA due" }); res.ignores++; continue; }
    // Fenêtre J-<fenetreJours> : on déclenche dès qu'il reste ≤ N jours (≥ 0),
    // ce qui rattrape un éventuel jour de cron manqué ; l'idempotence évite les doublons.
    if (!(jours >= 0 && jours <= fenetreJours)) { res.details.push({ dossier: nomSociete, periode, montant: nette, echeance: echStr, jours, statut: `hors fenêtre (J-${jours})` }); res.ignores++; continue; }

    const gerant = resoudreGerant(d);
    if (!gerant) { res.details.push({ dossier: nomSociete, periode, montant: nette, echeance: echStr, jours, statut: "aucun e-mail gérant" }); res.ignores++; continue; }

    // IDEMPOTENCE : déjà envoyé pour ce (dossier, période) ?
    const marqueur = `[rappel_tva:${periode}]`;
    const { data: dejaEnvoye } = await (sb as any).from("alertes")
      .select("id").eq("dossier_id", d.id).eq("type", "rappel_tva").ilike("message", `%${marqueur}%`).limit(1).maybeSingle();
    if (dejaEnvoye) { res.details.push({ dossier: nomSociete, periode, montant: nette, echeance: echStr, jours, statut: "déjà envoyé", to: gerant.to }); res.ignores++; continue; }

    if (dryRun) { res.details.push({ dossier: nomSociete, periode, montant: nette, echeance: echStr, jours, statut: "à envoyer (dry-run)", to: gerant.to }); continue; }

    // Envoi du rappel via SMTP.
    const { subject, html, text } = rappelEcheanceTVA({
      gerantNom: gerant.nom, societeNom: nomSociete, montantTVA: nette, periode, dateEcheance: echStr, joursRestants: jours,
    });
    try {
      await sendMail({ to: gerant.to, toName: gerant.nom, subject, html, text });
      res.envoyes++;
      res.details.push({ dossier: nomSociete, periode, montant: nette, echeance: echStr, jours, statut: "envoyé", to: gerant.to });
      // Trace + marqueur d'idempotence (best-effort) dans le centre d'alertes.
      await (sb as any).from("alertes").insert({
        dossier_id: d.id, type: "rappel_tva", lue: false,
        titre: `Rappel TVA ${periode} envoyé`,
        message: `${marqueur} TVA nette ${nette.toLocaleString("fr-FR", { minimumFractionDigits: 2 })} MAD à verser avant le ${echStr} — envoyé à ${gerant.to}`,
      });
    } catch (e: any) {
      res.ignores++;
      res.details.push({ dossier: nomSociete, periode, montant: nette, echeance: echStr, jours, statut: `échec envoi: ${e?.message ?? e}`, to: gerant.to });
    }
  }

  return res;
}

// Priorité de rôle pour choisir le destinataire le plus « gérant » en repli.
function rolePoids(role: string): number {
  switch (role) {
    case "chef_entreprise": return 4;
    case "expert_comptable": return 3;
    case "assistant_cabinet": return 2;
    case "collaborateur": return 1;
    default: return 0;
  }
}
