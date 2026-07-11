export type SupportedImageFormat = "jpeg" | "png" | "webp" | "heic";
export type JpegExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface InspectedImageFile {
  format: SupportedImageFormat;
  mime: "image/jpeg" | "image/png" | "image/webp" | "image/heic";
  width: number;
  height: number;
  animated: boolean;
  /** Conservative upper bound for the PNG decoder's raw scanline buffer. */
  pngRawBytes?: number;
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

const MAX_EXIF_IFD_ENTRIES = 4096;
const MAX_JPEG_MARKERS = 4096;
const MAX_JPEG_ICC_PROFILE_BYTES = 4 * 1024 * 1024;

function inspectExifOrientation(
  bytes: Uint8Array,
  payloadStart: number,
  segmentEnd: number,
): JpegExifOrientation | undefined {
  if (segmentEnd - payloadStart < 14 || ascii(bytes, payloadStart, 6) !== "Exif\0\0") {
    return undefined;
  }

  const tiffStart = payloadStart + 6;
  const byteOrder = ascii(bytes, tiffStart, 2);
  const littleEndian = byteOrder === "II";
  if (!littleEndian && byteOrder !== "MM") return undefined;

  const read16 = (offset: number): number | undefined => {
    if (offset < tiffStart || offset + 2 > segmentEnd) return undefined;
    return littleEndian ? readUint16LE(bytes, offset) : readUint16BE(bytes, offset);
  };
  const read32 = (offset: number): number | undefined => {
    if (offset < tiffStart || offset + 4 > segmentEnd) return undefined;
    return littleEndian ? readUint32LE(bytes, offset) : readUint32BE(bytes, offset);
  };

  if (read16(tiffStart + 2) !== 42) return undefined;
  const ifdOffset = read32(tiffStart + 4);
  if (ifdOffset === undefined || ifdOffset < 8) return undefined;
  const ifdStart = tiffStart + ifdOffset;
  if (!Number.isSafeInteger(ifdStart) || ifdStart + 2 > segmentEnd) return undefined;

  const entryCount = read16(ifdStart);
  if (entryCount === undefined || entryCount > MAX_EXIF_IFD_ENTRIES) return undefined;
  const entriesEnd = ifdStart + 2 + entryCount * 12;
  if (!Number.isSafeInteger(entriesEnd) || entriesEnd + 4 > segmentEnd) return undefined;

  for (let index = 0; index < entryCount; index += 1) {
    const entry = ifdStart + 2 + index * 12;
    const tag = read16(entry);
    if (tag !== 0x0112) continue;
    const type = read16(entry + 2);
    const count = read32(entry + 4);
    const value = read16(entry + 8);
    if (type !== 3 || count !== 1 || value === undefined || value < 1 || value > 8) return 1;
    return value as JpegExifOrientation;
  }

  return 1;
}

export function readJpegExifOrientation(buffer: ArrayBuffer): JpegExifOrientation {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
  let offset = 2;
  let markerCount = 0;

  while (offset < bytes.length) {
    markerCount += 1;
    if (markerCount > MAX_JPEG_MARKERS) return 1;
    while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > bytes.length) return 1;

    const segmentLength = readUint16BE(bytes, offset);
    const segmentEnd = offset + segmentLength;
    if (segmentLength < 2 || !Number.isSafeInteger(segmentEnd) || segmentEnd > bytes.length)
      return 1;
    if (marker === 0xe1) {
      const orientation = inspectExifOrientation(bytes, offset + 2, segmentEnd);
      if (orientation !== undefined) return orientation;
    }
    offset = segmentEnd;
  }

  return 1;
}

function jpegPayloadStartsWith(
  bytes: Uint8Array,
  payloadStart: number,
  segmentEnd: number,
  value: string,
): boolean {
  return (
    segmentEnd - payloadStart >= value.length && ascii(bytes, payloadStart, value.length) === value
  );
}

interface JpegIccChunk {
  payloadStart: number;
  dataStart: number;
  segmentEnd: number;
}

