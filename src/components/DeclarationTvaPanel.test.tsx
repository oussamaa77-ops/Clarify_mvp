// ============================================================================
// DeclarationTvaPanel.test.tsx — Le cycle SIMPL-TVA vu de l'écran.
//
// On monte la VUE PURE : elle reçoit l'état serveur en props et rend des
// fonctions de rappel. Ce que ces tests vérifient n'est donc pas « React fait
// bien du React », mais les trois gestes qui écrivent en comptabilité ou en
// base — liquider, joindre la quittance, pointer le règlement — et surtout les
// GARDES qui les entourent : rien ne part sans la modale de confirmation, et le
// pointage reste hors d'atteinte tant que le 4456 n'est pas soldé.
// ============================================================================

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

// Le module du panneau importe le client Supabase et les server functions au
// chargement : ni l'un ni l'autre n'a de sens hors runtime TanStack Start.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { storage: { from: () => ({}) }, from: () => ({}) },
}));
vi.mock("@/server/liquidation-tva.functions", () => ({
  etatPeriodeTva: vi.fn(), declarerTva: vi.fn(), payerTvaDgi: vi.fn(),
  pointerTvaPeriode: vi.fn(), enregistrerQuittanceTva: vi.fn(),
}));

import { VueDeclarationTva, type EtatPeriode, type Quittance } from "./DeclarationTvaPanel";

const periodes = [{ valeur: "2026-03", label: "Mars 2026" }];

/** Même formatage que l'écran — voir le commentaire du test du récapitulatif. */
const mad = (n: number) =>
  `${n.toLocaleString("fr-MA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MAD`;

const etatBase: EtatPeriode = {
  ok: true, raison: null, periode: "2026-03",
  liquidation: {
    collectee: 12000, deductible: 4500, net: 7500, montant: 7500,
    dette: true, neant: false, periode: "2026-03",
  },
  declaree: false, resteAPayer: 0, bouclee: false, detailBouclage: null,
  pointe: false, pointeLe: null, tracable: true,
};

/** Rend la vue avec l'état demandé ; renvoie les rappels pour les inspecter. */
function monter(etat: Partial<EtatPeriode> = {}, quittance: Quittance | null = null) {
  const rappels = {
    onDeclarer: vi.fn(), onOuvrirPaiement: vi.fn(), onFichierQuittance: vi.fn(),
    onVoirQuittance: vi.fn(), onPointer: vi.fn(), onPeriode: vi.fn(),
  };
  render(
    <VueDeclarationTva
      periode="2026-03" periodes={periodes} onPeriode={rappels.onPeriode}
      etat={{ ...etatBase, ...etat }}
      chargement={false} travail={false} upload={false} pointage={false}
      quittance={quittance}
      onDeclarer={rappels.onDeclarer}
      onOuvrirPaiement={rappels.onOuvrirPaiement}
      onFichierQuittance={rappels.onFichierQuittance}
      onVoirQuittance={rappels.onVoirQuittance}
      onPointer={rappels.onPointer}
    />,
  );
  return rappels;
}

/** État « déclarée et prélevée » : le point de départ du pointage. */
const payee: Partial<EtatPeriode> = { declaree: true, resteAPayer: 0, bouclee: true };

/** Liquidation en CRÉDIT de TVA : rien à payer, 3 000 MAD reportés. */
const liquidationCredit = {
  collectee: 1000, deductible: 4000, net: -3000, montant: 3000,
  dette: false, neant: false, periode: "2026-03",
};
/** Période en crédit, déclarée : aucune échéance sur la période. */
const enCredit: Partial<EtatPeriode> = {
  declaree: true, resteAPayer: 0, bouclee: true, detailBouclage: null,
  liquidation: liquidationCredit, creditReporte: 3000,
};
const recepisse: Quittance = {
  nom: "DECL-TVA-2026-03.pdf", chemin: "d1/DECL-TVA-2026-03.pdf", traceEnBase: true,
};

// ─── Point 7 — Liquidation ───────────────────────────────────────────────────

