// Type MIME déduit de l'extension d'un nom de fichier — sert de repli quand le
// stockage ne renvoie pas de Content-Type fiable, pour forcer un affichage
// INLINE correct (PDF / image) dans un <iframe>/<img>.
export function mimeFromName(name?: string | null): string | null {
  const ext = (name || "").toLowerCase().split(".").pop() || "";
  if (ext === "pdf") return "application/pdf";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png" || ext === "gif" || ext === "webp" || ext === "bmp") return `image/${ext}`;
  if (ext === "svg") return "image/svg+xml";
  if (ext === "xml") return "application/xml";
  return null;
}

export const isPdf = (mime?: string | null) => (mime || "").includes("pdf");
export const isImage = (mime?: string | null) => (mime || "").startsWith("image/");