function validJpegIccPayloadStarts(bytes: Uint8Array): ReadonlySet<number> {
  const chunks = new Map<number, JpegIccChunk>();
  let expectedChunkCount: number | undefined;
  let totalProfileBytes = 0;
  let markerCount = 0;
  let offset = 2;

  while (offset < bytes.length) {
    markerCount += 1;
    if (markerCount > MAX_JPEG_MARKERS || bytes[offset] !== 0xff) return new Set();
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0x00 || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return new Set();

    const segmentLength = readUint16BE(bytes, offset);
    const segmentEnd = offset + segmentLength;
    if (segmentLength < 2 || !Number.isSafeInteger(segmentEnd) || segmentEnd > bytes.length) {
      return new Set();
    }
    const payloadStart = offset + 2;
    if (
      marker === 0xe2 &&
      jpegPayloadStartsWith(bytes, payloadStart, segmentEnd, "ICC_PROFILE\0")
    ) {
      const sequence = bytes[payloadStart + 12] ?? 0;
      const chunkCount = bytes[payloadStart + 13] ?? 0;
      const dataStart = payloadStart + 14;
      if (
        dataStart >= segmentEnd ||
        chunkCount < 1 ||
        sequence < 1 ||
        sequence > chunkCount ||
        (expectedChunkCount !== undefined && expectedChunkCount !== chunkCount) ||
        chunks.has(sequence)
      ) {
        return new Set();
      }
      expectedChunkCount = chunkCount;
      totalProfileBytes += segmentEnd - dataStart;
      if (totalProfileBytes > MAX_JPEG_ICC_PROFILE_BYTES) return new Set();
      chunks.set(sequence, { payloadStart, dataStart, segmentEnd });
    }
    offset = segmentEnd;
  }

  if (
    expectedChunkCount === undefined ||
    chunks.size !== expectedChunkCount ||
    totalProfileBytes < 132
  ) {
    return new Set();
  }
  const profile = new Uint8Array(totalProfileBytes);
  let profileOffset = 0;
  for (let sequence = 1; sequence <= expectedChunkCount; sequence += 1) {
    const chunk = chunks.get(sequence);
    if (chunk === undefined) return new Set();
    const data = bytes.subarray(chunk.dataStart, chunk.segmentEnd);
    profile.set(data, profileOffset);
    profileOffset += data.byteLength;
  }

  if (readUint32BE(profile, 0) !== profile.byteLength || ascii(profile, 36, 4) !== "acsp") {
    return new Set();
  }
  for (let index = 100; index < 128; index += 1) {
    if (profile[index] !== 0) return new Set();
  }
  const tagCount = readUint32BE(profile, 128);
  const tableEnd = 132 + tagCount * 12;
  if (
    tagCount < 1 ||
    tagCount > 256 ||
    !Number.isSafeInteger(tableEnd) ||
    tableEnd > profile.length
  ) {
    return new Set();
  }

  const occupied = new Uint8Array(profile.length);
  occupied.fill(1, 0, tableEnd);
  const ranges: [number, number][] = [];
  let hasWhitePoint = false;
  for (let index = 0; index < tagCount; index += 1) {
    const entry = 132 + index * 12;
    const signature = ascii(profile, entry, 4);
    const dataOffset = readUint32BE(profile, entry + 4);
    const dataLength = readUint32BE(profile, entry + 8);
    const dataEnd = dataOffset + dataLength;
    if (
      !/^[\x20-\x7e]{4}$/.test(signature) ||
      dataOffset % 4 !== 0 ||
      dataOffset < tableEnd ||
      dataLength < 8 ||
      !Number.isSafeInteger(dataEnd) ||
      dataEnd > profile.length ||
      profile[dataOffset + 4] !== 0 ||
      profile[dataOffset + 5] !== 0 ||
      profile[dataOffset + 6] !== 0 ||
      profile[dataOffset + 7] !== 0
    ) {
      return new Set();
    }
    for (const [start, end] of ranges) {
      const identical = start === dataOffset && end === dataEnd;
      if (!identical && Math.max(start, dataOffset) < Math.min(end, dataEnd)) return new Set();
    }
    ranges.push([dataOffset, dataEnd]);
    occupied.fill(1, dataOffset, dataEnd);
    if (signature === "wtpt") {
      if (dataLength !== 20 || ascii(profile, dataOffset, 4) !== "XYZ ") return new Set();
      hasWhitePoint = true;
    }
  }
  if (!hasWhitePoint) return new Set();
  for (let index = 0; index < profile.length; index += 1) {
    if (occupied[index] === 0 && profile[index] !== 0) return new Set();
  }

  return new Set(Array.from(chunks.values(), (chunk) => chunk.payloadStart));
}

function keepJpegApplicationSegment(
  marker: number,
  bytes: Uint8Array,
  payloadStart: number,
  segmentEnd: number,
  validIccPayloads: ReadonlySet<number>,
): boolean {
  const payloadLength = segmentEnd - payloadStart;
  if (marker === 0xe0)
    return payloadLength === 14 && jpegPayloadStartsWith(bytes, payloadStart, segmentEnd, "JFIF\0");
  if (marker === 0xe2) return validIccPayloads.has(payloadStart);
  return (
    marker === 0xee &&
    payloadLength === 12 &&
    jpegPayloadStartsWith(bytes, payloadStart, segmentEnd, "Adobe")
  );
}

