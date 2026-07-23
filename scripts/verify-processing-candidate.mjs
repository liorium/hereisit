import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertExactKeys,
  assertNonNegativeSafeInteger,
  assertObject,
  assertSha256,
  canonicalJson,
  parseCliArguments,
  sha256Bytes,
} from "./image-lab-common.mjs";
import { validateProcessingCandidate } from "./read-processing-candidate.mjs";
import { verifyAndExtractTreeArchive } from "./verify-and-extract-tree-archive.mjs";
import {
  verifyDockerImageArchive,
  verifyOciImageArchive,
} from "./verify-image-archive-identities.mjs";
import { verifyProcessingReleaseInputBindings } from "./verify-processing-release-input-bindings.mjs";

const maximumManifestBytes = 1024 * 1024;
const maximumAssetBytes = 2 * 1024 * 1024 * 1024;
const gitShaPattern = /^[a-f0-9]{40}$/;
const maximumSecurityGateBytes = 1024 * 1024;
const securityScopes = Object.freeze([
  ["engine", "engine"],
  ["web-staging", "webStaging"],
  ["web-production", "webProduction"],
  ["worker", "worker"],
  ["lockfile", "lockfile"],
]);
const syftImage =
  "ghcr.io/anchore/syft@sha256:2baa4d24d90599840c0100a8d30deaa533821fcd99f405ce6f90e3d225bd836d";
const trivyImage =
  "ghcr.io/aquasecurity/trivy@sha256:7228e304ae0f610a1fad937baa463598cadac0c2ac4027cc68f3a8b997115689";

async function readBoundedRegularFile(path, maximumBytes, label) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ELOOP") throw new TypeError(`${label} must not be a symbolic link`);
    throw new Error(`${label} could not be read`);
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new TypeError(`${label} must be a regular file`);
    if (metadata.size < 1 || metadata.size > maximumBytes) {
      throw new RangeError(`${label} exceeds the size limit`);
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength !== metadata.size) throw new TypeError(`${label} changed while reading`);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function verifyAsset(root, asset, label, hashField = "sha256") {
  const path = join(root, ...asset.path.split("/"));
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ELOOP") throw new TypeError(`${label} must not be a symbolic link`);
    throw new Error(`${label} could not be read`);
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new TypeError(`${label} must be a regular file`);
    if (metadata.size !== asset.sizeBytes || metadata.size > maximumAssetBytes) {
      throw new TypeError(`${label} size does not match`);
    }
    const hash = createHash("sha256");
    let totalBytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      totalBytes += chunk.byteLength;
      if (totalBytes > asset.sizeBytes) throw new TypeError(`${label} changed while reading`);
      hash.update(chunk);
    }
    if (totalBytes !== asset.sizeBytes) throw new TypeError(`${label} changed while reading`);
    if (hash.digest("hex") !== asset[hashField])
      throw new TypeError(`${label} hash does not match`);
    return path;
  } finally {
    await handle.close();
  }
}

function releaseAssetEntries(candidate) {
  const assets = candidate.releaseAssets;
  const entries = [
    [assets.worker, "Worker asset"],
    [assets.releaseInputs, "processing release inputs asset"],
    [assets.costModel, "live cost model asset"],
  ];
  if (candidate.state === "finalized") {
    entries.unshift([assets.report, "release report asset"]);
    entries.push(
      [assets.evidence.bundle, "evidence bundle asset"],
      [assets.evidence.signature, "evidence signature asset"],
    );
  }
  for (const [groupName, group] of Object.entries(assets.security)) {
    for (const [name, asset] of Object.entries(group)) {
      entries.push([asset, `${name} security ${groupName} asset`]);
    }
  }
  return entries;
}

function assertTrue(value, label) {
  if (value !== true) throw new TypeError(`${label} must have passed`);
}

function assertValue(value, expected, label) {
  if (value !== expected) throw new TypeError(`${label} identity does not match`);
}

function assertHashList(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const unique = new Set();
  for (const hash of value) {
    assertSha256(hash, `${label} entry`);
    if (unique.has(hash)) throw new TypeError(`${label} entries must be unique`);
    unique.add(hash);
  }
}

async function readCanonicalGate(root, asset, label) {
  const bytes = await readBoundedRegularFile(
    join(root, asset.path),
    maximumSecurityGateBytes,
    label,
  );
  if (bytes.byteLength !== asset.sizeBytes || sha256Bytes(bytes) !== asset.sha256) {
    throw new TypeError(`${label} changed after asset verification`);
  }
  let value;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw new TypeError(`${label} is not valid JSON`);
  }
  if (!bytes.equals(Buffer.from(canonicalJson(value)))) {
    throw new TypeError(`${label} must be canonical JSON`);
  }
  return assertObject(value, label);
}

