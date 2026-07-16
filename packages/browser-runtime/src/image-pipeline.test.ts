import { afterEach, describe, expect, it, vi } from "vitest";
import { processImagePipeline } from "./image-pipeline";

const onePixelPng = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  ),
  (character) => character.charCodeAt(0),
);
function writeUint32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function writeUint16BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 8) & 0xff;
  bytes[offset + 1] = value & 0xff;
}

function writeUint32LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
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

function heicHeader(width: number, height: number): Uint8Array {
  const brands = new Uint8Array(16);
  brands.set(new TextEncoder().encode("heic"), 0);
  brands.set(new TextEncoder().encode("mif1"), 8);
  brands.set(new TextEncoder().encode("heic"), 12);
  const ispe = new Uint8Array(12);
  writeUint32BE(ispe, 4, width);
  writeUint32BE(ispe, 8, height);
  const meta = isoBox(
    "meta",
    joinBytes(new Uint8Array(4), isoBox("iprp", isoBox("ipco", isoBox("ispe", ispe)))),
  );
  return joinBytes(isoBox("ftyp", brands), meta);
}

function jpegHeader(width: number, height: number): Uint8Array {
  const framePayload = Uint8Array.from([
    8,
    (height >>> 8) & 0xff,
    height & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    3,
    1,
    0x11,
    0,
    2,
    0x11,
    0,
    3,
    0x11,
    0,
  ]);
  const frame = new Uint8Array(framePayload.byteLength + 4);
  frame.set([0xff, 0xc0]);
  writeUint16BE(frame, 2, framePayload.byteLength + 2);
  frame.set(framePayload, 4);
  return joinBytes(Uint8Array.from([0xff, 0xd8]), frame, Uint8Array.from([0xff, 0xd9]));
}

function webpHeader(width: number, height: number): Uint8Array {
  const packed = (width - 1) | ((height - 1) << 14);
  const lossless = new Uint8Array(5);
  lossless[0] = 0x2f;
  writeUint32LE(lossless, 1, packed);
  const chunk = joinBytes(
    new TextEncoder().encode("VP8L"),
    Uint8Array.from([5, 0, 0, 0]),
    lossless,
    Uint8Array.from([0]),
  );
  const payload = joinBytes(new TextEncoder().encode("WEBP"), chunk);
  const output = joinBytes(new TextEncoder().encode("RIFF"), new Uint8Array(4), payload);
  writeUint32LE(output, 4, output.byteLength - 8);
  return output;
}

function pngResult(width: number, height: number, byteLength: number): Uint8Array {
  if (byteLength < 58) throw new Error("PNG test result must be at least 58 bytes");
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const output = new Uint8Array(data.byteLength + 12);
    writeUint32BE(output, 0, data.byteLength);
    output.set(new TextEncoder().encode(type), 4);
    output.set(data, 8);
    return output;
  };
  const header = new Uint8Array(13);
  writeUint32BE(header, 0, width);
  writeUint32BE(header, 4, height);
  header[8] = 8;
  header[9] = 6;
  return joinBytes(
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(byteLength - 57)),
    chunk("IEND", new Uint8Array()),
  );
}

function encodedResult(
  mime: string,
  width: number,
  height: number,
  byteLength: number,
): Uint8Array {
  if (mime === "image/png") return pngResult(width, height, byteLength);
  if (mime === "image/webp") {
    if (byteLength < 26 || byteLength % 2 !== 0) {
      throw new Error("WebP test result must have an even length of at least 26 bytes");
    }
    const output = new Uint8Array(byteLength);
    output.set(webpHeader(width, height));
    writeUint32LE(output, 4, byteLength - 8);
    writeUint32LE(output, 16, byteLength - 20);
    return output;
  }
  const header = jpegHeader(width, height);
  const output = new Uint8Array(Math.max(byteLength, header.byteLength));
  output.set(header);
  return output;
}

