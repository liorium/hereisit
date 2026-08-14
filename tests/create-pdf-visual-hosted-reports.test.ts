import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluatePdfEngineReleaseGate,
  validatePdfBenchmarkReport,
} from "../scripts/benchmark-pdf-engine.mjs";
import { createPdfVisualHostedReports } from "../scripts/create-pdf-visual-hosted-reports.mjs";
import { canonicalJson, sha256Bytes } from "../scripts/image-lab-common.mjs";

const roots: string[] = [];
const gitSha = "a".repeat(40);
const sourceSha256 = "b".repeat(64);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function publicBenchmark() {
  const report = structuredClone(
    JSON.parse(readFileSync("docs/deployment/pdf-engine-benchmark.json", "utf8")),
  );
  const jpeg = report.records.find(
    (record: { stratum: string }) => record.stratum === "jpeg-heavy",
  );
  for (const sample of jpeg.native.samples) {
    sample.profile = "image-optimized";
    sample.visual = "passed";
  }
  report.summary.visualProfilesMeasured = 3;
  return validatePdfBenchmarkReport(report);
}

function visualEvidence(report: ReturnType<typeof publicBenchmark>) {
  const results = [0, 1, 2].map((repeat) => ({
    repeat,
    sha256: `${repeat + 1}`.repeat(64),
    byteLength: 100 + repeat,
    verified: true,
  }));
  return {
    schema: "hereisit.pdf-browser-visual-evidence@1",
    version: 1,
    passed: true,
    gitSha,
    sourceSha256,
    checkRunId: 42,
    execution: "exact-main-hosted-pdf-visual",
    inputManifestSha256: "c".repeat(64),
    engineImageDigest: report.identity.engineImageDigest,
    corpusManifestSha256: report.identity.corpusManifestSha256,
    stratum: "jpeg-heavy",
    projects: ["chromium", "firefox", "webkit"].map((project) => ({
      project,
      passed: true,
      results,
    })),
    visualProfilesMeasured: 9,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hereisit-pdf-hosted-reports-"));
  roots.push(root);
  const report = publicBenchmark();
  const gate = evaluatePdfEngineReleaseGate(report);
  const paths = {
    report: join(root, "benchmark.json"),
    gate: join(root, "gate.json"),
    visual: join(root, "visual.json"),
    output: join(root, "out"),
  };
  await writeFile(paths.report, canonicalJson(report));
  await writeFile(paths.gate, canonicalJson(gate));
  await writeFile(paths.visual, canonicalJson(visualEvidence(report)));
  return { report, gate, paths };
}

describe("PDF visual hosted report projection", () => {
  it("creates only strict benchmark and device documents bound to the exact hosted run", async () => {
    const { report, gate, paths } = await fixture();

    await createPdfVisualHostedReports({
      benchmarkPath: paths.report,
      gatePath: paths.gate,
      visualEvidencePath: paths.visual,
      output: paths.output,
      gitSha,
      sourceSha256,
      checkRunId: 42,
    });

    const benchmark = JSON.parse(
      await readFile(join(paths.output, "fullCorpusBenchmark.json"), "utf8"),
    );
    const device = JSON.parse(await readFile(join(paths.output, "deviceMatrix.json"), "utf8"));
    expect(benchmark).toMatchObject({
      passed: true,
      gitSha,
      sourceSha256,
      profilesMeasured: 3,
      corpusSha256: report.identity.corpusManifestSha256,
      benchmarkSha256: gate.benchmarkSha256,
      releaseGateSha256: sha256Bytes(canonicalJson(gate)),
      engineImageDigest: report.identity.engineImageDigest,
    });
    expect(device).toMatchObject({
      passed: true,
      projects: [
        "chromium",
        "firefox",
        "mobile-chromium",
        "mobile-firefox",
        "webkit",
        "mobile-webkit",
      ],
      productAnalytics: true,
      pdfVisualProfilesMeasured: 9,
    });
    await expect(readFile(join(paths.output, "privacyReview.json"))).rejects.toThrow();
  });

  it("fails closed when browser evidence or public admission drifts", async () => {
    const { paths } = await fixture();
    const visual = JSON.parse(await readFile(paths.visual, "utf8"));
    visual.engineImageDigest = `sha256:${"f".repeat(64)}`;
    await writeFile(paths.visual, canonicalJson(visual));

    await expect(
      createPdfVisualHostedReports({
        benchmarkPath: paths.report,
        gatePath: paths.gate,
        visualEvidencePath: paths.visual,
        output: paths.output,
        gitSha,
        sourceSha256,
        checkRunId: 42,
      }),
    ).rejects.toThrow(/match|drift|identity/i);
  });
});
