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

const maximumBytes = 256 * 1024;
const accountIdPattern = /^[0-9a-f]{32}$/;
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const queueIdPattern = /^[0-9a-f]{32}$/;

function exact(value, keys, label) {
  const object = assertObject(value, label);
  assertExactKeys(object, keys, label);
  return object;
}

function validateBucket(value, name, days, label) {
  const bucket = exact(value, ["name", "lifecycleDays", "private"], label);
  if (bucket.name !== name || bucket.lifecycleDays !== days || bucket.private !== true) {
    throw new TypeError(`${label} does not match its private retention contract`);
  }
}

function validateQueue(value, name, label) {
  const queue = exact(value, ["id", "name", "deliveryPaused"], label);
  if (
    typeof queue.id !== "string" ||
    !queueIdPattern.test(queue.id) ||
    queue.name !== name ||
    queue.deliveryPaused !== true
  ) {
    throw new TypeError(`${label} does not match its paused provisioning contract`);
  }
}

export function validateProcessingProvisionManifest(value) {
  const manifest = exact(
    value,
    [
      "schema",
      "version",
      "phase",
      "environment",
      "accountId",
      "verifiedAt",
      "d1",
      "r2",
      "queues",
      "analytics",
      "logpush",
      "verificationSha256",
    ],
    "processing provision manifest",
  );
  if (
    manifest.schema !== "hereisit-processing-resource-provision@1" ||
    manifest.version !== 1 ||
    manifest.phase !== "provision"
  ) {
    throw new TypeError("processing provision manifest schema is invalid");
  }
  if (manifest.environment !== "staging" && manifest.environment !== "production") {
    throw new TypeError("processing provision environment is invalid");
  }
  if (typeof manifest.accountId !== "string" || !accountIdPattern.test(manifest.accountId)) {
    throw new TypeError("processing provision account ID is invalid");
  }
  if (
    typeof manifest.verifiedAt !== "string" ||
    !Number.isFinite(Date.parse(manifest.verifiedAt)) ||
    new Date(manifest.verifiedAt).toISOString() !== manifest.verifiedAt
  ) {
    throw new TypeError("processing provision verification time is invalid");
  }
  assertSha256(manifest.verificationSha256, "processing provision verification hash");
  const { verificationSha256: _verificationSha256, ...unsigned } = manifest;
  if (manifest.verificationSha256 !== sha256Canonical(unsigned)) {
    throw new TypeError("processing provision manifest hash does not match");
  }
  const suffix = manifest.environment;
  const d1 = exact(manifest.d1, ["databaseId", "name", "requestedLocationHint"], "D1 provision");
  if (
    typeof d1.databaseId !== "string" ||
    !uuidPattern.test(d1.databaseId) ||
    d1.name !== `hereisit-processing-${suffix}` ||
    d1.requestedLocationHint !== "apac"
  ) {
    throw new TypeError("D1 provision does not match");
  }
  const r2 = exact(manifest.r2, ["jobs", "usage"], "R2 provision");
  validateBucket(r2.jobs, `hereisit-processing-${suffix}`, 1, "job bucket provision");
  validateBucket(r2.usage, `hereisit-processing-usage-${suffix}`, 3, "usage bucket provision");
  const queues = exact(manifest.queues, ["image", "pdf"], "Queue provision");
  const imageQueues = exact(queues.image, ["primary", "dlq"], "image Queue provision");
  const pdfQueues = exact(queues.pdf, ["primary", "dlq"], "PDF Queue provision");
  validateQueue(
    imageQueues.primary,
    `hereisit-image-jobs-${suffix}`,
    "image primary Queue provision",
  );
  validateQueue(imageQueues.dlq, `hereisit-image-jobs-dlq-${suffix}`, "image DLQ provision");
  validateQueue(pdfQueues.primary, `hereisit-pdf-jobs-${suffix}`, "PDF primary Queue provision");
  validateQueue(pdfQueues.dlq, `hereisit-pdf-jobs-dlq-${suffix}`, "PDF DLQ provision");
  const queueIds = [
    imageQueues.primary.id,
    imageQueues.dlq.id,
    pdfQueues.primary.id,
    pdfQueues.dlq.id,
  ];
  if (new Set(queueIds).size !== queueIds.length) {
    throw new TypeError("provisioned Queue IDs collide");
  }
  const analytics = exact(manifest.analytics, ["datasetName", "state"], "Analytics provision");
  if (
    analytics.datasetName !== `hereisit_processing_usage_${suffix}` ||
    analytics.state !== "binding-deferred"
  ) {
    throw new TypeError("Analytics provision does not match");
  }
  const logpush = exact(manifest.logpush, ["jobId", "configSha256"], "Logpush provision");
  if (!Number.isSafeInteger(logpush.jobId) || logpush.jobId < 1) {
    throw new TypeError("Logpush provision job ID is invalid");
  }
  assertSha256(logpush.configSha256, "Logpush provision configuration hash");
  return manifest;
}

const fieldReaders = Object.freeze({
  environment: (manifest) => manifest.environment,
  accountId: (manifest) => manifest.accountId,
  "d1.databaseId": (manifest) => manifest.d1.databaseId,
  "r2.jobs.name": (manifest) => manifest.r2.jobs.name,
  "r2.usage.name": (manifest) => manifest.r2.usage.name,
  "queues.image.primary.id": (manifest) => manifest.queues.image.primary.id,
  "queues.image.dlq.id": (manifest) => manifest.queues.image.dlq.id,
  "queues.pdf.primary.id": (manifest) => manifest.queues.pdf.primary.id,
  "queues.pdf.dlq.id": (manifest) => manifest.queues.pdf.dlq.id,
  "analytics.datasetName": (manifest) => manifest.analytics.datasetName,
  "logpush.jobId": (manifest) => manifest.logpush.jobId,
});

export function readProcessingProvisionField(value, field) {
  if (typeof field !== "string" || !Object.hasOwn(fieldReaders, field)) {
    throw new TypeError("processing provision field is not allowlisted");
  }
  return fieldReaders[field](validateProcessingProvisionManifest(value));
}

async function readBoundedJson(file) {
  let handle;
  try {
    handle = await open(file, "r");
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maximumBytes) {
      throw new RangeError("processing provision manifest exceeds its bound");
    }
    const bytes = Buffer.alloc(metadata.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== metadata.size) throw new Error("processing provision manifest read changed");
    return JSON.parse(bytes.toString("utf8", 0, bytesRead));
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function runProcessingProvisionReader(argv, stdout = process.stdout) {
  const args = parseCliArguments(argv);
  if (Object.keys(args).some((key) => key !== "file" && key !== "field")) {
    throw new TypeError("unknown processing provision reader argument");
  }
  if (args.file === undefined || args.field === undefined) {
    throw new TypeError("--file and --field are required");
  }
  const value = readProcessingProvisionField(await readBoundedJson(resolve(args.file)), args.field);
  stdout.write(`${String(value)}\n`);
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    await runProcessingProvisionReader(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : "processing provision reader failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
