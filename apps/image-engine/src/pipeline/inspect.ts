import { readFile, stat } from "node:fs/promises";
import { crc32, inflateSync } from "node:zlib";
import type { ImageResourceClass } from "@hereisit/server-contracts";
import {
  IMAGE_OPTIMIZE_MAX_DIMENSION,
  IMAGE_OPTIMIZE_MAX_FILE_BYTES,
  IMAGE_OPTIMIZE_MAX_PIXELS,
  type ImageOptimizeMime,
} from "@hereisit/tool-contracts";
import sharp from "sharp";
import { resourcePolicies } from "../job/resource-monitor";

const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const BOMB_DECODED_BYTES = 64 * 1024 * 1024;
const MAX_EXPANSION_RATIO = 512;

export type SourceColorModel = "gray" | "rgb" | "ycbcr" | "cmyk" | "ycck" | "unknown";

export interface ImageInspection {
  readonly format: "jpeg" | "png" | "webp";
  readonly mime: "image/jpeg" | "image/png" | "image/webp";
  readonly width: number;
  readonly height: number;
  readonly displayedWidth: number;
  readonly displayedHeight: number;
  readonly pixels: number;
  readonly bitDepth: 8 | 16;
  readonly hasAlpha: boolean;
  readonly animated: boolean;
  readonly orientation: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  readonly hasIccProfile: boolean;
  readonly sourceColorModel: SourceColorModel;
  readonly adobeTransform: 0 | 1 | 2 | null;
  readonly iccProfileKind: "none" | "srgb-compatible" | "cmyk" | "other";
  readonly wideGamut: boolean;
  readonly metadataBytes: number;
}

export type ImagePipelineErrorCode =
  | "UNSUPPORTED_INPUT"
  | "UNSUPPORTED_FEATURE"
  | "INPUT_LIMIT_EXCEEDED"
  | "PIXEL_LIMIT_EXCEEDED"
  | "RESOURCE_CLASS_UPGRADE"
  | "ENGINE_OOM";

export class ImagePipelineError extends Error {
  constructor(
    readonly code: ImagePipelineErrorCode,
    readonly retryable = false,
    readonly inspection?: ImageInspection,
  ) {
    super(code);
    this.name = "ImagePipelineError";
  }
}

export interface StructuralMetadata {
  readonly width: number;
  readonly height: number;
  readonly format: "jpeg" | "png" | "webp";
  readonly bitDepth: 8 | 16;
  readonly hasAlpha: boolean;
  readonly pages: number;
  readonly orientation: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
}

interface ParsedStructure extends ImageInspection {}

function fail(code: ImagePipelineErrorCode, retryable = false): never {
  throw new ImagePipelineError(code, retryable);
}

function checkedDimensions(width: number, height: number): number {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    fail("UNSUPPORTED_INPUT");
  }
  if (width > IMAGE_OPTIMIZE_MAX_DIMENSION || height > IMAGE_OPTIMIZE_MAX_DIMENSION) {
    fail("PIXEL_LIMIT_EXCEEDED");
  }
  if (width > Math.floor(IMAGE_OPTIMIZE_MAX_PIXELS / height)) fail("PIXEL_LIMIT_EXCEEDED");
  return width * height;
}

function displayedDimensions(width: number, height: number, orientation: number) {
  return orientation >= 5 && orientation <= 8
    ? { displayedWidth: height, displayedHeight: width }
    : { displayedWidth: width, displayedHeight: height };
}

function exifOrientation(bytes: Uint8Array): 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 {
  let offset = 0;
  if (bytes.length >= 6 && Buffer.from(bytes.subarray(0, 6)).toString("binary") === "Exif\0\0") {
    offset = 6;
  }
  if (bytes.length < offset + 8) return 1;
  const little = bytes[offset] === 0x49 && bytes[offset + 1] === 0x49;
  const big = bytes[offset] === 0x4d && bytes[offset + 1] === 0x4d;
  if (!little && !big) return 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, little);
  const u32 = (at: number) => view.getUint32(at, little);
  if (u16(offset + 2) !== 42) return 1;
  const directory = offset + u32(offset + 4);
  if (directory + 2 > bytes.length) return 1;
  const count = u16(directory);
  if (directory + 2 + count * 12 > bytes.length) return 1;
  for (let index = 0; index < count; index += 1) {
    const entry = directory + 2 + index * 12;
    if (u16(entry) !== 0x0112 || u16(entry + 2) !== 3 || u32(entry + 4) !== 1) continue;
    const value = u16(entry + 8);
    if (value >= 1 && value <= 8) return value as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  }
  return 1;
}

