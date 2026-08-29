import { describe, expect, it } from "vitest";
import {
  inspectImageHeader,
  readJpegExifOrientation,
  stripJpegMetadata,
  stripPngMetadata,
} from "./file-format";

function writeUint32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function pngWithChunks(chunks: readonly { type: string; data: Uint8Array }[]): ArrayBuffer {
  const total = 8 + chunks.reduce((size, chunk) => size + 12 + chunk.data.length, 0);
  const bytes = new Uint8Array(total);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let offset = 8;
  for (const chunk of chunks) {
    writeUint32BE(bytes, offset, chunk.data.length);
    bytes.set(new TextEncoder().encode(chunk.type), offset + 4);
    bytes.set(chunk.data, offset + 8);
    offset += 12 + chunk.data.length;
  }
  return bytes.buffer;
}

function pngHeader(width: number, height: number): Uint8Array {
  const header = new Uint8Array(13);
  writeUint32BE(header, 0, width);
  writeUint32BE(header, 4, height);
  header[8] = 8;
  header[9] = 6;
  return header;
}

function joinBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function gifWithFrames(width: number, height: number, frameCount: number): ArrayBuffer {
  const header = Uint8Array.from([
    0x47,
    0x49,
    0x46,
    0x38,
    0x39,
    0x61,
    width & 0xff,
    (width >>> 8) & 0xff,
    height & 0xff,
    (height >>> 8) & 0xff,
    0x80,
    0,
    0,
    0xff,
    0,
    0,
    0,
    0xff,
    0,
  ]);
  const frame = Uint8Array.from([
    0x21,
    0xf9,
    0x04,
    0x00,
    0x0a,
    0x00,
    0x00,
    0x00,
    0x2c,
    0,
    0,
    0,
    0,
    width & 0xff,
    (width >>> 8) & 0xff,
    height & 0xff,
    (height >>> 8) & 0xff,
    0x00,
    0x02,
    0x02,
    0x44,
    0x05,
    0x00,
  ]);
  return joinBytes(header, ...Array.from({ length: frameCount }, () => frame), Uint8Array.of(0x3b))
    .buffer as ArrayBuffer;
}

function isoBox(type: string, data: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(8 + data.byteLength);
  writeUint32BE(bytes, 0, bytes.byteLength);
  bytes.set(new TextEncoder().encode(type), 4);
  bytes.set(data, 8);
  return bytes;
}

function heicHeader(
  width: number,
  height: number,
  majorBrand = "heic",
  compatibleBrands: readonly string[] = ["mif1", "heic"],
): ArrayBuffer {
  const brandBytes = new Uint8Array(8 + compatibleBrands.length * 4);
  brandBytes.set(new TextEncoder().encode(majorBrand), 0);
  compatibleBrands.forEach((brand, index) => {
    brandBytes.set(new TextEncoder().encode(brand), 8 + index * 4);
  });

  const ispe = new Uint8Array(12);
  writeUint32BE(ispe, 4, width);
  writeUint32BE(ispe, 8, height);
  const properties = isoBox("ipco", isoBox("ispe", ispe));
  const itemProperties = isoBox("iprp", properties);
  const meta = isoBox("meta", joinBytes(new Uint8Array(4), itemProperties));
  return joinBytes(isoBox("ftyp", brandBytes), meta).buffer as ArrayBuffer;
}

function jpegWithExifOrientation(orientation: number, littleEndian = false): ArrayBuffer {
  const payload = new Uint8Array(32);
  payload.set([0x45, 0x78, 0x69, 0x66, 0, 0]);
  const tiff = 6;
  if (littleEndian) {
    payload.set([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0], tiff);
    payload.set([0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0], tiff + 10);
  } else {
    payload.set([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1], tiff);
    payload.set([0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0], tiff + 10);
  }
  const bytes = new Uint8Array(2 + 2 + 2 + payload.byteLength + 2);
  bytes.set([0xff, 0xd8, 0xff, 0xe1, 0, payload.byteLength + 2]);
  bytes.set(payload, 6);
  bytes.set([0xff, 0xd9], bytes.byteLength - 2);
  return bytes.buffer;
}

function jpegSegment(marker: number, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(payload.byteLength + 4);
  bytes.set([
    0xff,
    marker,
    ((payload.byteLength + 2) >>> 8) & 0xff,
    (payload.byteLength + 2) & 0xff,
  ]);
  bytes.set(payload, 4);
  return bytes;
}

