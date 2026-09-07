// ============================================================================
// FactureElectroniquePanel.tsx — bloc « Facture Électronique » du détail facture.
//
// Ce que l'utilisateur doit pouvoir faire ici, et rien d'autre :
//   • savoir OÙ EN EST sa facture vis-à-vis de la DGI, d'un coup d'œil ;
//   • voir et télécharger ce qui PART (le XML UBL), avant et après envoi ;
//   • transmettre, actualiser, annuler — chaque action à sa place dans le cycle ;
//   • récupérer la facture hybride PDF/A-3 à envoyer au client ;
//   • relire le journal des échanges quand quelque chose s'est mal passé.
//
// Deux partis pris d'interface :
//
//   1. Les actions IMPOSSIBLES sont absentes ou désactivées, jamais offertes
//      pour être refusées ensuite. Une facture validée n'affiche pas de bouton
//      « Transmettre » : elle affiche pourquoi elle ne peut plus l'être. Un
//      bouton qui échoue systématiquement apprend à l'utilisateur à ignorer les
//      messages d'erreur.
//
//   2. Le bac à sable est signalé en permanence, pas seulement au moment de
//      l'envoi. Un récépissé simulé affiché comme un vrai est le pire résultat
//      possible de ce module : le comptable croirait sa facture déclarée.
// ============================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  annulerFactureDgi,
  apercuQrFacture,
  consulterStatutDgi,
  genererPdfA3Facture,
  genererUblFacture,
  journalDgiFacture,
  telechargerUblFacture,
  transmettreFactureDgi,
} from "@/server/efacture.functions";
import { presenterStatutDgi, peutTransmettre, type DgiStatus } from "@/lib/efacture-mapping";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertCircle,
  BadgeCheck,
  Ban,
  Clock,
  Download,
  FileCode,
  FileText,
  Loader2,
  QrCode,
  RefreshCw,
  Send,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";

// ─── Badge de statut, réutilisable dans la liste des factures ───────────────

const TONS: Record<string, string> = {
  neutre: "bg-slate-100 text-slate-700 border-slate-200",
  attente: "bg-amber-100 text-amber-800 border-amber-200",
  succes: "bg-emerald-100 text-emerald-800 border-emerald-200",
  erreur: "bg-red-100 text-red-800 border-red-200",
};

const ICONES: Record<string, typeof Clock> = {
  neutre: FileText,
  attente: Clock,
  succes: BadgeCheck,
  erreur: AlertCircle,
};

/**
 * Badge DGI dynamique. Prend le statut BRUT : il tolère aussi bien les états
 * normalisés (`VALIDATED_BY_DGI`) que les valeurs héritées de l'ancienne
 * colonne (`conforme`), pour que les factures antérieures à la migration ne
 * s'affichent pas toutes en « Brouillon ».
 */
export function BadgeStatutDgi({
  statut,
  taille = "sm",
}: {
  statut: string | null | undefined;
  taille?: "sm" | "xs";
}) {
  const presentation = presenterStatutDgi(statut);
  const Icone = ICONES[presentation.ton];
  return (
    <Badge
      variant="outline"
      title={presentation.description}
      className={`${TONS[presentation.ton]} ${taille === "xs" ? "text-[10px] px-1.5" : "text-xs"} flex items-center gap-1 font-medium`}
    >
      <Icone className="h-3 w-3 shrink-0" />
      {presentation.libelle}
    </Badge>
  );
}

// ─── Panneau ────────────────────────────────────────────────────────────────

interface EntreeJournal {
  sens: "requete" | "reponse";
  operation: string;
  at: string;
  connecteur?: string;
  payload: unknown;
}

interface EtatJournal {
  journal: EntreeJournal[];
  dgi_uuid: string | null;
  dgi_submission_at: string | null;
  dgi_validated_at: string | null;
  statut: DgiStatus;
  hash_sha256: string | null;
  xml_ubl: string | null;
  connecteur: string;
  production: boolean;
}

type Action = "ubl" | "telecharger" | "transmettre" | "statut" | "annuler" | "pdf" | "qr" | null;

/**
 * Force la marque d'ordre des octets sur un fichier TEXTE téléchargé.
 *
 * Un `.xml` sans BOM ouvert dans un éditeur Windows est lu en ANSI : « Étage »
 * s'y affiche « Ã‰tage » alors que les octets du fichier sont corrects. La
 * marque lève l'ambiguïté pour le lecteur humain et ne change rien pour un
 * parseur XML, qui la reconnaît explicitement (XML 1.0 §4.3.3). Elle n'est
 * posée QUE sur la copie téléchargée : le document transmis à la DGI et celui
 * qui entre dans le PDF/A-3 restent des octets nus.
 */
