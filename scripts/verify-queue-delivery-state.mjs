import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseCliArguments } from "./image-lab-common.mjs";

const accountPattern = /^[0-9a-f]{32}$/;
const queueIdPattern = /^[0-9a-f]{32}$/;
const queueNamePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
const cloudflareApiOrigin = "https://api.cloudflare.com";

function assertObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function validateExpected(value) {
  if (value !== "paused" && value !== "resumed") {
    throw new TypeError("expected Queue state must be paused or resumed");
  }
  return value;
}

function validateQueueName(value) {
  if (typeof value !== "string" || !queueNamePattern.test(value)) {
    throw new TypeError("Queue name is invalid");
  }
  return value;
}

function validateEnvelope(document, label) {
  const envelope = assertObject(document, label);
  if (envelope.success !== true) throw new Error(`${label} was not successful`);
  if (
    envelope.errors != null &&
    (!Array.isArray(envelope.errors) || envelope.errors.length !== 0)
  ) {
    throw new Error(`${label} contains API errors`);
  }
  if (envelope.messages != null && !Array.isArray(envelope.messages)) {
    throw new TypeError(`${label} messages are malformed`);
  }
  return envelope;
}

function validateQueueIdentity(value, queueName) {
  const queue = assertObject(value, "Queue result");
  if (typeof queue.queue_id !== "string" || !queueIdPattern.test(queue.queue_id)) {
    throw new TypeError("Queue result ID is invalid");
  }
  if (queue.queue_name !== queueName) throw new TypeError("Queue result name does not match");
  return queue;
}

export function verifyQueueDeliveryState({ document, expectedQueueId, queueName, expected }) {
  validateQueueName(queueName);
  if (expected !== undefined) validateExpected(expected);
  if (typeof expectedQueueId !== "string" || !queueIdPattern.test(expectedQueueId)) {
    throw new TypeError("expected Queue ID is invalid");
  }
  const envelope = validateEnvelope(document, "Queue detail response");
  const queue = validateQueueIdentity(envelope.result, queueName);
  if (queue.queue_id !== expectedQueueId) throw new TypeError("Queue detail ID does not match");
  const settings = assertObject(queue.settings, "Queue settings");
  if (typeof settings.delivery_paused !== "boolean") {
    throw new TypeError("Queue delivery_paused state is missing");
  }
  const actual = settings.delivery_paused ? "paused" : "resumed";
  if (expected !== undefined && actual !== expected)
    throw new Error(`Queue delivery state is ${actual}, expected ${expected}`);
  return { queue: queueName, state: actual, verified: true };
}

function validateApiOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Cloudflare API origin is invalid");
  }
  if (url.origin !== value || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new TypeError("Cloudflare API origin must contain only an origin");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new TypeError("Cloudflare API origin must use HTTPS or loopback HTTP");
  }
  return url.origin;
}

async function readApiJson(response, label) {
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 1024 * 1024) throw new RangeError(`${label} exceeds 1 MiB`);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new TypeError(`${label} is not valid JSON`);
  }
}

function validateListPage(document, page) {
  const envelope = validateEnvelope(document, "Queue list response");
  if (!Array.isArray(envelope.result)) throw new TypeError("Queue list result must be an array");
  const info = assertObject(envelope.result_info, "Queue list result_info");
  for (const key of ["count", "page", "per_page", "total_count", "total_pages"]) {
    if (!Number.isSafeInteger(info[key]) || info[key] < 0) {
      throw new TypeError(`Queue list ${key} is invalid`);
    }
  }
  if (info.page !== page || info.count !== envelope.result.length) {
    throw new TypeError("Queue list pagination does not match its result");
  }
  if (info.total_pages < 1 || info.total_pages > 100 || page > info.total_pages) {
    throw new RangeError("Queue list pagination is outside the supported bound");
  }
  return { queues: envelope.result, totalPages: info.total_pages };
}

export async function inspectQueueDeliveryState({
  accountId,
  queueName,
  expected,
  apiToken,
  apiOrigin = cloudflareApiOrigin,
}) {
  if (typeof accountId !== "string" || !accountPattern.test(accountId)) {
    throw new TypeError("Cloudflare account ID is invalid");
  }
  validateQueueName(queueName);
  if (expected !== undefined) validateExpected(expected);
  if (
    typeof apiToken !== "string" ||
    apiToken.length < 1 ||
    apiToken.length > 512 ||
    /[\r\n]/.test(apiToken)
  ) {
    throw new TypeError("Cloudflare API token is invalid");
  }
  const origin = validateApiOrigin(apiOrigin);
  const base = `${origin}/client/v4/accounts/${accountId}/queues`;
  const headers = { accept: "application/json", authorization: `Bearer ${apiToken}` };
  const matches = [];
  let totalPages = 1;
  for (let page = 1; page <= totalPages; page += 1) {
    const response = await fetch(`${base}?page=${page}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    const parsed = validateListPage(await readApiJson(response, "Queue list response"), page);
    totalPages = parsed.totalPages;
    for (const candidate of parsed.queues) {
      if (assertObject(candidate, "Queue list entry").queue_name === queueName) {
        matches.push(validateQueueIdentity(candidate, queueName));
      }
    }
  }
  if (matches.length !== 1) {
    throw new TypeError("Queue discovery must return exactly one matching Queue");
  }
  const queueId = matches[0].queue_id;
  const detailResponse = await fetch(`${base}/${queueId}`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  return verifyQueueDeliveryState({
    document: await readApiJson(detailResponse, "Queue detail response"),
    expectedQueueId: queueId,
    queueName,
    expected,
  });
}

async function main() {
  const args = parseCliArguments(process.argv.slice(2));
  const allowed = new Set(["queue", "expected", "account-id"]);
  if (Object.keys(args).some((key) => !allowed.has(key)) || Object.keys(args).length !== 3) {
    throw new TypeError(
      "usage: verify-queue-delivery-state --queue <name> --expected <paused|resumed> --account-id <id>",
    );
  }
  const result = await inspectQueueDeliveryState({
    accountId: args["account-id"],
    queueName: args.queue,
    expected: args.expected,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
