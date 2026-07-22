import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeterministicTreeArchive } from "../scripts/create-deterministic-tree-archive.mjs";
import { createLiveCostModel } from "../scripts/create-live-cost-model.mjs";
import { createProcessingReleaseInputs } from "../scripts/create-processing-release-inputs.mjs";
import { canonicalJson, sha256Bytes, sha256Canonical } from "../scripts/image-lab-common.mjs";
import { materializeProcessingReleaseCandidate } from "../scripts/materialize-processing-release-candidate.mjs";

const releaseId = "2026-07-22.1";
const releaseTag = `processing-release-${releaseId}`;
const gitSha = "a".repeat(40);
const prefix = `candidate-v1--${releaseId}--`;
const securityScopes = ["engine", "web-staging", "web-production", "worker", "lockfile"] as const;
const securityKeys = ["engine", "webStaging", "webProduction", "worker", "lockfile"] as const;
const roots: string[] = [];

async function createCandidateFixture() {
  const parent = await mkdtemp(join(tmpdir(), "hereisit-release-materializer-"));
  roots.push(parent);
  const candidateRoot = join(parent, "source-candidate");
  const build = join(parent, "build");
  await mkdir(candidateRoot);
  await mkdir(build);

  const createWeb = async (environment: "staging" | "production") => {
    const tree = join(build, `web-${environment}`);
    await mkdir(tree);
    await writeFile(join(tree, "index.html"), `<h1>${environment}</h1>\n`);
    const archive = join(candidateRoot, `web-${environment}.tar`);
    return { archive, ...(await createDeterministicTreeArchive({ root: tree, output: archive })) };
  };
  const staging = await createWeb("staging");
  const production = await createWeb("production");

  const layerBytes = Buffer.from("canonical uncompressed layer tar bytes\n");
  const diffId = `sha256:${sha256Bytes(layerBytes)}`;
  const configBytes = Buffer.from(
    canonicalJson({
      architecture: "amd64",
      os: "linux",
      rootfs: { type: "layers", diff_ids: [diffId] },
    }),
  );
  const configDigest = `sha256:${sha256Bytes(configBytes)}`;
  const layerDigest = `sha256:${sha256Bytes(layerBytes)}`;
  const manifestBytes = Buffer.from(
    canonicalJson({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        digest: configDigest,
        size: configBytes.byteLength,
      },
      layers: [
        {
          mediaType: "application/vnd.oci.image.layer.v1.tar",
          digest: layerDigest,
          size: layerBytes.byteLength,
        },
      ],
    }),
  );
  const manifestDigest = `sha256:${sha256Bytes(manifestBytes)}`;
  const ociTree = join(build, "engine-oci");
  await mkdir(join(ociTree, "blobs", "sha256"), { recursive: true });
  await writeFile(join(ociTree, "oci-layout"), canonicalJson({ imageLayoutVersion: "1.0.0" }));
  await writeFile(
    join(ociTree, "index.json"),
    canonicalJson({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [
        {
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          digest: manifestDigest,
          size: manifestBytes.byteLength,
          platform: { os: "linux", architecture: "amd64" },
        },
      ],
    }),
  );
  await writeFile(join(ociTree, "blobs", "sha256", configDigest.slice(7)), configBytes);
  await writeFile(join(ociTree, "blobs", "sha256", manifestDigest.slice(7)), manifestBytes);
  await writeFile(join(ociTree, "blobs", "sha256", layerDigest.slice(7)), layerBytes);
  await createDeterministicTreeArchive({
    root: ociTree,
    output: join(candidateRoot, "image-engine-linux-amd64.oci.tar"),
  });

  const dockerTree = join(build, "engine-docker");
  await mkdir(join(dockerTree, "layer"), { recursive: true });
  await writeFile(join(dockerTree, "config.json"), configBytes);
  await writeFile(join(dockerTree, "layer", "layer.tar"), layerBytes);
  await writeFile(
    join(dockerTree, "manifest.json"),
    canonicalJson([
      {
        Config: "config.json",
        RepoTags: [`hereisit-image-engine:${gitSha}`],
        Layers: ["layer/layer.tar"],
      },
    ]),
  );
  await createDeterministicTreeArchive({
    root: dockerTree,
    output: join(candidateRoot, "image-engine-linux-amd64.docker.tar"),
  });

  const liveCostInput = JSON.parse(
    readFileSync("tests/fixtures/live-cost-model-pr-input.json", "utf8"),
  );
  const { routeCpuBenchmark: _route, ...modelInput } = liveCostInput;
  const fileBytes: Record<string, Buffer> = {
    "live-cost-model.json": Buffer.from(canonicalJson(createLiveCostModel(liveCostInput))),
    "processing-release-inputs.json": Buffer.from(
      canonicalJson(
        createProcessingReleaseInputs({
          version: 1,
          releaseId,
          baseSourceSha256: "1".repeat(64),
          reviewedAt: "2026-07-20T00:00:00.000Z",
          reviewerIdHash: "2".repeat(64),
          pricesAndResources: { version: 1, artifactSha256: "3".repeat(64), modelInput },
          ceilings: {
            maxCostPer1000JobsMicrousd: 500_000,
            maxLiveMedianOutputRatioBps: 8_500,
            maxLiveP95WeightedUnits: 150_000_000,
            maxLiveOriginalRetainedRateBps: 7_000,
            maxProjectedMonthlyCostMicrousd: 5_000_000,
          },
          routeCpuBenchmark: { artifactSha256: "4".repeat(64), ...liveCostInput.routeCpuBenchmark },
        }),
      ),
    ),
    "processing-release-report.json": Buffer.from('{"passed":true}\n'),
    "api-worker.mjs": Buffer.from("export default {};\n"),
    [`evidence-v1--${releaseId}--processing-evidence.json`]: Buffer.from('{"signed":true}\n'),
    [`evidence-v1--${releaseId}--processing-evidence.sig`]: Buffer.alloc(64, 0x61),
  };
  fileBytes["image-engine-linux-amd64.oci.tar"] = await readFile(
    join(candidateRoot, "image-engine-linux-amd64.oci.tar"),
  );
  fileBytes["image-engine-linux-amd64.docker.tar"] = await readFile(
    join(candidateRoot, "image-engine-linux-amd64.docker.tar"),
  );
  fileBytes["web-staging.tar"] = await readFile(staging.archive);
  fileBytes["web-production.tar"] = await readFile(production.archive);
  const artifactHashes: Record<(typeof securityScopes)[number], string> = {
    engine: configDigest.slice(7),
    "web-staging": staging.archiveSha256,
    "web-production": production.archiveSha256,
    worker: sha256Bytes(fileBytes["api-worker.mjs"]),
    lockfile: "6".repeat(64),
  };
  for (const scope of securityScopes) {
    fileBytes[`security-sbom-${scope}.cdx.json`] = Buffer.from(
      canonicalJson({ bomFormat: "CycloneDX", scope }),
    );
    fileBytes[`security-trivy-${scope}.json`] = Buffer.from(canonicalJson({ scope }));
  }
  const sbomHashes = Object.fromEntries(
    securityScopes.map((scope) => [
      scope,
      sha256Bytes(fileBytes[`security-sbom-${scope}.cdx.json`]),
    ]),
  );
  const reportHashes = Object.fromEntries(
    securityScopes.map((scope) => [scope, sha256Bytes(fileBytes[`security-trivy-${scope}.json`])]),
  );
  fileBytes["security-image-engine-license-gate.json"] = Buffer.from(
    canonicalJson({
      schema: "hereisit-image-engine-license-gate@1",
      passed: true,
      scope: "pr",
      artifactSha256: artifactHashes.engine,
      sourceLockSha256: "1".repeat(64),
      policySha256: "2".repeat(64),
      exceptionsSha256: "3".repeat(64),
      baseImagesSha256: "4".repeat(64),
    }),
  );
  fileBytes["security-application-supply-chain-gate.json"] = Buffer.from(
    canonicalJson({
      schema: "hereisit-application-supply-chain-gate@1",
      passed: true,
      policySha256: "1".repeat(64),
      lockfileSha256: artifactHashes.lockfile,
      noticesSha256: "2".repeat(64),
      fallbackTextSha256: ["3".repeat(64)],
      pnpmVersion: "11.11.0",
      syftVersion: "1.44.0",
      syftImage:
        "ghcr.io/anchore/syft@sha256:2baa4d24d90599840c0100a8d30deaa533821fcd99f405ce6f90e3d225bd836d",
      reviewedPackageCount: 1,
      scopes: Object.fromEntries(
        securityScopes.map((scope) => [
          scope,
          {
            artifactSha256: artifactHashes[scope],
            sbomSha256: sbomHashes[scope],
            componentCount: 1,
          },
        ]),
      ),
    }),
  );
  fileBytes["security-vulnerability-gate.json"] = Buffer.from(
    canonicalJson({
      schemaVersion: "hereisit-vulnerability-gate@1",
      passed: true,
      scanner: {
        policySha256: "1".repeat(64),
        version: "0.69.3",
        image:
          "ghcr.io/aquasecurity/trivy@sha256:7228e304ae0f610a1fad937baa463598cadac0c2ac4027cc68f3a8b997115689",
        databaseDigest: `sha256:${"d".repeat(64)}`,
      },
      exceptions: { engineSha256: "2".repeat(64), applicationSha256: "3".repeat(64) },
      scans: securityScopes.map((scope) => ({
        scope,
        artifactSha256: artifactHashes[scope],
        reportSha256: reportHashes[scope],
        totalFindingCount: 0,
        highOrCriticalFindingCount: 0,
        usedExceptionCount: 0,
      })),
    }),
  );
  for (const [path, bytes] of Object.entries(fileBytes)) {
    await writeFile(join(candidateRoot, path), bytes, { mode: 0o600 });
  }
  const artifact = (path: string) => ({
    path,
    sizeBytes: fileBytes[path].byteLength,
    sha256: sha256Bytes(fileBytes[path]),
  });
  const stagingIdentity = {
    archiveSha256: staging.archiveSha256,
    treeSha256: staging.treeSha256,
    processingApiOrigin: "https://hereisit-processing-staging.example.workers.dev",
  };
  const productionIdentity = {
    archiveSha256: production.archiveSha256,
    treeSha256: production.treeSha256,
    processingApiOrigin: "https://hereisit-processing-production.example.workers.dev",
  };
  const payload = {
    schema: "hereisit-processing-candidate@1",
    version: 1,
    state: "finalized",
    releaseId,
    gitSha,
    engine: {
      loadedImage: `hereisit-image-engine:${gitSha}`,
      oci: { configDigest, distributionLayerDigests: [layerDigest], diffIds: [diffId] },
      docker: { configDigest, diffIds: [diffId] },
    },
    web: { staging: stagingIdentity, production: productionIdentity },
    security: { trivyDbDigest: `sha256:${"d".repeat(64)}` },
    providerUsage: { schemaSha256: "e".repeat(64) },
    releaseInputs: { sha256: artifact("processing-release-inputs.json").sha256 },
    costModel: { sha256: artifact("live-cost-model.json").sha256 },
    releaseAssets: {
      report: artifact("processing-release-report.json"),
      engine: {
        oci: artifact("image-engine-linux-amd64.oci.tar"),
        docker: artifact("image-engine-linux-amd64.docker.tar"),
      },
      worker: artifact("api-worker.mjs"),
      releaseInputs: artifact("processing-release-inputs.json"),
      costModel: artifact("live-cost-model.json"),
      web: {
        staging: {
          path: "web-staging.tar",
          sizeBytes: fileBytes["web-staging.tar"].byteLength,
          ...stagingIdentity,
        },
        production: {
          path: "web-production.tar",
          sizeBytes: fileBytes["web-production.tar"].byteLength,
          ...productionIdentity,
        },
      },
      security: {
        gates: {
          imageEngine: artifact("security-image-engine-license-gate.json"),
          applicationSupplyChain: artifact("security-application-supply-chain-gate.json"),
          vulnerability: artifact("security-vulnerability-gate.json"),
        },
        sboms: Object.fromEntries(
          securityScopes.map((scope, index) => [
            securityKeys[index],
            artifact(`security-sbom-${scope}.cdx.json`),
          ]),
        ),
        vulnerabilityReports: Object.fromEntries(
          securityScopes.map((scope, index) => [
            securityKeys[index],
            artifact(`security-trivy-${scope}.json`),
          ]),
        ),
      },
      evidence: {
        bundle: artifact(`evidence-v1--${releaseId}--processing-evidence.json`),
        signature: artifact(`evidence-v1--${releaseId}--processing-evidence.sig`),
      },
    },
  };
  const candidate = { ...payload, verificationSha256: sha256Canonical(payload) };
  await writeFile(join(candidateRoot, "processing-candidate.json"), canonicalJson(candidate));

  const downloadRoot = join(parent, "download");
  await mkdir(downloadRoot);
  for (const name of await readdir(candidateRoot)) {
    const releaseName = name.startsWith("evidence-v1--") ? name : `${prefix}${name}`;
    await copyFile(join(candidateRoot, name), join(downloadRoot, releaseName));
  }
  return { parent, candidate, downloadRoot, outputRoot: join(parent, "candidate") };
}

