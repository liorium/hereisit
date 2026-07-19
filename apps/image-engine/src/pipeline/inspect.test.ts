import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { assessResourceBounds, inspectImage, type StructuralMetadata } from "./inspect";

const roots: string[] = [];
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "hereisit-inspect-"));
  roots.push(path);
  return path;
}
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function segment(marker: number, body: Uint8Array): Buffer {
  const length = body.byteLength + 2;
  return Buffer.concat([
    Buffer.from([0xff, marker, length >> 8, length & 0xff]),
    Buffer.from(body),
  ]);
}

function pngChunk(type: string, body: Uint8Array): Buffer {
  const payload = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(body)]);
  const result = Buffer.alloc(12 + body.byteLength);
  result.writeUInt32BE(body.byteLength, 0);
  payload.copy(result, 4);
  result.writeUInt32BE(crc32(payload), 8 + body.byteLength);
  return result;
}

function fixed(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32BE(Math.round(value * 65_536));
  return bytes;
}

function matrixIcc(wideGamut = false): Buffer {
  const xyz = (values: readonly [number, number, number]) =>
    Buffer.concat([Buffer.from("XYZ \0\0\0\0", "binary"), ...values.map(fixed)]);
  const curve = Buffer.alloc(14);
  curve.write("curv", 0, "ascii");
  curve.writeUInt32BE(1, 8);
  curve.writeUInt16BE(Math.round(2.2 * 256), 12);
  const entries = [
    ["rXYZ", xyz(wideGamut ? [0.6, 0.2, 0.01] : [0.4361, 0.2225, 0.0139])],
    ["gXYZ", xyz([0.3851, 0.7169, 0.0971])],
    ["bXYZ", xyz([0.1431, 0.0606, 0.7142])],
    ["rTRC", curve],
    ["gTRC", curve],
    ["bTRC", curve],
  ] as const;
  const table = Buffer.alloc(4 + entries.length * 12);
  table.writeUInt32BE(entries.length, 0);
  const payloads: Buffer[] = [];
  let offset = 128 + table.byteLength;
  entries.forEach(([name, value], index) => {
    table.write(name, 4 + index * 12, "ascii");
    table.writeUInt32BE(offset, 8 + index * 12);
    table.writeUInt32BE(value.byteLength, 12 + index * 12);
    const padding = Buffer.alloc((4 - (value.byteLength % 4)) % 4);
    payloads.push(value, padding);
    offset += value.byteLength + padding.byteLength;
  });
  const profile = Buffer.concat([Buffer.alloc(128), table, ...payloads]);
  profile.writeUInt32BE(profile.byteLength, 0);
  profile.write("RGB ", 16, "ascii");
  profile.write("acsp", 36, "ascii");
  return profile;
}

function jpegWithIcc(jpeg: Buffer, profile: Buffer): Buffer {
  const body = Buffer.concat([
    Buffer.from("ICC_PROFILE\0", "binary"),
    Buffer.from([1, 1]),
    profile,
  ]);
  return Buffer.concat([jpeg.subarray(0, 2), segment(0xe2, body), jpeg.subarray(2)]);
}

