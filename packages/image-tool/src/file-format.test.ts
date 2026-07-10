import { describe, expect, it } from "vitest";
import { inspectImageHeader } from "./file-format";

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
});
