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

function installCanvasResult(byteLength: number, width = 1, height = 1) {
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

      async convertToBlob(options: { type: string }) {
        return new Blob([new Uint8Array(byteLength)], { type: options.type });
      }
    },
  );
  return createImageBitmapMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("processImagePipeline size goal", () => {
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
