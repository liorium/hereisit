import { describe, expect, it } from "vitest";
import {
  imagePipelineSpecSchema,
  PDF_COMPRESS_SCANNED_TOOL_ID,
  PDF_COMPRESS_SCANNED_TOOL_VERSION,
  PDF_TO_IMAGES_TOOL_ID,
  PDF_TO_IMAGES_TOOL_VERSION,
  pdfCompressScannedSpecSchema,
  pdfPipelineSpecSchema,
  pdfToImagesSpecSchema,
} from "./index";

const basePdfToImagesSpec = {
  version: 1 as const,
  selection: { mode: "every-page" as const },
  output: { format: "jpeg" as const, quality: 85, background: "#ffffff" as const },
  dpi: 150 as const,
};

describe("imagePipelineSpecSchema", () => {
  it("rejects an inverted target-size quality range", () => {
    const result = imagePipelineSpecSchema.safeParse({
      version: 1,
      resize: { kind: "none" },
      output: {
        format: "webp",
        compression: {
          mode: "maxBytes",
          maxBytes: 100_000,
          minQuality: 92,
          maxQuality: 35,
          maxAttempts: 6,
        },
      },
      autoOrient: true,
      metadata: "strip",
    });
    expect(result.success).toBe(false);
  });

  it("defaults legacy specs to allow output growth", () => {
    const result = imagePipelineSpecSchema.parse({
      version: 1,
      resize: { kind: "none" },
      output: { format: "webp", compression: { mode: "quality", quality: 82 } },
      autoOrient: true,
      metadata: "strip",
    });

    expect(result.sizeGoal).toEqual({ mode: "allow-growth" });
  });

  it("fills bounded defaults for the smaller-only goal", () => {
    const result = imagePipelineSpecSchema.parse({
      version: 1,
      resize: { kind: "none" },
      output: { format: "webp", compression: { mode: "quality", quality: 82 } },
      sizeGoal: { mode: "smaller-only" },
      autoOrient: true,
      metadata: "strip",
    });

    expect(result.sizeGoal).toEqual({
      mode: "smaller-only",
      minSavingsPercent: 1,
      minQuality: 35,
      maxAttempts: 6,
    });
  });
});

describe("pdfToImagesSpecSchema", () => {
  it("publishes the independent tool identity", () => {
    expect(PDF_TO_IMAGES_TOOL_ID).toBe("pdf.to-images");
    expect(PDF_TO_IMAGES_TOOL_VERSION).toBe(1);
  });

  it.each([40, 85, 95])("accepts JPEG quality %i", (quality) => {
    expect(
      pdfToImagesSpecSchema.safeParse({
        ...basePdfToImagesSpec,
        output: { format: "jpeg", quality, background: "#ffffff" },
      }).success,
    ).toBe(true);
  });

  it.each([39, 40.5, 96])("rejects JPEG quality %s", (quality) => {
    expect(
      pdfToImagesSpecSchema.safeParse({
        ...basePdfToImagesSpec,
        output: { format: "jpeg", quality, background: "#ffffff" },
      }).success,
    ).toBe(false);
  });

  it.each([96, 150, 300])("accepts %iDPI", (dpi) => {
    expect(pdfToImagesSpecSchema.safeParse({ ...basePdfToImagesSpec, dpi }).success).toBe(true);
  });

  it("accepts PNG without quality", () => {
    expect(
      pdfToImagesSpecSchema.safeParse({
        ...basePdfToImagesSpec,
        output: { format: "png", background: "#ffffff" },
      }).success,
    ).toBe(true);
  });

  it.each([
    ["JPEG without quality", { format: "jpeg", background: "#ffffff" }],
    ["WebP", { format: "webp", quality: 85, background: "#ffffff" }],
    ["a non-white JPEG background", { format: "jpeg", quality: 85, background: "#000000" }],
    ["a non-white PNG background", { format: "png", background: "#000000" }],
  ])("rejects %s output", (_case, output) => {
    expect(pdfToImagesSpecSchema.safeParse({ ...basePdfToImagesSpec, output }).success).toBe(false);
  });

  it.each([
    ["72DPI", 72],
    ["string DPI", "150"],
  ])("rejects %s", (_case, dpi) => {
    expect(pdfToImagesSpecSchema.safeParse({ ...basePdfToImagesSpec, dpi }).success).toBe(false);
  });

  it("rejects version 2", () => {
    expect(pdfToImagesSpecSchema.safeParse({ ...basePdfToImagesSpec, version: 2 }).success).toBe(
      false,
    );
  });

  it.each([
    ["an empty extraction", []],
    ["duplicate pages", [1, 1]],
    ["page zero", [0]],
    ["a negative page", [-1]],
    ["a fractional page", [1.5]],
    ["page 501", [501]],
    ["101 unique pages", Array.from({ length: 101 }, (_, index) => index + 1)],
  ])("rejects extraction with %s", (_case, pages) => {
    expect(
      pdfToImagesSpecSchema.safeParse({
        ...basePdfToImagesSpec,
        selection: { mode: "extract", pages },
      }).success,
    ).toBe(false);
  });

  it("accepts extraction without sorting pages", () => {
    const result = pdfToImagesSpecSchema.safeParse({
      ...basePdfToImagesSpec,
      selection: { mode: "extract", pages: [3, 1, 2] },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.selection).toEqual({ mode: "extract", pages: [3, 1, 2] });
    }
  });
});