function validIccProfile(): Uint8Array {
  const profile = new Uint8Array(164);
  writeUint32BE(profile, 0, profile.byteLength);
  profile.set(new TextEncoder().encode("mntr"), 12);
  profile.set(new TextEncoder().encode("RGB "), 16);
  profile.set(new TextEncoder().encode("XYZ "), 20);
  profile.set(new TextEncoder().encode("acsp"), 36);
  writeUint32BE(profile, 128, 1);
  profile.set(new TextEncoder().encode("wtpt"), 132);
  writeUint32BE(profile, 136, 144);
  writeUint32BE(profile, 140, 20);
  profile.set(new TextEncoder().encode("XYZ "), 144);
  writeUint32BE(profile, 152, 0x0000_f6d6);
  writeUint32BE(profile, 156, 0x0001_0000);
  writeUint32BE(profile, 160, 0x0000_d32d);
  return profile;
}

function iccSegments(profile: Uint8Array, chunkCount = 2): Uint8Array[] {
  const segments: Uint8Array[] = [];
  for (let sequence = 1; sequence <= chunkCount; sequence += 1) {
    const start = Math.floor(((sequence - 1) * profile.byteLength) / chunkCount);
    const end = Math.floor((sequence * profile.byteLength) / chunkCount);
    const payload = joinBytes(
      new TextEncoder().encode("ICC_PROFILE\0"),
      Uint8Array.from([sequence, chunkCount]),
      profile.subarray(start, end),
    );
    segments.push(jpegSegment(0xe2, payload));
  }
  return segments;
}

function jpegWithSegments(
  beforeScan: readonly Uint8Array[],
  afterScan: readonly Uint8Array[] = [],
): ArrayBuffer {
  const frame = jpegSegment(
    0xc0,
    Uint8Array.from([8, 0, 10, 0, 20, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]),
  );
  const scan = jpegSegment(0xda, Uint8Array.from([3, 1, 0, 2, 0, 3, 0, 0, 0x3f, 0]));
  return joinBytes(
    Uint8Array.from([0xff, 0xd8]),
    ...beforeScan,
    frame,
    scan,
    Uint8Array.from([1, 2, 0xff, 0, 3]),
    ...afterScan,
    Uint8Array.from([0xff, 0xd9]),
  ).buffer as ArrayBuffer;
}

function jpegWithPrivateMetadata(): ArrayBuffer {
  const app0 = jpegSegment(0xe0, joinBytes(new TextEncoder().encode("JFIF\0"), new Uint8Array(9)));
  const app1 = jpegSegment(
    0xe1,
    joinBytes(new TextEncoder().encode("Exif\0\0GPS_PRIVATE_SENTINEL"), new Uint8Array(8)),
  );
  const privateApp = jpegSegment(0xec, new TextEncoder().encode("PRIVATE_APP_DATA"));
  const comment = jpegSegment(0xfe, new TextEncoder().encode("PRIVATE_COMMENT"));
  const postScanMetadata = jpegSegment(0xed, new TextEncoder().encode("PRIVATE_IPTC"));
  return jpegWithSegments(
    [app0, app1, ...iccSegments(validIccProfile()), privateApp, comment],
    [postScanMetadata],
  );
}

