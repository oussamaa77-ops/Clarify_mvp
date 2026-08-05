// ============================================================================
// LettrageManuel.tsx — Écran de rapprochement & lettrage manuel (onglet Compta).
//
// Le comptable choisit un compte de tiers, coche les lignes qui se soldent
// entre elles et pose un lettrage. Tout le contrôle métier (équilibre, comptes
// mélangés, lignes déjà lettrées) vient du moteur pur src/services/lettrage.ts,
// pour que l'écran et le serveur refusent EXACTEMENT les mêmes sélections.
//
// Choix d'interface : un seul tableau, pas deux colonnes débit/crédit. Un
// règlement partiel ou un solde à trois lignes ne se lit pas en vis-à-vis, et
// le tri chronologique est ce qui permet de reconnaître « la facture de mars et
// son virement d'avril ».
// ============================================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Link2, Unlink, AlertTriangle, CheckCircle2, Wand2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { controlerEquilibre, type LigneLettrable } from "@/services/lettrage";
import {
  getPostesTiers, lettrerSelection, delettrerSelection, lettrerAutomatiquement,
} from "@/server/lettrage-compta.functions";

const fmt = (n: number) =>
  Number(n ?? 0).toLocaleString("fr-MA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface CompteTiers {
  compte: string;
  sens: "client" | "fournisseur" | null;
  nbLignes: number;
  nbNonLettrees: number;
  solde: number;
  libelle: string | null;
}