describe("pdfCompressScannedSpecSchema", () => {
  it("publishes the independent scanned compression identity", () => {
    expect(PDF_COMPRESS_SCANNED_TOOL_ID).toBe("pdf.compress-scanned");
    expect(PDF_COMPRESS_SCANNED_TOOL_VERSION).toBe(1);
  });

  it.each(["balanced", "minimum"])("accepts the %s preset", (preset) => {
    expect(pdfCompressScannedSpecSchema.safeParse({ version: 1, preset }).success).toBe(true);
  });

  it.each([
    {},
    { version: 0, preset: "balanced" },
    { version: 2, preset: "balanced" },
    { version: 1 },
    { version: 1, preset: "adaptive" },
    { version: 1, preset: 96 },
    { version: 1, preset: "balanced", dpi: 96 },
    { version: 1, preset: "balanced", quality: 20 },
    { version: 1, preset: "balanced", background: "#000000" },
  ])("rejects caller-controlled or invalid settings %#", (value) => {
    expect(pdfCompressScannedSpecSchema.safeParse(value).success).toBe(false);
  });
});

describe("pdfPipelineSpecSchema", () => {
  it("parses every supported PDF operation", () => {
    expect(pdfPipelineSpecSchema.parse({ version: 1, operation: "merge" })).toEqual({
      version: 1,
      operation: "merge",
    });
    expect(
      pdfPipelineSpecSchema.parse({
        version: 1,
        operation: "split",
        selection: { mode: "every-page" },
      }),
    ).toMatchObject({ operation: "split" });
    expect(
      pdfPipelineSpecSchema.parse({
        version: 1,
        operation: "images-to-pdf",
        page: { size: "a4" },
      }),
    ).toMatchObject({ page: { size: "a4", margin: 24 } });
  });

  it("rejects duplicate extracted pages", () => {
    const result = pdfPipelineSpecSchema.safeParse({
      version: 1,
      operation: "split",
      selection: { mode: "extract", pages: [1, 1] },
    });
    expect(result.success).toBe(false);
  });

  it("parses a valid PDF page organization plan", () => {
    const result = pdfPipelineSpecSchema.parse({
      version: 1,
      operation: "organize",
      pages: [
        { sourcePage: 3, rotateBy: 90 },
        { sourcePage: 1, rotateBy: 270 },
      ],
    });

    expect(result).toEqual({
      version: 1,
      operation: "organize",
      pages: [
        { sourcePage: 3, rotateBy: 90 },
        { sourcePage: 1, rotateBy: 270 },
      ],
    });
  });

  it.each([
    ["an empty plan", []],
    [
      "duplicate source pages",
      [
        { sourcePage: 1, rotateBy: 0 },
        { sourcePage: 1, rotateBy: 180 },
      ],
    ],
    ["a source page below the range", [{ sourcePage: 0, rotateBy: 0 }]],
    ["a source page above the range", [{ sourcePage: 501, rotateBy: 0 }]],
  ])("rejects organize specs with %s", (_case, pages) => {
    const result = pdfPipelineSpecSchema.safeParse({
      version: 1,
      operation: "organize",
      pages,
    });

    expect(result.success).toBe(false);
  });

  it("rejects a 45-degree page organization rotation", () => {
    const result = pdfPipelineSpecSchema.safeParse({
      version: 1,
      operation: "organize",
      pages: [{ sourcePage: 1, rotateBy: 45 }],
    });

    expect(result.success).toBe(false);
  });

  it("trims and parses valid Korean watermark text", () => {
    const result = pdfPipelineSpecSchema.parse({
      version: 1,
      operation: "watermark",
      watermark: {
        text: "  사내 전용  ",
        placement: "center",
        fontSize: 36,
        opacity: 0.25,
        rotation: -45,
        color: "#334455",
      },
      selection: { mode: "extract", pages: [1, 500] },
    });

    expect(result).toMatchObject({
      operation: "watermark",
      watermark: { text: "사내 전용" },
      selection: { mode: "extract", pages: [1, 500] },
    });
  });

  it.each([
    ["every page", { mode: "every-page" }],
    ["selected pages", { mode: "extract", pages: [1, 500] }],
  ])("accepts watermark selection for %s", (_case, selection) => {
    const result = pdfPipelineSpecSchema.safeParse({
      version: 1,
      operation: "watermark",
      watermark: {
        text: "대외비",
        placement: "center",
        fontSize: 48,
        opacity: 0.18,
        rotation: -45,
        color: "#334155",
      },
      selection,
    });

    expect(result.success).toBe(true);
  });

  it.each([
    ["an empty page array", []],
    ["duplicate pages", [1, 1]],
    ["page zero", [0]],
    ["a negative page", [-1]],
    ["more than 500 pages", Array.from({ length: 501 }, (_, index) => index + 1)],
  ])("rejects watermark selection with %s", (_case, pages) => {
    const result = pdfPipelineSpecSchema.safeParse({
      version: 1,
      operation: "watermark",
      watermark: {
        text: "대외비",
        placement: "center",
        fontSize: 48,
        opacity: 0.18,
        rotation: -45,
        color: "#334155",
      },
      selection: { mode: "extract", pages },
    });

    expect(result.success).toBe(false);
  });

  it.each([
    ["empty text", "   "],
    ["81-character text", "가".repeat(81)],
    ["control characters", "검토\u0000금지"],
    ["bidirectional override characters", "검토\u202e금지"],
  ])("rejects watermark specs with %s", (_case, text) => {
    const result = pdfPipelineSpecSchema.safeParse({
      version: 1,
      operation: "watermark",
      watermark: {
        text,
        placement: "tile",
        fontSize: 24,
        opacity: 0.3,
        rotation: 45,
        color: "#abcdef",
      },
      selection: { mode: "every-page" },
    });

    expect(result.success).toBe(false);
  });

  it.each([0.049, 0.801])("rejects watermark opacity %s outside the supported range", (opacity) => {
    const result = pdfPipelineSpecSchema.safeParse({
      version: 1,
      operation: "watermark",
      watermark: {
        text: "검토용",
        placement: "center",
        fontSize: 36,
        opacity,
        rotation: 0,
        color: "#123456",
      },
      selection: { mode: "every-page" },
    });

    expect(result.success).toBe(false);
  });

  it.each(["#fff", "123456", "#gggggg"])("rejects invalid watermark color %s", (color) => {
    const result = pdfPipelineSpecSchema.safeParse({
      version: 1,
      operation: "watermark",
      watermark: {
        text: "검토용",
        placement: "center",
        fontSize: 36,
        opacity: 0.25,
        rotation: 0,
        color,
      },
      selection: { mode: "every-page" },
    });

    expect(result.success).toBe(false);
  });

  it("rejects an unsupported watermark rotation", () => {
    const result = pdfPipelineSpecSchema.safeParse({
      version: 1,
      operation: "watermark",
      watermark: {
        text: "검토용",
        placement: "center",
        fontSize: 36,
        opacity: 0.25,
        rotation: 90,
        color: "#123456",
      },
      selection: { mode: "every-page" },
    });

    expect(result.success).toBe(false);
  });
});