function minimalJpeg(input: {
  components: readonly number[];
  adobe?: 0 | 1 | 2;
  jfif?: boolean;
  width?: number;
  height?: number;
}): Buffer {
  const width = input.width ?? 16;
  const height = input.height ?? 8;
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (input.jfif)
    parts.push(segment(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "binary")));
  if (input.adobe !== undefined) {
    parts.push(
      segment(0xee, Buffer.from([65, 100, 111, 98, 101, 0, 100, 0, 0, 0, 0, input.adobe])),
    );
  }
  const sof = Buffer.alloc(6 + input.components.length * 3);
  sof[0] = 8;
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof[5] = input.components.length;
  input.components.forEach((id, index) => {
    sof[6 + index * 3] = id;
    sof[7 + index * 3] = index === 0 ? 0x22 : 0x11;
    sof[8 + index * 3] = 0;
  });
  parts.push(segment(0xc0, sof), Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

const metadata = (overrides: Partial<StructuralMetadata> = {}): StructuralMetadata => ({
  width: 16,
  height: 8,
  format: "jpeg",
  bitDepth: 8,
  hasAlpha: false,
  pages: 1,
  orientation: 1,
  ...overrides,
});

describe("inspectImage", () => {
  it("trusts file magic over the declared MIME", async () => {
    const directory = await root();
    const path = join(directory, "opaque.bin");
    await sharp({
      create: { width: 2, height: 3, channels: 3, background: "#123456" },
    })
      .png()
      .toFile(path);
    await expect(inspectImage(path, "image/jpeg")).resolves.toMatchObject({
      format: "png",
      mime: "image/png",
      width: 2,
      height: 3,
    });
  });

  it("accepts a static extended WebP and verifies its alpha flag", async () => {
    const directory = await root();
    const path = join(directory, "static-webp");
    await sharp({
      create: { width: 3, height: 2, channels: 4, background: "#12345680" },
    })
      .withMetadata({ orientation: 6 })
      .webp({ lossless: true })
      .toFile(path);
    await expect(inspectImage(path, "image/webp")).resolves.toMatchObject({
      format: "webp",
      width: 3,
      height: 2,
      hasAlpha: true,
      animated: false,
    });
  });

  it("rejects invalid WebP extended-header flags before decode", async () => {
    const directory = await root();
    const valid = await sharp({
      create: { width: 3, height: 2, channels: 4, background: "#12345680" },
    })
      .withMetadata({ orientation: 6 })
      .webp({ lossless: true })
      .toBuffer();
    expect(valid.subarray(12, 16).toString("ascii")).toBe("VP8X");

    const reservedFlag = Buffer.from(valid);
    reservedFlag[20] = (reservedFlag[20] ?? 0) | 0x80;
    const missingAlphaFlag = Buffer.from(valid);
    missingAlphaFlag[20] = (missingAlphaFlag[20] ?? 0) & ~0x10;
    const reservedPath = join(directory, "reserved-flag");
    const missingAlphaPath = join(directory, "missing-alpha-flag");
    await Promise.all([
      writeFile(reservedPath, reservedFlag),
      writeFile(missingAlphaPath, missingAlphaFlag),
    ]);

    await expect(inspectImage(reservedPath, "image/webp")).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
    });
    await expect(inspectImage(missingAlphaPath, "image/webp")).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
    });
  });

  it.each([
    ["gray", minimalJpeg({ components: [1] }), "gray"],
    ["JFIF YCbCr", minimalJpeg({ components: [1, 2, 3], jfif: true }), "ycbcr"],
    ["Adobe RGB", minimalJpeg({ components: [82, 71, 66], adobe: 0 }), "rgb"],
    ["Adobe CMYK", minimalJpeg({ components: [67, 77, 89, 75], adobe: 0 }), "cmyk"],
    ["Adobe YCCK", minimalJpeg({ components: [1, 2, 3, 4], adobe: 2 }), "ycck"],
    ["ambiguous", minimalJpeg({ components: [7, 8, 9] }), "unknown"],
  ])("classifies %s structurally before decode", async (_name, bytes, expected) => {
    const directory = await root();
    const path = join(directory, "input");
    await writeFile(path, bytes);
    await expect(
      inspectImage(path, "image/jpeg", { readMetadata: async () => metadata() }),
    ).resolves.toMatchObject({ sourceColorModel: expected });
  });

  it("rejects conflicting JPEG markers instead of guessing a color model", async () => {
    const directory = await root();
    const path = join(directory, "input");
    await writeFile(path, minimalJpeg({ components: [82, 71, 66], adobe: 0, jfif: true }));
    await expect(
      inspectImage(path, "image/jpeg", { readMetadata: async () => metadata() }),
    ).resolves.toMatchObject({ sourceColorModel: "unknown" });
  });

  it("validates ICC structure and distinguishes matrix sRGB from wide-gamut RGB", async () => {
    const directory = await root();
    const source = minimalJpeg({ components: [1, 2, 3], jfif: true });
    const srgbPath = join(directory, "srgb");
    const widePath = join(directory, "wide");
    const malformedPath = join(directory, "malformed");
    await writeFile(srgbPath, jpegWithIcc(source, matrixIcc()));
    await writeFile(widePath, jpegWithIcc(source, matrixIcc(true)));
    const malformed = matrixIcc();
    malformed.writeUInt32BE(malformed.byteLength - 1, 0);
    await writeFile(malformedPath, jpegWithIcc(source, malformed));
    await expect(
      inspectImage(srgbPath, "image/jpeg", { readMetadata: async () => metadata() }),
    ).resolves.toMatchObject({ iccProfileKind: "srgb-compatible", wideGamut: false });
    await expect(
      inspectImage(widePath, "image/jpeg", { readMetadata: async () => metadata() }),
    ).resolves.toMatchObject({ iccProfileKind: "other", wideGamut: true });
    await expect(
      inspectImage(malformedPath, "image/jpeg", { readMetadata: async () => metadata() }),
    ).resolves.toMatchObject({ iccProfileKind: "other", wideGamut: true });
  });

  it("rejects truncated structures and animated formats", async () => {
    const directory = await root();
    const truncated = join(directory, "truncated");
    await writeFile(truncated, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 20, 1]));
    await expect(inspectImage(truncated, "image/jpeg")).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
    });

    const animated = join(directory, "animated");
    const vp8x = Buffer.from([0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const chunk = Buffer.concat([Buffer.from("VP8X"), Buffer.from([10, 0, 0, 0]), vp8x]);
    const riff = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), chunk]);
    riff.writeUInt32LE(riff.length - 8, 4);
    await writeFile(animated, riff);
    await expect(inspectImage(animated, "image/webp")).rejects.toMatchObject({
      code: "UNSUPPORTED_FEATURE",
    });
  });

  it("rejects APNG before decode", async () => {
    const directory = await root();
    const base = await sharp({
      create: { width: 2, height: 2, channels: 4, background: "#abcdef80" },
    })
      .png()
      .toBuffer();
    const path = join(directory, "animated-png");
    const animationControl = Buffer.alloc(8);
    animationControl.writeUInt32BE(2, 0);
    animationControl.writeUInt32BE(0, 4);
    await writeFile(
      path,
      Buffer.concat([
        base.subarray(0, -12),
        pngChunk("acTL", animationControl),
        base.subarray(-12),
      ]),
    );
    await expect(inspectImage(path, "image/png")).rejects.toMatchObject({
      code: "UNSUPPORTED_FEATURE",
    });
  });

  it("rejects pixel, metadata, and decompression-bomb limits", async () => {
    const directory = await root();
    const oversized = join(directory, "oversized");
    await writeFile(
      oversized,
      minimalJpeg({ components: [1, 2, 3], jfif: true, width: 32_768, height: 1_221 }),
    );
    await expect(
      inspectImage(oversized, "image/jpeg", {
        readMetadata: async () => metadata({ width: 32_768, height: 1_221 }),
      }),
    ).rejects.toMatchObject({ code: "PIXEL_LIMIT_EXCEEDED" });

    const metadataHeavy = join(directory, "metadata-heavy");
    const jpeg = minimalJpeg({ components: [1], width: 1, height: 1 });
    const metadataSegments = Array.from({ length: 65 }, () => segment(0xe1, Buffer.alloc(65_533)));
    await writeFile(
      metadataHeavy,
      Buffer.concat([jpeg.subarray(0, 2), ...metadataSegments, jpeg.subarray(2)]),
    );
    await expect(inspectImage(metadataHeavy, "image/jpeg")).rejects.toMatchObject({
      code: "INPUT_LIMIT_EXCEEDED",
    });

    expect(() =>
      assessResourceBounds({
        inspection: { width: 10_000, height: 10_000, hasAlpha: true, bitDepth: 8 },
        encodedBytes: 1,
        resourceClass: "image-standard-v1",
      }),
    ).toThrowError(expect.objectContaining({ code: "INPUT_LIMIT_EXCEEDED" }));
  });

  it("makes the resource upgrade decision before opening Sharp", async () => {
    let opened = false;
    const decision = assessResourceBounds({
      inspection: {
        width: 10_000,
        height: 4_000,
        hasAlpha: true,
        bitDepth: 16,
      },
      encodedBytes: 30 * 1024 * 1024,
      resourceClass: "image-standard-v1",
    });
    expect(decision.code).toBe("RESOURCE_CLASS_UPGRADE");

    const directory = await root();
    const path = join(directory, "large");
    const header = Buffer.alloc(13);
    header.writeUInt32BE(10_000, 0);
    header.writeUInt32BE(4_000, 4);
    header[8] = 16;
    header[9] = 6;
    await writeFile(
      path,
      Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk("IHDR", header),
        pngChunk("IDAT", Buffer.alloc(0)),
        pngChunk("IEND", Buffer.alloc(0)),
      ]),
    );
    await expect(
      inspectImage(path, "image/png", {
        resourceClass: "image-standard-v1",
        readMetadata: async () => {
          opened = true;
          return metadata({
            width: 10_000,
            height: 4_000,
            format: "png",
            bitDepth: 16,
            hasAlpha: true,
          });
        },
        encodedBytesOverride: 1024 * 1024,
      }),
    ).rejects.toMatchObject({
      code: "RESOURCE_CLASS_UPGRADE",
      retryable: true,
      inspection: { width: 10_000, height: 4_000, bitDepth: 16, hasAlpha: true },
    });
    expect(opened).toBe(false);
  });

  it("uses strict exact boundaries for the immutable resource profiles", () => {
    const threshold = Math.floor(1024 ** 3 * 0.75);
    const encodedBytes = 1024 * 1024;
    const decodedAtBoundary = Math.floor((threshold - encodedBytes * 2) / 3);
    const below = assessResourceBounds({
      inspection: { width: threshold - 2, height: 1, hasAlpha: false, bitDepth: 8 },
      encodedBytes,
      resourceClass: "image-standard-v1",
      decodedBytesOverride: decodedAtBoundary,
    });
    expect(below.code).toBe(null);
    const above = assessResourceBounds({
      inspection: { width: 1, height: 1, hasAlpha: false, bitDepth: 8 },
      encodedBytes,
      resourceClass: "image-standard-v1",
      decodedBytesOverride: decodedAtBoundary + 1,
    });
    expect(above.code).toBe("RESOURCE_CLASS_UPGRADE");

    const largeThreshold = Math.floor(2 * 1024 ** 3 * 0.75);
    const largeDecoded = Math.floor((largeThreshold - encodedBytes * 2) / 3);
    expect(
      assessResourceBounds({
        inspection: { width: 1, height: 1, hasAlpha: true, bitDepth: 16 },
        encodedBytes,
        resourceClass: "image-large-v1",
        decodedBytesOverride: largeDecoded,
      }).code,
    ).toBe(null);
    expect(
      assessResourceBounds({
        inspection: { width: 1, height: 1, hasAlpha: true, bitDepth: 16 },
        encodedBytes,
        resourceClass: "image-large-v1",
        decodedBytesOverride: largeDecoded + 1,
      }).code,
    ).toBe("ENGINE_OOM");
  });
});
