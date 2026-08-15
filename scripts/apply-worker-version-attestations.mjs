import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertExactKeys,
  assertObject,
  parseCliArguments,
  sha256Canonical,
} from "./image-lab-common.mjs";
import {
  createWorkerAdmissionAttestationBatch,
  createWorkerVersionAttestationBatch,
} from "./verify-worker-version-chain.mjs";

const accountIdPattern = /^[0-9a-f]{32}$/;
const databaseIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const maximumResponseBytes = 256 * 1024;
const maximumAttestationBytes = 64 * 1024;
const requiredMigrationName = "0002_worker_version_attestations.sql";

async function readBoundedAttestationJson(file) {
  let handle;
  let bytes;
  try {
    handle = await open(file, "r");
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new TypeError("attestation input must be a regular file");
    if (metadata.size > maximumAttestationBytes) {
      throw new RangeError("attestation input exceeds the maximum size");
    }
    bytes = new Uint8Array(maximumAttestationBytes + 1);
    let total = 0;
    while (total < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, total, bytes.byteLength - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maximumAttestationBytes) {
      throw new RangeError("attestation input exceeds the maximum size");
    }
    bytes = bytes.subarray(0, total);
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) throw error;
    throw new Error("attestation input could not be opened");
  } finally {
    await handle?.close();
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError("attestation input is not valid UTF-8");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new TypeError("attestation JSON is invalid");
  }
}

