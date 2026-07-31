import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const commonRequiredKeys = Object.freeze([
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_D1_API_TOKEN",
  "CLOUDFLARE_LOGPUSH_API_TOKEN",
  "LOGPUSH_R2_ACCESS_KEY_ID",
  "LOGPUSH_R2_SECRET_ACCESS_KEY",
  "ALERT_DESTINATION_ADDRESS",
]);

const commonTokenKeys = Object.freeze([
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_D1_API_TOKEN",
  "CLOUDFLARE_LOGPUSH_API_TOKEN",
  "LOGPUSH_R2_ACCESS_KEY_ID",
  "LOGPUSH_R2_SECRET_ACCESS_KEY",
]);

function deploymentKeys(deployment) {
  if (deployment !== "staging" && deployment !== "production") {
    throw new TypeError("deployment must be staging or production");
  }
  const prefix = deployment.toUpperCase();
  return {
    required: [
      ...commonRequiredKeys,
      `${prefix}_ANALYTICS_READ_TOKEN`,
      `${prefix}_LOGPUSH_STATUS_TOKEN`,
      `${prefix}_ABUSE_HMAC_SECRET_CURRENT`,
      `${prefix}_ABUSE_HMAC_SECRET_PREVIOUS`,
      `${prefix}_MAINTAINER_SESSION_ID`,
      `${prefix}_MAINTAINER_HASHES_JSON`,
    ],
    tokens: [
      ...commonTokenKeys,
      `${prefix}_ANALYTICS_READ_TOKEN`,
      `${prefix}_LOGPUSH_STATUS_TOKEN`,
    ],
    abuseCurrent: `${prefix}_ABUSE_HMAC_SECRET_CURRENT`,
    abusePrevious: `${prefix}_ABUSE_HMAC_SECRET_PREVIOUS`,
    maintainerSessionId: `${prefix}_MAINTAINER_SESSION_ID`,
    maintainerHashes: `${prefix}_MAINTAINER_HASHES_JSON`,
  };
}

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

function validateMaintainerHashes(value, key) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError(`${key} must be valid JSON`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length < 1 ||
    parsed.length > 32 ||
    parsed.some((hash) => typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) ||
    new Set(parsed).size !== parsed.length
  ) {
    throw new TypeError(`${key} must contain 1-32 unique lowercase SHA-256 hashes`);
  }
  return parsed.length;
}

export function validateProcessingDeploymentEnvironment(environment, deployment = "staging") {
  if (environment === null || typeof environment !== "object" || Array.isArray(environment)) {
    throw new TypeError("deployment environment must be an object");
  }
  const keys = deploymentKeys(deployment);
  const missingKeys = keys.required.filter(
    (key) => typeof environment[key] !== "string" || environment[key].length === 0,
  );
  if (missingKeys.length > 0) {
    throw new TypeError(`missing required deployment values: ${missingKeys.join(", ")}`);
  }

  if (!/^[0-9a-f]{32}$/.test(environment.CLOUDFLARE_ACCOUNT_ID)) {
    throw new TypeError("CLOUDFLARE_ACCOUNT_ID must be a lowercase 32-character account ID");
  }
  for (const key of keys.tokens) validateOpaqueValue(environment[key], key);
  validateHmacSecret(environment[keys.abuseCurrent], keys.abuseCurrent);
  validateHmacSecret(environment[keys.abusePrevious], keys.abusePrevious);
  const maintainerHashCount = validateMaintainerHashes(
    environment[keys.maintainerHashes],
    keys.maintainerHashes,
  );
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      environment[keys.maintainerSessionId],
    )
  ) {
    throw new TypeError(`${keys.maintainerSessionId} must be a canonical UUID v4`);
  }
  const maintainerHashes = JSON.parse(environment[keys.maintainerHashes]);
  const expectedMaintainerHash = createHash("sha256")
    .update(environment[keys.maintainerSessionId])
    .digest("hex");
  if (!maintainerHashes.includes(expectedMaintainerHash)) {
    throw new TypeError(`${keys.maintainerSessionId} is not present in its hashed allowlist`);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(environment.ALERT_DESTINATION_ADDRESS)) {
    throw new TypeError("ALERT_DESTINATION_ADDRESS must be an email address");
  }
  return { ready: true, checked: keys.required.length, maintainerHashCount };
}

export function writeProcessingDeploymentEnvironmentSummary(
  environment,
  stdout = process.stdout,
  deployment = "staging",
) {
  const summary = validateProcessingDeploymentEnvironment(environment, deployment);
  stdout.write(`${JSON.stringify(summary)}\n`);
  return summary;
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const args = process.argv.slice(2);
  const deployment = args.length === 0 ? "staging" : args[0] === "--environment" ? args[1] : null;
  if (deployment === null || args.length > 2) {
    process.stderr.write(
      "usage: verify-processing-deployment-environment [--environment staging|production]\n",
    );
    process.exitCode = 1;
  } else {
    try {
      writeProcessingDeploymentEnvironmentSummary(process.env, process.stdout, deployment);
    } catch (error) {
      const message = error instanceof Error ? error.message : "deployment environment is invalid";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    }
  }
}