function findJpegMarkerAfterScan(bytes: Uint8Array, start: number): number {
  let offset = start;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const markerStart = offset;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    if (marker === undefined) return bytes.length;
    offset += 1;
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    return markerStart;
  }
  return bytes.length;
}

export function stripJpegMetadata(buffer: ArrayBuffer): ArrayBuffer {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) invalidImage();
  const validIccPayloads = validJpegIccPayloadStarts(bytes);

  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let outputLength = 2;
  let offset = 2;
  let sawScan = false;
  let sawEnd = false;
  let markerCount = 0;
  let removedMetadata = false;
  const keep = (start: number, end: number): void => {
    if (end <= start) return;
    const part = bytes.subarray(start, end);
    parts.push(part);
    outputLength += part.byteLength;
  };

  while (offset < bytes.length) {
    markerCount += 1;
    if (markerCount > MAX_JPEG_MARKERS) invalidImage();
    if (bytes[offset] !== 0xff) invalidImage();
    const markerStart = offset;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0x00) invalidImage();
    const normalizedMarkerStart = offset - 2;
    removedMetadata ||= normalizedMarkerStart !== markerStart;

    if (marker === 0xd9) {
      sawEnd = true;
      keep(normalizedMarkerStart, offset);
      removedMetadata ||= offset < bytes.length;
      offset = bytes.length;
      break;
    }
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      keep(normalizedMarkerStart, offset);
      continue;
    }
    if (offset + 2 > bytes.length) invalidImage();
    const segmentLength = readUint16BE(bytes, offset);
    const segmentEnd = offset + segmentLength;
    if (segmentLength < 2 || !Number.isSafeInteger(segmentEnd) || segmentEnd > bytes.length) {
      invalidImage();
    }

    if (marker === 0xda) {
      sawScan = true;
      keep(normalizedMarkerStart, segmentEnd);
      const nextMarker = findJpegMarkerAfterScan(bytes, segmentEnd);
      keep(segmentEnd, nextMarker);
      offset = nextMarker;
      continue;
    }

    const isApplication = marker >= 0xe0 && marker <= 0xef;
    const isComment = marker === 0xfe;
    if (
      (isApplication &&
        !keepJpegApplicationSegment(marker, bytes, offset + 2, segmentEnd, validIccPayloads)) ||
      isComment
    ) {
      removedMetadata = true;
    } else {
      keep(normalizedMarkerStart, segmentEnd);
    }
    offset = segmentEnd;
  }

  if (!sawScan || !sawEnd) invalidImage();
  if (!removedMetadata) return buffer;
  const stripped = new Uint8Array(outputLength);
  let outputOffset = 0;
  for (const part of parts) {
    stripped.set(part, outputOffset);
    outputOffset += part.byteLength;
  }
  return stripped.buffer;
}

