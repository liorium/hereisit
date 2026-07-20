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
const environments = Object.freeze(["staging", "production"]);

function assertPattern(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function assertHttpsOrigin(value, expected, label) {
  if (value !== expected) throw new TypeError(`${label} does not match the canonical origin`);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password) {
    throw new TypeError(`${label} must be an HTTPS origin`);
  }
  return value;
}

function validateArtifact(value, label, expectedPath) {
  const artifact = assertObject(value, label);
  assertExactKeys(artifact, ["path", "sizeBytes", "sha256"], label);
  assertPattern(artifact.path, relativePathPattern, `${label} path`);
  if (artifact.path !== expectedPath) throw new TypeError(`${label} path does not match`);
  assertNonNegativeSafeInteger(artifact.sizeBytes, `${label} size`);
  if (artifact.sizeBytes < 1) throw new TypeError(`${label} size must be positive`);
  assertSha256(artifact.sha256, `${label} hash`);
  return artifact;
}

function expectedOrigin(environment) {
  return `https://hereisit-processing-${environment}.liorium.workers.dev`;
}

function validateWebIdentity(value, environment) {
  const label = `${environment} web identity`;
  const identity = assertObject(value, label);
  assertExactKeys(identity, ["archiveSha256", "treeSha256", "processingApiOrigin"], label);
  assertSha256(identity.archiveSha256, `${label} archive hash`);
  assertSha256(identity.treeSha256, `${label} tree hash`);
  assertHttpsOrigin(
    identity.processingApiOrigin,
    expectedOrigin(environment),
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
  assertHttpsOrigin(
    asset.processingApiOrigin,
    expectedOrigin(environment),
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

function validateEngine(value, gitSha) {
  const engine = assertObject(value, "candidate engine identity");
  assertExactKeys(
    engine,
    ["loadedImage", "configDigest", "layerDigests"],
    "candidate engine identity",
  );
  if (engine.loadedImage !== `hereisit-image-engine:${gitSha}`) {
    throw new TypeError("candidate loaded image is malformed or does not match the git SHA");
  }
  assertPattern(engine.configDigest, digestPattern, "candidate engine configuration digest");
  if (
    !Array.isArray(engine.layerDigests) ||
    engine.layerDigests.length < 1 ||
    engine.layerDigests.length > 128
  ) {
    throw new TypeError("candidate engine layer digests are invalid");
  }
  const seen = new Set();
  for (const digest of engine.layerDigests) {
    assertPattern(digest, digestPattern, "candidate engine layer digest");
    if (seen.has(digest)) throw new TypeError("candidate engine layer digests must be unique");
    seen.add(digest);
  }
  return engine;
}

function validateReleaseAssets(value, state, releaseId, web) {
  const assets = assertObject(value, "candidate release assets");
  const builtKeys = ["engine", "worker", "web"];
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
  validateArtifact(assets.worker, "candidate Worker release asset", "api-worker.mjs");

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
  assertExactKeys(
    manifest,
    [
      "schema",
      "version",
      "state",
      "releaseId",
      "gitSha",
      "engine",
      "web",
      "security",
      "providerUsage",
      "releaseAssets",
      "verificationSha256",
    ],
    "processing candidate",
  );
  if (manifest.schema !== "hereisit-processing-candidate@1" || manifest.version !== 1) {
    throw new TypeError("processing candidate schema is invalid");
  }
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

  const web = assertObject(manifest.web, "candidate web identities");
  assertExactKeys(web, environments, "candidate web identities");
  for (const environment of environments) validateWebIdentity(web[environment], environment);

  const security = assertObject(manifest.security, "candidate security identity");
  assertExactKeys(security, ["trivyDbDigest"], "candidate security identity");
  assertPattern(security.trivyDbDigest, digestPattern, "candidate Trivy DB digest");

  const providerUsage = assertObject(manifest.providerUsage, "candidate provider usage identity");
  assertExactKeys(providerUsage, ["schemaSha256"], "candidate provider usage identity");
  assertSha256(providerUsage.schemaSha256, "candidate provider usage schema hash");

  const releaseAssets = validateReleaseAssets(
    manifest.releaseAssets,
    manifest.state,
    manifest.releaseId,
    web,
  );
  return { ...manifest, engine, web, security, providerUsage, releaseAssets };
}

const fieldReaders = Object.freeze({
  state: (candidate) => candidate.state,
  releaseId: (candidate) => candidate.releaseId,
  gitSha: (candidate) => candidate.gitSha,
  "engine.loadedImage": (candidate) => candidate.engine.loadedImage,
  "engine.configDigest": (candidate) => candidate.engine.configDigest,
  "security.trivyDbDigest": (candidate) => candidate.security.trivyDbDigest,
  "providerUsage.schemaSha256": (candidate) => candidate.providerUsage.schemaSha256,
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
