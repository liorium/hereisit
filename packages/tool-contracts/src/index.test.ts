import { describe, expect, it } from "vitest";
import { imagePipelineSpecSchema, pdfPipelineSpecSchema } from "./index";

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
