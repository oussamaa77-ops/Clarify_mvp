// frontend/src/lib/useActiveDossier.ts
// Hook React pour lire et écouter le dossier actif en temps réel

"use client";

import { useState, useEffect, useCallback } from "react";

const KEY_ID = "active_dossier_id";
const KEY_NAME = "active_dossier_name";
const KEY_ROLE = "active_dossier_role";

// Événement custom pour notifier les composants du changement de dossier
const DOSSIER_CHANGE_EVENT = "dossier-changed";

export function dispatchDossierChange() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(DOSSIER_CHANGE_EVENT));
  }
}

export function useActiveDossier() {
  const [dossierId, setDossierId] = useState<number | null>(null);
  const [dossierName, setDossierName] = useState<string>("");
  const [dossierRole, setDossierRole] = useState<string>("");

  const refresh = useCallback(() => {
    if (typeof window === "undefined") return;
    const id = localStorage.getItem(KEY_ID);
    setDossierId(id ? parseInt(id, 10) : null);
    setDossierName(localStorage.getItem(KEY_NAME) || "");
    setDossierRole(localStorage.getItem(KEY_ROLE) || "");
  }, []);

  useEffect(() => {
    // Lecture initiale
    refresh();

    // Écouter les changements de dossier
    window.addEventListener(DOSSIER_CHANGE_EVENT, refresh);
    // Écouter aussi les changements de storage (autre onglet)
    window.addEventListener("storage", refresh);

    return () => {
      window.removeEventListener(DOSSIER_CHANGE_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [refresh]);

  return { dossierId, dossierName, dossierRole };
}
