import type { ImageOptimizeSpecV1 } from "@hereisit/tool-contracts";
import { describe, expect, it } from "vitest";
import type { ImageInspection } from "./inspect";
import { planOptimization } from "./plan";

const balanced: ImageOptimizeSpecV1 = {
  version: 1,
  mode: "smart",
  preset: "balanced",
  output: "same-format",
  metadata: "strip",
  orientation: "apply",
  colorSpace: "srgb",
  minimumSavingsPercent: 1,
};

function inspection(overrides: Partial<ImageInspection>): ImageInspection {
  return {
    format: "jpeg",
    mime: "image/jpeg",
    width: 100,
    height: 100,
    displayedWidth: 100,
    displayedHeight: 100,
    pixels: 10_000,
    bitDepth: 8,
    hasAlpha: false,
    animated: false,
    orientation: 1,
    hasIccProfile: false,
    sourceColorModel: "ycbcr",
    adobeTransform: null,
    iccProfileKind: "none",
    wideGamut: false,
    metadataBytes: 0,
    ...overrides,
  };
}

describe("planOptimization", () => {
  it("uses 4:4:4 for screenshot JPEG and 4:2:0 for photos", () => {
    const screenshot = planOptimization(inspection({}), "screenshot-text", balanced);
    const photo = planOptimization(inspection({}), "photo", balanced);
    expect(screenshot.kind).toBe("plan");
    expect(photo.kind).toBe("plan");
    if (screenshot.kind === "plan" && photo.kind === "plan") {
      expect(screenshot.plan.candidates[0]).toMatchObject({
        codec: "mozjpeg",
        quality: 82,
        chroma: "444",
      });
      expect(photo.plan.candidates[0]).toMatchObject({
        codec: "mozjpeg",
        quality: 82,
        chroma: "420",
      });
    }
  });

  it.each([
    ["balanced", 86],
    ["smallest", 80],
  ] as const)("keeps a 4:4:4 fallback for %s photo JPEGs", (preset, quality) => {
    const result = planOptimization(inspection({}), "photo", { ...balanced, preset });

    expect(result).toMatchObject({
      kind: "plan",
      plan: {
        candidates: [{ chroma: "420" }, { chroma: "420" }, { chroma: "444", quality }],
      },
    });
  });

  it("normalizes trusted CMYK smart inputs and rejects unsafe interpretations", () => {
    expect(
      planOptimization(
        inspection({
          sourceColorModel: "cmyk",
          adobeTransform: 0,
          hasIccProfile: true,
          iccProfileKind: "cmyk",
        }),
        "photo",
        balanced,
      ),
    ).toMatchObject({ kind: "plan", plan: { normalizeColorWithLcms: true } });
    expect(
      planOptimization(
        inspection({ sourceColorModel: "unknown", adobeTransform: null }),
        "photo",
        balanced,
      ),
    ).toEqual({
      kind: "unsupported",
      code: "UNSUPPORTED_FEATURE",
      reason: "UNSAFE_SOURCE_COLOR_MODEL",
    });
  });

  it("keeps 16-bit and wide-gamut PNG on the lossless path", () => {
    const result = planOptimization(
      inspection({
        format: "png",
        mime: "image/png",
        bitDepth: 16,
        sourceColorModel: "rgb",
      }),
      "flat-graphic",
      balanced,
    );
    expect(result).toMatchObject({
      kind: "plan",
      plan: {
        requirePixelExact: true,
        candidates: [{ codec: "oxipng" }],
        warnings: ["SMART_PNG_FELL_BACK_TO_LOSSLESS"],
      },
    });
  });

  it("bounds every format and preset to at most three candidates", () => {
    const formats: ImageInspection[] = [
      inspection({}),
      inspection({ format: "png", mime: "image/png", sourceColorModel: "rgb" }),
      inspection({ format: "webp", mime: "image/webp", sourceColorModel: "rgb" }),
    ];
    for (const source of formats) {
      for (const mode of ["lossless", "smart"] as const) {
        for (const preset of ["balanced", "smallest"] as const) {
          const result = planOptimization(source, "photo", { ...balanced, mode, preset });
          expect(result.kind).toBe("plan");
          if (result.kind === "plan") {
            expect(result.plan.candidates.length).toBeGreaterThanOrEqual(1);
            expect(result.plan.candidates.length).toBeLessThanOrEqual(3);
          }
        }
      }
    }
  });

  it("uses bounded WebP near-lossless candidates for flat smart inputs", () => {
    const result = planOptimization(
      inspection({ format: "webp", mime: "image/webp", sourceColorModel: "rgb" }),
      "flat-graphic",
      { ...balanced, preset: "smallest" },
    );
    expect(result).toMatchObject({
      kind: "plan",
      plan: {
        candidates: [
          { codec: "libwebp", mode: "near-lossless", quality: 60, effort: 5 },
          { codec: "libwebp", mode: "lossy", quality: 72 },
          { codec: "libwebp", mode: "lossy", quality: 66 },
        ],
      },
    });
  });
});
