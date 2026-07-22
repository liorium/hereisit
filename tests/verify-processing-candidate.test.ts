import { readFileSync, watch } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync, zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { createDeterministicTreeArchive } from "../scripts/create-deterministic-tree-archive.mjs";
import { createLiveCostModel } from "../scripts/create-live-cost-model.mjs";
import {
  createBuiltProcessingCandidate,
  runProcessingCandidateCreator,
} from "../scripts/create-processing-candidate.mjs";
import { createProcessingReleaseInputs } from "../scripts/create-processing-release-inputs.mjs";
import {
  finalizeProcessingCandidate,
  runProcessingCandidateFinalizer,
} from "../scripts/finalize-processing-candidate.mjs";
import { canonicalJson, sha256Bytes, sha256Canonical } from "../scripts/image-lab-common.mjs";
import {
  inspectDockerImageArchive,
  inspectOciImageArchive,
} from "../scripts/verify-image-archive-identities.mjs";
import {
  runProcessingCandidateVerifier,
  verifyProcessingCandidate,
} from "../scripts/verify-processing-candidate.mjs";

const releaseId = "2026-07-20.1";
const gitSha = "a".repeat(40);
const temporaryRoots: string[] = [];
const securityScopes = ["engine", "web-staging", "web-production", "worker", "lockfile"] as const;
const securityKeys = ["engine", "webStaging", "webProduction", "worker", "lockfile"] as const;
type MutableSecurityGate = {
  artifactSha256: string;
  pnpmVersion: string;
  scanner: { databaseDigest: string };
  scans: Array<{ reportSha256: string; scope: string }>;
  scopes: {
    engine: { sbomSha256: string };
    worker: { artifactSha256: string };
  };
};

function rewriteTarChecksum(header: Buffer) {
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
}

