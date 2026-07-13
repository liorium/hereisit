import { describe, expect, expectTypeOf, it } from "vitest";
import {
  calculatePdfCompressScannedTarget,
  MAX_PDF_COMPRESS_SCANNED_INPUT_BYTES,
  PdfCompressScannedPlanError,
  planPdfCompressScannedRasterization,
  resolvePdfCompressScannedPreset,
} from "./compress-scanned-plan";

const MEBIBYTE = 1024 * 1024;

describe("scanned PDF compression presets", () => {
  it("resolves the balanced preset exactly", () => {
    expect(resolvePdfCompressScannedPreset("balanced")).toEqual({
      preset: "balanced",
      dpi: 150,
      quality: 72,
      background: "#ffffff",
    });
  });

  it("resolves the minimum preset exactly", () => {
    expect(resolvePdfCompressScannedPreset("minimum")).toEqual({
      preset: "minimum",
      dpi: 96,
      quality: 55,
      background: "#ffffff",
    });
  });
});

describe("scanned PDF raster planning", () => {
  it("plans already-rotated visible point dimensions without a rotation field", () => {
    const rotated = planPdfCompressScannedRasterization(
      [{ widthPoints: 792, heightPoints: 612 }],
      "balanced",
    );

    expect(rotated.pages[0]).toMatchObject({
      sourcePage: 1,
      widthPoints: 792,
      heightPoints: 612,
      width: 1_650,
      height: 1_275,
    });

    type VisiblePage = Parameters<typeof planPdfCompressScannedRasterization>[0][number];
    type HasRotationField = "rotation" extends keyof VisiblePage ? true : false;
    expectTypeOf<HasRotationField>().toEqualTypeOf<false>();
  });

  it("retains fractional point dimensions and rounds raster dimensions up", () => {
    const fractional = planPdfCompressScannedRasterization(
      [{ widthPoints: 144.25, heightPoints: 72.5 }],
      "balanced",
    );

    expect(fractional.pages[0]).toMatchObject({
      sourcePage: 1,
      widthPoints: 144.25,
      heightPoints: 72.5,
      width: 301,
      height: 152,
    });
  });

  it("assigns sequential one-based source page numbers", () => {
    const plan = planPdfCompressScannedRasterization(
      [
        { widthPoints: 72, heightPoints: 72 },
        { widthPoints: 144, heightPoints: 144 },
      ],
      "minimum",
    );

    expect(plan.pages.map((page) => page.sourcePage)).toEqual([1, 2]);
  });

  it.each([
    [[], "zero pages"],
    [Array.from({ length: 101 }, () => ({ widthPoints: 72, heightPoints: 72 })), "101 pages"],
  ] as const)("rejects %s (%s)", (pages, _label) => {
    expect(() => planPdfCompressScannedRasterization(pages, "balanced")).toThrowError(
      expect.objectContaining({
        name: "PdfCompressScannedPlanError",
        code: "PAGE_LIMIT",
      }),
    );
  });

  it("accepts exactly 100,000,000 pixels", () => {
    const plan = planPdfCompressScannedRasterization(
      [
        ...Array.from({ length: 6 }, () => ({ widthPoints: 1_920, heightPoints: 1_920 })),
        { widthPoints: 960, heightPoints: 960 },
      ],
      "balanced",
    );

    expect(plan.totalPixels).toBe(100_000_000);
  });

  it("rejects one pixel above the 100,000,000-pixel whole-document limit", () => {
    expect(() =>
      planPdfCompressScannedRasterization(
        [
          ...Array.from({ length: 6 }, () => ({ widthPoints: 1_920, heightPoints: 1_920 })),
          { widthPoints: 960, heightPoints: 960 },
          { widthPoints: 0.48, heightPoints: 0.48 },
        ],
        "balanced",
      ),
    ).toThrowError(
      expect.objectContaining({
        name: "PdfCompressScannedPlanError",
        code: "MEMORY_LIMIT",
      }),
    );
  });

  it("rejects 100 balanced A4 pages but accepts 100 minimum A4 pages", () => {
    const a4Pages = Array.from({ length: 100 }, () => ({
      widthPoints: 595.28,
      heightPoints: 841.89,
    }));

    expect(() => planPdfCompressScannedRasterization(a4Pages, "balanced")).toThrowError(
      expect.objectContaining({
        name: "PdfCompressScannedPlanError",
        code: "MEMORY_LIMIT",
      }),
    );

    expect(planPdfCompressScannedRasterization(a4Pages, "minimum")).toMatchObject({
      totalPixels: 89_166_200,
      pages: expect.arrayContaining([
        expect.objectContaining({ width: 794, height: 1_123, pixels: 891_662 }),
      ]),
    });
  });

  it("maps a shared per-page allocation failure to the compression planning error", () => {
    expect(() =>
      planPdfCompressScannedRasterization([{ widthPoints: 3_933.6, heightPoints: 72 }], "balanced"),
    ).toThrowError(
      expect.objectContaining({
        name: "PdfCompressScannedPlanError",
        code: "MEMORY_LIMIT",
      }),
    );
  });

  it("throws the exported typed planning error", () => {
    expect(() => planPdfCompressScannedRasterization([], "minimum")).toThrowError(
      PdfCompressScannedPlanError,
    );
  });
});

describe("scanned PDF byte targets", () => {
  it.each([
    [1, { requiredSaving: 1, targetBytes: 0 }],
    [99, { requiredSaving: 1, targetBytes: 98 }],
    [100, { requiredSaving: 1, targetBytes: 99 }],
    [101, { requiredSaving: 2, targetBytes: 99 }],
    [50 * MEBIBYTE, { requiredSaving: 524_288, targetBytes: 51_904_512 }],
  ] as const)("calculates an exact source-relative target for %i bytes", (sourceBytes, expected) => {
    expect(calculatePdfCompressScannedTarget(sourceBytes)).toEqual(expected);
  });

  it("publishes the exact 50 MiB source limit", () => {
    expect(MAX_PDF_COMPRESS_SCANNED_INPUT_BYTES).toBe(50 * MEBIBYTE);
  });

  it.each([
    [0, "zero"],
    [100.5, "fractional"],
    [50 * MEBIBYTE + 1, "one byte over 50 MiB"],
  ] as const)("rejects an invalid %s-byte source size (%s)", (sourceBytes, _label) => {
    expect(() => calculatePdfCompressScannedTarget(sourceBytes)).toThrowError(
      expect.objectContaining({
        name: "PdfCompressScannedPlanError",
        code: "MEMORY_LIMIT",
        message: "PDF 파일 크기를 확인할 수 없어요.",
      }),
    );
  });
});