describe("inspectImageHeader", () => {
  it("reads JPEG dimensions from a start-of-frame segment", () => {
    const bytes = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x00, 0x04, 0x00, 0x03, 0x01, 0x01, 0x11,
      0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9,
    ]);
    expect(inspectImageHeader(bytes.buffer)).toMatchObject({
      format: "jpeg",
      width: 1024,
      height: 768,
      animated: false,
    });
  });

  it("finds a real APNG animation chunk beyond the first 512 bytes", () => {
    const result = inspectImageHeader(
      pngWithChunks([
        { type: "IHDR", data: pngHeader(320, 240) },
        { type: "tEXt", data: new Uint8Array(600) },
        { type: "acTL", data: new Uint8Array(8) },
        { type: "IDAT", data: new Uint8Array(1) },
        { type: "IEND", data: new Uint8Array() },
      ]),
    );
    expect(result).toMatchObject({ format: "png", width: 320, height: 240, animated: true });
  });

  it("does not mistake chunk payload text for an animation chunk", () => {
    const payload = new TextEncoder().encode("ordinary acTL text");
    const result = inspectImageHeader(
      pngWithChunks([
        { type: "IHDR", data: pngHeader(10, 20) },
        { type: "tEXt", data: payload },
        { type: "IDAT", data: new Uint8Array(1) },
        { type: "IEND", data: new Uint8Array() },
      ]),
    );
    expect(result.animated).toBe(false);
  });

  it("rejects a file with a false extension and unknown signature", () => {
    const bytes = new TextEncoder().encode("not an image");
    expect(() => inspectImageHeader(bytes.buffer)).toThrow("지원하지 않거나 손상된 이미지");
  });
  it("reads HEIC dimensions from ISO BMFF properties", () => {
    expect(inspectImageHeader(heicHeader(451, 461))).toEqual({
      format: "heic",
      mime: "image/heic",
      width: 451,
      height: 461,
      animated: false,
    });
  });

  it("does not mistake an AVIF brand for HEIC", () => {
    expect(() => inspectImageHeader(heicHeader(100, 100, "avif", ["mif1", "avif"]))).toThrow();
  });
  it("marks the generic HEIF sequence brand as animated", () => {
    const result = inspectImageHeader(heicHeader(100, 100, "heic", ["mif1", "heic", "msf1"]));
    expect(result.animated).toBe(true);
  });

  it("still rejects AVIF sequences that use the generic sequence brand", () => {
    expect(() =>
      inspectImageHeader(heicHeader(100, 100, "avis", ["mif1", "avis", "msf1"])),
    ).toThrow();
  });

  it("caps compatible brands before they can amplify memory", () => {
    const brands = Array.from({ length: 65 }, () => "heic");
    expect(() => inspectImageHeader(heicHeader(100, 100, "heic", brands))).toThrow();
  });

  it("caps ISO box traversal before it can amplify memory", () => {
    const emptyBox = isoBox("free", new Uint8Array());
    const boxes = Array.from({ length: 4097 }, () => emptyBox);
    const bytes = joinBytes(new Uint8Array(heicHeader(100, 100)), ...boxes);
    expect(() => inspectImageHeader(bytes.buffer as ArrayBuffer)).toThrow();
  });

  it("rejects a duplicate IHDR even when it appears after image data", () => {
    const bytes = pngWithChunks([
      { type: "IHDR", data: pngHeader(1, 1) },
      { type: "IDAT", data: new Uint8Array(1) },
      { type: "IHDR", data: pngHeader(16_384, 16_384) },
      { type: "IEND", data: new Uint8Array() },
    ]);
    expect(() => inspectImageHeader(bytes)).toThrow();
  });

  it("estimates the raw scanline buffer for a high-depth PNG", () => {
    const header = pngHeader(3_000, 3_000);
    header[8] = 16;
    const result = inspectImageHeader(
      pngWithChunks([
        { type: "IHDR", data: header },
        { type: "IDAT", data: new Uint8Array(1) },
        { type: "IEND", data: new Uint8Array() },
      ]),
    );
    expect(result.pngRawBytes).toBe(72_003_000);
  });

  it("finds APNG control chunks after IDAT", () => {
    const result = inspectImageHeader(
      pngWithChunks([
        { type: "IHDR", data: pngHeader(1, 1) },
        { type: "IDAT", data: new Uint8Array(1) },
        { type: "fcTL", data: new Uint8Array(26) },
        { type: "IEND", data: new Uint8Array() },
      ]),
    );
    expect(result.animated).toBe(true);
  });

  it.each([
    ["a single-frame GIF", 1, false],
    ["an animated GIF", 2, true],
  ])("reads dimensions and animation state from %s", (_label, frameCount, animated) => {
    expect(inspectImageHeader(gifWithFrames(320, 240, frameCount))).toEqual({
      format: "gif",
      mime: "image/gif",
      width: 320,
      height: 240,
      animated,
    });
  });

  it("rejects a truncated GIF block", () => {
    const bytes = new Uint8Array(gifWithFrames(2, 1, 1));
    expect(() => inspectImageHeader(bytes.slice(0, -2).buffer)).toThrow(
      "지원하지 않거나 손상된 이미지",
    );
  });

  it("accepts GIF extensions with multiple data sub-blocks", () => {
    const source = new Uint8Array(gifWithFrames(2, 1, 1));
    const comment = Uint8Array.of(0x21, 0xfe, 3, 0x61, 0x62, 0x63, 2, 0x64, 0x65, 0);
    const bytes = joinBytes(source.slice(0, 19), comment, source.slice(19));
    expect(inspectImageHeader(bytes.buffer as ArrayBuffer)).toMatchObject({
      format: "gif",
      mime: "image/gif",
      width: 2,
      height: 1,
      animated: false,
    });
  });
});

