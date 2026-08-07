export const PDF_THUMBNAIL_LONG_EDGE = 160;
export const MAX_PDF_THUMBNAIL_TOTAL_BYTES = 48 * 1024 * 1024;

export interface PdfThumbnailRasterPlan {
  scale: number;
  width: number;
  height: number;
  rawByteLimit: number;
}

export function planPdfThumbnailRaster(width: number, height: number): PdfThumbnailRasterPlan {
  if (![width, height].every((value) => Number.isFinite(value) && value > 0)) {
    throw new RangeError("PDF 썸네일 크기는 양수여야 합니다.");
  }

  const scale = Math.min(1, PDF_THUMBNAIL_LONG_EDGE / Math.max(width, height));
  const plannedWidth = Math.max(1, Math.ceil(width * scale));
  const plannedHeight = Math.max(1, Math.ceil(height * scale));

  return {
    scale,
    width: plannedWidth,
    height: plannedHeight,
    rawByteLimit: plannedWidth * plannedHeight * 4,
  };
}

export function acceptPdfThumbnailBytes(
  usedBytes: number,
  encodedBytes: number,
  pageRawByteLimit: number,
): number | undefined {
  if (
    ![usedBytes, encodedBytes, pageRawByteLimit].every(Number.isSafeInteger) ||
    usedBytes < 0 ||
    encodedBytes < 1 ||
    encodedBytes > pageRawByteLimit
  ) {
    return undefined;
  }

  const total = usedBytes + encodedBytes;
  return Number.isSafeInteger(total) && total <= MAX_PDF_THUMBNAIL_TOTAL_BYTES
    ? total
    : undefined;
}
