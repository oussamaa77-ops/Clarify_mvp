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
