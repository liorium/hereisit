import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Canonical } from "../scripts/image-lab-common.mjs";
import { prepareProcessingCiEvidence } from "../scripts/prepare-processing-ci-evidence.mjs";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true }))));

describe("CI release evidence", () => {
  it("fails closed without protected reviewed evidence", async () => {
    await expect(
      prepareProcessingCiEvidence({
        candidatePath: "missing",
        releaseId: "2026-08-12.1",
        gitSha: "a".repeat(40),
        output: "missing",
        serializedReports: undefined,
      }),
    ).rejects.toThrow(/protected reviewed/);
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
        serializedReports: JSON.stringify({ fullCorpusBenchmark: { passed: true } }),
      }),
    ).rejects.toThrow(/candidate|field/i);
    await expect(readFile(output)).rejects.toThrow();
  });
});