function inspectJpeg(bytes: Uint8Array): InspectedImageFile {
  const startOfFrameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;
  let markerCount = 0;

  while (offset < bytes.length) {
    markerCount += 1;
    if (markerCount > MAX_JPEG_MARKERS) invalidImage();
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

const MAX_PNG_CHUNKS = 4096;
const PNG_ANIMATION_CHUNKS = new Set(["acTL", "fcTL", "fdAT"]);

interface InspectedPngStructure {
  image: InspectedImageFile;
  retainedRanges: readonly [number, number][];
  strippedMetadata: boolean;
}

function validPngBitDepth(bitDepth: number, colorType: number): boolean {
  if (colorType === 0) return [1, 2, 4, 8, 16].includes(bitDepth);
  if (colorType === 2 || colorType === 4 || colorType === 6)
    return bitDepth === 8 || bitDepth === 16;
  return colorType === 3 && [1, 2, 4, 8].includes(bitDepth);
}

function inspectPngStructure(bytes: Uint8Array): InspectedPngStructure {
  const retainedRanges: [number, number][] = [[0, 8]];
  let offset = 8;
  let chunkCount = 0;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  let paletteEntries = 0;
  let sawHeader = false;
  let sawPalette = false;
  let sawTransparency = false;
  let sawImageData = false;
  let imageDataBytes = 0;
  let imageDataEnded = false;
  let sawEnd = false;
  let animated = false;
  let strippedMetadata = false;

  while (offset < bytes.length) {
    chunkCount += 1;
    if (chunkCount > MAX_PNG_CHUNKS || offset + 12 > bytes.length) invalidImage();
    const chunkLength = readUint32BE(bytes, offset);
    const chunkType = ascii(bytes, offset + 4, 4);
    const dataStart = offset + 8;
    const nextOffset = dataStart + chunkLength + 4;
    if (
      !/^[A-Za-z]{4}$/.test(chunkType) ||
      !Number.isSafeInteger(nextOffset) ||
      nextOffset > bytes.length
    ) {
      invalidImage();
    }

    let retain = false;
    if (chunkType === "IHDR") {
      if (sawHeader || chunkCount !== 1 || chunkLength !== 13) invalidImage();
      sawHeader = true;
      width = readUint32BE(bytes, dataStart);
      height = readUint32BE(bytes, dataStart + 4);
      bitDepth = bytes[dataStart + 8] ?? 0;
      colorType = bytes[dataStart + 9] ?? -1;
      interlace = bytes[dataStart + 12] ?? -1;
      if (
        !validDimensions(width, height) ||
        !validPngBitDepth(bitDepth, colorType) ||
        bytes[dataStart + 10] !== 0 ||
        bytes[dataStart + 11] !== 0 ||
        ![0, 1].includes(interlace)
      ) {
        invalidImage();
      }
      retain = true;
    } else {
      if (!sawHeader) invalidImage();
      if (chunkType === "PLTE") {
        if (
          sawPalette ||
          sawImageData ||
          colorType === 0 ||
          colorType === 4 ||
          chunkLength < 3 ||
          chunkLength > 768 ||
          chunkLength % 3 !== 0
        ) {
          invalidImage();
        }
        paletteEntries = chunkLength / 3;
        if (colorType === 3 && paletteEntries > 2 ** bitDepth) invalidImage();
        sawPalette = true;
        retain = true;
      } else if (chunkType === "tRNS") {
        if (sawTransparency || sawImageData) invalidImage();
        const validLength =
          (colorType === 0 && chunkLength === 2) ||
          (colorType === 2 && chunkLength === 6) ||
          (colorType === 3 && sawPalette && chunkLength >= 1 && chunkLength <= paletteEntries);
        if (!validLength) invalidImage();
        sawTransparency = true;
        retain = true;
      } else if (chunkType === "IDAT") {
        if (imageDataEnded || (colorType === 3 && !sawPalette)) invalidImage();
        sawImageData = true;
        imageDataBytes += chunkLength;
        retain = true;
      } else if (chunkType === "IEND") {
        if (
          !sawImageData ||
          imageDataBytes < 1 ||
          sawEnd ||
          chunkLength !== 0 ||
          nextOffset !== bytes.length
        ) {
          invalidImage();
        }
        sawEnd = true;
        retain = true;
      } else {
        if (sawImageData) imageDataEnded = true;
        if (PNG_ANIMATION_CHUNKS.has(chunkType)) animated = true;
        if (chunkType.charCodeAt(0) >= 65 && chunkType.charCodeAt(0) <= 90) invalidImage();
        strippedMetadata = true;
      }
    }

    if (retain) retainedRanges.push([offset, nextOffset]);
    offset = nextOffset;
    if (sawEnd) break;
  }

  if (!sawHeader || !sawImageData || !sawEnd || (colorType === 3 && !sawPalette)) invalidImage();
  const channels = colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 1;
  const rowBytes = Math.ceil((width * channels * bitDepth) / 8);
  const rawBytes = (rowBytes + 1 + interlace) * height;
  return {
    image: {
      format: "png",
      mime: "image/png",
      width,
      height,
      animated,
      pngRawBytes: Number.isSafeInteger(rawBytes) ? rawBytes : Number.MAX_SAFE_INTEGER,
    },
    retainedRanges,
    strippedMetadata,
  };
}

function inspectPng(bytes: Uint8Array): InspectedImageFile {
  return inspectPngStructure(bytes).image;
}

export function stripPngMetadata(buffer: ArrayBuffer): ArrayBuffer {
  const bytes = new Uint8Array(buffer);
  const structure = inspectPngStructure(bytes);
  if (structure.image.animated) invalidImage();
  if (!structure.strippedMetadata) return buffer;

  const byteLength = structure.retainedRanges.reduce(
    (total, [start, end]) => total + end - start,
    0,
  );
  const stripped = new Uint8Array(byteLength);
  let outputOffset = 0;
  for (const [start, end] of structure.retainedRanges) {
    const part = bytes.subarray(start, end);
    stripped.set(part, outputOffset);
    outputOffset += part.byteLength;
  }
  return stripped.buffer;
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

interface IsoBox {
  type: string;
  payloadStart: number;
  end: number;
}

interface IsoBoxBudget {
  remaining: number;
}

const MAX_ISO_BOXES = 4096;
const MAX_HEIC_BRANDS = 64;
const HEIC_STILL_BRANDS = new Set(["heic", "heix", "heim", "heis"]);
const HEIC_SEQUENCE_BRANDS = new Set(["hevc", "hevx", "hevm", "hevs"]);
const HEIF_SEQUENCE_BRANDS = new Set(["msf1"]);

function visitIsoBoxes(
  bytes: Uint8Array,
  start: number,
  end: number,
  budget: IsoBoxBudget,
  visit: (box: IsoBox) => void,
): void {
  let offset = start;

  while (offset < end) {
    if (budget.remaining <= 0 || offset + 8 > end) invalidImage();
    budget.remaining -= 1;
    let size = readUint32BE(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    let headerSize = 8;

    if (size === 1) {
      if (offset + 16 > end) invalidImage();
      const high = readUint32BE(bytes, offset + 8);
      const low = readUint32BE(bytes, offset + 12);
      if (high > 0x1fffff) invalidImage();
      size = high * 0x100000000 + low;
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }

    const boxEnd = offset + size;
    if (size < headerSize || !Number.isSafeInteger(boxEnd) || boxEnd > end) invalidImage();
    visit({ type, payloadStart: offset + headerSize, end: boxEnd });
    offset = boxEnd;
  }
}

function inspectHeic(bytes: Uint8Array): InspectedImageFile {
  const budget: IsoBoxBudget = { remaining: MAX_ISO_BOXES };
  let foundFileType = false;
  let hasHeicCodecBrand = false;
  let hasSequenceBrand = false;
  let bestWidth = 0;
  let bestHeight = 0;
  let bestArea = 0;

  const inspectFileType = (box: IsoBox): void => {
    if (foundFileType) invalidImage();
    foundFileType = true;
    const brandBytes = box.end - box.payloadStart;
    if (brandBytes < 8 || (brandBytes - 8) % 4 !== 0) invalidImage();
    const brandCount = 1 + (brandBytes - 8) / 4;
    if (brandCount > MAX_HEIC_BRANDS) invalidImage();

    const inspectBrand = (brand: string): void => {
      hasHeicCodecBrand ||= HEIC_STILL_BRANDS.has(brand) || HEIC_SEQUENCE_BRANDS.has(brand);
      hasSequenceBrand ||= HEIC_SEQUENCE_BRANDS.has(brand) || HEIF_SEQUENCE_BRANDS.has(brand);
    };

    inspectBrand(ascii(bytes, box.payloadStart, 4));
    for (let offset = box.payloadStart + 8; offset + 4 <= box.end; offset += 4) {
      inspectBrand(ascii(bytes, offset, 4));
    }
  };

  const inspectProperty = (box: IsoBox, depth: number): void => {
    if (depth > 6) invalidImage();
    if (box.type === "ispe") {
      if (box.end - box.payloadStart < 12) invalidImage();
      const width = readUint32BE(bytes, box.payloadStart + 4);
      const height = readUint32BE(bytes, box.payloadStart + 8);
      if (!validDimensions(width, height)) invalidImage();
      const area = width * height;
      if (area > bestArea) {
        bestWidth = width;
        bestHeight = height;
        bestArea = area;
      }
      return;
    }

    let childStart: number | undefined;
    if (box.type === "meta") {
      if (box.payloadStart + 4 > box.end) invalidImage();
      childStart = box.payloadStart + 4;
    } else if (box.type === "iprp" || box.type === "ipco") {
      childStart = box.payloadStart;
    }

    if (childStart !== undefined) {
      visitIsoBoxes(bytes, childStart, box.end, budget, (child) =>
        inspectProperty(child, depth + 1),
      );
    }
  };

  visitIsoBoxes(bytes, 0, bytes.length, budget, (box) => {
    if (box.type === "ftyp") inspectFileType(box);
    inspectProperty(box, 0);
  });

  if (!foundFileType || !hasHeicCodecBrand || !validDimensions(bestWidth, bestHeight)) {
    invalidImage();
  }

  return {
    format: "heic",
    mime: "image/heic",
    width: bestWidth,
    height: bestHeight,
    animated: hasSequenceBrand,
  };
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

  if (bytes.length >= 24 && ascii(bytes, 4, 4) === "ftyp") {
    return inspectHeic(bytes);
  }
  return invalidImage();
}
