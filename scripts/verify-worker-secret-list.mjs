import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseCliArguments } from "./image-lab-common.mjs";

const requiredNames = new Set([
  "ABUSE_HMAC_SECRET_CURRENT",
  "ABUSE_HMAC_SECRET_PREVIOUS",
  "ANALYTICS_READ_TOKEN",
  "LOGPUSH_STATUS_TOKEN",
]);

export function verifyWorkerSecretList(value) {
  if (!Array.isArray(value) || value.length !== requiredNames.size) {
    throw new TypeError("Worker secret inventory must contain exactly four entries");
  }
  const names = new Set();
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError("Worker secret inventory entries must be objects");
    }
    const keys = Object.keys(entry).sort();
    if (keys.length !== 2 || keys[0] !== "name" || keys[1] !== "type") {
      throw new TypeError("Worker secret entries may contain only name and type");
    }
    if (typeof entry.name !== "string" || !requiredNames.has(entry.name)) {
      throw new TypeError("Worker secret inventory contains an unexpected name");
    }
    if (entry.type !== "secret_text") {
      throw new TypeError("Worker secret inventory entries must use secret_text");
    }
    if (names.has(entry.name)) throw new TypeError("Worker secret names must be unique");
    names.add(entry.name);
  }
  if ([...requiredNames].some((name) => !names.has(name))) {
    throw new TypeError("Worker secret inventory is incomplete");
  }
  return { verified: true, count: names.size };
}

async function main() {
  const args = parseCliArguments(process.argv.slice(2));
  if (Object.keys(args).length !== 1 || args.file === undefined) {
    throw new TypeError("usage: verify-worker-secret-list --file <wrangler-json>");
  }
  const bytes = await readFile(resolve(args.file));
  if (bytes.byteLength > 64 * 1024) throw new RangeError("Worker secret inventory exceeds 64 KiB");
  let inventory;
  try {
    inventory = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError("Worker secret inventory must be valid JSON");
  }
  process.stdout.write(`${JSON.stringify(verifyWorkerSecretList(inventory))}\n`);
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
