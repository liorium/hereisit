import { describe, expect, it } from "vitest";
import {
  detectFileKindPrefix,
  FILE_KIND_DETECTOR_VERSION,
  fileKindLabel,
  MAX_FILE_KIND_PREFIX_BYTES,
} from "./file-kind";

const encoder = new TextEncoder();

function fileTypeBox(majorBrand: string, compatibleBrands: readonly string[] = []): Uint8Array {
  const bytes = new Uint8Array(16 + compatibleBrands.length * 4);
  const size = bytes.byteLength;
  bytes.set([(size >>> 24) & 0xff, (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff]);
  bytes.set(encoder.encode("ftyp"), 4);
  bytes.set(encoder.encode(majorBrand), 8);
  compatibleBrands.forEach((brand, index) => {
    bytes.set(encoder.encode(brand), 16 + index * 4);
  });
  return bytes;
}

describe("detectFileKindPrefix", () => {
  it("publishes a versioned 64 KiB prefix contract", () => {
    expect(FILE_KIND_DETECTOR_VERSION).toBe(2);
    expect(MAX_FILE_KIND_PREFIX_BYTES).toBe(64 * 1024);
  });

  it.each([
    ["JPEG", Uint8Array.from([0xff, 0xd8, 0xff]), "image/jpeg"],
    ["PNG", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png"],
    [
      "WebP",
      Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]),
      "image/webp",
    ],
    ["GIF", encoder.encode("GIF89a"), "image/gif"],
    ["TIFF little-endian", Uint8Array.from([0x49, 0x49, 0x2a, 0x00]), "image/tiff"],
    ["SVG", encoder.encode("<svg"), "image/svg+xml"],
  ] as const)("recognizes a %s structural signature", (_name, prefix, expected) => {
    expect(detectFileKindPrefix(prefix)).toBe(expected);
  });

  it("finds a PDF header within the first 1,024 bytes", () => {
    const prefix = new Uint8Array(1_028);
    prefix.set(encoder.encode("%PDF-"), 1_023);

    expect(detectFileKindPrefix(prefix)).toBe("application/pdf");
  });

  it("rejects a PDF header starting at offset 1,024", () => {
    const prefix = new Uint8Array(1_029);
    prefix.set(encoder.encode("%PDF-"), 1_024);

    expect(detectFileKindPrefix(prefix)).toBeUndefined();
  });

  it.each([
    "heic",
    "heix",
    "hevc",
    "hevx",
    "heim",
    "heis",
    "hevm",
    "hevs",
  ])("recognizes the supported %s major brand", (brand) => {
    expect(detectFileKindPrefix(fileTypeBox(brand))).toBe("image/heic");
  });

  it("recognizes a supported compatible HEIC brand", () => {
    expect(detectFileKindPrefix(fileTypeBox("mif1", ["msf1", "heix"]))).toBe("image/heic");
  });

  it("normalizes structural HEIC evidence despite an HEIF MIME hint", () => {
    expect(
      detectFileKindPrefix(fileTypeBox("heic"), {
        mime: "image/heif",
        extension: ".heif",
      }),
    ).toBe("image/heic");
  });

  it("does not let hostile hints override structural evidence", () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    expect(detectFileKindPrefix(png, { mime: "application/pdf", extension: ".pdf" })).toBe(
      "image/png",
    );
    expect(
      detectFileKindPrefix(encoder.encode("not a pdf"), {
        mime: "application/pdf",
        extension: ".pdf",
      }),
    ).toBeUndefined();
  });

  it.each([
    ["empty input", new Uint8Array()],
    ["a truncated JPEG signature", Uint8Array.from([0xff, 0xd8])],
    ["a truncated PNG signature", Uint8Array.from([0x89, 0x50, 0x4e, 0x47])],
    [
      "a truncated WebP signature",
      Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45]),
    ],
    ["a truncated PDF header", encoder.encode("%PDF")],
    ["a truncated HEIC file-type box", encoder.encode("\0\0\0\fftyphe")],
    ["AVIF-only evidence", fileTypeBox("avif", ["mif1", "avif"])],
    ["generic HEIF evidence", fileTypeBox("mif1", ["msf1"])],
    ["a generic ZIP signature", Uint8Array.from([0x50, 0x4b, 0x03, 0x04])],
  ])("returns unknown for %s", (_name, prefix) => {
    expect(detectFileKindPrefix(prefix)).toBeUndefined();
  });

  it("rejects a prefix larger than the bounded contract", () => {
    expect(detectFileKindPrefix(new Uint8Array(MAX_FILE_KIND_PREFIX_BYTES + 1))).toBeUndefined();
  });

  it("accepts structural evidence at the exact prefix bound", () => {
    const prefix = new Uint8Array(MAX_FILE_KIND_PREFIX_BYTES);
    prefix.set([0xff, 0xd8, 0xff]);

    expect(detectFileKindPrefix(prefix)).toBe("image/jpeg");
  });
});

describe("fileKindLabel", () => {
  it.each([
    ["image/jpeg", "JPG 이미지"],
    ["image/png", "PNG 이미지"],
    ["image/webp", "WebP 이미지"],
    ["image/gif", "GIF 이미지"],
    ["image/tiff", "TIFF 이미지"],
    ["image/svg+xml", "SVG 이미지"],
    ["image/heic", "HEIC 이미지"],
    ["image/heif", "HEIF 이미지"],
    ["application/pdf", "PDF"],
    ["text/plain", "텍스트"],
    ["application/json", "JSON"],
    ["application/zip", "ZIP"],
    ["video/mp4", "동영상"],
    ["audio/mpeg", "오디오"],
  ] as const)("labels %s as %s", (kind, label) => {
    expect(fileKindLabel(kind)).toBe(label);
  });
});
