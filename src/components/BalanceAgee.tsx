import { useEffect, useMemo, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip as RcTooltip, ResponsiveContainer } from "recharts";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, HelpCircle, Inbox, Scale, FileText, Send, Flame } from "lucide-react";
import { toast } from "sonner";
import { cheminSegment } from "@/lib/chart-shapes";

// ─────────────────────────────────────────────────────────────────────────────
// Balance âgée : l'ÉTAT des factures d'un tiers (payées + impayées) — ce qui est
// facturé, réglé, encore dû (ventilé par ancienneté), et le délai de règlement moyen.
// Alimentée par la vue `v_balance_agee` (une ligne par tiers) — tout le calcul métier
// vit en SQL, ce composant ne fait que présenter.
// ─────────────────────────────────────────────────────────────────────────────

export interface LigneBalanceAgee {
  tiers_id: string | null;
  tiers_nom: string;
  nb_factures: number;          // toutes les factures du tiers (payées + impayées)
  nb_ouvertes: number;          // factures avec un reste dû
  total_facture: number;        // TTC facturé, tout statut
  total_paye: number;           // déjà réglé
  total_du: number;             // reste dû = somme des tranches
  non_echu: number;
  retard_1_30: number;
  retard_31_60: number;
  retard_60_plus: number;
  plus_ancienne_echeance: string | null;
  jours_retard_max: number;
  /** Délai moyen de règlement (jours facture → paiement) sur les factures soldées. */
  delai_reglement_moyen: number | null;
  nb_reglees: number;           // nombre de factures soldées ayant servi au délai
}

/** Les quatre tranches, de la plus jeune à la plus vieille. L'ordre porte le sens : ne pas permuter. */
const TRANCHES = [
  { cle: "non_echu", label: "Non échu", couleur: "var(--age-0)", aide: "Factures dont l'échéance n'est pas encore atteinte." },
  { cle: "retard_1_30", label: "1-30 jours", couleur: "var(--age-1)", aide: "Échues depuis 1 à 30 jours." },
  { cle: "retard_31_60", label: "31-60 jours", couleur: "var(--age-2)", aide: "Échues depuis 31 à 60 jours." },
  { cle: "retard_60_plus", label: "+60 jours", couleur: "var(--age-3)", aide: "Échues depuis plus de 60 jours. Risque de recouvrement." },
] as const;

type CleTranche = (typeof TRANCHES)[number]["cle"];

const TOP_GRAPHIQUE = 8;
const BAR_SIZE = 20;
const GAP = 1;    // 1 px de chaque côté → 2 px de surface entre deux segments accolés
const RAYON = 4;
const MIN_SEGMENT = 2;  // largeur plancher d'une tranche non nulle, en px