describe("Liquidation de la TVA (modale de confirmation)", () => {
  it("n'appelle rien tant que la modale n'est pas confirmée", () => {
    const { onDeclarer } = monter();
    fireEvent.click(screen.getByRole("button", { name: /Déclarer la TVA/i }));
    expect(onDeclarer).not.toHaveBeenCalled();
  });

  it("ouvre le récapitulatif fiscal avec les trois soldes", () => {
    monter();
    fireEvent.click(screen.getByRole("button", { name: /Déclarer la TVA/i }));

    const modale = screen.getByRole("dialog");
    expect(within(modale).getByText(/Total TVA collectée \(44551\)/)).toBeDefined();
    expect(within(modale).getByText(/Total TVA déductible \(34552\)/)).toBeDefined();
    expect(within(modale).getByText(/TVA à payer \(4456\)/)).toBeDefined();
    // Les montants, au format marocain, tels qu'ils seront écrits. On les
    // reconstruit avec le MÊME formateur que l'écran : le séparateur de milliers
    // de « fr-MA » dépend de l'ICU embarquée dans Node, le figer ici ferait
    // échouer le test sur une autre machine sans qu'aucun code n'ait bougé.
    expect(within(modale).getByText(mad(12000))).toBeDefined();
    expect(within(modale).getByText(mad(4500))).toBeDefined();
    expect(within(modale).getByText(mad(7500))).toBeDefined();
    // Et l'écriture elle-même : c'est elle qu'on valide, pas un total.
    expect(within(modale).getByText(/DECL-TVA-2026-03/)).toBeDefined();
  });

  it("déclenche la liquidation sur « Valider et comptabiliser »", () => {
    const { onDeclarer } = monter();
    fireEvent.click(screen.getByRole("button", { name: /Déclarer la TVA/i }));
    fireEvent.click(screen.getByRole("button", { name: /Valider et comptabiliser/i }));
    expect(onDeclarer).toHaveBeenCalledTimes(1);
  });

  it("annonce un crédit de TVA au lieu d'une dette quand la déductible l'emporte", () => {
    monter({ liquidation: liquidationCredit });
    fireEvent.click(screen.getByRole("button", { name: /Déclarer la TVA/i }));
    const modale = screen.getByRole("dialog");
    expect(within(modale).getByText(/Crédit de TVA reportable \(4456\)/)).toBeDefined();
    expect(within(modale).queryByText(/TVA à payer/)).toBeNull();
  });

  it("interdit de comptabiliser une période néant", () => {
    monter({
      liquidation: { collectee: 0, deductible: 0, net: 0, montant: 0, dette: true, neant: true, periode: "2026-03" },
    });
    // Aucun bouton d'ouverture : le cycle n'a rien à liquider.
    expect(screen.queryByRole("button", { name: /Déclarer la TVA/i })).toBeNull();
    expect(screen.getByText(/Rien à liquider/)).toBeDefined();
  });

  it("ne propose plus la liquidation une fois la période déclarée", () => {
    monter({ declaree: true, resteAPayer: 7500 });
    expect(screen.queryByRole("button", { name: /Déclarer la TVA/i })).toBeNull();
    expect(screen.getByRole("button", { name: /Enregistrer le prélèvement/i })).toBeDefined();
  });
});

// ─── Point 8 — Quittance SIMPL-TVA ───────────────────────────────────────────

