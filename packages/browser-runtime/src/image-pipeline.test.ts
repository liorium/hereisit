import { afterEach, describe, expect, it, vi } from "vitest";
import { processImagePipeline } from "./image-pipeline";

const onePixelPng = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  ),
  (character) => character.charCodeAt(0),
);

function installCanvasResult(byteLength: number): void {
  vi.stubGlobal("createImageBitmap", async () => ({ width: 1, height: 1, close: vi.fn() }));
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
