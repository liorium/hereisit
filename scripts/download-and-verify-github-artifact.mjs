import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateSync } from "fflate";
import { assertSha256, parseCliArguments } from "./image-lab-common.mjs";

const GITHUB_API_VERSION = "2026-03-10";
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024;
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 100_000;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const shaPattern = /^[0-9a-f]{40}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const artifactNamePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const crc32Table = Uint32Array.from({ length: 256 }, (_, byte) => {
  let value = byte;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffff_ffff;
  for (const byte of bytes) value = crc32Table[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffff_ffff) >>> 0;
}

function assertPositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function assertObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function assertApiOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("GitHub API origin is invalid");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (
    url.origin !== value ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
  ) {
    throw new TypeError("GitHub API origin must be an exact HTTPS or loopback HTTP origin");
  }
  return url.origin;
}

function apiHeaders(token) {
  if (typeof token !== "string" || token.length < 1 || token.length > 512 || /[\r\n]/.test(token)) {
    throw new TypeError("GitHub token is invalid");
  }
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "hereisit-release-artifact-verifier/1",
    "x-github-api-version": GITHUB_API_VERSION,
  };
}

async function readBoundedBytes(response, maximum, label) {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > maximum) {
      throw new RangeError(`${label} exceeds the size limit`);
    }
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximum) throw new RangeError(`${label} exceeds the size limit`);
  if (declared !== null && Number(declared) !== bytes.byteLength) {
    throw new TypeError(`${label} content length mismatch`);
  }
  return bytes;
}

