// ============================================================================
// fiscalite.functions.ts — Alertes fiscales INTERNES (gérant du dossier).
//
// envoyerRappelTVA : envoie au gérant/utilisateur courant un rappel d'échéance
// de TVA (données de la carte rouge du Dashboard). Le destinataire est fourni
// par le client (l'e-mail de l'utilisateur connecté) — jamais un tiers externe.
// L'envoi réutilise le service SMTP mutualisé (nodemailer, cf. ./mailer).
// ============================================================================

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { sendMail } from "./mailer";
import { rappelEcheanceTVA } from "./email.templates";
import { executerRappelsTVAJ3 } from "./rappel-tva.batch";

export const envoyerRappelTVA = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({
      to: z.string().email(),            // e-mail du gérant/utilisateur courant
      gerantNom: z.string().optional(),
      societeNom: z.string().default("HisabPro"),
      montantTVA: z.number(),            // TVA nette à verser (DH)
      periode: z.string().min(1),        // ex. « 2026-04 »
      dateEcheance: z.string().min(1),   // ex. « 20/05/2026 »
      joursRestants: z.number().optional(),
    }).parse(input)
  )
  .handler(async ({ data }) => {
    const { subject, html, text } = rappelEcheanceTVA({
      gerantNom: data.gerantNom,
      societeNom: data.societeNom,
      montantTVA: data.montantTVA,
      periode: data.periode,
      dateEcheance: data.dateEcheance,
      joursRestants: data.joursRestants ?? null,
    });

    const r = await sendMail({ to: data.to, toName: data.gerantNom, subject, html, text });
    return { success: true as const, messageId: r.messageId };
  });

// Déclenchement du BATCH J-3 (tous dossiers) — utilisable manuellement depuis
// l'app ou via un scheduler. `fenetreJours` et `dryRun` sont optionnels.
export const runRappelsTVAJ3 = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({
      fenetreJours: z.number().int().min(0).max(31).optional(),
      dryRun: z.boolean().optional(),
    }).parse(input ?? {})
  )
  .handler(async ({ data }) => {
    return await executerRappelsTVAJ3({ fenetreJours: data.fenetreJours, dryRun: data.dryRun });
  });
