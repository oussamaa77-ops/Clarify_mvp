// HTML email templates for HisabPro

export function emailFactureClient(opts: {
  clientNom: string;
  numeroFacture: string;
  montantTTC: number;
  dateEcheance: string | null;
  dgiUuid: string;
  hashSha256: string;
  societeNom: string;
}): { subject: string; html: string } {
  const fmt = (n: number) => n.toLocaleString("fr-MA", { minimumFractionDigits: 2 }) + " MAD";

  return {
    subject: `Facture ${opts.numeroFacture} — ${opts.societeNom}`,
    html: `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><style>
  body { font-family: Arial, sans-serif; background: #f4f4f4; margin: 0; padding: 20px; }
  .card { background: white; border-radius: 8px; padding: 32px; max-width: 600px; margin: 0 auto; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
  .header { border-bottom: 2px solid #2563eb; padding-bottom: 16px; margin-bottom: 24px; }
  .badge { display: inline-block; background: #22c55e; color: white; padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: bold; }
  .row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f0f0f0; }
  .label { color: #666; font-size: 14px; }
  .value { font-weight: bold; font-size: 14px; }
  .total { background: #f0f7ff; padding: 16px; border-radius: 6px; margin-top: 16px; }
  .mono { font-family: monospace; font-size: 11px; color: #888; word-break: break-all; }
  .footer { margin-top: 24px; padding-top: 16px; border-top: 1px solid #eee; font-size: 12px; color: #888; }
</style></head>
<body>
<div class="card">
  <div class="header">
    <h2 style="margin:0;color:#1e3a5f">🧾 ${opts.societeNom}</h2>
    <span class="badge">✅ Conforme DGI</span>
  </div>
  
  <p>Bonjour <strong>${opts.clientNom}</strong>,</p>
  <p>Votre facture a été émise et validée par la Direction Générale des Impôts (DGI) du Maroc.</p>

  <div class="row"><span class="label">N° Facture</span><span class="value">${opts.numeroFacture}</span></div>
  <div class="row"><span class="label">Montant TTC</span><span class="value" style="color:#2563eb">${fmt(opts.montantTTC)}</span></div>
  ${opts.dateEcheance ? `<div class="row"><span class="label">Date d'échéance</span><span class="value">${new Date(opts.dateEcheance).toLocaleDateString("fr-MA")}</span></div>` : ""}

  <div class="total">
    <div class="label">UUID DGI</div>
    <div class="mono">${opts.dgiUuid}</div>
    <div class="label" style="margin-top:8px">Empreinte SHA-256</div>
    <div class="mono">${opts.hashSha256}</div>
  </div>

  <div class="footer">
    <p>Cette facture est archivée dans la GED de HisabPro avec horodatage et scellement cryptographique.</p>
    <p>HisabPro — Comptabilité & e-Facture DGI Maroc 2026</p>
  </div>
</div>
</body>
</html>`,
  };
}

export function emailFactureRejetee(opts: {
  comptableEmail: string;
  numeroFacture: string;
  clientNom: string;
  erreurs: string[];
  dgiResponse: any;
}): { subject: string; html: string } {
  return {
    subject: `⚠️ Facture ${opts.numeroFacture} rejetée par la DGI`,
    html: `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><style>
  body { font-family: Arial, sans-serif; background: #f4f4f4; margin: 0; padding: 20px; }
  .card { background: white; border-radius: 8px; padding: 32px; max-width: 600px; margin: 0 auto; }
  .alert { background: #fef2f2; border: 1px solid #fca5a5; border-radius: 6px; padding: 16px; margin: 16px 0; }
  li { margin: 4px 0; color: #dc2626; }
</style></head>
<body>
<div class="card">
  <h2>⚠️ Rejet DGI — Facture ${opts.numeroFacture}</h2>
  <p>La facture émise pour <strong>${opts.clientNom}</strong> a été rejetée par la DGI.</p>
  <div class="alert">
    <strong>Motifs de rejet :</strong>
    <ul>${opts.erreurs.map((e) => `<li>${e}</li>`).join("")}</ul>
  </div>
  <p>Veuillez corriger la facture et la soumettre à nouveau.</p>
  <p style="font-size:12px;color:#888">HisabPro — Piste d'audit conservée</p>
</div>
</body>
</html>`,
  };
}

// Alerte INTERNE (pas un tiers) : rappel au gérant du dossier que la TVA nette
// du dernier mois clos arrive à échéance. Reprend les données de la carte rouge
// du Dashboard (montant net, période, date limite d'exigibilité).
export function rappelEcheanceTVA(opts: {
  gerantNom?: string | null;
  societeNom: string;
  montantTVA: number;        // TVA nette à verser (DH)
  periode: string;           // mois concerné, ex. « 2026-04 »
  dateEcheance: string;      // date limite d'exigibilité, ex. « 20/05/2026 »
  joursRestants?: number | null; // >0 = à venir, <0 = en retard
}): { subject: string; html: string; text: string } {
  const fmt = (n: number) => n.toLocaleString("fr-MA", { minimumFractionDigits: 2 }) + " MAD";
  const montant = fmt(opts.montantTVA);
  const j = opts.joursRestants ?? null;
  const enRetard = j !== null && j < 0;
  const statut =
    j === null ? "" :
    enRetard ? `⚠️ En retard de ${Math.abs(j)} jour(s)` :
    j === 0 ? "⏰ À verser aujourd'hui" :
    `Dans ${j} jour(s)`;
  const accent = enRetard ? "#dc2626" : (j !== null && j <= 7) ? "#ea580c" : "#2563eb";
  const bonjour = opts.gerantNom ? `Bonjour ${opts.gerantNom},` : "Bonjour,";

  const text = [
    `Rappel interne — Échéance TVA (${opts.societeNom})`,
    ``,
    bonjour,
    ``,
    `La TVA nette de la période ${opts.periode} arrive à échéance.`,
    ``,
    `  • TVA nette à verser : ${montant}`,
    `  • Période concernée  : ${opts.periode}`,
    `  • Date limite        : ${opts.dateEcheance}`,
    statut ? `  • Statut             : ${statut}` : ``,
    ``,
    `Pensez à préparer et télédéclarer la TVA avant la date limite (portail SIMPL-TVA / DGI).`,
    ``,
    `— ${opts.societeNom} · Rappel automatique HisabPro`,
  ].filter(Boolean).join("\n");

  return {
    subject: `⏰ Rappel TVA ${opts.periode} — ${montant} à verser avant le ${opts.dateEcheance}`,
    text,
    html: `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><style>
  body { font-family: Arial, sans-serif; background: #f4f4f4; margin: 0; padding: 20px; }
  .card { background: white; border-radius: 8px; padding: 32px; max-width: 600px; margin: 0 auto; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
  .header { border-bottom: 2px solid ${accent}; padding-bottom: 16px; margin-bottom: 24px; }
  .badge { display: inline-block; background: ${accent}; color: white; padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: bold; }
  .row { padding: 10px 0; border-bottom: 1px solid #f0f0f0; }
  .label { color: #666; font-size: 14px; }
  .value { font-weight: bold; font-size: 15px; float: right; }
  .amount { background: #fff7ed; border: 1px solid #fed7aa; padding: 16px; border-radius: 6px; margin: 20px 0; text-align: center; }
  .amount .big { font-size: 28px; font-weight: bold; color: ${accent}; }
  .footer { margin-top: 24px; padding-top: 16px; border-top: 1px solid #eee; font-size: 12px; color: #888; }
</style></head>
<body>
<div class="card">
  <div class="header">
    <h2 style="margin:0;color:#1e3a5f">🧾 ${opts.societeNom}</h2>
    <span class="badge">Rappel interne — Échéance TVA</span>
  </div>

  <p>${bonjour}</p>
  <p>La <strong>TVA nette</strong> de la période <strong>${opts.periode}</strong> arrive à échéance.</p>

  <div class="amount">
    <div class="label">TVA nette à verser</div>
    <div class="big">${montant}</div>
    ${statut ? `<div style="margin-top:6px;color:${accent};font-weight:bold;font-size:13px">${statut}</div>` : ""}
  </div>

  <div class="row"><span class="label">Période concernée</span><span class="value">${opts.periode}</span></div>
  <div class="row"><span class="label">Date limite d'exigibilité</span><span class="value" style="color:${accent}">${opts.dateEcheance}</span></div>

  <p style="margin-top:20px">Pensez à préparer et télédéclarer la TVA avant la date limite (portail SIMPL-TVA / DGI).</p>

  <div class="footer">
    <p>Ceci est un rappel automatique interne HisabPro — aucune donnée n'a été transmise à un tiers.</p>
    <p>HisabPro — Comptabilité & e-Facture DGI Maroc 2026</p>
  </div>
</div>
</body>
</html>`,
  };
}

export function emailInvitation(opts: {
  inviteEmail: string;
  inviteurNom: string;
  cabinetNom: string;
  role: string;
  token: string;
  baseUrl: string;
}): { subject: string; html: string } {
  const roleLabel: Record<string, string> = {
    expert_comptable: "Expert Comptable",
    assistant_cabinet: "Assistant Cabinet",
    chef_entreprise: "Chef d'Entreprise",
    collaborateur: "Collaborateur",
  };

  return {
    subject: `Invitation HisabPro — ${opts.cabinetNom}`,
    html: `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;background:#f4f4f4;padding:20px">
<div style="background:white;border-radius:8px;padding:32px;max-width:600px;margin:0 auto">
  <h2>🧾 Invitation HisabPro</h2>
  <p><strong>${opts.inviteurNom}</strong> vous invite à rejoindre le cabinet <strong>${opts.cabinetNom}</strong> en tant que <strong>${roleLabel[opts.role] ?? opts.role}</strong>.</p>
  <div style="text-align:center;margin:32px 0">
    <a href="${opts.baseUrl}/auth?token=${opts.token}" style="background:#2563eb;color:white;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:bold">
      Accepter l'invitation
    </a>
  </div>
  <p style="color:#888;font-size:12px">Ce lien expire dans 48h.</p>
</div>
</body>
</html>`,
  };
}
