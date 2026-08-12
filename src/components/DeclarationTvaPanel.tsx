// ============================================================================
// DeclarationTvaPanel — Déclaration SIMPL-TVA d'une période, paiement DGI,
// quittance et pointage du règlement.
//
// L'onglet TVA existant MESURE la position fiscale ; ce panneau la COMPTABILISE.
// Ce sont deux choses différentes et l'écran le dit : tant que l'OD n'est pas
// générée, la TVA reste sur 44551 / 34552 et le compte 4456 est vide.
//
// Le cycle complet d'une période, dans l'ordre où l'écran le présente :
//
//   1. POSITION    — ce que disent 44551 et 34552 sur la période ;
//   2. LIQUIDATION — l'OD qui les solde et constate la dette au 4456 ;
//   3. PAIEMENT    — le prélèvement DGI, qui éteint le 4456 ;
//   4. QUITTANCE   — le PDF SIMPL-TVA, pièce justificative du paiement ;
//   5. POINTAGE    — la marque « ce prélèvement est bien celui-là » ;
//   6. BOUCLAGE    — la preuve que les trois comptes sont revenus à 0,00.
//
// Aucune étape n'est proposée avant que la précédente soit faite. C'est
// `src/lib/cycle-tva.ts` qui porte cet ordre, l'écran qui le peint, et le
// serveur qui le fait respecter (cf. src/server/liquidation-tva.functions.ts).
//
// ─── Le cas du CRÉDIT DE TVA ─────────────────────────────────────────────────
// Une période en crédit ne paie RIEN : l'étape de paiement y est sans objet, et
// il n'existe aucune ligne bancaire à pointer. Elle se clôt sur pièces — l'OD de
// liquidation, puis le récépissé SIMPL-TVA — et c'est ce que l'étape 4 constate.
// Attention au piège : `resteAPayer` est le solde CUMULÉ du 4456. Sur une
// période en crédit, ce qu'il en reste vient des périodes antérieures ; l'écran
// le dit en texte secondaire au lieu de le présenter comme l'échéance du mois.
//
// ─── Pourquoi une modale, et pas un `confirm()` ──────────────────────────────
// L'OD de liquidation touche trois comptes et n'est défaisable qu'à la main.
// Avant de l'écrire, on montre EXACTEMENT ce qui va l'être — collectée,
// déductible, solde du 4456, date de l'écriture — dans un récapitulatif qu'on
// peut relire. Une boîte native n'affiche ni chiffre aligné ni sens de compte.
//
// ─── La quittance : bucket privé + trace en base ─────────────────────────────
// Le PDF est rangé à un chemin DÉTERMINISTE — `<dossier>/DECL-TVA-<période>.pdf`
// dans le bucket privé `quittances-tva`. On sait donc qu'une quittance existe en
// listant le dossier, sans dépendre d'une colonne. Le chemin est EN PLUS tracé
// sur la ligne de banque du prélèvement (`quittance_path`, migration
// 20260809130000) quand elle est rapprochée : c'est cette ligne que le
// contrôleur DGI regarde. Les deux ne se contredisent pas — le bucket est la
// vérité du fichier, la base est le lien vers l'écriture.
// ============================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertCircle, CheckCircle, Download, FileCheck2, Loader2, MinusCircle, Receipt, Upload, Wallet,
} from "lucide-react";
import { toast } from "sonner";
import {
  declarerTva, enregistrerQuittanceTva, etatPeriodeTva, payerTvaDgi, pointerTvaPeriode,
} from "@/server/liquidation-tva.functions";
import {
  COMPTE_TVA_COLLECTEE, COMPTE_TVA_DEDUCTIBLE, COMPTE_TVA_DUE,
  bornesPeriode, referenceDeclaration,
} from "@/lib/liquidation-tva";
import {
  actionsCycleTva, badgeCycleTva, estCreditTva, etapeCycleTva, soldeHistoriqueTva,
} from "@/lib/cycle-tva";

const BUCKET_QUITTANCES = "quittances-tva";

