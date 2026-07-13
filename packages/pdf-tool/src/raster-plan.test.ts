import { describe, expect, it } from "vitest";
import {
  calculatePdfRasterAllocation,
  calculatePdfRasterDimensions,
  calculatePdfToImageDimensions,
  calculatePdfToImagePagePlan,
  MAX_PDF_TO_IMAGES_TOTAL_PIXELS,
  normalizePdfToImagesPages,
  PdfRasterAllocationError,
  PdfToImagesPlanError,
  planPdfToImagesRasterization,
} from "./raster-plan";

type Selection = { mode: "every-page" } | { mode: "extract"; pages: number[] };

function createSpec(selection: Selection, dpi: 96 | 150 | 300 = 96) {
  return {
    version: 1 as const,
    selection,
    output: {
      format: "jpeg" as const,
      quality: 85,
      background: "#ffffff" as const,
    },
    dpi,
  };
}

function createInspection(
  dimensions: readonly { width: number; height: number; rotation?: number }[],
) {
  return {
    pageCount: dimensions.length,
    pages: dimensions.map((page, index) => ({
      sourcePage: index + 1,
      width: page.width,
      height: page.height,
      rotation: page.rotation ?? 0,
    })),
  };
}

describe("shared PDF raster allocation", () => {
  it("accepts an 8,192-pixel side and rejects 8,193 pixels", () => {
    expect(calculatePdfRasterDimensions({ widthPoints: 6_144, heightPoints: 72 }, 96)).toEqual({
      width: 8_192,
      height: 96,
    });
    expect(() =>
      calculatePdfRasterAllocation({ widthPoints: 6_144.75, heightPoints: 72 }, 96),
    ).toThrowError(PdfRasterAllocationError);
  });

  it("accepts exactly 16,000,000 pixels and 64,000,000 RGBA bytes", () => {
    expect(
      calculatePdfRasterAllocation({ widthPoints: 3_000, heightPoints: 3_000 }, 96),
    ).toMatchObject({
      width: 4_000,
      height: 4_000,
      pixels: 16_000_000,
      rgbaBytes: 64_000_000,
    });
    expect(() =>
      calculatePdfRasterAllocation({ widthPoints: 3_000, heightPoints: 3_000.75 }, 96),
    ).toThrowError(PdfRasterAllocationError);
  });

  it.each([
    [{ widthPoints: Number.NaN, heightPoints: 72 }, 96, "NaN points"],
    [{ widthPoints: 72, heightPoints: Number.POSITIVE_INFINITY }, 96, "infinite points"],
    [{ widthPoints: 0, heightPoints: 72 }, 96, "zero points"],
    [{ widthPoints: 72, heightPoints: -1 }, 96, "negative points"],
    [{ widthPoints: 72, heightPoints: 72 }, Number.NaN, "NaN DPI"],
    [{ widthPoints: 72, heightPoints: 72 }, Number.POSITIVE_INFINITY, "infinite DPI"],
    [{ widthPoints: 72, heightPoints: 72 }, 96.5, "fractional DPI"],
    [{ widthPoints: 72, heightPoints: 72 }, 0, "zero DPI"],
    [{ widthPoints: 72, heightPoints: 72 }, -96, "negative DPI"],
  ] as const)("rejects invalid geometry: %s at %s DPI (%s)", (visibleSize, dpi, _label) => {
    expect(() => calculatePdfRasterAllocation(visibleSize, dpi)).toThrowError(
      expect.objectContaining({
        name: "PdfRasterAllocationError",
        reason: "INVALID_GEOMETRY",
      }),
    );
  });
});

describe("PDF-to-image dimensions", () => {
  it.each([
    {
      page: { width: 612, height: 792, rotation: 0 },
      dpi: 96,
      expected: { width: 816, height: 1056 },
    },
    {
      page: { width: 612, height: 792, rotation: 90 },
      dpi: 150,
      expected: { width: 1650, height: 1275 },
    },
    {
      page: { width: 612, height: 792, rotation: 180 },
      dpi: 300,
      expected: { width: 2550, height: 3300 },
    },
    {
      page: { width: 612, height: 792, rotation: 270 },
      dpi: 150,
      expected: { width: 1650, height: 1275 },
    },
  ] as const)("calculates conservative dimensions for rotation $page.rotation at $dpi DPI", ({
    page,
    dpi,
    expected,
  }) => {
    expect(calculatePdfToImageDimensions(page, dpi)).toEqual(expected);
  });

  it("rounds each fractional pixel dimension up", () => {
    expect(calculatePdfToImageDimensions({ width: 612.1, height: 792.1, rotation: 0 }, 96)).toEqual(
      { width: 817, height: 1057 },
    );
  });

  it("normalizes positive and negative full turns", () => {
    expect(calculatePdfToImageDimensions({ width: 612, height: 792, rotation: 450 }, 150)).toEqual({
      width: 1650,
      height: 1275,
    });
    expect(calculatePdfToImageDimensions({ width: 612, height: 792, rotation: -90 }, 150)).toEqual({
      width: 1650,
      height: 1275,
    });
  });

  it.each([
    [{ width: 0, height: 792, rotation: 0 }, "zero width"],
    [{ width: Number.NaN, height: 792, rotation: 0 }, "NaN width"],
    [{ width: 612, height: Number.POSITIVE_INFINITY, rotation: 0 }, "infinite height"],
    [{ width: 612, height: 792, rotation: 45 }, "non-quarter rotation"],
  ])("rejects invalid geometry: %s", (page) => {
    expect(() => calculatePdfToImageDimensions(page, 96)).toThrowError(
      expect.objectContaining({
        name: "PdfToImagesPlanError",
        code: "MEMORY_LIMIT",
        message: "PDF 페이지 크기를 안전하게 계산할 수 없어요. 다른 PDF를 선택해 주세요.",
      }),
    );
  });
});