function iccKind(profile: Uint8Array | null): {
  kind: ImageInspection["iccProfileKind"];
  wideGamut: boolean;
} {
  if (profile === null) return { kind: "none", wideGamut: false };
  if (profile.byteLength < 132) return { kind: "other", wideGamut: true };
  const view = new DataView(profile.buffer, profile.byteOffset, profile.byteLength);
  const declared = view.getUint32(0, false);
  const signature = Buffer.from(profile.subarray(36, 40)).toString("ascii");
  if (declared !== profile.byteLength || signature !== "acsp") {
    return { kind: "other", wideGamut: true };
  }
  const tagCount = view.getUint32(128, false);
  if (tagCount > 128 || 132 + tagCount * 12 > profile.byteLength) {
    return { kind: "other", wideGamut: true };
  }
  const tags = new Map<string, Uint8Array>();
  for (let index = 0; index < tagCount; index += 1) {
    const entry = 132 + index * 12;
    const name = Buffer.from(profile.subarray(entry, entry + 4)).toString("ascii");
    const offset = view.getUint32(entry + 4, false);
    const length = view.getUint32(entry + 8, false);
    if (tags.has(name) || length < 8 || offset < 128 || offset > profile.byteLength - length) {
      return { kind: "other", wideGamut: true };
    }
    tags.set(name, profile.subarray(offset, offset + length));
  }
  const colorSpace = Buffer.from(profile.subarray(16, 20)).toString("ascii");
  if (colorSpace === "CMYK") return { kind: "cmyk", wideGamut: false };
  const hasLookupTransform = ["A2B0", "A2B1", "A2B2", "B2A0", "B2A1", "B2A2"].some((name) =>
    tags.has(name),
  );
  const fixed = (bytes: Uint8Array, offset: number) =>
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(offset, false) / 65_536;
  const xyz = (name: string): readonly [number, number, number] | null => {
    const bytes = tags.get(name);
    if (
      bytes === undefined ||
      bytes.byteLength < 20 ||
      Buffer.from(bytes.subarray(0, 4)).toString("ascii") !== "XYZ "
    ) {
      return null;
    }
    return [fixed(bytes, 8), fixed(bytes, 12), fixed(bytes, 16)];
  };
  const close = (actual: readonly number[] | null, expected: readonly number[], tolerance = 0.01) =>
    actual !== null &&
    expected.every((value, index) => Math.abs((actual[index] ?? 0) - value) <= tolerance);
  const transfer = (name: string): boolean => {
    const bytes = tags.get(name);
    if (bytes === undefined || bytes.byteLength < 12) return false;
    const type = Buffer.from(bytes.subarray(0, 4)).toString("ascii");
    const curveView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (type === "para") {
      if (bytes.byteLength < 16) return false;
      const functionType = curveView.getUint16(8, false);
      const gamma = fixed(bytes, 12);
      if (functionType === 0) return Math.abs(gamma - 2.2) <= 0.05;
      if ((functionType !== 3 && functionType !== 4) || bytes.byteLength < 32) return false;
      const parameters = [
        gamma,
        fixed(bytes, 16),
        fixed(bytes, 20),
        fixed(bytes, 24),
        fixed(bytes, 28),
      ];
      const expected = [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045];
      return expected.every((value, index) => Math.abs((parameters[index] ?? 0) - value) <= 0.01);
    }
    if (type !== "curv") return false;
    const count = curveView.getUint32(8, false);
    if (count === 1 && bytes.byteLength >= 14) {
      return Math.abs(curveView.getUint16(12, false) / 256 - 2.2) <= 0.05;
    }
    if (count < 16 || bytes.byteLength < 12 + count * 2) return false;
    for (const point of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const index = Math.round(point * (count - 1));
      const actual = curveView.getUint16(12 + index * 2, false) / 65_535;
      const expected = point <= 0.04045 ? point / 12.92 : ((point + 0.055) / 1.055) ** 2.4;
      if (Math.abs(actual - expected) > 0.015) return false;
    }
    return true;
  };
  const srgb =
    !hasLookupTransform &&
    (colorSpace === "RGB "
      ? close(xyz("rXYZ"), [0.4361, 0.2225, 0.0139]) &&
        close(xyz("gXYZ"), [0.3851, 0.7169, 0.0971]) &&
        close(xyz("bXYZ"), [0.1431, 0.0606, 0.7142]) &&
        transfer("rTRC") &&
        transfer("gTRC") &&
        transfer("bTRC")
      : colorSpace === "GRAY" && close(xyz("wtpt"), [0.9642, 1, 0.8249], 0.02) && transfer("kTRC"));
  return { kind: srgb ? "srgb-compatible" : "other", wideGamut: !srgb };
}

