import type { FileKind } from "./tool-catalog";

export const FILE_KIND_DETECTOR_VERSION = 1 as const;
export const MAX_FILE_KIND_PREFIX_BYTES = 64 * 1024;

export interface FileKindHint {
  mime?: string;
  extension?: string;
}

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"]);

function hasBytes(value: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return expected.every((byte, index) => value[offset + index] === byte);
}

function ascii(value: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...value.subarray(offset, offset + length));
}

function hasPdfHeader(value: Uint8Array): boolean {
  const limit = Math.min(1023, value.byteLength - 5);
  for (let offset = 0; offset <= limit; offset += 1) {
    if (hasBytes(value, offset, [0x25, 0x50, 0x44, 0x46, 0x2d])) return true;
  }
  return false;
}

function hasHeicBrand(value: Uint8Array): boolean {
  if (value.byteLength < 12 || ascii(value, 4, 4) !== "ftyp") return false;
  const declaredSize =
    (value[0] ?? 0) * 0x1000000 +
    (value[1] ?? 0) * 0x10000 +
    (value[2] ?? 0) * 0x100 +
    (value[3] ?? 0);
  const boxEnd = declaredSize === 0 ? value.byteLength : Math.min(declaredSize, value.byteLength);
  if (boxEnd < 12) return false;
  if (HEIC_BRANDS.has(ascii(value, 8, 4))) return true;
  for (let offset = 16; offset + 4 <= boxEnd; offset += 4) {
    if (HEIC_BRANDS.has(ascii(value, offset, 4))) return true;
  }
  return false;
}

export function detectFileKindPrefix(
  prefix: Uint8Array,
  _hint: FileKindHint = {},
): FileKind | undefined {
  if (prefix.byteLength === 0 || prefix.byteLength > MAX_FILE_KIND_PREFIX_BYTES) return undefined;
  if (hasBytes(prefix, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (hasBytes(prefix, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (prefix.byteLength >= 12 && ascii(prefix, 0, 4) === "RIFF" && ascii(prefix, 8, 4) === "WEBP") {
    return "image/webp";
  }
  if (hasPdfHeader(prefix)) return "application/pdf";
  if (hasHeicBrand(prefix)) return "image/heic";
  return undefined;
}

export function fileKindLabel(kind: FileKind): string {
  const labels: Partial<Record<FileKind, string>> = {
    "image/jpeg": "JPG 이미지",
    "image/png": "PNG 이미지",
    "image/webp": "WebP 이미지",
    "image/heic": "HEIC 이미지",
    "image/heif": "HEIF 이미지",
    "application/pdf": "PDF",
    "text/plain": "텍스트",
    "application/json": "JSON",
    "application/zip": "ZIP",
  };
  return labels[kind] ?? (kind.startsWith("video/") ? "동영상" : "오디오");
}
