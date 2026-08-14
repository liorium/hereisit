import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluatePdfEngineReleaseGate } from "../scripts/benchmark-pdf-engine.mjs";
import { createDeterministicTreeArchive } from "../scripts/create-deterministic-tree-archive.mjs";
import { createLiveCostModel } from "../scripts/create-live-cost-model.mjs";
import { createBuiltProcessingCandidate } from "../scripts/create-processing-candidate.mjs";
import { writeProcessingEvidenceBundle } from "../scripts/create-processing-evidence-bundle.mjs";
import { createProcessingReleaseInputs } from "../scripts/create-processing-release-inputs.mjs";
import {
  createAndWriteProcessingReleaseReport,
  runProcessingReleaseReportCreatorCli,
} from "../scripts/create-processing-release-report.mjs";
import { finalizeProcessingCandidate } from "../scripts/finalize-processing-candidate.mjs";
import { canonicalJson, sha256Bytes, sha256Canonical } from "../scripts/image-lab-common.mjs";
import { signCanonicalProcessingEvidence } from "../scripts/processing-evidence-signature.mjs";
import {
  assertVerifiedProcessingCandidateManifest,
  verifyProcessingCandidate,
} from "../scripts/verify-processing-candidate.mjs";
import {
  runProcessingReleaseReportVerifierCli,
  verifyProcessingReleaseReport,
} from "../scripts/verify-processing-release-report.mjs";

