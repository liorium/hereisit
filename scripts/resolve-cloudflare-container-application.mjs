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
const acceptedStates = new Set(["provisioning", "ready", "active"]);

function assertIsoTimestamp(value, label) {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
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

export function resolveContainerApplication(inputValue) {
  const input = assertObject(inputValue, "Container application resolution input");
  assertExactKeys(
    input,
    ["environment", "accountId", "workerScriptName", "engineImage", "observedAt", "applications"],
    "Container application resolution input",
  );
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
  const imageMatch =
    typeof input.engineImage === "string" ? digestImagePattern.exec(input.engineImage) : null;
  if (imageMatch?.[1] !== input.accountId) {
    throw new TypeError("Container application image is not an immutable account image");
  }
  assertIsoTimestamp(input.observedAt, "Container application observation time");
  if (!Array.isArray(input.applications) || input.applications.length > 1_000) {
    throw new TypeError("Container application inventory is invalid");
  }
  const expectedName = `${input.workerScriptName}-ImageEngineContainer`;
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
  const expectedKeys = new Set([
    "input",
    "output",
    "environment",
    "account-id",
    "worker-script-name",
    "engine-image",
    "observed-at",
  ]);
  if (Object.keys(args).some((key) => !expectedKeys.has(key))) {
    throw new TypeError("unknown Container application resolver argument");
  }
  for (const key of expectedKeys) {
    if (args[key] === undefined) throw new TypeError(`--${key} is required`);
  }
  const result = resolveContainerApplication({
    applications: await readBoundedJson(resolve(args.input)),
    environment: args.environment,
    accountId: args["account-id"],
    workerScriptName: args["worker-script-name"],
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
