import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Bytes, sha256Canonical } from "../scripts/image-lab-common.mjs";
import {
  readProcessingReleaseAssetField,
  readProcessingReleaseAssetsFile,
  runProcessingReleaseAssetsReader,
} from "../scripts/read-processing-release-assets.mjs";

const releaseId = "2026-07-20.1";
const releaseTag = `processing-release-${releaseId}`;
const repository = "liorium/hereisit";
const targetSha = "a".repeat(40);
const apiOrigin = "https://api.github.com";
const temporaryRoots: string[] = [];

function asset(assetId: number, suffix: string, sha256 = "b".repeat(64)) {
  return {
    assetId,
    name: `candidate-v1--${releaseId}--${suffix}`,
    sizeBytes: 1000 + assetId,
    sha256,
    apiUrl: `${apiOrigin}/repos/${repository}/releases/assets/${assetId}`,
  };
}

function candidateDocument() {
  const payload = {
    schema: "hereisit-processing-candidate@1",
    version: 1,
    state: "finalized",
    releaseId,
    gitSha: targetSha,
    engine: {
      loadedImage: `hereisit-image-engine:${targetSha}`,
      configDigest: `sha256:${"7".repeat(64)}`,
      layerDigests: [`sha256:${"8".repeat(64)}`],
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
        processingApiOrigin: "https://hereisit-processing-production.liorium.workers.dev",
      },
    },
    security: { trivyDbDigest: `sha256:${"9".repeat(64)}` },
    providerUsage: { schemaSha256: "a".repeat(64) },
    releaseAssets: {
      report: {
        path: "processing-release-report.json",
        sizeBytes: 1102,
        sha256: "c".repeat(64),
      },
      engine: {
        oci: {
          path: "image-engine-linux-amd64.oci.tar",
          sizeBytes: 1103,
          sha256: "d".repeat(64),
        },
        docker: {
          path: "image-engine-linux-amd64.docker.tar",
          sizeBytes: 1104,
          sha256: "e".repeat(64),
        },
      },
      worker: { path: "api-worker.mjs", sizeBytes: 1105, sha256: "f".repeat(64) },
      web: {
        staging: {
          path: "web-staging.tar",
          sizeBytes: 1106,
          archiveSha256: "1".repeat(64),
          treeSha256: "2".repeat(64),
          processingApiOrigin: "https://hereisit-processing-staging.liorium.workers.dev",
        },
        production: {
          path: "web-production.tar",
          sizeBytes: 1107,
          archiveSha256: "3".repeat(64),
          treeSha256: "4".repeat(64),
          processingApiOrigin: "https://hereisit-processing-production.liorium.workers.dev",
        },
      },
      evidence: {
        bundle: {
          path: `evidence-v1--${releaseId}--processing-evidence.json`,
          sizeBytes: 1108,
          sha256: "5".repeat(64),
        },
        signature: {
          path: `evidence-v1--${releaseId}--processing-evidence.sig`,
          sizeBytes: 1109,
          sha256: "6".repeat(64),
        },
      },
    },
  };
  return { ...payload, verificationSha256: sha256Canonical(payload) };
}

