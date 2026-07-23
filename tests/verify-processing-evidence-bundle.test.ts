import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeProcessingEvidenceBundle } from "../scripts/create-processing-evidence-bundle.mjs";
import { canonicalJson, sha256Canonical } from "../scripts/image-lab-common.mjs";
import { signCanonicalProcessingEvidence } from "../scripts/processing-evidence-signature.mjs";
import { verifyProcessingEvidenceBundle } from "../scripts/verify-processing-evidence-bundle.mjs";

const temporaryRoots: string[] = [];
const identity = {
  releaseId: "2026-07-20.1",
  gitSha: "a".repeat(40),
  candidateVerificationSha256: "b".repeat(64),
};

function inputs() {
  return {
    ...identity,
    createdAt: "2026-07-20T10:00:00.000Z",
    expiresAt: "2026-07-21T10:00:00.000Z",
    reports: {
      fullCorpusBenchmark: { passed: true },
      competitorComparison: [{ passed: true }],
      blindedHumanReview: { passed: true },
      commercialReview: { passed: true },
      privacyReview: { passed: true },
      deviceMatrix: { passed: true },
    },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hereisit-evidence-verify-"));
  temporaryRoots.push(root);
  const pair = generateKeyPairSync("ed25519");
  const bundlePath = join(root, "bundle.json");
  const signaturePath = join(root, "bundle.sig");
  const privateKeyPath = join(root, "private.pem");
  const publicKeyPath = join(root, "public.pem");
  await writeFile(privateKeyPath, pair.privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });
  await writeFile(publicKeyPath, pair.publicKey.export({ type: "spki", format: "pem" }));
  await writeProcessingEvidenceBundle({ output: bundlePath, ...inputs() });
  await signCanonicalProcessingEvidence({
    bundlePath,
    signaturePath,
    privateKeyPath,
    repositoryRoot: process.cwd(),
  });
  return { root, bundlePath, signaturePath, publicKeyPath, privateKeyPath };
}

function verification(value: Awaited<ReturnType<typeof fixture>>) {
  return {
    bundlePath: value.bundlePath,
    signaturePath: value.signaturePath,
    publicKeyPath: value.publicKeyPath,
    expectedReleaseId: identity.releaseId,
    expectedGitSha: identity.gitSha,
    expectedCandidateVerificationSha256: identity.candidateVerificationSha256,
    now: "2026-07-20T12:00:00.000Z",
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("processing evidence bundle verification", () => {
  it("verifies a signed valid six-report bundle", async () => {
    const value = await fixture();
    await expect(verifyProcessingEvidenceBundle(verification(value))).resolves.toEqual({
      bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      signatureSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      releaseId: identity.releaseId,
      expiresAt: inputs().expiresAt,
    });
  });

  it("rejects mutation and a wrong key", async () => {
    const value = await fixture();
    const bundle = JSON.parse(await readFile(value.bundlePath, "utf8"));
    bundle.reports.deviceMatrix.document.passed = false;
    bundle.reports.deviceMatrix.summarySha256 = sha256Canonical(
      bundle.reports.deviceMatrix.document,
    );
    await writeFile(value.bundlePath, canonicalJson(bundle));
    await expect(verifyProcessingEvidenceBundle(verification(value))).rejects.toThrow(
      /hash|signature/i,
    );

    const wrongKeyValue = await fixture();
    const other = generateKeyPairSync("ed25519");
    await writeFile(
      wrongKeyValue.publicKeyPath,
      other.publicKey.export({ type: "spki", format: "pem" }),
    );
    await expect(verifyProcessingEvidenceBundle(verification(wrongKeyValue))).rejects.toThrow(
      /signature/i,
    );
  });

  it("rejects wrong expected identities", async () => {
    const value = await fixture();
    for (const changed of [
      { expectedReleaseId: "2026-07-20.2" },
      { expectedGitSha: "c".repeat(40) },
      { expectedCandidateVerificationSha256: "d".repeat(64) },
    ]) {
      await expect(
        verifyProcessingEvidenceBundle({ ...verification(value), ...changed }),
      ).rejects.toThrow(/match|expected|identity/i);
    }
  });

  it("rejects time before creation and at or after expiry", async () => {
    const value = await fixture();
    for (const now of [
      "2026-07-20T09:59:59.999Z",
      inputs().expiresAt,
      "2026-07-22T00:00:00.000Z",
    ]) {
      await expect(verifyProcessingEvidenceBundle({ ...verification(value), now })).rejects.toThrow(
        /time|created|expir/i,
      );
    }
  });

  it("rejects non-canonical JSON and bad embedded hashes even when signed", async () => {
    const value = await fixture();
    const bundle = JSON.parse(await readFile(value.bundlePath, "utf8"));
    await writeFile(value.bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
    await expect(verifyProcessingEvidenceBundle(verification(value))).rejects.toThrow(/canonical/i);

    await rm(value.signaturePath);
    bundle.reports.deviceMatrix.summarySha256 = "c".repeat(64);
    await writeFile(value.bundlePath, canonicalJson(bundle));
    await signCanonicalProcessingEvidence({
      ...value,
      repositoryRoot: process.cwd(),
    });
    await expect(verifyProcessingEvidenceBundle(verification(value))).rejects.toThrow(/hash/i);
  });

  it("rejects a symbolic-link bundle", async () => {
    const value = await fixture();
    const linked = join(value.root, "linked-bundle.json");
    await symlink(value.bundlePath, linked);
    await expect(
      verifyProcessingEvidenceBundle({ ...verification(value), bundlePath: linked }),
    ).rejects.toThrow(/symbolic/i);
  });

  it("does not expose supplied paths through direct-execution errors", async () => {
    const value = await fixture();
    const missing = join(value.root, "must-not-appear-bundle.json");
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (finish) => {
        const child = spawn(
          process.execPath,
          [
            "scripts/verify-processing-evidence-bundle.mjs",
            "--bundle",
            missing,
            "--signature",
            value.signaturePath,
            "--public-key",
            value.publicKeyPath,
            "--expected-release-id",
            identity.releaseId,
            "--expected-git-sha",
            identity.gitSha,
            "--expected-candidate-verification-sha256",
            identity.candidateVerificationSha256,
            "--now",
            "2026-07-20T12:00:00.000Z",
          ],
          { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
        child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
        child.on("close", (code) => finish({ code, stdout, stderr }));
      },
    );

    expect(result).toMatchObject({ code: 1, stdout: "" });
    expect(result.stderr).not.toContain(missing);
    expect(result.stderr).not.toContain("must-not-appear-bundle.json");
  });
});