function validateImageEngineGate(gate, engineSha256) {
  const commonKeys = [
    "schema",
    "passed",
    "scope",
    "artifactSha256",
    "sourceLockSha256",
    "policySha256",
    "exceptionsSha256",
    "baseImagesSha256",
  ];
  if (gate.scope !== "pr" && gate.scope !== "release") {
    throw new TypeError("image-engine license gate scope is invalid");
  }
  assertExactKeys(
    gate,
    gate.scope === "release" ? [...commonKeys, "commercialReviewSha256"] : commonKeys,
    "image-engine license gate",
  );
  assertValue(gate.schema, "hereisit-image-engine-license-gate@1", "image-engine license gate");
  assertTrue(gate.passed, "image-engine license gate");
  for (const field of [
    "artifactSha256",
    "sourceLockSha256",
    "policySha256",
    "exceptionsSha256",
    "baseImagesSha256",
    ...(gate.scope === "release" ? ["commercialReviewSha256"] : []),
  ]) {
    assertSha256(gate[field], `image-engine license gate ${field}`);
  }
  assertValue(gate.artifactSha256, engineSha256, "image-engine license gate artifact");
}

function validateApplicationGate(gate, artifactHashes, sboms) {
  assertExactKeys(
    gate,
    [
      "schema",
      "passed",
      "policySha256",
      "lockfileSha256",
      "noticesSha256",
      "fallbackTextSha256",
      "pnpmVersion",
      "syftVersion",
      "syftImage",
      "reviewedPackageCount",
      "scopes",
    ],
    "application supply-chain gate",
  );
  assertValue(
    gate.schema,
    "hereisit-application-supply-chain-gate@1",
    "application supply-chain gate schema",
  );
  assertTrue(gate.passed, "application supply-chain gate");
  for (const field of ["policySha256", "lockfileSha256", "noticesSha256"]) {
    assertSha256(gate[field], `application supply-chain gate ${field}`);
  }
  assertHashList(gate.fallbackTextSha256, "application supply-chain fallback hashes");
  assertValue(gate.pnpmVersion, "11.11.0", "application supply-chain pnpm");
  assertValue(gate.syftVersion, "1.44.0", "application supply-chain Syft");
  assertValue(gate.syftImage, syftImage, "application supply-chain Syft image");
  assertNonNegativeSafeInteger(
    gate.reviewedPackageCount,
    "application supply-chain reviewed package count",
  );
  const scopes = assertObject(gate.scopes, "application supply-chain scopes");
  assertExactKeys(
    scopes,
    securityScopes.map(([scope]) => scope),
    "application supply-chain scopes",
  );
  for (const [scope, key] of securityScopes) {
    const value = assertObject(scopes[scope], `${scope} application supply-chain scope`);
    assertExactKeys(
      value,
      ["artifactSha256", "sbomSha256", "componentCount"],
      `${scope} application supply-chain scope`,
    );
    assertSha256(value.artifactSha256, `${scope} application artifact hash`);
    assertSha256(value.sbomSha256, `${scope} application SBOM hash`);
    assertNonNegativeSafeInteger(value.componentCount, `${scope} application component count`);
    assertValue(value.artifactSha256, artifactHashes[scope], `${scope} application artifact`);
    assertValue(value.sbomSha256, sboms[key].sha256, `${scope} application SBOM`);
  }
  assertValue(scopes.lockfile.artifactSha256, gate.lockfileSha256, "application lockfile artifact");
}

