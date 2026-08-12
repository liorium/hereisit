import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Canonical } from "../scripts/image-lab-common.mjs";
import {
  readProcessingCandidateField,
  readProcessingCandidateFile,
  runProcessingCandidateReader,
  validateProcessingCandidate,
} from "../scripts/read-processing-candidate.mjs";

const releaseId = "2026-07-20.1";
const gitSha = "a".repeat(40);
const temporaryRoots: string[] = [];

function artifact(path: string, sha256: string, sizeBytes: number) {
  return { path, sizeBytes, sha256 };
}

function securityAssets() {
  const scoped = (prefix: string, suffix: string) => ({
    engine: artifact(`${prefix}engine${suffix}`, "1".repeat(64), 1),
    webStaging: artifact(`${prefix}web-staging${suffix}`, "2".repeat(64), 1),
    webProduction: artifact(`${prefix}web-production${suffix}`, "3".repeat(64), 1),
    worker: artifact(`${prefix}worker${suffix}`, "4".repeat(64), 1),
    lockfile: artifact(`${prefix}lockfile${suffix}`, "5".repeat(64), 1),
  });
  return {
    gates: {
      imageEngine: artifact("security-image-engine-license-gate.json", "6".repeat(64), 1),
      applicationSupplyChain: artifact(
        "security-application-supply-chain-gate.json",
        "7".repeat(64),
        1,
      ),
      vulnerability: artifact("security-vulnerability-gate.json", "8".repeat(64), 1),
    },
    sboms: scoped("security-sbom-", ".cdx.json"),
    vulnerabilityReports: scoped("security-trivy-", ".json"),
  };
}