describe("Quittance SIMPL-TVA", () => {
  const pdf = () => new File(["%PDF-1.4"], "quittance-simpl.pdf", { type: "application/pdf" });

  it("ne propose aucun dépôt tant que la période n'est pas déclarée", () => {
    monter();
    expect(screen.queryByTestId("dropzone-quittance")).toBeNull();
  });

  it("téléverse le fichier choisi dans la zone de dépôt", () => {
    const { onFichierQuittance } = monter(payee);
    const fichier = pdf();
    fireEvent.change(screen.getByTestId("input-quittance"), { target: { files: [fichier] } });

    expect(onFichierQuittance).toHaveBeenCalledTimes(1);
    expect(onFichierQuittance.mock.calls[0][0].name).toBe("quittance-simpl.pdf");
  });

  it("accepte le glisser-déposer", () => {
    const { onFichierQuittance } = monter(payee);
    const fichier = pdf();
    const zone = screen.getByTestId("dropzone-quittance");

    fireEvent.dragOver(zone);
    fireEvent.drop(zone, { dataTransfer: { files: [fichier] } });

    expect(onFichierQuittance).toHaveBeenCalledWith(fichier);
  });

  it("ignore un dépôt vide plutôt que d'appeler avec undefined", () => {
    const { onFichierQuittance } = monter(payee);
    fireEvent.drop(screen.getByTestId("dropzone-quittance"), { dataTransfer: { files: [] } });
    expect(onFichierQuittance).not.toHaveBeenCalled();
  });

  it("affiche la quittance jointe et ouvre sa prévisualisation", () => {
    const { onVoirQuittance } = monter(payee, {
      nom: "DECL-TVA-2026-03.pdf", chemin: "d1/DECL-TVA-2026-03.pdf", traceEnBase: true,
    });
    expect(screen.getByText("DECL-TVA-2026-03.pdf")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /Voir la quittance/i }));
    expect(onVoirQuittance).toHaveBeenCalledTimes(1);
  });

  it("signale une quittance rangée sans ligne de relevé rapprochée", () => {
    monter(payee, { nom: "q.pdf", chemin: "d1/q.pdf", traceEnBase: false });
    expect(screen.getByText(/non rattachée à une ligne de relevé/)).toBeDefined();
  });
});

// ─── Point 8 — Pointage du règlement ─────────────────────────────────────────

describe("Pointage du règlement DGI", () => {
  const interrupteur = () => screen.getByRole("switch", { name: /Pointer le règlement/i });

  it("bascule le pointage à vrai", () => {
    const { onPointer } = monter(payee);
    expect(interrupteur().getAttribute("aria-checked")).toBe("false");
    fireEvent.click(interrupteur());
    expect(onPointer).toHaveBeenCalledWith(true);
  });

  it("permet de se dédire une fois pointé", () => {
    const { onPointer } = monter({ ...payee, pointe: true });
    expect(interrupteur().getAttribute("aria-checked")).toBe("true");
    fireEvent.click(interrupteur());
    expect(onPointer).toHaveBeenCalledWith(false);
  });

  it("passe le badge à « Liquidée & Payée » quand le règlement est pointé", () => {
    monter({ ...payee, pointe: true, pointeLe: "2026-04-28T09:12:00.000Z" });
    expect(screen.getByText("Liquidée & Payée")).toBeDefined();
    expect(screen.getByText(/ligne bancaire de débit du 4456 le 2026-04-28/)).toBeDefined();
  });

  it("refuse le pointage tant que le 4456 porte une dette, et dit pourquoi", () => {
    monter({ declaree: true, resteAPayer: 7500 });
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText(/enregistrez le prélèvement DGI/i)).toBeDefined();
  });

  it("ne propose pas de pointer un crédit de TVA : rien n'a été prélevé", () => {
    monter({ ...enCredit, resteAPayer: -3000 });
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText(/Aucun prélèvement à pointer/i)).toBeDefined();
  });

  it("désactive le pointage quand la migration de traçabilité manque", () => {
    monter({ ...payee, tracable: false });
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText(/20260809130000/)).toBeDefined();
  });
});

