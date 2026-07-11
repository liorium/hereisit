import { describe, expect, it } from "vitest";
import { detectPdfImageKind, hasPdfSignature } from "./file-format";

describe("PDF file signatures", () => {
  it("finds a PDF header within the first 1024 bytes", () => {
    const bytes = new TextEncoder().encode("\u0000\u0000%PDF-1.7");
    expect(hasPdfSignature(bytes.buffer)).toBe(true);
  });

  it("rejects a header after the inspection window", () => {
    const bytes = new Uint8Array(1_030);
    bytes.set(new TextEncoder().encode("%PDF-1.7"), 1_020);
    expect(hasPdfSignature(bytes.buffer)).toBe(false);
  });
});

describe("PDF image signatures", () => {
  it("detects JPEG and PNG without trusting the filename", () => {
    expect(detectPdfImageKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer)).toBe("jpeg");
    expect(
      detectPdfImageKind(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer),
    ).toBe("png");
    expect(detectPdfImageKind(new Uint8Array([1, 2, 3]).buffer)).toBeUndefined();
  });
});
