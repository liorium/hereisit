import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertExactKeys,
  assertObject,
  assertSha256,
  parseCliArguments,
  sha256Bytes,
  sha256Canonical,
} from "./image-lab-common.mjs";
import { validateProcessingCandidate } from "./read-processing-candidate.mjs";

const MAXIMUM_MANIFEST_BYTES = 512 * 1024;
const MAXIMUM_CANDIDATE_MANIFEST_BYTES = 1024 * 1024;
const MAXIMUM_SECURITY_GATE_BYTES = 1024 * 1024;
const MAXIMUM_SECURITY_EVIDENCE_BYTES = 8 * 1024 * 1024;
const REPOSITORY = "liorium/hereisit";
const GITHUB_API_ORIGIN = "https://api.github.com";
const releaseIdPattern = /^[0-9]{4}-[0-9]{2}-[0-9]{2}\.[1-9][0-9]*$/;
const gitShaPattern = /^[0-9a-f]{40}$/;
const assetNamePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/;
const workersSubdomainLabel = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";

const genericAssetFields = ["assetId", "name", "sizeBytes", "sha256", "apiUrl"];
const webAssetFields = [
  ...genericAssetFields,
  "archiveSha256",
  "treeSha256",
  "processingApiOrigin",
];
const securityScopes = Object.freeze([
  ["engine", "engine"],
  ["webStaging", "web-staging"],
  ["webProduction", "web-production"],
  ["worker", "worker"],
  ["lockfile", "lockfile"],
]);
const securityGates = Object.freeze([
  ["imageEngine", "security-image-engine-license-gate.json"],
  ["applicationSupplyChain", "security-application-supply-chain-gate.json"],
  ["vulnerability", "security-vulnerability-gate.json"],
]);

function assertPositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function assertExactHttpsOrigin(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${label} is invalid`);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.origin !== value ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.hostname.endsWith(".")
  ) {
    throw new TypeError(`${label} must be an exact HTTPS origin`);
  }
  return url;
}

function validateAsset(
  value,
  label,
  context,
  expectedName,
  fields = genericAssetFields,
  maximumBytes,
) {
  const asset = assertObject(value, label);
  assertExactKeys(asset, fields, label);
  const assetId = assertPositiveSafeInteger(asset.assetId, `${label} ID`);
  if (asset.name !== expectedName || !assetNamePattern.test(asset.name)) {
    throw new TypeError(`${label} name does not match the immutable release namespace`);
  }
  const sizeBytes = assertPositiveSafeInteger(asset.sizeBytes, `${label} size`);
  if (maximumBytes !== undefined && sizeBytes > maximumBytes) {
    throw new RangeError(`${label} exceeds the size limit`);
  }
  assertSha256(asset.sha256, `${label} SHA-256`);
  const expectedApiUrl = `${context.apiOrigin}/repos/${context.repository}/releases/assets/${assetId}`;
  if (asset.apiUrl !== expectedApiUrl) throw new TypeError(`${label} API URL is not canonical`);
  return { asset, assetId, sizeBytes };
}

function validateSecurityAssets(value, context) {
  const security = assertObject(value, "security release assets");
  assertExactKeys(security, ["gates", "sboms", "vulnerabilityReports"], "security release assets");
  const gates = assertObject(security.gates, "security gate release assets");
  assertExactKeys(
    gates,
    securityGates.map(([key]) => key),
    "security gate release assets",
  );
  const identities = securityGates.map(([key, path]) =>
    validateAsset(
      gates[key],
      `${key} security gate asset`,
      context,
      `candidate-v1--${context.releaseId}--${path}`,
      genericAssetFields,
      MAXIMUM_SECURITY_GATE_BYTES,
    ),
  );
  for (const [groupName, prefix, suffix] of [
    ["sboms", "security-sbom-", ".cdx.json"],
    ["vulnerabilityReports", "security-trivy-", ".json"],
  ]) {
    const group = assertObject(security[groupName], `security ${groupName} release assets`);
    assertExactKeys(
      group,
      securityScopes.map(([key]) => key),
      `security ${groupName} release assets`,
    );
    for (const [key, scope] of securityScopes) {
      identities.push(
        validateAsset(
          group[key],
          `${scope} security ${groupName} asset`,
          context,
          `candidate-v1--${context.releaseId}--${prefix}${scope}${suffix}`,
          genericAssetFields,
          MAXIMUM_SECURITY_EVIDENCE_BYTES,
        ),
      );
    }
  }
  return identities;
}

function validateProcessingApiOrigin(value, environment) {
  const url = assertExactHttpsOrigin(value, `${environment} processing API origin`);
  const pattern = new RegExp(
    `^hereisit-processing-${environment}\\.${workersSubdomainLabel}\\.workers\\.dev$`,
  );
  if (!pattern.test(url.hostname)) {
    throw new TypeError(`${environment} processing API origin does not match the Worker script`);
  }
  return value;
}

function validateWebAsset(value, environment, context) {
  const expectedName = `candidate-v1--${context.releaseId}--web-${environment}.tar`;
  const result = validateAsset(
    value,
    `${environment} web asset`,
    context,
    expectedName,
    webAssetFields,
  );
  assertSha256(result.asset.archiveSha256, `${environment} web archive SHA-256`);
  assertSha256(result.asset.treeSha256, `${environment} web tree SHA-256`);
  if (result.asset.sha256 !== result.asset.archiveSha256) {
    throw new TypeError(`${environment} web archive hashes do not match`);
  }
  validateProcessingApiOrigin(result.asset.processingApiOrigin, environment);
  return result;
}

export function validateProcessingReleaseAssets(value) {
  const manifest = assertObject(value, "processing release asset manifest");
  assertExactKeys(
    manifest,
    [
      "schema",
      "version",
      "apiOrigin",
      "repository",
      "release",
      "candidate",
      "report",
      "engine",
      "worker",
      "releaseInputs",
      "costModel",
      "web",
      "evidence",
      "security",
      "verificationSha256",
    ],
    "processing release asset manifest",
  );
  if (manifest.schema !== "hereisit-processing-release-assets@1" || manifest.version !== 1) {
    throw new TypeError("processing release asset schema is invalid");
  }
  const apiOrigin = assertExactHttpsOrigin(manifest.apiOrigin, "GitHub API origin").origin;
  if (apiOrigin !== GITHUB_API_ORIGIN) throw new TypeError("GitHub API origin does not match");
  if (manifest.repository !== REPOSITORY) {
    throw new TypeError("processing release repository does not match");
  }

  const release = assertObject(manifest.release, "processing release");
  assertExactKeys(release, ["id", "tag", "targetSha"], "processing release");
  assertPositiveSafeInteger(release.id, "processing release ID");
  if (typeof release.tag !== "string" || !release.tag.startsWith("processing-release-")) {
    throw new TypeError("processing release tag is invalid");
  }
  const releaseId = release.tag.slice("processing-release-".length);
  if (!releaseIdPattern.test(releaseId)) throw new TypeError("processing release tag is invalid");
  if (typeof release.targetSha !== "string" || !gitShaPattern.test(release.targetSha)) {
    throw new TypeError("processing release target SHA is invalid");
  }
  const context = { apiOrigin, repository: manifest.repository, releaseId };

  const prefix = `candidate-v1--${releaseId}--`;
  const candidate = validateAsset(
    manifest.candidate,
    "candidate manifest asset",
    context,
    `${prefix}processing-candidate.json`,
  );
  const report = validateAsset(
    manifest.report,
    "release report asset",
    context,
    `${prefix}processing-release-report.json`,
  );
  const engine = assertObject(manifest.engine, "engine release assets");
  assertExactKeys(engine, ["oci", "docker"], "engine release assets");
  const engineOci = validateAsset(
    engine.oci,
    "engine OCI asset",
    context,
    `${prefix}image-engine-linux-amd64.oci.tar`,
  );
  const engineDocker = validateAsset(
    engine.docker,
    "engine Docker asset",
    context,
    `${prefix}image-engine-linux-amd64.docker.tar`,
  );
  const worker = validateAsset(
    manifest.worker,
    "Worker module asset",
    context,
    `${prefix}api-worker.mjs`,
  );
  const releaseInputs = validateAsset(
    manifest.releaseInputs,
    "processing release inputs asset",
    context,
    `${prefix}processing-release-inputs.json`,
  );
  const costModel = validateAsset(
    manifest.costModel,
    "live cost model asset",
    context,
    `${prefix}live-cost-model.json`,
  );
  const web = assertObject(manifest.web, "web release assets");
  assertExactKeys(web, ["staging", "production"], "web release assets");
  const webStaging = validateWebAsset(web.staging, "staging", context);
  const webProduction = validateWebAsset(web.production, "production", context);
  if (web.staging.processingApiOrigin === web.production.processingApiOrigin) {
    throw new TypeError("staging and production processing API origins must be distinct");
  }

  const evidence = assertObject(manifest.evidence, "release evidence assets");
  assertExactKeys(evidence, ["bundle", "signature"], "release evidence assets");
  const evidenceBundle = validateAsset(
    evidence.bundle,
    "release evidence bundle asset",
    context,
    `evidence-v1--${releaseId}--processing-evidence.json`,
  );
  const evidenceSignature = validateAsset(
    evidence.signature,
    "release evidence signature asset",
    context,
    `evidence-v1--${releaseId}--processing-evidence.sig`,
  );
  const security = validateSecurityAssets(manifest.security, context);

  const identities = [
    candidate,
    report,
    engineOci,
    engineDocker,
    worker,
    releaseInputs,
    costModel,
    webStaging,
    webProduction,
    evidenceBundle,
    evidenceSignature,
    ...security,
  ];
  if (new Set(identities.map(({ assetId }) => assetId)).size !== identities.length) {
    throw new TypeError("processing release asset IDs are duplicated");
  }
  if (new Set(identities.map(({ asset }) => asset.name)).size !== identities.length) {
    throw new TypeError("processing release asset names are duplicated");
  }

  assertSha256(manifest.verificationSha256, "release asset verification SHA-256");
  const { verificationSha256: _verificationSha256, ...payload } = manifest;
  if (sha256Canonical(payload) !== manifest.verificationSha256) {
    throw new TypeError("processing release asset verification hash does not match");
  }
  return { manifest, releaseId };
}

async function readBoundedRegularFile(path, maximumBytes, label) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ELOOP") throw new TypeError(`${label} must not be a symbolic link`);
    throw error;
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

async function verifyCandidateBinding(manifest, releaseId, candidateRoot) {
  if (typeof candidateRoot !== "string" || candidateRoot.length === 0) {
    throw new TypeError("candidate root is required");
  }
  const requestedRoot = resolve(candidateRoot);
  const metadata = await stat(requestedRoot);
  if (!metadata.isDirectory()) throw new TypeError("candidate root must be a directory");
  if ((await realpath(requestedRoot)) !== requestedRoot) {
    throw new TypeError("candidate root must not be a symbolic link");
  }
  const bytes = await readBoundedRegularFile(
    join(requestedRoot, "processing-candidate.json"),
    MAXIMUM_CANDIDATE_MANIFEST_BYTES,
    "processing candidate manifest",
  );
  if (bytes.byteLength !== manifest.candidate.sizeBytes) {
    throw new TypeError("processing candidate size does not match the release asset manifest");
  }
  if (sha256Bytes(bytes) !== manifest.candidate.sha256) {
    throw new TypeError("processing candidate hash does not match the release asset manifest");
  }
  let candidate;
  try {
    candidate = validateProcessingCandidate(JSON.parse(bytes));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new TypeError("processing candidate manifest is invalid JSON");
    throw error;
  }
  if (candidate.state !== "finalized") {
    throw new TypeError("processing candidate must be finalized");
  }
  if (candidate.releaseId !== releaseId) {
    throw new TypeError("processing candidate release ID does not match");
  }
  if (candidate.gitSha !== manifest.release.targetSha) {
    throw new TypeError("processing candidate source SHA does not match");
  }
  const releaseAssets = candidate.releaseAssets;
  const assertAssetMatch = (candidateAsset, releaseAsset, label, hashField = "sha256") => {
    if (
      candidateAsset.sizeBytes !== releaseAsset.sizeBytes ||
      candidateAsset[hashField] !== releaseAsset.sha256
    ) {
      throw new TypeError(`candidate ${label} asset does not match the release asset manifest`);
    }
  };

  const report = releaseAssets.report;
  const engineOci = releaseAssets.engine.oci;
  const engineDocker = releaseAssets.engine.docker;
  const worker = releaseAssets.worker;
  const releaseInputs = releaseAssets.releaseInputs;
  const costModel = releaseAssets.costModel;
  const webStaging = releaseAssets.web.staging;
  const webProduction = releaseAssets.web.production;
  const evidenceBundle = releaseAssets.evidence.bundle;
  const evidenceSignature = releaseAssets.evidence.signature;
  const candidateSecurity = releaseAssets.security;

  assertAssetMatch(report, manifest.report, "release report");
  assertAssetMatch(engineOci, manifest.engine.oci, "engine OCI");
  assertAssetMatch(engineDocker, manifest.engine.docker, "engine Docker");
  assertAssetMatch(worker, manifest.worker, "Worker");
  assertAssetMatch(releaseInputs, manifest.releaseInputs, "processing release inputs");
  assertAssetMatch(costModel, manifest.costModel, "live cost model");
  assertAssetMatch(webStaging, manifest.web.staging, "staging web", "archiveSha256");
  assertAssetMatch(webProduction, manifest.web.production, "production web", "archiveSha256");
  if (
    webStaging.treeSha256 !== manifest.web.staging.treeSha256 ||
    webStaging.processingApiOrigin !== manifest.web.staging.processingApiOrigin ||
    webProduction.treeSha256 !== manifest.web.production.treeSha256 ||
    webProduction.processingApiOrigin !== manifest.web.production.processingApiOrigin
  ) {
    throw new TypeError("candidate web tree or processing API origin does not match");
  }
  assertAssetMatch(evidenceBundle, manifest.evidence.bundle, "release evidence bundle");
  assertAssetMatch(evidenceSignature, manifest.evidence.signature, "release evidence signature");
  for (const [key] of securityGates) {
    assertAssetMatch(candidateSecurity.gates[key], manifest.security.gates[key], `${key} gate`);
  }
  for (const groupName of ["sboms", "vulnerabilityReports"]) {
    for (const [key, scope] of securityScopes) {
      assertAssetMatch(
        candidateSecurity[groupName][key],
        manifest.security[groupName][key],
        `${scope} security ${groupName}`,
      );
    }
  }
}

const allowedFields = new Map([
  ["release.id", (manifest) => manifest.release.id],
  ["release.tag", (manifest) => manifest.release.tag],
  ["release.targetSha", (manifest) => manifest.release.targetSha],
  ...["candidate", "report", "worker", "releaseInputs", "costModel"].flatMap((section) =>
    genericAssetFields.map((field) => [
      `${section}.${field}`,
      (manifest) => manifest[section][field],
    ]),
  ),
  ...["oci", "docker"].flatMap((format) =>
    genericAssetFields.map((field) => [
      `engine.${format}.${field}`,
      (manifest) => manifest.engine[format][field],
    ]),
  ),
  ...["staging", "production"].flatMap((environment) =>
    webAssetFields.map((field) => [
      `web.${environment}.${field}`,
      (manifest) => manifest.web[environment][field],
    ]),
  ),
  ...["bundle", "signature"].flatMap((kind) =>
    genericAssetFields.map((field) => [
      `evidence.${kind}.${field}`,
      (manifest) => manifest.evidence[kind][field],
    ]),
  ),
  ...securityGates.flatMap(([key]) =>
    genericAssetFields.map((field) => [
      `security.gates.${key}.${field}`,
      (manifest) => manifest.security.gates[key][field],
    ]),
  ),
  ...["sboms", "vulnerabilityReports"].flatMap((groupName) =>
    securityScopes.flatMap(([key]) =>
      genericAssetFields.map((field) => [
        `security.${groupName}.${key}.${field}`,
        (manifest) => manifest.security[groupName][key][field],
      ]),
    ),
  ),
]);

export async function readProcessingReleaseAssetField(value, candidateRoot, field) {
  if (typeof field !== "string" || !allowedFields.has(field)) {
    throw new TypeError("processing release asset field is not allowlisted");
  }
  const { manifest, releaseId } = validateProcessingReleaseAssets(value);
  await verifyCandidateBinding(manifest, releaseId, candidateRoot);
  const output = allowedFields.get(field)(manifest);
  if (typeof output !== "string" && typeof output !== "number" && typeof output !== "boolean") {
    throw new TypeError("processing release asset field must be a scalar");
  }
  return output;
}

export async function readProcessingReleaseAssetsFile({ manifestPath, candidateRoot, field }) {
  const bytes = await readBoundedRegularFile(
    resolve(manifestPath),
    MAXIMUM_MANIFEST_BYTES,
    "processing release asset manifest",
  );
  let value;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw new TypeError("processing release asset manifest is invalid JSON");
  }
  return readProcessingReleaseAssetField(value, candidateRoot, field);
}

export async function runProcessingReleaseAssetsReader(argv, output = process.stdout) {
  const args = parseCliArguments(argv);
  assertExactKeys(args, ["manifest", "candidate-root", "field"], "release asset reader arguments");
  const value = await readProcessingReleaseAssetsFile({
    manifestPath: args.manifest,
    candidateRoot: args["candidate-root"],
    field: args.field,
  });
  output.write(`${String(value)}\n`);
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await runProcessingReleaseAssetsReader(process.argv.slice(2));
}