// ─── Période en CRÉDIT de TVA : étapes 2 (paiement) et 4 (validation) ────────
// Une période en crédit ne paie rien. Deux fautes d'affichage la guettent :
// présenter le prélèvement comme l'échéance du mois — alors que le 4456 est
// CUMULÉ et ne porte qu'un arriéré antérieur — et laisser le cycle inachevé
// faute d'un pointage qui n'aura jamais lieu.
describe("Période en crédit de TVA", () => {
  it("dit qu'aucun paiement n'est requis, sans proposer de prélèvement", () => {
    monter(enCredit);
    expect(screen.getByText(/Aucun paiement requis pour cette période \(Crédit de TVA reportable\)/))
      .toBeDefined();
    expect(screen.queryByRole("button", { name: /Enregistrer le prélèvement/i })).toBeNull();
    // L'étape est sans objet — ni cochée « fait », ni en attente d'un geste.
    expect(screen.getByText("sans objet")).toBeDefined();
  });

  it("relègue l'arriéré antérieur en texte secondaire au lieu d'en faire l'échéance", () => {
    monter({ ...enCredit, resteAPayer: 4200, bouclee: false });
    expect(screen.queryByRole("button", { name: /Enregistrer le prélèvement/i })).toBeNull();
    expect(screen.queryByText(/Reste 4/)).toBeNull();

    const ligne = screen.getByText(/Reste un solde historique/);
    expect(ligne.textContent).toContain(mad(4200));
    expect(ligne.textContent).toMatch(/périodes antérieures/);
  });

  it("valide la période dès l'OD générée et le récépissé déposé", () => {
    monter(enCredit, recepisse);
    expect(screen.getByText("Liquidée — crédit reporté")).toBeDefined();
    expect(screen.getByText("Validation de la période")).toBeDefined();
    expect(screen.getByText(/Période validée/)).toBeDefined();
    // Toujours aucun interrupteur : il n'y a rien à rapprocher.
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("ne la déclare pas validée tant que le récépissé manque", () => {
    monter(enCredit);
    expect(screen.queryByText(/Période validée/)).toBeNull();
    expect(screen.getByText("Crédit de TVA")).toBeDefined();
    expect(screen.getByText(/déposez le récépissé SIMPL-TVA/i)).toBeDefined();
  });

  it("valide aussi sur la seule trace en base du récépissé", () => {
    monter({ ...enCredit, quittancePath: "d1/DECL-TVA-2026-03.pdf" });
    expect(screen.getByText(/Période validée/)).toBeDefined();
  });
});

// ─── États de bord ───────────────────────────────────────────────────────────

describe("États de bord", () => {
  it("affiche la lecture en cours sans rien proposer", () => {
    render(
      <VueDeclarationTva
        periode="2026-03" periodes={periodes} onPeriode={vi.fn()}
        etat={null} chargement travail={false} upload={false} pointage={false}
        quittance={null}
        onDeclarer={vi.fn()} onOuvrirPaiement={vi.fn()} onFichierQuittance={vi.fn()}
        onVoirQuittance={vi.fn()} onPointer={vi.fn()}
      />,
    );
    expect(screen.getByText(/Lecture de la période/)).toBeDefined();
  });

  it("remonte la raison quand le serveur refuse la période", () => {
    monter({ ok: false, raison: "Période illisible : « 2026-13 »." });
    expect(screen.getByText(/Période illisible/)).toBeDefined();
  });
});

// ─── Bouclage : dette soldée vs crédit reporté ───────────────────────────────
// Un crédit reportable laisse le 4456 DÉBITEUR. La période est close, mais la
// carte ne doit pas pour autant annoncer « tous à 0,00 » : ce serait faux, et
// c'est exactement le genre de phrase qu'un contrôleur relit.
describe("Carte de bouclage", () => {
  it("annonce les trois comptes à zéro quand rien n'est reporté", () => {
    monter({ ...payee, creditReporte: 0 });
    expect(screen.getByText(/Période bouclée/)).toBeDefined();
    expect(screen.getByText(/sont tous à 0,00 MAD/)).toBeDefined();
  });

  it("annonce le crédit REPORTÉ au lieu de prétendre que le 4456 est à zéro", () => {
    monter({
      ...payee, creditReporte: 240,
      liquidation: { collectee: 0, deductible: 240, net: -240, montant: 240, dette: false, neant: false, periode: "2026-03" },
    });
    expect(screen.queryByText(/sont tous à 0,00 MAD/)).toBeNull();
    // Le montant est lu DANS la carte de bouclage : « 240,00 » figure aussi
    // dans la carte de position, une recherche globale ne prouverait rien.
    const carte = screen.getByText(/Période bouclée/).closest("span");
    expect(carte?.textContent).toContain(mad(240));
    expect(carte?.textContent).toMatch(/crédit de TVA reporté sur les périodes suivantes/);
  });

  it("affiche le détail du blocage quand la période n'est pas bouclée", () => {
    monter({ declaree: true, bouclee: false, detailBouclage: "Période non soldée au 2026-03-31 : 4456 = 7500.00 (TVA due non prélevée)." });
    expect(screen.getByText(/TVA due non prélevée/)).toBeDefined();
  });
});