const BOM_UTF8 = "\uFEFF";

function telechargerTexte(contenu: string, nom: string, type: string) {
  const nu = String(contenu ?? "").replace(/^\uFEFF/, "");
  telecharger(new TextEncoder().encode(BOM_UTF8 + nu), nom, `${type};charset=utf-8`);
}

function telecharger(contenu: BlobPart, nom: string, type: string) {
  const url = URL.createObjectURL(new Blob([contenu], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = nom;
  a.click();
  // Sans révocation, chaque téléchargement laisse le blob en mémoire pour toute
  // la durée de vie de l'onglet — un PDF de 300 Ko à chaque clic.
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function horodatage(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString("fr-MA");
}

export function FactureElectroniquePanel({
  factureId,
  numero,
  onStatutChange,
}: {
  factureId: string;
  numero: string | null;
  /** Prévient le parent pour qu'il rafraîchisse la ligne dans la liste. */
  onStatutChange?: (statut: DgiStatus) => void;
}) {
  const appelJournal = useServerFn(journalDgiFacture);
  const appelUbl = useServerFn(genererUblFacture);
  const appelTransmettre = useServerFn(transmettreFactureDgi);
  const appelStatut = useServerFn(consulterStatutDgi);
  const appelAnnuler = useServerFn(annulerFactureDgi);
  const appelPdf = useServerFn(genererPdfA3Facture);
  const appelQr = useServerFn(apercuQrFacture);
  const appelTelecharger = useServerFn(telechargerUblFacture);

  const [etat, setEtat] = useState<EtatJournal | null>(null);
  const [chargement, setChargement] = useState(true);
  const [action, setAction] = useState<Action>(null);
  const [erreurs, setErreurs] = useState<{ code?: string; message: string; champ?: string }[]>([]);
  const [avertissements, setAvertissements] = useState<string[]>([]);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [apercuXml, setApercuXml] = useState<string | null>(null);
  const [journalOuvert, setJournalOuvert] = useState(false);
  const [annulOuvert, setAnnulOuvert] = useState(false);
  const [motif, setMotif] = useState("");
  const [erreurChargement, setErreurChargement] = useState<string | null>(null);

  /**
   * Le rappel du parent est une lambda écrite dans le JSX : son identité change
   * à CHAQUE rendu. L'inclure dans les dépendances de `recharger` déclenchait la
   * boucle qui figeait le panneau sur « Chargement du dossier fiscal… » :
   *
   *   recharger → onStatutChange → setState du parent → nouveau rendu
   *             → nouvelle lambda → nouveau `recharger` → l'effet repart
   *             → setChargement(true) → …
   *
   * On garde donc le rappel dans une ref : il reste appelable, sans jamais
   * participer à l'identité de `recharger`. C'est le seul moyen d'accepter une
   * lambda du parent sans exiger de lui qu'il la mémorise.
   */
  const rappelStatut = useRef(onStatutChange);
  useEffect(() => {
    rappelStatut.current = onStatutChange;
  });

  const recharger = useCallback(async () => {
    try {
      setErreurChargement(null);
      const donnees = (await appelJournal({ data: { facture_id: factureId } })) as EtatJournal;
      setEtat(donnees);
      rappelStatut.current?.(donnees.statut);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Dossier fiscal illisible.";
      setErreurChargement(message);
      toast.error(message);
    } finally {
      // Dans le `finally` : sur échec aussi, le voile doit tomber pour laisser
      // apparaître le message. Un panneau qui « charge » indéfiniment ne dit
      // pas qu'il a échoué — il donne à croire que le serveur réfléchit encore.
      setChargement(false);
    }
  }, [appelJournal, factureId]);

  useEffect(() => {
    setChargement(true);
    void recharger();
  }, [recharger]);

  /** Applique le retour d'une action : messages, puis rechargement de l'état. */
  const appliquer = async (
    resultat: { succes: boolean; erreurs: any[]; avertissements: string[]; message: string },
  ) => {
    setErreurs(resultat.erreurs ?? []);
    setAvertissements(resultat.avertissements ?? []);
    if (resultat.succes) toast.success(resultat.message);
    else toast.error(resultat.message);
    await recharger();
  };

  const executer = async (nom: Exclude<Action, null>, travail: () => Promise<void>) => {
    setAction(nom);
    setErreurs([]);
    try {
      await travail();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setErreurs([{ message }]);
      toast.error(message);
    } finally {
      setAction(null);
    }
  };

  if (chargement) {
    return (
      <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Chargement du dossier fiscal…
      </div>
    );
  }

  // Repli explicite. Rendre `null` — ou laisser tourner le voile — privait
  // l'utilisateur de la seule information utile : ce qui a échoué, et comment
  // réessayer sans refermer la facture.
  if (!etat) {
    return (
      <div className="space-y-3 rounded-lg border border-red-200 bg-red-50/60 p-4">
        <div className="flex items-start gap-2">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
          <div className="space-y-1">
            <p className="text-sm font-semibold text-red-800">Dossier fiscal indisponible</p>
            <p className="text-xs text-red-700">
              {erreurChargement ?? "Le dossier fiscal de cette facture n'a pas pu être lu."}
            </p>
            <p className="text-xs text-red-700/80">
              Si l'erreur mentionne une colonne inconnue, c'est que la migration{" "}
              <code className="font-mono">20260817120000_efacture_dgi.sql</code> n'a pas encore été
              appliquée dans le SQL Editor de Supabase.
            </p>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-xs"
          onClick={() => {
            setChargement(true);
            void recharger();
          }}
        >
          <RefreshCw className="mr-1 h-3.5 w-3.5" />
          Réessayer
        </Button>
      </div>
    );
  }

  const presentation = presenterStatutDgi(etat.statut);
  const transmissible = peutTransmettre(etat.statut);
  const occupe = action !== null;

  return (
    <div className="space-y-3 rounded-lg border p-4">
      {/* ─── En-tête ───────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Facture Électronique</h3>
          <BadgeStatutDgi statut={etat.statut} />
        </div>
        <Button size="sm" variant="ghost" onClick={() => setJournalOuvert(true)} className="h-7 text-xs">
          Journal des échanges ({etat.journal.length})
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">{presentation.description}</p>

      {/* Un récépissé de bac à sable affiché comme un vrai ferait croire au
          comptable que sa facture est déclarée. La mention est permanente. */}
      {!etat.production && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-900">
          <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>
            Mode <strong>bac à sable</strong> ({etat.connecteur}) — aucun accès DGI n'est configuré.
            Les récépissés produits ici sont simulés et n'ont <strong>aucune valeur fiscale</strong>.
            Renseignez <code className="font-mono">DGI_API_URL</code> et{" "}
            <code className="font-mono">DGI_API_KEY</code> pour basculer en réel.
          </span>
        </div>
      )}

      {/* ─── Récépissé ─────────────────────────────────────────────────── */}
      {(etat.dgi_uuid || etat.hash_sha256) && (
        <div className="grid gap-3 rounded-md bg-muted/40 p-3 sm:grid-cols-2">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Récépissé DGI</p>
            <p className="break-all font-mono text-xs font-medium">{etat.dgi_uuid ?? "—"}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Validée le</p>
            <p className="text-xs font-medium">{horodatage(etat.dgi_validated_at)}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Transmise le</p>
            <p className="text-xs font-medium">{horodatage(etat.dgi_submission_at)}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Empreinte SHA-256 (inaltérabilité)
            </p>
            <p className="break-all font-mono text-[10px]">{etat.hash_sha256 ?? "—"}</p>
          </div>
        </div>
      )}

      {/* ─── Anomalies ─────────────────────────────────────────────────── */}
      {erreurs.length > 0 && (
        <div className="space-y-1 rounded-md border border-red-200 bg-red-50 p-3">
          <p className="text-xs font-semibold text-red-800">
            {erreurs.length === 1 ? "Anomalie bloquante" : `${erreurs.length} anomalies bloquantes`}
          </p>
          <ul className="space-y-0.5">
            {erreurs.map((e, i) => (
              <li key={i} className="text-xs text-red-700">
                • {e.message}
                {e.code && <span className="ml-1 font-mono text-[10px] opacity-60">[{e.code}]</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {avertissements.length > 0 && (
        <ul className="space-y-0.5 rounded-md border border-amber-200 bg-amber-50 p-3">
          {avertissements.map((a, i) => (
            <li key={i} className="text-xs text-amber-900">• {a}</li>
          ))}
        </ul>
      )}

      {/* ─── Actions ───────────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={occupe}
          className="h-8 text-xs"
          onClick={() =>
            executer("ubl", async () => {
              const r: any = await appelUbl({ data: { facture_id: factureId } });
              await appliquer(r);
              if (r.succes) setApercuXml(r.xml_ubl);
            })
          }
        >
          {action === "ubl" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <FileCode className="mr-1 h-3.5 w-3.5" />}
          Générer / prévisualiser l'UBL
        </Button>

        {etat.xml_ubl && (
          <Button
            size="sm"
            variant="outline"
            disabled={occupe}
            className="h-8 text-xs"
            onClick={() =>
              // On NE verse PAS `etat.xml_ubl` dans un blob : cette colonne est
              // l'ARCHIVE, et sur une facture scellée par un constructeur
              // antérieur elle ne porte aucune des trois règles DGI. Le serveur
              // rend le document au profil courant, scellement inchangé.
              executer("telecharger", async () => {
                const r: any = await appelTelecharger({ data: { facture_id: factureId } });
                // Les avertissements sont posés AVANT la remise du fichier :
                // c'est là que l'utilisateur apprend que son document a été remis
                // au profil courant, et un incident du navigateur pendant le
                // téléchargement ne doit pas emporter cette explication.
                setAvertissements(r.avertissements ?? []);
                if (r.regenere) await recharger();
                telechargerTexte(r.xml_ubl, r.nom_fichier ?? `${numero ?? factureId}-ubl.xml`, "application/xml");
              })
            }
          >
            {action === "telecharger" ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="mr-1 h-3.5 w-3.5" />
            )}
            Télécharger le XML UBL 2.1
          </Button>
        )}

        {transmissible ? (
          <Button
            size="sm"
            disabled={occupe}
            className="h-8 text-xs"
            onClick={() =>
              executer("transmettre", async () => {
                await appliquer((await appelTransmettre({ data: { facture_id: factureId } })) as any);
              })
            }
          >
            {action === "transmettre" ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="mr-1 h-3.5 w-3.5" />
            )}
            {etat.statut === "REJECTED_BY_DGI" ? "Retransmettre à la DGI" : "Transmettre à la DGI"}
          </Button>
        ) : (
          // Pas de bouton mort : on dit pourquoi l'action n'est pas offerte.
          <span className="self-center text-xs text-muted-foreground">
            {etat.statut === "VALIDATED_BY_DGI"
              ? "Facture scellée — pour la corriger, annulez-la puis émettez un avoir."
              : etat.statut === "PENDING_DGI"
                ? "Transmission en cours — actualisez le statut pour connaître l'issue."
                : "Facture annulée auprès de la DGI."}
          </span>
        )}

        {etat.dgi_uuid && (
          <Button
            size="sm"
            variant="outline"
            disabled={occupe}
            className="h-8 text-xs"
            onClick={() =>
              executer("statut", async () => {
                await appliquer((await appelStatut({ data: { facture_id: factureId } })) as any);
              })
            }
          >
            {action === "statut" ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-1 h-3.5 w-3.5" />
            )}
            Actualiser le statut
          </Button>
        )}

        <Button
          size="sm"
          variant="outline"
          disabled={occupe}
          className="h-8 text-xs"
          onClick={() =>
            executer("pdf", async () => {
              const r: any = await appelPdf({ data: { facture_id: factureId } });
              const octets = Uint8Array.from(atob(r.pdf_base64), (c) => c.charCodeAt(0));
              telecharger(octets, r.nom_fichier, "application/pdf");
              setAvertissements(r.avertissements ?? []);
              toast.success(
                r.conformite === "complete"
                  ? "Facture hybride PDF/A-3 téléchargée (XML UBL embarqué)."
                  : "PDF téléchargé, mais la conformité PDF/A est dégradée — voir les avertissements.",
              );
            })
          }
        >
          {action === "pdf" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <FileText className="mr-1 h-3.5 w-3.5" />}
          Télécharger le PDF/A-3
        </Button>

        <Button
          size="sm"
          variant="ghost"
          disabled={occupe}
          className="h-8 text-xs"
          onClick={() =>
            executer("qr", async () => {
              const r: any = await appelQr({ data: { facture_id: factureId } });
              setQrDataUrl(r.data_url);
            })
          }
        >
          {action === "qr" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <QrCode className="mr-1 h-3.5 w-3.5" />}
          QR fiscal
        </Button>

        {etat.dgi_uuid && etat.statut !== "CANCELLED_BY_DGI" && (
          <Button
            size="sm"
            variant="ghost"
            disabled={occupe}
            className="h-8 text-xs text-red-600 hover:text-red-700"
            onClick={() => setAnnulOuvert(true)}
          >
            <Ban className="mr-1 h-3.5 w-3.5" />
            Annuler auprès de la DGI
          </Button>
        )}
      </div>

      {qrDataUrl && (
        <div className="flex items-center gap-3 rounded-md border p-3">
          <img src={qrDataUrl} alt="QR code fiscal" className="h-24 w-24" />
          <p className="text-xs text-muted-foreground">
            Ce code encode le numéro, la date, les deux ICE, les montants, le récépissé DGI et
            l'empreinte SHA-256. Il est apposé sur le PDF/A-3 et permet un contrôle sans accès à
            l'application.
          </p>
        </div>
      )}

      {/* ─── Aperçu du XML ─────────────────────────────────────────────── */}
      <Dialog open={!!apercuXml} onOpenChange={(o) => !o && setApercuXml(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Document UBL 2.1 — {numero ?? factureId}</DialogTitle>
            <DialogDescription>
              Voici exactement ce qui sera transmis à la DGI et embarqué dans le PDF/A-3.
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-[60vh] overflow-auto rounded-md bg-muted p-3 font-mono text-[11px] leading-relaxed">
            {apercuXml}
          </pre>
          <DialogFooter>
            <Button
              size="sm"
              variant="outline"
              onClick={() => telechargerTexte(apercuXml!, `${numero ?? factureId}-ubl.xml`, "application/xml")}
            >
              <Download className="mr-1 h-4 w-4" />
              Télécharger
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Journal des échanges ──────────────────────────────────────── */}
      <Dialog open={journalOuvert} onOpenChange={setJournalOuvert}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Journal des échanges DGI</DialogTitle>
            <DialogDescription>
              Chaque requête et chaque réponse, dans l'ordre. C'est la pièce à produire pour
              expliquer un rejet ou prouver une transmission.
            </DialogDescription>
          </DialogHeader>
          {etat.journal.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Aucun échange enregistré : cette facture n'a jamais été transmise.
            </p>
          ) : (
            <div className="max-h-[60vh] space-y-2 overflow-auto">
              {[...etat.journal].reverse().map((e, i) => (
                <div key={i} className="rounded-md border p-2.5">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <Badge
                      variant="outline"
                      className={`text-[10px] ${
                        e.sens === "requete" ? "bg-slate-100 text-slate-700" : "bg-blue-50 text-blue-700"
                      }`}
                    >
                      {e.sens === "requete" ? "→ Requête" : "← Réponse"}
                    </Badge>
                    <span className="font-mono text-[11px] font-medium">{e.operation}</span>
                    <span className="text-[11px] text-muted-foreground">{horodatage(e.at)}</span>
                    {e.connecteur && (
                      <span className="text-[10px] text-muted-foreground">via {e.connecteur}</span>
                    )}
                  </div>
                  <pre className="max-h-40 overflow-auto rounded bg-muted p-2 font-mono text-[10px]">
                    {JSON.stringify(e.payload, null, 2)}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ─── Annulation ────────────────────────────────────────────────── */}
      <Dialog open={annulOuvert} onOpenChange={setAnnulOuvert}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Annuler la facture auprès de la DGI</DialogTitle>
            <DialogDescription>
              L'annulation est définitive et tracée. Une facture rectificative ou un avoir devra lui
              succéder. Le motif est obligatoire : sans lui, l'annulation n'est pas opposable en
              contrôle et la DGI la refuse.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={motif}
            onChange={(e) => setMotif(e.target.value)}
            placeholder="Ex. : erreur sur le client destinataire, marchandise retournée…"
            rows={3}
          />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setAnnulOuvert(false)}>
              Renoncer
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={motif.trim().length < 5 || occupe}
              onClick={() =>
                executer("annuler", async () => {
                  await appliquer(
                    (await appelAnnuler({ data: { facture_id: factureId, motif: motif.trim() } })) as any,
                  );
                  setAnnulOuvert(false);
                  setMotif("");
                })
              }
            >
              {action === "annuler" && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Confirmer l'annulation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