type FixtureCandidate = Awaited<ReturnType<typeof createCandidateFixture>>["candidate"];

function descriptor(candidate: FixtureCandidate, path: string) {
  if (path === "processing-release-report.json") return candidate.releaseAssets.report;
  if (path === "processing-release-inputs.json") return candidate.releaseAssets.releaseInputs;
  if (path === "live-cost-model.json") return candidate.releaseAssets.costModel;
  if (path === "api-worker.mjs") return candidate.releaseAssets.worker;
  if (path.includes("image-engine-linux-amd64.oci")) return candidate.releaseAssets.engine.oci;
  if (path.includes("image-engine-linux-amd64.docker"))
    return candidate.releaseAssets.engine.docker;
  if (path === "web-staging.tar") return candidate.releaseAssets.web.staging;
  if (path === "web-production.tar") return candidate.releaseAssets.web.production;
  if (path === "security-image-engine-license-gate.json")
    return candidate.releaseAssets.security.gates.imageEngine;
  if (path.startsWith("security-sbom-")) {
    const index = securityScopes.indexOf(path.slice(14, -9) as (typeof securityScopes)[number]);
    return candidate.releaseAssets.security.sboms[securityKeys[index]];
  }
  if (path.startsWith("security-trivy-")) {
    const index = securityScopes.indexOf(path.slice(15, -5) as (typeof securityScopes)[number]);
    return candidate.releaseAssets.security.vulnerabilityReports[securityKeys[index]];
  }
  if (path === `evidence-v1--${releaseId}--processing-evidence.json`)
    return candidate.releaseAssets.evidence.bundle;
  if (path === `evidence-v1--${releaseId}--processing-evidence.sig`)
    return candidate.releaseAssets.evidence.signature;
  throw new Error(`unknown fixture asset ${path}`);
}