function releaseManifest(candidateBytes: Uint8Array) {
  const payload = {
    schema: "hereisit-processing-release-assets@1",
    version: 1,
    apiOrigin,
    repository,
    release: {
      id: 9001,
      tag: releaseTag,
      targetSha,
    },
    candidate: {
      ...asset(101, "processing-candidate.json", sha256Bytes(candidateBytes)),
      sizeBytes: candidateBytes.byteLength,
    },
    report: asset(102, "processing-release-report.json", "c".repeat(64)),
    engine: {
      oci: asset(103, "image-engine-linux-amd64.oci.tar", "d".repeat(64)),
      docker: asset(104, "image-engine-linux-amd64.docker.tar", "e".repeat(64)),
    },
    worker: asset(105, "api-worker.mjs", "f".repeat(64)),
    web: {
      staging: {
        ...asset(106, "web-staging.tar", "1".repeat(64)),
        archiveSha256: "1".repeat(64),
        treeSha256: "2".repeat(64),
        processingApiOrigin: "https://hereisit-processing-staging.liorium.workers.dev",
      },
      production: {
        ...asset(107, "web-production.tar", "3".repeat(64)),
        archiveSha256: "3".repeat(64),
        treeSha256: "4".repeat(64),
        processingApiOrigin: "https://hereisit-processing-production.liorium.workers.dev",
      },
    },
    evidence: {
      bundle: {
        ...asset(108, "unused", "5".repeat(64)),
        name: `evidence-v1--${releaseId}--processing-evidence.json`,
      },
      signature: {
        ...asset(109, "unused", "6".repeat(64)),
        name: `evidence-v1--${releaseId}--processing-evidence.sig`,
      },
    },
  };
  return { ...payload, verificationSha256: sha256Canonical(payload) };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hereisit-release-assets-"));
  temporaryRoots.push(root);
  const candidateRoot = join(root, "candidate");
  await mkdir(candidateRoot);
  const candidateBytes = Buffer.from(canonicalJson(candidateDocument()));
  await writeFile(join(candidateRoot, "processing-candidate.json"), candidateBytes);
  const manifest = releaseManifest(candidateBytes);
  const manifestPath = join(root, "processing-release-assets.json");
  await writeFile(manifestPath, canonicalJson(manifest));
  return { root, candidateRoot, candidateBytes, manifest, manifestPath };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("processing release asset reader", () => {
  it("reads only allowlisted scalar identities from a candidate-bound manifest", async () => {
    const { candidateRoot, manifest } = await fixture();

    expect(
      await readProcessingReleaseAssetField(manifest, candidateRoot, "web.staging.assetId"),
    ).toBe(106);
    expect(await readProcessingReleaseAssetField(manifest, candidateRoot, "worker.sha256")).toBe(
      "f".repeat(64),
    );
    expect(
      await readProcessingReleaseAssetField(
        manifest,
        candidateRoot,
        "web.production.processingApiOrigin",
      ),
    ).toBe("https://hereisit-processing-production.liorium.workers.dev");
  });

  it.each([
    "web",
    "web.staging",
    "release",
    "verificationSha256",
    "__proto__.polluted",
    "worker.apiUrl.href",
    "evidence",
  ])("rejects non-allowlisted field %s", async (field) => {
    const { candidateRoot, manifest } = await fixture();
    await expect(readProcessingReleaseAssetField(manifest, candidateRoot, field)).rejects.toThrow(
      /field/i,
    );
  });

  it("rejects a stale manifest verification stamp", async () => {
    const { candidateRoot, manifest } = await fixture();
    manifest.worker.sha256 = "7".repeat(64);
    await expect(
      readProcessingReleaseAssetField(manifest, candidateRoot, "worker.assetId"),
    ).rejects.toThrow(/verification/i);
  });

  it("rejects a candidate root whose bytes changed", async () => {
    const { candidateRoot, manifest } = await fixture();
    await writeFile(
      join(candidateRoot, "processing-candidate.json"),
      canonicalJson({ ...candidateDocument(), state: "built" }),
    );
    await expect(
      readProcessingReleaseAssetField(manifest, candidateRoot, "candidate.assetId"),
    ).rejects.toThrow(/candidate.*(?:hash|size|finalized)/i);
  });

  it("rejects asset identity drift even when the manifest checksum is recomputed", async () => {
    const { candidateRoot, manifest } = await fixture();
    manifest.worker.sha256 = "7".repeat(64);
    const { verificationSha256: _old, ...payload } = manifest;
    manifest.verificationSha256 = sha256Canonical(payload);
    await expect(
      readProcessingReleaseAssetField(manifest, candidateRoot, "worker.sha256"),
    ).rejects.toThrow(/candidate.*worker.*match/i);
  });

  it.each([
    ["wrong repository", { repository: "attacker/hereisit" }],
    ["mutable tag", { release: { id: 9001, tag: "main", targetSha } }],
    ["unexpected field", { token: "must-not-appear" }],
    [
      "wrong asset name",
      { worker: { ...asset(105, "api-worker.mjs", "f".repeat(64)), name: "api-worker.mjs" } },
    ],
  ])("rejects %s", async (_label, override) => {
    const { candidateRoot, manifest } = await fixture();
    const changed = { ...manifest, ...override };
    const { verificationSha256: _old, ...payload } = changed;
    changed.verificationSha256 = sha256Canonical(payload);
    await expect(
      readProcessingReleaseAssetField(changed, candidateRoot, "worker.assetId"),
    ).rejects.toThrow();
  });

  it("reads a bounded file and prints only the requested scalar", async () => {
    const { candidateRoot, manifestPath } = await fixture();
    await expect(
      readProcessingReleaseAssetsFile({
        manifestPath,
        candidateRoot,
        field: "web.production.treeSha256",
      }),
    ).resolves.toBe("4".repeat(64));

    const writes: string[] = [];
    await runProcessingReleaseAssetsReader(
      ["--manifest", manifestPath, "--candidate-root", candidateRoot, "--field", "worker.assetId"],
      {
        write(value: string) {
          writes.push(value);
        },
      },
    );
    expect(writes).toEqual(["105\n"]);
  });

  it("rejects a release manifest beyond the fixed input bound", async () => {
    const { root, candidateRoot } = await fixture();
    const oversized = join(root, "oversized.json");
    await writeFile(oversized, " ".repeat(512 * 1024 + 1));
    await expect(
      readProcessingReleaseAssetsFile({
        manifestPath: oversized,
        candidateRoot,
        field: "worker.assetId",
      }),
    ).rejects.toThrow(/size|large/i);
  });
});