const releaseId = "2026-07-20.1";
const gitSha = "a".repeat(40);
const now = "2026-07-20T12:00:00.000Z";
const temporaryRoots: string[] = [];
const securityScopes = [
  "engine",
  "pdf-engine",
  "web-staging",
  "web-production",
  "worker",
  "lockfile",
] as const;

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "hereisit-release-report-verify-"));
  temporaryRoots.push(parent);
  const source = join(parent, "source");
  const build = join(parent, "build");
  const candidateRoot = join(parent, "candidate");
  await mkdir(source);
  await mkdir(build);

  const makeWeb = async (environment: "staging" | "production") => {
    const tree = join(build, `web-${environment}`);
    await mkdir(tree);
    await writeFile(join(tree, "index.html"), `<h1>${environment}</h1>\n`);
    const output = join(source, `web-${environment}.tar`);
    return { output, ...(await createDeterministicTreeArchive({ root: tree, output })) };
  };
  const staging = await makeWeb("staging");
  const production = await makeWeb("production");

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
  const ociTree = join(build, "oci");
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
    output: join(source, "image-engine-linux-amd64.oci.tar"),
  });

  const dockerTree = join(build, "docker");
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
    output: join(source, "image-engine-linux-amd64.docker.tar"),
  });

  const pdfConfigBytes = Buffer.from(
    canonicalJson({
      architecture: "amd64",
      os: "linux",
      config: { Labels: { "app.hereisit.engine": "pdf" } },
      rootfs: { type: "layers", diff_ids: [diffId] },
    }),
  );
  const pdfConfigDigest = `sha256:${sha256Bytes(pdfConfigBytes)}`;
  const pdfManifestBytes = Buffer.from(
    canonicalJson({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        digest: pdfConfigDigest,
        size: pdfConfigBytes.byteLength,
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
  const pdfManifestDigest = `sha256:${sha256Bytes(pdfManifestBytes)}`;
  const pdfOciTree = join(build, "pdf-oci");
  await mkdir(join(pdfOciTree, "blobs", "sha256"), { recursive: true });
  await writeFile(join(pdfOciTree, "oci-layout"), canonicalJson({ imageLayoutVersion: "1.0.0" }));
  await writeFile(
    join(pdfOciTree, "index.json"),
    canonicalJson({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [
        {
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          digest: pdfManifestDigest,
          size: pdfManifestBytes.byteLength,
          platform: { os: "linux", architecture: "amd64" },
        },
      ],
    }),
  );
  await writeFile(join(pdfOciTree, "blobs", "sha256", pdfConfigDigest.slice(7)), pdfConfigBytes);
  await writeFile(
    join(pdfOciTree, "blobs", "sha256", pdfManifestDigest.slice(7)),
    pdfManifestBytes,
  );
  await writeFile(join(pdfOciTree, "blobs", "sha256", layerDigest.slice(7)), layerBytes);
  await createDeterministicTreeArchive({
    root: pdfOciTree,
    output: join(source, "pdf-engine-linux-amd64.oci.tar"),
  });
  const pdfDockerTree = join(build, "pdf-docker");
  await mkdir(join(pdfDockerTree, "layer"), { recursive: true });
  await writeFile(join(pdfDockerTree, "config.json"), pdfConfigBytes);
  await writeFile(join(pdfDockerTree, "layer", "layer.tar"), layerBytes);
  await writeFile(
    join(pdfDockerTree, "manifest.json"),
    canonicalJson([
      {
        Config: "config.json",
        RepoTags: [`hereisit-pdf-engine:${gitSha}`],
        Layers: ["layer/layer.tar"],
      },
    ]),
  );
  await createDeterministicTreeArchive({
    root: pdfDockerTree,
    output: join(source, "pdf-engine-linux-amd64.docker.tar"),
  });
  const pdfBenchmark = JSON.parse(
    await readFile("docs/deployment/pdf-engine-benchmark.json", "utf8"),
  );
  pdfBenchmark.identity.engineImageId = pdfConfigDigest;
  pdfBenchmark.identity.engineImageDigest = pdfConfigDigest;
  await writeFile(join(source, "pdf-engine-benchmark.json"), canonicalJson(pdfBenchmark));
  await writeFile(
    join(source, "pdf-engine-benchmark.schema.json"),
    await readFile("docs/deployment/pdf-engine-benchmark.schema.json"),
  );
  await writeFile(
    join(source, "pdf-engine-release-gate.json"),
    canonicalJson(evaluatePdfEngineReleaseGate(pdfBenchmark)),
  );
  await writeFile(
    join(source, "pdf-engine-release-gate.schema.json"),
    await readFile("docs/deployment/pdf-engine-release-gate.schema.json"),
  );

  const costModel = createLiveCostModel(
    JSON.parse(readFileSync("docs/deployment/processing-staging-cost-input.json", "utf8")),
  );
  const releaseInputs = createProcessingReleaseInputs({
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
          readFileSync("docs/deployment/processing-staging-cost-input.json", "utf8"),
        );
        return modelInput;
      })(),
    },
    ceilings: {
      maxCostPer1000JobsMicrousd: 500_000,
      maxLiveMedianOutputRatioBps: 8_000,
      maxLiveOriginalRetainedRateBps: 2_500,
      maxLiveP95WeightedUnits: 12_000,
      maxProjectedMonthlyCostMicrousd: 5_000_000,
    },
    routeCpuBenchmark: {
      artifactSha256: "4".repeat(64),
      ...JSON.parse(readFileSync("docs/deployment/processing-staging-cost-input.json", "utf8"))
        .routeCpuBenchmark,
    },
  });
  await writeFile(join(source, "live-cost-model.json"), canonicalJson(costModel));
  await writeFile(join(source, "processing-release-inputs.json"), canonicalJson(releaseInputs));
  await writeFile(join(source, "api-worker.mjs"), "export default {};\n");

  const artifactHashes = {
    engine: configDigest.slice(7),
    "pdf-engine": pdfConfigDigest.slice(7),
    "web-staging": staging.archiveSha256,
    "web-production": production.archiveSha256,
    worker: sha256Bytes(await readFile(join(source, "api-worker.mjs"))),
    lockfile: "6".repeat(64),
  };
  const sbomHashes: Record<string, string> = {};
  const trivyHashes: Record<string, string> = {};
  for (const scope of securityScopes) {
    const sbom = Buffer.from(canonicalJson({ bomFormat: "CycloneDX", scope }));
    const trivy = Buffer.from(canonicalJson({ scope }));
    await writeFile(join(source, `security-sbom-${scope}.cdx.json`), sbom);
    await writeFile(join(source, `security-trivy-${scope}.json`), trivy);
    sbomHashes[scope] = sha256Bytes(sbom);
    trivyHashes[scope] = sha256Bytes(trivy);
  }
  await writeFile(
    join(source, "security-image-engine-license-gate.json"),
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
  await writeFile(
    join(source, "security-pdf-engine-license-gate.json"),
    canonicalJson({
      schema: "hereisit-pdf-engine-license-gate@1",
      passed: true,
      qpdfVersion: "12.4.0",
      sourceSha256: "2783a032f443cc886dad41aa6d5fae3dabf23dec00ee7ec2cfb27ef67ebcf529",
      sourceLockSha256: "1".repeat(64),
      policySha256: "2".repeat(64),
      licenseSha256: "3".repeat(64),
      noticeSha256: "4".repeat(64),
    }),
  );
  await writeFile(
    join(source, "security-application-supply-chain-gate.json"),
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
  const trivyDbDigest = `sha256:${"d".repeat(64)}`;
  await writeFile(
    join(source, "security-vulnerability-gate.json"),
    canonicalJson({
      schemaVersion: "hereisit-vulnerability-gate@1",
      passed: true,
      scanner: {
        policySha256: "1".repeat(64),
        version: "0.69.3",
        image:
          "ghcr.io/aquasecurity/trivy@sha256:7228e304ae0f610a1fad937baa463598cadac0c2ac4027cc68f3a8b997115689",
        databaseDigest: trivyDbDigest,
      },
      exceptions: { engineSha256: "2".repeat(64), applicationSha256: "3".repeat(64) },
      scans: securityScopes.map((scope) => ({
        scope,
        artifactSha256: artifactHashes[scope],
        reportSha256: trivyHashes[scope],
        totalFindingCount: 0,
        highOrCriticalFindingCount: 0,
        usedExceptionCount: 0,
      })),
    }),
  );

  await createBuiltProcessingCandidate({
    sourceRoot: source,
    outputRoot: candidateRoot,
    releaseId,
    gitSha,
    stagingProcessingApiOrigin: "https://hereisit-processing-staging.example.workers.dev",
    productionProcessingApiOrigin: "https://api.hereisit.app",
    stagingWebTreeSha256: staging.treeSha256,
    productionWebTreeSha256: production.treeSha256,
    trivyDbDigest,
    providerUsageSchemaPath: resolve("docs/deployment/provider-usage-schema.v1.json"),
  });
  const candidateManifestPath = join(candidateRoot, "processing-candidate.json");
  const candidate = JSON.parse(await readFile(candidateManifestPath, "utf8"));

  const evidenceBundlePath = join(parent, "evidence.json");
  const evidenceSignaturePath = join(parent, "evidence.sig");
  await writeProcessingEvidenceBundle({
    output: evidenceBundlePath,
    releaseId,
    gitSha,
    candidateVerificationSha256: candidate.verificationSha256,
    createdAt: "2026-07-20T10:00:00.000Z",
    expiresAt: "2026-07-21T10:00:00.000Z",
    reports: {
      fullCorpusBenchmark: { passed: true },
      competitorComparison: { passed: true },
      blindedHumanReview: { passed: true },
      commercialReview: { passed: true },
      privacyReview: { passed: true },
      deviceMatrix: { passed: true },
    },
  });
  const pair = generateKeyPairSync("ed25519");
  const privateKeyPath = join(parent, "private.pem");
  const publicKeyPath = join(parent, "public.pem");
  await writeFile(privateKeyPath, pair.privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });
  await writeFile(publicKeyPath, pair.publicKey.export({ type: "spki", format: "pem" }));
  await signCanonicalProcessingEvidence({
    bundlePath: evidenceBundlePath,
    signaturePath: evidenceSignaturePath,
    privateKeyPath,
    repositoryRoot: process.cwd(),
  });
  const reportPath = join(parent, "processing-release-report.json");
  return {
    parent,
    candidateRoot,
    candidateManifestPath,
    candidate,
    evidenceBundlePath,
    evidenceSignaturePath,
    publicKeyPath,
    reportPath,
  };
}

