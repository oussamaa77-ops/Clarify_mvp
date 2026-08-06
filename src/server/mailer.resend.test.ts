import { describe, it, expect, afterEach } from "vitest";
import { decrireErreurResend, resendFrom, resendEnBacASable, estPanneReseau } from "./mailer.resend";

// Charges utiles RÉELLES relevées sur l'API Resend (2026-08-06), pas des
// suppositions : c'est ce que le serveur recevra en production.
const REFUS_BAC_A_SABLE = {
  statusCode: 403,
  name: "validation_error",
  message:
    "You can only send testing emails to your own email address (oussamakarmaoui7@gmail.com). " +
    "To send emails to other recipients, please verify a domain at resend.com/domains, " +
    "and change the `from` address to an email using this domain.",
};

const REFUS_CLE_RESTREINTE = {
  statusCode: 401,
  name: "restricted_api_key",
  message: "This API key is restricted to only send emails",
};

const FROM = "Clarify <onboarding@resend.dev>";

afterEach(() => {
  delete process.env.RESEND_FROM;
});

describe("decrireErreurResend", () => {
  it("conserve le code HTTP, le nom et le message de l'API", () => {
    const m = decrireErreurResend(REFUS_BAC_A_SABLE, FROM, "client@exemple.ma");
    expect(m).toContain("HTTP 403");
    expect(m).toContain("validation_error");
    expect(m).toContain("You can only send testing emails");
  });

  it("nomme l'expéditeur ET le destinataire — un log sans eux n'est pas exploitable", () => {
    const m = decrireErreurResend(REFUS_BAC_A_SABLE, FROM, "client@exemple.ma");
    expect(m).toContain("from=Clarify <onboarding@resend.dev>");
    expect(m).toContain("to=client@exemple.ma");
  });

  it("traduit le refus du bac à sable en action concrète", () => {
    const m = decrireErreurResend(REFUS_BAC_A_SABLE, FROM, "client@exemple.ma");
    expect(m).toMatch(/resend\.com\/domains/);
    expect(m).toContain("RESEND_FROM");
  });

  it("distingue une clé restreinte d'une clé invalide", () => {
    const m = decrireErreurResend(REFUS_CLE_RESTREINTE, FROM, "admin@exemple.ma");
    expect(m).toContain("sending only");
    // Ne doit PAS envoyer régénérer une clé qui fonctionne pour l'envoi.
    expect(m).not.toContain("révoquée");
  });

  it("reste lisible sur une erreur sans forme connue", () => {
    const m = decrireErreurResend("panne inattendue", FROM, "admin@exemple.ma");
    expect(m).toContain("panne inattendue");
    expect(m).toContain("to=admin@exemple.ma");
  });
});

describe("estPanneReseau", () => {
  // Enveloppe RÉELLE du SDK Resend derrière le proxy TLS d'entreprise
  // (relevée le 2026-08-06) : ni code, ni cause, ni statut HTTP.
  const PANNE_SDK = {
    name: "application_error",
    statusCode: null,
    message: "Unable to fetch data. The request could not be resolved.",
  };

  it("reconnaît l'enveloppe application_error du SDK comme une panne RÉSEAU", () => {
    // Sans ce cas, le repli undici ne se déclenche pas et un simple blocage
    // proxy se lit comme un refus de l'API.
    expect(estPanneReseau(PANNE_SDK)).toBe(true);
  });

  it("reconnaît toujours les pannes réseau nues", () => {
    expect(estPanneReseau(new Error("fetch failed"))).toBe(true);
    expect(estPanneReseau({ code: "ETIMEDOUT", message: "connect ETIMEDOUT" })).toBe(true);
    expect(estPanneReseau({ message: "unable to verify the first certificate" })).toBe(true);
  });

  it("ne prend PAS un refus applicatif pour une panne réseau", () => {
    // Retenter un 403 par un autre chemin réseau serait vain : la distinction
    // est ce qui évite de doubler chaque envoi refusé.
    expect(estPanneReseau(REFUS_BAC_A_SABLE)).toBe(false);
    expect(estPanneReseau(REFUS_CLE_RESTREINTE)).toBe(false);
  });
});

describe("resendFrom / resendEnBacASable", () => {
  it("retombe sur le bac à sable quand RESEND_FROM n'est pas posée", () => {
    delete process.env.RESEND_FROM;
    expect(resendFrom()).toContain("onboarding@resend.dev");
    expect(resendEnBacASable()).toBe(true);
  });

  it("sort du bac à sable dès qu'un domaine vérifié est configuré", () => {
    process.env.RESEND_FROM = "Clarify <contact@clarify.ma>";
    expect(resendFrom()).toBe("Clarify <contact@clarify.ma>");
    expect(resendEnBacASable()).toBe(false);
  });
});
