import type {
  PdfCompressScannedErrorCode,
  PdfCompressScannedPreset,
} from "@hereisit/tool-contracts";
import {
  calculatePdfRasterAllocation,
  PdfRasterAllocationError,
  type PdfRasterVisibleSize,
} from "./raster-plan";

export const MAX_PDF_COMPRESS_SCANNED_INPUT_BYTES = 50 * 1024 * 1024;
export const MAX_PDF_COMPRESS_SCANNED_PAGES = 100;
export const MAX_PDF_COMPRESS_SCANNED_TOTAL_PIXELS = 100_000_000;

export type PdfCompressScannedPresetResolution =
  | {
      readonly preset: "balanced";
      readonly dpi: 150;
      readonly quality: 72;
      readonly background: "#ffffff";
    }
  | {
      readonly preset: "minimum";
      readonly dpi: 96;
      readonly quality: 55;
      readonly background: "#ffffff";
    };

export const PDF_COMPRESS_SCANNED_PRESETS = {
  balanced: {
    preset: "balanced",
    dpi: 150,
    quality: 72,
    background: "#ffffff",
  },
  minimum: {
    preset: "minimum",
    dpi: 96,
    quality: 55,
    background: "#ffffff",
  },
} as const satisfies Record<PdfCompressScannedPreset, PdfCompressScannedPresetResolution>;

export interface PdfCompressScannedPagePlan extends PdfRasterVisibleSize {
  readonly sourcePage: number;
  readonly width: number;
  readonly height: number;
  readonly pixels: number;
  readonly rgbaBytes: number;
}

export type PdfCompressScannedRasterPlan = PdfCompressScannedPresetResolution & {
  readonly pages: readonly PdfCompressScannedPagePlan[];
  readonly totalPixels: number;
};

export interface PdfCompressScannedByteTarget {
  readonly requiredSaving: number;
  readonly targetBytes: number;
}

export type PdfCompressScannedPlanErrorCode = Extract<
  PdfCompressScannedErrorCode,
  "PAGE_LIMIT" | "MEMORY_LIMIT"
>;

const PAGE_LIMIT_MESSAGE = `PDF는 1페이지부터 ${MAX_PDF_COMPRESS_SCANNED_PAGES}페이지까지 압축할 수 있어요.`;
const MEMORY_LIMIT_MESSAGE =
  "선택한 설정에서 PDF 페이지의 전체 이미지 크기가 너무 커요. 더 낮은 해상도를 선택해 주세요.";
const INPUT_SIZE_MESSAGE = "PDF 파일 크기를 확인할 수 없어요.";

export class PdfCompressScannedPlanError extends Error {
  constructor(
    readonly code: PdfCompressScannedPlanErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PdfCompressScannedPlanError";
  }
}

function fail(code: PdfCompressScannedPlanErrorCode, message: string): never {
  throw new PdfCompressScannedPlanError(code, message);
}

export function resolvePdfCompressScannedPreset(
  preset: PdfCompressScannedPreset,
): PdfCompressScannedPresetResolution {
  return PDF_COMPRESS_SCANNED_PRESETS[preset];
}

export function planPdfCompressScannedRasterization(
  visiblePages: readonly PdfRasterVisibleSize[],
  preset: PdfCompressScannedPreset,
): PdfCompressScannedRasterPlan {
  if (visiblePages.length < 1 || visiblePages.length > MAX_PDF_COMPRESS_SCANNED_PAGES) {
    return fail("PAGE_LIMIT", PAGE_LIMIT_MESSAGE);
  }

  const resolution = resolvePdfCompressScannedPreset(preset);
  const pages: PdfCompressScannedPagePlan[] = [];
  let totalPixels = 0;

  for (const [index, visibleSize] of visiblePages.entries()) {
    try {
      const allocation = calculatePdfRasterAllocation(visibleSize, resolution.dpi);
      const nextTotalPixels = totalPixels + allocation.pixels;
      if (
        !Number.isSafeInteger(nextTotalPixels) ||
        nextTotalPixels > MAX_PDF_COMPRESS_SCANNED_TOTAL_PIXELS
      ) {
        return fail("MEMORY_LIMIT", MEMORY_LIMIT_MESSAGE);
      }

      pages.push({
        sourcePage: index + 1,
        widthPoints: visibleSize.widthPoints,
        heightPoints: visibleSize.heightPoints,
        ...allocation,
      });
      totalPixels = nextTotalPixels;
    } catch (error) {
      if (error instanceof PdfRasterAllocationError) {
        return fail("MEMORY_LIMIT", MEMORY_LIMIT_MESSAGE);
      }
      throw error;
    }
  }

  return { ...resolution, pages, totalPixels };
}

export function calculatePdfCompressScannedTarget(
  sourceByteLength: number,
): PdfCompressScannedByteTarget {
  if (
    !Number.isSafeInteger(sourceByteLength) ||
    sourceByteLength < 1 ||
    sourceByteLength > MAX_PDF_COMPRESS_SCANNED_INPUT_BYTES
  ) {
    throw new PdfCompressScannedPlanError("MEMORY_LIMIT", INPUT_SIZE_MESSAGE);
  }
  const requiredSaving = Math.max(1, Math.ceil(sourceByteLength / 100));
  return { requiredSaving, targetBytes: sourceByteLength - requiredSaving };
}