async function requestJson(origin, path, headers) {
  const response = await fetch(`${origin}${path}`, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}`);
  const bytes = await readBoundedBytes(response, MAX_JSON_BYTES, "GitHub API response");
  try {
    return JSON.parse(utf8.decode(bytes));
  } catch {
    throw new TypeError("GitHub API response is not valid JSON");
  }
}

function validateWorkflowRun(document, repository, runId, expectedHeadSha, allowInProgress) {
  const run = assertObject(document, "workflow run");
  if (run.id !== runId) throw new TypeError("workflow run ID mismatch");
  if (run.head_sha !== expectedHeadSha) throw new TypeError("workflow run head SHA mismatch");
  if (assertObject(run.repository, "workflow run repository").full_name !== repository) {
    throw new TypeError("workflow run repository mismatch");
  }
  const validState = allowInProgress
    ? run.status === "in_progress" && run.conclusion === null
    : run.status === "completed" && run.conclusion === "success";
  if (!validState) {
    throw new Error("workflow run is not completed successfully");
  }
}

async function listArtifacts(origin, repository, runId, headers) {
  const artifacts = [];
  let totalCount;
  for (let page = 1; page <= 100; page += 1) {
    const document = assertObject(
      await requestJson(
        origin,
        `/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100&page=${page}`,
        headers,
      ),
      "workflow artifact list",
    );
    if (!Number.isSafeInteger(document.total_count) || document.total_count < 0) {
      throw new TypeError("workflow artifact total count is invalid");
    }
    if (totalCount === undefined) totalCount = document.total_count;
    if (document.total_count !== totalCount || !Array.isArray(document.artifacts)) {
      throw new TypeError("workflow artifact pagination changed during verification");
    }
    artifacts.push(...document.artifacts);
    if (artifacts.length >= totalCount) break;
    if (document.artifacts.length !== 100) {
      throw new TypeError("workflow artifact pagination is incomplete");
    }
  }
  if (artifacts.length !== totalCount) throw new TypeError("workflow artifact list is incomplete");
  const ids = artifacts.map((artifact) => assertObject(artifact, "workflow artifact").id);
  if (new Set(ids).size !== ids.length) throw new TypeError("workflow artifact IDs are duplicated");
  return artifacts;
}

function validateArtifact({
  artifact,
  origin,
  repository,
  runId,
  expectedHeadSha,
  name,
  expectedSha256,
  expectedArtifactId,
  expectedSize,
}) {
  const value = assertObject(artifact, "workflow artifact");
  const artifactId = assertPositiveSafeInteger(value.id, "artifact ID");
  if (expectedArtifactId !== undefined && artifactId !== expectedArtifactId) {
    throw new TypeError("artifact ID mismatch");
  }
  if (value.name !== name) throw new TypeError("artifact name mismatch");
  const sizeInBytes = assertPositiveSafeInteger(value.size_in_bytes, "artifact size");
  if (sizeInBytes > MAX_ARCHIVE_BYTES)
    throw new RangeError("artifact exceeds the archive size limit");
  if (expectedSize !== undefined && sizeInBytes !== expectedSize) {
    throw new TypeError("artifact size mismatch");
  }
  if (value.expired !== false) throw new Error("artifact is expired");
  if (value.digest !== `sha256:${expectedSha256}`) {
    throw new Error("GitHub artifact digest mismatch");
  }
  const expectedBase = `${origin}/repos/${repository}/actions/artifacts/${artifactId}`;
  if (value.url !== expectedBase || value.archive_download_url !== `${expectedBase}/zip`) {
    throw new TypeError("artifact API URLs are not canonical");
  }
  const workflow = assertObject(value.workflow_run, "artifact workflow run");
  if (workflow.id !== runId || workflow.head_sha !== expectedHeadSha) {
    throw new TypeError("artifact workflow identity mismatch");
  }
  return { artifactId, sizeInBytes };
}

function assertDownloadUrl(value, apiOrigin) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("artifact redirect URL is invalid");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
  ) {
    throw new TypeError("artifact redirect URL is unsafe");
  }
  if (apiOrigin.startsWith("http://127.0.0.1:") && url.origin !== apiOrigin) {
    throw new TypeError("loopback artifact redirect changed origin");
  }
  return url.href;
}

async function downloadArtifact(origin, repository, artifactId, headers, expectedSize) {
  const response = await fetch(
    `${origin}/repos/${repository}/actions/artifacts/${artifactId}/zip`,
    {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (response.status !== 302) {
    throw new Error(`GitHub artifact download returned HTTP ${response.status}`);
  }
  const location = response.headers.get("location");
  if (location === null) throw new TypeError("artifact download redirect is missing");
  const download = await fetch(assertDownloadUrl(location, origin), {
    headers: { "user-agent": "hereisit-release-artifact-verifier/1" },
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (!download.ok) throw new Error(`artifact byte download returned HTTP ${download.status}`);
  const bytes = await readBoundedBytes(download, MAX_ARCHIVE_BYTES, "artifact ZIP");
  if (bytes.byteLength !== expectedSize) throw new TypeError("artifact ZIP size mismatch");
  return bytes;
}

function findEndOfCentralDirectory(bytes) {
  const minimum = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new TypeError("ZIP end-of-central-directory record is missing");
}

function assertZipPath(path) {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.normalize("NFC") !== path ||
    path.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new TypeError("ZIP entry path is not canonical");
  }
}

function validateExtraFields(bytes, label) {
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (offset + 4 > bytes.byteLength) throw new TypeError(`${label} ZIP extra field is truncated`);
    const id = bytes.readUInt16LE(offset);
    const size = bytes.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + size > bytes.byteLength)
      throw new TypeError(`${label} ZIP extra field is truncated`);
    if (id === 0x0001) throw new TypeError("ZIP64 entries are not supported");
    offset += size;
  }
}

function parseCentralDirectory(bytes) {
  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd + 22 !== bytes.byteLength) {
    throw new TypeError("ZIP comments and trailing bytes are prohibited");
  }
  if (
    bytes.readUInt16LE(eocd + 4) !== 0 ||
    bytes.readUInt16LE(eocd + 6) !== 0 ||
    bytes.readUInt16LE(eocd + 8) !== bytes.readUInt16LE(eocd + 10) ||
    bytes.readUInt16LE(eocd + 20) !== 0
  ) {
    throw new TypeError("multi-disk ZIPs and ZIP comments are prohibited");
  }
  const entryCount = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (entryCount < 1 || entryCount > MAX_ENTRIES)
    throw new RangeError("ZIP entry count is invalid");
  if (centralOffset + centralSize !== eocd) {
    throw new TypeError("ZIP central directory bounds are invalid");
  }
  const entries = [];
  let offset = centralOffset;
  let totalExtractedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocd || bytes.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new TypeError("ZIP central-directory entry is malformed");
    }
    const madeBy = bytes.readUInt16LE(offset + 4);
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const crc32 = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const diskStart = bytes.readUInt16LE(offset + 34);
    const externalAttributes = bytes.readUInt32LE(offset + 38);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const entryEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (entryEnd > eocd || nameLength === 0 || commentLength !== 0 || diskStart !== 0) {
      throw new TypeError("ZIP central-directory metadata is invalid");
    }
    if ((flags & 1) !== 0) throw new TypeError("encrypted ZIP entries are prohibited");
    if (method !== 0 && method !== 8) throw new TypeError("ZIP compression method is unsupported");
    const allowedFlags = 0x0808 | (method === 8 ? 0x0006 : 0);
    if ((flags & ~allowedFlags) !== 0) {
      throw new TypeError("ZIP general-purpose flags are unsupported");
    }
    if (uncompressedSize > MAX_ENTRY_BYTES)
      throw new RangeError("ZIP entry exceeds the size limit");
    totalExtractedBytes += uncompressedSize;
    if (totalExtractedBytes > MAX_EXTRACTED_BYTES) {
      throw new RangeError("ZIP extracted tree exceeds the size limit");
    }
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const path = utf8.decode(nameBytes);
    assertZipPath(path);
    validateExtraFields(
      bytes.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength),
      "central",
    );
    const host = madeBy >>> 8;
    const unixType = (externalAttributes >>> 16) & 0o170000;
    if (host === 3 && unixType === 0o120000) {
      throw new TypeError("ZIP symlink entries are prohibited");
    }
    if (
      (host === 3 && unixType !== 0 && unixType !== 0o100000) ||
      (externalAttributes & 0x10) !== 0
    ) {
      throw new TypeError("only regular ZIP file entries are allowed");
    }
    entries.push({
      path,
      nameBytes,
      flags,
      method,
      crc32,
      compressedSize,
      uncompressedSize,
      localOffset,
    });
    offset = entryEnd;
  }
  if (offset !== eocd || entries.length !== entryCount) {
    throw new TypeError("ZIP central directory contains extra records");
  }
  const paths = entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) throw new TypeError("ZIP entry paths are duplicated");
  return { entries, centralOffset, totalExtractedBytes };
}

function descriptorLength(bytes, offset, entry) {
  const hasSignature = bytes.readUInt32LE(offset) === DATA_DESCRIPTOR_SIGNATURE;
  const start = offset + (hasSignature ? 4 : 0);
  if (
    start + 12 > bytes.byteLength ||
    bytes.readUInt32LE(start) !== entry.crc32 ||
    bytes.readUInt32LE(start + 4) !== entry.compressedSize ||
    bytes.readUInt32LE(start + 8) !== entry.uncompressedSize
  ) {
    throw new TypeError("ZIP data descriptor does not match the central directory");
  }
  return hasSignature ? 16 : 12;
}

function validateLocalRecords(bytes, parsed) {
  const ordered = [...parsed.entries].sort((left, right) => left.localOffset - right.localOffset);
  let expectedOffset = 0;
  for (const entry of ordered) {
    const offset = entry.localOffset;
    if (offset !== expectedOffset || offset + 30 > parsed.centralOffset) {
      throw new TypeError("ZIP contains extra root data or overlapping members");
    }
    if (bytes.readUInt32LE(offset) !== LOCAL_SIGNATURE) {
      throw new TypeError("ZIP local-file header is missing");
    }
    const flags = bytes.readUInt16LE(offset + 6);
    const method = bytes.readUInt16LE(offset + 8);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    if (
      flags !== entry.flags ||
      method !== entry.method ||
      nameLength !== entry.nameBytes.byteLength ||
      !bytes.subarray(nameStart, nameStart + nameLength).equals(entry.nameBytes) ||
      dataStart + entry.compressedSize > parsed.centralOffset
    ) {
      throw new TypeError("ZIP local-file header does not match the central directory");
    }
    validateExtraFields(bytes.subarray(nameStart + nameLength, dataStart), "local");
    entry.dataStart = dataStart;
    let end = dataStart + entry.compressedSize;
    if ((flags & 0x08) !== 0) {
      end += descriptorLength(bytes, end, entry);
    } else if (
      bytes.readUInt32LE(offset + 14) !== entry.crc32 ||
      bytes.readUInt32LE(offset + 18) !== entry.compressedSize ||
      bytes.readUInt32LE(offset + 22) !== entry.uncompressedSize
    ) {
      throw new TypeError("ZIP local-file sizes do not match the central directory");
    }
    expectedOffset = end;
  }
  if (expectedOffset !== parsed.centralOffset) {
    throw new TypeError("ZIP contains extra root data or overlapping members");
  }
}

function verifyZip(bytes) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parsed = parseCentralDirectory(buffer);
  validateLocalRecords(buffer, parsed);
  const files = new Map();
  for (const entry of parsed.entries) {
    const compressed = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
    let data;
    try {
      data =
        entry.method === 0
          ? Uint8Array.from(compressed)
          : inflateSync(compressed, { out: new Uint8Array(entry.uncompressedSize) });
    } catch {
      throw new TypeError("artifact ZIP decompression failed");
    }
    if (data.byteLength !== entry.uncompressedSize) {
      throw new TypeError("artifact ZIP extracted size mismatch");
    }
    if (crc32(data) !== entry.crc32) throw new TypeError("ZIP entry CRC-32 mismatch");
    files.set(entry.path, data);
  }
  return { files, entries: parsed.entries };
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function publishFiles(files, outputDir) {
  const parent = await realpath(dirname(resolve(outputDir)));
  const output = join(parent, basename(resolve(outputDir)));
  if (await pathExists(output)) throw new Error("output directory already exists");
  const temporary = await mkdtemp(join(parent, ".hereisit-artifact-"));
  let published = false;
  try {
    for (const path of [...files.keys()].sort()) {
      const destination = join(temporary, ...path.split("/"));
      await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
      await writeFile(destination, files.get(path), { flag: "wx", mode: 0o644 });
      await chmod(destination, 0o644);
    }
    if (await pathExists(output)) throw new Error("output directory already exists");
    await rename(temporary, output);
    published = true;
  } finally {
    if (!published) await rm(temporary, { recursive: true, force: true });
  }
}

export async function downloadAndVerifyGitHubArtifact({
  repository,
  runId,
  expectedHeadSha,
  name,
  expectedSha256,
  outputDir,
  expectedArtifactId,
  expectedSize,
  allowInProgress = false,
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: this standalone verifier intentionally follows the GitHub Actions API-origin contract outside Turbo tasks.
  apiOrigin = process.env.GITHUB_API_URL ?? "https://api.github.com",
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: credentials are runtime-only CLI inputs and must never enter Turbo cache keys.
  token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
}) {
  if (typeof repository !== "string" || !repositoryPattern.test(repository)) {
    throw new TypeError("repository must be owner/name");
  }
  assertPositiveSafeInteger(runId, "workflow run ID");
  if (typeof expectedHeadSha !== "string" || !shaPattern.test(expectedHeadSha)) {
    throw new TypeError("expected workflow head SHA is invalid");
  }
  if (typeof name !== "string" || !artifactNamePattern.test(name)) {
    throw new TypeError("artifact name is invalid");
  }
  assertSha256(expectedSha256, "expected artifact SHA-256");
  if (expectedArtifactId !== undefined)
    assertPositiveSafeInteger(expectedArtifactId, "artifact ID");
  if (expectedSize !== undefined) assertPositiveSafeInteger(expectedSize, "artifact size");
  if (typeof allowInProgress !== "boolean") {
    throw new TypeError("allow-in-progress must be boolean");
  }
  const origin = assertApiOrigin(apiOrigin);
  const headers = apiHeaders(token);
  if (await pathExists(resolve(outputDir))) throw new Error("output directory already exists");

  const run = await requestJson(origin, `/repos/${repository}/actions/runs/${runId}`, headers);
  validateWorkflowRun(run, repository, runId, expectedHeadSha, allowInProgress);
  const artifacts = await listArtifacts(origin, repository, runId, headers);
  const matches = artifacts.filter((artifact) => artifact?.name === name);
  if (matches.length !== 1)
    throw new TypeError("workflow run must contain exactly one named artifact");
  const identity = validateArtifact({
    artifact: matches[0],
    origin,
    repository,
    runId,
    expectedHeadSha,
    name,
    expectedSha256,
    expectedArtifactId,
    expectedSize,
  });
  const bytes = await downloadArtifact(
    origin,
    repository,
    identity.artifactId,
    headers,
    identity.sizeInBytes,
  );
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== expectedSha256) throw new Error("downloaded artifact SHA-256 mismatch");
  const verifiedZip = verifyZip(bytes);
  await publishFiles(verifiedZip.files, outputDir);
  return {
    version: 1,
    repository,
    runId,
    headSha: expectedHeadSha,
    artifactId: identity.artifactId,
    artifactName: name,
    sizeInBytes: identity.sizeInBytes,
    sha256: actualSha256,
    fileCount: verifiedZip.entries.length,
  };
}

async function main() {
  const args = parseCliArguments(process.argv.slice(2));
  const required = ["repo", "run-id", "expected-head-sha", "name", "expected-sha256", "output-dir"];
  const optional = ["expected-artifact-id", "expected-size", "allow-in-progress"];
  const allowed = new Set([...required, ...optional]);
  if (
    Object.keys(args).some((name) => !allowed.has(name)) ||
    required.some((name) => args[name] === undefined)
  ) {
    throw new TypeError("invalid GitHub artifact verifier arguments");
  }
  const parseInteger = (name) => {
    if (args[name] === undefined) return undefined;
    if (!/^[1-9][0-9]*$/.test(args[name])) throw new TypeError(`--${name} is invalid`);
    return Number(args[name]);
  };
  if (args["allow-in-progress"] !== undefined && args["allow-in-progress"] !== "true") {
    throw new TypeError("--allow-in-progress must be exactly true");
  }
  const result = await downloadAndVerifyGitHubArtifact({
    repository: args.repo,
    runId: parseInteger("run-id"),
    expectedHeadSha: args["expected-head-sha"],
    name: args.name,
    expectedSha256: args["expected-sha256"],
    outputDir: args["output-dir"],
    expectedArtifactId: parseInteger("expected-artifact-id"),
    expectedSize: parseInteger("expected-size"),
    allowInProgress: args["allow-in-progress"] === "true",
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
