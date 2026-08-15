import { posix } from "node:path";
import {
  assertExactKeys,
  assertNonNegativeSafeInteger,
  assertObject,
  assertSha256,
  sha256Canonical,
} from "./image-lab-common.mjs";

const gitShaPattern = /^[a-f0-9]{40}$/;
const scopes = ["worker", "webStaging", "webProduction", "lockfile"];
const maximumLifetimeMs = 24 * 60 * 60 * 1000;

function validateTimestamp(value, label) {
  if (typeof value !== "string" || new Date(value).toISOString() !== value) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function validateArtifact(value, label, extraKeys = []) {
  const artifact = assertObject(value, label);
  assertExactKeys(artifact, ["path", "sizeBytes", "sha256", ...extraKeys], label);
  if (
    typeof artifact.path !== "string" ||
    !artifact.path.startsWith(".artifacts/application/") ||
    artifact.path.includes("\\") ||
    posix.normalize(artifact.path) !== artifact.path ||
    artifact.path.includes(":")
  ) {
    throw new TypeError(`${label} path is invalid`);
  }
  assertNonNegativeSafeInteger(artifact.sizeBytes, `${label} size`);
  if (artifact.sizeBytes < 1) throw new TypeError(`${label} size is invalid`);
  assertSha256(artifact.sha256, `${label} hash`);
  for (const key of extraKeys) assertSha256(artifact[key], `${label} ${key}`);
  return { ...artifact };
}

function validateSecurityGroup(value, label) {
  const group = assertObject(value, label);
  assertExactKeys(group, scopes, label);
  return Object.fromEntries(
    scopes.map((scope) => [scope, validateArtifact(group[scope], `${label} ${scope}`)]),
  );
}

function validatePayload(value) {
  const input = assertObject(value, "processing application release");
  assertExactKeys(
    input,
    [
      "schema",
      "version",
      "gitSha",
      "baseReleaseReportSha256",
      "worker",
      "web",
      "security",
      "createdAt",
      "expiresAt",
    ],
    "processing application release",
  );
  if (input.schema !== "hereisit-processing-application-release@1" || input.version !== 1) {
    throw new TypeError("processing application release schema is invalid");
  }
  if (typeof input.gitSha !== "string" || !gitShaPattern.test(input.gitSha)) {
    throw new TypeError("processing application release Git SHA is invalid");
  }
  assertSha256(input.baseReleaseReportSha256, "base release report hash");
  const web = assertObject(input.web, "processing application web artifacts");
  assertExactKeys(web, ["staging", "production"], "processing application web artifacts");
  const security = assertObject(input.security, "processing application security evidence");
  assertExactKeys(
    security,
    ["sboms", "vulnerabilityReports"],
    "processing application security evidence",
  );
  const createdAt = validateTimestamp(input.createdAt, "createdAt");
  const expiresAt = validateTimestamp(input.expiresAt, "expiresAt");
  const lifetime = Date.parse(expiresAt) - Date.parse(createdAt);
  if (lifetime <= 0 || lifetime > maximumLifetimeMs) {
    throw new TypeError("processing application release lifetime is invalid");
  }
  return {
    schema: input.schema,
    version: input.version,
    gitSha: input.gitSha,
    baseReleaseReportSha256: input.baseReleaseReportSha256,
    worker: validateArtifact(input.worker, "Worker artifact"),
    web: {
      staging: validateArtifact(web.staging, "staging web artifact", ["treeSha256"]),
      production: validateArtifact(web.production, "production web artifact", ["treeSha256"]),
    },
    security: {
      sboms: validateSecurityGroup(security.sboms, "SBOM evidence"),
      vulnerabilityReports: validateSecurityGroup(
        security.vulnerabilityReports,
        "vulnerability evidence",
      ),
    },
    createdAt,
    expiresAt,
  };
}

export function createProcessingApplicationRelease(input) {
  const payload = validatePayload({
    schema: "hereisit-processing-application-release@1",
    version: 1,
    ...input,
  });
  return { ...payload, verificationSha256: sha256Canonical(payload) };
}

export function validateProcessingApplicationRelease(value) {
  const release = assertObject(value, "processing application release");
  assertExactKeys(
    release,
    [
      "schema",
      "version",
      "gitSha",
      "baseReleaseReportSha256",
      "worker",
      "web",
      "security",
      "createdAt",
      "expiresAt",
      "verificationSha256",
    ],
    "processing application release",
  );
  const { verificationSha256, ...rawPayload } = release;
  const payload = validatePayload(rawPayload);
  assertSha256(verificationSha256, "processing application release verification hash");
  if (verificationSha256 !== sha256Canonical(payload)) {
    throw new TypeError("processing application release verification hash does not match");
  }
  return { ...payload, verificationSha256 };
}
