import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateImageQualityReport,
  validateCorpusManifest,
  verifyCorpusFiles,
} from "../scripts/verify-image-quality.mjs";

const passing = {
  version: 1,
  scope: "release",
  identity: {
    engineImageDigest: `sha256:${"a".repeat(64)}`,
    sourceLockSha256: "b".repeat(64),
    corpusManifestSha256: "c".repeat(64),
    metricBuildIds: { ssimulacra2: "libjxl-0.11.2", butteraugli: "libjxl-0.11.2" },
  },
  aggregate: {
    supportedSuccessRate: 0.995,
    severeRegressions: 0,
    maxSsimulacra2Deficit: 1,
    maxButteraugliRegression: 0.1,
    largerSelectedOutputs: 0,
    losslessVerificationMismatches: 0,
    alphaCompositeMismatches: 0,
    mixedMetricBuilds: 0,
    missingAuthorizedCompetitorMeasurements: 0,
    falseNoSizeReductionPassRate: 0.95,
    comparableMedianBaselineRatio: 1,
    warmJpegWebpP95Ms: 2900,
    standardPngP95Ms: 7900,
    ordinaryPeakMemoryBytes: 512 * 1024 * 1024,
    cancellationP95Ms: 1000,
    policyP95Ms: 500,
    localFeedbackP95Ms: 100,
    streamingUpload: true,
    uploadWorkerCpuP95Ms: 100,
    cold12MpP95Ms: 20_000,
    firstNativePhaseP95Ms: 8000,
    inputDeletionP99Ms: 60_000,
    acknowledgedResultDeletionP99Ms: 10_000,
    sweeperResultDeletionP99Ms: 35 * 60_000,
    costPer1000JobsMicrousd: 500_000,
    humanReview: {
      count: 20,
      hereisitOrTieRate: 0.8,
      hereisit: 10,
      baseline: 10,
      severeDefects: 0,
    },
  },
  thresholds: { maxCostPer1000JobsMicrousd: 500_000 },
  strata: [{ id: "jpeg-small-photo-opaque", successfulSamples: 3, passed: true }],
  strategic: [
    {
      tag: "korean-text",
      authorizedSamples: 3,
      humanReviewedSamples: 1,
      medianBaselineRatio: 0.95,
    },
    { tag: "ui", authorizedSamples: 3, humanReviewedSamples: 1, medianBaselineRatio: 0.95 },
    { tag: "code", authorizedSamples: 3, humanReviewedSamples: 1, medianBaselineRatio: 0.95 },
    { tag: "logo", authorizedSamples: 3, humanReviewedSamples: 1, medianBaselineRatio: 0.95 },
    {
      tag: "flat-graphic",
      authorizedSamples: 3,
      humanReviewedSamples: 1,
      medianBaselineRatio: 0.95,
    },
  ],
};

describe("image release quality gates", () => {
  it("passes only when every global, stratum, and strategic gate passes", () => {
    expect(evaluateImageQualityReport(passing)).toEqual({ passed: true, failures: [] });
  });

  it.each([
    ["success", { supportedSuccessRate: 0.989 }],
    ["regression", { severeRegressions: 1 }],
    ["SSIMULACRA2", { maxSsimulacra2Deficit: 1.001 }],
    ["Butteraugli", { maxButteraugliRegression: 0.101 }],
    ["larger output", { largerSelectedOutputs: 1 }],
    ["lossless mismatch", { losslessVerificationMismatches: 1 }],
    ["alpha mismatch", { alphaCompositeMismatches: 1 }],
    ["mixed metrics", { mixedMetricBuilds: 1 }],
    ["missing competitor", { missingAuthorizedCompetitorMeasurements: 1 }],
    ["false no reduction", { falseNoSizeReductionPassRate: 0.899 }],
    ["baseline", { comparableMedianBaselineRatio: 1.051 }],
    ["JPEG/WebP time", { warmJpegWebpP95Ms: 3001 }],
    ["PNG time", { standardPngP95Ms: 8001 }],
    ["memory", { ordinaryPeakMemoryBytes: 512 * 1024 * 1024 + 1 }],
    ["cancellation", { cancellationP95Ms: 1001 }],
    ["policy", { policyP95Ms: 501 }],
    ["feedback", { localFeedbackP95Ms: 101 }],
    ["streaming", { streamingUpload: false }],
    ["upload CPU", { uploadWorkerCpuP95Ms: 101 }],
    ["cold", { cold12MpP95Ms: 20_001 }],
    ["native feedback", { firstNativePhaseP95Ms: 8001 }],
    ["input deletion", { inputDeletionP99Ms: 60_001 }],
    ["ack deletion", { acknowledgedResultDeletionP99Ms: 10_001 }],
    ["sweeper deletion", { sweeperResultDeletionP99Ms: 35 * 60_000 + 1 }],
    ["cost", { costPer1000JobsMicrousd: 500_001 }],
    ["human sample count", { humanReview: { ...passing.aggregate.humanReview, count: 19 } }],
    [
      "human severe defect",
      { humanReview: { ...passing.aggregate.humanReview, severeDefects: 1 } },
    ],
    [
      "human acceptance",
      { humanReview: { ...passing.aggregate.humanReview, hereisitOrTieRate: 0.799 } },
    ],
    [
      "human preference",
      { humanReview: { ...passing.aggregate.humanReview, hereisit: 9, baseline: 10 } },
    ],
  ])("fails independently for %s", (_, aggregate) => {
    const result = evaluateImageQualityReport({
      ...passing,
      aggregate: { ...passing.aggregate, ...aggregate },
    });
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(1);
  });

  it("does not hide a failed stratum or missing strategic coverage", () => {
    expect(
      evaluateImageQualityReport({ ...passing, strata: [{ ...passing.strata[0], passed: false }] })
        .passed,
    ).toBe(false);
    expect(
      evaluateImageQualityReport({ ...passing, strategic: passing.strategic.slice(1) }).passed,
    ).toBe(false);
  });

  it("validates owned manifest hashes, metadata, unique IDs, and strategic fixture counts", () => {
    expect(() => validateCorpusManifest({ version: 1, entries: [] })).toThrow();
  });

  it("binds every committed public corpus byte to the strict manifest", async () => {
    const root = resolve("tests/image-corpus");
    const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
    validateCorpusManifest(manifest);
    await verifyCorpusFiles(manifest, root);
    expect(manifest.entries.length).toBeGreaterThanOrEqual(24);
    for (const entry of manifest.entries) {
      const bytes = await readFile(resolve(root, entry.relativePath));
      expect(createHash("sha256").update(bytes).digest("hex"), entry.id).toBe(entry.sha256);
    }
  });
});
