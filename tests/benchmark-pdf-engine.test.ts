import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  evaluatePdfEngineReleaseGate,
  fetchBeforeDeadline,
  readBoundedPdfResponse,
  validatePdfBenchmarkReport,
  validatePdfEvidenceSchemas,
  validatePdfReleaseGate,
} from "../scripts/benchmark-pdf-engine.mjs";
import { REQUIRED_PDF_CORPUS_STRATA } from "../scripts/create-pdf-compression-corpus.mjs";

const sha = (character: string) => character.repeat(64);
const hostile = new Set(["encrypted", "corrupt", "decompression-bomb"]);

function sample(stratum: string, runner: "local" | "native", repeat: number) {
  const rejected = hostile.has(stratum);
  const winningStratum = stratum === "duplicate-resource";
  const win = winningStratum && runner === "native" && repeat < 2;
  const effectiveBytes = rejected ? null : win ? 7_000 : 9_500;
  return {
    repeat,
    verdict: rejected
      ? "rejected"
      : (effectiveBytes ?? 10_000) < 10_000
        ? "reduced"
        : "original-retained",
    effectiveBytes,
    durationMs: 8 + repeat,
    peakRssBytes: 10_000_000 + repeat,
    candidateCount: rejected ? 0 : runner === "native" ? 2 : 1,
    code: rejected
      ? stratum === "decompression-bomb"
        ? "INFLATED_LIMIT_EXCEEDED"
        : "UNSUPPORTED_INPUT"
      : null,
    profile: rejected || runner === "local" ? null : "structural",
    semantic: rejected ? "not-applicable" : "passed",
    visual: rejected ? "not-applicable" : "not-required",
  };
}

function record(stratum: string) {
  const localSamples = [0, 1, 2].map((repeat) => sample(stratum, "local", repeat));
  const nativeSamples = [0, 1, 2].map((repeat) => sample(stratum, "native", repeat));
  const win = stratum === "duplicate-resource";
  return {
    stratum,
    sourceBytes: 10_000,
    local: {
      samples: localSamples,
      medianEffectiveBytes: hostile.has(stratum) ? null : 9_500,
      medianDurationMs: 9,
      maximumPeakRssBytes: 10_000_002,
      maximumCandidateCount: hostile.has(stratum) ? 0 : 1,
    },
    native: {
      samples: nativeSamples,
      medianEffectiveBytes: hostile.has(stratum) ? null : win ? 7_000 : 9_500,
      medianDurationMs: 9,
      maximumPeakRssBytes: 10_000_002,
      maximumCandidateCount: hostile.has(stratum) ? 0 : 2,
    },
    smallerOnly: true,
    repeatableNativeWins: win ? 2 : 0,
    nativeAdvantageRatio: win ? 0.25 : 0,
  };
}

function passingReport() {
  return {
    schema: "hereisit.pdf-engine-benchmark@2",
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
      strata: 17,
      measuredSamples: 51,
      nativeWins: 1,
      rejectedSafely: 3,
      maximumPeakRssBytes: 10_000_002,
      visualProfilesMeasured: 0,
      passed: true,
    },
  };
}

describe("PDF native benchmark release gate", () => {
  it("accepts only complete evidence derived from all three repeats", () => {
    const report = validatePdfBenchmarkReport(passingReport());
    expect(evaluatePdfEngineReleaseGate(report)).toMatchObject({
      passed: true,
      failures: [],
      visualProfilesMeasured: 0,
      publicAdmissionReady: false,
    });
  });

  it.each([
    [
      "derived bytes",
      (r: ReturnType<typeof passingReport>) => (r.records[0].native.medianEffectiveBytes = 1),
    ],
    [
      "derived smaller-only",
      (r: ReturnType<typeof passingReport>) => (r.records[0].smallerOnly = false),
    ],
    [
      "derived repeat wins",
      (r: ReturnType<typeof passingReport>) => (r.records[7].repeatableNativeWins = 3),
    ],
    [
      "derived advantage",
      (r: ReturnType<typeof passingReport>) => (r.records[7].nativeAdvantageRatio = 0.9),
    ],
    ["derived summary", (r: ReturnType<typeof passingReport>) => (r.summary.nativeWins = 2)],
    [
      "derived maximum",
      (r: ReturnType<typeof passingReport>) => (r.summary.maximumPeakRssBytes = 3),
    ],
    [
      "derived visual coverage",
      (r: ReturnType<typeof passingReport>) => (r.summary.visualProfilesMeasured = 1),
    ],
    ["missing repeat", (r: ReturnType<typeof passingReport>) => r.records[0].native.samples.pop()],
    [
      "duplicate repeat",
      (r: ReturnType<typeof passingReport>) => (r.records[0].native.samples[2].repeat = 1),
    ],
    [
      "unknown sample key",
      (r: ReturnType<typeof passingReport>) =>
        Object.assign(r.records[0].native.samples[0], { path: "/tmp/x" }),
    ],
  ])("rejects tampered evidence: %s", (_, mutate) => {
    const report = passingReport();
    mutate(report);
    expect(() => validatePdfBenchmarkReport(report)).toThrow();
  });

  it("requires at least two repeat wins and a threshold-sized median advantage", () => {
    const report = passingReport();
    const winning = report.records.find((item) => item.stratum === "duplicate-resource");
    expect(winning).toBeDefined();
    if (winning === undefined) throw new Error("winning record is missing");
    winning.native.samples[1].effectiveBytes = 9_500;
    winning.native.medianEffectiveBytes = 9_500;
    winning.repeatableNativeWins = 1;
    winning.nativeAdvantageRatio = 0;
    report.summary.nativeWins = 0;
    report.summary.passed = false;
    expect(evaluatePdfEngineReleaseGate(validatePdfBenchmarkReport(report)).passed).toBe(false);
  });

  it.each([
    undefined,
    "",
    "x",
    "52428801",
  ])("rejects missing, noncanonical, or oversized Content-Length: %s", async (length) => {
    const headers = length === undefined ? {} : { "content-length": length };
    await expect(
      readBoundedPdfResponse(new Response(new Uint8Array([1]), { headers })),
    ).rejects.toThrow();
  });

  it("aborts and cancels a response stream that overruns the declared bounded length", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(6));
      },
      cancel,
    });
    await expect(
      readBoundedPdfResponse(new Response(body, { headers: { "content-length": "5" } })),
    ).rejects.toThrow();
    expect(cancel).toHaveBeenCalled();
  });

  it("aborts a hanging fetch at the remaining job deadline", async () => {
    const hanging = vi.fn(
      (_input, init) =>
        new Promise((_resolve, reject) =>
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }),
        ),
    );
    await expect(
      fetchBeforeDeadline("http://engine.invalid", {}, Date.now() + 10, hanging),
    ).rejects.toThrow();
    expect(hanging.mock.calls[0]?.[1]?.signal.aborted).toBe(true);
  });

  it("keeps checked-in schemas and parser vocabularies identical", async () => {
    const report = passingReport();
    const gate = evaluatePdfEngineReleaseGate(validatePdfBenchmarkReport(report));
    await expect(
      validatePdfEvidenceSchemas({
        report,
        gate,
        benchmarkSchema: JSON.parse(
          await readFile("docs/deployment/pdf-engine-benchmark.schema.json", "utf8"),
        ),
        gateSchema: JSON.parse(
          await readFile("docs/deployment/pdf-engine-release-gate.schema.json", "utf8"),
        ),
      }),
    ).resolves.toBeUndefined();
    expect(validatePdfReleaseGate(gate)).toEqual(gate);
  });
});
