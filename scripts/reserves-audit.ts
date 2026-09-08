/**
 * reserves-audit.ts — le registre des ARBITRAGES MÉTIER en attente.
 *
 * ─── Pourquoi un registre, et pourquoi ici ───────────────────────────────────
 * Certaines anomalies ne se règlent pas par du code : elles demandent qu'un
 * humain tranche un fait. « Ce paiement de 20 160 MAD est-il sorti de la caisse
 * ou de la banque ? » n'a pas de réponse dans la base — elle est dans un relevé,
 * un chèque, ou la mémoire du gérant.
 *
 * Ces questions ont une fâcheuse tendance à disparaître : elles sont signalées
 * une fois dans un compte rendu, puis le compte rendu défile. Un fichier de
 * documentation séparé ne vaut guère mieux — il se périme en silence, et rien ne
 * dit qu'il a été relu.
 *
 * D'où ce registre : il est LU par `audit-incoherences-chatgpt.ts`, qui l'affiche
 * à chaque exécution tant que la réserve n'est pas levée. Tant qu'une entrée est
 * là, personne ne peut faire tourner l'audit sans la voir.
 *
 * ─── Ce qu'une réserve n'est PAS ─────────────────────────────────────────────
 * Une réserve ne fait PAS échouer l'audit et ne change AUCUN verdict PASS/FAIL.
 * C'est délibéré : les 7 règles portent sur des impossibilités comptables, et
 * elles sont respectées. Une réserve dit autre chose — « la comptabilité est
 * cohérente, mais elle repose sur une hypothèse qu'il faut confirmer ». Mêler
 * les deux rendrait l'audit impossible à passer au vert, donc inutilisable comme
 * garde-fou automatisé.
 *
 * ─── Lever une réserve ───────────────────────────────────────────────────────
 * Quand l'arbitrage est rendu : appliquer la décision, puis SUPPRIMER l'entrée
 * de ce fichier. Ne pas la commenter, ne pas la marquer « résolue » — un
 * registre qui accumule des lignes mortes cesse d'être lu, ce qui est exactement
 * le défaut qu'il corrige.
 */

export interface ReserveAudit {
  /** Fragment du nom du dossier concerné, comparé sans casse. */
  dossier: string;
  /** La pièce ou l'opération en cause. */
  piece: string;
  /** Date d'ouverture de la réserve (ISO). */
  ouverteLe: string;
  /** Le FAIT constaté, sans interprétation. */
  constat: string[];
  /** Ce que la réponse change, en clair. */
  enjeu: string;
  /** Les branches possibles, et ce qu'il faut faire dans chacune. */
  options: string[];
  /** Comment défaire ce qui a été posé en attendant l'arbitrage. */
  rollback?: string;
}

export const RESERVES_AUDIT: ReserveAudit[] = [
  {
    dossier: "SOMADIR",
    piece: "FAC-FOURNISSEUR-2024-0055 — ATLAS PACKAGING MAROC SARL, 20 160,00 MAD TTC",
    ouverteLe: "2026-09-08",
    constat: [
      "La facture porte `mode_reglement = \"virement\"`.",
      "L'écriture du 04/05/2026 la règle pourtant en CAISSE : journal CAI, "
        + "crédit 51610000 / débit 44110001, adossée à un `encaissements` de type « especes ».",
      "AUCUNE ligne de relevé bancaire du dossier ne porte 20 160,00 — ni au débit, ni au crédit.",
      "Ce décaissement est à lui seul le creux de caisse : sans lui, la caisse ne devient "
        + "jamais créditrice.",
      "Un apport en compte courant d'associé de 20 160,00 a été posé au 04/05/2026 "
        + "(pièce APPORT-CAISSE-2026-05-04, débit 51610000 / crédit 44610000) pour rendre "
        + "la caisse possible. La règle R2 passe, mais sur cette hypothèse.",
    ],
    enjeu:
      "Si le virement est avéré, le défaut n'est pas un manque d'espèces mais un MAUVAIS "
      + "JOURNAL : le paiement aurait dû passer en banque. L'apport posé affirme alors une "
      + "injection d'espèces qui n'a jamais eu lieu, et laisse 14 748,00 MAD de billets "
      + "fictifs en caisse à la clôture — un montant qu'aucun comptage ne retrouvera.",
    options: [
      "VIREMENT AVÉRÉ → annuler l'apport (rollback ci-dessous), puis reclasser le règlement "
        + "en journal BQ sur 51410000. Attention : sans ligne de relevé correspondante, "
        + "l'écriture bancaire restera sans pièce et le contrôle de trésorerie la signalera "
        + "— c'est le bon comportement, il faudra produire le relevé.",
      "ESPÈCES CONFIRMÉES → conserver l'apport au 44610000, et joindre au dossier le reçu "
        + "de caisse signé de l'associé. La réserve peut alors être levée.",
    ],
    rollback:
      "node --import tsx scripts/alimenter-caisse.ts "
      + "--rollback=backup_apport_caisse_somadir_s_a__2026-09-08T22-16-44-177Z.json",
  },
];

/** Réserves ouvertes sur un dossier, par correspondance de nom insensible à la casse. */
export function reservesDuDossier(nomSociete: string | null | undefined): ReserveAudit[] {
  const nom = String(nomSociete ?? "").toLowerCase();
  return RESERVES_AUDIT.filter((r) => nom.includes(r.dossier.toLowerCase()));
}
