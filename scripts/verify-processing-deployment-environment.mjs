import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const requiredKeys = Object.freeze([
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_D1_API_TOKEN",
  "CLOUDFLARE_LOGPUSH_API_TOKEN",
  "LOGPUSH_R2_ACCESS_KEY_ID",
  "LOGPUSH_R2_SECRET_ACCESS_KEY",
  "STAGING_ANALYTICS_READ_TOKEN",
  "STAGING_LOGPUSH_STATUS_TOKEN",
  "STAGING_ABUSE_HMAC_SECRET_CURRENT",
  "STAGING_ABUSE_HMAC_SECRET_PREVIOUS",
  "STAGING_MAINTAINER_SESSION_ID",
  "STAGING_MAINTAINER_HASHES_JSON",
  "ALERT_DESTINATION_ADDRESS",
]);

const tokenKeys = Object.freeze([
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_D1_API_TOKEN",
  "CLOUDFLARE_LOGPUSH_API_TOKEN",
  "LOGPUSH_R2_ACCESS_KEY_ID",
  "LOGPUSH_R2_SECRET_ACCESS_KEY",
  "STAGING_ANALYTICS_READ_TOKEN",
  "STAGING_LOGPUSH_STATUS_TOKEN",
]);

function validateOpaqueValue(value, key) {
  if (value.length < 20 || value.length > 512 || /\s/.test(value)) {
    throw new TypeError(`${key} has an invalid credential envelope`);
  }
}

function validateHmacSecret(value, key) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new TypeError(`${key} must be canonical 32-byte base64url`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== 32 || decoded.toString("base64url") !== value) {
    throw new TypeError(`${key} must be canonical 32-byte base64url`);
  }
}

function validateMaintainerHashes(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("STAGING_MAINTAINER_HASHES_JSON must be valid JSON");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length < 1 ||
    parsed.length > 32 ||
    parsed.some((hash) => typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) ||
    new Set(parsed).size !== parsed.length
  ) {
    throw new TypeError(
      "STAGING_MAINTAINER_HASHES_JSON must contain 1-32 unique lowercase SHA-256 hashes",
    );
  }
  return parsed.length;
}

export function validateProcessingDeploymentEnvironment(environment) {
  if (environment === null || typeof environment !== "object" || Array.isArray(environment)) {
    throw new TypeError("deployment environment must be an object");
  }
  const missingKeys = requiredKeys.filter(
    (key) => typeof environment[key] !== "string" || environment[key].length === 0,
  );
  if (missingKeys.length > 0) {
    throw new TypeError(`missing required deployment values: ${missingKeys.join(", ")}`);
  }

  if (!/^[0-9a-f]{32}$/.test(environment.CLOUDFLARE_ACCOUNT_ID)) {
    throw new TypeError("CLOUDFLARE_ACCOUNT_ID must be a lowercase 32-character account ID");
  }
  for (const key of tokenKeys) validateOpaqueValue(environment[key], key);
  validateHmacSecret(
    environment.STAGING_ABUSE_HMAC_SECRET_CURRENT,
    "STAGING_ABUSE_HMAC_SECRET_CURRENT",
  );
  validateHmacSecret(
    environment.STAGING_ABUSE_HMAC_SECRET_PREVIOUS,
    "STAGING_ABUSE_HMAC_SECRET_PREVIOUS",
  );
  const maintainerHashCount = validateMaintainerHashes(environment.STAGING_MAINTAINER_HASHES_JSON);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      environment.STAGING_MAINTAINER_SESSION_ID,
    )
  ) {
    throw new TypeError("STAGING_MAINTAINER_SESSION_ID must be a canonical UUID");
  }
  const maintainerHashes = JSON.parse(environment.STAGING_MAINTAINER_HASHES_JSON);
  const expectedMaintainerHash = createHash("sha256")
    .update(environment.STAGING_MAINTAINER_SESSION_ID)
    .digest("hex");
  if (!maintainerHashes.includes(expectedMaintainerHash)) {
    throw new TypeError("STAGING_MAINTAINER_SESSION_ID is not present in its hashed allowlist");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(environment.ALERT_DESTINATION_ADDRESS)) {
    throw new TypeError("ALERT_DESTINATION_ADDRESS must be an email address");
  }
  return { ready: true, checked: requiredKeys.length, maintainerHashCount };
}

export function writeProcessingDeploymentEnvironmentSummary(environment, stdout = process.stdout) {
  const summary = validateProcessingDeploymentEnvironment(environment);
  stdout.write(`${JSON.stringify(summary)}\n`);
  return summary;
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  if (process.argv.length !== 2) {
    process.stderr.write("verify-processing-deployment-environment accepts no arguments\n");
    process.exitCode = 1;
  } else {
    try {
      writeProcessingDeploymentEnvironmentSummary(process.env);
    } catch (error) {
      const message = error instanceof Error ? error.message : "deployment environment is invalid";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    }
  }
}
