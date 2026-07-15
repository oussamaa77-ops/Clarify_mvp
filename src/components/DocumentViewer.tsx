// ============================================================================
// DocumentViewer — panneau d'aperçu d'un document, RENDU À L'ÉCRAN.
//
// Objectif : voir le document directement (jamais « après téléchargement »).
//   • On récupère TOUJOURS les octets (fetch d'URL publique OU storage.download
//     d'un bucket privé) — on n'envoie jamais l'URL de stockage dans un <iframe>
//     (que le navigateur télécharge quand le Content-Disposition = attachment).
//   • PDF → rendu page par page en <canvas>/image via pdf.js (comme l'aperçu de
//     scan) : affichage inline garanti, quel que soit le lecteur PDF du navigateur.
//   • Image → <img>.  •  XML → texte formaté.  •  autre → info + téléchargement.
//   • Le téléchargement reste un CHOIX (bouton), sur le fichier ORIGINAL.
// ============================================================================
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Download, Loader2, FileWarning, X, ExternalLink } from "lucide-react";
import { mimeFromName, isPdf, isImage } from "@/lib/mime";

export interface DocumentViewerSource {
  title?: string;
  fileName?: string | null;
  mimeType?: string | null;
  /** URL directe (bucket public). */
  url?: string | null;
  /** Bucket privé + chemin — téléchargé via l'API storage. */
  bucket?: string | null;
  path?: string | null;
}

// Extrait { bucket, path } d'une URL de stockage Supabase (public/sign/authenticated),
// afin de récupérer le binaire via l'API storage (auth-aware, insensible au
// Content-Disposition / CORS), au lieu d'un fetch de l'URL brute.
function parseStorageUrl(url: string): { bucket: string; path: string } | null {
  const m = url.match(/\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/(.+?)(?:\?|$)/);
  if (!m) return null;
  try {
    return { bucket: decodeURIComponent(m[1]), path: decodeURIComponent(m[2]) };
  } catch {
    return { bucket: m[1], path: m[2] };
  }
}

// Chargement paresseux de pdf.js (worker configuré une seule fois).
let _pdfjs: any = null;
let _pdfjsPromise: Promise<any> | null = null;
async function getPdfjs(): Promise<any> {
  if (_pdfjs) return _pdfjs;
  if (!_pdfjsPromise) {
    _pdfjsPromise = (async () => {
      const lib = await import("pdfjs-dist");
      lib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
      _pdfjs = lib;
      return lib;
    })();
  }
  return _pdfjsPromise;
}

type Rendered =
  | { kind: "pdf"; pages: string[] }
  | { kind: "image"; url: string }
  | { kind: "text"; content: string }
  | { kind: "raw" };   // type inconnu → téléchargement uniquement

