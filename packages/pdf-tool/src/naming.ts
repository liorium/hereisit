function safeStem(filename: string, fallback: string): string {
  const leaf = filename.replaceAll("\\", "/").split("/").at(-1) ?? "";
  const withoutExtension = leaf.replace(/\.pdf$/i, "");
  const cleaned = Array.from(withoutExtension.replace(/[<>:"|?*]/g, "-"))
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 31 && code !== 127;
    })
    .join("")
    .trim()
    .replace(/^\.+/, "");
  return Array.from(cleaned || fallback)
    .slice(0, 120)
    .join("");
}

export function mergedPdfName(): string {
  return "merged-hereisit.pdf";
}

export function splitPdfArchiveName(filename: string): string {
  return `${safeStem(filename, "document")}-pages-hereisit.zip`;
}

export function splitPdfPageName(filename: string, page: number, pageCount: number): string {
  const digits = Math.max(3, String(pageCount).length);
  return `${safeStem(filename, "document")}-page-${String(page).padStart(digits, "0")}.pdf`;
}

export function extractedPdfName(filename: string): string {
  return `${safeStem(filename, "document")}-selected-hereisit.pdf`;
}

export function imagesPdfName(): string {
  return "images-hereisit.pdf";
}