function options(value: Awaited<ReturnType<typeof fixture>>) {
  return {
    candidateRoot: value.candidateRoot,
    candidateManifestPath: value.candidateManifestPath,
    evidenceBundlePath: value.evidenceBundlePath,
    evidenceSignaturePath: value.evidenceSignaturePath,
    publicKeyPath: value.publicKeyPath,
    now,
    reportPath: value.reportPath,
  };
}

async function finalizedFixture() {
  const value = await fixture();
  await createAndWriteProcessingReleaseReport(options(value));
  const candidateRoot = join(value.parent, "finalized");
  const candidate = await finalizeProcessingCandidate({
    builtRoot: value.candidateRoot,
    outputRoot: candidateRoot,
    reportPath: value.reportPath,
    evidenceBundlePath: value.evidenceBundlePath,
    evidenceSignaturePath: value.evidenceSignaturePath,
  });
  return {
    ...value,
    candidateRoot,
    candidateManifestPath: join(candidateRoot, "processing-candidate.json"),
    candidate,
    reportPath: join(candidateRoot, candidate.releaseAssets.report.path),
    evidenceBundlePath: join(candidateRoot, candidate.releaseAssets.evidence.bundle.path),
    evidenceSignaturePath: join(candidateRoot, candidate.releaseAssets.evidence.signature.path),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("processing release report verification", () => {
  it("binds reread candidate bytes and fields to the exact verified manifest", async () => {
    const value = await fixture();
    const manifestBytes = await readFile(value.candidateManifestPath);
    const verification = await verifyProcessingCandidate({
      manifestPath: value.candidateManifestPath,
      root: value.candidateRoot,
      requiredState: "built",
    });
    expect(verification).toMatchObject({
      manifestSha256: sha256Bytes(manifestBytes),
      candidateVerificationSha256: value.candidate.verificationSha256,
    });
    expect(() =>
      assertVerifiedProcessingCandidateManifest({
        verification,
        manifestBytes,
        candidate: value.candidate,
      }),
    ).not.toThrow();
    expect(() =>
      assertVerifiedProcessingCandidateManifest({
        verification,
        manifestBytes: Buffer.from(`${manifestBytes.toString("utf8")} `),
        candidate: value.candidate,
      }),
    ).toThrow(/verified|manifest|identity/i);
    expect(() =>
      assertVerifiedProcessingCandidateManifest({
        verification,
        manifestBytes,
        candidate: { ...value.candidate, verificationSha256: "0".repeat(64) },
      }),
    ).toThrow(/verified|manifest|identity/i);
  });

  it("creates and verifies an exact report derived only from verified bytes", async () => {
    const value = await fixture();
    const created = await createAndWriteProcessingReleaseReport(options(value));
    expect(created.artifacts).toEqual({
      engineDockerConfigDigest: value.candidate.engine.docker.configDigest,
      pdfEngineDockerConfigDigest: value.candidate.pdfEngine.docker.configDigest,
      pdfBenchmarkSha256: value.candidate.pdfQuality.benchmarkSha256,
      pdfReleaseGateSha256: value.candidate.pdfQuality.releaseGateSha256,
      pdfVisualProfilesMeasured: value.candidate.pdfQuality.visualProfilesMeasured,
      pdfPublicAdmissionReady: value.candidate.pdfQuality.publicAdmissionReady,
      webStagingArchiveSha256: value.candidate.web.staging.archiveSha256,
      webProductionArchiveSha256: value.candidate.web.production.archiveSha256,
      workerSha256: value.candidate.releaseAssets.worker.sha256,
      lockfileSha256: "6".repeat(64),
    });
    const originalBytes = await readFile(value.reportPath);
    expect((await stat(value.reportPath)).mode & 0o777).toBe(0o600);
    await expect(createAndWriteProcessingReleaseReport(options(value))).rejects.toThrow();
    expect(await readFile(value.reportPath)).toEqual(originalBytes);
    await expect(verifyProcessingReleaseReport(options(value))).resolves.toEqual({
      schema: "hereisit-processing-release-report-verification@1",
      releaseId,
      gitSha,
      reportSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      evidenceBundleSha256: created.evidence.bundleSha256,
      evidenceSignatureSha256: created.evidence.signatureSha256,
    });
  });

  it("verifies a finalized candidate by reconstructing its unique built projection", async () => {
    const value = await finalizedFixture();
    const report = JSON.parse(await readFile(value.reportPath, "utf8"));

    await expect(verifyProcessingReleaseReport(options(value))).resolves.toMatchObject({
      schema: "hereisit-processing-release-report-verification@1",
      releaseId,
      gitSha,
      reportSha256: value.candidate.releaseAssets.report.sha256,
      evidenceBundleSha256: value.candidate.releaseAssets.evidence.bundle.sha256,
      evidenceSignatureSha256: value.candidate.releaseAssets.evidence.signature.sha256,
    });
    expect(report.candidateVerificationSha256).not.toBe(value.candidate.verificationSha256);

    const writes: string[] = [];
    await runProcessingReleaseReportVerifierCli(
      [
        "--candidate-root",
        value.candidateRoot,
        "--candidate-manifest",
        value.candidateManifestPath,
        "--evidence-bundle",
        value.evidenceBundlePath,
        "--evidence-signature",
        value.evidenceSignaturePath,
        "--public-key",
        value.publicKeyPath,
        "--now",
        now,
        "--report",
        value.reportPath,
      ],
      { write: (text: string) => writes.push(text) },
    );
    expect(JSON.parse(writes[0])).toMatchObject({ releaseId, gitSha });
  });

  it("keeps report creation built-only", async () => {
    const value = await finalizedFixture();
    const reportPath = join(value.parent, "second-report.json");
    await expect(
      createAndWriteProcessingReleaseReport({
        ...options(value),
        reportPath,
      }),
    ).rejects.toThrow(/built|state/i);
    await expect(
      createAndWriteProcessingReleaseReport({
        ...options(value),
        reportPath,
        candidateState: "finalized",
        reportBytes: await readFile(value.reportPath),
        verifiedReportPath: value.reportPath,
      }),
    ).rejects.toThrow(/built|state/i);
  });

  it("requires the finalized candidate's exact report path", async () => {
    const value = await finalizedFixture();
    const externalReportPath = join(value.parent, "external-report.json");
    await writeFile(externalReportPath, await readFile(value.reportPath));

    await expect(
      verifyProcessingReleaseReport({
        ...options(value),
        reportPath: externalReportPath,
      }),
    ).rejects.toThrow(/report path|finalized candidate/i);
  });

  it("rejects a finalized candidate whose reconstructed built projection is not signed", async () => {
    const value = await finalizedFixture();
    const candidate = JSON.parse(await readFile(value.candidateManifestPath, "utf8"));
    const changedOrigin = "https://hereisit-processing-staging.changed.workers.dev";
    candidate.web.staging.processingApiOrigin = changedOrigin;
    candidate.releaseAssets.web.staging.processingApiOrigin = changedOrigin;
    const { verificationSha256: _verificationSha256, ...payload } = candidate;
    candidate.verificationSha256 = sha256Canonical(payload);
    await writeFile(value.candidateManifestPath, canonicalJson(candidate));

    await expect(verifyProcessingReleaseReport(options(value))).rejects.toThrow(
      /evidence|candidate|verified release inputs/i,
    );
  });

  it("rejects finalized report, evidence, security, candidate, and evidence-path drift", async () => {
    for (const mutate of [
      async (value: Awaited<ReturnType<typeof finalizedFixture>>) =>
        writeFile(
          value.reportPath,
          Buffer.concat([await readFile(value.reportPath), Buffer.from(" ")]),
        ),
      async (value: Awaited<ReturnType<typeof finalizedFixture>>) =>
        writeFile(
          value.evidenceBundlePath,
          Buffer.concat([await readFile(value.evidenceBundlePath), Buffer.from(" ")]),
        ),
      async (value: Awaited<ReturnType<typeof finalizedFixture>>) =>
        writeFile(value.evidenceSignaturePath, Buffer.alloc(64)),
      async (value: Awaited<ReturnType<typeof finalizedFixture>>) =>
        writeFile(join(value.candidateRoot, "security-trivy-engine.json"), "{}\n"),
      async (value: Awaited<ReturnType<typeof finalizedFixture>>) =>
        writeFile(value.candidateManifestPath, "{}\n"),
    ]) {
      const value = await finalizedFixture();
      await mutate(value);
      await expect(verifyProcessingReleaseReport(options(value))).rejects.toThrow();
    }

    const external = await finalizedFixture();
    const externalBundlePath = join(external.parent, "external-evidence.json");
    await writeFile(externalBundlePath, await readFile(external.evidenceBundlePath));
    await expect(
      verifyProcessingReleaseReport({
        ...options(external),
        evidenceBundlePath: externalBundlePath,
      }),
    ).rejects.toThrow(/evidence bundle path|finalized candidate/i);

    const externalSignaturePath = join(external.parent, "external-evidence.sig");
    await writeFile(externalSignaturePath, await readFile(external.evidenceSignaturePath));
    await expect(
      verifyProcessingReleaseReport({
        ...options(external),
        evidenceSignaturePath: externalSignaturePath,
      }),
    ).rejects.toThrow(/evidence signature path|finalized candidate/i);
  }, 10_000);

  it("has exact creator and verifier CLI boundaries with compact canonical output", async () => {
    const value = await fixture();
    const creatorWrites: string[] = [];
    const args = [
      "--candidate-root",
      value.candidateRoot,
      "--candidate-manifest",
      value.candidateManifestPath,
      "--evidence-bundle",
      value.evidenceBundlePath,
      "--evidence-signature",
      value.evidenceSignaturePath,
      "--public-key",
      value.publicKeyPath,
      "--now",
      now,
    ];
    await runProcessingReleaseReportCreatorCli([...args, "--output", value.reportPath], {
      write: (text: string) => creatorWrites.push(text),
    });
    expect(JSON.parse(creatorWrites[0])).toEqual({
      schema: "hereisit-processing-release-report-creation@1",
      version: 1,
      passed: true,
      releaseId,
      gitSha,
      reportSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const verifierWrites: string[] = [];
    await runProcessingReleaseReportVerifierCli([...args, "--report", value.reportPath], {
      write: (text: string) => verifierWrites.push(text),
    });
    expect(verifierWrites).toHaveLength(1);
    expect(JSON.parse(verifierWrites[0])).toEqual({
      schema: "hereisit-processing-release-report-verification@1",
      releaseId,
      gitSha,
      reportSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      evidenceBundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      evidenceSignatureSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(verifierWrites[0]).not.toContain(value.parent);
  });

  it("rejects report mutation, noncanonical bytes, unknown fields, size, and symlinks", async () => {
    for (const mutation of [
      "candidate",
      "evidence",
      "gate",
      "sbom",
      "trivy",
      "artifact",
      "timestamp",
      "unknown",
    ]) {
      const value = await fixture();
      await createAndWriteProcessingReleaseReport(options(value));
      const report = JSON.parse(await readFile(value.reportPath, "utf8"));
      if (mutation === "candidate") report.candidateVerificationSha256 = "0".repeat(64);
      if (mutation === "evidence") {
        report.evidence.reports.deviceMatrix.summarySha256 = "0".repeat(64);
      }
      if (mutation === "gate") report.security.gates.vulnerability.sha256 = "0".repeat(64);
      if (mutation === "sbom") report.security.sboms.engine.sha256 = "0".repeat(64);
      if (mutation === "trivy") {
        report.security.vulnerabilityReports.worker.sha256 = "0".repeat(64);
      }
      if (mutation === "artifact") report.artifacts.workerSha256 = "0".repeat(64);
      if (mutation === "timestamp") report.verifiedAt = "2026-07-20T12:00:01.000Z";
      if (mutation === "unknown") report.unexpected = true;
      await writeFile(value.reportPath, canonicalJson(report));
      await expect(verifyProcessingReleaseReport(options(value))).rejects.toThrow();
    }

    const noncanonical = await fixture();
    await createAndWriteProcessingReleaseReport(options(noncanonical));
    const report = JSON.parse(await readFile(noncanonical.reportPath, "utf8"));
    await writeFile(noncanonical.reportPath, `${JSON.stringify(report, null, 2)}\n`);
    await expect(verifyProcessingReleaseReport(options(noncanonical))).rejects.toThrow(
      /canonical/i,
    );

    const oversized = await fixture();
    await writeFile(oversized.reportPath, Buffer.alloc(1024 * 1024 + 1, 0x20));
    await expect(verifyProcessingReleaseReport(options(oversized))).rejects.toThrow(
      /bounded|size/i,
    );

    const linked = await fixture();
    const target = join(linked.parent, "real-report.json");
    await writeFile(target, "{}\n");
    await symlink(target, linked.reportPath);
    await expect(verifyProcessingReleaseReport(options(linked))).rejects.toThrow(/symbolic/i);
  }, 10_000);

  it("rejects stale or drifted candidate, security, evidence, signature, and path inputs", async () => {
    const stale = await fixture();
    await expect(
      createAndWriteProcessingReleaseReport({ ...options(stale), now: "2026-07-21T10:00:00.000Z" }),
    ).rejects.toThrow(/time|valid|expir/i);

    for (const mutate of [
      async (value: Awaited<ReturnType<typeof fixture>>) =>
        writeFile(value.candidateManifestPath, "{}\n"),
      async (value: Awaited<ReturnType<typeof fixture>>) =>
        writeFile(join(value.candidateRoot, "security-trivy-engine.json"), "{}\n"),
      async (value: Awaited<ReturnType<typeof fixture>>) =>
        writeFile(value.evidenceBundlePath, "{}\n"),
      async (value: Awaited<ReturnType<typeof fixture>>) =>
        writeFile(value.evidenceSignaturePath, Buffer.alloc(64)),
    ]) {
      const value = await fixture();
      await mutate(value);
      await expect(createAndWriteProcessingReleaseReport(options(value))).rejects.toThrow();
    }

    const escaped = await fixture();
    await expect(
      createAndWriteProcessingReleaseReport({
        ...options(escaped),
        candidateManifestPath: join(escaped.parent, "processing-candidate.json"),
      }),
    ).rejects.toThrow(/canonical|inside|read/i);
  });
});
