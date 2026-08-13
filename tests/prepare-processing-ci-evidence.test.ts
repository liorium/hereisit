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
