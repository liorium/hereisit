import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  evaluatePdfEngineReleaseGate,
  fetchBeforeDeadline,
  readBoundedPdfResponse,
  runBenchmarkRepeats,
  validatePdfBenchmarkReport,
  validatePdfEvidenceSchemas,
  validatePdfReleaseGate,
  validatePdfVisualInputManifest,
  validatePdfVisualInputSchema,
  writePdfVisualInputBundle,
} from "../scripts/benchmark-pdf-engine.mjs";
import { REQUIRED_PDF_CORPUS_STRATA } from "../scripts/create-pdf-compression-corpus.mjs";

const sha = (character: string) => character.repeat(64);
const hostile = new Set(["encrypted", "corrupt", "decompression-bomb"]);

function pdfBytes(label: string, padding = 0) {
  return Buffer.from(`%PDF-1.7\n%${label}\n${"x".repeat(padding)}\n%%EOF\n`);
}

function visualInputManifest() {
  const source = pdfBytes("source", 200);
  return {
    schema: "hereisit.pdf-browser-visual-input@1",
    version: 1,
    engineImageDigest: `sha256:${sha("a")}`,
    corpusManifestSha256: sha("b"),
    stratum: "jpeg-heavy",
    source: {
      artifact: "source.pdf",
      sha256: createHash("sha256").update(source).digest("hex"),
      byteLength: source.byteLength,
      pageCount: 1,
    },
    results: [0, 1, 2].map((repeat) => {
      const bytes = pdfBytes(`result-${repeat}`);
      return {
        repeat,
        artifact: `result-${repeat}.pdf`,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.byteLength,
        profile: "image-optimized",
        semantic: "passed",
        visual: "passed",
      };
    }),
  };
}

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
        ? runner === "native"
          ? "INPUT_LIMIT_EXCEEDED"
          : "INFLATED_LIMIT_EXCEEDED"
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

  it("pairs native and local samples by canonical repeat number, not array position", () => {
    const report = passingReport();
    report.records[7].native.samples.reverse();
    expect(() => validatePdfBenchmarkReport(report)).toThrow(/repeat order/i);
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
    ["derived pass true", (r: ReturnType<typeof passingReport>) => (r.summary.passed = false)],
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
    [
      "visual-only semantic value",
      (r: ReturnType<typeof passingReport>) =>
        (r.records[0].native.samples[0].semantic = "not-required"),
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
    "ENGINE_CRASH",
    "ENGINE_TIMEOUT",
    "ENGINE_OOM",
  ])("does not count a decompression bomb %s as a safe native admission rejection", (code) => {
    const report = passingReport();
    const bomb = report.records.at(-1);
    const sample = bomb?.native.samples[0];
    if (sample === undefined) throw new Error("fixture bomb sample is missing");
    sample.code = code;
    report.summary.passed = false;
    expect(evaluatePdfEngineReleaseGate(validatePdfBenchmarkReport(report)).failures).toContain(
      "decompression-bomb:native:UNSAFE_REJECTION_CODE",
    );
  });

  it("requires measured native resources for decompression-bomb admission", () => {
    const report = passingReport();
    const bomb = report.records.at(-1);
    const sample = bomb?.native.samples[0];
    if (bomb === undefined || sample === undefined)
      throw new Error("fixture bomb sample is missing");
    sample.peakRssBytes = 0;
    bomb.native.maximumPeakRssBytes = 10_000_002;
    report.summary.passed = false;
    expect(evaluatePdfEngineReleaseGate(validatePdfBenchmarkReport(report)).failures).toContain(
      "decompression-bomb:native:RSS_NOT_MEASURED",
    );
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

  it("shares one outer deadline across repeats and never starts a repeat after exhaustion", async () => {
    const started = Date.now();
    const attempts: number[] = [];
    const hanging = (_input, init) =>
      new Promise((_resolve, reject) =>
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }),
      );
    await expect(
      runBenchmarkRepeats({
        deadline: started + 20,
        operation: async (repeat, deadline) => {
          attempts.push(repeat);
          if (repeat === 0) return repeat;
          return fetchBeforeDeadline("http://engine.invalid", {}, deadline, hanging);
        },
      }),
    ).rejects.toThrow();
    expect(attempts).toEqual([0, 1]);
    expect(Date.now() - started).toBeLessThan(200);
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

  it.each([
    "empty required",
    "open objects",
    "wrong bound",
  ])("rejects a weakened benchmark schema: %s", async (mutation) => {
    const report = passingReport();
    const benchmarkSchema = JSON.parse(
      await readFile("docs/deployment/pdf-engine-benchmark.schema.json", "utf8"),
    );
    const gateSchema = JSON.parse(
      await readFile("docs/deployment/pdf-engine-release-gate.schema.json", "utf8"),
    );
    if (mutation === "empty required") benchmarkSchema.required = [];
    else if (mutation === "open objects") benchmarkSchema.additionalProperties = true;
    else benchmarkSchema.$defs.sample.properties.repeat.maximum = 3;
    await expect(
      validatePdfEvidenceSchemas({
        report,
        gate: evaluatePdfEngineReleaseGate(report),
        benchmarkSchema,
        gateSchema,
      }),
    ).rejects.toThrow();
  });

  it("rejects evidence that violates a checked-in schema even if vocabulary fields are intact", async () => {
    const report = passingReport();
    Object.assign(report.records[0].native.samples[0], { durationMs: "8" });
    const benchmarkSchema = JSON.parse(
      await readFile("docs/deployment/pdf-engine-benchmark.schema.json", "utf8"),
    );
    const gateSchema = JSON.parse(
      await readFile("docs/deployment/pdf-engine-release-gate.schema.json", "utf8"),
    );
    await expect(
      validatePdfEvidenceSchemas({
        report,
        gate: evaluatePdfEngineReleaseGate(passingReport()),
        benchmarkSchema,
        gateSchema,
      }),
    ).rejects.toThrow();
  });

  it("binds one exact image ID and digest throughout report and gate", () => {
    const report = passingReport();
    report.identity.engineImageDigest = `sha256:${sha("d")}`;
    expect(() => validatePdfBenchmarkReport(report)).toThrow(/image identity/i);
    const valid = passingReport();
    const gate = evaluatePdfEngineReleaseGate(valid);
    gate.engineImageDigest = `sha256:${sha("d")}`;
    expect(() => validatePdfReleaseGate(gate, valid)).toThrow(/image/i);
  });
});

describe("private PDF browser visual inputs", () => {
  it("accepts only three canonical image-optimized repeats bound to one engine and corpus", async () => {
    const manifest = visualInputManifest();
    expect(validatePdfVisualInputManifest(manifest)).toEqual(manifest);
    await expect(
      validatePdfVisualInputSchema(
        manifest,
        JSON.parse(await readFile("docs/deployment/pdf-visual-input.schema.json", "utf8")),
      ),
    ).resolves.toBeUndefined();

    for (const mutate of [
      (value: ReturnType<typeof visualInputManifest>) => value.results.pop(),
      (value: ReturnType<typeof visualInputManifest>) => (value.results[2].repeat = 1),
      (value: ReturnType<typeof visualInputManifest>) => (value.results[0].profile = "structural"),
      (value: ReturnType<typeof visualInputManifest>) =>
        (value.results[0].artifact = "/tmp/result.pdf"),
      (value: ReturnType<typeof visualInputManifest>) =>
        Object.assign(value.results[0], { diagnostic: "private" }),
    ]) {
      const changed = visualInputManifest();
      mutate(changed);
      expect(() => validatePdfVisualInputManifest(changed)).toThrow();
    }
  });

  it("writes one private source and three verified results and refuses overwrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "hereisit-pdf-visual-test-"));
    const output = join(root, "bundle");
    const source = pdfBytes("source", 200);
    const results = [0, 1, 2].map((repeat) => ({
      repeat,
      output: pdfBytes(`result-${repeat}`),
      verdict: "reduced",
      profile: "image-optimized",
      semantic: "passed",
      visual: "passed",
    }));
    try {
      const manifest = await writePdfVisualInputBundle({
        output,
        engineImageDigest: `sha256:${sha("a")}`,
        corpusManifestSha256: sha("b"),
        stratum: "jpeg-heavy",
        source,
        pageCount: 1,
        results,
      });
      expect(validatePdfVisualInputManifest(manifest)).toEqual(manifest);
      expect((await readdir(output)).toSorted()).toEqual([
        "manifest.json",
        "result-0.pdf",
        "result-1.pdf",
        "result-2.pdf",
        "source.pdf",
      ]);
      await expect(
        writePdfVisualInputBundle({
          output,
          engineImageDigest: `sha256:${sha("a")}`,
          corpusManifestSha256: sha("b"),
          stratum: "jpeg-heavy",
          source,
          pageCount: 1,
          results,
        }),
      ).rejects.toThrow();
      expect((await readdir(output)).toSorted()).toHaveLength(5);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes a partial bundle when any result is not verified image-optimized output", async () => {
    const root = await mkdtemp(join(tmpdir(), "hereisit-pdf-visual-test-"));
    const output = join(root, "bundle");
    try {
      await expect(
        writePdfVisualInputBundle({
          output,
          engineImageDigest: `sha256:${sha("a")}`,
          corpusManifestSha256: sha("b"),
          stratum: "jpeg-heavy",
          source: pdfBytes("source", 200),
          pageCount: 1,
          results: [0, 1, 2].map((repeat) => ({
            repeat,
            output: pdfBytes(`result-${repeat}`),
            verdict: "reduced",
            profile: repeat === 2 ? "structural" : "image-optimized",
            semantic: "passed",
            visual: "passed",
          })),
        }),
      ).rejects.toThrow();
      await expect(readdir(output)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
