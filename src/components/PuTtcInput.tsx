import { useState } from "react";
import { Input } from "@/components/ui/input";
import { puHtToTtc, puTtcToHt } from "@/lib/tva";

interface PuTtcInputProps {
  /** Prix unitaire HT de la ligne — la seule valeur réellement stockée. */
  prixHt: number;
  /** Taux de TVA de la ligne (null → pas de taux connu, TTC = HT). */
  tauxTva: number | null;
  /** Remonte le PU HT reconverti à partir du TTC saisi. */
  onChangeHt: (prixHt: number) => void;
  className?: string;
  placeholder?: string;
}

/**
 * Saisie du PRIX UNITAIRE TTC d'une ligne, réciproque du champ PU HT.
 *
 * Le modèle ne stocke que le HT : ce champ affiche le TTC dérivé du taux, et
 * toute saisie est reconvertie en HT. Saisir l'un met donc l'autre à jour —
 * utile quand le fournisseur libelle ses prix unitaires en TTC.
 */
export function PuTtcInput({
  prixHt,
  tauxTva,
  onChangeHt,
  className,
  placeholder = "PU TTC",
}: PuTtcInputProps) {
  // Brouillon de frappe : tant que le champ est actif, on affiche EXACTEMENT ce
  // qui est tapé. Sans ça, l'aller-retour TTC → HT → TTC (arrondi au centime)
  // réécrirait la saisie en cours sous les doigts de l'utilisateur.
  const [draft, setDraft] = useState<string | null>(null);
  const ttcDerive = puHtToTtc(prixHt || 0, tauxTva);

  return (
    <Input
      type="number"
      min="0"
      step="0.01"
      className={className}
      placeholder={placeholder}
      value={draft ?? (ttcDerive ? String(ttcDerive) : "")}
      onChange={(e) => {
        setDraft(e.target.value);
        onChangeHt(puTtcToHt(parseFloat(e.target.value) || 0, tauxTva));
      }}
      onBlur={() => setDraft(null)}
    />
  );
}