function installCanvasResult(
  byteLength: number,
  width = 1,
  height = 1,
  encode: (
    mime: string,
    width: number,
    height: number,
    byteLength: number,
    quality?: number,
  ) => Uint8Array = encodedResult,
) {
  const createImageBitmapMock = vi.fn(async (_source: Blob) => ({ width, height, close: vi.fn() }));
  vi.stubGlobal("createImageBitmap", createImageBitmapMock);
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      readonly width: number;
      readonly height: number;

      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }

      getContext() {
        return {
          clearRect: vi.fn(),
          drawImage: vi.fn(),
          fillRect: vi.fn(),
          fillStyle: "#ffffff",
          imageSmoothingEnabled: false,
          imageSmoothingQuality: "low",
        };
      }

      async convertToBlob(options: { type: string; quality?: number }) {
        const quality =
          options.quality === undefined ? undefined : Math.round(options.quality * 100);
        const bytes = encode(options.type, this.width, this.height, byteLength, quality);
        return new Blob([bytes.slice().buffer as ArrayBuffer], {
          type: options.type,
        });
      }
    },
  );
  return createImageBitmapMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("processImagePipeline size goal", () => {
  it.each([
    {
      bytes: jpegHeader(7, 5),
      name: "portrait.jpeg",
      mime: "image/jpeg" as const,
      suggestedName: "portrait-hereisit.jpeg",
      width: 7,
      height: 5,
    },
    {
      bytes: webpHeader(9, 6),
      name: "graphic.WEBP",
      mime: "image/webp" as const,
      suggestedName: "graphic-hereisit.WEBP",
      width: 9,
      height: 6,
    },
  ])("preserves $mime bytes, dimensions, and extension in source mode", async (sample) => {
    installCanvasResult(40, sample.width, sample.height);

    const result = await processImagePipeline(
      {
        name: sample.name,
        mimeHint: "application/octet-stream",
        byteLength: sample.bytes.byteLength,
        bytes: sample.bytes.slice().buffer,
      },
      {
        version: 2,
        resize: { kind: "none" },
        output: { format: "source", compression: { mode: "quality", quality: 82 } },
        sizeGoal: { mode: "allow-growth" },
        autoOrient: true,
        metadata: "strip",
      },
      vi.fn(),
    );

    expect(result).toMatchObject({
      mime: sample.mime,
      suggestedName: sample.suggestedName,
      width: sample.width,
      height: sample.height,
    });
  });

  it("preserves the structurally detected PNG format in source mode", async () => {
    installCanvasResult(58);

    const result = await processImagePipeline(
      {
        name: "holiday.photo.PNG",
        mimeHint: "image/jpeg",
        byteLength: onePixelPng.byteLength,
        bytes: onePixelPng.slice().buffer,
      },
      {
        version: 2,
        resize: { kind: "none" },
        output: { format: "source", compression: { mode: "quality", quality: 82 } },
        sizeGoal: { mode: "allow-growth" },
        autoOrient: true,
        metadata: "strip",
      },
      vi.fn(),
    );

    expect(result).toMatchObject({
      mime: "image/png",
      suggestedName: "holiday.photo-hereisit.PNG",
      width: 1,
      height: 1,
    });
  });

  it("rejects encoder bytes whose signature does not match the claimed MIME", async () => {
    installCanvasResult(40, 1, 1, () => new Uint8Array(40));

    await expect(
      processImagePipeline(
        {
          name: "tiny.png",
          mimeHint: "image/png",
          byteLength: onePixelPng.byteLength,
          bytes: onePixelPng.slice().buffer,
        },
        {
          version: 1,
          resize: { kind: "none" },
          output: {
            format: "jpeg",
            compression: { mode: "quality", quality: 82 },
            matte: "#ffffff",
          },
          sizeGoal: { mode: "allow-growth" },
          autoOrient: true,
          metadata: "strip",
        },
        vi.fn(),
      ),
    ).rejects.toMatchObject({ code: "ENCODE_FAILED" });
  });

  it("rejects encoder bytes with dimensions different from the canvas", async () => {
    installCanvasResult(40, 1, 1, (mime, _width, _height, byteLength) =>
      encodedResult(mime, 2, 1, byteLength),
    );

    await expect(
      processImagePipeline(
        {
          name: "tiny.png",
          mimeHint: "image/png",
          byteLength: onePixelPng.byteLength,
          bytes: onePixelPng.slice().buffer,
        },
        {
          version: 1,
          resize: { kind: "none" },
          output: {
            format: "jpeg",
            compression: { mode: "quality", quality: 82 },
            matte: "#ffffff",
          },
          sizeGoal: { mode: "allow-growth" },
          autoOrient: true,
          metadata: "strip",
        },
        vi.fn(),
      ),
    ).rejects.toMatchObject({ code: "ENCODE_FAILED" });
  });

  it("rejects an output that cannot become smaller than its source", async () => {
    installCanvasResult(onePixelPng.byteLength + 20);

    await expect(
      processImagePipeline(
        {
          name: "tiny.png",
          mimeHint: "image/png",
          byteLength: onePixelPng.byteLength,
          bytes: onePixelPng.slice().buffer,
        },
        {
          version: 1,
          resize: { kind: "none" },
          output: { format: "webp", compression: { mode: "quality", quality: 82 } },
          sizeGoal: {
            mode: "smaller-only",
            minSavingsPercent: 1,
            minQuality: 35,
            maxAttempts: 6,
          },
          autoOrient: true,
          metadata: "strip",
        },
        vi.fn(),
      ),
    ).rejects.toMatchObject({ code: "NO_SIZE_REDUCTION" });
  });

  it("accepts an output that meets the source-relative target", async () => {
    installCanvasResult(40);

    const result = await processImagePipeline(
      {
        name: "tiny.png",
        mimeHint: "image/png",
        byteLength: onePixelPng.byteLength,
        bytes: onePixelPng.slice().buffer,
      },
      {
        version: 1,
        resize: { kind: "none" },
        output: { format: "webp", compression: { mode: "quality", quality: 82 } },
        sizeGoal: {
          mode: "smaller-only",
          minSavingsPercent: 1,
          minQuality: 35,
          maxAttempts: 6,
        },
        autoOrient: true,
        metadata: "strip",
      },
      vi.fn(),
    );

    expect(result.byteLength).toBe(40);
    expect(result.bytes.byteLength).toBe(40);
    expect(result.timing.encodeAttempts).toBe(1);
  });

  it("adapts source JPEG quality until the one-percent saving target is met", async () => {
    const input = encodedResult("image/jpeg", 1, 1, 200);
    const attemptedQualities: number[] = [];
    installCanvasResult(200, 1, 1, (mime, width, height, _byteLength, quality) => {
      if (quality === undefined) throw new Error("Expected JPEG quality");
      attemptedQualities.push(quality);
      return encodedResult(mime, width, height, 60 + quality * 2);
    });

    const result = await processImagePipeline(
      {
        name: "photo.jpeg",
        mimeHint: "image/jpeg",
        byteLength: input.byteLength,
        bytes: input.buffer as ArrayBuffer,
      },
      {
        version: 2,
        resize: { kind: "none" },
        output: { format: "source", compression: { mode: "quality", quality: 82 } },
        sizeGoal: {
          mode: "smaller-only",
          minSavingsPercent: 1,
          minQuality: 35,
          maxAttempts: 6,
        },
        autoOrient: true,
        metadata: "strip",
      },
      vi.fn(),
    );

    expect(attemptedQualities[0]).toBe(82);
    expect(attemptedQualities.some((quality) => quality < 82)).toBe(true);
    expect(attemptedQualities.every((quality) => quality >= 35 && quality <= 82)).toBe(true);
    expect(result).toMatchObject({
      mime: "image/jpeg",
      suggestedName: "photo-hereisit.jpeg",
      byteLength: 198,
    });
    expect(result.timing.encodeAttempts).toBe(attemptedQualities.length);
  });

  it("allows a larger result when the backward-compatible default permits growth", async () => {
    installCanvasResult(onePixelPng.byteLength + 20);

    const result = await processImagePipeline(
      {
        name: "tiny.png",
        mimeHint: "image/png",
        byteLength: onePixelPng.byteLength,
        bytes: onePixelPng.slice().buffer,
      },
      {
        version: 1,
        resize: { kind: "none" },
        output: { format: "webp", compression: { mode: "quality", quality: 82 } },
        autoOrient: true,
        metadata: "strip",
      },
      vi.fn(),
    );

    expect(result.byteLength).toBe(onePixelPng.byteLength + 20);
  });
});

