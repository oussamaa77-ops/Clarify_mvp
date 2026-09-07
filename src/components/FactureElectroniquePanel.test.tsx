// ============================================================================
// FactureElectroniquePanel.test.tsx — le cycle DGI vu de l'écran.
//
// Ce qui est éprouvé ici n'est pas « React rend du React », mais la règle
// d'interface qui porte tout le module : les actions IMPOSSIBLES ne doivent pas
// être offertes. Une facture scellée par la DGI qui exhiberait un bouton
// « Transmettre » apprendrait à l'utilisateur à ignorer les messages d'erreur —
// et c'est précisément dans ce module qu'il ne faut pas qu'il les ignore.
// ============================================================================

import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

// `useServerFn` n'a de sens que dans le runtime TanStack Start : on le réduit à
// l'identité pour que le composant appelle directement les doublures ci-dessous.
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));

const serveur = {
  journalDgiFacture: vi.fn(),
  genererUblFacture: vi.fn(),
  transmettreFactureDgi: vi.fn(),
  consulterStatutDgi: vi.fn(),
  annulerFactureDgi: vi.fn(),
  genererPdfA3Facture: vi.fn(),
  apercuQrFacture: vi.fn(),
  telechargerUblFacture: vi.fn(),
};
vi.mock("@/server/efacture.functions", () => ({
  journalDgiFacture: (...a: any[]) => serveur.journalDgiFacture(...a),
  genererUblFacture: (...a: any[]) => serveur.genererUblFacture(...a),
  transmettreFactureDgi: (...a: any[]) => serveur.transmettreFactureDgi(...a),
  consulterStatutDgi: (...a: any[]) => serveur.consulterStatutDgi(...a),
  annulerFactureDgi: (...a: any[]) => serveur.annulerFactureDgi(...a),
  genererPdfA3Facture: (...a: any[]) => serveur.genererPdfA3Facture(...a),
  apercuQrFacture: (...a: any[]) => serveur.apercuQrFacture(...a),
  telechargerUblFacture: (...a: any[]) => serveur.telechargerUblFacture(...a),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { BadgeStatutDgi, FactureElectroniquePanel } from "./FactureElectroniquePanel";

const HASH = "a".repeat(64);

function etat(surcharges: Record<string, unknown> = {}) {
  return {
    journal: [],
    dgi_uuid: null,
    dgi_submission_at: null,
    dgi_validated_at: null,
    statut: "DRAFT",
    hash_sha256: null,
    xml_ubl: null,
    connecteur: "HttpDgiConnector",
    production: true,
    ...surcharges,
  };
}

async function monter(surcharges: Record<string, unknown> = {}) {
  serveur.journalDgiFacture.mockResolvedValue(etat(surcharges));
  render(<FactureElectroniquePanel factureId="f-1" numero="FA-2026-0042" />);
  await waitFor(() => expect(screen.queryByText(/Chargement du dossier fiscal/)).toBeNull());
}

describe("BadgeStatutDgi", () => {
  it("nomme chaque état du cycle", () => {
    const { rerender } = render(<BadgeStatutDgi statut="DRAFT" />);
    expect(screen.getByText("Brouillon")).toBeTruthy();
    rerender(<BadgeStatutDgi statut="PENDING_DGI" />);
    expect(screen.getByText("En attente DGI")).toBeTruthy();
    rerender(<BadgeStatutDgi statut="VALIDATED_BY_DGI" />);
    expect(screen.getByText("Conforme DGI")).toBeTruthy();
    rerender(<BadgeStatutDgi statut="REJECTED_BY_DGI" />);
    expect(screen.getByText("Rejetée")).toBeTruthy();
  });

  // Sans cette tolérance, toutes les factures émises avant la migration
  // s'afficheraient « Brouillon » alors qu'elles portent un récépissé DGI.
  it("comprend encore les valeurs de l'ancienne colonne statut_dgi", () => {
    render(<BadgeStatutDgi statut="conforme" />);
    expect(screen.getByText("Conforme DGI")).toBeTruthy();
  });

  it("retombe sur Brouillon devant l'inconnu", () => {
    render(<BadgeStatutDgi statut={null} />);
    expect(screen.getByText("Brouillon")).toBeTruthy();
  });
});

describe("FactureElectroniquePanel — actions offertes selon l'état", () => {
  it("propose la transmission sur un brouillon", async () => {
    await monter();
    expect(screen.getByText("Transmettre à la DGI")).toBeTruthy();
  });

  // Retransmettre créerait un doublon au fichier fiscal : on ne propose pas
  // l'action, on explique le chemin légitime.
  it("retire la transmission d'une facture validée et dit pourquoi", async () => {
    await monter({ statut: "VALIDATED_BY_DGI", dgi_uuid: "u-1", hash_sha256: HASH });
    expect(screen.queryByText("Transmettre à la DGI")).toBeNull();
    expect(screen.getByText(/annulez-la puis émettez un avoir/)).toBeTruthy();
  });

  it("parle de RETRANSMISSION après un rejet", async () => {
    await monter({ statut: "REJECTED_BY_DGI" });
    expect(screen.getByText("Retransmettre à la DGI")).toBeTruthy();
  });

  it("renvoie vers l'actualisation quand la transmission est en cours", async () => {
    await monter({ statut: "PENDING_DGI", dgi_uuid: "u-1" });
    expect(screen.queryByText("Transmettre à la DGI")).toBeNull();
    expect(screen.getByText(/actualisez le statut/i)).toBeTruthy();
  });

  it("n'offre l'actualisation et l'annulation qu'une fois le récépissé attribué", async () => {
    await monter();
    expect(screen.queryByText("Actualiser le statut")).toBeNull();
    expect(screen.queryByText("Annuler auprès de la DGI")).toBeNull();
  });

  // Deux montages dans un même test se superposeraient : `cleanup` ne passe
  // qu'entre les tests. Chaque état a donc son propre cas.
  it("propose l'annulation sur une facture transmise", async () => {
    await monter({ statut: "VALIDATED_BY_DGI", dgi_uuid: "u-1" });
    expect(screen.getByText("Annuler auprès de la DGI")).toBeTruthy();
  });

  it("ne propose plus l'annulation d'une facture déjà annulée", async () => {
    await monter({ statut: "CANCELLED_BY_DGI", dgi_uuid: "u-1" });
    expect(screen.queryByText("Annuler auprès de la DGI")).toBeNull();
  });

  it("cache le téléchargement du XML tant qu'aucun document n'existe", async () => {
    await monter();
    expect(screen.queryByText(/Télécharger le XML UBL/)).toBeNull();
  });

  it("propose le téléchargement du XML dès qu'il existe", async () => {
    await monter({ xml_ubl: "<Invoice/>" });
    expect(screen.getByText(/Télécharger le XML UBL/)).toBeTruthy();
  });

  // La règle du module : la colonne `xml_ubl` est l'ARCHIVE. Sur une facture
  // scellée par un constructeur antérieur aux trois règles DGI, elle ne porte
  // aucune d'elles — et la verser dans un blob rendait toute correction du code
  // invisible. Le fichier doit venir du serveur, jamais de cet état d'écran.
  it("demande le document au serveur au lieu de verser l'archive dans un fichier", async () => {
    await monter({ xml_ubl: "<Invoice>ARCHIVE ANCIENNE</Invoice>", statut: "VALIDATED_BY_DGI", dgi_uuid: "u-1" });
    serveur.telechargerUblFacture.mockResolvedValue({
      xml_ubl: "<Invoice><ext:UBLExtensions/></Invoice>",
      nom_fichier: "FA-2026-0042-ubl.xml",
      regenere: true,
      motifs: ["ext:UBLExtensions (récépissé + empreinte)"],
      avertissements: ["Document remis au profil DGI courant."],
    });

    fireEvent.click(screen.getByText(/Télécharger le XML UBL/));
    await waitFor(() => expect(serveur.telechargerUblFacture).toHaveBeenCalledWith({ data: { facture_id: "f-1" } }));
    await waitFor(() => expect(document.body.textContent).toContain("Document remis au profil DGI courant."));
  });
});

describe("FactureElectroniquePanel — récépissé et bac à sable", () => {
  it("affiche le récépissé, les dates et l'empreinte", async () => {
    await monter({
      statut: "VALIDATED_BY_DGI",
      dgi_uuid: "8f3a21c4-5e7b-4d19-9c02-af41b6d83e77",
      dgi_validated_at: "2026-08-17T10:00:00.000Z",
      hash_sha256: HASH,
    });
    expect(screen.getByText("8f3a21c4-5e7b-4d19-9c02-af41b6d83e77")).toBeTruthy();
    expect(screen.getByText(HASH)).toBeTruthy();
  });

  // Le pire résultat possible de ce module serait qu'un récépissé simulé passe
  // pour un vrai : le comptable croirait sa facture déclarée.
  it("signale en permanence le mode bac à sable", async () => {
    await monter({ production: false, connecteur: "MockDgiService", statut: "VALIDATED_BY_DGI", dgi_uuid: "u-1" });
    // La phrase du bandeau est morcelée par ses mises en évidence (`strong`,
    // `code`) : aucun nœud ne la porte entière. On interroge donc le texte rendu
    // dans son ensemble, ce qui est exactement ce que l'utilisateur lit.
    const rendu = document.body.textContent ?? "";
    expect(rendu).toContain("bac à sable");
    expect(rendu).toContain("MockDgiService");
    expect(rendu).toContain("aucune valeur fiscale");
    expect(rendu).toContain("DGI_API_URL");
  });

  it("ne dit rien de tel quand le connecteur est réel", async () => {
    await monter({ statut: "VALIDATED_BY_DGI", dgi_uuid: "u-1" });
    expect(screen.queryByText(/aucune valeur fiscale/)).toBeNull();
  });
});

describe("FactureElectroniquePanel — retours d'action", () => {
  it("montre les anomalies bloquantes renvoyées par le serveur", async () => {
    await monter();
    serveur.genererUblFacture.mockResolvedValue({
      succes: false,
      erreurs: [{ code: "ICE", message: "ICE du vendeur manquant." }],
      avertissements: [],
      message: "Identités fiscales incomplètes",
    });

    fireEvent.click(screen.getByText(/Générer \/ prévisualiser l'UBL/));
    await waitFor(() => expect(screen.getByText(/ICE du vendeur manquant/)).toBeTruthy());
    expect(screen.getByText("Anomalie bloquante")).toBeTruthy();
  });

  it("ouvre l'aperçu du XML après une génération réussie", async () => {
    await monter();
    serveur.genererUblFacture.mockResolvedValue({
      succes: true,
      erreurs: [],
      avertissements: [],
      message: "Document UBL 2.1 généré et scellé.",
      xml_ubl: "<Invoice><cbc:ID>FA-2026-0042</cbc:ID></Invoice>",
    });

    fireEvent.click(screen.getByText(/Générer \/ prévisualiser l'UBL/));
    await waitFor(() => expect(screen.getByText(/Document UBL 2.1 — FA-2026-0042/)).toBeTruthy());
    expect(screen.getByText(/Voici exactement ce qui sera transmis/)).toBeTruthy();
  });

  it("prévient le parent du nouvel état après une action", async () => {
    const onStatutChange = vi.fn();
    serveur.journalDgiFacture.mockResolvedValue(etat({ statut: "VALIDATED_BY_DGI", dgi_uuid: "u-1" }));
    render(<FactureElectroniquePanel factureId="f-1" numero="FA-2026-0042" onStatutChange={onStatutChange} />);
    await waitFor(() => expect(onStatutChange).toHaveBeenCalledWith("VALIDATED_BY_DGI"));
  });
});

describe("FactureElectroniquePanel — chargement", () => {
  // RÉGRESSION. Le parent passe une lambda écrite dans le JSX, dont l'identité
  // change à chaque rendu ; comme cette lambda déclenche un setState du parent,
  // faire dépendre le rechargement de son identité bouclait sans fin et figeait
  // le panneau sur « Chargement du dossier fiscal… ».
  it("ne se recharge pas en boucle quand le parent se re-rend à chaque remontée", async () => {
    serveur.journalDgiFacture.mockResolvedValue(etat({ statut: "VALIDATED_BY_DGI", dgi_uuid: "u-1" }));

    function Parent() {
      const [rendus, setRendus] = useState(0);
      return (
        <div>
          <span data-testid="rendus">{rendus}</span>
          {/* Lambda recréée à chaque rendu, ET qui provoque un rendu. */}
          <FactureElectroniquePanel
            factureId="f-1"
            numero="FA-2026-0042"
            onStatutChange={() => setRendus((n) => n + 1)}
          />
        </div>
      );
    }

    render(<Parent />);
    await waitFor(() => expect(screen.getByText("Conforme DGI")).toBeTruthy());

    // On laisse tourner : une boucle se manifesterait par des appels qui
    // continuent d'affluer et par le retour du voile de chargement.
    await new Promise((r) => setTimeout(r, 150));
    expect(serveur.journalDgiFacture).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Chargement du dossier fiscal/)).toBeNull();
    expect(screen.getByTestId("rendus").textContent).toBe("1");
  });

  // Rendre `null` ou laisser tourner le voile privait l'utilisateur de la seule
  // information utile : ce qui a échoué.
  it("affiche un repli explicite quand le dossier fiscal ne se charge pas", async () => {
    serveur.journalDgiFacture.mockRejectedValue(
      new Error("column factures.dgi_response_payload does not exist"),
    );
    render(<FactureElectroniquePanel factureId="f-1" numero="FA-2026-0042" />);

    await waitFor(() => expect(screen.getByText("Dossier fiscal indisponible")).toBeTruthy());
    expect(screen.queryByText(/Chargement du dossier fiscal/)).toBeNull();
    expect(screen.getByText(/dgi_response_payload does not exist/)).toBeTruthy();
    // La cause la plus probable est nommée, avec le fichier à appliquer.
    expect(screen.getByText(/20260817120000_efacture_dgi.sql/)).toBeTruthy();
  });

  it("permet de réessayer sans refermer la facture", async () => {
    serveur.journalDgiFacture.mockRejectedValueOnce(new Error("réseau interrompu"));
    render(<FactureElectroniquePanel factureId="f-1" numero="FA-2026-0042" />);
    await waitFor(() => expect(screen.getByText("Dossier fiscal indisponible")).toBeTruthy());

    serveur.journalDgiFacture.mockResolvedValue(etat({ statut: "DRAFT" }));
    fireEvent.click(screen.getByText("Réessayer"));

    await waitFor(() => expect(screen.getByText("Transmettre à la DGI")).toBeTruthy());
    expect(screen.queryByText("Dossier fiscal indisponible")).toBeNull();
  });
});

describe("FactureElectroniquePanel — annulation", () => {
  it("exige un motif d'au moins cinq caractères avant de confirmer", async () => {
    await monter({ statut: "VALIDATED_BY_DGI", dgi_uuid: "u-1" });
    fireEvent.click(screen.getByText("Annuler auprès de la DGI"));

    const confirmer = await screen.findByText("Confirmer l'annulation");
    expect(confirmer.closest("button")?.disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText(/erreur sur le client/i), { target: { value: "abc" } });
    expect(confirmer.closest("button")?.disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText(/erreur sur le client/i), {
      target: { value: "Marchandise retournée" },
    });
    expect(confirmer.closest("button")?.disabled).toBe(false);
  });

  it("transmet le motif saisi au serveur", async () => {
    await monter({ statut: "VALIDATED_BY_DGI", dgi_uuid: "u-1" });
    serveur.annulerFactureDgi.mockResolvedValue({
      succes: true, erreurs: [], avertissements: [], message: "Facture annulée auprès de la DGI.",
    });

    fireEvent.click(screen.getByText("Annuler auprès de la DGI"));
    fireEvent.change(await screen.findByPlaceholderText(/erreur sur le client/i), {
      target: { value: "Marchandise retournée" },
    });
    fireEvent.click(screen.getByText("Confirmer l'annulation"));

    await waitFor(() =>
      expect(serveur.annulerFactureDgi).toHaveBeenCalledWith({
        data: { facture_id: "f-1", motif: "Marchandise retournée" },
      }),
    );
  });
});

describe("FactureElectroniquePanel — journal des échanges", () => {
  it("annonce le nombre d'échanges et les liste du plus récent au plus ancien", async () => {
    await monter({
      journal: [
        { sens: "requete", operation: "submitInvoice", at: "2026-08-17T10:00:00.000Z", payload: { a: 1 } },
        { sens: "reponse", operation: "submitInvoice", at: "2026-08-17T10:00:01.000Z", payload: { b: 2 } },
      ],
    });

    fireEvent.click(screen.getByText("Journal des échanges (2)"));
    const entrees = await screen.findAllByText(/→ Requête|← Réponse/);
    expect(entrees.map((e) => e.textContent)).toEqual(["← Réponse", "→ Requête"]);
  });

  it("explique un journal vide au lieu de laisser un blanc", async () => {
    await monter();
    fireEvent.click(screen.getByText("Journal des échanges (0)"));
    expect(await screen.findByText(/n'a jamais été transmise/)).toBeTruthy();
  });
});