function candidate() {
  const payload = {
    schema: "hereisit-processing-candidate@1",
    version: 1,
    state: "finalized",
    releaseId,
    gitSha,
    engine: {
      loadedImage: `hereisit-image-engine:${gitSha}`,
      oci: {
        configDigest: `sha256:${"b".repeat(64)}`,
        distributionLayerDigests: [`sha256:${"c".repeat(64)}`, `sha256:${"d".repeat(64)}`],
        diffIds: [`sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`],
      },
      docker: {
        configDigest: `sha256:${"b".repeat(64)}`,
        diffIds: [`sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`],
      },
    },
    web: {
      staging: {
        archiveSha256: "1".repeat(64),
        treeSha256: "2".repeat(64),
        processingApiOrigin: "https://hereisit-processing-staging.liorium.workers.dev",
      },
      production: {
        archiveSha256: "3".repeat(64),
        treeSha256: "4".repeat(64),
        processingApiOrigin: "https://api.hereisit.app",
      },
    },
    security: { trivyDbDigest: `sha256:${"e".repeat(64)}` },
    providerUsage: { schemaSha256: "f".repeat(64) },
    releaseInputs: { sha256: "a".repeat(64) },
    costModel: { sha256: "b".repeat(64) },
    releaseAssets: {
      report: artifact("processing-release-report.json", "5".repeat(64), 101),
      engine: {
        oci: artifact("image-engine-linux-amd64.oci.tar", "6".repeat(64), 102),
        docker: artifact("image-engine-linux-amd64.docker.tar", "7".repeat(64), 103),
      },
      worker: artifact("api-worker.mjs", "8".repeat(64), 104),
      releaseInputs: artifact("processing-release-inputs.json", "a".repeat(64), 109),
      costModel: artifact("live-cost-model.json", "b".repeat(64), 110),
      web: {
        staging: {
          path: "web-staging.tar",
          sizeBytes: 105,
          archiveSha256: "1".repeat(64),
          treeSha256: "2".repeat(64),
          processingApiOrigin: "https://hereisit-processing-staging.liorium.workers.dev",
        },
        production: {
          path: "web-production.tar",
          sizeBytes: 106,
          archiveSha256: "3".repeat(64),
          treeSha256: "4".repeat(64),
          processingApiOrigin: "https://api.hereisit.app",
        },
      },
      security: securityAssets(),
      evidence: {
        bundle: artifact(
          `evidence-v1--${releaseId}--processing-evidence.json`,
          "9".repeat(64),
          107,
        ),
        signature: artifact(
          `evidence-v1--${releaseId}--processing-evidence.sig`,
          "0".repeat(64),
          108,
        ),
      },
    },
  };
  return { ...payload, verificationSha256: sha256Canonical(payload) };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("processing candidate reader", () => {
  it("reads only allowlisted scalar identities from a verified finalized candidate", () => {
    const manifest = candidate();

    expect(readProcessingCandidateField(manifest, "engine.loadedImage")).toBe(
      `hereisit-image-engine:${gitSha}`,
    );
    expect(readProcessingCandidateField(manifest, "security.trivyDbDigest")).toBe(
      `sha256:${"e".repeat(64)}`,
    );
    expect(readProcessingCandidateField(manifest, "web.staging.archiveSha256")).toBe(
      "1".repeat(64),
    );
    expect(readProcessingCandidateField(manifest, "web.production.processingApiOrigin")).toBe(
      "https://api.hereisit.app",
    );
  });

  it("keeps legacy @1 parseable for history but never authorizes PDF public release", () => {
    const legacy = candidate();
    expect(validateProcessingCandidate(legacy)).toMatchObject({
      schema: "hereisit-processing-candidate@1",
      version: 1,
    });
    expect(() => readProcessingCandidateField(legacy, "pdfQuality.publicAdmissionReady")).toThrow();
  });

  it("accepts the reduced built-candidate release asset set", () => {
    const finalized = candidate();
    const { report: _report, evidence: _evidence, ...builtReleaseAssets } = finalized.releaseAssets;
    const { verificationSha256: _verificationSha256, ...finalizedPayload } = finalized;
    const payload = {
      ...finalizedPayload,
      state: "built",
      releaseAssets: builtReleaseAssets,
    };

    expect(
      readProcessingCandidateField(
        { ...payload, verificationSha256: sha256Canonical(payload) },
        "state",
      ),
    ).toBe("built");
  });

  it.each([
    "engine",
    "engine.distributionLayerDigests",
    "releaseAssets",
    "verificationSha256",
    "__proto__.polluted",
    "constructor.prototype",
    "releaseAssets.worker.path",
  ])("rejects non-allowlisted field %s", (field) => {
    expect(() => readProcessingCandidateField(candidate(), field)).toThrow(/field/i);
  });

  it("rejects a stale verification stamp", () => {
    const manifest = candidate();
    manifest.engine.loadedImage = "hereisit-image-engine:tampered";
    expect(() => readProcessingCandidateField(manifest, "engine.loadedImage")).toThrow(
      /verification/i,
    );
  });

  it.each([
    ["unexpected key", { token: "plaintext" }],
    [
      "absolute artifact path",
      {
        releaseAssets: {
          ...candidate().releaseAssets,
          worker: artifact("/tmp/api-worker.mjs", "8".repeat(64), 104),
        },
      },
    ],
    [
      "malformed image",
      { engine: { ...candidate().engine, loadedImage: "registry.example/image:latest" } },
    ],
    ["mutable state", { state: "draft" }],
  ])("rejects %s", (_label, override) => {
    const original = candidate();
    const { verificationSha256: _verificationSha256, ...payload } = { ...original, ...override };
    expect(() =>
      readProcessingCandidateField(
        { ...payload, verificationSha256: sha256Canonical(payload) },
        "engine.loadedImage",
      ),
    ).toThrow();
  });

  it("rejects web release identities that drift from the signed web identity", () => {
    const original = candidate();
    const payload = {
      ...original,
      releaseAssets: {
        ...original.releaseAssets,
        web: {
          ...original.releaseAssets.web,
          staging: {
            ...original.releaseAssets.web.staging,
            treeSha256: "a".repeat(64),
          },
        },
      },
    };
    const { verificationSha256: _verificationSha256, ...unsigned } = payload;
    expect(() =>
      readProcessingCandidateField(
        { ...unsigned, verificationSha256: sha256Canonical(unsigned) },
        "web.staging.treeSha256",
      ),
    ).toThrow(/match|identity/i);
  });

  it("accepts an account-selected Workers subdomain but rejects a cross-environment script", () => {
    const original = candidate();
    const changedOrigin = "https://hereisit-processing-staging.example.workers.dev";
    const payload = {
      ...original,
      web: {
        ...original.web,
        staging: { ...original.web.staging, processingApiOrigin: changedOrigin },
      },
      releaseAssets: {
        ...original.releaseAssets,
        web: {
          ...original.releaseAssets.web,
          staging: {
            ...original.releaseAssets.web.staging,
            processingApiOrigin: changedOrigin,
          },
        },
      },
    };
    const { verificationSha256: _verificationSha256, ...unsigned } = payload;
    expect(
      readProcessingCandidateField(
        { ...unsigned, verificationSha256: sha256Canonical(unsigned) },
        "web.staging.processingApiOrigin",
      ),
    ).toBe(changedOrigin);

    const invalid = {
      ...unsigned,
      web: {
        ...unsigned.web,
        staging: {
          ...unsigned.web.staging,
          processingApiOrigin: "https://hereisit-processing-production.example.workers.dev",
        },
      },
    };
    expect(() =>
      readProcessingCandidateField(
        { ...invalid, verificationSha256: sha256Canonical(invalid) },
        "web.staging.processingApiOrigin",
      ),
    ).toThrow(/origin|HTTPS/i);
  });

  it("rejects a Docker export whose config or ordered rootfs DiffIDs differ from OCI", () => {
    const original = candidate();
    const { verificationSha256: _verificationSha256, ...payload } = {
      ...original,
      engine: {
        ...original.engine,
        docker: {
          ...original.engine.docker,
          diffIds: [...original.engine.docker.diffIds].reverse(),
        },
      },
    };
    expect(() =>
      readProcessingCandidateField(
        { ...payload, verificationSha256: sha256Canonical(payload) },
        "engine.loadedImage",
      ),
    ).toThrow(/OCI.*Docker|match/i);
  });

  it("accepts repeated layer content identities without losing their order", () => {
    const original = candidate();
    const repeatedDistributionDigest = original.engine.oci.distributionLayerDigests[0];
    const repeatedDiffId = original.engine.oci.diffIds[0];
    const { verificationSha256: _verificationSha256, ...payload } = {
      ...original,
      engine: {
        ...original.engine,
        oci: {
          ...original.engine.oci,
          distributionLayerDigests: [repeatedDistributionDigest, repeatedDistributionDigest],
          diffIds: [repeatedDiffId, repeatedDiffId],
        },
        docker: {
          ...original.engine.docker,
          diffIds: [repeatedDiffId, repeatedDiffId],
        },
      },
    };

    expect(
      readProcessingCandidateField(
        { ...payload, verificationSha256: sha256Canonical(payload) },
        "engine.oci.configDigest",
      ),
    ).toBe(original.engine.oci.configDigest);
  });

  it("reads a bounded regular file and rejects a symbolic-link manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "hereisit-candidate-reader-"));
    temporaryRoots.push(root);
    const target = join(root, "candidate.json");
    const link = join(root, "candidate-link.json");
    await writeFile(target, JSON.stringify(candidate()), { mode: 0o600 });
    await symlink(target, link);

    await expect(
      readProcessingCandidateFile({ manifestPath: target, field: "providerUsage.schemaSha256" }),
    ).resolves.toBe("f".repeat(64));
    await expect(
      readProcessingCandidateFile({ manifestPath: link, field: "engine.loadedImage" }),
    ).rejects.toThrow(/read|symbolic|regular/i);
  });

  it("prints only the requested scalar through the CLI boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "hereisit-candidate-reader-"));
    temporaryRoots.push(root);
    const manifestPath = join(root, "processing-candidate.json");
    const writes: string[] = [];
    await writeFile(manifestPath, JSON.stringify(candidate()), { mode: 0o600 });

    await runProcessingCandidateReader(
      ["--manifest", manifestPath, "--field", "web.production.treeSha256"],
      {
        write(value: string) {
          writes.push(value);
        },
      },
    );
    expect(writes).toEqual([`${"4".repeat(64)}\n`]);
  });
});
