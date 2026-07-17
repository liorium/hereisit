import { describe, expect, it, vi } from "vitest";
import { BoundedCommandError } from "../codecs/command";
import type { CodecCandidate } from "../codecs/jpeg";
import { isSmartPngEligible } from "../codecs/png";
import type { ImageInspection } from "./inspect";
import {
  OptimizationExecutionError,
  optimizeCandidates,
  RecoverableCandidateError,
} from "./optimize";
import type { OptimizationCandidatePlan, OptimizationPlan } from "./plan";

function inspection(overrides: Partial<ImageInspection> = {}): ImageInspection {
  return {
    format: "png",
    mime: "image/png",
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
    sourceColorModel: "rgb",
    adobeTransform: null,
    iccProfileKind: "none",
    wideGamut: false,
    metadataBytes: 0,
    ...overrides,
  };
}

const candidates: OptimizationCandidatePlan[] = [
  {
    id: "png-quant-255-o3",
    codec: "quantizr-oxipng",
    mode: "quantized-255",
    quality: 255,
    effort: 3,
  },
  {
    id: "png-quant-128-o3",
    codec: "quantizr-oxipng",
    mode: "quantized-128",
    quality: 128,
    effort: 3,
  },
  { id: "png-lossless-o3", codec: "oxipng", mode: "lossless", effort: 3 },
];
const plan: OptimizationPlan = {
  contentClass: "screenshot-text",
  candidates: candidates as [
    OptimizationCandidatePlan,
    OptimizationCandidatePlan,
    OptimizationCandidatePlan,
  ],
  normalizeColorWithLcms: false,
  requirePixelExact: false,
  requireAlphaExact: true,
  minimumSavingsPercent: 1,
  warnings: [],
};

function encoded(candidate: OptimizationCandidatePlan, bytes: number): CodecCandidate {
  return {
    id: candidate.id,
    path: `/work/${candidate.id}.png`,
    mime: "image/png",
    byteLength: bytes,
    encodeMs: 1,
    codecBuildId: "test",
    mode: candidate.mode,
  };
}

describe("smart PNG eligibility", () => {
  it("allows static 8-bit sRGB RGB and alpha PNGs", () => {
    expect(isSmartPngEligible(inspection())).toBe(true);
    expect(isSmartPngEligible(inspection({ hasAlpha: true }))).toBe(true);
  });

  it.each([
    { bitDepth: 16 as const },
    { wideGamut: true, hasIccProfile: true, iccProfileKind: "other" as const },
    { animated: true },
    { format: "webp" as const, mime: "image/webp" as const },
  ])("rejects unsafe smart input %#", (overrides) => {
    expect(isSmartPngEligible(inspection(overrides))).toBe(false);
  });
});

describe("PNG candidate selection", () => {
  it("tests 255 then 128 then lossless and discards failed live quality", async () => {
    const encode = vi.fn(async (candidate: OptimizationCandidatePlan, index: number) =>
      encoded(candidate, [8_500, 6_800, 9_000][index] as number),
    );
    const verify = vi
      .fn()
      .mockResolvedValueOnce({
        accepted: false,
        sizeTargetPassed: false,
        qualityMarginPassed: false,
      })
      .mockResolvedValueOnce({
        accepted: false,
        sizeTargetPassed: true,
        qualityMarginPassed: false,
      })
      .mockResolvedValueOnce({ accepted: true, sizeTargetPassed: true, qualityMarginPassed: true });
    await expect(
      optimizeCandidates({ plan, encode, verify, signal: new AbortController().signal }),
    ).resolves.toMatchObject({
      selected: { id: "png-lossless-o3" },
      testedCandidates: 3,
      warnings: ["SMART_PNG_FELL_BACK_TO_LOSSLESS"],
    });
    expect(encode.mock.calls.map(([candidate]) => candidate.id)).toEqual(
      candidates.map((candidate) => candidate.id),
    );
  });

  it("stops after the 255-color candidate passes size and quality margins", async () => {
    const encode = vi.fn(async (candidate: OptimizationCandidatePlan) => encoded(candidate, 6_000));
    const verify = vi.fn(async () => ({
      accepted: true,
      sizeTargetPassed: true,
      qualityMarginPassed: true,
    }));
    await expect(
      optimizeCandidates({ plan, encode, verify, signal: new AbortController().signal }),
    ).resolves.toMatchObject({ selected: { id: "png-quant-255-o3" }, testedCandidates: 1 });
  });

  it("returns an accepted first candidate when the second codec times out", async () => {
    const first = encoded(candidates[0] as OptimizationCandidatePlan, 7_000);
    const encode = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new BoundedCommandError("timeout"));
    await expect(
      optimizeCandidates({
        plan,
        encode,
        verify: vi.fn(async () => ({
          accepted: true,
          sizeTargetPassed: false,
          qualityMarginPassed: true,
        })),
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ selected: first, testedCandidates: 2, warnings: [] });
  });

  it("discards a changed alpha plane and continues to the exact lossless candidate", async () => {
    const encode = vi.fn(async (candidate: OptimizationCandidatePlan) => {
      if (candidate.codec === "quantizr-oxipng") {
        throw new RecoverableCandidateError("alpha-mismatch");
      }
      return encoded(candidate, 9_000);
    });
    await expect(
      optimizeCandidates({
        plan,
        encode,
        verify: vi.fn(async () => ({
          accepted: true,
          sizeTargetPassed: true,
          qualityMarginPassed: true,
        })),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      selected: { id: "png-lossless-o3" },
      testedCandidates: 3,
      warnings: ["SMART_PNG_FELL_BACK_TO_LOSSLESS"],
    });
  });

  it("maps a first-candidate timeout to balanced-preset guidance", async () => {
    await expect(
      optimizeCandidates({
        plan,
        encode: vi.fn(async () => {
          throw new BoundedCommandError("timeout");
        }),
        verify: vi.fn(),
        signal: new AbortController().signal,
      }),
    ).rejects.toEqual(
      new OptimizationExecutionError("ENGINE_TIMEOUT", false, "TRY_BALANCED_PRESET"),
    );
  });
});
