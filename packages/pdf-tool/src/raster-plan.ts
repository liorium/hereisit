import type {
  PdfInspectionPage,
  PdfInspectionResult,
  PdfToImagesErrorCode,
  PdfToImagesSpecV1,
} from "@hereisit/tool-contracts";

export const MAX_PDF_RASTER_DIMENSION = 8_192;
export const MAX_PDF_RASTER_PAGE_PIXELS = 16_000_000;
export const PDF_RASTER_RGBA_BYTES_PER_PIXEL = 4;

export const MAX_PDF_TO_IMAGE_DIMENSION = MAX_PDF_RASTER_DIMENSION;
export const MAX_PDF_TO_IMAGE_PAGE_PIXELS = MAX_PDF_RASTER_PAGE_PIXELS;
export const MAX_PDF_TO_IMAGES_TOTAL_PIXELS = 100_000_000;
export const MAX_PDF_TO_IMAGES_OUTPUT_PAGES = 100;
export const PDF_TO_IMAGE_RGBA_BYTES_PER_PIXEL = PDF_RASTER_RGBA_BYTES_PER_PIXEL;

export interface PdfRasterVisibleSize {
  widthPoints: number;
  heightPoints: number;
}

export interface PdfRasterAllocation {
  width: number;
  height: number;
  pixels: number;
  rgbaBytes: number;
}

export class PdfRasterAllocationError extends Error {
  constructor(
    readonly reason: "INVALID_GEOMETRY" | "SIDE_LIMIT" | "PAGE_PIXEL_LIMIT",
    message: string,
  ) {
    super(message);
    this.name = "PdfRasterAllocationError";
  }
}

export interface PdfToImagePagePlan {
  sourcePage: number;
  width: number;
  height: number;
  pixels: number;
  rgbaBytes: number;
}

export interface PdfToImagesRasterPlan {
  pages: readonly PdfToImagePagePlan[];
  totalPixels: number;
}

export type PdfToImagesPlanErrorCode = Extract<
  PdfToImagesErrorCode,
  "PAGE_RANGE_INVALID" | "PAGE_LIMIT" | "MEMORY_LIMIT"
>;

const INVALID_GEOMETRY_MESSAGE =
  "PDF 페이지 크기를 안전하게 계산할 수 없어요. 다른 PDF를 선택해 주세요.";
const PAGE_MEMORY_LIMIT_MESSAGE =
  "선택한 해상도에서 페이지가 너무 커요. 더 낮은 해상도를 선택해 주세요.";
const TOTAL_MEMORY_LIMIT_MESSAGE =
  "선택한 페이지의 전체 이미지 크기가 너무 커요. 페이지 수나 해상도를 줄여 주세요.";
const PAGE_LIMIT_MESSAGE = `한 번에 최대 ${MAX_PDF_TO_IMAGES_OUTPUT_PAGES}페이지까지 이미지로 변환할 수 있어요.`;
const INVALID_INSPECTION_MESSAGE = "PDF 페이지 정보를 확인할 수 없어요. 파일을 다시 선택해 주세요.";
const INVALID_RASTER_GEOMETRY_MESSAGE =
  "PDF raster geometry must use positive finite dimensions and a positive integer DPI.";
const RASTER_SIDE_LIMIT_MESSAGE = `PDF raster dimensions cannot exceed ${MAX_PDF_RASTER_DIMENSION} pixels per side.`;
const RASTER_PAGE_PIXEL_LIMIT_MESSAGE = `PDF raster allocation cannot exceed ${MAX_PDF_RASTER_PAGE_PIXELS} pixels.`;

export class PdfToImagesPlanError extends Error {
  readonly code: PdfToImagesPlanErrorCode;

  constructor(code: PdfToImagesPlanErrorCode, message: string) {
    super(message);
    this.name = "PdfToImagesPlanError";
    this.code = code;
  }
}

function fail(code: PdfToImagesPlanErrorCode, message: string): never {
  throw new PdfToImagesPlanError(code, message);
}

function normalizeRotation(rotation: number): 0 | 90 | 180 | 270 {
  if (!Number.isSafeInteger(rotation)) {
    return fail("MEMORY_LIMIT", INVALID_GEOMETRY_MESSAGE);
  }

  const normalized = ((rotation % 360) + 360) % 360;
  if (normalized !== 0 && normalized !== 90 && normalized !== 180 && normalized !== 270) {
    return fail("MEMORY_LIMIT", INVALID_GEOMETRY_MESSAGE);
  }
  return normalized;
}

function failRasterAllocation(reason: PdfRasterAllocationError["reason"], message: string): never {
  throw new PdfRasterAllocationError(reason, message);
}

export function calculatePdfRasterDimensions(
  visibleSize: PdfRasterVisibleSize,
  dpi: number,
): { width: number; height: number } {
  if (
    !Number.isFinite(visibleSize.widthPoints) ||
    visibleSize.widthPoints <= 0 ||
    !Number.isFinite(visibleSize.heightPoints) ||
    visibleSize.heightPoints <= 0 ||
    !Number.isSafeInteger(dpi) ||
    dpi <= 0
  ) {
    return failRasterAllocation("INVALID_GEOMETRY", INVALID_RASTER_GEOMETRY_MESSAGE);
  }

  const width = Math.ceil((visibleSize.widthPoints * dpi) / 72);
  const height = Math.ceil((visibleSize.heightPoints * dpi) / 72);
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    return failRasterAllocation("INVALID_GEOMETRY", INVALID_RASTER_GEOMETRY_MESSAGE);
  }

  return { width, height };
}