function classifyJpegColor(input: {
  components: readonly number[];
  jfif: boolean;
  adobeTransform: 0 | 1 | 2 | null;
  profileKind: ImageInspection["iccProfileKind"];
}): SourceColorModel {
  if (input.components.length === 1) return "gray";
  if (input.components.length === 3) {
    if (input.jfif && input.adobeTransform === 0) return "unknown";
    if (input.adobeTransform === 1 || input.jfif) return "ycbcr";
    if (input.adobeTransform === 0) return "rgb";
    if (input.components.join(",") === "82,71,66") return "rgb";
    if (input.components.join(",") === "1,2,3") return "ycbcr";
    return "unknown";
  }
  if (input.components.length === 4) {
    if (input.adobeTransform === 0) return "cmyk";
    if (input.adobeTransform === 2) return "ycck";
    if (input.profileKind === "cmyk" && input.components.join(",") === "67,77,89,75") {
      return "cmyk";
    }
  }
  return "unknown";
}

function parseJpeg(bytes: Uint8Array): ParsedStructure {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) fail("UNSUPPORTED_INPUT");
  let offset = 2;
  let width = 0;
  let height = 0;
  let bitDepth: 8 | 16 = 8;
  let components: number[] | null = null;
  let jfif = false;
  let adobeTransform: 0 | 1 | 2 | null = null;
  let orientation: ImageInspection["orientation"] = 1;
  let metadataBytes = 0;
  const iccChunks = new Map<number, Uint8Array>();
  let iccCount: number | null = null;
  let sawEoi = false;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) fail("UNSUPPORTED_INPUT");
    while (bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) fail("UNSUPPORTED_INPUT");
    const marker = bytes[offset] as number;
    offset += 1;
    if (marker === 0xd9) {
      sawEoi = true;
      break;
    }
    if (marker === 0xda) {
      if (offset + 2 > bytes.length) fail("UNSUPPORTED_INPUT");
      const length = ((bytes[offset] as number) << 8) | (bytes[offset + 1] as number);
      if (length < 2 || offset + length > bytes.length) fail("UNSUPPORTED_INPUT");
      if (
        bytes.length < 2 ||
        bytes[bytes.length - 2] !== 0xff ||
        bytes[bytes.length - 1] !== 0xd9
      ) {
        fail("UNSUPPORTED_INPUT");
      }
      sawEoi = true;
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) fail("UNSUPPORTED_INPUT");
    const length = ((bytes[offset] as number) << 8) | (bytes[offset + 1] as number);
    if (length < 2 || offset + length > bytes.length) fail("UNSUPPORTED_INPUT");
    const body = bytes.subarray(offset + 2, offset + length);
    offset += length;
    if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) {
      metadataBytes += body.byteLength;
      if (metadataBytes > MAX_METADATA_BYTES) fail("INPUT_LIMIT_EXCEEDED");
    }
    if (marker === 0xe0 && Buffer.from(body.subarray(0, 5)).toString("binary") === "JFIF\0") {
      jfif = true;
    }
    if (marker === 0xe1 && Buffer.from(body.subarray(0, 6)).toString("binary") === "Exif\0\0") {
      orientation = exifOrientation(body);
    }
    if (marker === 0xee && Buffer.from(body.subarray(0, 5)).toString("ascii") === "Adobe") {
      if (body.length < 12 || (body[11] as number) > 2) fail("UNSUPPORTED_INPUT");
      const transform = body[11] as 0 | 1 | 2;
      if (adobeTransform !== null && adobeTransform !== transform) fail("UNSUPPORTED_INPUT");
      adobeTransform = transform;
    }
    if (
      marker === 0xe2 &&
      Buffer.from(body.subarray(0, 12)).toString("binary") === "ICC_PROFILE\0"
    ) {
      if (body.length < 14) fail("UNSUPPORTED_INPUT");
      const sequence = body[12] as number;
      const count = body[13] as number;
      if (
        sequence < 1 ||
        count < 1 ||
        sequence > count ||
        (iccCount !== null && iccCount !== count)
      ) {
        fail("UNSUPPORTED_INPUT");
      }
      if (iccChunks.has(sequence)) fail("UNSUPPORTED_INPUT");
      iccCount = count;
      iccChunks.set(sequence, body.subarray(14));
    }
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof) {
      if (components !== null || body.length < 6) fail("UNSUPPORTED_INPUT");
      const precision = body[0] as number;
      if (precision !== 8 && precision !== 16) fail("UNSUPPORTED_FEATURE");
      bitDepth = precision;
      height = ((body[1] as number) << 8) | (body[2] as number);
      width = ((body[3] as number) << 8) | (body[4] as number);
      const count = body[5] as number;
      if (count < 1 || count > 4 || body.length !== 6 + count * 3) fail("UNSUPPORTED_INPUT");
      components = [];
      for (let index = 0; index < count; index += 1) {
        const id = body[6 + index * 3] as number;
        const sampling = body[7 + index * 3] as number;
        if (sampling >> 4 < 1 || (sampling & 0x0f) < 1) fail("UNSUPPORTED_INPUT");
        components.push(id);
      }
    }
  }
  if (!sawEoi || components === null) fail("UNSUPPORTED_INPUT");
  let iccProfile: Uint8Array | null = null;
  if (iccCount !== null) {
    if (iccChunks.size !== iccCount) fail("UNSUPPORTED_INPUT");
    iccProfile = Buffer.concat(
      Array.from({ length: iccCount }, (_, index) =>
        Buffer.from(iccChunks.get(index + 1) as Uint8Array),
      ),
    );
    if (iccProfile.byteLength > MAX_METADATA_BYTES) fail("INPUT_LIMIT_EXCEEDED");
  }
  const profile = iccKind(iccProfile);
  const pixels = checkedDimensions(width, height);
  const display = displayedDimensions(width, height, orientation);
  return {
    format: "jpeg",
    mime: "image/jpeg",
    width,
    height,
    ...display,
    pixels,
    bitDepth,
    hasAlpha: false,
    animated: false,
    orientation,
    hasIccProfile: iccCount !== null,
    sourceColorModel: classifyJpegColor({
      components,
      jfif,
      adobeTransform,
      profileKind: profile.kind,
    }),
    adobeTransform,
    iccProfileKind: profile.kind,
    wideGamut: profile.wideGamut,
    metadataBytes,
  };
}