describe("processImagePipeline HEIC decoding", () => {
  it("rejects source-preserving HEIC compression before decoding", async () => {
    const bytes = heicHeader(451, 461);
    const createImageBitmapMock = installCanvasResult(40, 451, 461);

    await expect(
      processImagePipeline(
        {
          name: "rainbow.heic",
          mimeHint: "image/heic",
          byteLength: bytes.byteLength,
          bytes: bytes.buffer as ArrayBuffer,
        },
        {
          version: 2,
          resize: { kind: "none" },
          output: { format: "source", compression: { mode: "quality", quality: 82 } },
          sizeGoal: { mode: "smaller-only" },
          autoOrient: true,
          metadata: "strip",
        },
        vi.fn(),
      ),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      message: expect.stringContaining("형식을 유지"),
    });
    expect(createImageBitmapMock).not.toHaveBeenCalled();
  });

  it("passes a HEIC Blob to the browser native decoder", async () => {
    const bytes = heicHeader(451, 461);
    const createImageBitmapMock = installCanvasResult(40, 451, 461);

    const result = await processImagePipeline(
      {
        name: "rainbow.heic",
        mimeHint: "image/heic",
        byteLength: bytes.byteLength,
        bytes: bytes.buffer as ArrayBuffer,
      },
      {
        version: 1,
        resize: { kind: "none" },
        output: { format: "jpeg", compression: { mode: "quality", quality: 82 }, matte: "#ffffff" },
        autoOrient: true,
        metadata: "strip",
      },
      vi.fn(),
    );

    const sourceBlob = createImageBitmapMock.mock.calls[0]?.[0];
    expect(sourceBlob).toBeInstanceOf(Blob);
    expect(sourceBlob?.type).toBe("image/heic");
    expect(result).toMatchObject({ width: 451, height: 461, mime: "image/jpeg" });
  });

  it("reports unsupported native HEIC decoding clearly", async () => {
    const bytes = heicHeader(451, 461);
    vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("unsupported")));

    await expect(
      processImagePipeline(
        {
          name: "rainbow.heic",
          mimeHint: "image/heic",
          byteLength: bytes.byteLength,
          bytes: bytes.buffer as ArrayBuffer,
        },
        {
          version: 1,
          resize: { kind: "none" },
          output: { format: "webp", compression: { mode: "quality", quality: 82 } },
          autoOrient: true,
          metadata: "strip",
        },
        vi.fn(),
      ),
    ).rejects.toMatchObject({ code: "DECODE_FAILED", message: expect.stringContaining("HEIC") });
  });
});
