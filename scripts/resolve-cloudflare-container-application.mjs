import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertExactKeys,
  assertObject,
  parseCliArguments,
  sha256Canonical,
  writeCanonicalJsonAtomic,
} from "./image-lab-common.mjs";

const maximumInputBytes = 1024 * 1024;
const accountIdPattern = /^[0-9a-f]{32}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const workerNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const digestImagePattern =
  /^registry\.cloudflare\.com\/([0-9a-f]{32})\/hereisit-image-engine@sha256:([0-9a-f]{64})$/;
const utcTimestampPattern = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/;
const acceptedStates = new Set(["provisioning", "ready", "active"]);

function assertIsoTimestamp(value, label) {
  const match = typeof value === "string" ? utcTimestampPattern.exec(value) : null;
  const normalized = match ? `${match[1]}.${(match[2] ?? "").padEnd(3, "0").slice(0, 3)}Z` : "";
  if (
    !match ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== normalized
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function validateApplication(value) {
  const application = assertObject(value, "Container application");
  assertExactKeys(
    application,
    ["id", "name", "state", "instances", "image", "version", "updated_at", "created_at"],
    "Container application",
  );
  if (!uuidPattern.test(application.id)) throw new TypeError("Container application ID is invalid");
  if (typeof application.name !== "string" || application.name.length > 128) {
    throw new TypeError("Container application name is invalid");
  }
  if (typeof application.state !== "string") {
    throw new TypeError("Container application state is invalid");
  }
  if (!Number.isSafeInteger(application.instances) || application.instances < 0) {
    throw new TypeError("Container application instance count is invalid");
  }
  if (typeof application.image !== "string" || application.image.length > 512) {
    throw new TypeError("Container application image is invalid");
  }
  if (!Number.isSafeInteger(application.version) || application.version < 1) {
    throw new TypeError("Container application version is invalid");
  }
  assertIsoTimestamp(application.updated_at, "Container application update time");
  assertIsoTimestamp(application.created_at, "Container application creation time");
  return application;
}

function validateApplicationDetail(value) {
  const application = assertObject(value, "Container application detail");
  if (!uuidPattern.test(application.id)) throw new TypeError("Container application ID is invalid");
  if (typeof application.name !== "string" || application.name.length > 128) {
    throw new TypeError("Container application name is invalid");
  }
  if (!Number.isSafeInteger(application.instances) || application.instances < 0) {
    throw new TypeError("Container application instance count is invalid");
  }
  if (!Number.isSafeInteger(application.version) || application.version < 1) {
    throw new TypeError("Container application version is invalid");
  }
  assertIsoTimestamp(application.updated_at, "Container application update time");
  assertIsoTimestamp(application.created_at, "Container application creation time");
  const configuration = assertObject(
    application.configuration,
    "Container application configuration",
  );
  if (typeof configuration.image !== "string" || configuration.image.length > 512) {
    throw new TypeError("Container application image is invalid");
  }
  const health = assertObject(application.health, "Container application health");
  const healthInstances = assertObject(health.instances, "Container application instance health");
  for (const key of ["failed", "starting", "scheduling", "active"]) {
    if (!Number.isSafeInteger(healthInstances[key]) || healthInstances[key] < 0) {
      throw new TypeError("Container application health is invalid");
    }
  }
  const state =
    healthInstances.failed > 0
      ? "degraded"
      : healthInstances.starting > 0 || healthInstances.scheduling > 0
        ? "provisioning"
        : healthInstances.active > 0
          ? "active"
          : "ready";
  return {
    id: application.id,
    accountId: application.account_id,
    name: application.name,
    state,
    instances: application.instances,
    image: configuration.image,
    version: application.version,
    updated_at: application.updated_at,
    created_at: application.created_at,
  };
}

function validateIdentity(input) {
  if (input.environment !== "staging" && input.environment !== "production") {
    throw new TypeError("Container application environment is invalid");
  }
  if (typeof input.accountId !== "string" || !accountIdPattern.test(input.accountId)) {
    throw new TypeError("Container application account ID is invalid");
  }
  if (
    typeof input.workerScriptName !== "string" ||
    !workerNamePattern.test(input.workerScriptName) ||
    input.workerScriptName !== `hereisit-processing-${input.environment}`
  ) {
    throw new TypeError("Container application Worker name is invalid");
  }
  return `${input.workerScriptName}-ImageEngineContainer`.toLowerCase();
}

function sealApplication(input, application) {
  const unsigned = {
    schema: "hereisit-container-provider-scope@1",
    version: 1,
    environment: input.environment,
    accountId: input.accountId,
    observedAt: input.observedAt,
    application: {
      id: application.id,
      name: application.name,
      image: application.image,
      version: application.version,
      state: application.state,
    },
  };
  return { ...unsigned, verificationSha256: sha256Canonical(unsigned) };
}

export function resolveContainerApplicationId(inputValue) {
  const input = assertObject(inputValue, "Container application discovery input");
  assertExactKeys(
    input,
    ["environment", "accountId", "workerScriptName", "applications"],
    "Container application discovery input",
  );
  const expectedName = validateIdentity(input);
  if (!Array.isArray(input.applications) || input.applications.length > 1_000) {
    throw new TypeError("Container application inventory is invalid");
  }
  const matches = input.applications
    .map(validateApplication)
    .filter((application) => application.name === expectedName);
  if (matches.length !== 1) {
    throw new TypeError("Container application inventory must contain exactly one expected app");
  }
  const application = matches[0];
  if (digestImagePattern.exec(application.image)?.[1] !== input.accountId) {
    throw new TypeError("Container application summary image is outside the account registry");
  }
  if (!acceptedStates.has(application.state)) {
    throw new TypeError("Container application is degraded or unavailable");
  }
  return application.id;
}

export function resolveContainerApplicationDetail(inputValue) {
  const input = assertObject(inputValue, "Container application detail input");
  assertExactKeys(
    input,
    [
      "environment",
      "accountId",
      "workerScriptName",
      "applicationId",
      "engineImage",
      "observedAt",
      "application",
    ],
    "Container application detail input",
  );
  const { accountId: detailAccountId, ...application } = validateApplicationDetail(
    input.application,
  );
  if (application.id !== input.applicationId || detailAccountId !== input.accountId) {
    throw new TypeError("Container application detail identity does not match");
  }
  return resolveContainerApplication({
    environment: input.environment,
    accountId: input.accountId,
    workerScriptName: input.workerScriptName,
    engineImage: input.engineImage,
    observedAt: input.observedAt,
    applications: [application],
  });
}

export function resolveContainerApplication(inputValue) {
  const input = assertObject(inputValue, "Container application resolution input");
  assertExactKeys(
    input,
    ["environment", "accountId", "workerScriptName", "engineImage", "observedAt", "applications"],
    "Container application resolution input",
  );
  const expectedName = validateIdentity(input);
  const imageMatch =
    typeof input.engineImage === "string" ? digestImagePattern.exec(input.engineImage) : null;
  if (imageMatch?.[1] !== input.accountId) {
    throw new TypeError("Container application image is not an immutable account image");
  }
  assertIsoTimestamp(input.observedAt, "Container application observation time");
  if (!Array.isArray(input.applications) || input.applications.length > 1_000) {
    throw new TypeError("Container application inventory is invalid");
  }
  const matches = input.applications
    .map(validateApplication)
    .filter((application) => application.name === expectedName);
  if (matches.length !== 1) {
    throw new TypeError("Container application inventory must contain exactly one expected app");
  }
  const application = matches[0];
  if (application.image !== input.engineImage) {
    throw new TypeError("Container application image does not match the release digest");
  }
  if (!acceptedStates.has(application.state)) {
    throw new TypeError("Container application is degraded or unavailable");
  }
  return sealApplication(input, application);
}

async function readBoundedJson(path) {
  let handle;
  try {
    handle = await open(path, "r");
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maximumInputBytes) {
      throw new RangeError("Container application inventory exceeds its bound");
    }
    const bytes = Buffer.alloc(metadata.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== metadata.size)
      throw new Error("Container application inventory read changed");
    return JSON.parse(bytes.toString("utf8", 0, bytesRead));
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function runContainerApplicationResolver(argv, stdout = process.stdout) {
  const args = parseCliArguments(argv);
  const commonKeys = ["mode", "input", "environment", "account-id", "worker-script-name"];
  const expectedKeys =
    args.mode === "discover"
      ? new Set(commonKeys)
      : new Set([...commonKeys, "output", "application-id", "engine-image", "observed-at"]);
  if (
    (args.mode !== "discover" && args.mode !== "verify") ||
    Object.keys(args).some((key) => !expectedKeys.has(key))
  ) {
    throw new TypeError("unknown Container application resolver argument");
  }
  for (const key of expectedKeys) {
    if (args[key] === undefined) throw new TypeError(`--${key} is required`);
  }
  const common = {
    environment: args.environment,
    accountId: args["account-id"],
    workerScriptName: args["worker-script-name"],
  };
  const document = await readBoundedJson(resolve(args.input));
  if (args.mode === "discover") {
    stdout.write(`${resolveContainerApplicationId({ ...common, applications: document })}\n`);
    return;
  }
  const result = resolveContainerApplicationDetail({
    ...common,
    application: document,
    applicationId: args["application-id"],
    engineImage: args["engine-image"],
    observedAt: args["observed-at"],
  });
  await writeCanonicalJsonAtomic(resolve(args.output), result, { refuseOverwrite: true });
  stdout.write(`${result.application.id}\n`);
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    await runContainerApplicationResolver(process.argv.slice(2));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Container application resolver failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