function readUInt24LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] as number) |
    ((bytes[offset + 1] as number) << 8) |
    ((bytes[offset + 2] as number) << 16)
  );
}

function parsePng(bytes: Uint8Array): ParsedStructure {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 33 || !Buffer.from(bytes.subarray(0, 8)).equals(signature))
    fail("UNSUPPORTED_INPUT");
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth: 8 | 16 = 8;
  let colorType = -1;
  let hasAlpha = false;
  let animated = false;
  let orientation: ImageInspection["orientation"] = 1;
  let metadataBytes = 0;
  let profile: Uint8Array | null = null;
  let srgbChunk = false;
  let gamutMarkers = false;
  let sawHeader = false;
  let sawEnd = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) fail("UNSUPPORTED_INPUT");
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
    const length = view.getUint32(0, false);
    const end = offset + 12 + length;
    if (end > bytes.length) fail("UNSUPPORTED_INPUT");
    const type = Buffer.from(bytes.subarray(offset + 4, offset + 8)).toString("ascii");
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = new DataView(
      bytes.buffer,
      bytes.byteOffset + offset + 8 + length,
      4,
    ).getUint32(0, false);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== expectedCrc) {
      fail("UNSUPPORTED_INPUT");
    }
    offset = end;
    if (!sawHeader && type !== "IHDR") fail("UNSUPPORTED_INPUT");
    if (type === "IHDR") {
      if (sawHeader || length !== 13) fail("UNSUPPORTED_INPUT");
      sawHeader = true;
      const header = new DataView(body.buffer, body.byteOffset, body.byteLength);
      width = header.getUint32(0, false);
      height = header.getUint32(4, false);
      const precision = body[8] as number;
      colorType = body[9] as number;
      if (![0, 2, 3, 4, 6].includes(colorType)) fail("UNSUPPORTED_FEATURE");
      if (precision === 16) bitDepth = 16;
      else if ([1, 2, 4, 8].includes(precision)) bitDepth = 8;
      else fail("UNSUPPORTED_FEATURE");
      hasAlpha = colorType === 4 || colorType === 6;
    } else if (type === "IEND") {
      if (length !== 0 || offset !== bytes.length) fail("UNSUPPORTED_INPUT");
      sawEnd = true;
      break;
    } else if (type === "acTL" || type === "fcTL" || type === "fdAT") {
      animated = true;
    } else if (type === "tRNS") {
      hasAlpha = true;
    } else if (type === "eXIf") {
      orientation = exifOrientation(body);
    } else if (type === "sRGB") {
      srgbChunk = true;
    } else if (type === "gAMA" || type === "cHRM" || type === "cICP") {
      gamutMarkers = true;
    } else if (type === "iCCP") {
      const zero = body.indexOf(0);
      if (zero < 1 || zero + 2 > body.length || body[zero + 1] !== 0) fail("UNSUPPORTED_INPUT");
      try {
        profile = inflateSync(body.subarray(zero + 2), { maxOutputLength: MAX_METADATA_BYTES + 1 });
      } catch {
        fail("UNSUPPORTED_INPUT");
      }
      if (profile.byteLength > MAX_METADATA_BYTES) fail("INPUT_LIMIT_EXCEEDED");
    }
    if (type !== "IDAT" && type !== "IHDR" && type !== "IEND") {
      metadataBytes += length;
      if (metadataBytes > MAX_METADATA_BYTES) fail("INPUT_LIMIT_EXCEEDED");
    }
  }
  if (!sawHeader || !sawEnd) fail("UNSUPPORTED_INPUT");
  if (animated) fail("UNSUPPORTED_FEATURE");
  const parsedProfile =
    profile === null && srgbChunk
      ? { kind: "srgb-compatible" as const, wideGamut: false }
      : iccKind(profile);
  const pixels = checkedDimensions(width, height);
  const display = displayedDimensions(width, height, orientation);
  return {
    format: "png",
    mime: "image/png",
    width,
    height,
    ...display,
    pixels,
    bitDepth,
    hasAlpha,
    animated: false,
    orientation,
    hasIccProfile: profile !== null,
    sourceColorModel: colorType === 0 || colorType === 4 ? "gray" : "rgb",
    adobeTransform: null,
    iccProfileKind: parsedProfile.kind,
    wideGamut: parsedProfile.wideGamut || (gamutMarkers && !srgbChunk),
    metadataBytes,
  };
}

