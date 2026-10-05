import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeAnimatedGif } from "./image-extra";
import {
  assertExtraFileSizes,
  assertExtraResultsFit,
  inspectExtraInput,
  loadRenderSource,
  planExtraDimensions,
  validateExtraOutput,
} from "./image-extra-browser";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const file = new File([png], "small.png", { type: "image/png" });
afterEach(() => vi.unstubAllGlobals());

describe("extra image resource boundaries", () => {
  it("rejects per-file, batch and count overflow before reading files", () => {
    const limits = { minFiles: 1, maxFiles: 2, maxFileBytes: 10, maxTotalBytes: 15 };
    expect(() => assertExtraFileSizes([{ size: 10 }, { size: 5 }], limits)).not.toThrow();
    expect(() => assertExtraFileSizes([{ size: 11 }], limits)).toThrow();
    expect(() => assertExtraFileSizes([{ size: 8 }, { size: 8 }], limits)).toThrow();
    expect(() => assertExtraFileSizes([{ size: 1 }, { size: 1 }, { size: 1 }], limits)).toThrow();
  });
  it("plans exact 2x/4x output and rejects oversized output without silent resizing", () => {
    expect(planExtraDimensions(100, 80, 4)).toEqual({ width: 400, height: 320 });
    expect(planExtraDimensions(2500, 2500, 2)).toEqual({ width: 5000, height: 5000 });
    expect(() => planExtraDimensions(4000, 3000, 4)).toThrow(/배율/);
    expect(() => planExtraDimensions(2501, 2500, 2)).toThrow();
    expect(() => planExtraDimensions(16385, 1, 1)).toThrow();
    expect(() => planExtraDimensions(Number.NaN, 2, 1)).toThrow();
  });
  it("rejects excessive input geometry and uninspectable inputs before decoding", async () => {
    const huge = Buffer.from(png);
    huge.writeUInt32BE(100_000, 16);
    await expect(inspectExtraInput(new Blob([huge]))).rejects.toThrow();
    await expect(inspectExtraInput(new Blob(["<svg/>"]))).rejects.toThrow();
    await expect(inspectExtraInput(file)).resolves.toMatchObject({ width: 1, height: 1 });
  });
  it.each(["missing", "failure"])("preserves exact scale with %s bitmap decoder", async (mode) => {
    vi.stubGlobal(
      "createImageBitmap",
      mode === "missing" ? undefined : vi.fn().mockRejectedValue(new Error("decoder")),
    );
    vi.stubGlobal(
      "Image",
      class {
        naturalWidth = 100;
        naturalHeight = 80;
        decoding = "";
        onload = () => {};
        onerror = () => {};
        set src(_value: string) {
          queueMicrotask(() => this.onload());
        }
        removeAttribute() {}
      },
    );
    const result = await loadRenderSource(file, 4);
    expect(result).toMatchObject({ width: 400, height: 320 });
    result.release();
  });
  it("permits bounded animated GIF only for the first-frame conversion path", async () => {
    const frame = { width: 1, height: 1, pixels: new Uint8ClampedArray([255, 0, 0, 255]) };
    const gif = new Blob([encodeAnimatedGif([frame, frame], { delayMs: 100, loop: true })], {
      type: "image/gif",
    });
    await expect(inspectExtraInput(gif)).rejects.toThrow();
    await expect(inspectExtraInput(gif, true)).resolves.toMatchObject({
      animated: true,
      decodedPixels: 20,
    });
    const oversized = new Uint8Array(await gif.arrayBuffer());
    new DataView(oversized.buffer).setUint16(6, 2000, true);
    new DataView(oversized.buffer).setUint16(8, 2000, true);
    await expect(inspectExtraInput(new Blob([oversized]), true)).rejects.toThrow();
  });

  it("checks encoded dimensions and retained/ZIP byte totals", async () => {
    await expect(validateExtraOutput(file, { width: 4, height: 4 }, "image/png")).rejects.toThrow();
    await expect(
      validateExtraOutput(file, { width: 1, height: 1 }, "image/png"),
    ).resolves.toBeUndefined();
    expect(() => assertExtraResultsFit(100 * 1024 * 1024)).not.toThrow();
    expect(() => assertExtraResultsFit(100 * 1024 * 1024 + 1)).toThrow();
    expect(() => assertExtraResultsFit(100, 50_000_000)).not.toThrow();
    expect(() => assertExtraResultsFit(100, 50_000_001)).toThrow();
  });
});
