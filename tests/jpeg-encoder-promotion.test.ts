import { describe, expect, it } from "vitest";
import {
  benchmarkJpegEncoders,
  evaluateJpegliPromotion,
  productionJpegEncoder,
  promotionReport,
  runtimeInventory,
} from "../scripts/benchmark-jpeg-encoders.mjs";

describe("JPEG encoder promotion gate", () => {
  it("keeps benchmark-only jpegli out of the production runtime", () => {
    expect(productionJpegEncoder).toBe("mozjpeg");
    expect(runtimeInventory).not.toContain("jpegli");
    expect(promotionReport.candidate).toBe("jpegli");
    expect(promotionReport.patentReview).toBe("not-approved");
    expect(evaluateJpegliPromotion(promotionReport)).toBe(false);
  });

  it("requires written patent review, a complete corpus, and every release threshold", () => {
    const otherwisePassing = {
      ...promotionReport,
      patentReview: "approved",
      corpusComplete: true,
      thresholds: {
        qualityPassed: true,
        sizePassed: true,
        latencyPassed: true,
        memoryPassed: true,
      },
    };
    expect(evaluateJpegliPromotion(otherwisePassing)).toBe(true);
    expect(evaluateJpegliPromotion({ ...otherwisePassing, corpusComplete: false })).toBe(false);
    expect(
      evaluateJpegliPromotion({
        ...otherwisePassing,
        thresholds: { ...otherwisePassing.thresholds, qualityPassed: false },
      }),
    ).toBe(false);
  });

  it("benchmarks MozJPEG and jpegli over the same authorized corpus without reporting paths", async () => {
    const calls: unknown[] = [];
    const report = await benchmarkJpegEncoders({
      corpus: {
        authorization: "hereisit-benchmark-v1",
        items: [{ inputPath: "/private/photo.ppm", sha256: "a".repeat(64) }],
      },
      run: async (input) => {
        calls.push(input);
        return {
          byteLength: input.encoder === "mozjpeg" ? 8_000 : 7_500,
          encodeMs: input.encoder === "mozjpeg" ? 10 : 12,
          outputSha256: (input.encoder === "mozjpeg" ? "b" : "c").repeat(64),
        };
      },
    });
    expect(calls).toEqual([
      { encoder: "mozjpeg", inputPath: "/private/photo.ppm", quality: 82 },
      { encoder: "jpegli", inputPath: "/private/photo.ppm", quality: 82 },
    ]);
    expect(JSON.stringify(report)).not.toContain("/private/");
    expect(report.results).toHaveLength(1);
    expect(report.corpusComplete).toBe(true);
  });
});