function parseWebp(bytes: Uint8Array): ParsedStructure {
  if (
    bytes.length < 20 ||
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") !== "RIFF" ||
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") !== "WEBP"
  ) {
    fail("UNSUPPORTED_INPUT");
  }
  const declared = new DataView(bytes.buffer, bytes.byteOffset + 4, 4).getUint32(0, true) + 8;
  if (declared !== bytes.length) fail("UNSUPPORTED_INPUT");
  let offset = 12;
  let extendedWidth = 0;
  let extendedHeight = 0;
  let imageWidth = 0;
  let imageHeight = 0;
  let hasAlpha = false;
  let animated = false;
  let orientation: ImageInspection["orientation"] = 1;
  let metadataBytes = 0;
  let profile: Uint8Array | null = null;
  let imageChunks = 0;
  let chunkIndex = 0;
  let sawExtendedHeader = false;
  let extendedFlags = 0;
  let hasAlphaChunk = false;
  let hasExifChunk = false;
  let hasXmpChunk = false;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) fail("UNSUPPORTED_INPUT");
    const type = Buffer.from(bytes.subarray(offset, offset + 4)).toString("ascii");
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0, true);
    const bodyStart = offset + 8;
    const bodyEnd = bodyStart + length;
    if (bodyEnd > bytes.length) fail("UNSUPPORTED_INPUT");
    const body = bytes.subarray(bodyStart, bodyEnd);
    offset = bodyEnd + (length & 1);
    if (offset > bytes.length) fail("UNSUPPORTED_INPUT");
    if (type === "VP8X") {
      if (
        length !== 10 ||
        chunkIndex !== 0 ||
        sawExtendedHeader ||
        ((body[0] as number) & 0xc1) !== 0
      ) {
        fail("UNSUPPORTED_INPUT");
      }
      sawExtendedHeader = true;
      extendedFlags = body[0] as number;
      animated ||= (extendedFlags & 0x02) !== 0;
      extendedWidth = readUInt24LE(body, 4) + 1;
      extendedHeight = readUInt24LE(body, 7) + 1;
    } else if (type === "VP8 ") {
      imageChunks += 1;
      if (length < 10 || body[3] !== 0x9d || body[4] !== 0x01 || body[5] !== 0x2a) {
        fail("UNSUPPORTED_INPUT");
      }
      imageWidth = ((body[6] as number) | ((body[7] as number) << 8)) & 0x3fff;
      imageHeight = ((body[8] as number) | ((body[9] as number) << 8)) & 0x3fff;
    } else if (type === "VP8L") {
      imageChunks += 1;
      if (length < 5 || body[0] !== 0x2f) fail("UNSUPPORTED_INPUT");
      const packed = new DataView(body.buffer, body.byteOffset + 1, 4).getUint32(0, true);
      imageWidth = (packed & 0x3fff) + 1;
      imageHeight = ((packed >>> 14) & 0x3fff) + 1;
      hasAlpha ||= ((packed >>> 28) & 1) === 1;
    } else if (type === "ANIM" || type === "ANMF") {
      animated = true;
    } else if (type === "ALPH") {
      hasAlphaChunk = true;
      hasAlpha = true;
    } else if (type === "ICCP") {
      if (profile !== null) fail("UNSUPPORTED_INPUT");
      profile = body;
      metadataBytes += length;
    } else if (type === "EXIF") {
      hasExifChunk = true;
      orientation = exifOrientation(body);
      metadataBytes += length;
    } else if (type === "XMP ") {
      hasXmpChunk = true;
      metadataBytes += length;
    }
    if (metadataBytes > MAX_METADATA_BYTES) fail("INPUT_LIMIT_EXCEEDED");
    chunkIndex += 1;
  }
  if (animated) fail("UNSUPPORTED_FEATURE");
  if (imageWidth < 1 || imageHeight < 1 || imageChunks !== 1) fail("UNSUPPORTED_INPUT");
  const flagMatches = (mask: number, present: boolean) =>
    ((extendedFlags & mask) !== 0) === present;
  if (sawExtendedHeader) {
    if (
      extendedWidth !== imageWidth ||
      extendedHeight !== imageHeight ||
      !flagMatches(0x20, profile !== null) ||
      !flagMatches(0x10, hasAlpha) ||
      !flagMatches(0x08, hasExifChunk) ||
      !flagMatches(0x04, hasXmpChunk)
    ) {
      fail("UNSUPPORTED_INPUT");
    }
  } else if (profile !== null || hasExifChunk || hasXmpChunk || hasAlphaChunk) {
    fail("UNSUPPORTED_INPUT");
  }
  const width = sawExtendedHeader ? extendedWidth : imageWidth;
  const height = sawExtendedHeader ? extendedHeight : imageHeight;
  const parsedProfile = iccKind(profile);
  const pixels = checkedDimensions(width, height);
  const display = displayedDimensions(width, height, orientation);
  return {
    format: "webp",
    mime: "image/webp",
    width,
    height,
    ...display,
    pixels,
    bitDepth: 8,
    hasAlpha,
    animated: false,
    orientation,
    hasIccProfile: profile !== null,
    sourceColorModel: "rgb",
    adobeTransform: null,
    iccProfileKind: parsedProfile.kind,
    wideGamut: parsedProfile.wideGamut,
    metadataBytes,
  };
}

