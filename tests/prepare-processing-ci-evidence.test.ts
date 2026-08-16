import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Canonical } from "../scripts/image-lab-common.mjs";
import * as ciEvidenceModule from "../scripts/prepare-processing-ci-evidence.mjs";
import { prepareProcessingCiEvidence } from "../scripts/prepare-processing-ci-evidence.mjs";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true }))));

describe("CI release evidence", () => {
  it("accepts only exact hosted-main check receipts bound to the source SHA", () => {
    const candidate = (ciEvidenceModule as Record<string, unknown>).validateHostedReviewReceipt;
    expect(typeof candidate).toBe("function");
    const validate = candidate as (
      value: unknown,
      input: { name: string; gitSha: string; sourceSha256: string },
    ) => unknown;
    const input = {
      name: "deviceMatrix",
      gitSha: "a".repeat(40),
      sourceSha256: "b".repeat(64),
    };
    const value = {
      schema: "hereisit-processing-hosted-review@1",
      version: 1,
      reportName: input.name,
      passed: true,
      gitSha: input.gitSha,
      sourceSha256: input.sourceSha256,
      checkRunId: 42,
      document: {
        schema: "hereisit-device-matrix-review@1",
        version: 1,
        passed: true,
        gitSha: input.gitSha,
        sourceSha256: input.sourceSha256,
        checkRunId: 42,
        execution: "exact-main-hosted-check",
        projects: [
          "chromium",
          "firefox",
          "mobile-chromium",
          "mobile-firefox",
          "webkit",
          "mobile-webkit",
        ],
        productAnalytics: true,
        pdfVisualEvidenceSha256: "c".repeat(64),
        pdfVisualProfilesMeasured: 9,
      },
    };
    expect(validate(value, input)).toEqual(value.document);
    for (const drift of [
      { ...value, sourceSha256: "c".repeat(64) },
      { ...value, passed: false },
      { ...value, reportName: "privacyReview" },
      { ...value, extra: true },
    ]) {
      expect(() => validate(drift, input)).toThrow(/hosted|review|source|field|pass/i);
    }
  });
  it("fails closed without protected reviewed evidence", async () => {
    await expect(
      prepareProcessingCiEvidence({
        candidatePath: "missing",
        releaseId: "2026-08-12.1",
        gitSha: "a".repeat(40),
        output: "missing",
        hostedCheckRoot: undefined,
        sourceSha256: "b".repeat(64),
      }),
    ).rejects.toThrow(/hosted review/);
  });

  it("binds hosted PDF benchmark and browser coverage to the exact candidate", () => {
    const validate = (
      ciEvidenceModule as unknown as {
        validateHostedPdfCandidateBinding: (
          reports: unknown,
          candidate: unknown,
          visual: unknown,
          benchmark: unknown,
          pdfLicenseGateSha256: string,
        ) => unknown;
      }
    ).validateHostedPdfCandidateBinding;
    const reports = {
      fullCorpusBenchmark: {
        gitSha: "a".repeat(40),
        sourceSha256: "b".repeat(64),
        checkRunId: 42,
        benchmarkSha256: "1".repeat(64),
        releaseGateSha256: "2".repeat(64),
        profilesMeasured: 3,
        engineImageDigest: `sha256:${"3".repeat(64)}`,
        corpusSha256: "d".repeat(64),
      },
      competitorComparison: { casesCompared: 17, baselineSha256: "1".repeat(64) },
      blindedHumanReview: {
        visualProfilesMeasured: 9,
        pdfVisualEvidenceSha256: "0".repeat(64),
      },
      commercialReview: { licenseGateSha256: "e".repeat(64) },
      privacyReview: { testsRun: 6, pdfVisualEvidenceSha256: "0".repeat(64) },
      deviceMatrix: { pdfVisualProfilesMeasured: 9, pdfVisualEvidenceSha256: "0".repeat(64) },
    };
    const candidate = {
      gitSha: "a".repeat(40),
      pdfQuality: {
        benchmarkSha256: "1".repeat(64),
        releaseGateSha256: "2".repeat(64),
        visualProfilesMeasured: 3,
      },
      pdfEngine: { oci: { configDigest: `sha256:${"3".repeat(64)}` } },
    };
    const results = [0, 1, 2].map((repeat) => ({
      repeat,
      sha256: `${repeat + 4}`.repeat(64),
      byteLength: repeat + 100,
      verified: true,
    }));
    const visual = {
      schema: "hereisit.pdf-browser-visual-evidence@1",
      version: 1,
      passed: true,
      gitSha: "a".repeat(40),
      sourceSha256: "b".repeat(64),
      checkRunId: 42,
      execution: "exact-main-hosted-pdf-visual",
      inputManifestSha256: "c".repeat(64),
      engineImageDigest: candidate.pdfEngine.oci.configDigest,
      corpusManifestSha256: "d".repeat(64),
      stratum: "jpeg-heavy",
      projects: ["chromium", "firefox", "webkit"].map((project) => ({
        project,
        passed: true,
        results,
      })),
      visualProfilesMeasured: 9,
    };
    const benchmark = {
      identity: {
        engineImageDigest: candidate.pdfEngine.oci.configDigest,
        corpusManifestSha256: visual.corpusManifestSha256,
      },
      records: Array.from({ length: 17 }, (_, index) => ({ stratum: `case-${index}` })),
    };
    const benchmarkSha256 = sha256Canonical(benchmark);
    reports.fullCorpusBenchmark.benchmarkSha256 = benchmarkSha256;
    candidate.pdfQuality.benchmarkSha256 = benchmarkSha256;
    reports.deviceMatrix.pdfVisualEvidenceSha256 = sha256Canonical(visual);
    reports.blindedHumanReview.pdfVisualEvidenceSha256 = sha256Canonical(visual);
    reports.privacyReview.pdfVisualEvidenceSha256 = sha256Canonical(visual);
    reports.competitorComparison.baselineSha256 = benchmarkSha256;
    expect(validate(reports, candidate, visual, benchmark, "e".repeat(64))).toBe(reports);
    for (const changed of [
      { ...candidate, pdfQuality: { ...candidate.pdfQuality, visualProfilesMeasured: 0 } },
      {
        ...candidate,
        pdfEngine: { oci: { configDigest: `sha256:${"4".repeat(64)}` } },
      },
    ])
      expect(() => validate(reports, changed, visual, benchmark, "e".repeat(64))).toThrow(
        /exact candidate/i,
      );
    const drifted = structuredClone(visual);
    drifted.projects[2].results[0].sha256 = "f".repeat(64);
    expect(() => validate(reports, candidate, drifted, benchmark, "e".repeat(64))).toThrow(
      /browser|visual|candidate/i,
    );
    const reboundReports = structuredClone(reports);
    const reboundCandidate = structuredClone(candidate);
    reboundReports.fullCorpusBenchmark.benchmarkSha256 = "e".repeat(64);
    reboundCandidate.pdfQuality.benchmarkSha256 = "e".repeat(64);
    expect(() =>
      validate(reboundReports, reboundCandidate, visual, benchmark, "e".repeat(64)),
    ).toThrow(/benchmark|candidate/i);
    const mismatchedReview = structuredClone(reports);
    mismatchedReview.commercialReview.licenseGateSha256 = "f".repeat(64);
    expect(() => validate(mismatchedReview, candidate, visual, benchmark, "e".repeat(64))).toThrow(
      /license|candidate/i,
    );
  });

  it("binds protected reviewed reports to the exact current @2 candidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "hereisit-ci-evidence-"));
    roots.push(root);
    const candidatePath = join(root, "candidate.json");
    const output = join(root, "evidence.json");
    const releaseId = "2026-08-12.1";
    const gitSha = "a".repeat(40);
    const candidatePayload = {
      schema: "hereisit-processing-candidate@2",
      version: 2,
      state: "built",
      releaseId,
      gitSha,
    };
    // Candidate validation is intentionally proved by the release creator suites. This regression
    // uses the full checked-in fixture there indirectly by requiring the verifier to reject a
    // structurally abbreviated value before it can consume protected evidence.
    await writeFile(
      candidatePath,
      canonicalJson({ ...candidatePayload, verificationSha256: sha256Canonical(candidatePayload) }),
    );
    await expect(
      prepareProcessingCiEvidence({
        candidatePath,
        releaseId,
        gitSha,
        output,
        hostedCheckRoot: root,
        sourceSha256: "b".repeat(64),
      }),
    ).rejects.toThrow(/candidate|field/i);
    await expect(readFile(output)).rejects.toThrow();
  });
});
