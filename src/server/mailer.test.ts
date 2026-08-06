import { describe, it, expect, afterEach, vi } from "vitest";
import { ordreTransports, htmlToText } from "./mailer";

const ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ENV };
  vi.restoreAllMocks();
});

describe("ordreTransports", () => {
  it("place Resend en tête par défaut (HTTPS/443, le port ouvert partout)", () => {
    delete process.env.MAIL_TRANSPORT;
    expect(ordreTransports()).toEqual(["resend", "smtp", "brevo"]);
  });

  it("traite « auto » comme le défaut", () => {
    process.env.MAIL_TRANSPORT = "auto";
    expect(ordreTransports()).toEqual(["resend", "smtp", "brevo"]);
  });

  it("garde l'ancien sens : une valeur seule force CE transport et lui seul", () => {
    process.env.MAIL_TRANSPORT = "smtp";
    expect(ordreTransports()).toEqual(["smtp"]);
  });

  it("accepte une liste ordonnée — SMTP principal, Resend en secours", () => {
    process.env.MAIL_TRANSPORT = "smtp,resend";
    expect(ordreTransports()).toEqual(["smtp", "resend"]);
  });

  it("tolère espaces, points-virgules et casse (saisie à la main dans Railway)", () => {
    process.env.MAIL_TRANSPORT = " SMTP ; Resend ";
    expect(ordreTransports()).toEqual(["smtp", "resend"]);
  });

  it("dédoublonne sans changer l'ordre voulu", () => {
    process.env.MAIL_TRANSPORT = "smtp,resend,smtp";
    expect(ordreTransports()).toEqual(["smtp", "resend"]);
  });

  it("ignore une valeur inconnue, la signale, et garde les valides", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.MAIL_TRANSPORT = "smpt,resend"; // faute de frappe classique
    expect(ordreTransports()).toEqual(["resend"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("smpt"));
  });

  it("retombe sur l'ordre par défaut si TOUT est invalide — jamais zéro transport", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.MAIL_TRANSPORT = "sendgrid";
    expect(ordreTransports()).toEqual(["resend", "smtp", "brevo"]);
  });

  it("traite une valeur vide comme absente", () => {
    process.env.MAIL_TRANSPORT = "   ";
    expect(ordreTransports()).toEqual(["resend", "smtp", "brevo"]);
  });
});

describe("htmlToText", () => {
  it("produit une version texte lisible (absence de partie texte = signal spam)", () => {
    const t = htmlToText("<p>Bonjour</p><p>Votre facture&nbsp;: <strong>1 200 MAD</strong></p>");
    expect(t).toBe("Bonjour\nVotre facture : 1 200 MAD");
  });
});
