// ROUTE DE PREVIEW TEMPORAIRE — à supprimer après contrôle visuel.
import { createFileRoute } from "@tanstack/react-router";
import { VueDeclarationTva, type EtatPeriode, type Quittance } from "@/components/DeclarationTvaPanel";

export const Route = createFileRoute("/previewtva")({ component: Preview });

const periodes = [
  { valeur: "2026-03", label: "Mars 2026" },
  { valeur: "2026-T1", label: "1ᵉ trimestre 2026" },
];

const base: EtatPeriode = {
  ok: true, raison: null, periode: "2026-03",
  liquidation: { collectee: 12000, deductible: 4500, net: 7500, montant: 7500, dette: true, neant: false, periode: "2026-03" },
  declaree: false, resteAPayer: 0, bouclee: false,
  detailBouclage: "Période non soldée au 2026-03-31 : 44551 = 12000.00, 34552 = 4500.00.",
  pointe: false, pointeLe: null, tracable: true,
};

/** Liquidation en crédit : TVA nette à payer nulle, 3 000 MAD reportables. */
const credit = {
  collectee: 1000, deductible: 4000, net: -3000, montant: 3000,
  dette: false, neant: false, periode: "2026-03",
};

const etats: [string, EtatPeriode, Quittance | null][] = [
  ["1 — À DÉCLARER (la TVA dort encore sur 44551 / 34552)", base, null],
  ["2 — À PAYER (OD générée, dette au 4456)", {
    ...base, declaree: true, resteAPayer: 7500,
    detailBouclage: "Période non soldée au 2026-03-31 : 4456 = 7500.00.",
  }, null],
  ["3 — PAYÉE, QUITTANCE JOINTE, RESTE À POINTER", {
    ...base, declaree: true, resteAPayer: 0, bouclee: true, detailBouclage: null,
  }, { nom: "DECL-TVA-2026-03.pdf", chemin: "x/DECL-TVA-2026-03.pdf", traceEnBase: true }],
  ["4 — LIQUIDÉE & PAYÉE (règlement pointé)", {
    ...base, declaree: true, resteAPayer: 0, bouclee: true, detailBouclage: null,
    pointe: true, pointeLe: "2026-04-28T09:12:00.000Z",
  }, { nom: "DECL-TVA-2026-03.pdf", chemin: "x/DECL-TVA-2026-03.pdf", traceEnBase: true }],
  ["5 — CRÉDIT DE TVA (rien à payer, récépissé attendu)", {
    ...base, declaree: true, resteAPayer: 0, bouclee: true, detailBouclage: null, creditReporte: 3000,
    liquidation: credit,
  }, null],
  ["5b — CRÉDIT DE TVA + ARRIÉRÉ ANTÉRIEUR sur le 4456 (texte secondaire)", {
    ...base, declaree: true, resteAPayer: 4200, bouclee: false, creditReporte: 0,
    detailBouclage: "Période non soldée au 2026-03-31 : 4456 = 4200.00 (TVA due non prélevée).",
    liquidation: credit,
  }, null],
  ["5c — CRÉDIT DE TVA VALIDÉ (OD + récépissé déposé, aucun pointage)", {
    ...base, declaree: true, resteAPayer: 0, bouclee: true, detailBouclage: null, creditReporte: 3000,
    liquidation: credit,
  }, { nom: "DECL-TVA-2026-03.pdf", chemin: "x/DECL-TVA-2026-03.pdf", traceEnBase: true }],
  ["6 — PÉRIODE NÉANT", {
    ...base, bouclee: true, detailBouclage: null,
    liquidation: { collectee: 0, deductible: 0, net: 0, montant: 0, dette: true, neant: true, periode: "2026-03" },
  }, null],
  ["7 — MIGRATION 20260809130000 NON APPLIQUÉE (pointage indisponible)", {
    ...base, declaree: true, resteAPayer: 0, bouclee: true, detailBouclage: null, tracable: false,
  }, null],
];

function Preview() {
  return (
    <div className="p-8 max-w-4xl mx-auto space-y-10 bg-background">
      {etats.map(([titre, etat, quittance]) => (
        <div key={titre}>
          <p className="text-xs font-mono text-muted-foreground mb-2 border-b pb-1">{titre}</p>
          <VueDeclarationTva
            periode="2026-03" periodes={periodes} onPeriode={() => {}}
            etat={etat} chargement={false} travail={false} upload={false} pointage={false}
            quittance={quittance}
            onDeclarer={() => {}} onOuvrirPaiement={() => {}}
            onFichierQuittance={() => {}} onVoirQuittance={() => {}} onPointer={() => {}}
          />
        </div>
      ))}
    </div>
  );
}
