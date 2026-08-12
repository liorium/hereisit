import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertExactKeys,
  assertNonNegativeSafeInteger,
  assertObject,
  assertSha256,
  parseCliArguments,
  sha256Canonical,
} from "./image-lab-common.mjs";

const maximumManifestBytes = 256 * 1024;
const releaseIdPattern = /^\d{4}-\d{2}-\d{2}\.[1-9]\d*$/;
const gitShaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const relativePathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;
const workersSubdomainLabel = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const environments = Object.freeze(["staging", "production"]);
const securityScopes = Object.freeze([
  ["engine", "engine"],
  ["pdfEngine", "pdf-engine"],
  ["webStaging", "web-staging"],
  ["webProduction", "web-production"],
  ["worker", "worker"],
  ["lockfile", "lockfile"],
]);
const maximumSecurityGateBytes = 1024 * 1024;
const maximumSecurityEvidenceBytes = 8 * 1024 * 1024;

function assertPattern(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function assertProcessingApiOrigin(value, environment, label) {
  if (typeof value !== "string") throw new TypeError(`${label} is invalid`);
  const url = new URL(value);
  const hostnameMatches =
    environment === "production"
      ? url.hostname === "api.hereisit.app"
      : new RegExp(`^hereisit-processing-staging\\.${workersSubdomainLabel}\\.workers\\.dev$`).test(
          url.hostname,
        );
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.username ||
    url.password ||
    !hostnameMatches
  ) {
    throw new TypeError(`${label} must be an HTTPS origin`);
  }
  return value;
}

function validateArtifact(value, label, expectedPath, maximumBytes) {
  const artifact = assertObject(value, label);
  assertExactKeys(artifact, ["path", "sizeBytes", "sha256"], label);
  assertPattern(artifact.path, relativePathPattern, `${label} path`);
  if (artifact.path !== expectedPath) throw new TypeError(`${label} path does not match`);
  assertNonNegativeSafeInteger(artifact.sizeBytes, `${label} size`);
  if (artifact.sizeBytes < 1) throw new TypeError(`${label} size must be positive`);
  if (maximumBytes !== undefined && artifact.sizeBytes > maximumBytes) {
    throw new TypeError(`${label} size exceeds the limit`);
  }
  assertSha256(artifact.sha256, `${label} hash`);
  return artifact;
}

function validateSecurityReleaseAssets(value, dual) {
  const security = assertObject(value, "candidate security release assets");
  assertExactKeys(
    security,
    ["gates", "sboms", "vulnerabilityReports"],
    "candidate security release assets",
  );
  const gates = assertObject(security.gates, "candidate security gate assets");
  assertExactKeys(
    gates,
    dual
      ? ["imageEngine", "pdfEngine", "applicationSupplyChain", "vulnerability"]
      : ["imageEngine", "applicationSupplyChain", "vulnerability"],
    "candidate security gate assets",
  );
  validateArtifact(
    gates.imageEngine,
    "candidate image-engine license gate asset",
    "security-image-engine-license-gate.json",
    maximumSecurityGateBytes,
  );
  if (dual) {
    validateArtifact(
      gates.pdfEngine,
      "candidate PDF-engine license gate asset",
      "security-pdf-engine-license-gate.json",
      maximumSecurityGateBytes,
    );
  }
  validateArtifact(
    gates.applicationSupplyChain,
    "candidate application supply-chain gate asset",
    "security-application-supply-chain-gate.json",
    maximumSecurityGateBytes,
  );
  validateArtifact(
    gates.vulnerability,
    "candidate vulnerability gate asset",
    "security-vulnerability-gate.json",
    maximumSecurityGateBytes,
  );
  for (const [groupName, filenamePrefix, filenameSuffix] of [
    ["sboms", "security-sbom-", ".cdx.json"],
    ["vulnerabilityReports", "security-trivy-", ".json"],
  ]) {
    const group = assertObject(security[groupName], `candidate security ${groupName} assets`);
    assertExactKeys(
      group,
      securityScopes.filter(([key]) => dual || key !== "pdfEngine").map(([key]) => key),
      `candidate security ${groupName} assets`,
    );
    for (const [key, scope] of securityScopes.filter(([key]) => dual || key !== "pdfEngine")) {
      validateArtifact(
        group[key],
        `candidate ${scope} security ${groupName} asset`,
        `${filenamePrefix}${scope}${filenameSuffix}`,
        maximumSecurityEvidenceBytes,
      );
    }
  }
  return security;
}

