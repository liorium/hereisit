import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { inspectImage } from "./inspect";
import { normalizeImage } from "./normalize";

const roots: string[] = [];
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "hereisit-normalize-"));
  roots.push(path);
  return path;
}

function pngChunk(type: string, body: Uint8Array): Buffer {
  const payload = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(body)]);
  const result = Buffer.alloc(12 + body.byteLength);
  result.writeUInt32BE(body.byteLength, 0);
  payload.copy(result, 4);
  result.writeUInt32BE(crc32(payload), 8 + body.byteLength);
  return result;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("normalizeImage", () => {
  it("applies EXIF orientation six exactly once and writes a private raw file", async () => {
    const directory = await root();
    const sourcePath = join(directory, "input");
    const rawPath = join(directory, "normalized.raw");
    await sharp({
      create: { width: 3, height: 2, channels: 3, background: "#7f4f2f" },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toFile(sourcePath);
    const inspection = await inspectImage(sourcePath, "image/jpeg");
    expect([inspection.displayedWidth, inspection.displayedHeight]).toEqual([2, 3]);
    const normalized = await normalizeImage({ sourcePath, rawPath, inspection });
    expect(normalized).toMatchObject({
      width: 2,
      height: 3,
      channels: 3,
      normalizedColorSpace: "srgb",
      rawEndian: "little",
    });
    expect((await lstat(rawPath)).mode & 0o077).toBe(0);
    expect((await readFile(rawPath)).byteLength).toBe(2 * 3 * 3);
  });

  it("hashes the alpha plane independently and deterministically", async () => {
    const directory = await root();
    const sourcePath = join(directory, "input");
    const pixels = Buffer.from([255, 0, 0, 0, 0, 255, 0, 128]);
    await sharp(pixels, { raw: { width: 2, height: 1, channels: 4 } })
      .png()
      .toFile(sourcePath);
    const inspection = await inspectImage(sourcePath, "image/png");
    const one = await normalizeImage({
      sourcePath,
      rawPath: join(directory, "one.raw"),
      inspection,
    });
    const two = await normalizeImage({
      sourcePath,
      rawPath: join(directory, "two.raw"),
      inspection,
    });
    expect(one.rawSha256).toBe(two.rawSha256);
    expect(one.alphaSha256).toBe(two.alphaSha256);
    expect(one.alphaSha256).toBe(
      createHash("sha256")
        .update(Buffer.from([0, 128]))
        .digest("hex"),
    );
    expect(one.sample.width).toBe(2);
    expect(one.sample.height).toBe(1);
    expect(one.sample.pixels.byteLength).toBe(8);
  });

  it("canonicalizes a 16-bit RGBA working image to little-endian samples", async () => {
    const directory = await root();
    const sourcePath = join(directory, "input16");
    const pixels = Buffer.alloc(17);
    [65_535, 1_024, 512, 65_535, 4_096, 8_192, 16_384, 32_768].forEach((value, index) => {
      pixels.writeUInt16BE(value, 1 + index * 2);
    });
    const header = Buffer.alloc(13);
    header.writeUInt32BE(2, 0);
    header.writeUInt32BE(1, 4);
    header[8] = 16;
    header[9] = 6;
    await writeFile(
      sourcePath,
      Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk("IHDR", header),
        pngChunk("IDAT", deflateSync(pixels)),
        pngChunk("IEND", Buffer.alloc(0)),
      ]),
    );
    const inspection = await inspectImage(sourcePath, "image/png");
    expect(inspection.bitDepth).toBe(16);
    const normalized = await normalizeImage({
      sourcePath,
      rawPath: join(directory, "normalized16.raw"),
      inspection,
    });
    expect(normalized).toMatchObject({ sampleDepth: 16, channels: 4, rawEndian: "little" });
    expect((await readFile(normalized.rawPath)).byteLength).toBe(16);
    expect(normalized.alphaSha256).toBe(
      createHash("sha256")
        .update(Buffer.from([0xff, 0xff, 0x00, 0x80]))
        .digest("hex"),
    );
  });
});
