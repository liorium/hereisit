export type SupportedImageFormat = "jpeg" | "png" | "webp";

export interface InspectedImageFile {
  format: SupportedImageFormat;
  mime: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
  animated: boolean;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(bytes[start + index] ?? 0);
  }
  return value;
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      ((bytes[offset + 1] ?? 0) << 16) +
      ((bytes[offset + 2] ?? 0) << 8) +
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) +
      ((bytes[offset + 1] ?? 0) << 8) +
      ((bytes[offset + 2] ?? 0) << 16) +
      (bytes[offset + 3] ?? 0) * 0x1000000) >>>
    0
  );
}

function invalidImage(): never {
  throw new Error("지원하지 않거나 손상된 이미지 형식입니다.");
}

function validDimensions(width: number, height: number): boolean {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0;
}

function inspectJpeg(bytes: Uint8Array): InspectedImageFile {
  const startOfFrameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;

  while (offset < bytes.length) {
    while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > bytes.length) invalidImage();

    const segmentLength = readUint16BE(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) invalidImage();
    if (startOfFrameMarkers.has(marker)) {
      if (segmentLength < 7) invalidImage();
      const height = readUint16BE(bytes, offset + 3);
      const width = readUint16BE(bytes, offset + 5);
      if (!validDimensions(width, height)) invalidImage();
      return { format: "jpeg", mime: "image/jpeg", width, height, animated: false };
    }
    offset += segmentLength;
  }

  return invalidImage();
}

function inspectPng(bytes: Uint8Array): InspectedImageFile {
  if (ascii(bytes, 12, 4) !== "IHDR") invalidImage();
  const width = readUint32BE(bytes, 16);
  const height = readUint32BE(bytes, 20);
  if (!validDimensions(width, height)) invalidImage();

  let animated = false;
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const chunkLength = readUint32BE(bytes, offset);
    const chunkType = ascii(bytes, offset + 4, 4);
    const nextOffset = offset + 12 + chunkLength;
    if (nextOffset > bytes.length) invalidImage();
    if (chunkType === "acTL") animated = true;
    if (chunkType === "IDAT" || chunkType === "IEND") break;
    offset = nextOffset;
  }

  return { format: "png", mime: "image/png", width, height, animated };
}

function inspectWebp(bytes: Uint8Array): InspectedImageFile {
  const declaredEnd = readUint32LE(bytes, 4) + 8;
  if (declaredEnd < 20 || declaredEnd > bytes.length) invalidImage();

  let width: number | undefined;
  let height: number | undefined;
  let animated = false;
  let offset = 12;

  while (offset + 8 <= declaredEnd) {
    const chunkType = ascii(bytes, offset, 4);
    const chunkLength = readUint32LE(bytes, offset + 4);
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + chunkLength;
    if (dataEnd > declaredEnd) invalidImage();

    if (chunkType === "VP8X") {
      if (chunkLength < 10) invalidImage();
      animated ||= ((bytes[dataOffset] ?? 0) & 0x02) !== 0;
      width = readUint24LE(bytes, dataOffset + 4) + 1;
      height = readUint24LE(bytes, dataOffset + 7) + 1;
    } else if (chunkType === "VP8 ") {
      if (
        chunkLength < 10 ||
        bytes[dataOffset + 3] !== 0x9d ||
        bytes[dataOffset + 4] !== 0x01 ||
        bytes[dataOffset + 5] !== 0x2a
      ) {
        invalidImage();
      }
      width ??= readUint16LE(bytes, dataOffset + 6) & 0x3fff;
      height ??= readUint16LE(bytes, dataOffset + 8) & 0x3fff;
    } else if (chunkType === "VP8L") {
      if (chunkLength < 5 || bytes[dataOffset] !== 0x2f) invalidImage();
      const packed = readUint32LE(bytes, dataOffset + 1);
      width ??= (packed & 0x3fff) + 1;
      height ??= ((packed >>> 14) & 0x3fff) + 1;
    } else if (chunkType === "ANIM" || chunkType === "ANMF") {
      animated = true;
    }

    offset = dataEnd + (chunkLength % 2);
  }

  if (width === undefined || height === undefined || !validDimensions(width, height))
    invalidImage();
  return { format: "webp", mime: "image/webp", width, height, animated };
}

export function inspectImageHeader(buffer: ArrayBuffer): InspectedImageFile {
  const bytes = new Uint8Array(buffer);

  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return inspectJpeg(bytes);
  }

  if (
    bytes.length >= 33 &&
    bytes[0] === 0x89 &&
    ascii(bytes, 1, 3) === "PNG" &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return inspectPng(bytes);
  }

  if (bytes.length >= 20 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return inspectWebp(bytes);
  }

  return invalidImage();
}
