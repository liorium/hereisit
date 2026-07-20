import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseCliArguments } from "./image-lab-common.mjs";

const BLOCK_SIZE = 512;
const END_BLOCKS = Buffer.alloc(BLOCK_SIZE * 2);
const TREE_DOMAIN = Buffer.from("HEREISIT_TREE_V1\0", "ascii");
const DEFAULT_MAX_FILE_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_TREE_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_FILES = 100_000;

function writeString(header, offset, length, value) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength > length) throw new RangeError("USTAR field is too long");
  bytes.copy(header, offset);
}

function writeOctal(header, offset, length, value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("USTAR value is invalid");
  const encoded = value.toString(8);
  if (encoded.length > length - 1) throw new RangeError("USTAR value does not fit");
  header.write(encoded.padStart(length - 1, "0"), offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
}

function splitUstarPath(path) {
  const pathBytes = Buffer.byteLength(path);
  if (pathBytes <= 100) return { name: path, prefix: "" };
  for (let index = path.lastIndexOf("/"); index > 0; index = path.lastIndexOf("/", index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw new RangeError("path does not fit canonical USTAR fields");
}

function createHeader(entry) {
  const header = Buffer.alloc(BLOCK_SIZE);
  const { name, prefix } = splitUstarPath(entry.path);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, entry.mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.bytes.byteLength);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  writeOctal(header, 329, 8, 0);
  writeOctal(header, 337, 8, 0);
  writeString(header, 345, 155, prefix);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const encoded = checksum.toString(8).padStart(6, "0");
  header.write(encoded, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function assertCanonicalPath(path) {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.normalize("NFC") !== path ||
    path.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new TypeError("source path is not canonical");
  }
}

async function collectFiles(root, { maxFileBytes, maxTreeBytes, maxFiles }) {
  const entries = [];
  let totalBytes = 0;
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const absolute = resolve(directory, child.name);
      const metadata = await lstat(absolute);
      if (metadata.isDirectory()) {
        await visit(absolute);
      } else if (metadata.isFile()) {
        if (metadata.nlink !== 1) throw new TypeError("hard-linked files are not allowed");
        if (!Number.isSafeInteger(metadata.size) || metadata.size > maxFileBytes) {
          throw new RangeError("source file exceeds the configured size limit");
        }
        totalBytes += metadata.size;
        if (totalBytes > maxTreeBytes) {
          throw new RangeError("source tree exceeds the configured size limit");
        }
        if (entries.length + 1 > maxFiles) {
          throw new RangeError("source tree exceeds the configured file-count limit");
        }
        const path = relative(root, absolute).split(sep).join("/");
        assertCanonicalPath(path);
        const bytes = await readFile(absolute);
        entries.push({ path, bytes, mode: (metadata.mode & 0o111) === 0 ? 0o644 : 0o755 });
      } else {
        throw new TypeError("source tree may contain only directories and regular files");
      }
    }
  }
  await visit(root);
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  return entries;
}

export function computeTreeSha256(entries) {
  const hash = createHash("sha256").update(TREE_DOMAIN);
  for (const entry of entries) {
    const path = Buffer.from(entry.path, "utf8");
    const fixed = Buffer.alloc(16);
    fixed.writeUInt32BE(path.byteLength, 0);
    fixed.writeUInt32BE(entry.mode, 4);
    const size = entry.size ?? entry.bytes?.byteLength;
    fixed.writeBigUInt64BE(BigInt(size), 8);
    hash.update(fixed);
    hash.update(path);
    hash.update(
      entry.sha256 === undefined
        ? createHash("sha256").update(entry.bytes).digest()
        : Buffer.from(entry.sha256, "hex"),
    );
  }
  return hash.digest("hex");
}

function assertLimit(value, fallback, label) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return selected;
}

export async function createDeterministicTreeArchive({
  root,
  output,
  maxFileBytes,
  maxTreeBytes,
  maxFiles,
}) {
  const requestedRoot = resolve(root);
  const source = await lstat(requestedRoot);
  if (!source.isDirectory()) throw new TypeError("archive root must be a real directory");
  const sourceRoot = await realpath(requestedRoot);
  const outputParent = await realpath(dirname(resolve(output)));
  const outputPath = join(outputParent, basename(resolve(output)));
  const outputRelative = relative(sourceRoot, outputPath);
  if (
    outputRelative === "" ||
    (!outputRelative.startsWith(`..${sep}`) &&
      outputRelative !== ".." &&
      !isAbsolute(outputRelative))
  ) {
    throw new TypeError("archive output must be outside the source tree");
  }
  const limits = {
    maxFileBytes: assertLimit(maxFileBytes, DEFAULT_MAX_FILE_BYTES, "maxFileBytes"),
    maxTreeBytes: assertLimit(maxTreeBytes, DEFAULT_MAX_TREE_BYTES, "maxTreeBytes"),
    maxFiles: assertLimit(maxFiles, DEFAULT_MAX_FILES, "maxFiles"),
  };
  const entries = await collectFiles(sourceRoot, limits);
  if (entries.length === 0) throw new TypeError("archive tree must contain at least one file");
  const chunks = [];
  let totalBytes = 0;
  for (const entry of entries) {
    chunks.push(createHeader(entry), entry.bytes);
    const padding = (BLOCK_SIZE - (entry.bytes.byteLength % BLOCK_SIZE)) % BLOCK_SIZE;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
    totalBytes += entry.bytes.byteLength;
  }
  chunks.push(END_BLOCKS);
  const archive = Buffer.concat(chunks);
  await writeFile(outputPath, archive, { flag: "wx", mode: 0o644 });
  return {
    version: 1,
    format: "ustar",
    archiveSha256: createHash("sha256").update(archive).digest("hex"),
    treeSha256: computeTreeSha256(entries),
    fileCount: entries.length,
    totalBytes,
  };
}

async function main() {
  const args = parseCliArguments(process.argv.slice(2));
  const allowed = new Set(["root", "output", "max-file-bytes", "max-tree-bytes", "max-files"]);
  if (Object.keys(args).some((name) => !allowed.has(name))) {
    throw new TypeError("unknown deterministic archive argument");
  }
  if (args.root === undefined || args.output === undefined) {
    throw new TypeError("--root and --output are required");
  }
  const parseLimit = (name) => {
    if (args[name] === undefined) return undefined;
    if (!/^[1-9][0-9]*$/.test(args[name])) throw new TypeError(`--${name} is invalid`);
    return Number(args[name]);
  };
  const result = await createDeterministicTreeArchive({
    root: args.root,
    output: args.output,
    maxFileBytes: parseLimit("max-file-bytes"),
    maxTreeBytes: parseLimit("max-tree-bytes"),
    maxFiles: parseLimit("max-files"),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
