import { assertExactKeys, assertObject, sha256Canonical } from "./image-lab-common.mjs";

const accountIdPattern = /^[0-9a-f]{32}$/;
const databaseIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const maximumResponseBytes = 256 * 1024;

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

async function postD1Query({ url, apiToken, body, expectedCount, fetchImpl }) {
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