function parseStructure(bytes: Uint8Array): ParsedStructure {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return parseJpeg(bytes);
  if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) {
    return parsePng(bytes);
  }
  if (
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
  ) {
    return parseWebp(bytes);
  }
  fail("UNSUPPORTED_INPUT");
}

export interface ResourceAssessment {
  readonly decodedBytes: number;
  readonly expansionRatio: number;
  readonly estimatedWorkingSet: number;
  readonly code: "RESOURCE_CLASS_UPGRADE" | "ENGINE_OOM" | null;
}

export function assessResourceBounds(input: {
  readonly inspection: Pick<ImageInspection, "width" | "height" | "hasAlpha" | "bitDepth">;
  readonly encodedBytes: number;
  readonly resourceClass: ImageResourceClass;
  readonly decodedBytesOverride?: number;
}): ResourceAssessment {
  if (!Number.isSafeInteger(input.encodedBytes) || input.encodedBytes < 1) {
    fail("UNSUPPORTED_INPUT");
  }
  const decodedBytes =
    input.decodedBytesOverride ??
    input.inspection.width *
      input.inspection.height *
      (input.inspection.hasAlpha ? 4 : 3) *
      (input.inspection.bitDepth / 8);
  if (!Number.isSafeInteger(decodedBytes) || decodedBytes < 1) fail("ENGINE_OOM");
  const expansionRatio = Math.ceil(decodedBytes / input.encodedBytes);
  if (expansionRatio > MAX_EXPANSION_RATIO && decodedBytes > BOMB_DECODED_BYTES) {
    fail("INPUT_LIMIT_EXCEEDED");
  }
  const estimatedWorkingSet = decodedBytes * 3 + input.encodedBytes * 2;
  if (!Number.isSafeInteger(estimatedWorkingSet)) fail("ENGINE_OOM");
  const standardThreshold = Math.floor(resourcePolicies["image-standard-v1"].workspaceBytes * 0.75);
  const largeThreshold = Math.floor(resourcePolicies["image-large-v1"].workspaceBytes * 0.75);
  const code =
    estimatedWorkingSet > largeThreshold
      ? "ENGINE_OOM"
      : input.resourceClass === "image-standard-v1" && estimatedWorkingSet > standardThreshold
        ? "RESOURCE_CLASS_UPGRADE"
        : null;
  return { decodedBytes, expansionRatio, estimatedWorkingSet, code };
}