export function calculatePdfRasterAllocation(
  visibleSize: PdfRasterVisibleSize,
  dpi: number,
): PdfRasterAllocation {
  const { width, height } = calculatePdfRasterDimensions(visibleSize, dpi);
  if (width > MAX_PDF_RASTER_DIMENSION || height > MAX_PDF_RASTER_DIMENSION) {
    return failRasterAllocation("SIDE_LIMIT", RASTER_SIDE_LIMIT_MESSAGE);
  }

  const pixels = width * height;
  const rgbaBytes = pixels * PDF_RASTER_RGBA_BYTES_PER_PIXEL;
  if (
    !Number.isSafeInteger(pixels) ||
    !Number.isSafeInteger(rgbaBytes) ||
    pixels > MAX_PDF_RASTER_PAGE_PIXELS ||
    rgbaBytes > MAX_PDF_RASTER_PAGE_PIXELS * PDF_RASTER_RGBA_BYTES_PER_PIXEL
  ) {
    return failRasterAllocation("PAGE_PIXEL_LIMIT", RASTER_PAGE_PIXEL_LIMIT_MESSAGE);
  }

  return { width, height, pixels, rgbaBytes };
}

function calculatePdfToImageVisibleSize(
  page: Pick<PdfInspectionPage, "width" | "height" | "rotation">,
): PdfRasterVisibleSize {
  const rotation = normalizeRotation(page.rotation);
  const swapsAxes = rotation === 90 || rotation === 270;
  return {
    widthPoints: swapsAxes ? page.height : page.width,
    heightPoints: swapsAxes ? page.width : page.height,
  };
}

function mapPdfRasterAllocationError(error: unknown): never {
  if (!(error instanceof PdfRasterAllocationError)) {
    throw error;
  }

  return fail(
    "MEMORY_LIMIT",
    error.reason === "INVALID_GEOMETRY" ? INVALID_GEOMETRY_MESSAGE : PAGE_MEMORY_LIMIT_MESSAGE,
  );
}

export function calculatePdfToImageDimensions(
  page: Pick<PdfInspectionPage, "width" | "height" | "rotation">,
  dpi: PdfToImagesSpecV1["dpi"],
): { width: number; height: number } {
  const visibleSize = calculatePdfToImageVisibleSize(page);
  try {
    return calculatePdfRasterDimensions(visibleSize, dpi);
  } catch (error) {
    return mapPdfRasterAllocationError(error);
  }
}

export function calculatePdfToImagePagePlan(
  page: PdfInspectionPage,
  dpi: PdfToImagesSpecV1["dpi"],
): PdfToImagePagePlan {
  if (!Number.isSafeInteger(page.sourcePage) || page.sourcePage < 1) {
    return fail("PAGE_RANGE_INVALID", INVALID_INSPECTION_MESSAGE);
  }

  const visibleSize = calculatePdfToImageVisibleSize(page);
  try {
    return {
      sourcePage: page.sourcePage,
      ...calculatePdfRasterAllocation(visibleSize, dpi),
    };
  } catch (error) {
    return mapPdfRasterAllocationError(error);
  }
}

export function normalizePdfToImagesPages(
  selection: PdfToImagesSpecV1["selection"],
  pageCount: number,
): readonly number[] {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
    return fail("PAGE_RANGE_INVALID", INVALID_INSPECTION_MESSAGE);
  }

  if (selection.mode === "every-page") {
    if (pageCount > MAX_PDF_TO_IMAGES_OUTPUT_PAGES) {
      return fail("PAGE_LIMIT", PAGE_LIMIT_MESSAGE);
    }
    return Array.from({ length: pageCount }, (_, index) => index + 1);
  }

  if (selection.pages.length > MAX_PDF_TO_IMAGES_OUTPUT_PAGES) {
    return fail("PAGE_LIMIT", PAGE_LIMIT_MESSAGE);
  }
  for (const sourcePage of selection.pages) {
    if (!Number.isSafeInteger(sourcePage) || sourcePage < 1 || sourcePage > pageCount) {
      return fail("PAGE_RANGE_INVALID", `이 PDF는 ${pageCount}페이지까지 있어요.`);
    }
  }
  return [...selection.pages];
}

function assertConsistentInspection(inspection: PdfInspectionResult): void {
  if (
    !Number.isSafeInteger(inspection.pageCount) ||
    inspection.pageCount < 1 ||
    inspection.pages.length !== inspection.pageCount
  ) {
    fail("PAGE_RANGE_INVALID", INVALID_INSPECTION_MESSAGE);
  }

  for (const [index, page] of inspection.pages.entries()) {
    if (page.sourcePage !== index + 1) {
      fail("PAGE_RANGE_INVALID", INVALID_INSPECTION_MESSAGE);
    }
  }
}

export function planPdfToImagesRasterization(
  inspection: PdfInspectionResult,
  spec: PdfToImagesSpecV1,
): PdfToImagesRasterPlan {
  assertConsistentInspection(inspection);
  const sourcePages = normalizePdfToImagesPages(spec.selection, inspection.pageCount);
  const pages: PdfToImagePagePlan[] = [];
  let totalPixels = 0;

  for (const sourcePage of sourcePages) {
    const inspectedPage = inspection.pages[sourcePage - 1];
    if (inspectedPage === undefined) {
      return fail("PAGE_RANGE_INVALID", INVALID_INSPECTION_MESSAGE);
    }

    const page = calculatePdfToImagePagePlan(inspectedPage, spec.dpi);
    const nextTotalPixels = totalPixels + page.pixels;
    if (
      !Number.isSafeInteger(nextTotalPixels) ||
      nextTotalPixels > MAX_PDF_TO_IMAGES_TOTAL_PIXELS
    ) {
      return fail("MEMORY_LIMIT", TOTAL_MEMORY_LIMIT_MESSAGE);
    }
    pages.push(page);
    totalPixels = nextTotalPixels;
  }

  return { pages, totalPixels };
}