function validateWebIdentity(value, environment) {
  const label = `${environment} web identity`;
  const identity = assertObject(value, label);
  assertExactKeys(identity, ["archiveSha256", "treeSha256", "processingApiOrigin"], label);
  assertSha256(identity.archiveSha256, `${label} archive hash`);
  assertSha256(identity.treeSha256, `${label} tree hash`);
  assertProcessingApiOrigin(
    identity.processingApiOrigin,
    environment,
    `${label} processing API origin`,
  );
  return identity;
}

function validateWebReleaseAsset(value, environment, identity) {
  const label = `${environment} web release asset`;
  const asset = assertObject(value, label);
  assertExactKeys(
    asset,
    ["path", "sizeBytes", "archiveSha256", "treeSha256", "processingApiOrigin"],
    label,
  );
  assertPattern(asset.path, relativePathPattern, `${label} path`);
  if (asset.path !== `web-${environment}.tar`) throw new TypeError(`${label} path does not match`);
  assertNonNegativeSafeInteger(asset.sizeBytes, `${label} size`);
  if (asset.sizeBytes < 1) throw new TypeError(`${label} size must be positive`);
  assertSha256(asset.archiveSha256, `${label} archive hash`);
  assertSha256(asset.treeSha256, `${label} tree hash`);
  assertProcessingApiOrigin(
    asset.processingApiOrigin,
    environment,
    `${label} processing API origin`,
  );
  if (
    asset.archiveSha256 !== identity.archiveSha256 ||
    asset.treeSha256 !== identity.treeSha256 ||
    asset.processingApiOrigin !== identity.processingApiOrigin
  ) {
    throw new TypeError(`${label} does not match the signed web identity`);
  }
  return asset;
}

function validateDigestArray(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) {
    throw new TypeError(`${label} are invalid`);
  }
  for (const digest of value) {
    assertPattern(digest, digestPattern, `${label} entry`);
  }
  return value;
}

function validateOciImageIdentity(value) {
  const label = "candidate OCI image identity";
  const identity = assertObject(value, label);
  assertExactKeys(identity, ["configDigest", "distributionLayerDigests", "diffIds"], label);
  assertPattern(identity.configDigest, digestPattern, `${label} configuration digest`);
  validateDigestArray(identity.distributionLayerDigests, `${label} distribution layer digests`);
  validateDigestArray(identity.diffIds, `${label} rootfs DiffIDs`);
  if (identity.distributionLayerDigests.length !== identity.diffIds.length) {
    throw new TypeError(`${label} distribution layers and rootfs DiffIDs do not align`);
  }
  return identity;
}

function validateDockerImageIdentity(value) {
  const label = "candidate Docker image identity";
  const identity = assertObject(value, label);
  assertExactKeys(identity, ["configDigest", "diffIds"], label);
  assertPattern(identity.configDigest, digestPattern, `${label} configuration digest`);
  validateDigestArray(identity.diffIds, `${label} rootfs DiffIDs`);
  return identity;
}

function validateEngine(value, gitSha, kind = "image") {
  const label = kind === "pdf" ? "candidate PDF engine identity" : "candidate engine identity";
  const engine = assertObject(value, label);
  assertExactKeys(engine, ["loadedImage", "oci", "docker"], label);
  if (engine.loadedImage !== `hereisit-${kind}-engine:${gitSha}`) {
    throw new TypeError("candidate loaded image is malformed or does not match the git SHA");
  }
  const oci = validateOciImageIdentity(engine.oci);
  const docker = validateDockerImageIdentity(engine.docker);
  if (
    oci.configDigest !== docker.configDigest ||
    oci.diffIds.length !== docker.diffIds.length ||
    oci.diffIds.some((digest, index) => digest !== docker.diffIds[index])
  ) {
    throw new TypeError("candidate OCI and Docker image identities do not match");
  }
  return engine;
}

