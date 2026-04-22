import { getToken, removeToken } from "./auth";
import { getDossierHeaders } from "./dossier";

// On supprime la détection automatique qui bugue et on force l'URL réelle
const remoteApiUrl = "https://fantastic-zebra-qvqqg5xprrrw2xwv-8000.app.github.dev";
export const API_BASE_URL = `${remoteApiUrl}/api`;

/**
 * L'objet 'api' pour l'assistant (Simule Axios pour éviter les erreurs)
 */
export const api = {
    async post(endpoint: string, body: any) {
        const response = await apiFetch(endpoint, {
            method: 'POST',
            body: body
        });
        // On enveloppe le résultat dans .data UNIQUEMENT pour cet objet
        return { data: response };
    }
};

interface FetchOptions extends Omit<RequestInit, 'body'> {
  requireAuth?: boolean;
  body?: any;
}

export async function apiFetch(endpoint: string, options: FetchOptions = {}) {
  const { requireAuth = true, ...customOptions } = options;
  const headers = new Headers(customOptions.headers);

  if (customOptions.body && !(customOptions.body instanceof FormData) && !(customOptions.body instanceof URLSearchParams)) {
      if (!headers.has("Content-Type")) {
          headers.set("Content-Type", "application/json");
      }
      if (typeof customOptions.body === "object") {
          customOptions.body = JSON.stringify(customOptions.body);
      }
  }

  if (requireAuth) {
    const token = getToken();
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    } else if (typeof window !== "undefined") {
        window.location.href = "/login";
    }
    // Injecter le dossier actif dans chaque requête authentifiée
    const activeDossierId = localStorage.getItem("active_dossier_id");
    if (activeDossierId) headers.set("X-Active-Dossier", activeDossierId);
    
  }

  const url = `${API_BASE_URL}${endpoint}`;

  try {
    const response = await fetch(url, { ...customOptions, headers });

    if (response.status === 401) {
      removeToken();
      if (typeof window !== "undefined" && window.location.pathname !== "/login") {
        window.location.href = "/login";
      }
      throw new Error("Unauthorized");
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => null);
      throw new Error(errorData?.detail || `Error: ${response.status}`);
    }

    if (response.status === 204) return null;
    
    const contentType = response.headers.get("content-type");
    if (contentType && contentType.includes("application/pdf")) {
      return response.blob();
    }

    // RETOUR IMPORTANT : On renvoie le JSON directement 
    // pour que data.kpis dans le Dashboard refonctionne !
    return await response.json();
    
  } catch (error) {
    console.error("API Error:", error);
    throw error;
  }
}

// Pour les factures Clients
export const payInvoice = async (invoiceId) => {
  const response = await fetch(`/api/billing/invoices/${invoiceId}/pay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  return response.json();
};

// Pour les factures Fournisseurs (Achats)
export const paySupplierBill = async (billId) => {
  const response = await fetch(`/api/billing/supplier-bills/${billId}/pay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  return response.json();
};