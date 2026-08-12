import { describe, expect, it } from "vitest";
import {
  evaluatePdfEngineReleaseGate,
  validatePdfBenchmarkReport,
  validatePdfReleaseGate,
} from "../scripts/benchmark-pdf-engine.mjs";
import { REQUIRED_PDF_CORPUS_STRATA } from "../scripts/create-pdf-compression-corpus.mjs";

const sha = (character: string) => character.repeat(64);
const hostile = new Set(["encrypted", "corrupt", "decompression-bomb"]);

function record(stratum: string) {
  const rejected = hostile.has(stratum);
  const sourceBytes = 10_000;
  const localBytes = stratum === "duplicate-resource" ? 9_500 : sourceBytes - 1;
  const nativeBytes = stratum === "duplicate-resource" ? 7_000 : sourceBytes - 1;
  return {
    stratum,
    sourceBytes,
    local: {
      verdict: rejected ? "rejected" : localBytes < sourceBytes ? "reduced" : "original-retained",
      outputBytes: rejected ? null : localBytes,
      ratio: rejected ? null : localBytes / sourceBytes,
      coldMs: rejected ? 0 : 10,
      warmMedianMs: rejected ? 0 : 8,
      peakRssBytes: rejected ? 0 : 10_000_000,
      candidateCount: rejected ? 0 : 1,
      semantic: rejected ? "not-applicable" : "passed",
      visual: "not-required",
    },
    native: {
      verdict: rejected ? "rejected" : nativeBytes < sourceBytes ? "reduced" : "original-retained",
      outputBytes: rejected ? null : nativeBytes,
      ratio: rejected ? null : nativeBytes / sourceBytes,
      coldMs: rejected ? 0 : 12,
      warmMedianMs: rejected ? 0 : 9,
      peakRssBytes: rejected ? 0 : 20_000_000,
      candidateCount: rejected ? 0 : 2,
      semantic: rejected ? "not-applicable" : "passed",
      visual: "not-required",
    },
    smallerOnly: true,
    nativeAdvantageRatio: stratum === "duplicate-resource" ? 0.25 : 0,
  };
}

function passingReport() {
  return {
    schema: "hereisit.pdf-engine-benchmark@1",
    identity: {
      engineImageId: `sha256:${sha("a")}`,
      engineImageDigest: `sha256:${sha("a")}`,
      qpdfVersion: "12.4.0",
      corpusManifestSha256: sha("b"),
      sourceLockSha256: sha("c"),
      localRunner: "pdf-lib-structural@2.7.1",
    },
    limits: {
      repeats: 3,
      maximumSamples: 51,
      maximumWallMs: 300_000,
      maximumSourceBytes: 52_428_800,
      maximumOutputBytes: 52_428_800,
      maximumPeakRssBytes: 805_306_368,
      maximumParserPixels: 20_000_000,
      maximumDiagnosticBytes: 4096,
    },
    records: REQUIRED_PDF_CORPUS_STRATA.map(record),
    summary: {
      strata: REQUIRED_PDF_CORPUS_STRATA.length,
      measuredSamples: 42,
      nativeWins: 1,
      rejectedSafely: 3,
      passed: true,
    },
  };
}

describe("PDF native benchmark release gate", () => {
  it("accepts only complete bounded evidence with a repeatable structured native win", () => {
    const report = validatePdfBenchmarkReport(passingReport());
    const gate = evaluatePdfEngineReleaseGate(report);
    expect(gate.passed).toBe(true);
    expect(gate.failures).toEqual([]);
    expect(validatePdfReleaseGate(gate)).toEqual(gate);
  });

  it.each([
    ["missing stratum", (report: ReturnType<typeof passingReport>) => report.records.pop()],
    [
      "duplicate stratum",
      (report: ReturnType<typeof passingReport>) => report.records.push(report.records[0]),
    ],
    [
      "unknown key",
      (report: ReturnType<typeof passingReport>) => Object.assign(report, { path: "/tmp/a" }),
    ],
    [
      "unsafe number",
      (report: ReturnType<typeof passingReport>) =>
        (report.records[0].native.warmMedianMs = Number.NaN),
    ],
    [
      "path leakage",
      (report: ReturnType<typeof passingReport>) => (report.identity.localRunner = "/home/private"),
    ],
    [
      "URL leakage",
      (report: ReturnType<typeof passingReport>) =>
        (report.identity.localRunner = "https://private"),
    ],
  ])("rejects malformed evidence: %s", (_, mutate) => {
    const report = passingReport();
    mutate(report);
    expect(() => validatePdfBenchmarkReport(report)).toThrow();
  });

  it("fails on expansion, semantic/visual failure, limit escape, unsafe rejection, or no native win", () => {
    const mutations = [
      (report: ReturnType<typeof passingReport>) => {
        report.records[0].native.verdict = "reduced";
        report.records[0].native.outputBytes = 10_001;
        report.records[0].native.ratio = 1.0001;
        report.records[0].smallerOnly = false;
      },
      (report: ReturnType<typeof passingReport>) => (report.records[0].native.semantic = "failed"),
      (report: ReturnType<typeof passingReport>) => (report.records[0].native.visual = "failed"),
      (report: ReturnType<typeof passingReport>) =>
        (report.records[0].native.peakRssBytes = 805_306_369),
      (report: ReturnType<typeof passingReport>) => (report.records[0].native.peakRssBytes = 0),
      (report: ReturnType<typeof passingReport>) => {
        const native = report.records[report.records.length - 1].native;
        native.verdict = "reduced";
        native.outputBytes = 9_000;
        native.ratio = 0.9;
        native.semantic = "passed";
      },
      (report: ReturnType<typeof passingReport>) => {
        for (const item of report.records) item.nativeAdvantageRatio = 0;
      },
    ];
    for (const mutate of mutations) {
      const report = passingReport();
      mutate(report);
      const gate = evaluatePdfEngineReleaseGate(validatePdfBenchmarkReport(report));
      expect(gate.passed).toBe(false);
      expect(validatePdfReleaseGate(gate)).toEqual(gate);
    }
  });
});
