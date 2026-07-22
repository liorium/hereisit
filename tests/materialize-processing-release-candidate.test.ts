import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  materializeProcessingReleaseCandidate,
  processingReleaseMaterializationPlan,
} from "../scripts/materialize-processing-release-candidate.mjs";

const releaseId = "2026-07-22.1";
const releaseTag = `processing-release-${releaseId}`;
const prefix = `candidate-v1--${releaseId}--`;
const candidateSuffixes = [
  "processing-candidate.json",
  "processing-release-report.json",
  "image-engine-linux-amd64.oci.tar",
  "image-engine-linux-amd64.docker.tar",
  "api-worker.mjs",
  "processing-release-inputs.json",
  "live-cost-model.json",
  "web-staging.tar",
  "web-production.tar",
  "security-image-engine-license-gate.json",
  "security-application-supply-chain-gate.json",
  "security-vulnerability-gate.json",
  "security-sbom-engine.cdx.json",
  "security-sbom-web-staging.cdx.json",
  "security-sbom-web-production.cdx.json",
  "security-sbom-worker.cdx.json",
  "security-sbom-lockfile.cdx.json",
  "security-trivy-engine.json",
  "security-trivy-web-staging.json",
  "security-trivy-web-production.json",
  "security-trivy-worker.json",
  "security-trivy-lockfile.json",
] as const;
const evidenceNames = [
  `evidence-v1--${releaseId}--processing-evidence.json`,
  `evidence-v1--${releaseId}--processing-evidence.sig`,
] as const;
const exactNames = [...candidateSuffixes.map((name) => `${prefix}${name}`), ...evidenceNames];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("processing release candidate materialization", () => {
  it("normalizes only the exact versioned release namespace", () => {
    const plan = processingReleaseMaterializationPlan(releaseTag, exactNames);

    expect(plan).toHaveLength(24);
    expect(
      plan.find(({ source }) => source.endsWith("processing-candidate.json"))?.destination,
    ).toBe("processing-candidate.json");
    expect(plan.find(({ source }) => source.endsWith("processing-evidence.sig"))?.destination).toBe(
      evidenceNames[1],
    );
  });

  it.each([
    [exactNames.slice(1)],
    [[...exactNames, `${prefix}unexpected.bin`]],
    [[...exactNames.slice(0, -1), "processing-evidence.sig"]],
  ])("rejects incomplete, extra, or unversioned files", (names) => {
    expect(() => processingReleaseMaterializationPlan(releaseTag, names)).toThrow(
      /exact release asset namespace/i,
    );
  });

  it("does not publish a partial output when the download tree is incomplete", async () => {
    const root = await mkdtemp(join(tmpdir(), "hereisit-materialize-release-"));
    roots.push(root);
    const downloadRoot = join(root, "download");
    const outputRoot = join(root, "candidate");
    await mkdir(downloadRoot);
    await writeFile(join(downloadRoot, exactNames[0]), "{}");

    await expect(
      materializeProcessingReleaseCandidate({
        releaseTag,
        downloadRoot,
        outputRoot,
        expectedGitSha: "a".repeat(40),
      }),
    ).rejects.toThrow(/exact release asset namespace/i);
    await expect(mkdir(outputRoot)).resolves.toBeUndefined();
  });
});