async function defaultReadMetadata(path: string): Promise<StructuralMetadata> {
  let value: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    value = await sharp(path, {
      failOn: "error",
      limitInputPixels: IMAGE_OPTIMIZE_MAX_PIXELS,
      sequentialRead: true,
    }).metadata();
  } catch {
    fail("UNSUPPORTED_INPUT");
  }
  if (
    value.width === undefined ||
    value.height === undefined ||
    (value.format !== "jpeg" && value.format !== "png" && value.format !== "webp")
  ) {
    fail("UNSUPPORTED_INPUT");
  }
  return {
    width: value.width,
    height: value.height,
    format: value.format,
    bitDepth: value.depth === "ushort" ? 16 : 8,
    hasAlpha: value.hasAlpha ?? false,
    pages: value.pages ?? 1,
    orientation:
      value.orientation !== undefined && value.orientation >= 1 && value.orientation <= 8
        ? (value.orientation as StructuralMetadata["orientation"])
        : 1,
  };
}

export async function inspectImage(
  path: string,
  _mimeHint: ImageOptimizeMime,
  options: {
    readonly resourceClass?: ImageResourceClass;
    readonly readMetadata?: (path: string) => Promise<StructuralMetadata>;
    readonly encodedBytesOverride?: number;
  } = {},
): Promise<ImageInspection> {
  const information = await stat(path);
  if (!information.isFile() || information.size < 1) fail("UNSUPPORTED_INPUT");
  if (information.size > IMAGE_OPTIMIZE_MAX_FILE_BYTES) fail("INPUT_LIMIT_EXCEEDED");
  const bytes = await readFile(path);
  const inspection = parseStructure(bytes);
  const assessment = assessResourceBounds({
    inspection,
    encodedBytes: options.encodedBytesOverride ?? information.size,
    resourceClass: options.resourceClass ?? "image-standard-v1",
  });
  if (assessment.code === "RESOURCE_CLASS_UPGRADE") {
    throw new ImagePipelineError(assessment.code, true, inspection);
  }
  if (assessment.code === "ENGINE_OOM") {
    throw new ImagePipelineError(assessment.code, false, inspection);
  }
  const decoded = await (options.readMetadata ?? defaultReadMetadata)(path);
  if (
    decoded.width !== inspection.width ||
    decoded.height !== inspection.height ||
    decoded.format !== inspection.format ||
    decoded.pages !== 1 ||
    decoded.bitDepth !== inspection.bitDepth ||
    decoded.hasAlpha !== inspection.hasAlpha ||
    decoded.orientation !== inspection.orientation
  ) {
    fail("UNSUPPORTED_INPUT");
  }
  return inspection;
}
