import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createGunzip, createZstdDecompress } from "node:zlib";

const blockSize = 512;
const maximumArchiveBytes = 2 * 1024 * 1024 * 1024;
const maximumExpandedLayerBytes = 4 * 1024 * 1024 * 1024;
const maximumEntries = 10_000;
const maximumJsonBytes = 8 * 1024 * 1024;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const utf8 = new TextDecoder("utf-8", { fatal: true });

function assertObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    throw new TypeError(`${label} must be a SHA-256 digest`);
  }
  return value;
}

function assertAllowedKeys(value, allowed, required, label) {
  const keys = Object.keys(assertObject(value, label));
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))) {
    throw new TypeError(`${label} fields are invalid`);
  }
}

function isZero(bytes) {
  for (const byte of bytes) if (byte !== 0) return false;
  return true;
}

async function readExactly(handle, position, length, label) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(bytes, offset, length - offset, position + offset);
    if (result.bytesRead === 0) throw new TypeError(`${label} ended unexpectedly`);
    offset += result.bytesRead;
  }
  return bytes;
}

function readTarString(header, offset, length, label) {
  const field = header.subarray(offset, offset + length);
  const terminator = field.indexOf(0);
  const end = terminator === -1 ? field.byteLength : terminator;
  try {
    return utf8.decode(field.subarray(0, end));
  } catch {
    throw new TypeError(`${label} is not valid UTF-8`);
  }
}

