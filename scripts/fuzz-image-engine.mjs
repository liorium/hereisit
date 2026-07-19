import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parseCliArguments, sha256Canonical } from "./image-lab-common.mjs";

const execute = promisify(execFile);
const mutationFamilies = ["magic", "truncate", "length", "dimension", "metadata", "byte-flip"];
const mimeByFormat = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
const safeFailureCodes = new Set([
  "UNSUPPORTED_INPUT",
  "UNSUPPORTED_FEATURE",
  "INPUT_LIMIT_EXCEEDED",
  "PIXEL_LIMIT_EXCEEDED",
  "RESOURCE_CLASS_UPGRADE",
  "ENGINE_TIMEOUT",
  "ENGINE_OOM",
  "VERIFICATION_FAILED",
]);

function pseudoRandom(seed) {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function setBytes(bytes, offset, values) {
  if (offset < 0 || offset >= bytes.byteLength) return;
  bytes.set(values.subarray(0, bytes.byteLength - offset), offset);
}

function mutateLength(bytes, format) {
  if (format === "png") setBytes(bytes, 8, Uint8Array.of(0x7f, 0xff, 0xff, 0xff));
  else if (format === "webp") setBytes(bytes, 4, Uint8Array.of(0xff, 0xff, 0xff, 0x7f));
  else setBytes(bytes, 4, Uint8Array.of(0xff, 0xff));
}

function mutateDimension(bytes, format) {
  if (format === "png") {
    setBytes(bytes, 16, Uint8Array.of(0, 0, 0x80, 0));
    setBytes(bytes, 20, Uint8Array.of(0, 0, 0x80, 0));
    return;
  }
  if (format === "webp") {
    setBytes(bytes, 24, Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff));
    return;
  }
  for (let offset = 2; offset + 8 < bytes.byteLength; offset += 1) {
    if (bytes[offset] === 0xff && [0xc0, 0xc1, 0xc2, 0xc3].includes(bytes[offset + 1] ?? -1)) {
      setBytes(bytes, offset + 5, Uint8Array.of(0x7f, 0xff, 0x7f, 0xff));
      return;
    }
  }
  setBytes(bytes, 8, Uint8Array.of(0x7f, 0xff, 0x7f, 0xff));
}

function mutateMetadata(bytes, format) {
  if (format === "png") setBytes(bytes, 12, Uint8Array.of(0x69, 0x43, 0x43, 0x50));
  else if (format === "webp") setBytes(bytes, 12, Uint8Array.of(0x49, 0x43, 0x43, 0x50));
  else setBytes(bytes, 2, Uint8Array.of(0xff, 0xe2, 0xff, 0xff));
}

export function normalizeFuzzCaseId(value) {
  if (typeof value !== "string" || !/^case-[0-9a-f]{16}$/.test(value)) {
    throw new TypeError("fuzz case ID is invalid");
  }
  return value;
}

export function createImageMutation({ bytes: input, format, caseNumber, seed }) {
  if (!(input instanceof Uint8Array) || input.byteLength < 2) {
    throw new TypeError("fuzz source must contain at least two bytes");
  }
  if (!Object.hasOwn(mimeByFormat, format)) throw new TypeError("fuzz format is invalid");
  if (!Number.isSafeInteger(caseNumber) || caseNumber < 0) {
    throw new TypeError("fuzz case number is invalid");
  }
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new TypeError("fuzz seed is invalid");
  }
  const random = pseudoRandom((seed ^ Math.imul(caseNumber + 1, 0x45d9f3b)) >>> 0);
  const mutation = mutationFamilies[caseNumber % mutationFamilies.length];
  let bytes = Uint8Array.from(input);
  if (mutation === "magic") bytes[0] ^= 0xff;
  else if (mutation === "truncate") {
    bytes = bytes.slice(0, 1 + (random() % (bytes.byteLength - 1)));
  } else if (mutation === "length") mutateLength(bytes, format);
  else if (mutation === "dimension") mutateDimension(bytes, format);
  else if (mutation === "metadata") mutateMetadata(bytes, format);
  else {
    const minimum = Math.min(8, bytes.byteLength - 1);
    const offset = minimum + (random() % (bytes.byteLength - minimum));
    bytes[offset] ^= 1 << (random() % 8);
  }
  const id = `case-${createHash("sha256")
    .update(`${seed}:${caseNumber}:${format}:${mutation}:`)
    .update(bytes)
    .digest("hex")
    .slice(0, 16)}`;
  return { id: normalizeFuzzCaseId(id), mutation, bytes };
}

