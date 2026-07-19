import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertExactKeys,
  assertObject,
  assertSha256,
  parseCliArguments,
  sha256Canonical,
} from "./image-lab-common.mjs";

const maximumManifestBytes = 256 * 1024;
const accountIdPattern = /^[0-9a-f]{32}$/;
const resourceIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const queueIdPattern = /^[0-9a-f]{32}$/;

function assertString(value, label, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function assertVerified(value, label) {
  if (value !== true) throw new TypeError(`${label} must be verified`);
}

function validateR2Bucket(value, label, expectedName, lifecycleDays) {
  const bucket = assertObject(value, label);
  assertExactKeys(bucket, ["name", "lifecycleDays", "private"], label);
  if (bucket.name !== expectedName) throw new TypeError(`${label} name does not match`);
  if (bucket.lifecycleDays !== lifecycleDays) {
    throw new TypeError(`${label} lifecycle does not match`);
  }
  if (bucket.private !== true) throw new TypeError(`${label} must be private`);
}

function validateQueue(value, label, expectedName) {
  const queue = assertObject(value, label);
  assertExactKeys(queue, ["id", "name", "deliveryPaused"], label);
  assertString(queue.id, `${label} ID`, queueIdPattern);
  if (queue.name !== expectedName) throw new TypeError(`${label} name does not match`);
  if (queue.deliveryPaused !== true) throw new TypeError(`${label} delivery must be paused`);
}

function validateEnvironment(value) {
  const entry = assertObject(value, "resource environment");
  assertExactKeys(
    entry,
    [
      "environment",
      "accountId",
      "verifiedAt",
      "d1",
      "r2",
      "queues",
      "analytics",
      "logpush",
      "providerUsage",
    ],
    "resource environment",
  );

  if (entry.environment !== "staging" && entry.environment !== "production") {
    throw new TypeError("resource environment is invalid");
  }
  assertString(entry.accountId, "resource account ID", accountIdPattern);
  if (
    typeof entry.verifiedAt !== "string" ||
    !Number.isFinite(Date.parse(entry.verifiedAt)) ||
    new Date(entry.verifiedAt).toISOString() !== entry.verifiedAt
  ) {
    throw new TypeError("resource verification time is invalid");
  }

  const suffix = entry.environment;
  const d1 = assertObject(entry.d1, "D1 resource");
  assertExactKeys(d1, ["databaseId", "name", "location"], "D1 resource");
  assertString(d1.databaseId, "D1 database ID", resourceIdPattern);
  if (d1.name !== `hereisit-processing-${suffix}`) {
    throw new TypeError("D1 resource name does not match");
  }
  if (d1.location !== "apac") throw new TypeError("D1 resource location must be apac");

  const r2 = assertObject(entry.r2, "R2 resources");
  assertExactKeys(r2, ["jobs", "usage"], "R2 resources");
  validateR2Bucket(r2.jobs, "job R2 bucket", `hereisit-processing-${suffix}`, 1);
  validateR2Bucket(r2.usage, "usage R2 bucket", `hereisit-processing-usage-${suffix}`, 3);

  const queues = assertObject(entry.queues, "Queue resources");
  assertExactKeys(queues, ["primary", "dlq"], "Queue resources");
  validateQueue(queues.primary, "primary Queue", `hereisit-image-jobs-${suffix}`);
  validateQueue(queues.dlq, "dead-letter Queue", `hereisit-image-jobs-dlq-${suffix}`);
  if (queues.primary.id === queues.dlq.id) throw new TypeError("Queue IDs must be distinct");

  const analytics = assertObject(entry.analytics, "Analytics resource");
  assertExactKeys(analytics, ["datasetName", "verified", "workerVersionId"], "Analytics resource");
  if (analytics.datasetName !== `hereisit_processing_usage_${suffix}`) {
    throw new TypeError("Analytics dataset name does not match");
  }
  assertVerified(analytics.verified, "Analytics resource");
  assertString(analytics.workerVersionId, "Analytics Worker version ID", resourceIdPattern);

  const logpush = assertObject(entry.logpush, "Logpush resource");
  assertExactKeys(logpush, ["jobId", "configSha256", "verified"], "Logpush resource");
  if (!Number.isSafeInteger(logpush.jobId) || logpush.jobId < 1) {
    throw new TypeError("Logpush job ID is invalid");
  }
  assertSha256(logpush.configSha256, "Logpush configuration hash");
  assertVerified(logpush.verified, "Logpush resource");

  const providerUsage = assertObject(entry.providerUsage, "provider usage resource");
  assertExactKeys(providerUsage, ["schemaSha256", "verified"], "provider usage resource");
  assertSha256(providerUsage.schemaSha256, "provider usage schema hash");
  assertVerified(providerUsage.verified, "provider usage resource");

  return entry;
}

export function validateResourceManifest(value) {
  const manifest = assertObject(value, "resource manifest");
  assertExactKeys(
    manifest,
    ["schema", "version", "sealed", "environments", "verificationSha256"],
    "resource manifest",
  );
  if (manifest.schema !== "hereisit-processing-resources@1" || manifest.version !== 1) {
    throw new TypeError("resource manifest schema is invalid");
  }
  if (manifest.sealed !== true) throw new TypeError("resource manifest must be sealed");
  assertSha256(manifest.verificationSha256, "resource manifest verification hash");
  const expectedVerification = sha256Canonical({
    schema: manifest.schema,
    version: manifest.version,
    sealed: manifest.sealed,
    environments: manifest.environments,
  });
  if (manifest.verificationSha256 !== expectedVerification) {
    throw new TypeError("resource manifest verification hash does not match");
  }
  if (!Array.isArray(manifest.environments) || manifest.environments.length === 0) {
    throw new TypeError("resource manifest environments must be a non-empty array");
  }

  const environments = manifest.environments.map(validateEnvironment);
  const seen = new Set();
  for (const entry of environments) {
    if (seen.has(entry.environment)) {
      throw new TypeError(`duplicate resource environment: ${entry.environment}`);
    }
    seen.add(entry.environment);
  }
  if (environments.length !== 1) {
    throw new TypeError("resource manifest must contain exactly one environment");
  }
  return environments[0];
}

const fieldReaders = Object.freeze({
  environment: (entry) => entry.environment,
  accountId: (entry) => entry.accountId,
  "d1.databaseId": (entry) => entry.d1.databaseId,
  "r2.jobs.name": (entry) => entry.r2.jobs.name,
  "r2.usage.name": (entry) => entry.r2.usage.name,
  "queues.primary.id": (entry) => entry.queues.primary.id,
  "queues.dlq.id": (entry) => entry.queues.dlq.id,
  "analytics.datasetName": (entry) => entry.analytics.datasetName,
  "logpush.jobId": (entry) => entry.logpush.jobId,
  "providerUsage.schemaSha256": (entry) => entry.providerUsage.schemaSha256,
});

export function readResourceManifestField(manifest, field) {
  if (typeof field !== "string" || !Object.hasOwn(fieldReaders, field)) {
    throw new TypeError("resource manifest field is not allowlisted");
  }
  const entry = validateResourceManifest(manifest);
  return fieldReaders[field](entry);
}

async function readBoundedManifestText(file) {
  let handle;
  try {
    handle = await open(file, "r");
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new TypeError("resource manifest input must be a regular file");
    if (metadata.size > maximumManifestBytes) {
      throw new RangeError("resource manifest exceeds the maximum input size");
    }

    const buffer = Buffer.alloc(maximumManifestBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maximumManifestBytes) {
      throw new RangeError("resource manifest exceeds the maximum input size");
    }
    return buffer.toString("utf8", 0, offset);
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) throw error;
    throw new Error("resource manifest file could not be read");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readResourceManifestFile({ file, field }) {
  if (typeof file !== "string" || file.length === 0) {
    throw new TypeError("resource manifest file is required");
  }
  const text = await readBoundedManifestText(file);
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new TypeError("resource manifest JSON is invalid");
  }
  return readResourceManifestField(manifest, field);
}

export async function runResourceManifestReader(argv, stdout = process.stdout) {
  const args = parseCliArguments(argv);
  if (Object.keys(args).some((key) => key !== "file" && key !== "field")) {
    throw new TypeError("unknown resource manifest reader argument");
  }
  if (args.file === undefined || args.field === undefined) {
    throw new TypeError("--file and --field are required");
  }
  const value = await readResourceManifestFile({
    file: resolve(args.file),
    field: args.field,
  });
  stdout.write(`${String(value)}\n`);
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    await runResourceManifestReader(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : "resource manifest reader failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