function validateParams(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} params must be an array`);
  for (const param of value) {
    if (param !== null && !["string", "number", "boolean"].includes(typeof param)) {
      throw new TypeError(`${label} contains an invalid parameter`);
    }
  }
  return value;
}

function validateBatch(value) {
  const batch = assertObject(value, "D1 attestation batch");
  assertExactKeys(batch, ["version", "statements", "verification"], "D1 attestation batch");
  if (batch.version !== 1) throw new TypeError("D1 attestation batch version is invalid");
  if (
    !Array.isArray(batch.statements) ||
    batch.statements.length < 1 ||
    batch.statements.length > 7
  ) {
    throw new TypeError("D1 attestation batch statement count is invalid");
  }
  for (const [index, valueStatement] of batch.statements.entries()) {
    const statement = assertObject(valueStatement, `D1 write statement ${index}`);
    assertExactKeys(statement, ["sql", "params"], `D1 write statement ${index}`);
    if (
      typeof statement.sql !== "string" ||
      (!statement.sql.startsWith("INSERT INTO worker_version_attestations ") &&
        !statement.sql.startsWith("UPDATE worker_version_attestations SET kind = ?")) ||
      /;|--|\/\*/.test(statement.sql)
    ) {
      throw new TypeError("D1 attestation batch contains prohibited write SQL");
    }
    validateParams(statement.params, `D1 write statement ${index}`);
  }
  if (
    !Array.isArray(batch.verification) ||
    batch.verification.length < 1 ||
    batch.verification.length > 2
  ) {
    throw new TypeError("D1 attestation verification count is invalid");
  }
  for (const [index, valueQuery] of batch.verification.entries()) {
    const query = assertObject(valueQuery, `D1 verification query ${index}`);
    assertExactKeys(query, ["sql", "params", "expected"], `D1 verification query ${index}`);
    if (
      typeof query.sql !== "string" ||
      !query.sql.startsWith("SELECT ") ||
      !query.sql.includes(" FROM worker_version_attestations ") ||
      /;|--|\/\*/.test(query.sql)
    ) {
      throw new TypeError("D1 attestation batch contains prohibited verification SQL");
    }
    validateParams(query.params, `D1 verification query ${index}`);
    if (!Array.isArray(query.expected)) {
      throw new TypeError(`D1 verification query ${index} expected rows must be an array`);
    }
  }
  return batch;
}

async function readBoundedJson(response) {
  if (!response.ok) throw new Error("Cloudflare D1 request failed");
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new Error("Cloudflare D1 response content type is invalid");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("Cloudflare D1 response body is missing");
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumResponseBytes) {
        await reader.cancel();
        throw new RangeError("Cloudflare D1 response exceeds the maximum size");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError("Cloudflare D1 response is not valid UTF-8");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new TypeError("Cloudflare D1 response JSON is invalid");
  }
}

function validateQueryEnvelope(value, expectedCount, { requirePrimary }) {
  const envelope = assertObject(value, "Cloudflare D1 response");
  assertExactKeys(envelope, ["success", "errors", "messages", "result"], "Cloudflare D1 response");
  if (
    envelope.success !== true ||
    !Array.isArray(envelope.errors) ||
    envelope.errors.length !== 0
  ) {
    throw new Error("Cloudflare D1 response reported failure");
  }
  if (!Array.isArray(envelope.messages) || !Array.isArray(envelope.result)) {
    throw new TypeError("Cloudflare D1 response envelope is invalid");
  }
  if (envelope.result.length !== expectedCount) {
    throw new TypeError("Cloudflare D1 response result count does not match");
  }
  return envelope.result.map((valueResult, index) => {
    const result = assertObject(valueResult, `Cloudflare D1 result ${index}`);
    if (result.success !== true || !Array.isArray(result.results)) {
      throw new Error("Cloudflare D1 query result reported failure");
    }
    const meta = assertObject(result.meta, `Cloudflare D1 result ${index} metadata`);
    if (requirePrimary && meta.served_by_primary !== true) {
      throw new Error("Cloudflare D1 query was not served by the primary");
    }
    return result;
  });
}

export async function postD1Query({ url, apiToken, body, expectedCount, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error("Cloudflare D1 request could not be completed");
  }
  const envelope = await readBoundedJson(response);
  return validateQueryEnvelope(envelope, expectedCount, { requirePrimary: true });
}

export async function verifyAttestationMigration({ url, apiToken, fetchImpl }) {
  let result;
  try {
    [result] = await postD1Query({
      url,
      apiToken,
      body: {
        sql: "SELECT name FROM d1_migrations WHERE name = ?",
        params: [requiredMigrationName],
      },
      expectedCount: 1,
      fetchImpl,
    });
  } catch {
    throw new Error("Worker attestation D1 migration preflight failed");
  }
  if (sha256Canonical(result.results) !== sha256Canonical([{ name: requiredMigrationName }])) {
    throw new Error("Worker attestation D1 migration is not applied");
  }
}

export async function applyWorkerVersionAttestationBatch({
  accountId,
  databaseId,
  apiToken,
  batch: batchValue,
  fetchImpl = fetch,
}) {
  if (typeof accountId !== "string" || !accountIdPattern.test(accountId)) {
    throw new TypeError("Cloudflare account ID is invalid");
  }
  if (typeof databaseId !== "string" || !databaseIdPattern.test(databaseId)) {
    throw new TypeError("Cloudflare D1 database ID is invalid");
  }
  if (typeof apiToken !== "string" || apiToken.length < 1) {
    throw new TypeError("Cloudflare D1 API token is required");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");
  const batch = validateBatch(batchValue);
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;

  await verifyAttestationMigration({ url, apiToken, fetchImpl });
  await postD1Query({
    url,
    apiToken,
    body: { batch: batch.statements },
    expectedCount: batch.statements.length,
    fetchImpl,
  });
  for (const query of batch.verification) {
    const [result] = await postD1Query({
      url,
      apiToken,
      body: { sql: query.sql, params: query.params },
      expectedCount: 1,
      fetchImpl,
    });
    if (sha256Canonical(result.results) !== sha256Canonical(query.expected)) {
      throw new Error("persisted Worker version attestation verification failed");
    }
  }
  return {
    applied: true,
    statements: batch.statements.length,
    verificationQueries: batch.verification.length,
  };
}

export async function runApplyWorkerVersionAttestationsCli(
  argv,
  { env = process.env, fetchImpl = fetch } = {},
) {
  const args = parseCliArguments(argv);
  const allowed = new Set(["attestation", "account-id", "database-id"]);
  if (Object.keys(args).some((key) => !allowed.has(key))) {
    throw new TypeError("unknown Worker attestation application argument");
  }
  for (const name of ["attestation", "account-id", "database-id"]) {
    if (args[name] === undefined) throw new TypeError(`--${name} is required`);
  }
  if (typeof env.CLOUDFLARE_D1_API_TOKEN !== "string" || env.CLOUDFLARE_D1_API_TOKEN.length === 0) {
    throw new TypeError("CLOUDFLARE_D1_API_TOKEN environment variable is required");
  }
  const attestation = await readBoundedAttestationJson(args.attestation);
  const batch =
    attestation?.schema === "hereisit-worker-admission-transition@1"
      ? createWorkerAdmissionAttestationBatch(attestation)
      : createWorkerVersionAttestationBatch(attestation);
  return applyWorkerVersionAttestationBatch({
    accountId: args["account-id"],
    databaseId: args["database-id"],
    apiToken: env.CLOUDFLARE_D1_API_TOKEN,
    batch,
    fetchImpl,
  });
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const result = await runApplyWorkerVersionAttestationsCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Worker attestation application failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