describe("readJpegExifOrientation", () => {
  it("reads big-endian and little-endian TIFF orientation values", () => {
    expect(readJpegExifOrientation(jpegWithExifOrientation(6))).toBe(6);
    expect(readJpegExifOrientation(jpegWithExifOrientation(8, true))).toBe(8);
  });

  it("falls back safely for malformed or unsupported EXIF values", () => {
    expect(readJpegExifOrientation(jpegWithExifOrientation(9))).toBe(1);
    const malformed = new Uint8Array(jpegWithExifOrientation(6));
    malformed.set([0xff, 0xff, 0xff, 0xff], 16);
    expect(readJpegExifOrientation(malformed.buffer)).toBe(1);
    expect(readJpegExifOrientation(new Uint8Array([1, 2, 3]).buffer)).toBe(1);
  });
});

describe("lossless image metadata stripping", () => {
  it("removes PNG text chunks while retaining pixel chunks", () => {
    const source = pngWithChunks([
      { type: "IHDR", data: pngHeader(1, 1) },
      { type: "tEXt", data: new TextEncoder().encode("GPS_PRIVATE_SENTINEL") },
      { type: "IDAT", data: new Uint8Array([1, 2, 3]) },
      { type: "IEND", data: new Uint8Array() },
    ]);
    const stripped = stripPngMetadata(source);
    expect(new TextDecoder().decode(stripped)).not.toContain("GPS_PRIVATE_SENTINEL");
    expect(inspectImageHeader(stripped)).toMatchObject({ format: "png", width: 1, height: 1 });
  });

  it("removes JPEG private metadata while retaining JFIF and a valid ICC profile", () => {
    const stripped = stripJpegMetadata(jpegWithPrivateMetadata());
    const text = new TextDecoder().decode(stripped);
    expect(text).toContain("JFIF");
    expect(text).toContain("ICC_PROFILE\0");
    expect(text).toContain("acsp");
    expect(text).not.toContain("GPS_PRIVATE_SENTINEL");
    expect(text).not.toContain("PRIVATE_COMMENT");
    expect(text).not.toContain("PRIVATE_IPTC");
    expect(text).not.toContain("PRIVATE_APP_DATA");
    expect(inspectImageHeader(stripped)).toMatchObject({ format: "jpeg", width: 20, height: 10 });
  });

  it("strips an APP2 payload that only pretends to be an ICC profile", () => {
    const fakeProfile = jpegSegment(
      0xe2,
      joinBytes(
        new TextEncoder().encode("ICC_PROFILE\0"),
        Uint8Array.from([1, 1]),
        new TextEncoder().encode("GPS_PRIVATE_SENTINEL"),
      ),
    );
    const stripped = stripJpegMetadata(jpegWithSegments([fakeProfile]));
    expect(new TextDecoder().decode(stripped)).not.toContain("GPS_PRIVATE_SENTINEL");
  });

  it("rejects a JPEG whose scan is not terminated by an EOI marker", () => {
    const source = new Uint8Array(jpegWithPrivateMetadata());
    const truncated = source.slice(0, -2);
    expect(() => stripJpegMetadata(truncated.buffer)).toThrow("지원하지 않거나 손상된 이미지");
  });

  it("normalizes marker fill bytes for strict downstream JPEG decoders", () => {
    const frame = jpegSegment(
      0xc0,
      Uint8Array.from([8, 0, 10, 0, 20, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]),
    );
    const scan = jpegSegment(0xda, Uint8Array.from([3, 1, 0, 2, 0, 3, 0, 0, 0x3f, 0]));
    const source = joinBytes(
      Uint8Array.from([0xff, 0xd8, 0xff]),
      frame,
      scan,
      Uint8Array.from([1, 2, 3, 0xff, 0xd9]),
    );

    const stripped = new Uint8Array(stripJpegMetadata(source.buffer as ArrayBuffer));
    expect(stripped.slice(0, 4)).toEqual(Uint8Array.from([0xff, 0xd8, 0xff, 0xc0]));
    expect(stripped.byteLength).toBe(source.byteLength - 1);
    expect(inspectImageHeader(stripped.buffer)).toMatchObject({
      format: "jpeg",
      width: 20,
      height: 10,
    });
  });

  it("caps JPEG markers before retained subarray views can amplify memory", () => {
    const markers = Array.from({ length: 4_096 }, () => Uint8Array.from([0xff, 0x01]));
    expect(() => stripJpegMetadata(jpegWithSegments(markers))).toThrow(
      "지원하지 않거나 손상된 이미지",
    );
  });
});