export function classifyFuzzTerminalStatus(status) {
  if (status?.state === "succeeded") return "succeeded";
  if (status?.state === "cancelled" && status.error?.code === "CANCELLED") return "cancelled";
  if (status?.state !== "failed") throw new Error("image engine status is not terminal");
  const code = status.error?.code;
  if (typeof code !== "string" || !safeFailureCodes.has(code)) {
    throw new Error(`unsafe engine outcome: ${typeof code === "string" ? code : "unknown"}`);
  }
  return `rejected:${code}`;
}

export function selectFuzzSources(entries) {
  if (!Array.isArray(entries)) throw new TypeError("fuzz corpus entries must be an array");
  return entries.filter(
    (entry) =>
      Object.hasOwn(mimeByFormat, entry?.expected?.format) &&
      !["malformed", "bomb", "truncated"].includes(entry.expected.class) &&
      Number.isSafeInteger(entry.expected.width) &&
      Number.isSafeInteger(entry.expected.height) &&
      entry.expected.width > 0 &&
      entry.expected.height > 0 &&
      entry.expected.width * entry.expected.height <= 1_000_000,
  );
}

async function docker(...args) {
  const result = await execute("docker", args, { maxBuffer: 4 * 1024 * 1024 });
  return result.stdout.trim();
}

async function waitForHealth(origin, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${origin}/healthz`)).status === 204) return;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("image engine fuzz target did not become healthy");
}

async function pollTerminal(origin, jobId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${origin}/v1/jobs/${jobId}`);
    if (!response.ok) throw new Error(`image engine status failed: ${response.status}`);
    const status = await response.json();
    if (["succeeded", "failed", "cancelled"].includes(status.state)) return status;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error("image engine fuzz case hung");
}

async function exerciseCase(origin, mutation, format, caseNumber) {
  const jobId = randomUUID();
  const spec = {
    version: 1,
    mode: caseNumber % 2 === 0 ? "smart" : "lossless",
    preset: "balanced",
    output: "same-format",
    metadata: "strip",
    orientation: "apply",
    colorSpace: "srgb",
    minimumSavingsPercent: 1,
  };
  try {
    const created = await fetch(`${origin}/v1/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        protocol: 1,
        jobId,
        attempt: 1,
        tool: "image.optimize",
        toolVersion: 1,
        spec,
        specHash: sha256Canonical(spec),
        input: {
          byteLength: mutation.bytes.byteLength,
          etag: mutation.id,
          mimeHint: mimeByFormat[format],
        },
        resourceClass: "image-standard-v1",
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (created.status !== 201) throw new Error(`image engine create failed: ${created.status}`);
    const uploaded = await fetch(`${origin}/v1/jobs/${jobId}/input`, {
      method: "PUT",
      headers: {
        "content-length": String(mutation.bytes.byteLength),
        "content-type": mimeByFormat[format],
      },
      body: mutation.bytes,
      signal: AbortSignal.timeout(5_000),
    });
    if (uploaded.status !== 204) throw new Error(`image engine upload failed: ${uploaded.status}`);
    const started = await fetch(`${origin}/v1/jobs/${jobId}/run`, {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
    });
    if (started.status !== 202) throw new Error(`image engine run failed: ${started.status}`);
    return classifyFuzzTerminalStatus(await pollTerminal(origin, jobId));
  } finally {
    await fetch(`${origin}/v1/jobs/${jobId}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined);
  }
}