function validateVulnerabilityGate(gate, candidate, artifactHashes) {
  assertExactKeys(
    gate,
    ["schemaVersion", "passed", "scanner", "exceptions", "scans"],
    "vulnerability gate",
  );
  assertValue(gate.schemaVersion, "hereisit-vulnerability-gate@1", "vulnerability gate schema");
  assertTrue(gate.passed, "vulnerability gate");
  const scanner = assertObject(gate.scanner, "vulnerability scanner");
  assertExactKeys(
    scanner,
    ["policySha256", "version", "image", "databaseDigest"],
    "vulnerability scanner",
  );
  assertSha256(scanner.policySha256, "vulnerability scanner policy hash");
  assertValue(scanner.version, "0.69.3", "vulnerability scanner version");
  assertValue(scanner.image, trivyImage, "vulnerability scanner image");
  assertValue(
    scanner.databaseDigest,
    candidate.security.trivyDbDigest,
    "vulnerability scanner database",
  );
  const exceptions = assertObject(gate.exceptions, "vulnerability exceptions");
  assertExactKeys(exceptions, ["engineSha256", "applicationSha256"], "vulnerability exceptions");
  assertSha256(exceptions.engineSha256, "engine vulnerability exceptions hash");
  assertSha256(exceptions.applicationSha256, "application vulnerability exceptions hash");
  if (!Array.isArray(gate.scans) || gate.scans.length !== securityScopes.length) {
    throw new TypeError("vulnerability gate must contain exactly five scans");
  }
  const scans = new Map();
  for (const scanValue of gate.scans) {
    const scan = assertObject(scanValue, "vulnerability scan");
    assertExactKeys(
      scan,
      [
        "scope",
        "artifactSha256",
        "reportSha256",
        "totalFindingCount",
        "highOrCriticalFindingCount",
        "usedExceptionCount",
      ],
      "vulnerability scan",
    );
    if (!securityScopes.some(([scope]) => scope === scan.scope) || scans.has(scan.scope)) {
      throw new TypeError("vulnerability scan scopes are invalid");
    }
    assertSha256(scan.artifactSha256, `${scan.scope} vulnerability artifact hash`);
    assertSha256(scan.reportSha256, `${scan.scope} vulnerability report hash`);
    for (const field of ["totalFindingCount", "highOrCriticalFindingCount", "usedExceptionCount"]) {
      assertNonNegativeSafeInteger(scan[field], `${scan.scope} vulnerability ${field}`);
    }
    scans.set(scan.scope, scan);
  }
  for (const [scope, key] of securityScopes) {
    const scan = scans.get(scope);
    assertValue(scan.artifactSha256, artifactHashes[scope], `${scope} vulnerability artifact`);
    assertValue(
      scan.reportSha256,
      candidate.releaseAssets.security.vulnerabilityReports[key].sha256,
      `${scope} vulnerability report`,
    );
  }
}

async function verifySecurityGates(root, candidate) {
  const assets = candidate.releaseAssets.security;
  const application = await readCanonicalGate(
    root,
    assets.gates.applicationSupplyChain,
    "application supply-chain gate",
  );
  const artifactHashes = {
    engine: candidate.engine.docker.configDigest.slice("sha256:".length),
    "web-staging": candidate.web.staging.archiveSha256,
    "web-production": candidate.web.production.archiveSha256,
    worker: candidate.releaseAssets.worker.sha256,
    lockfile: application.lockfileSha256,
  };
  validateApplicationGate(application, artifactHashes, assets.sboms);
  validateImageEngineGate(
    await readCanonicalGate(root, assets.gates.imageEngine, "image-engine license gate"),
    artifactHashes.engine,
  );
  validateVulnerabilityGate(
    await readCanonicalGate(root, assets.gates.vulnerability, "vulnerability gate"),
    candidate,
    artifactHashes,
  );
}

