import { describe, expect, it } from "vitest";
import {
  detectPdfImageKind,
  hasCompletePdfEnvelope,
  hasPdfEofMarker,
  hasPdfSignature,
} from "./file-format";

const encoder = new TextEncoder();

function pdfBytes(text: string, trailingBytes: readonly number[] = []): ArrayBuffer {
  const content = encoder.encode(text);
  const bytes = new Uint8Array(content.length + trailingBytes.length);
  bytes.set(content);
  bytes.set(trailingBytes, content.length);
  return bytes.buffer;
}

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

  it("accepts a complete envelope with the header at the final valid offset", () => {
    const bytes = new Uint8Array(1_019 + encoder.encode("%PDF-1.7\n%%EOF").length);
    bytes.fill(0x41, 0, 1_019);
    bytes.set(encoder.encode("%PDF-1.7\n%%EOF"), 1_019);

    expect(hasCompletePdfEnvelope(bytes.buffer)).toBe(true);
  });

  it("rejects a complete-looking envelope whose header begins beyond the first 1,024 bytes", () => {
    const bytes = new Uint8Array(1_020 + encoder.encode("%PDF-1.7\n%%EOF").length);
    bytes.fill(0x41, 0, 1_020);
    bytes.set(encoder.encode("%PDF-1.7\n%%EOF"), 1_020);

    expect(hasCompletePdfEnvelope(bytes.buffer)).toBe(false);
  });
});

describe("PDF EOF markers", () => {
  it("accepts an exact terminal marker followed only by PDF whitespace", () => {
    expect(hasPdfEofMarker(pdfBytes("prefix%%EOF", [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]))).toBe(
      true,
    );
    expect(hasCompletePdfEnvelope(pdfBytes("%PDF-1.7\n%%EOF"))).toBe(true);
  });

  it.each([
    ["%PDF-1.7\n%%EO", [], "a truncated marker"],
    ["%PDF-1.7\n%%EOF\nembedded content", [], "an embedded marker"],
    ["%PDF-1.7\n%%EOF", [0x0b], "non-PDF whitespace"],
    ["%PDF-1.7\n%%EOF", [0x21], "an arbitrary trailing byte"],
  ] as const)("rejects %s with %s (%s)", (text, trailingBytes, _label) => {
    expect(hasCompletePdfEnvelope(pdfBytes(text, trailingBytes))).toBe(false);
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
