import { describe, expect, it } from "vitest";
import {
  IMAGE_TOOL_VERSION,
  IMAGE_WATERMARK_TOOL_ID,
  IMAGE_WATERMARK_TOOL_VERSION,
  imagePipelineSpecSchema,
  imagePipelineSpecV1Schema,
  imagePipelineSpecV2Schema,
  imageWatermarkSpecSchema,
  JSON_FORMAT_TOOL_ID,
  JSON_FORMAT_TOOL_VERSION,
} from "./index";

describe("JSON format contract", () => {
  it("publishes the stable local tool identity", () => {
    expect(JSON_FORMAT_TOOL_ID).toBe("json.format");
    expect(JSON_FORMAT_TOOL_VERSION).toBe(1);
  });
});

const baseImageWatermarkSpec = {
  version: 1 as const,
  watermark: {
    kind: "text" as const,
    text: "HereIsIt",
    color: "#111827",
    sizePercent: 12,
  },
  position: "bottom-right" as const,
  marginPercent: 3,
  opacity: 0.55,
  output: { format: "source" as const, quality: 90 },
  autoOrient: true as const,
  metadata: "strip" as const,
};

describe("imagePipelineSpecSchema", () => {
  it("publishes source-format compression only in image pipeline v2", () => {
    expect(IMAGE_TOOL_VERSION).toBe(2);
    expect(
      imagePipelineSpecSchema.safeParse({
        version: 1,
        resize: { kind: "none" },
        output: { format: "source", compression: { mode: "quality", quality: 82 } },
        sizeGoal: { mode: "smaller-only" },
        autoOrient: true,
        metadata: "strip",
      }).success,
    ).toBe(false);

    const result = imagePipelineSpecSchema.parse({
      version: 2,
      resize: { kind: "none" },
      output: { format: "source", compression: { mode: "quality", quality: 82 } },
      sizeGoal: { mode: "smaller-only" },
      autoOrient: true,
      metadata: "strip",
    });

    expect(result.output).toEqual({
      format: "source",
      compression: { mode: "quality", quality: 82 },
    });
  });

  it("rejects a max-byte policy that cannot apply to source PNG", () => {
    expect(
      imagePipelineSpecSchema.safeParse({
        version: 2,
        resize: { kind: "none" },
        output: {
          format: "source",
          compression: { mode: "maxBytes", maxBytes: 10_000 },
        },
        sizeGoal: { mode: "smaller-only" },
        autoOrient: true,
        metadata: "strip",
      }).success,
    ).toBe(false);
  });

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

  it("publishes quarter-turn rotation for image transform tools", () => {
    const base = {
      version: 2,
      resize: { kind: "none" },
      output: { format: "webp", compression: { mode: "quality", quality: 82 } },
      autoOrient: true,
      metadata: "strip",
    } as const;

    expect(imagePipelineSpecV2Schema.parse(base).rotation).toBe(0);
    for (const rotation of [0, 90, 180, 270] as const) {
      expect(imagePipelineSpecV2Schema.parse({ ...base, rotation }).rotation).toBe(rotation);
    }
    expect(imagePipelineSpecSchema.safeParse({ ...base, rotation: 45 }).success).toBe(false);
  });

  it("accepts rotation direction filters only in the v2 contract", () => {
    const base = {
      version: 2,
      resize: { kind: "none" },
      output: { format: "webp", compression: { mode: "quality", quality: 82 } },
      autoOrient: true,
      metadata: "strip",
    } as const;

    for (const rotationScope of ["all", "portrait", "landscape"] as const) {
      expect(imagePipelineSpecV2Schema.parse({ ...base, rotationScope }).rotationScope).toBe(
        rotationScope,
      );
    }
    expect(
      imagePipelineSpecV1Schema.safeParse({ ...base, version: 1, rotationScope: "all" }).success,
    ).toBe(false);
  });

  it("accepts a bounded source rectangle for free-form cover crops", () => {
    const result = imagePipelineSpecV2Schema.safeParse({
      version: 2,
      resize: {
        kind: "cover",
        width: 1200,
        height: 720,
        sourceRect: { x: 0.1, y: 0.2, width: 0.5, height: 0.6 },
      },
      output: { format: "webp", compression: { mode: "quality", quality: 82 } },
      autoOrient: true,
      metadata: "strip",
    });

    expect(result.success).toBe(true);
  });

  it("accepts a bounded percentage resize in the v2 contract", () => {
    expect(
      imagePipelineSpecV2Schema.safeParse({
        version: 2,
        resize: { kind: "percentage", percent: 75 },
        output: { format: "webp", compression: { mode: "quality", quality: 82 } },
        autoOrient: true,
        metadata: "strip",
      }).success,
    ).toBe(true);
  });

  it.each([0, 400.5, 401, Number.NaN])("rejects an invalid percentage resize: %s", (percent) => {
    expect(
      imagePipelineSpecV2Schema.safeParse({
        version: 2,
        resize: { kind: "percentage", percent },
        output: { format: "webp", compression: { mode: "quality", quality: 82 } },
        autoOrient: true,
        metadata: "strip",
      }).success,
    ).toBe(false);
  });

  it("keeps free-form source rectangles out of the v1 contract", () => {
    expect(
      imagePipelineSpecSchema.safeParse({
        version: 1,
        resize: {
          kind: "cover",
          width: 1200,
          height: 720,
          sourceRect: { x: 0.1, y: 0.2, width: 0.5, height: 0.6 },
        },
        output: { format: "webp", compression: { mode: "quality", quality: 82 } },
        autoOrient: true,
        metadata: "strip",
      }).success,
    ).toBe(false);
  });

  it("keeps percentage resize out of the v1 contract", () => {
    expect(
      imagePipelineSpecSchema.safeParse({
        version: 1,
        resize: { kind: "percentage", percent: 75 },
        output: { format: "webp", compression: { mode: "quality", quality: 82 } },
        autoOrient: true,
        metadata: "strip",
      }).success,
    ).toBe(false);
  });

  it.each([
    { x: 0.5, y: 0, width: 0.6, height: 0.5 },
    { x: 0, y: 0.5, width: 0.5, height: 0.6 },
    { x: -0.1, y: 0, width: 0.5, height: 0.5 },
    { x: 0, y: 0, width: 0, height: 0.5 },
  ])("rejects a source rectangle outside the image bounds: %o", (sourceRect) => {
    expect(
      imagePipelineSpecV2Schema.safeParse({
        version: 2,
        resize: { kind: "cover", width: 1200, height: 720, sourceRect },
        output: { format: "webp", compression: { mode: "quality", quality: 82 } },
        autoOrient: true,
        metadata: "strip",
      }).success,
    ).toBe(false);
  });
});