const fmtMad = (n: number) => Number(n).toLocaleString("fr-MA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Axe et labels de graphique : on compacte, la valeur exacte reste dans le tableau et l'infobulle. */
const fmtCourt = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toLocaleString("fr-MA", { maximumFractionDigits: 1 })} M`
  : n >= 1_000 ? `${(n / 1_000).toLocaleString("fr-MA", { maximumFractionDigits: 0 })} k`
  : String(Math.round(n));
const fmtDate = (iso: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "—");
/** Jour civil LOCAL. `toISOString()` renverrait le jour UTC — la veille après 23 h à Casablanca. */
const aujourdhui = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function Aide({ texte }: { texte: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={texte} className="text-muted-foreground hover:text-foreground">
          <HelpCircle className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-xs">{texte}</TooltipContent>
    </Tooltip>
  );
}

export function BalanceAgee({ dossierId, sens, onVoirFactures, onRelancer }: {
  dossierId: string;
  sens: "client" | "fournisseur";
  /** Raccourci d'action : inspecter les pièces du tiers. Fournie par la page, elle
   *  bascule sur l'annuaire, sélectionne le tiers et ouvre son onglet Factures. */
  onVoirFactures?: (ligne: LigneBalanceAgee) => void;
  /** Déclenche une relance sur le tiers. Optionnelle : à défaut, un toast informe que
   *  la fonctionnalité arrive. Câblée côté clients vers le module de relances. */
  onRelancer?: (ligne: LigneBalanceAgee) => void;
}) {
  const [lignes, setLignes] = useState<LigneBalanceAgee[]>([]);
  const [loading, setLoading] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);

  const encours = sens === "client" ? "créances" : "dettes";
  const tiers = sens === "client" ? "clients" : "fournisseurs";

  useEffect(() => {
    let annule = false;
    (async () => {
      setLoading(true);
      setErreur(null);
      const { data, error } = await (supabase as any)
        .from("v_balance_agee")
        .select("tiers_id,tiers_nom,nb_factures,nb_ouvertes,total_facture,total_paye,total_du,non_echu,retard_1_30,retard_31_60,retard_60_plus,plus_ancienne_echeance,jours_retard_max,delai_reglement_moyen,nb_reglees")
        .eq("dossier_id", dossierId)
        .eq("sens", sens);
      if (annule) return;
      if (error) setErreur(error.message);
      else setLignes((data ?? []).map((l: any) => ({
        ...l,
        ...Object.fromEntries(TRANCHES.map(t => [t.cle, Number(l[t.cle] ?? 0)])),
        total_facture: Number(l.total_facture ?? 0),
        total_paye: Number(l.total_paye ?? 0),
        total_du: Number(l.total_du ?? 0),
        nb_ouvertes: Number(l.nb_ouvertes ?? 0),
        nb_reglees: Number(l.nb_reglees ?? 0),
        delai_reglement_moyen: l.delai_reglement_moyen == null ? null : Number(l.delai_reglement_moyen),
      })));
      setLoading(false);
    })();
    return () => { annule = true; };
  }, [dossierId, sens]);

  // Graphique = composition de l'encours : seuls les tiers ayant un reste dû, du plus
  // exposé au moins exposé. Un tiers entièrement soldé n'a rien à y montrer.
  const triees = useMemo(
    () => lignes.filter(l => l.total_du > 0).sort((a, b) => b.total_du - a.total_du),
    [lignes],
  );

  // Tri du tableau orienté RISQUE et non plus montant : le plus gros arriéré ancien
  // d'abord (tranche +60 jours décroissante), départagé par le montant total dû.
  // C'est la file de recouvrement — en tête, le tiers dont la créance dort depuis le
  // plus longtemps et pèse le plus lourd.
  const trieesRisque = useMemo(() => [...lignes].sort((a, b) => {
    if (b.retard_60_plus !== a.retard_60_plus) return b.retard_60_plus - a.retard_60_plus;
    return b.total_du - a.total_du;
  }), [lignes]);

  // Bloc « À traiter en priorité » : les 3 tiers les plus critiques, par arriéré +60 j
  // puis par ancienneté maximale. Seuls les tiers ayant réellement du +60 j y entrent.
  const prioritaires = useMemo(() =>
    [...lignes]
      .filter(l => l.retard_60_plus > 0)
      .sort((a, b) => (b.retard_60_plus - a.retard_60_plus) || (b.jours_retard_max - a.jours_retard_max))
      .slice(0, 3),
    [lignes]);

  const totaux = useMemo(() => {
    const t = { total_facture: 0, total_paye: 0, total_du: 0, non_echu: 0, retard_1_30: 0, retard_31_60: 0, retard_60_plus: 0 };
    let poidsDelai = 0, nbReglees = 0;
    for (const l of lignes) {
      t.total_facture += l.total_facture;
      t.total_paye += l.total_paye;
      t.total_du += l.total_du;
      for (const { cle } of TRANCHES) t[cle] += l[cle];
      // Délai global = moyenne PONDÉRÉE par le nombre de factures soldées de chaque tiers,
      // pas une moyenne de moyennes (qui donnerait le même poids à 1 et à 50 factures).
      if (l.delai_reglement_moyen != null && l.nb_reglees > 0) {
        poidsDelai += l.delai_reglement_moyen * l.nb_reglees;
        nbReglees += l.nb_reglees;
      }
    }
    const echu = t.retard_1_30 + t.retard_31_60 + t.retard_60_plus;
    return {
      ...t, echu,
      delaiMoyen: nbReglees > 0 ? Math.round(poidsDelai / nbReglees) : null,
      tauxPaye: t.total_facture > 0 ? (t.total_paye / t.total_facture) * 100 : 0,
    };
  }, [lignes]);

  const donneesGraphique = useMemo(() => triees.slice(0, TOP_GRAPHIQUE).map(l => ({
    ...l,
    // Le dernier segment non vide porte l'extrémité arrondie et le label du total.
    dernier: [...TRANCHES].reverse().find(t => l[t.cle] > 0)?.cle ?? null,
  })), [triees]);

  const maxTotal = Math.max(1, ...donneesGraphique.map(l => l.total_du));

  // Smart insight à paliers : part du plus vieux retard dans l'encours échu.
  //   > 70 % → critique (rouge) : le poste échu est quasi entièrement figé.
  //   > 40 % → attention (orange) : bascule à surveiller de près.
  //   sinon → rien.
  const partEchu60 = totaux.echu > 0 ? (totaux.retard_60_plus / totaux.echu) * 100 : 0;
  const niveauAlerte: "critique" | "attention" | null =
    partEchu60 > 70 ? "critique" : partEchu60 > 40 ? "attention" : null;

  if (loading) {
    return (
      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-24 rounded-xl" />)}
        </div>
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  if (erreur) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <AlertTriangle className="h-6 w-6 mx-auto mb-2" style={{ color: "var(--status-critical)" }} />
          <p className="text-sm font-medium">Balance âgée indisponible</p>
          <p className="text-xs text-muted-foreground mt-1">{erreur}</p>
        </CardContent>
      </Card>
    );
  }

  if (lignes.length === 0) {
    return (
      <Card>
        <CardContent className="py-14 text-center">
          <Inbox className="h-7 w-7 mx-auto mb-3 text-muted-foreground" />
          <p className="text-sm font-medium">Aucune facture</p>
          <p className="text-xs text-muted-foreground mt-1">
            Ce dossier n'a encore aucune facture {sens === "client" ? "de vente" : "d'achat"}.
          </p>
        </CardContent>
      </Card>
    );
  }

  const regleLabel = sens === "client" ? "Encaissé" : "Réglé";

  return (
    <TooltipProvider delayDuration={150}>
      <div className="space-y-5">
        <div>
          <h2 className="text-lg font-bold flex items-center gap-2"><Scale className="h-4 w-4" />Balance âgée</h2>
          <p className="text-muted-foreground text-sm mt-0.5">
            État des factures {sens === "client" ? "de vente" : "d'achat"} — facturé, {regleLabel.toLowerCase()},
            reste dû par ancienneté et délai de règlement, au {fmtDate(aujourdhui())}.
          </p>
        </div>

        {/* ── Cartes de synthèse : facturé → réglé → reste (échu/non échu) → délai ── */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <CarteSynthese
            label="Total facturé" valeur={totaux.total_facture}
            aide={`Montant TTC de toutes les factures, réglées ou non. ${lignes.length} ${tiers} concernés.`}
          />
          <CarteSynthese
            label={regleLabel} valeur={totaux.total_paye} pastille="var(--age-0)"
            sousTitre={`${Math.round(totaux.tauxPaye)}% du facturé`}
            aide={`Montant déjà ${sens === "client" ? "encaissé" : "réglé"} sur l'ensemble des factures.`}
          />
          <CarteSynthese
            label="Reste dû" valeur={totaux.total_du} critique={totaux.retard_60_plus > 0}
            sousTitre={`Non échu ${fmtCourt(totaux.non_echu)} · Échu ${fmtCourt(totaux.echu)}`}
            aide="Somme restant à payer, ventilée plus bas par ancienneté. « Échu » = échéance dépassée."
          />
          <CarteSynthese
            label="Délai moyen de règlement" valeur={totaux.delaiMoyen} unite="j" entier
            sousTitre={sens === "client" ? "de la facture à l'encaissement" : "de la facture au paiement"}
            aide="Moyenne du nombre de jours entre l'émission de la facture et son règlement, sur les factures soldées."
          />
        </div>

        {/* ── Smart insight : alerte de concentration du retard le plus ancien ── */}
        {niveauAlerte && (
          <div
            role="alert"
            className={`flex items-start gap-2.5 rounded-lg border px-4 py-3 text-sm ${
              niveauAlerte === "critique"
                ? "border-red-500/50 bg-red-500/10 text-red-700 dark:text-red-300"
                : "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300"
            }`}
          >
            <AlertTriangle
              className={`h-4 w-4 mt-0.5 shrink-0 ${niveauAlerte === "critique" ? "text-red-500" : "text-amber-500"}`}
              aria-hidden
            />
            <p>
              <span className="font-semibold">
                {niveauAlerte === "critique" ? "Alerte critique :" : "Attention :"}
              </span>{" "}
              <span className="font-bold">{Math.round(partEchu60)}%</span>{" "}
              des {encours} échues ont plus de 60 jours d'ancienneté
              {niveauAlerte === "critique"
                ? " — l'essentiel du poste est gelé sur le plus vieux retard, à traiter en priorité."
                : " — la part la plus ancienne progresse, à surveiller de près."}
            </p>
          </div>
        )}

        {/* ── Graphique : composition de l'encours par tranche (tiers ayant un reste dû) ── */}
        {donneesGraphique.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              Reste dû — {triees.length > TOP_GRAPHIQUE ? `${TOP_GRAPHIQUE} premiers ${tiers}` : `répartition par ${sens}`}
            </CardTitle>
            <p className="text-xs text-muted-foreground">Du plus exposé au moins exposé. Plus la teinte tranche sur le fond, plus la créance est ancienne.</p>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={donneesGraphique.length * 42 + 16}>
              <BarChart layout="vertical" data={donneesGraphique} margin={{ top: 4, right: 76, bottom: 4, left: 4 }}>
                {/* Une seule échelle. Les montants exacts vivent dans l'infobulle et le tableau. */}
                <XAxis type="number" hide domain={[0, maxTotal]} />
                <YAxis
                  type="category" dataKey="tiers_nom" width={150}
                  tickLine={false} axisLine={false}
                  tick={{ fontSize: 12, fill: "var(--muted-foreground)" }}
                  tickFormatter={(v: string) => (v.length > 20 ? `${v.slice(0, 19)}…` : v)}
                />
                <RcTooltip
                  cursor={{ fill: "var(--muted)", opacity: 0.3 }}
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const l = payload[0].payload as LigneBalanceAgee;
                    return (
                      <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-md">
                        <p className="font-semibold mb-1">{l.tiers_nom}</p>
                        {TRANCHES.filter(t => l[t.cle] > 0).map(t => (
                          <p key={t.cle} className="flex items-center gap-1.5 text-muted-foreground">
                            <span className="h-2 w-2 rounded-sm shrink-0" style={{ background: t.couleur }} />
                            {t.label} : <span className="font-mono text-foreground">{fmtMad(l[t.cle])}</span>
                          </p>
                        ))}
                        <p className="mt-1 pt-1 border-t text-muted-foreground">
                          Total : <span className="font-mono text-foreground">{fmtMad(l.total_du)} MAD</span> · {l.nb_factures} facture{l.nb_factures > 1 ? "s" : ""}
                        </p>
                      </div>
                    );
                  }}
                />
                {TRANCHES.map(t => (
                  <Bar
                    key={t.cle} dataKey={t.cle} stackId="age" barSize={BAR_SIZE} isAnimationActive={false}
                    shape={(props: any) => {
                      const { x, y, width, height, payload } = props;
                      if (payload[t.cle] <= 0) return <g />;
                      // Un montant dû non nul garde toujours une marque visible : sans ce
                      // plancher, une petite tranche face à un gros tiers tombe sous le pixel
                      // et la ligne s'affiche sans barre du tout.
                      const w = Math.max(MIN_SEGMENT, width - 2 * GAP);
                      const r = payload.dernier === t.cle ? RAYON : 0;
                      return (
                        <g>
                          <path d={cheminSegment(x + GAP, y, w, height, r)} fill={t.couleur} />
                          {/* Un seul label direct par barre : le total, posé hors du dernier segment.
                              Un montant dans chaque tranche serait illisible et resterait non lu. */}
                          {payload.dernier === t.cle && (
                            <text
                              x={x + GAP + w + 10} y={y + height / 2} dy="0.36em"
                              fontSize={11} fontWeight={600} fill="var(--foreground)" pointerEvents="none"
                            >
                              {fmtCourt(payload.total_du)}
                            </text>
                          )}
                        </g>
                      );
                    }}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>

            {/* Légende : l'identité d'une tranche ne repose jamais sur la seule couleur. */}
            <div className="flex flex-wrap gap-x-5 gap-y-1.5 pt-1 pl-1">
              {TRANCHES.map(t => (
                <span key={t.cle} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ background: t.couleur }} />
                  {t.label}
                </span>
              ))}
            </div>
          </CardContent>
        </Card>
        )}

        {/* ── Bloc prioritaire : les 3 tiers les plus critiques, masqué si aucun +60 j ── */}
        {prioritaires.length > 0 && (
          <Card className="border-red-500/30">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Flame className="h-4 w-4 text-red-500" />À traiter en priorité
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Les {sens === "client" ? "clients" : "fournisseurs"} au plus gros arriéré de plus de 60 jours. Agissez ici en premier.
              </p>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-3">
                {prioritaires.map((l, i) => (
                  <div key={l.tiers_id ?? l.tiers_nom} className="rounded-lg border bg-red-500/5 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-[11px] font-semibold text-red-600 dark:text-red-400">#{i + 1}</p>
                        <p className="font-semibold text-sm truncate" title={l.tiers_nom}>{l.tiers_nom}</p>
                      </div>
                      <BadgeRetard jours={l.jours_retard_max} />
                    </div>
                    <div className="mt-2 flex items-baseline justify-between">
                      <span className="text-[11px] text-muted-foreground">+60 jours</span>
                      <span className="font-mono tabular-nums font-bold text-red-600 dark:text-red-400">{fmtMad(l.retard_60_plus)}</span>
                    </div>
                    <div className="mt-0.5 flex items-baseline justify-between">
                      <span className="text-[11px] text-muted-foreground">Retard max</span>
                      <span className="font-mono tabular-nums text-xs">{l.jours_retard_max} j</span>
                    </div>
                    {(onVoirFactures || onRelancer !== undefined) && (
                      <div className="mt-2 flex items-center gap-3 border-t pt-2">
                        {onVoirFactures && (
                          <button type="button" onClick={() => onVoirFactures(l)}
                            className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline">
                            <FileText className="h-3 w-3" />Factures
                          </button>
                        )}
                        <button type="button"
                          onClick={() => (onRelancer ? onRelancer(l) : toast.info("Fonctionnalité de relance à venir"))}
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-red-600 dark:text-red-400 hover:underline">
                          <Send className="h-3 w-3" />Relancer
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── Tableau : le jumeau exact du graphique, sans dépendance à la couleur ── */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base capitalize">{tiers}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted text-xs uppercase text-muted-foreground">
                    <th className="text-left font-semibold px-4 py-2">Tiers</th>
                    <th className="text-right font-semibold px-4 py-2">Factures</th>
                    <th className="text-right font-semibold px-4 py-2">Facturé</th>
                    <th className="text-right font-semibold px-4 py-2">{regleLabel}</th>
                    {TRANCHES.map(t => (
                      <th key={t.cle} className="text-right font-semibold px-4 py-2 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5">
                          <span className="h-2 w-2 rounded-sm shrink-0" style={{ background: t.couleur }} />
                          {t.label}
                          <Aide texte={t.aide} />
                        </span>
                      </th>
                    ))}
                    <th className="text-right font-semibold px-4 py-2">Reste dû</th>
                    <th className="text-right font-semibold px-4 py-2 whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5">
                        Retard max
                        <Aide texte="Nombre de jours écoulés depuis l'échéance la plus ancienne encore impayée." />
                      </span>
                    </th>
                    <th className="text-right font-semibold px-4 py-2 whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5">
                        Délai règl.
                        <Aide texte="Délai moyen entre l'émission de la facture et son règlement, sur les factures soldées." />
                      </span>
                    </th>
                    <th className="text-right font-semibold px-4 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {trieesRisque.map((l, i) => {
                    // Priorisation visuelle : au-delà de 90 j, toute la ligne vire au rouge léger.
                    const urgent = l.jours_retard_max > 90;
                    return (
                    <tr
                      key={l.tiers_id ?? l.tiers_nom}
                      className={`border-b last:border-0 ${urgent ? "bg-red-50 dark:bg-red-500/10" : i % 2 ? "bg-muted/20" : ""}`}
                    >
                      <td className="px-4 py-2">
                        {l.tiers_nom}
                        {l.plus_ancienne_echeance
                          ? <span className="block text-[11px] text-muted-foreground">impayé depuis le {fmtDate(l.plus_ancienne_echeance)}</span>
                          : l.total_du <= 0 && <span className="block text-[11px] text-emerald-600 dark:text-emerald-400">soldé</span>}
                      </td>
                      <td className="px-4 py-2 text-right font-mono tabular-nums text-muted-foreground">
                        {l.nb_factures}
                        {l.nb_ouvertes > 0 && <span className="block text-[10px]">{l.nb_ouvertes} due{l.nb_ouvertes > 1 ? "s" : ""}</span>}
                      </td>
                      <td className="px-4 py-2 text-right"><Montant n={l.total_facture} /></td>
                      <td className="px-4 py-2 text-right"><Montant n={l.total_paye} /></td>
                      {TRANCHES.map(t => (
                        <td key={t.cle} className="px-4 py-2 text-right"><Montant n={l[t.cle]} /></td>
                      ))}
                      <td className="px-4 py-2 text-right"><Montant n={l.total_du} /></td>
                      <td className="px-4 py-2 text-right whitespace-nowrap">
                        <span className="inline-flex items-center justify-end gap-2">
                          <BadgeRetard jours={l.jours_retard_max} />
                          <span
                            className={`font-mono tabular-nums ${l.jours_retard_max > 0 ? "" : "text-gray-400 dark:text-gray-500"}`}
                            style={l.jours_retard_max > 60 ? { color: "var(--status-critical)" } : undefined}
                          >
                            {l.jours_retard_max} j
                          </span>
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right font-mono tabular-nums whitespace-nowrap">
                        {l.delai_reglement_moyen != null
                          ? `${l.delai_reglement_moyen} j`
                          : <span className="text-gray-400 dark:text-gray-500">—</span>}
                      </td>
                      <td className="px-4 py-2 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-3">
                          {onVoirFactures && (
                            <button
                              type="button"
                              onClick={() => onVoirFactures(l)}
                              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                            >
                              <FileText className="h-3.5 w-3.5" />
                              Voir les factures
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => (onRelancer ? onRelancer(l) : toast.info("Fonctionnalité de relance à venir"))}
                            className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                            title="Relancer ce tiers"
                          >
                            <Send className="h-3.5 w-3.5" />
                            Relancer
                          </button>
                        </div>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-muted/50 font-medium">
                    <td className="px-4 py-2">Total</td>
                    <td className="px-4 py-2 text-right font-mono tabular-nums">{lignes.reduce((s, l) => s + l.nb_factures, 0)}</td>
                    <td className="px-4 py-2 text-right font-mono tabular-nums">{fmtMad(totaux.total_facture)}</td>
                    <td className="px-4 py-2 text-right font-mono tabular-nums">{fmtMad(totaux.total_paye)}</td>
                    {TRANCHES.map(t => (
                      <td key={t.cle} className="px-4 py-2 text-right font-mono tabular-nums">{fmtMad(totaux[t.cle])}</td>
                    ))}
                    <td className="px-4 py-2 text-right font-mono tabular-nums">{fmtMad(totaux.total_du)}</td>
                    <td className="px-4 py-2" />
                    <td className="px-4 py-2 text-right font-mono tabular-nums">
                      {totaux.delaiMoyen != null ? `${totaux.delaiMoyen} j` : ""}
                    </td>
                    <td className="px-4 py-2" />
                  </tr>
                </tfoot>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>
    </TooltipProvider>
  );
}

/**
 * Montant comptable dans une cellule : aligné à droite, chiffres tabulaires, milliers
 * espacés (fr-MA). Un montant > 0 est mis en gras (il porte l'information) ; un zéro
 * n'est jamais un tiret — il s'écrit « 0,00 » atténué, ce qui se lit « rien à ce poste »
 * plutôt que « donnée manquante ».
 */
function Montant({ n }: { n: number }) {
  const positif = n > 0;
  return (
    <span className={`font-mono tabular-nums ${positif ? "font-semibold" : "font-normal text-gray-400 dark:text-gray-500"}`}>
      {fmtMad(n)}
    </span>
  );
}

/** Pastille de priorité fondée sur l'ancienneté maximale : > 90 j urgent, 30-90 j à suivre. */
function BadgeRetard({ jours }: { jours: number }) {
  if (jours > 90)
    return <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold text-red-700 bg-red-100 dark:text-red-300 dark:bg-red-500/15">Urgent</span>;
  if (jours >= 30)
    return <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold text-amber-700 bg-amber-100 dark:text-amber-300 dark:bg-amber-500/15">À suivre</span>;
  return null;
}

function CarteSynthese({ label, valeur, aide, pastille, critique, unite = "MAD", entier = false, sousTitre }: {
  label: string; valeur: number | null; aide: string; pastille?: string; critique?: boolean;
  /** Unité affichée après la valeur (« MAD » par défaut, « j » pour un délai). */
  unite?: string;
  /** Formate en entier sans décimales (délais en jours) plutôt qu'en montant à 2 décimales. */
  entier?: boolean;
  /** Ligne de contexte discrète sous la valeur (part, définition…). */
  sousTitre?: string;
}) {
  const indisponible = valeur == null;
  const affiche = indisponible ? "—" : entier ? Math.round(valeur).toLocaleString("fr-MA") : fmtMad(valeur);
  return (
    <Card>
      <CardContent className="pt-4 pb-4">
        <div className="flex items-center gap-1.5 mb-1.5">
          {pastille && <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ background: pastille }} />}
          {/* Une couleur de statut ne porte jamais le sens seule : icône + libellé l'accompagnent. */}
          {critique && <AlertTriangle className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--status-critical)" }} aria-hidden />}
          <span className="text-xs font-medium text-muted-foreground">{label}</span>
          <Aide texte={aide} />
        </div>
        <p className="text-2xl font-semibold" style={critique ? { color: "var(--status-critical)" } : undefined}>
          {affiche}
          {!indisponible && <span className="text-sm font-normal text-muted-foreground ml-1.5">{unite}</span>}
        </p>
        {sousTitre && <p className="text-[11px] text-muted-foreground mt-0.5">{sousTitre}</p>}
      </CardContent>
    </Card>
  );
}