function readTarNumber(header, offset, length, label) {
  const field = header.subarray(offset, offset + length);
  if ((field[0] & 0x80) !== 0) {
    const encoded = Buffer.from(field);
    encoded[0] &= 0x7f;
    let value = 0n;
    for (const byte of encoded) value = value * 256n + BigInt(byte);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError(`${label} exceeds the safe integer range`);
    }
    return Number(value);
  }
  const text = field.toString("ascii").replace(/\0.*$/s, "").trim();
  if (text.length === 0) return 0;
  if (!/^[0-7]+$/.test(text)) throw new TypeError(`${label} is not an octal number`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} exceeds the safe integer range`);
  return value;
}

function verifyTarChecksum(header) {
  const expected = readTarNumber(header, 148, 8, "tar checksum");
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  let actual = 0;
  for (const byte of copy) actual += byte;
  if (actual !== expected) throw new TypeError("tar header checksum does not match");
}

function canonicalMemberPath(header, type) {
  const name = readTarString(header, 0, 100, "tar member name");
  const prefix = readTarString(header, 345, 155, "tar member prefix");
  let path = prefix.length === 0 ? name : `${prefix}/${name}`;
  if (type === "5" && path.endsWith("/")) path = path.slice(0, -1);
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.normalize("NFC") !== path ||
    path.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new TypeError("tar member path is not canonical");
  }
  return path;
}

async function hashRange(handle, start, size, transform, maximumOutputBytes = maximumArchiveBytes) {
  const hash = createHash("sha256");
  if (size === 0) return hash.digest("hex");
  const source = handle.createReadStream({ start, end: start + size - 1, autoClose: false });
  const stream = transform === undefined ? source : source.pipe(transform());
  let totalBytes = 0;
  try {
    for await (const chunk of stream) {
      totalBytes += chunk.byteLength;
      if (totalBytes > maximumOutputBytes) {
        throw new RangeError("image layer exceeds the expanded size limit");
      }
      hash.update(chunk);
    }
  } catch (error) {
    if (error instanceof RangeError) throw error;
    throw new TypeError("image layer could not be decompressed");
  }
  return hash.digest("hex");
}

async function verifyZeroRange(handle, start, size, label) {
  let offset = 0;
  while (offset < size) {
    const length = Math.min(64 * 1024, size - offset);
    const bytes = await readExactly(handle, start + offset, length, label);
    if (!isZero(bytes)) throw new TypeError(`${label} must contain only zero bytes`);
    offset += length;
  }
}

async function scanVerifiedTarArchive({ archivePath, asset, label }) {
  let handle;
  try {
    handle = await open(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ELOOP") throw new TypeError(`${label} must not be a symbolic link`);
    throw new Error(`${label} could not be read`);
  }
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size !== asset.sizeBytes ||
      metadata.size < blockSize * 3 ||
      metadata.size > maximumArchiveBytes ||
      metadata.size % blockSize !== 0
    ) {
      throw new TypeError(`${label} size does not match or is not a bounded tar archive`);
    }
    const archiveSha256 = await hashRange(handle, 0, metadata.size);
    if (archiveSha256 !== asset.sha256) throw new TypeError(`${label} hash does not match`);

    const entries = new Map();
    const paths = new Set();
    let position = 0;
    while (position < metadata.size) {
      const header = await readExactly(handle, position, blockSize, `${label} header`);
      if (isZero(header)) {
        const trailingBytes = metadata.size - position;
        if (trailingBytes < blockSize * 2) throw new TypeError(`${label} tar end is truncated`);
        await verifyZeroRange(handle, position, trailingBytes, `${label} tar end`);
        return { handle, entries };
      }
      verifyTarChecksum(header);
      const rawType = header[156];
      const type = rawType === 0 ? "0" : String.fromCharCode(rawType);
      if (type !== "0" && type !== "5") {
        throw new TypeError(`${label} contains a non-file tar member`);
      }
      const path = canonicalMemberPath(header, type);
      if (paths.has(path)) throw new TypeError(`${label} contains duplicate tar members`);
      paths.add(path);
      if (paths.size > maximumEntries) throw new RangeError(`${label} has too many tar members`);
      const size = readTarNumber(header, 124, 12, "tar member size");
      if (type === "5" && size !== 0) throw new TypeError(`${label} directory member is not empty`);
      const dataOffset = position + blockSize;
      const paddedSize = Math.ceil(size / blockSize) * blockSize;
      const nextPosition = dataOffset + paddedSize;
      if (nextPosition > metadata.size - blockSize * 2) {
        throw new TypeError(`${label} tar member exceeds archive bounds`);
      }
      if (type === "0") {
        const sha256 = await hashRange(handle, dataOffset, size);
        entries.set(path, { path, size, dataOffset, sha256 });
      }
      if (paddedSize > size) {
        await verifyZeroRange(
          handle,
          dataOffset + size,
          paddedSize - size,
          `${label} tar member padding`,
        );
      }
      position = nextPosition;
    }
    throw new TypeError(`${label} is missing the tar end blocks`);
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readJsonEntry(handle, entry, label) {
  if (entry === undefined) throw new TypeError(`${label} is missing`);
  if (entry.size < 1 || entry.size > maximumJsonBytes) {
    throw new RangeError(`${label} exceeds the JSON size limit`);
  }
  const bytes = await readExactly(handle, entry.dataOffset, entry.size, label);
  try {
    return JSON.parse(utf8.decode(bytes));
  } catch {
    throw new TypeError(`${label} is not valid JSON`);
  }
}

function descriptorEntry(entries, descriptor, label) {
  const value = assertObject(descriptor, label);
  const digest = assertDigest(value.digest, `${label} digest`);
  if (!Number.isSafeInteger(value.size) || value.size < 1) {
    throw new TypeError(`${label} size is invalid`);
  }
  const entry = entries.get(`blobs/sha256/${digest.slice(7)}`);
  if (entry === undefined || entry.size !== value.size || entry.sha256 !== digest.slice(7)) {
    throw new TypeError(`${label} blob identity does not match`);
  }
  return entry;
}

function validateConfig(config, expectedIdentity, label) {
  const value = assertObject(config, `${label} config`);
  if (value.os !== "linux" || value.architecture !== "amd64") {
    throw new TypeError(`${label} config platform must be linux/amd64`);
  }
  const rootfs = assertObject(value.rootfs, `${label} config rootfs`);
  if (rootfs.type !== "layers" || !Array.isArray(rootfs.diff_ids)) {
    throw new TypeError(`${label} config rootfs DiffIDs are invalid`);
  }
  const diffIds = rootfs.diff_ids.map((digest) => assertDigest(digest, `${label} rootfs DiffID`));
  if (
    diffIds.length !== expectedIdentity.diffIds.length ||
    diffIds.some((digest, index) => digest !== expectedIdentity.diffIds[index])
  ) {
    throw new TypeError(`${label} config rootfs DiffIDs do not match the candidate`);
  }
  return diffIds;
}

function selectOciManifestDescriptor(index) {
  const value = assertObject(index, "OCI index");
  if (value.schemaVersion !== 2 || value.mediaType !== "application/vnd.oci.image.index.v1+json") {
    throw new TypeError("OCI index format is unsupported");
  }
  if (!Array.isArray(value.manifests) || value.manifests.length === 0) {
    throw new TypeError("OCI index manifests are missing");
  }
  const runnable = [];
  for (const descriptorValue of value.manifests) {
    const descriptor = assertObject(descriptorValue, "OCI index descriptor");
    if (descriptor.mediaType !== "application/vnd.oci.image.manifest.v1+json") {
      throw new TypeError("OCI index descriptor media type is unsupported");
    }
    const platform = descriptor.platform;
    if (platform === undefined) runnable.push(descriptor);
    else {
      const selected = assertObject(platform, "OCI index descriptor platform");
      const name = `${selected.os}/${selected.architecture}`;
      if (name === "linux/amd64") runnable.push(descriptor);
      else if (name !== "unknown/unknown") {
        throw new TypeError(`unexpected OCI platform descriptor: ${name}`);
      }
    }
  }
  if (runnable.length !== 1) {
    throw new TypeError("OCI index must contain exactly one runnable linux/amd64 image");
  }
  return runnable[0];
}

function layerTransform(mediaType) {
  if (mediaType === "application/vnd.oci.image.layer.v1.tar") return undefined;
  if (mediaType === "application/vnd.oci.image.layer.v1.tar+gzip") return createGunzip;
  if (mediaType === "application/vnd.oci.image.layer.v1.tar+zstd") {
    return createZstdDecompress;
  }
  throw new TypeError("OCI layer media type is unsupported");
}

export async function verifyOciImageArchive({ archivePath, asset, expectedIdentity }) {
  const scanned = await scanVerifiedTarArchive({ archivePath, asset, label: "engine OCI asset" });
  try {
    const layout = await readJsonEntry(
      scanned.handle,
      scanned.entries.get("oci-layout"),
      "OCI layout",
    );
    if (
      Object.keys(assertObject(layout, "OCI layout")).length !== 1 ||
      layout.imageLayoutVersion !== "1.0.0"
    ) {
      throw new TypeError("OCI layout version is unsupported");
    }
    const index = await readJsonEntry(
      scanned.handle,
      scanned.entries.get("index.json"),
      "OCI index",
    );
    const manifestDescriptor = selectOciManifestDescriptor(index);
    const manifestEntry = descriptorEntry(
      scanned.entries,
      manifestDescriptor,
      "OCI runnable manifest descriptor",
    );
    const manifest = assertObject(
      await readJsonEntry(scanned.handle, manifestEntry, "OCI runnable manifest"),
      "OCI runnable manifest",
    );
    if (
      manifest.schemaVersion !== 2 ||
      manifest.mediaType !== "application/vnd.oci.image.manifest.v1+json"
    ) {
      throw new TypeError("OCI runnable manifest format is unsupported");
    }
    const configEntry = descriptorEntry(scanned.entries, manifest.config, "OCI config descriptor");
    const configDigest = `sha256:${configEntry.sha256}`;
    if (configDigest !== expectedIdentity.configDigest) {
      throw new TypeError("OCI config digest does not match the candidate");
    }
    const config = await readJsonEntry(scanned.handle, configEntry, "OCI image config");
    const configDiffIds = validateConfig(config, expectedIdentity, "OCI image");
    if (!Array.isArray(manifest.layers) || manifest.layers.length !== configDiffIds.length) {
      throw new TypeError("OCI manifest layers do not align with the config rootfs");
    }
    const distributionLayerDigests = [];
    const derivedDiffIds = [];
    for (const layer of manifest.layers) {
      const entry = descriptorEntry(scanned.entries, layer, "OCI layer descriptor");
      const descriptor = assertObject(layer, "OCI layer descriptor");
      distributionLayerDigests.push(assertDigest(descriptor.digest, "OCI layer digest"));
      const diffId = await hashRange(
        scanned.handle,
        entry.dataOffset,
        entry.size,
        layerTransform(descriptor.mediaType),
        maximumExpandedLayerBytes,
      );
      derivedDiffIds.push(`sha256:${diffId}`);
    }
    if (
      distributionLayerDigests.length !== expectedIdentity.distributionLayerDigests.length ||
      distributionLayerDigests.some(
        (digest, indexValue) => digest !== expectedIdentity.distributionLayerDigests[indexValue],
      )
    ) {
      throw new TypeError("OCI distribution layer identity does not match the candidate");
    }
    if (derivedDiffIds.some((digest, indexValue) => digest !== configDiffIds[indexValue])) {
      throw new TypeError("OCI layer content does not match the config rootfs DiffIDs");
    }
    return { configDigest, distributionLayerDigests, diffIds: derivedDiffIds };
  } finally {
    await scanned.handle.close();
  }
}

export async function verifyDockerImageArchive({
  archivePath,
  asset,
  expectedIdentity,
  expectedRepoTag,
}) {
  const scanned = await scanVerifiedTarArchive({
    archivePath,
    asset,
    label: "engine Docker asset",
  });
  try {
    const manifest = await readJsonEntry(
      scanned.handle,
      scanned.entries.get("manifest.json"),
      "Docker manifest",
    );
    if (!Array.isArray(manifest) || manifest.length !== 1) {
      throw new TypeError("Docker manifest must contain exactly one image");
    }
    const image = manifest[0];
    assertAllowedKeys(
      image,
      ["Config", "RepoTags", "Layers", "LayerSources"],
      ["Config", "RepoTags", "Layers"],
      "Docker manifest image",
    );
    if (
      !Array.isArray(image.RepoTags) ||
      image.RepoTags.length !== 1 ||
      image.RepoTags[0] !== expectedRepoTag
    ) {
      throw new TypeError("Docker manifest repository tag does not match");
    }
    if (typeof image.Config !== "string" || typeof scanned.entries.get(image.Config) !== "object") {
      throw new TypeError("Docker config entry is invalid");
    }
    const configEntry = scanned.entries.get(image.Config);
    const configDigest = `sha256:${configEntry.sha256}`;
    if (configDigest !== expectedIdentity.configDigest) {
      throw new TypeError("Docker config digest does not match the candidate");
    }
    const config = await readJsonEntry(scanned.handle, configEntry, "Docker image config");
    const configDiffIds = validateConfig(config, expectedIdentity, "Docker image");
    if (!Array.isArray(image.Layers) || image.Layers.length !== configDiffIds.length) {
      throw new TypeError("Docker manifest layers do not align with the config rootfs");
    }
    const derivedDiffIds = image.Layers.map((path, index) => {
      if (typeof path !== "string") throw new TypeError("Docker layer path is invalid");
      const entry = scanned.entries.get(path);
      if (entry === undefined) throw new TypeError("Docker layer entry is missing");
      const digest = `sha256:${entry.sha256}`;
      if (digest !== configDiffIds[index]) {
        throw new TypeError("Docker layer content does not match the config rootfs DiffIDs");
      }
      return digest;
    });
    return { configDigest, diffIds: derivedDiffIds };
  } finally {
    await scanned.handle.close();
  }
}
