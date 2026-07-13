function safeStem(filename: string, fallback: string): string {
  const leaf = filename.replaceAll("\\", "/").split("/").at(-1) ?? "";
  const withoutExtension = leaf.replace(/\.pdf$/i, "");
  const cleaned = Array.from(withoutExtension.replace(/[<>:"|?*]/g, "-"))
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (
        code > 31 &&
        code !== 127 &&
        !(code >= 0x80 && code <= 0x9f) &&
        code !== 0x061c &&
        code !== 0x200e &&
        code !== 0x200f &&
        !(code >= 0x202a && code <= 0x202e) &&
        !(code >= 0x2066 && code <= 0x2069)
      );
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

export function compressedPdfName(filename: string): string {
  return `${safeStem(filename, "document")}-compressed-hereisit.pdf`;
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

export function organizedPdfName(filename: string): string {
  return `${safeStem(filename, "document")}-organized-hereisit.pdf`;
}

export function watermarkedPdfName(filename: string): string {
  return `${safeStem(filename, "document")}-watermarked-hereisit.pdf`;
}

export function pdfToImagePageName(
  filename: string,
  sourcePage: number,
  format: "jpeg" | "png",
): string {
  const extension = format === "jpeg" ? "jpg" : "png";
  return `${safeStem(filename, "document")}-page-${String(sourcePage).padStart(3, "0")}.${extension}`;
}

export function pdfToImagesArchiveName(filename: string): string {
  return `${safeStem(filename, "document")}-images-hereisit.zip`;
}