describe("PDF-to-image page resource planning", () => {
  it("accepts an 8,192-pixel side and rejects 8,193 pixels", () => {
    expect(
      calculatePdfToImagePagePlan({ sourcePage: 1, width: 6_144, height: 0.75, rotation: 0 }, 96),
    ).toMatchObject({ width: 8_192, height: 1, pixels: 8_192, rgbaBytes: 32_768 });

    expect(() =>
      calculatePdfToImagePagePlan(
        { sourcePage: 1, width: 6_144.75, height: 0.75, rotation: 0 },
        96,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "MEMORY_LIMIT",
        message: "선택한 해상도에서 페이지가 너무 커요. 더 낮은 해상도를 선택해 주세요.",
      }),
    );
  });

  it("accepts 16,000,000 pixels and 64,000,000 RGBA bytes, then rejects one extra row", () => {
    expect(
      calculatePdfToImagePagePlan({ sourcePage: 1, width: 3_000, height: 3_000, rotation: 0 }, 96),
    ).toEqual({
      sourcePage: 1,
      width: 4_000,
      height: 4_000,
      pixels: 16_000_000,
      rgbaBytes: 64_000_000,
    });

    expect(() =>
      calculatePdfToImagePagePlan(
        { sourcePage: 1, width: 3_000, height: 3_000.75, rotation: 0 },
        96,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "MEMORY_LIMIT",
        message: "선택한 해상도에서 페이지가 너무 커요. 더 낮은 해상도를 선택해 주세요.",
      }),
    );
  });
});

describe("PDF-to-images selection normalization", () => {
  it("accepts every page up to the exact 100-page cap", () => {
    expect(normalizePdfToImagesPages({ mode: "every-page" }, 100)).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 1),
    );
  });

  it("rejects every-page output above the 100-page cap with corrective copy", () => {
    expect(() => normalizePdfToImagesPages({ mode: "every-page" }, 101)).toThrowError(
      expect.objectContaining({
        name: "PdfToImagesPlanError",
        code: "PAGE_LIMIT",
        message: "한 번에 최대 100페이지까지 이미지로 변환할 수 있어요.",
      }),
    );
  });

  it("preserves explicit extraction order", () => {
    expect(normalizePdfToImagesPages({ mode: "extract", pages: [3, 1] }, 3)).toEqual([3, 1]);
  });

  it("rejects a page outside the inspected document", () => {
    expect(() => normalizePdfToImagesPages({ mode: "extract", pages: [3] }, 2)).toThrowError(
      expect.objectContaining({
        name: "PdfToImagesPlanError",
        code: "PAGE_RANGE_INVALID",
        message: "이 PDF는 2페이지까지 있어요.",
      }),
    );
  });
});

describe("PDF-to-images raster planning", () => {
  it("accepts exactly 100,000,000 selected pixels", () => {
    const inspection = createInspection([
      ...Array.from({ length: 6 }, () => ({ width: 3_000, height: 3_000 })),
      { width: 1_500, height: 1_500 },
    ]);

    const plan = planPdfToImagesRasterization(inspection, createSpec({ mode: "every-page" }));

    expect(plan.totalPixels).toBe(MAX_PDF_TO_IMAGES_TOTAL_PIXELS);
    expect(plan.pages).toHaveLength(7);
  });

  it("rejects one pixel above the selected-job limit", () => {
    const inspection = createInspection([
      ...Array.from({ length: 6 }, () => ({ width: 3_000, height: 3_000 })),
      { width: 1_500, height: 1_500 },
      { width: 0.75, height: 0.75 },
    ]);

    expect(() =>
      planPdfToImagesRasterization(inspection, createSpec({ mode: "every-page" })),
    ).toThrowError(
      expect.objectContaining({
        code: "MEMORY_LIMIT",
        message: "선택한 페이지의 전체 이미지 크기가 너무 커요. 페이지 수나 해상도를 줄여 주세요.",
      }),
    );
  });

  it("plans extraction in the explicit source-page order", () => {
    const plan = planPdfToImagesRasterization(
      createInspection([
        { width: 72, height: 72 },
        { width: 144, height: 144 },
        { width: 216, height: 216 },
      ]),
      createSpec({ mode: "extract", pages: [3, 1] }),
    );

    expect(plan.pages.map((page) => page.sourcePage)).toEqual([3, 1]);
  });

  it("rejects inconsistent inspection indices before planning selected pages", () => {
    const inspection = {
      pageCount: 2,
      pages: [
        { sourcePage: 1, width: 72, height: 72, rotation: 0 },
        { sourcePage: 3, width: 72, height: 72, rotation: 0 },
      ],
    };

    expect(() =>
      planPdfToImagesRasterization(inspection, createSpec({ mode: "extract", pages: [1] })),
    ).toThrowError(
      expect.objectContaining({
        code: "PAGE_RANGE_INVALID",
        message: "PDF 페이지 정보를 확인할 수 없어요. 파일을 다시 선택해 주세요.",
      }),
    );
  });

  it("throws the exported typed planning error", () => {
    expect(() => normalizePdfToImagesPages({ mode: "extract", pages: [2] }, 1)).toThrowError(
      PdfToImagesPlanError,
    );
  });
});
