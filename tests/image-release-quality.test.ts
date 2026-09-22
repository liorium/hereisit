import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Bytes } from "../scripts/image-lab-common.mjs";
import { evaluateNativeImageReleaseReport } from "../scripts/verify-image-quality.mjs";
import { bytes, fixture, manifest } from "./fixtures/image-release-quality-fixture";

function evaluate(report = fixture()) {
  return evaluateNativeImageReleaseReport(report, manifest, sha256Bytes(bytes));
}

describe("full native image release measurements", () => {
  it("verifies full native records through the hosted workflow CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "image-release-quality-"));
    try {
      const path = join(root, "report.json");
      await writeFile(path, JSON.stringify(fixture()));
      const result = execFileSync(
        process.execPath,
        [
          "scripts/verify-image-quality.mjs",
          "--report",
          path,
          "--scope",
          "native-release",
          "--manifest",
          "tests/image-corpus/manifest.json",
        ],
        { encoding: "utf8" },
      );
      expect(JSON.parse(result)).toMatchObject({ passed: true, profilesMeasured: 117 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("accepts all measured profiles without inventing competitor or public cost evidence", () => {
    expect(evaluate()).toMatchObject({ passed: true, failures: [], profilesMeasured: 117 });
  });
  it("requires the planner's safe unsupported-feature rejection, never a crash", () => {
    for (const errorCode of ["UNSUPPORTED_INPUT", "ENGINE_CRASH", null]) {
      const report = fixture();
      const unsupported = report.records.find((record) => record.errorCode !== null);
      if (!unsupported) throw new Error("missing unsupported fixture");
      unsupported.errorCode = errorCode;
      expect(evaluate(report).failures).toContain("UNSAFE_UNSUPPORTED_INPUT");
    }
  });
  it("does not hide an engine crash inside the supported success-rate tolerance", () => {
    const report = fixture();
    Object.assign(report.records[0], {
      outcome: "rejected",
      outputMime: null,
      outputBytes: null,
      effectiveDeliveredBytes: null,
      errorCode: "ENGINE_CRASH",
    });
    expect(evaluate(report).failures).toContain("NATIVE_ENGINE_CRASH");
  });
  it("rejects reduced, missing, duplicate and foreign corpus measurements", () => {
    for (const mutate of [
      (r: ReturnType<typeof fixture>) => {
        r.scope = "pr";
      },
      (r: ReturnType<typeof fixture>) => {
        r.records.pop();
      },
      (r: ReturnType<typeof fixture>) => {
        r.records[1] = r.records[0];
      },
      (r: ReturnType<typeof fixture>) => {
        r.identity.corpusManifestSha256 = "f".repeat(64);
      },
    ]) {
      const report = fixture();
      mutate(report);
      expect(() => evaluate(report)).toThrow();
    }
  });
  it.each([
    { qualityChecksPassed: false },
    { alphaChecksPassed: false },
    { deletionVerified: false },
    { ssimulacra2: null },
    { butteraugli: Number.NaN },
    { inputDeletionLagMs: 60_001 },
    { resultDeletionLagMs: 10_001 },
    { processingMs: -1 },
    { peakMemoryBytes: 0 },
  ])("rejects unmeasured or failed automatic checks", (change) => {
    const report = fixture();
    Object.assign(report.records[0], change);
    expect(evaluate(report).passed).toBe(false);
  });
  it("rejects a release that never delivers compressed files", () => {
    const report = fixture();
    for (const record of report.records)
      if (record.outcome === "download")
        Object.assign(record, {
          outcome: "original-retained",
          outputMime: null,
          outputBytes: null,
          effectiveDeliveredBytes: 1000,
        });
    expect(evaluate(report).passed).toBe(false);
  });
  it("keeps the reproduced false-original-retained regression from hiding behind other downloads", () => {
    const report = fixture();
    for (const record of report.records)
      if (record.corpusId === "photo-ordinary-jpeg" && record.mode === "smart") {
        Object.assign(record, {
          outcome: "original-retained",
          outputBytes: null,
          outputMime: null,
          effectiveDeliveredBytes: record.inputBytes,
        });
      }
    expect(evaluate(report).failures).toContain("FALSE_NO_SIZE_REDUCTION");
  });
});