const fmt = (n: number) =>
  Number(n ?? 0).toLocaleString("fr-MA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Chemin déterministe de la quittance — retrouvable sans lecture de la base. */
export const cheminQuittance = (dossierId: string, periode: string, ext = "pdf") =>
  `${dossierId}/${referenceDeclaration(periode)}.${ext}`;

/** Les 12 mois et les 4 trimestres d'un exercice, prêts pour le sélecteur. */
export function periodesDeclarables(exercice: string): { valeur: string; label: string }[] {
  const a = Number(exercice) || new Date().getFullYear();
  const mois = Array.from({ length: 12 }, (_, i) => {
    const v = `${a}-${String(i + 1).padStart(2, "0")}`;
    const nom = new Date(Date.UTC(a, i, 1)).toLocaleDateString("fr-MA", { month: "long", year: "numeric" });
    return { valeur: v, label: `${nom.charAt(0).toUpperCase()}${nom.slice(1)}` };
  });
  const trimestres = Array.from({ length: 4 }, (_, i) => ({
    valeur: `${a}-T${i + 1}`, label: `${i + 1}ᵉ trimestre ${a}`,
  }));
  return [...mois, ...trimestres];
}

export interface EtatPeriode {
  ok: boolean;
  raison: string | null;
  periode: string;
  liquidation: {
    collectee: number; deductible: number; net: number; montant: number;
    dette: boolean; neant: boolean; periode: string;
  } | null;
  declaree: boolean;
  resteAPayer: number;
  bouclee: boolean;
  detailBouclage: string | null;
  /** Crédit de TVA reporté sur les périodes suivantes (positif), 0 sinon. */
  creditReporte?: number;
  /** Migration 20260809130000 — absents tant qu'elle n'est pas appliquée. */
  pointe?: boolean;
  pointeLe?: string | null;
  quittancePath?: string | null;
  quittanceNom?: string | null;
  transactionId?: string | null;
  tracable?: boolean;
}

export interface Quittance {
  nom: string;
  chemin: string;
  /** Le chemin est-il tracé sur la ligne de banque, ou seulement dans le bucket ? */
  traceEnBase?: boolean;
}

export function DeclarationTvaPanel({
  dossierId, exercice, periodeInitiale,
}: { dossierId: string; exercice: string; periodeInitiale?: string }) {
  const periodes = periodesDeclarables(exercice);
  const moisCourant = new Date().toISOString().slice(0, 7);
  const defaut = [periodeInitiale, moisCourant].find((p) => p && periodes.some((x) => x.valeur === p));
  const [periode, setPeriode] = useState(defaut ?? periodes[0].valeur);
  const [etat, setEtat] = useState<EtatPeriode | null>(null);
  const [chargement, setChargement] = useState(true);
  const [travail, setTravail] = useState(false);
  const [pointage, setPointage] = useState(false);

  // Paiement DGI
  const [openPaiement, setOpenPaiement] = useState(false);
  const [datePaiement, setDatePaiement] = useState(new Date().toISOString().slice(0, 10));
  const [montantPaiement, setMontantPaiement] = useState("");
  const [plusieursComptes, setPlusieursComptes] = useState(false);
  const [compteBanque, setCompteBanque] = useState("5141");

  // Quittance
  const [quittance, setQuittance] = useState<Quittance | null>(null);
  const [upload, setUpload] = useState(false);

  const charger = useCallback(async () => {
    setChargement(true);
    try {
      const e = await etatPeriodeTva({ data: { dossierId, periode } }) as EtatPeriode;
      setEtat(e);
      setMontantPaiement(e?.resteAPayer ? String(e.resteAPayer) : "");
    } catch (err: any) {
      toast.error("Lecture de la période impossible : " + (err?.message ?? err));
      setEtat(null);
    } finally {
      setChargement(false);
    }
  }, [dossierId, periode]);

  // Présence de la quittance : une simple liste du dossier suffit, la nomenclature
  // du fichier portant la période.
  const chargerQuittance = useCallback(async () => {
    try {
      const prefixe = referenceDeclaration(periode);
      const { data, error } = await supabase.storage.from(BUCKET_QUITTANCES).list(dossierId, { search: prefixe });
      if (error) { setQuittance(null); return; }
      const f = (data ?? []).find((x: any) => String(x.name).startsWith(prefixe));
      setQuittance(f ? { nom: f.name, chemin: `${dossierId}/${f.name}` } : null);
    } catch { setQuittance(null); }
  }, [dossierId, periode]);

  useEffect(() => { charger(); chargerQuittance(); }, [charger, chargerQuittance]);

  // Un seul compte de trésorerie : le sélecteur n'apporte rien et l'écran s'allège.
  useEffect(() => {
    (async () => {
      const { data } = await (supabase.from("comptes_bancaires") as any)
        .select("id").eq("dossier_id", dossierId);
      setPlusieursComptes(((data ?? []) as any[]).length > 1);
    })();
  }, [dossierId]);

  // ── Actions ────────────────────────────────────────────────────────────────
  const genererDeclaration = async () => {
    setTravail(true);
    try {
      const r = await declarerTva({ data: { dossierId, periode } }) as any;
      if (!r.ok) { toast.error(r.raison ?? "Liquidation refusée"); return; }
      if (!r.lignesInserees) { toast.info(r.raison ?? "Rien à déclarer."); return; }
      toast.success(
        `Liquidation ${r.periode} comptabilisée — ${r.lignesInserees} lignes, `
        + `${fmt(r.montant)} MAD de ${r.dette ? "TVA due" : "crédit reportable"}`,
      );
      await charger();
    } catch (e: any) {
      toast.error("Liquidation impossible : " + (e?.message ?? e));
    } finally { setTravail(false); }
  };

  const enregistrerPaiement = async () => {
    const montant = Number(String(montantPaiement).replace(",", "."));
    if (!(montant > 0)) { toast.error("Montant invalide."); return; }
    setTravail(true);
    try {
      const r = await payerTvaDgi({
        data: { dossierId, periode, date: datePaiement, montant, compteBanque },
      }) as any;
      if (!r.ok) { toast.error(r.raison ?? "Paiement refusé"); return; }
      if (!r.lignesInserees) { toast.info(r.raison ?? "Rien à payer."); return; }
      toast.success(
        r.resteApres > 0
          ? `Paiement de ${fmt(r.montant)} MAD enregistré — reste ${fmt(r.resteApres)} MAD au compte 4456`
          : `Paiement de ${fmt(r.montant)} MAD enregistré — le compte 4456 est soldé`,
      );
      setOpenPaiement(false);
      await charger();
    } catch (e: any) {
      toast.error("Paiement impossible : " + (e?.message ?? e));
    } finally { setTravail(false); }
  };

  const televerserQuittance = async (file: File) => {
    setUpload(true);
    try {
      const ext = (file.name.split(".").pop() || "pdf").toLowerCase();
      const chemin = cheminQuittance(dossierId, periode, ext);
      const { error } = await supabase.storage.from(BUCKET_QUITTANCES)
        .upload(chemin, file, { upsert: true, contentType: file.type || "application/pdf" });
      if (error) {
        // Cause de très loin la plus probable : le bucket n'existe pas encore.
        const manque = /bucket/i.test(error.message ?? "");
        toast.error(manque
          ? "Le bucket « quittances-tva » n'existe pas : appliquez la migration 20260809130000 dans Supabase."
          : "Envoi refusé : " + error.message);
        return;
      }
      // Le fichier est en place ; on le rattache à la ligne de banque du
      // prélèvement. Un échec ici ne perd rien — le PDF reste dans le bucket.
      let traceEnBase = false;
      try {
        const r = await enregistrerQuittanceTva({
          data: { dossierId, periode, path: chemin, nom: file.name },
        }) as any;
        traceEnBase = !!r?.traceEnBase;
        if (r?.ok && !traceEnBase && r?.raison) toast.info(r.raison);
        else if (!r?.ok && r?.raison) toast.warning(r.raison);
      } catch { /* trace facultative : le bucket fait foi */ }

      setQuittance({ nom: file.name, chemin, traceEnBase });
      toast.success("Quittance SIMPL-TVA jointe à la période.");
      await chargerQuittance();
      await charger();
    } catch (e: any) {
      toast.error("Envoi impossible : " + (e?.message ?? e));
    } finally {
      setUpload(false);
    }
  };

  const ouvrirQuittance = async () => {
    if (!quittance) return;
    // Bucket PRIVÉ : le document nomme la société et le montant de sa TVA, il ne
    // doit jamais être servi par une URL publique. Lien signé, valable 5 minutes.
    const { data, error } = await supabase.storage.from(BUCKET_QUITTANCES)
      .createSignedUrl(quittance.chemin, 300);
    if (error || !data?.signedUrl) { toast.error("Lien impossible : " + (error?.message ?? "inconnu")); return; }
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  };

  const basculerPointage = async (valeur: boolean) => {
    setPointage(true);
    try {
      const r = await pointerTvaPeriode({ data: { dossierId, periode, pointe: valeur } }) as any;
      if (!r.ok) { toast.error(r.raison ?? "Pointage refusé"); return; }
      toast.success(valeur
        ? `Règlement pointé — ${r.lignesPointees} ligne${r.lignesPointees > 1 ? "s" : ""} de ${COMPTE_TVA_DUE} cochée${r.lignesPointees > 1 ? "s" : ""}.`
        : "Pointage retiré.");
      await charger();
    } catch (e: any) {
      toast.error("Pointage impossible : " + (e?.message ?? e));
    } finally { setPointage(false); }
  };

  // ── Rendu ──────────────────────────────────────────────────────────────────
  return (
    <>
      <VueDeclarationTva
        periode={periode} periodes={periodes} onPeriode={setPeriode}
        etat={etat} chargement={chargement} travail={travail} upload={upload} pointage={pointage}
        quittance={quittance}
        onDeclarer={genererDeclaration}
        onOuvrirPaiement={() => setOpenPaiement(true)}
        onFichierQuittance={televerserQuittance}
        onVoirQuittance={ouvrirQuittance}
        onPointer={basculerPointage}
      />

      {/* ── Dialogue de paiement ── */}
      <Dialog open={openPaiement} onOpenChange={setOpenPaiement}>
        <DialogContent>
          <DialogHeader><DialogTitle>Prélèvement DGI — {etat?.periode}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Génère l'écriture <strong>D {COMPTE_TVA_DUE} / C {compteBanque}</strong>, qui éteint la dette de TVA.
            </p>
            <div>
              <Label className="text-xs" htmlFor="tva-date-paiement">Date du prélèvement</Label>
              <Input
                id="tva-date-paiement" type="date" value={datePaiement}
                onChange={(e) => setDatePaiement(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs" htmlFor="tva-montant-paiement">Montant (MAD)</Label>
              <Input
                id="tva-montant-paiement" inputMode="decimal" value={montantPaiement}
                onChange={(e) => setMontantPaiement(e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                Dû au compte {COMPTE_TVA_DUE} : {fmt(etat?.resteAPayer ?? 0)} MAD. Un montant inférieur est
                accepté (échéancier) ; un montant supérieur est refusé, il rendrait le {COMPTE_TVA_DUE} débiteur.
              </p>
            </div>
            {plusieursComptes && (
              <div>
                <Label className="text-xs">Compte de trésorerie crédité</Label>
                <Select value={compteBanque} onValueChange={setCompteBanque}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="5141">5141 — Banque</SelectItem>
                    <SelectItem value="51610000">51610000 — Caisse</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenPaiement(false)}>Annuler</Button>
            <Button onClick={enregistrerPaiement} disabled={travail}>
              {travail && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Enregistrer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Vue PURE — aucune dépendance au réseau ni à Supabase.
 *
 * La séparation n'est pas cosmétique : c'est elle qui rend l'écran observable.
 * Les cinq états qui comptent (période néant, à déclarer, à payer, à pointer,
 * liquidée) se rendent ici à partir de simples props, donc se relisent, se
 * capturent en preview et se testent sans base de données ni session.
 *
 * La modale de liquidation vit ici, avec son état d'ouverture : c'est un
 * dialogue de CONFIRMATION, il ne consulte rien et n'écrit rien — il montre le
 * récapitulatif puis appelle `onDeclarer`.
 */
export function VueDeclarationTva({
  periode, periodes, onPeriode, etat, chargement, travail, upload, pointage, quittance,
  onDeclarer, onOuvrirPaiement, onFichierQuittance, onVoirQuittance, onPointer,
}: {
  periode: string;
  periodes: { valeur: string; label: string }[];
  onPeriode: (v: string) => void;
  etat: EtatPeriode | null;
  chargement: boolean;
  travail: boolean;
  upload: boolean;
  pointage: boolean;
  quittance: Quittance | null;
  onDeclarer: () => void;
  onOuvrirPaiement: () => void;
  onFichierQuittance: (f: File) => void;
  onVoirQuittance: () => void;
  onPointer: (v: boolean) => void;
}) {
  const [openRecap, setOpenRecap] = useState(false);
  const liq = etat?.liquidation ?? null;
  const bornes = bornesPeriode(periode);
  // Le récépissé est ce qui clôt une période en crédit : la règle a besoin de
  // savoir s'il est là. Le bucket fait foi (`quittance`), la trace en base n'est
  // qu'un rattachement — voir l'en-tête du fichier.
  const etatCycle = etat ? { ...etat, quittance: !!quittance || !!etat.quittancePath } : etat;
  const etape = etapeCycleTva(etatCycle);
  const badge = badgeCycleTva(etatCycle);
  const actions = actionsCycleTva(etatCycle);
  const credit = estCreditTva(etatCycle);
  const soldeHistorique = soldeHistoriqueTva(etatCycle);
  /** Fin de cycle : règlement pointé (dette) ou période justifiée (crédit). */
  const validee = etape === "liquidee";

  const confirmer = () => { setOpenRecap(false); onDeclarer(); };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="font-semibold">Liquidation &amp; paiement SIMPL-TVA</h2>
            {etat?.ok && !chargement && (
              <Badge variant={badge.variant} className={badge.classe}>{badge.label}</Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Solde les comptes {COMPTE_TVA_COLLECTEE} / {COMPTE_TVA_DEDUCTIBLE} de la période et
            constate la dette au {COMPTE_TVA_DUE}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={periode} onValueChange={onPeriode}>
            <SelectTrigger className="w-56" aria-label="Période déclarative"><SelectValue /></SelectTrigger>
            <SelectContent className="max-h-72">
              {periodes.map((p) => (
                <SelectItem key={p.valeur} value={p.valeur}>{p.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {actions.declarer && (
            <Button onClick={() => setOpenRecap(true)} disabled={travail}>
              {travail ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <FileCheck2 className="h-4 w-4 mr-2" />}
              Déclarer la TVA
            </Button>
          )}
        </div>
      </div>

      {chargement ? (
        <Card><CardContent className="py-10 text-center text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />Lecture de la période…
        </CardContent></Card>
      ) : !etat?.ok ? (
        <Card className="border-red-300"><CardContent className="py-6 text-sm text-red-700 dark:text-red-400">
          <AlertCircle className="h-4 w-4 inline mr-2" />{etat?.raison ?? "Période illisible."}
        </CardContent></Card>
      ) : (
        <>
          {/* ── 1. Position de la période ── */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Receipt className="h-4 w-4" />Position de la période
                {bornes && (
                  <span className="text-xs font-normal text-muted-foreground">
                    du {bornes.debut} au {bornes.fin} · {bornes.regime}
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {liq?.neant ? (
                <p className="text-sm text-muted-foreground py-2">
                  Période <strong>néant</strong> : aucune TVA collectée ni déductible.
                  Rien à liquider — la DGI attend néanmoins une déclaration à zéro sur son portail.
                </p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <Chiffre label={`TVA collectée (${COMPTE_TVA_COLLECTEE})`} valeur={liq!.collectee} couleur="text-red-600" />
                  <Chiffre label={`TVA déductible (${COMPTE_TVA_DEDUCTIBLE})`} valeur={liq!.deductible} couleur="text-green-600" />
                  <Chiffre
                    label={liq!.dette ? `TVA à payer (${COMPTE_TVA_DUE})` : "Crédit de TVA reportable"}
                    valeur={liq!.montant}
                    couleur={liq!.dette ? "text-orange-600" : "text-blue-600"}
                    gras
                  />
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── 2 à 5. Le cycle, étape par étape ── */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Cycle de la période</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Etape
                numero={1}
                titre="Liquidation comptable"
                fait={!!etat.declaree}
                inactif={etape === "neant"}
                detail={etat.declaree
                  ? `OD ${referenceDeclaration(periode)} générée — les comptes de TVA de la période sont soldés.`
                  : `Tant que l'OD n'est pas générée, la TVA reste sur ${COMPTE_TVA_COLLECTEE} / ${COMPTE_TVA_DEDUCTIBLE} et le compte ${COMPTE_TVA_DUE} est vide.`}
                action={actions.declarer && (
                  <Button size="sm" onClick={() => setOpenRecap(true)} disabled={travail}>
                    {travail ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <FileCheck2 className="h-4 w-4 mr-2" />}
                    Générer la liquidation
                  </Button>
                )}
              />

              {/* Sur un crédit de TVA, l'étape est SANS OBJET, pas « en attente » :
                  aucun prélèvement n'est dû. Un arriéré antérieur peut laisser le
                  4456 créditeur — il se dit en texte secondaire, jamais comme
                  l'échéance de la période affichée. */}
              <Etape
                numero={2}
                titre="Paiement à la DGI"
                fait={!credit && etat.declaree && etat.resteAPayer <= 0.005}
                neutre={credit && etat.declaree}
                inactif={!etat.declaree}
                detail={!etat.declaree
                  ? "Disponible une fois la liquidation générée."
                  : credit
                    ? "Aucun paiement requis pour cette période (Crédit de TVA reportable)."
                    : etat.resteAPayer > 0.005
                      ? `Reste ${fmt(etat.resteAPayer)} MAD au compte ${COMPTE_TVA_DUE}.`
                      : `Le compte ${COMPTE_TVA_DUE} est soldé : la TVA déclarée a bien été prélevée.`}
                secondaire={soldeHistorique > 0.005 && (
                  <>
                    Reste un solde historique de <strong>{fmt(soldeHistorique)} MAD</strong> sur les
                    périodes antérieures — il se règle depuis la période qui l'a constaté.
                  </>
                )}
                action={actions.payer && (
                  <Button size="sm" variant="outline" onClick={onOuvrirPaiement}>
                    <Wallet className="h-4 w-4 mr-2" />Enregistrer le prélèvement
                  </Button>
                )}
              />

              <Etape
                numero={3}
                titre="Quittance SIMPL-TVA"
                fait={!!quittance}
                inactif={!actions.quittance}
                detail={quittance
                  ? `Pièce jointe : ${quittance.nom}`
                  : credit
                    ? "Le récépissé de dépôt SIMPL-TVA justifie la déclaration du crédit : sans prélèvement, c'est lui qui clôt la période."
                    : "Le récépissé de télépaiement justifie le règlement de la taxe en cas de contrôle."}
              >
                {actions.quittance && (
                  <ZoneQuittance
                    quittance={quittance} upload={upload}
                    onFichier={onFichierQuittance} onVoir={onVoirQuittance}
                  />
                )}
              </Etape>

              {/* Un crédit n'a aucun règlement à rapprocher : la période se
                  valide sur ses pièces — OD de liquidation + récépissé déposé. */}
              <Etape
                numero={4}
                titre={credit ? "Validation de la période" : "Pointage du règlement"}
                fait={validee}
                inactif={!actions.pointer && !validee}
                detail={credit
                  ? validee
                    ? `Période validée : l'OD ${referenceDeclaration(periode)} est comptabilisée et le récépissé SIMPL-TVA déposé. Aucun prélèvement n'est attendu.`
                    : actions.raisonPointageIndisponible!
                  : etat.pointe
                    ? `Règlement rapproché de la ligne bancaire de débit du ${COMPTE_TVA_DUE}`
                      + (etat.pointeLe ? ` le ${String(etat.pointeLe).slice(0, 10)}.` : ".")
                    : actions.raisonPointageIndisponible
                      ?? `Cochez le rapprochement avec la ligne bancaire de débit du ${COMPTE_TVA_DUE} : le lettrage est interdit sur les comptes de TVA.`}
                action={(actions.pointer || etat.pointe) && (
                  <div className="flex items-center gap-2">
                    {pointage && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                    <Label htmlFor="tva-pointage" className="text-xs cursor-pointer">
                      Pointer le règlement
                    </Label>
                    <Switch
                      id="tva-pointage" aria-label="Pointer le règlement"
                      checked={!!etat.pointe} disabled={pointage || !actions.pointer}
                      onCheckedChange={onPointer}
                    />
                  </div>
                )}
              />
            </CardContent>
          </Card>

          {/* ── 6. Bouclage ── */}
          <Card className={etat.bouclee ? "border-emerald-300" : undefined}>
            <CardContent className="py-4">
              {etat.bouclee ? (
                <div className="flex items-start gap-2 text-sm text-emerald-700 dark:text-emerald-400">
                  <CheckCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  {/* Un crédit reportable laisse le 4456 DÉBITEUR : la période est
                      close, mais annoncer « tous à 0,00 » serait faux. */}
                  {(etat.creditReporte ?? 0) > 0.005 ? (
                    <span>
                      <strong>Période bouclée</strong> — {COMPTE_TVA_COLLECTEE} et {COMPTE_TVA_DEDUCTIBLE} sont
                      soldés au {bornes?.fin}, et rien n'est dû. Le {COMPTE_TVA_DUE} reste débiteur de{" "}
                      <strong>{fmt(etat.creditReporte!)} MAD</strong> : c'est le crédit de TVA reporté sur les
                      périodes suivantes, qui s'imputera sur la prochaine TVA due.
                    </span>
                  ) : (
                    <span>
                      <strong>Période bouclée</strong> — {COMPTE_TVA_COLLECTEE}, {COMPTE_TVA_DEDUCTIBLE} et{" "}
                      {COMPTE_TVA_DUE} sont tous à 0,00 MAD au {bornes?.fin}.
                    </span>
                  )}
                </div>
              ) : (
                <div className="flex items-start gap-2 text-sm text-muted-foreground">
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>{etat.detailBouclage ?? "Période non soldée."}</span>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {/* ── Modale de confirmation : le récapitulatif fiscal AVANT l'écriture ── */}
      <Dialog open={openRecap} onOpenChange={setOpenRecap}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Liquidation de la TVA — {liq?.periode ?? periode}</DialogTitle>
            <DialogDescription>
              Vérifiez le récapitulatif : l'OD touche trois comptes et ne se défait qu'à la main.
            </DialogDescription>
          </DialogHeader>

          {liq && (
            <div className="space-y-3">
              <div className="rounded-lg border divide-y">
                <LigneRecap
                  label={`Total TVA collectée (${COMPTE_TVA_COLLECTEE})`}
                  valeur={liq.collectee} classe="text-red-600"
                />
                <LigneRecap
                  label={`Total TVA déductible (${COMPTE_TVA_DEDUCTIBLE})`}
                  valeur={liq.deductible} classe="text-green-600"
                />
                <LigneRecap
                  label={liq.dette ? `TVA à payer (${COMPTE_TVA_DUE})` : `Crédit de TVA reportable (${COMPTE_TVA_DUE})`}
                  valeur={liq.montant}
                  classe={liq.dette ? "text-orange-600" : "text-blue-600"}
                  gras
                />
              </div>

              {/* L'écriture, en clair : c'est elle qu'on valide, pas un total. */}
              <div className="rounded-lg bg-muted/40 p-3 font-mono text-[11px] space-y-0.5">
                <p className="font-sans text-xs font-medium mb-1.5">
                  Écriture générée au {bornes?.fin ?? "dernier jour de la période"} — {referenceDeclaration(periode)}
                </p>
                {Math.abs(liq.collectee) > 0.005 && (
                  <p>Débit&nbsp;&nbsp;{COMPTE_TVA_COLLECTEE}&nbsp;&nbsp;{fmt(liq.collectee)} MAD</p>
                )}
                {Math.abs(liq.deductible) > 0.005 && (
                  <p>Crédit&nbsp;{COMPTE_TVA_DEDUCTIBLE}&nbsp;&nbsp;{fmt(liq.deductible)} MAD</p>
                )}
                <p>
                  {liq.dette ? "Crédit" : "Débit "}&nbsp;{COMPTE_TVA_DUE}&nbsp;&nbsp;&nbsp;{fmt(liq.montant)} MAD
                  {" "}({liq.dette ? "dette envers l'État" : "crédit reportable"})
                </p>
              </div>

              {liq.neant && (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  Période néant : aucune écriture ne sera générée. La déclaration à zéro reste
                  à déposer sur le portail de la DGI (Art. 229 du CGI).
                </p>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenRecap(false)}>Annuler</Button>
            <Button onClick={confirmer} disabled={travail || !liq || liq.neant}>
              {travail && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Valider et comptabiliser
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Zone de dépôt de la quittance.
 *
 * Glisser-déposer ET clic : le récépissé SIMPL-TVA arrive d'un téléchargement,
 * donc du dossier « Téléchargements » qu'on a déjà ouvert à côté. L'input reste
 * dans le DOM (`sr-only`) plutôt que masqué en `display:none` : c'est lui qui
 * porte le label accessible, et les lecteurs d'écran doivent l'atteindre.
 */
function ZoneQuittance({
  quittance, upload, onFichier, onVoir,
}: {
  quittance: Quittance | null;
  upload: boolean;
  onFichier: (f: File) => void;
  onVoir: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [survol, setSurvol] = useState(false);

  const deposer = (f?: File | null) => { if (f) onFichier(f); };

  return (
    <div className="mt-2 space-y-2">
      <div
        data-testid="dropzone-quittance"
        onDragOver={(e) => { e.preventDefault(); setSurvol(true); }}
        onDragLeave={() => setSurvol(false)}
        onDrop={(e) => {
          e.preventDefault(); setSurvol(false);
          deposer(e.dataTransfer?.files?.[0]);
        }}
        onClick={() => inputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed
          px-4 py-5 text-center text-xs transition-colors
          ${survol ? "border-primary bg-primary/5" : "border-muted-foreground/30 hover:bg-muted/40"}`}
      >
        {upload ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : (
          <Upload className="h-5 w-5 text-muted-foreground" />
        )}
        <p className="font-medium">
          {upload ? "Envoi en cours…"
            : quittance ? "Remplacer la quittance SIMPL-TVA"
            : "Déposer la quittance SIMPL-TVA (PDF)"}
        </p>
        <p className="text-muted-foreground">Glissez le fichier ici, ou cliquez pour le choisir</p>
      </div>

      <label className="sr-only" htmlFor="quittance-fichier">Quittance SIMPL-TVA (PDF)</label>
      <input
        ref={inputRef} id="quittance-fichier" data-testid="input-quittance"
        type="file" accept="application/pdf,image/*" className="sr-only"
        disabled={upload}
        onChange={(e) => {
          deposer(e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      {quittance && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/30 px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-xs font-medium">{quittance.nom}</p>
            <p className="text-[11px] text-muted-foreground">
              Bucket privé « {BUCKET_QUITTANCES} »
              {quittance.traceEnBase === false && " · non rattachée à une ligne de relevé"}
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); onVoir(); }}>
            <Download className="h-4 w-4 mr-2" />Voir la quittance
          </Button>
        </div>
      )}
    </div>
  );
}

function LigneRecap({ label, valeur, classe, gras }: {
  label: string; valeur: number; classe: string; gras?: boolean;
}) {
  return (
    <div className="flex items-center justify-between px-3 py-2">
      <span className={`text-xs ${gras ? "font-medium" : "text-muted-foreground"}`}>{label}</span>
      <span className={`font-mono ${gras ? "text-base font-bold" : "text-sm"} ${classe}`}>
        {fmt(valeur)} MAD
      </span>
    </div>
  );
}

function Chiffre({ label, valeur, couleur, gras }: {
  label: string; valeur: number; couleur: string; gras?: boolean;
}) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`font-mono ${gras ? "text-2xl font-bold" : "text-xl font-semibold"} ${couleur}`}>
        {fmt(valeur)}
      </p>
    </div>
  );
}

/**
 * Une étape du cycle.
 *
 * Trois états, et non deux : « fait », « en attente »… et SANS OBJET. Une étape
 * qu'aucune action ne concernera jamais — le paiement d'une période en crédit de
 * TVA — ne doit ressembler ni à une case cochée ni à un reste à faire ; les deux
 * feraient chercher un geste qui n'existe pas.
 *
 * `secondaire` porte ce qui est vrai sans être l'objet de l'étape : typiquement
 * un arriéré des périodes antérieures, à dire sans le confondre avec l'échéance
 * de la période affichée.
 */
function Etape({ numero, titre, fait, neutre, inactif, detail, secondaire, action, children }: {
  numero: number; titre: string; fait: boolean; neutre?: boolean; inactif?: boolean;
  detail: string; secondaire?: React.ReactNode;
  action?: React.ReactNode; children?: React.ReactNode;
}) {
  return (
    <div className={`rounded-lg border p-3 ${inactif ? "opacity-60" : ""}`}>
      <div className="flex items-start gap-3">
        <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold
          ${fait ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                 : "bg-muted text-muted-foreground"}`}>
          {fait ? <CheckCircle className="h-4 w-4" />
            : neutre ? <MinusCircle className="h-4 w-4" />
            : numero}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">{titre}</p>
            {fait ? <Badge variant="secondary" className="text-[10px]">fait</Badge>
              : neutre ? (
                <Badge variant="outline" className="text-[10px] text-muted-foreground">sans objet</Badge>
              ) : null}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{detail}</p>
          {secondaire && (
            <p className="text-[11px] text-amber-700 dark:text-amber-400 mt-1">{secondaire}</p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </div>
  );
}