function validatePdfQuality(value) {
  const quality = assertObject(value, "candidate PDF quality identity");
  assertExactKeys(
    quality,
    ["benchmarkSha256", "releaseGateSha256", "visualProfilesMeasured", "publicAdmissionReady"],
    "candidate PDF quality identity",
  );
  assertSha256(quality.benchmarkSha256, "candidate PDF benchmark hash");
  assertSha256(quality.releaseGateSha256, "candidate PDF release gate hash");
  assertNonNegativeSafeInteger(
    quality.visualProfilesMeasured,
    "candidate PDF visual profile count",
  );
  if (typeof quality.publicAdmissionReady !== "boolean") {
    throw new TypeError("candidate PDF public admission state is invalid");
  }
  if (quality.publicAdmissionReady && quality.visualProfilesMeasured < 1) {
    throw new TypeError("candidate PDF public admission requires visual evidence");
  }
  return quality;
}

function validateReleaseAssets(value, state, releaseId, web, dual) {
  const assets = assertObject(value, "candidate release assets");
  const builtKeys = [
    "engine",
    ...(dual ? ["pdfEngine", "pdfQuality"] : []),
    "worker",
    "web",
    "releaseInputs",
    "costModel",
    "security",
  ];
  const finalizedKeys = ["report", ...builtKeys, "evidence"];
  assertExactKeys(
    assets,
    state === "finalized" ? finalizedKeys : builtKeys,
    "candidate release assets",
  );

  const engine = assertObject(assets.engine, "candidate engine release assets");
  assertExactKeys(engine, ["oci", "docker"], "candidate engine release assets");
  validateArtifact(engine.oci, "candidate OCI release asset", "image-engine-linux-amd64.oci.tar");
  validateArtifact(
    engine.docker,
    "candidate Docker release asset",
    "image-engine-linux-amd64.docker.tar",
  );
  if (dual) {
    const pdfEngine = assertObject(assets.pdfEngine, "candidate PDF engine release assets");
    assertExactKeys(pdfEngine, ["oci", "docker"], "candidate PDF engine release assets");
    validateArtifact(
      pdfEngine.oci,
      "candidate PDF OCI release asset",
      "pdf-engine-linux-amd64.oci.tar",
    );
    validateArtifact(
      pdfEngine.docker,
      "candidate PDF Docker release asset",
      "pdf-engine-linux-amd64.docker.tar",
    );
    const pdfQuality = assertObject(assets.pdfQuality, "candidate PDF quality release assets");
    assertExactKeys(
      pdfQuality,
      ["benchmark", "benchmarkSchema", "releaseGate", "releaseGateSchema"],
      "candidate PDF quality release assets",
    );
    validateArtifact(
      pdfQuality.benchmark,
      "candidate PDF benchmark asset",
      "pdf-engine-benchmark.json",
      maximumSecurityEvidenceBytes,
    );
    validateArtifact(
      pdfQuality.benchmarkSchema,
      "candidate PDF benchmark schema asset",
      "pdf-engine-benchmark.schema.json",
      maximumSecurityGateBytes,
    );
    validateArtifact(
      pdfQuality.releaseGate,
      "candidate PDF release gate asset",
      "pdf-engine-release-gate.json",
      maximumSecurityGateBytes,
    );
    validateArtifact(
      pdfQuality.releaseGateSchema,
      "candidate PDF release gate schema asset",
      "pdf-engine-release-gate.schema.json",
      maximumSecurityGateBytes,
    );
  }
  validateArtifact(assets.worker, "candidate Worker release asset", "api-worker.mjs");
  validateArtifact(
    assets.releaseInputs,
    "candidate release inputs asset",
    "processing-release-inputs.json",
  );
  validateArtifact(assets.costModel, "candidate live cost model asset", "live-cost-model.json");
  validateSecurityReleaseAssets(assets.security, dual);

  const webAssets = assertObject(assets.web, "candidate web release assets");
  assertExactKeys(webAssets, environments, "candidate web release assets");
  for (const environment of environments) {
    validateWebReleaseAsset(webAssets[environment], environment, web[environment]);
  }

  if (state === "finalized") {
    validateArtifact(
      assets.report,
      "candidate release report asset",
      "processing-release-report.json",
    );
    const evidence = assertObject(assets.evidence, "candidate evidence release assets");
    assertExactKeys(evidence, ["bundle", "signature"], "candidate evidence release assets");
    validateArtifact(
      evidence.bundle,
      "candidate evidence bundle asset",
      `evidence-v1--${releaseId}--processing-evidence.json`,
    );
    validateArtifact(
      evidence.signature,
      "candidate evidence signature asset",
      `evidence-v1--${releaseId}--processing-evidence.sig`,
    );
  }
  return assets;
}

