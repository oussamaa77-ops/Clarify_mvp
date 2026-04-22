// frontend/src/lib/dossier.ts — VERSION CORRIGÉE
// Remplace complètement le fichier existant

const KEY = "active_dossier_id";
const KEY_NAME = "active_dossier_name";
const KEY_ROLE = "active_dossier_role";

// Événement custom pour notifier tous les composants
const DOSSIER_CHANGE_EVENT = "dossier-changed";

function dispatch() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(DOSSIER_CHANGE_EVENT));
  }
}

export function getActiveDossierId(): number | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(KEY);
  return raw ? parseInt(raw, 10) : null;
}

export function getActiveDossierName(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(KEY_NAME) || "";
}

export function getActiveDossierRole(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(KEY_ROLE) || "";
}

export function setActiveDossierId(id: number, name?: string, role?: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(KEY, String(id));
  if (name !== undefined) localStorage.setItem(KEY_NAME, name);
  if (role !== undefined) localStorage.setItem(KEY_ROLE, role);
  document.cookie = `active_dossier_id=${id}; path=/; max-age=86400`;
  // ← FIX : notifier tous les composants abonnés
  dispatch();
}

export function clearActiveDossierId(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(KEY);
  localStorage.removeItem(KEY_NAME);
  localStorage.removeItem(KEY_ROLE);
  document.cookie = "active_dossier_id=; path=/; max-age=0";
  dispatch();
}

export function getDossierHeaders(): Record<string, string> {
  const id = getActiveDossierId();
  if (!id) return {};
  return { "X-Active-Dossier": String(id) };
}
