import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { computeTreeSha256 } from "./create-deterministic-tree-archive.mjs";
import { assertSha256, parseCliArguments } from "./image-lab-common.mjs";

const BLOCK_SIZE = 512;
const DEFAULT_MAX_FILE_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_TREE_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_FILES = 100_000;
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const ZERO_BLOCK = Buffer.alloc(BLOCK_SIZE);
const utf8 = new TextDecoder("utf-8", { fatal: true });

function isZero(bytes) {
  for (const byte of bytes) if (byte !== 0) return false;
  return true;
}

function assertBytes(header, offset, expected, message) {
  const actual = header.subarray(offset, offset + expected.byteLength);
  if (!actual.equals(expected)) throw new TypeError(message);
}

function readCanonicalString(header, offset, length, label, { allowEmpty = false } = {}) {
  const field = header.subarray(offset, offset + length);
  const terminator = field.indexOf(0);
  const end = terminator === -1 ? field.byteLength : terminator;
  if (terminator !== -1 && !isZero(field.subarray(terminator))) {
    throw new TypeError(`${label} is not canonically NUL padded`);
  }
  const value = utf8.decode(field.subarray(0, end));
  if (!allowEmpty && value.length === 0) throw new TypeError(`${label} is empty`);
  return value;
}

function readCanonicalOctal(header, offset, length, label) {
  const field = header.subarray(offset, offset + length);
  if (field[length - 1] !== 0 || !/^[0-7]+$/.test(field.subarray(0, -1).toString("ascii"))) {
    throw new TypeError(`${label} is not canonical octal`);
  }
  const value = Number.parseInt(field.subarray(0, -1).toString("ascii"), 8);
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} exceeds safe integer range`);
  return value;
}

function assertMemberPath(path) {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.normalize("NFC") !== path ||
    path.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new TypeError("member path is not canonical");
  }
}

function canonicalPathParts(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  for (let index = path.lastIndexOf("/"); index > 0; index = path.lastIndexOf("/", index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw new RangeError("member path does not fit canonical USTAR fields");
}

function verifyHeaderChecksum(header) {
  const checksum = header.subarray(148, 156);
  if (!/^[0-7]{6}\0 $/.test(checksum.toString("latin1"))) {
    throw new TypeError("header checksum field is not canonical");
  }
  const expected = Number.parseInt(checksum.subarray(0, 6).toString("ascii"), 8);
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  let actual = 0;
  for (const byte of copy) actual += byte;
  if (actual !== expected) throw new TypeError("header checksum does not match");
}

function parseCanonicalHeader(header) {
  verifyHeaderChecksum(header);
  const name = readCanonicalString(header, 0, 100, "member name");
  const prefix = readCanonicalString(header, 345, 155, "member prefix", { allowEmpty: true });
  const path = prefix === "" ? name : `${prefix}/${name}`;
  assertMemberPath(path);
  const canonical = canonicalPathParts(path);
  if (canonical.name !== name || canonical.prefix !== prefix) {
    throw new TypeError("member path fields are not canonical");
  }
  const mode = readCanonicalOctal(header, 100, 8, "member mode");
  const size = readCanonicalOctal(header, 124, 12, "member size");
  if (mode !== 0o644 && mode !== 0o755) {
    throw new TypeError("header metadata is not canonical");
  }
  const canonicalMetadata = [
    [108, Buffer.from("0000000\0", "ascii")],
    [116, Buffer.from("0000000\0", "ascii")],
    [136, Buffer.from("00000000000\0", "ascii")],
    [157, Buffer.alloc(100)],
    [257, Buffer.from("ustar\0", "ascii")],
    [263, Buffer.from("00", "ascii")],
    [265, Buffer.alloc(32)],
    [297, Buffer.alloc(32)],
    [329, Buffer.from("0000000\0", "ascii")],
    [337, Buffer.from("0000000\0", "ascii")],
    [500, Buffer.alloc(12)],
  ];
  for (const [offset, expected] of canonicalMetadata) {
    assertBytes(header, offset, expected, "header metadata is not canonical");
  }
  if (header[156] !== "0".charCodeAt(0)) {
    throw new TypeError("only regular-file members are allowed");
  }
  return { path, mode, size };
}

function parseArchive(bytes, { maxFileBytes, maxTreeBytes, maxFiles }) {
  if (bytes.byteLength < BLOCK_SIZE * 3 || bytes.byteLength % BLOCK_SIZE !== 0) {
    throw new TypeError("archive length is not canonical USTAR");
  }
  const entries = [];
  let offset = 0;
  let totalBytes = 0;
  let previousPath;
  while (offset < bytes.byteLength) {
    const header = bytes.subarray(offset, offset + BLOCK_SIZE);
    if (isZero(header)) {
      if (
        bytes.byteLength - offset !== BLOCK_SIZE * 2 ||
        !bytes.subarray(offset + BLOCK_SIZE, offset + BLOCK_SIZE * 2).equals(ZERO_BLOCK)
      ) {
        throw new TypeError("archive must end with exactly two zero blocks");
      }
      if (entries.length === 0) throw new TypeError("archive must contain at least one file");
      return { entries, totalBytes };
    }
    const metadata = parseCanonicalHeader(header);
    if (metadata.size > maxFileBytes)
      throw new RangeError("member exceeds the configured size limit");
    totalBytes += metadata.size;
    if (totalBytes > maxTreeBytes) throw new RangeError("tree exceeds the configured size limit");
    if (entries.length + 1 > maxFiles) {
      throw new RangeError("tree exceeds the configured file-count limit");
    }
    const pathBytes = Buffer.from(metadata.path, "utf8");
    if (previousPath !== undefined && Buffer.compare(previousPath, pathBytes) >= 0) {
      throw new TypeError("archive members must be unique and sorted");
    }
    previousPath = pathBytes;
    const dataStart = offset + BLOCK_SIZE;
    const dataEnd = dataStart + metadata.size;
    const paddedEnd = dataStart + Math.ceil(metadata.size / BLOCK_SIZE) * BLOCK_SIZE;
    if (paddedEnd > bytes.byteLength - BLOCK_SIZE * 2) {
      throw new TypeError("archive member exceeds archive bounds");
    }
    const data = bytes.subarray(dataStart, dataEnd);
    if (!isZero(bytes.subarray(dataEnd, paddedEnd))) {
      throw new TypeError("data padding must be zero");
    }
    entries.push({
      ...metadata,
      data,
      sha256: createHash("sha256").update(data).digest("hex"),
    });
    offset = paddedEnd;
  }
  throw new TypeError("archive is missing canonical end blocks");
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

export async function verifyAndExtractTreeArchive({
  archive,
  expectedArchiveSha256,
  expectedTreeSha256,
  output,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxTreeBytes = DEFAULT_MAX_TREE_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
}) {
  assertSha256(expectedArchiveSha256, "expected archive SHA-256");
  assertSha256(expectedTreeSha256, "expected tree SHA-256");
  const archivePath = resolve(archive);
  let archiveHandle;
  try {
    archiveHandle = await open(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ELOOP") throw new TypeError("archive must not be a symbolic link");
    throw error;
  }
  let bytes;
  try {
    const archiveMetadata = await archiveHandle.stat();
    if (
      !archiveMetadata.isFile() ||
      archiveMetadata.size < BLOCK_SIZE * 3 ||
      archiveMetadata.size > MAX_ARCHIVE_BYTES
    ) {
      throw new RangeError("archive is not a bounded regular file");
    }
    bytes = await archiveHandle.readFile();
    if (bytes.byteLength !== archiveMetadata.size) {
      throw new TypeError("archive changed while reading");
    }
  } finally {
    await archiveHandle.close();
  }
  const archiveSha256 = createHash("sha256").update(bytes).digest("hex");
  if (archiveSha256 !== expectedArchiveSha256) throw new Error("archive SHA-256 mismatch");

  const parent = await realpath(dirname(resolve(output)));
  const outputPath = join(parent, basename(resolve(output)));
  if (await pathExists(outputPath)) throw new Error("destination already exists");

  const parsed = parseArchive(bytes, { maxFileBytes, maxTreeBytes, maxFiles });
  const treeSha256 = computeTreeSha256(
    parsed.entries.map((entry) => ({
      path: entry.path,
      mode: entry.mode,
      size: entry.size,
      sha256: entry.sha256,
    })),
  );
  if (treeSha256 !== expectedTreeSha256) throw new Error("tree SHA-256 mismatch");

  const temporary = await mkdtemp(join(parent, ".hereisit-tree-extract-"));
  let published = false;
  try {
    for (const entry of parsed.entries) {
      const destination = join(temporary, ...entry.path.split("/"));
      await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
      await writeFile(destination, entry.data, { flag: "wx", mode: entry.mode });
      await chmod(destination, entry.mode);
    }
    if (await pathExists(outputPath)) throw new Error("destination already exists");
    await rename(temporary, outputPath);
    published = true;
  } finally {
    if (!published) await rm(temporary, { recursive: true, force: true });
  }
  return {
    version: 1,
    format: "ustar",
    archiveSha256,
    treeSha256,
    fileCount: parsed.entries.length,
    totalBytes: parsed.totalBytes,
  };
}

async function main() {
  const args = parseCliArguments(process.argv.slice(2));
  const allowed = new Set(["archive", "expected-archive-sha256", "expected-tree-sha256", "output"]);
  if (Object.keys(args).some((name) => !allowed.has(name)) || Object.keys(args).length !== 4) {
    throw new TypeError(
      "usage: verify-and-extract-tree-archive --archive <file> --expected-archive-sha256 <sha256> --expected-tree-sha256 <sha256> --output <directory>",
    );
  }
  const result = await verifyAndExtractTreeArchive({
    archive: args.archive,
    expectedArchiveSha256: args["expected-archive-sha256"],
    expectedTreeSha256: args["expected-tree-sha256"],
    output: args.output,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