export default function LettrageManuel({ dossierId }: { dossierId: string }) {
  const [comptes, setComptes] = useState<CompteTiers[]>([]);
  const [compte, setCompte] = useState<string>("");
  const [lignes, setLignes] = useState<LigneLettrable[]>([]);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [seulementNonLettres, setSeulementNonLettres] = useState(true);
  const [chargement, setChargement] = useState(false);
  const [action, setAction] = useState(false);
  const [erreurSchema, setErreurSchema] = useState<string | null>(null);

  const charger = useCallback(async (compteVise: string, nonLettresSeuls: boolean) => {
    setChargement(true);
    try {
      const r: any = await getPostesTiers({
        data: { dossierId, compte: compteVise || undefined, seulementNonLettres: nonLettresSeuls },
      });
      if (!r?.ok) {
        // Colonne absente = migration non appliquée. Le dire explicitement : un
        // tableau vide se lirait « rien à lettrer », ce qui est faux.
        setErreurSchema(r?.reason ?? "Lecture impossible");
        setComptes([]); setLignes([]);
        return;
      }
      setErreurSchema(null);
      setComptes(r.comptes ?? []);
      setLignes(r.lignes ?? []);
      setSelection(new Set());
    } catch (e: any) {
      setErreurSchema(String(e?.message ?? e));
    } finally {
      setChargement(false);
    }
  }, [dossierId]);

  useEffect(() => { void charger(compte, seulementNonLettres); }, [charger, compte, seulementNonLettres]);

  const basculer = (id: string) => {
    setSelection((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };

  const lignesSelectionnees = useMemo(
    () => lignes.filter((l) => selection.has(l.id)),
    [lignes, selection],
  );

  // Le MÊME contrôle que le serveur : l'utilisateur voit pourquoi le bouton
  // reste désactivé au lieu de découvrir le refus après le clic.
  const controle = useMemo(
    () => controlerEquilibre(lignesSelectionnees),
    [lignesSelectionnees],
  );

  const selectionDejaLettree = lignesSelectionnees.some((l) => String(l.lettrage_code ?? "").trim());
  const totaux = useMemo(() => {
    const d = lignes.reduce((s, l) => s + Number(l.debit ?? 0), 0);
    const c = lignes.reduce((s, l) => s + Number(l.credit ?? 0), 0);
    return { debit: d, credit: c, solde: d - c };
  }, [lignes]);

  const lettrer = async () => {
    setAction(true);
    try {
      const r: any = await lettrerSelection({
        data: { dossierId, ligneIds: [...selection], origine: "manuel" },
      });
      if (!r?.ok) { toast.error(r?.reason ?? "Lettrage impossible"); return; }
      const tva = r.tvaBasculee > 0 ? ` — TVA ${fmt(r.tvaBasculee)} MAD rendue exigible` : "";
      toast.success(`Lettrage ${r.code} posé sur ${r.lignesLettrees} ligne(s)${tva}`);
      if (r.avertissement) toast.warning(r.avertissement);
      await charger(compte, seulementNonLettres);
    } catch (e: any) {
      toast.error(`Lettrage impossible : ${e?.message ?? e}`);
    } finally { setAction(false); }
  };

  const delettrer = async () => {
    setAction(true);
    try {
      const r: any = await delettrerSelection({ data: { dossierId, ligneIds: [...selection] } });
      if (!r?.ok) { toast.error(r?.reason ?? "Délettrage impossible"); return; }
      const od = r.odSupprimees > 0 ? ` — ${r.odSupprimees} écriture(s) de TVA annulée(s)` : "";
      toast.success(`Lettrage ${r.codes.join(", ")} annulé sur ${r.lignesDelettrees} ligne(s)${od}`);
      await charger(compte, seulementNonLettres);
    } catch (e: any) {
      toast.error(`Délettrage impossible : ${e?.message ?? e}`);
    } finally { setAction(false); }
  };

  const lettrerAuto = async () => {
    setAction(true);
    try {
      const r: any = await lettrerAutomatiquement({ data: { dossierId, compte: compte || undefined } });
      if (!r?.ok) { toast.error(r?.reason ?? "Lettrage automatique impossible"); return; }
      toast[r.lettres > 0 ? "success" : "info"](
        r.lettres > 0
          ? `${r.lettres} rapprochement(s) lettré(s) : ${r.codes.join(", ")}`
          : "Aucun appariement certain trouvé — à lettrer à la main",
      );
      await charger(compte, seulementNonLettres);
    } catch (e: any) {
      toast.error(`Lettrage automatique impossible : ${e?.message ?? e}`);
    } finally { setAction(false); }
  };

  if (erreurSchema) {
    return (
      <Card>
        <CardContent className="p-6 space-y-2">
          <div className="flex items-center gap-2 text-amber-600">
            <AlertTriangle className="h-5 w-5" />
            <span className="font-medium">Lettrage indisponible</span>
          </div>
          <p className="text-sm text-muted-foreground">
            La migration <code>20260805120000_lettrage_code_tva_encaissement.sql</code> n'est pas
            encore appliquée sur cette base.
          </p>
          <p className="text-xs text-muted-foreground font-mono break-all">{erreurSchema}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── Barre de sélection ────────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-4 flex flex-wrap items-end gap-3">
          <div className="min-w-[280px] flex-1">
            <label className="text-xs text-muted-foreground mb-1 block">Compte de tiers</label>
            <Select value={compte} onValueChange={setCompte}>
              <SelectTrigger><SelectValue placeholder="Choisir un compte client (342x) ou fournisseur (441x)" /></SelectTrigger>
              <SelectContent>
                {comptes.map((c) => (
                  <SelectItem key={c.compte} value={c.compte}>
                    {c.compte} — {c.libelle ?? (c.sens === "client" ? "Client" : "Fournisseur")}
                    {c.nbNonLettrees > 0 ? ` (${c.nbNonLettrees} non lettrée·s)` : " (soldé)"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Affichage</label>
            <Select
              value={seulementNonLettres ? "non" : "tous"}
              onValueChange={(v) => setSeulementNonLettres(v === "non")}
            >
              <SelectTrigger className="w-[170px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="non">Non lettrés</SelectItem>
                <SelectItem value="tous">Tous</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Button variant="outline" onClick={() => void charger(compte, seulementNonLettres)} disabled={chargement}>
            {chargement ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>

          <Button variant="outline" onClick={lettrerAuto} disabled={action || chargement}>
            <Wand2 className="h-4 w-4 mr-2" />
            Lettrage automatique
          </Button>
        </CardContent>
      </Card>

      {/* ── Sélection en cours : le verdict d'équilibre est l'information clé ── */}
      {selection.size > 0 && (
        <Card className={controle.ok ? "border-emerald-500/50" : "border-amber-500/50"}>
          <CardContent className="p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3 text-sm">
              {controle.ok
                ? <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0" />
                : <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0" />}
              <div>
                <div className="font-medium">
                  {selection.size} ligne(s) — débit {fmt(controle.totalDebit)} · crédit {fmt(controle.totalCredit)}
                </div>
                <div className={controle.ok ? "text-emerald-600 text-xs" : "text-amber-600 text-xs"}>
                  {controle.ok
                    ? "Sélection équilibrée : lettrage possible."
                    : selectionDejaLettree
                      ? "Sélection déjà lettrée — utilisez « Délettrer »."
                      : controle.raison}
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setSelection(new Set())}>Annuler</Button>
              {selectionDejaLettree ? (
                <Button variant="destructive" onClick={delettrer} disabled={action}>
                  {action ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Unlink className="h-4 w-4 mr-2" />}
                  Délettrer
                </Button>
              ) : (
                <Button onClick={lettrer} disabled={action || !controle.ok}>
                  {action ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Link2 className="h-4 w-4 mr-2" />}
                  Lettrer la sélection
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Tableau des postes ────────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-0">
          {!compte ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              Choisissez un compte de tiers pour afficher ses postes.
            </p>
          ) : chargement ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin inline mr-2" />Chargement…
            </p>
          ) : lignes.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              {seulementNonLettres
                ? "Aucun poste ouvert : ce compte est entièrement lettré."
                : "Aucune écriture sur ce compte."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="p-2 w-10"></th>
                    <th className="p-2 text-left">Date</th>
                    <th className="p-2 text-left">Journal</th>
                    <th className="p-2 text-left">Pièce</th>
                    <th className="p-2 text-left">Libellé</th>
                    <th className="p-2 text-right">Débit</th>
                    <th className="p-2 text-right">Crédit</th>
                    <th className="p-2 text-center">Lettrage</th>
                  </tr>
                </thead>
                <tbody>
                  {lignes.map((l) => {
                    const code = String(l.lettrage_code ?? "").trim();
                    return (
                      <tr
                        key={l.id}
                        className={`border-t hover:bg-muted/30 cursor-pointer ${selection.has(l.id) ? "bg-primary/5" : ""}`}
                        onClick={() => basculer(l.id)}
                      >
                        <td className="p-2" onClick={(e) => e.stopPropagation()}>
                          <Checkbox checked={selection.has(l.id)} onCheckedChange={() => basculer(l.id)} />
                        </td>
                        <td className="p-2 whitespace-nowrap">{(l.date_ecriture ?? "").slice(0, 10)}</td>
                        <td className="p-2">{(l as any).journal_code ?? ""}</td>
                        <td className="p-2 font-mono text-xs">{l.reference_piece ?? ""}</td>
                        <td className="p-2 max-w-[320px] truncate" title={l.libelle ?? ""}>{l.libelle ?? ""}</td>
                        <td className="p-2 text-right tabular-nums">{Number(l.debit ?? 0) > 0 ? fmt(l.debit as number) : ""}</td>
                        <td className="p-2 text-right tabular-nums">{Number(l.credit ?? 0) > 0 ? fmt(l.credit as number) : ""}</td>
                        <td className="p-2 text-center">
                          {code ? <Badge variant="secondary" className="font-mono">{code}</Badge> : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="border-t-2 bg-muted/30 font-medium">
                  <tr>
                    <td className="p-2" colSpan={5}>
                      {lignes.length} ligne(s) affichée(s)
                    </td>
                    <td className="p-2 text-right tabular-nums">{fmt(totaux.debit)}</td>
                    <td className="p-2 text-right tabular-nums">{fmt(totaux.credit)}</td>
                    <td className="p-2 text-center text-xs">
                      {Math.abs(totaux.solde) < 0.005
                        ? <span className="text-emerald-600">soldé</span>
                        : <span className="text-amber-600">reste {fmt(Math.abs(totaux.solde))}</span>}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