describe("imageWatermarkSpecSchema", () => {
  it("publishes the independent identity and trims safe text", () => {
    expect(IMAGE_WATERMARK_TOOL_ID).toBe("image.watermark");
    expect(IMAGE_WATERMARK_TOOL_VERSION).toBe(1);
    expect(
      imageWatermarkSpecSchema.parse({
        version: 1,
        watermark: { kind: "text", text: "  © HereIsIt  ", color: "#111827", sizePercent: 12 },
        position: "bottom-right",
        marginPercent: 3,
        opacity: 0.55,
        output: { format: "source", quality: 90 },
        autoOrient: true,
        metadata: "strip",
      }),
    ).toMatchObject({ watermark: { text: "© HereIsIt" } });
  });

  it.each([
    "top-left",
    "top-center",
    "top-right",
    "middle-left",
    "center",
    "middle-right",
    "bottom-left",
    "bottom-center",
    "bottom-right",
  ])("accepts the %s position", (position) => {
    expect(
      imageWatermarkSpecSchema.safeParse({ ...baseImageWatermarkSpec, position }).success,
    ).toBe(true);
  });

  it.each([
    ["text", { kind: "text", text: "© HereIsIt", color: "#111827", sizePercent: 12 }],
    ["logo", { kind: "logo", widthPercent: 25 }],
  ])("accepts the %s watermark branch", (_case, watermark) => {
    expect(
      imageWatermarkSpecSchema.safeParse({ ...baseImageWatermarkSpec, watermark }).success,
    ).toBe(true);
  });

  it("accepts bounded text shadow options without allowing them on logo watermarks", () => {
    const withShadow = imageWatermarkSpecSchema.safeParse({
      ...baseImageWatermarkSpec,
      watermark: {
        ...baseImageWatermarkSpec.watermark,
        shadow: { color: "#000000", blurPercent: 8, offsetPercent: 2 },
      },
    });
    expect(withShadow.success).toBe(true);
    expect(
      imageWatermarkSpecSchema.safeParse({
        ...baseImageWatermarkSpec,
        watermark: {
          kind: "logo",
          widthPercent: 20,
          shadow: { color: "#000000", blurPercent: 8, offsetPercent: 2 },
        },
      }).success,
    ).toBe(false);
    expect(
      imageWatermarkSpecSchema.safeParse({
        ...baseImageWatermarkSpec,
        watermark: {
          ...baseImageWatermarkSpec.watermark,
          shadow: { color: "#000000", blurPercent: 21, offsetPercent: 2 },
        },
      }).success,
    ).toBe(false);
  });

  it("accepts text at the 80-code-point ceiling", () => {
    expect(
      imageWatermarkSpecSchema.safeParse({
        ...baseImageWatermarkSpec,
        watermark: { ...baseImageWatermarkSpec.watermark, text: "🙂".repeat(80) },
      }).success,
    ).toBe(true);
  });

  it("rejects text that exceeds 80 code points after NFC normalization", () => {
    const expandingText = "\u0344".repeat(80);

    expect(Array.from(expandingText).length).toBe(80);
    expect(Array.from(expandingText.normalize("NFC")).length).toBe(160);
    expect(
      imageWatermarkSpecSchema.safeParse({
        ...baseImageWatermarkSpec,
        watermark: { ...baseImageWatermarkSpec.watermark, text: expandingText },
      }).success,
    ).toBe(false);
  });

  it.each([
    ["C1 next-line control", "\u0085"],
    ["Unicode line separator", "\u2028"],
    ["Unicode paragraph separator", "\u2029"],
  ])("rejects %s in image watermark text", (_case, separator) => {
    const text = `Here${separator}IsIt`;

    expect(
      imageWatermarkSpecSchema.safeParse({
        ...baseImageWatermarkSpec,
        watermark: { ...baseImageWatermarkSpec.watermark, text },
      }).success,
    ).toBe(false);
  });

  it.each([
    ["source", { format: "source", quality: 90 }],
    ["JPEG", { format: "jpeg", quality: 90, matte: "#ffffff" }],
    ["WebP", { format: "webp", quality: 90 }],
    ["PNG", { format: "png" }],
  ])("accepts the %s output branch", (_case, output) => {
    expect(imageWatermarkSpecSchema.safeParse({ ...baseImageWatermarkSpec, output }).success).toBe(
      true,
    );
  });

  it.each([0, 2])("rejects version %s", (version) => {
    expect(imageWatermarkSpecSchema.safeParse({ ...baseImageWatermarkSpec, version }).success).toBe(
      false,
    );
  });

  it.each([
    ["empty text", ""],
    ["81-code-point text", "🙂".repeat(81)],
    ["newlines", "Here\nIsIt"],
    ["bidirectional override characters", "Here\u202eIsIt"],
  ])("rejects %s", (_case, text) => {
    expect(
      imageWatermarkSpecSchema.safeParse({
        ...baseImageWatermarkSpec,
        watermark: { ...baseImageWatermarkSpec.watermark, text },
      }).success,
    ).toBe(false);
  });

  it.each(["#fff", "111827", "#gggggg"])("rejects invalid text color %s", (color) => {
    expect(
      imageWatermarkSpecSchema.safeParse({
        ...baseImageWatermarkSpec,
        watermark: { ...baseImageWatermarkSpec.watermark, color },
      }).success,
    ).toBe(false);
  });

  it.each([3, 31])("rejects text size %s", (sizePercent) => {
    expect(
      imageWatermarkSpecSchema.safeParse({
        ...baseImageWatermarkSpec,
        watermark: { ...baseImageWatermarkSpec.watermark, sizePercent },
      }).success,
    ).toBe(false);
  });

  it.each([4, 51])("rejects logo width %s", (widthPercent) => {
    expect(
      imageWatermarkSpecSchema.safeParse({
        ...baseImageWatermarkSpec,
        watermark: { kind: "logo", widthPercent },
      }).success,
    ).toBe(false);
  });

  it.each([-1, 11])("rejects margin %s", (marginPercent) => {
    expect(
      imageWatermarkSpecSchema.safeParse({ ...baseImageWatermarkSpec, marginPercent }).success,
    ).toBe(false);
  });

  it.each([0.049, 1.001])("rejects opacity %s", (opacity) => {
    expect(imageWatermarkSpecSchema.safeParse({ ...baseImageWatermarkSpec, opacity }).success).toBe(
      false,
    );
  });

  it.each([39, 96])("rejects output quality %s", (quality) => {
    expect(
      imageWatermarkSpecSchema.safeParse({
        ...baseImageWatermarkSpec,
        output: { format: "source", quality },
      }).success,
    ).toBe(false);
  });

  it("rejects extra output fields", () => {
    expect(
      imageWatermarkSpecSchema.safeParse({
        ...baseImageWatermarkSpec,
        output: { format: "png", quality: 80 },
      }).success,
    ).toBe(false);
  });

  it.each([
    ["caller-controlled orientation", { autoOrient: false }],
    ["caller-controlled metadata", { metadata: "preserve" }],
  ])("rejects %s", (_case, override) => {
    expect(
      imageWatermarkSpecSchema.safeParse({ ...baseImageWatermarkSpec, ...override }).success,
    ).toBe(false);
  });
});