export function DocumentViewer({
  open,
  onOpenChange,
  source,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: DocumentViewerSource | null;
}) {
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [rendered, setRendered] = useState<Rendered | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Object URL du fichier ORIGINAL (pour le bouton Télécharger + affichage image).
  const rawUrlRef = useRef<string | null>(null);
  const [rawUrl, setRawUrl] = useState<string | null>(null);

  const title = source?.title || source?.fileName || "Document";
  const mime = source?.mimeType || mimeFromName(source?.fileName) || null;

  useEffect(() => {
    let cancelled = false;
    const revoke = () => {
      if (rawUrlRef.current) { URL.revokeObjectURL(rawUrlRef.current); rawUrlRef.current = null; }
    };

    if (!open || !source) { revoke(); setRawUrl(null); setRendered(null); setError(null); setProgress(null); return; }

    (async () => {
      setLoading(true); setError(null); setRendered(null); setProgress(null);
      try {
        // 1) Récupérer les octets bruts, quelle que soit la source.
        //    On privilégie l'API storage (auth-aware) — même pour une `url`, on
        //    tente d'en extraire bucket+path pour éviter tout téléchargement forcé.
        let blob: Blob | null = null;
        let store = (source.bucket && source.path) ? { bucket: source.bucket, path: source.path } : null;
        if (!store && source.url) store = parseStorageUrl(source.url);

        if (store) {
          const { data, error: dlErr } = await supabase.storage.from(store.bucket).download(store.path);
          if (dlErr || !data) throw dlErr ?? new Error("Fichier introuvable dans le stockage.");
          blob = data;
        } else if (source.url) {
          const res = await fetch(source.url);
          if (!res.ok) throw new Error(`Téléchargement impossible (HTTP ${res.status}).`);
          blob = await res.blob();
        } else {
          throw new Error("Aucun fichier associé à ce document.");
        }
        if (cancelled || !blob) return;

        const effectiveMime = mime || blob.type || "application/octet-stream";
        // Object URL typé du fichier original (téléchargement + image).
        const typed = blob.type === effectiveMime ? blob : new Blob([blob], { type: effectiveMime });
        revoke();
        const raw = URL.createObjectURL(typed);
        rawUrlRef.current = raw;
        if (!cancelled) setRawUrl(raw);

        // 2) Produire un rendu AFFICHABLE.
        if (isPdf(effectiveMime)) {
          const buf = await typed.arrayBuffer();
          const pdfjs = await getPdfjs();
          const pdf = await pdfjs.getDocument({ data: buf }).promise;
          const total = Math.min(pdf.numPages, 40); // garde-fou anti-doc géant
          const pages: string[] = [];
          for (let i = 1; i <= total; i++) {
            if (cancelled) return;
            setProgress(`Rendu page ${i}/${total}…`);
            const page = await pdf.getPage(i);
            const viewport = page.getViewport({ scale: 2.0 });
            const canvas = document.createElement("canvas");
            canvas.width = viewport.width; canvas.height = viewport.height;
            await page.render({ canvasContext: canvas.getContext("2d")!, viewport }).promise;
            pages.push(canvas.toDataURL("image/jpeg", 0.9));
          }
          if (!cancelled) setRendered({ kind: "pdf", pages });
        } else if (isImage(effectiveMime)) {
          if (!cancelled) setRendered({ kind: "image", url: raw });
        } else if (effectiveMime.includes("xml") || (source.fileName || "").toLowerCase().endsWith(".xml")) {
          const content = await typed.text();
          if (!cancelled) setRendered({ kind: "text", content });
        } else {
          if (!cancelled) setRendered({ kind: "raw" });
        }
      } catch (e: any) {
        if (!cancelled) { setError(e?.message ?? "Impossible d'afficher le document."); setRendered(null); }
      } finally {
        if (!cancelled) { setLoading(false); setProgress(null); }
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, source?.url, source?.bucket, source?.path]);

  // Libère l'object URL au démontage.
  useEffect(() => () => { if (rawUrlRef.current) URL.revokeObjectURL(rawUrlRef.current); }, []);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:w-[70vw] sm:max-w-4xl flex flex-col gap-0 p-0">
        {/* En-tête : titre + actions (téléchargement OPTIONNEL). */}
        <div className="flex items-center justify-between gap-3 border-b bg-background px-5 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">{title}</h2>
            {source?.fileName && (
              <p className="text-xs text-muted-foreground truncate">{source.fileName}</p>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {rawUrl && (
              <>
                <Button asChild size="sm" variant="ghost" title="Ouvrir dans un nouvel onglet">
                  <a href={rawUrl} target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4" /></a>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <a href={rawUrl} download={source?.fileName ?? true}>
                    <Download className="h-4 w-4 mr-1.5" />Télécharger
                  </a>
                </Button>
              </>
            )}
            <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => onOpenChange(false)} title="Fermer">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Zone d'affichage du document. */}
        <div className="flex-1 min-h-0 overflow-auto bg-muted/40 p-4">
          {loading ? (
            <div className="h-full flex flex-col items-center justify-center gap-3 text-muted-foreground">
              <Loader2 className="h-7 w-7 animate-spin" />
              {progress && <p className="text-xs">{progress}</p>}
            </div>
          ) : error ? (
            <div className="h-full flex flex-col items-center justify-center gap-3 text-muted-foreground text-center px-6">
              <FileWarning className="h-10 w-10 opacity-40" />
              <p className="text-sm">{error}</p>
              {rawUrl && (
                <Button asChild size="sm" variant="outline">
                  <a href={rawUrl} download={source?.fileName ?? true}><Download className="h-4 w-4 mr-1.5" />Télécharger le fichier</a>
                </Button>
              )}
            </div>
          ) : rendered?.kind === "pdf" ? (
            <div className="flex flex-col items-center gap-4">
              {rendered.pages.map((p, i) => (
                <img key={i} src={p} alt={`Page ${i + 1}`} className="w-full max-w-3xl rounded-md shadow-md ring-1 ring-black/5 bg-white" />
              ))}
            </div>
          ) : rendered?.kind === "image" ? (
            <div className="flex items-start justify-center">
              <img src={rendered.url} alt={title} className="max-w-full rounded-md shadow-md ring-1 ring-black/5 bg-white" />
            </div>
          ) : rendered?.kind === "text" ? (
            <pre className="mx-auto max-w-3xl bg-background p-4 rounded-md text-xs font-mono whitespace-pre-wrap ring-1 ring-black/5">{rendered.content}</pre>
          ) : rendered?.kind === "raw" ? (
            <div className="h-full flex flex-col items-center justify-center gap-3 text-muted-foreground text-center px-6">
              <FileWarning className="h-10 w-10 opacity-40" />
              <p className="text-sm">Aperçu non disponible pour ce type de fichier.</p>
              {rawUrl && (
                <Button asChild size="sm" variant="outline">
                  <a href={rawUrl} download={source?.fileName ?? true}><Download className="h-4 w-4 mr-1.5" />Télécharger le fichier</a>
                </Button>
              )}
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
