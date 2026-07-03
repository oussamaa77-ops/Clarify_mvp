/**
 * Test suite for the FacturesPage route component.
 *
 * The goal of these tests is to verify the core logic of the component
 * without requiring a real Supabase backend or the PDF worker.
 *
 * We mock:
 *   - `useServerFn` to provide deterministic responses for OCR, XML generation
 *     and payment marking.
 *   - Supabase client methods (`from`, `select`, `insert`, `update`, `delete`)
 *     to avoid network calls.
 *   - `pdfjs-dist` dynamic import – the worker is not loaded during tests.
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Route } from "@tanstack/react-router";
import FacturesPage from "./dossiers.$dossierId.factures";

// ---------------------------------------------------------------------------
// Mock the Supabase client used in the component
// ---------------------------------------------------------------------------
vi.mock("@/integrations/supabase/client", () => {
  const mockFrom = vi.fn(() => ({
    select: vi.fn().mockResolvedValue({ data: [] }),
    insert: vi.fn().mockResolvedValue({ data: [{ id: "new-facture" }], error: null }),
    update: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  }));
  const mockAuth = vi.fn(() => ({
    getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user-1" } } }),
  }));
  const mockStorage = vi.fn(() => ({
    from: vi.fn(() => ({
      upload: vi.fn().mockResolvedValue({ data: {} }),
      getPublicUrl: vi.fn().mockReturnValue({ publicUrl: "https://example.com/file.pdf" }),
    })),
  }));
  return {
    supabase: {
      from: mockFrom,
      auth: { getUser: mockAuth },
      storage: mockStorage(),
    },
  };
});

// ---------------------------------------------------------------------------
// Mock the server functions used via `useServerFn`
// ---------------------------------------------------------------------------
vi.mock("@tanstack/react-start", () => {
  const mockUseServerFn = vi.fn((fn) => {
    // Return a wrapper that mimics the server function call signature
    return vi.fn(async (payload: any) => {
      // Simple deterministic responses based on the function name
      if (fn.name === "ocrFacture") {
        return { result: {
          client_id: "client-1",
          client_nom_extrait: "Test Client",
          numero_facture: "FA-001",
          date_facture: "2024-01-01",
          date_echeance: "2024-01-31",
          montant_ht: 1000,
          montant_tva: 200,
          montant_ttc: 1200,
          type_facture: "standard",
          lignes: [{ designation: "Produit A", quantite: 1, prix_unitaire: 1000, taux_tva: 20 }],
          confidence: "high",
          method: "mock",
          client_action: "found",
          client_trouve: { nom: "Test Client" },
          sens_facture: "sortant",
          emetteur_nom: "Émetteur Test",
        } };
      }
      if (fn.name === "generateFactureXml") {
        return { conforme: true, dgi_response: { message: "OK" }, dgi_uuid: "uuid-123" };
      }
      if (fn.name === "marquerPayee") {
        return {};
      }
      if (fn.name === "ajouterEmailClient") {
        return {};
      }
      return {};
    });
  });
  return { useServerFn: mockUseServerFn };
});

// ---------------------------------------------------------------------------
// Helper to render the component with a mocked route param
// ---------------------------------------------------------------------------
const renderFacturesPage = () => {
  // Mock the route params used by the component
  vi.spyOn(Route, "useParams").mockReturnValue({ dossierId: "dossier-1" } as any);
  return render(<FacturesPage />);
};

describe("FacturesPage component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the page title", () => {
    renderFacturesPage();
    expect(screen.getByRole("heading", { name: /Factures clients/i })).toBeInTheDocument();
  });

  it("opens the create‑invoice dialog when the button is clicked", async () => {
    renderFacturesPage();
    const newBtn = screen.getByRole("button", { name: /Nouvelle facture/i });
    await userEvent.click(newBtn);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("pre‑fills the form after a successful OCR call", async () => {
    renderFacturesPage();
    // Simulate dropping a file (the actual file content is irrelevant because OCR is mocked)
    const dropZone = screen.getByText(/Glissez une facture PDF/i).parentElement!;
    const file = new File(["dummy"], "facture.pdf", { type: "application/pdf" });
    await fireEvent.drop(dropZone, { dataTransfer: { files: [file] } });

    // Wait for the mocked OCR response to populate the fields
    await waitFor(() => {
      expect(screen.getByDisplayValue("Test Client")).toBeInTheDocument();
      expect(screen.getByDisplayValue("FA-001")).toBeInTheDocument();
    });
  });

  it("calculates HT, TVA and TTC correctly from line items", async () => {
    renderFacturesPage();
    // Open dialog and add a line manually
    await userEvent.click(screen.getByRole("button", { name: /Nouvelle facture/i }));
    const designationInput = screen.getAllByPlaceholderText("Désignation")[0];
    await userEvent.type(designationInput, "Produit B");
    const qtyInput = screen.getAllByPlaceholderText("Qté")[0];
    await userEvent.clear(qtyInput);
    await userEvent.type(qtyInput, "2");
    const puInput = screen.getAllByPlaceholderText("PU HT")[0];
    await userEvent.clear(puInput);
    await userEvent.type(puInput, "500");
    // TVA selector defaults to 20 %
    // Verify the totals displayed at the bottom of the lines section
    const totalLine = await screen.findByText(/HT:/i);
    expect(totalLine).toHaveTextContent("HT: 1 000,00 MAD"); // 2 × 500
    expect(totalLine).toHaveTextContent("TVA: 200,00 MAD"); // 20 % of 1000
    expect(totalLine).toHaveTextContent("TTC: 1 200,00 MAD");
  });
});
