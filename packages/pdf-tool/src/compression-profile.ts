export interface PdfCompressionPageSignals {
  readonly nonWhitespaceTextItems: number;
  readonly annotationCount: number;
  readonly imagePaintOperations: number;
  readonly nonImagePaintOperations: number;
}

export type PdfCompressionDocumentProfile = "image-only" | "structured";

export function classifyPdfCompressionDocument(
  pages: readonly PdfCompressionPageSignals[],
): PdfCompressionDocumentProfile {
  return pages.length > 0 &&
    pages.every(
      (page) =>
        page.nonWhitespaceTextItems === 0 &&
        page.annotationCount === 0 &&
        page.imagePaintOperations > 0 &&
        page.nonImagePaintOperations === 0,
    )
    ? "image-only"
    : "structured";
}