export function validateProcessingCandidate(value) {
  const manifest = assertObject(value, "processing candidate");
  const dual = manifest.schema === "hereisit-processing-candidate@2" && manifest.version === 2;
  const legacy = manifest.schema === "hereisit-processing-candidate@1" && manifest.version === 1;
  if (!dual && !legacy) throw new TypeError("processing candidate schema is invalid");
  assertExactKeys(
    manifest,
    [
      "schema",
      "version",
      "state",
      "releaseId",
      "gitSha",
      "engine",
      ...(dual ? ["pdfEngine", "pdfQuality"] : []),
      "web",
      "security",
      "providerUsage",
      "releaseInputs",
      "costModel",
      "releaseAssets",
      "verificationSha256",
    ],
    "processing candidate",
  );
  assertSha256(manifest.verificationSha256, "processing candidate verification hash");
  const { verificationSha256: _verificationSha256, ...payload } = manifest;
  if (sha256Canonical(payload) !== manifest.verificationSha256) {
    throw new TypeError("processing candidate verification hash does not match");
  }
  if (manifest.state !== "built" && manifest.state !== "finalized") {
    throw new TypeError("processing candidate state is invalid");
  }
  assertPattern(manifest.releaseId, releaseIdPattern, "processing candidate release ID");
  assertPattern(manifest.gitSha, gitShaPattern, "processing candidate git SHA");
  const engine = validateEngine(manifest.engine, manifest.gitSha);
  const pdfEngine = dual ? validateEngine(manifest.pdfEngine, manifest.gitSha, "pdf") : undefined;
  const pdfQuality = dual ? validatePdfQuality(manifest.pdfQuality) : undefined;

  const web = assertObject(manifest.web, "candidate web identities");
  assertExactKeys(web, environments, "candidate web identities");
  for (const environment of environments) validateWebIdentity(web[environment], environment);

  const security = assertObject(manifest.security, "candidate security identity");
  assertExactKeys(security, ["trivyDbDigest"], "candidate security identity");
  assertPattern(security.trivyDbDigest, digestPattern, "candidate Trivy DB digest");

  const providerUsage = assertObject(manifest.providerUsage, "candidate provider usage identity");
  assertExactKeys(providerUsage, ["schemaSha256"], "candidate provider usage identity");
  assertSha256(providerUsage.schemaSha256, "candidate provider usage schema hash");

  const releaseInputs = assertObject(manifest.releaseInputs, "candidate release inputs identity");
  assertExactKeys(releaseInputs, ["sha256"], "candidate release inputs identity");
  assertSha256(releaseInputs.sha256, "candidate release inputs hash");
  const costModel = assertObject(manifest.costModel, "candidate live cost model identity");
  assertExactKeys(costModel, ["sha256"], "candidate live cost model identity");
  assertSha256(costModel.sha256, "candidate live cost model hash");

  const releaseAssets = validateReleaseAssets(
    manifest.releaseAssets,
    manifest.state,
    manifest.releaseId,
    web,
    dual,
  );
  if (releaseAssets.releaseInputs.sha256 !== releaseInputs.sha256) {
    throw new TypeError("candidate release inputs asset does not match its identity");
  }
  if (releaseAssets.costModel.sha256 !== costModel.sha256) {
    throw new TypeError("candidate live cost model asset does not match its identity");
  }
  return {
    ...manifest,
    engine,
    ...(dual ? { pdfEngine, pdfQuality } : {}),
    web,
    security,
    providerUsage,
    releaseInputs,
    costModel,
    releaseAssets,
  };
}