async function bindOversizedAsset(
  fixture: Awaited<ReturnType<typeof createCandidateFixture>>,
  path: string,
  size: number,
) {
  const asset = descriptor(fixture.candidate, path);
  asset.sizeBytes = size;
  asset.sha256 = "f".repeat(64);
  const { verificationSha256: _hash, ...payload } = fixture.candidate;
  fixture.candidate.verificationSha256 = sha256Canonical(payload);
  await writeFile(
    join(fixture.downloadRoot, `${prefix}processing-candidate.json`),
    canonicalJson(fixture.candidate),
  );
  const name = path.startsWith("evidence-v1--") ? path : `${prefix}${path}`;
  const handle = await open(join(fixture.downloadRoot, name), "w");
  await handle.truncate(size);
  await handle.close();
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("processing release candidate materialization", () => {
  it("materializes and verifies the exact finalized release tree", async () => {
    const fixture = await createCandidateFixture();
    const result = await materializeProcessingReleaseCandidate({
      releaseTag,
      downloadRoot: fixture.downloadRoot,
      outputRoot: fixture.outputRoot,
      expectedGitSha: gitSha,
    });

    expect(result.state).toBe("finalized");
    expect(await readdir(fixture.outputRoot)).toHaveLength(24);
    expect(await readFile(join(fixture.outputRoot, "api-worker.mjs"), "utf8")).toBe(
      "export default {};\n",
    );
  });

  it.each([
    ["processing-release-report.json", 1024 * 1024 + 1],
    ["processing-release-inputs.json", 1024 * 1024 + 1],
    ["live-cost-model.json", 1024 * 1024 + 1],
    ["security-image-engine-license-gate.json", 1024 * 1024 + 1],
    ["security-sbom-engine.cdx.json", 8 * 1024 * 1024 + 1],
    ["security-trivy-engine.json", 8 * 1024 * 1024 + 1],
    [`evidence-v1--${releaseId}--processing-evidence.json`, 8 * 1024 * 1024 + 1],
    [`evidence-v1--${releaseId}--processing-evidence.sig`, 65],
    ["api-worker.mjs", 2 * 1024 * 1024 * 1024 + 1],
    ["web-staging.tar", 2 * 1024 * 1024 * 1024 + 1],
    ["image-engine-linux-amd64.docker.tar", 2 * 1024 * 1024 * 1024 + 1],
  ])("rejects an over-limit %s before publication", async (path, size) => {
    const fixture = await createCandidateFixture();
    await bindOversizedAsset(fixture, path, size);

    await expect(
      materializeProcessingReleaseCandidate({
        releaseTag,
        downloadRoot: fixture.downloadRoot,
        outputRoot: fixture.outputRoot,
        expectedGitSha: gitSha,
      }),
    ).rejects.toThrow(/bound|size|candidate/i);
    await expect(lstat(fixture.outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an oversized bootstrap manifest before copying assets", async () => {
    const fixture = await createCandidateFixture();
    await truncate(
      join(fixture.downloadRoot, `${prefix}processing-candidate.json`),
      1024 * 1024 + 1,
    );
    await expect(
      materializeProcessingReleaseCandidate({
        releaseTag,
        downloadRoot: fixture.downloadRoot,
        outputRoot: fixture.outputRoot,
        expectedGitSha: gitSha,
      }),
    ).rejects.toThrow(/bound|size|candidate/i);
  });

  it.each(["symbolic", "hard-linked"])("rejects a %s release asset", async (kind) => {
    const fixture = await createCandidateFixture();
    const name = `${prefix}api-worker.mjs`;
    const target = join(fixture.parent, "private-target");
    await writeFile(target, "private");
    await rm(join(fixture.downloadRoot, name));
    if (kind === "symbolic") await symlink(target, join(fixture.downloadRoot, name));
    else await link(target, join(fixture.downloadRoot, name));

    await expect(
      materializeProcessingReleaseCandidate({
        releaseTag,
        downloadRoot: fixture.downloadRoot,
        outputRoot: fixture.outputRoot,
        expectedGitSha: gitSha,
      }),
    ).rejects.toThrow(/regular|linked|files/i);
  });

  it("detects a source mutation during copying and cleans temporary output", async () => {
    const fixture = await createCandidateFixture();
    let mutated = false;
    await expect(
      materializeProcessingReleaseCandidate(
        {
          releaseTag,
          downloadRoot: fixture.downloadRoot,
          outputRoot: fixture.outputRoot,
          expectedGitSha: gitSha,
        },
        {
          afterCopyChunk: async (destination: string) => {
            if (destination !== "api-worker.mjs" || mutated) return;
            mutated = true;
            await writeFile(join(fixture.downloadRoot, `${prefix}api-worker.mjs`), "changed");
          },
        },
      ),
    ).rejects.toThrow(/changed|match/i);
    expect((await readdir(fixture.parent)).some((name) => name.startsWith(".hereisit-"))).toBe(
      false,
    );
    await expect(lstat(fixture.outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not replace an existing output directory", async () => {
    const fixture = await createCandidateFixture();
    const marker = join(fixture.outputRoot, "owner-marker");
    await mkdir(fixture.outputRoot);
    await writeFile(marker, "owner");

    await expect(
      materializeProcessingReleaseCandidate({
        releaseTag,
        downloadRoot: fixture.downloadRoot,
        outputRoot: fixture.outputRoot,
        expectedGitSha: gitSha,
      }),
    ).rejects.toThrow(/exist|reserve|publish/i);
    expect(await readFile(marker, "utf8")).toBe("owner");
  });

  it("does not replace an empty directory created at the exact publication race", async () => {
    const fixture = await createCandidateFixture();
    await expect(
      materializeProcessingReleaseCandidate(
        {
          releaseTag,
          downloadRoot: fixture.downloadRoot,
          outputRoot: fixture.outputRoot,
          expectedGitSha: gitSha,
        },
        { beforeReserve: () => mkdir(fixture.outputRoot) },
      ),
    ).rejects.toThrow(/exist|reserve|publish/i);

    expect((await lstat(fixture.outputRoot)).isDirectory()).toBe(true);
    expect(await readdir(fixture.outputRoot)).toEqual([]);
  });

  it("emits a stable CLI error without private paths", () => {
    const privatePath = "/tmp/private-customer-file";
    const result = spawnSync(
      process.execPath,
      [
        resolve("scripts/materialize-processing-release-candidate.mjs"),
        "--download-root",
        privatePath,
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("processing release candidate materialization failed\n");
    expect(result.stderr).not.toContain(privatePath);
  });
});