async function createFixture({ ociCompression }: { ociCompression?: "gzip" | "zstd" } = {}) {
  const parent = await mkdtemp(join(tmpdir(), "hereisit-candidate-verifier-"));
  temporaryRoots.push(parent);
  const root = join(parent, "candidate");
  const build = join(parent, "build");
  await mkdir(root);
  await mkdir(build);

  const createWeb = async (environment: "staging" | "production") => {
    const tree = join(build, `web-${environment}`);
    await mkdir(tree);
    await writeFile(join(tree, "index.html"), `<h1>${environment}</h1>\n`);
    const archive = join(root, `web-${environment}.tar`);
    const result = await createDeterministicTreeArchive({ root: tree, output: archive });
    return { archive, ...result };
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
  const distributionLayerBytes =
    ociCompression === "gzip"
      ? gzipSync(layerBytes, { mtime: 0 })
      : ociCompression === "zstd"
        ? zstdCompressSync(layerBytes)
        : layerBytes;
  const distributionLayerDigest = `sha256:${sha256Bytes(distributionLayerBytes)}`;
  const distributionLayerMediaType = `application/vnd.oci.image.layer.v1.tar${
    ociCompression === undefined ? "" : `+${ociCompression}`
  }`;
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
          mediaType: distributionLayerMediaType,
          digest: distributionLayerDigest,
          size: distributionLayerBytes.byteLength,
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
  await writeFile(
    join(ociTree, "blobs", "sha256", distributionLayerDigest.slice(7)),
    distributionLayerBytes,
  );
  const ociArchive = join(root, "image-engine-linux-amd64.oci.tar");
  await createDeterministicTreeArchive({ root: ociTree, output: ociArchive });

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
  const dockerArchive = join(root, "image-engine-linux-amd64.docker.tar");
  await createDeterministicTreeArchive({ root: dockerTree, output: dockerArchive });

  const fileBytes: Record<string, Buffer> = {
    "live-cost-model.json": Buffer.from(
      canonicalJson(
        createLiveCostModel(
          JSON.parse(await readFile("tests/fixtures/live-cost-model-pr-input.json", "utf8")),
        ),
      ),
    ),
    "processing-release-inputs.json": Buffer.from(
      canonicalJson(
        createProcessingReleaseInputs({
          version: 1,
          releaseId,
          baseSourceSha256: "1".repeat(64),
          reviewedAt: "2026-07-20T00:00:00.000Z",
          reviewerIdHash: "2".repeat(64),
          pricesAndResources: {
            version: 1,
            artifactSha256: "3".repeat(64),
            modelInput: (() => {
              const { routeCpuBenchmark: _route, ...modelInput } = JSON.parse(
                readFileSync("tests/fixtures/live-cost-model-pr-input.json", "utf8"),
              );
              return modelInput;
            })(),
          },
          ceilings: {
            maxCostPer1000JobsMicrousd: 500_000,
            maxProjectedMonthlyCostMicrousd: 5_000_000,
          },
          routeCpuBenchmark: {
            artifactSha256: "4".repeat(64),
            ...JSON.parse(readFileSync("tests/fixtures/live-cost-model-pr-input.json", "utf8"))
              .routeCpuBenchmark,
          },
        }),
      ),
    ),
    "processing-release-report.json": Buffer.from('{"passed":true}\n'),
    "image-engine-linux-amd64.oci.tar": await readFile(ociArchive),
    "image-engine-linux-amd64.docker.tar": await readFile(dockerArchive),
    "api-worker.mjs": Buffer.from("export default {};\n"),
    [`evidence-v1--${releaseId}--processing-evidence.json`]: Buffer.from('{"signed":true}\n'),
    [`evidence-v1--${releaseId}--processing-evidence.sig`]: Buffer.from("signature\n"),
  };
  const artifactHashes = {
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
    await writeFile(join(root, path), bytes, { mode: 0o600 });
  }
  const artifact = (path: string) => ({
    path,
    sizeBytes: fileBytes[path].byteLength,
    sha256: sha256Bytes(fileBytes[path]),
  });
  const webIdentity = (environment: "staging" | "production", value: typeof staging) => ({
    archiveSha256: value.archiveSha256,
    treeSha256: value.treeSha256,
    processingApiOrigin: `https://hereisit-processing-${environment}.example.workers.dev`,
  });
  const stagingIdentity = webIdentity("staging", staging);
  const productionIdentity = webIdentity("production", production);
  const payload = {
    schema: "hereisit-processing-candidate@1",
    version: 1,
    state: "finalized",
    releaseId,
    gitSha,
    engine: {
      loadedImage: `hereisit-image-engine:${gitSha}`,
      oci: {
        configDigest,
        distributionLayerDigests: [distributionLayerDigest],
        diffIds: [diffId],
      },
      docker: {
        configDigest,
        diffIds: [diffId],
      },
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
          sizeBytes: (await readFile(staging.archive)).byteLength,
          ...stagingIdentity,
        },
        production: {
          path: "web-production.tar",
          sizeBytes: (await readFile(production.archive)).byteLength,
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
  const candidate = {
    ...payload,
    verificationSha256: sha256Canonical(payload),
  };
  const manifestPath = join(root, "processing-candidate.json");
  await writeFile(manifestPath, canonicalJson(candidate), { mode: 0o600 });
  return { parent, root, manifestPath, candidate };
}

async function bindChangedDockerArchive(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  archiveBytes: Buffer,
) {
  await writeFile(join(fixture.root, "image-engine-linux-amd64.docker.tar"), archiveBytes);
  const { verificationSha256: _verificationSha256, ...unsigned } = fixture.candidate;
  const payload = {
    ...unsigned,
    releaseAssets: {
      ...unsigned.releaseAssets,
      engine: {
        ...unsigned.releaseAssets.engine,
        docker: {
          ...unsigned.releaseAssets.engine.docker,
          sizeBytes: archiveBytes.byteLength,
          sha256: sha256Bytes(archiveBytes),
        },
      },
    },
  };
  await writeFile(
    fixture.manifestPath,
    canonicalJson({ ...payload, verificationSha256: sha256Canonical(payload) }),
  );
}

function builtOptions(fixture: Awaited<ReturnType<typeof createFixture>>, outputRoot: string) {
  return {
    sourceRoot: fixture.root,
    outputRoot,
    releaseId,
    gitSha,
    stagingProcessingApiOrigin: fixture.candidate.web.staging.processingApiOrigin,
    productionProcessingApiOrigin: fixture.candidate.web.production.processingApiOrigin,
    stagingWebTreeSha256: fixture.candidate.web.staging.treeSha256,
    productionWebTreeSha256: fixture.candidate.web.production.treeSha256,
    trivyDbDigest: fixture.candidate.security.trivyDbDigest,
    providerUsageSchemaPath: resolve("docs/deployment/provider-usage-schema.v1.json"),
  };
}

async function bindChangedSecurityGate(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  key: "imageEngine" | "applicationSupplyChain" | "vulnerability",
  bytes: Buffer,
) {
  const path = fixture.candidate.releaseAssets.security.gates[key].path;
  await writeFile(join(fixture.root, path), bytes);
  const { verificationSha256: _verificationSha256, ...unsigned } = fixture.candidate;
  const payload = {
    ...unsigned,
    releaseAssets: {
      ...unsigned.releaseAssets,
      security: {
        ...unsigned.releaseAssets.security,
        gates: {
          ...unsigned.releaseAssets.security.gates,
          [key]: { path, sizeBytes: bytes.byteLength, sha256: sha256Bytes(bytes) },
        },
      },
    },
  };
  await writeFile(
    fixture.manifestPath,
    canonicalJson({ ...payload, verificationSha256: sha256Canonical(payload) }),
  );
}

async function verifyFixture(fixture: Awaited<ReturnType<typeof createFixture>>) {
  return verifyProcessingCandidate({
    manifestPath: fixture.manifestPath,
    root: fixture.root,
    requiredState: "finalized",
    expectedGitSha: gitSha,
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("processing candidate verifier", () => {
  it("atomically finalizes a verified built candidate with report and evidence bytes", async () => {
    const fixture = await createFixture();
    const builtRoot = join(fixture.parent, "built-for-finalization");
    const finalizedRoot = join(fixture.parent, "finalized-candidate");
    await createBuiltProcessingCandidate({
      sourceRoot: fixture.root,
      outputRoot: builtRoot,
      releaseId,
      gitSha,
      stagingProcessingApiOrigin: fixture.candidate.web.staging.processingApiOrigin,
      productionProcessingApiOrigin: fixture.candidate.web.production.processingApiOrigin,
      stagingWebTreeSha256: fixture.candidate.web.staging.treeSha256,
      productionWebTreeSha256: fixture.candidate.web.production.treeSha256,
      trivyDbDigest: fixture.candidate.security.trivyDbDigest,
      providerUsageSchemaPath: resolve("docs/deployment/provider-usage-schema.v1.json"),
    });

    const finalized = await finalizeProcessingCandidate({
      builtRoot,
      outputRoot: finalizedRoot,
      reportPath: join(fixture.root, "processing-release-report.json"),
      evidenceBundlePath: join(fixture.root, `evidence-v1--${releaseId}--processing-evidence.json`),
      evidenceSignaturePath: join(
        fixture.root,
        `evidence-v1--${releaseId}--processing-evidence.sig`,
      ),
    });

    expect(finalized).toMatchObject({ state: "finalized", releaseId, gitSha });
    await expect(
      verifyProcessingCandidate({
        manifestPath: join(finalizedRoot, "processing-candidate.json"),
        root: finalizedRoot,
        requiredState: "finalized",
        expectedGitSha: gitSha,
      }),
    ).resolves.toMatchObject({ state: "finalized", assetCount: 23 });
  });

  it("finalizes through an exact content-free CLI boundary", async () => {
    const fixture = await createFixture();
    const builtRoot = join(fixture.parent, "cli-built-for-finalization");
    const finalizedRoot = join(fixture.parent, "cli-finalized-candidate");
    await createBuiltProcessingCandidate({
      sourceRoot: fixture.root,
      outputRoot: builtRoot,
      releaseId,
      gitSha,
      stagingProcessingApiOrigin: fixture.candidate.web.staging.processingApiOrigin,
      productionProcessingApiOrigin: fixture.candidate.web.production.processingApiOrigin,
      stagingWebTreeSha256: fixture.candidate.web.staging.treeSha256,
      productionWebTreeSha256: fixture.candidate.web.production.treeSha256,
      trivyDbDigest: fixture.candidate.security.trivyDbDigest,
      providerUsageSchemaPath: resolve("docs/deployment/provider-usage-schema.v1.json"),
    });
    const writes: string[] = [];

    await runProcessingCandidateFinalizer(
      [
        "--built-root",
        builtRoot,
        "--output-root",
        finalizedRoot,
        "--report",
        join(fixture.root, "processing-release-report.json"),
        "--evidence-bundle",
        join(fixture.root, `evidence-v1--${releaseId}--processing-evidence.json`),
        "--evidence-signature",
        join(fixture.root, `evidence-v1--${releaseId}--processing-evidence.sig`),
      ],
      {
        write(value: string) {
          writes.push(value);
        },
      },
    );

    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0])).toEqual({
      schema: "hereisit-processing-candidate-finalization@1",
      version: 1,
      state: "finalized",
      releaseId,
      gitSha,
    });
    expect(writes[0]).not.toContain(fixture.root);
    expect(writes[0]).not.toContain("evidence-v1");
  });

  it("rejects candidate outputs nested inside their immutable source roots", async () => {
    const fixture = await createFixture();
    await expect(
      createBuiltProcessingCandidate({
        sourceRoot: fixture.root,
        outputRoot: join(fixture.root, "nested-built"),
        releaseId,
        gitSha,
        stagingProcessingApiOrigin: fixture.candidate.web.staging.processingApiOrigin,
        productionProcessingApiOrigin: fixture.candidate.web.production.processingApiOrigin,
        stagingWebTreeSha256: fixture.candidate.web.staging.treeSha256,
        productionWebTreeSha256: fixture.candidate.web.production.treeSha256,
        trivyDbDigest: fixture.candidate.security.trivyDbDigest,
        providerUsageSchemaPath: resolve("docs/deployment/provider-usage-schema.v1.json"),
      }),
    ).rejects.toThrow(/outside|source root/i);
  });

  it("atomically creates a minimal built candidate from verified source archives", async () => {
    const fixture = await createFixture({ ociCompression: "zstd" });
    const outputRoot = join(fixture.parent, "built-candidate");

    const created = await createBuiltProcessingCandidate({
      sourceRoot: fixture.root,
      outputRoot,
      releaseId,
      gitSha,
      stagingProcessingApiOrigin: fixture.candidate.web.staging.processingApiOrigin,
      productionProcessingApiOrigin: fixture.candidate.web.production.processingApiOrigin,
      stagingWebTreeSha256: fixture.candidate.web.staging.treeSha256,
      productionWebTreeSha256: fixture.candidate.web.production.treeSha256,
      trivyDbDigest: fixture.candidate.security.trivyDbDigest,
      providerUsageSchemaPath: resolve("docs/deployment/provider-usage-schema.v1.json"),
    });

    expect(created).toMatchObject({
      state: "built",
      releaseId,
      gitSha,
      releaseInputs: {
        sha256: sha256Bytes(await readFile(join(fixture.root, "processing-release-inputs.json"))),
      },
      costModel: {
        sha256: sha256Bytes(await readFile(join(fixture.root, "live-cost-model.json"))),
      },
      releaseAssets: {
        releaseInputs: { path: "processing-release-inputs.json" },
        costModel: { path: "live-cost-model.json" },
      },
    });
    await expect(
      verifyProcessingCandidate({
        manifestPath: join(outputRoot, "processing-candidate.json"),
        root: outputRoot,
        requiredState: "built",
        expectedGitSha: gitSha,
      }),
    ).resolves.toMatchObject({ state: "built", assetCount: 20 });
    await expect(lstat(join(outputRoot, "processing-release-report.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      lstat(join(outputRoot, `evidence-v1--${releaseId}--processing-evidence.json`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates a built candidate through an exact content-free CLI boundary", async () => {
    const fixture = await createFixture();
    const outputRoot = join(fixture.parent, "cli-built-candidate");
    const writes: string[] = [];

    await runProcessingCandidateCreator(
      [
        "--source-root",
        fixture.root,
        "--output-root",
        outputRoot,
        "--release-id",
        releaseId,
        "--git-sha",
        gitSha,
        "--staging-processing-api-origin",
        fixture.candidate.web.staging.processingApiOrigin,
        "--production-processing-api-origin",
        fixture.candidate.web.production.processingApiOrigin,
        "--staging-web-tree-sha256",
        fixture.candidate.web.staging.treeSha256,
        "--production-web-tree-sha256",
        fixture.candidate.web.production.treeSha256,
        "--trivy-db-digest",
        fixture.candidate.security.trivyDbDigest,
        "--provider-usage-schema",
        resolve("docs/deployment/provider-usage-schema.v1.json"),
      ],
      {
        write(value: string) {
          writes.push(value);
        },
      },
    );

    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0])).toEqual({
      schema: "hereisit-processing-candidate-creation@1",
      version: 1,
      state: "built",
      releaseId,
      gitSha,
    });
    expect(writes[0]).not.toContain(fixture.root);
    expect(writes[0]).not.toContain("image-engine-linux-amd64");
  });

  it("removes partial output when a source identity fails verification", async () => {
    const fixture = await createFixture();
    const outputRoot = join(fixture.parent, "invalid-built-candidate");

    await expect(
      createBuiltProcessingCandidate({
        sourceRoot: fixture.root,
        outputRoot,
        releaseId,
        gitSha,
        stagingProcessingApiOrigin: fixture.candidate.web.staging.processingApiOrigin,
        productionProcessingApiOrigin: fixture.candidate.web.production.processingApiOrigin,
        stagingWebTreeSha256: "0".repeat(64),
        productionWebTreeSha256: fixture.candidate.web.production.treeSha256,
        trivyDbDigest: fixture.candidate.security.trivyDbDigest,
        providerUsageSchemaPath: resolve("docs/deployment/provider-usage-schema.v1.json"),
      }),
    ).rejects.toThrow(/tree|hash|staging/i);
    await expect(lstat(outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await readdir(fixture.parent)).some((name) => name.startsWith(".hereisit-built-")),
    ).toBe(false);
  });

  it("rejects a symbolic-link source asset without publishing output", async () => {
    const fixture = await createFixture();
    const outputRoot = join(fixture.parent, "linked-built-candidate");
    const workerPath = join(fixture.root, "api-worker.mjs");
    const workerBytes = await readFile(workerPath);
    await rm(workerPath);
    const outsideWorker = join(fixture.parent, "outside-worker.mjs");
    await writeFile(outsideWorker, workerBytes);
    await symlink(outsideWorker, workerPath);

    await expect(
      createBuiltProcessingCandidate({
        sourceRoot: fixture.root,
        outputRoot,
        releaseId,
        gitSha,
        stagingProcessingApiOrigin: fixture.candidate.web.staging.processingApiOrigin,
        productionProcessingApiOrigin: fixture.candidate.web.production.processingApiOrigin,
        stagingWebTreeSha256: fixture.candidate.web.staging.treeSha256,
        productionWebTreeSha256: fixture.candidate.web.production.treeSha256,
        trivyDbDigest: fixture.candidate.security.trivyDbDigest,
        providerUsageSchemaPath: resolve("docs/deployment/provider-usage-schema.v1.json"),
      }),
    ).rejects.toThrow(/api-worker|symbolic|source/i);
    await expect(lstat(outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an oversized sparse source before copying its bytes", async () => {
    const fixture = await createFixture();
    const outputRoot = join(fixture.parent, "oversized-built-candidate");
    const worker = await open(join(fixture.root, "api-worker.mjs"), "w");
    await worker.truncate(2 * 1024 * 1024 * 1024 + 1);
    await worker.close();

    await expect(
      createBuiltProcessingCandidate({
        sourceRoot: fixture.root,
        outputRoot,
        releaseId,
        gitSha,
        stagingProcessingApiOrigin: fixture.candidate.web.staging.processingApiOrigin,
        productionProcessingApiOrigin: fixture.candidate.web.production.processingApiOrigin,
        stagingWebTreeSha256: fixture.candidate.web.staging.treeSha256,
        productionWebTreeSha256: fixture.candidate.web.production.treeSha256,
        trivyDbDigest: fixture.candidate.security.trivyDbDigest,
        providerUsageSchemaPath: resolve("docs/deployment/provider-usage-schema.v1.json"),
      }),
    ).rejects.toThrow(/api-worker|regular|size/i);
    await expect(lstat(outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    [
      "missing",
      async (_fixture: Awaited<ReturnType<typeof createFixture>>, path: string) => rm(path),
    ],
    [
      "symbolic",
      async (fixture: Awaited<ReturnType<typeof createFixture>>, path: string) => {
        const outside = join(fixture.parent, "outside-security-gate.json");
        await writeFile(outside, await readFile(path));
        await rm(path);
        await symlink(outside, path);
      },
    ],
    [
      "oversized",
      async (_fixture: Awaited<ReturnType<typeof createFixture>>, path: string) => {
        const handle = await open(path, "w");
        await handle.truncate(1024 * 1024 + 1);
        await handle.close();
      },
    ],
  ])("rejects a %s canonical security source without publishing", async (_label, mutate) => {
    const fixture = await createFixture();
    const outputRoot = join(fixture.parent, `invalid-security-${_label}`);
    await mutate(fixture, join(fixture.root, "security-image-engine-license-gate.json"));
    await expect(createBuiltProcessingCandidate(builtOptions(fixture, outputRoot))).rejects.toThrow(
      /security-image-engine|source|symbolic|regular|read/i,
    );
    await expect(lstat(outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a live cost model that does not reproduce the reviewed release inputs", async () => {
    const fixture = await createFixture();
    const outputRoot = join(fixture.parent, "drifted-cost-built-candidate");
    const costPath = join(fixture.root, "live-cost-model.json");
    const costModel = JSON.parse(await readFile(costPath, "utf8"));
    await writeFile(
      costPath,
      canonicalJson({ ...costModel, projectedMonthlyJobs: costModel.projectedMonthlyJobs + 1 }),
    );

    await expect(
      createBuiltProcessingCandidate({
        sourceRoot: fixture.root,
        outputRoot,
        releaseId,
        gitSha,
        stagingProcessingApiOrigin: fixture.candidate.web.staging.processingApiOrigin,
        productionProcessingApiOrigin: fixture.candidate.web.production.processingApiOrigin,
        stagingWebTreeSha256: fixture.candidate.web.staging.treeSha256,
        productionWebTreeSha256: fixture.candidate.web.production.treeSha256,
        trivyDbDigest: fixture.candidate.security.trivyDbDigest,
        providerUsageSchemaPath: resolve("docs/deployment/provider-usage-schema.v1.json"),
      }),
    ).rejects.toThrow(/cost model.*release inputs|reviewed/i);
    await expect(lstat(outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects non-canonical or oversized financial input documents", async () => {
    const nonCanonical = await createFixture();
    await writeFile(
      join(nonCanonical.root, "processing-release-inputs.json"),
      `${await readFile(join(nonCanonical.root, "processing-release-inputs.json"), "utf8")} `,
    );
    await expect(
      createBuiltProcessingCandidate({
        sourceRoot: nonCanonical.root,
        outputRoot: join(nonCanonical.parent, "noncanonical-built-candidate"),
        releaseId,
        gitSha,
        stagingProcessingApiOrigin: nonCanonical.candidate.web.staging.processingApiOrigin,
        productionProcessingApiOrigin: nonCanonical.candidate.web.production.processingApiOrigin,
        stagingWebTreeSha256: nonCanonical.candidate.web.staging.treeSha256,
        productionWebTreeSha256: nonCanonical.candidate.web.production.treeSha256,
        trivyDbDigest: nonCanonical.candidate.security.trivyDbDigest,
        providerUsageSchemaPath: resolve("docs/deployment/provider-usage-schema.v1.json"),
      }),
    ).rejects.toThrow(/canonical/i);

    const oversized = await createFixture();
    const releaseInputs = await open(join(oversized.root, "processing-release-inputs.json"), "w");
    await releaseInputs.truncate(1024 * 1024 + 1);
    await releaseInputs.close();
    await expect(
      createBuiltProcessingCandidate({
        sourceRoot: oversized.root,
        outputRoot: join(oversized.parent, "oversized-input-built-candidate"),
        releaseId,
        gitSha,
        stagingProcessingApiOrigin: oversized.candidate.web.staging.processingApiOrigin,
        productionProcessingApiOrigin: oversized.candidate.web.production.processingApiOrigin,
        stagingWebTreeSha256: oversized.candidate.web.staging.treeSha256,
        productionWebTreeSha256: oversized.candidate.web.production.treeSha256,
        trivyDbDigest: oversized.candidate.security.trivyDbDigest,
        providerUsageSchemaPath: resolve("docs/deployment/provider-usage-schema.v1.json"),
      }),
    ).rejects.toThrow(/processing-release-inputs|regular|size/i);
  });

  it("derives OCI and Docker identities from the unsigned archive bytes", async () => {
    const fixture = await createFixture({ ociCompression: "zstd" });

    await expect(
      inspectOciImageArchive({
        archivePath: join(fixture.root, fixture.candidate.releaseAssets.engine.oci.path),
        asset: fixture.candidate.releaseAssets.engine.oci,
      }),
    ).resolves.toEqual(fixture.candidate.engine.oci);
    await expect(
      inspectDockerImageArchive({
        archivePath: join(fixture.root, fixture.candidate.releaseAssets.engine.docker.path),
        asset: fixture.candidate.releaseAssets.engine.docker,
        expectedRepoTag: fixture.candidate.engine.loadedImage,
      }),
    ).resolves.toEqual(fixture.candidate.engine.docker);
  });

  it("verifies every release asset and both deterministic Pages trees", async () => {
    const fixture = await createFixture();

    await expect(
      verifyProcessingCandidate({
        manifestPath: fixture.manifestPath,
        root: fixture.root,
        requiredState: "finalized",
        expectedGitSha: gitSha,
      }),
    ).resolves.toEqual({
      schema: "hereisit-processing-candidate-verification@1",
      version: 1,
      state: "finalized",
      releaseId,
      gitSha,
      assetCount: 23,
      web: {
        staging: expect.objectContaining({ treeSha256: fixture.candidate.web.staging.treeSha256 }),
        production: expect.objectContaining({
          treeSha256: fixture.candidate.web.production.treeSha256,
        }),
      },
    });
  });

  it.each([
    "gzip",
    "zstd",
  ] as const)("derives the OCI DiffID through %s layer decompression", async (ociCompression) => {
    const fixture = await createFixture({ ociCompression });

    await expect(
      verifyProcessingCandidate({
        manifestPath: fixture.manifestPath,
        root: fixture.root,
        requiredState: "finalized",
        expectedGitSha: gitSha,
      }),
    ).resolves.toMatchObject({ state: "finalized", assetCount: 23 });
  });

  it.each([
    ["wrong required state", { requiredState: "built" }],
    ["wrong source SHA", { expectedGitSha: "f".repeat(40) }],
  ])("rejects %s", async (_label, override) => {
    const fixture = await createFixture();
    await expect(
      verifyProcessingCandidate({
        manifestPath: fixture.manifestPath,
        root: fixture.root,
        requiredState: "finalized",
        expectedGitSha: gitSha,
        ...override,
      }),
    ).rejects.toThrow(/state|SHA/i);
  });

  it("rejects changed asset bytes before claiming the candidate is verified", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.root, "api-worker.mjs"), "tampered\n");
    await expect(
      verifyProcessingCandidate({
        manifestPath: fixture.manifestPath,
        root: fixture.root,
        requiredState: "finalized",
        expectedGitSha: gitSha,
      }),
    ).rejects.toThrow(/Worker|size|hash/i);
  });

  it("rejects tampered raw security evidence before gate interpretation", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.root, "security-sbom-worker.cdx.json"), "tampered\n");
    await expect(verifyFixture(fixture)).rejects.toThrow(/worker.*security.*(?:size|hash)/i);
  });

  it("rejects noncanonical, malformed, or extra-field security gates", async () => {
    for (const change of [
      (gate: Record<string, unknown>) => Buffer.from(`${canonicalJson(gate)} `),
      () => Buffer.from("{not-json}\n"),
      (gate: Record<string, unknown>) => Buffer.from(canonicalJson({ ...gate, extra: true })),
    ]) {
      const fixture = await createFixture();
      const path = join(fixture.root, "security-image-engine-license-gate.json");
      const gate = JSON.parse(await readFile(path, "utf8"));
      await bindChangedSecurityGate(fixture, "imageEngine", change(gate));
      await expect(verifyFixture(fixture)).rejects.toThrow(/canonical|JSON|fields/i);
    }
  });

  it("cross-checks gate configuration, scope, artifact, SBOM, report, and database identities", async () => {
    const cases = [
      ["imageEngine", (gate: MutableSecurityGate) => (gate.artifactSha256 = "f".repeat(64))],
      ["applicationSupplyChain", (gate: MutableSecurityGate) => (gate.pnpmVersion = "11.10.0")],
      [
        "applicationSupplyChain",
        (gate: MutableSecurityGate) => (gate.scopes.worker.artifactSha256 = "f".repeat(64)),
      ],
      [
        "applicationSupplyChain",
        (gate: MutableSecurityGate) => (gate.scopes.engine.sbomSha256 = "f".repeat(64)),
      ],
      [
        "vulnerability",
        (gate: MutableSecurityGate) => (gate.scanner.databaseDigest = `sha256:${"f".repeat(64)}`),
      ],
      ["vulnerability", (gate: MutableSecurityGate) => (gate.scans[0].scope = "worker")],
      [
        "vulnerability",
        (gate: MutableSecurityGate) => (gate.scans[0].reportSha256 = "f".repeat(64)),
      ],
    ] as const;
    for (const [key, mutate] of cases) {
      const fixture = await createFixture();
      const path = join(fixture.root, fixture.candidate.releaseAssets.security.gates[key].path);
      const gate = JSON.parse(await readFile(path, "utf8"));
      mutate(gate);
      await bindChangedSecurityGate(fixture, key, Buffer.from(canonicalJson(gate)));
      await expect(verifyFixture(fixture)).rejects.toThrow(
        /identity|artifact|SBOM|report|database|scope|pnpm/i,
      );
    }
  });

  it("rejects security evidence drift before finalization", async () => {
    const fixture = await createFixture();
    const builtRoot = join(fixture.parent, "security-drift-built");
    await createBuiltProcessingCandidate(builtOptions(fixture, builtRoot));
    await writeFile(join(builtRoot, "security-trivy-lockfile.json"), "drifted\n");
    await expect(
      finalizeProcessingCandidate({
        builtRoot,
        outputRoot: join(fixture.parent, "security-drift-finalized"),
        reportPath: join(fixture.root, "processing-release-report.json"),
        evidenceBundlePath: join(
          fixture.root,
          `evidence-v1--${releaseId}--processing-evidence.json`,
        ),
        evidenceSignaturePath: join(
          fixture.root,
          `evidence-v1--${releaseId}--processing-evidence.sig`,
        ),
      }),
    ).rejects.toThrow(/lockfile.*security.*(?:size|hash)/i);
  });

  it("rejects same-size security evidence writes that race candidate creation", async () => {
    const fixture = await createFixture();
    const sbomPath = join(fixture.root, "security-sbom-engine.cdx.json");
    const sbomBytes = Buffer.alloc(8 * 1024 * 1024, "a");
    await writeFile(sbomPath, sbomBytes);
    const gatePath = join(fixture.root, "security-application-supply-chain-gate.json");
    const gate = JSON.parse(await readFile(gatePath, "utf8"));
    gate.scopes.engine.sbomSha256 = sha256Bytes(sbomBytes);
    await writeFile(gatePath, canonicalJson(gate));

    let settled = false;
    let creationError: unknown;
    const outputRoot = join(fixture.parent, "same-size-race-built");
    const creation = createBuiltProcessingCandidate(builtOptions(fixture, outputRoot))
      .catch((error: unknown) => {
        creationError = error;
      })
      .finally(() => {
        settled = true;
      });
    const writer = await open(sbomPath, "r+");
    try {
      let offset = 0;
      while (!settled) {
        await writer.write(Buffer.from("a"), 0, 1, offset);
        offset = (offset + 4096) % sbomBytes.byteLength;
        await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
      }
    } finally {
      await writer.close();
    }

    await creation;
    expect(creationError).toBeInstanceOf(TypeError);
    expect((creationError as Error).message).toMatch(/changed while reading/i);
    await expect(lstat(outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps security evidence bounded when finalization reopens verified files", async () => {
    const fixture = await createFixture();
    const builtRoot = join(fixture.parent, "bounded-security-built");
    await createBuiltProcessingCandidate(builtOptions(fixture, builtRoot));
    const outputRoot = join(fixture.parent, "bounded-security-finalized");
    const target = join(builtRoot, "security-trivy-lockfile.json");
    const watcher = watch(fixture.parent);
    const temporaryCreated = new Promise<void>((resolveCreated) => {
      watcher.on("change", (_event, name) => {
        if (String(name).startsWith(".hereisit-finalized-candidate-")) resolveCreated();
      });
    });
    const finalization = finalizeProcessingCandidate({
      builtRoot,
      outputRoot,
      reportPath: join(fixture.root, "processing-release-report.json"),
      evidenceBundlePath: join(fixture.root, `evidence-v1--${releaseId}--processing-evidence.json`),
      evidenceSignaturePath: join(
        fixture.root,
        `evidence-v1--${releaseId}--processing-evidence.sig`,
      ),
    });
    try {
      await temporaryCreated;
      const handle = await open(target, "w");
      await handle.truncate(8 * 1024 * 1024 + 1);
      await handle.close();
      await expect(finalization).rejects.toThrow(/lockfile.*bounded regular file/i);
    } finally {
      watcher.close();
    }
    await expect(lstat(outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recomputes the OCI distribution-layer identity from the archive", async () => {
    const fixture = await createFixture();
    const { verificationSha256: _verificationSha256, ...unsigned } = fixture.candidate;
    const payload = {
      ...unsigned,
      engine: {
        ...unsigned.engine,
        oci: {
          ...unsigned.engine.oci,
          distributionLayerDigests: [`sha256:${"f".repeat(64)}`],
        },
      },
    };
    await writeFile(
      fixture.manifestPath,
      canonicalJson({ ...payload, verificationSha256: sha256Canonical(payload) }),
    );

    await expect(
      verifyProcessingCandidate({
        manifestPath: fixture.manifestPath,
        root: fixture.root,
        requiredState: "finalized",
        expectedGitSha: gitSha,
      }),
    ).rejects.toThrow(/OCI|distribution|archive|identity/i);
  });

  it("recomputes Docker layer DiffIDs instead of trusting the signed manifest", async () => {
    const fixture = await createFixture();
    const archivePath = join(fixture.root, "image-engine-linux-amd64.docker.tar");
    const archiveBytes = await readFile(archivePath);
    const marker = Buffer.from("canonical uncompressed layer tar bytes\n");
    const markerOffset = archiveBytes.indexOf(marker);
    expect(markerOffset).toBeGreaterThanOrEqual(0);
    archiveBytes[markerOffset] ^= 1;
    await bindChangedDockerArchive(fixture, archiveBytes);

    await expect(
      verifyProcessingCandidate({
        manifestPath: fixture.manifestPath,
        root: fixture.root,
        requiredState: "finalized",
        expectedGitSha: gitSha,
      }),
    ).rejects.toThrow(/Docker.*(?:layer|DiffID|rootfs)/i);
  });

  it.each([
    [
      "symbolic-link member",
      (archiveBytes: Buffer) => {
        archiveBytes[156] = "2".charCodeAt(0);
        rewriteTarChecksum(archiveBytes.subarray(0, 512));
      },
    ],
    [
      "path escape",
      (archiveBytes: Buffer) => {
        archiveBytes.fill(0, 0, 100);
        archiveBytes.write("../escape", 0, "utf8");
        rewriteTarChecksum(archiveBytes.subarray(0, 512));
      },
    ],
  ])("rejects a Docker tar %s", async (_label, mutate) => {
    const fixture = await createFixture();
    const archiveBytes = await readFile(join(fixture.root, "image-engine-linux-amd64.docker.tar"));
    mutate(archiveBytes);
    await bindChangedDockerArchive(fixture, archiveBytes);

    await expect(
      verifyProcessingCandidate({
        manifestPath: fixture.manifestPath,
        root: fixture.root,
        requiredState: "finalized",
        expectedGitSha: gitSha,
      }),
    ).rejects.toThrow(/Docker|tar|member|canonical/i);
  });

  it("rejects symbolic-link manifests, roots, and release assets", async () => {
    const manifestFixture = await createFixture();
    const manifestLink = join(manifestFixture.parent, "manifest-link.json");
    await symlink(manifestFixture.manifestPath, manifestLink);
    await expect(
      verifyProcessingCandidate({
        manifestPath: manifestLink,
        root: manifestFixture.root,
        requiredState: "finalized",
        expectedGitSha: gitSha,
      }),
    ).rejects.toThrow(/manifest|root|symbolic|canonical/i);

    const rootFixture = await createFixture();
    const rootLink = join(rootFixture.parent, "root-link");
    await symlink(rootFixture.root, rootLink);
    await expect(
      verifyProcessingCandidate({
        manifestPath: join(rootLink, "processing-candidate.json"),
        root: rootLink,
        requiredState: "finalized",
        expectedGitSha: gitSha,
      }),
    ).rejects.toThrow(/root|symbolic|canonical/i);

    const assetFixture = await createFixture();
    const workerPath = join(assetFixture.root, "api-worker.mjs");
    const workerBytes = await readFile(workerPath);
    await rm(workerPath);
    const outside = join(assetFixture.parent, "worker.mjs");
    await writeFile(outside, workerBytes);
    await symlink(outside, workerPath);
    await expect(
      verifyProcessingCandidate({
        manifestPath: assetFixture.manifestPath,
        root: assetFixture.root,
        requiredState: "finalized",
        expectedGitSha: gitSha,
      }),
    ).rejects.toThrow(/Worker|symbolic|regular/i);

    const engineFixture = await createFixture();
    const enginePath = join(engineFixture.root, "image-engine-linux-amd64.oci.tar");
    const engineBytes = await readFile(enginePath);
    await rm(enginePath);
    const outsideEngine = join(engineFixture.parent, "engine.oci.tar");
    await writeFile(outsideEngine, engineBytes);
    await symlink(outsideEngine, enginePath);
    await expect(
      verifyProcessingCandidate({
        manifestPath: engineFixture.manifestPath,
        root: engineFixture.root,
        requiredState: "finalized",
        expectedGitSha: gitSha,
      }),
    ).rejects.toThrow(/OCI|symbolic|regular/i);
  });

  it("prints only a content-free verification summary at the CLI boundary", async () => {
    const fixture = await createFixture();
    const writes: string[] = [];
    await runProcessingCandidateVerifier(
      [
        "--manifest",
        fixture.manifestPath,
        "--root",
        fixture.root,
        "--required-state",
        "finalized",
        "--expected-git-sha",
        gitSha,
      ],
      {
        write(value: string) {
          writes.push(value);
        },
      },
    );
    expect(writes).toHaveLength(1);
    const summary = JSON.parse(writes[0]);
    expect(summary).toMatchObject({ state: "finalized", assetCount: 23 });
    expect(writes[0]).not.toContain("api-worker.mjs");
    expect(writes[0]).not.toContain(fixture.root);
  });
});