const fieldReaders = Object.freeze({
  state: (candidate) => candidate.state,
  releaseId: (candidate) => candidate.releaseId,
  gitSha: (candidate) => candidate.gitSha,
  "engine.loadedImage": (candidate) => candidate.engine.loadedImage,
  "engine.oci.configDigest": (candidate) => candidate.engine.oci.configDigest,
  "pdfEngine.loadedImage": (candidate) => candidate.pdfEngine.loadedImage,
  "pdfEngine.oci.configDigest": (candidate) => candidate.pdfEngine.oci.configDigest,
  "pdfQuality.publicAdmissionReady": (candidate) => candidate.pdfQuality.publicAdmissionReady,
  "security.trivyDbDigest": (candidate) => candidate.security.trivyDbDigest,
  "providerUsage.schemaSha256": (candidate) => candidate.providerUsage.schemaSha256,
  "releaseInputs.sha256": (candidate) => candidate.releaseInputs.sha256,
  "costModel.sha256": (candidate) => candidate.costModel.sha256,
  "web.staging.archiveSha256": (candidate) => candidate.web.staging.archiveSha256,
  "web.staging.treeSha256": (candidate) => candidate.web.staging.treeSha256,
  "web.staging.processingApiOrigin": (candidate) => candidate.web.staging.processingApiOrigin,
  "web.production.archiveSha256": (candidate) => candidate.web.production.archiveSha256,
  "web.production.treeSha256": (candidate) => candidate.web.production.treeSha256,
  "web.production.processingApiOrigin": (candidate) => candidate.web.production.processingApiOrigin,
});

export function readProcessingCandidateField(manifest, field) {
  if (typeof field !== "string" || !Object.hasOwn(fieldReaders, field)) {
    throw new TypeError("processing candidate field is not allowlisted");
  }
  return fieldReaders[field](validateProcessingCandidate(manifest));
}

async function readBoundedManifestText(manifestPath) {
  let handle;
  try {
    handle = await open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile())
      throw new TypeError("processing candidate input must be a regular file");
    if (metadata.size > maximumManifestBytes) {
      throw new RangeError("processing candidate exceeds the maximum input size");
    }
    const buffer = Buffer.alloc(maximumManifestBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maximumManifestBytes) {
      throw new RangeError("processing candidate exceeds the maximum input size");
    }
    return buffer.toString("utf8", 0, offset);
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) throw error;
    throw new Error("processing candidate file could not be read");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readProcessingCandidateFile({ manifestPath, field }) {
  if (typeof manifestPath !== "string" || manifestPath.length === 0) {
    throw new TypeError("processing candidate manifest path is required");
  }
  const text = await readBoundedManifestText(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new TypeError("processing candidate JSON is invalid");
  }
  return readProcessingCandidateField(manifest, field);
}

export async function runProcessingCandidateReader(argv, stdout = process.stdout) {
  const args = parseCliArguments(argv);
  if (Object.keys(args).some((key) => key !== "manifest" && key !== "field")) {
    throw new TypeError("unknown processing candidate reader argument");
  }
  if (args.manifest === undefined || args.field === undefined) {
    throw new TypeError("--manifest and --field are required");
  }
  const value = await readProcessingCandidateFile({
    manifestPath: resolve(args.manifest),
    field: args.field,
  });
  stdout.write(`${String(value)}\n`);
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    await runProcessingCandidateReader(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : "processing candidate reader failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