async function saveReproducer(mutation, metadata) {
  const root = resolve(".artifacts/fuzz");
  await mkdir(root, { recursive: true });
  await Promise.all([
    writeFile(resolve(root, `${mutation.id}.bin`), mutation.bytes, { mode: 0o600 }),
    writeFile(resolve(root, `${mutation.id}.json`), `${JSON.stringify(metadata)}\n`, {
      mode: 0o600,
    }),
  ]);
}

export async function fuzzImageEngine({ durationSeconds, seed, engineImage, manifestPath }) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const sources = selectFuzzSources(manifest.entries);
  if (
    !new Set(sources.map((entry) => entry.expected.format)).isSupersetOf(
      new Set(Object.keys(mimeByFormat)),
    )
  ) {
    throw new Error("fuzz corpus must include JPEG, PNG, and WebP");
  }
  const containerName = `hereisit-image-fuzz-${process.pid}-${Date.now()}`;
  let containerId;
  try {
    containerId = await docker(
      "run",
      "--detach",
      "--rm",
      "--name",
      containerName,
      "--publish",
      "127.0.0.1::8080",
      "--memory",
      "1g",
      "--pids-limit",
      "128",
      "--env",
      "ENGINE_BUILD_ID=fuzz",
      "--env",
      "JPEG_CODEC_BUILD_ID=mozjpeg",
      "--env",
      "PNG_CODEC_BUILD_ID=oxipng-quantizr",
      "--env",
      "WEBP_CODEC_BUILD_ID=libwebp",
      "--env",
      "TRANSFORM_BUILD_ID=libvips",
      engineImage,
    );
    const published = await docker("port", containerId, "8080/tcp");
    const port = published.match(/:(\d+)$/)?.[1];
    if (port === undefined) throw new Error("docker did not publish the fuzz target port");
    const origin = `http://127.0.0.1:${port}`;
    await waitForHealth(origin);
    const deadline = performance.now() + durationSeconds * 1000;
    const outcomes = new Map();
    let caseNumber = 0;
    while (performance.now() < deadline || caseNumber < 12) {
      const source = sources[(seed + caseNumber) % sources.length];
      const bytes = await readFile(resolve(dirname(manifestPath), source.relativePath));
      const mutation = createImageMutation({
        bytes,
        format: source.expected.format,
        caseNumber,
        seed,
      });
      try {
        const outcome = await exerciseCase(origin, mutation, source.expected.format, caseNumber);
        outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
      } catch (error) {
        await saveReproducer(mutation, {
          version: 1,
          seed,
          caseNumber,
          caseId: mutation.id,
          format: source.expected.format,
          mutation: mutation.mutation,
          outcome: "unsafe",
        });
        throw error;
      }
      caseNumber += 1;
    }
    return {
      version: 1,
      seed,
      durationSeconds,
      cases: caseNumber,
      outcomes: Object.fromEntries(
        [...outcomes].sort(([left], [right]) => left.localeCompare(right)),
      ),
    };
  } finally {
    if (containerId !== undefined)
      await docker("rm", "--force", containerId).catch(() => undefined);
  }
}

async function main() {
  const args = parseCliArguments(process.argv.slice(2));
  const allowed = new Set(["duration-seconds", "seed", "engine-image", "manifest"]);
  if (Object.keys(args).some((key) => !allowed.has(key)))
    throw new TypeError("unknown fuzz argument");
  const durationSeconds = Number(args["duration-seconds"]);
  const seed = Number(args.seed);
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 1800) {
    throw new TypeError("--duration-seconds must be an integer from 1 to 1800");
  }
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new TypeError("--seed must be a uint32 integer");
  }
  const result = await fuzzImageEngine({
    durationSeconds,
    seed,
    engineImage: args["engine-image"] ?? "hereisit-image-engine:test",
    manifestPath: resolve(args.manifest ?? "tests/image-corpus/manifest.json"),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