async function verifyWebAsset(root, asset, environment) {
  const archivePath = await verifyAsset(root, asset, `${environment} web asset`, "archiveSha256");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "hereisit-candidate-web-verification-"));
  try {
    return await verifyAndExtractTreeArchive({
      archive: archivePath,
      expectedArchiveSha256: asset.archiveSha256,
      expectedTreeSha256: asset.treeSha256,
      output: join(temporaryRoot, "tree"),
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export function assertVerifiedProcessingCandidateManifest({
  verification,
  manifestBytes,
  candidate,
}) {
  const verified = assertObject(verification, "candidate verification summary");
  assertSha256(verified.manifestSha256, "verified candidate manifest hash");
  assertSha256(
    verified.candidateVerificationSha256,
    "verified candidate payload verification hash",
  );
  if (!Buffer.isBuffer(manifestBytes)) {
    throw new TypeError("candidate manifest bytes must be a buffer");
  }
  const manifest = assertObject(candidate, "reread processing candidate");
  if (
    sha256Bytes(manifestBytes) !== verified.manifestSha256 ||
    manifest.verificationSha256 !== verified.candidateVerificationSha256
  ) {
    throw new TypeError("reread processing candidate does not match the verified manifest");
  }
}

export async function verifyProcessingCandidate({
  manifestPath,
  root,
  requiredState,
  expectedGitSha,
}) {
  if (requiredState !== "built" && requiredState !== "finalized") {
    throw new TypeError("required candidate state is invalid");
  }
  if (
    expectedGitSha !== undefined &&
    (typeof expectedGitSha !== "string" || !gitShaPattern.test(expectedGitSha))
  ) {
    throw new TypeError("expected git SHA is invalid");
  }
  const requestedRoot = resolve(root);
  const rootMetadata = await stat(requestedRoot);
  if (!rootMetadata.isDirectory()) throw new TypeError("candidate root must be a directory");
  const canonicalRoot = await realpath(requestedRoot);
  if (canonicalRoot !== requestedRoot) {
    throw new TypeError("candidate root must not be a symbolic link or non-canonical path");
  }
  const canonicalManifestPath = join(canonicalRoot, "processing-candidate.json");
  if (resolve(manifestPath) !== canonicalManifestPath) {
    throw new TypeError("candidate manifest path must be canonical and inside the candidate root");
  }
  const manifestBytes = await readBoundedRegularFile(
    canonicalManifestPath,
    maximumManifestBytes,
    "processing candidate manifest",
  );
  let candidate;
  try {
    candidate = validateProcessingCandidate(JSON.parse(manifestBytes));
  } catch (error) {
    if (error instanceof SyntaxError) throw new TypeError("processing candidate JSON is invalid");
    throw error;
  }
  if (candidate.state !== requiredState) {
    throw new TypeError("processing candidate state does not match the required state");
  }
  if (expectedGitSha !== undefined && candidate.gitSha !== expectedGitSha) {
    throw new TypeError("processing candidate source SHA does not match");
  }

  await verifyOciImageArchive({
    archivePath: join(canonicalRoot, candidate.releaseAssets.engine.oci.path),
    asset: candidate.releaseAssets.engine.oci,
    expectedIdentity: candidate.engine.oci,
  });
  await verifyDockerImageArchive({
    archivePath: join(canonicalRoot, candidate.releaseAssets.engine.docker.path),
    asset: candidate.releaseAssets.engine.docker,
    expectedIdentity: candidate.engine.docker,
    expectedRepoTag: candidate.engine.loadedImage,
  });

  const entries = releaseAssetEntries(candidate);
  for (const [asset, label] of entries) await verifyAsset(canonicalRoot, asset, label);
  await verifySecurityGates(canonicalRoot, candidate);
  const financialInputs = await verifyProcessingReleaseInputBindings({
    releaseInputsPath: join(canonicalRoot, candidate.releaseAssets.releaseInputs.path),
    liveCostModelPath: join(canonicalRoot, candidate.releaseAssets.costModel.path),
    expectedReleaseId: candidate.releaseId,
  });
  if (
    financialInputs.releaseInputs.sha256 !== candidate.releaseInputs.sha256 ||
    financialInputs.costModel.sha256 !== candidate.costModel.sha256
  ) {
    throw new TypeError("candidate financial input identities do not match verified bytes");
  }
  const staging = await verifyWebAsset(
    canonicalRoot,
    candidate.releaseAssets.web.staging,
    "staging",
  );
  const production = await verifyWebAsset(
    canonicalRoot,
    candidate.releaseAssets.web.production,
    "production",
  );
  return {
    schema: "hereisit-processing-candidate-verification@1",
    version: 1,
    state: candidate.state,
    releaseId: candidate.releaseId,
    gitSha: candidate.gitSha,
    manifestSha256: sha256Bytes(manifestBytes),
    candidateVerificationSha256: candidate.verificationSha256,
    assetCount: entries.length + 4,
    web: {
      staging: {
        archiveSha256: staging.archiveSha256,
        treeSha256: staging.treeSha256,
        fileCount: staging.fileCount,
        totalBytes: staging.totalBytes,
      },
      production: {
        archiveSha256: production.archiveSha256,
        treeSha256: production.treeSha256,
        fileCount: production.fileCount,
        totalBytes: production.totalBytes,
      },
    },
  };
}

export async function runProcessingCandidateVerifier(argv, stdout = process.stdout) {
  const args = parseCliArguments(argv);
  const expectedKeys = ["manifest", "root", "required-state", "expected-git-sha"];
  if (
    Object.keys(args).length !== expectedKeys.length ||
    Object.keys(args).some((key) => !expectedKeys.includes(key))
  ) {
    throw new TypeError("candidate verifier arguments are invalid");
  }
  const summary = await verifyProcessingCandidate({
    manifestPath: args.manifest,
    root: args.root,
    requiredState: args["required-state"],
    expectedGitSha: args["expected-git-sha"],
  });
  stdout.write(canonicalJson(summary));
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    await runProcessingCandidateVerifier(process.argv.slice(2));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "processing candidate verification failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
